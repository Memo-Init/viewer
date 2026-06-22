import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { MemoModel } from '../../src/MemoModel.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'


// Memo 038 Phase 1 (P1c) + Phase 3 (answeredBy provenance, answer-split, finalize-gate schranke).
// Covers: answeredBy default 'user' + explicit 'ai-on-behalf' parse (JSON + markdown split);
// userDecision/aiRecommendationWas extraction (inline `·`-form + multi-line form); the finalize
// schranke (an ai-on-behalf answer does not satisfy the gate); MEMO-025 stays green with the split.

const __dirname = dirname( fileURLToPath( import.meta.url ) )
const REV05_PATH = resolve(
    __dirname,
    '../../../../.memo/memos/038-plan-f3-vergleich-indydevdan-planungsstr/revisions/REV-05.md'
)


describe( 'P3a — answeredBy in the questions-json schema', () => {
    it( 'defaults answeredBy to "user" when the field is absent', () => {
        const content = '```questions-json\n' + JSON.stringify( [
            { 'id': 'F1', 'title': 'T', 'frage': 'F?', 'aiRecommendation': 'A',
                'options': [ { 'key': 'A', 'label': 'a', 'kind': 'option' } ], 'answered': true }
        ] ) + '\n```'

        const { questions } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( questions[ 0 ][ 'answeredBy' ] ).toBe( 'user' )
    } )


    it( 'parses an explicit answeredBy="ai-on-behalf"', () => {
        const content = '```questions-json\n' + JSON.stringify( [
            { 'id': 'F1', 'title': 'T', 'frage': 'F?', 'aiRecommendation': 'A', 'answeredBy': 'ai-on-behalf',
                'options': [ { 'key': 'A', 'label': 'a', 'kind': 'option' } ], 'answered': true }
        ] ) + '\n```'

        const { questions } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( questions[ 0 ][ 'answeredBy' ] ).toBe( 'ai-on-behalf' )
    } )


    it( 'falls back to "user" for an unknown answeredBy value', () => {
        const content = '```questions-json\n' + JSON.stringify( [
            { 'id': 'F1', 'title': 'T', 'frage': 'F?', 'aiRecommendation': 'A', 'answeredBy': 'bogus',
                'options': [ { 'key': 'A', 'label': 'a', 'kind': 'option' } ], 'answered': true }
        ] ) + '\n```'

        const { questions } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( questions[ 0 ][ 'answeredBy' ] ).toBe( 'user' )
    } )
} )


describe( 'P1c — userDecision / aiRecommendationWas extraction (markdown)', () => {
    const buildDoc = ( { answeredBody } ) => {
        return [
            '## Offene Fragen',
            '',
            '_Keine offenen Fragen._',
            '',
            '## Beantwortete Fragen',
            '',
            answeredBody,
            '',
            '## Phasen',
            ''
        ].join( '\n' )
    }


    it( 'extracts the inline `·`-form decision pair and defaults answeredBy to "user"', () => {
        const body = [
            '### F1 — Eine Frage',
            '- **AI-Empfehlung war:** A · **User-Entscheidung:** B (teilweise) · **Beantwortet in:** REV-02'
        ].join( '\n' )

        const { questions } = DocumentRegistry.parseQuestionSchema( { content: buildDoc( { answeredBody: body } ) } )
        const f1 = questions.find( ( q ) => q[ 'id' ] === 'F1' )

        expect( f1[ 'answered' ] ).toBe( true )
        expect( f1[ 'aiRecommendationWas' ] ).toBe( 'A' )
        expect( f1[ 'userDecision' ] ).toBe( 'B (teilweise)' )
        expect( f1[ 'answeredBy' ] ).toBe( 'user' )
    } )


    it( 'extracts the multi-line form decision pair (back-compat)', () => {
        const body = [
            '### F1 — Eine Frage',
            '- **Frage (Original):** Was soll passieren?',
            '- **AI-Empfehlung war:** A',
            '- **User-Entscheidung:** C — anders entschieden',
            '- **Beantwortet in:** REV-03',
            '- **Anmerkung:** egal'
        ].join( '\n' )

        const { questions } = DocumentRegistry.parseQuestionSchema( { content: buildDoc( { answeredBody: body } ) } )
        const f1 = questions.find( ( q ) => q[ 'id' ] === 'F1' )

        expect( f1[ 'aiRecommendationWas' ] ).toBe( 'A' )
        expect( f1[ 'userDecision' ] ).toBe( 'C — anders entschieden' )
    } )


    it( 'leaves the decision fields absent on an open question (additive)', () => {
        const doc = [
            '## Offene Fragen',
            '',
            '### F1 — Offen',
            '**Hintergrund:** H',
            '**Frage:** Was?',
            '**AI-Empfehlung:** A',
            'A) Alpha',
            'B) Beta',
            '',
            '## Beantwortete Fragen',
            '',
            '## Phasen',
            ''
        ].join( '\n' )

        const { questions } = DocumentRegistry.parseQuestionSchema( { content: doc } )
        const f1 = questions.find( ( q ) => q[ 'id' ] === 'F1' )

        expect( f1[ 'answered' ] ).toBe( false )
        expect( f1[ 'answeredBy' ] ).toBe( 'user' )
        expect( Object.prototype.hasOwnProperty.call( f1, 'userDecision' ) ).toBe( false )
        expect( Object.prototype.hasOwnProperty.call( f1, 'aiRecommendationWas' ) ).toBe( false )
    } )
} )


