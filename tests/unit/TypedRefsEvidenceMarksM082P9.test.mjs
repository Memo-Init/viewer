import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { extractFunctionSources, sliceDeclaration, readEmittedScript } from '../helpers/extractFunction.mjs'


// PRD-17 (Memo 082 Phase 9, WI-238) — S7: one sees a reference's KIND, and one popup answers for all.
//
// Three halves, and this suite covers all three:
//   kinds      the reference type table, its one-to-one colour mapping, the neutral row for a kind the
//              table does not name, and the parity between the table and app.css.
//   evidence   the five evidence tags rendered AS marks, the proof that the pass leaves the text (and
//              therefore the existing count) untouched, and the NAMED zero over a document with none.
//   popup      the typed renderers at the seam PRD-16 named — the REAL registration run against the
//              REAL registry declaration, not a replica of it.
//
// The pure functions are LIFTED out of the classic client script and really called; the two wiring
// lines that need a live DOM are asserted on the emitted source, following the convention of the other
// client-pipeline suites (this project has no jsdom).
//
// EVERY CASE STATES HOW MUCH IT COMPARED. A check over an empty comparison set is red, never green.
//
// The expectation tables below are written out DELIBERATELY instead of being derived from the
// production tables. A test that reads its expectation out of the code under test is green by
// construction; these fifteen and five rows are the independent second copy of the decision, so a
// hand-edit on either side turns a case red instead of drifting quietly.
const here = dirname( fileURLToPath( import.meta.url ) )

const EXPECTED_KINDS = [
    { 'prefix': 'M', 'slug': 'm', 'label': 'Memo', 'tint': 'rgba(88, 166, 255, 0.18)' },
    { 'prefix': 'MNT', 'slug': 'mnt', 'label': 'Wartungs-Karte', 'tint': 'rgba(63, 185, 80, 0.18)' },
    { 'prefix': 'T', 'slug': 't', 'label': 'Topic', 'tint': 'rgba(210, 153, 34, 0.18)' },
    { 'prefix': 'B', 'slug': 'b', 'label': 'Block', 'tint': 'rgba(188, 140, 255, 0.18)' },
    { 'prefix': 'G', 'slug': 'g', 'label': 'Ziel', 'tint': 'rgba(255, 123, 114, 0.18)' },
    { 'prefix': 'WI', 'slug': 'wi', 'label': 'Work-Item', 'tint': 'rgba(57, 197, 207, 0.18)' },
    { 'prefix': 'RES', 'slug': 'res', 'label': 'Research-Datensatz', 'tint': 'rgba(219, 97, 162, 0.18)' },
    { 'prefix': 'PRD', 'slug': 'prd', 'label': 'Arbeitsauftrag', 'tint': 'rgba(240, 136, 62, 0.18)' },
    { 'prefix': 'REQ', 'slug': 'req', 'label': 'Anforderung', 'tint': 'rgba(163, 113, 247, 0.18)' },
    { 'prefix': 'PLAN', 'slug': 'plan', 'label': 'Plan', 'tint': 'rgba(31, 111, 235, 0.18)' },
    { 'prefix': 'ANM', 'slug': 'anm', 'label': 'Anmerkung', 'tint': 'rgba(226, 192, 141, 0.18)' },
    { 'prefix': 'LL', 'slug': 'll', 'label': 'Lehre', 'tint': 'rgba(126, 231, 135, 0.18)' },
    { 'prefix': 'REV', 'slug': 'rev', 'label': 'Revision', 'tint': 'rgba(255, 166, 87, 0.18)' },
    { 'prefix': 'SR', 'slug': 'sr', 'label': 'Sprech-Regel', 'tint': 'rgba(121, 192, 255, 0.18)' },
    { 'prefix': null, 'slug': 'other', 'label': 'unbekannte Art', 'tint': 'rgba(139, 148, 158, 0.18)' }
]

const NAMED_KINDS = EXPECTED_KINDS.filter( ( kind ) => kind[ 'prefix' ] !== null )

