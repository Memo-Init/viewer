import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import { extractFunctions, readMemoViewSource, readMemoViewStyles } from '../helpers/extractFunction.mjs'
import { MemoView } from '../../src/MemoView.mjs'
import { BlockMeta } from '../../src/BlockMeta.mjs'


// PRD-014 (Memo 016 Kap 9): empty-/error-states + requirements rest (A9, A10, A11, B6, B7, B8, B9,
// B10, B11, F9). Like the sibling render tests there is no jsdom, so we (a) prove the emitted browser
// script is syntactically valid, (b) unit-test the PURE static MemoView decision helpers + their 1:1
// inline browser mirrors, (c) drive the render functions against a small DOM shim to assert real DOM
// behaviour (severity/kind chip, empty-/error-state, child block hook, child modal title, block->req
// drilldown), and (d) keep a source-shape regression so the route wiring cannot silently drift.


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
        ( node._listeners[ 'click' ] || [] ).forEach( ( fn ) => fn( { target: node, preventDefault: () => {} } ) )
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
// 1. Pure static MemoView decision helpers (A10/F9, A11, B8, B9).
// ============================================================================================
describe( 'PRD-014 static decision helpers (MemoView)', () => {
    // F9/A10: blocksEmptyState ternary verdict.
    it( 'blocksEmptyState: present / no-blocks / parse-error verdicts', () => {
        expect( MemoView.blocksEmptyState( { count: 3, errorCount: 0 } ).empty ).toBe( false )
        expect( MemoView.blocksEmptyState( { count: 3, errorCount: 0 } ).kind ).toBe( 'present' )

        const noBlocks = MemoView.blocksEmptyState( { count: 0, errorCount: 0 } )
        expect( noBlocks.empty ).toBe( true )
        expect( noBlocks.kind ).toBe( 'no-blocks' )
        expect( noBlocks.reason.length ).toBeGreaterThan( 0 )

        const parseErr = MemoView.blocksEmptyState( { count: 0, errorCount: 2 } )
        expect( parseErr.empty ).toBe( true )
        expect( parseErr.kind ).toBe( 'parse-error' )
        expect( parseErr.reason ).toContain( '2' )
    } )


    // B8: requirementsConsistency expected-from-blocks vs resolved.
    it( 'requirementsConsistency: consistent vs mismatch', () => {
        const ok = MemoView.requirementsConsistency( { expectedFromBlocks: 3, resolvedCount: 3 } )
        expect( ok.consistent ).toBe( true )
        expect( ok.expected ).toBe( 3 )
        expect( ok.resolved ).toBe( 3 )

        const bad = MemoView.requirementsConsistency( { expectedFromBlocks: 8, resolvedCount: 0 } )
        expect( bad.consistent ).toBe( false )
        expect( bad.expected ).toBe( 8 )
        expect( bad.resolved ).toBe( 0 )
        expect( bad.reason ).toContain( 'Inkonsistenz' )

        // 0 expected, 0 resolved is consistent (no blocks declare requirements).
        expect( MemoView.requirementsConsistency( { expectedFromBlocks: 0, resolvedCount: 0 } ).consistent ).toBe( true )
    } )


    // B9: requirementSeverityClass maps known severities, unknown -> info.
    it( 'requirementSeverityClass: known severities + neutral fallback', () => {
        expect( MemoView.requirementSeverityClass( { severity: 'blocker' } ).severityClass ).toBe( 'req-sev-blocker' )
        expect( MemoView.requirementSeverityClass( { severity: 'WARNING' } ).severity ).toBe( 'warning' )
        expect( MemoView.requirementSeverityClass( { severity: 'nonsense' } ).severityClass ).toBe( 'req-sev-info' )
        expect( MemoView.requirementSeverityClass( { severity: null } ).severityClass ).toBe( 'req-sev-info' )
    } )


    // B9: requirementKindLabel derives the kind badge from check.kind.
    it( 'requirementKindLabel: uppercased kind from check.kind, empty when absent', () => {
        expect( MemoView.requirementKindLabel( { requirement: { check: { kind: 'tool' } } } ).kindLabel ).toBe( 'TOOL' )
        expect( MemoView.requirementKindLabel( { requirement: { check: { kind: 'skill' } } } ).kind ).toBe( 'skill' )
        expect( MemoView.requirementKindLabel( { requirement: {} } ).kindLabel ).toBe( '' )
        expect( MemoView.requirementKindLabel( { requirement: null } ).kindLabel ).toBe( '' )
    } )


    // A11: blockChildHook produces a non-empty stable hook for a child (id-less) and keeps a B-id.
    it( 'blockChildHook: composite child-<topic> hook, never empty', () => {
        expect( MemoView.blockChildHook( { block: { id: 'B001' } } ).hook ).toBe( 'B001' )
        expect( MemoView.blockChildHook( { block: { id: '', topic: 'T012' } } ).hook ).toBe( 'child-T012' )
        expect( MemoView.blockChildHook( { block: { topic: 'T014' } } ).hook ).toBe( 'child-T014' )
        // No id and no topic still yields a non-empty hook (never blind).
        expect( MemoView.blockChildHook( { block: {} } ).hook.length ).toBeGreaterThan( 0 )
    } )
} )


