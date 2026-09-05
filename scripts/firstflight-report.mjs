// firstflight-report.mjs — the measuring instrument of the first flight (Memo 080, Kap 19, PRD-V9,
// A15-A19).
//
// WHY IT EXISTS: the long-poll answer road is UNFLOWN here. Every deadline in the design comes from
// foreign documentation. So the first flight is a measurement with a comparison set fixed BEFORE the
// run — and this script is the thing that states how much it compared. A run that compared nothing is
// RED, never green (lesson deterministic-gates-can-be-vacuum-green).
//
// THREE COUNTERS, EACH WITH ITS OWN SOURCE (A16/A18) — they are never merged:
//   * comparedCount   — how many of the planned events the protocol actually carries
//   * diskCount       — for how many events the DURABLE store carries answer rows bound to that
//                       transcript (read here, out of the database — not from the protocol's claim)
//   * deliveredCount  — for how many events the tool RESULT reached the waiting session
// `deliveredCount < diskCount` is not a blemish, it is the verdict: the write road works, the delivery
// road does not — exactly the finding of 2026-08-31/09-01, when 75 agents wrote their file and their
// return text still did not arrive.
//
// Usage:
//   node scripts/firstflight-report.mjs --protocol <protocol.json> [--json]
// Exit 0 = PASS · 1 = FAIL · 2 = nothing compared (no comparison basis, red) · 3 = call error.

import { existsSync, readFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DoltDbAssembler } from '../src/DoltDbAssembler.mjs'


// The four deadlines the design hangs on. Every one of them is answered by the flight with yes/no PLUS
// our own measured value — the foreign figure stays beside it, it is never replaced or smoothed.
const DEADLINES = [
    { 'key': 'autoBackground', 'label': 'auto-backgrounding above 2 min', 'documented': '> 2 min (client >= 2.1.212)' },
    { 'key': 'idleSurvival', 'label': 'call survives > 5 min idle', 'documented': '5 min HTTP idle deadline' },
    { 'key': 'progressMessages', 'label': 'progress messages sent', 'documented': '1 per 60 s while open' },
    { 'key': 'latency', 'label': 'press -> return latency', 'documented': 'no documented figure' }
]


class FirstFlightReport {
    static DEADLINES = DEADLINES


    static parseArgs( { argv } ) {
        const list = Array.isArray( argv ) ? argv : []
        const at = list.indexOf( '--protocol' )
        const protocol = at === -1 ? null : list[ at + 1 ]

        return {
            'protocol': ( typeof protocol === 'string' && protocol.length > 0 ) ? protocol : null,
            'asJson': list.includes( '--json' )
        }
    }


    // The PURE core: counters and verdict out of the protocol plus the independently read disk hits.
    // `diskHits` is a map transcriptId -> number of durable answer rows; it is measured by readDisk, NOT
    // taken from the protocol, so a protocol that lies about the store cannot turn this green.
    static evaluate( { expected, events, diskHits } ) {
        if( Number.isInteger( expected ) !== true || expected < 1 ) {
            throw new Error( `FirstFlightReport.evaluate: "expected" must be a positive integer — got "${ expected }"` )
        }
        if( Array.isArray( events ) !== true ) {
            throw new Error( 'FirstFlightReport.evaluate: "events" is required (array)' )
        }
        if( diskHits === null || typeof diskHits !== 'object' ) {
            throw new Error( 'FirstFlightReport.evaluate: "diskHits" is required (object transcriptId -> answer rows)' )
        }

        const comparedCount = events.length
        const diskCount = events
            .filter( ( event ) => Number( diskHits[ event[ 'transcriptId' ] ] ) > 0 )
            .length
        const deliveredCount = events
            .filter( ( event ) => event[ 'delivered' ] === true )
            .length
        const missing = events.length < expected
            ? Array.from( { 'length': expected - events.length } ).map( ( _, index ) => `event ${ events.length + index + 1 } of ${ expected } never recorded` )
            : []

        const findings = []

        if( comparedCount === 0 ) {
            findings.push( { 'code': 'VACUUM', 'text': 'comparedCount === 0 — nothing was compared, the flight did not take place' } )
        }
        if( comparedCount > 0 && comparedCount < expected ) {
            findings.push( { 'code': 'INCOMPLETE', 'text': `comparedCount ${ comparedCount } < ${ expected }: ${ missing.join( '; ' ) }` } )
        }
        if( comparedCount > 0 && diskCount < expected ) {
            findings.push( { 'code': 'WRITE-PATH', 'text': `diskCount ${ diskCount } < ${ expected } — the press does not reach the durable store` } )
        }
        if( comparedCount > 0 && deliveredCount < diskCount ) {
            findings.push( { 'code': 'DELIVERY-PATH', 'text': `deliveredCount ${ deliveredCount } < diskCount ${ diskCount } — the delivery road is defective; the tool is an accelerator, the file road stays leading` } )
        }

        const verdict = comparedCount === 0
            ? 'FAIL-VACUUM'
            : ( findings.length === 0 ? 'PASS' : 'FAIL' )

        return { expected, comparedCount, diskCount, deliveredCount, verdict, findings, missing }
    }


