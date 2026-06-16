import { describe, it, expect, beforeAll } from '@jest/globals'

import { RevisionLogic } from '../../src/RevisionLogic.mjs'
import { MemoView } from '../../src/MemoView.mjs'
import { extractFunctions } from '../helpers/extractFunction.mjs'


// PRD-012 (Memo 016, catalog F3): a set of small PURE decision helpers used to be duplicated —
// once as a static MemoView.xxx method (server) and once as an inline `function xxx(...)` inside
// the client browser script (src/public/app.client.mjs). Two hand-maintained copies DRIFT.
//
// F3's intent is realized in two halves:
//   1. SERVER single source: the logic now lives ONCE in src/RevisionLogic.mjs; every MemoView.xxx
//      static is a thin wrapper that delegates to RevisionLogic.xxx (no duplicated server body).
//      Part 1 of this file unit-tests RevisionLogic directly AND asserts the MemoView wrapper still
//      returns the exact same shape (so the public name keeps working for existing callers/tests).
//   2. CLIENT drift-guard: the client CANNOT runtime-import RevisionLogic (it is served as a CLASSIC
//      <script>, see F8). So per deduped function this file extracts the client inline copy via
//      tests/helpers/extractFunction.mjs and runs the SAME representative inputs through BOTH
//      RevisionLogic.xxx and the client inline copy, asserting identical outputs. If the two ever
//      diverge, the corresponding drift-guard test fails.
//
// Note on return shapes: RevisionLogic (house style) returns objects ({ slug }, { ballStatus },
// { revisionId }, { html }, { rerender } ). Several client inline copies return the BARE value
// (string/boolean). The drift-guards below unwrap the RevisionLogic object to compare against the
// client's bare return — equal logic, different surface.


// ---- representative input sets (shared by the unit tests + the drift-guards) --------------------
const SLUG_INPUTS = [
    'Hello World',
    'Übergrößenträger — Maße & Größe',
    'Kapitel 14/15: Drift?!',
    '   ---trim---   ',
    '',
    null,
    undefined,
    'ALL CAPS 123',
    'a..b..c'
]

const REVISIONS_INPUTS = [
    [ { fileName: 'REV-01.md' }, { fileName: 'REV-03.md' }, { fileName: 'REV-02.md' } ],
    [ { fileName: 'REV-10.md' } ],
    [],
    undefined,
    [ { fileName: 'phase-2.md' }, { fileName: 'REV-05.md' } ],
    [ { notAFileName: true }, null ]
]

const BALL_INPUTS = [
    { revisionStatus: 'offen', memoFinalized: false },
    { revisionStatus: 'transcript-eingetragen', memoFinalized: false },
    { revisionStatus: 'transcript-eingetragen', memoFinalized: true },
    { revisionStatus: 'eingeloggt', memoFinalized: true },
    { revisionStatus: 'eingeloggt', memoFinalized: false },
    { revisionStatus: undefined, memoFinalized: false }
]

const FILENAME_INPUTS = [
    'REV-03.md',
    'REV-12.md',
    'phase-2',
    'no-revision-here',
    '',
    42,
    null,
    undefined
]

const MERMAID_INPUTS = [
    { err: new Error( 'Parse error on line 2' ), originalText: 'graph TD; A-->B' },
    { err: { message: 'broken & <tag>' }, originalText: 'flowchart LR\n  X --> Y & <Z>' },
    { err: 'string error', originalText: '' },
    { err: null, originalText: null },
    { err: undefined, originalText: 'a > b < c & d' }
]

const EMPTY_STATE_INPUTS = [
    { count: 0, setPresent: false, missingCount: 0 },
    { count: 0, setPresent: true, missingCount: 0 },
    { count: 0, setPresent: true, missingCount: 3 },
    { count: 3, setPresent: true, missingCount: 0 },
    { count: undefined, setPresent: false, missingCount: null },
    { count: 0, setPresent: true, missingCount: -2 }
]

