// mermaid-parse-gate.mjs
//
// PRD-011 (Memo 024 Kap 8): CI-Gate against "Render-Roulette".
//
// Unlike the diagnose-first test-mermaid-versions.mjs (which only writes a PENDING
// harness matrix), this script ACTUALLY runs `mermaid.parse` over every mermaid
// code-block found live in the memo sources and EXITS NON-ZERO on the first parse
// failure. That makes unquoted node/edge labels (the `(`, `{`, leading `/`,
// mixed/German quotes class) fail at commit time instead of crashing in the viewer.
//
// REQUIREMENTS (NETWORK + PLAYWRIGHT):
//   - Network: loads mermaid from the jsDelivr CDN (same source + version as the
//     viewer, MemoView.mjs). Offline => the gate cannot run and exits non-zero.
//   - Playwright (Chromium): runs mermaid.parse in a real browser context, exactly
//     like the viewer. Playwright is NOT a dependency of this package (mermaid is
//     loaded via CDN, never installed locally). The gate resolves a Playwright that
//     already exists in a sibling workbench project. If none is found it exits
//     non-zero with an explanation — never silently passes.
//
// Mechanic (PRD-003 / Memo 076 WI-038 — mirrors the viewer RENDER path, not just parse):
//   one page, mermaid.initialize with { startOnLoad: false, securityLevel: 'strict' } (viewer
//   parity, app.client.mjs), then a real mermaid.render + SVG innerHTML roundtrip per diagram —
//   so a diagram that PARSES but fails to RENDER turns the gate red (parse success != render success).
//
// Usage:
//   node editor/scripts/mermaid-parse-gate.mjs
//   node editor/scripts/mermaid-parse-gate.mjs --version=11.4.1
//   node editor/scripts/mermaid-parse-gate.mjs --memo-roots=/abs/.memo,/abs/projects/flowmcp/.memo
//
// Exit codes:
//   0  all diagrams parse cleanly (CI-Gate green)
//   1  at least one parse failure, OR Playwright/CDN unavailable (CI-Gate red)

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { extractMermaidBlocks } from './collect-mermaid-errors.mjs'


const DEFAULT_VERSION = '11.4.1'


const parseArgs = ( argv ) => {
    const result = { 'version': DEFAULT_VERSION, 'memoRoots': [], 'playwrightFrom': null }

    argv
        .filter( ( arg ) => arg.startsWith( '--' ) )
        .forEach( ( arg ) => {
            const eq = arg.indexOf( '=' )
            const key = eq > -1 ? arg.slice( 2, eq ) : arg.slice( 2 )
            const val = eq > -1 ? arg.slice( eq + 1 ) : 'true'

            if( key === 'version' ) { result.version = val }
            if( key === 'playwright-from' ) { result.playwrightFrom = val }
            if( key === 'memo-roots' ) {
                result.memoRoots = val
                    .split( ',' )
                    .map( ( v ) => v.trim() )
                    .filter( ( v ) => v.length > 0 )
            }
        } )

    return result
}


const collectMarkdownFiles = async ( { dir } ) => {
    const collected = []

    const walk = async ( current ) => {
        let entries

        try {
            entries = await readdir( current, { 'withFileTypes': true } )
        } catch( e ) {
            return
        }

        await Promise.all(
            entries.map( async ( entry ) => {
                const full = path.join( current, entry.name )

                if( entry.isDirectory() ) {
                    if( entry.name === 'node_modules' || entry.name.startsWith( '.git' ) ) { return }
                    await walk( full )

                    return
                }

                if( entry.isFile() && entry.name.endsWith( '.md' ) ) {
                    if( current.includes( `${path.sep}revisions${path.sep}` ) || current.endsWith( `${path.sep}revisions` ) ) {
                        collected.push( full )
                    }
                }
            } )
        )
    }

    await walk( dir )

    return collected
}