    // Read the DISK side of the flight, independently of what the protocol claims (A18):
    //   * answer rows bound to the transcript (payload fingerprint -> user_inputs -> user_input_answers)
    //   * the `.loggedin` sidecar mtime — the instant of the press
    // A missing file or a missing database is recorded as 0 WITH its reason; it is never skipped.
    static readDisk( { events } ) {
        const struct = { 'diskHits': {}, 'pressedAt': {}, 'messages': [] }

        events
            .forEach( ( event ) => {
                const transcriptId = event[ 'transcriptId' ]
                struct[ 'diskHits' ][ transcriptId ] = 0
                struct[ 'pressedAt' ][ transcriptId ] = null

                const markerPath = event[ 'loginMarkerPath' ]

                if( typeof markerPath === 'string' && existsSync( markerPath ) === true ) {
                    struct[ 'pressedAt' ][ transcriptId ] = statSync( markerPath ).mtime.toISOString()
                } else {
                    struct[ 'messages' ].push( `no .loggedin sidecar for ${ transcriptId } — the press instant is unknown` )
                }

                const dbPath = event[ 'dbPath' ]
                const transcriptPath = event[ 'transcriptPath' ]

                if( typeof dbPath !== 'string' || existsSync( dbPath ) !== true ) {
                    struct[ 'messages' ].push( `no database for ${ transcriptId } — 0 answer rows counted` )

                    return
                }
                if( typeof transcriptPath !== 'string' || existsSync( transcriptPath ) !== true ) {
                    struct[ 'messages' ].push( `no transcript file for ${ transcriptId } — 0 answer rows counted` )

                    return
                }

                try {
                    const read = DoltDbAssembler.readAnswersForPayload( { dbPath, 'payload': readFileSync( transcriptPath, 'utf-8' ) } )
                    struct[ 'diskHits' ][ transcriptId ] = read[ 'answers' ].length
                } catch ( err ) {
                    struct[ 'messages' ].push( `reading the answer store for ${ transcriptId } failed: ${ err.message }` )
                }
            } )

        return struct
    }


    // The four deadlines, one line each, ALSO when they miss the expectation (A17). A deadline the flight
    // could not exercise is reported as 'not flown' WITH its name — never as met.
    static deadlineRows( { events, deadlines } ) {
        const measured = ( deadlines !== null && typeof deadlines === 'object' ) ? deadlines : {}

        const rows = DEADLINES
            .map( ( entry ) => {
                const value = measured[ entry[ 'key' ] ]

                if( value === undefined || value === null ) {
                    return { 'label': entry[ 'label' ], 'documented': entry[ 'documented' ], 'answer': 'not flown', 'measured': '—' }
                }

                return {
                    'label': entry[ 'label' ],
                    'documented': entry[ 'documented' ],
                    'answer': value[ 'held' ] === true ? 'yes' : ( value[ 'held' ] === false ? 'no' : 'not flown' ),
                    'measured': typeof value[ 'measured' ] === 'string' ? value[ 'measured' ] : String( value[ 'measured' ] )
                }
            } )

        const perEvent = events
            .map( ( event ) => ( {
                'transcriptId': event[ 'transcriptId' ],
                'session': event[ 'session' ],
                'latencyMs': Number.isFinite( event[ 'latencyMs' ] ) ? event[ 'latencyMs' ] : null,
                'progressMessages': Number.isFinite( event[ 'progressMessages' ] ) ? event[ 'progressMessages' ] : null,
                'delivered': event[ 'delivered' ] === true
            } ) )

        return { rows, perEvent }
    }


