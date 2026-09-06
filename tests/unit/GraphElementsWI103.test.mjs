import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { MemoView } from '../../src/MemoView.mjs'
import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'


// WI-103 (Memo 080, Kap 15 — Das Schaufenster; F30 = A: Cytoscape.js). Stage 1 (PRD-V2) shipped the
// graph as a mermaid TILE — a picture, because mermaid runs here with securityLevel 'strict' and strict
// switches its click bindings off. The chapter's Soll-Zustand is an INTERACTIVE graph, which needs an
// element set rather than a text source.
//
// These tests are about the element set staying a faithful SECOND PROJECTION of the same read: same
// node ids, same edge rule, nothing invented, nothing dropped. A test that only checked "elements is an
// array" would survive every interesting regression, so each case names the count it compared.
describe( 'Graph-Elemente fuer die interaktive Anzeige (WI-103, Memo 080 Kap 15, F30 = A)', () => {
    let root = ''
    let withDb = ''
    let withoutDb = ''
    let graph = null


    beforeAll( async () => {
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'graphelements-' ) )
        withDb = join( root, 'with-db' )
        withoutDb = join( root, 'without-db' )
        await mkdir( join( withDb, 'revisions' ), { recursive: true } )
        await mkdir( join( withoutDb, 'revisions' ), { recursive: true } )
        await writeFile( join( withoutDb, 'revisions', 'REV-01.md' ), '# leer\n', 'utf8' )

        // 2 topics · 3 work items · 2 phases · 2 rollout rows. Larger than the stage-1 seed on purpose:
        // one work item carries a topic that does NOT exist (WI-901 -> T999), so the "dangling reference
        // is never invented into a node" rule has something to be violated by.
        const db = new DatabaseSync( join( withDb, 'memo-080.db' ) )
        db.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, spillover TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )

        const topics = [
            [ 'T015', 'M080', 'Graph', 'P9', 'B015' ],
            [ 'T034', 'M080', 'Rohtabellen', 'P9', 'B034' ]
        ]
        topics
            .forEach( ( row ) => db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block ) VALUES ( ?, ?, ?, ?, ? )' ).run( ...row ) )

        const workItems = [
            [ 'WI-102', 'T015', 'Graph Stufe 1', 'erledigt', 'schaufenster' ],
            [ 'WI-103', 'T015', 'Interaktiver Graph, Bausteine mitliefern, Sicherheits-Kopf', 'offen', 'schaufenster' ],
            [ 'WI-901', 'T999', 'Verweis ins Leere', 'offen', 'schaufenster' ]
        ]
        workItems
            .forEach( ( row ) => db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' ).run( ...row ) )

        const phases = [
            [ 'phase-9', 'M080', 'Das Schaufenster', 'open', '{}' ],
            [ 'phase-10', 'M080', 'Abschluss', 'open', '{}' ]
        ]
        phases
            .forEach( ( row ) => db.prepare( 'INSERT INTO rollout_phase ( id, memo_id, name, status, spillover ) VALUES ( ?, ?, ?, ?, ? )' ).run( ...row ) )

        const prds = [
            [ 'WI-102', 'phase-9', 'PRD-V2', 'done', null, 'prd', '{}' ],
            [ 'WI-103', 'phase-9', 'PRD-V12', 'open', null, 'prd', '{}' ]
        ]
        prds
            .forEach( ( row ) => db.prepare( 'INSERT INTO rollout_work_item ( id, phase_id, title, status, target, wi_type, spillover ) VALUES ( ?, ?, ?, ?, ?, ?, ? )' ).run( ...row ) )
        db.close()

        const { dbPath } = MemoView.resolveMemoDbPath( { 'memoPath': withDb } )
        graph = DoltDbAssembler.readKnowledgeGraph( { dbPath } )
    } )


    afterAll( async () => {
        await rm( root, { recursive: true, force: true } )
    } )


    it( 'carries one element per read row — 9 nodes over 4 kinds, counted per kind', () => {
        const nodes = graph[ 'elements' ][ 'nodes' ]
        const byKind = nodes
            .reduce( ( acc, node ) => Object.assign( acc, { [ node[ 'data' ][ 'kind' ] ]: ( acc[ node[ 'data' ][ 'kind' ] ] || 0 ) + 1 } ), {} )

        expect( nodes.length ).toBe( 9 )
        expect( byKind ).toEqual( { 'T': 2, 'W': 3, 'P': 2, 'R': 2 } )
        // and the per-kind counts are exactly the figures the head line states — one read, two shapes
        expect( byKind[ 'T' ] ).toBe( graph[ 'counts' ][ 'topics' ] )
        expect( byKind[ 'W' ] ).toBe( graph[ 'counts' ][ 'workItems' ] )
        expect( byKind[ 'P' ] ).toBe( graph[ 'counts' ][ 'phases' ] )
        expect( byKind[ 'R' ] ).toBe( graph[ 'counts' ][ 'prds' ] )
    } )


    it( 'carries one element per counted edge, family-tagged — 6 edges over 3 families', () => {
        const edges = graph[ 'elements' ][ 'edges' ]
        const byKind = edges
            .reduce( ( acc, edge ) => Object.assign( acc, { [ edge[ 'data' ][ 'kind' ] ]: ( acc[ edge[ 'data' ][ 'kind' ] ] || 0 ) + 1 } ), {} )

        expect( byKind[ 'topic-work-item' ] ).toBe( graph[ 'counts' ][ 'edgesTopicWorkItem' ] )
        expect( byKind[ 'phase-prd' ] ).toBe( graph[ 'counts' ][ 'edgesPhasePrd' ] )
        expect( byKind[ 'topic-prd' ] ).toBe( graph[ 'counts' ][ 'edgesTopicPrd' ] )
        expect( edges.length ).toBe(
            graph[ 'counts' ][ 'edgesTopicWorkItem' ] + graph[ 'counts' ][ 'edgesPhasePrd' ] + graph[ 'counts' ][ 'edgesTopicPrd' ]
        )
        expect( edges.length ).toBe( 6 )
    } )


    it( 'invents no node: every edge endpoint exists among the nodes (12 endpoints checked)', () => {
        const ids = new Set( graph[ 'elements' ][ 'nodes' ].map( ( node ) => node[ 'data' ][ 'id' ] ) )
        const endpoints = graph[ 'elements' ][ 'edges' ]
            .flatMap( ( edge ) => [ edge[ 'data' ][ 'source' ], edge[ 'data' ][ 'target' ] ] )

        expect( endpoints.length ).toBe( 12 )
        expect( endpoints.filter( ( id ) => ids.has( id ) !== true ) ).toEqual( [] )
        // the dangling topic T999 named by WI-901 became NO node and NO edge
        expect( ids.has( 'T_T999' ) ).toBe( false )
        expect( graph[ 'elements' ][ 'edges' ].filter( ( edge ) => edge[ 'data' ][ 'source' ] === 'T_T999' ) ).toEqual( [] )
    } )


    it( 'element ids are unique — cytoscape refuses a duplicate id, so a collision must fail here', () => {
        const nodeIds = graph[ 'elements' ][ 'nodes' ].map( ( node ) => node[ 'data' ][ 'id' ] )
        const edgeIds = graph[ 'elements' ][ 'edges' ].map( ( edge ) => edge[ 'data' ][ 'id' ] )

        expect( new Set( nodeIds ).size ).toBe( nodeIds.length )
        expect( new Set( edgeIds ).size ).toBe( edgeIds.length )
        // the family is part of the edge id, so a topic reaching a PRD directly and over the bridge are
        // two distinct statements instead of one silently swallowing the other
        expect( edgeIds.filter( ( id ) => id.startsWith( 'topic-prd__' ) ).length ).toBe( graph[ 'counts' ][ 'edgesTopicPrd' ] )
    } )


    it( 'the node ids are the SAME ids the mermaid source uses — one identity, not two', () => {
        const ids = graph[ 'elements' ][ 'nodes' ].map( ( node ) => node[ 'data' ][ 'id' ] )
        const missingFromSource = ids
            .filter( ( id ) => graph[ 'mermaid' ].indexOf( id ) === -1 )

        expect( ids.length ).toBe( 9 )
        expect( missingFromSource ).toEqual( [] )
    } )


    it( 'every node carries its untruncated title next to the drawing label', () => {
        const long = graph[ 'elements' ][ 'nodes' ]
            .find( ( node ) => node[ 'data' ][ 'rawId' ] === 'WI-103' )

        expect( long[ 'data' ][ 'title' ] ).toBe( 'Interaktiver Graph, Bausteine mitliefern, Sicherheits-Kopf' )
        expect( long[ 'data' ][ 'label' ] ).toContain( 'WI-103' )
        // the label is capped for the drawing, the title is not — the detail panel shows the full text
        expect( long[ 'data' ][ 'label' ].length ).toBeLessThan( long[ 'data' ][ 'rawId' ].length + long[ 'data' ][ 'title' ].length )
    } )


    // Found by measuring the REAL M080 database through the browser, not by reading code: 426 rows read,
    // 413 distinct identifiers. Thirteen rollout rows repeat an id that already exists, cytoscape keeps
    // the first of each and says nothing — so the head line claimed 426 nodes over a drawing of 413. The
    // mermaid source of stage 1 collapsed them exactly as quietly. The drop is now deterministic, counted
    // and named in the warnings; this case is what keeps it from going silent again.
    it( 'a repeated identifier is dropped ONCE, deterministically, and NAMED — never swallowed', () => {
        const nodes = [
            { 'kind': 'R', 'id': 'R_PRD_2d_D1', 'rawId': 'PRD-D1', 'rawTitle': 'zuerst gelesen' },
            { 'kind': 'R', 'id': 'R_PRD_2d_D1', 'rawId': 'PRD-D1', 'rawTitle': 'zweite Zeile, gleiche Kennung' },
            { 'kind': 'R', 'id': 'R_PRD_2d_D2', 'rawId': 'PRD-D2', 'rawTitle': 'eigenstaendig' }
        ]
        const built = DoltDbAssembler.graphElements( { nodes, 'edgeFamilies': [] } )

        expect( built[ 'nodes' ].length ).toBe( 2 )
        expect( built[ 'droppedDuplicateNodes' ] ).toBe( 1 )
        // first row wins — the choice is deterministic, not "whichever the library happened to keep"
        expect( built[ 'nodes' ][ 0 ][ 'data' ][ 'title' ] ).toBe( 'zuerst gelesen' )
        // and a clean set reports zero, so the field is a real measurement and not a constant
        const clean = DoltDbAssembler.graphElements( { 'nodes': nodes.slice( 1 ), 'edgeFamilies': [] } )

        expect( clean[ 'droppedDuplicateNodes' ] ).toBe( 0 )
    } )


    it( 'the drawn graph never claims more nodes than it draws — figures and drawing are reconciled', () => {
        const drawn = graph[ 'elements' ][ 'nodes' ].length
        const read = graph[ 'counts' ][ 'topics' ] + graph[ 'counts' ][ 'workItems' ]
            + graph[ 'counts' ][ 'phases' ] + graph[ 'counts' ][ 'prds' ]

        // this fixture has no duplicates, so the two agree and no warning is raised …
        expect( drawn ).toBe( read )
        expect( graph[ 'elements' ][ 'droppedDuplicateNodes' ] ).toBe( 0 )
        expect( graph[ 'warnings' ].filter( ( text ) => text.includes( 'Kennung' ) ) ).toEqual( [] )
        // … and where they would NOT agree, the difference has to be stated
        expect( drawn + graph[ 'elements' ][ 'droppedDuplicateNodes' ] ).toBe( read )
    } )


    it( 'a memo without a database answers in the SAME shape — empty elements, never a missing field', () => {
        const resolved = MemoView.resolveMemoDbPath( { 'memoPath': withoutDb } )
        const empty = DoltDbAssembler.emptyGraphElements()

        expect( resolved[ 'status' ] ).toBe( false )
        expect( empty ).toEqual( { 'nodes': [], 'edges': [], 'droppedDuplicateNodes': 0 } )
        expect( Object.keys( empty ) ).toEqual( Object.keys( graph[ 'elements' ] ) )
    } )
} )
