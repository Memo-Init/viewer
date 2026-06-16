import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoModel } from '../../src/MemoModel.mjs'
import { BlockMeta } from '../../src/BlockMeta.mjs'


// PRD-008 (Memo 016, F5): MemoModel.parse turns memo markdown ONCE into a typed model so rendering
// can be deterministic FROM DATA instead of re-derived from the DOM. This suite proves the parser
// extracts vorwort / sections / questions / topics / blocks / requirements correctly — against a
// REAL committed memo fixture (sample-rev.md, a finalized REV-05) for the common case, and against
// a small synthetic fixture for the fields the finalized memo does not exercise (open questions,
// topics, block-meta, requirements). It also checks purity (deterministic) and empty/edge inputs.

const here = dirname( fileURLToPath( import.meta.url ) )


// A compact synthetic memo carrying every field type: open + answered questions, a topics block,
// a block-meta fence (parent + child), explicit REQ-NNN refs and req-* slugs. Used to prove the
// fields the finalized fixture leaves empty actually populate.
const SYNTHETIC = [
    '# Mein Memo-Titel',
    '',
    '## Vorwort',
    '',
    'Ein kurzes Vorwort von Claude.',
    '',
    '## Topics',
    '',
    'Dieses Memo betrifft T012 und T045.',
    '',
    '## Kapitel Über Größe & Ähnliches [Code]',
    '',
    'Body mit einer REQ-007 Referenz und einem req-secrets Slug.',
    '',
    '```block-meta',
    '{ "id": "B001", "topics": ["T012"], "prds": ["PRD-001"], "requirements": ["req-coverage"] }',
    '```',
    '',
    '## Offene Fragen',
    '',
    '### F1 — Erste offene Frage',
    '',
    '- **Frage:** Soll Variante A gewählt werden?',
    '- **AI-Empfehlung:** Ja, Variante A.',
    '',
    '### F2 — Zweite offene Frage',
    '',
    '- **Frage:** Topic jetzt oder später?',
    '',
    '## Beantwortete Fragen',
    '',
    '### F3 — Schon beantwortet',
    '',
    '- **Frage (Original):** War das gut?',
    '- **User-Entscheidung:** Ja.',
    '- **Beantwortet in:** REV-01',
    ''
].join( '\n' )


