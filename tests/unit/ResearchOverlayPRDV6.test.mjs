import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, sep } from 'node:path'

import vm from 'node:vm'

import { MemoView } from '../../src/MemoView.mjs'
import { extractFunctions, extractFunctionSources } from '../helpers/extractFunction.mjs'


// Memo 080 PRD-V6 (Kap 16, WI-177): a reference document is a DEEPER LEVEL of the memo, so it opens as
// an overlay OVER the prose instead of replacing it. The server door (GET /api/research-page) and the
// path-traversal guard (readResearchDoc) already existed and are deliberately NOT touched — this suite
// proves both halves: the guard still bites (real calls) and the client wiring points at the overlay.
//
// This project has NO jsdom (see A11yAndLabelsPRD013), so the DOM-near parts are asserted at SOURCE
// level — the same convention ResearchAnnotationM3 and FootnoteApparatusPRDV4 follow. Every count-based
// case states HOW MANY items it compared: a check without a comparison basis is not a pass.
const HERE = dirname( fileURLToPath( import.meta.url ) )
const CLIENT_PATH = join( HERE, '..', '..', 'src', 'public', 'app.client.mjs' )
const CSS_PATH = join( HERE, '..', '..', 'src', 'public', 'app.css' )
const SERVER_PATH = join( HERE, '..', '..', 'src', 'MemoView.mjs' )


// The six class names that Befund 6 of the PRD measured as UNSTYLED (0 rules in app.css before this PRD).
const UNSTYLED_BEFORE = [
    'research-open-link',
    'topic-research-line',
    'topic-research-label',
    'research-view-bar',
    'research-back-link',
    'research-view-file'
]


function countOccurrences( haystack, needle ) {
    return haystack.split( needle ).length - 1
}


describe( 'PRD-V6 — der Server-Schutz bleibt die letzte Instanz (echte Aufrufe, A8)', () => {
    let memoDir = ''

    beforeAll( async () => {
        memoDir = await mkdtemp( join( tmpdir(), 'v6-research-' ) )
        await mkdir( join( memoDir, 'context' ), { recursive: true } )
        await writeFile( join( memoDir, 'context', 'research-form.md' ), '# Form\n\nEin Beleg.\n', 'utf8' )
        await writeFile( join( dirname( memoDir ), 'outside-secret.md' ), 'top secret', 'utf8' )
    } )


    afterAll( async () => {
        await rm( memoDir, { recursive: true, force: true } )
    } )


    it( 'reads the real research file the overlay asks for — the door itself still opens', async () => {
        const doc = await MemoView.readResearchDoc( { memoDir, researchFile: 'context/research-form.md' } )

        expect( doc ).not.toBeNull()
        expect( doc.content ).toContain( '# Form' )
        expect( doc.researchFile ).toBe( 'context/research-form.md' )
        expect( doc.path.startsWith( memoDir + sep ) ).toBe( true )
    } )


    it( 'refuses EVERY escape shape a manipulated client could send (5 of 5 real calls return null)', async () => {
        const escapes = [
            '../outside-secret.md',
            'context/../../outside-secret.md',
            '/etc/passwd.md',
            './../outside-secret.md',
            'context/./../../outside-secret.md'
        ]

        expect( escapes.length ).toBe( 5 )
        const results = await Promise.all(
            escapes.map( ( researchFile ) => MemoView.readResearchDoc( { memoDir, researchFile } ) )
        )
        const refused = results.filter( ( entry ) => entry === null )

        expect( refused.length ).toBe( escapes.length )
    } )


    it( 'the within-memo guard line in readResearchDoc is UNCHANGED (this PRD may not touch it)', async () => {
        const server = await readFile( SERVER_PATH, 'utf8' )

        expect( server ).toContain( 'const within = abs === baseDir || abs.startsWith( baseDir + sep )' )
        expect( countOccurrences( server, 'static async readResearchDoc( { memoDir, researchFile } )' ) ).toBe( 1 )
    } )


    it( 'the route payload and its 404 branch are unchanged — the overlay reuses, it does not rewrite', async () => {
        const server = await readFile( SERVER_PATH, 'utf8' )
        const branch = server.slice(
            server.indexOf( "if( url === '/api/research-page' && req.method === 'GET' ) {" ),
            server.indexOf( "if( url.startsWith( '/api/' ) ) {" )
        )

        expect( branch.length ).toBeGreaterThan( 0 )
        expect( branch ).toContain( "MemoView.readResearchDoc( { 'memoDir': location[ 'memoDir' ], 'researchFile': file } )" )
        expect( branch ).toContain( 'sendJson( res, 404, { \'error\': `Research doc not found: ${ file }` } )' )
        expect( branch ).toContain( "'content': doc[ 'content' ]" )
    } )
} )


