import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import { extractFunctions, readMemoViewSource } from '../helpers/extractFunction.mjs'


// PRD-012 (Memo 011 Kap 4, F16=A): the requirements VIEW lives inside the single inline <script>
// of the HTML page MemoView.#buildHtmlPage emits. There is no jsdom in this project, so — like the
// existing render tests — we (a) prove the emitted browser script is syntactically valid, (b) assert
// the structural hooks (markup reuses .t-modal; CSS .t-modal is centered), and (c) lift the pure
// render functions out of the script and drive them against a SMALL deterministic DOM shim to assert
// the real DOM behaviour: chips carry data-req-id + a hover short-name (title), the aggregate
// container carries data-req-aggregate, and clicking a chip opens the REUSED #requirement-modal by
// removing t-hidden (US-1/US-2/US-3). This is a DOM-LEVEL assertion (no real browser).


// ---- Minimal DOM shim --------------------------------------------------------------------------
// Supports exactly the surface the extracted render functions use: createElement, getElementById,
// appendChild, setAttribute/getAttribute, classList (add/remove/contains), className, textContent,
// addEventListener + a click() dispatcher, querySelectorAll-free. Deterministic, no timers.
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

// Recursively collect all descendant nodes carrying a given attribute.
function collectByAttr( node, attr ) {
    const hits = []
    const walk = ( n ) => {
        if( n.getAttribute && n.getAttribute( attr ) !== null ) { hits.push( n ) }
        ;( n.children || [] ).forEach( walk )
    }
    walk( node )

    return hits
}


