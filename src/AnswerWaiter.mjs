// AnswerWaiter.mjs — the wait register behind the long-running `wait_for_answer` tool
// (Memo 080, Kap 19, PRD-V9, WI-098/WI-164).
//
// WHY IT EXISTS: the viewer already pushes a wake FLAG when the user presses "Abschliessen"
// (MemoView login route). A flag is a file — the waiting session has to notice it and then go and
// read. This register is the second delivery road on the SAME button press: a session that holds an
// open tool call gets the answer handed back IN the tool result, with zero extra turns.
//
// THE ONE RULE THAT SHAPES IT (WI-164): several sessions wait AT THE SAME TIME. So there is no
// global latch and no ordering — the register is a Map `transcriptId -> Set<waiter>`:
//   * resolve() serves EVERY waiter of that transcript (fan-out, A5) and ONLY those (A4).
//   * a timeout or a dropped connection removes its OWN entry, so the register drains back to 0
//     (A8) — a wait register that only grows is a leak with a nice name.
//
// The register is deliberately NOT the truth. It is the accelerator. The durable answer lives in
// `user_input_answers` in the per-memo database and in the transcript file on disk; the tool result
// carries a pointer to it (A11). A missed notification loses speed, never the answer.
//
// Class architecture per node-class-architecture: static entry points, object parameter, object
// return, private-by-default, NO SILENT DEFAULTS — every missing required argument fails loud.

class AnswerWaiter {
    // transcriptId -> Set<entry>. `entry` carries { waiterId, resolveFn, timer, startedAt }.
    static #byTranscript = new Map()

    // waiterId -> transcriptId, so cancel()/the timeout path find their bucket without scanning.
    static #byWaiterId = new Map()

    // Monotonic id source. A waiter id is never reused inside a process life, so a late timer for an
    // already-resolved waiter can never hit a younger waiter's entry.
    static #sequence = 0


    // Register ONE waiting call. Returns the waiterId (the handle for cancel) and the promise the
    // caller awaits. The promise NEVER rejects — it settles as
    //   { outcome: 'answered', transcriptId, waitedMs, payload }   (resolve() reached it)
    //   { outcome: 'timeout',  transcriptId, waitedMs, payload: null }
    //   { outcome: 'cancelled', transcriptId, waitedMs, payload: null }
    // A rejecting waiter would turn a normal timeout into a 500; the caller must be able to answer
    // "no answer yet, here is where to look" instead (A7).
    //
    // The timeout timer is unref'd: an open wait must not keep the process alive on its own. The
    // socket the caller holds does that, and it is the honest owner of that lifetime.
    static register( { transcriptId, timeoutMs, now } ) {
        AnswerWaiter.#validationRegister( { transcriptId, timeoutMs } )

        const startedAt = typeof now === 'number' ? now : Date.now()
        AnswerWaiter.#sequence = AnswerWaiter.#sequence + 1
        const waiterId = `W-${ AnswerWaiter.#sequence }`

        const entry = { waiterId, transcriptId, startedAt, 'resolveFn': null, 'timer': null }

        const promise = new Promise( ( resolvePromise ) => {
            entry[ 'resolveFn' ] = resolvePromise
        } )

        const timer = setTimeout( () => {
            AnswerWaiter.#settle( { waiterId, 'outcome': 'timeout', 'payload': null } )
        }, timeoutMs )

        if( typeof timer.unref === 'function' ) { timer.unref() }

        entry[ 'timer' ] = timer

        const bucket = AnswerWaiter.#byTranscript.has( transcriptId ) ? AnswerWaiter.#byTranscript.get( transcriptId ) : new Set()
        bucket.add( entry )
        AnswerWaiter.#byTranscript.set( transcriptId, bucket )
        AnswerWaiter.#byWaiterId.set( waiterId, entry )

        return { 'status': true, waiterId, promise }
    }


