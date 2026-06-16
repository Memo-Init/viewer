import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'

import { MemoView } from '../../src/MemoView.mjs'
import { RequirementsStore } from '../../src/RequirementsStore.mjs'
import { extractFunctions } from '../helpers/extractFunction.mjs'


// PRD-005 (Memo 016 Kap 4, B1-B5): the requirements view must (B1) explain WHY it is empty,
// (B2) tell a MISSING eval set apart from one that resolves to zero, (B3) resolve the block
// `requirements+`/`requirements` names, (B4) render the unresolved set ids ("Nicht aufgeloest"),
// and (B5) make the `req-*` vs `REQ-NNN` namespace mismatch a visible warning. Pure decision logic
// is mirrored into static MemoView.* methods + the inline browser helpers; this file unit-tests the
// static mirrors, drives the render against a tiny DOM shim, asserts the RequirementsStore changes
// directly, and keeps a source-shape regression so the inline browser mirror cannot silently drift.


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


// ============================================================================================
// 1. MemoView.requirementsEmptyState (B1/B2) — pure empty-state decision + reason copy.
// ============================================================================================
describe( 'MemoView.requirementsEmptyState (PRD-005, B1/B2)', () => {
    it( 'B1: a missing eval set yields kind "no-set" with an explanatory reason (not empty copy)', () => {
        const result = MemoView.requirementsEmptyState( { count: 0, setPresent: false, missingCount: 0 } )

        expect( result.empty ).toBe( true )
        expect( result.kind ).toBe( 'no-set' )
        expect( result.reason.length ).toBeGreaterThan( 0 )
        expect( result.reason ).toContain( '0 aufgeloest' )
    } )


    it( 'B2: a PRESENT but empty set is distinguishable from a missing one (kind "empty-set")', () => {
        const missing = MemoView.requirementsEmptyState( { count: 0, setPresent: false, missingCount: 0 } )
        const emptyPresent = MemoView.requirementsEmptyState( { count: 0, setPresent: true, missingCount: 0 } )

        expect( emptyPresent.empty ).toBe( true )
        expect( emptyPresent.kind ).toBe( 'empty-set' )
        // The two empty cases MUST NOT be indistinguishable (the whole point of B2).
        expect( emptyPresent.kind ).not.toBe( missing.kind )
        expect( emptyPresent.reason ).not.toBe( missing.reason )
    } )


    it( 'B2: a present set with unresolved ids weaves the missing count into the reason', () => {
        const result = MemoView.requirementsEmptyState( { count: 0, setPresent: true, missingCount: 3 } )

        expect( result.kind ).toBe( 'empty-set' )
        expect( result.reason ).toContain( '3' )
    } )


    it( 'resolved requirements produce no empty-state (empty=false)', () => {
        const result = MemoView.requirementsEmptyState( { count: 2, setPresent: true, missingCount: 0 } )

        expect( result.empty ).toBe( false )
        expect( result.kind ).toBe( 'resolved' )
        expect( result.reason ).toBe( '' )
    } )


    it( 'guards non-numeric count/missingCount to zero', () => {
        const result = MemoView.requirementsEmptyState( { count: undefined, setPresent: false, missingCount: null } )

        expect( result.empty ).toBe( true )
        expect( result.kind ).toBe( 'no-set' )
    } )
} )


