// McpEndpoint.mjs — the tool endpoint of the viewer (Memo 080, Kap 19, PRD-V9, F12=A / F31=A).
//
// WHAT IT IS: ONE route (`/mcp`) on the ALREADY RUNNING viewer server — no second port, no second
// process, loopback binding inherited (A1). It speaks the JSON-RPC subset a tool client needs:
// `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. It offers exactly
// ONE tool, `wait_for_answer`, which WAITS until the user presses "Abschliessen" in the viewer and
// hands the answer back IN the tool result — the only road on which the answer reaches the calling
// session directly instead of only appearing in a terminal.
//
// WHY IT IS HAND-WRITTEN AND NOT A LIBRARY (A14): the viewer carries exactly two dependencies
// (@dolthub/doltlite, ws). The needed protocol surface is five methods over POST-with-JSON plus an
// event stream for progress; that is smaller than the supply-chain review a new dependency would
// need. The decision is recorded here and in the closing note, it is not taken silently.
//
// THE SENTENCE THE WHOLE FILE HANGS ON (A11): delivery is NOT the proof. Every result carries
// `evidencePath` onto the durable store, and the answer is re-read FROM DISK after the register
// wakes — the register only decides WHEN to look, never WHAT is true. In this very rollout 75 agents
// worked cleanly, wrote their file and still mostly failed to deliver their return text.
//
// Class architecture per node-class-architecture: static-only, object params, object returns,
// private-by-default, NO SILENT DEFAULTS, no for/while loops.

import { AnswerWaiter } from './AnswerWaiter.mjs'


// The protocol revisions this endpoint answers for. The client names one in `initialize`; a known one
// is echoed back, an unknown one is answered with our newest AND the negotiation is stated in the
// result, never silently bent.
const SUPPORTED_PROTOCOL_VERSIONS = [ '2025-06-18', '2025-03-26', '2024-11-05' ]

// A tool call may wait a long time — but the ceiling is OURS, never inherited from the client's
// overall deadline (A7). Default one hour, hard ceiling one day.
const DEFAULT_TIMEOUT_SECONDS = 3600
const MAX_TIMEOUT_SECONDS = 86400

// The idle deadline of the HTTP transport is 5 minutes (research §3). Anything that waits longer than
// a coffee break dies without traffic, so a progress message goes out every 60 s while a call is open
// (A6). Measure the real deadline with tests/manual/mcp-wait-for-answer-e2e.mjs, do not trust this
// comment: it is the reason for the number, not evidence for it.
const PROGRESS_INTERVAL_MS = 60000

// The loopback origins a browser-side caller may carry. Everything else is a foreign origin: the
// attack this closes is DNS rebinding — a page on a foreign host resolving to 127.0.0.1 and posting
// into the local server (A2).
const LOOPBACK_ORIGIN_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/


class McpEndpoint {
    static ENDPOINT_PATH = '/mcp'
    static PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[ 0 ]
    static DEFAULT_TIMEOUT_SECONDS = DEFAULT_TIMEOUT_SECONDS
    static MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_SECONDS
    static PROGRESS_INTERVAL_MS = PROGRESS_INTERVAL_MS
    static TOOL_NAME = 'wait_for_answer'


    static isEndpointUrl( { url } ) {
        const path = typeof url === 'string' ? url.split( '?' )[ 0 ] : ''

        return { 'matches': path === McpEndpoint.ENDPOINT_PATH }
    }


    // A2 — three outcomes, none of them a quiet yes:
    //   * a loopback origin  -> allowed
    //   * a foreign origin   -> rejected ('foreign-origin')
    //   * NO origin at all   -> rejected ('missing-origin')
    // The missing case is refused on purpose. A caller that sends no origin gets a 403 WITH the reason
    // in the body and a line in the server log, so the very first real call diagnoses itself instead of
    // failing mutely.
    static checkOrigin( { origin } ) {
        if( origin === undefined || origin === null || origin === '' ) {
            return { 'allowed': false, 'reason': 'missing-origin' }
        }
        if( typeof origin !== 'string' ) {
            return { 'allowed': false, 'reason': 'foreign-origin' }
        }
        if( LOOPBACK_ORIGIN_PATTERN.test( origin ) !== true ) {
            return { 'allowed': false, 'reason': 'foreign-origin' }
        }

        return { 'allowed': true, 'reason': null }
    }


