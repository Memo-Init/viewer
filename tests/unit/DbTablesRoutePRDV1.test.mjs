import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { MemoView } from '../../src/MemoView.mjs'
import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'


// PRD-V1 (Memo 080, Kap 15 — Das Schaufenster / WI-101): the READ-ONLY raw-table routes
// `GET /api/db/tables` and `GET /api/db/table/{name}`. Following the suite convention for the private
// #createHttpHandler, the pure statics behind the routes are exercised directly and the route wiring
// itself is asserted on the handler source string. Every case states HOW MUCH it compared (number of
// tables / rows / rejected shapes / matched source anchors) — a check without a comparison base counts
// as red, not green (lesson deterministic-gates-can-be-vacuum-green).
const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewSource = resolve( here, '..', '..', 'src', 'MemoView.mjs' )


describe( 'PRD-V1 — resolveMemoDbPath (die EINE Aufloesungs-Kette, kein zweiter Weg)', () => {
    let root = ''
    let withDb = ''
    let withoutDb = ''


    beforeAll( async () => {
        // Test isolation: write ONLY into the repo-internal .test-tmp/, never .memo/ and never the home.
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'dbroute-' ) )
        withDb = join( root, 'with-db' )
        withoutDb = join( root, 'without-db' )
        await mkdir( join( withDb, 'revisions' ), { recursive: true } )
        await mkdir( join( withoutDb, 'revisions' ), { recursive: true } )
        await writeFile( join( withoutDb, 'revisions', 'REV-01.md' ), '# leer\n', 'utf8' )

        const db = new DatabaseSync( join( withDb, 'memo-080.db' ) )
        db.exec( 'CREATE TABLE IF NOT EXISTS lifecycle ( state TEXT, at TEXT, by TEXT, evidence TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT )' )
        db.prepare( 'INSERT INTO lifecycle ( state, at, by, evidence ) VALUES ( ?, ?, ?, ? )' )
            .run( 'angelegt', '2026-08-31T00:00:00.000Z', 'memo-init', 'seed' )
        db.close()
    } )


    afterAll( async () => {
        await rm( root, { recursive: true, force: true } )
    } )


    it( 'resolves a memo dir to its memo-NNN.db', () => {
        const out = MemoView.resolveMemoDbPath( { memoPath: withDb } )

        expect( out[ 'status' ] ).toBe( true )
        expect( out[ 'dbPath' ] ).toBe( resolve( withDb, 'memo-080.db' ) )
        expect( out[ 'memoDir' ] ).toBe( withDb )
    } )


    it( 'accepts the revisions/ shape of a registered memoPath (same chain as the serve weiche)', () => {
        const out = MemoView.resolveMemoDbPath( { memoPath: join( withDb, 'revisions' ) } )

        expect( out[ 'status' ] ).toBe( true )
        expect( out[ 'dbPath' ] ).toBe( resolve( withDb, 'memo-080.db' ) )
    } )


    it( 'a memo WITHOUT a per-memo database fails with a message that NAMES the missing database', () => {
        const out = MemoView.resolveMemoDbPath( { memoPath: withoutDb } )

        expect( out[ 'status' ] ).toBe( false )
        expect( out[ 'dbPath' ] ).toBe( null )
        expect( out[ 'message' ] ).toMatch( /memo-NNN\.db/ )
    } )


    it( 'an empty / missing memoPath fails loud instead of guessing a directory', () => {
        expect( MemoView.resolveMemoDbPath( { memoPath: '' } )[ 'status' ] ).toBe( false )
        expect( MemoView.resolveMemoDbPath( {} )[ 'status' ] ).toBe( false )
    } )


    it( 'the resolved path really opens: the listing reports 2 tables of this seeded db', () => {
        const { dbPath } = MemoView.resolveMemoDbPath( { memoPath: withDb } )
        const { tables, tableCount } = DoltDbAssembler.readTableList( { dbPath } )

        expect( tableCount ).toBe( 2 )
        expect( tables.map( ( t ) => t[ 'name' ] ) ).toEqual( [ 'lifecycle', 'memo' ] )
    } )
} )


