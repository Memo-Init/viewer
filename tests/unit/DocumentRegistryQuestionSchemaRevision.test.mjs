import { describe, it, expect } from '@jest/globals'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-006 (Memo 018 Kap 9): the question schema is sourced from the ACTIVE REVISION
// content. These tests pin the revision-level parsing contract and the Memo-017
// regression: inline-parenthesized "(A) ... (B) ..." options inside the Frage text
// must be parsed, while option back-references inside answer/metadata lines must NOT
// become phantom options.
describe( 'parseQuestionSchema — Revisionsebene (PRD-006)', () => {
    const happyPath = [
        '## Offene Fragen',
        '',
        '### F1 — Begriffswahl',
        '',
        '**Hintergrund:** Zwei Begriffe konkurrieren im Memo.',
        '',
        '**Frage:** Welchen Begriff durchgehend verwenden?',
        '',
        '**AI-Empfehlung:** A',
        '',
        'A) Context Rot',
        'B) Kontaminierung',
        ''
    ].join( '\n' )


    it( 'parses an open F-block with Hintergrund and discrete options', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: happyPath } )

        expect( questions.length ).toBe( 1 )

        const first = questions[ 0 ]
        expect( first[ 'id' ] ).toBe( 'F1' )
        expect( first[ 'title' ] ).toBe( 'Begriffswahl' )
        expect( first[ 'hintergrund' ] ).toBe( 'Zwei Begriffe konkurrieren im Memo.' )
        expect( first[ 'frage' ] ).toBe( 'Welchen Begriff durchgehend verwenden?' )
        expect( first[ 'answered' ] ).toBe( false )

        const letteredKeys = first[ 'options' ]
            .filter( ( option ) => option[ 'kind' ] === 'option' )
            .map( ( option ) => option[ 'key' ] )
        expect( letteredKeys ).toEqual( [ 'A', 'B' ] )
    } )


    it( 'returns an empty questions array when no Offene-Fragen section exists', () => {
        const content = [ '# Memo', '', '## Kontext', '', 'Kein Fragen-Abschnitt hier.' ].join( '\n' )
        const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

        expect( questions ).toEqual( [] )
    } )


    it( 'parses answered blocks from "Beantwortete Fragen" with answered: true', () => {
        const content = [
            '## Beantwortete Fragen',
            '',
            '### F9 — Entscheidung X',
            '',
            '- **Frage (Original):** Variante A oder B?',
            '- **AI-Empfehlung war:** A',
            '- **User-Entscheidung:** A',
            ''
        ].join( '\n' )

        const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

        expect( questions.length ).toBe( 1 )
        expect( questions[ 0 ][ 'id' ] ).toBe( 'F9' )
        expect( questions[ 0 ][ 'answered' ] ).toBe( true )
    } )
} )


// Faithful copy of the relevant F-blocks from Memo 017 REV-03.md (Beantwortete Fragen).
// The inline "(A) ... (B) ... (C)" markers in the Frage text and the back-references in
// the "**AI-Empfehlung war:**"/"**User-Entscheidung:**" list items are the exact failure
// shape PRD-006 (AC-10) targets.
describe( 'Memo-017 Fixture-Test (PRD-006 AC-10)', () => {
    const memo017Fixture = [
        '## Beantwortete Fragen',
        '',
        '### F2 — Begriffswahl Context Rot vs. Kontaminierung',
        '',
        '- **Frage (Original):** Beide Begriffe getrennt führen (Context Rot = Ursache, Kontaminierung = Folge) oder durchgehend einen?',
        '- **AI-Empfehlung war:** Beide getrennt (A).',
        '- **User-Entscheidung:** A — „Ja, das ist in Ordnung."',
        '- **Beantwortet in:** REV-02',
        '',
        '### F3 — Verhältnis zu bestehenden Skills',
        '',
        '- **Frage (Original):** `memo-handover` als (A) eigenständiger Skill, (B) Erweiterung von `memo-reset-recommend`, oder (C) Teil der `state-recovery-spec`?',
        '- **AI-Empfehlung war:** Eigenständig (A).',
        '- **User-Entscheidung:** A — „Ja, eigenständig."',
        '- **Beantwortet in:** REV-02',
        '',
        '### F5 — Fakten-Briefing: Pflicht oder opt-in?',
        '',
        '- **Frage (Original):** Schritt (A) immer Pflicht, (B) nur bei großen Auto-Memos, (C) konfigurierbar?',
        '- **AI-Empfehlung war:** Pflicht (A).',
        '- **User-Entscheidung:** A — „Okay, Pflicht."',
        '- **Beantwortet in:** REV-02',
        '',
        '### F6 — Begriff für das „synthetische Transkript"',
        '',
        '- **Frage (Original):** (A) „Fakten-Briefing", (B) „rekonstruiertes Kontext-Briefing", oder (C) bei „synthetisches Transkript" mit Definition bleiben?',
        '- **AI-Empfehlung war:** „Fakten-Briefing" (A).',
        '- **User-Entscheidung:** A — „ok nehmen wir."',
        '- **Beantwortet in:** REV-03',
        ''
    ].join( '\n' )


    const byId = ( questions, id ) => {
        return questions.find( ( question ) => question[ 'id' ] === id )
    }

    const letteredKeys = ( question ) => {
        return question[ 'options' ]
            .filter( ( option ) => option[ 'kind' ] === 'option' )
            .map( ( option ) => option[ 'key' ] )
    }


    it( 'F3 yields at least the inline A, B (and C) options from the Frage text', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: memo017Fixture } )
        const keys = letteredKeys( byId( questions, 'F3' ) )

        expect( keys ).toContain( 'A' )
        expect( keys ).toContain( 'B' )
        expect( keys ).toContain( 'C' )
    } )


    it( 'F5 yields the three inline A, B, C options', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: memo017Fixture } )
        const keys = letteredKeys( byId( questions, 'F5' ) )

        expect( keys ).toEqual( [ 'A', 'B', 'C' ] )
    } )


    it( 'F6 yields the three inline A, B, C options at the start of the Frage', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: memo017Fixture } )
        const keys = letteredKeys( byId( questions, 'F6' ) )

        expect( keys ).toEqual( [ 'A', 'B', 'C' ] )
    } )


    it( 'F2 (binary question) produces NO phantom option from the "(A)" back-reference', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: memo017Fixture } )
        const keys = letteredKeys( byId( questions, 'F2' ) )

        // The only "(A)" in F2 lives in the "**AI-Empfehlung war:** ... (A)." metadata line —
        // it is a back-reference, not an option declaration, and must be stripped.
        expect( keys ).toEqual( [] )
    } )


    it( 'keeps the Frage text clean — the AI/User metadata lines do not bleed into it', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: memo017Fixture } )
        const f3 = byId( questions, 'F3' )

        expect( f3[ 'frage' ].includes( 'AI-Empfehlung' ) ).toBe( false )
        expect( f3[ 'frage' ].includes( 'User-Entscheidung' ) ).toBe( false )
    } )
} )
