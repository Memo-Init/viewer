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


// PRD-V4 (Memo 080 Kap 16): a `/` opens a regex literal only where an operand may start. After an
// identifier, a number or a closing bracket it is a division. This is the classic lexer heuristic and
// is enough for the client script.
function regexMayStart( prev ) {
    if( prev === '' ) { return true }

    return '([{,;=:!&|?+-*%~^<>'.indexOf( prev ) !== -1
}


// PRD-V4 (Memo 080 Kap 16): the brace scanner now also skips comments AND regex literals. The former
// version only knew about quotes, so a regex such as /"/g or /`+/ flipped it into a phantom string —
// escapeHtml and escapeAttr could not be lifted out at all (the generated factory failed to parse).
// Functions without a regex or a comment are sliced exactly as before.
function sliceFunctionBody( source, name ) {
    const marker = 'function ' + name + '('
    const start = source.indexOf( marker )
    if( start === -1 ) { throw new Error( 'function not found: ' + name ) }

    const braceStart = source.indexOf( '{', start )
    if( braceStart === -1 ) { throw new Error( 'no body for: ' + name ) }

    const body = source.slice( braceStart )
    const seed = { mode: 'code', quote: '', escaped: false, skip: false, inClass: false, depth: 0, prev: '', end: -1 }
    const state = body
        .split( '' )
        .reduce( ( acc, ch, idx ) => {
            if( acc.end !== -1 ) { return acc }
            if( acc.skip ) {
                acc.skip = false

                return acc
            }
            if( acc.escaped ) {
                acc.escaped = false

                return acc
            }

            const next = body[ idx + 1 ] || ''

            if( acc.mode === 'string' ) {
                if( ch === '\\' ) { acc.escaped = true }
                else if( ch === acc.quote ) { acc.mode = 'code' }

                return acc
            }
            if( acc.mode === 'line' ) {
                if( ch === '\n' ) { acc.mode = 'code' }

                return acc
            }
            if( acc.mode === 'block' ) {
                if( ch === '*' && next === '/' ) {
                    acc.mode = 'code'
                    acc.skip = true
                }

                return acc
            }
            if( acc.mode === 'regex' ) {
                if( ch === '\\' ) { acc.escaped = true }
                else if( ch === '[' ) { acc.inClass = true }
                else if( ch === ']' ) { acc.inClass = false }
                else if( ch === '/' && !acc.inClass ) { acc.mode = 'code' }

                return acc
            }

            if( ch === '/' && next === '/' ) {
                acc.mode = 'line'
                acc.skip = true

                return acc
            }
            if( ch === '/' && next === '*' ) {
                acc.mode = 'block'
                acc.skip = true

                return acc
            }
            if( ch === '/' && regexMayStart( acc.prev ) ) {
                acc.mode = 'regex'
                acc.inClass = false

                return acc
            }
            if( ch === '"' || ch === "'" || ch === '`' ) {
                acc.mode = 'string'
                acc.quote = ch
                acc.prev = ch

                return acc
            }
            if( ch === '{' ) { acc.depth += 1 }
            if( ch === '}' ) {
                acc.depth -= 1
                if( acc.depth === 0 ) { acc.end = idx }
            }
            if( !/\s/.test( ch ) ) { acc.prev = ch }

            return acc
        }, seed )

    if( state.end === -1 ) { throw new Error( 'unbalanced braces for: ' + name ) }

    return source.slice( start, braceStart + state.end + 1 )
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
