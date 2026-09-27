import { describe, it, expect, beforeAll } from '@jest/globals'
import vm from 'node:vm'

import { extractFunctionSources, readEmittedScript, readMemoViewSource, readMemoViewStyles } from '../helpers/extractFunction.mjs'


// S5 / PRD-15 (Memo 082, Phase 9, WI-236) — the sitemap stays with the content, and a dead click says so.
//
// TWO defects at the same place, and they are NOT the same defect:
//
//   1. COUPLING. #content is replaced by a dozen different paths; only the prose and the spec page
//      rebuilt the sitemap. Open the Graph, the Blocks or the Requirements panel and the sitemap kept
//      the memo's chapters — every entry addressing a heading that is no longer on screen. The
//      research document was the second, separate break: it renders a whole new document and never
//      rebuilt the sitemap at all.
//   2. THE SILENT CLICK. The entry handler was `if( target ) { scroll }` with NO else branch. A target
//      that could not be found produced exactly nothing — the same surface as a broken page. This one
//      survives ANY repair of the first: even a perfectly coupled sitemap will one day miss a target,
//      and the difference between a tool you trust and one you do not is whether it says so.
//
// There is no jsdom in this project, so the DOM half runs against a narrow surrogate and the lifted
// PRODUCTION functions — not a replica of them. The surrogate implements what these functions actually
// touch and nothing more, so a function that starts relying on something else fails loudly here.
//
// EVERY case states HOW MUCH it compared. A case that compared nothing is a failure, never a pass —
// which is also the subject of the vacuum case below: a consistency check over ZERO entries must
// report red.

const LIFTED = [ 'tocClickVerdict', 'showTOCNote', 'clearTOCNote', 'setTOCInForce', 'syncTOCToContent', 'handleTOCEntryClick', 'buildTOC' ]

// The functions that own a #content transition. The list is the comparison set of the coupling case
// below and is stated with its count, so "all coupled" can never mean "none were looked at".
//
// For the three panels the entry is the LOADER, not the renderer: the loader is what switches the
// panel, and its three branches (server error, success, throw) all end in a replaced #content. Putting
// the call in the renderer was measured and withdrawn — the renderers are lifted out of the module by
// their own unit suites and driven against a narrow DOM shim, where a module-scope reference throws.
const CONTENT_WRITERS = [
    'renderProseContent',
    'renderSpecPage',
    'loadRequirementsView',
    'loadBlockView',
    'loadGraphView',
    'renderDbTablesView',
    'renderDbTableList',
    'renderFolderView',
    'renderFolderDocList',
    'selectFolderDoc',
    'openResearchDoc',
    'renderTranscriptContent',
    'loadTranscriptIntoContent'
]

// A function that demonstrably does NOT replace #content. It is the negative control for the coupling
// case: without it, a check that "every name in a list is coupled" would also pass on a list of names
// that are all coupled for some other reason.
const NON_WRITER = 'updateActiveTOC'