    // A7 — the wait ceiling is declared here, not inherited. An ABSENT value takes the published
    // default (3600 s); a PRESENT but unusable value fails loud and never reaches the register.
    static normalizeTimeoutSeconds( { timeoutSeconds } ) {
        if( timeoutSeconds === undefined || timeoutSeconds === null || timeoutSeconds === '' ) {
            return { 'seconds': DEFAULT_TIMEOUT_SECONDS, 'source': 'default' }
        }

        const numeric = Number( timeoutSeconds )

        if( Number.isInteger( numeric ) !== true ) {
            throw new Error( `McpEndpoint.normalizeTimeoutSeconds: "timeoutSeconds" must be an integer — got "${ timeoutSeconds }"` )
        }
        if( numeric < 1 || numeric > MAX_TIMEOUT_SECONDS ) {
            throw new Error( `McpEndpoint.normalizeTimeoutSeconds: "timeoutSeconds" must be between 1 and ${ MAX_TIMEOUT_SECONDS } — got "${ numeric }"` )
        }

        return { 'seconds': numeric, 'source': 'caller' }
    }


    static negotiateProtocolVersion( { requested } ) {
        const known = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes( requested )

        return {
            'protocolVersion': known === true ? requested : McpEndpoint.PROTOCOL_VERSION,
            'negotiated': known === true ? 'echoed' : 'server-newest'
        }
    }


    // The tool catalogue — exactly one entry. The description is the operating rule, because it is the
    // only text the calling model reliably reads: orchestrator only, never a sub-agent (A20), and read
    // the disk after the wake.
    static toolDescriptor() {
        return {
            'tools': [ {
                'name': McpEndpoint.TOOL_NAME,
                'title': 'Wait for the user to finish answering in memo-view',
                'description': 'Waits until the user presses "Abschliessen" for the given transcript in the memo-view window and returns the durable answers in the tool result. Call this from the ORCHESTRATOR session only — a sub-agent gets no automatic backgrounding, so the call would really block it. The result carries evidencePath: after the wake, READ THE DISK, do not trust the delivery.',
                'inputSchema': {
                    'type': 'object',
                    'properties': {
                        'memo': { 'type': 'string', 'description': 'memo number, e.g. "080"' },
                        'transcriptId': { 'type': 'string', 'description': 'the transcript to wait on, e.g. "memo-init--080-db-vollausbau--REV-18--01"' },
                        'questionId': { 'type': 'string', 'description': 'optional: only report this question id, e.g. "F12"' },
                        'timeoutSeconds': { 'type': 'integer', 'description': `optional wait ceiling in seconds (default ${ DEFAULT_TIMEOUT_SECONDS }, maximum ${ MAX_TIMEOUT_SECONDS })` }
                    },
                    'required': [ 'memo', 'transcriptId' ]
                }
            } ]
        }
    }


    // A3 — the normative result shape. EVERY field is mandatory: a missing one throws here instead of
    // travelling as `undefined` and quietly disappearing in JSON.stringify. `reason` is null on the
    // success path and a named string otherwise; `evidencePath` is set on BOTH paths, because the whole
    // point of a timeout answer is telling the caller where to look.
    static buildToolResult( { status, transcriptId, answers, evidencePath, waitedMs, reason } ) {
        const missing = [
            [ 'status', typeof status === 'boolean' ],
            [ 'transcriptId', typeof transcriptId === 'string' && transcriptId.length > 0 ],
            [ 'answers', Array.isArray( answers ) ],
            [ 'evidencePath', typeof evidencePath === 'string' && evidencePath.length > 0 ],
            [ 'waitedMs', Number.isFinite( waitedMs ) ]
        ]
            .filter( ( entry ) => entry[ 1 ] !== true )
            .map( ( entry ) => entry[ 0 ] )

        if( missing.length > 0 ) {
            throw new Error( `McpEndpoint.buildToolResult: mandatory field(s) missing or malformed: ${ missing.join( ', ' ) }` )
        }

        return {
            'result': {
                status,
                transcriptId,
                answers,
                evidencePath,
                waitedMs,
                'reason': ( typeof reason === 'string' && reason.length > 0 ) ? reason : null
            }
        }
    }


