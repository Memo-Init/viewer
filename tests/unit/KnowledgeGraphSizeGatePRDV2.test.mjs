import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'


// PRD-V2 REWORK (Memo 080, Kap 15 / WI-102) — the finding: the graph view printed
// "Topics 102 · Work-Items 223 … — Kanten: …" ABOVE a mermaid error tile. Measured cause: the source of the
// real inventory is 53362 characters, mermaid 11.4.1 runs a maxTextSize of 50000, and above that limit the
// renderer does NOT reject — it discards the source and RESOLVES with a one-node placeholder, so the failure
// was silent and the view claimed a drawing that never happened.
// Two things are proven here: (1) the source that leaves the server FITS a declared budget, with every node
// and every edge still in it, or says in plain words that it does not; (2) the client recognises a resolved
// placeholder as a FAILURE and reports it instead of a success line.
// Every case states HOW MUCH it compared (rows, nodes, edges, characters) — a check without a comparison
// base counts as red, not green.
const here = dirname( fileURLToPath( import.meta.url ) )
const clientSource = resolve( here, '..', '..', 'src', 'public', 'app.client.mjs' )
const assemblerSource = resolve( here, '..', '..', 'src', 'DoltDbAssembler.mjs' )


// One seeded memo database with `topicCount` topics and `workItemCount` work items, each title `titleLength`
// characters long. The title length is the knob the size gate is exercised with: short titles stay under the
// budget, long ones force the condensation ladder, and a very large row count outgrows even bare identifiers.
// `titleLength: 0` seeds EMPTY titles — that renders exactly the source the ladder's last step produces
// (identifier only), which is how the bare-identifier length is measured instead of being frozen as a literal.
const seedGraphDb = ( { dbPath, topicCount, workItemCount, titleLength } ) => {
    const db = new DatabaseSync( dbPath )
    db.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, spillover TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )

    const title = ( prefix, index ) => titleLength === 0 ? '' : `${ prefix }-${ index } ${ 'a'.repeat( Math.max( 0, titleLength ) ) }`
    const insertTopic = db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block ) VALUES ( ?, ?, ?, ?, ? )' )
    const insertWorkItem = db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' )

    Array.from( { length: topicCount } )
        .forEach( ( _, index ) => insertTopic.run( `T${ String( index ).padStart( 4, '0' ) }`, 'M080', title( 'Topic', index ), 'P0', 'B1' ) )
    Array.from( { length: workItemCount } )
        .forEach( ( _, index ) => insertWorkItem.run( `WI-${ String( index ).padStart( 4, '0' ) }`, `T${ String( index % Math.max( 1, topicCount ) ).padStart( 4, '0' ) }`, title( 'Work-Item', index ), 'offen', 'g' ) )
    db.close()

    return { topicCount, workItemCount }
}


