import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { extractFunctions, readEmittedScript } from '../helpers/extractFunction.mjs'


// Memo 080, PRD-F1 (Kap 18 / WI-076) — the question lifecycle on the viewer side.
//
// THE TWO DEFECTS THIS COVERS, MEASURED AT HEAD BEFORE THE CHANGE:
//   - the interactive widget filtered on `answered === false`, so a question retired as irrelevant or
//     replaced still got a widget and went on collecting answers nobody would ever read;
//   - the counter carried TWO figures, so a retired question simply left "offen" and appeared nowhere —
//     a silent difference between the parsed stock and the shown one.
//
// Every case below states how much it compared. A fixture that parsed nothing would satisfy a filter
// trivially, so the comparison basis is asserted first, never assumed.
describe( 'Question lifecycle — Memo 080, PRD-F1', () => {
    const FIXTURE = [
        { id: 'F1', title: 'Offen', frage: 'Bleibt offen?', typ: 'single', options: [ { key: 'A', label: 'a', kind: 'option' } ], answered: false, status: 'open' },
        { id: 'F2', title: 'Beantwortet', frage: 'Ist beantwortet?', typ: 'single', options: [ { key: 'A', label: 'a', kind: 'option' } ], answered: true, status: 'answered', answeredBy: 'ai-on-behalf', answeredInRev: 'REV-02', note: 'im Namen des Users' },
        { id: 'F3', title: 'Irrelevant', frage: 'Ist irrelevant?', typ: 'single', options: [ { key: 'A', label: 'a', kind: 'option' } ], answered: false, status: 'irrelevant', statusReason: 'die Messung hat sie erledigt' },
        { id: 'F4', title: 'Ersetzt', frage: 'Ist ersetzt?', typ: 'single', options: [ { key: 'A', label: 'a', kind: 'option' } ], answered: false, status: 'replaced', statusReason: 'F1 fragt dasselbe', replacedBy: 'F1' }
    ]

    const fenceDocument = ( { questions } ) => [
        '# Memo',
        '',
        '## Fragen',
        '',
        '```questions-json',
        JSON.stringify( questions, null, 2 ),
        '```',
        ''
    ].join( '\n' )


    const clientPath = () => join( dirname( fileURLToPath( import.meta.url ) ), '..', '..', 'src', 'public', 'app.client.mjs' )


    it( 'A14 — the parsed schema carries a status per question, and exactly ONE of the four is open', () => {
        const { found, questions } = DocumentRegistry.parseQuestionJsonBlock( { content: fenceDocument( { questions: FIXTURE } ) } )

        expect( found ).toBe( true )
        expect( questions.length ).toBe( FIXTURE.length )
        expect( questions.map( ( entry ) => entry[ 'status' ] ) ).toEqual( [ 'open', 'answered', 'irrelevant', 'replaced' ] )

        // the axis the widget filter reads — one widget for four questions.
        const widgetWorthy = questions.filter( ( entry ) => entry[ 'status' ] === 'open' )
        expect( widgetWorthy.map( ( entry ) => entry[ 'id' ] ) ).toEqual( [ 'F1' ] )

        // GEGENPROBE: the OLD predicate would have handed a widget to three of the four — which is
        // exactly the defect. Stating it here keeps the case from passing for the wrong reason.
        const oldPredicate = questions.filter( ( entry ) => entry[ 'answered' ] === false )
        expect( oldPredicate.map( ( entry ) => entry[ 'id' ] ) ).toEqual( [ 'F1', 'F3', 'F4' ] )
    } )


    it( 'A14 — an unknown status degrades to the boolean reading instead of throwing (the viewer never refuses a document)', () => {
        const { questions } = DocumentRegistry.parseQuestionJsonBlock( { content: fenceDocument( { questions: [
            { id: 'F9', frage: 'Kaputt?', answered: true, status: 'opne' },
            { id: 'F8', frage: 'Ohne Feld?', answered: false }
        ] } ) } )

        expect( questions.length ).toBe( 2 )
        expect( questions[ 0 ][ 'status' ] ).toBe( 'answered' )
        expect( questions[ 1 ][ 'status' ] ).toBe( 'open' )
    } )


    it( 'A14 — the client filters the widget and the prompt list on the STATUS axis, not on the boolean', async () => {
        const src = await readFile( clientPath(), 'utf8' )

        expect( src ).toContain( "return q && q.status === 'open'" )
        // the OLD predicate must be gone as a widget filter — searched over the whole client script, and
        // the number searched is stated so a zero can never come from an empty search.
        const remaining = [ ...src.matchAll( /q\.answered === false/g ) ]
        expect( { hits: remaining.length, searched: src.length } ).toEqual( { hits: 0, searched: src.length } )
        expect( src.length ).toBeGreaterThan( 1000 )
        // the prompt dialog prefills from the SAME filtered list (questionNav.questions), so the
        // restriction cannot hold in one place and leak in the other.
        expect( src ).toContain( 'var open = Array.isArray( questionNav.questions ) ? questionNav.questions : []' )
    } )


    it( 'A15 — the counter carries three figures whose sum is the parsed stock, with no silent difference', () => {
        const parsed = DocumentRegistry.parseQuestions( { content: fenceDocument( { questions: FIXTURE } ) } )

        expect( parsed ).toEqual( { openCount: 1, answeredCount: 1, deferredCount: 2 } )
        expect( parsed[ 'openCount' ] + parsed[ 'answeredCount' ] + parsed[ 'deferredCount' ] ).toBe( FIXTURE.length )
    } )


    it( 'A15 — the markdown path counts the retired section too, so both regimes add up', () => {
        const document = [
            '# Memo',
            '',
            '## Offene Fragen',
            '',
            '### F1 — Offen',
            '',
            '## Beantwortete Fragen',
            '',
            '### F2 — Beantwortet',
            '',
            '## Zurueckgestellte Fragen',
            '',
            '### F3 — Irrelevant',
            '',
            '### F4 — Ersetzt',
            ''
        ].join( '\n' )

        const parsed = DocumentRegistry.parseQuestions( { content: document } )

        expect( parsed ).toEqual( { openCount: 1, answeredCount: 1, deferredCount: 2 } )
    } )


    it( 'A15 — the label states the third figure when it is non-zero and stays quiet when it is zero', async () => {
        const { normalizeQuestions, questionsLabel } = await extractFunctions( [ 'normalizeQuestions', 'questionsLabel' ] )

        expect( normalizeQuestions( null ) ).toMatchObject( { open: 0, answered: 0, deferred: 0 } )
        expect( questionsLabel( { open: 1, answered: 1, deferred: 2 } ) ).toBe( '1 beantwortet · 1 offen · 2 zurückgestellt' )
        // a memo without a retired stock reads exactly as it did before — the figure is information, not noise.
        expect( questionsLabel( { open: 3, answered: 4, deferred: 0 } ) ).toBe( '4 beantwortet · 3 offen' )
    } )


    it( 'A11 — a rendered answered section is read back with its provenance, so the ai-on-behalf barrier still bites', () => {
        // The bytes below are what the two renderers emit for an answered stock split by provenance
        // (RevisionAssembler.#renderAnsweredQuestions / DoltDbAssembler.#renderAnsweredQuestions). The
        // roundtrip that matters is DB -> file -> parser -> gate: before PRD-F1 the DB render emitted no
        // subsection heading at all, the parser fell back to its 'user' default, and the finalization
        // barrier — which exists so an answer the AI gave in the user's name cannot satisfy the gate on
        // its own — ran empty for every DB-first memo.
        const rendered = [
            '# Memo',
            '',
            '## Beantwortete Fragen',
            '',
            '### Vom User beantwortet',
            '',
            '### F1 — Vom User',
            '',
            '- **Frage (Original):** Wer entscheidet?',
            '- **AI-Empfehlung war:** A',
            '- **User-Entscheidung:** A — der User',
            '',
            '### Von der KI im Namen des Users beantwortet',
            '',
            '### F2 — Stellvertretend',
            '',
            '- **Frage (Original):** Wer entschied hier?',
            '- **AI-Empfehlung war:** B',
            '- **User-Entscheidung:** B — die KI im Namen des Users',
            '- **Beantwortet in:** REV-03',
            ''
        ].join( '\n' )

        const { questions } = DocumentRegistry.parseQuestionSchema( { content: rendered } )
        const answered = questions.filter( ( entry ) => entry[ 'answered' ] === true )

        expect( answered.length ).toBe( 2 )
        expect( answered.map( ( entry ) => [ entry[ 'id' ], entry[ 'answeredBy' ] ] ) ).toEqual( [ [ 'F1', 'user' ], [ 'F2', 'ai-on-behalf' ] ] )
        // the two subsection headings are NOT questions — they carry provenance, they do not add to the stock.
        expect( questions.map( ( entry ) => entry[ 'id' ] ) ).toEqual( [ 'F1', 'F2' ] )
    } )


    it( 'A13 — both renderers hold the retired section and the provenance groups as ONE declared literal each', async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const core = await readFile( join( here, '..', '..', '..', 'core', 'cli', 'src', 'RevisionAssembler.mjs' ), 'utf8' )
            .catch( () => null )
        const viewer = await readFile( join( here, '..', '..', 'src', 'DoltDbAssembler.mjs' ), 'utf8' )

        // The byte-equality itself is proved by the hash-manifested fixture both suites assert against.
        // What is checked HERE is the shape that keeps it provable: each renderer declares the retired
        // status set and the provenance groups ONCE, so a widening is one edit and not a second `||`.
        const declarations = [
            "const DEFERRED_STATUS = [ 'irrelevant', 'replaced' ]",
            "{ value: 'user', heading: 'Vom User beantwortet' }",
            "{ value: 'ai-on-behalf', heading: 'Von der KI im Namen des Users beantwortet' }"
        ]
        declarations
            .forEach( ( literal ) => {
                expect( viewer.split( literal ).length - 1 ).toBe( 1 )
            } )

        // CI checks THIS repo out alone, so the core sibling may legitimately be absent. It is then a
        // NAMED, COUNTED skip of the cross-repo half — never a quiet pass of the whole case.
        const crossRepo = core === null
            ? { checked: 0, skipped: declarations.length, reason: 'the core sibling repo is not checked out beside this one' }
            : { checked: declarations.filter( ( literal ) => core.split( literal ).length - 1 === 1 ).length, skipped: 0, reason: null }
        expect( crossRepo.checked + crossRepo.skipped ).toBe( declarations.length )
        if( core !== null ) {
            expect( crossRepo ).toEqual( { checked: declarations.length, skipped: 0, reason: null } )
        }
    } )


    it( 'the client script really is the file this suite read (comparison basis, not an assumption)', async () => {
        const script = await readEmittedScript()

        expect( script.length ).toBeGreaterThan( 1000 )
        expect( script ).toContain( 'function questionsLabel(' )
    } )
} )