const RESOLVE_INPUTS = [
    { blockRequirementNames: [ 'req-secrets', 'req-coverage' ], knownIds: [ 'REQ-001', 'REQ-002' ] },
    { blockRequirementNames: [ 'req-001', 'req-secrets' ], knownIds: [ 'REQ-001', 'REQ-002' ] },
    { blockRequirementNames: [ 'REQ-001', 'req-002' ], knownIds: [ 'REQ-001', 'REQ-002' ] },
    { blockRequirementNames: [ 'req-secrets', 'req-secrets', '', '  ' ], knownIds: [ 'REQ-001' ] },
    { blockRequirementNames: undefined, knownIds: undefined }
]

const VIEW_STATE_INPUTS = [
    { current: 'prose', requested: 'requirements' },
    { current: 'prose', requested: 'blocks' },
    { current: 'requirements', requested: 'requirements' },
    { current: 'blocks', requested: 'blocks' },
    { current: 'requirements', requested: 'blocks' },
    { current: 'requirements', requested: 'prose' },
    { current: 'prose', requested: 'prose' },
    { current: 'unknown', requested: 'weird' }
]

const RERENDER_INPUTS = [ 'prose', 'memo', 'requirements', 'blocks', undefined, null, '' ]


// ================================================================================================
// 1. RevisionLogic unit tests — the single source of truth (pure functions).
// ================================================================================================
describe( 'RevisionLogic.slugify (PRD-012 / D3/D7)', () => {
    it( 'lowercases, transliterates umlauts and collapses punctuation to single dashes', () => {
        expect( RevisionLogic.slugify( { text: 'Größe & Maße' } ).slug ).toBe( 'groesse-masse' )
    } )

    it( 'trims leading/trailing dashes and guards null/undefined to empty', () => {
        expect( RevisionLogic.slugify( { text: '   ---X---   ' } ).slug ).toBe( 'x' )
        expect( RevisionLogic.slugify( { text: null } ).slug ).toBe( '' )
        expect( RevisionLogic.slugify( { text: undefined } ).slug ).toBe( '' )
    } )
} )


describe( 'RevisionLogic.nextRevisionNumbers (PRD-012 / PRD-013)', () => {
    it( 'next = highest existing + 1, previous = highest existing (never from viewed suffix)', () => {
        const result = RevisionLogic.nextRevisionNumbers( {
            revisions: [ { fileName: 'REV-01.md' }, { fileName: 'REV-03.md' }, { fileName: 'REV-02.md' } ]
        } )

        expect( result.previous ).toBe( 3 )
        expect( result.next ).toBe( 4 )
        expect( result.previousId ).toBe( 'REV-03' )
        expect( result.nextId ).toBe( 'REV-04' )
    } )

    it( 'empty / undefined revisions => previous 0, next 1', () => {
        expect( RevisionLogic.nextRevisionNumbers( { revisions: [] } ).nextId ).toBe( 'REV-01' )
        expect( RevisionLogic.nextRevisionNumbers( { revisions: undefined } ).nextId ).toBe( 'REV-01' )
    } )

    it( 'ignores non-REV filenames', () => {
        const result = RevisionLogic.nextRevisionNumbers( {
            revisions: [ { fileName: 'phase-2.md' }, { fileName: 'REV-05.md' } ]
        } )

        expect( result.previous ).toBe( 5 )
        expect( result.nextId ).toBe( 'REV-06' )
    } )
} )


