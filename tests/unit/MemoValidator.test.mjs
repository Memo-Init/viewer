import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoValidator } from '../../src/MemoValidator.mjs'


// PRD-036/037/038 (Memo 016, Kap 13): MemoValidator structural validation.
// Result shape { status, messages, info }; status = messages.length === 0 (never manual);
// info is advisory and never blocks. Codes follow PREFIX-NUMBER (node-error-codes).

const CODE_REGEX = /^([A-Z]{3,4}-\d{3})/


// A fully valid revision skeleton — all required sections + header + a clean question.
const VALID_DOC = [
    '# Title',
    '',
    '| Feld | Wert |',
    '|------|------|',
    '| **Memo** | 016 |',
    '| **Memo-Name** | Test |',
    '| **Revision** | REV-01 |',
    '| **Datum** | 2026-05-26 |',
    '| **Status** | Entwurf |',
    'Schema-Version: 2',
    '',
    '## Kontext',
    'kontext text',
    '',
    '## Offene Fragen',
    '',
    '### F1 — Eine Frage',
    '',
    '**Hintergrund:** Hier der Hintergrund.',
    '',
    '**Frage:** Was soll passieren?',
    '',
    '**AI-Empfehlung:** A',
    '',
    'A) Erste Option',
    'B) Zweite Option',
    '',
    '## Beantwortete Fragen',
    'keine',
    '',
    '## Phasen',
    '### Phase 1: Test',
    '- [ ] etwas',
    '',
    '## Phase-Hints',
    '| phase-id | depends-on |',
    '|----------|-----------|',
    '| P1 | — |'
].join( '\n' )


describe( 'MemoValidator.validate — result shape & status (PRD-036)', () => {
    it( 'returns exactly the keys status, messages, info', () => {
        const result = MemoValidator.validate( { doc: VALID_DOC } )

        expect( Object.keys( result ).sort() ).toEqual( [ 'info', 'messages', 'status' ] )
        expect( Array.isArray( result[ 'messages' ] ) ).toBe( true )
        expect( Array.isArray( result[ 'info' ] ) ).toBe( true )
        expect( typeof result[ 'status' ] ).toBe( 'boolean' )
    } )


    it( 'status is true exactly when messages is empty (positive case)', () => {
        const result = MemoValidator.validate( { doc: VALID_DOC } )

        expect( result[ 'messages' ] ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
    } )


    it( 'info entries do not affect status', () => {
        const docNoSchema = VALID_DOC.replace( 'Schema-Version: 2\n', '' )
        const result = MemoValidator.validate( { doc: docNoSchema } )

        expect( result[ 'info' ].length ).toBeGreaterThan( 0 )
        expect( result[ 'messages' ] ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
    } )


    it( 'every message and info string starts with a PREFIX-NUMBER code', () => {
        const docNoSchema = VALID_DOC.replace( '## Kontext\nkontext text\n\n', '' ).replace( 'Schema-Version: 2\n', '' )
        const result = MemoValidator.validate( { doc: docNoSchema } )
        const all = result[ 'messages' ].concat( result[ 'info' ] )

        all
            .forEach( ( line ) => {
                expect( line ).toMatch( CODE_REGEX )
            } )
    } )


    it( 'never throws on invalid input and blocks with a code (MEMO-002)', () => {
        const cases = [ undefined, null, 123, '', {} ]

        cases
            .forEach( ( value ) => {
                const result = MemoValidator.validate( { doc: value } )

                expect( result[ 'status' ] ).toBe( false )
                expect( result[ 'messages' ].length ).toBeGreaterThan( 0 )
                expect( result[ 'messages' ][ 0 ] ).toMatch( /^MEMO-002/ )
            } )
    } )
} )


describe( 'MemoValidator catalogue, classify & message-builder (PRD-037)', () => {
    it( 'every catalogue code matches the PREFIX-NUMBER regex', () => {
        const { catalog } = MemoValidator.getCatalog()

        catalog
            .forEach( ( entry ) => {
                expect( entry[ 'code' ] ).toMatch( CODE_REGEX )
            } )
    } )


    it( 'has no duplicate full codes (suffix distinguishes variants)', () => {
        const { catalog } = MemoValidator.getCatalog()
        const codes = catalog.map( ( entry ) => entry[ 'code' ] )
        const unique = new Set( codes )

        expect( unique.size ).toBe( codes.length )
    } )


    it( 'classify maps MEMO -> ERROR and INFO -> INFO', () => {
        expect( MemoValidator.classify( { code: 'MEMO-020a' } )[ 'severity' ] ).toBe( 'ERROR' )
        expect( MemoValidator.classify( { code: 'MEMO-001' } )[ 'severity' ] ).toBe( 'ERROR' )
        expect( MemoValidator.classify( { code: 'INFO-010' } )[ 'severity' ] ).toBe( 'INFO' )
    } )
} )


describe( 'MemoValidator required sections (MEMO-001)', () => {
    it( 'flags each missing required section', () => {
        const result = MemoValidator.validate( { doc: '## Kontext\nx\nSchema-Version: 2' } )
        const sectionMsgs = result[ 'messages' ].filter( ( m ) => m.startsWith( 'MEMO-001' ) )

        // Offene Fragen, Beantwortete Fragen, Phasen, Phase-Hints all missing -> 4.
        expect( sectionMsgs.length ).toBe( 4 )
        expect( result[ 'status' ] ).toBe( false )
    } )
} )


describe( 'MemoValidator header fields (MEMO-010 / INFO-010)', () => {
    it( 'flags a missing header field as MEMO-010', () => {
        const doc = VALID_DOC.replace( '| **Datum** | 2026-05-26 |\n', '' )
        const result = MemoValidator.validate( { doc } )
        const headerMsgs = result[ 'messages' ].filter( ( m ) => m.startsWith( 'MEMO-010' ) )

        expect( headerMsgs.length ).toBe( 1 )
        expect( headerMsgs[ 0 ] ).toMatch( /header\.Datum/ )
    } )


    it( 'flags an empty header field as MEMO-010', () => {
        const doc = VALID_DOC.replace( '| **Status** | Entwurf |', '| **Status** |  |' )
        const result = MemoValidator.validate( { doc } )
        const headerMsgs = result[ 'messages' ].filter( ( m ) => m.startsWith( 'MEMO-010' ) )

        expect( headerMsgs.length ).toBe( 1 )
    } )


    it( 'missing Schema-Version marker is advisory INFO-010, never blocking (H3)', () => {
        const doc = VALID_DOC.replace( 'Schema-Version: 2\n', '' )
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'info' ].some( ( m ) => m.startsWith( 'INFO-010' ) ) ).toBe( true )
        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'INFO-010' ) ) ).toBe( false )
    } )
} )


