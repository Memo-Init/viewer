import { describe, it, expect, afterEach } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { VALID_OPTION_KINDS, isRenderable } from '../../src/QuestionContract.mjs'
import { extractFunctions, readEmittedScript } from '../helpers/extractFunction.mjs'


// Memo 080, PRD-F2 (REV-18 Kap 18, T070) — "Antwortmoeglichkeiten neu formulieren".
//
// The user's own diagnosis: "Es gibt 'Frage neu formulieren'. Aber oftmals ist es nicht die Frage, die
// falsch ist, sondern DIE ANTWORTMOEGLICHKEITEN. Das ist das Hauptproblem, was ich oftmals mit dir habe."
// The third injected default does not fit that case — it signals a false premise of the QUESTION. So a
// FOURTH default joins it: `reoption`. It changes no status, it is never pre-selected, it does not count
// toward the render minimum, and the reason the user types is journalled with the discarded option set.
//
// This file covers the VIEWER half (A1-A3, A10, A11, R3). The DB half — the appending journal row, the
// mandatory reason, the discarded set in its own column and the semantic gate (A4-A9, R1, R2) — lives at
// the WRITE, in repos/core (MemoContentStore.test.mjs), because a gate nobody calls refuses nothing and
// the only caller of that gate is the writer of the event.
//
// EVERY case below states how much it compared: a count of 0 is red, not green.
describe( 'Memo 080 PRD-F2 — the fourth injected default: re-formulate the ANSWER OPTIONS', () => {
    const clientPath = () => join( dirname( fileURLToPath( import.meta.url ) ), '..', '..', 'src', 'public', 'app.client.mjs' )

    const savedDocument = globalThis.document
    const savedQuestionNav = globalThis.questionNav
    const savedSetAddButtonState = globalThis.setAddButtonState
    const savedUpdateSaveAnswersOnlyState = globalThis.updateSaveAnswersOnlyState
    // PRD-31 (Memo 081, WI-118): harvestReformulationInputs joins the persistence seam at its end, so
    // the lifted function needs that collaborator stubbed like the two above.
    const savedPersistQuestionState = globalThis.persistQuestionState


    afterEach( () => {
        globalThis.document = savedDocument
        globalThis.questionNav = savedQuestionNav
        globalThis.setAddButtonState = savedSetAddButtonState
        globalThis.updateSaveAnswersOnlyState = savedUpdateSaveAnswersOnlyState
        globalThis.persistQuestionState = savedPersistQuestionState
    } )


    // The four injected defaults, in the ONE order both parse paths must produce.
    const INJECTED = [
        { key: 'custom', label: 'ablehnen', kind: 'custom' },
        { key: 'topic', label: 'Über das Topic springen', kind: 'topic' },
        { key: 'reframe', label: 'Frage neu formulieren', kind: 'reframe' },
        { key: 'reoption', label: 'Antwortmoeglichkeiten neu formulieren', kind: 'reoption' }
    ]

    const jsonAuthored = () => {
        const content = '```questions-json\n' + JSON.stringify( [ {
            'id': 'F21',
            'title': 'Umfang',
            'frage': 'Welchen Umfang bauen wir?',
            'aiRecommendation': 'A — alles bauen',
            'typ': 'single',
            'options': [
                { 'key': 'A', 'label': 'Alles bauen', 'kind': 'option' },
                { 'key': 'B', 'label': 'Nur den Kern bauen', 'kind': 'option' }
            ],
            'answered': false
        } ] ) + '\n```'

        return DocumentRegistry.parseQuestionJsonBlock( { content } )
    }

    const markdownAuthored = () => {
        const content = [
            '## Offene Fragen',
            '',
            '### F21 — Umfang',
            '',
            '- **Hintergrund:** Der Umfang ist offen.',
            '- **Frage:** Welchen Umfang bauen wir?',
            'A) Alles bauen',
            'B) Nur den Kern bauen',
            '- **AI-Empfehlung:** A — alles bauen',
            ''
        ].join( '\n' )

        return DocumentRegistry.parseQuestionSchema( { content } )
    }


    it( 'A1 — the render contract knows exactly five option kinds, and the new one is a NON-option kind', () => {
        expect( VALID_OPTION_KINDS ).toEqual( [ 'option', 'custom', 'topic', 'reframe', 'reoption' ] )
        expect( VALID_OPTION_KINDS.length ).toBe( 5 )

        // R1 first half: `reoption` does NOT count toward the two-real-option render minimum. A question
        // whose only real choice is one option plus the four defaults stays UNRENDERABLE.
        const thin = {
            id: 'F21',
            frage: 'Welchen Umfang bauen wir?',
            aiRecommendation: 'A',
            typ: 'single',
            options: [ { key: 'A', label: 'Alles bauen', kind: 'option' } ].concat( INJECTED )
        }
        expect( thin.options.length ).toBe( 5 )
        expect( isRenderable( { question: thin } ) ).toBe( false )

        // GEGENPROBE: a SECOND real option makes the very same card renderable — it is the kind that
        // counts, never the number of entries.
        const full = Object.assign( {}, thin, { options: [
            { key: 'A', label: 'Alles bauen', kind: 'option' },
            { key: 'B', label: 'Nur den Kern bauen', kind: 'option' }
        ].concat( INJECTED ) } )
        expect( isRenderable( { question: full } ) ).toBe( true )
    } )


    it( 'A2/A11 — BOTH parse paths end on the same four defaults, in the same order, with the same labels', () => {
        const paths = [
            { name: 'questions-json', questions: jsonAuthored().questions },
            { name: 'markdown', questions: markdownAuthored().questions }
        ]
        expect( paths.length ).toBe( 2 )

        const tails = paths
            .map( ( entry ) => {
                expect( entry.questions.length ).toBe( 1 )
                const options = entry.questions[ 0 ][ 'options' ]

                return { name: entry.name, tail: options.slice( options.length - INJECTED.length ) }
            } )
        // A11: the three PRE-EXISTING defaults keep their key, their label AND their position — the new
        // one is appended BEHIND them, it does not reorder anything.
        tails
            .forEach( ( entry ) => {
                expect( entry.tail.map( ( o ) => o[ 'key' ] ) ).toEqual( INJECTED.map( ( o ) => o.key ) )
                expect( entry.tail.map( ( o ) => o[ 'label' ] ) ).toEqual( INJECTED.map( ( o ) => o.label ) )
                expect( entry.tail.map( ( o ) => o[ 'kind' ] ) ).toEqual( INJECTED.map( ( o ) => o.kind ) )
            } )
        // and the two paths are MIRRORS: a default that reaches only one of them would hand the user a
        // different answer set depending on how the revision happened to be written.
        expect( tails[ 0 ].tail ).toEqual( tails[ 1 ].tail )
    } )


    it( 'A3/R3 — the new kind is never PRE-SELECTED, on either path, and it decides nothing for the user', () => {
        const cases = [
            { name: 'questions-json', question: jsonAuthored().questions[ 0 ] },
            { name: 'markdown', question: markdownAuthored().questions[ 0 ] }
        ]
        expect( cases.length ).toBe( 2 )

        const compared = cases
            .map( ( entry ) => {
                const options = entry.question[ 'options' ]
                const preselected = entry.question[ 'preselected' ]
                const nonOptionIndexes = options
                    .map( ( option, index ) => ( option[ 'kind' ] === 'option' ? -1 : index ) )
                    .filter( ( index ) => index !== -1 )

                // the AI recommendation names A, so the recommendation IS resolved — the case is not
                // vacuously true because nothing was pre-selected at all.
                expect( preselected.length ).toBeGreaterThan( 0 )
                expect( nonOptionIndexes.length ).toBe( INJECTED.length )
                nonOptionIndexes
                    .forEach( ( index ) => expect( preselected ).not.toContain( index ) )

                return nonOptionIndexes.length
            } )
        expect( compared ).toEqual( [ 4, 4 ] )

        // R3, second half: the presence of the new default changes NO status. Both paths still read the
        // question as open, exactly as they did with three defaults.
        cases
            .forEach( ( entry ) => {
                expect( entry.question[ 'status' ] ).toBe( 'open' )
                expect( entry.question[ 'answered' ] ).toBe( false )
            } )
    } )


    it( 'A10 — the reason free-text row is built, revealed only while `reoption` is selected, and harvested', async () => {
        const src = await readEmittedScript()

        // (a) the row is DECLARED with its own attribute and its own prompt, next to the reframe row —
        // one list, so build, reveal and harvest can never know different sets of rows.
        expect( src ).toContain( "{ kind: 'reoption', attribute: 'data-reoption-row', placeholder: 'Was stimmt an den Antwortmoeglichkeiten nicht?' }" )
        expect( src ).toContain( "{ kind: 'reframe', attribute: 'data-reframe-row', placeholder: 'Wie sollte die Frage richtig lauten?' }" )

        // (b) the reveal reads the SAME list — no per-kind branch survives in refreshOptionMarkers.
        expect( src ).toContain( 'reformulationRowsOf( q.options ).forEach' )
        expect( src.indexOf( "card.querySelector( '.qw-custom-row[data-reframe-row=\"1\"]' )" ) ).toBe( -1 )

        // (c) hidden unless its own option is selected — driven, not read.
        const { reformulationRowsOf } = await extractFunctions( [ 'reformulationRowsOf' ], [ 'REFORMULATION_KINDS' ] )
        const options = [ { kind: 'option', key: 'A', label: 'Alles bauen' }, { kind: 'option', key: 'B', label: 'Nur den Kern' } ].concat( INJECTED )
        const rows = reformulationRowsOf( options )
        expect( rows.map( ( row ) => row.kind ) ).toEqual( [ 'reframe', 'reoption' ] )
        expect( rows.map( ( row ) => row.idx ) ).toEqual( [ 4, 5 ] )
        // a question WITHOUT the defaults gets no re-formulation row at all (nothing to reveal).
        expect( reformulationRowsOf( [ { kind: 'option', key: 'A', label: 'Alles' } ] ) ).toEqual( [] )
    } )


    it( 'A10 — a typed-but-not-Entered reason is harvested before the answer is built (no Enter needed)', async () => {
        const { harvestReformulationInputs, buildAnswerText } = await extractFunctions( [ 'harvestReformulationInputs', 'buildAnswerText', 'markQuestionTouched', 'answerMarkSuffix', 'isPreselectionAnswer' ], [ 'REFORMULATION_KINDS' ] )

        // a fake card that carries BOTH rows, each with its own input — the reoption one holds the typed
        // reason, the reframe one is empty (the user did not take that turn).
        const reoptionInput = { value: '  Es fehlt die Option, den Umfang kleiner zu machen  ' }
        const reframeInput = { value: '' }
        const card = { querySelector: ( sel ) => {
            if( sel.indexOf( 'data-reoption-row' ) !== -1 ) { return reoptionInput }
            if( sel.indexOf( 'data-reframe-row' ) !== -1 ) { return reframeInput }

            return null
        } }
        globalThis.document = { querySelector: ( sel ) => ( sel.includes( 'qw-card' ) ? card : null ) }
        globalThis.setAddButtonState = () => {}
        globalThis.updateSaveAnswersOnlyState = () => {}
        globalThis.persistQuestionState = () => {}
        globalThis.questionNav = { state: [ { selected: [ 5 ], custom: [], added: false } ] }

        harvestReformulationInputs( 0 )

        expect( globalThis.questionNav.state[ 0 ].custom ).toEqual( [ 'Es fehlt die Option, den Umfang kleiner zu machen' ] )
        expect( reoptionInput.value ).toBe( '' )

        // and the harvested reason survives into the answer line of a SINGLE-select — the "first part
        // only" rule must not drop it, exactly as it must not drop a reframe reformulation.
        const q = {
            id: 'F21',
            title: 'Umfang',
            typ: 'single',
            options: [ { kind: 'option', key: 'A', label: 'Alles bauen' }, { kind: 'option', key: 'B', label: 'Nur den Kern' } ].concat( INJECTED )
        }
        const built = buildAnswerText( q, globalThis.questionNav.state[ 0 ] )
        expect( built.answerLine ).toBe( 'Antwortmoeglichkeiten neu formulieren; Es fehlt die Option, den Umfang kleiner zu machen' )
    } )


    it( 'A11 — the reframe turn is UNTOUCHED: same label, same prompt, same folded answer', async () => {
        const { harvestReformulationInputs, buildAnswerText } = await extractFunctions( [ 'harvestReformulationInputs', 'buildAnswerText', 'markQuestionTouched', 'answerMarkSuffix', 'isPreselectionAnswer' ], [ 'REFORMULATION_KINDS' ] )

        const reframeInput = { value: 'Wie gross soll der Umfang maximal sein?' }
        const card = { querySelector: ( sel ) => ( sel.indexOf( 'data-reframe-row' ) !== -1 ? reframeInput : null ) }
        globalThis.document = { querySelector: ( sel ) => ( sel.includes( 'qw-card' ) ? card : null ) }
        globalThis.setAddButtonState = () => {}
        globalThis.updateSaveAnswersOnlyState = () => {}
        globalThis.persistQuestionState = () => {}
        globalThis.questionNav = { state: [ { selected: [ 4 ], custom: [], added: false } ] }

        harvestReformulationInputs( 0 )
        const q = {
            id: 'F21',
            title: 'Umfang',
            typ: 'single',
            options: [ { kind: 'option', key: 'A', label: 'Alles bauen' }, { kind: 'option', key: 'B', label: 'Nur den Kern' } ].concat( INJECTED )
        }
        const built = buildAnswerText( q, globalThis.questionNav.state[ 0 ] )

        expect( built.answerLine ).toBe( 'Frage neu formulieren; Wie gross soll der Umfang maximal sein?' )
    } )


    it( 'the mechanism is ONE list, not two branches — a third kind would need no new build/reveal/harvest', async () => {
        const src = await readFile( clientPath(), 'utf8' )

        // the kind list is the single declaration all four places read.
        const declared = src.match( /var REFORMULATION_KINDS = \[[^]*?\n {8}\]/ )
        expect( declared ).not.toBeNull()
        const kinds = declared[ 0 ].match( /kind: '[a-z]+'/g )
        expect( kinds ).toEqual( [ "kind: 'reframe'", "kind: 'reoption'" ] )

        // and no place hard-codes a single kind any more: the old reframe-only lookups are gone. The
        // needle list is the comparison basis — four sites were searched, not "some".
        const needles = [
            'var reframeIdx = optionList.findIndex',
            'var reframeOnly =',
            'function harvestReframeInput',
            'var isReframeAnswer ='
        ]
        expect( needles.length ).toBe( 4 )
        const leftovers = needles
            .filter( ( needle ) => src.indexOf( needle ) !== -1 )
        expect( leftovers ).toEqual( [] )
        // GEGENPROBE: the search itself works — a needle that IS in the file is found.
        expect( needles.concat( [ 'function harvestReformulationInputs' ] ).filter( ( needle ) => src.indexOf( needle ) !== -1 ) ).toEqual( [ 'function harvestReformulationInputs' ] )
    } )
} )
