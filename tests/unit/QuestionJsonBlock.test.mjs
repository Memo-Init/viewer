import { describe, it, expect } from '@jest/globals'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-039 (Memo 016, Kap 13, F7=C Hybrid): the questions-json codeblock is the
// authoritative parse-safe source; renderQuestionsMarkdown generates the human-readable
// mirror; round-trip via parseQuestionSchema must stay structurally consistent.

const QUESTIONS = [
    {
        'id': 'F1',
        'title': 'Eine Single-Frage',
        'hintergrund': 'Hintergrund-Text',
        'frage': 'Was soll passieren?',
        'aiRecommendation': 'A',
        'typ': 'single',
        'options': [
            { 'key': 'A', 'label': 'Erste Option', 'kind': 'option' },
            { 'key': 'B', 'label': 'Zweite Option', 'kind': 'option' }
        ],
        'answered': false
    },
    {
        'id': 'F2',
        'title': 'Eine Multi-Frage',
        'hintergrund': 'Mehr Kontext',
        'frage': 'Welche treffen zu?',
        'aiRecommendation': 'A',
        'typ': 'multi',
        'options': [
            { 'key': 'A', 'label': 'Alpha', 'kind': 'option' },
            { 'key': 'B', 'label': 'Beta', 'kind': 'option' }
        ],
        'answered': false
    }
]


describe( 'DocumentRegistry.parseQuestionJsonBlock (PRD-039)', () => {
    it( 'parses a well-formed questions-json block (found: true)', () => {
        const content = '```questions-json\n' + JSON.stringify( QUESTIONS ) + '\n```'
        const { questions, found, error } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( found ).toBe( true )
        expect( error ).toBe( null )
        expect( questions.length ).toBe( 2 )
        expect( questions[ 0 ][ 'id' ] ).toBe( 'F1' )
        expect( questions[ 1 ][ 'typ' ] ).toBe( 'multi' )
    } )


    it( 'tolerates a { questions: [...] } wrapper object', () => {
        const content = '```questions-json\n' + JSON.stringify( { 'questions': QUESTIONS } ) + '\n```'
        const { questions, found } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( found ).toBe( true )
        expect( questions.length ).toBe( 2 )
    } )


    it( 'returns found: false without throwing on malformed JSON', () => {
        const content = '```questions-json\n{ broken ]\n```'
        const { questions, found, error } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( found ).toBe( false )
        expect( questions ).toEqual( [] )
        expect( typeof error ).toBe( 'string' )
    } )


    it( 'returns found: false when no block is present', () => {
        const { questions, found } = DocumentRegistry.parseQuestionJsonBlock( { content: '# Just markdown' } )

        expect( found ).toBe( false )
        expect( questions ).toEqual( [] )
    } )


    it( 'tolerates invalid input without throwing', () => {
        const { found } = DocumentRegistry.parseQuestionJsonBlock( { content: null } )

        expect( found ).toBe( false )
    } )
} )


describe( 'DocumentRegistry.renderQuestionsMarkdown (PRD-039)', () => {
    it( 'renders options as discrete lines, never inline (A)/(B)', () => {
        const { markdown } = DocumentRegistry.renderQuestionsMarkdown( { questions: QUESTIONS } )

        expect( markdown ).toMatch( /^A\) Erste Option$/m )
        expect( markdown ).toMatch( /^B\) Zweite Option$/m )
        expect( markdown ).not.toMatch( /\(A\)\/\(B\)/ )
    } )


    it( 'tolerates non-array input', () => {
        const { markdown } = DocumentRegistry.renderQuestionsMarkdown( { questions: null } )

        expect( markdown ).toBe( '' )
    } )
} )