const collectDiagrams = async ( { memoRoots } ) => {
    const existing = memoRoots.filter( ( root ) => existsSync( root ) )

    const perRoot = await Promise.all(
        existing.map( async ( root ) => {
            const files = await collectMarkdownFiles( { 'dir': root } )

            const perFile = await Promise.all(
                files.map( async ( file ) => {
                    const content = await readFile( file, 'utf8' )
                    const blocks = extractMermaidBlocks( { 'content': content, 'sourcePath': file, 'memoRoot': root } )

                    return blocks.map( ( block ) => ( {
                        // The display id (memo-rev-index) is NOT unique across roots —
                        // the flowmcp root collapses the memo segment to "revisions".
                        // The composite source:line is the stable key for failure attribution.
                        'id':         `${block.memo}-${block.rev}-${String( block.index ).padStart( 2, '0' )}`,
                        'key':        `${block.relSource}:${block.startLine}`,
                        'source':     block.relSource,
                        'sourcePath': block.sourcePath,
                        'line':       block.startLine,
                        'code':       block.code
                    } ) )
                } )
            )

            return perFile.flat()
        } )
    )

    return { 'diagrams': perRoot.flat(), 'roots': existing }
}


const resolvePlaywright = ( { playwrightFrom, workspaceRoot } ) => {
    const candidates = [
        playwrightFrom,
        path.join( workspaceRoot, 'projects', 'agentprobe', 'package.json' ),
        path.join( workspaceRoot, 'projects', 'opendata-enabled-ai', 'package.json' )
    ].filter( ( c ) => typeof c === 'string' && c.length > 0 )

    const found = candidates
        .map( ( anchor ) => {
            try {
                const require = createRequire( anchor )
                const pw = require( 'playwright' )

                return { 'anchor': anchor, 'playwright': pw }
            } catch( e ) {
                return null
            }
        } )
        .find( ( entry ) => entry !== null )

    return { 'resolved': found || null }
}


