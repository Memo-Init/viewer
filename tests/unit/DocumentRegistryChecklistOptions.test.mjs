import { describe, it, expect } from '@jest/globals'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-003 (Memo 022, Kap 4, F9=A): a checklist-style question (options expressed as
// "- [ ] ..." markdown checkbox items, NOT A/B/C letter markers) must yield real
// `option` entries so the render gate treats it as a Multi-Select widget instead of
// forcing the markdown fallback. Plus: the parser's custom-option label is "ablehnen".
describe( 'parseQuestionSchema — Checklisten-Optionen (PRD-003)', () => {
    const checklistContent = [
        '## Offene Fragen',
        '',
        '### F1 — Finalisierungs-Checkliste',
        '',
        '**Hintergrund:** Vor dem Abschluss zu prüfende Punkte.',
        '',
        '**Frage:** Welche Punkte sind erfüllt?',
        '',
        '- [ ] Tests sind grün',
        '- [ ] Dokumentation ist aktuell',
        '- [x] Security-Scan durchgeführt',
        ''
    ].join( '\n' )


    const letterContent = [
        '## Offene Fragen',
        '',
        '### F2 — Begriffswahl',
        '',
        '**Frage:** Welchen Begriff durchgehend verwenden?',
        '',
        '**AI-Empfehlung:** A',
        '',
        'A) Context Rot',
        'B) Kontaminierung',
        ''
    ].join( '\n' )


    function realOptions( question ) {
        return question[ 'options' ].filter( ( o ) => o[ 'kind' ] === 'option' )
    }


    it( 'derives >= 2 option entries from "- [ ] ..." checkbox items', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: checklistContent } )
        const q = questions[ 0 ]
        const opts = realOptions( q )

        expect( opts.length ).toBe( 3 )
        expect( opts.map( ( o ) => o[ 'label' ] ) ).toEqual( [
            'Tests sind grün',
            'Dokumentation ist aktuell',
            'Security-Scan durchgeführt'
        ] )
    } )


    it( 'derives stable letter keys A, B, C by item index', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: checklistContent } )
        const opts = realOptions( questions[ 0 ] )

        expect( opts.map( ( o ) => o[ 'key' ] ) ).toEqual( [ 'A', 'B', 'C' ] )
    } )


    it( 'classifies the checklist question as typ === "multi"', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: checklistContent } )

        expect( questions[ 0 ][ 'typ' ] ).toBe( 'multi' )
    } )


    it( 'gives every parsed question a custom option labelled "ablehnen"', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: checklistContent } )
        const custom = questions[ 0 ][ 'options' ].find( ( o ) => o[ 'kind' ] === 'custom' )

        expect( custom ).toBeDefined()
        expect( custom[ 'label' ] ).toBe( 'ablehnen' )
    } )


    it( 'does NOT derive checklist options for a classic A/B/C letter question', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: letterContent } )
        const opts = realOptions( questions[ 0 ] )

        // The letter scan wins; no checkbox items exist, so keys stay A/B exactly.
        expect( opts.map( ( o ) => o[ 'key' ] ) ).toEqual( [ 'A', 'B' ] )
    } )


    it( 'leaves a single checkbox item below the >= 2 threshold without forcing a widget', () => {
        const oneItem = [
            '## Offene Fragen',
            '',
            '### F3 — Einzelpunkt',
            '',
            '**Frage:** Ist der eine Punkt erfüllt?',
            '',
            '- [ ] Einziger Punkt',
            ''
        ].join( '\n' )

        const { questions } = DocumentRegistry.parseQuestionSchema( { content: oneItem } )
        const opts = realOptions( questions[ 0 ] )

        // A single checkbox item still produces an option, but only one — the >= 2 render
        // gate (covered in QuestionRenderGate) then keeps it on the fallback path.
        expect( opts.length ).toBe( 1 )
    } )
} )
