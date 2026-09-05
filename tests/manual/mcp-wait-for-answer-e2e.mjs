// mcp-wait-for-answer-e2e.mjs — DER ERSTFLUG (Memo 080, Kap 19, PRD-V9, A15-A19).
//
// Der Weg ist bei uns ungeflogen; alle vier Fristen stammen aus fremder Doku. Deshalb steht die
// Vergleichsmenge VOR dem Lauf fest: **5 Abschluss-Ereignisse ueber 2 gleichzeitig wartende
// Sitzungen (3 + 2)**, eines davon bewusst erst nach mehr als 6 Minuten.
//
// Was hier ECHT ist und nicht nachgestellt:
//   * das Memo und seine Datenbank kommen aus der echten Core-CLI (`memo new`) — Produktions-Schema
//   * die Antworten schreibt der echte Einzel-Schreiber (`memo user-input record` / `answer`)
//   * der Server ist der echte memo-view-Server (MemoView.startServer, 127.0.0.1)
//   * die Sitzungen sprechen den echten `/mcp`-Endpunkt ueber echtes HTTP + Event-Stream an
//   * der Knopfdruck ist der echte `POST /api/transcripts/<id>/login` — derselbe Pfad wie im Browser
//
// Was hier NICHT gemessen werden kann und deshalb als "nicht geflogen" im Protokoll steht:
//   die Auto-Verlagerung des Aufrufs in den Hintergrund nach 2 Minuten. Das ist eine Eigenschaft des
//   Claude-Code-Clients, nicht des Servers. Ein Harness, der sie behauptet, behauptet sie ueber sich
//   selbst. Sie wird beim ersten echten Client-Aufruf nachgemessen (siehe README).
//
// Lauf:  MEMOVIEW_NO_BROWSER=1 node tests/manual/mcp-wait-for-answer-e2e.mjs
//        MCP_E2E_LONG_WAIT_MS=20000 node tests/manual/mcp-wait-for-answer-e2e.mjs   (Kurzprobe)
// Exit 0 = alle Pruefungen bestanden, 1 = mindestens eine nicht.
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { MemoView } from '../../src/MemoView.mjs'
import { FirstFlightReport } from '../../scripts/firstflight-report.mjs'


const PORT = 47921
const ORIGIN = `http://127.0.0.1:${ PORT }`
const CORE_CLI = resolve( process.cwd(), '..', 'core', 'cli', 'bin', 'memo.mjs' )
const PLANNED_EVENTS = 5
// Das eine Ereignis, das die 5-Minuten-Leerlauf-Frist wirklich prueft. Ueberschreibbar, damit eine
// Kurzprobe den Ablauf pruefen kann — das Protokoll haelt fest, mit welchem Wert geflogen wurde.
const LONG_WAIT_MS = Number( process.env[ 'MCP_E2E_LONG_WAIT_MS' ] || 380000 )

const execFileAsync = promisify( execFile )
const results = []

const check = ( label, condition, detail ) => {
    results.push( { label, 'ok': condition === true } )
    process.stdout.write( `  ${ condition === true ? 'PASS' : 'FAIL' }  ${ label }${ detail === undefined ? '' : ` — ${ detail }` }\n` )
}

const wait = ( ms ) => new Promise( ( done ) => setTimeout( done, ms ) )


const runCli = async ( { args, stdin } ) => {
    try {
        const child = execFile( 'node', [ CORE_CLI ].concat( args ) )
        const collected = new Promise( ( done, fail ) => {
            let out = ''
            child.stdout.on( 'data', ( chunk ) => { out = out + String( chunk ) } )
            child.on( 'error', fail )
            child.on( 'close', ( code ) => done( { out, code } ) )
        } )

        if( typeof stdin === 'string' ) {
            child.stdin.write( stdin )
            child.stdin.end()
        }

        const { out, code } = await collected

        return code === 0 ? { 'ok': true, 'answer': JSON.parse( out ) } : { 'ok': false, 'answer': null, 'reason': out.slice( 0, 400 ) }
    } catch ( error ) {
        return { 'ok': false, 'answer': null, 'reason': String( error.message ).slice( 0, 400 ) }
    }
}


