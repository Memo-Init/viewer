import { VALID_SCOPES, QUESTION_QUALITY_FIELDS, OPTION_QUALITY_FIELDS, isRealOptionKind } from './QuestionContract.mjs'


// OptionQualityLint.mjs — Memo 080, PRD-F4 (Kap 18 "Fragen: Lebenszyklus und Antwortmoeglichkeiten").
//
// The eight option-quality rules stop being prose and become a decidable predicate. Before this
// module the rule "a balanced option set" lived as a SENTENCE in two places — question-format.md
// (C2) and spec 29 (C2) — and not one of the 1032 question objects in the stock carried a field any
// of the eight rules could be decided on. A rule nobody can check is a rule nobody keeps; the three
// returned questions F19/F20/F21 are the evidence.
//
// The engine is PURE: no file IO, no clock, no loops. Same questions + same register -> the same
// findings in the same order (sorted by question id, then code). The anchor register is handed IN,
// never read here (A12) — that is what keeps this module free of the live, foreign-WIP register.
//
// WHAT THE CODES MEAN (the catalogue entries live in MemoValidator.ERROR_CODE_CATALOG, the ONE
// catalogue — this module produces findings, it does not keep a second catalogue):
//
//   MEMO-034  ERROR    the option set is not balanced (A1), or an option carries a `scope` outside
//                      the closed list, which makes the balance predicate undecidable
//   MEMO-035  ERROR    `dimension` missing, an option `value` missing, or two options share a value (A2)
//   MEMO-036  ERROR    a real option carries no non-empty `effect` (A3)
//   MEMO-037  ERROR    a time expression sits in an option `label` or `value` (A4)
//   MEMO-038  ERROR    an option names a postponement but carries no `deferCost` (A5)
//   MEMO-039  ERROR    `sharedPremise` is set but not exactly one option denies it (A6)
//   WARN-030  WARNING  the question sentence bundles two decisions (R1)
//   WARN-031  WARNING  an option label couples goal and measure (R3)
//   WARN-032  WARNING  a non-approved word from the register's misLabels[] (A7, R6)
//   WARN-033  WARNING  `mentalModelCheck` missing or empty (A8, advisory by construction)
//   WARN-034  WARNING  open questions were left UNGRADED because they carry none of the quality fields —
//                      the named skip of the transition period, stated per block with every id (A11)
//   INFO-020  INFO     the run examined 0 open questions although a questions-json block was present (A11)
//
// NUMBERING NOTE — MEASURED, NOT ASSUMED. PRD-F4 assigned WARN-020..023 to the four warnings and
// called them free. They are NOT: WARN-020 (document order) and WARN-021 (document-level head
// fields) were taken by Memo 080 / PRD-R1 Vollausbau, and they sit in MemoValidator's catalogue
// today. The four warnings therefore occupy the next free BLOCK, WARN-030..033, following the
// catalogue's own "number blocks have gaps" convention. MEMO-034..039 and INFO-020 were measured
// free and are used as the PRD assigns them.
//
// THE TWO NON-MACHINE PARTS ARE NOT CLAIMED AS CHECKED. Whether an author NOTICED a shared premise
// (A6) and whether the mental-model note is TRUE (A8) cannot be decided here. What is decided is
// consistency: a declared `sharedPremise` needs exactly one denying option, and the note must exist.
// The noticing stays a duty of the PREPARE step.
//
// LEGACY SHAPE — A NAMED SKIP, MEASURED, NEVER A SILENT PASS. A question object that carries NONE of
// the nine quality fields predates the standard: there is nothing on it to decide any rule against.
// Grading it would report the same six errors on every object ever written — measured 2026-09-06 over
// .memo/memos/*/revisions/REV-NN.md: 808 of 808 open questions, and the same on every revision the
// assembler generates, because the generator does not emit the fields either. That is not a finding,
// it is the absence of a comparison basis, and the two are different statements.
//
// So a legacy-shaped question is SKIPPED, COUNTED and NAMED — `skippedLegacy` rides in every result, every
// ungraded id is named in WARN-034, and a run that measured nothing says INFO-020 on top of that. The
// naming is not decoration: a counter alone is only readable by a caller that carries the counter through,
// and the moment ONE question was measured the "I compared nothing" statement is no longer true, so without
// WARN-034 a MIXED block — the shape the whole transition period consists of — would report the opted-in
// question and stay silent about the one next to it. The moment a question carries even ONE quality field
// it has opted into the standard and is measured in FULL, so a half-adopted object is loud rather than
// quietly half-checked. The distinction "not checked" versus "checked and clean" is the whole point; it is
// the same distinction `registerAvailable` draws for WARN-032.
//
// The graduation is therefore a MEASUREMENT, not a promise: once the writing path emits the fields, the
// legacy count falls to zero on its own and the rules bite on everything.
//
// ANSWERED RECORDS — A10's SECOND HALF IS SUBSTITUTED, AND THE SUBSTITUTION IS NAMED HERE rather than
// left as a silently absent assertion. PRD-F4 / A10 reads: "Die neuen Codes greifen nur bei
// Frage-Objekten mit answered: false. Bei answered: true degradieren sie zu INFO." The first sentence is
// implemented literally. The second is NOT: an answered record is SKIPPED and COUNTED, it produces no
// finding at any severity. Three reasons, all the PRD's own or the catalogue's:
//   1. The PRD's Out of Scope forbids acting on such a finding — "Nachruesten der 1032 bestehenden
//      Frage-Objekte ... sie umzuschreiben faelscht den Record". A degrade would emit advice nobody is
//      allowed to follow, and a channel trained to carry unactionable advice stops being read.
//   2. Every revision carries its whole answered set, so the degrade would repeat up to ten advisory
//      lines per answered record on EVERY lint of EVERY revision — against records that were already
//      graded while they were open and are now frozen.
//   3. A severity that changes with the reading context would make the ONE catalogue (A9) a half-truth:
//      its entry says MEMO-034 is an ERROR.
// What A10 actually wanted — that the run not be SILENT about what it left ungraded — is delivered in a
// stronger form: `skippedAnswered` rides in EVERY result, so the run states the number of ungraded
// records instead of N unactionable lines. It is the same distinction `skippedLegacy` and
// `registerAvailable` draw: "not checked" is a different statement from "checked and clean".
//
// MEASURED, so the substitution is not hiding a difference: over .memo/memos/*/revisions/REV-NN.md on
// 2026-09-06 — 83 memo dirs, 334 files, 197 questions-json blocks, 0 malformed, 1041 question objects,
// 233 answered / 808 open — exactly 0 of the 233 answered records carry ANY of the nine quality fields.
// A degrade would therefore fire on 0 records today; the two designs can only differ for records not yet
// written. The detector behind that zero was positive-controlled: a synthetic answered record carrying
// `dimension` IS detected, a plain {key,label,kind} one is not. The behaviour is pinned by
// tests/unit/OptionQualityLint.test.mjs — no finding at any severity, `skippedAnswered: 1`, and the
// counter-check that the identical question WITHOUT `answered` fires four blocking codes.


