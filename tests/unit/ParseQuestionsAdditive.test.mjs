import { describe, it, expect } from '@jest/globals'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-P1-01 (Memo 075, WI-006): the Fragen-Zähler never reached "N of N" because parseQuestions
// counted ONLY the questions-json block and early-returned. The memo-revision-execute write
// convention moves answered questions OUT of the json block into the `## Beantwortete Fragen`
// markdown section, leaving an empty `[]` block behind — so answeredCount stayed 0 (live: memo 072
// showed {open:0,answered:0} despite 10 answers). The fix counts the markdown-answered entries
// ADDITIVELY on top of the json-answered ones, deduped by F-id.
const answeredMarkdown = ( count ) => {
    const headings = Array.from( { length: count }, ( _value, index ) => {
        const number = index + 1

        return `### F${ number } — Frage ${ number }\n- **AI-Empfehlung war:** A · **User-Entscheidung:** A`
    } )

    return headings.join( '\n\n' )
}


describe( 'DocumentRegistry.parseQuestions — additive markdown-answered count (PRD-P1-01)', () => {
    it( 'empty questions-json block + 10 answered markdown headings -> {open:0, answered:10} (memo 072)', () => {
        const content = [
            '## Offene Fragen',
            '',
            '```questions-json',
            '[]',
            '```',
            '',
            '## Beantwortete Fragen',
            '',
            '### Vom User beantwortet',
            '',
            answeredMarkdown( 10 )
        ].join( '\n' )

        const { openCount, answeredCount } = DocumentRegistry.parseQuestions( { content } )

        expect( openCount ).toBe( 0 )
        expect( answeredCount ).toBe( 10 )
    } )


    it( 'does NOT double-count a question present in BOTH json (answered) and markdown (F-id dedup)', () => {
        const jsonQuestions = [
            { 'id': 'F1', 'frage': 'Q1?', 'typ': 'single', 'options': [], 'answered': true }
        ]
        const content = [
            '## Offene Fragen',
            '',
            '```questions-json',
            JSON.stringify( jsonQuestions ),
            '```',
            '',
            '## Beantwortete Fragen',
            '',
            '### F1 — Frage 1',
            '- **AI-Empfehlung war:** A · **User-Entscheidung:** A'
        ].join( '\n' )

        const { openCount, answeredCount } = DocumentRegistry.parseQuestions( { content } )

        // F1 is answered in the json block AND mirrored as a `### F1` markdown heading — counts once.
        expect( openCount ).toBe( 0 )
        expect( answeredCount ).toBe( 1 )
    } )


    it( 'adds a markdown-only answered question that is NOT in the json block', () => {
        const jsonQuestions = [
            { 'id': 'F1', 'frage': 'Q1?', 'typ': 'single', 'options': [], 'answered': true }
        ]
        const content = [
            '## Offene Fragen',
            '',
            '```questions-json',
            JSON.stringify( jsonQuestions ),
            '```',
            '',
            '## Beantwortete Fragen',
            '',
            '### F1 — Frage 1',
            '- x',
            '',
            '### F2 — Frage 2',
            '- y'
        ].join( '\n' )

        const { openCount, answeredCount } = DocumentRegistry.parseQuestions( { content } )

        // F1 deduped (json + markdown), F2 markdown-only -> total 2 answered.
        expect( openCount ).toBe( 0 )
        expect( answeredCount ).toBe( 2 )
    } )


    it( 'keeps openCount json-driven while adding markdown-answered ones', () => {
        const jsonQuestions = [
            { 'id': 'F3', 'frage': 'still open?', 'typ': 'single', 'options': [], 'answered': false },
            { 'id': 'F4', 'frage': 'also open?', 'typ': 'single', 'options': [], 'answered': false }
        ]
        const content = [
            '## Offene Fragen',
            '',
            '```questions-json',
            JSON.stringify( jsonQuestions ),
            '```',
            '',
            '## Beantwortete Fragen',
            '',
            '### F1 — Frage 1',
            '- a',
            '',
            '### F2 — Frage 2',
            '- b'
        ].join( '\n' )

        const { openCount, answeredCount } = DocumentRegistry.parseQuestions( { content } )

        // 2 open in json, 0 json-answered, 2 markdown-answered (F1/F2, no overlap).
        expect( openCount ).toBe( 2 )
        expect( answeredCount ).toBe( 2 )
    } )


    it( 'still counts a pure json block with no markdown-answered section (no regression)', () => {
        const jsonQuestions = [
            { 'id': 'F1', 'frage': 'open?', 'typ': 'single', 'options': [], 'answered': false },
            { 'id': 'F2', 'frage': 'done?', 'typ': 'single', 'options': [], 'answered': true }
        ]
        const content = '```questions-json\n' + JSON.stringify( jsonQuestions ) + '\n```'

        const { openCount, answeredCount } = DocumentRegistry.parseQuestions( { content } )

        expect( openCount ).toBe( 1 )
        expect( answeredCount ).toBe( 1 )
    } )
} )
