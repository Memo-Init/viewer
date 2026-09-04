// Graph-View-E2E (Memo 080, PRD-V2 Rework) — boot the REAL memo-view server against a temp .memo tree,
// drive it in a REAL Chromium and press the Graph button, exactly the way the finding was produced.
//
// The finding: the count line ("Topics 102 · Work-Items 223 … — Kanten: …") stood ABOVE a mermaid error
// tile. Measured cause: the source of the real inventory is 53362 characters, mermaid 11.4.1 runs a
// maxTextSize of 50000, and above that limit the renderer does NOT reject — it discards the source and
// RESOLVES with a one-node placeholder ("Maximum text size in diagram exceeded"). The failure was silent.
//
// Proven here, in the browser, not in a unit test:
//   (A) mermaid really does resolve with the placeholder for an oversize source (the measured cause).
//   (B) pressing Graph on the REAL inventory draws a REAL flowchart — every node, every edge, no tile.
//   (C) a source that can not be drawn puts the view into the shared ERROR state and the success count
//       line is GONE — no headline over a failure.
//
// Run: node tests/manual/graph-view-e2e.mjs  → exits 0 on success, 1 on any failed assertion.
// Playwright is resolved from the sibling repo memo-init.github.io (the viewer buys no dependency).
import { mkdtemp, mkdir, rm, copyFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { MemoView } from '../../src/MemoView.mjs'
import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'


const PORT = 47915
const REAL_DB = resolve( process.cwd(), '..', '..', '.memo', 'memos', '080-db-vollausbau-und-laufzeit-transparenz', 'memo-080.db' )
const PLAYWRIGHT_ANCHORS = [
    resolve( process.cwd(), '..', 'memo-init.github.io', 'package.json' ),
    resolve( process.cwd(), 'package.json' )
]

const results = []

const check = ( label, condition, detail ) => {
    results.push( { label, ok: condition === true } )
    process.stdout.write( `  ${ condition === true ? 'PASS' : 'FAIL' }  ${ label }${ detail === undefined ? '' : ` — ${ detail }` }\n` )
}


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


// A synthetic stand-in for the real inventory, used only when memo-080.db is not next to this checkout.
// Same magnitude, so the size gate is exercised either way — and the run says which source it measured.
const seedFallbackDb = ( { dbPath } ) => {
    const db = new DatabaseSync( dbPath )
    db.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, spillover TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )
    const insertTopic = db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block ) VALUES ( ?, ?, ?, ?, ? )' )
    const insertWorkItem = db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' )
    Array.from( { length: 102 } )
        .forEach( ( _, index ) => insertTopic.run( `T${ String( index ).padStart( 3, '0' ) }`, 'M080', `Topic ${ index } ${ 'a'.repeat( 120 ) }`, 'P0', 'B1' ) )
    Array.from( { length: 223 } )
        .forEach( ( _, index ) => insertWorkItem.run( `WI-${ String( index ).padStart( 3, '0' ) }`, `T${ String( index % 102 ).padStart( 3, '0' ) }`, `Work-Item ${ index } ${ 'a'.repeat( 120 ) }`, 'offen', 'g' ) )
    db.close()
}


