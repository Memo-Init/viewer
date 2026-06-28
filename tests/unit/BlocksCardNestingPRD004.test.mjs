import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { extractFunctions, readMemoViewSource } from '../helpers/extractFunction.mjs'
import { MemoView } from '../../src/MemoView.mjs'
import { BlockMeta } from '../../src/BlockMeta.mjs'


// PRD-004 (Memo 016 Kap 3, A1-A8): the blocks view rendered parent+children as a FLAT list of
// identical empty cards. This suite drives BOTH the testable static mirror MemoView.partitionBlocks
// (A1 partition by role, A6 group by chapter, A7 effectiveRequirements wired) AND the inline
// browser render functions against a minimal DOM shim (A1 nesting, A2/A3 child data, A4 req chips,
// A5 role badge, A8 child modal), plus a source-shape regression on the renderer.


// ---- Minimal DOM shim (same surface as BlockViewPRD014.test.mjs) -------------------------------
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

function collectByClass( node, cls ) {
    const hits = []
    const walk = ( n ) => {
        if( n._classes && n._classes.has( cls ) ) { hits.push( n ) }
        ;( n.children || [] ).forEach( walk )
    }
    walk( node )

    return hits
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

function allText( node ) {
    const out = []
    const walk = ( n ) => {
        if( n._text ) { out.push( n._text ) }
        ;( n.children || [] ).forEach( walk )
    }
    walk( node )

    return out
}


// A representative document: one parent (chapter "3. Block-Struktur", topics [T012], requirements
// [req-secrets]) and TWO children binding to T012 with their own additive requirements+.
const PARENT_CHILD_DOC = [
    '## 3. Block-Struktur',
    '```block-meta',
    '{ "id": "B001", "topics": ["T012"], "repos": ["repos/core"], "prds": ["PRD-001"], "requirements": ["req-secrets"] }',
    '```',
    '',
    '```block-meta',
    '{ "topic": "T012", "requirements+": ["req-coverage"] }',
    '```',
    '',
    '```block-meta',
    '{ "topic": "T012", "requirements+": ["req-docs"] }',
    '```'
].join( '\n' )


describe( 'MemoView.partitionBlocks (PRD-004, A1/A6/A7)', () => {
    function parsed() {
        return BlockMeta.parse( { doc: PARENT_CHILD_DOC } ).blocks
    }


    it( 'A1: partitions by role — children nest under their parent, not a flat list', () => {
        const { groups, orphans } = MemoView.partitionBlocks( { blocks: parsed() } )

        expect( groups ).toHaveLength( 1 )
        expect( groups[ 0 ].parents ).toHaveLength( 1 )
        const parent = groups[ 0 ].parents[ 0 ]
        expect( parent.role ).toBe( 'parent' )
        expect( parent.children ).toHaveLength( 2 )
        expect( parent.children.every( ( c ) => c.role === 'child' ) ).toBe( true )
        expect( orphans ).toEqual( [] )
    } )


    it( 'A6: groups parents by chapter — one group per chapter, no per-child repeat', () => {
        const { groups } = MemoView.partitionBlocks( { blocks: parsed() } )

        expect( groups.map( ( g ) => g.chapter ) ).toEqual( [ '3. Block-Struktur' ] )
    } )


    it( 'A7: each child carries effectiveRequirements = parent default ∪ child additive (deduped)', () => {
        const { groups } = MemoView.partitionBlocks( { blocks: parsed() } )
        const kids = groups[ 0 ].parents[ 0 ].children

        expect( kids[ 0 ].effectiveRequirements ).toEqual( [ 'req-secrets', 'req-coverage' ] )
        expect( kids[ 1 ].effectiveRequirements ).toEqual( [ 'req-secrets', 'req-docs' ] )
    } )


    it( 'A7: effectiveRequirements mirrors BlockMeta.effectiveRequirements exactly', () => {
        const blocks = parsed()
        const parent = blocks.find( ( b ) => b.role === 'parent' )
        const child = blocks.find( ( b ) => b.role === 'child' )
        const { requirements } = BlockMeta.effectiveRequirements( { parent, child } )

        const { groups } = MemoView.partitionBlocks( { blocks } )
        expect( groups[ 0 ].parents[ 0 ].children[ 0 ].effectiveRequirements ).toEqual( requirements )
    } )


    it( 'a child without a matching parent becomes a visible orphan (still gets effectiveRequirements)', () => {
        const blocks = [
            { role: 'child', topic: 'T999', requirementsPlus: [ 'req-x' ], chapter: 'X' }
        ]
        const { groups, orphans } = MemoView.partitionBlocks( { blocks } )

        expect( groups ).toEqual( [] )
        expect( orphans ).toHaveLength( 1 )
        expect( orphans[ 0 ].effectiveRequirements ).toEqual( [ 'req-x' ] )
    } )


    it( 'guards a non-array blocks argument', () => {
        const { groups, orphans } = MemoView.partitionBlocks( { blocks: undefined } )

        expect( groups ).toEqual( [] )
        expect( orphans ).toEqual( [] )
    } )
} )


describe( 'inline blocks renderer — PRD-004 (A1-A5)', () => {
    let fns = null
    let savedDocument = null


    beforeAll( async () => {
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


    function render() {
        globalThis.document = makeDocument( {} )
        const container = makeElement( 'div' )
        const blocks = BlockMeta.parse( { doc: PARENT_CHILD_DOC } ).blocks

        return fns.renderBlockView( { blocks }, container )
    }


    it( 'A1: renders ONE chapter group with the parent card and a nested .block-children block', () => {
        const root = render()

        const groups = collectByClass( root, 'block-group' )
        expect( groups ).toHaveLength( 1 )

        const nests = collectByClass( root, 'block-children' )
        expect( nests ).toHaveLength( 1 )

        // The two child cards live INSIDE the nest, not flat at group level.
        const nestedChildren = collectByAttr( nests[ 0 ], 'data-block-role' )
            .filter( ( n ) => n.getAttribute( 'data-block-role' ) === 'child' )
        expect( nestedChildren ).toHaveLength( 2 )
    } )


    it( 'A6: the chapter label is emitted ONCE (group header), not per child', () => {
        const root = render()

        const headers = collectByClass( root, 'block-group-header' )
            .map( ( n ) => n.textContent )
        expect( headers ).toEqual( [ '3. Block-Struktur' ] )
    } )


    it( 'A5: parent + child cards carry a role badge and a role class/attribute', () => {
        const root = render()

        const roleNodes = collectByAttr( root, 'data-block-role' )
        const roles = roleNodes.map( ( n ) => n.getAttribute( 'data-block-role' ) ).sort()
        expect( roles ).toEqual( [ 'child', 'child', 'parent' ] )

        const parentCard = roleNodes.find( ( n ) => n.getAttribute( 'data-block-role' ) === 'parent' )
        const childCard = roleNodes.find( ( n ) => n.getAttribute( 'data-block-role' ) === 'child' )
        expect( parentCard._classes.has( 'block-role-parent' ) ).toBe( true )
        expect( childCard._classes.has( 'block-role-child' ) ).toBe( true )

        const badges = collectByClass( root, 'block-role-badge' ).map( ( n ) => n.textContent ).sort()
        expect( badges ).toEqual( [ 'Child', 'Child', 'Parent' ] )
    } )


    it( 'A2/A3: a child card shows its topic chip (not empty) and a composite data-child-topic hook', () => {
        const root = render()

        const childCard = collectByAttr( root, 'data-block-role' )
            .find( ( n ) => n.getAttribute( 'data-block-role' ) === 'child' )

        expect( childCard.getAttribute( 'data-child-topic' ) ).toBe( 'T012' )
        const chips = collectByClass( childCard, 'block-tag' ).map( ( n ) => n.textContent )
        expect( chips ).toContain( 'T012' )
    } )


    it( 'A4: a child card shows its effective requirements as req chips', () => {
        const root = render()

        const reqChips = collectByClass( root, 'block-req-chip' ).map( ( n ) => n.textContent )
        expect( reqChips ).toContain( 'req-secrets' )
        expect( reqChips ).toContain( 'req-coverage' )
        expect( reqChips ).toContain( 'req-docs' )
    } )
} )


describe( 'inline block modal — PRD-004 (A8/A9)', () => {
    let fns = null
    let savedDocument = null


    beforeAll( async () => {
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


    it( 'A8: a child modal shows topic + effective requirements instead of 3x "—"', () => {
        const modal = makeElement( 'div' )
        modal.classList.add( 't-modal' )
        modal.classList.add( 't-hidden' )
        const modalBody = makeElement( 'div' )
        const modalTitle = makeElement( 'span' )
        globalThis.document = makeDocument( {
            'block-modal': modal,
            'block-modal-body': modalBody,
            'block-modal-title': modalTitle
        } )

        const childCard = fns.buildBlockItem( {
            role: 'child',
            topic: 'T012',
            requirementsPlus: [ 'req-coverage' ],
            effectiveRequirements: [ 'req-secrets', 'req-coverage' ],
            problem: null,
            solution: null,
            openQuestions: null
        } )

        childCard.click()

        // The reused modal opens.
        expect( modal.classList.contains( 't-hidden' ) ).toBe( false )

        // A9: title carries the topic, not an empty "Block ·".
        expect( modalTitle.textContent ).toBe( 'T012' )

        // A8: sections are topic + requirements, NOT three empty prose dashes.
        const sectionKeys = collectByAttr( modalBody, 'data-block-section' )
            .map( ( n ) => n.getAttribute( 'data-block-section' ) ).sort()
        expect( sectionKeys ).toEqual( [ 'requirements', 'topic' ] )

        const texts = allText( modalBody )
        expect( texts ).toContain( 'T012' )
        expect( texts.some( ( t ) => t.includes( 'req-secrets' ) ) ).toBe( true )
        expect( texts.filter( ( t ) => t === '—' ) ).toHaveLength( 0 )
    } )


    it( 'a parent modal still shows the three prose body sections', () => {
        const modal = makeElement( 'div' )
        modal.classList.add( 't-modal' )
        modal.classList.add( 't-hidden' )
        const modalBody = makeElement( 'div' )
        const modalTitle = makeElement( 'span' )
        globalThis.document = makeDocument( {
            'block-modal': modal,
            'block-modal-body': modalBody,
            'block-modal-title': modalTitle
        } )

        // PRD-003 (Memo 054 Kap 6): block now carries factualAccount + assessment (4 sections).
        const parentCard = fns.buildBlockItem( {
            role: 'parent',
            id: 'B001',
            chapter: '3. Block-Struktur',
            topics: [ 'T012' ],
            factualAccount: 'P',
            assessment: null,
            solution: 'S',
            openQuestions: 'Q'
        } )

        parentCard.click()

        const sectionKeys = collectByAttr( modalBody, 'data-block-section' )
            .map( ( n ) => n.getAttribute( 'data-block-section' ) ).sort()
        expect( sectionKeys ).toEqual( [ 'assessment', 'factual-account', 'open-questions', 'solution' ] )
    } )
} )


describe( 'source-shape regression — PRD-004 (A1/A6/A7)', () => {
    // PRD-011 (Memo 016, F1/F2): the inline client <script> was extracted into app.client.mjs. The
    // server method `static partitionBlocks` + the /blocks route STAY in MemoView.mjs, but the client
    // render fns (renderBlockView/buildBlockItem) now live in app.client.mjs — concat both so every grep
    // (server statics/routes AND client functions) resolves.
    const mjsSource = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
    const clientSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )
    const source = mjsSource + '\n' + clientSource


    it( 'the static mirror MemoView.partitionBlocks exists and invokes BlockMeta.effectiveRequirements (A7)', () => {
        expect( source ).toContain( 'static partitionBlocks( { blocks } )' )
        const slice = source.slice( source.indexOf( 'static partitionBlocks' ) )
            .slice( 0, 2000 )
        expect( slice ).toContain( 'BlockMeta.effectiveRequirements( { parent, child } )' )
    } )


    it( 'the /blocks route invokes the partition helper (effectiveRequirements no longer dead code, A7)', () => {
        const routeIdx = source.indexOf( "url.endsWith( '/blocks' )" )
        const route = source.slice( routeIdx, routeIdx + 1800 )
        expect( route ).toContain( 'MemoView.partitionBlocks( { blocks } )' )
    } )


    it( 'the renderer no longer emits a single flat .block-items list of identical cards (A1)', () => {
        const start = source.indexOf( 'function renderBlockView(' )
        // PRD-014 (A10/F9): renderBlockView gained an empty-state + parse-error preamble at the top,
        // so the chapter-group/children markup sits further down — widen the slice window accordingly.
        const slice = source.slice( start, start + 3400 )

        // A1/A6: it now builds chapter groups + nested children, not one flat .block-items loop.
        expect( slice ).toContain( 'partitionBlocks( blocks )' )
        expect( slice ).toContain( 'block-group' )
        expect( slice ).toContain( 'block-children' )
    } )


    it( 'buildBlockItem renders a role badge + role class and a child topic/req chip (A3/A4/A5)', () => {
        const start = source.indexOf( 'function buildBlockItem(' )
        const slice = source.slice( start, start + 3400 )

        expect( slice ).toContain( 'block-role-' )
        expect( slice ).toContain( 'block-role-badge' )
        expect( slice ).toContain( 'data-block-role' )
        expect( slice ).toContain( 'effectiveRequirements' )
        expect( slice ).toContain( 'block-req-chip' )
    } )


    it( 'the new render functions contain no for/while loops', () => {
        const names = [ 'partitionBlocks', 'buildBlockItem', 'renderBlockView', 'openBlockModal' ]
        const slices = names
            .map( ( name ) => {
                const start = source.indexOf( 'function ' + name + '(' )
                return start === -1 ? '' : source.slice( start, start + 2600 )
            } )
            .join( '\n' )

        expect( /for\s*\(/.test( slices ) ).toBe( false )
        expect( /while\s*\(/.test( slices ) ).toBe( false )
    } )
} )
