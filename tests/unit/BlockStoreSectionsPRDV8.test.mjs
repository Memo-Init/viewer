import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { MemoView } from '../../src/MemoView.mjs'
import { extractFunctionSources, readMemoViewSource, readMemoViewStyles, readEmittedScript } from '../helpers/extractFunction.mjs'


// PRD-V8 (Memo 080 Kap 16, T080, WI-153 display half / WI-203) — block-bound display of topics and
// work items.
//
// Four kinds of proof, in rising order of strength:
//   1. fixture runs — the real reader against a real temp memo dir (archived / broken / missing dir),
//   2. pure runs    — MemoView.blockStoreSections against hand-built stores (grouping, sums, sorting),
//   3. real store   — the same statics against the ACTUAL store of memo 080, skip-guarded because CI
//                     checks out this repo ALONE (the guard that tore 31 cases in P1),
//   4. real runs    — the client functions LIFTED OUT of app.client.mjs and EXECUTED in a vm sandbox
//                     against a hand-built DOM. No jsdom in this repo; this is the technique
//                     ResearchOverlayPRDV6 / AnnotationApparatusPRDV7 use.
//
// Deliberately NOT covered: the browser (real click, real collapse). See the unit report.


const REAL_MEMO_DIR = resolve( fileURLToPath( new URL( '../../../../.memo/memos/080-db-vollausbau-und-laufzeit-transparenz', import.meta.url ) ) )


// ---- a minimal DOM, built for exactly the calls the injected display makes ----

const makeText = ( value ) => ( { nodeType: 3, nodeValue: String( value ), parentNode: null, textContent: String( value ) } )


const selectorMatches = ( el, selector ) => {
    const text = String( selector )

    if( text.startsWith( '.' ) === true ) {
        return String( el.className ).split( ' ' ).includes( text.slice( 1 ) )
    }

    return el.tagName === text.toUpperCase()
}


const elementDescendants = ( el ) => el.childNodes
    .filter( ( child ) => child.nodeType === 1 )
    .flatMap( ( child ) => [ child ].concat( elementDescendants( child ) ) )


const makeElement = ( tag ) => {
    const el = {
        tagName: String( tag ).toUpperCase(),
        nodeType: 1,
        className: '',
        childNodes: [],
        parentNode: null,
        attributes: {}
    }

    const classSet = () => new Set( String( el.className ).split( ' ' ).filter( ( name ) => name.length > 0 ) )
    const siblingsFrom = ( kind ) => {
        if( el.parentNode === null ) { return null }
        const pool = kind === 'element' ? el.parentNode.childNodes.filter( ( node ) => node.nodeType === 1 ) : el.parentNode.childNodes
        const at = pool.indexOf( el )

        return at === -1 || at + 1 >= pool.length ? null : pool[ at + 1 ]
    }

    el.classList = {
        add: ( name ) => { const set = classSet(); set.add( name ); el.className = Array.from( set ).join( ' ' ) },
        contains: ( name ) => classSet().has( name )
    }
    el.setAttribute = ( name, value ) => { el.attributes[ name ] = String( value ) }
    el.getAttribute = ( name ) => ( el.attributes[ name ] === undefined ? null : el.attributes[ name ] )
    el.appendChild = ( child ) => { child.parentNode = el; el.childNodes.push( child ); return child }
    el.insertBefore = ( fresh, ref ) => {
        const at = ( ref === null || ref === undefined ) ? el.childNodes.length : el.childNodes.indexOf( ref )
        fresh.parentNode = el
        el.childNodes.splice( at === -1 ? el.childNodes.length : at, 0, fresh )

        return fresh
    }
    el.querySelectorAll = ( selector ) => elementDescendants( el ).filter( ( child ) => selectorMatches( child, selector ) )
    el.querySelector = ( selector ) => {
        const hits = el.querySelectorAll( selector )

        return hits.length === 0 ? null : hits[ 0 ]
    }

    Object.defineProperty( el, 'nextSibling', { get: () => siblingsFrom( 'node' ) } )
    Object.defineProperty( el, 'nextElementSibling', { get: () => siblingsFrom( 'element' ) } )
    Object.defineProperty( el, 'textContent', {
        get: () => el.childNodes.map( ( child ) => ( child.nodeType === 3 ? child.nodeValue : child.textContent ) ).join( '' ),
        set: ( value ) => { el.childNodes = [ makeText( value ) ] }
    } )

    return el
}


const appendTo = ( parent, tag, text ) => {
    const el = makeElement( tag )
    if( text !== undefined ) { el.textContent = text }
    parent.appendChild( el )

    return el
}


const CLIENT_FUNCTIONS = [ 'injectBlockStoreSections', 'buildStoreTable', 'chapterCarriesOwnWorkItems', 'injectUnboundWorkItems', 'formatProvenance', 'headingLevel' ]


const loadClient = async ( { contentEl } ) => {
    const lifted = await extractFunctionSources( CLIENT_FUNCTIONS )
    const sandbox = { document: { createElement: ( tag ) => makeElement( tag ) }, contentEl: contentEl }
    vm.createContext( sandbox )
    vm.runInContext( lifted.source + '\nglobalThis.api = { ' + CLIENT_FUNCTIONS.join( ', ' ) + ' }', sandbox )

    return sandbox.api
}


// ---- fixture: one temp memo carrying every case the display must survive ----

const FIXTURE_TOPICS = [
    { id: 'T001', title: 'Erstes Topic', status: 'registered', blockId: 'B001', chapter: '1. Erstes Kapitel', workItemIds: [ 'WI-001', 'WI-002' ] },
    { id: 'T002', title: 'Zweites Topic', status: 'registered', blockId: 'B001', chapter: '2. Zweites Kapitel', workItemIds: [ 'WI-003' ] },
    { id: 'T003', title: 'Drittes Topic ohne Work-Item', status: 'registered', blockId: 'B002', chapter: '1. Erstes Kapitel', workItemIds: [] },
    { id: 'T004', title: 'Deregistriertes Topic', status: 'deregistered', blockId: null, chapter: null, workItemIds: [ 'WI-004' ] },
    { id: 'T005', title: 'Block ohne Kapitel', status: 'registered', blockId: 'B003', chapter: null, workItemIds: [ 'WI-005' ] }
]

