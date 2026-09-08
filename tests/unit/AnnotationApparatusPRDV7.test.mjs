import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

import { AnnotationStore, ANM_STATUS_VALUES } from '../../src/AnnotationStore.mjs'
import { extractFunctionSources, readEmittedScript, readMemoViewSource, readMemoViewStyles } from '../helpers/extractFunction.mjs'


// PRD-V7 (Memo 080 Kap 16, T082, WI-176) — the annotation apparatus.
//
// Three things are proven here, in rising order of strength:
//   1. source cuts   — the shape the PRD fixes (skip lists, branch order, removed parallel path),
//   2. store runs    — AnnotationStore.setStatus against a real temp memo dir (A9-A12),
//   3. real runs     — the apparatus functions LIFTED OUT of the client and EXECUTED in a vm sandbox
//                      against a hand-built DOM (A5-A8, A15, A16, A18). No jsdom in this repo; this is
//                      the same technique ResearchOverlayPRDV6 / TranscriptSplitAndDedupePRDV5 use.
//
// What is deliberately NOT covered: the browser (real scroll, real click). The PRD's Validation steps
// 2/4/5 stay a manual check — see the unit's report.


// ---- a minimal DOM, built for exactly the calls the apparatus makes ----

const makeText = ( value ) => ( { nodeType: 3, nodeValue: String( value ), parentNode: null, textContent: String( value ) } )


const selectorMatches = ( el, selector ) => {
    const combined = String( selector ).match( /^\.([\w-]+)\[([\w-]+)="(.*)"\]$/ )
    if( combined !== null ) {
        return String( el.className ).split( ' ' ).includes( combined[ 1 ] ) && el.getAttribute( combined[ 2 ] ) === combined[ 3 ]
    }
    const attr = String( selector ).match( /^\[([a-zA-Z-]+)="(.*)"\]$/ )
    if( attr !== null ) { return el.getAttribute( attr[ 1 ] ) === attr[ 2 ] }

    return el.tagName === String( selector ).toUpperCase()
}


const makeFragment = () => {
    const frag = { nodeType: 11, childNodes: [], parentNode: null }
    frag.appendChild = ( child ) => { child.parentNode = frag; frag.childNodes.push( child ); return child }

    return frag
}


const elementDescendants = ( el ) => el.childNodes
    .filter( ( child ) => child.nodeType === 1 )
    .flatMap( ( child ) => [ child ].concat( elementDescendants( child ) ) )


const makeElement = ( tag ) => {
    const el = {
        tagName: String( tag ).toUpperCase(),
        nodeType: 1,
        id: '',
        className: '',
        type: '',
        title: '',
        childNodes: [],
        parentNode: null,
        attributes: {},
        listeners: {},
        scrolled: 0
    }

    const classSet = () => new Set( String( el.className ).split( ' ' ).filter( ( name ) => name.length > 0 ) )

    el.classList = {
        add: ( name ) => { const set = classSet(); set.add( name ); el.className = Array.from( set ).join( ' ' ) },
        remove: ( name ) => { const set = classSet(); set.delete( name ); el.className = Array.from( set ).join( ' ' ) },
        contains: ( name ) => classSet().has( name )
    }
    el.setAttribute = ( name, value ) => { el.attributes[ name ] = String( value ) }
    el.getAttribute = ( name ) => ( el.attributes[ name ] === undefined ? null : el.attributes[ name ] )
    el.appendChild = ( child ) => { child.parentNode = el; el.childNodes.push( child ); return child }
    el.removeChild = ( child ) => { el.childNodes = el.childNodes.filter( ( node ) => node !== child ); child.parentNode = null; return child }
    el.replaceChild = ( fresh, old ) => {
        const at = el.childNodes.indexOf( old )
        const incoming = fresh.nodeType === 11 ? fresh.childNodes : [ fresh ]
        incoming.forEach( ( node ) => { node.parentNode = el } )
        el.childNodes.splice( at, 1, ...incoming )
        old.parentNode = null

        return old
    }
    el.addEventListener = ( name, fn ) => { el.listeners[ name ] = ( el.listeners[ name ] === undefined ? [] : el.listeners[ name ] ).concat( [ fn ] ) }
    el.scrollIntoView = () => { el.scrolled += 1 }
    el.querySelectorAll = ( selector ) => elementDescendants( el ).filter( ( child ) => selectorMatches( child, selector ) )
    el.querySelector = ( selector ) => {
        const hits = el.querySelectorAll( selector )

        return hits.length === 0 ? null : hits[ 0 ]
    }

    Object.defineProperty( el, 'textContent', {
        get: () => el.childNodes.map( ( child ) => ( child.nodeType === 3 ? child.nodeValue : child.textContent ) ).join( '' ),
        set: ( value ) => { el.childNodes = [ makeText( value ) ] }
    } )

    return el
}


// The click a browser would deliver: the recorded listener, with a preventDefault/stopPropagation spy.
const clickOn = ( el ) => {
    const seen = { prevented: 0, stopped: 0 }
    const event = { preventDefault: () => { seen.prevented += 1 }, stopPropagation: () => { seen.stopped += 1 } }
    const handlers = el.listeners[ 'click' ] === undefined ? [] : el.listeners[ 'click' ]
    handlers.forEach( ( fn ) => { fn( event ) } )

    return { seen, handled: handlers.length }
}


const makeSandbox = ( { contentEl, currentFileName = 'REV-02.md', currentResearchFile = null, roots = [] } ) => {
    const wsSent = []
    const allRoots = [ contentEl ].concat( roots )
    const byId = ( id ) => {
        const hit = allRoots
            .flatMap( ( root ) => [ root ].concat( elementDescendants( root ) ) )
            .filter( ( el ) => el.id === id )

        return hit.length === 0 ? null : hit[ 0 ]
    }

    return {
        console,
        contentEl,
        currentFileName,
        currentResearchFile,
        currentWs: { send: ( payload ) => { wsSent.push( payload ) } },
        pendingChapterAnchor: null,
        wsSent,
        window: { scrollTo: () => {} },
        setTimeout: ( fn ) => { fn(); return 0 },
        document: {
            createElement: ( tag ) => makeElement( tag ),
            createTextNode: ( value ) => makeText( value ),
            createDocumentFragment: () => makeFragment(),
            getElementById: byId
        }
    }
}


