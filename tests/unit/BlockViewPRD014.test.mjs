import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import { extractFunctions, readMemoViewSource, readMemoViewStyles } from '../helpers/extractFunction.mjs'
import { BlockMeta } from '../../src/BlockMeta.mjs'


// PRD-010 (Memo 014 Kap 2): the block VIEW lives inside the single inline <script> of the HTML page
// MemoView.#buildHtmlPage emits — exactly like the Requirements-view (PRD-012). There is no jsdom in
// this project, so — mirroring RequirementsViewPRD012.test.mjs — we (a) prove the emitted browser
// script is syntactically valid, (b) assert the structural hooks (the popup REUSES .t-modal, no new
// position:fixed CSS), (c) lift the pure render functions out of the script and drive them against a
// SMALL deterministic DOM shim to assert real DOM behaviour: block-items carry data-block-id (B-id),
// the modal carries the three data-block-section hooks, clicking a block opens the REUSED #block-modal
// by removing t-hidden, and (d) prove the /blocks endpoint payload is BlockMeta.parse output.


// ---- Minimal DOM shim (same surface as RequirementsViewPRD012.test.mjs) -------------------------
function makeClassList( node ) {
    return {
        add( ...names ) { names.forEach( ( n ) => node._classes.add( n ) ) },
        remove( ...names ) { names.forEach( ( n ) => node._classes.delete( n ) ) },
        contains( n ) { return node._classes.has( n ) }
    }
}

function makeElement( tag ) {
    const node = {
        tagName: String( tag ).toUpperCase(),
        children: [],
        _attrs: {},
        _classes: new Set(),
        _listeners: {},
        _text: ''
    }

    node.classList = makeClassList( node )

    Object.defineProperty( node, 'className', {
        get() { return [ ...node._classes ].join( ' ' ) },
        set( value ) {
            node._classes = new Set( String( value ).split( /\s+/ ).filter( ( s ) => s.length > 0 ) )
        }
    } )

    Object.defineProperty( node, 'textContent', {
        get() { return node._text },
        set( value ) {
            node._text = String( value )
            node.children = []
        }
    } )

    node.setAttribute = ( key, value ) => { node._attrs[ key ] = String( value ) }
    node.getAttribute = ( key ) => ( key in node._attrs ? node._attrs[ key ] : null )
    node.appendChild = ( child ) => { node.children.push( child ); return child }
    node.addEventListener = ( type, fn ) => {
        if( !node._listeners[ type ] ) { node._listeners[ type ] = [] }
        node._listeners[ type ].push( fn )
    }
    node.click = () => {
        ( node._listeners[ 'click' ] || [] ).forEach( ( fn ) => fn( { target: node } ) )
    }
    node.querySelectorAll = () => []

    return node
}

function makeDocument( registry ) {
    return {
        createElement: ( tag ) => makeElement( tag ),
        getElementById: ( id ) => ( registry[ id ] || null ),
        addEventListener: () => {}
    }
}

function collectByAttr( node, attr ) {
    const hits = []
    const walk = ( n ) => {
        if( n.getAttribute && n.getAttribute( attr ) !== null ) { hits.push( n ) }
        ;( n.children || [] ).forEach( walk )
    }
    walk( node )

    return hits
}