describe( 'PRD-004 (Memo 011 Kap 11) — #normalizeJsonQuestion derives preselected (Bug A)', () => {
    it( 'derives preselected from aiRecommendation for a single question', () => {
        const questions = [
            {
                'id': 'F1',
                'title': 'Single mit Empfehlung',
                'frage': 'Was tun?',
                'aiRecommendation': 'C — weil das langfristig wartbarer ist',
                'typ': 'single',
                'options': [
                    { 'key': 'A', 'label': 'Erste', 'kind': 'option' },
                    { 'key': 'B', 'label': 'Zweite', 'kind': 'option' },
                    { 'key': 'C', 'label': 'Dritte', 'kind': 'option' }
                ],
                'answered': false
            }
        ]
        const content = '```questions-json\n' + JSON.stringify( questions ) + '\n```'
        const { questions: parsed } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( Array.isArray( parsed[ 0 ][ 'preselected' ] ) ).toBe( true )
        // C is the third real option (index 2). custom/topic defaults are appended AFTER the
        // real options, so the index of C is stable at 2.
        expect( parsed[ 0 ][ 'preselected' ] ).toEqual( [ 2 ] )
    } )


    it( 'appends custom and topic default options (no loss of defaults)', () => {
        const questions = [
            {
                'id': 'F1',
                'frage': 'Was tun?',
                'aiRecommendation': 'A',
                'typ': 'single',
                'options': [ { 'key': 'A', 'label': 'Erste', 'kind': 'option' } ],
                'answered': false
            }
        ]
        const content = '```questions-json\n' + JSON.stringify( questions ) + '\n```'
        const { questions: parsed } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        const kinds = parsed[ 0 ][ 'options' ].map( ( option ) => option[ 'kind' ] )
        expect( kinds ).toContain( 'custom' )
        expect( kinds ).toContain( 'topic' )
        // preselected still points at the real option A (index 0), not at a default.
        expect( parsed[ 0 ][ 'preselected' ] ).toEqual( [ 0 ] )
    } )


    it( 'returns preselected [] for an empty aiRecommendation (no crash)', () => {
        const questions = [
            {
                'id': 'F1',
                'frage': 'Was tun?',
                'aiRecommendation': '',
                'typ': 'single',
                'options': [ { 'key': 'A', 'label': 'Erste', 'kind': 'option' } ],
                'answered': false
            }
        ]
        const content = '```questions-json\n' + JSON.stringify( questions ) + '\n```'
        const { questions: parsed } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( parsed[ 0 ][ 'preselected' ] ).toEqual( [] )
    } )


    it( 'matches all recommended indices for a multi question', () => {
        const questions = [
            {
                'id': 'F1',
                'frage': 'Welche treffen zu?',
                'aiRecommendation': 'A+C',
                'typ': 'multi',
                'options': [
                    { 'key': 'A', 'label': 'Alpha', 'kind': 'option' },
                    { 'key': 'B', 'label': 'Beta', 'kind': 'option' },
                    { 'key': 'C', 'label': 'Gamma', 'kind': 'option' }
                ],
                'answered': false
            }
        ]
        const content = '```questions-json\n' + JSON.stringify( questions ) + '\n```'
        const { questions: parsed } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( parsed[ 0 ][ 'preselected' ] ).toEqual( [ 0, 2 ] )
    } )


    it( 'respects an explicit preselected array on the JSON entry', () => {
        const questions = [
            {
                'id': 'F1',
                'frage': 'Was tun?',
                'aiRecommendation': 'A',
                'typ': 'single',
                'preselected': [ 1 ],
                'options': [
                    { 'key': 'A', 'label': 'Erste', 'kind': 'option' },
                    { 'key': 'B', 'label': 'Zweite', 'kind': 'option' }
                ],
                'answered': false
            }
        ]
        const content = '```questions-json\n' + JSON.stringify( questions ) + '\n```'
        const { questions: parsed } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( parsed[ 0 ][ 'preselected' ] ).toEqual( [ 1 ] )
    } )


    it( 'does NOT treat a bare A-H letter buried in prose as a recommended key (Bug C)', () => {
        const questions = [
            {
                'id': 'F1',
                'frage': 'Was tun?',
                // The token "INCONCLUSIVE:" ends with an "E" right before a colon — the old
                // unanchored regex matched it as key "E". With anchoring it must NOT preselect.
                'aiRecommendation': 'INCONCLUSIVE: das Ergebnis ist offen',
                'typ': 'single',
                'options': [
                    { 'key': 'A', 'label': 'Erste', 'kind': 'option' },
                    { 'key': 'E', 'label': 'Fuenfte', 'kind': 'option' }
                ],
                'answered': false
            }
        ]
        const content = '```questions-json\n' + JSON.stringify( questions ) + '\n```'
        const { questions: parsed } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        expect( parsed[ 0 ][ 'preselected' ] ).toEqual( [] )
    } )
} )


describe( 'Round-trip JSON -> Markdown -> parseQuestionSchema (PRD-039)', () => {
    it( 'preserves id, typ and real options through the full cycle', () => {
        const { markdown } = DocumentRegistry.renderQuestionsMarkdown( { questions: QUESTIONS } )
        const doc = '## Offene Fragen\n\n' + markdown
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: doc } )

        expect( questions.length ).toBe( 2 )

        const f1 = questions.find( ( q ) => q[ 'id' ] === 'F1' )
        const f2 = questions.find( ( q ) => q[ 'id' ] === 'F2' )

        expect( f1 ).toBeDefined()
        expect( f1[ 'typ' ] ).toBe( 'single' )
        const f1Real = f1[ 'options' ].filter( ( o ) => o[ 'kind' ] === 'option' )
        expect( f1Real.map( ( o ) => o[ 'key' ] ).sort() ).toEqual( [ 'A', 'B' ] )

        expect( f2 ).toBeDefined()
        expect( f2[ 'typ' ] ).toBe( 'multi' )
    } )
} )
