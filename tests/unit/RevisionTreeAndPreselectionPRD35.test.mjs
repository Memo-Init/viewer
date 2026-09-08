import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { extractFunctions } from '../helpers/extractFunction.mjs'


// PRD-35 (Memo 081, Kap 19 + Kap 29 — WI-070 / WI-025): what the tree hides, and what the
// recommendation quietly clicks.
//
// WI-070: the sidebar tree dropped every non-full revision without printing a digit. Measured on this
// project's stock before the change: 13 of 27 registered revisions of memo 081 were unreachable (11
// prepare, 2 update), and 184 of 524 over the whole corpus (35.1 %). Only 2 of those 13 were update
// revisions — so the subject was never the revision TYPE, it was the SILENT filtering.
// WI-025: `preselected` answered two questions at once ("what did the author choose?" and "what does
// the AI recommend?"), so the recommendation walked into the widget's selection state. Measured before
// the change: 1335 of 4046 parsed questions carried a selection nobody clicked (33.0 %).
//
// Every case here states its comparison basis, and every case that asserts a zero measures a non-zero
// out of the same apparatus — a check that reports "0 derived preselections" without showing that an
// artificially built derivation IS found has not measured, it has kept quiet.
//
// Repo boundary: this file reads nothing outside the repo. Revision fixtures are written into the
// repo-internal .test-tmp/ and removed afterwards; CI checks this repo out alone.
describe( 'PRD-35 A1/T-A..T-C — the revision count names its own basis', () => {
    it( 'T-A — registered equals the sum over byType, and an absent type stands as 0 (3 types checked)', () => {
        const counts = DocumentRegistry.revisionCounts( {
            'registered': 5,
            'byType': { 'full': 3, 'update': 2, 'prepare': 0 },
            'source': 'scan',
            'countedIn': '/somewhere/revisions',
            'note': null
        } )

        expect( counts[ 'registered' ] ).toBe( 5 )
        expect( Object.keys( counts[ 'byType' ] ).sort() ).toEqual( [ 'full', 'prepare', 'update' ] )
        expect( counts[ 'byType' ][ 'prepare' ] ).toBe( 0 )
        expect( counts[ 'byType' ][ 'full' ] + counts[ 'byType' ][ 'update' ] + counts[ 'byType' ][ 'prepare' ] ).toBe( counts[ 'registered' ] )
        expect( counts[ 'basis' ] ).toBe( true )
        expect( counts[ 'comparison' ][ 'source' ] ).toBe( 'scan' )
    } )


    it( 'T-B — it THROWS on an unknown source, on a negative number and on a balance that does not add up (3 cases)', () => {
        const base = { 'registered': 1, 'byType': { 'full': 1, 'update': 0, 'prepare': 0 }, 'source': 'scan', 'countedIn': null, 'note': null }

        expect( () => DocumentRegistry.revisionCounts( { ...base, 'source': 'guessed' } ) ).toThrow( /source must be one of/ )
        expect( () => DocumentRegistry.revisionCounts( { ...base, 'registered': -1, 'byType': { 'full': -1, 'update': 0, 'prepare': 0 } } ) ).toThrow( /registered must be an integer/ )
        expect( () => DocumentRegistry.revisionCounts( { ...base, 'registered': 4 } ) ).toThrow( /does not equal the sum over byType/ )

        // Positive control to the three throws: the same call WITHOUT the defect returns. Without this
        // line a method that threw on everything would pass all three assertions above.
        expect( DocumentRegistry.revisionCounts( base )[ 'registered' ] ).toBe( 1 )
    } )


    it( 'T-C — the undeclared shape says "not counted", not "counted zero"', () => {
        const undeclared = DocumentRegistry.undeclaredRevisionCounts()
        const counted = DocumentRegistry.revisionCounts( { 'registered': 0, 'byType': { 'full': 0, 'update': 0, 'prepare': 0 }, 'source': 'scan', 'countedIn': '/x', 'note': null } )

        expect( undeclared[ 'basis' ] ).toBe( false )
        expect( undeclared[ 'comparison' ][ 'source' ] ).toBe( 'none' )
        expect( undeclared[ 'registered' ] ).toBe( 0 )
        // The two objects carry the SAME zero and make different statements — that difference is the
        // whole point, and a payload that collapses them has lost exactly the case that needed seeing.
        expect( counted[ 'registered' ] ).toBe( 0 )
        expect( counted[ 'basis' ] ).toBe( true )
        expect( undeclared[ 'basis' ] ).not.toBe( counted[ 'basis' ] )
    } )
} )


