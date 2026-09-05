import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

import { DatabaseSync } from '@dolthub/doltlite'

import { MemoView } from '../../src/MemoView.mjs'
import { AnswerWaiter } from '../../src/AnswerWaiter.mjs'
import { McpEndpoint } from '../../src/McpEndpoint.mjs'


// PRD-V9 (Memo 080, Kap 19 / WI-098, WI-164) — the answer channel WIRED INTO the viewer.
// Following the suite convention for the private #createHttpHandler: the route dispatch is asserted on
// the MemoView.mjs source string, the behaviour is exercised through the public statics the route calls,
// and the real HTTP round trip lives in tests/manual/mcp-wait-for-answer-e2e.mjs.
//
// Assertions covered: A1 (no second server / no second port), A2 (the route gate), A9 (ONE call point,
// each side may fail without taking the other down), A10 (the file road is untouched), A11 (the durable
// evidence and its pointer), A13 (no path under ~/.claude).
const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewPath = resolve( here, '..', '..', 'src', 'MemoView.mjs' )
const memoViewSource = readFileSync( memoViewPath, 'utf-8' )


describe( 'PRD-V9 A1 — the endpoint hangs off the EXISTING server (no second port, no second process)', () => {
    it( 'the /mcp branch is dispatched from the ONE route body, keyed by the shared matcher', () => {
        const anchor = memoViewSource.indexOf( "if( McpEndpoint.isEndpointUrl( { url } )[ 'matches' ] === true ) {" )

        expect( anchor ).toBeGreaterThan( -1 )
        expect( memoViewSource.indexOf( 'const route = async ( req, res, url ) => {' ) ).toBeLessThan( anchor )
    } )


    it( 'adds NO new listener and keeps the loopback bind (3 counts compared against the pre-existing figures)', () => {
        const listens = memoViewSource.split( 'server.listen(' ).length - 1
        const createServers = memoViewSource.split( 'createServer(' ).length - 1
        const bindHosts = memoViewSource.split( "const BIND_HOST = '127.0.0.1'" ).length - 1

        // Pre-PRD-V9 figures, re-measurable with: grep -c "server.listen(" src/MemoView.mjs
        expect( listens ).toBe( 2 )
        expect( createServers ).toBe( 3 )
        expect( bindHosts ).toBe( 1 )
        expect( memoViewSource ).not.toMatch( /listen\(\s*\d+\s*\)/ )
    } )


    it( 'the endpoint path is declared ONCE and read from there, never re-typed (2 sites compared)', () => {
        const literalHits = memoViewSource.split( "'/mcp'" ).length - 1

        expect( McpEndpoint.ENDPOINT_PATH ).toBe( '/mcp' )
        expect( literalHits ).toBe( 0 )
    } )
} )


describe( 'PRD-V9 A2 — the origin gate sits in the route, loud and before the body', () => {
    it( 'the route rejects with 403 AND writes a named warning (3 anchors compared)', () => {
        const anchors = [
            'McpEndpoint.checkOrigin( {',
            'MCP-ORIGIN-403',
            "sendJson( res, 403, { 'error': `Forbidden: ${ originCheck[ 'reason' ] }`"
        ]
        const found = anchors.filter( ( anchor ) => memoViewSource.includes( anchor ) )

        expect( found ).toEqual( anchors )
    } )


    it( 'the origin gate runs BEFORE the request body is read', () => {
        const routeStart = memoViewSource.indexOf( "if( McpEndpoint.isEndpointUrl( { url } )[ 'matches' ] === true ) {" )
        const gateAt = memoViewSource.indexOf( 'McpEndpoint.checkOrigin( {', routeStart )
        const bodyAt = memoViewSource.indexOf( 'await readBody( req )', routeStart )

        expect( gateAt ).toBeGreaterThan( routeStart )
        expect( bodyAt ).toBeGreaterThan( gateAt )
    } )
} )