// A1 — the balance predicate. A set is balanced when it carries BOTH a way forward
// (`continues: true` on an option that is not the smaller cut) AND a smaller cut (`scope: 'smaller'`).
const SCOPE_SMALLER = 'smaller'


// A4 — time expressions. Rollout timing is the user's own decision and its own question; bundling it
// into a subject-matter option forces a timing decision along with the subject one. Both the umlaut
// and the transliterated spelling are matched, because the corpus carries both.
const TIMING_EXPRESSION = /(?:\bjetzt\b|\bsofort\b|\bsp(?:ae|ä)ter\b|\bdanach\b|\bnach\s+dem\s+Rollout\b|\bim\s+n(?:ae|ä)chsten\s+Memo\b|\berst\s+wenn\b)/iu


// A5 — postponement expressions. Naming a postponement is allowed; hiding its price is not. German
// declines and prefixes these verbs, so the stems carry both ablaut forms and the optional participle
// prefix: "verschieben"/"verschoben" and "zurueckstellen"/"zurueckgestellt" all land.
const DEFER_EXPRESSION = /(?:\bsp(?:ae|ä)ter\b|\bversch(?:ieb|ob)\w*|\bzur(?:ue|ü)ck(?:ge)?stell\w*|\bFolge-?Memo\b|\bResearch-?Ablage\b)/iu


