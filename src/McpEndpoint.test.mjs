import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { McpEndpoint } from './McpEndpoint.mjs'
import { AnswerWaiter } from './AnswerWaiter.mjs'


// PRD-V9 (Memo 080, Kap 19 / WI-098, WI-164) — the tool endpoint of the viewer.
// Assertions covered here: A2 (origin gate, three origins), A3 (mandatory result fields), A6 (progress
// cadence against a FAKE clock — no test sleeps six real minutes), A7 (own ceiling, timeout answer with
// evidencePath), A11 (the answer is re-read from the durable store after the wake), A20 (the tool text
// forbids the sub-agent call WITH its reason).
const evidenceOf = ( { loggedIn, answers } ) => ( {
    'found': true,
    loggedIn,
    answers,
    'evidencePath': '.memo/memos/080-db-vollausbau/memo-080.db#user_input_answers',
    'match': 'sha256',
    'comparedInputs': 7,
    'messages': []
} )


// A fake interval clock: register callbacks, then fire them by hand. `advance` returns how many ticks
// it produced, so a case can COUNT messages instead of believing a comment.
const fakeTimers = () => {
    const state = { 'callbacks': new Map(), 'next': 0, 'cleared': 0 }

    return {
        'timers': {
            'setInterval': ( callback ) => {
                state[ 'next' ] = state[ 'next' ] + 1
                state[ 'callbacks' ].set( state[ 'next' ], callback )

                return state[ 'next' ]
            },
            'clearInterval': ( handle ) => {
                state[ 'cleared' ] = state[ 'cleared' ] + 1
                state[ 'callbacks' ].delete( handle )
            }
        },
        'fire': ( { times } ) => {
            Array.from( { 'length': times } )
                .forEach( () => Array.from( state[ 'callbacks' ].values() ).forEach( ( callback ) => callback() ) )

            return { 'fired': times }
        },
        'state': state
    }
}


describe( 'McpEndpoint.checkOrigin (A2 — DNS-rebinding guard)', () => {
    it( 'admits loopback, refuses a FOREIGN origin and refuses an ABSENT one (5 origins compared)', () => {
        const cases = [
            { 'origin': 'http://127.0.0.1:3333', 'allowed': true, 'reason': null },
            { 'origin': 'http://localhost:3333', 'allowed': true, 'reason': null },
            { 'origin': 'https://evil.example.com', 'allowed': false, 'reason': 'foreign-origin' },
            { 'origin': undefined, 'allowed': false, 'reason': 'missing-origin' },
            { 'origin': '', 'allowed': false, 'reason': 'missing-origin' }
        ]

        const verdicts = cases.map( ( entry ) => McpEndpoint.checkOrigin( { 'origin': entry[ 'origin' ] } ) )

        expect( cases.length ).toBe( 5 )
        expect( verdicts.map( ( entry ) => entry[ 'allowed' ] ) ).toEqual( cases.map( ( entry ) => entry[ 'allowed' ] ) )
        expect( verdicts.map( ( entry ) => entry[ 'reason' ] ) ).toEqual( cases.map( ( entry ) => entry[ 'reason' ] ) )
    } )


    it( 'a host that merely CONTAINS the loopback name is still foreign (rebinding attempt, 4 compared)', () => {
        const origins = [ 'http://127.0.0.1.evil.com', 'http://localhost.evil.com', 'http://evil.com#127.0.0.1', 'http://127.0.0.2:3333' ]
        const verdicts = origins.map( ( origin ) => McpEndpoint.checkOrigin( { origin } )[ 'allowed' ] )

        expect( origins.length ).toBe( 4 )
        expect( verdicts ).toEqual( [ false, false, false, false ] )
    } )
} )


describe( 'McpEndpoint.normalizeTimeoutSeconds (A7 — our ceiling, never the client deadline)', () => {
    it( 'takes the published default when absent and the caller value when usable (4 compared)', () => {
        expect( McpEndpoint.normalizeTimeoutSeconds( {} ) ).toEqual( { 'seconds': 3600, 'source': 'default' } )
        expect( McpEndpoint.normalizeTimeoutSeconds( { 'timeoutSeconds': null } )[ 'seconds' ] ).toBe( 3600 )
        expect( McpEndpoint.normalizeTimeoutSeconds( { 'timeoutSeconds': 120 } ) ).toEqual( { 'seconds': 120, 'source': 'caller' } )
        expect( McpEndpoint.normalizeTimeoutSeconds( { 'timeoutSeconds': 86400 } )[ 'seconds' ] ).toBe( 86400 )
    } )


    it( 'fails loud above the ceiling and on nonsense — never silently bent (3 compared)', () => {
        expect( () => McpEndpoint.normalizeTimeoutSeconds( { 'timeoutSeconds': 86401 } ) ).toThrow( /between 1 and 86400/ )
        expect( () => McpEndpoint.normalizeTimeoutSeconds( { 'timeoutSeconds': 0 } ) ).toThrow( /between 1 and 86400/ )
        expect( () => McpEndpoint.normalizeTimeoutSeconds( { 'timeoutSeconds': 'soon' } ) ).toThrow( /must be an integer/ )
    } )
} )


