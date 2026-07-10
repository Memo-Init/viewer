import { describe, it, expect, beforeAll, afterEach } from '@jest/globals'
import { readFile, rm, mkdir, access, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-031 (Memo 067 Phase 9, WI-8-04/05/06) — reverse-channel wake endpoint.
// The HTTP handler (#createHttpHandler) is private, so — as elsewhere in this suite — the route
// dispatch is asserted on the MemoView.mjs source string, while the real behaviour (flag write,
// path-traversal guard, session-scoped arm map) is exercised through the public static methods the
// routes call, and the wait-loop building block is run as the real shell script.
const execFileP = promisify( execFile )
const here = dirname( fileURLToPath( import.meta.url ) )
const WAKE_DIR = join( tmpdir(), 'memo-view-wake' )
const SCRIPT = join( here, '..', '..', 'scripts', 'session-wake-arm.sh' )


const exists = async ( path ) => {
    try {
        await access( path )

        return true
    } catch {
        return false
    }
}


describe( 'validateSessionId (AC-4 path-traversal guard)', () => {
    it( 'accepts plain [A-Za-z0-9_-] ids', () => {
        expect( MemoView.validateSessionId( { 'sessionId': 'test-sess_1' } )[ 'status' ] ).toBe( true )
    } )

    it( 'rejects path-traversal ids (../../etc, a/b, dotted)', () => {
        expect( MemoView.validateSessionId( { 'sessionId': '../../etc' } )[ 'status' ] ).toBe( false )
        expect( MemoView.validateSessionId( { 'sessionId': 'a/b' } )[ 'status' ] ).toBe( false )
        expect( MemoView.validateSessionId( { 'sessionId': 'a.b' } )[ 'status' ] ).toBe( false )
    } )

    it( 'rejects empty / non-string', () => {
        expect( MemoView.validateSessionId( { 'sessionId': '' } )[ 'status' ] ).toBe( false )
        expect( MemoView.validateSessionId( { 'sessionId': undefined } )[ 'status' ] ).toBe( false )
    } )
} )


describe( 'writeWakeFlag (WI-8-04) + session-scope (WI-8-05)', () => {
    afterEach( async () => {
        await rm( join( WAKE_DIR, 'wt-a.flag' ), { 'force': true } )
        await rm( join( WAKE_DIR, 'wt-b.flag' ), { 'force': true } )
    } )

    it( 'writes an ephemeral flag under os.tmpdir()/memo-view-wake and returns its path', async () => {
        const result = await MemoView.writeWakeFlag( { 'sessionId': 'wt-a' } )
        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'flagPath' ] ).toBe( join( WAKE_DIR, 'wt-a.flag' ) )
        expect( await exists( result[ 'flagPath' ] ) ).toBe( true )
    } )

    it( 'two ids create two distinct flags — waking A leaves B absent (no cross-waking)', async () => {
        const a = await MemoView.writeWakeFlag( { 'sessionId': 'wt-a' } )
        expect( await exists( a[ 'flagPath' ] ) ).toBe( true )
        expect( await exists( join( WAKE_DIR, 'wt-b.flag' ) ) ).toBe( false )
    } )

    it( 'rejects a traversal id WITHOUT writing any file', async () => {
        const result = await MemoView.writeWakeFlag( { 'sessionId': '../../etc' } )
        expect( result[ 'status' ] ).toBe( false )
        expect( await exists( join( WAKE_DIR, '..', '..', 'etc.flag' ) ) ).toBe( false )
    } )
} )


