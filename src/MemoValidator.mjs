import { DocumentRegistry } from './DocumentRegistry.mjs'
import { BlockMeta } from './BlockMeta.mjs'
import { invalidOptionKinds } from './QuestionContract.mjs'


// PRD-036/037/038 (Memo 016, Kap 13): deterministic, server-side, STRUCTURAL validation of
// a revision before it is delivered to the View/AI. Not a content judgement — it answers:
// "Did question parsing work? Is the structure correct? Are required fields present?".
//
// Error-Code catalogue (PRD-037), PREFIX-NUMBER per node-error-codes SKILL.md:
//   MEMO-NNN  → ERROR   (blocking, goes to `messages`)
//   INFO-NNN  → INFO    (advisory, goes to `info`, never blocks)
// Number blocks have gaps so codes can be inserted later without renumbering; letter
// suffixes (MEMO-020a/b/c) distinguish variants of the same theme.
//
//   Sections      MEMO-001–009   Pflicht-Sections fehlen
//   Header        MEMO-010–019   Header-Felder / Schema-Version-Marker
//   Frage         MEMO-020–029   ### F{N}-Block unvollstaendig (Hintergrund/Frage/AI)
//   Optionen      MEMO-030–039   Optionen nicht parsebar (Klammern statt Zeilen)
//   Typ-Badge     MEMO-040–049   Typ single/multi inkonsistent (Checkliste = multi)
//   JSON-Block    MEMO-050–059   Fragen-JSON-Codeblock malformed (PRD-039)
//   Dateiname     MEMO-060–069   Revisions-Dateiname-Suffix malformed (Memo 012, Kap 3)
//   Lifecycle     MEMO-070–079   Restmarker im finalen Dokument (Memo 012, Kap 3)
//   Block-Meta    MEMO-080–089   block-meta Overlay-Feld malformed (Memo 012, Kap 7)
//   Advisory      INFO-001–099   Hinweise ohne Blockierung
//
// Memo 012, Kap 3 (F-Forensik §5): four error classes the validator did NOT catch before
// but memo-revision-evaluate relies on. MEMO-031/032 extend the per-question Optionen checks;
// MEMO-060 needs the file name; MEMO-070 needs the raw doc. All four feed the same `messages`
// channel as the existing ERROR codes, so `memo lint` (the SSOT CLI wrapper) inherits them.
const ERROR_CODE_CATALOG = [
    { 'code': 'MEMO-001', 'severity': 'ERROR', 'theme': 'sections', 'description': 'Required section missing' },
    { 'code': 'MEMO-002', 'severity': 'ERROR', 'theme': 'input', 'description': 'Document is empty or not a string' },
    { 'code': 'MEMO-010', 'severity': 'ERROR', 'theme': 'header', 'description': 'Header field missing' },
    { 'code': 'MEMO-020a', 'severity': 'ERROR', 'theme': 'frage', 'description': 'Missing required field: Hintergrund' },
    { 'code': 'MEMO-020b', 'severity': 'ERROR', 'theme': 'frage', 'description': 'Missing required field: Frage' },
    { 'code': 'MEMO-020c', 'severity': 'ERROR', 'theme': 'frage', 'description': 'Missing required field: AI-Empfehlung' },
    { 'code': 'MEMO-020d', 'severity': 'ERROR', 'theme': 'frage', 'description': 'Malformed: AI-Empfehlung references no existing option' },
    { 'code': 'MEMO-025', 'severity': 'ERROR', 'theme': 'frage-parse', 'description': 'Question parsing incomplete (heading count differs from parsed questions)' },
    { 'code': 'MEMO-030', 'severity': 'ERROR', 'theme': 'optionen', 'description': 'Options not parseable (use discrete lines, not inline parentheses)' },
    { 'code': 'MEMO-040', 'severity': 'ERROR', 'theme': 'typ', 'description': 'Checklist must be typ=multi' },
    { 'code': 'MEMO-050', 'severity': 'ERROR', 'theme': 'json-block', 'description': 'Questions JSON codeblock is malformed' },
    { 'code': 'MEMO-031', 'severity': 'ERROR', 'theme': 'optionen', 'description': 'Option marker is bold-wrapped (e.g. "**A)**" / "**A:**") and does not parse as an option' },
    { 'code': 'MEMO-032', 'severity': 'ERROR', 'theme': 'optionen', 'description': 'Duplicate option within a question (duplicate key, or an authored option duplicates the injected custom/topic default)' },
    { 'code': 'MEMO-033', 'severity': 'ERROR', 'theme': 'optionen', 'description': 'Option kind is not one of {option, custom, topic} — the renderer drops such an option (Memo 041 Teil B, the split-brain fix)' },
    { 'code': 'MEMO-060', 'severity': 'ERROR', 'theme': 'filename', 'description': 'Revision filename suffix malformed (expected REV-NN.md, REV-NN-prepare.md or REV-NN-update.md)' },
    { 'code': 'MEMO-070', 'severity': 'ERROR', 'theme': 'lifecycle', 'description': 'Unresolved "[Research offen]" marker present outside code spans' },
    { 'code': 'MEMO-080', 'severity': 'ERROR', 'theme': 'block-meta', 'description': 'block-meta overlay block is malformed (invalid JSON; topic/prd ids not in T001 / PRD-001 shape; or a Parent/Child invariant is violated — child carrying prds, a block mixing singular topic with plural topics, or a grandchild/second level)' },
    { 'code': 'INFO-010', 'severity': 'INFO', 'theme': 'header', 'description': 'Schema-Version marker missing (advisory until writing skills set it)' }
]