    // A6 — the progress heartbeat. The timer functions are INJECTABLE so a test drives a fake clock and
    // COUNTS the messages instead of sleeping six real minutes. `stop()` is idempotent.
    static startProgressTicker( { intervalMs, onTick, timers } ) {
        if( Number.isInteger( intervalMs ) !== true || intervalMs <= 0 ) {
            throw new Error( `McpEndpoint.startProgressTicker: "intervalMs" must be a positive integer — got "${ intervalMs }"` )
        }
        if( typeof onTick !== 'function' ) {
            throw new Error( 'McpEndpoint.startProgressTicker: "onTick" is required (function)' )
        }

        const clock = ( timers !== null && typeof timers === 'object' ) ? timers : { 'setInterval': setInterval, 'clearInterval': clearInterval }
        const state = { 'ticks': 0, 'stopped': false }

        const handle = clock.setInterval( () => {
            if( state[ 'stopped' ] === true ) { return }

            state[ 'ticks' ] = state[ 'ticks' ] + 1
            onTick( { 'tick': state[ 'ticks' ], 'elapsedMs': state[ 'ticks' ] * intervalMs } )
        }, intervalMs )

        if( handle !== null && handle !== undefined && typeof handle.unref === 'function' ) { handle.unref() }

        const stop = () => {
            if( state[ 'stopped' ] === true ) { return { 'ticks': state[ 'ticks' ] } }

            state[ 'stopped' ] = true
            clock.clearInterval( handle )

            return { 'ticks': state[ 'ticks' ] }
        }

        return { stop, handle, 'ticks': () => state[ 'ticks' ] }
    }


    // The tool body. Every outside contact is a seam, so the whole flow is exercisable without a
    // server, without a database and without a real minute passing:
    //   * readEvidence( { memo, transcriptId } ) -> { found, evidencePath, answers, loggedIn, messages }
    //   * registerWaiter( { transcriptId, timeoutMs } ) -> { waiterId, promise }   (AnswerWaiter)
    //   * cancelWaiter( { waiterId } )
    //   * onProgress( { tick, elapsedMs } )        (optional — the transport writes the notification)
    //   * timers                                    (optional — fake clock in tests)
    //
    // ORDER MATTERS: the disk is read BEFORE the wait. A button that was already pressed must not put
    // the caller to sleep for an hour. And the disk is read AGAIN after the wake, so the returned
    // answers always come from the durable store and never from the wake payload (A11).
    static async waitForAnswer( { memo, transcriptId, questionId, timeoutSeconds, deps } ) {
        if( typeof memo !== 'string' || memo.length === 0 ) {
            throw new Error( 'McpEndpoint.waitForAnswer: "memo" is required (non-empty string)' )
        }
        if( typeof transcriptId !== 'string' || transcriptId.length === 0 ) {
            throw new Error( 'McpEndpoint.waitForAnswer: "transcriptId" is required (non-empty string)' )
        }
        if( deps === null || typeof deps !== 'object' ) {
            throw new Error( 'McpEndpoint.waitForAnswer: "deps" is required (object with readEvidence/registerWaiter/cancelWaiter)' )
        }

        const { readEvidence, registerWaiter, cancelWaiter, onProgress, timers } = deps

        if( typeof readEvidence !== 'function' ) {
            throw new Error( 'McpEndpoint.waitForAnswer: "deps.readEvidence" is required (function)' )
        }

        const { seconds } = McpEndpoint.normalizeTimeoutSeconds( { timeoutSeconds } )
        const startedAt = Date.now()
        const before = await readEvidence( { memo, transcriptId } )

        if( before[ 'found' ] !== true ) {
            return McpEndpoint.buildToolResult( {
                'status': false,
                transcriptId,
                'answers': [],
                'evidencePath': before[ 'evidencePath' ],
                'waitedMs': Date.now() - startedAt,
                'reason': 'transcript-not-found'
            } )
        }

        if( before[ 'loggedIn' ] === true ) {
            return McpEndpoint.buildToolResult( {
                'status': true,
                transcriptId,
                'answers': McpEndpoint.#selectAnswers( { 'answers': before[ 'answers' ], questionId } ),
                'evidencePath': before[ 'evidencePath' ],
                'waitedMs': Date.now() - startedAt,
                'reason': 'already-answered'
            } )
        }

        const register = typeof registerWaiter === 'function'
            ? registerWaiter( { transcriptId, 'timeoutMs': seconds * 1000 } )
            : AnswerWaiter.register( { transcriptId, 'timeoutMs': seconds * 1000 } )
        const ticker = McpEndpoint.startProgressTicker( {
            'intervalMs': PROGRESS_INTERVAL_MS,
            'onTick': ( tick ) => {
                if( typeof onProgress === 'function' ) { onProgress( tick ) }
            },
            timers
        } )

        try {
            const settled = await register[ 'promise' ]

            if( settled[ 'outcome' ] !== 'answered' ) {
                return McpEndpoint.buildToolResult( {
                    'status': false,
                    transcriptId,
                    'answers': [],
                    'evidencePath': before[ 'evidencePath' ],
                    'waitedMs': Date.now() - startedAt,
                    'reason': settled[ 'outcome' ]
                } )
            }

            // A11 — the register only said WHEN. The answer itself is re-read from the durable store.
            const after = await readEvidence( { memo, transcriptId } )

            return McpEndpoint.buildToolResult( {
                'status': true,
                transcriptId,
                'answers': McpEndpoint.#selectAnswers( { 'answers': after[ 'answers' ], questionId } ),
                'evidencePath': after[ 'evidencePath' ],
                'waitedMs': Date.now() - startedAt,
                'reason': null
            } )
        } finally {
            ticker.stop()

            const drop = typeof cancelWaiter === 'function' ? cancelWaiter : AnswerWaiter.cancel

            drop( { 'waiterId': register[ 'waiterId' ] } )
        }
    }