const FIXTURE_ITEMS = [
    { id: 'WI-001', topicId: 'T001', title: 'Titel mit <script> & Kaufmanns-Und', status: 'offen', disposition: null, dispositionNote: null, group: 'anzeige', provenance: [ { path: 'revisions/REV-01.md', lines: '12-14', quote: 'egal' }, { path: 'transcripts/t.md' } ] },
    { id: 'WI-003', topicId: 'T002', title: 'Drittes Work-Item', status: 'erledigt', disposition: 'dokumentiert', dispositionNote: 'fertig', group: 'anzeige', provenance: [] },
    { id: 'WI-004', topicId: 'T004', title: 'Haengt an deregistriertem Topic', status: 'offen', disposition: null, dispositionNote: null, group: 'rest', provenance: [] },
    { id: 'WI-005', topicId: 'T005', title: 'Topic hat Block aber kein Kapitel', status: 'offen', disposition: null, dispositionNote: null, group: 'rest', provenance: [] },
    { id: 'WI-006', topicId: 'T999', title: 'Topic gibt es gar nicht', status: 'offen', disposition: null, dispositionNote: null, group: 'rest', provenance: [] }
]


describe( 'PRD-V8 — work-item store reader (the third corner readTopicStore never had)', () => {
    let root = ''
    let memoDir = ''
    let store = null


    beforeAll( async () => {
        root = await mkdtemp( join( tmpdir(), 'memo-blockstore-' ) )
        memoDir = join( root, 'memo-080-fixture' )
        await mkdir( join( memoDir, '_topics' ), { recursive: true } )
        await mkdir( join( memoDir, '_work-items' ), { recursive: true } )

        await Promise.all( FIXTURE_TOPICS.map( ( topic ) => writeFile( join( memoDir, '_topics', topic.id + '.json' ), JSON.stringify( topic, null, 4 ) + '\n', 'utf-8' ) ) )
        // an ARCHIVED topic version — must never be read (archive-then-write, Memo 054 Kap 4).
        await writeFile( join( memoDir, '_topics', 'T001.2026-07-13T16-58-01-788Z.json' ), JSON.stringify( { id: 'T001', chapter: null }, null, 4 ) + '\n', 'utf-8' )

        await Promise.all( FIXTURE_ITEMS.map( ( item ) => writeFile( join( memoDir, '_work-items', item.id + '.json' ), JSON.stringify( item, null, 4 ) + '\n', 'utf-8' ) ) )
        // an ARCHIVED work-item version and a BROKEN one — neither may cost the whole read.
        await writeFile( join( memoDir, '_work-items', 'WI-001.2026-08-30T10-00-00-000Z.json' ), JSON.stringify( { id: 'WI-001', title: 'archivierte Fassung' }, null, 4 ) + '\n', 'utf-8' )
        await writeFile( join( memoDir, '_work-items', 'WI-002.json' ), '{ "id": "WI-002", broken', 'utf-8' )

        await Promise.all( [ 'B001', 'B002', 'B003' ].map( async ( blockId ) => {
            await mkdir( join( memoDir, 'blocks', blockId ), { recursive: true } )
            await writeFile( join( memoDir, 'blocks', blockId, 'block.json' ), JSON.stringify( { blockId: blockId, topicIds: [] }, null, 4 ) + '\n', 'utf-8' )
        } ) )

        store = await MemoView.readTopicStore( { memoDir } )
    } )


    afterAll( async () => {
        if( root.length > 0 ) { await rm( root, { recursive: true, force: true } ) }
    } )


    it( 'reads the CANONICAL work items only — the archived WI-001.<stamp>.json is not a second WI-001', () => {
        const ids = store.workItems.map( ( item ) => item.id )
        const onDisk = FIXTURE_ITEMS.length + 2

        expect( ids.filter( ( id ) => id === 'WI-001' ).length ).toBe( 1 )
        expect( store.workItems.find( ( item ) => item.id === 'WI-001' ).title ).toBe( FIXTURE_ITEMS[ 0 ].title )
        console.log( 'compared: ' + onDisk + ' json files on disk -> ' + ids.length + ' canonical records (' + ids.join( ', ' ) + ')' )
        expect( ids.length ).toBe( 5 )
    } )


    it( 'a BROKEN WI-002.json costs exactly itself — the other four survive, the read does not throw', () => {
        const ids = store.workItems.map( ( item ) => item.id )

        expect( ids.includes( 'WI-002' ) ).toBe( false )
        expect( ids ).toEqual( [ 'WI-001', 'WI-003', 'WI-004', 'WI-005', 'WI-006' ] )
    } )


    it( 'a memo WITHOUT _work-items/ answers with an empty list, not with a throw', async () => {
        const bare = join( root, 'memo-without-store' )
        await mkdir( join( bare, '_topics' ), { recursive: true } )
        const empty = await MemoView.readTopicStore( { memoDir: bare } )

        expect( empty.workItems ).toEqual( [] )
        expect( Array.isArray( empty.topics ) ).toBe( true )
        expect( ( await MemoView.readTopicStore( { memoDir: '' } ) ).workItems ).toEqual( [] )
    } )


    // The CLASS behind the two census pins PRD-V8 had to update in TopicStoreRoutePRD018.test.mjs:
    // whatever corners the store grows, the EMPTY answer must speak the same shape as a filled one.
    // Pinning a hand-typed key list in two places is how that census went stale in the first place.
    it( 'the EMPTY answer carries the same key set as a FILLED read — no corner appears only when full', async () => {
        const bare = join( root, 'memo-shape-probe' )
        await mkdir( bare, { recursive: true } )
        const emptyKeys = Object.keys( await MemoView.readTopicStore( { memoDir: bare } ) ).sort()
        const noArgKeys = Object.keys( await MemoView.readTopicStore( { memoDir: '' } ) ).sort()
        const filledKeys = Object.keys( store ).sort()

        expect( emptyKeys ).toEqual( filledKeys )
        expect( noArgKeys ).toEqual( filledKeys )
        console.log( 'compared: ' + filledKeys.length + ' keys over 3 read paths (' + filledKeys.join( ', ' ) + ')' )
    } )


    it( 'every record carries the SAME eight fields, and provenance is ALWAYS a list (5 of 5)', () => {
        const wanted = [ 'id', 'topicId', 'title', 'status', 'disposition', 'dispositionNote', 'group', 'provenance' ]
        const offenders = store.workItems.filter( ( item ) => JSON.stringify( Object.keys( item ).sort() ) !== JSON.stringify( wanted.slice().sort() ) )

        expect( offenders ).toEqual( [] )
        expect( store.workItems.every( ( item ) => Array.isArray( item.provenance ) ) ).toBe( true )
        console.log( 'compared: ' + store.workItems.length + ' records x ' + wanted.length + ' fields' )
    } )


    it( 'provenance is projected onto { path, lines } — a missing line span becomes null, not undefined', () => {
        const first = store.workItems.find( ( item ) => item.id === 'WI-001' )

        expect( first.provenance ).toEqual( [ { path: 'revisions/REV-01.md', lines: '12-14' }, { path: 'transcripts/t.md', lines: null } ] )
    } )


    it( 'the addition is ADDITIVE: topics and blocks keep their shape and their sort order', () => {
        expect( store.topics.map( ( topic ) => topic.id ) ).toEqual( [ 'T001', 'T002', 'T003', 'T004', 'T005' ] )
        expect( store.blocks.map( ( block ) => block.blockId ) ).toEqual( [ 'B001', 'B002', 'B003' ] )
        expect( Object.keys( store.topics[ 0 ] ).sort() ).toEqual( [ 'blockId', 'chapter', 'dependsOn', 'id', 'researchFile', 'status', 'title', 'workItemIds' ] )
        expect( Object.keys( store ).sort() ).toEqual( [ 'blocks', 'topics', 'workItems' ] )
    } )
} )