describe( 'RevisionLogic.deriveBallStatus (PRD-012 / F7)', () => {
    it( 'maps the three states', () => {
        expect( RevisionLogic.deriveBallStatus( { revisionStatus: 'eingeloggt', memoFinalized: true } ).ballStatus )
            .toBe( 'Finalisiert (Locked)' )
        expect( RevisionLogic.deriveBallStatus( { revisionStatus: 'transcript-eingetragen', memoFinalized: false } ).ballStatus )
            .toBe( 'Transcript hinterlegt' )
        expect( RevisionLogic.deriveBallStatus( { revisionStatus: 'offen', memoFinalized: false } ).ballStatus )
            .toBe( 'Wartet auf User-Feedback' )
    } )

    it( 'eingeloggt but NOT finalized stays feedback (no false lock)', () => {
        expect( RevisionLogic.deriveBallStatus( { revisionStatus: 'eingeloggt', memoFinalized: false } ).ballStatus )
            .toBe( 'Wartet auf User-Feedback' )
    } )
} )


describe( 'RevisionLogic.revisionIdFromFileName (PRD-012)', () => {
    it( 'extracts REV-NN, returns null for non-revision filenames and non-strings', () => {
        expect( RevisionLogic.revisionIdFromFileName( { fileName: 'REV-03.md' } ).revisionId ).toBe( 'REV-03' )
        expect( RevisionLogic.revisionIdFromFileName( { fileName: 'phase-2' } ).revisionId ).toBe( null )
        expect( RevisionLogic.revisionIdFromFileName( { fileName: 42 } ).revisionId ).toBe( null )
    } )
} )


describe( 'RevisionLogic.buildMermaidErrorHtml (PRD-012 / PRD-010)', () => {
    it( 'embeds the HTML-escaped message and original source', () => {
        const { html } = RevisionLogic.buildMermaidErrorHtml( { err: { message: 'x & <y>' }, originalText: 'a < b' } )

        expect( html ).toContain( 'Mermaid Error: x &amp; &lt;y&gt;' )
        expect( html ).toContain( '<pre class="mermaid-error-source">a &lt; b</pre>' )
    } )

    it( 'guards null err/originalText', () => {
        const { html } = RevisionLogic.buildMermaidErrorHtml( { err: null, originalText: null } )

        expect( typeof html ).toBe( 'string' )
        expect( html ).toContain( 'mermaid-error-source' )
    } )
} )


describe( 'RevisionLogic.requirementsEmptyState (PRD-012 / B1/B2)', () => {
    it( 'distinguishes no-set / empty-set / resolved', () => {
        expect( RevisionLogic.requirementsEmptyState( { count: 0, setPresent: false, missingCount: 0 } ).kind ).toBe( 'no-set' )
        expect( RevisionLogic.requirementsEmptyState( { count: 0, setPresent: true, missingCount: 0 } ).kind ).toBe( 'empty-set' )
        expect( RevisionLogic.requirementsEmptyState( { count: 2, setPresent: true, missingCount: 0 } ).kind ).toBe( 'resolved' )
    } )

    it( 'weaves missingCount into the empty-set reason', () => {
        expect( RevisionLogic.requirementsEmptyState( { count: 0, setPresent: true, missingCount: 3 } ).reason ).toContain( '3' )
    } )
} )


describe( 'RevisionLogic.resolveBlockRequirements (PRD-012 / B3/B5)', () => {
    it( 'resolves normalized names and reports the rest as namespace mismatch', () => {
        const result = RevisionLogic.resolveBlockRequirements( {
            blockRequirementNames: [ 'req-001', 'req-secrets' ],
            knownIds: [ 'REQ-001', 'REQ-002' ]
        } )

        expect( result.resolved ).toEqual( [ 'REQ-001' ] )
        expect( result.unresolved ).toEqual( [ 'req-secrets' ] )
        expect( result.hasNamespaceMismatch ).toBe( true )
    } )

    it( 'dedupes, ignores blanks and guards non-array inputs', () => {
        expect( RevisionLogic.resolveBlockRequirements( {
            blockRequirementNames: [ 'req-x', 'req-x', '', '  ' ],
            knownIds: [ 'REQ-001' ]
        } ).unresolved ).toEqual( [ 'req-x' ] )

        expect( RevisionLogic.resolveBlockRequirements( { blockRequirementNames: undefined, knownIds: undefined } ).hasNamespaceMismatch )
            .toBe( false )
    } )
} )


