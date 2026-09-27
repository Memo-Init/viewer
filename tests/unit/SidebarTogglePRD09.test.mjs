import { describe, it, expect, beforeAll } from '@jest/globals'
import vm from 'node:vm'

import { extractFunctionSources, sliceDeclaration, readEmittedScript, readMemoViewStyles, readMemoViewSource } from '../helpers/extractFunction.mjs'


// PRD-09 (Memo 082 Kap 20b, WI-123) — the collapsible sidebars, Xcode pattern.
//
// WHY THIS FILE DOES NOT CHECK FOR PRESENCE. A case that asserts a class or an attribute EXISTS is
// green over any nonsense — the class can be set on the wrong element, set on both sides at once, or
// never removed again. Every case here measures a STATE and a TRANSITION: the state after a toggle,
// the state after toggling back, and the state of the side that was NOT touched.
//
// The widths themselves are not measurable without a browser (this repo has no jsdom), so they are
// measured in .browser/scripts/p9-sidebar-toggle.mjs against a running server and reported in
// BEFUND-prd-09.md. What IS decidable here is the state machine behind them, the fact that the
// stylesheet binds that state to the two named panels, and — the one the cut table of Kap 20b
// demands — that the state has no path to the server or the database.
//
// Every case states HOW MUCH it compared. A case that compared nothing is a failure, never a pass.
const FEATURE_FUNCTIONS = [
    'parseSidebarState',
    'nextSidebarState',
    'sidebarToggleIcon',
    'readSidebarState',
    'writeSidebarState',
    'applySidebarState',
    'toggleSidebar',
    'buildSidebarToggles'
]

const STATE_KEY = 'memoViewSidebarCollapsed'

const report = ( { label, counts } ) => console.log( `      [PRD-09] ${ label }: ${ counts }` )


let clientScript = ''
let styles = ''
let markup = ''
let featureSource = ''
let sandboxSource = ''


beforeAll( async () => {
    clientScript = await readEmittedScript()
    styles = await readMemoViewStyles()
    markup = await readMemoViewSource()

    const lifted = await extractFunctionSources( FEATURE_FUNCTIONS )
    featureSource = lifted[ 'source' ]

    // The real declarations are lifted ALONGSIDE the functions, never retyped: a hand-written copy of
    // SIDEBAR_PANELS would keep this file green exactly when the production list changes.
    sandboxSource = [
        sliceDeclaration( clientScript, 'SIDEBAR_DEFAULT_STATE' ),
        sliceDeclaration( clientScript, 'SIDEBAR_PANELS' ),
        `var SIDEBAR_STATE_KEY = '${ STATE_KEY }'`,
        featureSource
    ].join( '\n\n' )
} )


// A DOM small enough to be obviously correct and big enough to answer the only question asked of it:
// which classes ended up on #layout, and which attributes on the two buttons.
const makeElement = ( id ) => {
    const element = { id, 'classes': new Set(), 'attributes': {}, 'html': '' }
    element.classList = {
        'toggle': ( name, on ) => {
            if( on === true ) { element.classes.add( name ) } else { element.classes.delete( name ) }
        },
        'contains': ( name ) => element.classes.has( name )
    }
    element.setAttribute = ( name, value ) => { element.attributes[ name ] = value }
    element.getAttribute = ( name ) => ( Object.prototype.hasOwnProperty.call( element.attributes, name ) ? element.attributes[ name ] : null )

    return element
}


const makeSandbox = ( { ids, stored } ) => {
    const store = ids.reduce( ( acc, id ) => Object.assign( acc, { [ id ]: makeElement( id ) } ), {} )
    const storage = { 'value': typeof stored === 'string' ? stored : null, 'writes': [] }

    const context = {
        'document': { 'getElementById': ( id ) => ( Object.prototype.hasOwnProperty.call( store, id ) ? store[ id ] : null ) },
        'sessionStorage': {
            'getItem': ( key ) => ( key === STATE_KEY ? storage[ 'value' ] : null ),
            'setItem': ( key, value ) => {
                storage[ 'writes' ].push( { key, value } )
                if( key === STATE_KEY ) { storage[ 'value' ] = value }
            }
        },
        'JSON': JSON,
        'console': console
    }

    return { store, storage, context }
}