// ---- DOM surrogate -----------------------------------------------------------------------------
// Narrow on purpose. `getClientRects` is here because reachability is a real distinction in the code
// under test: "exists in the document" and "can be scrolled to" are different questions, and answering
// only the first is how a click ends up doing nothing in silence.
function makeElement( tag ) {
    const node = {
        tagName: String( tag ).toUpperCase(),
        children: [],
        parentNode: null,
        id: '',
        title: '',
        _attrs: {},
        _classes: new Set(),
        _listeners: {},
        _text: '',
        _rects: 1,
        _closest: null
    }

    node.classList = {
        add: ( ...names ) => names.forEach( ( n ) => node._classes.add( n ) ),
        remove: ( ...names ) => names.forEach( ( n ) => node._classes.delete( n ) ),
        contains: ( n ) => node._classes.has( n ),
        toggle: ( n, on ) => {
            if( on === true ) { node._classes.add( n ) }
            else { node._classes.delete( n ) }

            return node._classes.has( n )
        }
    }

    Object.defineProperty( node, 'className', {
        get: () => [ ...node._classes ].join( ' ' ),
        set: ( value ) => { node._classes = new Set( String( value ).split( /\s+/ ).filter( ( s ) => s.length > 0 ) ) }
    } )

    Object.defineProperty( node, 'textContent', {
        get: () => node._text,
        set: ( value ) => { node._text = String( value ); node.children = [] }
    } )

    Object.defineProperty( node, 'innerHTML', {
        get: () => node._html || '',
        set: ( value ) => { node._html = String( value ); node.children = [] }
    } )

    node.setAttribute = ( key, value ) => { node._attrs[ key ] = String( value ) }
    node.getAttribute = ( key ) => ( key in node._attrs ? node._attrs[ key ] : null )
    node.appendChild = ( child ) => { child.parentNode = node; node.children.push( child ); return child }
    node.prepend = ( child ) => { child.parentNode = node; node.children.unshift( child ); return child }
    node.addEventListener = ( type, fn ) => {
        if( !node._listeners[ type ] ) { node._listeners[ type ] = [] }
        node._listeners[ type ].push( fn )
    }
    node.click = () => ( node._listeners.click || [] ).map( ( fn ) => fn.call( node, { target: node } ) )
    node.closest = ( selector ) => ( node._closest === selector ? makeElement( 'div' ) : null )
    node.getBoundingClientRect = () => ( { top: 10 } )
    node.getClientRects = () => new Array( node._rects ).fill( { top: 10 } )
    node.querySelectorAll = ( selector ) => {
        const wanted = String( selector ).split( ',' ).map( ( part ) => part.trim().toUpperCase() )

        return node.children.filter( ( child ) => wanted.indexOf( child.tagName ) !== -1 )
    }
    node.querySelector = ( selector ) => {
        const match = /^li\[data-target="(.*)"\]$/.exec( String( selector ) )
        if( !match ) { return null }

        return node.children.find( ( child ) => child.getAttribute( 'data-target' ) === match[ 1 ] ) || null
    }

    return node
}


function makeStage() {
    const registry = {}
    const contentEl = makeElement( 'div' )
    const tocListEl = makeElement( 'ul' )
    const tocSidebarEl = makeElement( 'nav' )
    const tocNoteEl = makeElement( 'div' )
    tocNoteEl._classes.add( 't-hidden' )

    const document = {
        createElement: ( tag ) => makeElement( tag ),
        getElementById: ( id ) => ( registry[ id ] || null )
    }
    const scrolls = []
    const sandbox = {
        document,
        contentEl,
        tocListEl,
        tocSidebarEl,
        tocNoteEl,
        registry,
        scrolls,
        Set,
        Array,
        window: { scrollY: 0, scrollTo: ( arg ) => scrolls.push( arg ) },
        slugify: ( text ) => String( text ).toLowerCase().replace( /[^a-z0-9]+/g, '-' ),
        updateActiveTOC: () => {}
    }

    return { sandbox, contentEl, tocListEl, tocSidebarEl, tocNoteEl, registry, scrolls }
}


// Put a heading into #content AND into the id registry, the way the browser does: buildTOC assigns
// heading.id and a later getElementById( id ) must find the same node.
function addHeading( stage, tag, text, id ) {
    const heading = makeElement( tag )
    heading.textContent = text
    heading.id = id
    stage.registry[ id ] = heading
    stage.contentEl.appendChild( heading )

    return heading
}


let clientSource = ''
let markup = ''
let cssSource = ''
let liftedSource = ''


beforeAll( async () => {
    clientSource = await readEmittedScript()
    markup = await readMemoViewSource()
    cssSource = await readMemoViewStyles()
    liftedSource = ( await extractFunctionSources( LIFTED ) ).source
} )


function boot() {
    const stage = makeStage()
    const context = vm.createContext( stage.sandbox )
    vm.runInContext( 'var currentContentPanel = \'Prosa\'\n' + liftedSource, context )

    return {
        ...stage,
        call: ( name, ...args ) => {
            stage.sandbox.__args = args

            return vm.runInContext( name + '( ...__args )', context )
        },
        panel: () => vm.runInContext( 'currentContentPanel', context )
    }
}