describe( 'McpEndpoint.buildToolResult (A3 — no field is optional-quiet)', () => {
    it( 'carries all SIX documented fields', () => {
        const { result } = McpEndpoint.buildToolResult( {
            'status': true,
            'transcriptId': 'T-1',
            'answers': [ { 'questionId': 'F12', 'optionKey': 'A', 'answerVerbatim': 'Protokoll-Weg' } ],
            'evidencePath': '.memo/memos/080/memo-080.db#user_input_answers',
            'waitedMs': 742318,
            'reason': null
        } )

        expect( Object.keys( result ).sort() ).toEqual( [ 'answers', 'evidencePath', 'reason', 'status', 'transcriptId', 'waitedMs' ] )
        expect( result[ 'reason' ] ).toBe( null )
        expect( result[ 'answers' ][ 0 ][ 'questionId' ] ).toBe( 'F12' )
    } )


    it( 'a MISSING mandatory field fails loud and names it (5 fields probed)', () => {
        const complete = {
            'status': true,
            'transcriptId': 'T-1',
            'answers': [],
            'evidencePath': 'p#user_input_answers',
            'waitedMs': 1
        }
        const names = [ 'status', 'transcriptId', 'answers', 'evidencePath', 'waitedMs' ]

        const thrown = names
            .map( ( name ) => {
                const broken = { ...complete }
                delete broken[ name ]

                try {
                    McpEndpoint.buildToolResult( broken )

                    return null
                } catch ( err ) {
                    return err.message.includes( name ) ? name : `wrong-message:${ name }`
                }
            } )

        expect( names.length ).toBe( 5 )
        expect( thrown ).toEqual( names )
    } )
} )


describe( 'McpEndpoint.startProgressTicker (A6 — the 60 s heartbeat against the 5 min idle deadline)', () => {
    it( 'produces ONE message per interval over 6 simulated minutes (6 ticks compared)', () => {
        const clock = fakeTimers()
        const seen = []
        const ticker = McpEndpoint.startProgressTicker( {
            'intervalMs': McpEndpoint.PROGRESS_INTERVAL_MS,
            'onTick': ( tick ) => seen.push( tick ),
            'timers': clock[ 'timers' ]
        } )

        clock.fire( { 'times': 6 } )
        const stopped = ticker.stop()

        expect( McpEndpoint.PROGRESS_INTERVAL_MS ).toBe( 60000 )
        expect( seen.length ).toBe( 6 )
        expect( seen.map( ( entry ) => entry[ 'tick' ] ) ).toEqual( [ 1, 2, 3, 4, 5, 6 ] )
        expect( seen[ 5 ][ 'elapsedMs' ] ).toBe( 360000 )
        expect( stopped[ 'ticks' ] ).toBe( 6 )
        expect( clock[ 'state' ][ 'cleared' ] ).toBe( 1 )
    } )


    it( 'stop() is idempotent and silences further ticks', () => {
        const clock = fakeTimers()
        const seen = []
        const ticker = McpEndpoint.startProgressTicker( { 'intervalMs': 1000, 'onTick': () => seen.push( 1 ), 'timers': clock[ 'timers' ] } )

        clock.fire( { 'times': 2 } )
        ticker.stop()
        ticker.stop()

        expect( seen.length ).toBe( 2 )
        expect( clock[ 'state' ][ 'cleared' ] ).toBe( 1 )
    } )


    it( 'fails loud on a nonsense interval and a missing sink', () => {
        expect( () => McpEndpoint.startProgressTicker( { 'intervalMs': 0, 'onTick': () => {} } ) ).toThrow( /positive integer/ )
        expect( () => McpEndpoint.startProgressTicker( { 'intervalMs': 1000 } ) ).toThrow( /"onTick" is required/ )
    } )
} )