describe( 'PRD-V8 — blockStoreSections: one section per (chapter, block), nothing lost', () => {
    const view = MemoView.blockStoreSections( { topics: FIXTURE_TOPICS, blocks: [ { blockId: 'B001' }, { blockId: 'B002' }, { blockId: 'B003' } ], workItems: FIXTURE_ITEMS } )


    it( 'is PURE: same input twice, character-identical output — and it reads no file at all', async () => {
        const again = MemoView.blockStoreSections( { topics: FIXTURE_TOPICS, blocks: [ { blockId: 'B001' }, { blockId: 'B002' }, { blockId: 'B003' } ], workItems: FIXTURE_ITEMS } )
        const source = await readMemoViewSource()
        const cut = source.slice( source.indexOf( 'static blockStoreSections(' ), source.indexOf( 'static #unboundEntry(' ) )

        expect( JSON.stringify( again ) ).toBe( JSON.stringify( view ) )
        expect( /readFile|readdir|existsSync|writeFile/.test( cut ) ).toBe( false )
        console.log( 'compared: ' + cut.split( '\n' ).length + ' source lines, 0 file verbs' )
    } )


    it( 'splits a block that stands over TWO chapters into two sections — never one, never a double', () => {
        const keys = view.sections.map( ( section ) => section.chapter + ' / ' + section.blockId )

        expect( keys ).toEqual( [ '1. Erstes Kapitel / B001', '1. Erstes Kapitel / B002', '2. Zweites Kapitel / B001' ] )
        expect( view.sections.filter( ( section ) => section.blockId === 'B001' ).length ).toBe( 2 )
        console.log( 'compared: 5 topics / 3 blocks -> ' + view.sections.length + ' sections' )
    } )


    it( 'a cross-chapter block names its OTHER chapters and the full topic count; a single-chapter block names none', () => {
        const first = view.sections[ 0 ]
        const single = view.sections.find( ( section ) => section.blockId === 'B002' )

        expect( first.topics.map( ( topic ) => topic.id ) ).toEqual( [ 'T001' ] )
        expect( first.topicCountInBlock ).toBe( 2 )
        expect( first.otherChapters ).toEqual( [ '2. Zweites Kapitel' ] )
        expect( single.topicCountInBlock ).toBe( 1 )
        expect( single.otherChapters ).toEqual( [] )
    } )


    it( 'a section carries EXACTLY the work items of its own topics, and no item lands in two sections', () => {
        const perSection = view.sections.map( ( section ) => section.workItems.map( ( item ) => item.id ) )
        const flat = perSection.flat()

        expect( perSection ).toEqual( [ [ 'WI-001' ], [], [ 'WI-003' ] ] )
        expect( new Set( flat ).size ).toBe( flat.length )
        console.log( 'compared: ' + flat.length + ' placed work-item rows over ' + view.sections.length + ' sections' )
    } )


    it( 'the sum holds BY CONSTRUCTION: placed + unplaceable === read (2 + 3 = 5)', () => {
        expect( view.counts.workItemsInSections + view.counts.workItemsUnbound ).toBe( view.counts.workItems )
        expect( view.counts ).toEqual( { topics: 5, topicsWithBlock: 4, workItems: 5, workItemsInSections: 2, workItemsUnbound: 3, blocks: 3, sections: 3 } )
    } )


    it( 'every unplaceable item names its REASON — all three shapes, not just the two that exist today', () => {
        const seen = view.unbound.map( ( item ) => item.id + ':' + item.reason + ':' + item.topicStatus )

        expect( seen ).toEqual( [ 'WI-004:topic-without-block:deregistered', 'WI-005:topic-without-chapter:registered', 'WI-006:topic-unknown:null' ] )
        expect( Object.keys( view.unbound[ 0 ] ).sort() ).toEqual( [ 'disposition', 'dispositionNote', 'group', 'id', 'provenance', 'reason', 'status', 'title', 'topicId', 'topicStatus' ] )
        console.log( 'compared: ' + view.unbound.length + ' backlog rows, 3 of 3 reasons exercised' )
    } )


    it( 'topics and work items inside a section are sorted by id, sections by chapter then block', () => {
        const twoTopics = MemoView.blockStoreSections( {
            topics: [
                { id: 'T009', blockId: 'B001', chapter: '1. Kapitel', title: 'spaet', status: 'registered' },
                { id: 'T002', blockId: 'B001', chapter: '1. Kapitel', title: 'frueh', status: 'registered' }
            ],
            blocks: [],
            workItems: [ { id: 'WI-030', topicId: 'T009' }, { id: 'WI-004', topicId: 'T002' } ]
        } )

        expect( twoTopics.sections[ 0 ].topics.map( ( topic ) => topic.id ) ).toEqual( [ 'T002', 'T009' ] )
        expect( twoTopics.sections[ 0 ].workItems.map( ( item ) => item.id ) ).toEqual( [ 'WI-004', 'WI-030' ] )
    } )


    it( 'two DIFFERENT (chapter, block) pairs never collapse into one — the key is escaped, not glued', () => {
        const tricky = MemoView.blockStoreSections( {
            topics: [
                { id: 'T001', blockId: 'B001', chapter: '1. Kapitel mit " Zitat', title: '', status: 'registered' },
                { id: 'T002', blockId: 'B001', chapter: '1. Kapitel mit " Zitat", "B001', title: '', status: 'registered' },
                { id: 'T003', blockId: 'B002', chapter: '1. Kapitel mit " Zitat', title: '', status: 'registered' }
            ],
            blocks: [],
            workItems: []
        } )

        expect( tricky.counts.sections ).toBe( 3 )
        console.log( 'compared: 3 adversarial (chapter, block) pairs -> ' + tricky.counts.sections + ' sections' )
    } )


    it( 'chapter 2 sorts BEFORE chapter 10 — the ordinal decides, not the string', () => {
        const mixed = MemoView.blockStoreSections( {
            topics: [
                { id: 'T001', blockId: 'B001', chapter: '10. Zehntes Kapitel', title: '', status: 'registered' },
                { id: 'T002', blockId: 'B001', chapter: '2. Zweites Kapitel', title: '', status: 'registered' }
            ],
            blocks: [],
            workItems: []
        } )

        expect( mixed.sections.map( ( section ) => section.chapter ) ).toEqual( [ '2. Zweites Kapitel', '10. Zehntes Kapitel' ] )
    } )


    it( 'the BACK edge topic.workItemIds is not a second truth: trimming it changes nothing', () => {
        const trimmed = FIXTURE_TOPICS.map( ( topic ) => ( topic.id === 'T001' ? Object.assign( {}, topic, { workItemIds: [] } ) : topic ) )
        const other = MemoView.blockStoreSections( { topics: trimmed, blocks: [ { blockId: 'B001' }, { blockId: 'B002' }, { blockId: 'B003' } ], workItems: FIXTURE_ITEMS } )

        expect( JSON.stringify( other ) ).toBe( JSON.stringify( view ) )
        console.log( 'compared: 1 trimmed back edge, ' + view.counts.workItemsInSections + ' placed rows unchanged' )
    } )


    it( 'an empty store answers with the SAME seven counters, all zero — no missing key', () => {
        const empty = MemoView.blockStoreSections( { topics: [], blocks: [], workItems: [] } )

        expect( empty.sections ).toEqual( [] )
        expect( empty.unbound ).toEqual( [] )
        expect( empty.counts ).toEqual( { topics: 0, topicsWithBlock: 0, workItems: 0, workItemsInSections: 0, workItemsUnbound: 0, blocks: 0, sections: 0 } )
        expect( Object.keys( empty.counts ).length ).toBe( Object.keys( view.counts ).length )
    } )
} )


