import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoValidator } from '../../src/MemoValidator.mjs'


// PRD-005 (Memo 019, Kap 5): Revisions-Validierung mit Reject + separate /validate-Route.
// The route + reject-gate live in the private #createHttpHandler (no public boot without a
// browser/watchers), so — like ValidationGate.test.mjs (PRD-040) — these tests prove the
// behaviour two ways:
//   1) Decision-logic: replicate the EXACT reject filter the server uses and drive it with
//      real MemoValidator output (AC 1-6 at the truth level: same codes, same status mapping).
//   2) Source-structural: the /api/validate route + the reject-gate are wired with the right
//      HTTP status codes (200/422), call the centralised validator, and run BEFORE addTranscript.

const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewPath = resolve( here, '../../src/MemoView.mjs' )


// The same regex the server uses in #computeQuestionReject — kept in sync with the source.
const QUESTION_CODE_REGEX = /^MEMO-(02\d?[a-d]?|03\d|04\d|05\d)\b/


function questionReject( doc ) {
    const validation = MemoValidator.validate( { doc } )
    if( validation[ 'status' ] !== false ) { return { reject: false, messages: [] } }

    const messages = validation[ 'messages' ].filter( ( m ) => QUESTION_CODE_REGEX.test( m ) )

    return { reject: messages.length > 0, messages }
}


// A fully valid revision skeleton with one clean question (status:true).
const VALID_DOC = [
    '# Title', '',
    '| Feld | Wert |', '|------|------|',
    '| **Memo** | 019 |', '| **Memo-Name** | Test |', '| **Revision** | REV-01 |',
    '| **Datum** | 2026-05-27 |', '| **Status** | Entwurf |', 'Schema-Version: 2', '',
    '## Kontext', 'kontext text', '',
    '## Offene Fragen', '',
    '### F1 — Eine Frage', '',
    '**Hintergrund:** Hier der Hintergrund.', '',
    '**Frage:** Was soll passieren?', '',
    '**AI-Empfehlung:** A', '',
    'A) Erste Option', 'B) Zweite Option', '',
    '## Beantwortete Fragen', 'keine', '',
    '## Phasen', '### Phase 1: Test', '- [ ] etwas', '',
    '## Phase-Hints', '| phase-id | depends-on |', '|----------|-----------|', '| P1 | — |'
].join( '\n' )


// Same skeleton but the open question is missing the AI-Empfehlung -> MEMO-020c.
const MISSING_AI_DOC = VALID_DOC.replace( '**AI-Empfehlung:** A\n', '' )


// A revision whose questions-json block is malformed -> MEMO-050.
const MALFORMED_JSON_DOC = VALID_DOC + '\n\n```questions-json\n{ broken ]\n```\n'


// A pure transcript text / answers-only body — no questions, no sections.
const ANSWERS_ONLY_DOC = '## Antwort auf F1 — Titel\nA) Erste Option'


describe( 'PRD-005 reject-gate decision (truth level, AC 3-6)', () => {
    it( 'accepts a correctly formatted revision (AC-4 accept)', () => {
        const { reject } = questionReject( VALID_DOC )

        expect( reject ).toBe( false )
    } )


    it( 'rejects a revision with a missing AI-Empfehlung via MEMO-020c (AC-3/AC-6)', () => {
        const { reject, messages } = questionReject( MISSING_AI_DOC )

        expect( reject ).toBe( true )
        expect( messages.some( ( m ) => m.startsWith( 'MEMO-020c' ) ) ).toBe( true )
    } )


    it( 'rejects a revision with a malformed questions-json block via MEMO-050 (AC-3/AC-6)', () => {
        const { reject, messages } = questionReject( MALFORMED_JSON_DOC )

        expect( reject ).toBe( true )
        expect( messages.some( ( m ) => m.startsWith( 'MEMO-050' ) ) ).toBe( true )
    } )


    it( 'does NOT reject a pure answers-only body — no questions, no question errors (AC-5)', () => {
        const { reject } = questionReject( ANSWERS_ONLY_DOC )

        expect( reject ).toBe( false )
    } )


    it( 'never rejects on section/header codes alone (transcript text has no sections)', () => {
        // A raw transcript without sections fails the FULL validator (MEMO-001/010), but the
        // question-only filter ignores those — so the reject-gate stays inert (Scope 2).
        const validation = MemoValidator.validate( { doc: 'just some transcript text' } )
        expect( validation[ 'status' ] ).toBe( false )

        const { reject } = questionReject( 'just some transcript text' )
        expect( reject ).toBe( false )
    } )
} )


