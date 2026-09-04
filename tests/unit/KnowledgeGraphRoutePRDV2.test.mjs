import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { MemoView } from '../../src/MemoView.mjs'
import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'


// PRD-V2 (Memo 080, Kap 15 — Das Schaufenster / WI-102): the READ-ONLY knowledge-graph route
// `GET /api/documents/{id}/graph`. Following the suite convention for the private #createHttpHandler, the
// pure statics behind the route are exercised against a real seeded memo directory and the route wiring
// itself is asserted on the handler source string. Every case states HOW MUCH it compared (nodes / edges /
// anchors / matched positions) — a check without a comparison base counts as red, not green (lesson
// deterministic-gates-can-be-vacuum-green).
const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewSource = resolve( here, '..', '..', 'src', 'MemoView.mjs' )
const clientSource = resolve( here, '..', '..', 'src', 'public', 'app.client.mjs' )


describe( 'PRD-V2 — die Antwort der Graph-Route (echte Datenbank, echte Aufloesungs-Kette)', () => {
    let root = ''
    let withDb = ''
    let withoutDb = ''


    beforeAll( async () => {
        // Test isolation: write ONLY into the repo-internal .test-tmp/, never .memo/ and never the home.
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'graphroute-' ) )
        withDb = join( root, 'with-db' )
        withoutDb = join( root, 'without-db' )
        await mkdir( join( withDb, 'revisions' ), { recursive: true } )
        await mkdir( join( withoutDb, 'revisions' ), { recursive: true } )
        await writeFile( join( withoutDb, 'revisions', 'REV-01.md' ), '# leer\n', 'utf8' )

        // 1 topic · 1 work item · 1 phase · 1 rollout row — the smallest seed that still closes the
        // work-item bridge the user asked for ("welches Topic steckt in welchem PRD").
        const db = new DatabaseSync( join( withDb, 'memo-080.db' ) )
        db.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, spillover TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )
        db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'T015', 'M080', 'Visualisierung Topics/WIs/PRDs', 'P0', 'B015' )
        db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'WI-102', 'T015', 'Graph Stufe 1', 'offen', 'schaufenster' )
        db.prepare( 'INSERT INTO rollout_phase ( id, memo_id, name, status, spillover ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'phase-9', 'M080', 'Das Schaufenster', 'open', '{}' )
        db.prepare( 'INSERT INTO rollout_work_item ( id, phase_id, title, status, target, wi_type, spillover ) VALUES ( ?, ?, ?, ?, ?, ?, ? )' )
            .run( 'WI-102', 'phase-9', 'PRD-V2', 'open', null, 'prd', '{}' )
        db.close()
    } )


    afterAll( async () => {
        await rm( root, { recursive: true, force: true } )
    } )


    it( 'a memo WITH a database answers with a source and all seven figures (4 nodes, 3 edges)', () => {
        const { dbPath, status } = MemoView.resolveMemoDbPath( { memoPath: withDb } )
        const graph = DoltDbAssembler.readKnowledgeGraph( { dbPath } )

        expect( status ).toBe( true )
        expect( typeof graph[ 'mermaid' ] ).toBe( 'string' )
        expect( Object.keys( graph[ 'counts' ] ).length ).toBe( 7 )
        expect( graph[ 'counts' ] ).toEqual( {
            topics: 1, workItems: 1, phases: 1, prds: 1,
            edgesTopicWorkItem: 1, edgesPhasePrd: 1, edgesTopicPrd: 1
        } )
        expect( graph[ 'empty' ] ).toBe( false )
        expect( graph[ 'reason' ] ).toBe( null )
        expect( graph[ 'warnings' ] ).toEqual( [] )
        expect( graph[ 'mermaid' ] ).toContain( 'T_T015 --> R_WI_2d_102' )
    } )


    it( 'a memo WITHOUT a database resolves to a NAMED reason, not to a crash and not to a fake empty graph', () => {
        const resolved = MemoView.resolveMemoDbPath( { memoPath: withoutDb } )
        const counts = DoltDbAssembler.emptyGraphCounts()

        expect( resolved[ 'status' ] ).toBe( false )
        expect( resolved[ 'message' ] ).toMatch( /memo-NNN\.db/ )
        // the no-db answer speaks the SAME seven-figure shape a real read produces — 7 of 7 keys
        expect( Object.keys( counts ).length ).toBe( 7 )
        expect( Object.values( counts ).filter( ( value ) => value !== 0 ) ).toEqual( [] )
    } )
} )


