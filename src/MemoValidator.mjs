import { DocumentRegistry } from './DocumentRegistry.mjs'


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
//   Advisory      INFO-001–099   Hinweise ohne Blockierung
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
    { 'code': 'INFO-010', 'severity': 'INFO', 'theme': 'header', 'description': 'Schema-Version marker missing (advisory until writing skills set it)' }
]


class MemoValidator {
    static validate( { doc } ) {
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
        const questions = MemoValidator.#validateQuestions( { doc, questionSchema } )

        const messages = []
            .concat( sections[ 'messages' ] )
            .concat( header[ 'messages' ] )
            .concat( json[ 'messages' ] )
            .concat( questions[ 'messages' ] )

        const info = []
            .concat( sections[ 'info' ] )
            .concat( header[ 'info' ] )
            .concat( json[ 'info' ] )
            .concat( questions[ 'info' ] )

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


    static #validateQuestions( { doc, questionSchema } ) {
        const struct = { 'messages': [], 'info': [] }
        const questions = ( questionSchema !== null && typeof questionSchema === 'object' && Array.isArray( questionSchema[ 'questions' ] ) )
            ? questionSchema[ 'questions' ]
            : []

        // PRD-038 Re-Check: "Did question parsing work?" — compare ### F{N} headings in the
        // raw markdown with the number of parsed questions. A mismatch means a heading exists
        // that the parser did not capture as a question.
        const { messages: parseMessages, info: parseInfo } = MemoValidator.#validateQuestionParse( { doc, questionSchema } )
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


    static #validateQuestionParse( { doc, questionSchema } ) {
        const struct = { 'messages': [], 'info': [] }
        const questions = ( questionSchema !== null && typeof questionSchema === 'object' && Array.isArray( questionSchema[ 'questions' ] ) )
            ? questionSchema[ 'questions' ]
            : []

        const headingMatches = doc.match( /^###\s+F\d+\b/gm ) || []
        const headingCount = headingMatches.length

        if( headingCount !== questions.length ) {
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
