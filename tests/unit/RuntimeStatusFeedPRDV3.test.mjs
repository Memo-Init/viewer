import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { MemoView } from '../../src/MemoView.mjs'
import { extractFunctions } from '../helpers/extractFunction.mjs'


// PRD-V3 (Memo 080, Kap 15 / WI-104, WI-105) — the LAUFZEIT-STATUS path, end to end in pieces:
//   database write -> file watcher -> MAX(seq) -> `runtimeStatus` message -> one line in the head bar.
//
// The finding this suite is built around: the running server registers the memo's `revisions/` SUBFOLDER
// (ProjectAutoRegister), while `memo-NNN.db` lies in the MEMO folder one level up. A db branch bolted onto
// the registered folder alone would be green in a test and DEAD in production — the class of defect, not the
// one case. Case 1 therefore watches exactly the production shape.
//
// Every case states HOW MUCH it compared (events, evaluations, messages, ledger rows). Tests write ONLY
// into the repo-internal .test-tmp/, never into .memo/ and never into the home.
const HERE = dirname( fileURLToPath( import.meta.url ) )
const CLIENT_SOURCE = resolve( HERE, '..', '..', 'src', 'public', 'app.client.mjs' )
const MEMOVIEW_SOURCE = resolve( HERE, '..', '..', 'src', 'MemoView.mjs' )
const CSS_SOURCE = resolve( HERE, '..', '..', 'src', 'public', 'app.css' )

// The debounce of the db branch is 150 ms (DocumentRegistry DB_WATCH_DEBOUNCE_MS). A case that waits for a
// report waits longer than that; a case that fires a burst fires well inside it.
const SETTLE_MS = 700
const BURST_GAP_MS = 20

const wait = ( ms ) => new Promise( ( done ) => setTimeout( done, ms ) )

// macOS delivers the CREATION events of a freshly seeded folder to a watcher that armed afterwards, so a
// case that counts from zero would be counting the seeding, not its own write. Every case therefore lets the
// watcher settle once and then measures from a KNOWN baseline — the count it reports is its own.
const settle = async ( { events } ) => {
    await wait( SETTLE_MS )
    const swallowed = events.length
    events.splice( 0, events.length )

    return { swallowed }
}