describe( 'PRD-005 /validate route contract (truth level, AC 1-2)', () => {
    it( 'a valid revision yields status:true with empty messages (HTTP 200 mapping)', () => {
        const validation = MemoValidator.validate( { doc: VALID_DOC } )

        expect( validation[ 'status' ] ).toBe( true )
        expect( validation[ 'messages' ] ).toEqual( [] )
    } )


    it( 'an invalid revision yields status:false with MEMO codes (HTTP 422 mapping)', () => {
        const validation = MemoValidator.validate( { doc: MISSING_AI_DOC } )

        expect( validation[ 'status' ] ).toBe( false )
        expect( validation[ 'messages' ].some( ( m ) => /^MEMO-\d/.test( m ) || /^MEMO-020c/.test( m ) ) ).toBe( true )
    } )
} )


describe( 'PRD-005 node-error-codes conformity (AC-7)', () => {
    it( 'every catalog code follows PREFIX-NUMBER and classify maps prefix to severity', () => {
        const { catalog } = MemoValidator.getCatalog()

        catalog
            .forEach( ( entry ) => {
                expect( entry[ 'code' ] ).toMatch( /^(MEMO|INFO)-\d{3}[a-d]?$/ )
                const { severity } = MemoValidator.classify( { code: entry[ 'code' ] } )
                expect( severity ).toBe( entry[ 'severity' ] )
            } )
    } )


    it( 'ERROR codes land in messages, INFO codes in info (never blocking)', () => {
        // INFO-010 (schema-version) is advisory: omit the marker so it appears, and confirm it
        // does NOT block (status driven only by messages).
        const noMarker = VALID_DOC.replace( 'Schema-Version: 2\n', '' )
        const validation = MemoValidator.validate( { doc: noMarker } )

        expect( validation[ 'info' ].some( ( m ) => m.startsWith( 'INFO-010' ) ) ).toBe( true )
        expect( validation[ 'messages' ].some( ( m ) => m.startsWith( 'INFO-' ) ) ).toBe( false )
        expect( validation[ 'status' ] ).toBe( true )
    } )
} )


describe( 'PRD-005 gate wiring (source-structural)', () => {
    it( 'a centralised #computeQuestionReject helper exists, is defensive and question-scoped', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )

        expect( src ).toMatch( /static #computeQuestionReject\( \{ content \} \)/ )
        expect( src ).toMatch( /MEMO-\(02\\d\?\[a-d\]\?\|03\\d\|04\\d\|05\\d\)/ )
        expect( src ).toMatch( /'reject': false, 'messages': \[\]/ )
    } )


    it( 'the reject-gate runs BEFORE addTranscript and returns 422 with messages', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )

        const gateIdx = src.indexOf( 'const { reject, messages: rejectMessages } = MemoView.#computeQuestionReject' )
        const addIdx = src.indexOf( 'MemoView.#transcriptRegistry.addTranscript( {' )

        expect( gateIdx ).toBeGreaterThan( -1 )
        expect( addIdx ).toBeGreaterThan( gateIdx )
        expect( src ).toMatch( /sendJson\( res, 422, \{ 'error': rejectMessages\.join\( '; ' \), 'messages': rejectMessages \} \)/ )
    } )


    it( 'a read-only POST /api/validate route exists with 200/422 status mapping', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )

        expect( src ).toMatch( /url === '\/api\/validate' && req\.method === 'POST'/ )
        expect( src ).toMatch( /const statusCode = safe\[ 'status' \] === true \? 200 : 422/ )
        expect( src ).toMatch( /sendJson\( res, statusCode, safe \)/ )
    } )
} )