// R1 — a question sentence that bundles two decisions ("Machen wir X, und mit welchem Werkzeug?").
// PRD-F4 prescribes `\bund (mit welchem|mit welcher|wie|ob|welche)\b`; the inflection tail
// (`welche\w*`) is added because German declines the word and the bare form would miss "welchen".
const BUNDLED_DECISION = /\bund\s+(?:mit\s+welche\w*|wie|ob|welche\w*)\b/iu


// R3 — an option label that couples goal and measure in one row. Deliberately blunt: it is a
// WARNING precisely because "und" is a normal German word and the check over-counts by design.
const COUPLED_LABEL = /(?:;|\s\+\s|\sund\s)/u


class OptionQualityLint {
    // check — the ONE entry point. `questions` is the RAW question list of a questions-json block
    // (raw, so the authored `kind` and the new quality fields survive; the normaliser knows neither).
    // `anchorTerms` is the parsed terms[] of the anchor register, handed in by the caller.
    //
    // Returns { status, messages, findings, checked, skippedAnswered, skippedLegacy,
    // registerAvailable, counts }. `checked` is the number of OPEN questions actually examined and it
    // rides in EVERY result: a verdict without its comparison basis is not readable, and a run that
    // examined nothing reports INFO-020 instead of a green zero (A11). `skippedAnswered` is the same
    // statement for the answered records A10's substitution leaves ungraded (see the head of this file),
    // and `skippedLegacy` is backed by a NAMED finding (WARN-034) so the gap survives a caller that reads
    // only the finding channels — a count that no door carries is the same as no statement at all.
    static check( { questions, anchorTerms } ) {
        // No silent default: a non-array question list is the one loud error case. An EMPTY array is
        // a valid input — it means "a block was present and carried no question", which is exactly
        // the vacuum case INFO-020 exists for.
        if( Array.isArray( questions ) !== true ) {
            return {
                'status': false,
                'messages': [ 'questions: required array (the raw questions-json list)' ],
                'findings': [],
                'checked': null,
                'skippedAnswered': null,
                'skippedLegacy': null,
                'registerAvailable': false,
                'counts': {}
            }
        }

        const terms = Array.isArray( anchorTerms ) ? anchorTerms : []
        // An absent register and an EMPTY register are the same statement: A7 has no comparison
        // basis and is not reported as checked. The caller learns that from `registerAvailable`,
        // never from a silent green.
        const registerAvailable = terms.length > 0

        const objects = questions
            .map( ( entry ) => ( entry !== null && typeof entry === 'object' ) ? entry : {} )
        // A10 — the answered records leave the measured set HERE, and this is the ONE place the
        // substitution named at the head of this file is executed: they are counted, never graded, and
        // never carried into #checkOne at any severity.
        const open = objects.filter( ( question ) => question[ 'answered' ] !== true )
        const skippedAnswered = objects.length - open.length

        const measured = open.filter( ( question ) => OptionQualityLint.#carriesQualityFields( { question } ).carries === true )
        const legacy = open.filter( ( question ) => OptionQualityLint.#carriesQualityFields( { question } ).carries !== true )
        const skippedLegacy = legacy.length

        const findings = measured
            .flatMap( ( question ) => OptionQualityLint.#checkOne( { question, terms, registerAvailable } ) )
        const vacuum = measured.length === 0
            ? [ {
                'code': 'INFO-020',
                'questionId': '(block)',
                'field': 'questions',
                'description': `The option-quality lint examined 0 open questions although a questions-json block was present (${ objects.length } question object(s): ${ skippedAnswered } answered, ${ skippedLegacy } open but carrying none of the quality fields) — a run without a comparison basis reports that it compared nothing, it never reports green`
            } ]
            : []
        // WARN-034 — THE SKIP IS ANNOUNCED, BY NAME, AND IT DOES NOT DEPEND ON THE RUN HAVING MEASURED
        // NOTHING. INFO-020 answers "did this run compare anything at all?" and therefore falls silent the
        // moment ONE question is measured. That left a hole exactly where the transition lives: a MIXED
        // block — one opted-in question next to a legacy-shaped one — reported the measured question and
        // said nothing whatsoever about the other, so a question violating four rules produced no trace.
        // Reproduced 2026-09-06 through `memo lint`: the ungraded id appeared 0 times in the output.
        //
        // The gap is therefore stated as its OWN finding, per block, naming every ungraded id, and it is a
        // WARNING rather than an INFO for two measured reasons: an ungraded OPEN question is actionable
        // (unlike an answered record, which Out of Scope forbids rewriting — it can simply be given a
        // quality field), and the warnings channel is the one channel every door carries. It stays
        // NON-BLOCKING because the writing path does not emit the fields yet; sharpening it is bound to a
        // fresh corpus measurement, not to its introduction.
        //
        // ONE finding per block, not one per question: the ids are named in it, so nothing is hidden, and a
        // memo carrying its full open-question set cannot flood the channel it needs to be read in.
        const ungraded = legacy.length === 0
            ? []
            : [ {
                'code': 'WARN-034',
                'questionId': '(block)',
                'field': 'questions',
                'description': `${ legacy.length } of ${ open.length } open question(s) carry none of the option-quality fields and were NOT graded: ${ legacy.map( ( question ) => OptionQualityLint.#idOf( { question } ).id ).join( ', ' ) } — an ungraded question is a stated gap, never a clean result; one quality field opts an object into the standard and it is then measured in full`
            } ]

        const all = OptionQualityLint.#sorted( { findings: findings.concat( ungraded ).concat( vacuum ) } )

        return {
            'status': true,
            'messages': [],
            'findings': all,
            'checked': measured.length,
            skippedAnswered,
            skippedLegacy,
            registerAvailable,
            'counts': OptionQualityLint.#counts( { findings: all } )
        }
    }


    // ---- private ----

    // Has this question OPTED IN to the standard? True as soon as it carries ONE of the nine quality
    // fields — on the question itself or on any of its options. The field names come from the shared
    // contract, never from a second list here, so widening the standard widens this test with it.
    // An "opted in" question is measured in FULL; a half-filled object is therefore loud, not
    // half-checked. A question carrying none of them predates the standard and is counted as legacy.
    static #carriesQualityFields( { question } ) {
        const onQuestion = QUESTION_QUALITY_FIELDS
            .some( ( field ) => question[ field ] !== undefined )
        if( onQuestion === true ) { return { 'carries': true } }

        const options = Array.isArray( question[ 'options' ] ) ? question[ 'options' ] : []
        const onOption = options
            .filter( ( option ) => option !== null && typeof option === 'object' )
            .some( ( option ) => OPTION_QUALITY_FIELDS.some( ( field ) => option[ field ] !== undefined ) )

        return { 'carries': onOption }
    }


    // The id a finding names the question by. ONE derivation, used by the graded findings and by the
    // WARN-034 skip notice alike — an id that reads "F2" in one line and "F?" in the next would make the
    // two halves of the same run unjoinable. An object without a usable id is named "F?" rather than
    // dropped, because a nameless ungraded question is still a stated gap.
    static #idOf( { question } ) {
        const id = question[ 'id' ]

        return { 'id': ( typeof id === 'string' && id.length > 0 ) ? id : 'F?' }
    }


    static #checkOne( { question, terms, registerAvailable } ) {
        const { id } = OptionQualityLint.#idOf( { question } )
        const { options } = OptionQualityLint.#realOptions( { question } )

        return []
            .concat( OptionQualityLint.#balance( { id, options } ) )
            .concat( OptionQualityLint.#oneDimension( { id, question, options } ) )
            .concat( OptionQualityLint.#effects( { id, options } ) )
            .concat( OptionQualityLint.#timing( { id, options } ) )
            .concat( OptionQualityLint.#deferCost( { id, options } ) )
            .concat( OptionQualityLint.#sharedPremise( { id, question, options } ) )
            .concat( OptionQualityLint.#bundledQuestion( { id, question } ) )
            .concat( OptionQualityLint.#coupledLabels( { id, options } ) )
            .concat( OptionQualityLint.#misLabels( { id, question, options, terms, registerAvailable } ) )
            .concat( OptionQualityLint.#mentalModelCheck( { id, question } ) )
    }


    // The REAL options of a question, carrying their authored index so a finding can name the row
    // even when the option has no key. A missing `kind` counts as a real option — that is the render
    // contract's own reading (QuestionContract: "A missing kind is NOT a defect, it defaults to
    // 'option'"), and reading it any other way would fire MEMO-034 on every legal block that simply
    // omits the field. The four injected siblings (custom/topic/reframe/reoption) never count.
    static #realOptions( { question } ) {
        const list = Array.isArray( question[ 'options' ] ) ? question[ 'options' ] : []

        const options = list
            .map( ( option, index ) => ( { 'option': ( option !== null && typeof option === 'object' ) ? option : {}, index } ) )
            .filter( ( entry ) => isRealOptionKind( { kind: entry[ 'option' ][ 'kind' ] } ).real === true )
            .map( ( entry ) => {
                const option = entry[ 'option' ]
                const key = typeof option[ 'key' ] === 'string' && option[ 'key' ].length > 0
                    ? option[ 'key' ]
                    : `#${ entry[ 'index' ] }`

                return { option, key, 'index': entry[ 'index' ] }
            } )

        return { options }
    }


    // A1 + A13 — the balance predicate, plus the closed `scope` list it rests on. An unknown scope is
    // reported under the SAME code because it is the same statement: the balance of this set cannot
    // be established. Reporting it silently as "not smaller" would be the silent default the house
    // style forbids.
    static #balance( { id, options } ) {
        const unknownScope = options
            .filter( ( entry ) => {
                const scope = entry[ 'option' ][ 'scope' ]

                return scope !== undefined && scope !== null && VALID_SCOPES.includes( scope ) !== true
            } )
            .map( ( entry ) => ( {
                'code': 'MEMO-034',
                'questionId': id,
                'field': `options.${ entry[ 'key' ] }.scope`,
                'description': `Option scope "${ String( entry[ 'option' ][ 'scope' ] ) }" is outside the closed list {${ VALID_SCOPES.join( ', ' ) }} — the balance predicate cannot be decided on it`
            } ) )

        const forward = options
            .some( ( entry ) => entry[ 'option' ][ 'continues' ] === true && entry[ 'option' ][ 'scope' ] !== SCOPE_SMALLER )
        const smaller = options
            .some( ( entry ) => entry[ 'option' ][ 'scope' ] === SCOPE_SMALLER )

        if( forward === true && smaller === true ) { return unknownScope }

        const missing = []
            .concat( forward === true ? [] : [ 'the way forward (an option with continues: true and scope !== "smaller")' ] )
            .concat( smaller === true ? [] : [ 'the smaller cut (an option with scope: "smaller")' ] )

        return unknownScope.concat( [ {
            'code': 'MEMO-034',
            'questionId': id,
            'field': 'options',
            'description': `Option set is not balanced over ${ options.length } real option(s): missing ${ missing.join( ' and ' ) }`
        } ] )
    }


    // A2 — one decision per question, structurally. The question names the ONE `dimension` it decides,
    // every real option names the `value` it takes on it, and no two options take the same value. A set
    // with two simultaneously varying dimensions is not representable in this shape — that is the
    // purpose of the construction, not an extra check.
    static #oneDimension( { id, question, options } ) {
        const dimension = typeof question[ 'dimension' ] === 'string' ? question[ 'dimension' ].trim() : ''
        const dimensionFinding = dimension.length > 0
            ? []
            : [ {
                'code': 'MEMO-035',
                'questionId': id,
                'field': 'dimension',
                'description': 'Field "dimension" missing or empty — name the ONE thing being decided, as a plain-language noun phrase'
            } ]

        const values = options
            .map( ( entry ) => ( { 'key': entry[ 'key' ], 'value': typeof entry[ 'option' ][ 'value' ] === 'string' ? entry[ 'option' ][ 'value' ].trim() : '' } ) )

        const missingValue = values
            .filter( ( entry ) => entry[ 'value' ].length === 0 )
            .map( ( entry ) => ( {
                'code': 'MEMO-035',
                'questionId': id,
                'field': `options.${ entry[ 'key' ] }.value`,
                'description': 'Real option carries no non-empty "value" — every option names the value it takes on the question\'s dimension'
            } ) )

        const present = values.filter( ( entry ) => entry[ 'value' ].length > 0 )
        const duplicates = present
            .filter( ( entry, index ) => present.findIndex( ( other ) => other[ 'value' ].toLowerCase() === entry[ 'value' ].toLowerCase() ) !== index )
            .map( ( entry ) => ( {
                'code': 'MEMO-035',
                'questionId': id,
                'field': `options.${ entry[ 'key' ] }.value`,
                'description': `Two real options take the same value "${ entry[ 'value' ] }" on the dimension — the values of one option set are pairwise distinct`
            } ) )

        return dimensionFinding.concat( missingValue ).concat( duplicates )
    }


    // A3 — every option names its consequence: half a sentence on what follows if the user picks it.
    static #effects( { id, options } ) {
        return options
            .filter( ( entry ) => {
                const effect = typeof entry[ 'option' ][ 'effect' ] === 'string' ? entry[ 'option' ][ 'effect' ].trim() : ''

                return effect.length === 0
            } )
            .map( ( entry ) => ( {
                'code': 'MEMO-036',
                'questionId': id,
                'field': `options.${ entry[ 'key' ] }.effect`,
                'description': 'Real option carries no non-empty "effect" — name in half a sentence what follows when this option is chosen'
            } ) )
    }


    // A4 — rollout timing is not a subject-matter option.
    static #timing( { id, options } ) {
        return options
            .flatMap( ( entry ) => {
                return [ 'label', 'value' ]
                    .map( ( field ) => {
                        const text = typeof entry[ 'option' ][ field ] === 'string' ? entry[ 'option' ][ field ] : ''
                        const hit = text.match( TIMING_EXPRESSION )

                        return { field, hit }
                    } )
                    .filter( ( found ) => found[ 'hit' ] !== null )
                    .map( ( found ) => ( {
                        'code': 'MEMO-037',
                        'questionId': id,
                        'field': `options.${ entry[ 'key' ] }.${ found[ 'field' ] }`,
                        'description': `Time expression "${ found[ 'hit' ][ 0 ] }" in a subject-matter option — the rollout moment is the user's own question and is never bundled into a subject option`
                    } ) )
            } )
    }


    // A5 — a postponement names its price. The check reads `label` AND `effect`, so a postponement
    // that only surfaces in the consequence is caught too.
    static #deferCost( { id, options } ) {
        return options
            .map( ( entry ) => {
                const label = typeof entry[ 'option' ][ 'label' ] === 'string' ? entry[ 'option' ][ 'label' ] : ''
                const effect = typeof entry[ 'option' ][ 'effect' ] === 'string' ? entry[ 'option' ][ 'effect' ] : ''
                const cost = typeof entry[ 'option' ][ 'deferCost' ] === 'string' ? entry[ 'option' ][ 'deferCost' ].trim() : ''
                const hit = `${ label }\n${ effect }`.match( DEFER_EXPRESSION )

                return { 'key': entry[ 'key' ], hit, cost }
            } )
            .filter( ( found ) => found[ 'hit' ] !== null && found[ 'cost' ].length === 0 )
            .map( ( found ) => ( {
                'code': 'MEMO-038',
                'questionId': id,
                'field': `options.${ found[ 'key' ] }.deferCost`,
                'description': `Option names a postponement ("${ found[ 'hit' ][ 0 ] }") but carries no non-empty "deferCost" — no flat penalty, but no concealed price either`
            } ) )
    }


    // A6 — the CONSISTENCY of a declared shared premise, honestly bounded. Whether the author
    // NOTICED a shared premise is not machine-decidable and is not claimed here; what is decidable is
    // that a declared premise has exactly one option denying it.
    static #sharedPremise( { id, question, options } ) {
        const premise = typeof question[ 'sharedPremise' ] === 'string' ? question[ 'sharedPremise' ].trim() : ''
        if( premise.length === 0 ) { return [] }

        const denying = options.filter( ( entry ) => entry[ 'option' ][ 'deniesPremise' ] === true )
        if( denying.length === 1 ) { return [] }

        return [ {
            'code': 'MEMO-039',
            'questionId': id,
            'field': 'sharedPremise',
            'description': `Field "sharedPremise" is set but ${ denying.length } of ${ options.length } real option(s) carry deniesPremise: true — a declared shared premise needs exactly one option that denies it`
        } ]
    }


    // R1 — the question sentence bundles two decisions. Reads the English `question` and the German
    // legacy `frage` the parser still accepts, so a legacy block is measured, not skipped.
    static #bundledQuestion( { id, question } ) {
        const text = OptionQualityLint.#questionText( { question } ).text
        const hit = text.match( BUNDLED_DECISION )
        if( hit === null ) { return [] }

        return [ {
            'code': 'WARN-030',
            'questionId': id,
            'field': 'question',
            'description': `Question sentence bundles two decisions at "${ hit[ 0 ] }" — split it into one question per decision`
        } ]
    }


    // R3 — an option label that couples goal and measure.
    static #coupledLabels( { id, options } ) {
        return options
            .map( ( entry ) => {
                const label = typeof entry[ 'option' ][ 'label' ] === 'string' ? entry[ 'option' ][ 'label' ] : ''

                return { 'key': entry[ 'key' ], 'hit': label.match( COUPLED_LABEL ) }
            } )
            .filter( ( found ) => found[ 'hit' ] !== null )
            .map( ( found ) => ( {
                'code': 'WARN-031',
                'questionId': id,
                'field': `options.${ found[ 'key' ] }.label`,
                'description': `Option label couples goal and measure at "${ found[ 'hit' ][ 0 ].trim() }" — one option row carries one value, not a goal plus its measure`
            } ) )
    }


    // A7 / R6 — no non-approved word from the register at the decision point. This covers two things at
    // once: no jargon where the decision is taken, and no provocative user word carried on as a term —
    // such a word sits in the register as non-approved and is replaced by its approved label.
    // Not run at all when no register was handed in; the caller reports that as registerAvailable:false.
    static #misLabels( { id, question, options, terms, registerAvailable } ) {
        if( registerAvailable !== true ) { return [] }

        const pairs = terms
            .map( ( term ) => ( term !== null && typeof term === 'object' ) ? term : {} )
            .flatMap( ( term ) => {
                const labels = Array.isArray( term[ 'misLabels' ] ) ? term[ 'misLabels' ] : []
                const label = typeof term[ 'label' ] === 'string' ? term[ 'label' ] : ''

                return labels
                    .filter( ( misLabel ) => typeof misLabel === 'string' && misLabel.length > 0 && label.length > 0 )
                    .map( ( misLabel ) => ( { misLabel, label } ) )
            } )

        const fields = [
            { 'field': 'title', 'text': typeof question[ 'title' ] === 'string' ? question[ 'title' ] : '' },
            { 'field': 'question', 'text': OptionQualityLint.#questionText( { question } ).text }
        ].concat( options.flatMap( ( entry ) => {
            return [ 'label', 'value' ]
                .map( ( name ) => ( {
                    'field': `options.${ entry[ 'key' ] }.${ name }`,
                    'text': typeof entry[ 'option' ][ name ] === 'string' ? entry[ 'option' ][ name ] : ''
                } ) )
        } ) )

        return fields
            .flatMap( ( entry ) => {
                return pairs
                    .map( ( pair ) => {
                        const escaped = OptionQualityLint.#escapeRegex( { token: pair[ 'misLabel' ] } ).escaped
                        const pattern = new RegExp( `(?<![\\p{L}\\p{N}])(${ escaped })(?![\\p{L}\\p{N}])`, 'iu' )

                        return { 'hit': entry[ 'text' ].match( pattern ), 'label': pair[ 'label' ] }
                    } )
                    .filter( ( found ) => found[ 'hit' ] !== null )
                    .map( ( found ) => ( {
                        'code': 'WARN-032',
                        'questionId': id,
                        'field': entry[ 'field' ],
                        'description': `Non-approved word "${ found[ 'hit' ][ 0 ] }" at the decision point — use the approved label "${ found[ 'label' ] }" instead (one term, one meaning)`
                    } ) )
            } )
    }


    // A8 — the mental-model comparison is VISIBLE. Advisory on purpose: it is a WARNING, it never
    // answers the question and it never removes it.
    static #mentalModelCheck( { id, question } ) {
        const note = typeof question[ 'mentalModelCheck' ] === 'string' ? question[ 'mentalModelCheck' ].trim() : ''
        if( note.length > 0 ) { return [] }

        return [ {
            'code': 'WARN-033',
            'questionId': id,
            'field': 'mentalModelCheck',
            'description': 'Field "mentalModelCheck" missing or empty — state "aligned" or name the collision with the known user tendency (advisory, it never answers the question)'
        } ]
    }