describe( 'P3b — answer-split subsections drive answeredBy (markdown)', () => {
    const doc = [
        '## Offene Fragen',
        '',
        '_Keine offenen Fragen._',
        '',
        '## Beantwortete Fragen',
        '',
        '### Vom User beantwortet',
        '',
        '### F1 — User-Frage',
        '- **AI-Empfehlung war:** A · **User-Entscheidung:** A · **Beantwortet in:** REV-02',
        '',
        '### Von der AI im Namen des Users beantwortet',
        '',
        '### F2 — AI-Frage',
        '- **AI-Empfehlung war:** B · **User-Entscheidung:** B · **Beantwortet in:** REV-03',
        '',
        '## Phasen',
        ''
    ].join( '\n' )


    it( 'maps F1 (under "Vom User") to answeredBy="user"', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: doc } )
        const f1 = questions.find( ( q ) => q[ 'id' ] === 'F1' )

        expect( f1[ 'answeredBy' ] ).toBe( 'user' )
    } )


    it( 'maps F2 (under "Von der AI im Namen…") to answeredBy="ai-on-behalf"', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: doc } )
        const f2 = questions.find( ( q ) => q[ 'id' ] === 'F2' )

        expect( f2[ 'answeredBy' ] ).toBe( 'ai-on-behalf' )
    } )


    it( 'does not count the two subsection headings as questions (MEMO-025 stays green)', () => {
        const schema = DocumentRegistry.parseQuestionSchema( { content: doc } )

        expect( schema[ 'questions' ].length ).toBe( 2 )
        expect( schema[ 'headingCount' ] ).toBe( 2 )
        expect( schema[ 'countMismatch' ] ).toBe( false )

        const { messages } = MemoValidator.validate( { doc, fileName: 'REV-09.md' } )
        const memo025 = messages.filter( ( m ) => m.startsWith( 'MEMO-025' ) )

        expect( memo025 ).toEqual( [] )
    } )
} )


describe( 'P1c — MemoModel projection carries provenance additively', () => {
    const doc = [
        '## Offene Fragen',
        '',
        '_Keine offenen Fragen._',
        '',
        '## Beantwortete Fragen',
        '',
        '### Von der AI im Namen des Users beantwortet',
        '',
        '### F1 — AI-Frage',
        '- **AI-Empfehlung war:** A · **User-Entscheidung:** A · **Beantwortet in:** REV-03',
        '',
        '## Phasen',
        ''
    ].join( '\n' )


    it( 'keeps { id, text, answered } intact and adds answeredBy + decision pair', () => {
        const model = MemoModel.parse( { markdown: doc } )
        const f1 = model.questions.find( ( q ) => q.id === 'F1' )

        expect( f1.id ).toBe( 'F1' )
        expect( f1.answered ).toBe( true )
        expect( typeof f1.text ).toBe( 'string' )
        expect( f1.answeredBy ).toBe( 'ai-on-behalf' )
        expect( f1.userDecision ).toBe( 'A' )
        expect( f1.aiRecommendationWas ).toBe( 'A' )
    } )
} )


