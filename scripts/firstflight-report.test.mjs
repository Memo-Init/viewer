import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { DatabaseSync } from '@dolthub/doltlite'

import { FirstFlightReport } from './firstflight-report.mjs'


// PRD-V9 (Memo 080, Kap 19 / A15-A17) — the measuring instrument of the first flight, tested against
// templates: the complete run (5/5/5), the DELIVERY GAP (5/5/2) and the vacuum (0 => FAIL). The gap case
// is the one that matters: it is the shape of the finding of 2026-08-31/09-01, and the script has to name
// it as a defective delivery road instead of rounding it away.
const eventTemplate = ( { index, delivered } ) => ( {
    'transcriptId': `T-${ index }`,
    'session': index < 4 ? 'A' : 'B',
    'delivered': delivered,
    'latencyMs': 120 + index,
    'progressMessages': index === 3 ? 6 : 0
} )


describe( 'FirstFlightReport.evaluate — the three counters and their verdict', () => {
    it( 'a COMPLETE run is 5/5/5 and PASS (5 events compared)', () => {
        const events = Array.from( { 'length': 5 } ).map( ( _, index ) => eventTemplate( { 'index': index + 1, 'delivered': true } ) )
        const diskHits = { 'T-1': 2, 'T-2': 1, 'T-3': 3, 'T-4': 1, 'T-5': 1 }

        const report = FirstFlightReport.evaluate( { 'expected': 5, events, diskHits } )

        expect( report[ 'comparedCount' ] ).toBe( 5 )
        expect( report[ 'diskCount' ] ).toBe( 5 )
        expect( report[ 'deliveredCount' ] ).toBe( 5 )
        expect( report[ 'findings' ] ).toEqual( [] )
        expect( report[ 'verdict' ] ).toBe( 'PASS' )
    } )


    it( 'the DELIVERY GAP 5/5/2 is FAIL and names the delivery road, not the write road (5 compared)', () => {
        const events = Array.from( { 'length': 5 } ).map( ( _, index ) => eventTemplate( { 'index': index + 1, 'delivered': index < 2 } ) )
        const diskHits = { 'T-1': 1, 'T-2': 1, 'T-3': 1, 'T-4': 1, 'T-5': 1 }

        const report = FirstFlightReport.evaluate( { 'expected': 5, events, diskHits } )

        expect( report[ 'comparedCount' ] ).toBe( 5 )
        expect( report[ 'diskCount' ] ).toBe( 5 )
        expect( report[ 'deliveredCount' ] ).toBe( 2 )
        expect( report[ 'verdict' ] ).toBe( 'FAIL' )
        expect( report[ 'findings' ].map( ( finding ) => finding[ 'code' ] ) ).toEqual( [ 'DELIVERY-PATH' ] )
        expect( report[ 'findings' ][ 0 ][ 'text' ] ).toMatch( /file road stays leading/ )
    } )


    it( 'the VACUUM case (0 events) is FAIL-VACUUM — never a silent green', () => {
        const report = FirstFlightReport.evaluate( { 'expected': 5, 'events': [], 'diskHits': {} } )

        expect( report[ 'comparedCount' ] ).toBe( 0 )
        expect( report[ 'verdict' ] ).toBe( 'FAIL-VACUUM' )
        expect( report[ 'findings' ].map( ( finding ) => finding[ 'code' ] ) ).toEqual( [ 'VACUUM' ] )
    } )


    it( 'an INCOMPLETE run names the missing events by number (3 of 5 compared)', () => {
        const events = Array.from( { 'length': 3 } ).map( ( _, index ) => eventTemplate( { 'index': index + 1, 'delivered': true } ) )
        const diskHits = { 'T-1': 1, 'T-2': 1, 'T-3': 1 }

        const report = FirstFlightReport.evaluate( { 'expected': 5, events, diskHits } )

        expect( report[ 'comparedCount' ] ).toBe( 3 )
        expect( report[ 'missing' ] ).toEqual( [ 'event 4 of 5 never recorded', 'event 5 of 5 never recorded' ] )
        expect( report[ 'findings' ].map( ( finding ) => finding[ 'code' ] ) ).toEqual( [ 'INCOMPLETE', 'WRITE-PATH' ] )
        expect( report[ 'verdict' ] ).toBe( 'FAIL' )
    } )


    it( 'a WRITE-PATH gap (5/3/3) is reported apart from the delivery road (5 compared)', () => {
        const events = Array.from( { 'length': 5 } ).map( ( _, index ) => eventTemplate( { 'index': index + 1, 'delivered': index < 3 } ) )
        const diskHits = { 'T-1': 1, 'T-2': 1, 'T-3': 1, 'T-4': 0, 'T-5': 0 }

        const report = FirstFlightReport.evaluate( { 'expected': 5, events, diskHits } )

        expect( report[ 'diskCount' ] ).toBe( 3 )
        expect( report[ 'deliveredCount' ] ).toBe( 3 )
        expect( report[ 'findings' ].map( ( finding ) => finding[ 'code' ] ) ).toEqual( [ 'WRITE-PATH' ] )
    } )


    it( 'fails loud on a nonsense comparison set — no invented expectation', () => {
        expect( () => FirstFlightReport.evaluate( { 'expected': 0, 'events': [], 'diskHits': {} } ) ).toThrow( /positive integer/ )
        expect( () => FirstFlightReport.evaluate( { 'expected': 5, 'diskHits': {} } ) ).toThrow( /"events" is required/ )
        expect( () => FirstFlightReport.evaluate( { 'expected': 5, 'events': [] } ) ).toThrow( /"diskHits" is required/ )
    } )
} )


