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


// The gate's selection rule is NOT mirrored here any more (Memo 080, PRD-F4).
// MemoValidator.isQuestionFormatCode IS the rule the server runs — #computeQuestionReject calls
// exactly this predicate — so this driver exercises production code instead of a hand-kept copy.
// The copy it replaces was /^MEMO-(02\d?[a-d]?|03\d|04\d|05\d)\b/, and it is the reason this door
// widened unnoticed: a NUMBER RANGE adopts every code later added inside it, so `03\d` began
// matching the option-QUALITY codes MEMO-034..039 the day they entered the catalogue — on both
// sides at once, which is why a green test could not see it.
const QUESTION_CODE_OLD_RANGE = /^MEMO-(02\d?[a-d]?|03\d|04\d|05\d)\b/


function questionReject( doc ) {
    const validation = MemoValidator.validate( { doc } )
    if( validation[ 'status' ] !== false ) { return { reject: false, messages: [] } }

    const messages = validation[ 'messages' ].filter( ( m ) => MemoValidator.isQuestionFormatCode( { code: m } ).questionFormat === true )

    return { reject: messages.length > 0, messages }
}


// A fully valid revision skeleton with one clean question (status:true).
const VALID_DOC = [
    '# Title', '',
    '| Feld | Wert |', '|------|------|',
    '| **Memo** | 019 |', '| **Memo-Name** | Test |', '| **Revision** | REV-01 |',
    '| **Datum** | 2026-05-27 |', '| **Status** | Entwurf |', 'Schema-Version: 2', '',
    '## Kontext', 'kontext text', '',
    '## Vorwort', 'vorwort text', '',
    '## Offene Fragen', '',
    '### F1 — Eine Frage', '',
    '**Hintergrund:** Hier der Hintergrund.', '',
    '**Frage:** Was soll passieren?', '',
    '**AI-Empfehlung:** A', '',
    'A) Erste Option', 'B) Zweite Option', '',
    '## Beantwortete Fragen', 'keine', '',
    '## Phasen', '### Phase 1: Test', '- [ ] etwas', '',
    '## Phase-Hints', '| phase-id | depends-on |', '|----------|-----------|', '| P1 | — |', '',
    '## Finalisierungs-Checkliste', 'checkliste', '',
    '## Ancillary Files', 'keine', '',
    '## Rollout-Entry-Points', '1. `pfad/datei.mjs` — start', '',
    '## Lessons-Learned', 'noch leer'
].join( '\n' )


// Same skeleton but the open question is missing the AI-Empfehlung -> MEMO-020c.
const MISSING_AI_DOC = VALID_DOC.replace( '**AI-Empfehlung:** A\n', '' )


// A revision whose questions-json block is malformed -> MEMO-050.
const MALFORMED_JSON_DOC = VALID_DOC + '\n\n```questions-json\n{ broken ]\n```\n'


// A pure transcript text / answers-only body — no questions, no sections.
const ANSWERS_ONLY_DOC = '## Antwort auf F1 — Titel\nA) Erste Option'


// Memo 080, PRD-F4 — the THIRD DOOR fixture. A raw transcript body carrying a questions-json block
// whose question is well-formed as a QUESTION (id, Hintergrund, Frage, AI-Empfehlung, two real
// options) but violates the option-QUALITY rules: it carries `dimension` and one `scope`, so it has
// opted into the standard, and it then misses the balance predicate, the option `value`s and the
// option `effect`s -> MEMO-034 + MEMO-035 + MEMO-036.
const transcriptWithQuestionsJson = ( question ) => [
    'Ein Transkript-Text ohne Sections.',
    '',
    '```questions-json',
    JSON.stringify( { questions: [ question ] }, null, 2 ),
    '```',
    ''
].join( '\n' )


const OPTION_QUALITY_ONLY_DOC = transcriptWithQuestionsJson( {
    id: 'F1',
    hintergrund: 'Hintergrund.',
    frage: 'Was soll passieren?',
    aiRecommendation: 'A',
    dimension: 'Zuschnitt',
    options: [
        { key: 'A', label: 'Vollausbau', kind: 'option', scope: 'same' },
        { key: 'B', label: 'Kernschnitt', kind: 'option' }
    ]
} )


