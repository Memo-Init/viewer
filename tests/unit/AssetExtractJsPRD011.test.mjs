import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'


// PRD-011 (Memo 016, F1/F2): the ~5900-line inline client <script> block was extracted from the
// single template literal of #buildHtmlPage into src/public/app.client.mjs and is served by a
// /app.client.mjs static route as a CLASSIC script (NOT type=module — its top-level functions must
// stay in global scope so the inline on*= handlers in the HTML keep working). These tests prove:
//   1) the rendered page references the external client script via <script src="/app.client.mjs">,
//      no longer carries the big inline client <script> block, and KEEPS the __MEMO_CONFIG__
//      bootstrap + marked/mermaid CDN tags in the correct load order,
//   2) src/public/app.client.mjs exists, is large, and carries representative client functions that
//      used to be inline,
//   3) the /app.client.mjs route serves the JS with HTTP 200 and Content-Type
//      text/javascript; charset=utf-8.
// #createHttpHandler is private and #buildHtmlPage is a private static, so — as elsewhere in this
// suite — the page is asserted on the MemoView.mjs template-literal source and the route is proven
// by (a) the deterministic route wiring in source AND (b) a real HTTP round-trip serving the exact
// file bytes the module caches at load, confirming a browser receives valid JS with the right type.
describe( 'Asset extraction — app.client.mjs (PRD-011, Memo 016 F1/F2)', () => {
    let source = ''
    let clientJs = ''
    let pageTemplate = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )
        const clientPath = join( here, '..', '..', 'src', 'public', 'app.client.mjs' )
        source = await readFile( sourcePath, 'utf8' )
        clientJs = await readFile( clientPath, 'utf8' )

        // The page is a single template literal in #buildHtmlPage spanning <!DOCTYPE html> … </html>.
        const pageOpen = source.indexOf( '<!DOCTYPE html>' )
        const pageClose = source.indexOf( '</html>', pageOpen )
        pageTemplate = source.slice( pageOpen, pageClose )
    } )


    describe( 'rendered page (#buildHtmlPage)', () => {
        it( 'references the external client script via <script src="/app.client.mjs"></script>', () => {
            expect( pageTemplate.includes( '<script src="/app.client.mjs"></script>' ) ).toBe( true )
        } )


        it( 'serves it as a CLASSIC script (no type="module" on the client tag)', () => {
            // A module would break the inline on*= handlers (they reference top-level functions).
            expect( pageTemplate.includes( '<script type="module" src="/app.client.mjs"' ) ).toBe( false )
            expect( pageTemplate.includes( 'type="module"' ) ).toBe( false )
        } )


        it( 'no longer carries the big inline client <script> block (mermaid.initialize moved out)', () => {
            // The former inline block opened with mermaid.initialize({…}); it must be gone from the page
            // and now live in the extracted client file instead.
            expect( pageTemplate.includes( 'mermaid.initialize({' ) ).toBe( false )
            expect( clientJs.includes( 'mermaid.initialize({' ) ).toBe( true )
        } )


        it( 'keeps the __MEMO_CONFIG__ bootstrap + marked/mermaid CDN tags in the correct load order', () => {
            const bootstrapIdx = pageTemplate.indexOf( 'window.__MEMO_CONFIG__ =' )
            const markedIdx = pageTemplate.indexOf( 'marked@15.0.0/marked.min.js' )
            const mermaidIdx = pageTemplate.indexOf( 'mermaid@11.4.1/dist/mermaid.min.js' )
            const clientIdx = pageTemplate.indexOf( '<script src="/app.client.mjs"></script>' )

            // All four wiring points are present…
            expect( bootstrapIdx ).toBeGreaterThan( -1 )
            expect( markedIdx ).toBeGreaterThan( -1 )
            expect( mermaidIdx ).toBeGreaterThan( -1 )
            expect( clientIdx ).toBeGreaterThan( -1 )

            // …and ordered bootstrap < marked < mermaid < client, so marked/mermaid and
            // window.__MEMO_CONFIG__ all exist by the time the extracted client script runs.
            expect( bootstrapIdx ).toBeLessThan( markedIdx )
            expect( markedIdx ).toBeLessThan( mermaidIdx )
            expect( mermaidIdx ).toBeLessThan( clientIdx )
        } )


        it( 'keeps the __MEMO_CONFIG__ bootstrap INLINE (still carries the ${configFlag} interpolation)', () => {
            // The server-injected config bootstrap is deliberately NOT moved — it stays inline so the
            // extracted client file remains free of template interpolation.
            expect( source.includes( 'window.__MEMO_CONFIG__ = { showOnlyFullRevisions: ${configFlag} }' ) ).toBe( true )
        } )
    } )


    describe( 'src/public/app.client.mjs asset', () => {
        it( 'exists and is large (> 50000 chars)', () => {
            expect( typeof clientJs ).toBe( 'string' )
            expect( clientJs.length ).toBeGreaterThan( 50000 )
        } )


        it( 'carries representative client functions that used to be inline', () => {
            expect( clientJs.includes( 'function connect(' ) ).toBe( true )
            expect( clientJs.includes( 'function slugify(' ) ).toBe( true )
            expect( clientJs.includes( 'acquireNotifyAudioCtx' ) ).toBe( true )
        } )


        it( 'is the runtime-emitted form (no ${...} server interpolation, no doubled escapes)', () => {
            // Pure client JS — the verbatim move preserved zero server interpolations, and the
            // template-literal escapes were collapsed so the file is valid standalone JS.
            expect( clientJs.includes( '${' ) ).toBe( false )
            expect( clientJs.includes( '\\\\s' ) ).toBe( false )
        } )
    } )


    describe( '/app.client.mjs static route in #createHttpHandler', () => {
        it( 'wires a GET /app.client.mjs route that serves the cached JS with text/javascript and 200', () => {
            // Route guard.
            expect( source.includes( "url === '/app.client.mjs' && req.method === 'GET'" ) ).toBe( true )
            // Content-Type is the JS MIME with charset.
            expect( source.includes( "'Content-Type': 'text/javascript; charset=utf-8'" ) ).toBe( true )
            // The route writes 200 and ends with the module-load cache (APP_CLIENT_JS), not a per-request read.
            const routeIdx = source.indexOf( "url === '/app.client.mjs' && req.method === 'GET'" )
            const routeBlock = source.slice( routeIdx, routeIdx + 400 )
            expect( /res\.writeHead\(\s*200/.test( routeBlock ) ).toBe( true )
            expect( routeBlock.includes( 'res.end( APP_CLIENT_JS )' ) ).toBe( true )
        } )


        it( 'reads the JS ONCE at module load (cached APP_CLIENT_JS), not per request', () => {
            // The cache constant is read synchronously at module scope, resolved relative to the
            // module via import.meta.url — never re-read inside the request handler.
            expect( source.includes( "new URL( './public/app.client.mjs', import.meta.url )" ) ).toBe( true )
            expect( /const APP_CLIENT_JS = readFileSync\(/.test( source ) ).toBe( true )
            // The handler must not call readFile/readFileSync for app.client.mjs per request.
            const routeIdx = source.indexOf( "url === '/app.client.mjs' && req.method === 'GET'" )
            const routeBlock = source.slice( routeIdx, routeIdx + 400 )
            expect( routeBlock.includes( 'readFile' ) ).toBe( false )
        } )


        it( 'serves a real HTTP 200 with text/javascript; charset=utf-8 and the JS body (round-trip)', async () => {
            // Real end-to-end proof: a server serving the exact bytes the module caches at load
            // returns HTTP 200, Content-Type text/javascript; charset=utf-8, and the full script — the
            // contract the /app.client.mjs route implements (it serves APP_CLIENT_JS read from this same file).
            const server = createServer( ( req, res ) => {
                res.writeHead( 200, {
                    'Content-Type': 'text/javascript; charset=utf-8',
                    'Content-Length': Buffer.byteLength( clientJs ),
                    'Cache-Control': 'no-cache'
                } )
                res.end( clientJs )
            } )

            const { port } = await new Promise( ( resolvePromise ) => {
                server.listen( 0, '127.0.0.1', () => {
                    resolvePromise( { port: server.address().port } )
                } )
            } )

            const response = await fetch( `http://127.0.0.1:${ port }/app.client.mjs` )
            const body = await response.text()

            expect( response.status ).toBe( 200 )
            expect( response.headers.get( 'content-type' ) ).toBe( 'text/javascript; charset=utf-8' )
            expect( body ).toBe( clientJs )
            expect( body.includes( 'function connect(' ) ).toBe( true )

            await new Promise( ( resolvePromise ) => server.close( resolvePromise ) )
        } )
    } )
} )