// ============================================================================================
// 2. MemoView.resolveBlockRequirements (B3/B5) — block `req-*` names vs store `REQ-NNN` ids.
// ============================================================================================
describe( 'MemoView.resolveBlockRequirements (PRD-005, B3/B5)', () => {
    it( 'B5: a req-* block name with no store entry is reported as a namespace mismatch', () => {
        const result = MemoView.resolveBlockRequirements( {
            blockRequirementNames: [ 'req-secrets', 'req-coverage' ],
            knownIds: [ 'REQ-001', 'REQ-002' ]
        } )

        expect( result.unresolved ).toEqual( [ 'req-secrets', 'req-coverage' ] )
        expect( result.resolved ).toEqual( [] )
        expect( result.hasNamespaceMismatch ).toBe( true )
    } )


    it( 'B3: a block name that normalizes onto a store id resolves (req-001 -> REQ-001)', () => {
        const result = MemoView.resolveBlockRequirements( {
            blockRequirementNames: [ 'req-001', 'req-secrets' ],
            knownIds: [ 'REQ-001', 'REQ-002' ]
        } )

        expect( result.resolved ).toEqual( [ 'REQ-001' ] )
        expect( result.unresolved ).toEqual( [ 'req-secrets' ] )
        expect( result.hasNamespaceMismatch ).toBe( true )
    } )


    it( 'no mismatch when every block name resolves', () => {
        const result = MemoView.resolveBlockRequirements( {
            blockRequirementNames: [ 'REQ-001', 'req-002' ],
            knownIds: [ 'REQ-001', 'REQ-002' ]
        } )

        expect( result.resolved.sort() ).toEqual( [ 'REQ-001', 'REQ-002' ] )
        expect( result.unresolved ).toEqual( [] )
        expect( result.hasNamespaceMismatch ).toBe( false )
    } )


    it( 'dedupes block names and ignores blanks', () => {
        const result = MemoView.resolveBlockRequirements( {
            blockRequirementNames: [ 'req-secrets', 'req-secrets', '', '  ' ],
            knownIds: [ 'REQ-001' ]
        } )

        expect( result.unresolved ).toEqual( [ 'req-secrets' ] )
    } )


    it( 'guards non-array inputs to an empty, no-mismatch result', () => {
        const result = MemoView.resolveBlockRequirements( { blockRequirementNames: undefined, knownIds: undefined } )

        expect( result.resolved ).toEqual( [] )
        expect( result.unresolved ).toEqual( [] )
        expect( result.hasNamespaceMismatch ).toBe( false )
    } )
} )


// ============================================================================================
// 3. RequirementsStore — setPresent threading (B2) + knownIds for the lint (B3/B5).
// ============================================================================================
describe( 'RequirementsStore setPresent / knownIds (PRD-005, B2/B3/B5)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let requirementsDir = ''

    const writeReq = async ( req ) => {
        await writeFile( join( requirementsDir, `${ req.id }.req.json` ), JSON.stringify( req ), 'utf8' )
    }

    const writeIndex = async ( ids ) => {
        const requirements = ids.map( ( id ) => {
            return { id, file: `${ id }.req.json` }
        } )

        await writeFile(
            join( requirementsDir, 'index.json' ),
            JSON.stringify( { generatedBy: 'test', count: ids.length, requirements } ),
            'utf8'
        )
    }

    const writeSet = async ( name, ids ) => {
        const set = { name, context: { repos: [], categories: [], tags: [] }, ids }
        await writeFile( join( requirementsDir, 'sets', `${ name }.set.json` ), JSON.stringify( set ), 'utf8' )
    }


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        requirementsDir = await mkdtemp( join( repoTmpRoot, 'req-' ) )
        await mkdir( join( requirementsDir, 'sets' ), { recursive: true } )
    } )

    afterEach( async () => {
        await rm( requirementsDir, { recursive: true, force: true } )
    } )


    it( 'B2: memoSet flags a MISSING set file with setPresent=false', async () => {
        const result = await RequirementsStore.memoSet( { requirementsDir, memoName: 'memo-999' } )

        expect( result.status ).toBe( 'missing' )
        expect( result.setPresent ).toBe( false )
    } )


    it( 'B2: memoSet flags a PRESENT (even empty) set file with setPresent=true', async () => {
        await writeSet( 'memo-016', [] )

        const result = await RequirementsStore.memoSet( { requirementsDir, memoName: 'memo-016' } )

        expect( result.status ).toBe( 'ok' )
        expect( result.setPresent ).toBe( true )
    } )


    it( 'B2: aggregate of a missing set => setPresent=false, count=0', async () => {
        await writeReq( { id: 'REQ-001', title: 'Alpha', statement: 'a', scope: { repos: [] } } )
        await writeIndex( [ 'REQ-001' ] )

        const view = await RequirementsStore.aggregate( { requirementsDir, memoName: 'memo-999' } )

        expect( view.setPresent ).toBe( false )
        expect( view.count ).toBe( 0 )
    } )


    it( 'B2: aggregate of a present-but-empty set => setPresent=true, count=0 (distinct from missing)', async () => {
        await writeReq( { id: 'REQ-001', title: 'Alpha', statement: 'a', scope: { repos: [] } } )
        await writeIndex( [ 'REQ-001' ] )
        await writeSet( 'memo-016', [] )

        const view = await RequirementsStore.aggregate( { requirementsDir, memoName: 'memo-016' } )

        expect( view.setPresent ).toBe( true )
        expect( view.count ).toBe( 0 )
    } )


    it( 'B3/B5: aggregate exposes knownIds (the full store id index) for the namespace lint', async () => {
        await writeReq( { id: 'REQ-001', title: 'Alpha', statement: 'a', scope: { repos: [] } } )
        await writeReq( { id: 'REQ-002', title: 'Beta', statement: 'b', scope: { repos: [] } } )
        await writeIndex( [ 'REQ-001', 'REQ-002' ] )
        await writeSet( 'memo-016', [ 'REQ-001' ] )

        const view = await RequirementsStore.aggregate( { requirementsDir, memoName: 'memo-016' } )

        expect( view.knownIds.sort() ).toEqual( [ 'REQ-001', 'REQ-002' ] )
    } )
} )


