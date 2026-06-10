// test-mermaid-versions.mjs
//
// Patches editor/src/MemoView.mjs temporarily with each mermaid version (CDN URL),
// renders every diagram from editor/tests/manual/mermaid-error-collection/extracted/INDEX.md,
// and writes a render-status matrix to editor/tests/manual/test-results/mermaid-version-matrix.json.
//
// Diagnose-first (PRD-022, Memo 011 Kap 3.1): this script does NOT upgrade the production
// MemoView.mjs version. It uses a backup-and-restore pattern so the working tree is left
// unchanged after each run. The actual upgrade decision must be made by a human reviewing
// mermaid-upgrade-decision.md.
//
// Usage:
//   node editor/scripts/test-mermaid-versions.mjs --versions=11.4.1,11.5.0
//   node editor/scripts/test-mermaid-versions.mjs --versions=11.4.1 --dry-run
//
// Render-backend: Headless Chromium via Playwright CLI (preferred). This script writes
// a standalone HTML harness with the mermaid CDN injected and instructs the operator
// to render with Playwright (so the script remains side-effect-free and does not require
// a Playwright dependency in package.json).

import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


const parseArgs = ( argv ) => {
    const result = { 'versions': [], 'indexPath': null, 'memoViewPath': null, 'outDir': null, 'dryRun': false }

    argv
        .filter( ( arg ) => arg.startsWith( '--' ) )
        .forEach( ( arg ) => {
            const eq = arg.indexOf( '=' )
            const key = eq > -1 ? arg.slice( 2, eq ) : arg.slice( 2 )
            const val = eq > -1 ? arg.slice( eq + 1 ) : 'true'

            if( key === 'versions' ) {
                result.versions = val
                    .split( ',' )
                    .map( ( v ) => v.trim() )
                    .filter( ( v ) => v.length > 0 )
            }
            if( key === 'index' ) { result.indexPath = val }
            if( key === 'memoview' ) { result.memoViewPath = val }
            if( key === 'out' ) { result.outDir = val }
            if( key === 'dry-run' ) { result.dryRun = true }
        } )

    return result
}


const parseIndex = ( { content } ) => {
    const lines = content.split( '\n' )
    const rows = []

    lines.forEach( ( line ) => {
        if( !line.startsWith( '| `' ) ) { return }
        if( line.includes( '|----|' ) ) { return }

        const cells = line.split( '|' ).map( ( c ) => c.trim() )

        if( cells.length < 8 ) { return }

        const idCell = cells[ 1 ]
        const fileCell = cells[ 7 ]
        const id = idCell.replace( /`/g, '' )
        const file = fileCell.replace( /`/g, '' )

        if( id.length > 0 && file.length > 0 && file.endsWith( '.mmd' ) ) {
            rows.push( { 'id': id, 'file': file } )
        }
    } )

    return rows
}


const buildHarness = ( { version, diagramId, diagramCode } ) => {
    const cdn = `https://cdn.jsdelivr.net/npm/mermaid@${version}/dist/mermaid.min.js`
    const safe = diagramCode.replace( /<\/script>/g, '<\\/script>' )

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Mermaid Version Test — ${version} — ${diagramId}</title>
<script src="${cdn}"></script>
</head>
<body>
<div id="status" data-status="pending"></div>
<div id="target"></div>
<pre id="source">${safe}</pre>
<script>
( async () => {
    try {
        const code = document.getElementById( 'source' ).textContent
        const result = await mermaid.render( 'mm-${diagramId}', code )
        document.getElementById( 'target' ).innerHTML = result.svg || result
        document.getElementById( 'status' ).dataset.status = 'ok'
    } catch( err ) {
        const status = document.getElementById( 'status' )
        status.dataset.status = 'fail'
        status.dataset.error = String( err && err.message ? err.message : err )
    }
} )()
</script>
</body>
</html>
`
}


const patchMemoView = async ( { memoViewPath, version } ) => {
    const original = await readFile( memoViewPath, 'utf8' )
    const backupPath = `${memoViewPath}.bak`

    await writeFile( backupPath, original, 'utf8' )

    const patched = original.replace(
        /https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@[^/]+\/dist\/mermaid\.min\.js/,
        `https://cdn.jsdelivr.net/npm/mermaid@${version}/dist/mermaid.min.js`
    )

    await writeFile( memoViewPath, patched, 'utf8' )

    return { 'backupPath': backupPath }
}


const restoreMemoView = async ( { memoViewPath, backupPath } ) => {
    if( !existsSync( backupPath ) ) { return }
    await rename( backupPath, memoViewPath )
}


const writeMatrix = async ( { matrix, versions, outDir } ) => {
    await mkdir( outDir, { 'recursive': true } )

    const matrixPath = path.join( outDir, 'mermaid-version-matrix.json' )

    const payload = {
        'generated':       new Date().toISOString(),
        'tested-versions': versions,
        'diagrams':        matrix
    }

    await writeFile( matrixPath, JSON.stringify( payload, null, 2 ), 'utf8' )

    return { 'matrixPath': matrixPath }
}