const EXPECTED_EVIDENCE = [
    { 'tag': 'GEMESSEN', 'slug': 'gemessen', 'label': 'gemessen', 'tint': 'rgba(46, 160, 67, 0.2)' },
    { 'tag': 'FAKT', 'slug': 'fakt', 'label': 'Fakt', 'tint': 'rgba(56, 139, 253, 0.2)' },
    { 'tag': 'ABGELEITET', 'slug': 'abgeleitet', 'label': 'abgeleitet', 'tint': 'rgba(137, 87, 229, 0.2)' },
    { 'tag': 'ANNAHME', 'slug': 'annahme', 'label': 'Annahme', 'tint': 'rgba(187, 128, 9, 0.2)' },
    { 'tag': 'VERMUTUNG', 'slug': 'vermutung', 'label': 'Vermutung', 'tint': 'rgba(218, 54, 51, 0.2)' }
]

// A prefix the table does not name. `ZZ` is not in ID_VOCABULARY_MIRROR either, so it is exactly the
// case the fallback row exists for: a kind that arrives without a considered look.
const UNKNOWN_PREFIX = 'ZZ'

const OVERVIEW = {
    'state': 'ok',
    'documentId': 'memo-init/080-datenbank',
    'memoName': '080-datenbank',
    'documentKind': 'revision',
    'memoStatus': 'finalisiert',
    'revisionCount': 12,
    'latestRevision': { 'fileName': 'REV-12.md', 'sizeKb': 311 },
    'questions': { 'answered': 23, 'open': 1, 'deferred': 0, 'basis': true },
    'headings': [ 'Kapitel eins', 'Kapitel zwei' ],
    'headingCount': 19,
    'fullViewPath': '/doc/memo-init%2F080-datenbank'
}

let client = null
let clientSource = ''
let cssSource = ''


// The lift: declarations first so the lifted functions close over the REAL tables, then the functions,
// then the REAL registration call against the REAL registry declaration. Exposing the registry itself
// is what makes the dispatch testable without re-implementing the registration in the test.
async function liftClient() {
    const script = await readEmittedScript()
    const declarationNames = [ 'ID_REF_KINDS', 'EVIDENCE_MARK_KINDS', 'EVIDENCE_TAGS', 'EVIDENCE_ART_VALUES', 'ID_VOCABULARY_MIRROR', 'idRefOverviewRenderers' ]
    const functionNames = [
        'escapeHtml', 'escapeAttr',
        'idRefKindOf', 'idRefKindFallbackRow', 'idRefKindResolve', 'idRefKindClass',
        'evidenceMarkKindOf', 'evidenceTokenPattern', 'evidenceMarkClass', 'splitEvidenceHits',
        'artValueOfRow', 'distributionOf',
        'idRefOverviewBody', 'idRefOverviewHead', 'idRefTypedOverviewBody', 'idRefOverviewFallbackBody',
        'renderIdRefOverview', 'registerIdRefTypedRenderers'
    ]
    const declarations = declarationNames
        .map( ( name ) => sliceDeclaration( script, name ) )
        .join( '\n' )
    const { source } = await extractFunctionSources( functionNames )
    const exposed = functionNames.concat( declarationNames ).join( ', ' )
    const factory = new Function( [
        declarations,
        source,
        'var registration = registerIdRefTypedRenderers( idRefOverviewRenderers )',
        'return { ' + exposed + ', registration }'
    ].join( '\n' ) )

    return factory()
}


beforeAll( async () => {
    client = await liftClient()
    clientSource = await readFile( join( here, '..', '..', 'src', 'public', 'app.client.mjs' ), 'utf8' )
    cssSource = await readFile( join( here, '..', '..', 'src', 'public', 'app.css' ), 'utf8' )
} )


