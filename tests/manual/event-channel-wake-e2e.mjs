// Event-Kanal-E2E (Memo 080, PRD-V10 / WI-207) — den Uebergangs-Rueckkanal im ECHTEN Betrieb fahren:
// echter memo-view-Server, echtes Chromium, echter Knopfdruck auf „Abschliessen", echtes Shell-Skript
// als Hintergrund-Prozess. Kein Nachbau, keine Attrappe.
//
// Warum ein Handlauf und nicht nur Unit-Tests: die Unit-Tests fahren das Skript gegen einen Wegwerf-
// Server, der jede Anfrage mit 200 beantwortet. Damit ist bewiesen, dass das Skript einen Armier-Aufruf
// SENDET — nicht, dass der laufende Server ihn ANNIMMT und dass der Knopf im Schaufenster daraus ein
// Wake-Flag macht. Genau diese Naht ist in Phase 9 schon einmal gerissen (PRD-V9: die Attrappe bot ein
// Feld an, das die Wirklichkeit weglaesst).
//
// Hier belegt, im echten Umfeld:
//   (A) Armieren und Warten in EINEM Befehl — der laufende Server fuehrt die Sitzung danach unter
//       GET /api/session/armed?transcriptId=, ohne dass jemand vorher ein curl abgesetzt hat
//   (B) der Knopfdruck im Browser beendet den wartenden Prozess mit WOKEN <id> <transcriptId>
//   (C) die letzte Ausgabezeile ist der Wiederanlauf-Befehl, und er ist WOERTLICH ausfuehrbar:
//       der zweite Durchgang startet genau diese Zeile und wird vom zweiten Klick genauso erhoert
//       (das ist die Grenze aus Beleg 19.5 — ein Beobachter, ein Ereignis)
//   (D) die drei Enden ARM-FAILED / WAIT-EXPIRED / Guard verhalten sich am echten Server wie im Test
//
// Das Memo wird mit dem ECHTEN `memo new` (core-CLI) angelegt, damit Baum und Schema die Produktions-
// form haben. Ohne das Nachbar-Repo core meldet der Lauf BLOCKED und endet mit 1 — er meldet nie ein
// Bestehen, das er nicht messen konnte. Playwright wird aus dem Nachbar-Repo memo-init.github.io
// aufgeloest (der Viewer kauft keine Abhaengigkeit); fehlt es, wird der Browser-Block als SKIP
// ausgewiesen und der Knopfdruck ueber dieselbe Route gefahren, die der Knopf ruft — mit Vermerk.
//
// Lauf: MEMOVIEW_NO_BROWSER=1 node tests/manual/event-channel-wake-e2e.mjs  → 0 bei Erfolg, 1 bei Fehler.
//
// UEBERGANG — DIESER HANDLAUF GEHT MIT DEM SKRIPT (Memo 080, Phase 9, Abschluss).
// Er faehrt das Skript `scripts/session-wake-arm.sh` und ist damit ein Traeger des Uebergangs: wird das
// Skript beim Ablauf entfernt, hat dieser Handlauf nichts mehr zu fahren. Er steht deshalb auf der
// Ablauf-Liste — gefunden, nicht abgeschrieben: das Sunset-Gate
// (tests/unit/EventChannelSunsetPRDV10.test.mjs) durchsucht beide Repos nach jeder Datei, die das
// Skript nennt, statt eine Liste zu fuehren, die am Tag ihrer Niederschrift richtig war.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { MemoView } from '../../src/MemoView.mjs'


const PORT = 47951
const ORIGIN = `http://127.0.0.1:${ PORT }`
const VIEWER_ROOT = resolve( process.cwd() )
const PROJECT_ROOT = resolve( VIEWER_ROOT, '..', '..' )
const SCRIPT = join( VIEWER_ROOT, 'scripts', 'session-wake-arm.sh' )
const CORE_CLI = resolve( VIEWER_ROOT, '..', 'core', 'cli', 'bin', 'memo.mjs' )
const PLAYWRIGHT_ANCHORS = [
    resolve( VIEWER_ROOT, '..', 'memo-init.github.io', 'package.json' ),
    resolve( VIEWER_ROOT, 'package.json' )
]