const load = ( { sandbox } ) => {
    const exported = `( { ${ FEATURE_FUNCTIONS.join( ', ' ) } } )`

    return vm.runInNewContext( `${ sandboxSource }\n\n${ exported }`, sandbox[ 'context' ] )
}


describe( 'M082-09-09 — Seitenleisten ein- und ausblendbar (Xcode-Muster)', () => {

    // ── AB-6 / D7: the starting state of a new session is NAMED, not inferred from an absence. ──────
    describe( 'Ausgangszustand einer neuen Sitzung', () => {
        it( 'the starting state is declared under its own name, not left implicit', () => {
            const declaration = sliceDeclaration( clientScript, 'SIDEBAR_DEFAULT_STATE' )
            report( { 'label': 'declared starting state', 'counts': declaration.replace( /\s+/g, ' ' ) } )

            expect( declaration.includes( 'left: false' ) ).toBe( true )
            expect( declaration.includes( 'right: false' ) ).toBe( true )
        } )

        it( 'a session with nothing stored opens with BOTH sidebars visible', () => {
            const sandbox = makeSandbox( { 'ids': [], 'stored': null } )
            const api = load( { sandbox } )

            // Comparison set stated with a number: three unreadable inputs plus the empty one.
            const inputs = [ null, '', 'not json', '{"left":' ]
            const results = inputs.map( ( raw ) => api.parseSidebarState( raw ) )
            report( { 'label': 'unreadable inputs compared', 'counts': `${ results.length }` } )

            expect( results.length ).toBe( 4 )
            results.forEach( ( state ) => {
                expect( state.left ).toBe( false )
                expect( state.right ).toBe( false )
            } )
        } )

        it( 'a stored state IS read back — the default is a default, not a constant answer', () => {
            const sandbox = makeSandbox( { 'ids': [], 'stored': JSON.stringify( { 'left': true, 'right': false } ) } )
            const api = load( { sandbox } )
            const state = api.readSidebarState()

            // B8: a build that always answers "both visible" would pass the case above. This one
            // separates "correctly defaulting" from "broken and always defaulting".
            expect( state.left ).toBe( true )
            expect( state.right ).toBe( false )
        } )
    } )


    // ── D7: the state change per side, in BOTH directions. Three readings, not two. ────────────────
    describe( 'Zustandswechsel je Seite, beide Richtungen', () => {
        const sides = [ 'left', 'right' ]

        sides.forEach( ( side ) => {
            it( `${ side }: collapse and the SAME button back lands on the starting state`, () => {
                const sandbox = makeSandbox( { 'ids': [], 'stored': null } )
                const api = load( { sandbox } )

                const s0 = api.parseSidebarState( null )
                const s1 = api.nextSidebarState( s0, side )
                const s2 = api.nextSidebarState( s1, side )
                report( { 'label': `${ side } readings`, 'counts': `${ JSON.stringify( [ s0, s1, s2 ] ) }` } )

                expect( s0[ side ] ).toBe( false )
                expect( s1[ side ] ).toBe( true )
                expect( s2[ side ] ).toBe( false )
                expect( s2 ).toEqual( s0 )
            } )
        } )

        it( 'an unknown side moves nothing — a typo must not collapse something at random', () => {
            const sandbox = makeSandbox( { 'ids': [], 'stored': null } )
            const api = load( { sandbox } )
            const state = api.nextSidebarState( { 'left': true, 'right': false }, 'middle' )

            expect( state ).toEqual( { 'left': true, 'right': false } )
        } )
    } )


    // ── AB-3 / S1: the two sides are INDEPENDENT. ───────────────────────────────────────────────────
    describe( 'Unabhaengigkeit der beiden Seiten', () => {
        it( 'toggling one side never moves the other — all four combinations are reachable', () => {
            const sandbox = makeSandbox( { 'ids': [], 'stored': null } )
            const api = load( { sandbox } )

            const bothOpen = api.parseSidebarState( null )
            const leftClosed = api.nextSidebarState( bothOpen, 'left' )
            const bothClosed = api.nextSidebarState( leftClosed, 'right' )
            const rightClosed = api.nextSidebarState( bothClosed, 'left' )

            const table = [ bothOpen, leftClosed, rightClosed, bothClosed ]
            const distinct = new Set( table.map( ( state ) => `${ state.left }|${ state.right }` ) )
            report( { 'label': 'combinations compared', 'counts': `${ table.length }, distinct ${ distinct.size }` } )

            expect( table.length ).toBe( 4 )
            expect( distinct.size ).toBe( 4 )
            // The named claim, per combination — a distinct-count alone would not say WHICH four.
            expect( leftClosed ).toEqual( { 'left': true, 'right': false } )
            expect( rightClosed ).toEqual( { 'left': false, 'right': true } )
            expect( bothClosed ).toEqual( { 'left': true, 'right': true } )
        } )

        it( 'the untouched side keeps its value through a toggle of the other one', () => {
            const sandbox = makeSandbox( { 'ids': [], 'stored': null } )
            const api = load( { sandbox } )

            const cases = [
                { 'from': { 'left': false, 'right': true }, 'side': 'left', 'untouched': 'right' },
                { 'from': { 'left': true, 'right': false }, 'side': 'right', 'untouched': 'left' },
                { 'from': { 'left': true, 'right': true }, 'side': 'left', 'untouched': 'right' },
                { 'from': { 'left': true, 'right': true }, 'side': 'right', 'untouched': 'left' }
            ]
            report( { 'label': 'untouched-side cases compared', 'counts': `${ cases.length }` } )

            expect( cases.length ).toBeGreaterThan( 0 )
            cases.forEach( ( entry ) => {
                const after = api.nextSidebarState( entry[ 'from' ], entry[ 'side' ] )
                expect( after[ entry[ 'untouched' ] ] ).toBe( entry[ 'from' ][ entry[ 'untouched' ] ] )
                expect( after[ entry[ 'side' ] ] ).toBe( !entry[ 'from' ][ entry[ 'side' ] ] )
            } )
        } )
    } )


    // ── The state actually REACHES the layout, and only the side it belongs to. ─────────────────────
    describe( 'Der Zustand erreicht das Layout — und nur die gemeinte Seite', () => {
        const ids = [ 'layout', 'nav-bar', 'nav-brand', 'status', 'sidebar-toggle-left', 'sidebar-toggle-right' ]

        it( 'applying a one-sided state sets exactly ONE collapse class', () => {
            const sandbox = makeSandbox( { ids, 'stored': null } )
            const api = load( { sandbox } )

            api.applySidebarState( { 'left': true, 'right': false } )
            const layout = sandbox[ 'store' ][ 'layout' ]
            report( { 'label': 'classes on #layout', 'counts': `${ JSON.stringify( [ ...layout.classes ] ) }` } )

            expect( layout.classList.contains( 'sidebar-left-collapsed' ) ).toBe( true )
            expect( layout.classList.contains( 'sidebar-right-collapsed' ) ).toBe( false )
        } )

        it( 'applying the starting state removes BOTH classes again', () => {
            const sandbox = makeSandbox( { ids, 'stored': null } )
            const api = load( { sandbox } )

            api.applySidebarState( { 'left': true, 'right': true } )
            api.applySidebarState( { 'left': false, 'right': false } )
            const layout = sandbox[ 'store' ][ 'layout' ]

            expect( [ ...layout.classes ] ).toEqual( [] )
        } )

        it( 'the control reports its own state — aria-expanded follows the collapse', () => {
            const sandbox = makeSandbox( { ids, 'stored': null } )
            const api = load( { sandbox } )

            api.applySidebarState( { 'left': true, 'right': false } )
            const left = sandbox[ 'store' ][ 'sidebar-toggle-left' ]
            const right = sandbox[ 'store' ][ 'sidebar-toggle-right' ]

            expect( left.getAttribute( 'aria-expanded' ) ).toBe( 'false' )
            expect( right.getAttribute( 'aria-expanded' ) ).toBe( 'true' )
            // S3: the way back names itself. A collapsed side whose button still says "ausblenden"
            // would be a control pointing at the direction it cannot go.
            expect( left.getAttribute( 'title' ) ).toBe( 'Linke Seitenleiste einblenden' )
            expect( right.getAttribute( 'title' ) ).toBe( 'Rechte Seitenleiste ausblenden' )
        } )

        it( 'toggleSidebar persists and applies in one step, and the second call returns', () => {
            const sandbox = makeSandbox( { ids, 'stored': null } )
            const api = load( { sandbox } )
            const layout = sandbox[ 'store' ][ 'layout' ]

            const first = api.toggleSidebar( 'left' )
            const afterFirst = [ ...layout.classes ]
            const second = api.toggleSidebar( 'left' )
            const afterSecond = [ ...layout.classes ]
            report( { 'label': 'layout classes after 1st / 2nd click', 'counts': `${ JSON.stringify( afterFirst ) } / ${ JSON.stringify( afterSecond ) }` } )

            expect( first ).toEqual( { 'left': true, 'right': false } )
            expect( afterFirst ).toEqual( [ 'sidebar-left-collapsed' ] )
            expect( second ).toEqual( { 'left': false, 'right': false } )
            expect( afterSecond ).toEqual( [] )
            // Both clicks were persisted — the second one too, otherwise a reload would reopen the
            // collapsed state the user just closed.
            expect( sandbox[ 'storage' ][ 'writes' ].length ).toBe( 2 )
        } )
    } )


    // ── AB-5: the write paths of the view state, counted, and none of them leaves the browser. ─────
    describe( 'AB-5 — kein Schreibweg in die Datenbank oder an den Server', () => {
        it( 'every reference to the state key is a sessionStorage access, and at least one WRITES', () => {
            const lines = featureSource
                .split( '\n' )
                .map( ( line, index ) => ( { 'index': index, 'text': line } ) )
                .filter( ( entry ) => entry[ 'text' ].includes( 'SIDEBAR_STATE_KEY' ) === true )

            const classified = lines.map( ( entry ) => {
                if( /sessionStorage\.setItem\(/.test( entry[ 'text' ] ) === true ) { return 'write:sessionStorage' }
                if( /sessionStorage\.getItem\(/.test( entry[ 'text' ] ) === true ) { return 'read:sessionStorage' }

                return `unclassified:${ entry[ 'text' ].trim() }`
            } )

            const writes = classified.filter( ( kind ) => kind === 'write:sessionStorage' )
            const unclassified = classified.filter( ( kind ) => kind.startsWith( 'unclassified' ) === true )
            report( { 'label': 'state-key paths', 'counts': `${ classified.length } total, ${ writes.length } write, ${ unclassified.length } unclassified` } )

            // B4: green over a null set is not green. A block that never touches the key at all would
            // otherwise pass every assertion below.
            expect( classified.length ).toBeGreaterThan( 0 )
            expect( writes.length ).toBeGreaterThan( 0 )
            expect( unclassified ).toEqual( [] )
        } )

        it( 'the feature carries no path to the server — neither fetch, socket, beacon nor an /api/ route', () => {
            const forbidden = [ 'fetch(', 'XMLHttpRequest', 'sendBeacon', '.send(', '/api/', 'localStorage' ]
            const hits = forbidden.filter( ( token ) => featureSource.includes( token ) === true )
            report( { 'label': 'server-path tokens scanned / found', 'counts': `${ forbidden.length } / ${ hits.length }` } )

            expect( forbidden.length ).toBeGreaterThan( 0 )
            expect( hits ).toEqual( [] )
        } )

        it( 'the run through toggleSidebar writes ONLY the state key, and only to sessionStorage', () => {
            const sandbox = makeSandbox( { 'ids': [ 'layout', 'sidebar-toggle-left', 'sidebar-toggle-right' ], 'stored': null } )
            const api = load( { sandbox } )

            api.toggleSidebar( 'left' )
            api.toggleSidebar( 'right' )
            const writes = sandbox[ 'storage' ][ 'writes' ]
            report( { 'label': 'writes observed', 'counts': `${ writes.length } -> ${ JSON.stringify( writes.map( ( entry ) => entry[ 'key' ] ) ) }` } )

            expect( writes.length ).toBe( 2 )
            writes.forEach( ( entry ) => expect( entry[ 'key' ] ).toBe( STATE_KEY ) )
            expect( JSON.parse( writes[ writes.length - 1 ][ 'value' ] ) ).toEqual( { 'left': true, 'right': true } )
        } )

        it( 'a browser that refuses storage still toggles — the view never depends on the store', () => {
            const sandbox = makeSandbox( { 'ids': [ 'layout' ], 'stored': null } )
            sandbox[ 'context' ][ 'sessionStorage' ] = {
                'getItem': () => { throw new Error( 'storage blocked' ) },
                'setItem': () => { throw new Error( 'storage blocked' ) }
            }
            const api = load( { sandbox } )
            const state = api.toggleSidebar( 'left' )

            expect( state ).toEqual( { 'left': true, 'right': false } )
            expect( sandbox[ 'store' ][ 'layout' ].classList.contains( 'sidebar-left-collapsed' ) ).toBe( true )
        } )
    } )


    // ── The stylesheet binds the state to the two NAMED panels (G2: per named selector, no totals). ─
    describe( 'app.css — die Bindung an die beiden benannten Bereiche', () => {
        const expected = [
            { 'class': 'sidebar-left-collapsed', 'panel': '#doc-sidebar' },
            { 'class': 'sidebar-right-collapsed', 'panel': '#toc-sidebar' }
        ]

        expected.forEach( ( entry ) => {
            it( `.${ entry[ 'class' ] } hides ${ entry[ 'panel' ] } and nothing else`, () => {
                const rule = new RegExp( `#layout\\.${ entry[ 'class' ] }\\s+${ entry[ 'panel' ] }\\s*\\{[^}]*display:\\s*none` )

                expect( rule.test( styles ) ).toBe( true )
            } )
        } )

        it( 'the collapse classes are scoped to #layout — never bare, never on the panel itself', () => {
            const bare = expected.filter( ( entry ) => new RegExp( `(^|[^.\\w])\\.${ entry[ 'class' ] }\\s*\\{` , 'm' ).test( styles ) === true )
            report( { 'label': 'collapse classes checked / unscoped', 'counts': `${ expected.length } / ${ bare.length }` } )

            expect( expected.length ).toBe( 2 )
            expect( bare ).toEqual( [] )
        } )

        it( 'the toggle control carries a visible box — padding and a border, not a bare glyph', () => {
            const block = styles.slice( styles.indexOf( '.sidebar-toggle {' ) )
            const rule = block.slice( 0, block.indexOf( '}' ) )
            report( { 'label': '.sidebar-toggle declarations', 'counts': `${ rule.split( ';' ).filter( ( part ) => part.trim().length > 0 ).length }` } )

            expect( styles.includes( '.sidebar-toggle {' ) ).toBe( true )
            expect( /padding:\s*\d/.test( rule ) ).toBe( true )
            expect( /border:\s*1px/.test( rule ) ).toBe( true )
            expect( styles.includes( '.sidebar-toggle[aria-expanded="false"]' ) ).toBe( true )
        } )
    } )


    // ── The two panels the descriptors point at are the ones the page actually renders. ────────────
    describe( 'Die Bereiche, auf die die Knoepfe zeigen, gibt es wirklich', () => {
        it( 'every descriptor names a panel and an anchor that exist in the served markup', () => {
            const declaration = sliceDeclaration( clientScript, 'SIDEBAR_PANELS' )
            const panelIds = ( declaration.match( /panelId:\s*'([^']+)'/g ) || [] ).map( ( part ) => part.split( "'" )[ 1 ] )
            const anchorIds = ( declaration.match( /anchorId:\s*'([^']+)'/g ) || [] ).map( ( part ) => part.split( "'" )[ 1 ] )
            report( { 'label': 'panels / anchors checked against markup', 'counts': `${ panelIds.length } / ${ anchorIds.length }` } )

            // B3a: a comparison set that does not contain the subject is green by construction.
            expect( panelIds.length ).toBe( 2 )
            expect( anchorIds.length ).toBe( 2 )
            panelIds.forEach( ( id ) => expect( markup.includes( `id="${ id }"` ) ).toBe( true ) )
            anchorIds.forEach( ( id ) => expect( markup.includes( `id="${ id }"` ) ).toBe( true ) )
        } )

        it( 'the built control points at its panel via aria-controls', () => {
            const sandbox = makeSandbox( { 'ids': [ 'layout', 'nav-bar', 'nav-brand', 'status' ], 'stored': null } )
            const store = sandbox[ 'store' ]

            // insertAdjacentElement is the only DOM verb buildSidebarToggles needs beyond the stub.
            const inserted = []
            const attach = ( element ) => {
                element.insertAdjacentElement = ( place, node ) => { inserted.push( { place, node } ) }

                return element
            }
            attach( store[ 'nav-brand' ] )
            attach( store[ 'status' ] )
            sandbox[ 'context' ][ 'document' ][ 'createElement' ] = () => {
                const node = makeElement( '' )
                node.addEventListener = () => {}

                return node
            }

            const api = load( { sandbox } )
            const built = api.buildSidebarToggles()
            report( { 'label': 'controls built', 'counts': `${ built }, inserted ${ inserted.length }` } )

            expect( built ).toBe( 2 )
            expect( inserted.length ).toBe( 2 )
            expect( inserted.map( ( entry ) => entry[ 'node' ].getAttribute( 'aria-controls' ) ) ).toEqual( [ 'doc-sidebar', 'toc-sidebar' ] )
            expect( inserted.map( ( entry ) => entry[ 'place' ] ) ).toEqual( [ 'afterend', 'beforebegin' ] )
            // AB-7 on the markup side: the control starts out expanded and carries a name a screen
            // reader can announce. Its measured BOX is proven in the Playwright run, not here.
            inserted.forEach( ( entry ) => {
                expect( entry[ 'node' ].getAttribute( 'aria-expanded' ) ).toBe( 'true' )
                expect( typeof entry[ 'node' ].getAttribute( 'aria-label' ) ).toBe( 'string' )
            } )
        } )

        it( 'the icon differs per side — the two controls are told apart by shape, not only by place', () => {
            const sandbox = makeSandbox( { 'ids': [], 'stored': null } )
            const api = load( { sandbox } )
            const left = api.sidebarToggleIcon( 'left' )
            const right = api.sidebarToggleIcon( 'right' )
            report( { 'label': 'icon lengths left / right', 'counts': `${ left.length } / ${ right.length }` } )

            expect( left.length ).toBeGreaterThan( 0 )
            expect( right.length ).toBeGreaterThan( 0 )
            expect( left ).not.toBe( right )
            expect( left.includes( 'aria-hidden="true"' ) ).toBe( true )
            expect( right.includes( 'aria-hidden="true"' ) ).toBe( true )
        } )
    } )
} )
