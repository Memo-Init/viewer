// Runtime-Status-E2E (Memo 080, PRD-V3 / WI-104 + WI-105) — boot the REAL memo-view server against a temp
// .memo tree, connect a REAL WebSocket client and a REAL Chromium, write to the database with the REAL CLI
// and look at what arrives and what is on screen.
//
// Why a manual e2e and not only unit tests: the running server registers the memo's `revisions/` SUBFOLDER
// (ProjectAutoRegister), while `memo-NNN.db` lies in the MEMO folder one level up. A db branch bolted onto
// the registered folder alone passes every unit test and is DEAD in production. This harness lets the server
// register the tree itself and therefore measures the path that actually runs.
//
// Proven here, in the real server and the real browser, not in a unit test:
//   (A) a real database commit (`memo rollout normalize`) reaches the client as a `runtimeStatus` message,
//       and the head line changes without a reload and without moving the scroll position
//   (B) a file event WITHOUT a grown sequence adds NO further message (no noise)
//   (C) the line names the empty rollout state in words before the write and the figures after it
//   (D) how many fs events ONE commit produces — the measurement the debounce window is derived from
//
// The memo database is created by the REAL `memo new` (core CLI) so the schema is the production schema.
// Without the sibling core repo the harness reports BLOCKED and exits 1 — it never reports a pass it could
// not measure. Playwright is resolved from the sibling repo memo-init.github.io (the viewer buys no
// dependency); without it the browser block is reported as skipped and the message assertions still run.
//
// Run: MEMOVIEW_NO_BROWSER=1 node tests/manual/runtime-status-e2e.mjs  → exits 0 on success, 1 on any fail.
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync, watch } from 'node:fs'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { WebSocket } from 'ws'

import { MemoView } from '../../src/MemoView.mjs'
import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'


const PORT = 47917
const MEMO_SLUG = '080-db-vollausbau-und-laufzeit-transparenz'
const CORE_CLI = resolve( process.cwd(), '..', 'core', 'cli', 'bin', 'memo.mjs' )
const REAL_STATE = resolve( process.cwd(), '..', '..', '.memo', 'memos', MEMO_SLUG, 'rollout', 'state.json' )
const PLAYWRIGHT_ANCHORS = [
    resolve( process.cwd(), '..', 'memo-init.github.io', 'package.json' ),
    resolve( process.cwd(), 'package.json' )
]

const execFileAsync = promisify( execFile )
const results = []

const check = ( label, condition, detail ) => {
    results.push( { label, ok: condition === true } )
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

        return { ok: true, answer: JSON.parse( run.stdout ) }
    } catch( error ) {
        return { ok: false, answer: null, reason: String( error.stdout || error.message ).slice( 0, 400 ) }
    }
}


// A rollout state the normalize can ingest. MEASURED cause for the dedup: memo 080's own rollout/state.json
// lists 90 PRD rows with only 77 DISTINCT ids (the P0 tracer PRDs appear a second time in their build-out
// phase), and `rollout_work_item.id` is the PRIMARY KEY — the real command dies with "UNIQUE constraint
// failed: rollout_work_item.id". The harness says how many rows it dropped, so the collision stays visible
// instead of being papered over. Without the real file a small synthetic state is used and the run says so.
const buildState = async () => {
    if( existsSync( REAL_STATE ) !== true ) {
        const phases = Array.from( { length: 3 } )
            .map( ( _, index ) => ( { phase: index, name: `Phase ${ index }`, prds: [ { id: `PRD-${ index }-A` }, { id: `PRD-${ index }-B` } ] } ) )

        return { state: { memo: 'M080', phases }, source: 'synthetisch (rollout/state.json nicht neben diesem Checkout)', dropped: 0, prds: 6 }
    }

    const parsed = JSON.parse( await readFile( REAL_STATE, 'utf8' ) )
    const seen = new Set()
    const dropped = parsed[ 'phases' ]
        .reduce( ( count, phase ) => {
            const all = phase[ 'prds' ] || []
            const kept = all
                .filter( ( entry ) => {
                    if( seen.has( entry[ 'id' ] ) === true ) { return false }
                    seen.add( entry[ 'id' ] )

                    return true
                } )
            phase[ 'prds' ] = kept

            return count + ( all.length - kept.length )
        }, 0 )

    return { state: parsed, source: 'echtes rollout/state.json von Memo 080', dropped, prds: seen.size }
}