describe( 'McpEndpoint.waitForAnswer (A7/A11 — the disk decides, not the delivery)', () => {
    it( 'returns IMMEDIATELY when the button was already pressed — no hour-long nap on a done transcript', async () => {
        const reads = []
        const { result } = await McpEndpoint.waitForAnswer( {
            'memo': '080',
            'transcriptId': 'T-done',
            'deps': {
                'readEvidence': async ( args ) => {
                    reads.push( args )

                    return evidenceOf( { 'loggedIn': true, 'answers': [ { 'questionId': 'F12', 'optionKey': 'A', 'answerVerbatim': 'A' } ] } )
                }
            }
        } )

        expect( reads.length ).toBe( 1 )
        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'reason' ] ).toBe( 'already-answered' )
        expect( result[ 'answers' ].length ).toBe( 1 )
    } )


    it( 'RE-READS the durable store after the wake — the wake payload is never the answer (2 reads compared, A11)', async () => {
        const reads = []
        const registered = { 'waiterId': 'W-test', 'promise': Promise.resolve( { 'outcome': 'answered', 'transcriptId': 'T-x', 'waitedMs': 5, 'payload': { 'answers': [ { 'questionId': 'FAKE' } ] } } ) }

        const { result } = await McpEndpoint.waitForAnswer( {
            'memo': '080',
            'transcriptId': 'T-x',
            'deps': {
                'readEvidence': async () => {
                    reads.push( reads.length )

                    return reads.length === 1
                        ? evidenceOf( { 'loggedIn': false, 'answers': [] } )
                        : evidenceOf( { 'loggedIn': true, 'answers': [ { 'questionId': 'F31', 'optionKey': 'A', 'answerVerbatim': 'ein Server' } ] } )
                },
                'registerWaiter': () => registered,
                'cancelWaiter': () => ( { 'cancelled': true } )
            }
        } )

        expect( reads.length ).toBe( 2 )
        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'answers' ] ).toEqual( [ { 'questionId': 'F31', 'optionKey': 'A', 'answerVerbatim': 'ein Server' } ] )
        expect( result[ 'answers' ].some( ( entry ) => entry[ 'questionId' ] === 'FAKE' ) ).toBe( false )
        expect( result[ 'evidencePath' ] ).toContain( '#user_input_answers' )
    } )


    it( 'a TIMEOUT answers status:false, reason:timeout AND still carries evidencePath (A7)', async () => {
        const { result } = await McpEndpoint.waitForAnswer( {
            'memo': '080',
            'transcriptId': 'T-late',
            'timeoutSeconds': 1,
            'deps': {
                'readEvidence': async () => evidenceOf( { 'loggedIn': false, 'answers': [] } ),
                'registerWaiter': () => ( { 'waiterId': 'W-late', 'promise': Promise.resolve( { 'outcome': 'timeout', 'transcriptId': 'T-late', 'waitedMs': 1000, 'payload': null } ) } ),
                'cancelWaiter': () => ( { 'cancelled': false } )
            }
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'reason' ] ).toBe( 'timeout' )
        expect( result[ 'evidencePath' ] ).toBe( '.memo/memos/080-db-vollausbau/memo-080.db#user_input_answers' )
        expect( result[ 'answers' ] ).toEqual( [] )
    } )


    it( 'an UNKNOWN transcript answers transcript-not-found instead of waiting forever', async () => {
        const { result } = await McpEndpoint.waitForAnswer( {
            'memo': '080',
            'transcriptId': 'T-ghost',
            'deps': { 'readEvidence': async () => ( { 'found': false, 'loggedIn': false, 'answers': [], 'evidencePath': 'memo-080.db#user_input_answers', 'messages': [] } ) }
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'reason' ] ).toBe( 'transcript-not-found' )
    } )


    it( 'questionId narrows the answer set without inventing one (3 answers compared)', async () => {
        const { result } = await McpEndpoint.waitForAnswer( {
            'memo': '080',
            'transcriptId': 'T-pick',
            'questionId': 'F31',
            'deps': {
                'readEvidence': async () => evidenceOf( {
                    'loggedIn': true,
                    'answers': [
                        { 'questionId': 'F12', 'optionKey': 'A', 'answerVerbatim': 'a' },
                        { 'questionId': 'F31', 'optionKey': 'A', 'answerVerbatim': 'b' },
                        { 'questionId': 'F13', 'optionKey': 'C', 'answerVerbatim': 'c' }
                    ]
                } )
            }
        } )

        expect( result[ 'answers' ].length ).toBe( 1 )
        expect( result[ 'answers' ][ 0 ][ 'questionId' ] ).toBe( 'F31' )
    } )


    it( 'cancels its OWN waiter when it leaves — the register drains (A8)', async () => {
        const waiter = AnswerWaiter.register( { 'transcriptId': 'T-drain', 'timeoutMs': 5000 } )
        setTimeout( () => AnswerWaiter.resolve( { 'transcriptId': 'T-drain', 'payload': null } ), 5 )

        await McpEndpoint.waitForAnswer( {
            'memo': '080',
            'transcriptId': 'T-drain',
            'deps': {
                'readEvidence': async () => evidenceOf( { 'loggedIn': false, 'answers': [] } ),
                'registerWaiter': () => waiter,
                'cancelWaiter': ( args ) => AnswerWaiter.cancel( args )
            }
        } )

        expect( AnswerWaiter.size( {} )[ 'size' ] ).toBe( 0 )
    } )


    it( 'fails loud on missing memo / transcriptId / deps — no silent default', async () => {
        await expect( McpEndpoint.waitForAnswer( { 'transcriptId': 'T', 'deps': {} } ) ).rejects.toThrow( /"memo" is required/ )
        await expect( McpEndpoint.waitForAnswer( { 'memo': '080', 'deps': {} } ) ).rejects.toThrow( /"transcriptId" is required/ )
        await expect( McpEndpoint.waitForAnswer( { 'memo': '080', 'transcriptId': 'T' } ) ).rejects.toThrow( /"deps" is required/ )
        await expect( McpEndpoint.waitForAnswer( { 'memo': '080', 'transcriptId': 'T', 'deps': {} } ) ).rejects.toThrow( /"deps.readEvidence" is required/ )
    } )
} )


