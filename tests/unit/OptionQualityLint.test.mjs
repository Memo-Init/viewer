import { describe, it, expect } from '@jest/globals'
import { OptionQualityLint } from '../../src/OptionQualityLint.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'


// Memo 080, PRD-F4 (Kap 18) — the option-quality rules as a decidable predicate.
//
// The suite is built as a POSITIVE CONTROL per code, which is the only construction that proves a
// code exists rather than merely compiles: one clean base question that fires NOTHING, then exactly
// one perturbation per code. Each test asserts the DISTINCT CODE SET — not "contains" — so a code
// that fires next to its neighbours fails just as loudly as a code that never fires at all.
//
// A code without its own fixture counts as unverified. All eleven have one below.


// A synthetic register, deliberately tiny and NOT the live spec/data/anchor-terms.json: a unit test
// that reads a file outside the repo is a test that goes red in a clean CI checkout.
const REGISTER = [
    { 'id': 'AT-memo', 'label': 'Memo', 'misLabels': [ 'document', 'spec doc' ] },
    { 'id': 'AT-revision', 'label': 'Revision', 'misLabels': [ 'version' ] }
]


// The clean base question: it satisfies all eight rules, so every finding a perturbed copy produces
// is attributable to the ONE field that was changed.
function cleanQuestion() {
    return {
        'id': 'F1',
        'title': 'Zuschnitt der Umsetzung',
        'type': 'single',
        'background': 'Der Zuschnitt entscheidet, wie viel in dieser Phase gebaut wird.',
        'question': 'Welchen Zuschnitt bauen wir?',
        'recommendation': 'A',
        'dimension': 'Zuschnitt der Umsetzung',
        'mentalModelCheck': 'aligned',
        'answered': false,
        'options': [
            { 'key': 'A', 'label': 'Vollausbau', 'kind': 'option', 'value': 'vollausbau',
              'effect': 'Alle Regeln greifen mit dieser Revision', 'scope': 'same', 'continues': true },
            { 'key': 'B', 'label': 'Kernschnitt', 'kind': 'option', 'value': 'kernschnitt',
              'effect': 'Nur die sechs harten Regeln greifen', 'scope': 'smaller' }
        ]
    }
}


// Perturb the base question through a mutator and return the DISTINCT sorted code set of the run.
function codesOf( { mutate, anchorTerms } ) {
    const question = cleanQuestion()
    mutate( question )
    const result = OptionQualityLint.check( { questions: [ question ], anchorTerms } )
    const codes = result[ 'findings' ].map( ( finding ) => finding[ 'code' ] )

    return { 'codes': [ ...new Set( codes ) ].sort(), 'result': result }
}


function buildQuestionsJsonDoc( { questions } ) {
    return '# Test\n\n## Offene Fragen\n\n```questions-json\n' + JSON.stringify( questions ) + '\n```\n'
}


describe( 'PRD-F4 — the clean base fires nothing (the negative control the positives rest on)', () => {
    it( 'reports zero findings and states its comparison basis', () => {
        const { codes, result } = codesOf( { 'mutate': () => {}, 'anchorTerms': REGISTER } )

        expect( codes ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'checked' ] ).toBe( 1 )
        expect( result[ 'skippedAnswered' ] ).toBe( 0 )
        expect( result[ 'skippedLegacy' ] ).toBe( 0 )
        expect( result[ 'registerAvailable' ] ).toBe( true )
    } )


    it( 'treats an option with an OMITTED kind as a real option (the render contract default)', () => {
        // Without this reading every legal block that simply omits `kind` would count zero real
        // options and fire MEMO-034 — a false positive over the whole stock.
        const { codes } = codesOf( {
            'mutate': ( q ) => {
                q[ 'options' ].forEach( ( option ) => { delete option[ 'kind' ] } )
            },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [] )
    } )


    it( 'never counts the injected siblings toward the balance predicate', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => {
                q[ 'options' ].push( { 'key': 'C', 'label': 'eigene Antwort', 'kind': 'custom' } )
                q[ 'options' ].push( { 'key': 'D', 'label': 'Frage neu formulieren', 'kind': 'reframe' } )
            },
            'anchorTerms': REGISTER
        } )

        // The two siblings carry no value/effect/scope; if they counted as real options they would
        // fire MEMO-035 and MEMO-036 at once.
        expect( codes ).toEqual( [] )
    } )
} )