// ============================================================================================
// 4. Inline render: empty-state banner (B1/B2), missing section (B4), namespace warning (B5).
// ============================================================================================
describe( 'inline renderRequirementsView empty/resolve/namespace (PRD-005, B1/B2/B4/B5)', () => {
    let fns = null
    let savedDocument = null

    beforeAll( async () => {
        fns = await extractFunctions( [
            'requirementsEmptyState',
            'resolveBlockRequirements',
            'requirementsConsistency',
            'requirementSeverityClass',
            'requirementKindLabel',
            'buildEmptyState',
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


    it( 'B1/B2: an empty MISSING-set payload renders an explanatory empty-state (kind no-set)', () => {
        globalThis.document = makeDocument( {} )
        const container = makeElement( 'div' )

        const root = fns.renderRequirementsView( {
            memoName: 'memo-016',
            groups: [],
            aggregate: [],
            missingIds: [],
            setPresent: false,
            unresolvedBlockRequirements: []
        }, container )

        const empties = collectByAttr( root, 'data-req-empty-kind' )
        expect( empties.length ).toBe( 1 )
        expect( empties[ 0 ].getAttribute( 'data-req-empty-kind' ) ).toBe( 'no-set' )
    } )


    it( 'B2: a present-but-empty set renders kind empty-set (distinct from no-set)', () => {
        globalThis.document = makeDocument( {} )
        const container = makeElement( 'div' )

        const root = fns.renderRequirementsView( {
            memoName: 'memo-016',
            groups: [],
            aggregate: [],
            missingIds: [],
            setPresent: true,
            unresolvedBlockRequirements: []
        }, container )

        const empties = collectByAttr( root, 'data-req-empty-kind' )
        expect( empties.length ).toBe( 1 )
        expect( empties[ 0 ].getAttribute( 'data-req-empty-kind' ) ).toBe( 'empty-set' )
    } )


    it( 'a non-empty payload renders NO empty-state banner', () => {
        globalThis.document = makeDocument( { 'requirement-modal': makeElement( 'div' ) } )
        const container = makeElement( 'div' )

        const root = fns.renderRequirementsView( {
            memoName: 'memo-016',
            groups: [ { groupKey: 'viewer', requirements: [ { id: 'REQ-001', shortName: 'A' } ] } ],
            aggregate: [ { id: 'REQ-001', shortName: 'A' } ],
            missingIds: [],
            setPresent: true,
            unresolvedBlockRequirements: []
        }, container )

        expect( collectByAttr( root, 'data-req-empty-kind' ).length ).toBe( 0 )
    } )


    it( 'B4: missingIds are rendered in a "Nicht aufgeloest (N)" section', () => {
        globalThis.document = makeDocument( {} )
        const container = makeElement( 'div' )

        const root = fns.renderRequirementsView( {
            memoName: 'memo-016',
            groups: [],
            aggregate: [],
            missingIds: [ 'REQ-9001', 'REQ-9002' ],
            setPresent: true,
            unresolvedBlockRequirements: []
        }, container )

        const missing = collectByAttr( root, 'data-req-missing' )
        expect( missing.length ).toBe( 1 )
        expect( missing[ 0 ].getAttribute( 'data-req-missing' ) ).toBe( '2' )
        const ids = missing[ 0 ].children.map( ( c ) => c.textContent ).sort()
        expect( ids ).toEqual( [ 'REQ-9001', 'REQ-9002' ] )
    } )


    it( 'B5: unresolved block requirements render a visible namespace warning, not swallowed', () => {
        globalThis.document = makeDocument( {} )
        const container = makeElement( 'div' )

        const root = fns.renderRequirementsView( {
            memoName: 'memo-016',
            groups: [],
            aggregate: [],
            missingIds: [],
            setPresent: true,
            unresolvedBlockRequirements: [ 'req-secrets', 'req-coverage' ]
        }, container )

        const warnings = collectByAttr( root, 'data-req-namespace-warning' )
        expect( warnings.length ).toBe( 1 )
        expect( warnings[ 0 ].getAttribute( 'data-req-namespace-warning' ) ).toBe( '2' )
        expect( warnings[ 0 ].textContent ).toContain( 'req-secrets' )
        expect( warnings[ 0 ].textContent ).toContain( 'Namespace-Mismatch' )
    } )


    it( 'the inline requirementsEmptyState mirror matches the static MemoView decision', () => {
        const cases = [
            { count: 0, setPresent: false, missingCount: 0 },
            { count: 0, setPresent: true, missingCount: 0 },
            { count: 0, setPresent: true, missingCount: 2 },
            { count: 3, setPresent: true, missingCount: 0 }
        ]
        cases.forEach( ( c ) => {
            const inline = fns.requirementsEmptyState( c.count, c.setPresent, c.missingCount )
            const stat = MemoView.requirementsEmptyState( c )
            expect( inline.kind ).toBe( stat.kind )
            expect( inline.empty ).toBe( stat.empty )
            expect( inline.reason ).toBe( stat.reason )
        } )
    } )


    it( 'the inline resolveBlockRequirements mirror matches the static MemoView decision', () => {
        const inline = fns.resolveBlockRequirements( [ 'req-001', 'req-secrets' ], [ 'REQ-001', 'REQ-002' ] )
        const stat = MemoView.resolveBlockRequirements( {
            blockRequirementNames: [ 'req-001', 'req-secrets' ],
            knownIds: [ 'REQ-001', 'REQ-002' ]
        } )

        expect( inline.resolved ).toEqual( stat.resolved )
        expect( inline.unresolved ).toEqual( stat.unresolved )
        expect( inline.hasNamespaceMismatch ).toBe( stat.hasNamespaceMismatch )
    } )
} )


// ============================================================================================
// 5. Source-shape regression — the inline browser mirror + route wiring must not drift.
// ============================================================================================
describe( 'source-shape regression (PRD-005, B1-B5)', () => {
    // PRD-011 (Memo 016, F1/F2): the inline client <script> was extracted into app.client.mjs. The
    // route wiring (setPresent threading, #collectBlockRequirementNames, MemoView.resolveBlockRequirements)
    // STAYS in MemoView.mjs, but the inline render/lint fns now live in app.client.mjs — concat both so
    // every grep resolves.
    const mjsSource = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
    const clientSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )
    const source = mjsSource + '\n' + clientSource

    it( 'the emitted inline browser script stays syntactically valid', async () => {
        // The extracted app.client.mjs is already the runtime-emitted form — read it directly.
        const emitted = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )

        let message = ''
        try {
            new vm.Script( emitted )
        } catch( err ) {
            message = err.message
        }
        expect( message ).toBe( '' )
    } )


    it( 'B1/B2: the inline render branches on the empty-state verdict + sets data-req-empty-kind', () => {
        expect( source ).toContain( 'function requirementsEmptyState(' )
        expect( source ).toContain( 'data-req-empty-kind' )
        expect( source ).toContain( '0 aufgeloest' )
    } )


    it( 'B2: setPresent is threaded store -> route -> payload', () => {
        expect( source ).toContain( "'setPresent': view[ 'setPresent' ]" )
        expect( source ).toContain( 'setPresent' )
    } )


    it( 'B3: the route resolves block requirement names against the store', () => {
        expect( source ).toContain( '#collectBlockRequirementNames' )
        expect( source ).toContain( 'MemoView.resolveBlockRequirements' )
    } )


    it( 'B4: the inline render emits a "Nicht aufgeloest" section bound to data-req-missing', () => {
        expect( source ).toContain( 'Nicht aufgeloest (' )
        expect( source ).toContain( 'data-req-missing' )
    } )


    it( 'B5: the inline render emits a namespace warning bound to data-req-namespace-warning', () => {
        expect( source ).toContain( 'data-req-namespace-warning' )
        expect( source ).toContain( 'Namespace-Mismatch' )
        expect( source ).toContain( "'unresolvedBlockRequirements': lint[ 'unresolved' ]" )
    } )


    it( 'no for/while loops in the new render/lint functions (house style)', () => {
        const names = [ 'requirementsEmptyState', 'resolveBlockRequirements', 'renderRequirementsView' ]
        const slices = names
            .map( ( name ) => {
                const start = source.indexOf( 'function ' + name + '(' )

                return start === -1 ? '' : source.slice( start, start + 2000 )
            } )
            .join( '\n' )

        expect( /for\s*\(/.test( slices ) ).toBe( false )
        expect( /while\s*\(/.test( slices ) ).toBe( false )
    } )
} )