describe( 'PRD-V8 — against the REAL store of memo 080 (skip-guarded: CI checks out this repo alone)', () => {
    const present = existsSync( REAL_MEMO_DIR )


    it( 'reads the real store and reproduces the measured figures — 0 work items would be RED', async () => {
        if( present !== true ) {
            console.log( 'skipped: the memo store is not checked out next to this repo (' + REAL_MEMO_DIR + ')' )
            expect( present ).toBe( false )

            return
        }

        const store = await MemoView.readTopicStore( { memoDir: REAL_MEMO_DIR } )
        const view = MemoView.blockStoreSections( store )
        const blockDirs = await readdir( join( REAL_MEMO_DIR, 'blocks' ) )
        const realBlocks = blockDirs.filter( ( name ) => /^B\d{3}$/.test( name ) && existsSync( join( REAL_MEMO_DIR, 'blocks', name, 'block.json' ) ) ).length

        console.log( 'compared: ' + view.counts.topics + ' Topics (' + view.counts.topicsWithBlock + ' mit Block) · '
            + view.counts.workItems + ' Work-Items · ' + view.counts.blocks + ' Bloecke · '
            + view.counts.workItemsInSections + ' in Sektionen · ' + view.counts.workItemsUnbound + ' ohne Bindung · '
            + view.counts.sections + ' Sektionen' )

        // No comparison basis is RED, not green (a green zero is red).
        expect( view.counts.workItems ).toBeGreaterThan( 0 )
        expect( view.counts.topics ).toBe( 106 )
        expect( view.counts.topicsWithBlock ).toBe( 102 )
        expect( view.counts.workItems ).toBe( 223 )
        expect( view.counts.workItemsInSections ).toBe( 221 )
        expect( view.counts.workItemsUnbound ).toBe( 2 )
        expect( view.counts.workItemsInSections + view.counts.workItemsUnbound ).toBe( view.counts.workItems )
        // The PRD froze 50 here; the store grew to 51 (B051, registered after the PRD was written).
        // Pinned against the DIRECTORY COUNT measured in this run, so it can never be a frozen value.
        expect( view.counts.blocks ).toBe( realBlocks )
        expect( view.counts.blocks ).toBeGreaterThanOrEqual( 50 )
    } )


    it( 'B039 — the cross-chapter block of this PRD — appears once per chapter, never twice in one', async () => {
        if( present !== true ) {
            console.log( 'skipped: the memo store is not checked out next to this repo' )
            expect( present ).toBe( false )

            return
        }

        const store = await MemoView.readTopicStore( { memoDir: REAL_MEMO_DIR } )
        const view = MemoView.blockStoreSections( store )
        const b039 = view.sections.filter( ( section ) => section.blockId === 'B039' )
        const inChapter16 = b039.find( ( section ) => section.chapter.startsWith( '16.' ) )

        console.log( 'compared: ' + b039.length + ' B039 sections over ' + view.counts.sections + ' sections total' )
        expect( b039.length ).toBe( 2 )
        expect( inChapter16.topics.map( ( topic ) => topic.id ) ).toEqual( [ 'T080' ] )
        expect( inChapter16.topicCountInBlock ).toBe( 2 )
        expect( inChapter16.otherChapters ).toEqual( [ '2. Form und Aufbau eines Memos' ] )
        expect( inChapter16.workItems.map( ( item ) => item.id ) ).toEqual( [ 'WI-203' ] )
    } )


    it( 'WI-062 and WI-095 are the ONLY two in the backlog, each with reason and topic status', async () => {
        if( present !== true ) {
            console.log( 'skipped: the memo store is not checked out next to this repo' )
            expect( present ).toBe( false )

            return
        }

        const store = await MemoView.readTopicStore( { memoDir: REAL_MEMO_DIR } )
        const view = MemoView.blockStoreSections( store )
        const seen = view.unbound.map( ( item ) => item.id + ':' + item.topicId + ':' + item.reason + ':' + item.topicStatus )

        console.log( 'compared: ' + view.counts.workItems + ' work items -> ' + view.unbound.length + ' backlog rows' )
        expect( seen ).toEqual( [ 'WI-062:T056:topic-without-block:deregistered', 'WI-095:T063:topic-without-block:deregistered' ] )
    } )
} )