describe( 'PRD-V2 — die Route im Handler (Quelltext-Nachweis, Suite-Konvention fuer #createHttpHandler)', () => {
    let source = ''


    beforeAll( async () => {
        source = await readFile( memoViewSource, 'utf-8' )
    } )


    it( 'the read route exists and answers through the existing sendJson helper (4 of 4 anchors)', () => {
        const anchors = [
            "url.startsWith( '/api/documents/' ) && url.endsWith( '/graph' ) && req.method === 'GET'",
            "DoltDbAssembler.readKnowledgeGraph( { 'dbPath': resolved[ 'dbPath' ] } )",
            "'counts': DoltDbAssembler.emptyGraphCounts()",
            "'reason': 'no-db'"
        ]

        expect( anchors.length ).toBe( 4 )
        expect( anchors.filter( ( anchor ) => source.indexOf( anchor ) === -1 ) ).toEqual( [] )
    } )


    it( 'the route is sorted BEFORE the generic /api/documents/<id> read (otherwise that one swallows it)', () => {
        const graphBranch = source.indexOf( "url.endsWith( '/graph' ) && req.method === 'GET'" )
        const genericBranch = source.indexOf( "if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {" )

        expect( graphBranch ).toBeGreaterThan( -1 )
        expect( genericBranch ).toBeGreaterThan( -1 )
        expect( graphBranch ).toBeLessThan( genericBranch )
    } )


    it( 'an unknown document ends in 404 with the registry message, a read failure in 503', () => {
        const branch = source.slice(
            source.indexOf( "url.endsWith( '/graph' ) && req.method === 'GET'" ),
            source.indexOf( "if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {" )
        )

        expect( branch ).toContain( "sendJson( res, 404, { 'error': result[ 'messages' ].join( '; ' ) } )" )
        expect( branch ).toContain( "sendJson( res, 503, { 'error': `Datenbank vorübergehend nicht verfügbar" )
        // the read is wrapped — no throw escapes into the request loop and takes the server down
        expect( branch ).toContain( 'try {' )
    } )


    it( 'a POST to the same address is NOT handled as the graph route (the branch is GET-gated)', () => {
        const graphGets = source.match( /url\.endsWith\( '\/graph' \) && req\.method === 'GET'/g ) || []
        const anyGraph = source.match( /url\.endsWith\( '\/graph' \)/g ) || []

        // every single /graph match is the GET-gated one — 1 of 1, no write twin anywhere
        expect( anyGraph.length ).toBe( 1 )
        expect( graphGets.length ).toBe( anyGraph.length )
    } )


    it( 'the graph branch carries NO write verb and adds NO second listener/binding (5 verbs scanned)', () => {
        const branch = source.slice(
            source.indexOf( "url.endsWith( '/graph' ) && req.method === 'GET'" ),
            source.indexOf( "if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {" )
        )
        const verbs = [ 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE' ]

        expect( branch.length ).toBeGreaterThan( 0 )
        expect( verbs.length ).toBe( 5 )
        expect( verbs.filter( ( verb ) => branch.indexOf( verb ) !== -1 ) ).toEqual( [] )
        expect( branch.indexOf( 'listen' ) ).toBe( -1 )

        // the file still holds exactly the three pre-existing server.listen calls
        const listens = source.match( /server\.listen\(|testServer\.listen\(/g ) || []
        expect( listens.length ).toBe( 3 )
    } )


    it( 'the route resolves the memo over the EXISTING chain — no second resolution path', () => {
        const branch = source.slice(
            source.indexOf( "url.endsWith( '/graph' ) && req.method === 'GET'" ),
            source.indexOf( "if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {" )
        )

        expect( branch ).toContain( "MemoView.resolveMemoDbPath( { 'memoPath': result[ 'document' ][ 'memoPath' ] } )" )
        expect( branch.indexOf( 'DoltDbAssembler.hasDb' ) ).toBe( -1 )
        expect( branch.indexOf( 'DoltDbAssembler.resolveDbPath' ) ).toBe( -1 )
    } )
} )


describe( 'PRD-V2 — der Umschalt-Vertrag der dritten Ansicht (gleiche Regel wie Requirements/Bloecke)', () => {
    let client = ''
    let logic = ''


    beforeAll( async () => {
        client = await readFile( clientSource, 'utf-8' )
        logic = await readFile( resolve( here, '..', '..', 'src', 'RevisionLogic.mjs' ), 'utf-8' )
    } )


    it( 'the graph view is known and opens from prose', () => {
        expect( MemoView.nextViewState( { current: 'prose', requested: 'graph' } ) ).toEqual( { view: 'graph', render: true } )
    } )


    it( 'pressing the toggle again while the graph is open returns HOME to prose', () => {
        const open = MemoView.nextViewState( { current: 'prose', requested: 'graph' } )
        const back = MemoView.nextViewState( { current: open.view, requested: 'graph' } )

        expect( open.view ).toBe( 'graph' )
        expect( back ).toEqual( { view: 'prose', render: true } )
    } )


    it( 'the graph and the two older panels switch between each other (4 transitions compared)', () => {
        const transitions = [
            [ 'requirements', 'graph', 'graph' ],
            [ 'blocks', 'graph', 'graph' ],
            [ 'graph', 'requirements', 'requirements' ],
            [ 'graph', 'blocks', 'blocks' ]
        ]

        expect( transitions.length ).toBe( 4 )
        const wrong = transitions
            .filter( ( entry ) => MemoView.nextViewState( { current: entry[ 0 ], requested: entry[ 1 ] } ).view !== entry[ 2 ] )
        expect( wrong ).toEqual( [] )
    } )


    it( 'an open graph panel survives a WS content broadcast (it is not the prose home view)', () => {
        expect( MemoView.shouldRerenderOnBroadcast( { currentView: 'graph' } ) ).toBe( false )
    } )


    it( 'client and server carry the SAME known list — one state machine, mirrored (4 of 4 entries)', () => {
        // read the list INSIDE each nextViewState — the client carries a second, unrelated `known` list
        // (the severity ranks), so an unanchored match would compare the wrong two things.
        const clientFn = client.slice( client.indexOf( 'function nextViewState( current, requested )' ) )
        const serverFn = logic.slice( logic.indexOf( 'static nextViewState( { current, requested } )' ) )
        const clientList = clientFn.match( /var known = \[([^\]]+)\]/ )
        const serverList = serverFn.match( /const known = \[([^\]]+)\]/ )

        expect( clientList ).not.toBe( null )
        expect( serverList ).not.toBe( null )
        const parse = ( match ) => match[ 1 ].split( ',' ).map( ( entry ) => entry.trim().replace( /'/g, '' ) )
        expect( parse( clientList ).length ).toBe( 4 )
        expect( parse( clientList ) ).toEqual( parse( serverList ) )
        expect( parse( clientList ) ).toEqual( [ 'prose', 'requirements', 'blocks', 'graph' ] )
    } )
} )


describe( 'PRD-V2 — die Ansicht im Betrachter (Client-Quelltext-Nachweis)', () => {
    let client = ''
    let source = ''
    let manifest = null


    beforeAll( async () => {
        client = await readFile( clientSource, 'utf-8' )
        source = await readFile( memoViewSource, 'utf-8' )
        manifest = JSON.parse( await readFile( resolve( here, '..', '..', 'package.json' ), 'utf-8' ) )
    } )


    it( 'loads and renders the graph over the existing view mechanics (6 of 6 anchors)', () => {
        const anchors = [
            'async function loadGraphView( documentId )',
            'function renderGraphView( payload, contentTarget )',
            "'/graph'",
            '<button id="graph-view-toggle"',
            "document.getElementById( 'graph-view-toggle' )",
            "var known = [ 'prose', 'requirements', 'blocks', 'graph' ]"
        ]

        expect( anchors.length ).toBe( 6 )
        expect( anchors.filter( ( anchor ) => client.indexOf( anchor ) === -1 ) ).toEqual( [] )
    } )


    it( 'the graph is drawn through the EXISTING diagram registry — one div.mermaid, one render pass', () => {
        const start = client.indexOf( 'function renderGraphView( payload, contentTarget )' )
        const end = client.indexOf( 'async function loadGraphView( documentId )', start )
        const region = client.slice( start, end )

        expect( start ).toBeGreaterThan( -1 )
        expect( end ).toBeGreaterThan( start )
        expect( region ).toContain( "box.className = 'mermaid'" )
        expect( region ).toContain( "box.setAttribute( 'data-src', payload.mermaid )" )
        // exactly ONE render call in the graph path — no second drawing path is opened
        expect( ( region.match( /renderAllDiagrams\(\)/g ) || [] ).length ).toBe( 1 )
        // and no direct renderer call bypassing the registry
        expect( region.indexOf( 'mermaid.render' ) ).toBe( -1 )
    } )


    it( 'the count line and the warnings are ALWAYS written, the empty case says so in plain words', () => {
        const start = client.indexOf( 'function renderGraphView( payload, contentTarget )' )
        const end = client.indexOf( 'async function loadGraphView( documentId )', start )
        const region = client.slice( start, end )
        const figures = [ 'counts.topics', 'counts.workItems', 'counts.phases', 'counts.prds',
            'counts.edgesTopicWorkItem', 'counts.edgesPhasePrd', 'counts.edgesTopicPrd' ]

        // all seven figures reach the head line — 7 of 7
        expect( figures.length ).toBe( 7 )
        expect( figures.filter( ( figure ) => region.indexOf( figure ) === -1 ) ).toEqual( [] )
        expect( region ).toContain( "note.className = 'graph-warning'" )
        expect( region ).toContain( "emptyBox.className = 'graph-empty'" )
        expect( region ).toContain( 'Kein Graph gezeichnet' )
    } )


    it( 'a load or answer error lands in the shared error state with the REAL server message', () => {
        const start = client.indexOf( 'async function loadGraphView( documentId )' )
        const region = client.slice( start, start + 1800 )

        expect( region ).toContain( "renderViewError( contentTarget, 'Graph konnte nicht geladen werden: ' + graphMsg )" )
        expect( region ).toContain( "var graphMsg = ( payload && payload.error ) ? payload.error : ( 'HTTP ' + resp.status )" )
        expect( region ).toContain( "var step = nextViewState( currentContentView, 'graph' )" )
    } )


    it( 'the security posture is NOT lowered: strict stays strict, 5 network assets stay 5, 0 new deps', () => {
        const strict = client.match( /securityLevel: 'strict'/g ) || []
        const cdn = source.match( /cdn\.jsdelivr\.net/g ) || []
        const deps = Object.keys( manifest[ 'dependencies' ] )

        expect( strict.length ).toBe( 1 )
        expect( cdn.length ).toBe( 5 )                               // the tracer adds no sixth network asset
        expect( deps.length ).toBe( 2 )                              // @dolthub/doltlite + ws, unchanged
        expect( deps.sort() ).toEqual( [ '@dolthub/doltlite', 'ws' ] )
        // no vendored graph library was dropped into the served folder
        expect( client.indexOf( 'cytoscape' ) ).toBe( -1 )
    } )
} )
