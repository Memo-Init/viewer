import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { extractFunctions } from '../helpers/extractFunction.mjs'


// Memo 079 PRD-24 (WI-042/043): the Fragen-Widget answer-loss fix has two client parts:
//   (1) the prompt popup prefills from the LIVE widget state via buildAnswerText(q, st).answerLine
//       (not only from a confirmed st.added answer);
//   (2) renderQuestionWidgets merges prior answer state BY question id (prevById) instead of a hard
//       reset, so a WS content-broadcast no longer wipes unsaved selections/custom entries.
// buildAnswerText is pure and extractable → tested directly (it is the exact value the popup now uses).
// The DOM-bound merge/prefill wiring is guarded by a source assertion (jest runs in a node env, no DOM).
describe( 'Question widget answer persistence — Memo 079 PRD-24', () => {
    const clientPath = () => join( dirname( fileURLToPath( import.meta.url ) ), '..', '..', 'src', 'public', 'app.client.mjs' )


    it( 'buildAnswerText (the popup prefill source) renders a single-select answer line', async () => {
        const { buildAnswerText } = await extractFunctions( [ 'buildAnswerText' ] )
        const q = { id: 'F1', title: 'Frage', typ: 'single', options: [ { kind: 'option', key: 'A', label: 'Alpha' }, { kind: 'option', key: 'B', label: 'Beta' } ] }
        const st = { selected: [ 1 ], custom: [] }

        expect( buildAnswerText( q, st ).answerLine ).toBe( 'B) Beta' )
    } )


    it( 'buildAnswerText joins multi-select options + custom entries', async () => {
        const { buildAnswerText } = await extractFunctions( [ 'buildAnswerText' ] )
        const q = { id: 'F2', title: 'Frage', typ: 'multi', options: [ { kind: 'option', key: 'A', label: 'Alpha' }, { kind: 'option', key: 'B', label: 'Beta' } ] }
        const st = { selected: [ 0, 1 ], custom: [ 'eigener' ] }

        expect( buildAnswerText( q, st ).answerLine ).toBe( 'A) Alpha; B) Beta; eigener' )
    } )


    it( 'the popup prefills from the LIVE state (selected/custom), not only confirmed answers', async () => {
        const src = await readFile( clientPath(), 'utf8' )

        // The old gate `st.added && st.addedText` in renderPromptQuestions is replaced by a live gate.
        expect( src ).toContain( 'st.selected.length > 0 || st.custom.length > 0' )
        expect( src ).toContain( 'buildAnswerText( q, st ).answerLine' )
    } )


    it( 'renderQuestionWidgets merges prior state by question id (no hard reset)', async () => {
        const src = await readFile( clientPath(), 'utf8' )

        expect( src ).toContain( 'var prevById = {}' )
        expect( src ).toContain( 'prevById[ q.id ]' )
    } )
} )