const main = async () => {
    const loaded = loadPlaywright()

    if( loaded === null ) {
        process.stderr.write( '\n  BLOCKED: playwright not resolvable from ' + PLAYWRIGHT_ANCHORS.join( ' | ' ) + '\n\n' )
        process.exit( 1 )
    }

    const tempDir = await mkdtemp( join( tmpdir(), 'graph-view-e2e-' ) )
    process.chdir( tempDir )

    const memoDir = join( tempDir, '.memo', 'memos', '080-db-vollausbau-und-laufzeit-transparenz' )
    await mkdir( join( memoDir, 'revisions' ), { recursive: true } )
    await writeFile( join( memoDir, 'revisions', 'REV-01.md' ), '# 080 Graph-E2E\n\nRumpf.\n', 'utf8' )

    const dbPath = join( memoDir, 'memo-080.db' )
    const usedReal = existsSync( REAL_DB )

    if( usedReal === true ) {
        await copyFile( REAL_DB, dbPath )
    } else {
        seedFallbackDb( { dbPath } )
    }

    // What the server will hand out — measured BEFORE the browser, so the browser assertions have numbers
    // to be held against instead of comparing against nothing.
    const graph = DoltDbAssembler.readKnowledgeGraph( { dbPath } )
    const expectedNodes = graph[ 'source' ][ 'nodes' ]
    const expectedEdges = graph[ 'source' ][ 'edges' ]

    process.stdout.write( `\n  Datenquelle: ${ usedReal === true ? REAL_DB : 'synthetischer Ersatz (memo-080.db nicht gefunden)' }\n` )
    process.stdout.write( `  Gemessen: ${ expectedNodes } Knoten · ${ expectedEdges } Kanten · Quelle ${ graph[ 'source' ][ 'chars' ] } Zeichen `
        + `(voll ${ graph[ 'source' ][ 'fullChars' ] }, Budget ${ graph[ 'source' ][ 'budget' ] }, Cap ${ graph[ 'source' ][ 'labelCap' ] })\n\n` )

    await MemoView.startServer( { port: PORT } )
    await fetch( `http://127.0.0.1:${ PORT }/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { projectId: 'memo-init', memoPath: join( memoDir, 'revisions' ) } )
    } )

    const listBody = await ( await fetch( `http://127.0.0.1:${ PORT }/api/documents` ) ).json()
    const doc = ( listBody.documents || [] ).find( ( entry ) => entry.memoName === '080-db-vollausbau-und-laufzeit-transparenz' )

    check( 'das Memo ist registriert', doc !== undefined )

    const browser = await loaded.playwright.chromium.launch()
    const page = await browser.newPage()
    const consoleErrors = []
    page.on( 'pageerror', ( err ) => consoleErrors.push( String( err && err.message ) ) )
    await page.goto( `http://127.0.0.1:${ PORT }/`, { waitUntil: 'networkidle' } )
    await page.waitForFunction( () => typeof window.renderGraphView === 'function' )

    // ── (A) the measured cause, reproduced in the browser: an oversize source RESOLVES with a placeholder ──
    const cause = await page.evaluate( async () => {
        const oversize = [ 'flowchart LR' ]
            .concat( Array.from( { length: 500 } ).map( ( _, index ) => `    N${ index }["${ 'x'.repeat( 120 ) }"]` ) )
            .join( '\n' )
        const rendered = await window.mermaid.render( 'cause-probe', oversize )

        return {
            chars: oversize.length,
            maxTextSize: window.mermaid.mermaidAPI.getConfig().maxTextSize,
            resolved: true,
            placeholder: rendered.svg.includes( 'Maximum text size in diagram exceeded' )
        }
    } )

    check( 'A1: mermaid laeuft mit der deklarierten Grenze 50000', cause.maxTextSize === 50000, `maxTextSize=${ cause.maxTextSize }` )
    check( 'A2: eine Quelle ueber der Grenze wird NICHT abgelehnt, sondern durch die Platzhalter-Kachel ersetzt',
        cause.resolved === true && cause.placeholder === true, `${ cause.chars } Zeichen` )

    // ── (B) the real click path: select the revision, press Graph, look at what is on screen ──
    await page.evaluate( ( documentId ) => window.selectRevision( documentId, 'REV-01.md' ), doc.documentId )
    await page.waitForSelector( '#graph-view-toggle', { timeout: 10000 } )
    await page.click( '#graph-view-toggle' )
    await page.waitForSelector( '.graph-view svg', { timeout: 30000 } )

    const drawn = await page.evaluate( () => {
        const content = document.getElementById( 'content' )
        const svg = content.querySelector( '.graph-view .mermaid svg' )

        return {
            countsLine: ( content.querySelector( '[data-graph-counts]' ) || { textContent: '' } ).textContent,
            warnings: Array.from( content.querySelectorAll( '[data-graph-warning]' ) ).map( ( el ) => el.textContent ),
            hasSvg: svg !== null,
            nodeGroups: svg === null ? 0 : svg.querySelectorAll( 'g.node' ).length,
            edgePaths: svg === null ? 0 : svg.querySelectorAll( 'path.flowchart-link, .edgePaths path' ).length,
            placeholder: svg === null ? false : ( svg.textContent || '' ).includes( 'Maximum text size in diagram exceeded' ),
            mermaidErrorBoxes: content.querySelectorAll( '.mermaid-error' ).length,
            diagramErrorBoxes: content.querySelectorAll( '.diagram-error' ).length,
            errorState: content.querySelectorAll( '[data-error-state]' ).length
        }
    } )

    check( 'B1: die Zeichenflaeche traegt ein echtes SVG', drawn.hasSvg === true )
    check( 'B2: KEINE Platzhalter-Kachel im gezeichneten Graphen', drawn.placeholder === false )
    check( 'B3: alle gelesenen Knoten sind gezeichnet', drawn.nodeGroups === expectedNodes, `${ drawn.nodeGroups } von ${ expectedNodes }` )
    check( 'B4: alle gelesenen Kanten sind gezeichnet', drawn.edgePaths === expectedEdges, `${ drawn.edgePaths } von ${ expectedEdges }` )
    check( 'B5: keine Fehler-Kachel und kein Fehler-Zustand ueber dem Graphen',
        drawn.mermaidErrorBoxes === 0 && drawn.diagramErrorBoxes === 0 && drawn.errorState === 0 )
    check( 'B6: die Zaehlzeile nennt die gemessenen Zahlen', drawn.countsLine.includes( `Topics ${ graph[ 'counts' ][ 'topics' ] }` )
        && drawn.countsLine.includes( `Work-Items ${ graph[ 'counts' ][ 'workItems' ] }` ), drawn.countsLine )
    check( 'B7: die Kuerzung der Beschriftungen ist ausgewiesen, nicht still',
        graph[ 'source' ][ 'condensed' ] !== true || drawn.warnings.filter( ( text ) => text.includes( 'gekuerzt' ) === true ).length === 1 )
    check( 'B8: keine JavaScript-Fehler auf der Seite', consoleErrors.length === 0, consoleErrors.join( ' | ' ) )

    // ── (C) the failure must not be silent: an undrawable source ends in the error state, WITHOUT a headline ──
    const failed = await page.evaluate( async () => {
        const content = document.getElementById( 'content' )
        const oversize = [ 'flowchart LR' ]
            .concat( Array.from( { length: 500 } ).map( ( _, index ) => `    M${ index }["${ 'y'.repeat( 120 ) }"]` ) )
            .join( '\n' )
        window.renderGraphView( {
            counts: { topics: 102, workItems: 223, phases: 0, prds: 0, edgesTopicWorkItem: 221, edgesPhasePrd: 0, edgesTopicPrd: 0 },
            mermaid: oversize, empty: false, warnings: [], reason: null
        }, content )
        await new Promise( ( done ) => setTimeout( done, 1500 ) )

        return {
            sourceChars: oversize.length,
            errorState: content.querySelectorAll( '[data-error-state]' ).length,
            errorText: ( content.querySelector( '.view-error-reason' ) || { textContent: '' } ).textContent,
            countsLine: content.querySelectorAll( '[data-graph-counts]' ).length,
            placeholderVisible: ( content.textContent || '' ).includes( 'Maximum text size in diagram exceeded' )
        }
    } )

    check( 'C1: eine nicht zeichenbare Quelle landet im gemeinsamen Fehler-Zustand', failed.errorState === 1 )
    check( 'C2: die Erfolgs-Zaehlzeile steht NICHT mehr ueber dem Fehlschlag', failed.countsLine === 0 )
    check( 'C3: die Fehlermeldung nennt die gemessene Groesse und die Grenze',
        failed.errorText.includes( String( failed.sourceChars ) ) && failed.errorText.includes( '50000' ), failed.errorText )
    check( 'C4: die gemessenen Zahlen bleiben in der Fehlermeldung erhalten', failed.errorText.includes( 'Topics 102' ) )
    check( 'C5: die Platzhalter-Kachel wird dem Leser nicht als Graph untergeschoben', failed.placeholderVisible === false )

    await browser.close()
    process.chdir( resolve( tempDir, '..' ) )
    await rm( tempDir, { recursive: true, force: true } )

    const failures = results.filter( ( entry ) => entry.ok !== true )
    process.stdout.write( `\n  ${ results.length - failures.length }/${ results.length } checks passed\n\n` )
    process.exit( failures.length === 0 ? 0 : 1 )
}


main().catch( ( err ) => {
    process.stderr.write( `\n  E2E ERROR: ${ err && err.stack ? err.stack : err }\n\n` )
    process.exit( 1 )
} )