// The POSITIVE CONTROL for the fixture above: the SAME body shape, but the defect is an option
// PARSE defect (an option kind outside the render contract -> MEMO-033, theme `optionen`). It must
// still be rejected, otherwise "not rejected" above would prove nothing but a dead gate.
const OPTION_PARSE_DOC = transcriptWithQuestionsJson( {
    id: 'F1',
    hintergrund: 'Hintergrund.',
    frage: 'Was soll passieren?',
    aiRecommendation: 'A',
    options: [
        { key: 'A', label: 'Vollausbau', kind: 'wunschkonzert' },
        { key: 'B', label: 'Kernschnitt', kind: 'option' }
    ]
} )


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


    it( 'does NOT reject a body whose only defect is option QUALITY (Memo 080, PRD-F4 third door)', () => {
        const validation = MemoValidator.validate( { doc: OPTION_QUALITY_ONLY_DOC } )

        // The comparison basis first: the option-quality family really did fire on this body, so a
        // "not rejected" below is a decision about the FILTER and not a vacuum pass.
        expect( validation[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-034' ) ) ).toBe( true )
        expect( validation[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-036' ) ) ).toBe( true )
        expect( validation[ 'optionQuality' ][ 'checked' ] ).toBe( 1 )

        const { reject, messages } = questionReject( OPTION_QUALITY_ONLY_DOC )

        expect( reject ).toBe( false )
        expect( messages ).toEqual( [] )
    } )


    it( 'the OLD number-range filter would have rejected that same body — the widening, pinned', () => {
        // This is the defect the catalogue-driven predicate closes, kept as an executable record:
        // `03\d` matches MEMO-034..039, so the pre-F4 filter turned an option-quality finding into a
        // transcript rejection on a door PRD-F4's Scope never names.
        const validation = MemoValidator.validate( { doc: OPTION_QUALITY_ONLY_DOC } )
        const oldHits = validation[ 'messages' ].filter( ( m ) => QUESTION_CODE_OLD_RANGE.test( m ) )

        expect( oldHits.length ).toBeGreaterThan( 0 )
        expect( oldHits.every( ( m ) => /^MEMO-03[4-9]\b/.test( m ) ) ).toBe( true )
    } )


    it( 'still rejects an option PARSE defect in the same body shape (positive control, MEMO-033)', () => {
        const { reject, messages } = questionReject( OPTION_PARSE_DOC )

        expect( reject ).toBe( true )
        expect( messages.some( ( m ) => m.startsWith( 'MEMO-033' ) ) ).toBe( true )
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
                expect( entry[ 'code' ] ).toMatch( /^(MEMO|INFO|WARN)-\d{3}[a-d]?$/ )
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
        expect( src ).toMatch( /MemoValidator\.isQuestionFormatCode\( \{ code: String\( message \) \} \)\.questionFormat === true/ )
        expect( src ).toMatch( /'reject': false, 'messages': \[\]/ )
    } )


    it( 'the gate selects by catalogue THEME, so no number range can adopt a future code', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )

        // The hand-kept range copy is GONE from the production filter (it survives in this test file
        // only, as the pinned record of the widening it caused).
        expect( src.includes( "/^MEMO-(02\\d?[a-d]?|03\\d|04\\d|05\\d)\\b/.test" ) ).toBe( false )

        const { catalog } = MemoValidator.getCatalog()
        const family = catalog
            .filter( ( entry ) => MemoValidator.isQuestionFormatCode( { code: entry[ 'code' ] } ).questionFormat === true )
            .map( ( entry ) => entry[ 'code' ] )

        // The comparison basis: the family is non-empty AND it is exactly the PRD-004 clean-parse set.
        expect( family.length ).toBeGreaterThan( 0 )
        expect( family.slice().sort() ).toEqual( [ 'MEMO-020a', 'MEMO-020b', 'MEMO-020c', 'MEMO-020d', 'MEMO-025', 'MEMO-030', 'MEMO-031', 'MEMO-032', 'MEMO-033', 'MEMO-040', 'MEMO-050' ] )

        // The six option-QUALITY codes sit in the same number block and are NOT in the family.
        const quality = [ 'MEMO-034', 'MEMO-035', 'MEMO-036', 'MEMO-037', 'MEMO-038', 'MEMO-039' ]
        expect( quality.every( ( code ) => catalog.some( ( entry ) => entry[ 'code' ] === code ) ) ).toBe( true )
        expect( quality.filter( ( code ) => MemoValidator.isQuestionFormatCode( { code } ).questionFormat === true ) ).toEqual( [] )

        // An unknown code is not a reject reason, and a message token is read like a bare code.
        expect( MemoValidator.isQuestionFormatCode( { code: 'MEMO-999' } ).questionFormat ).toBe( false )
        expect( MemoValidator.isQuestionFormatCode( { code: 'MEMO-030 F1.options: text' } ).questionFormat ).toBe( true )
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
