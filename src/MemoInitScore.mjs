// MemoInitScore — advisory pre-init score for the memo-init step (Memo 013, Kap 4 / F5).
//
// Implements the rubric from skills/memo/memo-init/memo-init-score-rubrik.md (PRD-003):
// four dimensions (direction, context, topics, references), each graded A/B/C.
// The class is STRICTLY advisory — it never throws on weak input and never blocks
// the init. Severity is limited to INFO and WARNING; there is no ERROR and no gate.
//
// Error-/hint-code format follows node-error-codes: {PREFIX}-{NUMBER} {location}: {description}.
// PREFIX is INIT, codes INIT-001..INIT-004 (one per dimension).

const VALID_GRADES = [ 'A', 'B', 'C' ]

const DIMENSION_DEFS = [
    { 'key': 'direction', 'code': 'INIT-001', 'location': 'direction', 'label': 'Richtungsklarheit', 'description': 'Richtung/Zielsetzung duenn — eine klarere Stossrichtung koennte ergaenzt werden' },
    { 'key': 'context', 'code': 'INIT-002', 'location': 'context', 'label': 'Kontext/Hintergrund', 'description': 'Hintergrund duenn — Ausgangslage/Rahmen koennte ergaenzt werden' },
    { 'key': 'topics', 'code': 'INIT-003', 'location': 'topics', 'label': 'Topic-Abdeckung', 'description': 'Themen nur teils benannt — Topics koennten klarer abgegrenzt werden' },
    { 'key': 'references', 'code': 'INIT-004', 'location': 'references', 'label': 'Referenzmaterial', 'description': 'Keine eindeutigen Quellen — Dateien/Transcripts/Links koennten ergaenzt werden' }
]


class MemoInitScore {

    // Grade a single dimension. Advisory only — returns a struct, never throws.
    // grade must be 'A', 'B' or 'C' (rubric A/B/C scale). On invalid input the
    // dimension is reported as not-valid with a message, but no error is raised.
    static gradeDimension( { key, grade } ) {
        const struct = { 'status': false, 'messages': [], 'dimension': null }

        const { status: validStatus, messages: validMessages } = MemoInitScore.validateGradeDimension( { key, grade } )

        if( !validStatus ) {
            struct['messages'] = validMessages

            return struct
        }

        const def = DIMENSION_DEFS
            .find( ( d ) => d['key'] === key )

        const { severity } = MemoInitScore.#severityForGrade( { grade } )
        const isHint = grade !== 'A'

        struct['status'] = true
        struct['dimension'] = {
            'key': def['key'],
            'label': def['label'],
            'grade': grade,
            'severity': severity,
            'isHint': isHint,
            'code': isHint ? def['code'] : null,
            'message': isHint ? `${def['code']} ${def['location']}: ${def['description']}` : null
        }

        return struct
    }


    // Evaluate all four dimensions at once. Input is an object mapping each
    // dimension key (direction/context/topics/references) to a grade A/B/C.
    // Returns { status, messages, grade, dimensions, hints }. ALWAYS advisory:
    // even an all-C input produces status:true with only INFO/WARNING hints.
    static evaluate( { grades } ) {
        const struct = { 'status': false, 'messages': [], 'grade': null, 'dimensions': [], 'hints': [] }

        const { status: validStatus, messages: validMessages } = MemoInitScore.validateEvaluate( { grades } )

        if( !validStatus ) {
            struct['messages'] = validMessages

            return struct
        }

        const dimensions = DIMENSION_DEFS
            .map( ( def ) => {
                const grade = grades[ def['key'] ]
                const { dimension } = MemoInitScore.gradeDimension( { key: def['key'], grade } )

                return dimension
            } )

        const hints = dimensions
            .filter( ( d ) => d['isHint'] )
            .map( ( d ) => {
                return { 'code': d['code'], 'severity': d['severity'], 'message': d['message'] }
            } )

        const { overall } = MemoInitScore.#aggregateGrade( { dimensions } )

        struct['status'] = true
        struct['grade'] = overall
        struct['dimensions'] = dimensions
        struct['hints'] = hints

        return struct
    }


    // Validate input for gradeDimension. Advisory: invalid input is reported via
    // messages, never thrown.
    static validateGradeDimension( { key, grade } ) {
        const struct = { 'status': false, 'messages': [] }
        const validKeys = DIMENSION_DEFS
            .map( ( d ) => d['key'] )

        if( key === undefined ) {
            struct['messages'].push( 'key: Missing value' )
        } else if( typeof key !== 'string' ) {
            struct['messages'].push( 'key: Must be a string' )
        } else if( !validKeys.includes( key ) ) {
            struct['messages'].push( `key: Must be one of: ${validKeys.join( ', ' )}` )
        }

        if( grade === undefined ) {
            struct['messages'].push( 'grade: Missing value' )
        } else if( typeof grade !== 'string' ) {
            struct['messages'].push( 'grade: Must be a string' )
        } else if( !VALID_GRADES.includes( grade ) ) {
            struct['messages'].push( `grade: Must be one of: ${VALID_GRADES.join( ', ' )}` )
        }

        if( struct['messages'].length > 0 ) {
            return struct
        }

        struct['status'] = true

        return struct
    }


    // Validate input for evaluate. Each dimension key must carry a valid A/B/C grade.
    static validateEvaluate( { grades } ) {
        const struct = { 'status': false, 'messages': [] }

        if( grades === undefined ) {
            struct['messages'].push( 'grades: Missing value' )

            return struct
        }

        if( typeof grades !== 'object' || grades === null || Array.isArray( grades ) ) {
            struct['messages'].push( 'grades: Must be an object' )

            return struct
        }

        DIMENSION_DEFS
            .forEach( ( def ) => {
                const grade = grades[ def['key'] ]

                if( grade === undefined ) {
                    struct['messages'].push( `grades.${def['key']}: Missing value` )
                } else if( typeof grade !== 'string' ) {
                    struct['messages'].push( `grades.${def['key']}: Must be a string` )
                } else if( !VALID_GRADES.includes( grade ) ) {
                    struct['messages'].push( `grades.${def['key']}: Must be one of: ${VALID_GRADES.join( ', ' )}` )
                }
            } )

        if( struct['messages'].length > 0 ) {
            return struct
        }

        struct['status'] = true

        return struct
    }


    // Expose the dimension definitions (read-only copy) so callers/tests can
    // introspect codes, labels and locations without reaching into internals.
    static getDimensionDefinitions() {
        const dimensions = DIMENSION_DEFS
            .map( ( def ) => {
                return {
                    'key': def['key'],
                    'code': def['code'],
                    'location': def['location'],
                    'label': def['label'],
                    'description': def['description']
                }
            } )

        return { dimensions }
    }


    // Severity mapping (rubric): B -> INFO, C -> WARNING, A -> INFO (no hint emitted).
    // There is no ERROR severity — that is the hard-coded advisory guarantee (Leitplanke 5).
    static #severityForGrade( { grade } ) {
        if( grade === 'C' ) {
            return { severity: 'WARNING' }
        }

        return { severity: 'INFO' }
    }


    // Aggregation (rubric): the lowest dimension dominates the overall grade
    // (min over C < B < A). Hints are listed, not summed.
    static #aggregateGrade( { dimensions } ) {
        const order = { 'A': 3, 'B': 2, 'C': 1 }
        const lowest = dimensions
            .reduce( ( acc, d ) => {
                return order[ d['grade'] ] < order[ acc ] ? d['grade'] : acc
            }, 'A' )

        return { overall: lowest }
    }
}


export { MemoInitScore }