describe( 'PRD-35 A1/A7/T-D..T-F — the tree ships the set, and both filters declare themselves', () => {
    let root = ''
    let mixedPath = ''
    let fullOnlyPath = ''
    let registry = null


    beforeAll( async () => {
        // Test isolation: write ONLY into the repo-internal .test-tmp/, never .memo/ and never the home.
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'revtree-' ) )
        mixedPath = join( root, '901-mixed', 'revisions' )
        fullOnlyPath = join( root, '902-full-only', 'revisions' )
        await mkdir( mixedPath, { recursive: true } )
        await mkdir( fullOnlyPath, { recursive: true } )
        await writeFile( join( mixedPath, 'REV-01.md' ), '# eins\n', 'utf8' )
        await writeFile( join( mixedPath, 'REV-02.md' ), '# zwei\n', 'utf8' )
        await writeFile( join( mixedPath, 'REV-02-update.md' ), '# zwei update\n', 'utf8' )
        await writeFile( join( mixedPath, 'REV-03-prepare.md' ), '# drei prepare\n', 'utf8' )
        await writeFile( join( fullOnlyPath, 'REV-01.md' ), '# eins\n', 'utf8' )
        await writeFile( join( fullOnlyPath, 'REV-02.md' ), '# zwei\n', 'utf8' )

        const created = DocumentRegistry.create( { 'onChange': null } )
        registry = created[ 'registry' ]
        await registry.addDocument( { 'projectId': 'prd35', 'memoPath': mixedPath } )
        await registry.addDocument( { 'projectId': 'prd35', 'memoPath': fullOnlyPath } )
    } )


    afterAll( async () => {
        registry.getDocuments()[ 'documents' ]
            .forEach( ( doc ) => registry.removeDocument( { 'documentId': doc[ 'documentId' ] } ) )
        await rm( root, { 'recursive': true, 'force': true } )
    } )


    const memosOf = () => {
        const { tree } = registry.getDocumentTree()

        return Object.keys( tree )
            .flatMap( ( projectId ) => tree[ projectId ][ 'memos' ] )
    }


    it( 'T-D — every document carries revisionCounts, and registered matches its own revisions list (2 documents)', () => {
        const memos = memosOf()

        expect( memos.length ).toBe( 2 )
        memos
            .forEach( ( doc ) => {
                expect( doc[ 'revisionCounts' ][ 'registered' ] ).toBe( doc[ 'revisions' ].length )
                expect( doc[ 'revisionCounts' ][ 'basis' ] ).toBe( true )
                expect( doc[ 'revisionCounts' ][ 'comparison' ][ 'source' ] ).toBe( 'scan' )
            } )

        const mixed = memos.find( ( doc ) => doc[ 'documentId' ].endsWith( '901-mixed' ) )
        expect( mixed[ 'revisionCounts' ][ 'registered' ] ).toBe( 4 )
        expect( mixed[ 'revisionCounts' ][ 'byType' ] ).toEqual( { 'full': 2, 'update': 1, 'prepare': 1 } )

        // The tree itself filters NOTHING — that is the contract the hidden-count row leans on.
        expect( mixed[ 'revisions' ].length ).toBe( 4 )
    } )


    it( 'T-E — the client partition is complete in BOTH directions (4 revisions, filter on and off)', async () => {
        const { partitionRevisionsByConfigFilter, hiddenRevisionsLabel } = await extractFunctions( [ 'revisionPassesConfigFilter', 'partitionRevisionsByConfigFilter', 'hiddenRevisionsLabel' ] )
        const revisions = memosOf()
            .find( ( doc ) => doc[ 'documentId' ].endsWith( '901-mixed' ) )[ 'revisions' ]

        globalThis.window = { '__MEMO_CONFIG__': { 'showOnlyFullRevisions': true } }
        const on = partitionRevisionsByConfigFilter( revisions )

        expect( on[ 'considered' ] ).toBe( 4 )
        expect( on[ 'kept' ].length + on[ 'hidden' ].length ).toBe( 4 )
        expect( on[ 'hidden' ].length ).toBe( 2 )
        expect( Object.keys( on[ 'byType' ] ).reduce( ( sum, key ) => sum + on[ 'byType' ][ key ], 0 ) ).toBe( on[ 'hidden' ].length )
        expect( hiddenRevisionsLabel( on ) ).toBe( '2 ausgeblendet (1 prepare, 1 update)' )

        // Vacuum bolt: the SAME apparatus with the filter off must hide nothing. Without this the
        // partition could be a function that always reports two hidden entries.
        globalThis.window = { '__MEMO_CONFIG__': { 'showOnlyFullRevisions': false } }
        const off = partitionRevisionsByConfigFilter( revisions )

        expect( off[ 'hidden' ].length ).toBe( 0 )
        expect( off[ 'kept' ].length ).toBe( 4 )

        // And a document that carries only full revisions hides nothing even with the filter ON —
        // otherwise a row that always appears is indistinguishable from one that means something.
        globalThis.window = { '__MEMO_CONFIG__': { 'showOnlyFullRevisions': true } }
        const fullOnly = partitionRevisionsByConfigFilter( memosOf().find( ( doc ) => doc[ 'documentId' ].endsWith( '902-full-only' ) )[ 'revisions' ] )

        expect( fullOnly[ 'considered' ] ).toBe( 2 )
        expect( fullOnly[ 'hidden' ].length ).toBe( 0 )

        delete globalThis.window
    } )


    it( 'T-F — getLatestRevisions reports what it held its rule against (6 revisions considered)', () => {
        const { latest, comparison } = registry.getLatestRevisions( { 'limit': 10 } )

        expect( comparison[ 'considered' ] ).toBe( 6 )
        expect( comparison[ 'considered' ] ).toBe( comparison[ 'kept' ] + comparison[ 'removed' ] )
        expect( comparison[ 'filter' ] ).toBe( 'full-or-update' )
        // The rule stays DIFFERENT from the tree's on purpose: it keeps the update revision, the tree
        // hides it. The defect was never the difference, it was that neither said it was selecting.
        expect( comparison[ 'kept' ] ).toBe( 5 )
        expect( comparison[ 'removed' ] ).toBe( 1 )
        expect( latest.length ).toBe( 5 )
    } )


    it( 'A-Extra — the auto-select fallback follows a NAMED rule and skips what it cannot open (3 documents)', async () => {
        // The Pflicht-Gegenstand of this order: `documents[ 0 ]` was a preselection without a rule —
        // the position belongs to whichever registration won the Promise.all race, and in the real
        // stock it carried no revision, so the branch fired in 0 of 385 sockets.
        const emptyPath = join( root, '903-empty', 'revisions' )
        await mkdir( emptyPath, { recursive: true } )
        await registry.addDocument( { 'projectId': 'prd35', 'memoPath': emptyPath } )

        const target = registry.resolveAutoSelectTarget()

        expect( target[ 'status' ] ).toBe( true )
        expect( target[ 'rule' ] ).toBe( 'newest-active-document-with-revision' )
        expect( target[ 'considered' ] ).toBe( 3 )
        expect( target[ 'skipped' ] ).toBe( 1 )
        expect( target[ 'documentId' ].endsWith( '903-empty' ) ).toBe( false )
        expect( typeof target[ 'fileName' ] ).toBe( 'string' )

        // Vacuum bolt: a registry that holds ONLY unopenable documents reports status false WITH a
        // reason and a comparison basis — never a silent pick.
        const { registry: onlyEmpty } = DocumentRegistry.create( { 'onChange': null } )
        const lonelyPath = join( root, '904-only-empty', 'revisions' )
        await mkdir( lonelyPath, { recursive: true } )
        await onlyEmpty.addDocument( { 'projectId': 'prd35', 'memoPath': lonelyPath } )
        const none = onlyEmpty.resolveAutoSelectTarget()

        expect( none[ 'status' ] ).toBe( false )
        expect( none[ 'considered' ] ).toBe( 1 )
        expect( none[ 'skipped' ] ).toBe( 1 )
        expect( none[ 'reason' ] ).toContain( '1 registrierten' )
        onlyEmpty.getDocuments()[ 'documents' ]
            .forEach( ( doc ) => onlyEmpty.removeDocument( { 'documentId': doc[ 'documentId' ] } ) )
    } )
} )