describe( 'PRD-V9 A9 — ONE call point, two delivery roads, neither takes the other down', () => {
    afterEach( () => {
        AnswerWaiter.resetForTests()
    } )


    it( 'a normal press writes the flags AND serves the register (2 sessions + 2 waiters compared)', async () => {
        const written = []
        const first = AnswerWaiter.register( { 'transcriptId': 'T-both', 'timeoutMs': 5000 } )
        const second = AnswerWaiter.register( { 'transcriptId': 'T-both', 'timeoutMs': 5000 } )

        const delivery = await MemoView.deliverTranscriptCompletion( {
            'transcriptId': 'T-both',
            'armedSessions': [ 'sess-a', 'sess-b' ],
            'writeFlag': async ( { sessionId, payload } ) => {
                written.push( { sessionId, payload } )

                return { 'status': true }
            }
        } )

        const settled = await Promise.all( [ first[ 'promise' ], second[ 'promise' ] ] )

        expect( written.length ).toBe( 2 )
        expect( written.map( ( entry ) => entry[ 'payload' ] ) ).toEqual( [ 'T-both', 'T-both' ] )
        expect( delivery[ 'woken' ] ).toEqual( [ 'sess-a', 'sess-b' ] )
        expect( delivery[ 'resolved' ] ).toBe( 2 )
        expect( settled.map( ( entry ) => entry[ 'outcome' ] ) ).toEqual( [ 'answered', 'answered' ] )
    } )


    it( 'a THROWING flag write does not stop the register — the waiting tool call is still served', async () => {
        const waiter = AnswerWaiter.register( { 'transcriptId': 'T-flagfail', 'timeoutMs': 5000 } )

        const delivery = await MemoView.deliverTranscriptCompletion( {
            'transcriptId': 'T-flagfail',
            'armedSessions': [ 'sess-a' ],
            'writeFlag': async () => { throw new Error( 'disk full' ) }
        } )
        const settled = await waiter[ 'promise' ]

        expect( delivery[ 'woken' ] ).toEqual( [] )
        expect( delivery[ 'resolved' ] ).toBe( 1 )
        expect( delivery[ 'messages' ].join( ' ' ) ).toMatch( /WAKE-FLAG-001/ )
        expect( settled[ 'outcome' ] ).toBe( 'answered' )
    } )


    it( 'a THROWING register does not stop the flag write — the file road still delivers', async () => {
        const written = []

        const delivery = await MemoView.deliverTranscriptCompletion( {
            'transcriptId': 'T-regfail',
            'armedSessions': [ 'sess-a', 'sess-b' ],
            'writeFlag': async ( { sessionId } ) => {
                written.push( sessionId )

                return { 'status': true }
            },
            'resolveWaiters': () => { throw new Error( 'register exploded' ) }
        } )

        expect( written ).toEqual( [ 'sess-a', 'sess-b' ] )
        expect( delivery[ 'woken' ] ).toEqual( [ 'sess-a', 'sess-b' ] )
        expect( delivery[ 'resolved' ] ).toBe( 0 )
        expect( delivery[ 'messages' ].join( ' ' ) ).toMatch( /WAIT-REGISTER-001/ )
    } )


    it( 'a flag write that answers status:false is counted as NOT woken, never as woken (2 compared)', async () => {
        const delivery = await MemoView.deliverTranscriptCompletion( {
            'transcriptId': 'T-mixed',
            'armedSessions': [ 'good', 'bad' ],
            'writeFlag': async ( { sessionId } ) => ( { 'status': sessionId === 'good' } )
        } )

        expect( delivery[ 'woken' ] ).toEqual( [ 'good' ] )
    } )


    it( 'the login route calls the ONE delivery point and no longer writes flags inline (3 anchors)', () => {
        const loginAt = memoViewSource.indexOf( "url.startsWith( '/api/transcripts/' ) && url.endsWith( '/login' )" )
        const region = memoViewSource.slice( loginAt, loginAt + 3000 )

        expect( loginAt ).toBeGreaterThan( -1 )
        expect( region ).toContain( 'MemoView.deliverTranscriptCompletion( { transcriptId, armedSessions } )' )
        expect( region ).toContain( 'MemoView.getArmedSessions( { transcriptId } )' )
        expect( region ).not.toContain( 'await MemoView.writeWakeFlag(' )
    } )
} )