describe( 'PRD-V8 — the route carries the third corner, additively', () => {
    let routeCut = ''


    beforeAll( async () => {
        const source = await readMemoViewSource()
        const start = source.indexOf( "url.endsWith( '/topics' )" )
        const end = source.indexOf( "url.endsWith( '/annotations' )", start )
        routeCut = source.slice( start, end )
    } )


    it( 'answers with all SIX keys — the three old ones and the three new ones', () => {
        const wanted = [ "'topics'", "'blocks'", "'workItems'", "'sections'", "'unbound'", "'counts'" ]
        const missing = wanted.filter( ( key ) => routeCut.includes( key ) !== true )

        expect( missing ).toEqual( [] )
        console.log( 'compared: ' + wanted.length + ' payload keys over ' + routeCut.split( '\n' ).length + ' route lines' )
    } )


    it( 'the no-memoDir path still answers 200 and takes its empty shape FROM blockStoreSections', () => {
        const emptyBranch = routeCut.slice( routeCut.indexOf( "if( !location[ 'status' ] )" ), routeCut.indexOf( 'readTopicStore' ) )

        expect( emptyBranch.includes( 'sendJson( res, 200' ) ).toBe( true )
        expect( emptyBranch.includes( 'MemoView.blockStoreSections(' ) ).toBe( true )
        expect( emptyBranch.includes( '404' ) ).toBe( false )
    } )


    it( 'an unknown document id still ends in 404 with the registry message', () => {
        const unknownBranch = routeCut.slice( 0, routeCut.indexOf( 'resolveMemoDir' ) )

        expect( unknownBranch.includes( "sendJson( res, 404, { 'error': result[ 'messages' ].join( '; ' ) } )" ) ).toBe( true )
    } )


    it( 'the route is still sorted BEFORE the generic /api/documents/<id> read', async () => {
        const source = await readMemoViewSource()

        expect( source.indexOf( "url.endsWith( '/topics' )" ) ).toBeLessThan( source.indexOf( "url.startsWith( '/api/documents/' ) && req.method === 'GET'" ) )
    } )
} )


