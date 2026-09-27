import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { MemoView } from '../../src/MemoView.mjs'
import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'
import { extractFunctions, readEmittedScript } from '../helpers/extractFunction.mjs'


// WI-233 (Memo 082 Kap 33, S2 — "der Graph zeigt nichts"). The measurement said something sharper than
// the report: the data are NOT empty. On memo-082 at build time the graph read 348 nodes and 256 edges.
// What was missing is READABILITY — and one relation that the carrier held and the drawing threw away:
// `topic.block` was in the SELECT and never became an edge.
//
// Two things are proven here. First, that the discarded binding now becomes an edge, counted against a
// NAMED fixture whose P (topics) and Q (topics with a resolvable block) are both stated and both > 0 —
// against an empty fixture "0 edges built" would be trivially true and would prove nothing. Second,
// that the three toolbar instruments work in BOTH directions, driven through the REAL client functions
// lifted out of app.client.mjs rather than through a replica of them.
describe( 'PRD-12 — Block-Kanten aus topic.block (WI-233, Memo 082 Kap 33, S2)', () => {
    let root = ''
    let withBlocks = ''
    let emptyCarrier = ''
    let graph = null
    let emptyGraph = null

    // The named fixture, spelled out so every figure below has a comparison set. P = 5 topics, of which
    // Q = 3 carry a block binding that RESOLVES against the block table. One topic points at a block
    // nobody wrote (B909) and one carries no binding at all — three different facts that a single "has a
    // block" count would collapse into one.
    const FIXTURE_TOPICS = 5
    const FIXTURE_TOPICS_WITH_RESOLVABLE_BLOCK = 3
    const FIXTURE_TOPICS_WITH_DANGLING_BLOCK = 1
    const FIXTURE_BLOCKS = 3


    beforeAll( async () => {
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'p9-prd12-blockedges-' ) )
        withBlocks = join( root, 'with-blocks' )
        emptyCarrier = join( root, 'empty-carrier' )
        await mkdir( join( withBlocks, 'revisions' ), { recursive: true } )
        await mkdir( join( emptyCarrier, 'revisions' ), { recursive: true } )

        const db = new DatabaseSync( join( withBlocks, 'memo-082.db' ) )
        db.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, spillover TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, sort INTEGER )' )

        const topics = [
            [ 'T001', 'M082', 'Orchestrator-Rolle', 'P9', 'B001' ],
            [ 'T002', 'M082', 'Dynamische Workflows', 'P9', 'B001' ],
            [ 'T003', 'M082', 'Viewer-Befunde', 'P9', 'B002' ],
            [ 'T004', 'M082', 'Verweis ins Leere', 'P9', 'B909' ],
            [ 'T005', 'M082', 'Ohne Blockbindung', 'P9', null ]
        ]
        topics
            .forEach( ( row ) => db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block ) VALUES ( ?, ?, ?, ?, ? )' ).run( ...row ) )

        const blocks = [
            [ 'B001', 'M082', 'Der Orchestrator', 1 ],
            [ 'B002', 'M082', 'Das Schaufenster', 2 ],
            [ 'B003', 'M082', 'Von keinem Topic benannt', 3 ]
        ]
        blocks
            .forEach( ( row ) => db.prepare( 'INSERT INTO block ( id, memo_id, title, sort ) VALUES ( ?, ?, ?, ? )' ).run( ...row ) )

        const workItems = [
            [ 'WI-232', 'T003', 'Graph-Button-Optik', 'offen', 'p9-viewer-befunde' ],
            [ 'WI-233', 'T003', 'Graph-Toolbar und Block-Knoten', 'offen', 'p9-viewer-befunde' ],
            [ 'WI-901', 'T001', 'Orchestrator-Vertrag', 'offen', 'p9-orchestrator' ]
        ]
        workItems
            .forEach( ( row ) => db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' ).run( ...row ) )
        db.close()

        // The vacuum control: the SAME five tables, no rows at all. Its zero has to be a NAMED empty,
        // not a quiet pass — that is the difference this fixture exists to make measurable.
        const bare = new DatabaseSync( join( emptyCarrier, 'memo-083.db' ) )
        bare.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT )' )
        bare.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
        bare.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, spillover TEXT )' )
        bare.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )
        bare.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, sort INTEGER )' )
        bare.close()

        graph = DoltDbAssembler.readKnowledgeGraph( { 'dbPath': MemoView.resolveMemoDbPath( { 'memoPath': withBlocks } )[ 'dbPath' ] } )
        emptyGraph = DoltDbAssembler.readKnowledgeGraph( { 'dbPath': MemoView.resolveMemoDbPath( { 'memoPath': emptyCarrier } )[ 'dbPath' ] } )
    } )


    afterAll( async () => {
        await rm( root, { recursive: true, force: true } )
    } )


    // AB-7. The claim is not "some edges were built" but "exactly Q edges were built", with P and Q
    // named and both greater than zero.
    it( 'baut GENAU Q Block-Kanten — Vergleichsmenge P=5 Topics, davon Q=3 mit aufloesbarer Bindung', () => {
        expect( FIXTURE_TOPICS ).toBeGreaterThan( 0 )
        expect( FIXTURE_TOPICS_WITH_RESOLVABLE_BLOCK ).toBeGreaterThan( 0 )
        expect( graph[ 'counts' ][ 'topics' ] ).toBe( FIXTURE_TOPICS )
        expect( graph[ 'counts' ][ 'blocks' ] ).toBe( FIXTURE_BLOCKS )
        expect( graph[ 'counts' ][ 'edgesBlockTopic' ] ).toBe( FIXTURE_TOPICS_WITH_RESOLVABLE_BLOCK )

        const blockEdges = graph[ 'elements' ][ 'edges' ]
            .filter( ( edge ) => edge[ 'data' ][ 'kind' ] === 'block-topic' )

        expect( blockEdges.length ).toBe( FIXTURE_TOPICS_WITH_RESOLVABLE_BLOCK )
        expect( blockEdges.map( ( edge ) => edge[ 'data' ][ 'id' ] ).sort() ).toEqual( [
            'block-topic__B_B001__T_T001', 'block-topic__B_B001__T_T002', 'block-topic__B_B002__T_T003'
        ] )
    } )


    it( 'erfindet keinen Block: die haengende Bindung B909 wird NICHT gezeichnet und NAMENTLICH gemeldet', () => {
        const ids = new Set( graph[ 'elements' ][ 'nodes' ].map( ( node ) => node[ 'data' ][ 'id' ] ) )

        expect( ids.has( 'B_B909' ) ).toBe( false )
        expect( graph[ 'elements' ][ 'edges' ].filter( ( edge ) => edge[ 'data' ][ 'source' ] === 'B_B909' ) ).toEqual( [] )

        const named = graph[ 'warnings' ]
            .filter( ( text ) => text.indexOf( 'Topic-Zeile(n) verweisen auf einen Block' ) !== -1 )

        expect( named.length ).toBe( 1 )
        expect( named[ 0 ] ).toContain( `Auffaellig: ${ FIXTURE_TOPICS_WITH_DANGLING_BLOCK } ` )
    } )


    it( 'der Block ist ein KNOTEN — 3 von 3 Bloecken gezeichnet, auch der von keinem Topic benannte', () => {
        const byKind = graph[ 'elements' ][ 'nodes' ]
            .reduce( ( acc, node ) => Object.assign( acc, { [ node[ 'data' ][ 'kind' ] ]: ( acc[ node[ 'data' ][ 'kind' ] ] || 0 ) + 1 } ), {} )

        expect( byKind[ 'B' ] ).toBe( FIXTURE_BLOCKS )
        expect( byKind[ 'B' ] ).toBe( graph[ 'counts' ][ 'blocks' ] )
        // and the head-line arithmetic still reconciles over FIVE kinds, not four
        const read = graph[ 'counts' ][ 'topics' ] + graph[ 'counts' ][ 'workItems' ]
            + graph[ 'counts' ][ 'phases' ] + graph[ 'counts' ][ 'prds' ] + graph[ 'counts' ][ 'blocks' ]

        expect( graph[ 'elements' ][ 'nodes' ].length + graph[ 'elements' ][ 'droppedDuplicateNodes' ] ).toBe( read )
    } )


    // D7 / vacuum probe. A rule that answers "0 edges" over an empty carrier has measured NOTHING, and
    // the test says so: the zero is only accepted together with the named empty reason. The positive
    // control stands next to it, so the assertion cannot be satisfied by a rule that always returns 0.
    it( 'Vakuum-Probe: ueber einen leeren Traeger ist die 0 ein BENANNTER Befund, kein Bestehen', () => {
        expect( emptyGraph[ 'counts' ][ 'edgesBlockTopic' ] ).toBe( 0 )
        expect( emptyGraph[ 'counts' ][ 'blocks' ] ).toBe( 0 )
        expect( emptyGraph[ 'empty' ] ).toBe( true )
        expect( emptyGraph[ 'reason' ] ).toBe( 'empty-db' )
        expect( emptyGraph[ 'warnings' ].filter( ( text ) => text.indexOf( 'block' ) !== -1 ).length ).toBe( 1 )
        // positive control over the SAME rule: the populated carrier answers non-zero
        expect( graph[ 'counts' ][ 'edgesBlockTopic' ] ).toBeGreaterThan( 0 )
    } )


    it( 'die Zaehlung traegt alle neun Groessen — leerer und gefuellter Pfad sprechen dieselbe Form', () => {
        expect( Object.keys( graph[ 'counts' ] ).length ).toBe( 9 )
        expect( Object.keys( graph[ 'counts' ] ) ).toEqual( Object.keys( DoltDbAssembler.emptyGraphCounts() ) )
        expect( Object.keys( graph[ 'counts' ] ) ).toEqual( Object.keys( emptyGraph[ 'counts' ] ) )
    } )
} )