// ============================================================================================
// 2. Inline browser mirrors match the static decisions 1:1.
// ============================================================================================
describe( 'PRD-014 inline browser mirrors match static MemoView', () => {
    let fns = null

    beforeAll( async () => {
        fns = await extractFunctions( [
            'blocksEmptyState',
            'requirementsConsistency',
            'requirementSeverityClass',
            'requirementKindLabel',
            'blockChildHook'
        ] )
    } )


    it( 'inline blocksEmptyState mirrors MemoView.blocksEmptyState', () => {
        const cases = [
            { count: 0, errorCount: 0 },
            { count: 0, errorCount: 3 },
            { count: 5, errorCount: 0 }
        ]
        cases.forEach( ( c ) => {
            const inline = fns.blocksEmptyState( c.count, c.errorCount )
            const stat = MemoView.blocksEmptyState( c )
            expect( inline.empty ).toBe( stat.empty )
            expect( inline.kind ).toBe( stat.kind )
            expect( inline.reason ).toBe( stat.reason )
        } )
    } )


    it( 'inline requirementsConsistency mirrors MemoView.requirementsConsistency', () => {
        const cases = [ { e: 0, r: 0 }, { e: 3, r: 3 }, { e: 8, r: 2 } ]
        cases.forEach( ( c ) => {
            const inline = fns.requirementsConsistency( c.e, c.r )
            const stat = MemoView.requirementsConsistency( { expectedFromBlocks: c.e, resolvedCount: c.r } )
            expect( inline.consistent ).toBe( stat.consistent )
            expect( inline.reason ).toBe( stat.reason )
        } )
    } )


    it( 'inline severity/kind/childHook mirrors match the static decisions', () => {
        expect( fns.requirementSeverityClass( 'blocker' ).severityClass )
            .toBe( MemoView.requirementSeverityClass( { severity: 'blocker' } ).severityClass )
        expect( fns.requirementKindLabel( { check: { kind: 'tool' } } ).kindLabel )
            .toBe( MemoView.requirementKindLabel( { requirement: { check: { kind: 'tool' } } } ).kindLabel )
        expect( fns.blockChildHook( { topic: 'T012' } ).hook )
            .toBe( MemoView.blockChildHook( { block: { topic: 'T012' } } ).hook )
    } )
} )