describe( 'PRD-V1 — die Routen im Handler (Quelltext-Nachweis, Suite-Konvention fuer #createHttpHandler)', () => {
    let source = ''


    beforeAll( async () => {
        source = await readFile( memoViewSource, 'utf-8' )
    } )


    it( 'both read routes exist and answer via the existing sendJson helper', () => {
        const anchors = [
            "url === '/api/db/tables'",
            "url.startsWith( '/api/db/table/' )",
            "DoltDbAssembler.readTableList( { 'dbPath': resolved[ 'dbPath' ] } )",
            'DoltDbAssembler.readTablePage( {'
        ]

        // 4 of 4 anchors must be present — the comparison base is stated, an empty scan cannot pass.
        expect( anchors.length ).toBe( 4 )
        expect( anchors.filter( ( a ) => source.indexOf( a ) === -1 ) ).toEqual( [] )
    } )


    it( 'a non-GET method on the raw-table routes is refused with 405', () => {
        expect( source ).toContain( "sendJson( res, 405, { 'error': 'Nur lesende Anfragen (GET)" )
        expect( source ).toContain( "if( req.method !== 'GET' ) {" )
    } )


    it( 'unknown memo, missing database and unknown table all end in 404', () => {
        expect( source ).toContain( "sendJson( res, 404, { 'error': resolved[ 'message' ] } )" )
        expect( source ).toContain( "sendJson( res, 404, { 'error': `Unbekannte Tabelle: ${ tableName }`" )
    } )


    it( 'an open/read failure ends in 503 with a "nicht verfuegbar" message, the server keeps running', () => {
        expect( source ).toContain( 'sendJson( res, 503, { \'error\': `Datenbank vorübergehend nicht verfügbar' )
        // the read is wrapped — no throw escapes into the request loop.
        expect( source ).toContain( 'const listed = DoltDbAssembler.readTableList' )
    } )


    it( 'a bad page window is refused with 400 (it never reaches the database unchanged)', () => {
        expect( source ).toContain( "error.message.indexOf( 'normalizeTablePage' )" )
        expect( source ).toContain( 'isWindowError ? 400 : 503' )
    } )


    it( 'the routes resolve the memo over the EXISTING chain — no second resolution path', () => {
        expect( source ).toContain( "MemoView.resolveMemoDbPath( { 'memoPath': lookup[ 'document' ][ 'memoPath' ] } )" )
        // resolveMemoDbPath itself is the only place that walks resolveMemoDir → hasDb → resolveDbPath
        // for this surface; the raw-table branch never calls hasDb/resolveDbPath directly.
        const branchStart = source.indexOf( "url === '/api/db/tables' || url.startsWith" )
        const branchEnd = source.indexOf( '// Memo 079 M3=A (T059)', branchStart )
        const branch = source.slice( branchStart, branchEnd )

        expect( branchStart ).toBeGreaterThan( -1 )
        expect( branchEnd ).toBeGreaterThan( branchStart )
        expect( branch.indexOf( 'DoltDbAssembler.hasDb' ) ).toBe( -1 )
        expect( branch.indexOf( 'DoltDbAssembler.resolveDbPath' ) ).toBe( -1 )
    } )


    it( 'the raw-table branch carries NO write verb and adds NO second listener/binding', () => {
        const branchStart = source.indexOf( "url === '/api/db/tables' || url.startsWith" )
        const branchEnd = source.indexOf( '// Memo 079 M3=A (T059)', branchStart )
        const branch = source.slice( branchStart, branchEnd )
        const verbs = [ 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE' ]

        // 5 forbidden verbs scanned over 1 contiguous branch region.
        expect( verbs.length ).toBe( 5 )
        expect( verbs.filter( ( verb ) => branch.indexOf( verb ) !== -1 ) ).toEqual( [] )
        expect( branch.indexOf( 'listen' ) ).toBe( -1 )

        // the whole file still holds exactly the three pre-existing server.listen calls (start,
        // startServer, the port probe) — the raw-table surface hangs off the existing bound server.
        const listens = source.match( /server\.listen\(|testServer\.listen\(/g ) || []
        expect( listens.length ).toBe( 3 )
    } )


    it( 'the answer carries total, limit and offset so the client can page honestly', () => {
        expect( source ).toContain( "'totalRows': page[ 'totalRows' ], 'limit': page[ 'limit' ], 'offset': page[ 'offset' ]" )
        expect( source ).toContain( "'truncatedCells': page[ 'truncatedCells' ]" )
    } )


    it( '/dbtables is an SPA route so a reload of the view does not 404', () => {
        expect( source ).toContain( "url === '/dbtables'" )
    } )


    it( 'the raw-table mode button lives in the existing #mode-toggle bar', () => {
        expect( source ).toContain( '<button id="mode-dbtables" class="mode-toggle">Rohtabellen</button>' )
    } )
} )


describe( 'PRD-V1 — die Ansicht im Betrachter (Client-Quelltext-Nachweis)', () => {
    let client = ''


    beforeAll( async () => {
        client = await readFile( resolve( here, '..', '..', 'src', 'public', 'app.client.mjs' ), 'utf-8' )
    } )


    it( 'renders the table list, the chosen table and a vor/zurueck pager', () => {
        const anchors = [
            'function renderDbTablesView()',
            'function renderDbTableList(',
            'function selectDbTable(',
            'function renderDbTablePage(',
            "'/api/db/tables?documentId='",
            "'/api/db/table/'"
        ]

        // 6 of 6 anchors — the comparison base is stated.
        expect( anchors.length ).toBe( 6 )
        expect( anchors.filter( ( a ) => client.indexOf( a ) === -1 ) ).toEqual( [] )
    } )


    it( 'shows the position line "Zeilen x–y von z" built from the answer fields', () => {
        expect( client ).toContain( "var position = 'Zeilen ' + from + '–' + to + ' von ' + total" )
    } )


    it( 'every cell value goes through the existing escapeHtml (a stored <script> renders as TEXT)', () => {
        const start = client.indexOf( 'function renderDbTablePage(' )
        const end = client.indexOf( 'var prev = document.getElementById', start )
        const region = client.slice( start, end )

        expect( start ).toBeGreaterThan( -1 )
        // the header cells, the body cells and the truncation mark are all escaped — 3 call sites.
        expect( ( region.match( /escapeHtml\(/g ) || [] ).length ).toBeGreaterThanOrEqual( 3 )
        expect( region ).toContain( 'escapeHtml( cell.value )' )
    } )


    it( 'a truncated cell is visibly marked and an endpoint error is a visible note, never a silent blank', () => {
        expect( client ).toContain( 'dbtables-truncated' )
        expect( client ).toContain( 'class="dbtables-error"' )
        expect( client ).toContain( 'Rohtabellen konnten nicht geladen werden' )
    } )


    it( 'the mode button is wired through the EXISTING mode mechanics (setActiveModeButton / setMode)', () => {
        expect( client ).toContain( "applyState( modeDbTablesBtn, mode === 'dbtables' )" )
        expect( client ).toContain( "modeDbTablesBtn.addEventListener( 'click', function() { setMode( 'dbtables', { push: true } ) } )" )
    } )
} )