const runParse = async ( { diagrams, version, playwright } ) => {
    const cdn = `https://cdn.jsdelivr.net/npm/mermaid@${version}/dist/mermaid.min.js`

    const browser = await playwright.chromium.launch()
    const page = await browser.newPage()

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="${cdn}"></script></head><body></body></html>`

    await page.setContent( html, { 'waitUntil': 'networkidle' } )

    const ready = await page.evaluate( () => typeof window.mermaid !== 'undefined' )

    if( ready !== true ) {
        await browser.close()

        return { 'status': 'no-mermaid', 'results': [] }
    }

    await page.evaluate( () => {
        // PRD-003 (Memo 076 WI-038): 'strict' mirrors the viewer (app.client.mjs), so the gate
        // sanitises diagram-embedded HTML exactly like production instead of trusting it ('loose').
        window.mermaid.initialize( { 'startOnLoad': false, 'securityLevel': 'strict' } )
    } )

    const results = await page.evaluate( async ( items ) => {
        const out = []

        await items.reduce( async ( prev, item, idx ) => {
            await prev

            try {
                // PRD-003 (Memo 076 WI-038): parity with the viewer render path — a real
                // mermaid.render + SVG innerHTML roundtrip (not just mermaid.parse), so a diagram
                // that parses but fails to render turns the gate red. The id must be a stable,
                // valid DOM id for mermaid's temporary render node, hence the index-based 'gate-N'.
                const rendered = await window.mermaid.render( 'gate-' + idx, item.code )
                const container = document.createElement( 'div' )
                container.innerHTML = rendered.svg
                out.push( { 'id': item.id, 'source': item.source, 'line': item.line, 'ok': true, 'error': null } )
            } catch( err ) {
                const message = ( err && err.message ) ? err.message : String( err )
                out.push( { 'id': item.id, 'source': item.source, 'line': item.line, 'ok': false, 'error': message } )
            }
        }, Promise.resolve() )

        return out
    }, diagrams )

    await browser.close()

    return { 'status': 'done', 'results': results }
}


const run = async ( { version, memoRoots, playwrightFrom, workspaceRoot } ) => {
    const { resolved } = resolvePlaywright( { 'playwrightFrom': playwrightFrom, 'workspaceRoot': workspaceRoot } )

    if( resolved === null ) {
        return { 'status': 'no-playwright' }
    }

    const { diagrams, roots } = await collectDiagrams( { 'memoRoots': memoRoots } )

    if( diagrams.length === 0 ) {
        return { 'status': 'no-diagrams', 'roots': roots }
    }

    const parseResult = await runParse( { 'diagrams': diagrams, 'version': version, 'playwright': resolved.playwright } )

    if( parseResult.status === 'no-mermaid' ) {
        return { 'status': 'no-mermaid' }
    }

    const failures = parseResult.results
        .filter( ( r ) => r.ok !== true )
        .map( ( r ) => ( {
            'id':     r.id,
            'error':  r.error,
            'source': r.source,
            'line':   r.line
        } ) )

    return {
        'status':   'done',
        'roots':    roots,
        'total':    diagrams.length,
        'failures': failures
    }
}


const main = async () => {
    const here = path.dirname( fileURLToPath( import.meta.url ) )
    const editorRoot = path.resolve( here, '..' )
    const memoToolkitRoot = path.resolve( editorRoot, '..' )
    const workspaceRoot = path.resolve( memoToolkitRoot, '..', '..' )

    const args = parseArgs( process.argv.slice( 2 ) )
    const memoRoots = args.memoRoots.length > 0
        ? args.memoRoots.map( ( r ) => path.resolve( r ) )
        : [
            path.join( workspaceRoot, '.memo' ),
            path.join( workspaceRoot, 'projects', 'flowmcp', '.memo' )
        ]

    const result = await run( {
        'version':        args.version,
        'memoRoots':      memoRoots,
        'playwrightFrom': args.playwrightFrom,
        'workspaceRoot':  workspaceRoot
    } )

    if( result.status === 'no-playwright' ) {
        console.error( '[MERMAID-GATE] Playwright nicht aufloesbar. Gate braucht Chromium (Playwright) + CDN-Netzwerk.' )
        console.error( '[MERMAID-GATE] Setze --playwright-from=<pfad/zu/package.json> eines Projekts mit Playwright.' )
        process.exit( 1 )

        return
    }

    if( result.status === 'no-mermaid' ) {
        console.error( '[MERMAID-GATE] mermaid konnte nicht vom CDN geladen werden (Netzwerk?).' )
        process.exit( 1 )

        return
    }

    if( result.status === 'no-diagrams' ) {
        console.error( `[MERMAID-GATE] Keine Diagramme gefunden in: ${result.roots.join( ', ' )}` )
        process.exit( 1 )

        return
    }

    console.log( `[MERMAID-GATE] Memo-Roots: ${result.roots.join( ', ' )}` )
    console.log( `[MERMAID-GATE] Diagramme geparst: ${result.total}` )
    console.log( `[MERMAID-GATE] Parse-Fehler: ${result.failures.length}` )

    if( result.failures.length > 0 ) {
        result.failures.forEach( ( f ) => {
            console.error( `  FAIL ${f.id}  (${f.source}:${f.line})` )
            console.error( `       ${f.error}` )
        } )
        console.error( '[MERMAID-GATE] CI-Gate ROT: mindestens ein Diagramm parst nicht.' )
        process.exit( 1 )

        return
    }

    console.log( '[MERMAID-GATE] CI-Gate GRUEN: alle Diagramme parsen sauber.' )
    process.exit( 0 )
}


main().catch( ( e ) => {
    console.error( '[MERMAID-GATE] Fehler:', e )
    process.exit( 1 )
} )


export { parseArgs, collectMarkdownFiles, collectDiagrams, resolvePlaywright, run }
