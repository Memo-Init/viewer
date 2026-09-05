// health-endpoint-e2e.mjs — PRD-V11 (Memo 080, Kap 19 / WI-099, WI-100) against a REAL server.
//
// WHY A REAL SERVER. `GET /api/health` exists to answer one question honestly: is the process that is
// listening running the code that lies on disk? That question can not be settled by a mock — a mock
// would only prove the mock. So this harness starts the actual memo-view server from a THROWAWAY COPY
// of src/, asks the endpoint over the wire, then edits a module IN THE COPY and asks again. The flip
// from `stale: false` to `stale: true` is measured, not claimed.
//
// It also closes the loop the PRD cares about: after each answer it runs the real
// `memo session statusline` leaf against the same port and compares what the STATUS LINE would render
// (`view up` / `view stale`). Endpoint and consumer are proven together, because a green endpoint with
// a consumer that misreads it is still a broken status line.
//
// Run: MEMOVIEW_NO_BROWSER=1 node tests/manual/health-endpoint-e2e.mjs  -> exits 0 on success, 1 on any fail.
// Nothing under ~/.claude and nothing under the real .memo/ is written: the copy lives in .test-tmp/,
// the server's working directory is a fresh temp dir.

import { cp, mkdtemp, mkdir, rm, appendFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createConnection } from 'node:net'


const run = promisify( execFile )

const PORT = 47961
const PORT_INVENTORY = [ 3333, 4444, 5555, 6666, 7777, 8888, PORT ]
const REPO = resolve( new URL( '../..', import.meta.url ).pathname )
const CORE_CLI = resolve( REPO, '..', 'core', 'cli', 'bin', 'memo.mjs' )
const PROJECT_ROOT = resolve( REPO, '..', '..' )

const results = []


const check = ( label, passed, detail ) => {
    results.push( { label, passed } )
    process.stdout.write( `  ${ passed === true ? 'OK  ' : 'FAIL' }  ${ label }${ detail === undefined ? '' : ` — ${ detail }` }\n` )
}


const wait = ( ms ) => { return new Promise( ( done ) => setTimeout( done, ms ) ) }


// A port probe that does NOT need `nc`: open a socket, note whether anything answered, close it.
const probePort = ( port ) => {
    return new Promise( ( done ) => {
        const socket = createConnection( { host: '127.0.0.1', port } )
        const settle = ( inUse ) => { socket.destroy(); done( { port, inUse } ) }
        socket.setTimeout( 400 )
        socket.on( 'connect', () => settle( true ) )
        socket.on( 'timeout', () => settle( false ) )
        socket.on( 'error', () => settle( false ) )
    } )
}


const inventory = async () => {
    const seen = await Promise.all( PORT_INVENTORY.map( ( port ) => probePort( port ) ) )

    return seen.filter( ( entry ) => entry.inUse === true ).map( ( entry ) => entry.port )
}


const statuslineView = async ( { port } ) => {
    const answered = await run( process.execPath, [ CORE_CLI, 'session', 'statusline', '--memo', '080', '--project-root', PROJECT_ROOT, '--port', String( port ) ], { maxBuffer: 8 * 1024 * 1024 } )
        .catch( ( error ) => { return { stdout: error.stdout === undefined ? '' : error.stdout } } )

    try {
        const parsed = JSON.parse( answered.stdout )

        return { ok: parsed.status === true, viewState: parsed.viewState, stale: parsed.viewStale, gaps: parsed.gaps }
    } catch {
        return { ok: false, viewState: null, stale: null, gaps: 'unparsable' }
    }
}