describe( 'armSession / getArmedSessions (WI-8-05 session-scoped arm map)', () => {
    it( 'maps transcript → session(s); a button on T1 sees only T1 sessions', () => {
        MemoView.armSession( { 'sessionId': 'sA', 'transcriptId': 'T1' } )
        MemoView.armSession( { 'sessionId': 'sB', 'transcriptId': 'T1' } )
        MemoView.armSession( { 'sessionId': 'sC', 'transcriptId': 'T2' } )

        const t1 = MemoView.getArmedSessions( { 'transcriptId': 'T1' } )[ 'sessions' ]
        const t2 = MemoView.getArmedSessions( { 'transcriptId': 'T2' } )[ 'sessions' ]

        expect( t1.sort() ).toEqual( [ 'sA', 'sB' ] )
        expect( t2 ).toEqual( [ 'sC' ] )
        expect( MemoView.getArmedSessions( { 'transcriptId': 'unknown' } )[ 'sessions' ] ).toEqual( [] )
    } )

    it( 'rejects arming with a traversal sessionId', () => {
        expect( MemoView.armSession( { 'sessionId': '../x', 'transcriptId': 'T9' } )[ 'status' ] ).toBe( false )
    } )
} )


describe( 'route + loopback wiring (source assertions)', () => {
    let source = ''
    let clientJs = ''

    beforeAll( async () => {
        source = await readFile( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
        clientJs = await readFile( join( here, '..', '..', 'src', 'public', 'app.client.mjs' ), 'utf8' )
    } )

    it( 'wires arm, armed-GET and wake routes', () => {
        expect( source.includes( "url.startsWith( '/api/session/' ) && url.endsWith( '/arm' ) && req.method === 'POST'" ) ).toBe( true )
        expect( source.includes( "url === '/api/session/armed' && req.method === 'GET'" ) ).toBe( true )
        expect( source.includes( "url.startsWith( '/api/session/' ) && url.endsWith( '/wake' ) && req.method === 'POST'" ) ).toBe( true )
    } )

    it( 'wake flags live in an ephemeral os.tmpdir() dir (no repo/.memo/.env write)', () => {
        expect( source.includes( "const WAKE_DIR = join( tmpdir(), 'memo-view-wake' )" ) ).toBe( true )
    } )

    it( 'introduces NO new listener — the wake block hangs off the existing loopback-bound server', () => {
        const listenCount = ( source.match( /\.listen\(/g ) || [] ).length
        // Pre-existing: 2x server.listen + 1x testServer.listen (probe). The wake route adds none.
        expect( listenCount ).toBe( 3 )
        expect( source.includes( "const BIND_HOST = '127.0.0.1'" ) ).toBe( true )
    } )

    it( 'the button POSTs wake to armed sessions after login (client diff in bindPromptFinish)', () => {
        expect( clientJs.includes( '/api/session/armed?transcriptId=' ) ).toBe( true )
        expect( clientJs.includes( "'/api/session/' + encodeURIComponent( sessionId ) + '/wake'" ) ).toBe( true )
        const finishIdx = clientJs.indexOf( 'function bindPromptFinish(' )
        const wakeIdx = clientJs.indexOf( '/api/session/armed?transcriptId=' )
        expect( finishIdx ).toBeGreaterThan( -1 )
        expect( wakeIdx ).toBeGreaterThan( finishIdx )
    } )
} )


describe( 'wait-loop building block + WI-8-06 guard (real shell script)', () => {
    it( 'guard: CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 → fallback message, no loop, no WOKEN', async () => {
        const { stdout } = await execFileP( 'bash', [ SCRIPT, 'guard-sess' ], {
            'env': { ...process.env, 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS': '1' }
        } )
        expect( stdout ).toContain( 'background tasks disabled' )
        expect( stdout ).not.toContain( 'WOKEN' )
    } )

    it( 'happy path: a present flag ends the until-loop → WOKEN + one-shot cleanup', async () => {
        const dir = join( tmpdir(), 'memo-view-wake-test' )
        await mkdir( dir, { 'recursive': true } )
        const flag = join( dir, 'rt.flag' )
        await writeFile( flag, '' )

        const { stdout } = await execFileP( 'bash', [ SCRIPT, 'rt' ], {
            'env': { ...process.env, 'WAKE_DIR': dir }
        } )
        expect( stdout ).toContain( 'WOKEN rt' )
        expect( await exists( flag ) ).toBe( false )

        await rm( dir, { 'recursive': true, 'force': true } )
    } )
} )