describe( 'PRD-F4 — one positive control per ERROR code', () => {
    it( 'MEMO-034 fires when the smaller cut is missing (A1)', () => {
        const { codes, result } = codesOf( {
            'mutate': ( q ) => { delete q[ 'options' ][ 1 ][ 'scope' ] },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-034' ] )
        expect( result[ 'findings' ][ 0 ][ 'description' ] ).toContain( 'smaller cut' )
    } )


    it( 'MEMO-034 fires when the way forward is missing (only stop-options)', () => {
        const { codes, result } = codesOf( {
            'mutate': ( q ) => {
                q[ 'options' ][ 0 ][ 'scope' ] = 'smaller'
                delete q[ 'options' ][ 0 ][ 'continues' ]
            },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-034' ] )
        expect( result[ 'findings' ][ 0 ][ 'description' ] ).toContain( 'way forward' )
    } )


    it( 'MEMO-034 fires on a scope outside the closed list, because the predicate is then undecidable', () => {
        const { codes, result } = codesOf( {
            'mutate': ( q ) => { q[ 'options' ][ 1 ][ 'scope' ] = 'tiny' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-034' ] )
        // Two findings under the one code: the unknown scope AND the balance it made undecidable.
        expect( result[ 'findings' ].length ).toBe( 2 )
        expect( result[ 'findings' ].map( ( f ) => f[ 'description' ] ).join( ' ' ) ).toContain( 'outside the closed list' )
    } )


    it( 'MEMO-035 fires when "dimension" is missing (A2)', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => { delete q[ 'dimension' ] },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-035' ] )
    } )


    it( 'MEMO-035 fires when an option carries no "value"', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => { delete q[ 'options' ][ 1 ][ 'value' ] },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-035' ] )
    } )


    it( 'MEMO-035 fires when two options take the same value on the dimension', () => {
        const { codes, result } = codesOf( {
            'mutate': ( q ) => { q[ 'options' ][ 1 ][ 'value' ] = 'Vollausbau' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-035' ] )
        expect( result[ 'findings' ][ 0 ][ 'description' ] ).toContain( 'same value' )
    } )


    it( 'MEMO-036 fires on a real option without a non-empty "effect" (A3)', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => { q[ 'options' ][ 1 ][ 'effect' ] = '   ' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-036' ] )
    } )


    it( 'MEMO-037 fires on a time expression in an option label (A4)', () => {
        const { codes, result } = codesOf( {
            'mutate': ( q ) => { q[ 'options' ][ 0 ][ 'label' ] = 'Vollausbau jetzt' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-037' ] )
        expect( result[ 'findings' ][ 0 ][ 'description' ] ).toContain( 'jetzt' )
    } )


    it( 'MEMO-037 fires on a time expression in an option value', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => { q[ 'options' ][ 1 ][ 'value' ] = 'kernschnitt, erst wenn P11 steht' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-037' ] )
    } )


    it( 'MEMO-038 fires when an option names a postponement but no "deferCost" (A5)', () => {
        const { codes, result } = codesOf( {
            'mutate': ( q ) => { q[ 'options' ][ 1 ][ 'effect' ] = 'Der Rest wird zurueckgestellt' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-038' ] )
        expect( result[ 'findings' ][ 0 ][ 'description' ] ).toContain( 'deferCost' )
    } )


    it( 'MEMO-038 does NOT fire once the postponement names its price', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => {
                q[ 'options' ][ 1 ][ 'effect' ] = 'Der Rest wird zurueckgestellt'
                q[ 'options' ][ 1 ][ 'deferCost' ] = 'Ein zweiter Planungsdurchgang in der naechsten Phase'
            },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [] )
    } )


    it( 'MEMO-039 fires when a declared sharedPremise has no denying option (A6)', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => { q[ 'sharedPremise' ] = 'Wir bauen in dieser Phase ueberhaupt etwas' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'MEMO-039' ] )
    } )


    it( 'MEMO-039 fires when TWO options deny the premise, and is silent at exactly one', () => {
        const two = codesOf( {
            'mutate': ( q ) => {
                q[ 'sharedPremise' ] = 'Wir bauen in dieser Phase ueberhaupt etwas'
                q[ 'options' ][ 0 ][ 'deniesPremise' ] = true
                q[ 'options' ][ 1 ][ 'deniesPremise' ] = true
            },
            'anchorTerms': REGISTER
        } )
        const one = codesOf( {
            'mutate': ( q ) => {
                q[ 'sharedPremise' ] = 'Wir bauen in dieser Phase ueberhaupt etwas'
                q[ 'options' ][ 1 ][ 'deniesPremise' ] = true
            },
            'anchorTerms': REGISTER
        } )

        expect( two[ 'codes' ] ).toEqual( [ 'MEMO-039' ] )
        expect( one[ 'codes' ] ).toEqual( [] )
    } )
} )


describe( 'PRD-F4 — one positive control per WARNING code', () => {
    it( 'WARN-030 fires on a question sentence that bundles two decisions (R1)', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => { q[ 'question' ] = 'Welchen Zuschnitt bauen wir, und mit welchem Werkzeug?' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'WARN-030' ] )
    } )


    it( 'WARN-030 also reads the German legacy field name "frage"', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => {
                delete q[ 'question' ]
                q[ 'frage' ] = 'Bauen wir den Vollausbau, und wie sichern wir ihn ab?'
            },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'WARN-030' ] )
    } )


    it( 'WARN-031 fires on an option label that couples goal and measure (R3)', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => { q[ 'options' ][ 0 ][ 'label' ] = 'Vollausbau und Lint' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'WARN-031' ] )
    } )


    it( 'WARN-032 fires on a non-approved word from the register (A7)', () => {
        const { codes, result } = codesOf( {
            'mutate': ( q ) => { q[ 'title' ] = 'Zuschnitt des document' },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'WARN-032' ] )
        expect( result[ 'findings' ][ 0 ][ 'description' ] ).toContain( 'Memo' )
    } )


    it( 'WARN-033 fires when the mental-model note is missing (A8)', () => {
        const { codes } = codesOf( {
            'mutate': ( q ) => { delete q[ 'mentalModelCheck' ] },
            'anchorTerms': REGISTER
        } )

        expect( codes ).toEqual( [ 'WARN-033' ] )
    } )
} )


describe( 'PRD-F4 — no vacuum green (A11) and no silent default (A12)', () => {
    it( 'INFO-020: a block whose questions are ALL answered reports that it compared nothing', () => {
        const answered = cleanQuestion()
        answered[ 'answered' ] = true
        // Every rule is violated on this record; none of it may be graded. This is ALSO the pin of A10's
        // SUBSTITUTION (see the head of OptionQualityLint.mjs): the PRD's "bei answered: true degradieren
        // sie zu INFO" is deliberately replaced by a counted skip, so the record must produce NO finding at
        // ANY severity — while `skippedAnswered` states that it was passed over. A degrade would emit
        // advice the PRD's own Out of Scope forbids anyone from acting on.
        delete answered[ 'dimension' ]
        delete answered[ 'mentalModelCheck' ]
        answered[ 'options' ].forEach( ( option ) => { delete option[ 'effect' ] } )

        const result = OptionQualityLint.check( { 'questions': [ answered ], 'anchorTerms': REGISTER } )

        expect( result[ 'findings' ].map( ( f ) => f[ 'code' ] ) ).toEqual( [ 'INFO-020' ] )
        expect( result[ 'checked' ] ).toBe( 0 )
        expect( result[ 'skippedAnswered' ] ).toBe( 1 )
        expect( result[ 'findings' ][ 0 ][ 'description' ] ).toContain( '0 open questions' )
        expect( result[ 'findings' ][ 0 ][ 'description' ] ).toContain( '1 answered' )
        // GEGENPROBE that the zero above is a SKIP and not a clean record: the identical question with
        // `answered` removed fires four blocking codes. So the detector works and the skip is what silences
        // it — a positive control against exactly the vacuum-green reading.
        const open = cleanQuestion()
        delete open[ 'dimension' ]
        delete open[ 'mentalModelCheck' ]
        open[ 'options' ].forEach( ( option ) => { delete option[ 'effect' ] } )
        const control = OptionQualityLint.check( { 'questions': [ open ], 'anchorTerms': REGISTER } )
        const controlCodes = [ ...new Set( control[ 'findings' ].map( ( f ) => f[ 'code' ] ) ) ].sort()

        expect( controlCodes ).toEqual( [ 'MEMO-035', 'MEMO-036', 'WARN-033' ] )
        expect( control[ 'checked' ] ).toBe( 1 )
    } )


    it( 'INFO-020: an EMPTY block is the same statement — nothing was compared', () => {
        const result = OptionQualityLint.check( { 'questions': [], 'anchorTerms': REGISTER } )

        expect( result[ 'findings' ].map( ( f ) => f[ 'code' ] ) ).toEqual( [ 'INFO-020' ] )
        expect( result[ 'checked' ] ).toBe( 0 )
    } )


    it( 'without a register WARN-032 is NOT reported and registerAvailable says why', () => {
        const withRegister = codesOf( {
            'mutate': ( q ) => { q[ 'title' ] = 'Zuschnitt des document' },
            'anchorTerms': REGISTER
        } )
        const without = codesOf( {
            'mutate': ( q ) => { q[ 'title' ] = 'Zuschnitt des document' },
            'anchorTerms': undefined
        } )
        const empty = codesOf( {
            'mutate': ( q ) => { q[ 'title' ] = 'Zuschnitt des document' },
            'anchorTerms': []
        } )

        expect( withRegister[ 'codes' ] ).toEqual( [ 'WARN-032' ] )
        expect( withRegister[ 'result' ][ 'registerAvailable' ] ).toBe( true )
        // An ABSENT and an EMPTY register are the same statement: the rule had nothing to compare
        // against and is reported as not checked, never as clean.
        expect( without[ 'codes' ] ).toEqual( [] )
        expect( without[ 'result' ][ 'registerAvailable' ] ).toBe( false )
        expect( empty[ 'codes' ] ).toEqual( [] )
        expect( empty[ 'result' ][ 'registerAvailable' ] ).toBe( false )
    } )


    it( 'a non-array question list is the one LOUD error case, never a green zero', () => {
        const result = OptionQualityLint.check( { 'questions': null, 'anchorTerms': REGISTER } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ][ 0 ] ).toContain( 'questions: required array' )
        expect( result[ 'checked' ] ).toBe( null )
        expect( result[ 'skippedAnswered' ] ).toBe( null )
        expect( result[ 'skippedLegacy' ] ).toBe( null )
    } )
} )


describe( 'PRD-F4 — determinism', () => {
    it( 'the same input yields a byte-identical finding list', () => {
        const build = () => {
            const q1 = cleanQuestion()
            delete q1[ 'dimension' ]
            delete q1[ 'options' ][ 1 ][ 'scope' ]
            const q2 = cleanQuestion()
            q2[ 'id' ] = 'F2'
            q2[ 'options' ][ 0 ][ 'label' ] = 'Vollausbau und Lint'
            delete q2[ 'mentalModelCheck' ]

            return [ q2, q1 ]
        }

        const first = OptionQualityLint.check( { 'questions': build(), 'anchorTerms': REGISTER } )
        const second = OptionQualityLint.check( { 'questions': build(), 'anchorTerms': REGISTER } )

        expect( JSON.stringify( first[ 'findings' ] ) ).toBe( JSON.stringify( second[ 'findings' ] ) )
        // Sorted by question id first, so the F1 findings precede the F2 findings regardless of the
        // order the questions were handed in.
        expect( first[ 'findings' ].map( ( f ) => f[ 'questionId' ] ) ).toEqual( [ 'F1', 'F1', 'F2', 'F2' ] )
        expect( first[ 'counts' ] ).toEqual( { 'MEMO-034': 1, 'MEMO-035': 1, 'WARN-031': 1, 'WARN-033': 1 } )
    } )
} )


describe( 'PRD-F4 — the same rules through the validator door (one catalogue, two doors)', () => {
    it( 'routes ERROR codes to messages, WARNING codes to warnings, and blocks on the ERROR', () => {
        const question = cleanQuestion()
        delete question[ 'options' ][ 1 ][ 'scope' ]
        delete question[ 'mentalModelCheck' ]
        const doc = buildQuestionsJsonDoc( { 'questions': [ question ] } )

        const result = MemoValidator.validate( { doc, 'anchorTerms': REGISTER } )

        expect( result[ 'messages' ].filter( ( m ) => /^MEMO-034\b/.test( m ) ).length ).toBe( 1 )
        expect( result[ 'warnings' ].filter( ( m ) => /^WARN-033\b/.test( m ) ).length ).toBe( 1 )
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'optionQuality' ] ).toEqual( { 'ran': true, 'checked': 1, 'skippedAnswered': 0, 'skippedLegacy': 0, 'registerAvailable': true } )
    } )


    it( 'reports registerAvailable:false when no register is handed in (A12, no silent default)', () => {
        const doc = buildQuestionsJsonDoc( { 'questions': [ cleanQuestion() ] } )

        const result = MemoValidator.validate( { doc } )

        expect( result[ 'optionQuality' ] ).toEqual( { 'ran': true, 'checked': 1, 'skippedAnswered': 0, 'skippedLegacy': 0, 'registerAvailable': false } )
        expect( result[ 'messages' ].filter( ( m ) => /^MEMO-03[4-9]\b/.test( m ) ) ).toEqual( [] )
    } )


    it( 'does not run for a prepare artefact and says so', () => {
        const question = cleanQuestion()
        delete question[ 'dimension' ]
        const doc = '# REV-09-prepare\n\n| **Geplante Revision** | REV-09 |\n\n## Offene Fragen\n\n```questions-json\n'
            + JSON.stringify( [ question ] ) + '\n```\n'

        const result = MemoValidator.validate( { doc, 'fileName': 'REV-09-prepare.md', 'anchorTerms': REGISTER } )

        expect( result[ 'revisionType' ] ).toBe( 'prepare' )
        expect( result[ 'optionQuality' ] ).toEqual( { 'ran': false, 'checked': 0, 'skippedAnswered': 0, 'skippedLegacy': 0, 'registerAvailable': false } )
        expect( result[ 'messages' ].filter( ( m ) => /^MEMO-035\b/.test( m ) ) ).toEqual( [] )
    } )


    it( 'carries the eleven new codes in the ONE catalogue with the right severities', () => {
        const { catalog } = MemoValidator.getCatalog()
        const byCode = new Map( catalog.map( ( entry ) => [ entry[ 'code' ], entry ] ) )
        const expected = [
            [ 'MEMO-034', 'ERROR' ], [ 'MEMO-035', 'ERROR' ], [ 'MEMO-036', 'ERROR' ],
            [ 'MEMO-037', 'ERROR' ], [ 'MEMO-038', 'ERROR' ], [ 'MEMO-039', 'ERROR' ],
            [ 'WARN-030', 'WARNING' ], [ 'WARN-031', 'WARNING' ], [ 'WARN-032', 'WARNING' ],
            [ 'WARN-033', 'WARNING' ], [ 'INFO-020', 'INFO' ]
        ]

        expect( expected.map( ( entry ) => entry[ 0 ] ).filter( ( code ) => byCode.has( code ) ).length ).toBe( 11 )
        expected.forEach( ( entry ) => {
            expect( { 'code': entry[ 0 ], 'severity': byCode.get( entry[ 0 ] )[ 'severity' ] } )
                .toEqual( { 'code': entry[ 0 ], 'severity': entry[ 1 ] } )
            expect( MemoValidator.classify( { 'code': entry[ 0 ] } )[ 'severity' ] ).toBe( entry[ 1 ] )
        } )
    } )


    it( 'the numbers PRD-F4 called free were MEASURED: WARN-020/021 were already taken', () => {
        // The PRD assigned the four warnings to WARN-020..023. This pins the measurement that moved
        // them to WARN-030..033: the two lower numbers belong to the document-level checks and must
        // keep their meaning, so a later reader cannot silently re-collide them.
        const { catalog } = MemoValidator.getCatalog()
        const byCode = new Map( catalog.map( ( entry ) => [ entry[ 'code' ], entry ] ) )

        expect( byCode.get( 'WARN-020' )[ 'theme' ] ).toBe( 'dokument-ebene' )
        expect( byCode.get( 'WARN-021' )[ 'theme' ] ).toBe( 'header' )
        expect( byCode.get( 'WARN-030' )[ 'theme' ] ).toBe( 'optionen-guete' )
    } )
} )


