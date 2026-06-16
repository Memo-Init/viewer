import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'


// Test helper: lift a named `function NAME( ... ) { ... }` declaration out of the
// single inline <script> of MemoView.mjs and return it as a callable function. The
// trace- and transcript-sidebar helpers are pure but live inside the browser script,
// so unit tests reconstruct them here (same approach as SidebarConformance.test.mjs).
async function readMemoViewSource() {
    const here = dirname( fileURLToPath( import.meta.url ) )
    const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )

    return readFile( sourcePath, 'utf8' )
}


// PRD-010 (Memo 016, F1): the app CSS was extracted from the inline <style> block of MemoView.mjs
// into src/public/app.css. Tests that assert on CSS rules must read this stylesheet rather than the
// .mjs source. Returns the raw stylesheet text (byte-identical to the formerly inline CSS).
async function readMemoViewStyles() {
    const here = dirname( fileURLToPath( import.meta.url ) )
    const cssPath = join( here, '..', '..', 'src', 'public', 'app.css' )

    return readFile( cssPath, 'utf8' )
}


// PRD-011 (Memo 016, F1/F2): the big inline client <script> block was extracted from MemoView.mjs
// into src/public/app.client.mjs and is served by the /app.client.mjs static route as a classic
// script. The extracted file is already the runtime-emitted form (the template-literal escapes were
// collapsed during extraction, so `\\(` / `\\n` are now single-backslash exactly as a browser sees
// them). Reading it directly gives the runtime script — no slice/re-evaluation needed.
async function readEmittedScript() {
    const here = dirname( fileURLToPath( import.meta.url ) )
    const clientPath = join( here, '..', '..', 'src', 'public', 'app.client.mjs' )

    return readFile( clientPath, 'utf8' )
}


function sliceFunctionBody( source, name ) {
    const marker = 'function ' + name + '('
    const start = source.indexOf( marker )
    if( start === -1 ) { throw new Error( 'function not found: ' + name ) }

    const braceStart = source.indexOf( '{', start )
    if( braceStart === -1 ) { throw new Error( 'no body for: ' + name ) }

    let depth = 0
    let idx = braceStart
    let inString = false
    let quote = ''

    while( idx < source.length ) {
        const ch = source[ idx ]
        const prev = source[ idx - 1 ]
        if( inString ) {
            if( ch === quote && prev !== '\\' ) { inString = false }
        } else if( ch === '"' || ch === "'" || ch === '`' ) {
            inString = true
            quote = ch
        } else if( ch === '{' ) {
            depth += 1
        } else if( ch === '}' ) {
            depth -= 1
            if( depth === 0 ) { return source.slice( start, idx + 1 ) }
        }
        idx += 1
    }

    throw new Error( 'unbalanced braces for: ' + name )
}


async function extractFunctions( names ) {
    const script = await readEmittedScript()
    const decls = names
        .map( ( name ) => sliceFunctionBody( script, name ) )
        .join( '\n\n' )
    const factory = new Function( decls + '\nreturn { ' + names.join( ', ' ) + ' }' )

    return factory()
}


export { extractFunctions, readMemoViewSource, readMemoViewStyles }