describe( 'PRD-V8 — the injected display, really executed against a built DOM', () => {
    const sectionFixture = ( { blockId, chapter, topics, workItems, topicCountInBlock, otherChapters } ) => ( {
        chapter: chapter,
        blockId: blockId,
        topics: topics,
        workItems: workItems,
        topicCountInBlock: topicCountInBlock,
        otherChapters: otherChapters
    } )

    const SECTION_ONE = sectionFixture( {
        blockId: 'B039',
        chapter: '16. Viewer-Defekte und Stabilitaet',
        topics: [ { id: 'T080', title: 'Block-gebundene Anzeige', status: 'registered' } ],
        workItems: [ { id: 'WI-203', topicId: 'T080', title: 'Titel mit <b> & Co', status: 'offen', group: 'laufzeit', provenance: [ { path: 'revisions/REV-13.md', lines: '128' }, { path: 'transcripts/t.md', lines: null } ] } ],
        topicCountInBlock: 2,
        otherChapters: [ '2. Form und Aufbau eines Memos' ]
    } )

    const SECTION_EMPTY = sectionFixture( {
        blockId: 'B044',
        chapter: '16. Viewer-Defekte und Stabilitaet',
        topics: [ { id: 'T090', title: 'Topic ohne Work-Item', status: 'registered' } ],
        workItems: [],
        topicCountInBlock: 1,
        otherChapters: []
    } )


    const buildDocument = ( { withOwnWorkItems } ) => {
        const contentEl = makeElement( 'div' )
        const heading = appendTo( contentEl, 'h2', '16. Viewer-Defekte und Stabilitaet' )
        const pill = appendTo( contentEl, 'div' )
        pill.className = 'topic-pill-header'
        appendTo( contentEl, 'p', 'Prosa des Kapitels' )
        if( withOwnWorkItems === true ) { appendTo( contentEl, 'h4', 'Work-Items' ) }
        appendTo( contentEl, 'h2', '17. Naechstes Kapitel' )

        return { contentEl, heading, pill }
    }


    it( 'draws ONE Topics section per block and ONE Work-Items section — the block without items gets none', async () => {
        const dom = buildDocument( { withOwnWorkItems: false } )
        const api = await loadClient( { contentEl: dom.contentEl } )
        const drawn = api.injectBlockStoreSections( dom.heading, [ SECTION_ONE, SECTION_EMPTY ] )
        const sections = dom.contentEl.querySelectorAll( '.block-store-section' )
        const labels = sections.map( ( node ) => node.querySelector( 'summary' ).textContent )

        console.log( 'compared: 2 sections in -> ' + sections.length + ' collapsibles out (' + labels.join( ' | ' ) + ')' )
        expect( drawn ).toBe( 2 )
        expect( labels ).toEqual( [ 'Topics — B039', 'Work-Items — B039', 'Topics — B044' ] )
    } )


    it( 'every collapsible is a details.table-collapsible.block-store-section[open] with a summary', async () => {
        const dom = buildDocument( { withOwnWorkItems: false } )
        const api = await loadClient( { contentEl: dom.contentEl } )
        api.injectBlockStoreSections( dom.heading, [ SECTION_ONE ] )
        const sections = dom.contentEl.querySelectorAll( '.block-store-section' )

        expect( sections.length ).toBe( 2 )
        expect( sections.every( ( node ) => node.tagName === 'DETAILS' ) ).toBe( true )
        expect( sections.every( ( node ) => node.className === 'table-collapsible block-store-section' ) ).toBe( true )
        expect( sections.every( ( node ) => node.getAttribute( 'open' ) === '' ) ).toBe( true )
        expect( sections.every( ( node ) => node.querySelector( 'summary' ).className === 'table-collapsible-summary' ) ).toBe( true )
        console.log( 'compared: ' + sections.length + ' collapsibles, 4 shape checks each' )
    } )


    it( 'the two tables carry exactly the specified columns — 4 for Topics, 6 for Work-Items', async () => {
        const dom = buildDocument( { withOwnWorkItems: false } )
        const api = await loadClient( { contentEl: dom.contentEl } )
        api.injectBlockStoreSections( dom.heading, [ SECTION_ONE ] )
        const sections = dom.contentEl.querySelectorAll( '.block-store-section' )
        const head = ( node ) => node.querySelectorAll( 'th' ).map( ( th ) => th.textContent )

        expect( head( sections[ 0 ] ) ).toEqual( [ 'Topic', 'Titel', 'Status', 'Work-Items' ] )
        expect( head( sections[ 1 ] ) ).toEqual( [ 'WI', 'Topic', 'Titel', 'Status', 'Herkunft', 'Gruppe' ] )
    } )


    it( 'a title carrying < and & lands LITERALLY in the cell — textContent, never innerHTML', async () => {
        const dom = buildDocument( { withOwnWorkItems: false } )
        const api = await loadClient( { contentEl: dom.contentEl } )
        api.injectBlockStoreSections( dom.heading, [ SECTION_ONE ] )
        const cells = dom.contentEl.querySelectorAll( '.block-store-section' )[ 1 ].querySelectorAll( 'td' ).map( ( td ) => td.textContent )
        const source = await readEmittedScript()
        const cut = source.slice( source.indexOf( 'function buildStoreTable(' ), source.indexOf( 'function chapterCarriesOwnWorkItems(' ) )

        expect( cells ).toEqual( [ 'WI-203', 'T080', 'Titel mit <b> & Co', 'offen', 'revisions/REV-13.md:128 · transcripts/t.md', 'laufzeit' ] )
        expect( cut.includes( 'innerHTML' ) ).toBe( false )
        console.log( 'compared: ' + cells.length + ' cells, 3 raw glyphs (< > &) preserved' )
    } )


    it( 'the Topics row lists ITS OWN work items only — two topics in one block do not share a cell', async () => {
        const shared = sectionFixture( {
            blockId: 'B017',
            chapter: '16. Viewer-Defekte und Stabilitaet',
            topics: [ { id: 'T010', title: 'Erstes', status: 'registered' }, { id: 'T011', title: 'Zweites', status: 'registered' } ],
            workItems: [
                { id: 'WI-010', topicId: 'T010', title: 'a', status: 'offen', group: 'g', provenance: [] },
                { id: 'WI-011', topicId: 'T011', title: 'b', status: 'offen', group: 'g', provenance: [] },
                { id: 'WI-012', topicId: 'T011', title: 'c', status: 'offen', group: 'g', provenance: [] }
            ],
            topicCountInBlock: 2,
            otherChapters: []
        } )
        const dom = buildDocument( { withOwnWorkItems: false } )
        const api = await loadClient( { contentEl: dom.contentEl } )
        api.injectBlockStoreSections( dom.heading, [ shared ] )
        const cells = dom.contentEl.querySelectorAll( '.block-store-section' )[ 0 ].querySelectorAll( 'td' ).map( ( td ) => td.textContent )

        console.log( 'compared: 2 topics / 3 work items -> ' + cells.length + ' topic cells' )
        expect( cells ).toEqual( [ 'T010', 'Erstes', 'registered', 'WI-010', 'T011', 'Zweites', 'registered', 'WI-011, WI-012' ] )
    } )


    it( 'the cross-chapter hint names the ratio and the other chapter; a single-chapter block stays silent', async () => {
        const dom = buildDocument( { withOwnWorkItems: false } )
        const api = await loadClient( { contentEl: dom.contentEl } )
        api.injectBlockStoreSections( dom.heading, [ SECTION_ONE, SECTION_EMPTY ] )
        const notes = dom.contentEl.querySelectorAll( '.block-store-note' ).map( ( node ) => node.textContent )

        expect( notes ).toEqual( [ 'B039 · 1 von 2 Topics in diesem Kapitel · weitere in: 2. Form und Aufbau eines Memos' ] )
        console.log( 'compared: 2 sections -> ' + notes.length + ' hint line (B044 is single-chapter and says nothing)' )
    } )


    it( 'the SEAM to the generator: a chapter with its own Work-Items heading gets the pointer, not a second table', async () => {
        const dom = buildDocument( { withOwnWorkItems: true } )
        const api = await loadClient( { contentEl: dom.contentEl } )
        api.injectBlockStoreSections( dom.heading, [ SECTION_ONE ] )
        const labels = dom.contentEl.querySelectorAll( '.block-store-section' ).map( ( node ) => node.querySelector( 'summary' ).textContent )
        const notes = dom.contentEl.querySelectorAll( '.block-store-note' ).map( ( node ) => node.textContent )

        expect( labels ).toEqual( [ 'Topics — B039' ] )
        expect( notes.includes( 'Work-Items: im Dokument enthalten' ) ).toBe( true )
        console.log( 'compared: 1 own heading found -> 0 injected work-item tables, 1 pointer line' )
    } )


    it( 'the seam looks only INSIDE its own chapter — a Work-Items heading behind the next H2 does not count', async () => {
        const contentEl = makeElement( 'div' )
        const heading = appendTo( contentEl, 'h2', '16. Viewer-Defekte und Stabilitaet' )
        appendTo( contentEl, 'p', 'Prosa' )
        appendTo( contentEl, 'h2', '17. Naechstes Kapitel' )
        appendTo( contentEl, 'h4', 'Work-Items' )
        const api = await loadClient( { contentEl } )

        expect( api.chapterCarriesOwnWorkItems( heading ) ).toBe( false )
    } )


    it( 'a second render pass adds NOTHING — same node count, no doubled table', async () => {
        const dom = buildDocument( { withOwnWorkItems: false } )
        const api = await loadClient( { contentEl: dom.contentEl } )
        const first = api.injectBlockStoreSections( dom.heading, [ SECTION_ONE, SECTION_EMPTY ] )
        const afterFirst = dom.contentEl.querySelectorAll( '.block-store-section' ).length
        const second = api.injectBlockStoreSections( dom.heading, [ SECTION_ONE, SECTION_EMPTY ] )
        const afterSecond = dom.contentEl.querySelectorAll( '.block-store-section' ).length

        console.log( 'compared: pass 1 drew ' + afterFirst + ' collapsibles, pass 2 drew ' + ( afterSecond - afterFirst ) )
        expect( first ).toBe( 2 )
        expect( second ).toBe( 0 )
        expect( afterSecond ).toBe( afterFirst )
        expect( dom.contentEl.querySelectorAll( '.block-store-wrap' ).length ).toBe( 1 )
    } )


    it( 'the block goes DIRECTLY after the pill header, so the chapter prose keeps its place', async () => {
        const dom = buildDocument( { withOwnWorkItems: false } )
        const api = await loadClient( { contentEl: dom.contentEl } )
        api.injectBlockStoreSections( dom.heading, [ SECTION_ONE ] )
        const order = dom.contentEl.childNodes.map( ( node ) => node.className || node.tagName )

        expect( order ).toEqual( [ 'H2', 'topic-pill-header', 'block-store-wrap', 'P', 'H2' ] )
    } )


    it( 'the backlog names both rows WITH a reason column and closes with the count line', async () => {
        const contentEl = makeElement( 'div' )
        appendTo( contentEl, 'h2', '16. Kapitel' )
        const api = await loadClient( { contentEl } )
        const unbound = [
            { id: 'WI-062', topicId: 'T056', title: 'Erstes', status: 'offen', group: 'rest', provenance: [], reason: 'topic-without-block', topicStatus: 'deregistered' },
            { id: 'WI-095', topicId: 'T063', title: 'Zweites', status: 'offen', group: 'rest', provenance: [], reason: 'topic-without-block', topicStatus: 'deregistered' }
        ]
        const drawn = api.injectUnboundWorkItems( { unbound, counts: { workItems: 223, blocks: 51, workItemsInSections: 221, workItemsUnbound: 2 } } )
        const backlog = contentEl.querySelector( '.block-store-unbound' )
        const columns = backlog.querySelectorAll( 'th' ).map( ( th ) => th.textContent )
        const rows = backlog.querySelectorAll( 'tbody' )[ 0 ].querySelectorAll( 'tr' ).length

        console.log( 'compared: ' + unbound.length + ' backlog rows x ' + columns.length + ' columns' )
        expect( drawn ).toBe( 2 )
        expect( backlog.querySelector( 'summary' ).textContent ).toBe( 'Work-Items ohne Block-Bindung (2)' )
        expect( columns ).toEqual( [ 'WI', 'Topic', 'Titel', 'Status', 'Herkunft', 'Gruppe', 'Grund' ] )
        expect( rows ).toBe( 2 )
        expect( backlog.querySelectorAll( 'td' )[ 6 ].textContent ).toBe( 'topic-without-block (deregistered)' )
        expect( backlog.querySelector( '.block-store-count' ).textContent ).toBe( '223 Work-Items · 51 Blöcke · 221 im Block · 2 ohne Bindung' )
    } )


    it( 'the count line appears EVEN WITH an empty backlog — the visible proof that a comparison happened', async () => {
        const contentEl = makeElement( 'div' )
        const api = await loadClient( { contentEl } )
        const drawn = api.injectUnboundWorkItems( { unbound: [], counts: { workItems: 12, blocks: 3, workItemsInSections: 12, workItemsUnbound: 0 } } )

        expect( drawn ).toBe( 0 )
        expect( contentEl.querySelectorAll( '.block-store-section' ).length ).toBe( 0 )
        expect( contentEl.querySelector( '.block-store-count' ).textContent ).toBe( '12 Work-Items · 3 Blöcke · 12 im Block · 0 ohne Bindung' )
    } )


    it( 'the backlog is injected once — a second pass leaves exactly one', async () => {
        const contentEl = makeElement( 'div' )
        const api = await loadClient( { contentEl } )
        const counts = { workItems: 5, blocks: 3, workItemsInSections: 2, workItemsUnbound: 3 }
        api.injectUnboundWorkItems( { unbound: [], counts } )
        api.injectUnboundWorkItems( { unbound: [], counts } )

        expect( contentEl.querySelectorAll( '.block-store-unbound' ).length ).toBe( 1 )
    } )


    it( 'without counts nothing is drawn at all — no half backlog, no empty frame', async () => {
        const contentEl = makeElement( 'div' )
        const api = await loadClient( { contentEl } )

        expect( api.injectUnboundWorkItems( { unbound: [], counts: null } ) ).toBe( 0 )
        expect( contentEl.childNodes.length ).toBe( 0 )
    } )


    it( 'provenance reads as pfad:zeilen, several joined — an entry without a line span shows the path alone', async () => {
        const api = await loadClient( { contentEl: makeElement( 'div' ) } )

        expect( api.formatProvenance( [ { path: 'a.md', lines: '1-3' }, { path: 'b.md', lines: null } ] ) ).toBe( 'a.md:1-3 · b.md' )
        expect( api.formatProvenance( [ { path: '', lines: '9' }, { path: 'c.md', lines: '4' } ] ) ).toBe( 'c.md:4' )
        expect( api.formatProvenance( [] ) ).toBe( '' )
        expect( api.formatProvenance( null ) ).toBe( '' )
        console.log( 'compared: 4 provenance shapes' )
    } )
} )