// ============================================================================================
// 3. Inline render: severity/kind chip, empty-/error-state, child hook, child modal title, drilldown.
// ============================================================================================
describe( 'PRD-014 inline render behaviour', () => {
    let fns = null
    let savedDocument = null

    beforeAll( async () => {
        fns = await extractFunctions( [
            'requirementsEmptyState',
            'resolveBlockRequirements',
            'requirementsConsistency',
            'requirementSeverityClass',
            'requirementKindLabel',
            'blocksEmptyState',
            'blockChildHook',
            'buildEmptyState',
            'renderViewError',
            'buildRequirementChip',
            'renderRequirementsView',
            'openRequirementModal',
            'closeRequirementModal',
            'partitionBlocks',
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


    // B9: a chip carries a severity color class + a kind badge — chips are no longer all identical.
    it( 'B9: req chip carries a severity class + a kind badge', () => {
        globalThis.document = makeDocument( {} )

        const chip = fns.buildRequirementChip( {
            id: 'REQ-0001',
            shortName: 'Secrets',
            severity: 'blocker',
            check: { kind: 'tool' }
        } )

        expect( chip._classes.has( 'req-sev-blocker' ) ).toBe( true )
        expect( chip.getAttribute( 'data-req-severity' ) ).toBe( 'blocker' )
        const kindNodes = collectByAttr( chip, 'data-req-kind' )
        expect( kindNodes.length ).toBe( 1 )
        expect( kindNodes[ 0 ].getAttribute( 'data-req-kind' ) ).toBe( 'tool' )
        expect( kindNodes[ 0 ].textContent ).toBe( 'TOOL' )
    } )


    // B9: a requirement WITHOUT a check.kind omits the badge (no empty badge noise).
    it( 'B9: a kind-less requirement omits the kind badge', () => {
        globalThis.document = makeDocument( {} )

        const chip = fns.buildRequirementChip( { id: 'REQ-0002', shortName: 'X', severity: 'minor' } )

        expect( chip._classes.has( 'req-sev-minor' ) ).toBe( true )
        expect( collectByAttr( chip, 'data-req-kind' ).length ).toBe( 0 )
    } )


    // B8/B10/B7: the requirements view renders a consistency badge, the relabelled repo-scope level,
    // and the memo-aggregate level — the two levels stay distinct (data-req-level).
    it( 'B8/B10/B7: consistency badge + distinct repo-scope/aggregate levels (no misleading PRD-Ebene)', () => {
        globalThis.document = makeDocument( { 'requirement-modal': makeElement( 'div' ) } )
        const container = makeElement( 'div' )

        const root = fns.renderRequirementsView( {
            memoName: 'memo-016',
            groups: [ { groupKey: '(all repos)', requirements: [ { id: 'REQ-0001', shortName: 'A' } ] } ],
            aggregate: [ { id: 'REQ-0001', shortName: 'A' } ],
            missingIds: [],
            setPresent: true,
            blockRequirementNames: [ 'req-a', 'req-b' ],
            unresolvedBlockRequirements: [],
            consistency: { consistent: false, expected: 2, resolved: 1, reason: 'Inkonsistenz: Bloecke erwarten 2 Requirement(s), aufgeloest sind 1.' }
        }, container )

        // B8: a consistency badge is rendered with the mismatch verdict.
        const consistency = collectByAttr( root, 'data-req-consistent' )
        expect( consistency.length ).toBe( 1 )
        expect( consistency[ 0 ].getAttribute( 'data-req-consistent' ) ).toBe( 'false' )
        expect( consistency[ 0 ].textContent ).toContain( 'Inkonsistenz' )

        // B7/B10: the two levels stay distinct (repo-scope + memo-aggregate), no "PRD-Ebene" label.
        const levels = collectByAttr( root, 'data-req-level' ).map( ( n ) => n.getAttribute( 'data-req-level' ) ).sort()
        expect( levels ).toEqual( [ 'memo-aggregate', 'repo-scope' ] )
        const titleTexts = collectByAttr( root, 'data-req-level' ).map( ( n ) => n.textContent )
        expect( titleTexts.some( ( t ) => t.includes( 'PRD-Ebene' ) ) ).toBe( false )
        expect( titleTexts.some( ( t ) => t.includes( 'Repo-Scope' ) ) ).toBe( true )
    } )


    // F9: the requirements empty-state wears the SHARED .view-empty-state class (reusable component).
    it( 'F9: requirements empty-state uses the shared .view-empty-state component', () => {
        globalThis.document = makeDocument( {} )
        const container = makeElement( 'div' )

        const root = fns.renderRequirementsView( {
            memoName: 'memo-016', groups: [], aggregate: [], missingIds: [], setPresent: false,
            blockRequirementNames: [], unresolvedBlockRequirements: []
        }, container )

        const shared = collectByAttr( root, 'data-empty-state' )
        expect( shared.length ).toBeGreaterThanOrEqual( 1 )
        expect( shared[ 0 ]._classes.has( 'view-empty-state' ) ).toBe( true )
    } )


    // A10/F9: the blocks view renders a real "Keine Blöcke" empty-state + surfaces parse errors.
    it( 'A10/F9: blocks empty-state + parse errors surfaced (not discarded)', () => {
        globalThis.document = makeDocument( {} )
        const container = makeElement( 'div' )

        const root = fns.renderBlockView( {
            blocks: [],
            errors: [ { reason: 'invalid JSON: bad' } ]
        }, container )

        const empty = collectByAttr( root, 'data-empty-state' )
        expect( empty.length ).toBe( 1 )
        expect( empty[ 0 ]._classes.has( 'view-empty-state' ) ).toBe( true )
        expect( empty[ 0 ].getAttribute( 'data-empty-state' ) ).toBe( 'parse-error' )

        const parseErrors = collectByAttr( root, 'data-block-parse-errors' )
        expect( parseErrors.length ).toBe( 1 )
        expect( parseErrors[ 0 ].getAttribute( 'data-block-parse-errors' ) ).toBe( '1' )
        const errLines = parseErrors[ 0 ].children.map( ( c ) => c.textContent )
        expect( errLines.some( ( t ) => t.includes( 'invalid JSON' ) ) ).toBe( true )
    } )


    // A11: a child block card carries a NON-EMPTY data-block-id (composite child-<topic> hook).
    it( 'A11: a child block card has a non-empty data-block-id hook', () => {
        globalThis.document = makeDocument( {} )

        const child = fns.buildBlockItem( { role: 'child', id: '', topic: 'T012' } )

        expect( child.getAttribute( 'data-block-id' ) ).toBe( 'child-T012' )
        expect( child.getAttribute( 'data-block-id' ).length ).toBeGreaterThan( 0 )
        expect( child.getAttribute( 'data-child-topic' ) ).toBe( 'T012' )
    } )


    // A9: a child modal carries the child topic in the TITLE (not an empty "Block ·").
    it( 'A9: child modal title shows the topic, never empty', () => {
        const modal = makeElement( 'div' )
        modal.classList.add( 't-modal' )
        modal.classList.add( 't-hidden' )
        const modalBody = makeElement( 'div' )
        const modalTitle = makeElement( 'span' )
        const registry = { 'block-modal': modal, 'block-modal-body': modalBody, 'block-modal-title': modalTitle }
        globalThis.document = makeDocument( registry )

        fns.openBlockModal( { role: 'child', id: '', topic: 'T012', effectiveRequirements: [ 'req-secrets' ] } )

        expect( modalTitle.textContent ).toContain( 'T012' )
        expect( modalTitle.textContent.trim().length ).toBeGreaterThan( 0 )
        expect( modalTitle.textContent.startsWith( 'Block ·' ) ).toBe( false )
    } )


    // B6: the block modal carries a Block -> Requirements drilldown link.
    it( 'B6: block modal has a Block->Requirements drilldown link', () => {
        const modal = makeElement( 'div' )
        modal.classList.add( 't-modal' )
        modal.classList.add( 't-hidden' )
        const modalBody = makeElement( 'div' )
        const modalTitle = makeElement( 'span' )
        const registry = { 'block-modal': modal, 'block-modal-body': modalBody, 'block-modal-title': modalTitle }
        globalThis.document = makeDocument( registry )

        fns.openBlockModal( { role: 'parent', id: 'B001', chapter: 'Kap 9', requirements: [ 'req-secrets', 'req-coverage' ] } )

        const drill = collectByAttr( modalBody, 'data-block-req-drilldown' )
        expect( drill.length ).toBe( 1 )
        expect( drill[ 0 ].getAttribute( 'data-block-req-drilldown' ) ).toBe( '2' )
        expect( drill[ 0 ].textContent ).toContain( 'Requirements' )
    } )


    // B11/F9: the shared error-state component shows a real message (used by both load paths).
    it( 'B11/F9: renderViewError shows the error message via the shared error-state', () => {
        globalThis.document = makeDocument( {} )
        const target = makeElement( 'div' )

        const box = fns.renderViewError( target, 'HTTP 500 boom' )

        const errBoxes = collectByAttr( target, 'data-error-state' )
        expect( errBoxes.length ).toBe( 1 )
        expect( errBoxes[ 0 ]._classes.has( 'view-error-state' ) ).toBe( true )
        const msgTexts = errBoxes[ 0 ].children.map( ( c ) => c.textContent )
        expect( msgTexts.some( ( t ) => t.includes( 'HTTP 500 boom' ) ) ).toBe( true )
        expect( box.getAttribute( 'data-error-state' ) ).toBe( 'load-failed' )
    } )
} )


// ============================================================================================
// 4. RequirementsStore + BlockMeta direct: the data the route surfaces is real.
// ============================================================================================
describe( 'PRD-014 data sources (RequirementsStore / BlockMeta)', () => {
    // A10: BlockMeta.parse returns the `errors` the route now surfaces (a broken fence is reported,
    // never silently dropped).
    it( 'A10: BlockMeta.parse reports unparseable fences in errors[]', () => {
        const doc = [
            '## Kap 9',
            '',
            '```block-meta',
            '{ not valid json',
            '```',
            ''
        ].join( '\n' )

        const { blocks, errors } = BlockMeta.parse( { doc } )

        expect( blocks.length ).toBe( 0 )
        expect( errors.length ).toBe( 1 )
        expect( errors[ 0 ].reason ).toContain( 'invalid JSON' )
    } )


    // B8: a requirement body carries severity + check.kind — the fields B9/B8 read. Proven against
    // the public BlockMeta.effectiveRequirements union so the consistency input is real.
    it( 'B8/B7: BlockMeta.effectiveRequirements keeps parent default + child additive distinct levels', () => {
        const parent = { requirements: [ 'req-secrets' ] }
        const child = { requirementsPlus: [ 'req-coverage' ] }

        const { requirements } = BlockMeta.effectiveRequirements( { parent, child } )

        // Parent first (default), child additive after — both levels present (B7), deduped union.
        expect( requirements ).toEqual( [ 'req-secrets', 'req-coverage' ] )
    } )
} )


// ============================================================================================
// 5. Source-shape regression — route wiring + emitted script must not drift.
// ============================================================================================
describe( 'PRD-014 source-shape regression', () => {
    let source = ''
    let emitted = ''

    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const clientPath = join( here, '..', '..', 'src', 'public', 'app.client.mjs' )
        const mjsSource = await readMemoViewSource()
        const cssSource = await readMemoViewStyles()
        emitted = await readFile( clientPath, 'utf8' )
        source = mjsSource + '\n' + cssSource + '\n' + emitted
    } )


    it( 'the emitted inline browser script stays syntactically valid', () => {
        let message = ''
        try {
            new vm.Script( emitted )
        } catch( err ) {
            message = err.message
        }
        expect( message ).toBe( '' )
    } )


    it( 'A10: the /blocks route surfaces parse errors in the payload', () => {
        expect( source ).toContain( 'const { blocks, errors } = BlockMeta.parse( { doc: content } )' )
        expect( source ).toContain( "'errors': errors" )
    } )


    it( 'B8: the /requirements route surfaces a consistency verdict', () => {
        expect( source ).toContain( 'MemoView.requirementsConsistency' )
        expect( source ).toContain( "'consistency': consistency" )
    } )


    it( 'B9/B10/B11/A11/F9: the inline render carries the new hooks', () => {
        expect( source ).toContain( 'data-req-severity' )
        expect( source ).toContain( 'data-req-kind' )
        expect( source ).toContain( 'Requirements (nach Repo-Scope)' )
        expect( source ).toContain( 'data-req-consistent' )
        expect( source ).toContain( 'data-empty-state' )
        expect( source ).toContain( 'data-error-state' )
        expect( source ).toContain( 'data-block-req-drilldown' )
        expect( source ).toContain( 'function blockChildHook(' )
    } )


    it( 'B11: both load paths check resp.ok / payload.error', () => {
        expect( source ).toContain( '!resp.ok || ( payload && payload.error )' )
    } )


    it( 'no for/while loops in the new render/helper functions', () => {
        const names = [
            'blocksEmptyState', 'requirementsConsistency', 'requirementSeverityClass',
            'requirementKindLabel', 'blockChildHook', 'buildEmptyState', 'renderViewError'
        ]
        const slices = names
            .map( ( name ) => {
                const start = source.indexOf( 'function ' + name + '(' )

                return start === -1 ? '' : source.slice( start, start + 1200 )
            } )
            .join( '\n' )

        expect( /for\s*\(/.test( slices ) ).toBe( false )
        expect( /while\s*\(/.test( slices ) ).toBe( false )
    } )
} )