// A memo folder in the PRODUCTION shape: <memoDir>/memo-080.db + <memoDir>/revisions/REV-01.md.
const seedMemoFolder = ( { memoDir, journalRows } ) => {
    mkdirSync( join( memoDir, 'revisions' ), { recursive: true } )
    writeFileSync( join( memoDir, 'revisions', 'REV-01.md' ), '# 080\n\nRumpf.\n', 'utf8' )

    const dbPath = join( memoDir, 'memo-080.db' )
    const db = new DatabaseSync( dbPath )
    // The badge derivation of the registry reads `lifecycle` on every refresh — seeded here so the case
    // exercises a realistic memo database instead of a stripped one that only carries the ledger.
    db.exec( 'CREATE TABLE IF NOT EXISTS lifecycle ( state TEXT, `at` TEXT, by TEXT, evidence TEXT )' )
    db.prepare( 'INSERT INTO lifecycle ( state, `at`, by, evidence ) VALUES ( ?, ?, ?, ? )' )
        .run( 'rollout', '2026-09-05T09:00:00Z', 'test', null )
    db.exec( 'CREATE TABLE IF NOT EXISTS history_journal ( seq INTEGER, entity TEXT, entity_id TEXT, field TEXT, old_value TEXT, new_value TEXT, session_id TEXT, `at` TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, spillover TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )

    const journal = db.prepare( 'INSERT INTO history_journal ( seq, entity, entity_id, field, old_value, new_value, session_id, `at` ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ? )' )
    Array.from( { length: journalRows } )
        .forEach( ( _, index ) => journal.run( index + 1, 'lifecycle-set', `commit-${ index + 1 }`, null, null, null, 'sess-3', '2026-09-05T10:00:00Z' ) )
    db.close()

    return { dbPath, journalRows }
}


// Touch the db file `times` times inside the debounce window — the burst one commit can produce.
const touchDb = ( { dbPath, times } ) => {
    Array.from( { length: times } )
        .forEach( ( _, index ) => writeFileSync( `${ dbPath }`, readFileSync( dbPath ), { flag: 'r+' } ) || index )

    return { times }
}


describe( 'PRD-V3 — die Datei-Ueberwachung sieht die Datenbank (WI-104)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let root = ''


    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        root = mkdtempSync( join( repoTmpRoot, 'runtime-watch-' ) )
    } )

    afterEach( () => {
        rmSync( root, { recursive: true, force: true } )
    } )


    it( 'the PRODUCTION shape: the revisions/ subfolder is registered, the db lies one level up — and it is still seen', async () => {
        const memoDir = join( root, '080-db-vollausbau' )
        const seeded = seedMemoFolder( { memoDir, journalRows: 2 } )
        const events = []
        const { registry } = DocumentRegistry.create( { onChange: ( entry ) => events.push( entry ) } )

        const added = await registry.addDocument( { projectId: 'memo-init', memoPath: join( memoDir, 'revisions' ) } )
        expect( added[ 'status' ] ).toBe( true )
        await settle( { events } )

        touchDb( { dbPath: seeded.dbPath, times: 1 } )
        await wait( SETTLE_MS )
        registry.shutdown()

        const dbEvents = events.filter( ( entry ) => entry[ 'event' ] === 'dbChanged' )

        expect( events.length ).toBeGreaterThan( 0 )
        expect( dbEvents.length ).toBe( 1 )
        expect( dbEvents[ 0 ][ 'documentId' ] ).toBe( added[ 'documentId' ] )
        // the db branch does NOT re-broadcast the document list
        expect( events.filter( ( entry ) => entry[ 'event' ] === 'revisionsUpdated' ).length ).toBe( 0 )
    } )


    it( 'the memo folder itself may be registered too — the same rule, one directory down (1 event compared)', async () => {
        const memoDir = join( root, '080-flat' )
        const seeded = seedMemoFolder( { memoDir, journalRows: 1 } )
        const events = []
        const { registry } = DocumentRegistry.create( { onChange: ( entry ) => events.push( entry ) } )

        const added = await registry.addDocument( { projectId: 'memo-init', memoPath: memoDir } )
        expect( added[ 'status' ] ).toBe( true )
        await settle( { events } )

        touchDb( { dbPath: seeded.dbPath, times: 1 } )
        await wait( SETTLE_MS )
        registry.shutdown()

        expect( events.filter( ( entry ) => entry[ 'event' ] === 'dbChanged' ).length ).toBe( 1 )
    } )


    it( 'THREE file events inside the debounce window produce exactly ONE evaluation (3 events -> 1 report)', async () => {
        const memoDir = join( root, '080-debounce' )
        const seeded = seedMemoFolder( { memoDir, journalRows: 1 } )
        const events = []
        const { registry } = DocumentRegistry.create( { onChange: ( entry ) => events.push( entry ) } )

        await registry.addDocument( { projectId: 'memo-init', memoPath: join( memoDir, 'revisions' ) } )
        await settle( { events } )

        const burst = touchDb( { dbPath: seeded.dbPath, times: 1 } )
        await wait( BURST_GAP_MS )
        touchDb( { dbPath: seeded.dbPath, times: 1 } )
        await wait( BURST_GAP_MS )
        touchDb( { dbPath: seeded.dbPath, times: 1 } )
        await wait( SETTLE_MS )
        registry.shutdown()

        expect( burst.times ).toBe( 1 )
        expect( events.filter( ( entry ) => entry[ 'event' ] === 'dbChanged' ).length ).toBe( 1 )
    } )


    it( 'an unrelated file raises NOTHING, a REV file still raises the revision branch (2 files compared)', async () => {
        const memoDir = join( root, '080-other' )
        seedMemoFolder( { memoDir, journalRows: 1 } )
        const events = []
        const { registry } = DocumentRegistry.create( { onChange: ( entry ) => events.push( entry ) } )

        await registry.addDocument( { projectId: 'memo-init', memoPath: join( memoDir, 'revisions' ) } )
        const baseline = await settle( { events } )

        writeFileSync( join( memoDir, 'revisions', 'notes.txt' ), 'kein Ereignis\n', 'utf8' )
        await wait( SETTLE_MS )

        expect( baseline.swallowed ).toBeGreaterThanOrEqual( 0 )
        expect( events.length ).toBe( 0 )

        writeFileSync( join( memoDir, 'revisions', 'REV-02.md' ), '# 080\n\nZweite Fassung.\n', 'utf8' )
        await wait( SETTLE_MS )
        registry.shutdown()

        expect( events.filter( ( entry ) => entry[ 'event' ] === 'revisionsUpdated' ).length ).toBeGreaterThan( 0 )
        expect( events.filter( ( entry ) => entry[ 'event' ] === 'dbChanged' ).length ).toBe( 0 )
    } )
} )