describe( 'PRD-35 A3/T-G..T-I — display and selection are two fields', () => {
    const jsonOf = ( entries ) => {
        const content = '```questions-json\n' + JSON.stringify( entries ) + '\n```'

        return DocumentRegistry.parseQuestionJsonBlock( { content } )[ 'questions' ]
    }

    const markdownOf = ( body ) => {
        const content = [ '## Offene Fragen', '', '### F1 — T', '', body ].join( '\n' )

        return DocumentRegistry.parseQuestionSchema( { content } )[ 'questions' ]
    }

    const threeOptions = [
        { 'key': 'A', 'label': 'Erste', 'kind': 'option' },
        { 'key': 'B', 'label': 'Zweite', 'kind': 'option' },
        { 'key': 'C', 'label': 'Dritte', 'kind': 'option' }
    ]


    it( 'T-G — json WITHOUT an explicit field: the recommendation lands in aiRecommended, never in preselected', () => {
        const [ question ] = jsonOf( [ { 'id': 'F1', 'frage': 'Was tun?', 'aiRecommendation': 'Option C — weil', 'typ': 'single', 'options': threeOptions, 'answered': false } ] )

        expect( question[ 'preselected' ] ).toEqual( [] )
        expect( question[ 'aiRecommended' ] ).toEqual( [ 2 ] )
    } )


    it( 'T-H — json WITH an explicit field: the author decision survives the split unchanged', () => {
        const [ question ] = jsonOf( [ { 'id': 'F1', 'frage': 'Was tun?', 'aiRecommendation': 'A', 'typ': 'single', 'preselected': [ 1 ], 'options': threeOptions, 'answered': false } ] )

        expect( question[ 'preselected' ] ).toEqual( [ 1 ] )
        // and the recommendation is still computed beside it — the two no longer compete for one field.
        expect( question[ 'aiRecommended' ] ).toEqual( [ 0 ] )
    } )


    it( 'T-I — markdown: the path that never had a way out now has one (2 forms checked)', () => {
        const [ single ] = markdownOf( '**AI-Empfehlung:** Option C\n\nA) a B) b C) c' )
        const [ multi ] = markdownOf( '**Typ:** multi\n**AI-Empfehlung:** A+B\n\nA) a B) b C) c' )

        expect( single[ 'preselected' ] ).toEqual( [] )
        expect( single[ 'aiRecommended' ] ).toEqual( [ 2 ] )
        expect( multi[ 'preselected' ] ).toEqual( [] )
        expect( multi[ 'aiRecommended' ] ).toEqual( [ 0, 1 ] )

        // Vacuum bolt: an unmatchable recommendation yields an EMPTY aiRecommended out of the same
        // apparatus, so the two assertions above measure a derivation rather than a constant.
        const [ none ] = markdownOf( '**AI-Empfehlung:** keine klare Wahl\n\nA) a B) b' )
        expect( none[ 'aiRecommended' ] ).toEqual( [] )
        expect( none[ 'preselected' ] ).toEqual( [] )
    } )
} )