    // JSON-RPC dispatch. Returns { kind, payload }:
    //   * kind 'response'     — a JSON-RPC response object belongs on the wire
    //   * kind 'accepted'     — the message was a notification; the transport answers 202, no body
    // A tools/call for wait_for_answer is awaited here, so the caller (the transport) decides how long
    // it holds the socket open — this method never blocks the routing of OTHER requests, because
    // node's server is not serialized per connection (WI-164).
    static async handleMessage( { message, deps } ) {
        if( message === null || typeof message !== 'object' ) {
            return { 'kind': 'response', 'payload': McpEndpoint.#error( { 'id': null, 'code': -32700, 'message': 'Parse error: message must be a JSON object' } ) }
        }

        const id = message[ 'id' ] === undefined ? null : message[ 'id' ]
        const method = message[ 'method' ]

        if( typeof method !== 'string' || method.length === 0 ) {
            return { 'kind': 'response', 'payload': McpEndpoint.#error( { id, 'code': -32600, 'message': 'Invalid Request: "method" is required' } ) }
        }

        // A notification carries no id — it is acknowledged with 202 and nothing else.
        if( message[ 'id' ] === undefined || message[ 'id' ] === null ) {
            return { 'kind': 'accepted', 'payload': null, method }
        }

        if( method === 'initialize' ) {
            const params = ( message[ 'params' ] !== null && typeof message[ 'params' ] === 'object' ) ? message[ 'params' ] : {}
            const { protocolVersion } = McpEndpoint.negotiateProtocolVersion( { 'requested': params[ 'protocolVersion' ] } )

            return {
                'kind': 'response',
                'payload': McpEndpoint.#ok( {
                    id,
                    'result': {
                        protocolVersion,
                        'capabilities': { 'tools': { 'listChanged': false } },
                        'serverInfo': { 'name': 'memo-view', 'title': 'memo-view answer channel', 'version': '0.1.0' },
                        'instructions': 'One tool: wait_for_answer. Call it from the orchestrator session, never from a sub-agent. After the wake, read the path in evidencePath — the delivery is the accelerator, the disk is the proof.'
                    }
                } )
            }
        }

        if( method === 'ping' ) {
            return { 'kind': 'response', 'payload': McpEndpoint.#ok( { id, 'result': {} } ) }
        }

        if( method === 'tools/list' ) {
            return { 'kind': 'response', 'payload': McpEndpoint.#ok( { id, 'result': McpEndpoint.toolDescriptor() } ) }
        }

        if( method === 'tools/call' ) {
            const params = ( message[ 'params' ] !== null && typeof message[ 'params' ] === 'object' ) ? message[ 'params' ] : {}

            if( params[ 'name' ] !== McpEndpoint.TOOL_NAME ) {
                return { 'kind': 'response', 'payload': McpEndpoint.#error( { id, 'code': -32602, 'message': `Unknown tool: ${ params[ 'name' ] }` } ) }
            }

            const args = ( params[ 'arguments' ] !== null && typeof params[ 'arguments' ] === 'object' ) ? params[ 'arguments' ] : {}

            try {
                const { result } = await McpEndpoint.waitForAnswer( {
                    'memo': args[ 'memo' ],
                    'transcriptId': args[ 'transcriptId' ],
                    'questionId': args[ 'questionId' ],
                    'timeoutSeconds': args[ 'timeoutSeconds' ],
                    deps
                } )

                return {
                    'kind': 'response',
                    'payload': McpEndpoint.#ok( {
                        id,
                        'result': {
                            'content': [ { 'type': 'text', 'text': JSON.stringify( result, null, 4 ) } ],
                            'structuredContent': result,
                            'isError': result[ 'status' ] !== true
                        }
                    } )
                }
            } catch ( err ) {
                return { 'kind': 'response', 'payload': McpEndpoint.#error( { id, 'code': -32602, 'message': err.message } ) }
            }
        }

        return { 'kind': 'response', 'payload': McpEndpoint.#error( { id, 'code': -32601, 'message': `Method not found: ${ method }` } ) }
    }


    // Does this request want its answer as an event stream? Only a wait_for_answer call does — it is the
    // one message that may stay open for an hour and therefore needs the progress heartbeat. Everything
    // else is answered as ordinary JSON, which keeps every existing client happy.
    static wantsEventStream( { message } ) {
        const isCall = message !== null && typeof message === 'object' && message[ 'method' ] === 'tools/call'
        const params = ( isCall === true && message[ 'params' ] !== null && typeof message[ 'params' ] === 'object' ) ? message[ 'params' ] : {}

        return { 'stream': isCall === true && params[ 'name' ] === McpEndpoint.TOOL_NAME }
    }


    // The progress token the client attached (`params._meta.progressToken`). Absent means: the client
    // does not want progress notifications — the transport then keeps the connection alive with SSE
    // comments instead, so the idle deadline still cannot kill the call.
    static progressToken( { message } ) {
        const params = ( message !== null && typeof message === 'object' && message[ 'params' ] !== null && typeof message[ 'params' ] === 'object' ) ? message[ 'params' ] : {}
        const meta = ( params[ '_meta' ] !== null && typeof params[ '_meta' ] === 'object' ) ? params[ '_meta' ] : {}
        const token = meta[ 'progressToken' ]

        return { 'token': ( typeof token === 'string' || typeof token === 'number' ) ? token : null }
    }


    static progressNotification( { token, tick, elapsedMs } ) {
        return {
            'notification': {
                'jsonrpc': '2.0',
                'method': 'notifications/progress',
                'params': {
                    'progressToken': token,
                    'progress': tick,
                    'message': `still waiting for the "Abschliessen" press — ${ Math.round( elapsedMs / 1000 ) }s`
                }
            }
        }
    }


    static #selectAnswers( { answers, questionId } ) {
        const list = Array.isArray( answers ) ? answers : []

        if( typeof questionId !== 'string' || questionId.length === 0 ) {
            return list
        }

        return list.filter( ( entry ) => entry[ 'questionId' ] === questionId )
    }


    static #ok( { id, result } ) {
        return { 'jsonrpc': '2.0', id, result }
    }


    static #error( { id, code, message } ) {
        return { 'jsonrpc': '2.0', id, 'error': { code, message } }
    }
}


export { McpEndpoint }