describe( 'Requirements view — PRD-012 (Memo 011 Kap 4, F16=A)', () => {
    let emittedScript = ''
    let source = ''
    let fns = null
    let savedDocument = null


    beforeAll( async () => {
        source = await readMemoViewSource()

        const open = source.lastIndexOf( '<script>' )
        const close = source.indexOf( '</script>', open )
        const rawSlice = source.slice( open + '<script>'.length, close )
        const toRuntime = new Function( 'return `' + rawSlice.replace( /`/g, '\\`' ) + '`' )
        emittedScript = toRuntime()

        fns = await extractFunctions( [
            'buildRequirementChip',
            'renderRequirementsView',
            'openRequirementModal',
            'closeRequirementModal'
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


    // HARD assertion: modal reuse. The requirement popup markup uses the existing .t-modal classes
    // and there is NO new position:fixed overlay rule for a requirement-specific modal.
    it( 'reuses the existing .t-modal component for the requirement popup (no new overlay CSS)', () => {
        expect( source.includes( 'id="requirement-modal" class="t-modal t-hidden"' ) ).toBe( true )
        expect( source.includes( 'id="req-modal-body"' ) ).toBe( true )
        expect( source.includes( 'class="t-modal-content"' ) ).toBe( true )

        // No bespoke requirement-modal overlay: there must be no `#requirement-modal { position: fixed }`
        // or a `.req-...{ position: fixed }` rule. The only position:fixed overlay is the shared .t-modal.
        expect( /#requirement-modal\s*\{[^}]*position\s*:\s*fixed/.test( source ) ).toBe( false )
        expect( /\.req-[a-z-]+\s*\{[^}]*position\s*:\s*fixed/.test( source ) ).toBe( false )
    } )


    // HARD assertion: the shared .t-modal rule is centered (computed-style equivalent at the CSS-text
    // level — display:flex + align-items:center + justify-content:center). The popup inherits this.
    it( 'the reused .t-modal rule is centered (display:flex + align-items + justify-content center)', () => {
        const ruleMatch = source.match( /\.t-modal\s*\{([^}]*)\}/ )
        expect( ruleMatch ).not.toBeNull()
        const body = ruleMatch[ 1 ]
        expect( /display\s*:\s*flex/.test( body ) ).toBe( true )
        expect( /align-items\s*:\s*center/.test( body ) ).toBe( true )
        expect( /justify-content\s*:\s*center/.test( body ) ).toBe( true )
    } )


    // US-2: a chip carries a stable data-req-id hook AND a hover short-name (title attribute) that is
    // data-derived. US-1: the chip is a .req-item.
    it( 'renders a req chip with data-req-id and a hover short-name (title)', () => {
        globalThis.document = makeDocument( {} )

        const chip = fns.buildRequirementChip( {
            id: 'REQ-0042',
            shortName: 'Tool names unique',
            title: 'Tool names unique',
            statement: 'Tool names must be unique within catalog'
        } )

        expect( chip.className ).toBe( 'req-item' )
        expect( chip.getAttribute( 'data-req-id' ) ).toBe( 'REQ-0042' )
        expect( chip.getAttribute( 'title' ) ).toBe( 'Tool names unique' )
    } )


    // US-1: PRD-level items carry data-req-id under groups; the memo aggregate container carries
    // data-req-aggregate and holds every requirement.
    it( 'renders PRD-level groups (data-req-id) and a data-req-aggregate container', () => {
        const registry = { 'requirement-modal': makeElement( 'div' ) }
        globalThis.document = makeDocument( registry )

        const container = makeElement( 'div' )
        const payload = {
            memoName: 'memo-011',
            groups: [
                { groupKey: 'viewer', requirements: [ { id: 'REQ-0001', shortName: 'Alpha', scope: { repos: [ 'viewer' ] } } ] },
                { groupKey: 'spec', requirements: [ { id: 'REQ-0002', shortName: 'Beta', scope: { repos: [ 'spec' ] } } ] }
            ],
            aggregate: [
                { id: 'REQ-0001', shortName: 'Alpha', scope: { repos: [ 'viewer' ] } },
                { id: 'REQ-0002', shortName: 'Beta', scope: { repos: [ 'spec' ] } }
            ]
        }

        const root = fns.renderRequirementsView( payload, container )

        const reqIdNodes = collectByAttr( root, 'data-req-id' )
        const ids = reqIdNodes.map( ( n ) => n.getAttribute( 'data-req-id' ) ).sort()
        // Two PRD-level chips + two aggregate chips = four data-req-id nodes total.
        expect( reqIdNodes.length ).toBe( 4 )
        expect( ids ).toEqual( [ 'REQ-0001', 'REQ-0001', 'REQ-0002', 'REQ-0002' ] )

        const aggNodes = collectByAttr( root, 'data-req-aggregate' )
        expect( aggNodes.length ).toBe( 1 )
        expect( aggNodes[ 0 ].getAttribute( 'data-req-aggregate' ) ).toBe( 'memo-011' )
        // The aggregate container holds all (here: 2) requirement chips.
        expect( collectByAttr( aggNodes[ 0 ], 'data-req-id' ).length ).toBe( 2 )
    } )


    // US-3: clicking a chip opens the REUSED #requirement-modal by removing t-hidden, and the modal
    // body is populated with requirement details. Closing re-adds t-hidden.
    it( 'opens the reused #requirement-modal on chip click and toggles t-hidden', () => {
        const modal = makeElement( 'div' )
        modal.classList.add( 't-modal' )
        modal.classList.add( 't-hidden' )
        const modalBody = makeElement( 'div' )
        const modalTitle = makeElement( 'span' )
        const registry = {
            'requirement-modal': modal,
            'req-modal-body': modalBody,
            'req-modal-title': modalTitle
        }
        globalThis.document = makeDocument( registry )

        const chip = fns.buildRequirementChip( {
            id: 'REQ-0042',
            shortName: 'Tool names unique',
            statement: 'Tool names must be unique within catalog',
            scope: { repos: [ 'viewer' ] },
            severity: 'blocker',
            origin: 'ai-added'
        } )

        // Before click: modal hidden (t-hidden present == computed display:none equivalent).
        expect( modal.classList.contains( 't-hidden' ) ).toBe( true )

        chip.click()

        // After click: modal visible (t-hidden removed == display:flex equivalent, centered via .t-modal).
        expect( modal.classList.contains( 't-hidden' ) ).toBe( false )
        // Body shows requirement details (statement value present).
        const detailTexts = modalBody.children
            .map( ( row ) => row.children.map( ( c ) => c.textContent ) )
            .flat()
        expect( detailTexts ).toContain( 'Tool names must be unique within catalog' )
        expect( detailTexts ).toContain( 'blocker' )
        expect( detailTexts ).toContain( 'ai-added' )

        // Close re-hides via t-hidden.
        fns.closeRequirementModal()
        expect( modal.classList.contains( 't-hidden' ) ).toBe( true )
    } )


    // Source-grep guard (PRD HARD): the new render JS must use array methods, not for/while loops.
    it( 'the new requirements render functions contain no for/while loops', () => {
        const names = [ 'buildRequirementChip', 'renderRequirementsView', 'openRequirementModal', 'closeRequirementModal', 'loadRequirementsView' ]
        const slices = names
            .map( ( name ) => {
                const start = source.indexOf( 'function ' + name + '(' )
                if( start === -1 ) {
                    const asyncStart = source.indexOf( 'async function ' + name + '(' )
                    return asyncStart === -1 ? '' : source.slice( asyncStart, asyncStart + 1200 )
                }
                return source.slice( start, start + 1200 )
            } )
            .join( '\n' )

        expect( /for\s*\(/.test( slices ) ).toBe( false )
        expect( /while\s*\(/.test( slices ) ).toBe( false )
    } )
} )
