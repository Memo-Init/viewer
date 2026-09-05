// Runtime-status ADDRESSING (Memo 080, PRD-V3 / WI-104) — WHICH document does the figure in the head bar
// belong to? Measured in real operation: a real server, real database writes through the real CLI, a real
// Chromium, and TWO registered documents. The sibling harness runtime-status-e2e.mjs proves that the number
// arrives at all; this one proves it arrives at the RIGHT document.
//
// The finding this probe was built around: the server sends the `runtimeStatus` message to EVERY connected
// client (MemoView broadcasts over wss.clients) and the message carries its documentId, but the client
// branch rendered it without asking whose it was — measured, the head bar of document A carried the figures
// of document B, which was not on screen at all. The old justification ("the server only sends when the
// sequence has grown") answers WHETHER something is sent, never TO WHICH document the number belongs.
//
// Proven here, in both directions, with a distinguishable figure per document:
//   (E1) two documents are registered and the browser shows A
//   (E2) a write into B does arrive at a raw WebSocket client — so the server did send
//   (E3) the head bar still does NOT move and does not carry B's figures
//   (E4) control: handing the SAME payload straight to renderRuntimeStatus does paint B's figures, so (E3)
//        is the branch's filter and not a dead render path
//   (E5) a write into A puts A's figures on the bar and overwrites the control's
//
// The memo databases are created by the REAL `memo new` (core CLI), so the schema is the production schema.
// Without the sibling repo repos/core the probe reports BLOCKED and exits 1 — it never reports a pass it
// could not measure. Playwright is resolved from the sibling repo memo-init.github.io; without a browser the
// probe is BLOCKED too, because without a head bar there is nothing here to measure.
//
// Run: node tests/manual/runtime-status-document-scope-e2e.mjs  → exits 0 on success, 1 on any fail.
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { WebSocket } from 'ws'

import { MemoView } from '../../src/MemoView.mjs'


const PORT = 47921
const CORE_CLI = resolve( process.cwd(), '..', 'core', 'cli', 'bin', 'memo.mjs' )
const PLAYWRIGHT_ANCHORS = [
    resolve( process.cwd(), '..', 'memo-init.github.io', 'package.json' ),
    resolve( process.cwd(), 'package.json' )
]

