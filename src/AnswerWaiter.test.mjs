import { describe, it, expect, afterEach } from '@jest/globals'

import { AnswerWaiter } from './AnswerWaiter.mjs'


// PRD-V9 (Memo 080, Kap 19 / WI-098, WI-164) — the wait register behind `wait_for_answer`.
// The four properties that decide whether several sessions can share ONE server:
//   A4 three transcripts side by side — one answer serves exactly one of them
//   A5 fan-out — two waiters on the SAME transcript both get served, none is swallowed
//   A7 a timeout settles as a named outcome instead of hanging or throwing
//   A8 the register drains back to 0 — every exit removes its own entry
// Every case names how much it compared.
describe( 'AnswerWaiter — concurrency register (Memo 080, PRD-V9)', () => {
    afterEach( () => {
        AnswerWaiter.resetForTests()
    } )


    it( 'THREE transcripts wait side by side — one answer serves exactly ONE, the other two stay open (3 compared)', async () => {
        const a = AnswerWaiter.register( { 'transcriptId': 'T-a', 'timeoutMs': 5000 } )
        const b = AnswerWaiter.register( { 'transcriptId': 'T-b', 'timeoutMs': 5000 } )
        const c = AnswerWaiter.register( { 'transcriptId': 'T-c', 'timeoutMs': 5000 } )

        expect( AnswerWaiter.size( {} ) ).toEqual( { 'size': 3, 'transcripts': 3 } )

        const served = AnswerWaiter.resolve( { 'transcriptId': 'T-b', 'payload': { 'note': 'button pressed' } } )
        const settled = await b[ 'promise' ]

        expect( served[ 'resolved' ] ).toBe( 1 )
        expect( settled[ 'outcome' ] ).toBe( 'answered' )
        expect( settled[ 'transcriptId' ] ).toBe( 'T-b' )
        expect( settled[ 'payload' ] ).toEqual( { 'note': 'button pressed' } )
        // the other two are untouched — no global latch, no ordering
        expect( AnswerWaiter.size( { 'transcriptId': 'T-a' } )[ 'size' ] ).toBe( 1 )
        expect( AnswerWaiter.size( { 'transcriptId': 'T-c' } )[ 'size' ] ).toBe( 1 )
        expect( AnswerWaiter.size( {} )[ 'size' ] ).toBe( 2 )
        expect( a[ 'waiterId' ] === c[ 'waiterId' ] ).toBe( false )
    } )


    it( 'FAN-OUT: two sessions wait on the SAME transcript and BOTH get the same result (2 compared)', async () => {
        const first = AnswerWaiter.register( { 'transcriptId': 'T-shared', 'timeoutMs': 5000 } )
        const second = AnswerWaiter.register( { 'transcriptId': 'T-shared', 'timeoutMs': 5000 } )

        expect( AnswerWaiter.size( { 'transcriptId': 'T-shared' } )[ 'size' ] ).toBe( 2 )

        const served = AnswerWaiter.resolve( { 'transcriptId': 'T-shared', 'payload': { 'at': '2026-09-05T00:00:00Z' } } )
        const results = await Promise.all( [ first[ 'promise' ], second[ 'promise' ] ] )

        expect( served[ 'resolved' ] ).toBe( 2 )
        expect( results.map( ( entry ) => entry[ 'outcome' ] ) ).toEqual( [ 'answered', 'answered' ] )
        expect( results[ 0 ][ 'payload' ] ).toEqual( results[ 1 ][ 'payload' ] )
        expect( AnswerWaiter.size( {} )[ 'size' ] ).toBe( 0 )
    } )


    it( 'resolving a transcript NOBODY waits on is a measured zero, not an error', () => {
        const served = AnswerWaiter.resolve( { 'transcriptId': 'T-nobody', 'payload': null } )

        expect( served[ 'resolved' ] ).toBe( 0 )
        expect( served[ 'waiterIds' ] ).toEqual( [] )
    } )


    it( 'a TIMEOUT settles as { outcome: timeout } and never rejects (A7)', async () => {
        const waiter = AnswerWaiter.register( { 'transcriptId': 'T-timeout', 'timeoutMs': 20 } )
        const settled = await waiter[ 'promise' ]

        expect( settled[ 'outcome' ] ).toBe( 'timeout' )
        expect( settled[ 'transcriptId' ] ).toBe( 'T-timeout' )
        expect( settled[ 'payload' ] ).toBe( null )
        expect( Number.isFinite( settled[ 'waitedMs' ] ) ).toBe( true )
    } )


    it( 'LEAK PROBE: after 5 timed-out waits the register size is 0 (5 compared, A8)', async () => {
        const waiters = Array.from( { 'length': 5 } )
            .map( ( _, index ) => AnswerWaiter.register( { 'transcriptId': `T-leak-${ index }`, 'timeoutMs': 15 } ) )

        expect( AnswerWaiter.size( {} ) ).toEqual( { 'size': 5, 'transcripts': 5 } )

        const settled = await Promise.all( waiters.map( ( waiter ) => waiter[ 'promise' ] ) )

        expect( settled.map( ( entry ) => entry[ 'outcome' ] ) ).toEqual( [ 'timeout', 'timeout', 'timeout', 'timeout', 'timeout' ] )
        expect( AnswerWaiter.size( {} ) ).toEqual( { 'size': 0, 'transcripts': 0 } )
    } )


    it( 'CANCEL removes exactly its own entry and is idempotent (2 compared, A8)', async () => {
        const kept = AnswerWaiter.register( { 'transcriptId': 'T-kept', 'timeoutMs': 5000 } )
        const dropped = AnswerWaiter.register( { 'transcriptId': 'T-dropped', 'timeoutMs': 5000 } )

        const first = AnswerWaiter.cancel( { 'waiterId': dropped[ 'waiterId' ] } )
        const again = AnswerWaiter.cancel( { 'waiterId': dropped[ 'waiterId' ] } )
        const settled = await dropped[ 'promise' ]

        expect( first[ 'cancelled' ] ).toBe( true )
        expect( again[ 'cancelled' ] ).toBe( false )
        expect( settled[ 'outcome' ] ).toBe( 'cancelled' )
        expect( AnswerWaiter.size( { 'transcriptId': 'T-kept' } )[ 'size' ] ).toBe( 1 )
        expect( AnswerWaiter.openTranscriptIds()[ 'transcriptIds' ] ).toEqual( [ 'T-kept' ] )
        expect( kept[ 'waiterId' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'a resolved waiter is NOT settled a second time by its own timeout (double-settle probe)', async () => {
        const waiter = AnswerWaiter.register( { 'transcriptId': 'T-once', 'timeoutMs': 25 } )
        AnswerWaiter.resolve( { 'transcriptId': 'T-once', 'payload': { 'first': true } } )
        const settled = await waiter[ 'promise' ]

        await new Promise( ( done ) => setTimeout( done, 50 ) )

        expect( settled[ 'outcome' ] ).toBe( 'answered' )
        expect( settled[ 'payload' ] ).toEqual( { 'first': true } )
        expect( AnswerWaiter.size( {} )[ 'size' ] ).toBe( 0 )
    } )


    it( 'fails loud on a missing transcriptId and on a nonsense timeout — no silent default', () => {
        expect( () => AnswerWaiter.register( { 'timeoutMs': 100 } ) ).toThrow( /"transcriptId" is required/ )
        expect( () => AnswerWaiter.register( { 'transcriptId': 'T-x', 'timeoutMs': 0 } ) ).toThrow( /"timeoutMs" must be a positive integer/ )
        expect( () => AnswerWaiter.register( { 'transcriptId': 'T-x', 'timeoutMs': 1.5 } ) ).toThrow( /"timeoutMs" must be a positive integer/ )
        expect( () => AnswerWaiter.resolve( {} ) ).toThrow( /"transcriptId" is required/ )
        expect( () => AnswerWaiter.cancel( {} ) ).toThrow( /"waiterId" is required/ )
        expect( () => AnswerWaiter.size( { 'transcriptId': '' } ) ).toThrow( /must be a non-empty string/ )
    } )
} )
