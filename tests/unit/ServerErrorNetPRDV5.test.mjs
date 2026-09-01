import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { readFile, writeFile, mkdir, mkdtemp, rm, chmod, stat } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'
import { UserInputCapture } from '../../src/UserInputCapture.mjs'


// PRD-V5 (Memo 080, Kap 16 — WI-136): das Fehlernetz mit vier Maschen. The request handler was a bare
// async function without an enclosing try, the URL decode was its unguarded first statement, no
// response/request/output-channel guard existed anywhere, and the server never wrote a single byte to
// disk — so the 2026-08-23 crash forensics ended at "kein Logfile".
//
// Following the suite convention for the private #createHttpHandler (DbTablesRoutePRDV1.test.mjs),
// the pure leaves behind each mesh are exercised DIRECTLY and the wiring is asserted against the
// handler source string. Every case states HOW MUCH it compared (status codes, listeners, lines,
// bytes, files) — a check without a comparison base counts as red, not green
// (lesson deterministic-gates-can-be-vacuum-green).
const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewPath = resolve( here, '..', '..', 'src', 'MemoView.mjs' )
const userInputPath = resolve( here, '..', '..', 'src', 'UserInputCapture.mjs' )

let memoViewSource = ''
let userInputSource = ''
let memoViewCode = ''
let userInputCode = ''


// Counting guards on the raw source would count the COMMENTS that name them too (this PRD documents
// each mesh right above it). Every "how many are wired" assertion therefore counts on the
// comment-free projection; the prose assertions keep reading the raw source.
function stripLineComments( text ) {
    return text
        .split( '\n' )
        .filter( ( line ) => line.trim().startsWith( '//' ) === false )
        .join( '\n' )
}


// Test isolation: #logError resolves its target through SessionConfigStore, which ascends to the REAL
// shared .sessions/ dir. Without this redirect the suite would append jest stack traces to the user's
// live log. MEMOVIEW_SESSION_CONFIG pins the resolution into the repo-internal .test-tmp/ instead.
const originalSessionConfig = process.env[ 'MEMOVIEW_SESSION_CONFIG' ]
let sandboxSessionDir = ''


beforeAll( async () => {
    await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
    sandboxSessionDir = await mkdtemp( join( process.cwd(), '.test-tmp', 'logsink-' ) )
    process.env[ 'MEMOVIEW_SESSION_CONFIG' ] = join( sandboxSessionDir, 'config.json' )

    memoViewSource = await readFile( memoViewPath, 'utf8' )
    userInputSource = await readFile( userInputPath, 'utf8' )
    memoViewCode = stripLineComments( memoViewSource )
    userInputCode = stripLineComments( userInputSource )
} )


afterAll( async () => {
    if( originalSessionConfig === undefined ) {
        delete process.env[ 'MEMOVIEW_SESSION_CONFIG' ]
    } else {
        process.env[ 'MEMOVIEW_SESSION_CONFIG' ] = originalSessionConfig
    }

    await rm( sandboxSessionDir, { recursive: true, force: true } )
} )