// ---- S2: the three lages, decided purely ---------------------------------------------------------
describe( 'S5 / AB-3 — a dead click names WHICH of the three lages it hit', () => {
    it( 'lage "absent": the entry belongs to this panel and the target is simply gone', () => {
        const app = boot()
        const verdict = app.call( 'tocClickVerdict', {
            targetFound: false, reachable: false, entryPanel: 'Prosa', activePanel: 'Prosa'
        } )

        expect( verdict.lage ).toBe( 'absent' )
        expect( verdict.message ).toBe( 'Ziel nicht im aktuellen Inhalt' )
    } )


    it( 'lage "foreign": the entry was built for another panel, and the message NAMES that panel', () => {
        const app = boot()
        const verdict = app.call( 'tocClickVerdict', {
            targetFound: false, reachable: false, entryPanel: 'Prosa', activePanel: 'Graph'
        } )

        expect( verdict.lage ).toBe( 'foreign' )
        expect( verdict.message ).toBe( 'Ziel gehört zu Prosa' )
    } )


    it( 'lage "blocked": the target exists but cannot be reached, and the message gives the reason', () => {
        const app = boot()
        const verdict = app.call( 'tocClickVerdict', {
            targetFound: true, reachable: false, entryPanel: 'Prosa', activePanel: 'Prosa'
        } )

        expect( verdict.lage ).toBe( 'blocked' )
        expect( verdict.message ).toBe( 'Ziel nicht erreichbar: im aktuellen Inhalt verborgen' )
        expect( app.call( 'tocClickVerdict', {
            targetFound: true, reachable: false, entryPanel: 'Prosa', activePanel: 'Prosa', blockedReason: 'in einer zugeklappten Falte'
        } ).message ).toBe( 'Ziel nicht erreichbar: in einer zugeklappten Falte' )
    } )


    it( 'AB-3: the three messages are PAIRWISE different — a collected "nicht gefunden" would hide exactly the difference that helps', () => {
        const app = boot()
        const cases = [
            { targetFound: false, reachable: false, entryPanel: 'Prosa', activePanel: 'Prosa' },
            { targetFound: false, reachable: false, entryPanel: 'Prosa', activePanel: 'Graph' },
            { targetFound: true, reachable: false, entryPanel: 'Prosa', activePanel: 'Prosa' }
        ]
        const messages = cases.map( ( payload ) => app.call( 'tocClickVerdict', payload ).message )

        expect( messages.length ).toBe( 3 )
        expect( new Set( messages ).size ).toBe( 3 )
        expect( messages.every( ( text ) => text.length > 0 ) ).toBe( true )
    } )


    it( 'AB-5: the green path carries NO message — a version that comments every click is worth nothing', () => {
        const app = boot()
        const verdict = app.call( 'tocClickVerdict', {
            targetFound: true, reachable: true, entryPanel: 'Prosa', activePanel: 'Prosa'
        } )

        expect( verdict.lage ).toBe( 'resolved' )
        expect( verdict.message ).toBe( '' )
    } )
} )