describe( 'PRD-V6 — das Overlay-Markup erbt, es erfindet nichts (A1, A2)', () => {
    let server = ''
    let css = ''

    beforeAll( async () => {
        server = await readFile( SERVER_PATH, 'utf8' )
        css = await readFile( CSS_PATH, 'utf8' )
    } )


    it( 'carries EXACTLY ONE #research-modal, built from the shared .t-modal classes', () => {
        expect( countOccurrences( server, 'id="research-modal"' ) ).toBe( 1 )
        expect( server ).toContain( '<div id="research-modal" class="t-modal t-hidden" role="dialog" aria-modal="true" aria-labelledby="research-modal-title">' )
    } )


    it( 'declares all four hooks the client reaches for — 4 of 4 ids present exactly once', () => {
        const ids = [ 'research-modal-title', 'research-modal-full', 'research-modal-close', 'research-modal-body' ]

        expect( ids.length ).toBe( 4 )
        const found = ids.filter( ( id ) => countOccurrences( server, `id="${ id }"` ) === 1 )

        expect( found.length ).toBe( ids.length )
    } )


    it( 'sits inside the modal stack, right after #block-modal and before #annotation-modal', () => {
        const block = server.indexOf( 'id="block-modal"' )
        const research = server.indexOf( 'id="research-modal"' )
        const annotation = server.indexOf( 'id="annotation-modal"' )

        expect( block ).toBeGreaterThan( -1 )
        expect( research ).toBeGreaterThan( block )
        expect( annotation ).toBeGreaterThan( research )
    } )


    it( 'A2 — NO #research-modal rule sets position/backdrop/z-index; all 4 of them are geometry only', () => {
        const rules = css
            .split( '\n' )
            .filter( ( line ) => line.includes( '#research-modal' ) && line.includes( '{' ) )

        expect( rules.length ).toBe( 4 )
        const offenders = rules.filter( ( line ) => /position\s*:|z-index\s*:|var\(--overlay\)/.test( line ) )

        expect( offenders ).toEqual( [] )
    } )


    it( 'A2 — the shared .t-modal base rules stay singular (1 .t-modal, 1 .t-hidden, 1 .t-modal-content)', () => {
        expect( countOccurrences( css, '\n        .t-modal {' ) ).toBe( 1 )
        expect( countOccurrences( css, '\n        .t-hidden {' ) ).toBe( 1 )
        expect( countOccurrences( css, '\n        .t-modal-content {' ) ).toBe( 1 )
    } )
} )


describe( 'PRD-V6 — die Client-Vorpruefung als Klassenregel, nicht als Fallliste (A7)', () => {
    let isResearchOverlayPath = null

    beforeAll( async () => {
        const fns = await extractFunctions( [ 'isResearchOverlayPath' ] )
        isResearchOverlayPath = fns.isResearchOverlayPath
    } )


    it( 'lets an honest memo-relative research path through (4 of 4 accepted)', () => {
        const accepted = [
            'context/research-viewer-defekte-rev02.md',
            'context/research/deep.md',
            'notes.md',
            'context/a..b.md'
        ]

        expect( accepted.length ).toBe( 4 )
        const passed = accepted.filter( ( entry ) => isResearchOverlayPath( entry ) === true )

        expect( passed ).toEqual( accepted )
    } )


    it( 'refuses ANY scheme, not just http/https — 6 of 6 rejected without a fetch ever being built', () => {
        const schemes = [
            'http://example.com/x.md',
            'https://example.com/x.md',
            'HTTPS://EXAMPLE.COM/x.md',
            'file:///etc/passwd.md',
            'javascript:alert(1)//x.md',
            'data:text/markdown,hi.md'
        ]

        expect( schemes.length ).toBe( 6 )
        const rejected = schemes.filter( ( entry ) => isResearchOverlayPath( entry ) === false )

        expect( rejected ).toEqual( schemes )
    } )


    it( 'refuses every root-anchored and traversal shape on BOTH separators (7 of 7 rejected)', () => {
        const bad = [
            '/etc/passwd.md',
            '\\\\server\\share\\x.md',
            '../outside.md',
            'context/../../outside.md',
            'context\\..\\outside.md',
            '..',
            '../'
        ]

        expect( bad.length ).toBe( 7 )
        const rejected = bad.filter( ( entry ) => isResearchOverlayPath( entry ) === false )

        expect( rejected ).toEqual( bad )
    } )


    it( 'refuses a non-string / empty value instead of failing silently later (5 of 5 rejected)', () => {
        const junk = [ '', '   ', null, undefined, 42 ]

        expect( junk.length ).toBe( 5 )
        const rejected = junk.filter( ( entry ) => isResearchOverlayPath( entry ) === false )

        expect( rejected.length ).toBe( junk.length )
    } )
} )