// EIN Werkzeug-Aufruf ueber den echten Endpunkt. Liest den Event-Stream mit, zaehlt die
// Fortschritts-Meldungen und gibt zurueck, WAS ankam — nicht, was erwartet wurde.
const callWaitForAnswer = async ( { sessionLabel, memo, transcriptId, timeoutSeconds } ) => {
    const startedAt = Date.now()
    const record = { 'session': sessionLabel, transcriptId, startedAt, 'progressMessages': 0, 'delivered': false, 'result': null, 'error': null, 'returnedAt': null }

    const response = await fetch( `${ ORIGIN }/mcp`, {
        'method': 'POST',
        'headers': { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Origin': ORIGIN },
        'body': JSON.stringify( {
            'jsonrpc': '2.0',
            'id': `${ sessionLabel }-${ transcriptId }`,
            'method': 'tools/call',
            'params': {
                'name': 'wait_for_answer',
                'arguments': { memo, transcriptId, timeoutSeconds },
                '_meta': { 'progressToken': `${ sessionLabel }-${ transcriptId }` }
            }
        } )
    } )

    if( response.status !== 200 ) {
        record[ 'error' ] = `HTTP ${ response.status }`
        record[ 'returnedAt' ] = Date.now()

        return record
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()

    const pump = async ( buffer ) => {
        const { value, done } = await reader.read()

        if( done === true ) { return buffer }

        const text = buffer + decoder.decode( value, { 'stream': true } )
        const frames = text.split( '\n\n' )
        const rest = frames.pop()

        const finished = frames
            .map( ( frame ) => {
                const dataLine = frame.split( '\n' ).find( ( line ) => line.startsWith( 'data: ' ) )

                if( dataLine === undefined ) { return null }

                const parsed = JSON.parse( dataLine.slice( 'data: '.length ) )

                if( parsed[ 'method' ] === 'notifications/progress' ) {
                    record[ 'progressMessages' ] = record[ 'progressMessages' ] + 1

                    return null
                }

                return parsed
            } )
            .find( ( entry ) => entry !== null && entry !== undefined )

        if( finished !== undefined ) {
            record[ 'result' ] = finished
            record[ 'returnedAt' ] = Date.now()

            return rest
        }

        return pump( rest )
    }

    await pump( '' )

    const payload = record[ 'result' ]
    record[ 'delivered' ] = payload !== null
        && payload[ 'result' ] !== undefined
        && payload[ 'result' ][ 'structuredContent' ] !== undefined
        && payload[ 'result' ][ 'structuredContent' ][ 'status' ] === true
    // openMs = wie lange der Aufruf OFFEN war (die Leerlauf-Frist-Groesse). Die Latenz je Ereignis ist
    // etwas anderes (Knopfdruck -> Rueckkehr) und wird erst im Protokoll gebildet — die beiden nicht
    // zu trennen hat im ersten Probelauf "0 s offen" gemeldet, obwohl der Aufruf 20 s offen stand.
    record[ 'openMs' ] = record[ 'returnedAt' ] === null ? null : record[ 'returnedAt' ] - startedAt

    return record
}


const main = async () => {
    process.env[ 'MEMOVIEW_NO_BROWSER' ] = '1'

    if( existsSync( CORE_CLI ) !== true ) {
        process.stderr.write( `\n  BLOCKED: die memo-CLI ist nicht aufloesbar (${ CORE_CLI }) — ohne sie gibt es keinen echten Antwort-Speicher.\n\n` )
        process.exit( 1 )
    }

    const startDir = process.cwd()
    const tempDir = await mkdtemp( join( tmpdir(), 'mcp-firstflight-' ) )

    const created = await runCli( { 'args': [ 'new', '--topic', 'Rueckkanal Erstflug', '--project-root', tempDir ] } )
    check( 'Aufbau: das Memo kommt aus der echten CLI (Produktions-Schema)', created.ok === true, created.ok === true ? created.answer[ 'dbPath' ] : created.reason )

    if( created.ok !== true ) {
        await rm( tempDir, { 'recursive': true, 'force': true } )
        process.exit( 1 )
    }

    const memoNumber = created.answer[ 'number' ]
    const memoDir = resolve( created.answer[ 'dbPath' ], '..' )
    const dbPath = created.answer[ 'dbPath' ]
    const transcriptsDir = join( memoDir, 'transcripts' )
    await mkdir( transcriptsDir, { 'recursive': true } )

    // Fuenf Transkripte auf FUENF verschiedenen Revisionen — jedes traegt eine eigene .loggedin-Marke,
    // sonst waeren zwei Knopfdruecke derselbe Knopfdruck.
    //
    // STRENG NACHEINANDER, gemessener Grund: der Core-Schreiber friert jede Zeile mit einem eigenen
    // dolt-Commit ein. Parallel gestartet antwortet er mit "commit conflict: another connection
    // committed to this branch" — im ersten Probelauf dieses Harness kamen so nur 3 von 5 Antworten in
    // den Speicher. Der Einzel-Schreiber ist eine Eigenschaft der Architektur, keine Schwaeche des Tests.
    const seedOne = async ( { index, collected } ) => {
        if( index >= PLANNED_EVENTS ) { return collected }

        const revisionId = `REV-0${ index + 1 }`
        const fileName = `${ revisionId }--review--01.md`
        const body = `# Review ${ revisionId }\n\n## Antwort auf F12 — Rueckkanal\nA) Langlauf-Werkzeug, Ereignis ${ index + 1 }\n`
        await writeFile( join( transcriptsDir, fileName ), body, 'utf-8' )

        const recorded = await runCli( {
            'args': [ 'user-input', 'record', '--memo', memoNumber, '--kind', 'voice-review', '--payload', '-', '--source', 'transcript-server', '--session-id', `e2e-${ index + 1 }`, '--project-root', tempDir ],
            'stdin': body
        } )

        if( recorded.ok !== true ) {
            return seedOne( { 'index': index + 1, 'collected': collected.concat( [ { revisionId, fileName, body, 'inputId': null, 'reason': recorded.reason } ] ) } )
        }

        const answered = await runCli( {
            'args': [ 'user-input', 'answer', '--memo', memoNumber, '--input-id', recorded.answer[ 'inputId' ], '--question', 'F12', '--option', 'A', '--answer', `Langlauf-Werkzeug, Ereignis ${ index + 1 }`, '--project-root', tempDir ]
        } )

        return seedOne( {
            'index': index + 1,
            'collected': collected.concat( [ { revisionId, fileName, body, 'inputId': recorded.answer[ 'inputId' ], 'answered': answered.ok, 'reason': answered.ok === true ? undefined : answered.reason } ] )
        } )
    }

    const seeded = await seedOne( { 'index': 0, 'collected': [] } )

    const seededOk = seeded.filter( ( entry ) => entry[ 'inputId' ] !== null && entry[ 'answered' ] === true )
    check( `Aufbau: ${ PLANNED_EVENTS } Antworten stehen im echten Antwort-Speicher (Einzel-Schreiber)`, seededOk.length === PLANNED_EVENTS, `${ seededOk.length }/${ PLANNED_EVENTS }${ seededOk.length === PLANNED_EVENTS ? '' : ` — ${ seeded.map( ( entry ) => entry[ 'reason' ] ).filter( ( reason ) => reason !== undefined ).join( ' | ' ) }` }` )

    process.chdir( tempDir )
    await MemoView.startServer( { 'port': PORT } )

    const listed = await ( await fetch( `${ ORIGIN }/api/transcripts` ) ).json()
    const transcripts = ( listed[ 'transcripts' ] || [] )
        .filter( ( entry ) => entry[ 'revisionId' ] !== undefined && entry[ 'revisionId' ].startsWith( 'REV-' ) === true )
        .sort( ( a, b ) => a[ 'revisionId' ].localeCompare( b[ 'revisionId' ] ) )
    check( `Aufbau: der Server kennt die ${ PLANNED_EVENTS } Transkripte`, transcripts.length === PLANNED_EVENTS, `${ transcripts.length } registriert` )

    if( transcripts.length !== PLANNED_EVENTS ) {
        process.chdir( startDir )
        await rm( tempDir, { 'recursive': true, 'force': true } )
        process.exit( 1 )
    }

    // ── A1/A2: der Endpunkt haengt am bestehenden Server und weist fremde Herkunft ab ────────────────
    const handshake = await fetch( `${ ORIGIN }/mcp`, {
        'method': 'POST',
        'headers': { 'Content-Type': 'application/json', 'Origin': ORIGIN },
        'body': JSON.stringify( { 'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': { 'protocolVersion': '2025-06-18' } } )
    } )
    const handshakeBody = await handshake.json()
    check( 'A1: der Handshake laeuft ueber denselben Port wie das Schaufenster (kein zweiter Prozess)', handshake.status === 200 && handshakeBody[ 'result' ][ 'serverInfo' ][ 'name' ] === 'memo-view', `Port ${ PORT }, ${ handshakeBody[ 'result' ][ 'protocolVersion' ] }` )

    const toolsList = await ( await fetch( `${ ORIGIN }/mcp`, {
        'method': 'POST',
        'headers': { 'Content-Type': 'application/json', 'Origin': ORIGIN },
        'body': JSON.stringify( { 'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list' } )
    } ) ).json()
    check( 'A1: das Verzeichnis meldet GENAU ein Werkzeug', toolsList[ 'result' ][ 'tools' ].length === 1 && toolsList[ 'result' ][ 'tools' ][ 0 ][ 'name' ] === 'wait_for_answer', toolsList[ 'result' ][ 'tools' ].map( ( tool ) => tool[ 'name' ] ).join( ',' ) )

    const foreign = await fetch( `${ ORIGIN }/mcp`, { 'method': 'POST', 'headers': { 'Content-Type': 'application/json', 'Origin': 'https://evil.example.com' }, 'body': '{}' } )
    const bare = await fetch( `${ ORIGIN }/mcp`, { 'method': 'POST', 'headers': { 'Content-Type': 'application/json' }, 'body': '{}' } )
    check( 'A2: fremde UND fehlende Herkunft werden mit 403 abgewiesen (2 Herkuenfte verglichen)', foreign.status === 403 && bare.status === 403, `fremd ${ foreign.status } · ohne ${ bare.status }` )

    // ── Der Erstflug: 2 Sitzungen, 5 offene Anfragen (3 + 2) ─────────────────────────────────────────
    const plan = [
        { 'session': 'A', 'index': 0 }, { 'session': 'A', 'index': 1 }, { 'session': 'A', 'index': 2 },
        { 'session': 'B', 'index': 3 }, { 'session': 'B', 'index': 4 }
    ]
    const openedAt = Date.now()
    const calls = plan
        .map( ( entry ) => callWaitForAnswer( {
            'sessionLabel': entry[ 'session' ],
            'memo': memoNumber,
            'transcriptId': transcripts[ entry[ 'index' ] ][ 'transcriptId' ],
            'timeoutSeconds': 1800
        } ) )

    await wait( 1500 )

    // Gegenprobe zur Nebenlaeufigkeit: eine offene Warte-Anfrage darf den Server nicht belegen.
    const probeStart = Date.now()
    const shopWindow = await fetch( `${ ORIGIN }/` )
    const documents = await ( await fetch( `${ ORIGIN }/api/documents` ) ).json()
    const probeMs = Date.now() - probeStart
    check( 'Nebenlaeufigkeit: das Schaufenster antwortet, waehrend 5 Anfragen offen sind', shopWindow.status === 200 && Array.isArray( documents[ 'documents' ] ) === true, `${ probeMs } ms fuer Seite + Dokumentenliste` )

    const pressed = {}
    const press = async ( { index } ) => {
        const transcriptId = transcripts[ index ][ 'transcriptId' ]
        const at = Date.now()
        const answer = await ( await fetch( `${ ORIGIN }/api/transcripts/${ transcriptId }/login`, { 'method': 'POST' } ) ).json()
        pressed[ transcriptId ] = { at, 'resolvedWaiters': answer[ 'resolvedWaiters' ] }

        return answer
    }

    // Vier Knopfdruecke zeitnah — der fuenfte bewusst spaet (Leerlauf-Frist).
    const early = await Promise.all( [ 0, 1, 2, 3 ].map( async ( index ) => {
        await wait( index * 300 )

        return press( { index } )
    } ) )
    check( 'Vier Knopfdruecke haben je genau EINE wartende Anfrage bedient (4 verglichen)', early.every( ( entry ) => entry[ 'resolvedWaiters' ] === 1 ), early.map( ( entry ) => entry[ 'resolvedWaiters' ] ).join( ',' ) )

    const remaining = LONG_WAIT_MS - ( Date.now() - openedAt )
    process.stdout.write( `\n  Der fuenfte Knopfdruck folgt in ${ Math.round( Math.max( remaining, 0 ) / 1000 ) } s (Leerlauf-Frist-Probe, geplant ${ Math.round( LONG_WAIT_MS / 1000 ) } s)\n\n` )
    await wait( Math.max( remaining, 0 ) )

    const midFlightProbe = await fetch( `${ ORIGIN }/api/documents` )
    check( 'Der Server lebt auch nach der langen Wartezeit noch', midFlightProbe.status === 200, `HTTP ${ midFlightProbe.status }` )

    await press( { 'index': 4 } )

    const records = await Promise.all( calls )
    const lateRecord = records[ 4 ]

    // Was NICHT ankam, wird hier benannt statt weggerundet — ein leeres Ergebnis ist ein Befund.
    const structuredOf = ( { record } ) => {
        const envelope = record[ 'result' ]

        if( envelope === null || envelope === undefined ) { return null }
        if( envelope[ 'error' ] !== undefined ) { return { 'protocolError': envelope[ 'error' ][ 'message' ] } }
        if( envelope[ 'result' ] === undefined ) { return null }

        return envelope[ 'result' ][ 'structuredContent' ]
    }

    records
        .filter( ( record ) => record[ 'delivered' ] !== true )
        .forEach( ( record ) => process.stdout.write( `  NICHT ZUGESTELLT ${ record[ 'transcriptId' ] }: ${ JSON.stringify( structuredOf( { record } ) ) } (${ record[ 'error' ] })\n` ) )

    // ── Das Protokoll: jede Zahl mit ihrer Quelle, auch die schlechten ───────────────────────────────
    const events = records
        .map( ( record, index ) => ( {
            'transcriptId': record[ 'transcriptId' ],
            'session': record[ 'session' ],
            'delivered': record[ 'delivered' ],
            'latencyMs': pressed[ record[ 'transcriptId' ] ] === undefined || record[ 'returnedAt' ] === null
                ? null
                : record[ 'returnedAt' ] - pressed[ record[ 'transcriptId' ] ][ 'at' ],
            'openMs': record[ 'returnedAt' ] === null ? null : record[ 'returnedAt' ] - record[ 'startedAt' ],
            'progressMessages': record[ 'progressMessages' ],
            'answers': structuredOf( { record } ) === null || Array.isArray( ( structuredOf( { record } ) || {} )[ 'answers' ] ) !== true ? 0 : structuredOf( { record } )[ 'answers' ].length,
            'error': record[ 'error' ],
            dbPath,
            'transcriptPath': join( transcriptsDir, seeded[ index ][ 'fileName' ] ),
            'loginMarkerPath': join( transcriptsDir, `${ seeded[ index ][ 'revisionId' ] }.loggedin` )
        } ) )

    const protocol = {
        'memo': memoNumber,
        'plannedEvents': PLANNED_EVENTS,
        'startedAt': new Date( openedAt ).toISOString(),
        'sessions': [ { 'id': 'A', 'waits': 3 }, { 'id': 'B', 'waits': 2 } ],
        events,
        'deadlines': {
            // Eigenschaft des CLIENTS, nicht des Servers — hier nicht messbar, deshalb null.
            'autoBackground': null,
            'idleSurvival': { 'held': lateRecord[ 'returnedAt' ] !== null && lateRecord[ 'openMs' ] > 300000, 'measured': `${ Math.round( ( lateRecord[ 'openMs' ] || 0 ) / 1000 ) } s offen, Rueckkehr ${ lateRecord[ 'returnedAt' ] === null ? 'ausgeblieben' : 'erfolgt' }` },
            'progressMessages': { 'held': lateRecord[ 'progressMessages' ] >= Math.floor( ( lateRecord[ 'openMs' ] || 0 ) / 60000 ), 'measured': `${ lateRecord[ 'progressMessages' ] } bei ${ Math.round( ( lateRecord[ 'openMs' ] || 0 ) / 1000 ) } s` },
            'latency': { 'held': events.every( ( event ) => event[ 'latencyMs' ] !== null && event[ 'latencyMs' ] < 2000 ), 'measured': `${ Math.max( ...events.map( ( event ) => event[ 'latencyMs' ] === null ? -1 : event[ 'latencyMs' ] ) ) } ms schlechtester Fall` }
        }
    }

    const protocolPath = join( tempDir, 'firstflight-protocol.json' )
    await writeFile( protocolPath, JSON.stringify( protocol, null, 4 ), 'utf-8' )

    const run = FirstFlightReport.run( { 'argv': [ '--protocol', protocolPath ] } )
    process.stdout.write( run[ 'text' ] )

    const disk = FirstFlightReport.readDisk( { events } )
    const report = FirstFlightReport.evaluate( { 'expected': PLANNED_EVENTS, events, 'diskHits': disk[ 'diskHits' ] } )

    check( `A15: die festgelegte Vergleichsmenge wurde geflogen — comparedCount ${ report[ 'comparedCount' ] } von ${ PLANNED_EVENTS }`, report[ 'comparedCount' ] === PLANNED_EVENTS, `${ report[ 'comparedCount' ] }/${ PLANNED_EVENTS }` )
    check( `A16: Schreibweg und Zustellweg getrennt gezaehlt — disk ${ report[ 'diskCount' ] }, delivered ${ report[ 'deliveredCount' ] }`, report[ 'diskCount' ] === PLANNED_EVENTS && report[ 'deliveredCount' ] === PLANNED_EVENTS, `${ report[ 'comparedCount' ] }/${ report[ 'diskCount' ] }/${ report[ 'deliveredCount' ] }` )
    check( 'A5: beide Sitzungen wurden bedient — 3 aus A, 2 aus B', events.filter( ( event ) => event[ 'session' ] === 'A' && event[ 'delivered' ] === true ).length === 3 && events.filter( ( event ) => event[ 'session' ] === 'B' && event[ 'delivered' ] === true ).length === 2, `A ${ events.filter( ( event ) => event[ 'session' ] === 'A' && event[ 'delivered' ] === true ).length } · B ${ events.filter( ( event ) => event[ 'session' ] === 'B' && event[ 'delivered' ] === true ).length }` )
    check( 'A3: jedes Ergebnis traegt die durablen Antworten und den Platten-Zeiger', records.every( ( record ) => {
        const structured = structuredOf( { record } )

        return structured !== null && typeof structured[ 'evidencePath' ] === 'string' && structured[ 'evidencePath' ].includes( 'user_input_answers' ) === true && structured[ 'answers' ].length === 1
    } ), events.map( ( event ) => event[ 'answers' ] ).join( ',' ) )
    check( `A17/Leerlauf: der spaete Aufruf hat ${ Math.round( ( lateRecord[ 'openMs' ] || 0 ) / 1000 ) } s ueberlebt`, lateRecord[ 'returnedAt' ] !== null, protocol[ 'deadlines' ][ 'idleSurvival' ][ 'measured' ] )
    check( `A17/Fortschritt: der spaete Aufruf hat ${ lateRecord[ 'progressMessages' ] } Meldungen gesendet`, lateRecord[ 'progressMessages' ] >= Math.floor( ( lateRecord[ 'openMs' ] || 0 ) / 60000 ), protocol[ 'deadlines' ][ 'progressMessages' ][ 'measured' ] )
    check( 'A17/Auto-Verlagerung: NICHT geflogen — Client-Eigenschaft, hier nicht messbar', protocol[ 'deadlines' ][ 'autoBackground' ] === null, 'im Protokoll als "not flown" ausgewiesen' )
    check( 'A8: das Warte-Register ist nach dem Lauf leer', ( await import( '../../src/AnswerWaiter.mjs' ) ).AnswerWaiter.size( {} )[ 'size' ] === 0, `${ ( await import( '../../src/AnswerWaiter.mjs' ) ).AnswerWaiter.size( {} )[ 'size' ] } offen` )
    check( `Mess-Skript: Verdikt ${ report[ 'verdict' ] } (Exit ${ run[ 'exitCode' ] })`, run[ 'exitCode' ] === 0, report[ 'findings' ].map( ( finding ) => finding[ 'code' ] ).join( ',' ) )

    const keptProtocol = resolve( startDir, 'tests', 'manual', 'test-results', 'firstflight-protocol.json' )
    await mkdir( resolve( startDir, 'tests', 'manual', 'test-results' ), { 'recursive': true } )
    await writeFile( keptProtocol, JSON.stringify( protocol, null, 4 ), 'utf-8' )
    process.stdout.write( `\n  Protokoll abgelegt: ${ keptProtocol }\n` )

    process.chdir( startDir )
    await rm( tempDir, { 'recursive': true, 'force': true } )

    const failed = results.filter( ( entry ) => entry[ 'ok' ] !== true )
    process.stdout.write( `\n  ${ results.length - failed.length }/${ results.length } Pruefungen bestanden\n\n` )
    process.exit( failed.length === 0 ? 0 : 1 )
}


await main()