    static render( { report, deadlines, perEvent, diskMessages } ) {
        const head = [
            '',
            '  FIRST FLIGHT — memo-view wait_for_answer (Memo 080, PRD-V9)',
            '  ────────────────────────────────────────────────────────────',
            `  comparedCount   ${ report[ 'comparedCount' ] } of ${ report[ 'expected' ] }   (source: first-flight protocol)`,
            `  diskCount       ${ report[ 'diskCount' ] } of ${ report[ 'expected' ] }   (source: user_input_answers, read here)`,
            `  deliveredCount  ${ report[ 'deliveredCount' ] } of ${ report[ 'expected' ] }   (source: tool result recorded by the waiting session)`,
            ''
        ]

        const deadlineLines = [ '  DEADLINES — our figure beside the documented one', '' ]
            .concat( deadlines.map( ( row ) => `  ${ row[ 'answer' ].padEnd( 10 ) } ${ row[ 'label' ].padEnd( 34 ) } doc: ${ row[ 'documented' ].padEnd( 28 ) } ours: ${ row[ 'measured' ] }` ) )
            .concat( [ '' ] )

        const eventLines = [ '  PER EVENT', '' ]
            .concat( perEvent.map( ( row ) => `  ${ row[ 'delivered' ] === true ? 'delivered' : 'MISSING  ' } session ${ String( row[ 'session' ] ).padEnd( 3 ) } latency ${ row[ 'latencyMs' ] === null ? '—' : `${ row[ 'latencyMs' ] } ms` }   progress ${ row[ 'progressMessages' ] === null ? '—' : row[ 'progressMessages' ] }   ${ row[ 'transcriptId' ] }` ) )
            .concat( [ '' ] )

        const findingLines = report[ 'findings' ].length === 0
            ? [ '  no findings' ]
            : report[ 'findings' ].map( ( finding ) => `  ${ finding[ 'code' ] }: ${ finding[ 'text' ] }` )

        const noteLines = diskMessages.length === 0
            ? []
            : [ '', '  disk notes' ].concat( diskMessages.map( ( message ) => `  - ${ message }` ) )

        return {
            'text': head
                .concat( deadlineLines )
                .concat( eventLines )
                .concat( findingLines )
                .concat( noteLines )
                .concat( [ '', `  VERDICT ${ report[ 'verdict' ] }`, '' ] )
                .join( '\n' )
        }
    }


    static run( { argv } ) {
        const { protocol, asJson } = FirstFlightReport.parseArgs( { argv } )

        if( protocol === null ) {
            return { 'exitCode': 3, 'text': 'firstflight-report: --protocol <protocol.json> is required' }
        }

        const protocolPath = resolve( process.cwd(), protocol )

        if( existsSync( protocolPath ) !== true ) {
            return { 'exitCode': 3, 'text': `firstflight-report: protocol not found: ${ protocolPath }` }
        }

        const parsed = JSON.parse( readFileSync( protocolPath, 'utf-8' ) )
        const events = Array.isArray( parsed[ 'events' ] ) ? parsed[ 'events' ] : []
        const expected = Number.isInteger( parsed[ 'plannedEvents' ] ) ? parsed[ 'plannedEvents' ] : 5
        const disk = FirstFlightReport.readDisk( { events } )
        const report = FirstFlightReport.evaluate( { expected, events, 'diskHits': disk[ 'diskHits' ] } )
        const { rows, perEvent } = FirstFlightReport.deadlineRows( { events, 'deadlines': parsed[ 'deadlines' ] } )
        const { text } = FirstFlightReport.render( { report, 'deadlines': rows, perEvent, 'diskMessages': disk[ 'messages' ] } )

        const exitCode = report[ 'verdict' ] === 'PASS' ? 0 : ( report[ 'verdict' ] === 'FAIL-VACUUM' ? 2 : 1 )

        return {
            exitCode,
            'text': asJson === true ? JSON.stringify( { report, 'deadlines': rows, perEvent, 'pressedAt': disk[ 'pressedAt' ] }, null, 4 ) : text
        }
    }
}


const invokedDirectly = process.argv[ 1 ] !== undefined
    && import.meta.url === pathToFileURL( process.argv[ 1 ] ).href

if( invokedDirectly === true ) {
    const { exitCode, text } = FirstFlightReport.run( { 'argv': process.argv.slice( 2 ) } )
    process.stdout.write( `${ text }\n` )
    process.exit( exitCode )
}


export { FirstFlightReport }