describe( 'PRD-V9 A10 — the file road is untouched', () => {
    it( 'arm / wake / writeWakeFlag keep their signatures and their routes (5 anchors compared)', () => {
        const anchors = [
            'static async writeWakeFlag( { sessionId, payload } ) {',
            'static armSession( { sessionId, transcriptId } ) {',
            'static getArmedSessions( { transcriptId } ) {',
            "url.startsWith( '/api/session/' ) && url.endsWith( '/arm' ) && req.method === 'POST'",
            "url.startsWith( '/api/session/' ) && url.endsWith( '/wake' ) && req.method === 'POST'"
        ]
        const found = anchors.filter( ( anchor ) => memoViewSource.includes( anchor ) )

        expect( found ).toEqual( anchors )
    } )


    it( 'writeWakeFlag still writes the ephemeral flag with its payload (real file, 1 compared)', async () => {
        const result = await MemoView.writeWakeFlag( { 'sessionId': 'prdv9-probe', 'payload': 'T-probe' } )
        const body = await readFile( result[ 'flagPath' ], 'utf-8' )

        expect( result[ 'status' ] ).toBe( true )
        expect( body ).toBe( 'T-probe' )

        await rm( result[ 'flagPath' ], { 'force': true } )
    } )
} )


describe( 'PRD-V9 A11 — the durable evidence and its pointer', () => {
    let root = ''
    let memoDir = ''
    let transcriptsDir = ''
    let dbPath = ''
    const transcriptId = 'memo-init--080-db--REV-18--01'
    const transcriptBody = '# REV-18 review\n\n## Antwort auf F12 — Rueckkanal\nA\n'


    // The fake mirrors the REAL registry seam (resolveTranscriptFile), not the projected wire list.
    // That distinction is the defect this suite now guards: the wire list drops `absolutePath`, and a
    // fake that offered it made the unit test green while the real server handed back undefined.
    const fakeRegistry = () => ( {
        'resolveTranscriptFile': ( args ) => {
            if( args[ 'transcriptId' ] !== transcriptId ) {
                return { 'status': false, 'messages': [ `TRANSCRIPT-NOTFOUND-001: Transcript not found: ${ args[ 'transcriptId' ] }` ] }
            }

            return {
                'status': true,
                'messages': [],
                'absolutePath': join( transcriptsDir, 'REV-18--review--01.md' ),
                'transcriptsDir': transcriptsDir,
                'memoDir': memoDir,
                'revisionId': 'REV-18',
                'memoId': '080-db'
            }
        }
    } )


    beforeAll( async () => {
        await mkdir( join( process.cwd(), '.test-tmp' ), { 'recursive': true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'mcp-evidence-' ) )
        memoDir = join( root, '080-db-vollausbau' )
        transcriptsDir = join( memoDir, 'transcripts' )
        dbPath = join( memoDir, 'memo-080.db' )
        await mkdir( transcriptsDir, { 'recursive': true } )
        await writeFile( join( transcriptsDir, 'REV-18--review--01.md' ), transcriptBody, 'utf-8' )

        const db = new DatabaseSync( dbPath )
        db.exec( 'CREATE TABLE IF NOT EXISTS user_inputs ( input_id TEXT PRIMARY KEY, memo_id TEXT, kind TEXT, payload_verbatim TEXT, payload_sha256 TEXT, captured_at TEXT, source_channel TEXT, session_id TEXT, complete INTEGER, corrected_by TEXT, schema_version INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS user_input_answers ( input_id TEXT, question_id TEXT, option_key TEXT, answer_verbatim TEXT, preselected INTEGER )' )
        db.prepare( 'INSERT INTO user_inputs ( input_id, memo_id, kind, payload_verbatim, payload_sha256, captured_at, source_channel, session_id, complete, corrected_by, schema_version ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? )' )
            .run( 'UI-0042', 'M080', 'voice-review', transcriptBody, createHash( 'sha256' ).update( transcriptBody ).digest( 'hex' ), '2026-09-05T08:00:00Z', 'transcript-server', 'sess-1', 1, null, 1 )
        db.prepare( 'INSERT INTO user_input_answers ( input_id, question_id, option_key, answer_verbatim, preselected ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'UI-0042', 'F12', 'A', 'Protokoll-Weg mit Langlauf-Werkzeug', 0 )
        db.close()
    } )


    afterAll( async () => {
        await rm( root, { 'recursive': true, 'force': true } )
    } )


    it( 'reads loggedIn from the SIDECAR on disk — not from an in-memory flag (2 states compared)', async () => {
        const before = await MemoView.readAnswerEvidence( { 'memo': '080', transcriptId, 'registry': fakeRegistry() } )

        await writeFile( join( transcriptsDir, 'REV-18.loggedin' ), '', 'utf-8' )
        const after = await MemoView.readAnswerEvidence( { 'memo': '080', transcriptId, 'registry': fakeRegistry() } )

        expect( before[ 'found' ] ).toBe( true )
        expect( before[ 'loggedIn' ] ).toBe( false )
        expect( after[ 'loggedIn' ] ).toBe( true )

        await rm( join( transcriptsDir, 'REV-18.loggedin' ), { 'force': true } )
    } )


    it( 'binds the transcript to ITS answer rows and points at the durable store (1 answer / 1 input compared)', async () => {
        const evidence = await MemoView.readAnswerEvidence( { 'memo': '080', transcriptId, 'registry': fakeRegistry() } )

        expect( evidence[ 'match' ] ).toBe( 'sha256' )
        expect( evidence[ 'comparedInputs' ] ).toBe( 1 )
        expect( evidence[ 'answers' ] ).toEqual( [ { 'questionId': 'F12', 'optionKey': 'A', 'answerVerbatim': 'Protokoll-Weg mit Langlauf-Werkzeug', 'preselected': false } ] )
        expect( evidence[ 'evidencePath' ].endsWith( `memo-080.db#user_input_answers` ) ).toBe( true )
        expect( evidence[ 'messages' ] ).toEqual( [] )
    } )


    it( 'an UNREGISTERED transcript answers found:false with a named message, never an empty success', async () => {
        const evidence = await MemoView.readAnswerEvidence( { 'memo': '080', 'transcriptId': 'ghost--REV-99--01', 'registry': fakeRegistry() } )

        expect( evidence[ 'found' ] ).toBe( false )
        expect( evidence[ 'answers' ] ).toEqual( [] )
        expect( evidence[ 'messages' ].join( ' ' ) ).toMatch( /MCP-EVIDENCE-003/ )
        expect( evidence[ 'evidencePath' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'a memo WITHOUT a database points at the transcript FILE instead of an empty string (no-db)', async () => {
        const bare = join( root, '081-no-db' )
        const bareTranscripts = join( bare, 'transcripts' )
        await mkdir( bareTranscripts, { 'recursive': true } )
        await writeFile( join( bareTranscripts, 'REV-01--review--01.md' ), 'x\n', 'utf-8' )

        const evidence = await MemoView.readAnswerEvidence( {
            'memo': '081',
            'transcriptId': 'T-bare',
            'registry': {
                'resolveTranscriptFile': () => ( {
                    'status': true,
                    'messages': [],
                    'absolutePath': join( bareTranscripts, 'REV-01--review--01.md' ),
                    'transcriptsDir': bareTranscripts,
                    'memoDir': bare,
                    'revisionId': 'REV-01',
                    'memoId': '081'
                } )
            }
        } )

        expect( evidence[ 'found' ] ).toBe( true )
        expect( evidence[ 'match' ] ).toBe( 'no-db' )
        expect( evidence[ 'evidencePath' ].endsWith( 'REV-01--review--01.md' ) ).toBe( true )
        expect( evidence[ 'messages' ].join( ' ' ) ).toMatch( /MCP-EVIDENCE-004/ )
    } )


    it( 'the evidence pointer carries NO home directory once it lies in a .memo store (3 paths compared)', () => {
        const inStore = MemoView.projectRelativeEvidencePath( { 'absolutePath': `${ sep }Users${ sep }someone${ sep }p${ sep }.memo${ sep }memos${ sep }080${ sep }memo-080.db` } )
        const nested = MemoView.projectRelativeEvidencePath( { 'absolutePath': `${ sep }a${ sep }.memo${ sep }x${ sep }.memo${ sep }memos${ sep }080${ sep }f.md` } )
        const outside = MemoView.projectRelativeEvidencePath( { 'absolutePath': `${ sep }tmp${ sep }elsewhere${ sep }memo-080.db` } )

        expect( inStore ).toBe( `.memo${ sep }memos${ sep }080${ sep }memo-080.db` )
        expect( nested ).toBe( `.memo${ sep }memos${ sep }080${ sep }f.md` )
        expect( outside ).toBe( `${ sep }tmp${ sep }elsewhere${ sep }memo-080.db` )
        expect( () => MemoView.projectRelativeEvidencePath( {} ) ).toThrow( /"absolutePath" is required/ )
    } )
} )


// The guard against the exact defect the first flight uncovered: the wire projection does NOT carry the
// file path, so the answer channel must ask the registry's own resolver. A fake that offers a field the
// real registry withholds turns a green suite into a dead production path.
describe( 'PRD-V9 — the path seam matches the REAL registry, not a convenient fake', () => {
    it( 'the real registry HAS resolveTranscriptFile and its wire list does NOT carry absolutePath', async () => {
        const { TranscriptRegistry } = await import( '../../src/TranscriptRegistry.mjs' )
        const { registry } = TranscriptRegistry.create( { 'onChange': () => {}, 'host': 'localhost:3333' } )

        expect( typeof registry[ 'resolveTranscriptFile' ] ).toBe( 'function' )
        expect( registry.listTranscripts( {} )[ 'transcripts' ] ).toEqual( [] )
        expect( registry.resolveTranscriptFile( { 'transcriptId': 'nope' } )[ 'status' ] ).toBe( false )
        expect( registry.resolveTranscriptFile( { 'transcriptId': 'nope' } )[ 'messages' ].join( ' ' ) ).toMatch( /TRANSCRIPT-NOTFOUND-001/ )
        expect( registry.resolveTranscriptFile( {} )[ 'messages' ].join( ' ' ) ).toMatch( /TRANSCRIPT-ID-001/ )
    } )


    it( 'readAnswerEvidence reads the path through resolveTranscriptFile only (1 seam compared)', () => {
        const at = memoViewSource.indexOf( 'static async readAnswerEvidence( {' )
        const end = memoViewSource.indexOf( 'static projectRelativeEvidencePath( {', at )
        const region = memoViewSource.slice( at, end )

        expect( at ).toBeGreaterThan( -1 )
        expect( region ).toContain( 'store.resolveTranscriptFile( { transcriptId } )' )
        expect( region ).not.toContain( 'listTranscripts' )
        // the ONLY absolutePath read is the resolver's own return field
        expect( region.split( "[ 'absolutePath' ]" ).length - 1 ).toBe( 1 )
        expect( region ).toContain( "located[ 'absolutePath' ]" )
    } )
} )


describe( 'PRD-V9 A13 — nothing under ~/.claude is written by this unit', () => {
    it( 'no source file of the answer channel names a home-scoped claude path (4 files scanned)', () => {
        const files = [ 'MemoView.mjs', 'McpEndpoint.mjs', 'AnswerWaiter.mjs', 'DoltDbAssembler.mjs' ]
        const offenders = files
            .filter( ( name ) => {
                const source = readFileSync( resolve( here, '..', '..', 'src', name ), 'utf-8' )

                return /\.claude\//.test( source ) === true || /homedir\(/.test( source ) === true
            } )

        expect( files.length ).toBe( 4 )
        expect( offenders ).toEqual( [] )
    } )
} )