// Two documents, two DIFFERENT figures. Identical figures would make "the bar did not move" and "the bar
// moved to the wrong document" the same picture — the whole probe would prove nothing.
const SHOWN = { 'topic': 'Adressierung A angezeigt', 'phases': 3, 'perPhase': 2 }
const HIDDEN = { 'topic': 'Adressierung B nicht angezeigt', 'phases': 5, 'perPhase': 3 }

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
            } catch( error ) {
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


const stateFor = ( { phases, perPhase } ) => {
    return {
        'memo': 'M080',
        'phases': Array.from( { 'length': phases } )
            .map( ( _, phase ) => ( {
                phase,
                'name': `Phase ${ phase }`,
                'prds': Array.from( { 'length': perPhase } ).map( ( __, index ) => ( { 'id': `PRD-${ phase }-${ index }` } ) )
            } ) )
    }
}


// One memo, created by the real CLI, with a rollout state of the requested size on disk.
const makeMemo = async ( { projectRoot, topic, phases, perPhase } ) => {
    const created = await runCli( { 'args': [ 'new', '--topic', topic, '--project-root', projectRoot ] } )

    if( created.ok !== true ) { return { 'ok': false, 'reason': created.reason } }

    const memoDir = resolve( created.answer[ 'dbPath' ], '..' )
    await mkdir( join( memoDir, 'rollout' ), { 'recursive': true } )
    await writeFile( join( memoDir, 'rollout', 'state.json' ), JSON.stringify( stateFor( { phases, perPhase } ), null, 2 ), 'utf8' )
    await writeFile( created.answer[ 'revPath' ], `${ await readFile( created.answer[ 'revPath' ], 'utf8' ) }\n${ 'Fuelltext.\n\n'.repeat( 40 ) }`, 'utf8' )

    return {
        'ok': true,
        'number': created.answer[ 'number' ],
        'memoDir': memoDir,
        'expected': `${ phases } Phasen · ${ phases * perPhase } PRDs`
    }
}


const headBar = async ( { page } ) => {
    return page.evaluate( () => {
        const host = document.getElementById( 'runtime-status' )

        return host === null ? null : host.textContent
    } )
}


const main = async () => {
    process.env[ 'MEMOVIEW_NO_BROWSER' ] = '1'

    if( existsSync( CORE_CLI ) !== true ) {
        process.stderr.write( `\n  BLOCKED: die memo-CLI ist nicht aufloesbar (${ CORE_CLI }) — ohne sie kann kein echter Datenbank-Schreibvorgang gemessen werden.\n\n` )
        process.exit( 1 )
    }

    const loaded = loadPlaywright()

    if( loaded === null ) {
        process.stderr.write( `\n  BLOCKED: playwright ist nicht aufloesbar (${ PLAYWRIGHT_ANCHORS.join( ' | ' ) }) — ohne echten Browser gibt es keine Kopfleiste zu messen.\n\n` )
        process.exit( 1 )
    }

    const startDir = process.cwd()
    const tempDir = await mkdtemp( join( tmpdir(), 'runtime-scope-e2e-' ) )

    const shown = await makeMemo( { 'projectRoot': tempDir, ...SHOWN } )
    const hidden = await makeMemo( { 'projectRoot': tempDir, ...HIDDEN } )

    if( shown.ok !== true || hidden.ok !== true ) {
        process.stderr.write( `\n  BLOCKED: die beiden Memos liessen sich nicht anlegen — ${ shown.reason || hidden.reason }\n\n` )
        await rm( tempDir, { 'recursive': true, 'force': true } )
        process.exit( 1 )
    }

    process.stdout.write( `\n  angezeigt: Memo ${ shown.number } erwartet "${ shown.expected }"  ·  nicht angezeigt: Memo ${ hidden.number } erwartet "${ hidden.expected }"\n\n` )

    // Isolation: the server boots INSIDE the throwaway tree, so its auto-register never touches the real .memo/.
    process.chdir( tempDir )
    await MemoView.startServer( { 'port': PORT } )

    const listBody = await ( await fetch( `http://127.0.0.1:${ PORT }/api/documents` ) ).json()
    const documents = listBody.documents || []
    const shownDoc = documents.find( ( entry ) => entry.memoPath.includes( `${ shown.number }-` ) === true )
    const hiddenDoc = documents.find( ( entry ) => entry.memoPath.includes( `${ hidden.number }-` ) === true )

    check( 'E1a: ZWEI Dokumente sind registriert (ohne zwei gibt es keine Adressierungsfrage)', documents.length === 2, `${ documents.length } Dokument(e): ${ documents.map( ( entry ) => entry.documentId ).join( ', ' ) }` )
    check( 'E1b: beide Dokumente sind unterscheidbar aufgeloest', shownDoc !== undefined && hiddenDoc !== undefined && shownDoc.documentId !== hiddenDoc.documentId, `${ shownDoc === undefined ? '-' : shownDoc.documentId } vs ${ hiddenDoc === undefined ? '-' : hiddenDoc.documentId }` )

    if( documents.length !== 2 || shownDoc === undefined || hiddenDoc === undefined ) {
        process.chdir( startDir )
        await rm( tempDir, { 'recursive': true, 'force': true } )
        process.stdout.write( '\n  BLOCKED: ohne zwei aufgeloeste Dokumente ist nichts zu messen\n\n' )
        process.exit( 1 )
    }

    // A raw WebSocket client next to the browser: it shows the server sent anything at all. Without it,
    // "the head bar did not move" would be green with a mute server too.
    const messages = []
    const socket = new WebSocket( `ws://127.0.0.1:${ PORT }` )
    socket.on( 'message', ( raw ) => {
        try {
            const parsed = JSON.parse( String( raw ) )

            if( parsed.type === 'runtimeStatus' ) { messages.push( parsed ) }
        } catch( error ) {
            return
        }
    } )
    await new Promise( ( done ) => socket.on( 'open', done ) )

    const browser = await loaded.playwright.chromium.launch()
    const page = await browser.newPage()
    await page.goto( `http://127.0.0.1:${ PORT }/`, { 'waitUntil': 'networkidle' } )
    await page.waitForFunction( () => typeof window.selectRevision === 'function', { 'timeout': 20000 } )
    await page.evaluate( ( documentId ) => window.selectRevision( documentId, 'REV-01.md' ), shownDoc.documentId )
    await page.waitForSelector( '#content', { 'timeout': 15000 } )
    await wait( 800 )

    const beforeBar = await headBar( { page } )
    check( 'E1c: der Browser zeigt das angezeigte Dokument, die Kopfleiste hat noch keine Zahl', beforeBar !== null && beforeBar.includes( 'PRDs' ) === false, `Kopfleiste: "${ beforeBar }"` )

    // ── (E2/E3) a write into the document that is NOT on screen ─────────────────────────────────────
    const hiddenWrite = await runCli( { 'args': [ 'rollout', 'normalize', '--memo', hidden.number, '--project-root', tempDir ] } )
    check( 'E2a: der echte Schreibvorgang in das nicht angezeigte Dokument lief durch', hiddenWrite.ok === true, hiddenWrite.ok === true ? `${ hiddenWrite.answer[ 'phases' ] } Phasen / ${ hiddenWrite.answer[ 'workItems' ] } Zeilen` : hiddenWrite.reason )
    await wait( 3000 )

    const forHidden = messages.filter( ( message ) => message.documentId === hiddenDoc.documentId )
    check( 'E2b: die Nachricht des nicht angezeigten Dokuments ist beim rohen Client ANGEKOMMEN (der Server hat gesendet)', forHidden.length >= 1, `${ forHidden.length } Nachricht(en), ${ messages.length } insgesamt` )

    const afterHiddenBar = await headBar( { page } )
    check( 'E3a: die Kopfleiste hat sich NICHT bewegt, obwohl die Nachricht ankam', afterHiddenBar === beforeBar, `"${ beforeBar }" -> "${ afterHiddenBar }"` )
    check( 'E3b: die Kopfleiste traegt die Zahlen des nicht angezeigten Dokuments nicht', afterHiddenBar !== null && afterHiddenBar.includes( hidden.expected ) === false, `erwartet NICHT "${ hidden.expected }", gelesen "${ afterHiddenBar }"` )

    // ── (E4) control: the render path is not dead ───────────────────────────────────────────────────
    const payload = forHidden.length === 0 ? null : forHidden[ forHidden.length - 1 ]
    const controlBar = payload === null ? null : await page.evaluate( ( message ) => {
        window.renderRuntimeStatus( message )
        const host = document.getElementById( 'runtime-status' )

        return host === null ? null : host.textContent
    }, payload )
    check( 'E4: dieselbe Nutzlast direkt an renderRuntimeStatus gegeben MALT B\'s Zahlen — E3 ist der Filter, kein toter Pfad', controlBar !== null && controlBar.includes( hidden.expected ) === true, `Gegenprobe-Kopfleiste: "${ controlBar }"` )

    // ── (E5) a write into the document that IS on screen ────────────────────────────────────────────
    const shownWrite = await runCli( { 'args': [ 'rollout', 'normalize', '--memo', shown.number, '--project-root', tempDir ] } )
    check( 'E5a: der echte Schreibvorgang in das angezeigte Dokument lief durch', shownWrite.ok === true, shownWrite.ok === true ? `${ shownWrite.answer[ 'phases' ] } Phasen / ${ shownWrite.answer[ 'workItems' ] } Zeilen` : shownWrite.reason )
    await wait( 3000 )

    const finalBar = await headBar( { page } )
    check( 'E5b: die Kopfleiste traegt jetzt die Zahlen DES ANGEZEIGTEN Dokuments', finalBar !== null && finalBar.includes( shown.expected ) === true, `erwartet "${ shown.expected }", gelesen "${ finalBar }"` )
    check( 'E5c: und nicht mehr die des anderen — die Gegenprobe wurde ueberschrieben', finalBar !== null && finalBar.includes( hidden.expected ) === false, `erwartet NICHT "${ hidden.expected }", gelesen "${ finalBar }"` )

    await browser.close()
    socket.close()
    process.chdir( startDir )
    await rm( tempDir, { 'recursive': true, 'force': true } )

    const failed = results.filter( ( entry ) => entry.ok !== true )
    process.stdout.write( `\n  ${ results.length - failed.length }/${ results.length } Pruefungen bestanden\n\n` )
    process.exit( failed.length === 0 ? 0 : 1 )
}


await main()