describe( 'PRD-35 A4/T-J..T-L — the three displays and the provenance chain survive', () => {
    const optionsOf = () => [
        { 'kind': 'option', 'key': 'A', 'label': 'Eins' },
        { 'kind': 'option', 'key': 'B', 'label': 'Zwei' },
        { 'kind': 'option', 'key': 'C', 'label': 'Drei' }
    ]


    it( 'T-J — a recommendation seeds NO selection, and an explicit one still does (2 questions)', async () => {
        const { seedQuestionState } = await extractFunctions( [ 'seedQuestionState' ] )
        const recommended = { 'id': 'F1', 'typ': 'single', 'options': optionsOf(), 'preselected': [], 'aiRecommended': [ 0 ] }
        const chosen = { 'id': 'F2', 'typ': 'single', 'options': optionsOf(), 'preselected': [ 0 ], 'aiRecommended': [ 0 ] }

        const state = seedQuestionState( [ recommended, chosen ], {} )

        expect( state[ 0 ].selected ).toEqual( [] )
        expect( state[ 0 ].touched ).toBe( false )
        // Positive control: without it, "0 preselections" would also be reported by a function that
        // simply does nothing.
        expect( state[ 1 ].selected ).toEqual( [ 0 ] )
        expect( state[ 1 ].touched ).toBe( false )
    } )


    it( 'T-K — the recommendation display finds the hard cases the client fallback misses (6 forms)', () => {
        const options = optionsOf()
        const parse = ( recommendation ) => {
            const content = '```questions-json\n' + JSON.stringify( [ { 'id': 'F1', 'frage': 'Was?', 'aiRecommendation': recommendation, 'typ': 'single', 'options': options, 'answered': false } ] ) + '\n```'

            return DocumentRegistry.parseQuestionJsonBlock( { content } )[ 'questions' ][ 0 ]
        }
        const clientFallback = ( text ) => {
            const match = String( text ).match( /^([A-H])\b/ )

            return match === null ? -1 : options.findIndex( ( o ) => o[ 'kind' ] === 'option' && o[ 'key' ] === match[ 1 ] )
        }

        // Measured over the whole corpus: 1390 single questions carry a non-empty recommendation, the
        // client regex recovers 1252 and loses 138 (9.9 %). Of those 138, 97 read "Option X …" and 37
        // are other separator-led forms. These three are that set.
        const hard = [ 'Option C — weil', '(C) weil', 'Variante C — weil' ]
        const easy = [ 'C — weil', 'C' ]

        hard
            .forEach( ( text ) => {
                expect( parse( text )[ 'aiRecommended' ] ).toEqual( [ 2 ] )
                expect( clientFallback( text ) ).toBe( -1 )
            } )
        easy
            .forEach( ( text ) => {
                expect( parse( text )[ 'aiRecommended' ] ).toEqual( [ 2 ] )
                expect( clientFallback( text ) ).toBe( 2 )
            } )

        // A form NEITHER side resolves, pinned as a finding rather than left as folklore: the PRD names
        // "**A** — …" among the cases the server derivation recovers, and it does not — the anchor
        // pattern needs a separator or "Option " before the key, and `*` is neither. Such a card shows
        // no recommendation marker at all, before and after this change alike. Unchanged behaviour,
        // written down so the next reader measures it instead of believing the example.
        expect( parse( '**C** — weil' )[ 'aiRecommended' ] ).toEqual( [] )
        expect( clientFallback( '**C** — weil' ) ).toBe( -1 )
    } )


    it( 'T-L — isPreselectionAnswer reads the recommendation, in both directions and both payload ages', async () => {
        const { isPreselectionAnswer, answerMarkSuffix } = await extractFunctions( [ 'isPreselectionAnswer', 'answerMarkSuffix' ], [ 'REFORMULATION_KINDS' ] )
        const question = { 'id': 'F1', 'typ': 'single', 'title': 'T', 'options': optionsOf(), 'preselected': [], 'aiRecommended': [ 0 ] }
        const stateWith = ( selected ) => ( { 'selected': selected, 'custom': [], 'added': false, 'addedText': null, 'rejected': false, 'touched': true } )

        expect( isPreselectionAnswer( question, stateWith( [ 0 ] ) ) ).toBe( true )
        expect( isPreselectionAnswer( question, stateWith( [ 1 ] ) ) ).toBe( false )
        expect( answerMarkSuffix( question, stateWith( [ 0 ] ) ) ).toBe( ' [Vorauswahl]' )
        // An empty recommendation is never a match — nothing was recommended to agree with.
        expect( isPreselectionAnswer( { ...question, 'aiRecommended': [] }, stateWith( [ 0 ] ) ) ).toBe( false )
        // Older payload (no aiRecommended field at all): the previous reading still applies, so an
        // older server build does not silently zero the provenance column.
        expect( isPreselectionAnswer( { 'id': 'F1', 'typ': 'single', 'options': optionsOf(), 'preselected': [ 0 ] }, stateWith( [ 0 ] ) ) ).toBe( true )
    } )
} )