const APPARATUS_FUNCTIONS = [
    'slugify',
    'cssEscapeAttr',
    'annotationNumber',
    'annotationStatus',
    'annotationReference',
    'currentRevisionId',
    'annotationsInScope',
    'applyAnnotations',
    'renderAnnotationApparatus',
    'annotationApparatusEntry',
    'annotationResolvedLine',
    'buildResolvedChapterLink',
    'flashAnnotationTarget',
    'scrollToAnnotationTarget',
    'jumpToApparatusEntry',
    'jumpToAnnotationMark',
    'scrollToChapterSlug',
    'jumpToResolvedChapter',
    'resolvePendingChapterAnchor'
]


const annotation = ( { id, comment = 'Kommentar', revisionId = 'REV-02', anmStatus = 'offen', resolvedIn = null, targetKind = 'revision', researchFile = null, exact = 'Zitat' } ) => ( {
    id,
    revisionId,
    targetKind,
    researchFile,
    comment,
    anmStatus,
    resolvedIn,
    anchor: { type: 'text-quote', exact, prefix: '', suffix: '', chapterSlug: '16-viewer', sourceLine: 12 }
} )


describe( 'PRD-V7 — the shape the PRD fixes (source cuts)', () => {
    let client = ''
    let server = ''

    beforeAll( async () => {
        client = await readEmittedScript()
        server = await readMemoViewSource()

        expect( client.length ).toBeGreaterThan( 0 )
        expect( server.length ).toBeGreaterThan( 0 )
    } )


    it( 'A1 — the anchor skip list is exactly { PRE, SCRIPT, STYLE, MARK }: A and CODE are GONE (4 of 4)', () => {
        const from = client.indexOf( 'function anchorTextQuote(' )
        expect( from ).toBeGreaterThan( -1 )
        const block = client.slice( from, client.indexOf( 'function allIndexesOf(', from ) )
        const line = block.split( '\n' ).filter( ( row ) => row.includes( 'var skip = {' ) )

        expect( line.length ).toBe( 1 )
        expect( line[ 0 ].includes( "'PRE': true" ) ).toBe( true )
        expect( line[ 0 ].includes( "'SCRIPT': true" ) ).toBe( true )
        expect( line[ 0 ].includes( "'STYLE': true" ) ).toBe( true )
        expect( line[ 0 ].includes( "'MARK': true" ) ).toBe( true )
        // WI-176: these two are the defect. A marked passage crossing a link or inline code was a
        // permanent orphan while they were in the set.
        expect( line[ 0 ].includes( "'A': true" ) ).toBe( false )
        expect( line[ 0 ].includes( "'CODE': true" ) ).toBe( false )
        expect( line[ 0 ].split( ': true' ).length - 1 ).toBe( 4 )
    } )


    // Memo 081, PRD-42 (WI-076): the ASSERTION is unchanged — the wiki pass's skip set still holds its
    // five entries including CODE and A, and it is still a DIFFERENT set from the annotation one above.
    // What changed is WHERE that set is written: PRD-42 added a second post-render pass (resolveIdLinks)
    // which the memo requires to use "the SAME skip set" (REV-16:3055), so the literal moved out of the
    // function body to the module-scope CONTENT_SKIP_TAGS both passes now read. Two skip sets that are
    // supposed to agree are exactly the parallel path that requirement rejects.
    //
    // The case follows the binding instead of assuming the old location, and it still measures the same
    // five entries — old expectation: one `var skip = { … }` literal inside resolveWikiLinks with 5
    // entries; new expectation: one `var skip = CONTENT_SKIP_TAGS` binding inside resolveWikiLinks plus
    // exactly one module-scope declaration carrying those same 5 entries.
    it( 'A2 — the OTHER skip list (resolveWikiLinks) is untouched: still 5 entries incl. CODE and A', () => {
        const from = client.indexOf( 'function resolveWikiLinks(' )
        expect( from ).toBeGreaterThan( -1 )
        const block = client.slice( from, client.indexOf( 'function buildWikiLink(', from ) )
        const binding = block.split( '\n' ).filter( ( row ) => row.includes( 'var skip = ' ) )

        expect( binding.length ).toBe( 1 )
        expect( binding[ 0 ].trim() ).toBe( 'var skip = CONTENT_SKIP_TAGS' )

        const declaration = client.split( '\n' ).filter( ( row ) => row.trim().startsWith( 'var CONTENT_SKIP_TAGS = {' ) )

        expect( declaration.length ).toBe( 1 )
        expect( declaration[ 0 ].includes( "'CODE': true" ) ).toBe( true )
        expect( declaration[ 0 ].includes( "'A': true" ) ).toBe( true )
        expect( declaration[ 0 ].split( ': true' ).length - 1 ).toBe( 5 )
    } )


    it( 'A4 — the badge still swallows the click (preventDefault + stopPropagation) and now jumps to the entry', () => {
        const from = client.indexOf( 'function annotationBadge(' )
        const block = client.slice( from, client.indexOf( 'function annotationsInScope(', from ) )

        expect( block.includes( 'e.preventDefault()' ) ).toBe( true )
        expect( block.includes( 'e.stopPropagation()' ) ).toBe( true )
        expect( block.includes( 'jumpToApparatusEntry( ann.id )' ) ).toBe( true )
        expect( block.includes( 'showAnnotationDetail' ) ).toBe( false )
    } )


    it( 'the read-only parallel path is REMOVED, not left standing beside the apparatus (2 declarations gone)', () => {
        expect( client.includes( 'function showAnnotationDetail(' ) ).toBe( false )
        expect( client.includes( 'function renderOrphanList(' ) ).toBe( false )
        expect( client.includes( "getElementById( 'anm-orphan-list' )" ) ).toBe( false )
        // …while the AUTHORING path keeps the modal it always owned.
        expect( client.includes( 'function openAnnotationModal(' ) ).toBe( true )
        expect( client.includes( 'function saveAnnotation(' ) ).toBe( true )
    } )


    it( 'A14 — the PATCH branch broadcasts BEFORE it answers 200, and carries 404 / 422 / 400', () => {
        const from = server.indexOf( "if( url.startsWith( '/api/annotations/' ) && req.method === 'PATCH' )" )
        expect( from ).toBeGreaterThan( -1 )
        const block = server.slice( from, server.indexOf( "if( url.startsWith( '/api/transcripts/' )", from ) )

        const broadcastAt = block.indexOf( '#broadcastAnnotationList' )
        const okAt = block.indexOf( "sendJson( res, 200," )
        expect( broadcastAt ).toBeGreaterThan( -1 )
        expect( okAt ).toBeGreaterThan( broadcastAt )
        expect( block.includes( 'sendJson( res, 404,' ) ).toBe( true )
        expect( block.includes( 'sendJson( res, 422,' ) ).toBe( true )
        expect( block.includes( 'sendJson( res, 400,' ) ).toBe( true )
        expect( block.includes( 'AnnotationStore.setStatus(' ) ).toBe( true )
    } )


    it( 'the PATCH branch adds NO second store, NO second listener and NO write verb of its own', () => {
        const from = server.indexOf( "if( url.startsWith( '/api/annotations/' ) && req.method === 'PATCH' )" )
        const block = server.slice( from, server.indexOf( "if( url.startsWith( '/api/transcripts/' )", from ) );

        [ 'writeFile', 'unlink', 'rename', 'rm(', 'server.listen' ]
            .forEach( ( verb ) => { expect( block.includes( verb ) ).toBe( false ) } )
        // The memo dir comes from the SAME chain the POST branch uses — no second resolution path.
        expect( block.includes( 'MemoView.resolveMemoDir(' ) ).toBe( true )
        // the bindings stay what they were: 2 real ones (startServer + serveMemos) + 1 port probe.
        expect( server.split( '.listen(' ).length - 1 ).toBe( 3 )
        expect( server.split( 'server.listen(' ).length - 1 ).toBe( 2 )
    } )


    it( 'PATCH is method-gated: the only /api/annotations/<id> branch is the PATCH one (1 of 1)', () => {
        const hits = server.split( "url.startsWith( '/api/annotations/' )" ).length - 1

        expect( hits ).toBe( 1 )
        expect( server.includes( "url.startsWith( '/api/annotations/' ) && req.method === 'PATCH'" ) ).toBe( true )
    } )


    it( 'the new client block keeps the classic-script house style (no for/while, no arrows, no trailing semicolons)', () => {
        const from = client.indexOf( 'function renderAnnotationApparatus(' )
        const to = client.indexOf( 'function cssEscapeAttr(', from )
        expect( from ).toBeGreaterThan( -1 )
        expect( to ).toBeGreaterThan( from )
        const block = client.slice( from, to )

        expect( /\bfor\s*\(/.test( block ) ).toBe( false )
        expect( /\bwhile\s*\(/.test( block ) ).toBe( false )
        expect( block.includes( '=>' ) ).toBe( false )
        const trailing = block
            .split( '\n' )
            .filter( ( row ) => /;\s*$/.test( row ) )
        expect( trailing ).toEqual( [] )
    } )
} )


describe( 'PRD-V7 — AnnotationStore.setStatus, run against a real memo dir (A9-A12)', () => {
    let memoDir = ''
    const textAnchor = { type: 'text-quote', exact: 'Trajectory', prefix: '', suffix: '', chapterSlug: '3-trajectory' }


    beforeEach( async () => {
        memoDir = await mkdtemp( join( tmpdir(), 'memo-anm-v7-' ) )
    } )


    afterEach( async () => {
        if( memoDir.length > 0 ) {
            await rm( memoDir, { recursive: true, force: true } )
        }
    } )


    const seed = async () => AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-02', anchor: textAnchor, comment: 'Hallo', memoDir } )


    it( 'create writes resolvedIn: null — the back-reference is part of the schema, not an absent key', async () => {
        const created = await seed()
        const record = JSON.parse( await readFile( created.path, 'utf-8' ) )

        expect( Object.keys( record ).includes( 'resolvedIn' ) ).toBe( true )
        expect( record.resolvedIn ).toBe( null )
        expect( record.anmStatus ).toBe( 'offen' )
    } )


    it( 'A9 — a status outside ANM_STATUS_VALUES is refused with status:false and NOTHING is written', async () => {
        const created = await seed()
        const before = await readFile( created.path, 'utf-8' )

        const result = await AnnotationStore.setStatus( { id: 'ANM-001', anmStatus: 'erledigt', memoDir } )

        expect( result.status ).toBe( false )
        expect( result.messages.join( ' ' ) ).toContain( ANM_STATUS_VALUES.join( ', ' ) )
        expect( await readFile( created.path, 'utf-8' ) ).toBe( before )
        // and the archive stayed empty — a refusal must not even rotate the file.
        const files = await readdir( join( memoDir, '_annotations' ) )
        expect( files ).toEqual( [ 'ANM-001.json' ] )
    } )


    it( 'A10 — "eingearbeitet" without a usable resolvedIn is refused (4 of 4 malformed shapes)', async () => {
        await seed()
        const shapes = [
            { label: 'missing', resolvedIn: undefined },
            { label: 'no revisionId', resolvedIn: { chapters: [ '16-viewer' ] } },
            { label: 'empty chapters', resolvedIn: { revisionId: 'REV-18', chapters: [] } },
            { label: 'blank chapter entry', resolvedIn: { revisionId: 'REV-18', chapters: [ '  ' ] } }
        ]

        const results = await Promise.all( shapes.map( ( shape ) => AnnotationStore.setStatus( { id: 'ANM-001', anmStatus: 'eingearbeitet', resolvedIn: shape.resolvedIn, memoDir } ) ) )

        expect( results.length ).toBe( 4 )
        expect( results.filter( ( entry ) => entry.status === false ).length ).toBe( 4 )
        expect( results.every( ( entry ) => entry.messages.join( ' ' ).includes( 'resolvedIn' ) ) ).toBe( true )
        const stored = JSON.parse( await readFile( join( memoDir, '_annotations', 'ANM-001.json' ), 'utf-8' ) )
        expect( stored.anmStatus ).toBe( 'offen' )
    } )


    it( 'A10 — a well-formed back-reference is accepted and stored trimmed, with BOTH chapters', async () => {
        await seed()
        const result = await AnnotationStore.setStatus( {
            id: 'ANM-001',
            anmStatus: 'eingearbeitet',
            resolvedIn: { revisionId: 'REV-18', chapters: [ ' 16-viewer ', '2-form' ] },
            memoDir
        } )

        expect( result.status ).toBe( true )
        expect( result.item.anmStatus ).toBe( 'eingearbeitet' )
        expect( result.item.resolvedIn ).toEqual( { revisionId: 'REV-18', chapters: [ '16-viewer', '2-form' ] } )
        const stored = JSON.parse( await readFile( join( memoDir, '_annotations', 'ANM-001.json' ), 'utf-8' ) )
        expect( stored.resolvedIn.chapters.length ).toBe( 2 )
    } )


    it( 'A11 — setting it back to "offen" CLEARS resolvedIn (no stale back-reference survives)', async () => {
        await seed()
        await AnnotationStore.setStatus( { id: 'ANM-001', anmStatus: 'eingearbeitet', resolvedIn: { revisionId: 'REV-18', chapters: [ '16-viewer' ] }, memoDir } )

        const reopened = await AnnotationStore.setStatus( { id: 'ANM-001', anmStatus: 'offen', resolvedIn: { revisionId: 'REV-18', chapters: [ '16-viewer' ] }, memoDir } )

        expect( reopened.status ).toBe( true )
        expect( reopened.item.resolvedIn ).toBe( null )
        const stored = JSON.parse( await readFile( join( memoDir, '_annotations', 'ANM-001.json' ), 'utf-8' ) )
        expect( stored.resolvedIn ).toBe( null )
    } )


    it( 'A12 — the write goes through archive-then-write: the previous version is in the archive, the id is unchanged', async () => {
        const created = await seed()
        const before = JSON.parse( await readFile( created.path, 'utf-8' ) )

        const result = await AnnotationStore.setStatus( { id: 'ANM-001', anmStatus: 'eingearbeitet', resolvedIn: { revisionId: 'REV-18', chapters: [ '16-viewer' ] }, memoDir } )

        expect( result.id ).toBe( 'ANM-001' )
        expect( result.path ).toBe( created.path )
        const files = await readdir( join( memoDir, '_annotations' ) )
        const archived = files.filter( ( name ) => /^ANM-001\..+\.json$/.test( name ) )
        expect( archived.length ).toBe( 1 )
        const archivedRecord = JSON.parse( await readFile( join( memoDir, '_annotations', archived[ 0 ] ), 'utf-8' ) )
        expect( archivedRecord.anmStatus ).toBe( 'offen' )
        // …and the archived copy is the pre-image, byte for byte in its identifying fields.
        expect( archivedRecord.id ).toBe( before.id )
        expect( archivedRecord.createdAt ).toBe( before.createdAt )
        // the list still reports exactly ONE annotation (archived versions are not listed).
        const listed = await AnnotationStore.list( { memoDir } )
        expect( listed.annotations.length ).toBe( 1 )
        expect( listed.annotations[ 0 ].anmStatus ).toBe( 'eingearbeitet' )
    } )


    it( 'a bad id, an unknown id and a missing memoDir all fail LOUD and name what is wrong (3 of 3)', async () => {
        await seed()
        const badId = await AnnotationStore.setStatus( { id: 'ANM-1', anmStatus: 'offen', memoDir } )
        const unknown = await AnnotationStore.setStatus( { id: 'ANM-404', anmStatus: 'offen', memoDir } )
        const noDir = await AnnotationStore.setStatus( { id: 'ANM-001', anmStatus: 'offen', memoDir: '' } )

        expect( badId.status ).toBe( false )
        expect( badId.messages.join( ' ' ) ).toContain( 'ANM-NNN' )
        expect( unknown.status ).toBe( false )
        expect( unknown.messages.join( ' ' ) ).toContain( 'ANM-404' )
        expect( noDir.status ).toBe( false )
        expect( noDir.messages.join( ' ' ) ).toContain( 'memoDir' )
    } )


    it( 'a record written BEFORE this PRD (no resolvedIn key) is updated without a crash', async () => {
        const dir = join( memoDir, '_annotations' )
        await mkdir( dir, { recursive: true } )
        const legacy = { id: 'ANM-007', documentId: 'doc-1', targetKind: 'revision', revisionId: 'REV-02', researchFile: null, anchor: textAnchor, comment: 'alt', anmStatus: 'offen', createdAt: '2026-01-01T00:00:00.000Z' }
        await writeFile( join( dir, 'ANM-007.json' ), JSON.stringify( legacy, null, 4 ) + '\n', 'utf-8' )

        const result = await AnnotationStore.setStatus( { id: 'ANM-007', anmStatus: 'eingearbeitet', resolvedIn: { revisionId: 'REV-18', chapters: [ '16-viewer' ] }, memoDir } )

        expect( result.status ).toBe( true )
        expect( result.item.resolvedIn.revisionId ).toBe( 'REV-18' )
        expect( result.item.comment ).toBe( 'alt' )
    } )
} )


describe( 'PRD-V7 — the apparatus in the run (vm sandbox, the REAL client functions)', () => {
    let liftedSource = ''

    beforeAll( async () => {
        const lifted = await extractFunctionSources( APPARATUS_FUNCTIONS )
        liftedSource = lifted[ 'source' ]

        expect( lifted[ 'names' ].length ).toBe( APPARATUS_FUNCTIONS.length )
        expect( liftedSource.length ).toBeGreaterThan( 0 )
    } )


    const run = ( { script, contentEl, currentFileName, currentResearchFile, extra } ) => {
        const sandbox = Object.assign( makeSandbox( { contentEl, currentFileName, currentResearchFile } ), extra === undefined ? {} : extra )
        vm.createContext( sandbox )
        const out = vm.runInContext( `${ liftedSource }\n${ script }`, sandbox )

        return { sandbox, out }
    }


    const apparatusOf = ( contentEl ) => contentEl.childNodes.filter( ( node ) => node.id === 'anm-apparatus' )
    const entriesOf = ( contentEl ) => elementDescendants( contentEl ).filter( ( node ) => String( node.className ).includes( 'anm-ref-item' ) )


    it( 'A6/A18 — every annotation in scope gets EXACTLY ONE entry: 2 anchored + 1 orphan = 3 of 3', () => {
        const contentEl = makeElement( 'div' )
        const script = 'renderAnnotationApparatus( { anchored: __anchored, orphans: __orphans } )'
        const { } = run( {
            script,
            contentEl,
            extra: {
                __anchored: [ annotation( { id: 'ANM-001' } ), annotation( { id: 'ANM-003' } ) ],
                __orphans: [ annotation( { id: 'ANM-002' } ) ]
            }
        } )

        expect( apparatusOf( contentEl ).length ).toBe( 1 )
        const entries = entriesOf( contentEl )
        expect( entries.length ).toBe( 3 )
        expect( entries.map( ( entry ) => entry.id ) ).toEqual( [ 'anm-ref-ANM-001', 'anm-ref-ANM-003', 'anm-ref-ANM-002' ] )
        const title = contentEl.childNodes[ 0 ].childNodes[ 0 ]
        expect( title.textContent ).toBe( 'Anmerkungen (3)' )
        const groups = elementDescendants( contentEl ).filter( ( node ) => node.getAttribute( 'data-anm-group' ) !== null )
        expect( groups.map( ( group ) => group.getAttribute( 'data-anm-group' ) ) ).toEqual( [ 'verankert', 'nicht-verankert' ] )
    } )


    it( 'the pass is idempotent: rendering twice leaves ONE apparatus, not two', () => {
        const contentEl = makeElement( 'div' )
        const script = [
            'renderAnnotationApparatus( { anchored: __anchored, orphans: [] } )',
            'renderAnnotationApparatus( { anchored: __anchored, orphans: [] } )'
        ].join( '\n' )
        run( { script, contentEl, extra: { __anchored: [ annotation( { id: 'ANM-001' } ) ] } } )

        expect( apparatusOf( contentEl ).length ).toBe( 1 )
        expect( entriesOf( contentEl ).length ).toBe( 1 )
    } )


    it( 'an empty scope renders NO apparatus at all — an empty box is not a result', () => {
        const contentEl = makeElement( 'div' )
        run( { script: 'renderAnnotationApparatus( { anchored: [], orphans: [] } )', contentEl } )

        expect( contentEl.childNodes.length ).toBe( 0 )
    } )


    it( 'A8 — an entry carries reference, comment and a status chip; "eingearbeitet" gets its own chip class', () => {
        const contentEl = makeElement( 'div' )
        run( {
            script: 'renderAnnotationApparatus( { anchored: __anchored, orphans: [] } )',
            contentEl,
            extra: {
                __anchored: [
                    annotation( { id: 'ANM-001', comment: 'Diese Notes werden falsch angezeigt.' } ),
                    annotation( { id: 'ANM-002', anmStatus: 'eingearbeitet', resolvedIn: { revisionId: 'REV-18', chapters: [ '16-viewer', '2-form' ] } } )
                ]
            }
        } )

        const entries = entriesOf( contentEl )
        expect( entries.length ).toBe( 2 )

        const open = entries[ 0 ]
        expect( open.getAttribute( 'data-anm-status' ) ).toBe( 'offen' )
        const openChip = open.querySelector( '[data-anm-status="offen"]' )
        expect( openChip.textContent ).toBe( 'offen' )
        expect( openChip.className ).toBe( 'anm-chip' )
        expect( open.querySelectorAll( 'div' ).filter( ( n ) => n.className === 'anm-ref-quote' )[ 0 ].textContent ).toContain( 'Kapitel 16-viewer' )
        expect( open.querySelectorAll( 'div' ).filter( ( n ) => n.className === 'anm-ref-comment' )[ 0 ].textContent ).toBe( 'Diese Notes werden falsch angezeigt.' )
        expect( open.querySelectorAll( 'div' ).filter( ( n ) => n.className === 'anm-ref-resolved' ).length ).toBe( 0 )

        const done = entries[ 1 ]
        expect( done.getAttribute( 'data-anm-status' ) ).toBe( 'eingearbeitet' )
        expect( done.querySelector( '[data-anm-status="eingearbeitet"]' ).className ).toBe( 'anm-chip anm-chip-done' )
    } )


    it( 'A16 — a worked-in entry names the revision and carries ONE link per chapter (2 of 2)', () => {
        const contentEl = makeElement( 'div' )
        run( {
            script: 'renderAnnotationApparatus( { anchored: __anchored, orphans: [] } )',
            contentEl,
            extra: { __anchored: [ annotation( { id: 'ANM-002', anmStatus: 'eingearbeitet', resolvedIn: { revisionId: 'REV-18', chapters: [ '16-viewer', '2-form' ] } } ) ] }
        } )

        const resolved = elementDescendants( contentEl ).filter( ( node ) => node.className === 'anm-ref-resolved' )
        expect( resolved.length ).toBe( 1 )
        expect( resolved[ 0 ].textContent ).toContain( 'Eingearbeitet in REV-18' )
        const links = resolved[ 0 ].querySelectorAll( 'a' )
        expect( links.length ).toBe( 2 )
        expect( links.map( ( link ) => link.getAttribute( 'data-anm-chapter' ) ) ).toEqual( [ '16-viewer', '2-form' ] )
        expect( links[ 0 ].textContent ).toBe( 'Kapitel 16-viewer' )
    } )


    it( 'A7 — badge -> entry and the entry\'s ↩ -> mark really move to the OTHER element (2 jumps)', () => {
        const contentEl = makeElement( 'div' )
        const mark = makeElement( 'mark' )
        mark.id = 'anm-mark-ANM-001'
        mark.setAttribute( 'data-anm', 'ANM-001' )
        contentEl.appendChild( mark )

        const { sandbox } = run( {
            script: [
                'renderAnnotationApparatus( { anchored: __anchored, orphans: [] } )',
                'var __forward = jumpToApparatusEntry( "ANM-001" )',
                'var __back = jumpToAnnotationMark( "ANM-001" )',
                '__result = { forward: __forward, back: __back }'
            ].join( '\n' ),
            contentEl,
            extra: { __anchored: [ annotation( { id: 'ANM-001' } ) ], __result: null }
        } )

        expect( sandbox.__result ).toEqual( { forward: true, back: true } )
        const entry = entriesOf( contentEl )[ 0 ]
        expect( entry.scrolled ).toBe( 1 )
        expect( mark.scrolled ).toBe( 1 )
    } )


    it( 'A5/A7 — the ↩ button exists ONLY on an anchored entry and swallows its click', () => {
        const contentEl = makeElement( 'div' )
        run( {
            script: 'renderAnnotationApparatus( { anchored: __anchored, orphans: __orphans } )',
            contentEl,
            extra: { __anchored: [ annotation( { id: 'ANM-001' } ) ], __orphans: [ annotation( { id: 'ANM-002' } ) ] }
        } )

        const backs = elementDescendants( contentEl ).filter( ( node ) => node.className === 'anm-ref-back' )
        expect( backs.length ).toBe( 1 )
        expect( backs[ 0 ].getAttribute( 'data-anm-back' ) ).toBe( 'ANM-001' )

        const click = clickOn( backs[ 0 ] )
        expect( click.handled ).toBe( 1 )
        expect( click.seen ).toEqual( { prevented: 1, stopped: 1 } )
    } )


    it( 'the back-jump finds the mark even when the mark id was taken by another annotation (data-anm fallback)', () => {
        const contentEl = makeElement( 'div' )
        const row = makeElement( 'tr' )
        row.id = 'anm-mark-ANM-001'
        const badge = makeElement( 'span' )
        badge.setAttribute( 'data-anm', 'ANM-009' )
        row.appendChild( badge )
        contentEl.appendChild( row )

        const { sandbox } = run( {
            script: '__result = jumpToAnnotationMark( "ANM-009" )',
            contentEl,
            extra: { __result: null }
        } )

        expect( sandbox.__result ).toBe( true )
        expect( badge.scrolled ).toBe( 1 )
    } )


    it( 'a jump to an id that does not exist reports false instead of throwing', () => {
        const contentEl = makeElement( 'div' )
        const { sandbox } = run( {
            script: '__result = [ jumpToApparatusEntry( "ANM-404" ), jumpToAnnotationMark( "ANM-404" ), scrollToChapterSlug( "kein-kapitel" ) ]',
            contentEl,
            extra: { __result: null }
        } )

        expect( sandbox.__result ).toEqual( [ false, false, false ] )
    } )


    it( 'A15 — a revision view keeps ONLY its own annotations (2 of 5 survive the scope filter)', () => {
        const contentEl = makeElement( 'div' )
        const { sandbox } = run( {
            script: '__result = annotationsInScope( __list ).map( function( a ) { return a.id } )',
            contentEl,
            currentFileName: 'REV-02.md',
            extra: {
                __result: null,
                __list: [
                    annotation( { id: 'ANM-001', revisionId: 'REV-02' } ),
                    annotation( { id: 'ANM-002', revisionId: 'REV-18' } ),
                    annotation( { id: 'ANM-003', revisionId: 'REV-02' } ),
                    annotation( { id: 'ANM-004', revisionId: 'REV-02', targetKind: 'research', researchFile: 'context/x.md' } ),
                    annotation( { id: 'ANM-005', revisionId: null } )
                ]
            }
        } )

        expect( sandbox.__result ).toEqual( [ 'ANM-001', 'ANM-003' ] )
    } )


    it( 'A15 — a research view keeps ONLY its own file (1 of 3), and a non-revision file keeps none', () => {
        const list = [
            annotation( { id: 'ANM-001', revisionId: 'REV-02' } ),
            annotation( { id: 'ANM-004', targetKind: 'research', researchFile: 'context/a.md' } ),
            annotation( { id: 'ANM-005', targetKind: 'research', researchFile: 'context/b.md' } )
        ]
        const research = run( {
            script: '__result = annotationsInScope( __list ).map( function( a ) { return a.id } )',
            contentEl: makeElement( 'div' ),
            currentResearchFile: 'context/a.md',
            extra: { __result: null, __list: list }
        } )
        const noRevision = run( {
            script: '__result = annotationsInScope( __list ).map( function( a ) { return a.id } )',
            contentEl: makeElement( 'div' ),
            currentFileName: 'PROGRESS.md',
            extra: { __result: null, __list: list }
        } )

        expect( research.sandbox.__result ).toEqual( [ 'ANM-004' ] )
        expect( noRevision.sandbox.__result ).toEqual( [] )
    } )


    it( 'A18 — applyAnnotations puts EVERY in-scope annotation into exactly one group (4 in scope -> 4 entries)', () => {
        const contentEl = makeElement( 'div' )
        const { sandbox } = run( {
            script: 'applyAnnotations()',
            contentEl,
            currentFileName: 'REV-02.md',
            extra: {
                // ANM-002 does not anchor, ANM-004 carries no anchor object at all, ANM-005 is out of scope.
                anchorTextQuote: ( ann ) => ann.id !== 'ANM-002',
                anchorTableRow: () => true,
                lastAnnotations: [
                    annotation( { id: 'ANM-001' } ),
                    annotation( { id: 'ANM-002' } ),
                    annotation( { id: 'ANM-003' } ),
                    Object.assign( annotation( { id: 'ANM-004' } ), { anchor: null } ),
                    annotation( { id: 'ANM-005', revisionId: 'REV-18' } )
                ]
            }
        } )

        expect( sandbox.pendingChapterAnchor ).toBe( null )
        const entries = entriesOf( contentEl )
        expect( entries.length ).toBe( 4 )
        const groups = elementDescendants( contentEl ).filter( ( node ) => node.getAttribute( 'data-anm-group' ) !== null )
        expect( groups[ 0 ].querySelectorAll( 'div' ).filter( ( n ) => n.className === 'anm-ref-item' ).map( ( n ) => n.id ) ).toEqual( [ 'anm-ref-ANM-001', 'anm-ref-ANM-003' ] )
        expect( groups[ 1 ].querySelectorAll( 'div' ).filter( ( n ) => n.className === 'anm-ref-item' ).map( ( n ) => n.id ) ).toEqual( [ 'anm-ref-ANM-002', 'anm-ref-ANM-004' ] )
    } )


    it( 'A16 — a chapter of the SAME revision scrolls in the page and sends NOTHING over the socket', () => {
        const contentEl = makeElement( 'div' )
        const heading = makeElement( 'h2' )
        heading.id = '16-viewer-defekte-und-stabilitaet-code'
        contentEl.appendChild( heading )

        const { sandbox } = run( {
            script: '__result = jumpToResolvedChapter( "REV-02", "16-viewer-defekte-und-stabilitaet-code" )',
            contentEl,
            currentFileName: 'REV-02.md',
            extra: { __result: null }
        } )

        expect( sandbox.__result ).toBe( true )
        expect( heading.scrolled ).toBe( 1 )
        expect( sandbox.wsSent ).toEqual( [] )
        expect( sandbox.pendingChapterAnchor ).toBe( null )
    } )


    it( 'A16 — a chapter of ANOTHER revision navigates over the existing channel and remembers the anchor', () => {
        const contentEl = makeElement( 'div' )
        const { sandbox } = run( {
            script: '__result = jumpToResolvedChapter( "REV-18", "24-sprache-und-namensgebung-docs" )',
            contentEl,
            currentFileName: 'REV-02.md',
            extra: { __result: null }
        } )

        expect( sandbox.__result ).toBe( false )
        expect( sandbox.wsSent ).toEqual( [ JSON.stringify( { type: 'navigate', path: 'REV-18.md' } ) ] )
        expect( sandbox.pendingChapterAnchor ).toBe( '24-sprache-und-namensgebung-docs' )
    } )


    it( 'A16 — the remembered anchor is redeemed ONCE by the next pass, then cleared', () => {
        const contentEl = makeElement( 'div' )
        const heading = makeElement( 'h2' )
        heading.id = '24-sprache-und-namensgebung-docs'
        contentEl.appendChild( heading )

        const { sandbox } = run( {
            script: '__result = [ resolvePendingChapterAnchor(), resolvePendingChapterAnchor() ]',
            contentEl,
            currentFileName: 'REV-18.md',
            extra: { __result: null, pendingChapterAnchor: '24-sprache-und-namensgebung-docs' }
        } )

        expect( sandbox.__result ).toEqual( [ true, false ] )
        expect( heading.scrolled ).toBe( 1 )
        expect( sandbox.pendingChapterAnchor ).toBe( null )
    } )


    it( 'the chapter jump also finds a heading whose id was renumbered (slugify comparison, not id only)', () => {
        const contentEl = makeElement( 'div' )
        const heading = makeElement( 'h2' )
        heading.id = '2-form-und-aufbau-eines-memos-docs-1'
        heading.textContent = '2. Form und Aufbau eines Memos [Docs]'
        contentEl.appendChild( heading )

        const { sandbox } = run( {
            script: '__result = scrollToChapterSlug( "2-form-und-aufbau-eines-memos-docs" )',
            contentEl,
            extra: { __result: null }
        } )

        expect( sandbox.__result ).toBe( true )
        expect( heading.scrolled ).toBe( 1 )
    } )


    it( 'memo text reaches the entry as TEXT, never as markup (a <script> comment stays inert)', () => {
        const contentEl = makeElement( 'div' )
        run( {
            script: 'renderAnnotationApparatus( { anchored: [], orphans: __orphans } )',
            contentEl,
            extra: { __orphans: [ annotation( { id: 'ANM-001', comment: '<script>alert(1)</script>' } ) ] }
        } )

        const comment = elementDescendants( contentEl ).filter( ( node ) => node.className === 'anm-ref-comment' )[ 0 ]
        expect( comment.textContent ).toBe( '<script>alert(1)</script>' )
        expect( comment.childNodes.length ).toBe( 1 )
        expect( comment.childNodes[ 0 ].nodeType ).toBe( 3 )
    } )
} )


describe( 'PRD-V7 / WI-176 — anchoring ACROSS a link and inline code, really executed', () => {
    let liftedSource = ''

    beforeAll( async () => {
        const lifted = await extractFunctionSources( [
            'annotationNumber',
            'annotationStatus',
            'annotationBadge',
            'cssEscapeAttr',
            'collectUntilNextH2',
            'chapterScopeRoot',
            'allIndexesOf',
            'pickByContext',
            'wrapLinearRange',
            'anchorTextQuote',
            'jumpToApparatusEntry',
            'scrollToAnnotationTarget',
            'flashAnnotationTarget'
        ] )
        liftedSource = lifted[ 'source' ]

        expect( lifted[ 'names' ].length ).toBe( 13 )
    } )


    // <p>lead <TAG>inner</TAG> tail</p> — the exact shape the memo renders for a footnote link and for
    // inline code.
    const paragraphWith = ( { tag, lead, inner, tail } ) => {
        const contentEl = makeElement( 'div' )
        const p = makeElement( 'p' )
        const wrapper = makeElement( tag )
        wrapper.appendChild( makeText( inner ) )
        p.appendChild( makeText( lead ) )
        p.appendChild( wrapper )
        p.appendChild( makeText( tail ) )
        contentEl.appendChild( p )

        return { contentEl, p, wrapper }
    }


    const anchor = ( { contentEl, exact } ) => {
        const sandbox = makeSandbox( { contentEl } )
        sandbox.__ann = { id: 'ANM-002', comment: 'c', anmStatus: 'offen', anchor: { type: 'text-quote', exact, prefix: '', suffix: '', chapterSlug: null } }
        sandbox.__result = null
        vm.createContext( sandbox )
        vm.runInContext( `${ liftedSource }\n__result = anchorTextQuote( __ann )`, sandbox )

        return sandbox.__result
    }


    const marksIn = ( contentEl ) => elementDescendants( contentEl ).filter( ( node ) => node.tagName === 'MARK' )


    it( 'A3 — a quote that spans a LINK anchors (before the fix this was a permanent orphan)', () => {
        const { contentEl, wrapper } = paragraphWith( { tag: 'a', lead: 'per Selbsttest ', inner: '^18', tail: ':' } )

        const anchored = anchor( { contentEl, exact: 'Selbsttest ^18:' } )

        expect( anchored ).toBe( true )
        const marks = marksIn( contentEl )
        expect( marks.length ).toBe( 3 )
        // the middle mark really sits INSIDE the <a> — the link text is part of the marked passage.
        expect( wrapper.childNodes.filter( ( node ) => node.tagName === 'MARK' ).length ).toBe( 1 )
        expect( marks.map( ( mark ) => mark.textContent ).join( '' ) ).toBe( 'Selbsttest ^18:' )
    } )


    it( 'A3 — a quote inside INLINE CODE anchors too (the same skip-list entry, the other half)', () => {
        const { contentEl, wrapper } = paragraphWith( { tag: 'code', lead: 'ruft ', inner: 'memo controlled-language check', tail: ' auf' } )

        const anchored = anchor( { contentEl, exact: 'controlled-language' } )

        expect( anchored ).toBe( true )
        expect( wrapper.childNodes.filter( ( node ) => node.tagName === 'MARK' ).length ).toBe( 1 )
        expect( marksIn( contentEl ).map( ( mark ) => mark.textContent ).join( '' ) ).toBe( 'controlled-language' )
    } )


    it( 'PRE stays shielded: a quote inside a code BLOCK is still NOT anchored (the deliberate half)', () => {
        const { contentEl } = paragraphWith( { tag: 'pre', lead: 'Beispiel ', inner: 'npm run build', tail: ' Ende' } )

        expect( anchor( { contentEl, exact: 'npm run build' } ) ).toBe( false )
        expect( marksIn( contentEl ).length ).toBe( 0 )
    } )


    it( 'A5 — exactly ONE element carries id="anm-mark-ANM-002", even across 3 marks, and the badge is last', () => {
        const { contentEl } = paragraphWith( { tag: 'a', lead: 'per Selbsttest ', inner: '^18', tail: ':' } )

        anchor( { contentEl, exact: 'Selbsttest ^18:' } )

        const carriers = elementDescendants( contentEl ).filter( ( node ) => node.id === 'anm-mark-ANM-002' )
        expect( carriers.length ).toBe( 1 )
        expect( carriers[ 0 ].tagName ).toBe( 'MARK' )
        expect( carriers[ 0 ].textContent ).toBe( 'Selbsttest ' )
        const badges = elementDescendants( contentEl ).filter( ( node ) => String( node.className ).includes( 'anm-badge' ) )
        expect( badges.length ).toBe( 1 )
        expect( badges[ 0 ].getAttribute( 'data-anm-status' ) ).toBe( 'offen' )
    } )


    it( 'A4 — the badge inside the link swallows the click (preventDefault + stopPropagation), really fired', () => {
        const { contentEl } = paragraphWith( { tag: 'a', lead: 'per Selbsttest ', inner: '^18', tail: ':' } )
        anchor( { contentEl, exact: 'Selbsttest ^18:' } )

        const badge = elementDescendants( contentEl ).filter( ( node ) => String( node.className ).includes( 'anm-badge' ) )[ 0 ]
        const click = clickOn( badge )

        expect( click.handled ).toBe( 1 )
        expect( click.seen ).toEqual( { prevented: 1, stopped: 1 } )
    } )


    it( 'a worked-in annotation shows it on the badge itself (anm-badge-done, data-anm-status)', () => {
        const contentEl = makeElement( 'div' )
        const sandbox = makeSandbox( { contentEl } )
        sandbox.__ann = { id: 'ANM-001', comment: 'c', anmStatus: 'eingearbeitet', resolvedIn: { revisionId: 'REV-18', chapters: [ '16-viewer' ] } }
        sandbox.__badge = null
        vm.createContext( sandbox )
        vm.runInContext( `${ liftedSource }\n__badge = annotationBadge( __ann )`, sandbox )

        expect( sandbox.__badge.className ).toBe( 'anm-badge anm-badge-done' )
        expect( sandbox.__badge.getAttribute( 'data-anm-status' ) ).toBe( 'eingearbeitet' )
        expect( sandbox.__badge.textContent ).toBe( '1' )
    } )
} )


describe( 'PRD-V7 — the stylesheet carries the apparatus (A2 neighbourhood, no overlay CSS)', () => {
    let css = ''

    beforeAll( async () => {
        css = await readMemoViewStyles()

        expect( css.length ).toBeGreaterThan( 0 )
    } )


    it( 'every class the apparatus renders carries at least one rule (14 of 14)', () => {
        const names = [
            '.anm-apparatus', '.anm-apparatus-title', '.anm-apparatus-group',
            '.anm-ref-item', '.anm-ref-head', '.anm-ref-quote', '.anm-ref-comment',
            '.anm-ref-resolved', '.anm-ref-back', '.anm-ref-forward',
            '.anm-chip', '.anm-chip-done', '.anm-badge-done', '.anm-flash'
        ]
        const missing = names.filter( ( name ) => css.includes( name + ' ' ) === false && css.includes( name + '[' ) === false && css.includes( name + ':' ) === false )

        expect( names.length ).toBe( 14 )
        expect( missing ).toEqual( [] )
    } )


    it( 'the dead orphan-box rules are GONE (3 of 3) while the mark/badge rules stay untouched', () => {
        [ '.anm-orphan-list', '.anm-orphan-title', '.anm-orphan-item' ]
            .forEach( ( name ) => { expect( css.includes( name ) ).toBe( false ) } )
        expect( css.includes( 'mark.anm-mark' ) ).toBe( true )
        expect( css.includes( '.anm-badge ' ) ).toBe( true )
    } )


    it( 'the apparatus adds NO overlay: no position/z-index/backdrop rule among its declarations', () => {
        const from = css.indexOf( '.anm-apparatus {' )
        const to = css.indexOf( '.anm-flash {' )
        expect( from ).toBeGreaterThan( -1 )
        expect( to ).toBeGreaterThan( from )
        const block = css.slice( from, to )

        expect( block.includes( 'position:' ) ).toBe( false )
        expect( block.includes( 'z-index' ) ).toBe( false )
        expect( block.includes( 'inset:' ) ).toBe( false )
        expect( block.includes( 'var(--overlay' ) ).toBe( false )
        // the done-badge must beat the shared .anm-badge:hover, so it brings its own hover rule.
        expect( css.includes( '.anm-badge-done:hover' ) ).toBe( true )
    } )
} )