const main = async () => {
    process.env[ 'MEMOVIEW_NO_BROWSER' ] = '1'

    if( existsSync( CORE_CLI ) !== true ) {
        process.stderr.write( `\n  BLOCKED: die memo-CLI ist nicht aufloesbar (${ CORE_CLI }) — ohne sie kann die Verbraucher-Seite nicht gemessen werden.\n\n` )
        process.exit( 1 )
    }

    const before = await inventory()
    process.stdout.write( `\n  Port-Inventar vor dem Start: ${ before.length === 0 ? 'keiner belegt' : before.join( ', ' ) }\n` )

    await mkdir( join( REPO, '.test-tmp' ), { recursive: true } )
    const copyRoot = await mkdtemp( join( REPO, '.test-tmp', 'health-e2e-' ) )
    const srcCopy = join( copyRoot, 'src' )
    await cp( join( REPO, 'src' ), srcCopy, { recursive: true } )
    const modules = ( await readdir( srcCopy ) ).filter( ( name ) => name.endsWith( '.mjs' ) === true && name.endsWith( '.test.mjs' ) === false )
    check( 'die Wegwerf-Kopie traegt den vollstaendigen Server-Baum', modules.length > 20, `${ modules.length } Module kopiert` )

    // The server's working directory is a fresh temp tree: its boot auto-registration never sees the
    // real .memo/ of this project.
    const workDir = await mkdtemp( join( tmpdir(), 'health-e2e-work-' ) )
    process.chdir( workDir )

    const { MemoView } = await import( join( srcCopy, 'MemoView.mjs' ) )
    await MemoView.startServer( { port: PORT } )

    const after = await inventory()
    const added = after.filter( ( port ) => before.includes( port ) === false )
    check( 'A11: der Start hat GENAU EINEN Port belegt, und zwar den eigenen', added.length === 1 && added[ 0 ] === PORT, `neu belegt: ${ added.join( ', ' ) }` )

    const first = await fetch( `http://127.0.0.1:${ PORT }/api/health` )
    const firstBody = await first.json()
    check( 'A9: der laufende Server antwortet mit 200 und stale false', first.status === 200 && firstBody[ 'stale' ] === false, `HTTP ${ first.status } · stale ${ firstBody[ 'stale' ] } · ${ firstBody[ 'hashedFiles' ] } Module gehasht · bootHash ${ firstBody[ 'bootHash' ] }` )
    check( 'A9: die Antwort ist unspeicherbar ausgezeichnet', first.headers.get( 'cache-control' ) === 'no-store', `Cache-Control: ${ first.headers.get( 'cache-control' ) }` )
    check( 'A9: der Rumpf traegt alle neun Felder', [ 'status', 'pid', 'port', 'startedAt', 'uptimeSeconds', 'bootHash', 'currentHash', 'stale', 'memoRoot' ].every( ( key ) => Object.keys( firstBody ).includes( key ) === true ), Object.keys( firstBody ).join( ',' ) )

    const viewUp = await statuslineView( { port: PORT } )
    check( 'A9 (Verbraucher): die Statuszeile liest daraus "view up"', viewUp.ok === true && viewUp.viewState === 'up', `viewState ${ viewUp.viewState } · gaps "${ viewUp.gaps }"` )

    const second = await fetch( `http://127.0.0.1:${ PORT }/api/health` )
    const secondBody = await second.json()
    check( 'A12: zwei Anfragen ohne Quell-Aenderung loesen genau EINEN Hash-Vorgang aus', secondBody[ 'hashComputations' ] === 1, `hashComputations ${ firstBody[ 'hashComputations' ] } -> ${ secondBody[ 'hashComputations' ] }` )

    // The flip: a module the running process already loaded is changed on disk. This is exactly the
    // "3-Tage-STALE-Server" case that `nc -z` colours green.
    await appendFile( join( srcCopy, 'DoltDbAssembler.mjs' ), '\n// a later edit the running process never saw (PRD-V11 e2e)\n', 'utf8' )
    await wait( 50 )

    const third = await fetch( `http://127.0.0.1:${ PORT }/api/health` )
    const thirdBody = await third.json()
    check( 'A10: nach der Quell-Aenderung meldet derselbe Server stale true — bei weiterhin HTTP 200', third.status === 200 && thirdBody[ 'stale' ] === true, `HTTP ${ third.status } · bootHash ${ thirdBody[ 'bootHash' ] } · currentHash ${ thirdBody[ 'currentHash' ] }` )
    check( 'A10: der Boot-Hash ist eingefroren geblieben', thirdBody[ 'bootHash' ] === firstBody[ 'bootHash' ], `${ firstBody[ 'bootHash' ] } === ${ thirdBody[ 'bootHash' ] }` )
    check( 'A12: erst die echte Aenderung hat neu gehasht', thirdBody[ 'hashComputations' ] === 2, `hashComputations 1 -> ${ thirdBody[ 'hashComputations' ] }` )

    const viewStale = await statuslineView( { port: PORT } )
    check( 'A10 (Verbraucher): die Statuszeile liest daraus "view stale"', viewStale.ok === true && viewStale.viewState === 'stale', `viewState ${ viewStale.viewState }` )

    // The endpoint must never hold a connection (that is PRD-V9's job): measure it.
    const startedAt = Date.now()
    await Promise.all( [ 0, 1, 2, 3, 4 ].map( () => fetch( `http://127.0.0.1:${ PORT }/api/health` ) ) )
    const elapsed = Date.now() - startedAt
    check( 'der Endpunkt haelt keine Verbindung: fuenf Anfragen sind in unter einer Sekunde beantwortet', elapsed < 1000, `${ elapsed } ms fuer 5 Anfragen` )

    // The port probe the endpoint replaces: it can NOT tell these two states apart. Shown, not claimed.
    const probe = await probePort( PORT )
    check( 'Gegenprobe: die reine Port-Pruefung meldet in BEIDEN Zustaenden dasselbe', probe.inUse === true, `nc-Aequivalent: belegt=${ probe.inUse }, waehrend der Server stale ist` )

    // The listener is released by the process exit below (the harness owns the whole process); the
    // throwaway copy and the working directory are removed here so nothing survives the run.
    process.chdir( REPO )
    await rm( copyRoot, { recursive: true, force: true } )
    await rm( workDir, { recursive: true, force: true } )

    const failed = results.filter( ( entry ) => entry.passed !== true )
    process.stdout.write( `\n  ${ results.length - failed.length } von ${ results.length } Pruefungen bestanden\n\n` )

    if( results.length === 0 ) {
        process.stderr.write( '  FAIL-VACUUM: keine einzige Pruefung gelaufen — das ist rot, nicht gruen.\n\n' )
        process.exit( 1 )
    }

    process.exit( failed.length === 0 ? 0 : 1 )
}


main()
    .catch( ( error ) => {
        process.stderr.write( `\n  ABBRUCH: ${ error.stack }\n\n` )
        process.exit( 1 )
    } )