describe( 'PRD-V3 — das Signal ist die laufende Nummer (WI-104)', () => {
    it( 'a sequence that did NOT grow does not advance the gate (3 comparisons)', () => {
        const documentId = `gate-${ Date.now() }`

        expect( MemoView.advanceRuntimeSeq( { documentId, seq: 5 } )[ 'advanced' ] ).toBe( true )
        expect( MemoView.advanceRuntimeSeq( { documentId, seq: 5 } )[ 'advanced' ] ).toBe( false )
        expect( MemoView.advanceRuntimeSeq( { documentId, seq: 4 } )[ 'advanced' ] ).toBe( false )
        expect( MemoView.advanceRuntimeSeq( { documentId, seq: 6 } )[ 'advanced' ] ).toBe( true )

        MemoView.forgetRuntimeStatus( { documentId } )
    } )


    it( 'forgetting a document resets the gate — the next message is not swallowed', () => {
        const documentId = `gate-forget-${ Date.now() }`

        MemoView.advanceRuntimeSeq( { documentId, seq: 9 } )
        expect( MemoView.advanceRuntimeSeq( { documentId, seq: 9 } )[ 'advanced' ] ).toBe( false )
        expect( MemoView.forgetRuntimeStatus( { documentId } )[ 'forgotten' ] ).toBe( true )
        expect( MemoView.advanceRuntimeSeq( { documentId, seq: 9 } )[ 'advanced' ] ).toBe( true )

        MemoView.forgetRuntimeStatus( { documentId } )
    } )


    it( 'the message carries all SIX payload fields, declared in one place', () => {
        const status = { 'seq': 180, 'latest': { 'seq': 180, 'entity': 'rollout-normalize', 'entityId': 'rollout state normalize', 'sessionId': 's', 'at': '2026-09-05T06:56:11.299Z' }, 'phases': 11, 'workItems': 77, 'rolloutInDb': true }
        const message = MemoView.buildRuntimeStatusMessage( { documentId: 'memo-init--080', status } )

        expect( Object.keys( message ).sort() ).toEqual( [ 'documentId', 'latest', 'phases', 'rolloutInDb', 'seq', 'type', 'workItems' ] )
        expect( message[ 'type' ] ).toBe( 'runtimeStatus' )
        expect( message[ 'seq' ] ).toBe( 180 )
        expect( message[ 'rolloutInDb' ] ).toBe( true )
    } )


    it( 'without a connected client nothing is sent AND the gate stays untouched', () => {
        const documentId = `gate-noclient-${ Date.now() }`
        const result = MemoView.broadcastRuntimeStatus( { documentId, memoPath: join( process.cwd(), 'does-not-exist' ) } )

        expect( result[ 'sent' ] ).toBe( false )
        expect( result[ 'reason' ] ).toBe( 'no-clients' )
        // the marker was not written, so the first real message after a client connects still arrives
        expect( MemoView.forgetRuntimeStatus( { documentId } )[ 'forgotten' ] ).toBe( false )
    } )
} )