const main = async () => {
    process.env[ 'MEMOVIEW_NO_BROWSER' ] = '1'

    if( existsSync( CORE_CLI ) !== true ) {
        process.stderr.write( `\n  BLOCKED: die memo-CLI ist nicht aufloesbar (${ CORE_CLI }) — ohne sie kann kein echter Datenbank-Commit gemessen werden.\n\n` )
        process.exit( 1 )
    }

    const startDir = process.cwd()
    const tempDir = await mkdtemp( join( tmpdir(), 'runtime-status-e2e-' ) )

    // The memo is created by the REAL CLI, so the database carries the production schema.
    const created = await runCli( { args: [ 'new', '--topic', 'Laufzeit Status E2E', '--project-root', tempDir ] } )
    check( 'das Memo wurde mit der echten CLI angelegt (Produktions-Schema)', created.ok === true && created.answer[ 'dbCreated' ] === true, created.ok === true ? created.answer[ 'dbPath' ] : created.reason )

    if( created.ok !== true ) {
        await rm( tempDir, { recursive: true, force: true } )
        process.exit( 1 )
    }

    const memoNumber = created.answer[ 'number' ]
    const memoDir = resolve( created.answer[ 'dbPath' ], '..' )
    const dbPath = created.answer[ 'dbPath' ]
    await mkdir( join( memoDir, 'rollout' ), { recursive: true } )

    // A revision long enough to scroll — otherwise "the scroll position did not move" would be a statement
    // about a page that can not scroll at all, which proves nothing.
    await writeFile( created.answer[ 'revPath' ], `${ await readFile( created.answer[ 'revPath' ], 'utf8' ) }\n${ 'Fuellzeile fuer eine scrollbare Seite.\n\n'.repeat( 300 ) }`, 'utf8' )

    const built = await buildState()
    await writeFile( join( memoDir, 'rollout', 'state.json' ), JSON.stringify( built.state, null, 2 ), 'utf8' )
    process.stdout.write( `\n  Rollout-Zustand: ${ built.source } — ${ built.prds } eindeutige PRD-Kennungen, ${ built.dropped } doppelte entfernt\n` )

    // Isolation: the server boots INSIDE the temp tree, so its auto-register never touches the real .memo/.
    process.chdir( tempDir )
    await MemoView.startServer( { port: PORT } )

    const listBody = await ( await fetch( `http://127.0.0.1:${ PORT }/api/documents` ) ).json()
    const documents = listBody.documents || []
    check( 'genau EIN Dokument ist registriert (die Boot-Registrierung des Baums)', documents.length === 1, `${ documents.length } Dokument(e)` )

    const doc = documents[ 0 ]
    const before = DoltDbAssembler.readRuntimeStatus( { dbPath } )
    process.stdout.write( `  Ausgangsmessung: seq ${ before[ 'seq' ] } · ${ before[ 'phases' ] } Phasen · ${ before[ 'workItems' ] } Rollout-Zeilen · rolloutInDb ${ before[ 'rolloutInDb' ] }\n` )
    check( 'Ausgangslage: der Rollout-Zustand steht NICHT in der Datenbank', before[ 'rolloutInDb' ] === false, `${ before[ 'phases' ] }/${ before[ 'workItems' ] }` )

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

    const loaded = loadPlaywright()
    const browser = loaded === null ? null : await loaded.playwright.chromium.launch()
    const page = browser === null ? null : await browser.newPage()

    if( page !== null ) {
        await page.goto( `http://127.0.0.1:${ PORT }/`, { waitUntil: 'networkidle' } )
        await page.waitForFunction( () => typeof window.buildRuntimeStatusLine === 'function', { timeout: 20000 } )
        await page.evaluate( ( documentId ) => window.selectRevision( documentId, 'REV-01.md' ), doc.documentId )
        await page.waitForSelector( '#content', { timeout: 15000 } )
        await wait( 500 )
        await page.evaluate( () => window.scrollTo( 0, 400 ) )
        await wait( 300 )

        // The GAP branch, rendered by the real client in the real browser: an empty rollout must say so in
        // words. Measured here instead of only in Node, because this is the branch the user sees.
        const gapLine = await page.evaluate( () => window.buildRuntimeStatusLine( { seq: 179, latest: { seq: 179, entity: 'write-through-workItems', entityId: 'workItems', at: '2026-09-04T22:19:52.022Z' }, phases: 0, workItems: 0, rolloutInDb: false } ) )
        check( 'C1: die leere Rollout-Lage wird im echten Browser in Worten benannt, nicht als Null-Bilanz',
            gapLine.gap === true && gapLine.html.includes( 'Rollout-Zustand nicht in der Datenbank' ) === true && gapLine.html.includes( '0 Phasen' ) === false,
            gapLine.html )
    } else {
        process.stdout.write( '  SKIP  Browser-Block: playwright nicht aufloesbar von ' + PLAYWRIGHT_ANCHORS.join( ' | ' ) + '\n' )
    }

    const scrollBefore = page === null ? null : await page.evaluate( () => window.scrollY )

    // ── (D) how many fs events does ONE real commit produce? The debounce window is derived from this. ──
    const observed = []
    const probe = watch( memoDir, ( eventType, filename ) => observed.push( String( filename ) ) )
    await wait( 400 )

    // ── (A) the real write: `memo rollout normalize` stages the rows, stamps them and freezes ONE commit ──
    const normalized = await runCli( { args: [ 'rollout', 'normalize', '--memo', memoNumber, '--project-root', tempDir ] } )
    check( 'A0: `memo rollout normalize` lief durch', normalized.ok === true, normalized.ok === true ? `${ normalized.answer[ 'phases' ] } Phasen / ${ normalized.answer[ 'workItems' ] } Zeilen` : normalized.reason )

    await wait( 2500 )
    probe.close()

    const dbEvents = observed.filter( ( name ) => DoltDbAssembler.isDbFileName( { fileName: name } )[ 'isDbFile' ] === true )
    process.stdout.write( `\n  fs-Ereignisse je Fest-Schreibung: ${ dbEvents.length } auf memo-${ memoNumber }.db (${ observed.length } insgesamt: ${ [ ...new Set( observed ) ].join( ', ' ) })\n` )
    check( 'D1: eine Fest-Schreibung erzeugt mindestens ein Datei-Ereignis auf der Datenbank', dbEvents.length >= 1, `${ dbEvents.length } Ereignis(se)` )

    const after = DoltDbAssembler.readRuntimeStatus( { dbPath } )
    check( 'A1: der Rollout-Zustand steht jetzt in der Datenbank', after[ 'rolloutInDb' ] === true && after[ 'phases' ] > 0 && after[ 'workItems' ] > 0, `${ after[ 'phases' ] } Phasen / ${ after[ 'workItems' ] } Zeilen` )
    check( 'A2: das Journal hat eine Zeile der Art rollout-normalize gewonnen', after[ 'seq' ] > before[ 'seq' ] && after[ 'latest' ][ 'entity' ] === 'rollout-normalize', `seq ${ before[ 'seq' ] } -> ${ after[ 'seq' ] }, Art ${ after[ 'latest' ] === null ? '-' : after[ 'latest' ][ 'entity' ] }` )
    check( 'A3: mindestens eine runtimeStatus-Nachricht ist beim Client angekommen', messages.length >= 1, `${ messages.length } Nachricht(en)` )
    check( 'A4: die juengste Nachricht traegt alle sechs Nutzfelder', messages.length >= 1
        && [ 'documentId', 'seq', 'latest', 'phases', 'workItems', 'rolloutInDb' ].every( ( key ) => Object.keys( messages[ messages.length - 1 ] ).includes( key ) === true ),
        messages.length === 0 ? 'keine Nachricht' : Object.keys( messages[ messages.length - 1 ] ).join( ',' ) )
    check( 'A5: sie meldet den Rollout-Zustand mit den Zahlen der Datenbank', messages.length >= 1
        && messages[ messages.length - 1 ].rolloutInDb === true
        && messages[ messages.length - 1 ].phases === after[ 'phases' ]
        && messages[ messages.length - 1 ].workItems === after[ 'workItems' ],
        messages.length === 0 ? '-' : `${ messages[ messages.length - 1 ].phases }/${ messages[ messages.length - 1 ].workItems }` )

    if( page !== null ) {
        const shown = await page.evaluate( () => {
            const host = document.getElementById( 'runtime-status' )

            return { text: host === null ? null : host.textContent, gap: host === null ? null : host.classList.contains( 'runtime-status-gap' ), scrollY: window.scrollY }
        } )
        check( 'A6: die Kopfzeile traegt die Zahlen, ohne Neuladen', shown.text !== null && shown.text.includes( `${ after[ 'phases' ] } Phasen · ${ after[ 'workItems' ] } PRDs` ) && shown.gap === false, shown.text )
        check( 'A7: die Scroll-Position ist unveraendert', shown.scrollY === scrollBefore, `${ scrollBefore } -> ${ shown.scrollY }` )
    }

    // ── (B) a file event WITHOUT a grown sequence adds nothing ──
    const seenBefore = messages.length
    await writeFile( dbPath, await readFile( dbPath ) )
    await wait( 2000 )
    check( 'B1: ein Datei-Ereignis ohne gestiegene Nummer erzeugt KEINE weitere Nachricht', messages.length === seenBefore, `${ seenBefore } -> ${ messages.length }` )

    if( browser !== null ) { await browser.close() }
    socket.close()
    process.chdir( startDir )
    await rm( tempDir, { recursive: true, force: true } )

    const failed = results.filter( ( entry ) => entry.ok !== true )
    process.stdout.write( `\n  ${ results.length - failed.length }/${ results.length } Pruefungen bestanden\n\n` )
    process.exit( failed.length === 0 ? 0 : 1 )
}


await main()