    // Serve EVERY waiter of this transcript and only those. `resolved` is the count — the caller
    // publishes it, so "nobody was waiting" is a measured zero and never an implied success.
    static resolve( { transcriptId, payload } ) {
        if( typeof transcriptId !== 'string' || transcriptId.length === 0 ) {
            throw new Error( 'AnswerWaiter.resolve: "transcriptId" is required (non-empty string)' )
        }

        const bucket = AnswerWaiter.#byTranscript.has( transcriptId ) ? AnswerWaiter.#byTranscript.get( transcriptId ) : new Set()
        const waiterIds = Array.from( bucket ).map( ( entry ) => entry[ 'waiterId' ] )

        const served = waiterIds
            .map( ( waiterId ) => AnswerWaiter.#settle( { waiterId, 'outcome': 'answered', payload } ) )
            .filter( ( result ) => result[ 'settled' ] === true )

        return { 'status': true, 'resolved': served.length, waiterIds }
    }


    // Drop ONE waiter (the caller's connection went away). Idempotent: cancelling an already settled
    // waiter answers `cancelled: false` instead of throwing — a peer that disconnects right after the
    // answer arrived is normal operation, not a fault.
    static cancel( { waiterId } ) {
        if( typeof waiterId !== 'string' || waiterId.length === 0 ) {
            throw new Error( 'AnswerWaiter.cancel: "waiterId" is required (non-empty string)' )
        }

        const result = AnswerWaiter.#settle( { waiterId, 'outcome': 'cancelled', 'payload': null } )

        return { 'cancelled': result[ 'settled' ] }
    }


    // How many waiters are open — for ONE transcript when `transcriptId` is given, otherwise over the
    // whole register. This is the leak probe of A8 and it always states what it counted.
    static size( { transcriptId } ) {
        if( transcriptId === undefined || transcriptId === null ) {
            const total = Array.from( AnswerWaiter.#byTranscript.values() )
                .reduce( ( sum, bucket ) => sum + bucket.size, 0 )

            return { 'size': total, 'transcripts': AnswerWaiter.#byTranscript.size }
        }

        if( typeof transcriptId !== 'string' || transcriptId.length === 0 ) {
            throw new Error( 'AnswerWaiter.size: "transcriptId" must be a non-empty string when given' )
        }

        const bucket = AnswerWaiter.#byTranscript.has( transcriptId ) ? AnswerWaiter.#byTranscript.get( transcriptId ) : new Set()

        return { 'size': bucket.size, 'transcripts': AnswerWaiter.#byTranscript.size }
    }


    // The open transcript ids — the server's own answer to "who is waiting on me right now".
    static openTranscriptIds() {
        return { 'transcriptIds': Array.from( AnswerWaiter.#byTranscript.keys() ) }
    }


    // Test seam ONLY: drop every open waiter (they settle as 'cancelled'). Production never calls
    // this — a shared server must not be able to clear foreign sessions' waits.
    static resetForTests() {
        const waiterIds = Array.from( AnswerWaiter.#byWaiterId.keys() )
        waiterIds.forEach( ( waiterId ) => AnswerWaiter.#settle( { waiterId, 'outcome': 'cancelled', 'payload': null } ) )

        return { 'cleared': waiterIds.length }
    }


    // The ONE exit of a waiter: clear the timer, remove it from both indices, settle the promise.
    // Every path (answer, timeout, cancel) runs through here, so there is exactly one place that can
    // leave an entry behind — and it does not.
    static #settle( { waiterId, outcome, payload } ) {
        if( AnswerWaiter.#byWaiterId.has( waiterId ) !== true ) {
            return { 'settled': false }
        }

        const entry = AnswerWaiter.#byWaiterId.get( waiterId )
        AnswerWaiter.#byWaiterId.delete( waiterId )

        const bucket = AnswerWaiter.#byTranscript.get( entry[ 'transcriptId' ] )

        if( bucket !== undefined ) {
            bucket.delete( entry )

            if( bucket.size === 0 ) {
                AnswerWaiter.#byTranscript.delete( entry[ 'transcriptId' ] )
            }
        }

        clearTimeout( entry[ 'timer' ] )

        const waitedMs = Date.now() - entry[ 'startedAt' ]
        entry[ 'resolveFn' ]( {
            outcome,
            'transcriptId': entry[ 'transcriptId' ],
            waitedMs,
            'payload': payload === undefined ? null : payload
        } )

        return { 'settled': true }
    }


    static #validationRegister( { transcriptId, timeoutMs } ) {
        if( typeof transcriptId !== 'string' || transcriptId.length === 0 ) {
            throw new Error( 'AnswerWaiter.register: "transcriptId" is required (non-empty string)' )
        }
        if( Number.isInteger( timeoutMs ) !== true || timeoutMs <= 0 ) {
            throw new Error( `AnswerWaiter.register: "timeoutMs" must be a positive integer — got "${ timeoutMs }"` )
        }
    }
}


export { AnswerWaiter }