// ---- S1: the sitemap follows the panel -----------------------------------------------------------
describe( 'S5 / AB-1 — the sitemap follows whatever owns #content', () => {
    it( 'prose first: the entries are built, stamped with their panel and in force (compared 2 headings)', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        addHeading( app, 'h2', 'Kapitel B', 'kapitel-b' )
        app.call( 'buildTOC', null )

        expect( app.tocListEl.children.length ).toBe( 2 )
        expect( app.tocListEl.children.map( ( li ) => li.getAttribute( 'data-toc-panel' ) ) ).toEqual( [ 'Prosa', 'Prosa' ] )
        expect( app.tocSidebarEl.classList.contains( 'toc-not-applicable' ) ).toBe( false )
        expect( app.tocNoteEl.classList.contains( 't-hidden' ) ).toBe( true )
    } )


    it( 'a panel WITHOUT an outline greys the sitemap out and SAYS which panel it does not apply to', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        app.call( 'buildTOC', null )
        const before = app.tocListEl.children.length

        // the Graph panel replaces #content with div/svg content — no headings at all
        app.contentEl.children = []
        const state = app.call( 'syncTOCToContent', app.contentEl, 'Graph' )

        expect( before ).toBe( 1 )
        expect( state.synced ).toBe( true )
        expect( app.panel() ).toBe( 'Graph' )
        expect( app.tocSidebarEl.classList.contains( 'toc-not-applicable' ) ).toBe( true )
        expect( app.tocNoteEl.classList.contains( 't-hidden' ) ).toBe( false )
        expect( app.tocNoteEl.textContent ).toBe( 'Diese Gliederung gilt nicht für: Graph' )
    } )


    it( 'a panel WITH an outline gets its OWN entries — nothing is invented, the panel headings are indexed', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        app.call( 'buildTOC', null )

        app.contentEl.children = []
        addHeading( app, 'h2', 'Rohtabellen', 'rohtabellen' )
        const state = app.call( 'syncTOCToContent', app.contentEl, 'Rohtabellen' )

        expect( state.entries ).toBe( 1 )
        expect( app.tocListEl.children.length ).toBe( 1 )
        expect( app.tocListEl.children[ 0 ].textContent ).toBe( 'Rohtabellen' )
        expect( app.tocListEl.children[ 0 ].getAttribute( 'data-toc-panel' ) ).toBe( 'Rohtabellen' )
        expect( app.tocSidebarEl.classList.contains( 'toc-not-applicable' ) ).toBe( false )
        expect( app.tocNoteEl.classList.contains( 't-hidden' ) ).toBe( true )
    } )


    it( 'AB-4: the research path is the SECOND, different break and is covered too (compared 1 document)', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        app.call( 'buildTOC', null )

        // openResearchDoc renders a whole other document into #content
        app.contentEl.children = []
        addHeading( app, 'h2', 'Befund', 'befund' )
        addHeading( app, 'h3', 'Methode', 'methode' )
        const state = app.call( 'syncTOCToContent', app.contentEl, 'Research-Dokument' )

        expect( state.entries ).toBe( 2 )
        expect( app.tocListEl.children.map( ( li ) => li.textContent ) ).toEqual( [ 'Befund', 'Methode' ] )
        expect( app.tocListEl.children.every( ( li ) => li.getAttribute( 'data-toc-panel' ) === 'Research-Dokument' ) ).toBe( true )
    } )


    it( 'a renderer reused for a target other than #content is a NO-OP here, not a wrong rebuild', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        app.call( 'buildTOC', null )
        const foreign = makeElement( 'div' )
        const state = app.call( 'syncTOCToContent', foreign, 'Irgendwas' )

        expect( state.synced ).toBe( false )
        expect( app.panel() ).toBe( 'Prosa' )
        expect( app.tocListEl.children.length ).toBe( 1 )
    } )
} )