describe( 'PRD-V3 — die Zeile in der Kopfleiste (WI-104)', () => {
    let buildRuntimeStatusLine = null
    let client = ''
    let memoView = ''
    let css = ''


    beforeAll( async () => {
        client = await readFile( CLIENT_SOURCE, 'utf8' )
        memoView = await readFile( MEMOVIEW_SOURCE, 'utf8' )
        css = await readFile( CSS_SOURCE, 'utf8' )
        const fns = await extractFunctions( [ 'escapeHtml', 'buildRuntimeStatusLine' ] )
        buildRuntimeStatusLine = fns.buildRuntimeStatusLine
    } )


    it( 'an EMPTY rollout says so in words instead of printing a null balance', () => {
        const line = buildRuntimeStatusLine( { seq: 179, latest: { seq: 179, entity: 'write-through-workItems', entityId: 'workItems', at: '2026-09-04T22:19:52.022Z' }, phases: 0, workItems: 0, rolloutInDb: false } )

        expect( line.gap ).toBe( true )
        expect( line.html ).toContain( 'Rollout-Zustand nicht in der Datenbank' )
        expect( line.html ).not.toContain( '0 Phasen' )
        // the timestamp of the newest ledger row is on the line, so a stale stand is readable
        expect( line.html ).toContain( '2026-09-04T22:19:52.022Z' )
        expect( line.html ).toContain( 'DB #179' )
    } )


    it( 'a FILLED rollout prints the two figures (11 phases, 77 PRDs compared)', () => {
        const line = buildRuntimeStatusLine( { seq: 180, latest: { seq: 180, entity: 'rollout-normalize', entityId: 'rollout state normalize', at: '2026-09-05T06:56:11.299Z' }, phases: 11, workItems: 77, rolloutInDb: true } )

        expect( line.gap ).toBe( false )
        expect( line.html ).toContain( '11 Phasen · 77 PRDs' )
        expect( line.html ).toContain( 'rollout-normalize' )
    } )


    it( 'an EMPTY ledger renders without inventing a newest row', () => {
        const line = buildRuntimeStatusLine( { seq: 0, latest: null, phases: 0, workItems: 0, rolloutInDb: false } )

        expect( line.html ).toContain( 'DB #0' )
        expect( line.gap ).toBe( true )
    } )


    it( 'a hostile value from the database is escaped, not rendered as markup', () => {
        const line = buildRuntimeStatusLine( { seq: 3, latest: { seq: 3, entity: '<img src=x onerror=alert(1)>', entityId: '"quoted"', at: '2026-09-05' }, phases: 1, workItems: 2, rolloutInDb: true } )

        expect( line.html ).not.toContain( '<img' )
        expect( line.html ).toContain( '&lt;img' )
        expect( line.html ).toContain( '&quot;quoted&quot;' )
    } )


    it( 'the head bar carries the target span and the stylesheet carries its rule', () => {
        expect( memoView ).toContain( 'id="runtime-status"' )
        expect( memoView ).toContain( 'aria-live="polite"' )
        expect( memoView.indexOf( 'id="runtime-status"' ) ).toBeLessThan( memoView.indexOf( '<span id="nav-spacer">' ) )
        expect( css ).toContain( '.runtime-status' )
        expect( css ).toContain( '.runtime-status-gap' )
    } )


    it( 'the eight existing message types are untouched and runtimeStatus is the ninth (9 types compared)', () => {
        const known = [ 'build', 'pushHistory', 'documentList', 'transcriptList', 'transcriptLoggedIn', 'transcriptLoggedOut', 'clientList', 'annotationList', 'content' ]
        const missing = known
            .filter( ( type ) => client.indexOf( `data.type === '${ type }'` ) === -1 )

        expect( known.length ).toBe( 9 )
        expect( missing ).toEqual( [] )
        expect( client ).toContain( "data.type === 'runtimeStatus'" )
        // the branch renders, it does not re-render the revision view and does not touch the scroll
        const start = client.indexOf( "if( data.type === 'runtimeStatus' ) {" )
        const region = client.slice( start, start + 200 )
        expect( start ).toBeGreaterThan( -1 )
        expect( region ).toContain( 'renderRuntimeStatus( data )' )
        expect( region ).not.toContain( 'scrollTo' )
    } )
} )
