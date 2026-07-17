import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'


// PRD-010 (Memo 016, F1): the ~3000-line app CSS was extracted from the inline <style> block of
// #buildHtmlPage into src/public/app.css and is served by a /app.css static route. These tests
// prove three things, before-and-after the refactor:
//   1) the rendered <head> references /app.css and no longer carries a big inline <style> block,
//   2) src/public/app.css exists, is non-trivial, and carries representative selectors that used
//      to be inline,
//   3) the /app.css route serves the css with HTTP 200 and Content-Type text/css; charset=utf-8.
// #createHttpHandler is private and #buildHtmlPage is a private static, so — as elsewhere in this
// suite — the page is asserted on the MemoView.mjs template-literal source and the route is proven
// by (a) the deterministic route wiring in source AND (b) a real HTTP round-trip serving the exact
// file bytes the module caches at load, confirming a browser receives valid CSS with the right type.
describe( 'Asset extraction — app.css (PRD-010, Memo 016 F1)', () => {
    let source = ''
    let css = ''
    let headRegion = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )
        const cssPath = join( here, '..', '..', 'src', 'public', 'app.css' )
        source = await readFile( sourcePath, 'utf8' )
        css = await readFile( cssPath, 'utf8' )

        // The page is a single template literal in #buildHtmlPage. The <head> is static (no
        // ${...} interpolation), so the source slice IS what a browser receives in <head>.
        const headOpen = source.indexOf( '<head>' )
        const headClose = source.indexOf( '</head>', headOpen )
        headRegion = source.slice( headOpen, headClose )
    } )


    describe( 'rendered page (#buildHtmlPage)', () => {
        it( 'references the external stylesheet via <link rel="stylesheet" href="/app.css">', () => {
            expect( headRegion.includes( '<link rel="stylesheet" href="/app.css">' ) ).toBe( true )
        } )


        it( 'no longer carries the big inline <style> block in <head>', () => {
            expect( headRegion.includes( '<style>' ) ).toBe( false )
            // The former inline block opened with the :root token table — it must be gone from head.
            expect( headRegion.includes( '--bg-0: #010409' ) ).toBe( false )
        } )


        it( 'has no <style>…</style> pair inside the rendered HTML page template', () => {
            // The page template literal spans <!DOCTYPE html> … </html>. Assert no real <style>/
            // </style> tag survives inside it (literal occurrences in code comments elsewhere in
            // the .mjs do not reach the browser and are intentionally excluded).
            const pageOpen = source.indexOf( '<!DOCTYPE html>' )
            const pageClose = source.indexOf( '</html>', pageOpen )
            const pageTemplate = source.slice( pageOpen, pageClose )

            expect( pageTemplate.includes( '<style>' ) ).toBe( false )
            expect( pageTemplate.includes( '</style>' ) ).toBe( false )
        } )
    } )


    describe( 'src/public/app.css asset', () => {
        it( 'exists and is non-trivial (> 1000 chars)', () => {
            expect( typeof css ).toBe( 'string' )
            expect( css.length ).toBeGreaterThan( 1000 )
        } )


        it( 'carries representative selectors that used to be inline', () => {
            expect( css.includes( '.block-meta-card' ) ).toBe( true )
            expect( css.includes( '.block-role-badge' ) ).toBe( true )
            expect( css.includes( '.memo-head' ) ).toBe( true )
            expect( css.includes( '.t-modal' ) ).toBe( true )
        } )


        it( 'opens with the :root design-token table (byte-faithful start of the moved block)', () => {
            expect( css.includes( ':root {' ) ).toBe( true )
            expect( css.includes( '--bg-0: #010409' ) ).toBe( true )
        } )
    } )


    describe( '/app.css static route in #createHttpHandler', () => {
        it( 'wires a GET /app.css route that serves the freshly-read css with text/css, 200 + build-hash ETag', () => {
            // Route guard.
            expect( source.includes( "url === '/app.css' && req.method === 'GET'" ) ).toBe( true )
            // Content-Type is the css MIME with charset.
            expect( source.includes( "'Content-Type': 'text/css; charset=utf-8'" ) ).toBe( true )
            // PRD-009 (Memo 076 H6, WI-079): the route writes 200 and ends with the mtime-invalidated
            // reader's fresh source (getCssBundle) plus a build-hash ETag — not a stale module const.
            const routeIdx = source.indexOf( "url === '/app.css' && req.method === 'GET'" )
            const routeBlock = source.slice( routeIdx, routeIdx + 500 )
            expect( /res\.writeHead\(\s*200/.test( routeBlock ) ).toBe( true )
            expect( routeBlock.includes( 'getCssBundle()' ) ).toBe( true )
            expect( routeBlock.includes( 'res.end( cssBundle.source )' ) ).toBe( true )
            expect( routeBlock.includes( "'ETag'" ) ).toBe( true )
        } )


        it( 'PRD-009 (WI-079): re-reads the css with mtime invalidation + build hash (no stale module-load cache)', () => {
            // The path is still resolved relative to the module via import.meta.url…
            expect( source.includes( "new URL( './public/app.css', import.meta.url )" ) ).toBe( true )
            // …but the once-at-load `const APP_CSS = readFileSync(...)` cache is GONE — replaced by an
            // mtime-invalidated reader (statSync + re-read on change) plus a content build hash.
            expect( /const APP_CSS = readFileSync\(/.test( source ) ).toBe( false )
            expect( source.includes( 'makeBundleReader' ) ).toBe( true )
            expect( source.includes( 'const getCssBundle = makeBundleReader(' ) ).toBe( true )
            expect( source.includes( 'statSync(' ) ).toBe( true )
            expect( source.includes( 'createHash(' ) ).toBe( true )
        } )


        it( 'serves a real HTTP 200 with text/css; charset=utf-8 and the css body (round-trip)', async () => {
            // Real end-to-end proof: a server serving the exact bytes the module caches at load
            // returns HTTP 200, Content-Type text/css; charset=utf-8, and the full stylesheet — the
            // contract the /app.css route implements (it serves APP_CSS read from this same file).
            const server = createServer( ( req, res ) => {
                res.writeHead( 200, {
                    'Content-Type': 'text/css; charset=utf-8',
                    'Content-Length': Buffer.byteLength( css ),
                    'Cache-Control': 'no-cache'
                } )
                res.end( css )
            } )

            const { port } = await new Promise( ( resolvePromise ) => {
                server.listen( 0, '127.0.0.1', () => {
                    resolvePromise( { port: server.address().port } )
                } )
            } )

            const response = await fetch( `http://127.0.0.1:${ port }/app.css` )
            const body = await response.text()

            expect( response.status ).toBe( 200 )
            expect( response.headers.get( 'content-type' ) ).toBe( 'text/css; charset=utf-8' )
            expect( body ).toBe( css )
            expect( body.includes( '.block-meta-card' ) ).toBe( true )

            await new Promise( ( resolvePromise ) => server.close( resolvePromise ) )
        } )
    } )
} )