describe( 'MemoModel.parse on a real finalized memo (PRD-008)', () => {
    it( 'returns the full typed shape with all six fields', async () => {
        const md = await readFile( resolve( here, '../fixtures/sample-rev.md' ), 'utf-8' )
        const model = MemoModel.parse( { markdown: md } )

        expect( Object.keys( model ).sort() )
            .toEqual( [ 'blocks', 'questions', 'requirements', 'sections', 'topics', 'vorwort' ] )
    } )

    it( 'extracts the Vorwort body (non-empty, contains the lead sentence)', async () => {
        const md = await readFile( resolve( here, '../fixtures/sample-rev.md' ), 'utf-8' )
        const { vorwort } = MemoModel.parse( { markdown: md } )

        expect( typeof vorwort ).toBe( 'string' )
        expect( vorwort.length ).toBeGreaterThan( 0 )
        expect( vorwort ).toContain( 'server-seitige Revisions-Validierung mit Error-Codes' )
    } )

    it( 'extracts sections with levels, titles and viewer-consistent slugs', async () => {
        const md = await readFile( resolve( here, '../fixtures/sample-rev.md' ), 'utf-8' )
        const { sections } = MemoModel.parse( { markdown: md } )

        // Every section is H2+ and carries the four typed keys.
        expect( sections.length ).toBeGreaterThan( 0 )
        sections.forEach( ( section ) => {
            expect( section.level ).toBeGreaterThanOrEqual( 2 )
            expect( typeof section.title ).toBe( 'string' )
            expect( typeof section.slug ).toBe( 'string' )
            expect( typeof section.body ).toBe( 'string' )
        } )

        const byTitle = sections.find( ( section ) => section.title === 'Kontext' )
        expect( byTitle ).toBeDefined()
        expect( byTitle.level ).toBe( 2 )
        expect( byTitle.slug ).toBe( 'kontext' )

        // Slug rule mirrors MemoView.slugify: umlaut/punctuation collapse to "-" separators.
        const chapter1 = sections.find( ( section ) => section.title.startsWith( '1. Ausgangslage' ) )
        expect( chapter1.slug ).toBe( '1-ausgangslage-problem-kontext-docs' )

        // The known H2 set of the finalized fixture is captured.
        const h2Titles = sections
            .filter( ( section ) => section.level === 2 )
            .map( ( section ) => section.title )
        expect( h2Titles ).toEqual( expect.arrayContaining( [ 'Vorwort', 'Offene Fragen', 'Beantwortete Fragen', 'Phasen' ] ) )
    } )

    it( 'extracts the answered questions as F-ids', async () => {
        const md = await readFile( resolve( here, '../fixtures/sample-rev.md' ), 'utf-8' )
        const { questions } = MemoModel.parse( { markdown: md } )

        const ids = questions.map( ( question ) => question.id )
        expect( ids ).toEqual( [ 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7' ] )
        questions.forEach( ( question ) => {
            expect( question.answered ).toBe( true )
            expect( typeof question.text ).toBe( 'string' )
        } )
    } )

    it( 'blocks/topics/requirements are [] when the memo declares none (no false positives)', async () => {
        const md = await readFile( resolve( here, '../fixtures/sample-rev.md' ), 'utf-8' )
        const { blocks, topics, requirements } = MemoModel.parse( { markdown: md } )

        expect( blocks ).toEqual( [] )
        expect( topics ).toEqual( [] )
        expect( requirements ).toEqual( [] )
    } )

    it( 'is deterministic — same input yields a deeply equal model', async () => {
        const md = await readFile( resolve( here, '../fixtures/sample-rev.md' ), 'utf-8' )
        const first = MemoModel.parse( { markdown: md } )
        const second = MemoModel.parse( { markdown: md } )

        expect( first ).toEqual( second )
    } )
} )


describe( 'MemoModel.parse on a synthetic memo exercising every field (PRD-008)', () => {
    const model = MemoModel.parse( { markdown: SYNTHETIC } )

    it( 'captures the Vorwort body', () => {
        expect( model.vorwort ).toContain( 'Ein kurzes Vorwort von Claude.' )
    } )

    it( 'slugifies an umlaut/punctuation chapter title via the shared rule', () => {
        const chapter = model.sections.find( ( section ) => section.title.startsWith( 'Kapitel' ) )
        expect( chapter ).toBeDefined()
        expect( chapter.slug ).toBe( 'kapitel-ueber-groesse-aehnliches-code' )
    } )

    it( 'parses open AND answered questions with the answered flag', () => {
        const ids = model.questions.map( ( question ) => question.id )
        expect( ids ).toEqual( expect.arrayContaining( [ 'F1', 'F2', 'F3' ] ) )

        const open = model.questions.find( ( question ) => question.id === 'F1' )
        const answered = model.questions.find( ( question ) => question.id === 'F3' )
        expect( open.answered ).toBe( false )
        expect( answered.answered ).toBe( true )
        expect( open.text.length ).toBeGreaterThan( 0 )
    } )

    it( 'extracts topics from the topics section AND the block-meta fence, deduped', () => {
        expect( model.topics ).toEqual( expect.arrayContaining( [ 'T012', 'T045' ] ) )
        // T012 appears in both the prose topics section and the block-meta fence -> deduped once.
        expect( model.topics.filter( ( topic ) => topic === 'T012' ).length ).toBe( 1 )
    } )

    it( 'delegates block parsing to BlockMeta (same result as BlockMeta.parse)', () => {
        const { blocks } = BlockMeta.parse( { doc: SYNTHETIC } )
        expect( model.blocks ).toEqual( blocks )
        expect( model.blocks.length ).toBe( 1 )
        expect( model.blocks[ 0 ].id ).toBe( 'B001' )
    } )

    it( 'collects requirement ids from prose REQ-NNN, req-* slugs and block-meta, deduped', () => {
        expect( model.requirements ).toEqual( expect.arrayContaining( [ 'REQ-007', 'req-secrets', 'req-coverage' ] ) )
        const unique = new Set( model.requirements )
        expect( unique.size ).toBe( model.requirements.length )
    } )
} )


describe( 'MemoModel.parse edge cases (PRD-008)', () => {
    it( 'returns a fully-shaped empty model for an empty string', () => {
        expect( MemoModel.parse( { markdown: '' } ) )
            .toEqual( { vorwort: '', sections: [], questions: [], topics: [], blocks: [], requirements: [] } )
    } )

    it( 'returns a fully-shaped empty model for a non-string input', () => {
        expect( MemoModel.parse( { markdown: null } ) )
            .toEqual( { vorwort: '', sections: [], questions: [], topics: [], blocks: [], requirements: [] } )
        expect( MemoModel.parse( { markdown: undefined } ) )
            .toEqual( { vorwort: '', sections: [], questions: [], topics: [], blocks: [], requirements: [] } )
    } )

    it( 'does not treat a "## " heading inside a fenced code block as a section', () => {
        const md = [
            '# Titel',
            '',
            '## Echtes Kapitel',
            '',
            '```',
            '## Nicht-Kapitel im Codeblock',
            '```',
            ''
        ].join( '\n' )
        const { sections } = MemoModel.parse( { markdown: md } )
        const titles = sections.map( ( section ) => section.title )

        expect( titles ).toContain( 'Echtes Kapitel' )
        expect( titles ).not.toContain( 'Nicht-Kapitel im Codeblock' )
    } )

    it( 'de-duplicates colliding heading slugs with a numeric suffix (like the renderer)', () => {
        const md = [
            '# Titel',
            '## Offene Fragen',
            'a',
            '## Offene Fragen',
            'b',
            ''
        ].join( '\n' )
        const { sections } = MemoModel.parse( { markdown: md } )
        const slugs = sections.map( ( section ) => section.slug )

        expect( slugs ).toEqual( [ 'offene-fragen', 'offene-fragen-1' ] )
    } )

    it( 'matches MemoModel.slugify to the documented MemoView rule', () => {
        expect( MemoModel.slugify( { text: 'Über Größe & Ähnliches!' } ).slug ).toBe( 'ueber-groesse-aehnliches' )
        expect( MemoModel.slugify( { text: '' } ).slug ).toBe( '' )
        expect( MemoModel.slugify( { text: null } ).slug ).toBe( '' )
    } )
} )