    // The question sentence, reading the canonical English field and the German legacy name the
    // parser still accepts. The German name wins where both are present, exactly as the parser does.
    static #questionText( { question } ) {
        const german = typeof question[ 'frage' ] === 'string' ? question[ 'frage' ] : ''
        const english = typeof question[ 'question' ] === 'string' ? question[ 'question' ] : ''

        return { 'text': german.length > 0 ? german : english }
    }


    static #escapeRegex( { token } ) {
        return { 'escaped': token.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) }
    }


    // Deterministic order: question id, then code, then field. Same input -> byte-identical list.
    static #sorted( { findings } ) {
        return findings
            .slice()
            .sort( ( a, b ) => {
                const byId = a[ 'questionId' ].localeCompare( b[ 'questionId' ] )
                if( byId !== 0 ) { return byId }
                const byCode = a[ 'code' ].localeCompare( b[ 'code' ] )
                if( byCode !== 0 ) { return byCode }

                return a[ 'field' ].localeCompare( b[ 'field' ] )
            } )
    }


    static #counts( { findings } ) {
        const codes = findings.map( ( finding ) => finding[ 'code' ] )
        const distinct = codes.filter( ( code, index ) => codes.indexOf( code ) === index )

        return Object.fromEntries( distinct.map( ( code ) => [ code, codes.filter( ( item ) => item === code ).length ] ) )
    }
}


export { OptionQualityLint }
