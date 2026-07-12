import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, readFile, utimes } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'
import { MemoView } from '../../src/MemoView.mjs'


// PRD-022 (Memo 067 WI-6-03): the auto-bind must pick the mtime-NEAREST unbound memo-init candidate
// (not the first .find() in insertion order) and must WARN + skip when two candidates are nearly
// equidistant. WI-6-01: resolveOtherRootForProject resolves the store deterministically and falls
// back to a status:false (caller logs cwd fallback) when no registered project matches. These
// integration tests use a repo-local, isolated test-home (NEVER the user home).
const __dirname = dirname( fileURLToPath( import.meta.url ) )
const testHomeRoot = resolve( __dirname, '..', '..', '.test-home' )

const BASE_MS = 1600000000000


const addMemoInitOther = async ( { registry, otherRoot, content } ) => {
    const result = await registry.addOtherTranscript( { projectId: 'proj', content, otherRoot, type: 'memo-init' } )

    return { result }
}


describe( 'PRD-022 WI-6-03 — mtime-nearest auto-bind', () => {
    let tempDir
    let registry


    beforeEach( async () => {
        await mkdir( testHomeRoot, { recursive: true } )
        tempDir = await mkdtemp( join( testHomeRoot, 'autobind-p22-' ) )
        const { registry: reg } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        registry = reg
    } )


    afterEach( async () => {
        registry.shutdown()
        await rm( tempDir, { recursive: true, force: true } )
    } )


    it( 'binds the candidate whose mtime is nearest the memo creation time, not the first inserted', async () => {
        // Candidate A is inserted FIRST but is temporally FAR; candidate B is inserted second but NEAR.
        const far = await addMemoInitOther( { registry, otherRoot: tempDir, content: 'AAA far candidate' } )
        const near = await addMemoInitOther( { registry, otherRoot: tempDir, content: 'BBB near candidate' } )
        expect( far.result[ 'status' ] ).toBe( true )
        expect( near.result[ 'status' ] ).toBe( true )

        const farDate = new Date( BASE_MS )
        const nearDate = new Date( BASE_MS + 10 * 60 * 1000 )
        await utimes( far.result[ 'absolutePath' ], farDate, farDate )
        await utimes( near.result[ 'absolutePath' ], nearDate, nearDate )

        // Refresh the in-memory mtimeMs from disk.
        await registry.scanOther( { otherRoot: tempDir } )

        const memoDir = join( tempDir, '.memo', 'memos', '070-nearest' )
        await mkdir( memoDir, { recursive: true } )
        const memoDate = new Date( BASE_MS + 10 * 60 * 1000 + 20 * 1000 ) // 20s after the NEAR candidate
        await utimes( memoDir, memoDate, memoDate )

        const result = await registry.autoBindInitTranscript( { projectId: 'proj', memoId: '070-nearest', memoPath: memoDir } )

        expect( result[ 'status' ] ).toBe( true )
        const written = await readFile( result[ 'absolutePath' ], 'utf-8' )
        expect( written ).toContain( 'BBB near candidate' )
        expect( written ).not.toContain( 'AAA far candidate' )
    } )


    it( 'skips with reason ambiguous-candidate when two candidates are near-equidistant', async () => {
        const a = await addMemoInitOther( { registry, otherRoot: tempDir, content: 'AAA equidistant' } )
        const b = await addMemoInitOther( { registry, otherRoot: tempDir, content: 'BBB equidistant' } )

        const aDate = new Date( BASE_MS )
        const bDate = new Date( BASE_MS + 20 * 1000 )
        await utimes( a.result[ 'absolutePath' ], aDate, aDate )
        await utimes( b.result[ 'absolutePath' ], bDate, bDate )
        await registry.scanOther( { otherRoot: tempDir } )

        const memoDir = join( tempDir, '.memo', 'memos', '071-ambiguous' )
        await mkdir( memoDir, { recursive: true } )
        const memoDate = new Date( BASE_MS + 10 * 1000 ) // exact midpoint: 10s from each
        await utimes( memoDir, memoDate, memoDate )

        const result = await registry.autoBindInitTranscript( { projectId: 'proj', memoId: '071-ambiguous', memoPath: memoDir } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'skipped' ] ).toBe( true )
        expect( result[ 'reason' ] ).toBe( 'ambiguous-candidate' )
        expect( result[ 'candidateCount' ] ).toBe( 2 )
    } )


    it( 'never re-binds an already-consumed candidate to a second memo', async () => {
        // Single candidate, two memos. The first memo binds it; the second must find no candidate.
        const only = await addMemoInitOther( { registry, otherRoot: tempDir, content: 'ONLY candidate' } )
        const onlyDate = new Date( BASE_MS )
        await utimes( only.result[ 'absolutePath' ], onlyDate, onlyDate )
        await registry.scanOther( { otherRoot: tempDir } )

        const memoA = join( tempDir, '.memo', 'memos', '072-first' )
        const memoB = join( tempDir, '.memo', 'memos', '073-second' )
        await mkdir( memoA, { recursive: true } )
        await mkdir( memoB, { recursive: true } )
        // Keep both memos within the staleness window of the candidate so this test isolates the
        // consumption guard, not the Memo-153 staleness gate (without utimes the folder mtime defaults
        // to the real current time, which is years past BASE_MS and would trip the staleness gate).
        const memoDate = new Date( BASE_MS + 30 * 1000 )
        await utimes( memoA, memoDate, memoDate )
        await utimes( memoB, memoDate, memoDate )

        const first = await registry.autoBindInitTranscript( { projectId: 'proj', memoId: '072-first', memoPath: memoA } )
        expect( first[ 'status' ] ).toBe( true )

        const second = await registry.autoBindInitTranscript( { projectId: 'proj', memoId: '073-second', memoPath: memoB } )
        expect( second[ 'status' ] ).toBe( false )
        expect( second[ 'reason' ] ).toBe( 'no-candidate' )
    } )


    // Memo 153 (FlowMCP rollout follow-up): the mtime-nearest candidate must also be temporally
    // PLAUSIBLE. A stale pool leftover (e.g. a bootstrapped --other-- transcript weeks older than the
    // memo) must NOT be auto-bound — it silently mis-attributes provenance (the observed 151/153 bug).
    it( 'skips with reason stale-candidate when the nearest candidate is older than the staleness window', async () => {
        const stale = await addMemoInitOther( { registry, otherRoot: tempDir, content: 'STALE grading leftover' } )
        expect( stale.result[ 'status' ] ).toBe( true )

        const staleDate = new Date( BASE_MS )
        await utimes( stale.result[ 'absolutePath' ], staleDate, staleDate )
        await registry.scanOther( { otherRoot: tempDir } )

        const memoDir = join( tempDir, '.memo', 'memos', '074-fresh-memo' )
        await mkdir( memoDir, { recursive: true } )
        const memoDate = new Date( BASE_MS + 25 * 24 * 60 * 60 * 1000 ) // 25 days after the stale candidate
        await utimes( memoDir, memoDate, memoDate )

        const result = await registry.autoBindInitTranscript( { projectId: 'proj', memoId: '074-fresh-memo', memoPath: memoDir } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'skipped' ] ).toBe( true )
        expect( result[ 'reason' ] ).toBe( 'stale-candidate' )
    } )


    it( 'still binds a candidate that sits within the staleness window (same-day workflow)', async () => {
        const fresh = await addMemoInitOther( { registry, otherRoot: tempDir, content: 'FRESH within-window candidate' } )
        const freshDate = new Date( BASE_MS )
        await utimes( fresh.result[ 'absolutePath' ], freshDate, freshDate )
        await registry.scanOther( { otherRoot: tempDir } )

        const memoDir = join( tempDir, '.memo', 'memos', '075-same-day' )
        await mkdir( memoDir, { recursive: true } )
        const memoDate = new Date( BASE_MS + 12 * 60 * 60 * 1000 ) // 12h after — within the 24h window
        await utimes( memoDir, memoDate, memoDate )

        const result = await registry.autoBindInitTranscript( { projectId: 'proj', memoId: '075-same-day', memoPath: memoDir } )

        expect( result[ 'status' ] ).toBe( true )
        const written = await readFile( result[ 'absolutePath' ], 'utf-8' )
        expect( written ).toContain( 'FRESH within-window candidate' )
    } )
} )


describe( 'PRD-022 WI-6-01 — resolveOtherRootForProject', () => {
    it( 'returns status:false (caller falls back to logged cwd) when no registry is set', () => {
        const result = MemoView.resolveOtherRootForProject( { projectId: 'nonexistent-project' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'otherRoot' ] ).toBe( null )
        expect( result[ 'source' ] ).toBe( 'none' )
    } )


    it( 'returns status:false for a missing/empty projectId', () => {
        const empty = MemoView.resolveOtherRootForProject( { projectId: '' } )
        const undef = MemoView.resolveOtherRootForProject( {} )

        expect( empty[ 'status' ] ).toBe( false )
        expect( undef[ 'status' ] ).toBe( false )
    } )
} )