describe( 'PRD-V5 Masche 1 — Handler-Fang: 500 statt Prozess-Tod', () => {

    it( 'der Routing-Rumpf liegt in GENAU EINEM try/catch (Vergleich: 1 route-Aufruf, 1 umschliessendes try)', () => {
        const routedCalls = memoViewCode.match( /await route\( req, res, decoded\[ 'url' \] \)/g ) || []
        const guardedCall = /try \{\n\s+await route\( req, res, decoded\[ 'url' \] \)\n\s+\} catch \( err \) \{/.test( memoViewCode )

        expect( routedCalls.length ).toBe( 1 )
        expect( guardedCall ).toBe( true )
    } )


    it( 'der Fang-Zweig antwortet 500 und protokolliert Art, Adresse, Methode und Fehler (4 Felder)', () => {
        const catchBlock = memoViewSource.slice( memoViewSource.indexOf( 'await route( req, res, decoded' ) )
        const window = catchBlock.slice( 0, 900 )

        expect( window ).toContain( "'kind': 'handler'" )
        expect( window ).toContain( "'url': req.url" )
        expect( window ).toContain( "'method': req.method" )
        expect( window ).toContain( "'error': err" )
        expect( window ).toContain( 'res.writeHead( 500' )
    } )


    it( 'bei bereits gesendeten Kopfzeilen wird NICHT erneut geschrieben (headersSent-Zweig vor writeHead)', () => {
        const start = memoViewSource.indexOf( "await MemoView.#logError( { 'kind': 'handler'" )
        const window = memoViewSource.slice( start, start + 500 )
        const destroyIndex = window.indexOf( 'res.destroy()' )
        const writeHeadIndex = window.indexOf( 'res.writeHead( 500' )

        expect( window ).toContain( 'res.headersSent === true' )
        expect( destroyIndex ).toBeGreaterThan( -1 )
        expect( writeHeadIndex ).toBeGreaterThan( destroyIndex )
    } )


    it( 'das prozess-weite Netz aus Memo 081 bleibt bestehen und ist die LETZTE Masche (je 1 Treffer)', () => {
        const uncaught = memoViewSource.match( /process\.on\( 'uncaughtException', survive\( 'uncaughtException' \) \)/g ) || []
        const unhandled = memoViewSource.match( /process\.on\( 'unhandledRejection', survive\( 'unhandledRejection' \) \)/g ) || []

        expect( uncaught.length ).toBe( 1 )
        expect( unhandled.length ).toBe( 1 )
        // unveraenderte Semantik: es lebt weiter und schreibt weiterhin nach stderr
        expect( memoViewSource ).toContain( 'SURVIVED ${ kind }' )
        // ... und jetzt zusaetzlich in das durable Protokoll
        expect( memoViewSource ).toContain( "MemoView.#logError( { kind, 'url': null, 'method': null, 'error': err } )" )
    } )
} )


describe( 'PRD-V5 Masche 2a — Dekodier-Schutz: 400 statt Wurf', () => {

    it( 'GET /% wird abgefangen (status false, Klartext-Meldung) — heute beendet es den Prozess', () => {
        const out = MemoView.decodeRequestPath( { 'rawUrl': '/%' } )

        expect( out[ 'status' ] ).toBe( false )
        expect( out[ 'url' ] ).toBe( null )
        expect( out[ 'message' ] ).toMatch( /Bad Request/ )
    } )


    it( 'GET /%zz wird abgefangen (zweiter Fall, eigener Test wie im PRD verlangt)', () => {
        const out = MemoView.decodeRequestPath( { 'rawUrl': '/%zz' } )

        expect( out[ 'status' ] ).toBe( false )
        expect( out[ 'message' ] ).toMatch( /Bad Request/ )
    } )


    it( 'roher decodeURIComponent wirft bei denselben 2 Eingaben — der Schutz ist nicht kosmetisch', () => {
        const broken = [ '/%', '/%zz' ]
        const throwing = broken.filter( ( raw ) => {
            try {
                decodeURIComponent( raw )

                return false
            } catch {
                return true
            }
        } )

        expect( throwing.length ).toBe( 2 )
    } )


    it( 'gueltige kodierte Adressen bleiben unveraendert bedient (4 Faelle, Abfrageteil abgeschnitten)', () => {
        const cases = [
            [ '/api/documents', '/api/documents' ],
            [ '/api/documents?q=a%20b', '/api/documents' ],
            [ '/memos%2Ffoo', '/memos/foo' ],
            [ '/spec-page?namespace=memo&page=01%2Dphilosophy', '/spec-page' ]
        ]
        const results = cases.map( ( [ raw, expected ] ) => {
            const out = MemoView.decodeRequestPath( { 'rawUrl': raw } )

            return out[ 'status' ] === true && out[ 'url' ] === expected
        } )

        expect( results.length ).toBe( 4 )
        expect( results.filter( ( ok ) => ok === true ).length ).toBe( 4 )
    } )


    it( 'der Handler nutzt den Schutz VOR jeder Route und antwortet 400 (1 Aufrufstelle)', () => {
        const calls = memoViewSource.match( /MemoView\.decodeRequestPath\( \{ 'rawUrl': req\.url \} \)/g ) || []
        const rawDecode = memoViewSource.match( /const url = decodeURIComponent\( req\.url/g ) || []

        expect( calls.length ).toBe( 1 )
        expect( rawDecode.length ).toBe( 0 )
        expect( memoViewSource ).toContain( 'res.writeHead( 400' )
    } )
} )


describe( 'PRD-V5 Masche 2b — Verbindungs-Waechter (Antwort und Anfrage)', () => {

    it( "res.on( 'error' ) ist an GENAU EINER Stelle je Anfrage gesetzt — nicht 108-mal (heute 0)", () => {
        const responseGuards = memoViewCode.match( /res\.on\( 'error'/g ) || []
        const sendJsonCalls = memoViewCode.match( /sendJson\( res,/g ) || []

        expect( responseGuards.length ).toBe( 1 )
        // Vergleichsgrundlage: die Zahl der Antwort-Aufrufe, die dieser EINE Waechter abdeckt.
        expect( sendJsonCalls.length ).toBeGreaterThan( 100 )
    } )


    it( 'der Koerper-Leser registriert data, end, aborted UND error (4 Kanaele, heute 2)', () => {
        const readerStart = memoViewSource.indexOf( 'static readRequestBody( { req } )' )
        const readerBody = memoViewSource.slice( readerStart, readerStart + 1400 )
        const channels = [ "req.on( 'data'", "req.on( 'end'", "req.on( 'aborted'", "req.on( 'error'" ]
        const present = channels.filter( ( channel ) => readerBody.includes( channel ) === true )

        expect( readerStart ).toBeGreaterThan( -1 )
        expect( present.length ).toBe( 4 )
    } )


    it( 'ein normaler Koerper loest mit { body, aborted:false } auf (Vergleich: 2 Bloecke, 9 Bytes)', async () => {
        const req = new EventEmitter()
        req.url = '/api/x'
        req.method = 'POST'

        const promise = MemoView.readRequestBody( { req } )
        req.emit( 'data', Buffer.from( '{"a":1,' ) )
        req.emit( 'data', Buffer.from( '"b":2}' ) )
        req.emit( 'end' )

        const out = await promise

        expect( out[ 'aborted' ] ).toBe( false )
        expect( out[ 'body' ] ).toBe( '{"a":1,"b":2}' )
        expect( Buffer.byteLength( out[ 'body' ] ) ).toBe( 13 )
    } )


    it( 'ein ABGEBROCHENER Koerper loest binnen einer Sekunde auf statt ewig zu haengen', async () => {
        const req = new EventEmitter()
        req.url = '/api/transcripts'
        req.method = 'POST'

        const started = Date.now()
        const promise = MemoView.readRequestBody( { req } )
        req.emit( 'data', Buffer.from( 'halb' ) )
        req.emit( 'aborted' )

        const out = await Promise.race( [
            promise,
            new Promise( ( resolvePromise ) => setTimeout( () => resolvePromise( { 'timedOut': true } ), 1000 ) )
        ] )
        const elapsed = Date.now() - started

        expect( out[ 'timedOut' ] ).toBeUndefined()
        expect( out[ 'aborted' ] ).toBe( true )
        expect( out[ 'body' ] ).toBe( null )
        expect( elapsed ).toBeLessThan( 1000 )
    } )


    it( "ein 'error'-Ereignis auf der Anfrage wirft NICHT, sondern loest als Abbruch auf", async () => {
        const req = new EventEmitter()
        req.url = '/api/transcripts'
        req.method = 'POST'

        const promise = MemoView.readRequestBody( { req } )
        // Ohne Zuhoerer wuerde exakt dieses emit in Node werfen.
        req.emit( 'error', new Error( 'ECONNRESET' ) )

        const out = await promise

        expect( out[ 'aborted' ] ).toBe( true )
        expect( out[ 'body' ] ).toBe( null )
    } )


    it( 'die Zusage loest genau EINMAL auf, auch wenn Abbruch und Ende beide feuern', async () => {
        const req = new EventEmitter()
        req.url = '/api/x'
        req.method = 'POST'

        const promise = MemoView.readRequestBody( { req } )
        req.emit( 'aborted' )
        req.emit( 'data', Buffer.from( 'spaet' ) )
        req.emit( 'end' )

        const out = await promise

        expect( out[ 'aborted' ] ).toBe( true )
    } )


    it( 'ALLE 14 Aufrufstellen werten den Abbruch aus (14 Leser, 14 Wachen)', () => {
        const readers = memoViewSource.match( /const \{ body, aborted \} = await readBody\( req \)/g ) || []
        const guards = memoViewSource.match( /if\( aborted === true \) \{ return \}/g ) || []
        const oldReaders = memoViewSource.match( /const \{ body \} = await readBody\( req \)/g ) || []

        expect( readers.length ).toBe( 14 )
        expect( guards.length ).toBe( 14 )
        expect( oldReaders.length ).toBe( 0 )
    } )
} )


describe( 'PRD-V5 Masche 3 — Ausgabekanal- und Kindprozess-Waechter', () => {
    const attached = { 'stdout': null, 'stderr': null }


    afterAll( () => {
        if( attached[ 'stdout' ] !== null ) { process.stdout.off( 'error', attached[ 'stdout' ] ) }
        if( attached[ 'stderr' ] !== null ) { process.stderr.off( 'error', attached[ 'stderr' ] ) }
    } )


    it( 'stdout und stderr erhalten je EINEN error-Zuhoerer (Vergleich: 0 -> 1 je Kanal)', () => {
        const beforeOut = process.stdout.listenerCount( 'error' )
        const beforeErr = process.stderr.listenerCount( 'error' )

        const armed = MemoView.armOutputChannelGuards()
        attached[ 'stdout' ] = armed[ 'stdoutGuard' ]
        attached[ 'stderr' ] = armed[ 'stderrGuard' ]

        const afterOut = process.stdout.listenerCount( 'error' )
        const afterErr = process.stderr.listenerCount( 'error' )

        expect( beforeOut ).toBe( 0 )
        expect( beforeErr ).toBe( 0 )
        expect( afterOut ).toBe( 1 )
        expect( afterErr ).toBe( 1 )
    } )


    it( 'ein zweiter Aufruf legt KEINEN zweiten Zuhoerer nach (idempotent, weiterhin 1 je Kanal)', () => {
        const second = MemoView.armOutputChannelGuards()

        expect( second[ 'armed' ] ).toBe( false )
        expect( process.stdout.listenerCount( 'error' ) ).toBe( 1 )
        expect( process.stderr.listenerCount( 'error' ) ).toBe( 1 )
    } )


    it( 'die Waechter werden beim Start scharf gestellt (1 Aufruf in #registerShutdown)', () => {
        const calls = memoViewCode.match( /MemoView\.armOutputChannelGuards\(\)/g ) || []
        const shutdownStart = memoViewCode.indexOf( 'static #registerShutdown(' )
        const shutdownBody = memoViewCode.slice( shutdownStart )

        expect( calls.length ).toBe( 1 )
        expect( shutdownBody ).toContain( 'MemoView.armOutputChannelGuards()' )
    } )


    it( "child.stdin traegt einen error-Zuhoerer (heute 0) — 1 Treffer in UserInputCapture", () => {
        const guards = userInputCode.match( /child\.stdin\.on\( 'error'/g ) || []
        const childGuards = userInputCode.match( /child\.on\( 'error'/g ) || []

        expect( guards.length ).toBe( 1 )
        // die bestehende Kindprozess-Wache bleibt unangetastet
        expect( childGuards.length ).toBe( 1 )
    } )


    it( 'ein erfundener Programmname liefert { status:false } mit Meldung und WIRFT NICHT', async () => {
        const out = await UserInputCapture.recordInput( {
            'memoId': '080',
            'kind': 'voice-review',
            'sessionId': 'test-session',
            'source': 'transcript-server',
            'payload': 'x'.repeat( 200000 ),
            'bin': 'memo-view-prdv5-does-not-exist'
        } )

        expect( out[ 'status' ] ).toBe( false )
        expect( out[ 'inputId' ] ).toBe( null )
        expect( out[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'ein WIRKLICHES write EPIPE auf child.stdin bleibt folgenlos — der Fall, der ohne Waechter toetet', async () => {
        // Nachgemessen: der ENOENT-Fall oben laeuft AUCH ohne Waechter durch (die Zusage loest ueber
        // child.on('error') auf, bevor stdin ueberhaupt meckert) — er allein waere ein Vakuum-Test.
        // DIESER Fall provoziert das echte Ereignis: ein Kind, das sofort endet, waehrend ~8 MB auf
        // seine Eingabe laufen. Ohne `child.stdin.on( 'error' )` ist das eine uncaughtException und
        // damit der Prozess-Tod; mit Waechter ist es eine Meldung im Ergebnis.
        const out = await UserInputCapture.recordInput( {
            'memoId': '080',
            'kind': 'voice-review',
            'sessionId': 'test-session',
            'source': 'transcript-server',
            'payload': 'x'.repeat( 8000000 ),
            'bin': '/bin/sh'
        } )

        expect( out[ 'status' ] ).toBe( false )
        expect( out[ 'inputId' ] ).toBe( null )
        expect( out[ 'messages' ].length ).toBe( 1 )
        expect( out[ 'messages' ][ 0 ] ).toMatch( /EPIPE/ )
    } )
} )


describe( 'PRD-V5 Masche 4 — durables Protokoll', () => {
    let root = ''


    beforeAll( async () => {
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'errorlog-' ) )
    } )


    afterAll( async () => {
        await chmod( join( root, 'readonly' ), 0o755 ).catch( () => {} )
        await rm( root, { recursive: true, force: true } )
    } )


    it( 'der Protokollpfad liegt NEBEN der Sitzungs-Ablage (1 aufgeloester Pfad, Dateiname memo-view.log)', async () => {
        const sessionsDir = join( root, '.sessions' )
        await mkdir( sessionsDir, { recursive: true } )
        await writeFile( join( sessionsDir, 'config.json' ), JSON.stringify( { 'projects': [] } ), 'utf8' )

        const { logPath } = MemoView.resolveErrorLogPath( { 'cwd': root, 'env': {} } )

        expect( logPath ).toBe( join( sessionsDir, 'memo-view.log' ) )
    } )


    it( 'ohne Sitzungs-Ablage faellt der Pfad auf das Betriebssystem-Temp zurueck (nie null)', () => {
        const { logPath } = MemoView.resolveErrorLogPath( { 'cwd': '/', 'env': {} } )

        expect( typeof logPath ).toBe( 'string' )
        expect( logPath.endsWith( 'memo-view.log' ) ).toBe( true )
    } )


    it( 'eine Protokollzeile traegt Zeitstempel, Art, Methode, Adresse und Stapel (5 Felder, 1 Zeile)', () => {
        const error = new Error( 'boom')
        const { line } = MemoView.formatErrorLogLine( { 'kind': 'handler', 'url': '/api/documents', 'method': 'POST', error } )

        expect( line.split( '\n' ).length ).toBe( 2 )
        expect( line ).toMatch( /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] handler POST \/api\/documents :: / )
        expect( line ).toContain( 'Error: boom' )
        expect( line ).toContain( 'ServerErrorNetPRDV5' )
    } )


    it( 'nach einem provozierten Fehler waechst die Protokolldatei um GENAU 1 Zeile (0 -> 1 -> 2)', async () => {
        const logPath = join( root, 'grow.log' )
        const countLines = async () => {
            try {
                const text = await readFile( logPath, 'utf8' )

                return text.split( '\n' ).filter( ( l ) => l.length > 0 ).length
            } catch {
                return 0
            }
        }

        const before = await countLines()
        const first = MemoView.formatErrorLogLine( { 'kind': 'handler', 'url': '/%', 'method': 'GET', 'error': new Error( 'URIError' ) } )
        const wrote = await MemoView.writeErrorLog( { logPath, 'line': first[ 'line' ] } )
        const afterOne = await countLines()

        const second = MemoView.formatErrorLogLine( { 'kind': 'response', 'url': '/app.client.mjs', 'method': 'GET', 'error': new Error( 'EPIPE' ) } )
        await MemoView.writeErrorLog( { logPath, 'line': second[ 'line' ] } )
        const afterTwo = await countLines()

        expect( wrote[ 'status' ] ).toBe( true )
        expect( wrote[ 'fallback' ] ).toBe( false )
        expect( before ).toBe( 0 )
        expect( afterOne ).toBe( 1 )
        expect( afterTwo ).toBe( 2 )
    } )


    it( 'ein UNBESCHREIBBARER Protokollpfad ist folgenlos — Rueckfall auf stderr, kein Wurf', async () => {
        const readonlyDir = join( root, 'readonly' )
        await mkdir( readonlyDir, { recursive: true } )
        await chmod( readonlyDir, 0o500 )

        const captured = []
        const originalWrite = process.stderr.write.bind( process.stderr )
        process.stderr.write = ( chunk ) => { captured.push( String( chunk ) ); return true }

        let out = null

        try {
            out = await MemoView.writeErrorLog( { 'logPath': join( readonlyDir, 'nope.log' ), 'line': 'X\n' } )
        } finally {
            process.stderr.write = originalWrite
        }

        expect( out[ 'status' ] ).toBe( false )
        expect( out[ 'fallback' ] ).toBe( true )
        expect( out[ 'message' ] ).toMatch( /MEMOVIEW-LOG-002/ )
        expect( captured.length ).toBe( 1 )
        expect( captured[ 0 ] ).toBe( 'X\n' )
    } )


    it( 'ein leerer Protokollpfad ist folgenlos — Rueckfall statt Wurf', async () => {
        const captured = []
        const originalWrite = process.stderr.write.bind( process.stderr )
        process.stderr.write = ( chunk ) => { captured.push( String( chunk ) ); return true }

        let out = null

        try {
            out = await MemoView.writeErrorLog( { 'logPath': '', 'line': 'Y\n' } )
        } finally {
            process.stderr.write = originalWrite
        }

        expect( out[ 'fallback' ] ).toBe( true )
        expect( out[ 'message' ] ).toMatch( /MEMOVIEW-LOG-001/ )
        expect( captured.length ).toBe( 1 )
    } )


    it( 'das Protokoll enthaelt KEINE Transcript-Inhalte (1 Erkennungszeichenfolge, 0 Treffer)', async () => {
        const sentinel = 'PRDV5-SENTINEL-4f2a9c-GEHEIMER-TRANSCRIPT-TEXT'
        const transcriptsDir = join( root, 'memo', 'transcripts' )
        await mkdir( transcriptsDir, { recursive: true } )
        const transcriptPath = join( transcriptsDir, 'REV-01--review--01.md' )
        await writeFile( transcriptPath, `# Transcript zu Memo 080 x — Revision REV-01\n\n## Transcript-Inhalt\n\n${ sentinel }\n`, 'utf8' )

        const logPath = join( root, 'no-leak.log' )
        const error = new Error( 'Atomic write failed' )
        const { line } = MemoView.formatErrorLogLine( { 'kind': 'handler', 'url': '/api/transcripts/T-1', 'method': 'PUT', error } )
        await MemoView.writeErrorLog( { logPath, line } )

        const written = await readFile( logPath, 'utf8' )
        const transcript = await readFile( transcriptPath, 'utf8' )
        const hits = written.split( sentinel ).length - 1

        expect( transcript ).toContain( sentinel )
        expect( hits ).toBe( 0 )
        expect( written.split( '\n' ).filter( ( l ) => l.length > 0 ).length ).toBe( 1 )
    } )


    it( 'formatErrorLogLine baut die Zeile NUR aus kind/url/method/error — keine weitere Quelle', () => {
        const start = memoViewSource.indexOf( 'static formatErrorLogLine(' )
        const body = memoViewSource.slice( start, memoViewSource.indexOf( 'return { line }', start ) )
        const forbidden = [ 'content', 'body', 'transcript', 'process.env' ]
        const leaks = forbidden.filter( ( token ) => body.includes( token ) === true )

        expect( start ).toBeGreaterThan( -1 )
        expect( leaks.length ).toBe( 0 )
    } )


    it( 'der Server schreibt ueberhaupt auf Platte — appendFile ist importiert und genutzt (heute 0)', async () => {
        const appends = memoViewSource.match( /await appendFile\( logPath/g ) || []
        const imported = /import \{[^}]*appendFile[^}]*\} from 'node:fs\/promises'/.test( memoViewSource )
        const logged = await stat( memoViewPath )

        expect( imported ).toBe( true )
        expect( appends.length ).toBe( 1 )
        expect( logged.size ).toBeGreaterThan( 0 )
    } )
} )
