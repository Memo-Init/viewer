import { describe, it, expect, afterEach } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { extractFunctions } from '../helpers/extractFunction.mjs'


// Memo 079 reframe-freetext-click-loss: the reframe reformulation used to be committed ONLY on Enter
// (keydown). A user who typed the reformulation and clicked "Hinzufügen" (or opened the answer popup) —
// both of which blur the input BEFORE st.custom is read — lost the text: buildAnswerText yielded only the
// "Frage neu formulieren" label. The fix harvests the live input into st.custom on blur AND at submit.
// harvestReframeInput reads a `document`/`questionNav` global, so the extracted function is driven against
// a small injected fake DOM (no jsdom in this project).
describe( 'Memo 079 reframe-freetext-click-loss', () => {
    const clientPath = () => join( dirname( fileURLToPath( import.meta.url ) ), '..', '..', 'src', 'public', 'app.client.mjs' )

    const savedDocument = globalThis.document
    const savedQuestionNav = globalThis.questionNav
    const savedSetAddButtonState = globalThis.setAddButtonState
    const savedUpdateSaveAnswersOnlyState = globalThis.updateSaveAnswersOnlyState


    afterEach( () => {
        globalThis.document = savedDocument
        globalThis.questionNav = savedQuestionNav
        globalThis.setAddButtonState = savedSetAddButtonState
        globalThis.updateSaveAnswersOnlyState = savedUpdateSaveAnswersOnlyState
    } )


    // Wire a minimal fake DOM: #question-widgets .qw-card[...] -> card -> .qw-custom-input -> the input.
    const installFakeDom = ( { inputValue } ) => {
        const input = { value: inputValue }
        const card = { querySelector: ( sel ) => ( sel.includes( 'qw-custom-input' ) ? input : null ) }
        globalThis.document = { querySelector: ( sel ) => ( sel.includes( 'qw-card' ) ? card : null ) }
        globalThis.setAddButtonState = () => {}
        globalThis.updateSaveAnswersOnlyState = () => {}

        return { input }
    }


    it( 'harvestReframeInput folds a typed-but-not-Entered reformulation into st.custom and clears the field', async () => {
        const { harvestReframeInput } = await extractFunctions( [ 'harvestReframeInput' ] )
        const { input } = installFakeDom( { inputValue: '  Soll auch Option C erlaubt sein?  ' } )
        globalThis.questionNav = { state: [ { selected: [ 2 ], custom: [], added: false } ] }

        harvestReframeInput( 0 )

        expect( globalThis.questionNav.state[ 0 ].custom ).toEqual( [ 'Soll auch Option C erlaubt sein?' ] )
        expect( input.value ).toBe( '' )
    } )


    it( 'does NOT duplicate a reformulation already committed (dedup by value)', async () => {
        const { harvestReframeInput } = await extractFunctions( [ 'harvestReframeInput' ] )
        installFakeDom( { inputValue: 'Reformulierung' } )
        globalThis.questionNav = { state: [ { selected: [ 2 ], custom: [ 'Reformulierung' ], added: false } ] }

        harvestReframeInput( 0 )

        expect( globalThis.questionNav.state[ 0 ].custom ).toEqual( [ 'Reformulierung' ] )
    } )


    it( 'an empty input is a no-op (nothing pushed)', async () => {
        const { harvestReframeInput } = await extractFunctions( [ 'harvestReframeInput' ] )
        installFakeDom( { inputValue: '   ' } )
        globalThis.questionNav = { state: [ { selected: [ 2 ], custom: [], added: false } ] }

        harvestReframeInput( 0 )

        expect( globalThis.questionNav.state[ 0 ].custom ).toEqual( [] )
    } )


    it( 'end-to-end: harvest → buildAnswerText yields the folded reframe answer (no dropped text)', async () => {
        const { harvestReframeInput, buildAnswerText } = await extractFunctions( [ 'harvestReframeInput', 'buildAnswerText' ] )
        installFakeDom( { inputValue: 'Soll auch Option C erlaubt sein?' } )
        const q = { id: 'F3', title: 'Frage', typ: 'single', options: [ { kind: 'option', key: 'A', label: 'Alpha' }, { kind: 'reframe', key: 'reframe', label: 'Frage neu formulieren' } ] }
        globalThis.questionNav = { state: [ { selected: [ 1 ], custom: [], added: false } ] }

        // Simulate the click path: the typed-but-not-Entered value is harvested, then read.
        harvestReframeInput( 0 )
        const built = buildAnswerText( q, globalThis.questionNav.state[ 0 ] )

        expect( built.answerLine ).toBe( 'Frage neu formulieren; Soll auch Option C erlaubt sein?' )
    } )


    it( 'submitQuestionAnswer and the reframe input are wired to harvest (source-level)', async () => {
        const src = await readFile( clientPath(), 'utf8' )

        expect( src ).toContain( 'function harvestReframeInput( qIdx )' )
        // committed on blur (covers "Hinzufügen" click + opening the popup, both blur first).
        expect( src ).toContain( "input.addEventListener( 'blur', function() { harvestReframeInput( qIdx ) } )" )
        // and harvested at submit before buildAnswerText reads st.custom.
        expect( src ).toContain( 'harvestReframeInput( qIdx )' )
        expect( src.indexOf( 'harvestReframeInput( qIdx )' ) ).toBeLessThan( src.indexOf( 'var built = buildAnswerText( q, st )' ) )
    } )
} )