describe( 'FirstFlightReport.deadlineRows — all four, also when they miss (A17)', () => {
    it( 'reports a MISSED deadline as "no" and an unflown one as "not flown" (4 deadlines compared)', () => {
        const { rows } = FirstFlightReport.deadlineRows( {
            'events': [],
            'deadlines': {
                'idleSurvival': { 'held': true, 'measured': '372 s open, call alive' },
                'progressMessages': { 'held': true, 'measured': '6' },
                'latency': { 'held': false, 'measured': '4200 ms worst case' }
            }
        } )

        expect( rows.length ).toBe( 4 )
        expect( rows.map( ( row ) => row[ 'answer' ] ) ).toEqual( [ 'not flown', 'yes', 'yes', 'no' ] )
        expect( rows[ 0 ][ 'documented' ] ).toMatch( /2 min/ )
        expect( rows[ 3 ][ 'measured' ] ).toBe( '4200 ms worst case' )
    } )
} )


describe( 'FirstFlightReport.readDisk — the counters are read here, not believed (A18)', () => {
    let root = ''
    let dbPath = ''
    let transcriptPath = ''
    const body = '# REV-18 review\n\n## Antwort auf F12\nA\n'


    beforeAll( async () => {
        await mkdir( join( process.cwd(), '.test-tmp' ), { 'recursive': true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'firstflight-' ) )
        dbPath = join( root, 'memo-080.db' )
        transcriptPath = join( root, 'REV-18--review--01.md' )
        await writeFile( transcriptPath, body, 'utf-8' )
        await writeFile( join( root, 'REV-18.loggedin' ), '', 'utf-8' )

        const db = new DatabaseSync( dbPath )
        db.exec( 'CREATE TABLE IF NOT EXISTS user_inputs ( input_id TEXT PRIMARY KEY, memo_id TEXT, kind TEXT, payload_verbatim TEXT, payload_sha256 TEXT, captured_at TEXT, source_channel TEXT, session_id TEXT, complete INTEGER, corrected_by TEXT, schema_version INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS user_input_answers ( input_id TEXT, question_id TEXT, option_key TEXT, answer_verbatim TEXT, preselected INTEGER )' )
        db.prepare( 'INSERT INTO user_inputs ( input_id, memo_id, kind, payload_verbatim, payload_sha256, captured_at, source_channel, session_id, complete, corrected_by, schema_version ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? )' )
            .run( 'UI-0001', 'M080', 'voice-review', body, createHash( 'sha256' ).update( body ).digest( 'hex' ), '2026-09-05T08:00:00Z', 'transcript-server', 'sess-1', 1, null, 1 )
        db.prepare( 'INSERT INTO user_input_answers ( input_id, question_id, option_key, answer_verbatim, preselected ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'UI-0001', 'F12', 'A', 'Protokoll-Weg', 0 )
        db.close()
    } )


    afterAll( async () => {
        await rm( root, { 'recursive': true, 'force': true } )
    } )


    it( 'counts the durable rows and the press instant, and NAMES what it could not read (2 events compared)', () => {
        const disk = FirstFlightReport.readDisk( {
            'events': [
                { 'transcriptId': 'T-real', dbPath, transcriptPath, 'loginMarkerPath': join( root, 'REV-18.loggedin' ) },
                { 'transcriptId': 'T-ghost', 'dbPath': join( root, 'nope.db' ), 'transcriptPath': join( root, 'nope.md' ), 'loginMarkerPath': join( root, 'nope.loggedin' ) }
            ]
        } )

        expect( disk[ 'diskHits' ][ 'T-real' ] ).toBe( 1 )
        expect( disk[ 'diskHits' ][ 'T-ghost' ] ).toBe( 0 )
        expect( typeof disk[ 'pressedAt' ][ 'T-real' ] ).toBe( 'string' )
        expect( disk[ 'pressedAt' ][ 'T-ghost' ] ).toBe( null )
        expect( disk[ 'messages' ].length ).toBe( 2 )
        expect( disk[ 'messages' ].join( ' ' ) ).toMatch( /no \.loggedin sidecar for T-ghost/ )
    } )


    it( 'the CLI answers exit 3 without a protocol and exit 2 on a vacuum protocol (2 runs compared)', async () => {
        const noArgs = FirstFlightReport.run( { 'argv': [] } )
        const vacuumPath = join( root, 'vacuum.json' )
        await writeFile( vacuumPath, JSON.stringify( { 'plannedEvents': 5, 'events': [] } ), 'utf-8' )
        const vacuum = FirstFlightReport.run( { 'argv': [ '--protocol', vacuumPath ] } )

        expect( noArgs[ 'exitCode' ] ).toBe( 3 )
        expect( vacuum[ 'exitCode' ] ).toBe( 2 )
        expect( vacuum[ 'text' ] ).toMatch( /FAIL-VACUUM/ )
        expect( vacuum[ 'text' ] ).toMatch( /comparedCount   0 of 5/ )
    } )


    it( 'a full protocol renders PASS with all three counters and the four deadline lines', async () => {
        const protocolPath = join( root, 'full.json' )
        await writeFile( protocolPath, JSON.stringify( {
            'plannedEvents': 1,
            'events': [ { 'transcriptId': 'T-real', 'session': 'A', 'delivered': true, 'latencyMs': 91, 'progressMessages': 0, dbPath, transcriptPath, 'loginMarkerPath': join( root, 'REV-18.loggedin' ) } ],
            'deadlines': { 'idleSurvival': { 'held': true, 'measured': '1 s' } }
        } ), 'utf-8' )

        const run = FirstFlightReport.run( { 'argv': [ '--protocol', protocolPath ] } )

        expect( run[ 'exitCode' ] ).toBe( 0 )
        expect( run[ 'text' ] ).toMatch( /comparedCount   1 of 1/ )
        expect( run[ 'text' ] ).toMatch( /diskCount       1 of 1/ )
        expect( run[ 'text' ] ).toMatch( /deliveredCount  1 of 1/ )
        expect( run[ 'text' ].split( 'not flown' ).length - 1 ).toBe( 3 )
        expect( run[ 'text' ] ).toMatch( /VERDICT PASS/ )
    } )


    it( 'parseArgs reads --protocol and --json without guessing a path', () => {
        expect( FirstFlightReport.parseArgs( { 'argv': [ '--protocol', 'p.json', '--json' ] } ) ).toEqual( { 'protocol': 'p.json', 'asJson': true } )
        expect( FirstFlightReport.parseArgs( { 'argv': [] } ) ).toEqual( { 'protocol': null, 'asJson': false } )
        expect( FirstFlightReport.parseArgs( { 'argv': [ '--protocol' ] } ) ).toEqual( { 'protocol': null, 'asJson': false } )
    } )


    it( 'the module carries NO for/while loop — Node baseline (source scan)', () => {
        const source = readFileSync( resolve( import.meta.dirname, 'firstflight-report.mjs' ), 'utf-8' )

        expect( source.length ).toBeGreaterThan( 1000 )
        expect( /\bfor\s*\(/.test( source ) ).toBe( false )
        expect( /\bwhile\s*\(/.test( source ) ).toBe( false )
    } )
} )