// ---- The whole click path, end to end ------------------------------------------------------------
describe( 'S5 / AB-2 + AB-8 — the click path: visible, and it never navigates', () => {
    it( 'a live click jumps and stays SILENT (compared 1 entry)', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        app.call( 'buildTOC', null )
        const verdict = app.call( 'handleTOCEntryClick', app.tocListEl.children[ 0 ] )

        expect( verdict.lage ).toBe( 'resolved' )
        expect( app.scrolls.length ).toBe( 1 )
        expect( app.tocNoteEl.classList.contains( 't-hidden' ) ).toBe( true )
        expect( app.tocNoteEl.textContent ).toBe( '' )
    } )


    it( 'AB-2: a dead click puts a VISIBLE message in the DOM and does NOT scroll (compared 1 entry)', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        app.call( 'buildTOC', null )

        // the panel switch takes the heading away; the entry survives, out of force
        delete app.registry[ 'kapitel-a' ]
        app.contentEl.children = []
        app.call( 'syncTOCToContent', app.contentEl, 'Graph' )

        const entry = app.tocListEl.children[ 0 ]
        const verdict = app.call( 'handleTOCEntryClick', entry )

        expect( app.tocListEl.children.length ).toBe( 1 )
        expect( verdict.lage ).toBe( 'foreign' )
        expect( app.tocNoteEl.classList.contains( 't-hidden' ) ).toBe( false )
        expect( app.tocNoteEl.textContent ).toBe( 'Ziel gehört zu Prosa' )
        expect( app.scrolls.length ).toBe( 0 )
    } )


    it( 'AB-8: the click SAYS where the target lives — it does not switch the panel unasked', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        app.call( 'buildTOC', null )
        delete app.registry[ 'kapitel-a' ]
        app.contentEl.children = []
        app.call( 'syncTOCToContent', app.contentEl, 'Graph' )

        const panelBefore = app.panel()
        const entriesBefore = app.tocListEl.children.length
        app.call( 'handleTOCEntryClick', app.tocListEl.children[ 0 ] )

        expect( app.panel() ).toBe( panelBefore )
        expect( app.tocListEl.children.length ).toBe( entriesBefore )
        expect( app.scrolls.length ).toBe( 0 )
        // the source carries the same promise: the click path calls nothing that changes the view
        const handler = clientSource.slice(
            clientSource.indexOf( 'function handleTOCEntryClick( entry )' ),
            clientSource.indexOf( 'function buildTOC(' )
        )
        expect( handler.length ).toBeGreaterThan( 0 )
        expect( [ 'setMode(', 'applyMode(', 'loadGraphView(', 'loadBlockView(', 'loadRequirementsView(', 'selectRevision(' ]
            .filter( ( call ) => handler.includes( call ) ) ).toEqual( [] )
    } )


    it( 'a target that is present but not reachable is its own lage, not silence (compared 1 entry)', () => {
        const app = boot()
        const heading = addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        app.call( 'buildTOC', null )
        heading._rects = 0

        const verdict = app.call( 'handleTOCEntryClick', app.tocListEl.children[ 0 ] )

        expect( verdict.lage ).toBe( 'blocked' )
        expect( app.tocNoteEl.textContent ).toBe( 'Ziel nicht erreichbar: im aktuellen Inhalt verborgen' )
        expect( app.scrolls.length ).toBe( 0 )
    } )


    it( 'the wired click listener uses the SAME path as a direct call (both entry kinds, compared 2)', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        const extra = makeElement( 'div' )
        app.registry[ 'offene-fragen' ] = extra
        app.call( 'buildTOC', null )

        expect( app.tocListEl.children.length ).toBe( 2 )
        expect( app.tocListEl.children.map( ( li ) => li.getAttribute( 'data-toc-panel' ) ) ).toEqual( [ 'Prosa', 'Prosa' ] )
        expect( app.tocListEl.children.every( ( li ) => ( li._listeners.click || [] ).length === 1 ) ).toBe( true )

        delete app.registry[ 'offene-fragen' ]
        app.tocListEl.children[ 1 ].click()

        expect( app.tocNoteEl.textContent ).toBe( 'Ziel nicht im aktuellen Inhalt' )
    } )
} )


// ---- The vacuum case ------------------------------------------------------------------------------
describe( 'S5 / D6 — zero entries is a FINDING, never a quiet pass', () => {
    it( 'the consistency check over 0 TOC entries reports RED (compared 0 entries, and that is the point)', () => {
        const app = boot()
        const state = app.call( 'syncTOCToContent', app.contentEl, 'Leeres Panel' )

        expect( state.entries ).toBe( 0 )
        expect( app.tocSidebarEl.classList.contains( 'toc-not-applicable' ) ).toBe( true )
        expect( app.tocNoteEl.classList.contains( 't-hidden' ) ).toBe( false )
        expect( app.tocNoteEl.textContent ).toBe( 'Diese Gliederung gilt nicht für: Leeres Panel' )
    } )


    it( 'and the positive control: the SAME check over a non-empty outline reports green (compared 1 entry)', () => {
        const app = boot()
        addHeading( app, 'h2', 'Kapitel A', 'kapitel-a' )
        const state = app.call( 'syncTOCToContent', app.contentEl, 'Prosa' )

        expect( state.entries ).toBe( 1 )
        expect( app.tocSidebarEl.classList.contains( 'toc-not-applicable' ) ).toBe( false )
        expect( app.tocNoteEl.classList.contains( 't-hidden' ) ).toBe( true )
    } )


    it( 'buildTOC over content whose only headings are collapsed lands in the SAME red, not in a green blank', () => {
        const app = boot()
        const heading = addHeading( app, 'h2', 'Gefaltet', 'gefaltet' )
        heading._closest = '.chapter-section'
        app.call( 'buildTOC', null, 'Prosa' )

        expect( app.tocListEl.children.length ).toBe( 0 )
        expect( app.tocSidebarEl.classList.contains( 'toc-not-applicable' ) ).toBe( true )
        expect( app.tocNoteEl.textContent ).toBe( 'Diese Gliederung gilt nicht für: Prosa' )
    } )
} )