describe( 'PRD-V6 — die Verdrahtung im Client (Quelltext-Nachweis, kein jsdom)', () => {
    let client = ''
    let overlayBlock = ''

    beforeAll( async () => {
        client = await readFile( CLIENT_PATH, 'utf8' )
        overlayBlock = client.slice(
            client.indexOf( 'function isResearchOverlayPath( researchFile )' ),
            client.indexOf( 'function uniqueList( arr )' )
        )
    } )


    it( 'A3 — openResearchOverlay writes into #research-modal-body and NEVER into contentEl', () => {
        const fn = client.slice(
            client.indexOf( 'function openResearchOverlay( researchFile )' ),
            client.indexOf( 'function isResearchOverlayOpen()' )
        )

        expect( fn.length ).toBeGreaterThan( 0 )
        expect( fn ).toContain( "'/api/research-page?documentId=' + encodeURIComponent( currentDocumentId )" )
        expect( fn ).toContain( "'&file=' + encodeURIComponent( researchFile )" )
        expect( fn ).toContain( "document.getElementById( 'research-modal-body' )" )
        expect( fn ).toContain( 'marked.parse(' )
        expect( fn ).toContain( 'renderAllDiagrams()' )
        expect( fn.includes( 'contentEl' ) ).toBe( false )
    } )


    it( 'A7 — the pre-check runs BEFORE the fetch is even assembled (no request on a refused path)', () => {
        const fn = client.slice(
            client.indexOf( 'function openResearchOverlay( researchFile )' ),
            client.indexOf( 'function isResearchOverlayOpen()' )
        )
        const guard = fn.indexOf( 'if( !isResearchOverlayPath( researchFile ) ) { return }' )
        const fetchCall = fn.indexOf( 'fetch( qs )' )

        expect( guard ).toBeGreaterThan( -1 )
        expect( fetchCall ).toBeGreaterThan( guard )
    } )


    it( 'A9 — a failed read leaves the overlay OPEN with a named message, it does not navigate away', () => {
        const fn = client.slice(
            client.indexOf( 'function openResearchOverlay( researchFile )' ),
            client.indexOf( 'function isResearchOverlayOpen()' )
        )

        expect( fn ).toContain( "body.innerHTML = '<p class=\"research-overlay-error\">Research-Dokument konnte nicht geladen werden: '" )
        expect( fn ).toContain( 'escapeHtml( researchFile )' )
        expect( fn.includes( "classList.add( 't-hidden' )" ) ).toBe( false )
    } )


    it( 'A6 — closing is wired the shared way: button, backdrop identity, Escape — and #content is untouched', () => {
        const close = client.slice(
            client.indexOf( 'function closeResearchOverlay()' ),
            client.indexOf( 'function uniqueList( arr )' )
        )

        expect( close ).toContain( "researchModalCloseBtn.addEventListener( 'click', closeResearchOverlay )" )
        expect( close ).toContain( 'if( ev.target === researchModalEl ) { closeResearchOverlay() }' )
        expect( close ).toContain( "if( ev.key === 'Escape' && isResearchOverlayOpen() ) { closeResearchOverlay() }" )
        expect( close.includes( 'contentEl' ) ).toBe( false )
    } )


    it( 'A4 — openResearchDoc still exists, still owns #content, and is reachable via #research-modal-full', () => {
        expect( client ).toContain( 'function openResearchDoc( researchFile )' )
        const full = client.slice(
            client.indexOf( "var researchModalFullBtn = document.getElementById( 'research-modal-full' )" ),
            client.indexOf( 'function uniqueList( arr )' )
        )

        expect( full.length ).toBeGreaterThan( 0 )
        // the file must be read BEFORE closing, because closeResearchOverlay clears it.
        expect( full.indexOf( 'var file = researchOverlayFile' ) ).toBeLessThan( full.indexOf( 'closeResearchOverlay()' ) )
        expect( full.indexOf( 'closeResearchOverlay()' ) ).toBeLessThan( full.indexOf( 'openResearchDoc( file )' ) )

        const doc = client.slice(
            client.indexOf( 'function openResearchDoc( researchFile )' ),
            client.indexOf( 'function isResearchOverlayPath( researchFile )' )
        )

        expect( doc ).toContain( 'contentEl.innerHTML = back + renderMarkdownWithFootnotes(' )
        expect( doc ).toContain( 'currentResearchFile = researchFile' )
    } )


    it( 'A5 — the topic-line entry point now calls openResearchOverlay, and no longer openResearchDoc', () => {
        const entry = client.slice(
            client.indexOf( "researchRow.className = 'topic-research-line'" ),
            client.indexOf( 'wrap.appendChild( researchRow )' )
        )

        expect( entry.length ).toBeGreaterThan( 0 )
        expect( entry ).toContain( "link.addEventListener( 'click', function() { openResearchOverlay( file ) } )" )
        expect( entry.includes( 'openResearchDoc( file )' ) ).toBe( false )
        expect( entry ).toContain( "link.title = 'Research-Dokument öffnen'" )
        expect( entry.includes( '(annotierbar)' ) ).toBe( false )
    } )


    it( 'the overlay state is its OWN variable — it must not make saveAnnotation post targetKind:research', () => {
        expect( client ).toContain( 'let researchOverlayFile = null' )
        expect( client ).toContain( 'researchFile: currentResearchFile' )
        expect( client.includes( 'researchFile: researchOverlayFile' ) ).toBe( false )
    } )


    it( 'A11 — an in-memo .md link opens the overlay; without an open memo the navigate branch survives', () => {
        const intercept = client.slice(
            client.indexOf( 'function classifyLinkHref( href )' ),
            client.indexOf( 'function connect()' )
        )

        expect( intercept.length ).toBeGreaterThan( 0 )
        expect( intercept ).toContain( 'if( currentDocumentId && isResearchOverlayPath( stem ) ) {' )
        expect( intercept ).toContain( 'openResearchOverlay( stem )' )
        // the pre-existing in-app navigation stays, and stays BELOW the overlay branch.
        expect( intercept ).toContain( "{ type: 'navigate', path: decision.href }" )
        expect( intercept.indexOf( 'openResearchOverlay( stem )' ) )
            .toBeLessThan( intercept.indexOf( "{ type: 'navigate', path: decision.href }" ) )
        // only a 'doc' decision ever reaches either branch — external/anchor/route are still returned early.
        expect( intercept.indexOf( "if( decision.kind !== 'doc' ) { return }" ) )
            .toBeLessThan( intercept.indexOf( 'openResearchOverlay( stem )' ) )
    } )


    it( 'A11 — the fragment is dropped for the read, so REV-02.md#kap-10 resolves to the file', () => {
        const intercept = client.slice(
            client.indexOf( 'function classifyLinkHref( href )' ),
            client.indexOf( 'function connect()' )
        )

        expect( intercept ).toContain( "var stem = decision.href.split( '#' )[ 0 ].split( '?' )[ 0 ]" )
    } )


    it( 'A13 — the new block keeps the surrounding classic-script style (no for/while, no semicolons, no arrows)', () => {
        expect( overlayBlock.length ).toBeGreaterThan( 0 )
        expect( /\b(for|while)\s*\(/.test( overlayBlock ) ).toBe( false )
        expect( /;\s*\n/.test( overlayBlock ) ).toBe( false )
        expect( /=>/.test( overlayBlock ) ).toBe( false )
        const declared = [
            'function isResearchOverlayPath( researchFile )',
            'function openResearchOverlay( researchFile )',
            'function isResearchOverlayOpen()',
            'function closeResearchOverlay()'
        ]

        expect( declared.length ).toBe( 4 )
        const present = declared.filter( ( decl ) => overlayBlock.includes( decl ) )

        expect( present ).toEqual( declared )
    } )
} )


// The DOM-near behaviour is RUN, not only read: the four overlay functions are lifted out of the client
// script and executed in a vm sandbox against stubbed nodes (the PRD-V5/PRD-Q3 convention in this suite,
// because the project carries no jsdom). This is what turns "the source says X" into "X happens".
const makeNode = () => {
    const node = { innerHTML: '', textContent: '', classes: new Set( [ 't-hidden' ] ) }
    node.classList = {
        add: ( name ) => node.classes.add( name ),
        remove: ( name ) => node.classes.delete( name ),
        contains: ( name ) => node.classes.has( name )
    }

    return node
}


describe( 'PRD-V6 — das Overlay im Lauf (vm-Sandbox, echte Funktionen aus dem Client)', () => {
    let liftedSource = ''

    beforeAll( async () => {
        const lifted = await extractFunctionSources( [
            'escapeHtml',
            'isResearchOverlayPath',
            'openResearchOverlay',
            'isResearchOverlayOpen',
            'closeResearchOverlay'
        ] )
        liftedSource = lifted[ 'source' ]

        expect( lifted[ 'names' ].length ).toBe( 5 )
        expect( liftedSource.length ).toBeGreaterThan( 0 )
    } )


    const runOverlay = async ( { researchFile, documentId = 'doc-1', fetchResult = null } ) => {
        const modal = makeNode()
        const body = makeNode()
        const title = makeNode()
        const content = makeNode()
        const nodes = { 'research-modal': modal, 'research-modal-body': body, 'research-modal-title': title, 'content': content }
        const calls = { fetch: [], diagrams: 0 }

        const sandbox = {
            console,
            currentDocumentId: documentId,
            researchOverlayFile: null,
            marked: { parse: ( markdown ) => `<article>${ markdown }</article>` },
            renderAllDiagrams: () => { calls.diagrams += 1 },
            document: { getElementById: ( id ) => ( nodes[ id ] === undefined ? null : nodes[ id ] ) },
            fetch: ( url ) => {
                calls.fetch.push( url )
                if( fetchResult === null ) { return Promise.reject( new Error( 'network down' ) ) }

                return Promise.resolve( fetchResult )
            }
        }

        vm.createContext( sandbox )
        vm.runInContext( `${ liftedSource }\nopenResearchOverlay( __file )`, Object.assign( sandbox, { __file: researchFile } ) )
        await new Promise( ( resolve ) => { setTimeout( resolve, 0 ) } )

        return { modal, body, title, content, calls, sandbox }
    }


    const okResponse = ( markdown ) => ( { ok: true, status: 200, json: () => Promise.resolve( { content: markdown } ) } )


    it( 'A3 — a good path lands in #research-modal-body, opens the overlay and leaves #content untouched', async () => {
        const run = await runOverlay( { researchFile: 'context/research-form.md', fetchResult: okResponse( '# Form' ) } )

        expect( run.calls.fetch.length ).toBe( 1 )
        expect( run.calls.fetch[ 0 ] ).toBe( '/api/research-page?documentId=doc-1&file=context%2Fresearch-form.md' )
        expect( run.body.innerHTML ).toBe( '<article># Form</article>' )
        expect( run.title.textContent ).toBe( 'context/research-form.md' )
        expect( run.modal.classes.has( 't-hidden' ) ).toBe( false )
        expect( run.content.innerHTML ).toBe( '' )
        expect( run.calls.diagrams ).toBe( 1 )
        expect( run.sandbox.researchOverlayFile ).toBe( 'context/research-form.md' )
    } )


    it( 'A7 — a refused path opens NOTHING and fetches NOTHING (4 of 4 stay silent)', async () => {
        const refused = [ 'https://example.com/x.md', '/etc/passwd.md', '../outside.md', '' ]

        expect( refused.length ).toBe( 4 )
        const runs = []
        await refused.reduce(
            ( chain, researchFile ) => chain.then( async () => { runs.push( await runOverlay( { researchFile, fetchResult: okResponse( 'x' ) } ) ) } ),
            Promise.resolve()
        )

        expect( runs.length ).toBe( refused.length )
        expect( runs.filter( ( run ) => run.calls.fetch.length === 0 ).length ).toBe( refused.length )
        expect( runs.filter( ( run ) => run.modal.classes.has( 't-hidden' ) === true ).length ).toBe( refused.length )
    } )


    it( 'without an open memo nothing opens either — no documentId, no overlay, no request', async () => {
        const run = await runOverlay( { researchFile: 'context/research-form.md', documentId: '', fetchResult: okResponse( '# Form' ) } )

        expect( run.calls.fetch.length ).toBe( 0 )
        expect( run.modal.classes.has( 't-hidden' ) ).toBe( true )
    } )


    it( 'A9 — a 404 from the route leaves the overlay OPEN and names the file, escaped', async () => {
        const run = await runOverlay( {
            researchFile: 'context/<ghost>.md',
            fetchResult: { ok: false, status: 404, json: () => Promise.resolve( {} ) }
        } )

        expect( run.calls.fetch.length ).toBe( 1 )
        expect( run.modal.classes.has( 't-hidden' ) ).toBe( false )
        expect( run.body.innerHTML ).toContain( 'konnte nicht geladen werden' )
        expect( run.body.innerHTML ).toContain( '&lt;ghost&gt;' )
        expect( run.body.innerHTML.includes( '<ghost>' ) ).toBe( false )
        expect( run.content.innerHTML ).toBe( '' )
    } )


    it( 'A9 — a dead connection behaves the same way: message inside, overlay still closable', async () => {
        const run = await runOverlay( { researchFile: 'context/research-form.md', fetchResult: null } )

        expect( run.modal.classes.has( 't-hidden' ) ).toBe( false )
        expect( run.body.innerHTML ).toContain( 'konnte nicht geladen werden' )

        vm.runInContext( 'closeResearchOverlay()', run.sandbox )

        expect( run.modal.classes.has( 't-hidden' ) ).toBe( true )
        expect( run.body.innerHTML ).toBe( '' )
        expect( run.sandbox.researchOverlayFile ).toBeNull()
    } )


    it( 'A6 — closing hides the overlay, empties it and forgets the file; #content is never read', async () => {
        const run = await runOverlay( { researchFile: 'context/research-form.md', fetchResult: okResponse( '# Form' ) } )

        expect( vm.runInContext( 'isResearchOverlayOpen()', run.sandbox ) ).toBe( true )

        vm.runInContext( 'closeResearchOverlay()', run.sandbox )

        expect( vm.runInContext( 'isResearchOverlayOpen()', run.sandbox ) ).toBe( false )
        expect( run.body.innerHTML ).toBe( '' )
        expect( run.content.innerHTML ).toBe( '' )
        expect( run.sandbox.researchOverlayFile ).toBeNull()
    } )
} )


describe( 'PRD-V6 — A10: die CSS-Luecke aus Befund 6 ist geschlossen (vorher 0 Treffer)', () => {
    let css = ''

    beforeAll( async () => {
        css = await readFile( CSS_PATH, 'utf8' )
    } )


    it( 'every one of the six formerly unstyled class names now carries at least one rule (6 of 6)', () => {
        expect( UNSTYLED_BEFORE.length ).toBe( 6 )
        const styled = UNSTYLED_BEFORE.filter( ( name ) => css.includes( `.${ name }` ) )

        expect( styled ).toEqual( UNSTYLED_BEFORE )
    } )


    it( 'the two button classes drop the browser 3D box explicitly (appearance + border reset)', () => {
        const open = css.slice( css.indexOf( '#content .research-open-link {' ), css.indexOf( '#content .research-open-link:hover' ) )
        const back = css.slice( css.indexOf( '.research-back-link {' ), css.indexOf( '.research-back-link:hover' ) )

        expect( open.length ).toBeGreaterThan( 0 )
        expect( back.length ).toBeGreaterThan( 0 )
        const required = [ 'appearance: none', 'background: none', 'border: none', 'cursor: pointer' ]

        expect( required.length ).toBe( 4 )
        expect( required.filter( ( rule ) => open.includes( rule ) ) ).toEqual( required )
        expect( required.filter( ( rule ) => back.includes( rule ) ) ).toEqual( required )
    } )


    it( 'the overlay gets a reading width instead of the 720px form width', () => {
        expect( css ).toContain( '#research-modal .t-modal-content { width: 980px; }' )
    } )
} )