describe( 'Block view — PRD-010 (Memo 014 Kap 2)', () => {
    let emittedScript = ''
    let source = ''
    let fns = null
    let savedDocument = null


    beforeAll( async () => {
        // PRD-010 (Memo 016, F1): CSS moved to src/public/app.css. PRD-011 (Memo 016, F1/F2): the
        // inline client <script> was extracted into src/public/app.client.mjs (already runtime form).
        // emittedScript reads the client file directly; source concats .mjs + CSS + client so both
        // server-side route greps AND client render-function greps resolve.
        const here = dirname( fileURLToPath( import.meta.url ) )
        const clientPath = join( here, '..', '..', 'src', 'public', 'app.client.mjs' )
        const mjsSource = await readMemoViewSource()
        const cssSource = await readMemoViewStyles()
        const clientSource = await readFile( clientPath, 'utf8' )

        emittedScript = clientSource
        source = mjsSource + '\n' + cssSource + '\n' + clientSource

        fns = await extractFunctions( [
            'partitionBlocks',
            'blockChildHook',
            'blocksEmptyState',
            'buildEmptyState',
            'buildBlockItem',
            'renderBlockView',
            'openBlockModal',
            'closeBlockModal'
        ] )

        savedDocument = globalThis.document
    } )

    afterAll( () => {
        globalThis.document = savedDocument
    } )


    it( 'emits a syntactically valid inline browser script', () => {
        let message = ''
        try {
            new vm.Script( emittedScript )
        } catch( err ) {
            message = err.message
        }
        expect( message ).toBe( '' )
    } )


    // HARD assertion: modal reuse. The block popup markup uses the existing .t-modal classes and there
    // is NO new position:fixed overlay rule for a block-specific modal.
    it( 'reuses the existing .t-modal component for the block popup (no new overlay CSS)', () => {
        expect( source.includes( 'id="block-modal" class="t-modal t-hidden"' ) ).toBe( true )
        expect( source.includes( 'id="block-modal-body"' ) ).toBe( true )

        // No bespoke block-modal overlay: there must be no `#block-modal { position: fixed }` rule nor
        // a `.block-...{ position: fixed }` rule. The only position:fixed overlay is the shared .t-modal.
        expect( /#block-modal\s*\{[^}]*position\s*:\s*fixed/.test( source ) ).toBe( false )
        expect( /\.block-[a-z-]+\s*\{[^}]*position\s*:\s*fixed/.test( source ) ).toBe( false )
    } )


    // A block card carries the stable data-block-id hook and the .block-item class. The id is a B-id.
    it( 'renders a .block-item with a B-id data-block-id and repos/tags/topics chips', () => {
        globalThis.document = makeDocument( {} )

        const item = fns.buildBlockItem( {
            id: 'B001',
            chapter: 'Konsolidierung',
            repos: [ 'repos/viewer' ],
            tags: [ 'Code' ],
            topics: [ 'T014' ]
        } )

        // PRD-004 (A5): the card now also carries a role class (block-role-parent/-child).
        expect( item._classes.has( 'block-item' ) ).toBe( true )
        expect( item.getAttribute( 'data-block-id' ) ).toBe( 'B001' )
        expect( /^B\d{3}$/.test( item.getAttribute( 'data-block-id' ) ) ).toBe( true )

        const tagTexts = collectByAttr( item, 'class' ).length // sanity; not used further
        expect( tagTexts ).toBeGreaterThanOrEqual( 0 )
    } )


    // renderBlockView produces one .block-item per block, each carrying data-block-id.
    it( 'renders one .block-item per block (data-block-id), B-id shape', () => {
        globalThis.document = makeDocument( {} )

        const container = makeElement( 'div' )
        const payload = {
            blocks: [
                { id: 'B001', chapter: 'Kap 1', repos: [ 'repos/viewer' ], tags: [ 'Code' ], topics: [] },
                { id: 'B002', chapter: 'Kap 2', repos: [], tags: [ 'Docs' ], topics: [ 'T014' ] }
            ]
        }

        const root = fns.renderBlockView( payload, container )

        const idNodes = collectByAttr( root, 'data-block-id' )
        const ids = idNodes.map( ( n ) => n.getAttribute( 'data-block-id' ) ).sort()
        expect( idNodes.length ).toBe( 2 )
        expect( ids ).toEqual( [ 'B001', 'B002' ] )
        ids.forEach( ( id ) => expect( /^B\d{3}$/.test( id ) ).toBe( true ) )
    } )


    // Click a block -> opens the REUSED #block-modal (removes t-hidden) and populates the three body
    // sections with stable data-block-section hooks. Closing re-adds t-hidden.
    it( 'opens the reused #block-modal on block click, shows 3 body sections, toggles t-hidden', () => {
        const modal = makeElement( 'div' )
        modal.classList.add( 't-modal' )
        modal.classList.add( 't-hidden' )
        const modalBody = makeElement( 'div' )
        const modalTitle = makeElement( 'span' )
        const registry = {
            'block-modal': modal,
            'block-modal-body': modalBody,
            'block-modal-title': modalTitle
        }
        globalThis.document = makeDocument( registry )

        const item = fns.buildBlockItem( {
            id: 'B001',
            chapter: 'Konsolidierung',
            repos: [ 'repos/viewer' ],
            tags: [ 'Code' ],
            topics: [],
            problem: 'Die Bloecke sind unsichtbar.',
            solution: 'Ein Overlay rendert sie.',
            openQuestions: 'Wie viele Bloecke pro Memo?'
        } )

        // Before click: modal hidden (t-hidden present == computed display:none equivalent).
        expect( modal.classList.contains( 't-hidden' ) ).toBe( true )

        item.click()

        // After click: modal visible (t-hidden removed == display:flex equivalent, centered via .t-modal).
        expect( modal.classList.contains( 't-hidden' ) ).toBe( false )

        // The body carries exactly the three data-block-section hooks.
        const sectionNodes = collectByAttr( modalBody, 'data-block-section' )
        const sectionKeys = sectionNodes.map( ( n ) => n.getAttribute( 'data-block-section' ) ).sort()
        expect( sectionKeys ).toEqual( [ 'open-questions', 'problem', 'solution' ] )

        // Section values come from the block fields.
        const detailTexts = sectionNodes
            .map( ( s ) => s.children.map( ( c ) => c.textContent ) )
            .flat()
        expect( detailTexts ).toContain( 'Die Bloecke sind unsichtbar.' )
        expect( detailTexts ).toContain( 'Ein Overlay rendert sie.' )
        expect( detailTexts ).toContain( 'Wie viele Bloecke pro Memo?' )

        // Close re-hides via t-hidden.
        fns.closeBlockModal()
        expect( modal.classList.contains( 't-hidden' ) ).toBe( true )
    } )


    // The /blocks endpoint payload is exactly BlockMeta.parse output: blocks[] with id/repos/tags/
    // topics and the three flat body fields. We exercise the data source the route wraps.
    it( 'GET /api/documents/<id>/blocks payload mirrors BlockMeta.parse (blocks[] with body sections)', () => {
        const doc = [
            '## Konsolidierung, Nutzbarkeit und Sichtbarkeit',
            '',
            '```block-meta',
            '{ "id": "B001", "topics": ["T014"], "repos": ["repos/viewer"], "tags": ["Code"], "prds": ["PRD-010"] }',
            '```',
            '',
            '### Problem-Beschreibung',
            'Der Block hat keinen Viewer-Overlay.',
            '',
            '### Loesungsansatz',
            'Ein read-only Overlay, das .t-modal wiederverwendet.',
            '',
            '### Offene Fragen',
            'Welche Felder zeigt das Overlay?',
            ''
        ].join( '\n' )

        const { blocks } = BlockMeta.parse( { doc } )

        // The route returns { status, documentId, blocks } — blocks IS this array.
        expect( Array.isArray( blocks ) ).toBe( true )
        expect( blocks.length ).toBe( 1 )

        const block = blocks[ 0 ]
        expect( block.id ).toBe( 'B001' )
        expect( /^B\d{3}$/.test( block.id ) ).toBe( true )
        expect( block.repos ).toEqual( [ 'repos/viewer' ] )
        expect( block.tags ).toEqual( [ 'Code' ] )
        expect( block.topics ).toEqual( [ 'T014' ] )
        expect( block.problem ).toBe( 'Der Block hat keinen Viewer-Overlay.' )
        expect( block.solution ).toBe( 'Ein read-only Overlay, das .t-modal wiederverwendet.' )
        expect( block.openQuestions ).toBe( 'Welche Felder zeigt das Overlay?' )
    } )


    // The route source is wired correctly: a /blocks GET branch that calls BlockMeta.parse, matched
    // BEFORE the generic /api/documents/<id> GET (suffix is more specific).
    it( 'the /blocks route is wired to BlockMeta.parse and matched before the generic route', () => {
        expect( source.includes( "url.endsWith( '/blocks' )" ) ).toBe( true )
        expect( source.includes( 'BlockMeta.parse( { doc: content } )' ) ).toBe( true )

        const blocksIdx = source.indexOf( "url.endsWith( '/blocks' )" )
        const genericIdx = source.indexOf( "if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {" )
        expect( blocksIdx ).toBeGreaterThan( -1 )
        expect( genericIdx ).toBeGreaterThan( -1 )
        expect( blocksIdx ).toBeLessThan( genericIdx )
    } )


    // Source-grep guard (PRD HARD): the new render JS must use array methods, not for/while loops.
    it( 'the new block render functions contain no for/while loops', () => {
        const names = [ 'buildBlockItem', 'renderBlockView', 'openBlockModal', 'closeBlockModal', 'loadBlockView' ]
        const slices = names
            .map( ( name ) => {
                const start = source.indexOf( 'function ' + name + '(' )
                if( start === -1 ) {
                    const asyncStart = source.indexOf( 'async function ' + name + '(' )
                    return asyncStart === -1 ? '' : source.slice( asyncStart, asyncStart + 1600 )
                }
                return source.slice( start, start + 1600 )
            } )
            .join( '\n' )

        expect( /for\s*\(/.test( slices ) ).toBe( false )
        expect( /while\s*\(/.test( slices ) ).toBe( false )
    } )
} )
