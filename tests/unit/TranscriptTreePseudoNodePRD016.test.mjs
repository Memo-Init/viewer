import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'


// PRD-016 (Memo 072 WI-T011-5): getTranscriptTree must carry ALL transcripts — the REV-bound ones
// under their real memo node AND the memo-less #otherTranscripts (frei / memo-init / other) under a
// per-project pseudo-memo node (TranscriptRegistry.OTHER_TRANSCRIPTS_MEMO_ID) — so the Transcripts
// tab has ONE source instead of two ad-hoc fetches.
describe( 'getTranscriptTree pseudo-memo node for memo-less transcripts (PRD-016)', () => {
    let tempDir
    let registry


    beforeEach( async () => {
        tempDir = await mkdtemp( join( tmpdir(), 'transcript-tree-pseudo-' ) )
        const { registry: reg } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        registry = reg
    } )


    afterEach( async () => {
        registry.shutdown()
        await rm( tempDir, { recursive: true, force: true } )
    } )


    it( 'covers both #transcripts (REV-bound) and #otherTranscripts (pseudo node)', async () => {
        const memoDir = join( tempDir, '072-feature' )
        await mkdir( memoDir, { recursive: true } )

        // REV-bound review transcript -> #transcripts, under the real memo node.
        const bound = await registry.addTranscript( { projectId: 'ns', memoId: '072-feature', revisionId: 'REV-01', content: 'feedback to REV-01', memoPath: memoDir } )
        // Memo-less transcripts -> #otherTranscripts (frei + memo-init).
        const frei = await registry.addOtherTranscript( { projectId: 'ns', content: 'a free idea', otherRoot: tempDir } )
        const init = await registry.addOtherTranscript( { projectId: 'ns', content: 'a bootstrap memo', otherRoot: tempDir, type: 'memo-init' } )

        expect( bound[ 'status' ] ).toBe( true )
        expect( frei[ 'status' ] ).toBe( true )
        expect( init[ 'status' ] ).toBe( true )

        const { tree } = registry.getTranscriptTree()
        const pseudo = TranscriptRegistry.OTHER_TRANSCRIPTS_MEMO_ID

        // The namespace carries BOTH the real memo node and the pseudo node.
        expect( tree[ 'ns' ] ).toBeDefined()
        expect( Array.isArray( tree[ 'ns' ][ '072-feature' ] ) ).toBe( true )
        expect( Array.isArray( tree[ 'ns' ][ pseudo ] ) ).toBe( true )

        // REV-bound leaf: revisionId REV-01, ungebunden false.
        const boundLeaves = tree[ 'ns' ][ '072-feature' ]
        expect( boundLeaves.length ).toBe( 1 )
        expect( boundLeaves[ 0 ][ 'revisionId' ] ).toBe( 'REV-01' )
        expect( boundLeaves[ 0 ][ 'ungebunden' ] ).toBe( false )

        // Pseudo node carries both other transcripts: ungebunden true, no revision binding, type kept.
        const otherLeaves = tree[ 'ns' ][ pseudo ]
        expect( otherLeaves.length ).toBe( 2 )
        otherLeaves.forEach( ( leaf ) => {
            expect( leaf[ 'ungebunden' ] ).toBe( true )
            expect( leaf[ 'revisionId' ] ).toBeNull()
        } )
        const types = otherLeaves
            .map( ( leaf ) => leaf[ 'type' ] )
            .sort()
        expect( types ).toEqual( [ 'frei', 'memo-init' ] )
        // Each other leaf keeps its own transcriptId (loadable via /transcripts/{id}).
        const ids = otherLeaves.map( ( leaf ) => leaf[ 'transcriptId' ] )
        expect( ids ).toContain( frei[ 'transcriptId' ] )
        expect( ids ).toContain( init[ 'transcriptId' ] )
    } )


    it( 'hangs memo-less transcripts under the pseudo node only — no invented real memo node', async () => {
        const add = await registry.addOtherTranscript( { projectId: 'ns', content: 'lonely idea', otherRoot: tempDir } )

        expect( add[ 'status' ] ).toBe( true )

        const { tree } = registry.getTranscriptTree()
        const pseudo = TranscriptRegistry.OTHER_TRANSCRIPTS_MEMO_ID

        expect( tree[ 'ns' ][ pseudo ].length ).toBe( 1 )
        // No real memo node was invented for the ungebundene transcript.
        expect( Object.keys( tree[ 'ns' ] ) ).toEqual( [ pseudo ] )
    } )


    it( 'exposes a parenthesised sentinel that cannot collide with a real memoId', () => {
        expect( TranscriptRegistry.OTHER_TRANSCRIPTS_MEMO_ID ).toBe( '(ungebunden)' )
    } )
} )