const nodeLinesOf = ( source ) => source.split( '\n' ).filter( ( line ) => /^ {4}[A-Za-z0-9_]+\["/.test( line ) === true )
const edgeLinesOf = ( source ) => source.split( '\n' ).filter( ( line ) => line.includes( ' --> ' ) === true )


describe( 'PRD-V2 Rework — der Groessen-Riegel der Diagramm-Quelle (echte Datenbanken)', () => {
    let root = ''


    beforeAll( async () => {
        // Test isolation: write ONLY into the repo-internal .test-tmp/, never .memo/ and never the home.
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'graphsize-' ) )
    } )


    afterAll( async () => {
        await rm( root, { recursive: true, force: true } )
    } )


    it( 'a small inventory is drawn at FULL label width — no cap, no size warning (30 rows, 20 edges)', async () => {
        const dbPath = join( root, 'small.db' )
        const seeded = seedGraphDb( { dbPath, topicCount: 10, workItemCount: 20, titleLength: 30 } )
        const graph = DoltDbAssembler.readKnowledgeGraph( { dbPath } )
        const facts = graph[ 'source' ]

        expect( seeded.topicCount + seeded.workItemCount ).toBe( 30 )
        expect( facts[ 'condensed' ] ).toBe( false )
        expect( facts[ 'labelCap' ] ).toBe( null )
        expect( facts[ 'chars' ] ).toBe( graph[ 'mermaid' ].length )
        expect( facts[ 'chars' ] ).toBe( facts[ 'fullChars' ] )
        expect( facts[ 'chars' ] ).toBeLessThanOrEqual( facts[ 'budget' ] )
        expect( facts[ 'nodes' ] ).toBe( 30 )
        expect( facts[ 'edges' ] ).toBe( 20 )
        // 30 of 30 nodes and 20 of 20 edges are in the source, and the titles are UNTOUCHED
        expect( nodeLinesOf( graph[ 'mermaid' ] ).length ).toBe( 30 )
        expect( edgeLinesOf( graph[ 'mermaid' ] ).length ).toBe( 20 )
        expect( graph[ 'mermaid' ] ).toContain( `Topic-0 ${ 'a'.repeat( 30 ) }` )
        expect( graph[ 'warnings' ].filter( ( text ) => text.includes( 'gekuerzt' ) === true ) ).toEqual( [] )
    } )


    it( 'an oversize inventory is CONDENSED under the budget — every node and every edge survives (600 rows)', async () => {
        const dbPath = join( root, 'oversize.db' )
        seedGraphDb( { dbPath, topicCount: 200, workItemCount: 400, titleLength: 220 } )
        const graph = DoltDbAssembler.readKnowledgeGraph( { dbPath } )
        const facts = graph[ 'source' ]

        // the full-width source would blow the limit — that is the situation the finding described
        expect( facts[ 'fullChars' ] ).toBeGreaterThan( facts[ 'budget' ] )
        // …and what LEAVES the server fits
        expect( facts[ 'condensed' ] ).toBe( true )
        expect( typeof facts[ 'labelCap' ] ).toBe( 'number' )
        expect( facts[ 'chars' ] ).toBe( graph[ 'mermaid' ].length )
        expect( facts[ 'chars' ] ).toBeLessThanOrEqual( facts[ 'budget' ] )
        expect( graph[ 'reason' ] ).toBe( null )
        // NOTHING was dropped to make it fit: 600 of 600 nodes, 400 of 400 edges, counts unchanged
        expect( graph[ 'counts' ][ 'topics' ] ).toBe( 200 )
        expect( graph[ 'counts' ][ 'workItems' ] ).toBe( 400 )
        expect( graph[ 'counts' ][ 'edgesTopicWorkItem' ] ).toBe( 400 )
        expect( nodeLinesOf( graph[ 'mermaid' ] ).length ).toBe( 600 )
        expect( edgeLinesOf( graph[ 'mermaid' ] ).length ).toBe( 400 )
        // and the step that was taken is NAMED with its measured figures, not applied silently
        const condensed = graph[ 'warnings' ].filter( ( text ) => text.includes( 'gekuerzt' ) === true )
        expect( condensed.length ).toBe( 1 )
        expect( condensed[ 0 ] ).toContain( String( facts[ 'labelCap' ] ) )
        expect( condensed[ 0 ] ).toContain( String( facts[ 'fullChars' ] ) )
        expect( condensed[ 0 ] ).toContain( String( facts[ 'budget' ] ) )
    } )


    it( 'the cut runs on the RAW title, so no condensed label carries a broken entity or a bare quote (600 labels)', async () => {
        const dbPath = join( root, 'quotes.db' )
        const db = new DatabaseSync( dbPath )
        db.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
        const insert = db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block ) VALUES ( ?, ?, ?, ?, ? )' )
        // The quote sits exactly ON the cut boundary of every ladder step that can be reached here, and the
        // padding forces the ladder to run at all.
        Array.from( { length: 600 } )
            .forEach( ( _, index ) => insert.run( `T${ String( index ).padStart( 4, '0' ) }`, 'M080',
                `${ 'b'.repeat( 15 ) }"[]${ 'c'.repeat( 300 ) }`, 'P0', 'B1' ) )
        db.close()

        const graph = DoltDbAssembler.readKnowledgeGraph( { dbPath } )
        const lines = nodeLinesOf( graph[ 'mermaid' ] )

        expect( graph[ 'source' ][ 'condensed' ] ).toBe( true )
        expect( lines.length ).toBe( 600 )
        // 600 of 600 node lines are a well-formed `id["label"]` with no raw quote or bracket inside
        expect( lines.filter( ( line ) => /^ {4}[A-Za-z0-9_]+\["[^"[\]]*"\]$/.test( line ) === false ) ).toEqual( [] )
        // no half-written entity survived the cut — every `#` inside a LABEL belongs to a complete code
        // (the classDef lines carry `#`-colours and are deliberately not part of this comparison base)
        const entities = lines.join( '\n' ).match( /#[A-Za-z0-9]*;?/g ) || []
        expect( entities.length ).toBeGreaterThan( 0 )
        expect( entities.filter( ( entity ) => /^#(quot|91|93|35|123|125|60|62|124|96);$/.test( entity ) === false ) ).toEqual( [] )
    } )


    it( 'an inventory too large even for bare identifiers is NOT drawn and says so (1400 rows)', async () => {
        const dbPath = join( root, 'huge.db' )
        seedGraphDb( { dbPath, topicCount: 700, workItemCount: 700, titleLength: 200 } )
        const graph = DoltDbAssembler.readKnowledgeGraph( { dbPath } )
        const facts = graph[ 'source' ]

        expect( graph[ 'mermaid' ] ).toBe( null )
        expect( graph[ 'reason' ] ).toBe( 'source-too-large' )
        expect( graph[ 'empty' ] ).toBe( false )
        // the figures are still reported in full — 1400 of 1400 nodes, 700 of 700 edges
        expect( facts[ 'nodes' ] ).toBe( 1400 )
        expect( facts[ 'edges' ] ).toBe( 700 )
        expect( facts[ 'chars' ] ).toBeGreaterThan( facts[ 'budget' ] )
        expect( graph[ 'counts' ][ 'topics' ] ).toBe( 700 )
        // The reported figure is the one the sentence is ABOUT: the source with bare identifiers, not the
        // full-width source. Measured, not frozen — the SAME 1400 ids with empty titles render exactly the
        // bare-identifier source, so its full width is the number the gate has to name (69622 against 370402
        // at full width on this seed; `npm test -- KnowledgeGraphSizeGatePRDV2` re-measures both).
        const barePath = join( root, 'huge-bare.db' )
        seedGraphDb( { dbPath: barePath, topicCount: 700, workItemCount: 700, titleLength: 0 } )
        const bare = DoltDbAssembler.readKnowledgeGraph( { dbPath: barePath } )

        expect( bare[ 'source' ][ 'nodes' ] ).toBe( facts[ 'nodes' ] )
        expect( facts[ 'chars' ] ).toBe( bare[ 'source' ][ 'fullChars' ] )
        expect( facts[ 'chars' ] ).toBeLessThan( facts[ 'fullChars' ] )
        const tooLarge = graph[ 'warnings' ].filter( ( text ) => text.includes( 'Nicht gezeichnet' ) === true )
        expect( tooLarge.length ).toBe( 1 )
        expect( tooLarge[ 0 ] ).toContain( String( facts[ 'budget' ] ) )
        // both measured lengths are named, each for what it is
        expect( tooLarge[ 0 ] ).toContain( String( facts[ 'chars' ] ) )
        expect( tooLarge[ 0 ] ).toContain( String( facts[ 'fullChars' ] ) )
    } )


    it( 'the empty and the no-database answer speak the same seven-field source shape (7 of 7 fields)', async () => {
        const dbPath = join( root, 'empty.db' )
        seedGraphDb( { dbPath, topicCount: 0, workItemCount: 0, titleLength: 0 } )
        const graph = DoltDbAssembler.readKnowledgeGraph( { dbPath } )
        const noDb = DoltDbAssembler.emptyGraphSourceFacts()

        expect( Object.keys( noDb ).sort() ).toEqual( [ 'budget', 'chars', 'condensed', 'edges', 'fullChars', 'labelCap', 'nodes' ] )
        expect( Object.keys( graph[ 'source' ] ).sort() ).toEqual( Object.keys( noDb ).sort() )
        expect( graph[ 'reason' ] ).toBe( 'empty-db' )
        expect( graph[ 'source' ] ).toEqual( noDb )
    } )
} )


describe( 'PRD-V2 Rework — Server-Budget und Client-Grenze duerfen nicht auseinanderlaufen', () => {
    it( 'the server budget lies strictly BELOW the limit the client declares (two measured numbers)', async () => {
        const assembler = await readFile( assemblerSource, 'utf-8' )
        const client = await readFile( clientSource, 'utf-8' )
        const budget = assembler.match( /const GRAPH_SOURCE_BUDGET = (\d+)/ )
        const limit = client.match( /var MERMAID_MAX_TEXT_SIZE = (\d+)/ )

        expect( budget ).not.toBe( null )
        expect( limit ).not.toBe( null )
        expect( Number( budget[ 1 ] ) ).toBeLessThan( Number( limit[ 1 ] ) )
        // the limit is the value mermaid 11.4.1 actually runs (measured via mermaidAPI.getConfig()), so the
        // declaration mirrors the library instead of raising its guard
        expect( Number( limit[ 1 ] ) ).toBe( 50000 )
        expect( DoltDbAssembler.emptyGraphSourceFacts()[ 'budget' ] ).toBe( Number( budget[ 1 ] ) )
    } )


    it( 'the declared limit is handed to mermaid.initialize and strict stays strict (3 anchors)', async () => {
        const client = await readFile( clientSource, 'utf-8' )

        expect( client ).toContain( 'maxTextSize: MERMAID_MAX_TEXT_SIZE' )
        expect( ( client.match( /securityLevel: 'strict'/g ) || [] ).length ).toBe( 1 )
        expect( client ).not.toContain( "securityLevel: 'loose'" )
    } )
} )


describe( 'PRD-V2 Rework — der Client erkennt die Platzhalter-Kachel als Fehlschlag', () => {
    let client = ''
    let mermaidDrawFailure = null


    beforeAll( async () => {
        client = await readFile( clientSource, 'utf-8' )
        // The two declarations plus the function are lifted out of the served client script and evaluated —
        // this is a BEHAVIOURAL check of the real source, not a string match on it.
        const declarations = ( client.match( /var MERMAID_MAX_TEXT_SIZE = \d+/ ) || [] )[ 0 ]
            + '\n' + ( client.match( /var MERMAID_OVERSIZE_MARKER = '[^']+'/ ) || [] )[ 0 ]
        const start = client.indexOf( 'function mermaidDrawFailure( spec, svg ) {' )
        const end = client.indexOf( '// Memo 020 Kap 6 (pt 1)', start )
        const body = client.slice( start, end )

        mermaidDrawFailure = new Function( declarations + '\n' + body + '\nreturn mermaidDrawFailure' )()
    } )


    it( 'a source ABOVE the declared limit is a failure before the renderer is even asked', () => {
        const oversize = 'flowchart LR\n' + 'x'.repeat( 60000 )
        const reason = mermaidDrawFailure( oversize, null )

        expect( oversize.length ).toBeGreaterThan( 50000 )
        expect( typeof reason ).toBe( 'string' )
        expect( reason ).toContain( String( oversize.length ) )
        expect( reason ).toContain( '50000' )
    } )


    it( 'a RESOLVED result carrying mermaid substitution tile is a failure, not a success', () => {
        const spec = 'flowchart LR\n    A["a"] --> B["b"]'
        const placeholder = '<svg id="m1"><g class="node"><span>Maximum text size in diagram exceeded</span></g></svg>'
        const reason = mermaidDrawFailure( spec, placeholder )

        expect( spec.length ).toBeLessThan( 50000 )
        expect( typeof reason ).toBe( 'string' )
        expect( reason ).toContain( 'Platzhalter-Kachel' )
    } )


    it( 'a real drawing is NOT reported as a failure, and a diagram about the marker is not either (2 of 2)', () => {
        const spec = 'flowchart LR\n    A["a"] --> B["b"]'
        const realSvg = '<svg id="m1" aria-roledescription="flowchart-v2"><style>#m1 .error-icon{fill:#552222;}</style><g class="node"></g></svg>'
        // the CSS markers `error-icon` / `error-text` are in EVERY flowchart svg — they must not be read as a failure
        expect( realSvg ).toContain( 'error-icon' )
        expect( mermaidDrawFailure( spec, realSvg ) ).toBe( null )

        // a diagram whose OWN source talks about the limit is not mistaken for a substituted one
        const aboutSpec = 'flowchart LR\n    A["Maximum text size in diagram exceeded"]'
        const aboutSvg = '<svg><text>Maximum text size in diagram exceeded</text></svg>'
        expect( mermaidDrawFailure( aboutSpec, aboutSvg ) ).toBe( null )
    } )


    it( 'the registry answers whether it drew, and the graph view turns a failed draw into the shared error state', () => {
        const registryStart = client.indexOf( 'var diagramRegistry = {' )
        const registryEnd = client.indexOf( 'function renderAllDiagrams()', registryStart )
        const registry = client.slice( registryStart, registryEnd )
        const viewStart = client.indexOf( 'function renderGraphView( payload, contentTarget )' )
        const viewEnd = client.indexOf( 'async function loadGraphView( documentId )', viewStart )
        const view = client.slice( viewStart, viewEnd )

        expect( registryStart ).toBeGreaterThan( -1 )
        expect( registryEnd ).toBeGreaterThan( registryStart )
        // both ends of the check sit in the ONE registry entry — before the call and on the result
        expect( ( registry.match( /mermaidDrawFailure\(/g ) || [] ).length ).toBe( 2 )
        expect( registry ).toContain( 'return { ok: true, error: null, el: el }' )
        expect( registry ).toContain( 'buildMermaidErrorHtml( new Error( substituted ), spec )' )
        // The graph view still never leaves the count line standing over a failed drawing — WI-103
        // (Memo 080 Kap 15, F30 = A) only changed WHICH renderer can fail there. The mermaid
        // placeholder-tile gate above keeps guarding the prose ```mermaid path, which is untouched;
        // the graph view draws with cytoscape and routes ITS failure into the same shared error state,
        // carrying the same measured figures.
        expect( viewStart ).toBeGreaterThan( -1 )
        expect( ( view.match( /renderAllDiagrams\(\)/g ) || [] ).length ).toBe( 0 )
        expect( view ).toContain( "renderViewError( contentTarget, 'Graph konnte nicht gezeichnet werden: '" )
        expect( view ).toContain( "' — gemessen: ' + headText" )
        expect( view ).toContain( 'graphInstance = cytoscape( {' )
        // and the size gate itself is no longer a reason to show nothing: cytoscape has no text budget,
        // so the element set is drawn even when the mermaid source was over budget
        expect( view ).toContain( 'var elementNodes = ( elements && elements.nodes ) ? elements.nodes : []' )
        expect( view.indexOf( 'payload.mermaid' ) ).toBe( -1 )
    } )


    it( 'renderAllDiagrams reports one outcome per element and unmarks a failed one for a retry (3 elements)', async () => {
        const marker = 'function renderAllDiagrams('
        const start = client.indexOf( marker )
        const end = client.indexOf( '// Memo 020 Kap 4: a node sits "inside a diagram"', start )
        const body = client.slice( start, end )
        const renderAllDiagrams = new Function( 'document', 'diagramRegistry', body + '\nreturn renderAllDiagrams' )

        const makeEl = ( id, src ) => ( {
            id: id, dataset: {}, innerHTML: '',
            getAttribute: function( name ) { return name === 'data-src' ? src : null },
            textContent: src
        } )
        const good = makeEl( 'ok', 'flowchart LR' )
        const bad = makeEl( 'bad', 'flowchart LR' )
        const silent = makeEl( 'silent', '{}' )
        const fakeDocument = { querySelectorAll: function( selector ) {
            return selector === '.mermaid' ? [ good, bad ] : [ silent ]
        } }
        const fakeRegistry = {
            mermaid: { selector: '.mermaid', render: function( spec, el ) {
                return Promise.resolve( el.id === 'bad' ? { ok: false, error: 'zu gross', el: el } : { ok: true, error: null, el: el } )
            } },
            'vega-lite': { selector: '.vega-lite', render: function() { return undefined } }
        }

        const outcomes = await renderAllDiagrams( fakeDocument, fakeRegistry )()

        // 3 of 3 elements answered, exactly 1 of them as a failure
        expect( outcomes.length ).toBe( 3 )
        expect( outcomes.filter( ( status ) => status.ok === false ).length ).toBe( 1 )
        expect( outcomes.filter( ( status ) => status.ok === false )[ 0 ].error ).toBe( 'zu gross' )
        // a hook that answers nothing counts as drawn — no invented failure
        expect( outcomes.filter( ( status ) => status.el === silent )[ 0 ].ok ).toBe( true )
        // the failed element is unmarked (retryable), the drawn ones keep their guard
        expect( bad.dataset.renderedSrc ).toBe( '' )
        expect( good.dataset.renderedSrc ).toBe( 'flowchart LR' )
    } )
} )