describe( 'P3c — finalize-gate schranke (ai-on-behalf never satisfies the gate)', () => {
    it( 'counts a user answer toward the gate', () => {
        const gate = MemoValidator.finalizeGate( { questions: [
            { 'id': 'F1', 'answered': true, 'answeredBy': 'user' }
        ] } )

        expect( gate[ 'gateSatisfied' ] ).toBe( true )
        expect( gate[ 'answeredByUser' ] ).toBe( 1 )
        expect( gate[ 'needsUser' ] ).toBe( 0 )
    } )


    it( 'does NOT count an ai-on-behalf answer toward the gate', () => {
        const gate = MemoValidator.finalizeGate( { questions: [
            { 'id': 'F1', 'answered': true, 'answeredBy': 'ai-on-behalf' }
        ] } )

        expect( gate[ 'gateSatisfied' ] ).toBe( false )
        expect( gate[ 'answeredByUser' ] ).toBe( 0 )
        expect( gate[ 'answeredByAi' ] ).toBe( 1 )
        expect( gate[ 'needsUser' ] ).toBe( 1 )
    } )


    it( 'a mix of user + ai-on-behalf leaves the gate unsatisfied until the AI one gets a user look', () => {
        const gate = MemoValidator.finalizeGate( { questions: [
            { 'id': 'F1', 'answered': true, 'answeredBy': 'user' },
            { 'id': 'F2', 'answered': true, 'answeredBy': 'ai-on-behalf' }
        ] } )

        expect( gate[ 'gateSatisfied' ] ).toBe( false )
        expect( gate[ 'answeredByUser' ] ).toBe( 1 )
        expect( gate[ 'answeredByAi' ] ).toBe( 1 )
        expect( gate[ 'needsUser' ] ).toBe( 1 )
    } )


    it( 'a legacy answered question (no answeredBy) counts as a user answer (back-compat)', () => {
        const gate = MemoValidator.finalizeGate( { questions: [
            { 'id': 'F1', 'answered': true }
        ] } )

        expect( gate[ 'gateSatisfied' ] ).toBe( true )
        expect( gate[ 'answeredByUser' ] ).toBe( 1 )
    } )


    it( 'exposes the advisory start threshold (>= 95 %), and an open question never satisfies', () => {
        const gate = MemoValidator.finalizeGate( { questions: [
            { 'id': 'F1', 'answered': false, 'answeredBy': 'user' }
        ] } )

        expect( gate[ 'startThreshold' ] ).toBe( 0.95 )
        expect( gate[ 'gateSatisfied' ] ).toBe( false )
        expect( gate[ 'needsUser' ] ).toBe( 1 )
    } )
} )


describe( 'REV-05 fixture (the dogfooded target structure)', () => {
    const content = readFileSync( REV05_PATH, 'utf8' )

    it( 'parses 8 questions from the questions-json block', () => {
        const { questions, found } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( found ).toBe( true )
        expect( questions.length ).toBe( 8 )
        expect( questions.every( ( q ) => q[ 'answeredBy' ] === 'user' ) ).toBe( true )
    } )


    it( 'keeps MEMO-025 satisfied (8 "### F{N}" headings == 8 parsed questions) despite the split', () => {
        const schema = DocumentRegistry.parseQuestionSchema( { content } )

        expect( schema[ 'questions' ].length ).toBe( 8 )
        expect( schema[ 'headingCount' ] ).toBe( 8 )
        expect( schema[ 'countMismatch' ] ).toBe( false )
    } )


    it( 'maps all 8 markdown answered entries (under "Vom User beantwortet") to answeredBy="user"', () => {
        const schema = DocumentRegistry.parseQuestionSchema( { content } )
        const answered = schema[ 'questions' ].filter( ( q ) => q[ 'answered' ] === true )

        expect( answered.length ).toBe( 8 )
        expect( answered.every( ( q ) => q[ 'answeredBy' ] === 'user' ) ).toBe( true )
    } )


    it( 'extracts the decision pair from the inline REV-05 form', () => {
        const schema = DocumentRegistry.parseQuestionSchema( { content } )
        const f2 = schema[ 'questions' ].find( ( q ) => q[ 'id' ] === 'F2' && q[ 'answered' ] === true )

        expect( f2[ 'aiRecommendationWas' ] ).toBe( 'A' )
        expect( f2[ 'userDecision' ].startsWith( 'B' ) ).toBe( true )
    } )
} )