describe( 'McpEndpoint.handleMessage (JSON-RPC surface)', () => {
    const deps = { 'readEvidence': async () => evidenceOf( { 'loggedIn': true, 'answers': [ { 'questionId': 'F12', 'optionKey': 'A', 'answerVerbatim': 'A' } ] } ) }


    it( 'answers initialize, ping and tools/list, and ACCEPTS a notification without a body (4 messages compared)', async () => {
        const init = await McpEndpoint.handleMessage( { 'message': { 'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': { 'protocolVersion': '2025-06-18' } }, deps } )
        const ping = await McpEndpoint.handleMessage( { 'message': { 'jsonrpc': '2.0', 'id': 2, 'method': 'ping' }, deps } )
        const list = await McpEndpoint.handleMessage( { 'message': { 'jsonrpc': '2.0', 'id': 3, 'method': 'tools/list' }, deps } )
        const note = await McpEndpoint.handleMessage( { 'message': { 'jsonrpc': '2.0', 'method': 'notifications/initialized' }, deps } )

        expect( init[ 'payload' ][ 'result' ][ 'protocolVersion' ] ).toBe( '2025-06-18' )
        expect( init[ 'payload' ][ 'result' ][ 'serverInfo' ][ 'name' ] ).toBe( 'memo-view' )
        expect( ping[ 'payload' ][ 'result' ] ).toEqual( {} )
        expect( list[ 'payload' ][ 'result' ][ 'tools' ].length ).toBe( 1 )
        expect( list[ 'payload' ][ 'result' ][ 'tools' ][ 0 ][ 'name' ] ).toBe( 'wait_for_answer' )
        expect( note[ 'kind' ] ).toBe( 'accepted' )
    } )


    it( 'an UNKNOWN protocol version is answered with ours AND the negotiation is named (2 compared)', () => {
        expect( McpEndpoint.negotiateProtocolVersion( { 'requested': '2025-03-26' } ) ).toEqual( { 'protocolVersion': '2025-03-26', 'negotiated': 'echoed' } )
        expect( McpEndpoint.negotiateProtocolVersion( { 'requested': '1999-01-01' } ) ).toEqual( { 'protocolVersion': McpEndpoint.PROTOCOL_VERSION, 'negotiated': 'server-newest' } )
    } )


    it( 'a tools/call delivers the structured result AND the text mirror', async () => {
        const call = await McpEndpoint.handleMessage( {
            'message': { 'jsonrpc': '2.0', 'id': 9, 'method': 'tools/call', 'params': { 'name': 'wait_for_answer', 'arguments': { 'memo': '080', 'transcriptId': 'T-1' } } },
            deps
        } )

        const structured = call[ 'payload' ][ 'result' ][ 'structuredContent' ]

        expect( structured[ 'status' ] ).toBe( true )
        expect( structured[ 'transcriptId' ] ).toBe( 'T-1' )
        expect( call[ 'payload' ][ 'result' ][ 'isError' ] ).toBe( false )
        expect( JSON.parse( call[ 'payload' ][ 'result' ][ 'content' ][ 0 ][ 'text' ] ) ).toEqual( structured )
    } )


    it( 'refuses an unknown tool, an unknown method and a broken message (3 error codes compared)', async () => {
        const unknownTool = await McpEndpoint.handleMessage( { 'message': { 'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': { 'name': 'rm_rf' } }, deps } )
        const unknownMethod = await McpEndpoint.handleMessage( { 'message': { 'jsonrpc': '2.0', 'id': 2, 'method': 'resources/list' }, deps } )
        const broken = await McpEndpoint.handleMessage( { 'message': 'not an object', deps } )

        expect( unknownTool[ 'payload' ][ 'error' ][ 'code' ] ).toBe( -32602 )
        expect( unknownMethod[ 'payload' ][ 'error' ][ 'code' ] ).toBe( -32601 )
        expect( broken[ 'payload' ][ 'error' ][ 'code' ] ).toBe( -32700 )
    } )


    it( 'ONLY a wait_for_answer call wants the event stream (3 messages compared)', () => {
        expect( McpEndpoint.wantsEventStream( { 'message': { 'method': 'tools/call', 'params': { 'name': 'wait_for_answer' } } } )[ 'stream' ] ).toBe( true )
        expect( McpEndpoint.wantsEventStream( { 'message': { 'method': 'tools/list' } } )[ 'stream' ] ).toBe( false )
        expect( McpEndpoint.wantsEventStream( { 'message': { 'method': 'tools/call', 'params': { 'name': 'other' } } } )[ 'stream' ] ).toBe( false )
    } )


    it( 'reads the progress token off _meta and reports null when the client sent none (3 compared)', () => {
        expect( McpEndpoint.progressToken( { 'message': { 'params': { '_meta': { 'progressToken': 'p-1' } } } } )[ 'token' ] ).toBe( 'p-1' )
        expect( McpEndpoint.progressToken( { 'message': { 'params': { '_meta': { 'progressToken': 7 } } } } )[ 'token' ] ).toBe( 7 )
        expect( McpEndpoint.progressToken( { 'message': { 'params': {} } } )[ 'token' ] ).toBe( null )
    } )


    it( 'the progress notification is a valid JSON-RPC notification carrying the token', () => {
        const { notification } = McpEndpoint.progressNotification( { 'token': 'p-1', 'tick': 3, 'elapsedMs': 180000 } )

        expect( notification[ 'jsonrpc' ] ).toBe( '2.0' )
        expect( notification[ 'method' ] ).toBe( 'notifications/progress' )
        expect( notification[ 'params' ][ 'progressToken' ] ).toBe( 'p-1' )
        expect( notification[ 'params' ][ 'progress' ] ).toBe( 3 )
        expect( notification[ 'id' ] ).toBe( undefined )
    } )


    it( 'the endpoint path matcher ignores a query string and refuses look-alikes (4 urls compared)', () => {
        const urls = [ '/mcp', '/mcp?x=1', '/mcp/extra', '/api/mcp' ]
        const verdicts = urls.map( ( url ) => McpEndpoint.isEndpointUrl( { url } )[ 'matches' ] )

        expect( urls.length ).toBe( 4 )
        expect( verdicts ).toEqual( [ true, true, false, false ] )
    } )
} )


describe( 'McpEndpoint tool text (A20 — the sub-agent ban travels WITH its reason)', () => {
    it( 'the tool description forbids the sub-agent call, names the reason and orders the disk read', () => {
        const description = McpEndpoint.toolDescriptor()[ 'tools' ][ 0 ][ 'description' ]

        expect( description ).toMatch( /ORCHESTRATOR session only/ )
        expect( description ).toMatch( /sub-agent gets no automatic backgrounding/ )
        expect( description ).toMatch( /READ THE DISK/ )
    } )


    it( 'the module carries NO for/while loop — Node baseline (source scan)', () => {
        const source = readFileSync( resolve( import.meta.dirname, 'McpEndpoint.mjs' ), 'utf-8' )

        expect( source.length ).toBeGreaterThan( 1000 )
        expect( /\bfor\s*\(/.test( source ) ).toBe( false )
        expect( /\bwhile\s*\(/.test( source ) ).toBe( false )
    } )
} )
