import { spawn } from 'node:child_process'


// PRD-09/11 (Memo 079): capture every user input that reaches the transcript server as a
// `user_inputs` row (and, for review widget answers, `user_input_answers` rows) in the per-memo DB.
//
// F4=A single-writer (design authority: w2-user-inputs-pfad.md:246 "Writes nur ueber die CLI"): the
// viewer NEVER opens a 2nd concurrent writer to the per-memo DB. EVERY write is routed THROUGH the
// core CLI leaf (`memo user-input record` / `memo user-input answer`) via child_process. This module
// holds only the exec-and-map logic behind an INJECTABLE exec seam, so it is testable without a real
// binary and without a real DB.
//
// Best-effort-but-visible (PRD-19 error-transparency, w2:247 fail-loud): a capture failure — exec
// error, non-zero exit, or a missing session id — NEVER crashes the primary (atomic) transcript MD
// write. It surfaces a visible message instead of a silent skip.
class UserInputCapture {
    // Reserve memo id for inputs that arrive WITHOUT a bound memo number (the /api/other/transcripts
    // pool). Mirrors TranscriptRegistry.OTHER_TRANSCRIPTS_MEMO_ID — keep the two literals in sync.
    static OTHER_MEMO_ID = '(ungebunden)'

    // Transcript header-type -> user_inputs.kind. init / other-memo-init -> voice-init,
    // revision -> voice-review, frei -> voice-frei. An unknown type yields null so the caller
    // surfaces it (never a silent guess). The DB `kind` column is free TEXT (DoltSchema), but the core
    // `user-input record` leaf validates --kind against UserInputStore.INPUT_KINDS — every slug emitted
    // here (incl. voice-frei) is an accepted enum member, so capture never fails on an unknown kind.
    static #KIND_BY_TYPE = {
        'memo-init': 'voice-init',
        'revision': 'voice-review',
        'frei': 'voice-frei'
    }


    // Resolve the memo binary. Explicit `bin` wins; otherwise MEMO_CLI_BIN from the environment (so
    // verification can point at a worktree build), else the global `memo`. Never a silent empty bin.
    static resolveBin( { env, bin } ) {
        if( typeof bin === 'string' && bin.length > 0 ) {
            return { bin }
        }

        const environment = ( env !== null && typeof env === 'object' ) ? env : {}
        const fromEnv = environment[ 'MEMO_CLI_BIN' ]

        return { 'bin': ( typeof fromEnv === 'string' && fromEnv.length > 0 ) ? fromEnv : 'memo' }
    }


    static mapKind( { transcriptType } ) {
        const kind = UserInputCapture.#KIND_BY_TYPE[ transcriptType ] || null

        return { kind }
    }


    // Session id resolution: request body (`--session-id` flag equivalent) > CLAUDE_CODE_SESSION_ID
    // ambient. A truly absent id is NOT swallowed — status:false + a visible message (w2:216 the
    // `unknown` value is forbidden -> fail-loud). sessionSource mirrors sessions.jsonl (flag/ambient/none).
    static resolveSessionId( { bodySessionId, env } ) {
        const struct = { 'status': false, 'sessionId': null, 'sessionSource': 'none', 'messages': [] }

        if( typeof bodySessionId === 'string' && bodySessionId.length > 0 ) {
            struct[ 'status' ] = true
            struct[ 'sessionId' ] = bodySessionId
            struct[ 'sessionSource' ] = 'flag'

            return struct
        }

        const environment = ( env !== null && typeof env === 'object' ) ? env : {}
        const ambient = environment[ 'CLAUDE_CODE_SESSION_ID' ]

        if( typeof ambient === 'string' && ambient.length > 0 ) {
            struct[ 'status' ] = true
            struct[ 'sessionId' ] = ambient
            struct[ 'sessionSource' ] = 'ambient'

            return struct
        }

        struct[ 'messages' ].push( 'USERINPUT-SESSION-001: no session id (request body or CLAUDE_CODE_SESSION_ID env) — user_inputs row NOT recorded; transcript MD write is unaffected' )

        return struct
    }


    // Parse the widget "## Antwort auf F{N} — {title}" answer blocks out of a review transcript body.
    // The block body runs to the NEXT "## " heading, so trailing "## Quality-Checks angefragt" /
    // "## Anmerkungen" sections (composed by the same "Uebernehmen" flow) are excluded. `^` is
    // start-or-after-newline; `$` (no m-flag) is end-of-string. Empty answers are dropped.
    static parseAnswerBlocks( { content } ) {
        const struct = { 'answers': [] }

        if( typeof content !== 'string' || content.length === 0 ) {
            return struct
        }

        const pattern = /(?:^|\n)##\s+Antwort auf\s+(F\d+)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/g
        const matches = [ ...content.matchAll( pattern ) ]

        struct[ 'answers' ] = matches
            .map( ( match ) => {
                const question = match[ 1 ]
                const answer = ( match[ 2 ] || '' ).trim()

                return { question, answer }
            } )
            .filter( ( entry ) => entry[ 'answer' ].length > 0 )

        return struct
    }


    // EXEC `memo user-input record --memo <id> --kind <k> --source transcript-server --session-id <id>
    // --payload -` with the RAW transcript content piped on stdin. Returns the input_id parsed from the
    // leaf's stdout so PRD-11 answers can be chained to the same record.
    static async recordInput( { memoId, kind, sessionId, source, payload, bin, exec } ) {
        const struct = { 'status': false, 'inputId': null, 'messages': [], 'argv': null }

        const runner = ( typeof exec === 'function' ) ? exec : UserInputCapture.#defaultExec
        const binary = ( typeof bin === 'string' && bin.length > 0 ) ? bin : 'memo'
        const args = [
            'user-input', 'record',
            '--memo', String( memoId ),
            '--kind', String( kind ),
            '--source', String( source ),
            '--session-id', String( sessionId ),
            '--payload', '-'
        ]

        struct[ 'argv' ] = [ binary ].concat( args )

        let result

        try {
            result = await runner( { 'bin': binary, args, 'input': payload } )
        } catch ( err ) {
            struct[ 'messages' ].push( `USERINPUT-EXEC-001: record exec threw: ${ err.message }` )

            return struct
        }

        if( result === null || result === undefined || result[ 'status' ] !== true ) {
            const detail = ( result !== null && result !== undefined && result[ 'stderr' ] ) ? String( result[ 'stderr' ] ).trim() : 'unknown error'
            struct[ 'messages' ].push( `USERINPUT-EXEC-002: record exited non-zero — ${ detail }` )

            return struct
        }

        const { inputId } = UserInputCapture.#parseInputId( { 'stdout': result[ 'stdout' ] } )

        if( inputId === null ) {
            struct[ 'messages' ].push( 'USERINPUT-EXEC-003: record succeeded but no input_id on stdout — answers cannot be chained to a record' )

            return struct
        }

        struct[ 'status' ] = true
        struct[ 'inputId' ] = inputId

        return struct
    }


    // EXEC `memo user-input answer` once per parsed answer block — chained to the record's input_id, so
    // a widget answer writes the SAME user_input_answers record a terminal answer would (WI-044,
    // w3-interaktionsformen.md:170). SEQUENTIAL (reduce, not Promise.all) to keep the single-writer
    // discipline: never fire N concurrent CLI writers at one per-memo DB.
    static async recordAnswers( { memoId, inputId, answers, bin, exec } ) {
        const struct = { 'status': true, 'recorded': 0, 'messages': [], 'invocations': [] }

        if( !Array.isArray( answers ) || answers.length === 0 ) {
            return struct
        }

        const runner = ( typeof exec === 'function' ) ? exec : UserInputCapture.#defaultExec
        const binary = ( typeof bin === 'string' && bin.length > 0 ) ? bin : 'memo'

        const final = await answers.reduce( async ( accPromise, answer ) => {
            const acc = await accPromise
            const one = await UserInputCapture.#execAnswer( { binary, memoId, inputId, answer, runner } )

            acc[ 'invocations' ].push( one[ 'argv' ] )

            if( one[ 'status' ] === true ) {
                acc[ 'recorded' ] += 1
            } else {
                one[ 'messages' ].forEach( ( message ) => acc[ 'messages' ].push( message ) )
            }

            return acc
        }, Promise.resolve( { 'recorded': 0, 'messages': [], 'invocations': [] } ) )

        struct[ 'recorded' ] = final[ 'recorded' ]
        struct[ 'messages' ] = final[ 'messages' ]
        struct[ 'invocations' ] = final[ 'invocations' ]
        struct[ 'status' ] = final[ 'messages' ].length === 0

        return struct
    }


    // High-level orchestrator called by the POST routes AFTER the primary MD write. Never throws:
    // always returns a struct with visible messages. status:true means the record row was written.
    static async capture( { memoId, transcriptType, content, bodySessionId, env, source, bin, exec, withAnswers } ) {
        const struct = { 'status': false, 'inputId': null, 'kind': null, 'answersRecorded': 0, 'messages': [], 'invocations': [] }

        const resolvedSource = ( typeof source === 'string' && source.length > 0 ) ? source : 'transcript-server'
        const { bin: resolvedBin } = UserInputCapture.resolveBin( { env, bin } )
        const { kind } = UserInputCapture.mapKind( { transcriptType } )
        const resolvedMemo = ( typeof memoId === 'string' && memoId.length > 0 ) ? memoId : UserInputCapture.OTHER_MEMO_ID

        if( kind === null ) {
            struct[ 'messages' ].push( `USERINPUT-KIND-001: unknown transcript type '${ transcriptType }' — user_inputs row NOT recorded (transcript MD unaffected)` )

            return struct
        }

        struct[ 'kind' ] = kind

        const session = UserInputCapture.resolveSessionId( { bodySessionId, env } )

        if( session[ 'status' ] !== true ) {
            struct[ 'messages' ] = struct[ 'messages' ].concat( session[ 'messages' ] )

            return struct
        }

        const record = await UserInputCapture.recordInput( {
            'memoId': resolvedMemo,
            kind,
            'sessionId': session[ 'sessionId' ],
            'source': resolvedSource,
            'payload': content,
            'bin': resolvedBin,
            exec
        } )

        struct[ 'invocations' ].push( record[ 'argv' ] )

        if( record[ 'status' ] !== true ) {
            struct[ 'messages' ] = struct[ 'messages' ].concat( record[ 'messages' ] )

            return struct
        }

        struct[ 'status' ] = true
        struct[ 'inputId' ] = record[ 'inputId' ]

        if( withAnswers === true ) {
            const { answers } = UserInputCapture.parseAnswerBlocks( { content } )
            const answered = await UserInputCapture.recordAnswers( {
                'memoId': resolvedMemo,
                'inputId': record[ 'inputId' ],
                answers,
                'bin': resolvedBin,
                exec
            } )

            struct[ 'answersRecorded' ] = answered[ 'recorded' ]
            answered[ 'invocations' ].forEach( ( invocation ) => struct[ 'invocations' ].push( invocation ) )

            if( answered[ 'status' ] !== true ) {
                struct[ 'messages' ] = struct[ 'messages' ].concat( answered[ 'messages' ] )
            }
        }

        return struct
    }


    static async #execAnswer( { binary, memoId, inputId, answer, runner } ) {
        const struct = { 'status': false, 'messages': [], 'argv': null }

        const question = ( answer !== null && answer !== undefined && answer[ 'question' ] ) ? String( answer[ 'question' ] ) : ''
        const answerText = ( answer !== null && answer !== undefined && answer[ 'answer' ] !== undefined && answer[ 'answer' ] !== null ) ? String( answer[ 'answer' ] ) : ''

        if( question.length === 0 ) {
            struct[ 'messages' ].push( 'USERINPUT-ANSWER-001: answer block without a question id — skipped' )

            return struct
        }

        const base = [ 'user-input', 'answer', '--memo', String( memoId ), '--input-id', String( inputId ), '--question', question ]
        const hasOption = ( answer[ 'option' ] !== undefined && answer[ 'option' ] !== null && String( answer[ 'option' ] ).length > 0 )
        const withOption = hasOption ? base.concat( [ '--option', String( answer[ 'option' ] ) ] ) : base
        const args = withOption.concat( [ '--answer', answerText ] )

        struct[ 'argv' ] = [ binary ].concat( args )

        let result

        try {
            result = await runner( { 'bin': binary, args, 'input': null } )
        } catch ( err ) {
            struct[ 'messages' ].push( `USERINPUT-EXEC-001: answer exec threw for ${ question }: ${ err.message }` )

            return struct
        }

        if( result === null || result === undefined || result[ 'status' ] !== true ) {
            const detail = ( result !== null && result !== undefined && result[ 'stderr' ] ) ? String( result[ 'stderr' ] ).trim() : 'unknown error'
            struct[ 'messages' ].push( `USERINPUT-EXEC-002: answer ${ question } exited non-zero — ${ detail }` )

            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static #parseInputId( { stdout } ) {
        const struct = { 'inputId': null }

        if( typeof stdout !== 'string' || stdout.trim().length === 0 ) {
            return struct
        }

        try {
            const json = JSON.parse( stdout.trim() )
            const id = json[ 'input_id' ] || json[ 'inputId' ] || null

            if( typeof id === 'string' && id.length > 0 ) {
                struct[ 'inputId' ] = id

                return struct
            }
        } catch {
            // Not JSON — fall through to a permissive UI-<n> extraction below.
        }

        const match = stdout.match( /\bUI-\d+\b/ )

        if( match ) {
            struct[ 'inputId' ] = match[ 0 ]
        }

        return struct
    }


    // Default exec seam: spawn the memo binary, pipe `input` on stdin, collect stdout/stderr. Resolves
    // (never rejects) to { status, code, stdout, stderr } so callers stay best-effort. A spawn failure
    // (ENOENT etc.) arrives via the 'error' event, not a throw.
    static #defaultExec( { bin, args, input } ) {
        return new Promise( ( resolvePromise ) => {
            const struct = { 'status': false, 'code': null, 'stdout': '', 'stderr': '' }
            let child

            try {
                child = spawn( bin, args, { 'stdio': [ 'pipe', 'pipe', 'pipe' ] } )
            } catch ( err ) {
                struct[ 'stderr' ] = err.message
                resolvePromise( struct )

                return
            }

            child.stdout.on( 'data', ( chunk ) => { struct[ 'stdout' ] += chunk.toString() } )
            child.stderr.on( 'data', ( chunk ) => { struct[ 'stderr' ] += chunk.toString() } )

            child.on( 'error', ( err ) => {
                struct[ 'stderr' ] += err.message
                resolvePromise( struct )
            } )

            child.on( 'close', ( code ) => {
                struct[ 'code' ] = code
                struct[ 'status' ] = code === 0
                resolvePromise( struct )
            } )

            if( input !== undefined && input !== null ) {
                child.stdin.write( input )
            }

            child.stdin.end()
        } )
    }
}


export { UserInputCapture }