describe( 'MemoValidator question checks (PRD-038)', () => {
    it( 'missing AI-Empfehlung yields exactly one MEMO-020c with field path', () => {
        const doc = VALID_DOC.replace( '**AI-Empfehlung:** A\n\n', '' )
        const result = MemoValidator.validate( { doc } )
        const aiMsgs = result[ 'messages' ].filter( ( m ) => m.startsWith( 'MEMO-020c' ) )

        expect( aiMsgs.length ).toBe( 1 )
        expect( aiMsgs[ 0 ] ).toMatch( /F1\.aiEmpfehlung:/ )
        expect( aiMsgs[ 0 ] ).toMatch( /Missing required field/ )
    } )


    it( 'missing Hintergrund yields MEMO-020a', () => {
        const doc = VALID_DOC.replace( '**Hintergrund:** Hier der Hintergrund.\n\n', '' )
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-020a' ) ) ).toBe( true )
    } )


    it( 'missing Frage yields MEMO-020b', () => {
        const doc = VALID_DOC.replace( '**Frage:** Was soll passieren?\n\n', '' )
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-020b' ) ) ).toBe( true )
    } )


    it( 'AI-Empfehlung referencing no existing option yields MEMO-020d (malformed)', () => {
        // Options are A and B; recommend D (a valid A-H letter that maps to no option).
        const doc = VALID_DOC.replace( '**AI-Empfehlung:** A', '**AI-Empfehlung:** D' )
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-020d' ) ) ).toBe( true )
    } )


    it( 'cascade: a question missing both Hintergrund AND AI-Empfehlung yields one message per field', () => {
        const doc = VALID_DOC
            .replace( '**Hintergrund:** Hier der Hintergrund.\n\n', '' )
            .replace( '**AI-Empfehlung:** A\n\n', '' )
        const result = MemoValidator.validate( { doc } )
        const f1Msgs = result[ 'messages' ].filter( ( m ) => /F1\./.test( m ) )

        // exactly one per affected field — no double-reporting of the same field.
        expect( f1Msgs.filter( ( m ) => /F1\.hintergrund/.test( m ) ).length ).toBe( 1 )
        expect( f1Msgs.filter( ( m ) => /F1\.aiEmpfehlung/.test( m ) ).length ).toBe( 1 )
    } )


    it( 'option markers the parser cannot read (bracket form) yield MEMO-030', () => {
        // The Phase-5 parser is paren-tolerant, so "(A)/(B)" now PARSE. The residual
        // not-parseable form is bracket markers "[A] ... [B] ..." — >= 2 distinct marker
        // letters present, but #extractOptions produces 0 real options.
        const doc = VALID_DOC.replace(
            'A) Erste Option\nB) Zweite Option',
            'Soll [A] die erste [B] die zweite gewaehlt werden?'
        )
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-030' ) ) ).toBe( true )
    } )


    it( 'a markdown checklist is auto-classified multi, so no MEMO-040', () => {
        // #detectType turns >= 2 checkbox items into typ=multi automatically, so a checklist
        // written in markdown is consistent and must NOT be flagged.
        const doc = VALID_DOC.replace(
            'A) Erste Option\nB) Zweite Option',
            '- [ ] erste\n- [ ] zweite'
        ).replace( '**AI-Empfehlung:** A', '**AI-Empfehlung:** keine' )
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-040' ) ) ).toBe( false )
    } )


    it( 'a checklist with forced typ=single (JSON source) yields MEMO-040', () => {
        const jsonBlock = [
            '```questions-json',
            JSON.stringify( [ {
                'id': 'F1',
                'title': 'Checkliste',
                'hintergrund': 'h',
                'frage': 'f',
                'aiRecommendation': 'A',
                'typ': 'single',
                'options': [ { 'key': 'A', 'label': 'a', 'kind': 'option' }, { 'key': 'B', 'label': 'b', 'kind': 'option' } ],
                'answered': false
            } ] ),
            '```'
        ].join( '\n' )

        const doc = VALID_DOC
            .replace( '### F1 — Eine Frage', '### F1 — Checkliste\n\n- [ ] erste\n- [ ] zweite\n' )
            + '\n\n' + jsonBlock

        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-040' ) ) ).toBe( true )
    } )


    it( 'parse re-check: an F-heading the parser misses yields MEMO-025', () => {
        // Add a JSON block declaring only 1 question while markdown has 2 headings.
        const doc = VALID_DOC.replace(
            '### F1 — Eine Frage',
            '### F3 — Zweite Frage\n\n**Hintergrund:** x\n\n**Frage:** y\n\n**AI-Empfehlung:** A\n\nA) opt\n\n### F1 — Eine Frage'
        ) + '\n\n```questions-json\n' + JSON.stringify( [ { 'id': 'F1', 'frage': 'y', 'hintergrund': 'x', 'aiRecommendation': 'A', 'typ': 'single', 'options': [ { 'key': 'A', 'label': 'a', 'kind': 'option' } ] } ] ) + '\n```'
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-025' ) ) ).toBe( true )
    } )


    it( 'a fully correct question produces no question message', () => {
        const result = MemoValidator.validate( { doc: VALID_DOC } )
        const questionMsgs = result[ 'messages' ].filter( ( m ) => /^MEMO-02|^MEMO-03|^MEMO-04/.test( m ) )

        expect( questionMsgs ).toEqual( [] )
    } )
} )


describe( 'MemoValidator JSON block (MEMO-050, PRD-039)', () => {
    it( 'a malformed questions-json block yields MEMO-050', () => {
        const doc = VALID_DOC + '\n\n```questions-json\n{ not valid json ]\n```'
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-050' ) ) ).toBe( true )
    } )
} )


describe( 'MemoValidator on a real finalized memo (positive smoke)', () => {
    it( 'a real finalized REV validates to status=true (no blocking messages)', async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        // Committed fixture (a real finalized REV-05) — kept in-repo so the test is
        // self-contained and does not depend on the workbench .memo/ tree (CI isolation).
        const revPath = resolve( here, '../fixtures/sample-rev.md' )
        const content = await readFile( revPath, 'utf-8' )
        const result = MemoValidator.validate( { doc: content } )

        expect( result[ 'messages' ] ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
    } )
} )