describe( 'PRD-12 — die drei Werkzeuge der Toolbar (WI-233, Memo 082 Kap 33, S1/S3)', () => {
    let tools = null
    let client = ''
    let baseNodes = []
    let baseEdges = []

    const allKindsOn = () => ( { 'T': true, 'W': true, 'P': true, 'R': true, 'B': true } )

    // The element set the toolbar operates on, in the shape the server hands over: five topics over two
    // blocks plus three work items. Built here rather than read from a database, because the subject of
    // this block is the toolbar rule, not the read — and a rule driven by a replica of the shape would
    // stop measuring the moment the real shape changed.
    const nodeOf = ( kind, rawId, title, groupTopic, groupBlock ) => ( { 'data': {
        'id': `${ kind }_${ rawId.replace( /-/g, '_2d_' ) }`, kind, rawId, 'label': `${ rawId } ${ title }`,
        title, groupTopic, groupBlock
    } } )
    const edgeOf = ( kind, source, target ) => ( { 'data': { 'id': `${ kind }__${ source }__${ target }`, source, target, kind } } )


    beforeAll( async () => {
        tools = await extractFunctions( [ 'buildGraphDrawSet', 'graphPlainNode', 'graphLayoutOptions' ], [ 'GRAPH_LAYOUT_PRESETS' ] )
        client = await readEmittedScript()

        baseNodes = [
            nodeOf( 'B', 'B001', 'Der Orchestrator', '', 'B001' ),
            nodeOf( 'B', 'B002', 'Das Schaufenster', '', 'B002' ),
            nodeOf( 'T', 'T001', 'Orchestrator-Rolle', 'T001', 'B001' ),
            nodeOf( 'T', 'T003', 'Viewer-Befunde', 'T003', 'B002' ),
            nodeOf( 'W', 'WI-232', 'Graph-Button-Optik', 'T003', 'B002' ),
            nodeOf( 'W', 'WI-233', 'Graph-Toolbar', 'T003', 'B002' ),
            nodeOf( 'P', 'phase-9', 'Frage-Viewer', '', '' )
        ]
        baseEdges = [
            edgeOf( 'block-topic', 'B_B001', 'T_T001' ),
            edgeOf( 'block-topic', 'B_B002', 'T_T003' ),
            edgeOf( 'topic-work-item', 'T_T003', 'W_WI_2d_232' ),
            edgeOf( 'topic-work-item', 'T_T003', 'W_WI_2d_233' )
        ]
    } )


    it( 'die Werkzeuge sind die ECHTEN Client-Funktionen, nicht nachgebaut — 3 von 3 gehoben', () => {
        expect( typeof tools[ 'buildGraphDrawSet' ] ).toBe( 'function' )
        expect( typeof tools[ 'graphPlainNode' ] ).toBe( 'function' )
        expect( typeof tools[ 'graphLayoutOptions' ] ).toBe( 'function' )
    } )


    // AB-1 on the rule side: the filter changes the SET, and switching back restores it exactly.
    it( 'Kind-Filter: ausschalten verkleinert die Menge, einschalten stellt sie ZEICHENGLEICH her', () => {
        const before = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'none', 'layout': 'cose' } )
        const withoutWorkItems = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': Object.assign( allKindsOn(), { 'W': false } ), 'group': 'none', 'layout': 'cose' } )
        const again = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'none', 'layout': 'cose' } )

        expect( before.nodes.length ).toBe( 7 )
        expect( withoutWorkItems.nodes.length ).toBe( 5 )
        expect( withoutWorkItems.nodes.length ).toBeLessThan( before.nodes.length )
        expect( again.nodes.length ).toBe( before.nodes.length )
        expect( JSON.stringify( again ) ).toBe( JSON.stringify( before ) )
    } )


    it( 'Kind-Filter: eine Kante ueberlebt nur, wenn BEIDE Enden sichtbar sind — 4 gegen 2 Kanten', () => {
        const all = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'none', 'layout': 'cose' } )
        const withoutBlocks = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': Object.assign( allKindsOn(), { 'B': false } ), 'group': 'none', 'layout': 'cose' } )

        expect( all.edges.length ).toBe( 4 )
        expect( withoutBlocks.edges.length ).toBe( 2 )
        expect( withoutBlocks.edges.filter( ( edge ) => edge.data.kind === 'block-topic' ) ).toEqual( [] )
    } )


    // AB-5 on the rule side: the state the message belongs to is reachable and it is EMPTY, so the view
    // has something to say "0 von N" about. The message text itself is measured in the browser run.
    it( 'alle Arten aus ⇒ 0 sichtbare Knoten bei Vergleichsmenge 7 — der Zustand, den S3 benennen muss', () => {
        const nothing = tools.buildGraphDrawSet( baseNodes, baseEdges, {
            'kinds': { 'T': false, 'W': false, 'P': false, 'R': false, 'B': false }, 'group': 'none', 'layout': 'cose'
        } )

        expect( baseNodes.length ).toBe( 7 )
        expect( nothing.nodes.length ).toBe( 0 )
        expect( nothing.edges.length ).toBe( 0 )
    } )


    it( 'die Leermengen-Meldung nennt N aus der aktuellen Menge, nicht aus einer Konstanten', () => {
        const start = client.indexOf( 'function drawGraph()' )
        const region = client.slice( start, start + 2400 )

        expect( start ).toBeGreaterThan( -1 )
        expect( region ).toContain( "'0 von ' + elementNodes.length + ' Knoten sichtbar" )
        // the empty box is a named state, distinguishable from the "no rows at all" one above it
        expect( client ).toContain( "filterEmpty.setAttribute( 'data-graph-empty', 'filter' )" )
        expect( client ).toContain( "emptyBox.setAttribute( 'data-graph-empty', '1' )" )
    } )


    // AB-2 on the rule side: grouping produces COMPOUND parents, in all three states, and returning to
    // "nicht gruppieren" removes them again.
    it( 'Gruppierung: alle drei Zustaende — 0 Gruppen, 2 Topic-Gruppen, 2 Block-Gruppen, wieder 0', () => {
        const none = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'none', 'layout': 'cose' } )
        const byTopic = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'topic', 'layout': 'cose' } )
        const byBlock = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'block', 'layout': 'cose' } )
        const back = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'none', 'layout': 'cose' } )

        expect( none.groupNodes.length ).toBe( 0 )
        expect( byTopic.groupNodes.length ).toBe( 2 )
        expect( byBlock.groupNodes.length ).toBe( 2 )
        expect( back.groupNodes.length ).toBe( 0 )
        expect( JSON.stringify( back ) ).toBe( JSON.stringify( none ) )
    } )


    it( 'Gruppierung ist STRUKTUR, nicht Anordnung: die Mitglieder tragen parent, der Rest nicht', () => {
        const byBlock = tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'block', 'layout': 'cose' } )
        const members = byBlock.nodes.filter( ( node ) => node.data.parent !== undefined )
        const phase = byBlock.nodes.filter( ( node ) => node.data.rawId === 'phase-9' )[ 0 ]

        // 6 of the 7 nodes carry a block; the phase carries none and stays unparented instead of being
        // swept into an invented "rest" group
        expect( members.length ).toBe( 6 )
        expect( phase.data.parent ).toBe( undefined )
        // B002 holds FOUR: the block node itself plus its topic and that topic's two work items. The
        // block belongs inside its own territory — leaving it outside would put every one of its edges
        // across the group boundary, which is the opposite of what grouping is for.
        expect( byBlock.nodes.filter( ( node ) => node.data.parent === 'G__block__B002' ).length ).toBe( 4 )
        // the group caption is taken from the OWNING node, never invented
        expect( byBlock.groupNodes.filter( ( node ) => node.data.id === 'G__block__B002' )[ 0 ].data.label )
            .toBe( 'B002 — Das Schaufenster' )
    } )


    it( 'die Gruppierung laesst die BASIS unberuehrt — ein Umschalten faerbt nicht auf den naechsten ab', () => {
        const before = JSON.stringify( baseNodes )
        tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'block', 'layout': 'cose' } )
        tools.buildGraphDrawSet( baseNodes, baseEdges, { 'kinds': allKindsOn(), 'group': 'topic', 'layout': 'cose' } )

        expect( JSON.stringify( baseNodes ) ).toBe( before )
        expect( baseNodes.filter( ( node ) => node.data.parent !== undefined ) ).toEqual( [] )
    } )


    // AB-4 on the rule side: there is more than one arrangement, they are DIFFERENT, and an unknown key
    // falls back to a real layout instead of to none at all.
    it( 'Layout-Presets: 4 benannte Anordnungen, je verschieden, die heutige bleibt die erste', () => {
        const names = GRAPH_LAYOUT_PRESET_KEYS( client )

        expect( names.length ).toBeGreaterThanOrEqual( 2 )
        expect( names[ 0 ] ).toBe( 'cose' )
        expect( new Set( names ).size ).toBe( names.length )
        expect( tools.graphLayoutOptions( 'cose' ).name ).toBe( 'cose' )
        expect( tools.graphLayoutOptions( 'concentric' ).name ).toBe( 'concentric' )
        expect( tools.graphLayoutOptions( 'cose' ).name ).not.toBe( tools.graphLayoutOptions( 'concentric' ).name )
        // an unknown key never becomes "no layout" — that would stack every node on the origin and look
        // like a drawing failure rather than like a wrong key
        expect( tools.graphLayoutOptions( 'gibt-es-nicht' ).name ).toBe( 'cose' )
    } )


    it( 'der Betrachter kennt fuenf Arten und vier Kantenfamilien — Block ist keine Sonderbehandlung', () => {
        const kinds = ( client.match( /\{ kind: '[TWPRB]', fill: '#[0-9a-f]{6}'/g ) || [] )

        expect( kinds.length ).toBe( 5 )
        expect( client ).toContain( "GRAPH_KIND_LABELS = { T: 'Topic', W: 'Work-Item', P: 'Phase', R: 'PRD', B: 'Block' }" )
        expect( client ).toContain( "selector: 'edge[kind = \"block-topic\"]'" )
        expect( client ).toContain( "' · Blöcke ' + num( counts.blocks )" )
        expect( client ).toContain( "' · Block→Topic ' + num( counts.edgesBlockTopic )" )
    } )
} )


// The preset keys as the CLIENT declares them — read out of the source, so the test cannot pass against
// a list that only the test knows. Kept out of the describe body so it reads as what it is: a reader of
// the production declaration, not a second copy of it.
function GRAPH_LAYOUT_PRESET_KEYS( client ) {
    const start = client.indexOf( 'var GRAPH_LAYOUT_PRESETS = [' )
    const end = client.indexOf( '\n        ]', start )

    return ( client.slice( start, end ).match( /\{ key: '([a-z]+)'/g ) || [] )
        .map( ( entry ) => entry.replace( /^\{ key: '/, '' ).replace( /'$/, '' ) )
}