describe( 'RevisionLogic.nextViewState (PRD-012 / F4/E6)', () => {
    it( 'opens a panel, toggles the active panel back to prose, returns home on prose', () => {
        expect( RevisionLogic.nextViewState( { current: 'prose', requested: 'requirements' } ) )
            .toEqual( { view: 'requirements', render: true } )
        expect( RevisionLogic.nextViewState( { current: 'requirements', requested: 'requirements' } ) )
            .toEqual( { view: 'prose', render: true } )
        expect( RevisionLogic.nextViewState( { current: 'prose', requested: 'prose' } ) )
            .toEqual( { view: 'prose', render: false } )
    } )
} )


describe( 'RevisionLogic.shouldRerenderOnBroadcast (PRD-012 / E7/F10)', () => {
    it( 'only the prose/memo home view (or empty) re-renders; panels survive', () => {
        expect( RevisionLogic.shouldRerenderOnBroadcast( { currentView: 'prose' } ).rerender ).toBe( true )
        expect( RevisionLogic.shouldRerenderOnBroadcast( { currentView: 'memo' } ).rerender ).toBe( true )
        expect( RevisionLogic.shouldRerenderOnBroadcast( { currentView: undefined } ).rerender ).toBe( true )
        expect( RevisionLogic.shouldRerenderOnBroadcast( { currentView: 'requirements' } ).rerender ).toBe( false )
        expect( RevisionLogic.shouldRerenderOnBroadcast( { currentView: 'blocks' } ).rerender ).toBe( false )
    } )
} )


// ================================================================================================
// 2. Server single-source — the MemoView wrappers delegate to RevisionLogic (same shape, no body).
// ================================================================================================
describe( 'MemoView wrappers delegate to RevisionLogic (server single source, PRD-012)', () => {
    it( 'every wrapper returns exactly the RevisionLogic result shape', () => {
        SLUG_INPUTS.forEach( ( text ) => {
            expect( MemoView.slugify( { text } ) ).toEqual( RevisionLogic.slugify( { text } ) )
        } )
        REVISIONS_INPUTS.forEach( ( revisions ) => {
            expect( MemoView.nextRevisionNumbers( { revisions } ) ).toEqual( RevisionLogic.nextRevisionNumbers( { revisions } ) )
        } )
        BALL_INPUTS.forEach( ( input ) => {
            expect( MemoView.deriveBallStatus( input ) ).toEqual( RevisionLogic.deriveBallStatus( input ) )
        } )
        FILENAME_INPUTS.forEach( ( fileName ) => {
            expect( MemoView.revisionIdFromFileName( { fileName } ) ).toEqual( RevisionLogic.revisionIdFromFileName( { fileName } ) )
        } )
        MERMAID_INPUTS.forEach( ( input ) => {
            expect( MemoView.buildMermaidErrorHtml( input ) ).toEqual( RevisionLogic.buildMermaidErrorHtml( input ) )
        } )
        EMPTY_STATE_INPUTS.forEach( ( input ) => {
            expect( MemoView.requirementsEmptyState( input ) ).toEqual( RevisionLogic.requirementsEmptyState( input ) )
        } )
        RESOLVE_INPUTS.forEach( ( input ) => {
            expect( MemoView.resolveBlockRequirements( input ) ).toEqual( RevisionLogic.resolveBlockRequirements( input ) )
        } )
        VIEW_STATE_INPUTS.forEach( ( input ) => {
            expect( MemoView.nextViewState( input ) ).toEqual( RevisionLogic.nextViewState( input ) )
        } )
    } )

    it( 'MemoView.shouldRerenderOnBroadcast keeps its bare-boolean public contract', () => {
        RERENDER_INPUTS.forEach( ( currentView ) => {
            const wrapped = MemoView.shouldRerenderOnBroadcast( { currentView } )
            const single = RevisionLogic.shouldRerenderOnBroadcast( { currentView } ).rerender

            expect( typeof wrapped ).toBe( 'boolean' )
            expect( wrapped ).toBe( single )
        } )
    } )
} )