const execFileAsync = promisify( execFile )
const results = []

const check = ( label, condition, detail ) => {
    results.push( { label, 'ok': condition === true } )
    process.stdout.write( `  ${ condition === true ? 'PASS' : 'FAIL' }  ${ label }${ detail === undefined ? '' : ` — ${ detail }` }\n` )
}

const wait = ( ms ) => new Promise( ( done ) => setTimeout( done, ms ) )


const loadPlaywright = () => {
    const found = PLAYWRIGHT_ANCHORS
        .map( ( anchor ) => {
            try {
                return { anchor, 'playwright': createRequire( anchor )( 'playwright' ) }
            } catch {
                return null
            }
        } )
        .find( ( entry ) => entry !== null )

    return found === undefined ? null : found
}


const runCli = async ( { args } ) => {
    try {
        const run = await execFileAsync( 'node', [ CORE_CLI ].concat( args ) )

        return { 'ok': true, 'answer': JSON.parse( run.stdout ) }
    } catch( error ) {
        return { 'ok': false, 'answer': null, 'reason': String( error.stdout || error.message ).slice( 0, 400 ) }
    }
}


// Der Beobachter ist ein lang laufender Prozess, deshalb werden Start und Ende GETRENNT gefahren —
// alles, was dieser Handlauf belegt, geschieht zwischen diesen beiden Momenten.
const startWatcher = ( { argv, env } ) => {
    const child = spawn( 'bash', argv, { 'cwd': PROJECT_ROOT, 'env': { ...process.env, ...env } } )
    const chunks = []
    const errors = []

    child.stdout.on( 'data', ( chunk ) => { chunks.push( String( chunk ) ) } )
    child.stderr.on( 'data', ( chunk ) => { errors.push( String( chunk ) ) } )

    const ended = new Promise( ( done ) => {
        child.on( 'close', ( code ) => {
            done( { 'code': code, 'stdout': chunks.join( '' ), 'stderr': errors.join( '' ), 'endedAt': Date.now() } )
        } )
    } )

    return { child, ended }
}


const lastLine = ( { stdout } ) => {
    const lines = stdout.split( '\n' ).filter( ( line ) => line.trim().length > 0 )

    return lines.length === 0 ? '' : lines[ lines.length - 1 ]
}


const waitUntil = async ( { probe, timeoutMs } ) => {
    const deadline = Date.now() + timeoutMs
    const attempt = async () => {
        const seen = await probe()

        if( seen === true ) { return true }
        if( Date.now() > deadline ) { return false }

        await wait( 100 )

        return attempt()
    }

    return attempt()
}


const armedSessions = async ( { transcriptId } ) => {
    const answer = await ( await fetch( `${ ORIGIN }/api/session/armed?transcriptId=${ encodeURIComponent( transcriptId ) }` ) ).json()

    return answer[ 'sessions' ] === undefined ? [] : answer[ 'sessions' ]
}


// Ein nachweislich geschlossener Port: einmal gebunden, dann freigegeben. Dieselbe Fehlerart wie
// „Server aus" (ECONNREFUSED) — und anders als eine geratene Portnummer kann er nicht versehentlich
// einen fremden Dienst treffen.
const closedPort = async () => {
    const server = createServer( () => {} )

    await new Promise( ( ready ) => { server.listen( 0, '127.0.0.1', ready ) } )

    const port = server.address().port

    await new Promise( ( done ) => { server.close( done ) } )

    return port
}