describe( 'PRD-F4 — the LEGACY shape is a named, counted skip, never a silent pass', () => {
    // Measured 2026-09-06 over .memo/memos/*/revisions/REV-NN.md: 808 of 808 open questions carry none
    // of the nine quality fields, and so does every revision RevisionAssembler generates. Grading them
    // would report the same six errors on every question object ever written — which is not a finding,
    // it is the absence of a comparison basis. The two must not be reported as the same thing.
    const legacyQuestion = () => ( {
        'id': 'F7', 'title': 'Alt', 'type': 'single', 'background': 'b', 'question': 'Alt?',
        'recommendation': 'A', 'answered': false,
        'options': [
            { 'key': 'A', 'label': 'X', 'kind': 'option' },
            { 'key': 'B', 'label': 'Y', 'kind': 'option' }
        ]
    } )


    it( 'a question carrying NONE of the quality fields is skipped, counted and reported via INFO-020', () => {
        const result = OptionQualityLint.check( { 'questions': [ legacyQuestion() ], 'anchorTerms': REGISTER } )

        expect( result[ 'findings' ].map( ( f ) => f[ 'code' ] ) ).toEqual( [ 'INFO-020' ] )
        expect( result[ 'checked' ] ).toBe( 0 )
        expect( result[ 'skippedLegacy' ] ).toBe( 1 )
        expect( result[ 'findings' ][ 0 ][ 'description' ] ).toContain( '1 open but carrying none of the quality fields' )
    } )


    it( 'ONE quality field is enough to opt in — and then the object is measured in FULL', () => {
        const half = legacyQuestion()
        half[ 'dimension' ] = 'Alt-Dimension'
        const result = OptionQualityLint.check( { 'questions': [ half ], 'anchorTerms': REGISTER } )
        const codes = [ ...new Set( result[ 'findings' ].map( ( f ) => f[ 'code' ] ) ) ].sort()

        expect( result[ 'checked' ] ).toBe( 1 )
        expect( result[ 'skippedLegacy' ] ).toBe( 0 )
        // A half-adopted object is LOUD, not quietly half-checked.
        expect( codes ).toEqual( [ 'MEMO-034', 'MEMO-035', 'MEMO-036', 'WARN-033' ] )
    } )


    it( 'a single OPTION-level field is enough to opt in too', () => {
        const half = legacyQuestion()
        half[ 'options' ][ 0 ][ 'scope' ] = 'same'
        const result = OptionQualityLint.check( { 'questions': [ half ], 'anchorTerms': REGISTER } )

        expect( result[ 'checked' ] ).toBe( 1 )
        expect( result[ 'skippedLegacy' ] ).toBe( 0 )
    } )


    it( 'a mixed block measures the new objects and counts the old ones separately', () => {
        const result = OptionQualityLint.check( {
            'questions': [ legacyQuestion(), cleanQuestion(), legacyQuestion() ],
            'anchorTerms': REGISTER
        } )

        expect( result[ 'checked' ] ).toBe( 1 )
        expect( result[ 'skippedLegacy' ] ).toBe( 2 )
        expect( result[ 'skippedAnswered' ] ).toBe( 0 )
        // The one measured question is clean, and INFO-020 does NOT fire — something WAS compared.
        expect( result[ 'findings' ] ).toEqual( [] )
    } )
} )