describe( 'PRD-V8 — form, stylesheet and the boundaries the PRD draws', () => {
    it( 'the new client block keeps the classic-script style: no for/while, no arrows, no semicolons', async () => {
        const source = await readEmittedScript()
        const cut = source.slice( source.indexOf( 'function injectBlockStoreSections(' ), source.indexOf( 'function openResearchDoc(' ) )
        const codeLines = cut.split( '\n' ).filter( ( line ) => line.trim().startsWith( '//' ) !== true )

        expect( /\bfor\s*\(|\bwhile\s*\(/.test( cut ) ).toBe( false )
        expect( cut.includes( '=>' ) ).toBe( false )
        expect( codeLines.filter( ( line ) => line.trim().endsWith( ';' ) ) ).toEqual( [] )
        expect( [ 'injectBlockStoreSections', 'buildStoreTable', 'chapterCarriesOwnWorkItems', 'injectUnboundWorkItems', 'formatProvenance' ].filter( ( name ) => cut.includes( 'function ' + name + '(' ) !== true ) ).toEqual( [] )
        console.log( 'compared: ' + codeLines.length + ' code lines, 5 declarations' )
    } )


    // "Writer ohne Caller" (M079): a leaf nobody calls is not built. These two pin the wiring.
    it( 'the render pass REALLY calls both new leaves — and after the pill header, not before it', async () => {
        const source = await readEmittedScript()
        const cut = source.slice( source.indexOf( 'async function applyTopicPillsFromStore(' ), source.indexOf( 'function matchChapterHeading(' ) )
        const atPill = cut.indexOf( 'injectTopicPillHeader( entry.heading, entry.topics )' )
        const atSections = cut.indexOf( 'injectBlockStoreSections( entry.heading, entry.sections )' )
        const atBacklog = cut.indexOf( 'injectUnboundWorkItems( {' )

        expect( atPill ).toBeGreaterThan( -1 )
        expect( atSections ).toBeGreaterThan( atPill )
        expect( atBacklog ).toBeGreaterThan( atSections )
        expect( cut.includes( 'payload.sections' ) && cut.includes( 'payload.unbound' ) && cut.includes( 'payload.counts' ) ).toBe( true )
        console.log( 'compared: 3 call sites in order over ' + cut.split( '\n' ).length + ' lines of the render pass' )
    } )


    it( 'the early exit no longer swallows a store that HAS sections — all three lists must be empty', async () => {
        const source = await readEmittedScript()
        const cut = source.slice( source.indexOf( 'async function applyTopicPillsFromStore(' ), source.indexOf( 'function matchChapterHeading(' ) )

        expect( cut.includes( 'if( topics.length === 0 && sections.length === 0 && unbound.length === 0 ) { return }' ) ).toBe( true )
        expect( cut.includes( 'if( topics.length === 0 ) { return }' ) ).toBe( false )
    } )


    it( 'the pill header comma list stays UNTOUCHED — the table is the unfolding, not the replacement', async () => {
        const source = await readEmittedScript()
        const cut = source.slice( source.indexOf( 'function injectTopicPillHeader(' ), source.indexOf( 'function injectBlockStoreSections(' ) )

        expect( cut.includes( "crossParts.push( 'Work-Items: ' + uniqueList( wis ).join( ', ' ) )" ) ).toBe( true )
    } )


    it( 'the stylesheet carries the four named classes, and the neighbouring rule is untouched', async () => {
        const css = await readMemoViewStyles()
        const wanted = [ '.block-store-section', '.block-store-note', '.block-store-count', '.block-store-unbound' ]
        const missing = wanted.filter( ( name ) => css.includes( '#content ' + name + ' {' ) !== true )

        expect( missing ).toEqual( [] )
        expect( css.split( '#content .topic-crosslink-line {' ).length - 1 ).toBe( 1 )
        expect( css.includes( '#content .block-store-wrap {' ) ).toBe( true )
        console.log( 'compared: ' + ( wanted.length + 1 ) + ' rule selectors' )
    } )


    it( 'no new collapsible machinery: the block-store table rides on the EXISTING .table-collapsible rules', async () => {
        const css = await readMemoViewStyles()
        const cut = css.slice( css.indexOf( '#content .block-store-wrap {' ), css.indexOf( '/* PRD-V6 (Memo 080 Kap 16, WI-177)' ) )

        expect( /position\s*:\s*fixed|z-index/.test( cut ) ).toBe( false )
        expect( css.split( '#content .table-collapsible {' ).length - 1 ).toBe( 1 )
    } )


    it( 'the DATABASE path stays out of it: DoltDbAssembler knows nothing about block-store sections', async () => {
        const dolt = await import( 'node:fs/promises' ).then( ( fs ) => fs.readFile( fileURLToPath( new URL( '../../src/DoltDbAssembler.mjs', import.meta.url ) ), 'utf8' ) )

        expect( /blockStoreSections|block-store|readWorkItemFiles/.test( dolt ) ).toBe( false )
    } )
} )