describe( 'PRD-17 — ID_REF_KINDS: one kind, one colour', () => {
    it( 'matches the independently written expectation row for row (15 rows compared)', () => {
        const actual = client[ 'ID_REF_KINDS' ].map( ( kind ) => ( { 'prefix': kind[ 'prefix' ], 'slug': kind[ 'slug' ], 'label': kind[ 'label' ], 'tint': kind[ 'tint' ] } ) )

        expect( actual.length ).toBe( 15 )
        expect( actual ).toEqual( EXPECTED_KINDS )
    } )


    // The parity guard: the table is hand-kept on purpose, so growth of the mirrored vocabulary must
    // show up as a RED case rather than as a grey mark nobody ordered.
    it( 'names every recognised prefix of ID_VOCABULARY_MIRROR (14 prefixes compared)', () => {
        const vocabulary = client[ 'ID_VOCABULARY_MIRROR' ].map( ( row ) => row[ 'prefix' ] )
        const named = client[ 'ID_REF_KINDS' ].filter( ( kind ) => kind[ 'prefix' ] !== null ).map( ( kind ) => kind[ 'prefix' ] )
        const missing = vocabulary.filter( ( prefix ) => named.indexOf( prefix ) === -1 )
        const extra = named.filter( ( prefix ) => vocabulary.indexOf( prefix ) === -1 )

        expect( vocabulary.length ).toBe( 14 )
        expect( missing ).toEqual( [] )
        expect( extra ).toEqual( [] )
    } )


    it( 'carries exactly one fallback row, and it is the only one without a prefix (15 rows compared)', () => {
        const fallbacks = client[ 'ID_REF_KINDS' ].filter( ( kind ) => kind[ 'prefix' ] === null )

        expect( client[ 'ID_REF_KINDS' ].length ).toBe( 15 )
        expect( fallbacks.length ).toBe( 1 )
        expect( client[ 'idRefKindFallbackRow' ]()[ 'slug' ] ).toBe( 'other' )
    } )


    // AB-2: the mapping is one-to-one. Two kinds in the same colour would not be a distinction, it
    // would be a new confusion.
    it( 'AB-2 — the 15 tints are pairwise different (15 kinds, 15 colours)', () => {
        const tints = client[ 'ID_REF_KINDS' ].map( ( kind ) => kind[ 'tint' ] )
        const distinct = tints.filter( ( tint, index ) => tints.indexOf( tint ) === index )

        expect( tints.length ).toBe( 15 )
        expect( distinct.length ).toBe( tints.length )
    } )


    it( 'the 15 slugs are pairwise different (15 kinds compared)', () => {
        const slugs = client[ 'ID_REF_KINDS' ].map( ( kind ) => kind[ 'slug' ] )
        const distinct = slugs.filter( ( slug, index ) => slugs.indexOf( slug ) === index )

        expect( slugs.length ).toBe( 15 )
        expect( distinct.length ).toBe( slugs.length )
    } )


    // AB-1, predicate side: one named case per measured kind. The click-side proof is
    // .browser/scripts/p9-typed-refs.mjs against the running viewer.
    NAMED_KINDS.forEach( ( kind ) => {
        it( 'AB-1 — kind ' + kind[ 'prefix' ] + ' carries class id-ref-kind-' + kind[ 'slug' ] + ' and colour ' + kind[ 'tint' ], () => {
            expect( client[ 'idRefKindClass' ]( kind[ 'prefix' ] ) ).toBe( 'id-ref-kind-' + kind[ 'slug' ] )
            expect( client[ 'idRefKindOf' ]( kind[ 'prefix' ] )[ 'tint' ] ).toBe( kind[ 'tint' ] )
            expect( client[ 'idRefKindOf' ]( kind[ 'prefix' ] )[ 'label' ] ).toBe( kind[ 'label' ] )
        } )
    } )


    // AB-3: the undecidable case is not rendered as the harmless one.
    it( 'AB-3 — an unknown prefix gets the NEUTRAL row, different from all 14 named classes', () => {
        const unknownClass = client[ 'idRefKindClass' ]( UNKNOWN_PREFIX )
        const namedClasses = NAMED_KINDS.map( ( kind ) => 'id-ref-kind-' + kind[ 'slug' ] )

        expect( client[ 'idRefKindOf' ]( UNKNOWN_PREFIX ) ).toBe( null )
        expect( unknownClass ).toBe( 'id-ref-kind-other' )
        expect( namedClasses.length ).toBe( 14 )
        expect( namedClasses.indexOf( unknownClass ) ).toBe( -1 )
    } )


    // AB-2, stylesheet side: the declared colour and the rendered colour are one decision in two
    // files, so they are held against each other rather than trusted to agree.
    it( 'AB-2 — app.css carries the declared tint for every kind (15 rules compared)', () => {
        const missing = client[ 'ID_REF_KINDS' ]
            .map( ( kind ) => '#content .id-ref-kind-' + kind[ 'slug' ] + ' { background-color: ' + kind[ 'tint' ] + '; }' )
            .filter( ( rule ) => cssSource.indexOf( rule ) === -1 )

        expect( client[ 'ID_REF_KINDS' ].length ).toBe( 15 )
        expect( missing ).toEqual( [] )
    } )


    // The property split is the mechanism behind "ergaenzen, nicht ersetzen": the state rules must not
    // start writing background-color, or the kind channel would be overwritten by the state again.
    it( 'the state rules leave background-color alone (7 state rules compared)', () => {
        const stateRules = cssSource
            .split( '\n' )
            .filter( ( line ) => /#content (a\.)?\.?id-ref-(local|foreign|resolved|unresolved|ambiguous|no-carrier)/.test( line ) )
        const offenders = stateRules.filter( ( line ) => line.indexOf( 'background' ) !== -1 )

        expect( stateRules.length ).toBeGreaterThan( 6 )
        expect( offenders ).toEqual( [] )
    } )
} )


describe( 'PRD-17 — buildIdMark: the kind rides NEXT TO the state', () => {
    it( 'sets data-ref-prefix from the split token and keeps the state class (1 function compared)', () => {
        const marker = clientSource.indexOf( 'function buildIdMark(' )
        const body = clientSource.slice( marker, marker + 2600 )

        expect( marker ).toBeGreaterThan( -1 )
        expect( body ).toContain( "node.setAttribute( 'data-ref-prefix', entry.prefix )" )
        expect( body ).toContain( "node.setAttribute( 'data-ref-kind', kindRow.slug )" )
        expect( body ).toContain( "'id-ref id-ref-' + ( target === null && verdict.state === 'local' ? 'resolved' : verdict.state ) + ' ' + idRefKindClass( entry.prefix )" )
    } )


    it( 'data-ref-prefix exists at all — it was 0 occurrences before this order', () => {
        const hits = clientSource.split( 'data-ref-prefix' ).length - 1

        expect( hits ).toBeGreaterThan( 0 )
    } )
} )


describe( 'PRD-17 — the five evidence tags, SHOWN', () => {
    it( 'matches the independently written expectation row for row (5 rows compared)', () => {
        const actual = client[ 'EVIDENCE_MARK_KINDS' ].map( ( kind ) => ( { 'tag': kind[ 'tag' ], 'slug': kind[ 'slug' ], 'label': kind[ 'label' ], 'tint': kind[ 'tint' ] } ) )

        expect( actual.length ).toBe( 5 )
        expect( actual ).toEqual( EXPECTED_EVIDENCE )
    } )


    it( 'AB-5 — the display table covers EXACTLY EVIDENCE_TAGS (5 tags compared)', () => {
        const tags = client[ 'EVIDENCE_TAGS' ]
        const shown = client[ 'EVIDENCE_MARK_KINDS' ].map( ( kind ) => kind[ 'tag' ] )

        expect( tags.length ).toBe( 5 )
        expect( shown ).toEqual( tags )
    } )


    it( 'the 5 evidence tints are pairwise different (5 rows compared)', () => {
        const tints = client[ 'EVIDENCE_MARK_KINDS' ].map( ( kind ) => kind[ 'tint' ] )
        const distinct = tints.filter( ( tint, index ) => tints.indexOf( tint ) === index )

        expect( tints.length ).toBe( 5 )
        expect( distinct.length ).toBe( 5 )
    } )


    // One colour, one meaning — across BOTH families, not just inside each.
    it( 'no colour is used twice across both families (20 tints compared)', () => {
        const tints = client[ 'ID_REF_KINDS' ].map( ( kind ) => kind[ 'tint' ] )
            .concat( client[ 'EVIDENCE_MARK_KINDS' ].map( ( kind ) => kind[ 'tint' ] ) )
        const distinct = tints.filter( ( tint, index ) => tints.indexOf( tint ) === index )

        expect( tints.length ).toBe( 20 )
        expect( distinct.length ).toBe( 20 )
    } )


    EXPECTED_EVIDENCE.forEach( ( kind ) => {
        it( 'AB-5 — ' + kind[ 'tag' ] + ' renders as evidence-mark-' + kind[ 'slug' ], () => {
            expect( client[ 'evidenceMarkClass' ]( kind[ 'tag' ] ) ).toBe( 'evidence-mark evidence-mark-' + kind[ 'slug' ] )
            expect( client[ 'evidenceMarkKindOf' ]( kind[ 'tag' ] )[ 'tint' ] ).toBe( kind[ 'tint' ] )
        } )
    } )


    it( 'a tag the display table does not name falls to evidence-mark-other', () => {
        expect( client[ 'evidenceMarkKindOf' ]( 'GERAUNT' ) ).toBe( null )
        expect( client[ 'evidenceMarkClass' ]( 'GERAUNT' ) ).toBe( 'evidence-mark evidence-mark-other' )
    } )


    it( 'AB-5 — app.css carries the declared tint for every evidence mark (5 rules compared)', () => {
        const missing = client[ 'EVIDENCE_MARK_KINDS' ]
            .map( ( kind ) => '#content .evidence-mark-' + kind[ 'slug' ] + ' { background-color: ' + kind[ 'tint' ] + '; }' )
            .filter( ( rule ) => cssSource.indexOf( rule ) === -1 )

        expect( client[ 'EVIDENCE_MARK_KINDS' ].length ).toBe( 5 )
        expect( missing ).toEqual( [] )
    } )


    // AB-7: the pass does not change the text. Computed, not promised.
    it( 'AB-7 — splitEvidenceHits rejoins to the INPUT character for character (L = 283 > 0)', () => {
        const text = 'Der Messwert [GEMESSEN] steht neben der Ableitung [ABGELEITET]; die Annahme [ANNAHME] ist als solche '
            + 'gekennzeichnet, die Vermutung [VERMUTUNG] ebenso, und der Fakt [FAKT] bleibt ein Fakt. Klammern wie [XYZ] '
            + 'und Wortmarken wie ANNAHME ohne Klammern bleiben unberuehrt.'
        const split = client[ 'splitEvidenceHits' ]( text )
        const rejoined = split[ 'parts' ].map( ( part ) => part[ 'text' ] ).join( '' )

        expect( text.length ).toBeGreaterThan( 0 )
        expect( split[ 'sourceLength' ] ).toBe( text.length )
        expect( rejoined ).toBe( text )
        expect( rejoined.length ).toBe( text.length )
    } )


    it( 'AB-5 — splitEvidenceHits finds all five tags and names them (5 marks in a 5-tag text)', () => {
        const text = '[GEMESSEN] [FAKT] [ABGELEITET] [ANNAHME] [VERMUTUNG]'
        const split = client[ 'splitEvidenceHits' ]( text )

        expect( split[ 'comparedTags' ] ).toBe( 5 )
        expect( split[ 'marks' ] ).toBe( 5 )
        expect( split[ 'tags' ] ).toEqual( [ 'GEMESSEN', 'FAKT', 'ABGELEITET', 'ANNAHME', 'VERMUTUNG' ] )
        expect( split[ 'parts' ].filter( ( part ) => part[ 'kind' ] === 'mark' ).map( ( part ) => part[ 'text' ] ) )
            .toEqual( [ '[GEMESSEN]', '[FAKT]', '[ABGELEITET]', '[ANNAHME]', '[VERMUTUNG]' ] )
    } )


    // AB-6, and it runs the REAL counter: distributionOf( dimension 'evidence' ) reads textContent, and
    // a mark's textContent is its tag verbatim — so the count before and after must be identical.
    it( 'AB-6 — the REAL distributionOf counts the same before and after the pass (7 tag occurrences)', () => {
        const text = 'Ein [FAKT], ein zweiter [FAKT], ein [GEMESSEN], ein [ABGELEITET], zwei [ANNAHME] [ANNAHME] und ein [VERMUTUNG].'
        const split = client[ 'splitEvidenceHits' ]( text )
        const markedTextContent = split[ 'parts' ].map( ( part ) => part[ 'text' ] ).join( '' )
        const before = client[ 'distributionOf' ]( { 'body': [ { 'textContent': text } ], 'dimension': 'evidence' } )
        const after = client[ 'distributionOf' ]( { 'body': [ { 'textContent': markedTextContent } ], 'dimension': 'evidence' } )
        const total = before.reduce( ( sum, part ) => sum + part[ 'count' ], 0 )

        expect( total ).toBe( 7 )
        expect( split[ 'marks' ] ).toBe( 7 )
        expect( after ).toEqual( before )
    } )


    // The vacuum case, NAMED. "Nothing was marked" and "everything was marked" must not read alike.
    it( 'the vacuum case is NAMED: 0 marks over a tagless text, comparison set still 5 tags', () => {
        const split = client[ 'splitEvidenceHits' ]( 'Ein Satz ohne jede Evidenz-Marke, aber mit [Klammern] darin.' )

        expect( split[ 'marks' ] ).toBe( 0 )
        expect( split[ 'tags' ] ).toEqual( [] )
        expect( split[ 'comparedTags' ] ).toBe( 5 )
        expect( split[ 'parts' ].length ).toBe( 1 )
        expect( split[ 'parts' ][ 0 ][ 'kind' ] ).toBe( 'text' )
    } )


    it( 'the empty text answers a named zero, not an empty success (comparison set 5 tags)', () => {
        const split = client[ 'splitEvidenceHits' ]( '' )

        expect( split[ 'parts' ] ).toEqual( [] )
        expect( split[ 'marks' ] ).toBe( 0 )
        expect( split[ 'comparedTags' ] ).toBe( 5 )
        expect( split[ 'sourceLength' ] ).toBe( 0 )
    } )


    it( 'resolveEvidenceMarks reuses the identifier pass mechanics and names its zero (1 function compared)', () => {
        const marker = clientSource.indexOf( 'function resolveEvidenceMarks(' )
        const body = clientSource.slice( marker, clientSource.indexOf( '\n        }', marker ) )

        expect( marker ).toBeGreaterThan( -1 )
        expect( body ).toContain( 'CONTENT_SKIP_TAGS[ child.tagName ]' )
        expect( body ).toContain( 'isDiagramContainer( child )' )
        expect( body ).toContain( "child.classList.contains( 'evidence-mark' )" )
        expect( body ).toContain( 'no evidence tag in this document — nothing was marked' )
        expect( body ).toContain( 'comparedTags: EVIDENCE_TAGS.length' )
        expect( /\b(for|while)\s*\(/.test( body ) ).toBe( false )
    } )


    it( 'the pass runs at exactly ONE call point, next to the identifier pass (1 call site compared)', () => {
        const calls = clientSource.split( '\n' ).filter( ( line ) => line.trim() === 'resolveEvidenceMarks()' )

        expect( calls.length ).toBe( 1 )
        expect( clientSource.indexOf( 'resolveIdLinks( currentDocumentId )' ) ).toBeLessThan( clientSource.indexOf( '\n            resolveEvidenceMarks()' ) )
    } )
} )


describe( 'PRD-17 — ONE popup, typed content', () => {
    it( 'AB-9 — the REAL registration registers one renderer per NAMED kind (14 of 15 rows)', () => {
        expect( client[ 'registration' ][ 'registered' ] ).toBe( 14 )
        expect( client[ 'registration' ][ 'comparedKinds' ] ).toBe( 15 )
        expect( client[ 'registration' ][ 'prefixes' ] ).toEqual( NAMED_KINDS.map( ( kind ) => kind[ 'prefix' ] ) )
        expect( Object.keys( client[ 'idRefOverviewRenderers' ] ).length ).toBe( 14 )
    } )


    it( 'AB-9 — the seam is the ONLY registry: one declaration in the whole client (1 compared)', () => {
        const declarations = clientSource.split( 'var idRefOverviewRenderers = ' ).length - 1

        expect( declarations ).toBe( 1 )
    } )


    NAMED_KINDS.forEach( ( kind ) => {
        it( 'AB-4 — the popup for ' + kind[ 'prefix' ] + ' names the kind "' + kind[ 'label' ] + '"', () => {
            const entry = { 'token': kind[ 'prefix' ] + '-042', 'id': kind[ 'prefix' ] + '-042', 'prefix': kind[ 'prefix' ], 'scope': null, 'key': kind[ 'prefix' ] + '-042' }
            const html = client[ 'renderIdRefOverview' ]( OVERVIEW, entry )

            expect( html ).toContain( 'data-ref-kind="' + kind[ 'slug' ] + '"' )
            expect( html ).toContain( kind[ 'label' ] )
            expect( html ).toContain( 'data-ref-prefix="' + kind[ 'prefix' ] + '"' )
            expect( html ).not.toContain( 'data-ref-fallback' )
        } )
    } )


    // AB-4: typed means DIFFERENT. Identical content for two kinds would be a renderer that only
    // pretends to switch.
    it( 'AB-4 — all 14 named kinds render pairwise DIFFERENT bodies for the SAME overview (91 pairs)', () => {
        const bodies = NAMED_KINDS.map( ( kind ) => {
            const entry = { 'token': kind[ 'prefix' ] + '-042', 'id': kind[ 'prefix' ] + '-042', 'prefix': kind[ 'prefix' ], 'scope': null, 'key': kind[ 'prefix' ] + '-042' }

            return client[ 'renderIdRefOverview' ]( OVERVIEW, entry )
        } )
        const distinct = bodies.filter( ( body, index ) => bodies.indexOf( body ) === index )
        const pairs = ( bodies.length * ( bodies.length - 1 ) ) / 2

        expect( bodies.length ).toBe( 14 )
        expect( pairs ).toBe( 91 )
        expect( distinct.length ).toBe( 14 )
    } )


    it( 'a QUALIFIED reference names the item inside the foreign memo (1 reference compared)', () => {
        const entry = { 'token': 'M080-T096', 'id': 'T096', 'prefix': 'T', 'scope': 'M080', 'qualified': true, 'key': 'M080-T096' }
        const html = client[ 'renderIdRefOverview' ]( OVERVIEW, entry )

        expect( html ).toContain( 'Topic T096' )
        expect( html ).toContain( 'in Memo 080' )
    } )


    // AB-8: a fallback that does not say so is indistinguishable from an answer.
    it( 'AB-8 — the fallback renderer SAYS it is the general view (1 unknown kind compared)', () => {
        const entry = { 'token': UNKNOWN_PREFIX + '-001', 'id': UNKNOWN_PREFIX + '-001', 'prefix': UNKNOWN_PREFIX, 'scope': null, 'key': UNKNOWN_PREFIX + '-001' }
        const html = client[ 'renderIdRefOverview' ]( OVERVIEW, entry )

        expect( html ).toContain( 'data-ref-fallback="true"' )
        expect( html ).toContain( 'unbekannte Art' )
        expect( html ).toContain( 'keine eigene Darstellung' )
        expect( html ).toContain( 'allgemeine Uebersicht' )
    } )


    it( 'AB-8 — the fallback still shows the GENERIC body, unchanged (1 body compared)', () => {
        const entry = { 'token': UNKNOWN_PREFIX + '-001', 'id': UNKNOWN_PREFIX + '-001', 'prefix': UNKNOWN_PREFIX, 'scope': null, 'key': UNKNOWN_PREFIX + '-001' }
        const html = client[ 'renderIdRefOverview' ]( OVERVIEW, entry )
        const generic = client[ 'idRefOverviewBody' ]( OVERVIEW )

        expect( generic.length ).toBeGreaterThan( 0 )
        expect( html ).toContain( generic )
    } )


    it( 'a typed renderer also keeps the generic body, so nothing is lost by typing it (14 kinds)', () => {
        const generic = client[ 'idRefOverviewBody' ]( OVERVIEW )
        const missing = NAMED_KINDS.filter( ( kind ) => {
            const entry = { 'token': kind[ 'prefix' ] + '-042', 'id': kind[ 'prefix' ] + '-042', 'prefix': kind[ 'prefix' ], 'scope': null, 'key': kind[ 'prefix' ] + '-042' }

            return client[ 'renderIdRefOverview' ]( OVERVIEW, entry ).indexOf( generic ) === -1
        } )

        expect( NAMED_KINDS.length ).toBe( 14 )
        expect( missing ).toEqual( [] )
    } )


    it( 'a non-ok overview keeps its NAMED state through the typed head (1 state compared)', () => {
        const entry = { 'token': 'T099', 'id': 'T099', 'prefix': 'T', 'scope': null, 'key': 'T099' }
        const html = client[ 'renderIdRefOverview' ]( { 'state': 'unknown-document', 'note': 'Diese Kennung kennt der Katalog nicht.', 'documentId': 'x', 'reason': 'not-in-catalogue' }, entry )

        expect( html ).toContain( 'Topic T099' )
        expect( html ).toContain( 'Diese Kennung kennt der Katalog nicht.' )
    } )
} )
