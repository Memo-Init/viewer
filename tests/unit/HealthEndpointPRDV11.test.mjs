import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm, appendFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

import { MemoView, makeSourceTreeReader } from '../../src/MemoView.mjs'


// PRD-V11 (Memo 080, Kap 19 — Rueckkanal und Statuszeile / WI-100): `GET /api/health`, the honest
// replacement of the status line's `nc -z 127.0.0.1 3333`. A port probe only proves that SOMETHING
// listens; a process running older code than the source on disk passes it green. Covers A9-A12.
//
// Every case states HOW MUCH it compared. The stale direction is shown on a REAL throwaway source tree
// (files written, changed and re-read on disk) — never by editing the running repo, and never by a
// mock that would only prove the mock. The full over-the-wire proof (server up, GET, flip to stale,
// port inventory) lives in tests/manual/health-endpoint-e2e.mjs and is run against a real server.
const here = fileURLToPath( new URL( '.', import.meta.url ) )
const memoViewSource = await readFile( resolve( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )

const bootOf = ( { hash, startedAtMs, port } ) => {
    return { startedAtMs, startedAt: new Date( startedAtMs ).toISOString(), bootHash: hash, port, memoRoot: '/tmp/root' }
}


describe( 'PRD-V11 A9/A10 — stale is a MEASURED comparison, in both directions', () => {
    let dir = ''
    let read = null


    beforeAll( async () => {
        // Test isolation: only into the repo-internal .test-tmp/, never .memo/ and never the home.
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        dir = await mkdtemp( join( process.cwd(), '.test-tmp', 'health-src-' ) )
        await writeFile( join( dir, 'Alpha.mjs' ), 'export const a = 1\n', 'utf8' )
        await writeFile( join( dir, 'Beta.mjs' ), 'export const b = 2\n', 'utf8' )
        await writeFile( join( dir, 'Beta.test.mjs' ), 'test files never enter the process\n', 'utf8' )
        read = makeSourceTreeReader( { dir } )
    } )


    afterAll( async () => {
        await rm( dir, { recursive: true, force: true } )
    } )


    it( 'A9 — an unchanged source tree answers status ok and stale false (2 modules compared)', () => {
        const boot = bootOf( { hash: read().hash, startedAtMs: Date.UTC( 2026, 8, 5, 10, 0, 0 ), port: 3333 } )
        const { payload } = MemoView.buildHealthPayload( { boot, current: read(), nowMs: Date.UTC( 2026, 8, 5, 10, 0, 30 ) } )

        expect( payload[ 'status' ] ).toBe( 'ok' )
        expect( payload[ 'stale' ] ).toBe( false )
        expect( payload[ 'bootHash' ] ).toBe( payload[ 'currentHash' ] )
        expect( payload[ 'hashedFiles' ] ).toBe( 2 )
        expect( payload[ 'uptimeSeconds' ] ).toBe( 30 )
        expect( payload[ 'port' ] ).toBe( 3333 )
    } )


    it( 'A10 — a source file changed AFTER the boot flips stale to true, and the answer stays a 200 payload', async () => {
        const boot = bootOf( { hash: read().hash, startedAtMs: Date.UTC( 2026, 8, 5, 10, 0, 0 ), port: 3333 } )
        const before = MemoView.buildHealthPayload( { boot, current: read(), nowMs: Date.UTC( 2026, 8, 5, 10, 0, 1 ) } ).payload
        expect( before[ 'stale' ] ).toBe( false )

        await appendFile( join( dir, 'Beta.mjs' ), '// a later edit the running process never saw\n', 'utf8' )
        const after = MemoView.buildHealthPayload( { boot, current: read(), nowMs: Date.UTC( 2026, 8, 5, 10, 0, 2 ) } ).payload

        expect( after[ 'stale' ] ).toBe( true )
        expect( after[ 'status' ] ).toBe( 'ok' )
        expect( after[ 'bootHash' ] ).not.toBe( after[ 'currentHash' ] )
        expect( after[ 'bootHash' ] ).toBe( before[ 'bootHash' ] )
        expect( [ before[ 'stale' ], after[ 'stale' ] ] ).toEqual( [ false, true ] )
    } )


    it( 'A10 — a NEW module in the tree is the same finding: the scope is the tree, not one file', async () => {
        const boot = bootOf( { hash: read().hash, startedAtMs: Date.UTC( 2026, 8, 5, 10, 0, 0 ), port: 3333 } )
        await writeFile( join( dir, 'Gamma.mjs' ), 'export const g = 3\n', 'utf8' )
        const after = MemoView.buildHealthPayload( { boot, current: read(), nowMs: Date.UTC( 2026, 8, 5, 10, 0, 5 ) } ).payload

        expect( after[ 'stale' ] ).toBe( true )
        expect( after[ 'hashedFiles' ] ).toBe( 3 )
    } )


    it( 'a process that never recorded a boot says so — stale is null, never a comfortable false', () => {
        const boot = { startedAtMs: null, startedAt: null, bootHash: null, port: null, memoRoot: null }
        const { payload } = MemoView.buildHealthPayload( { boot, current: read(), nowMs: Date.now() } )

        expect( payload[ 'status' ] ).toBe( 'unrecorded' )
        expect( payload[ 'stale' ] ).toBe( null )
        expect( payload[ 'uptimeSeconds' ] ).toBe( null )
    } )
} )


describe( 'PRD-V11 A12 — the normal case does NOT hash', () => {
    let dir = ''


    beforeAll( async () => {
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        dir = await mkdtemp( join( process.cwd(), '.test-tmp', 'health-hash-' ) )
        await writeFile( join( dir, 'One.mjs' ), 'export const one = 1\n', 'utf8' )
    } )


    afterAll( async () => {
        await rm( dir, { recursive: true, force: true } )
    } )


    it( 'three reads WITHOUT a source change trigger exactly ONE hash (3 reads compared)', () => {
        const read = makeSourceTreeReader( { dir } )
        const counts = [ read().hashCount, read().hashCount, read().hashCount ]

        expect( counts ).toEqual( [ 1, 1, 1 ] )
    } )


    it( 'a REAL content change is the only thing that hashes again (1 -> 2 over 4 reads)', async () => {
        const read = makeSourceTreeReader( { dir } )
        expect( read().hashCount ).toBe( 1 )
        expect( read().hashCount ).toBe( 1 )

        await writeFile( join( dir, 'One.mjs' ), 'export const one = 2\n', 'utf8' )

        expect( read().hashCount ).toBe( 2 )
        expect( read().hashCount ).toBe( 2 )
    } )


    it( 'an unreadable directory yields an empty comparison basis instead of a crash — and names it as 0 files', () => {
        const read = makeSourceTreeReader( { dir: join( dir, 'does-not-exist' ) } )
        const seen = read()

        expect( seen.files ).toBe( 0 )
        expect( seen.bytes ).toBe( 0 )
    } )
} )


describe( 'PRD-V11 A11 — no second listener, loopback only', () => {
    it( 'the endpoint adds NO server.listen and NO createServer (3 pre-existing counts compared)', () => {
        const listens = memoViewSource.split( 'server.listen(' ).length - 1
        const creates = memoViewSource.split( 'createServer(' ).length - 1
        const binds = memoViewSource.split( 'const BIND_HOST' ).length - 1

        // Pre-PRD-V11 figures, re-measurable with:
        //   grep -c "server.listen(" src/MemoView.mjs ; grep -c "createServer(" src/MemoView.mjs
        expect( listens ).toBe( 2 )
        expect( creates ).toBe( 3 )
        expect( binds ).toBe( 1 )
    } )


    it( 'every listen call passes the single BIND_HOST constant — the health route changed nothing about the bind (2 calls compared)', () => {
        const calls = memoViewSource.split( 'server.listen(' ).slice( 1 )

        expect( calls.length ).toBe( 2 )
        calls
            .forEach( ( tail ) => {
                expect( tail.slice( 0, 60 ) ).toContain( 'BIND_HOST' )
            } )
        // `0.0.0.0` does occur — in the PRD-002 comment that EXPLAINS why the probe stopped using it.
        // The finding would be a CODE line carrying it, so the check is spelled that way.
        const wildcardCodeLines = memoViewSource.split( '\n' )
            .filter( ( line ) => line.includes( '0.0.0.0' ) === true && line.trim().startsWith( '//' ) === false )

        expect( wildcardCodeLines ).toEqual( [] )
    } )


    it( 'the /api/health branch is dispatched from the ONE route body and holds no connection open (4 anchors compared)', () => {
        const anchors = [
            "if( url === '/api/health' && req.method === 'GET' )",
            "'Cache-Control': 'no-store'",
            'MemoView.healthPayload( {} )',
            'const route = async ( req, res, url ) => {'
        ]
        const missing = anchors.filter( ( anchor ) => memoViewSource.includes( anchor ) === false )

        expect( missing ).toEqual( [] )
        // The branch must NOT read a body and must NOT register a waiter — both would make the
        // endpoint blockable, which is exactly the line PRD-V9 draws between the two endpoints.
        const branch = memoViewSource.split( "if( url === '/api/health' && req.method === 'GET' ) {" )[ 1 ].split( '\n\n' )[ 0 ]
        expect( branch.includes( 'readBody' ) ).toBe( false )
        expect( branch.includes( 'AnswerWaiter' ) ).toBe( false )
    } )


    it( 'the boot hash is frozen in BOTH listen callbacks — one recordBoot per start path (2 call sites compared)', () => {
        const sites = memoViewSource.split( 'MemoView.recordBoot( {' ).length - 1

        expect( sites ).toBe( 2 )
        expect( memoViewSource.includes( 'static recordBoot( { port, memoRoot, nowMs } )' ) ).toBe( true )
    } )


    it( 'the health scope covers the whole server-side module tree, not the entry file alone', () => {
        const current = MemoView.healthPayload( {} ).payload

        // Measured on the real src/: ls src/*.mjs | grep -v '\.test\.mjs' | wc -l
        expect( current[ 'hashedFiles' ] ).toBeGreaterThan( 20 )
        expect( memoViewSource.includes( "name.endsWith( '.test.mjs' ) === false" ) ).toBe( true )
    } )
} )