// Memo 038 Kap 7 (F8=A): the start confidence threshold for an AI "im Namen des Users"
// pre-decision. The AI may only pre-decide a question at VERY high confidence (>= 95 %) and the
// threshold is lowered over time as the User Mental Model proves itself. This is advisory
// provenance metadata only — it never auto-answers a question. The hard rule (F5=A) is enforced by
// #finalizeAnsweredCount below: an 'ai-on-behalf' answer NEVER satisfies the finalize gate on its
// own; it always still needs a user look.
const AI_ON_BEHALF_START_THRESHOLD = 0.95


class MemoValidator {
    static validate( { doc, fileName } ) {
        const struct = { 'status': false, 'messages': [], 'info': [] }

        if( typeof doc !== 'string' || doc.length === 0 ) {
            const { message } = MemoValidator.#buildMessage( {
                'code': 'MEMO-002',
                'feldPfad': 'doc',
                'description': 'Document is empty or not a string'
            } )
            struct[ 'messages' ] = [ message ]
            struct[ 'status' ] = false

            return struct
        }

        const { questions: markdownQuestions } = DocumentRegistry.parseQuestionSchema( { content: doc } )
        const { questions: jsonQuestions, found: jsonFound, error: jsonError } = DocumentRegistry.parseQuestionJsonBlock( { content: doc } )
        const questionSchema = jsonFound ? { 'questions': jsonQuestions } : { 'questions': markdownQuestions }

        const sections = MemoValidator.#validateRequiredSections( { doc } )
        const header = MemoValidator.#validateHeaderFields( { doc } )
        const json = MemoValidator.#validateJsonBlock( { doc, jsonFound, jsonError } )
        const questions = MemoValidator.#validateQuestions( { doc, questionSchema, jsonFound } )
        const optionKinds = MemoValidator.#validateOptionKinds( { doc, jsonFound } )
        const lintExt = MemoValidator.#validateLintExtensions( { doc, fileName } )

        const messages = []
            .concat( sections[ 'messages' ] )
            .concat( header[ 'messages' ] )
            .concat( json[ 'messages' ] )
            .concat( questions[ 'messages' ] )
            .concat( optionKinds[ 'messages' ] )
            .concat( lintExt[ 'messages' ] )

        const info = []
            .concat( sections[ 'info' ] )
            .concat( header[ 'info' ] )
            .concat( json[ 'info' ] )
            .concat( questions[ 'info' ] )
            .concat( optionKinds[ 'info' ] )
            .concat( lintExt[ 'info' ] )

        struct[ 'messages' ] = messages
        struct[ 'info' ] = info
        struct[ 'status' ] = messages.length === 0

        return struct
    }


    static classify( { code } ) {
        const prefix = typeof code === 'string' ? code.split( '-' )[ 0 ] : ''
        const severity = prefix === 'INFO' ? 'INFO' : 'ERROR'

        return { severity }
    }


    static getCatalog() {
        return { 'catalog': ERROR_CODE_CATALOG }
    }


    // Memo 038 Kap 7 (P3c, F5=A): the finalize-gate schranke. The "all questions answered" gate
    // for finalize-readiness must NOT count an 'ai-on-behalf' answer as satisfying it on its own —
    // such an answer is an advisory AI pre-decision that ALWAYS still needs a user look. This helper
    // is the single, well-commented guard: given the parsed question list it returns the counts the
    // finalize gate must use. `total` is every question; `answeredByUser` counts only questions that
    // are answered AND were decided by the user (the gate-satisfying answers); `answeredByAi` counts
    // answered questions whose provenance is 'ai-on-behalf' (these need confirmation); `needsUser` is
    // every still-open OR ai-on-behalf question; `gateSatisfied` is true only when EVERY question is
    // user-answered. The advisory start threshold (>= 95 %) is exported separately for callers that
    // surface it — it is provenance, not an auto-answer.
    static finalizeGate( { questions } ) {
        const list = Array.isArray( questions ) ? questions : []

        const total = list.length
        const answeredByUser = list
            .filter( ( question ) => question !== null && typeof question === 'object'
                && question[ 'answered' ] === true
                && MemoValidator.#answeredByOf( { question } ) === 'user' )
            .length
        const answeredByAi = list
            .filter( ( question ) => question !== null && typeof question === 'object'
                && question[ 'answered' ] === true
                && MemoValidator.#answeredByOf( { question } ) === 'ai-on-behalf' )
            .length

        // A question still needs a user look when it is open OR was only AI-pre-decided. The gate
        // is satisfied only when nothing needs a user look anymore (and at least one question exists).
        const needsUser = total - answeredByUser

        return {
            total,
            answeredByUser,
            answeredByAi,
            needsUser,
            'gateSatisfied': total > 0 && needsUser === 0,
            'startThreshold': AI_ON_BEHALF_START_THRESHOLD
        }
    }


    static #answeredByOf( { question } ) {
        // Memo 038 Kap 7: accept only the two known provenance values; default to 'user' so a
        // legacy answered entry (no answeredBy field) counts as a user answer (back-compat).
        return question[ 'answeredBy' ] === 'ai-on-behalf' ? 'ai-on-behalf' : 'user'
    }


    static #buildMessage( { code, feldPfad, description } ) {
        // node-error-codes Abschnitt 1: `{PREFIX}-{NUMBER} {location}: {description}`.
        const message = `${ code } ${ feldPfad }: ${ description }`

        return { message }
    }


    static #route( { code, feldPfad, description, messages, info } ) {
        const { severity } = MemoValidator.classify( { code } )
        const { message } = MemoValidator.#buildMessage( { code, feldPfad, description } )

        if( severity === 'INFO' ) {
            info.push( message )
        } else {
            messages.push( message )
        }

        return { messages, info }
    }


    static #validateRequiredSections( { doc } ) {
        const struct = { 'messages': [], 'info': [] }
        // PRD-002 (Memo 011, Kap 10): enforce the 10 mandatory sections = the 9 canonical
        // Pflicht-Sections from memo-init/SKILL.md ("Pflicht-Sections (PRD-029)" table)
        // PLUS `Beantwortete Fragen`. `Beantwortete Fragen` is kept (validation finding
        // REV-05) because the REV format uses it throughout (F1–F18) — the validator must
        // not stop checking a section the REV format actually uses (silent regression drift).
        const required = [ 'Kontext', 'Vorwort', 'Offene Fragen', 'Beantwortete Fragen', 'Phasen', 'Phase-Hints', 'Finalisierungs-Checkliste', 'Ancillary Files', 'Rollout-Entry-Points', 'Lessons-Learned' ]

        // Some sections allow alternative headings (SKILL.md Z.413): `## Vorwort` may also
        // appear as `## Claude-Vorwort`. A section counts as present if ANY of its accepted
        // headings is found. Sections without an alias map to a single-element list.
        const aliases = { 'Vorwort': [ 'Vorwort', 'Claude-Vorwort' ] }

        required
            .forEach( ( heading ) => {
                const accepted = Array.isArray( aliases[ heading ] ) ? aliases[ heading ] : [ heading ]
                const present = accepted
                    .some( ( candidate ) => {
                        const pattern = new RegExp( `^##\\s+${ candidate }\\s*$`, 'im' )

                        return pattern.test( doc )
                    } )

                if( !present ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-001',
                        'feldPfad': `section.${ heading.replace( /\s+/g, '' ) }`,
                        'description': `Required section missing (expected heading "## ${ heading }")`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }
            } )

        return struct
    }


    static #validateHeaderFields( { doc } ) {
        const struct = { 'messages': [], 'info': [] }
        const requiredHeaderFields = [ 'Memo', 'Memo-Name', 'Revision', 'Datum', 'Status' ]

        requiredHeaderFields
            .forEach( ( field ) => {
                const pattern = new RegExp( `\\|\\s*\\*\\*${ field }\\*\\*\\s*\\|\\s*([^|]*?)\\s*\\|`, 'i' )
                const matched = doc.match( pattern )
                const value = matched !== null ? matched[ 1 ].trim() : ''

                if( matched === null ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-010',
                        'feldPfad': `header.${ field }`,
                        'description': `Header field missing (expected "| **${ field }** | ... |")`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                } else if( value.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-010',
                        'feldPfad': `header.${ field }`,
                        'description': `Header field empty (expected a value for "${ field }")`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }
            } )

        // H3-decision (Memo Kap 13 validation): the Schema-Version marker check is advisory
        // (INFO) for now, NOT blocking — writing skills do not yet set the marker in memo files.
        const hasSchemaVersion = /Schema-Version\s*[:|]/i.test( doc )

        if( !hasSchemaVersion ) {
            MemoValidator.#route( {
                'code': 'INFO-010',
                'feldPfad': 'header.Schema-Version',
                'description': 'Schema-Version marker missing (advisory; expected e.g. "Schema-Version: 2")',
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        }

        return struct
    }


    static #validateJsonBlock( { doc, jsonFound, jsonError } ) {
        const struct = { 'messages': [], 'info': [] }

        // PRD-039: only flag the JSON block when a marker is present but parsing failed.
        const markerPresent = /```questions-json/.test( doc )

        if( markerPresent && !jsonFound ) {
            const detail = typeof jsonError === 'string' && jsonError.length > 0
                ? jsonError
                : 'Questions JSON codeblock is malformed'

            MemoValidator.#route( {
                'code': 'MEMO-050',
                'feldPfad': 'questionsJson',
                'description': detail,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        }

        return struct
    }


    static #validateQuestions( { doc, questionSchema, jsonFound } ) {
        const struct = { 'messages': [], 'info': [] }
        const questions = ( questionSchema !== null && typeof questionSchema === 'object' && Array.isArray( questionSchema[ 'questions' ] ) )
            ? questionSchema[ 'questions' ]
            : []

        // PRD-038 Re-Check: "Did question parsing work?" — compare ### F{N} headings in the
        // raw markdown with the number of parsed questions. A mismatch means a heading exists
        // that the parser did not capture as a question.
        const { messages: parseMessages, info: parseInfo } = MemoValidator.#validateQuestionParse( { doc, questionSchema, jsonFound } )
        struct[ 'messages' ] = struct[ 'messages' ].concat( parseMessages )
        struct[ 'info' ] = struct[ 'info' ].concat( parseInfo )

        const { blocks: rawBlocks } = MemoValidator.#extractQuestionBlocks( { doc } )

        questions
            .forEach( ( question ) => {
                const safe = ( question !== null && typeof question === 'object' ) ? question : {}
                const id = typeof safe[ 'id' ] === 'string' && safe[ 'id' ].length > 0 ? safe[ 'id' ] : 'F?'

                // Answered questions are HISTORICAL records (## Beantwortete Fragen). They use a
                // different shape (single-line meta: "**AI:** X. **User:** Y.") and carry no
                // Hintergrund/Frage/AI-Empfehlung fields by design — the required-field and
                // typ checks apply only to OPEN questions being delivered to the AI. Skip them.
                if( safe[ 'answered' ] === true ) { return }

                const hintergrund = typeof safe[ 'hintergrund' ] === 'string' ? safe[ 'hintergrund' ].trim() : ''
                const frage = typeof safe[ 'frage' ] === 'string' ? safe[ 'frage' ].trim() : ''
                const aiRecommendation = typeof safe[ 'aiRecommendation' ] === 'string' ? safe[ 'aiRecommendation' ].trim() : ''
                const typ = safe[ 'typ' ] === 'multi' ? 'multi' : 'single'
                const realOptions = ( Array.isArray( safe[ 'options' ] ) ? safe[ 'options' ] : [] )
                    .filter( ( option ) => option !== null && typeof option === 'object' && option[ 'kind' ] === 'option' )

                // Hintergrund — single message per field via else-if cascade (existence only here).
                if( hintergrund.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-020a',
                        'feldPfad': `${ id }.hintergrund`,
                        'description': 'Missing required field: Hintergrund',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // Frage.
                if( frage.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-020b',
                        'feldPfad': `${ id }.frage`,
                        'description': 'Missing required field: Frage',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // AI-Empfehlung is REQUIRED and enforced. Cascade existence → malformed.
                const recommendedKeys = aiRecommendation.toUpperCase().match( /\b([A-H])\b/g ) || []
                const optionKeys = realOptions.map( ( option ) => option[ 'key' ] )
                const referencesExistingOption = recommendedKeys.some( ( key ) => optionKeys.includes( key ) )

                if( aiRecommendation.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-020c',
                        'feldPfad': `${ id }.aiEmpfehlung`,
                        'description': 'Missing required field: AI-Empfehlung',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                } else if( typ === 'single' && realOptions.length > 0 && recommendedKeys.length > 0 && !referencesExistingOption ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-020d',
                        'feldPfad': `${ id }.aiEmpfehlung`,
                        'description': `Malformed: AI-Empfehlung references no existing option (expected one of ${ optionKeys.join( ', ' ) })`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // Options-parseable check — only meaningful for the markdown source. The raw
                // block for this question is matched by id; if it shows option markers but the
                // parser produced 0 real options, the options are not parseable. The Phase-5
                // parser is paren-tolerant ("(A)" / "A)" both parse), so the residual failure
                // mode is a marker form the parser cannot read — e.g. bracket markers "[A]" or
                // bare-letter lists. We require >= 2 DISTINCT letters so a stray single letter
                // never triggers a false positive.
                const rawBlock = typeof rawBlocks[ id ] === 'string' ? rawBlocks[ id ] : ''
                const markerLetters = ( rawBlock.match( /(?:^|\s|\[|\()([A-H])(?:\]|\))?[):.\]]\s+\S/gm ) || [] )
                    .map( ( hit ) => ( hit.match( /[A-H]/ ) || [ '' ] )[ 0 ] )
                const distinctMarkers = new Set( markerLetters )
                const hasMarkers = distinctMarkers.size >= 2

                if( realOptions.length === 0 && hasMarkers && !safe[ 'answered' ] ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-030',
                        'feldPfad': `${ id }.options`,
                        'description': 'Options not parseable (use discrete lines "A) ...", not inline "(A)/(B)")',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // MEMO-031 (Memo 012 Kap 3): bold-wrapped option markers like "**A)**" or
                // "**A:**" never parse as options (the marker regex requires start/space/[/(
                // before the letter, not "*"). The author intent is clearly options, so a
                // bold marker with zero parsed real options is a defect — not a false positive
                // on prose, because this only inspects the question's own raw block.
                const boldMarkers = rawBlock.match( /\*\*[A-H][):]\*\*/g ) || []
                if( boldMarkers.length > 0 && realOptions.length === 0 && !safe[ 'answered' ] ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-031',
                        'feldPfad': `${ id }.options`,
                        'description': `Option marker is bold-wrapped (${ boldMarkers[ 0 ] }) and does not parse — use plain "A) ..." lines`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // MEMO-032 (Memo 012 Kap 3): duplicate options. Two failure modes — a duplicate
                // key among the real options, or an authored option whose label duplicates a
                // parser-injected default ("ablehnen" / "Über das Topic springen" / legacy
                // "Frage ablösen"), which yields 7-instead-of-5 options that still pass today.
                const optionKeyList = realOptions.map( ( option ) => option[ 'key' ] )
                const duplicateKey = optionKeyList
                    .find( ( key, index ) => optionKeyList.indexOf( key ) !== index )
                const injectedLabels = [ 'ablehnen', 'über das topic springen', 'frage ablösen' ]
                const duplicatesInjected = realOptions
                    .some( ( option ) => injectedLabels.includes( String( option[ 'label' ] ).trim().toLowerCase() ) )

                if( ( duplicateKey !== undefined || duplicatesInjected === true ) && !safe[ 'answered' ] ) {
                    const detail = duplicateKey !== undefined
                        ? `duplicate option key "${ duplicateKey }"`
                        : 'an authored option duplicates the injected custom/topic default'
                    MemoValidator.#route( {
                        'code': 'MEMO-032',
                        'feldPfad': `${ id }.options`,
                        'description': `Duplicate option within the question (${ detail })`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // Typ consistency — checklist (>= 2 checkbox items) must be typ=multi.
                const checkboxItems = rawBlock.match( /^[ \t]*[-*]\s+\[[ xX]\]/gm ) || []

                if( checkboxItems.length >= 2 && typ !== 'multi' ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-040',
                        'feldPfad': `${ id }.typ`,
                        'description': 'Checklist must be typ=multi (>= 2 checkbox items found)',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }
            } )

        return struct
    }


    static #validateLintExtensions( { doc, fileName } ) {
        const struct = { 'messages': [], 'info': [] }

        // MEMO-060 (Memo 012 Kap 3): the revision filename suffix. Only checked when a file
        // name is supplied (the server write-gate validates raw doc strings without one). The
        // accepted forms are REV-NN.md (Full), REV-NN-prepare.md and REV-NN-update.md.
        if( typeof fileName === 'string' && fileName.length > 0 ) {
            const base = fileName.split( '/' ).pop()
            const wellFormed = /^REV-\d{2}(-prepare|-update)?\.md$/.test( base )

            if( wellFormed !== true ) {
                MemoValidator.#route( {
                    'code': 'MEMO-060',
                    'feldPfad': `file.${ base }`,
                    'description': 'Revision filename suffix malformed (expected REV-NN.md, REV-NN-prepare.md or REV-NN-update.md)',
                    'messages': struct[ 'messages' ],
                    'info': struct[ 'info' ]
                } )
            }
        }

        // MEMO-070 (Memo 012 Kap 3): an unresolved "[Research offen]" lifecycle marker must not
        // survive into a delivered revision. Markers inside inline code spans (`[Research offen]`)
        // or fenced code blocks are documentation about the marker, not an active marker — strip
        // those first, then look for a residual occurrence.
        const withoutFences = doc.replace( /```[\s\S]*?```/g, '' )
        const withoutInlineCode = withoutFences.replace( /`[^`]*`/g, '' )
        if( /\[Research offen\]/i.test( withoutInlineCode ) === true ) {
            MemoValidator.#route( {
                'code': 'MEMO-070',
                'feldPfad': 'lifecycle.research',
                'description': 'Unresolved "[Research offen]" marker present — resolve the open research before delivering',
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        }

        // MEMO-080 (Memo 012 Kap 7): the Block overlay's machine-readable block-meta field.
        // Additive — a memo with no block-meta fence parses to an empty list and never trips this.
        // A block-meta fence must be valid JSON AND its topic/prd ids must be in T001 / PRD-001 shape.
        const { blocks, errors } = BlockMeta.parse( { doc } )

        errors.forEach( ( entry ) => {
            MemoValidator.#route( {
                'code': 'MEMO-080',
                'feldPfad': `block-meta.${ entry.chapter === null ? '(top)' : entry.chapter.replace( /\s+/g, '' ) }`,
                'description': entry.reason,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        } )

        blocks.forEach( ( block ) => {
            const { messages } = BlockMeta.validateShape( { block } )
            messages.forEach( ( message ) => {
                MemoValidator.#route( {
                    'code': 'MEMO-080',
                    'feldPfad': `block-meta.${ block.chapter === null ? '(top)' : block.chapter.replace( /\s+/g, '' ) }`,
                    'description': message,
                    'messages': struct[ 'messages' ],
                    'info': struct[ 'info' ]
                } )
            } )
        } )

        return struct
    }


    static #validateQuestionParse( { doc, questionSchema, jsonFound } ) {
        const struct = { 'messages': [], 'info': [] }
        const questions = ( questionSchema !== null && typeof questionSchema === 'object' && Array.isArray( questionSchema[ 'questions' ] ) )
            ? questionSchema[ 'questions' ]
            : []

        const headingMatches = doc.match( /^###\s+F\d+\b/gm ) || []
        const headingCount = headingMatches.length

        // Memo 041 Teil B (Kap 9, 12): json is the source. When a questions-json block is present it is
        // FULLY authoritative — the `### F{N}` markdown is no longer a required render mirror. Open
        // questions live json-only (the split-brain fix), while answered questions keep their
        // `## Beantwortete Fragen` decision records (the AI-Empfehlung-war / User-Entscheidung pairs that
        // memo-mental-model-derive reads). Because those two artefacts legitimately differ in count, the
        // heading-vs-question cross-check does NOT apply to a json-source revision — and old hybrid memos
        // (every question mirrored) keep passing on re-registration. Only the MARKDOWN-ONLY path keeps the
        // original rule: a `### F{N}` heading that did not parse into a question is still a defect.
        if( jsonFound !== true && headingCount !== questions.length ) {
            MemoValidator.#route( {
                'code': 'MEMO-025',
                'feldPfad': 'questions',
                'description': `Question parsing incomplete (found ${ headingCount } "### F{N}" headings but parsed ${ questions.length } questions)`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        }

        return struct
    }


    static #validateOptionKinds( { doc, jsonFound } ) {
        // MEMO-033 (Memo 041 Teil B, Kap 10): the kind-validity check the renderer needs but the
        // validator was missing. Inspect the RAW questions-json options (before #normalizeJsonQuestion
        // coerces unknown kinds to 'option') so a bad authored kind — e.g. kind:"normal" — fails LOUD
        // at the door instead of silently dropping the option into the browser fallback. Only meaningful
        // when a questions-json block exists; the markdown mirror never carries an explicit kind.
        const struct = { 'messages': [], 'info': [] }

        if( jsonFound !== true ) { return struct }

        const blockPattern = /```questions-json\s*\n([\s\S]*?)\n```/
        const matched = doc.match( blockPattern )
        if( matched === null ) { return struct }

        let parsed
        try {
            parsed = JSON.parse( matched[ 1 ] )
        } catch {
            // A malformed block is already reported as MEMO-050 by #validateJsonBlock — do not double-report.
            return struct
        }

        const list = Array.isArray( parsed )
            ? parsed
            : ( parsed !== null && typeof parsed === 'object' && Array.isArray( parsed[ 'questions' ] ) ? parsed[ 'questions' ] : [] )

        list
            .forEach( ( entry ) => {
                const safe = ( entry !== null && typeof entry === 'object' ) ? entry : {}
                const id = typeof safe[ 'id' ] === 'string' && safe[ 'id' ].length > 0 ? safe[ 'id' ] : 'F?'
                const invalid = invalidOptionKinds( { options: safe[ 'options' ] } )

                invalid
                    .forEach( ( option ) => {
                        const keyLabel = option[ 'key' ].length > 0 ? option[ 'key' ] : '?'
                        MemoValidator.#route( {
                            'code': 'MEMO-033',
                            'feldPfad': `${ id }.options.${ keyLabel }.kind`,
                            'description': `Option kind "${ option[ 'kind' ] }" is not one of {option, custom, topic} — the renderer drops it`,
                            'messages': struct[ 'messages' ],
                            'info': struct[ 'info' ]
                        } )
                    } )
            } )

        return struct
    }


    static #extractQuestionBlocks( { doc } ) {
        const struct = { 'blocks': {} }
        const lines = doc.split( '\n' )
        const headingPattern = /^###\s+(F\d+)\b/
        const sectionPattern = /^##\s+/

        // A question block ends at the next "### F{N}" heading OR the next "## " section
        // heading (whichever comes first), so a question never bleeds across a section
        // boundary into the following section's content (e.g. the "## Phasen" checkboxes).
        const starts = []
        const boundaries = []
        lines
            .forEach( ( line, index ) => {
                const matched = line.match( headingPattern )

                if( matched !== null ) {
                    starts.push( { 'id': matched[ 1 ], index } )
                    boundaries.push( index )
                } else if( sectionPattern.test( line ) === true ) {
                    boundaries.push( index )
                }
            } )

        starts
            .forEach( ( entry ) => {
                const laterBoundaries = boundaries
                    .filter( ( boundaryIndex ) => boundaryIndex > entry[ 'index' ] )
                const endIndex = laterBoundaries.length > 0
                    ? Math.min( ...laterBoundaries )
                    : lines.length
                const block = lines
                    .slice( entry[ 'index' ], endIndex )
                    .join( '\n' )

                struct[ 'blocks' ][ entry[ 'id' ] ] = block
            } )

        return struct
    }
}


export { MemoValidator }