const runDryRun = async ( { versions, rows, harnessDir, outDir, extractedDir } ) => {
    await mkdir( harnessDir, { 'recursive': true } )

    const matrix = {}

    await rows.reduce( async ( prev, row ) => {
        await prev

        matrix[ row.id ] = {}

        await versions.reduce( async ( inner, version ) => {
            await inner

            const harnessName = `${row.id}__${version}.html`
            const harnessPath = path.join( harnessDir, harnessName )
            const diagramPath = path.join( extractedDir, row.file )

            let diagramCode = ''

            try {
                diagramCode = await readFile( diagramPath, 'utf8' )
            } catch( e ) {
                matrix[ row.id ][ version ] = 'NO-SOURCE'

                return
            }

            const html = buildHarness( { 'version': version, 'diagramId': row.id, 'diagramCode': diagramCode } )

            await writeFile( harnessPath, html, 'utf8' )

            matrix[ row.id ][ version ] = 'PENDING'
        }, Promise.resolve() )
    }, Promise.resolve() )

    const matrixResult = await writeMatrix( { 'matrix': matrix, 'versions': versions, 'outDir': outDir } )

    return { 'mode': 'dry-run', 'harnessDir': harnessDir, 'matrixPath': matrixResult.matrixPath, 'rows': rows.length }
}


const run = async ( { versions, indexPath, memoViewPath, outDir, dryRun } ) => {
    if( versions.length === 0 ) {
        return { 'status': 'no-versions', 'message': 'Mindestens eine Version angeben: --versions=11.4.1,11.5.0' }
    }

    if( !existsSync( indexPath ) ) {
        return { 'status': 'no-index', 'message': `INDEX.md fehlt: ${indexPath}. Erst collect-mermaid-errors.mjs ausfuehren.` }
    }

    const indexContent = await readFile( indexPath, 'utf8' )
    const rows = parseIndex( { 'content': indexContent } )
    const harnessDir = path.join( outDir, 'harness' )
    const extractedDir = path.dirname( indexPath )

    if( dryRun ) {
        return await runDryRun( { 'versions': versions, 'rows': rows, 'harnessDir': harnessDir, 'outDir': outDir, 'extractedDir': extractedDir } )
    }

    // Live mode: patches MemoView.mjs version-by-version, leaves matrix as PENDING.
    // The actual render-and-classify step needs Playwright and lives in mermaid-upgrade-decision.md as manual workflow.
    if( !existsSync( memoViewPath ) ) {
        return { 'status': 'no-memoview', 'message': `MemoView.mjs nicht gefunden: ${memoViewPath}` }
    }

    const patchLog = []

    await versions.reduce( async ( prev, version ) => {
        await prev

        const { backupPath } = await patchMemoView( { 'memoViewPath': memoViewPath, 'version': version } )

        patchLog.push( { 'version': version, 'patched': true, 'backup': backupPath } )

        await restoreMemoView( { 'memoViewPath': memoViewPath, 'backupPath': backupPath } )
    }, Promise.resolve() )

    const dryRunResult = await runDryRun( { 'versions': versions, 'rows': rows, 'harnessDir': harnessDir, 'outDir': outDir, 'extractedDir': extractedDir } )

    return { 'mode': 'live', 'patchLog': patchLog, ...dryRunResult }
}


const main = async () => {
    const here = path.dirname( fileURLToPath( import.meta.url ) )
    const editorRoot = path.resolve( here, '..' )

    const args = parseArgs( process.argv.slice( 2 ) )
    const indexPath = args.indexPath
        ? path.resolve( args.indexPath )
        : path.join( editorRoot, 'tests', 'manual', 'mermaid-error-collection', 'extracted', 'INDEX.md' )
    const memoViewPath = args.memoViewPath ? path.resolve( args.memoViewPath ) : path.join( editorRoot, 'src', 'MemoView.mjs' )
    const outDir = args.outDir ? path.resolve( args.outDir ) : path.join( editorRoot, 'tests', 'manual', 'test-results' )

    const result = await run( {
        'versions':     args.versions,
        'indexPath':    indexPath,
        'memoViewPath': memoViewPath,
        'outDir':       outDir,
        'dryRun':       args.dryRun
    } )

    if( result.status === 'no-versions' || result.status === 'no-index' || result.status === 'no-memoview' ) {
        console.log( `[TEST-MERMAID] ${result.message}` )
        process.exit( 1 )

        return
    }

    console.log( `[TEST-MERMAID] Modus: ${result.mode}` )
    console.log( `[TEST-MERMAID] Diagramme: ${result.rows}` )
    console.log( `[TEST-MERMAID] Harness-Ordner: ${result.harnessDir}` )
    console.log( `[TEST-MERMAID] Matrix: ${result.matrixPath}` )
    console.log( '[TEST-MERMAID] Status: PENDING — Render-Phase muss manuell via Playwright erfolgen.' )
    console.log( '[TEST-MERMAID] Siehe tests/manual/mermaid-upgrade-decision.md fuer den manuellen Workflow.' )
}


main().catch( ( e ) => {
    console.error( '[TEST-MERMAID] Fehler:', e )
    process.exit( 1 )
} )


export { parseArgs, parseIndex, buildHarness, patchMemoView, restoreMemoView, run }
