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


// The browser script lives inside a template literal in MemoView.mjs, so escapes like
// `\\(` / `\\n` are doubled in the raw file. Reconstruct the emitted runtime script
// (same approach as SidebarConformance.test.mjs) before extracting any function from it.
async function readEmittedScript() {
    const source = await readMemoViewSource()
    const open = source.lastIndexOf( '<script>' )
    const close = source.indexOf( '</script>', open )
    const rawSlice = source.slice( open + '<script>'.length, close )
    const toRuntime = new Function( 'return `' + rawSlice.replace( /`/g, '\\`' ) + '`' )

    return toRuntime()
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


export { extractFunctions, readMemoViewSource }