// ---- Coupling completeness, at the source ---------------------------------------------------------
describe( 'S5 / AB-1 — EVERY path that replaces #content is coupled (source shape)', () => {
    const bodyOf = ( name ) => {
        const start = clientSource.indexOf( 'function ' + name + '(' )
        if( start === -1 ) { return '' }
        const rest = clientSource.slice( start + 1 )
        const next = rest.indexOf( '\n        function ' )
        const nextAsync = rest.indexOf( '\n        async function ' )
        const bounds = [ next, nextAsync ].filter( ( index ) => index !== -1 )

        return rest.slice( 0, bounds.length === 0 ? rest.length : Math.min( ...bounds ) )
    }


    it( 'every named #content writer carries a coupling call (comparison set stated with its count)', () => {
        expect( CONTENT_WRITERS.length ).toBe( 13 )
        const found = CONTENT_WRITERS.filter( ( name ) => bodyOf( name ).length > 0 )
        expect( found ).toEqual( CONTENT_WRITERS )

        const uncoupled = CONTENT_WRITERS
            .filter( ( name ) => {
                const body = bodyOf( name )

                return body.includes( 'syncTOCToContent(' ) === false && body.includes( 'buildTOC(' ) === false
            } )

        expect( uncoupled ).toEqual( [] )
    } )


    it( 'negative control: a function that does NOT own #content carries no coupling call', () => {
        const body = bodyOf( NON_WRITER )

        expect( body.length ).toBeGreaterThan( 0 )
        expect( body.includes( 'syncTOCToContent(' ) ).toBe( false )
    } )


    it( 'the entry click no longer swallows a missing target — both entry kinds route to ONE handler', () => {
        const slice = clientSource.slice(
            clientSource.indexOf( 'function buildTOC(' ),
            clientSource.indexOf( 'function updateActiveTOC(' )
        )
        const routed = slice.split( 'handleTOCEntryClick( this )' ).length - 1

        expect( routed ).toBe( 2 )
        // the old swallowing shape is gone from that slice
        expect( slice.includes( 'window.scrollTo( { top: top, behavior:' ) ).toBe( false )
        expect( slice ).toContain( 'setTOCInForce( tocListEl.children.length > 0 )' )
    } )


    it( 'the three prose call sites keep their one-argument shape, so the panel rides as the default', () => {
        expect( clientSource.split( 'buildTOC( currentDiff )' ).length - 1 ).toBe( 3 )
        expect( clientSource ).toContain( 'function buildTOC( diffData, panelLabel )' )
    } )
} )


// ---- The surface the message needs ----------------------------------------------------------------
describe( 'S5 — the status line exists in the markup and has a named style', () => {
    it( 'the sitemap carries a live status element inside its own nav', () => {
        expect( markup ).toContain( '<div id="toc-note" class="toc-note t-hidden" role="status" aria-live="polite"></div>' )
        expect( markup.indexOf( 'id="toc-note"' ) ).toBeGreaterThan( markup.indexOf( 'id="toc-sidebar"' ) )
        expect( markup.indexOf( 'id="toc-note"' ) ).toBeLessThan( markup.indexOf( 'id="toc-list"' ) )
    } )


    it( 'the two named selectors exist — the note and the greyed-out, out-of-force entries', () => {
        expect( cssSource ).toContain( '.toc-note {' )
        expect( cssSource ).toContain( '#toc-sidebar.toc-not-applicable li {' )
    } )
} )