// ================================================================================================
// 3. CLIENT drift-guard — RevisionLogic.xxx output === client inline copy output (per function).
//    Extract each inline `function xxx(...)` from src/public/app.client.mjs and run the SAME inputs.
//    If the client copy ever diverges from RevisionLogic, the matching test below fails.
// ================================================================================================
describe( 'client drift-guard: RevisionLogic === client inline copy (PRD-012, F3 closes drift)', () => {
    let client = null

    beforeAll( async () => {
        client = await extractFunctions( [
            'slugify',
            'nextRevisionNumbers',
            'deriveBallStatus',
            'revisionIdFromFileName',
            'buildMermaidErrorHtml',
            'requirementsEmptyState',
            'resolveBlockRequirements',
            'nextViewState',
            'shouldRerenderOnBroadcast'
        ] )
    } )


    it( 'slugify: client bare string === RevisionLogic { slug }', () => {
        SLUG_INPUTS.forEach( ( text ) => {
            expect( client.slugify( text ) ).toBe( RevisionLogic.slugify( { text } ).slug )
        } )
    } )


    it( 'nextRevisionNumbers: client struct === RevisionLogic struct', () => {
        REVISIONS_INPUTS.forEach( ( revisions ) => {
            expect( client.nextRevisionNumbers( revisions ) ).toEqual( RevisionLogic.nextRevisionNumbers( { revisions } ) )
        } )
    } )


    it( 'deriveBallStatus: client bare string === RevisionLogic { ballStatus }', () => {
        BALL_INPUTS.forEach( ( input ) => {
            expect( client.deriveBallStatus( input.revisionStatus, input.memoFinalized ) )
                .toBe( RevisionLogic.deriveBallStatus( input ).ballStatus )
        } )
    } )


    it( 'revisionIdFromFileName: client bare value === RevisionLogic { revisionId }', () => {
        FILENAME_INPUTS.forEach( ( fileName ) => {
            expect( client.revisionIdFromFileName( fileName ) )
                .toBe( RevisionLogic.revisionIdFromFileName( { fileName } ).revisionId )
        } )
    } )


    it( 'buildMermaidErrorHtml: client bare string === RevisionLogic { html }', () => {
        MERMAID_INPUTS.forEach( ( input ) => {
            expect( client.buildMermaidErrorHtml( input.err, input.originalText ) )
                .toBe( RevisionLogic.buildMermaidErrorHtml( input ).html )
        } )
    } )


    it( 'requirementsEmptyState: client object === RevisionLogic object', () => {
        EMPTY_STATE_INPUTS.forEach( ( input ) => {
            expect( client.requirementsEmptyState( input.count, input.setPresent, input.missingCount ) )
                .toEqual( RevisionLogic.requirementsEmptyState( input ) )
        } )
    } )


    it( 'resolveBlockRequirements: client object === RevisionLogic object', () => {
        RESOLVE_INPUTS.forEach( ( input ) => {
            expect( client.resolveBlockRequirements( input.blockRequirementNames, input.knownIds ) )
                .toEqual( RevisionLogic.resolveBlockRequirements( input ) )
        } )
    } )


    it( 'nextViewState: client object === RevisionLogic object', () => {
        VIEW_STATE_INPUTS.forEach( ( input ) => {
            expect( client.nextViewState( input.current, input.requested ) )
                .toEqual( RevisionLogic.nextViewState( input ) )
        } )
    } )


    it( 'shouldRerenderOnBroadcast: client bare boolean === RevisionLogic { rerender }', () => {
        RERENDER_INPUTS.forEach( ( currentView ) => {
            expect( client.shouldRerenderOnBroadcast( currentView ) )
                .toBe( RevisionLogic.shouldRerenderOnBroadcast( { currentView } ).rerender )
        } )
    } )
} )