const main = async () => {
    process.env[ 'MEMOVIEW_NO_BROWSER' ] = '1'

    if( existsSync( CORE_CLI ) !== true ) {
        process.stderr.write( `\n  BLOCKED: die memo-CLI ist nicht aufloesbar (${ CORE_CLI }) — ohne sie gibt es keinen Produktions-Baum.\n\n` )
        process.exit( 1 )
    }

    const startDir = process.cwd()
    const tempDir = await mkdtemp( join( tmpdir(), 'event-channel-e2e-' ) )
    const wakeDir = await mkdtemp( join( tmpdir(), 'event-channel-wake-' ) )

    const created = await runCli( { 'args': [ 'new', '--topic', 'Ereignis Kanal E2E', '--project-root', tempDir ] } )
    check( 'Aufbau: das Memo kommt aus der echten CLI (Produktions-Schema)', created.ok === true, created.ok === true ? created.answer[ 'dbPath' ] : created.reason )

    if( created.ok !== true ) {
        await rm( tempDir, { 'recursive': true, 'force': true } )
        await rm( wakeDir, { 'recursive': true, 'force': true } )
        process.exit( 1 )
    }

    const memoDir = resolve( created.answer[ 'dbPath' ], '..' )
    const transcriptsDir = join( memoDir, 'transcripts' )

    await mkdir( transcriptsDir, { 'recursive': true } )
    await writeFile(
        join( transcriptsDir, 'REV-01--review--01.md' ),
        '# Review REV-01\n\n## Antwort auf F12 — Rueckkanal\nA) Ereignis-Weg als Uebergang\n',
        'utf-8'
    )

    // Isolation: der Server bootet INNERHALB des Wegwerf-Baums, seine Auto-Registrierung fasst das
    // echte .memo/ nie an.
    process.chdir( tempDir )
    await MemoView.startServer( { 'port': PORT } )

    const listed = await ( await fetch( `${ ORIGIN }/api/transcripts` ) ).json()
    const transcripts = listed[ 'transcripts' ] === undefined ? [] : listed[ 'transcripts' ]
    const transcript = transcripts.find( ( entry ) => entry[ 'revisionId' ] === 'REV-01' )

    check( 'Aufbau: der Server kennt das Transkript', transcript !== undefined, `${ transcripts.length } registriert` )

    if( transcript === undefined ) {
        process.chdir( startDir )
        await rm( tempDir, { 'recursive': true, 'force': true } )
        await rm( wakeDir, { 'recursive': true, 'force': true } )
        process.exit( 1 )
    }

    const transcriptId = transcript[ 'transcriptId' ]
    const documents = ( await ( await fetch( `${ ORIGIN }/api/documents` ) ).json() )[ 'documents' ]
    const documentId = documents === undefined || documents.length === 0 ? null : documents[ 0 ][ 'documentId' ]
    const sessionId = `e2e-v10-${ process.pid }`
    // GEMESSENER BEFUND, der diesen Handlauf gerechtfertigt hat: der erste Lauf setzte WAKE_DIR auf einen
    // Wegwerf-Ordner — alle Unit-Tests tun das — und lief in WAIT-EXPIRED, obwohl der Server „woke 1 armed
    // session[s]" meldete. Ursache: die SERVER-Seite kennt keine WAKE_DIR-Umgebungsvariable, ihr Ordner ist
    // die Konstante os.tmpdir()+'/memo-view-wake' (MemoView.mjs). Die Ueberschreibung ist eine reine
    // Test-Naht. Wer sie im echten Betrieb setzt, misst eine Strasse, die es in der Produktion nicht gibt.
    // Deshalb faehrt dieser Lauf den Produktions-Ordner; die Flaggen sind sitzungs-eigen benannt und werden
    // am Ende einzeln entfernt.
    const productionWakeDir = join( tmpdir(), 'memo-view-wake' )
    const watcherEnv = { 'MEMOVIEW_URL': ORIGIN, 'WAKE_MAX_WAIT': '120' }

    const loaded = loadPlaywright()
    const browser = loaded === null ? null : await loaded.playwright.chromium.launch()
    const page = browser === null ? null : await browser.newPage()

    if( page !== null ) {
        await page.goto( `${ ORIGIN }/`, { 'waitUntil': 'networkidle' } )
        await page.evaluate( ( id ) => window.selectRevision( id, 'REV-01.md' ), documentId )
        await page.waitForSelector( '#ps-finish', { 'timeout': 20000 } )
        await wait( 400 )
    } else {
        process.stdout.write( `  SKIP  Browser-Block: playwright nicht aufloesbar von ${ PLAYWRIGHT_ANCHORS.join( ' | ' ) }\n` )
    }

    // Der Knopfdruck. Im Browser ist es der echte Klick auf #ps-finish; ohne Browser dieselbe Route,
    // die der Knopf ruft — der Server schreibt das Wake-Flag auf BEIDEN Wegen (MemoView.mjs Login-Route).
    const pressFinish = async () => {
        if( page !== null ) {
            await page.click( '#ps-finish' )

            return 'Klick auf #ps-finish im echten Chromium'
        }

        await fetch( `${ ORIGIN }/api/transcripts/${ transcriptId }/login`, { 'method': 'POST', 'headers': { 'Content-Type': 'application/json' }, 'body': '{}' } )

        return 'POST /api/transcripts/<id>/login (Browser nicht verfuegbar)'
    }

    // ── Durchgang 1: Armieren und Warten in EINEM Befehl ──────────────────────────────────────────
    const first = startWatcher( { 'argv': [ SCRIPT, sessionId, transcriptId ], 'env': watcherEnv } )
    const armedSeen = await waitUntil( {
        'probe': async () => ( await armedSessions( { transcriptId } ) ).includes( sessionId ),
        'timeoutMs': 15000
    } )

    check( 'A1: der laufende Server fuehrt die Sitzung als armiert — ohne vorheriges curl', armedSeen === true, `sessionId ${ sessionId }` )

    const pressedWith = await pressFinish()
    const pressedAt = Date.now()
    const firstResult = await first.ended

    check( 'B: der Knopfdruck beendet den wartenden Prozess mit WOKEN', firstResult.stdout.includes( `WOKEN ${ sessionId } ${ transcriptId }` ) === true, `${ pressedWith } · Code ${ firstResult.code } · ${ firstResult.endedAt - pressedAt } ms` )
    check( 'B: das Prozess-Ende ist ein sauberes Ende (Code 0)', firstResult.code === 0, `Code ${ firstResult.code }` )
    check( 'C: die LETZTE Zeile ist der vollstaendige Wiederanlauf-Befehl', lastLine( { 'stdout': firstResult.stdout } ) === `NEXT: bash repos/viewer/scripts/session-wake-arm.sh ${ sessionId } ${ transcriptId }`, lastLine( { 'stdout': firstResult.stdout } ) )

    // ── Durchgang 2: die NEXT-Zeile WOERTLICH ausfuehren ──────────────────────────────────────────
    // Nicht nachgebaut: die Zeile aus der Ausgabe des ersten Laufs wird zerlegt und genau so gestartet.
    // Faellt der Wortlaut auseinander, scheitert dieser Durchgang — das ist der Sinn der Uebung.
    const nextCommand = lastLine( { 'stdout': firstResult.stdout } ).replace( 'NEXT: bash ', '' ).trim()
    const nextArgv = nextCommand.split( ' ' ).filter( ( part ) => part.length > 0 )
    const second = startWatcher( { 'argv': nextArgv, 'env': watcherEnv } )
    const armedAgain = await waitUntil( {
        'probe': async () => ( await armedSessions( { transcriptId } ) ).includes( sessionId ),
        'timeoutMs': 15000
    } )

    check( 'C: der Wiederanlauf-Befehl laeuft aus der Projektwurzel woertlich an', armedAgain === true, `bash ${ nextCommand }` )

    const pressedTwice = await pressFinish()
    const secondResult = await second.ended

    check( 'D: der ZWEITE Klick weckt genauso — die Grenze „ein Beobachter, ein Ereignis" ist ueberbrueckt', secondResult.stdout.includes( `WOKEN ${ sessionId } ${ transcriptId }` ) === true && secondResult.code === 0, `${ pressedTwice } · Code ${ secondResult.code }` )

    // ── Die drei Enden am echten Server ───────────────────────────────────────────────────────────
    const deadPort = await closedPort()
    const armFailed = await startWatcher( {
        'argv': [ SCRIPT, `${ sessionId }-off`, transcriptId ],
        'env': { 'WAKE_DIR': wakeDir, 'MEMOVIEW_URL': `http://127.0.0.1:${ deadPort }`, 'WAKE_MAX_WAIT': '120' }
    } ).ended

    check( 'E: Server nicht erreichbar → ARM-FAILED, Code 3, kein stiller Wartezustand', armFailed.stdout.includes( `ARM-FAILED ${ sessionId }-off` ) === true && armFailed.code === 3, `Code ${ armFailed.code } · Port ${ deadPort } (gebunden und wieder freigegeben)` )

    const expiredAt = Date.now()
    const expired = await startWatcher( {
        'argv': [ SCRIPT, `${ sessionId }-exp`, transcriptId ],
        'env': { 'WAKE_DIR': wakeDir, 'MEMOVIEW_URL': ORIGIN, 'WAKE_MAX_WAIT': '1' }
    } ).ended
    const expiredMs = Date.now() - expiredAt
    const leftovers = await execFileAsync( 'bash', [ '-c', `ps -Ao args= | grep -c "[s]ession-wake-arm.sh ${ sessionId }-exp" || true` ] )

    check( 'F: Frist abgelaufen → WAIT-EXPIRED, Code 4, NEXT-Zeile, kein Waisen-Prozess', expired.stdout.includes( `WAIT-EXPIRED ${ sessionId }-exp` ) === true && expired.code === 4 && lastLine( { 'stdout': expired.stdout } ).startsWith( 'NEXT: bash' ) === true && leftovers.stdout.trim() === '0', `${ expiredMs } ms · Code ${ expired.code } · ${ leftovers.stdout.trim() } Prozess(e) uebrig` )

    const guarded = await startWatcher( {
        'argv': [ SCRIPT, `${ sessionId }-guard`, transcriptId ],
        'env': { 'WAKE_DIR': wakeDir, 'MEMOVIEW_URL': ORIGIN, 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS': '1' }
    } ).ended
    const armedAfterGuard = await armedSessions( { transcriptId } )

    check( 'G: Guard gesetzt → Ansage wie bisher und KEIN Armier-Aufruf am echten Server', guarded.stdout.includes( 'background tasks disabled' ) === true && guarded.code === 0 && armedAfterGuard.includes( `${ sessionId }-guard` ) === false, `armiert: ${ armedAfterGuard.join( ', ' ) }` )

    if( browser !== null ) { await browser.close() }

    // Die Flagge ist ein Einmal-Schuss: nach zwei bedienten Wecken darf im Produktions-Ordner nichts
    // von dieser Sitzung uebrig sein. Das ist zugleich die Aufraeum-Kontrolle und der Nachweis, dass
    // beide Wecken wirklich verbraucht wurden.
    const ownFlag = join( productionWakeDir, `${ sessionId }.flag` )

    check( 'H: der Produktions-Flaggen-Ordner traegt nach dem Lauf keine Flagge dieser Sitzung', existsSync( ownFlag ) === false, ownFlag )

    await rm( ownFlag, { 'force': true } )

    process.chdir( startDir )
    await rm( tempDir, { 'recursive': true, 'force': true } )
    await rm( wakeDir, { 'recursive': true, 'force': true } )

    const failed = results.filter( ( entry ) => entry.ok !== true )

    process.stdout.write( `\n  ${ results.length - failed.length }/${ results.length } bestanden${ page === null ? ' (Browser-Block uebersprungen)' : '' }\n\n` )
    process.exit( failed.length === 0 ? 0 : 1 )
}


main()
    .catch( ( error ) => {
        process.stderr.write( `\n  ABBRUCH: ${ error.stack }\n\n` )
        process.exit( 1 )
    } )
