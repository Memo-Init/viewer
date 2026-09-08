import { describe, it, expect, beforeAll } from '@jest/globals'

import { readEmittedScript, extractFunctionSources, sliceDeclaration } from '../helpers/extractFunction.mjs'
import { IdRegister, ID_TOKEN_SOURCE, SCOPE_PREFIX_SOURCE } from '../../src/IdRegister.mjs'


// Memo 081, PRD-42 (WI-076, T055/T060): identifiers in the rendered document.
//
// WHAT THIS SUITE EXERCISES IS THE REAL BROWSER CODE. The pass, its vocabulary mirror and its verdict
// function are lifted out of src/public/app.client.mjs with the repo's own extractFunction helper and
// run against a DOM shim — there is no jsdom in this project. A re-typed copy would stay green exactly
// when the shipped code starts behaving differently, which is the failure mode this technique avoids.
//
// EVERY CASE STATES HOW MUCH IT COMPARED. A case that asserts a zero or an absence measures the
// opposite out of the SAME fixture in the same case (T-B, T-E, T-I, T-J, T-K do this explicitly): a
// check reporting "0 wrong marks" without showing that a RIGHT one appears has not measured, it has
// kept quiet.
//
// REPO BOUNDARY: this file reads nothing outside repos/viewer. The stock is built in the test.


// ---------------------------------------------------------------------------
// The DOM shim — the surface the pass actually touches, and nothing beyond it.
// ---------------------------------------------------------------------------

function textOf( node ) {
    if( node.nodeType === 3 ) { return node.nodeValue }

    return node.childNodes.map( ( child ) => textOf( child ) ).join( '' )
}


function detach( child ) {
    const parent = child.parentNode
    if( parent === null || parent === undefined ) { return }
    const at = parent.childNodes.indexOf( child )
    if( at !== -1 ) { parent.childNodes.splice( at, 1 ) }
    child.parentNode = null
}


function adopt( parent, child, at ) {
    const incoming = child.nodeType === 11 ? child.childNodes.slice() : [ child ]
    if( child.nodeType === 11 ) { child.childNodes.length = 0 }
    incoming.forEach( ( node, offset ) => {
        detach( node )
        parent.childNodes.splice( at + offset, 0, node )
        node.parentNode = parent
    } )

    return incoming.length
}


function makeText( value ) {
    return { nodeType: 3, nodeValue: String( value ), childNodes: [], parentNode: null }
}


function matchesSelector( node, selector ) {
    const attr = ( /\[([a-z-]+)\]/.exec( selector ) || [] )[ 1 ] || null
    const bare = selector.replace( /\[[a-z-]+\]/g, '' )
    const classes = ( bare.match( /\.[A-Za-z0-9_-]+/g ) || [] ).map( ( entry ) => entry.slice( 1 ) )
    const tag = bare.split( '.' )[ 0 ]

    if( tag.length > 0 && node.tagName !== tag.toUpperCase() ) { return false }
    if( classes.some( ( name ) => node.classList.contains( name ) !== true ) ) { return false }
    if( attr !== null && node.getAttribute( attr ) === null ) { return false }

    return true
}


function descendants( node ) {
    return node.childNodes
        .filter( ( child ) => child.nodeType === 1 )
        .reduce( ( acc, child ) => acc.concat( [ child ] ).concat( descendants( child ) ), [] )
}


function makeElement( tag, classes ) {
    const node = {
        nodeType: 1,
        tagName: String( tag ).toUpperCase(),
        childNodes: [],
        parentNode: null,
        attributes: {},
        listeners: {},
        scrolled: 0,
        classSet: new Set( classes === undefined ? [] : classes )
    }

    node.classList = {
        add: ( ...names ) => names.forEach( ( name ) => node.classSet.add( name ) ),
        contains: ( name ) => node.classSet.has( name )
    }
    Object.defineProperty( node, 'className', {
        get: () => Array.from( node.classSet ).join( ' ' ),
        set: ( value ) => { node.classSet = new Set( String( value ).split( /\s+/ ).filter( ( part ) => part.length > 0 ) ) }
    } )
    Object.defineProperty( node, 'textContent', {
        get: () => textOf( node ),
        set: ( value ) => {
            node.childNodes.slice().forEach( ( child ) => detach( child ) )
            adopt( node, makeText( value ), 0 )
        }
    } )
    Object.defineProperty( node, 'firstChild', { get: () => ( node.childNodes.length > 0 ? node.childNodes[ 0 ] : null ) } )

    node.setAttribute = ( key, value ) => { node.attributes[ key ] = String( value ) }
    node.getAttribute = ( key ) => ( Object.prototype.hasOwnProperty.call( node.attributes, key ) ? node.attributes[ key ] : null )
    node.addEventListener = ( type, fn ) => {
        node.listeners[ type ] = ( node.listeners[ type ] === undefined ? [] : node.listeners[ type ] ).concat( [ fn ] )
    }
    node.appendChild = ( child ) => { adopt( node, child, node.childNodes.length ); return child }
    node.insertBefore = ( child, reference ) => {
        const at = ( reference === null || reference === undefined ) ? node.childNodes.length : node.childNodes.indexOf( reference )
        adopt( node, child, at === -1 ? node.childNodes.length : at )

        return child
    }
    node.removeChild = ( child ) => { detach( child ); return child }
    node.replaceChild = ( fresh, old ) => {
        const at = node.childNodes.indexOf( old )
        detach( old )
        adopt( node, fresh, at === -1 ? node.childNodes.length : at )

        return old
    }
    node.querySelectorAll = ( selector ) => descendants( node ).filter( ( child ) => matchesSelector( child, selector ) )
    node.querySelector = ( selector ) => {
        const hits = node.querySelectorAll( selector )

        return hits.length > 0 ? hits[ 0 ] : null
    }
    node.scrollIntoView = () => { node.scrolled = node.scrolled + 1 }
    node.closest = () => null

    return node
}


function makeDocument() {
    return {
        createElement: ( tag ) => makeElement( tag ),
        createTextNode: ( value ) => makeText( value ),
        createDocumentFragment: () => {
            const frag = { nodeType: 11, childNodes: [], parentNode: null }
            frag.appendChild = ( child ) => { adopt( frag, child, frag.childNodes.length ); return child }

            return frag
        },
        getElementById: () => null
    }
}


// A paragraph carrying exactly the given text — the shape marked() produces for prose.
function paragraph( text ) {
    const p = makeElement( 'p' )
    p.appendChild( makeText( text ) )

    return p
}


function heading( level, title ) {
    const h = makeElement( 'h' + level )
    h.appendChild( makeText( title ) )

    return h
}


function contentWith( nodes ) {
    const root = makeElement( 'div', [ 'content' ] )
    nodes.forEach( ( node ) => root.appendChild( node ) )

    return root
}


// ---------------------------------------------------------------------------
// The lift — the real client code, with the real literal lines.
// ---------------------------------------------------------------------------

const LIFTED_FUNCTIONS = [
    'slugify',
    'isDiagramContainer',
    'flattenTreeMemos',
    'matchChapterHeading',
    'idTokenSource',
    'idRecognizedPrefixes',
    'idTokenPattern',
    'idSplitToken',
    'idMemoCatalogue',
    'buildIdStock',
    'idVerdictOf',
    'buildIdMark',
    'renderIdStockNote',
    'resolveIdLinks',
    'loadTopicStore',
    'resetTopicStoreCache'
]

const LIFTED_DECLARATIONS = [ 'CONTENT_SKIP_TAGS', 'ID_VOCABULARY_MIRROR', 'ID_SEPARATOR_SOURCE', 'ID_STOCK_PREFIXES', 'topicStorePending' ]


// The one mirrored constant that is NOT a bracketed literal, so sliceDeclaration cannot take it. Read
// as the single line it is — and the case below holds that line against IdRegister.SCOPE_PREFIX_SOURCE.
function scopePrefixLine( script ) {
    const line = script
        .split( '\n' )
        .find( ( entry ) => entry.trim().startsWith( 'var ID_SCOPE_PREFIX_SOURCE = ' ) )

    if( line === undefined ) { throw new Error( 'ID_SCOPE_PREFIX_SOURCE not found in the client script' ) }

    return line.trim()
}


// Builds one isolated instance of the pass. Everything the client reads from its closure —
// document, fetch, contentEl, currentDocumentId, lastTree, diagramRegistry — is injected, so the
// lifted code is the shipped code and only its surroundings are the test's.
async function makePass( { contentEl, currentDocumentId, lastTree, fetchImpl } ) {
    const script = await readEmittedScript()
    const declarations = LIFTED_DECLARATIONS
        .map( ( name ) => sliceDeclaration( script, name ) )
        .concat( [ scopePrefixLine( script ) ] )
        .join( '\n' )
    const { source } = await extractFunctionSources( LIFTED_FUNCTIONS )
    const tail = '\nreturn { ' + LIFTED_FUNCTIONS.join( ', ' ) + ', setDocument: function( value ) { currentDocumentId = value } }'
    const factory = new Function( 'document', 'fetch', 'contentEl', 'currentDocumentId', 'lastTree', 'diagramRegistry', declarations + '\n' + source + tail )

    return factory( makeDocument(), fetchImpl, contentEl, currentDocumentId, lastTree, { mermaid: true, 'vega-lite': true } )
}


// ---------------------------------------------------------------------------
// The fixtures — a store built IN the test, never read from disk.
// ---------------------------------------------------------------------------

const DOC_LOCAL = 'memo-init--081-konvergenz'
const DOC_FOREIGN = 'memo-init--080-db-vollausbau'

const TREE = {
    'memo-init': {
        memos: [
            { documentId: DOC_LOCAL, memoName: '081-konvergenz' },
            { documentId: DOC_FOREIGN, memoName: '080-db-vollausbau' }
        ]
    }
}

const STORE = {
    topics: [
        { id: 'T055', title: 'Render-Seite', blockId: 'B003', chapter: '31. Kennungen im Dokument' },
        { id: 'T060', title: 'Verweis-Syntax', blockId: 'B003', chapter: '31. Kennungen im Dokument' },
        { id: 'T077', title: 'Form des Auftrags', blockId: 'B004', chapter: '38. Kapitel-Vertrag' }
    ],
    blocks: [ { blockId: 'B003', topicIds: [ 'T055', 'T060' ], tags: [] }, { blockId: 'B004', topicIds: [ 'T077' ], tags: [] } ],
    workItems: [ { id: 'WI-076', topicId: 'T055', title: 'Kennungen verlinken', status: 'offen' } ]
}

const HEADINGS = [ heading( 2, '31. Kennungen im Dokument' ), heading( 2, '38. Kapitel-Vertrag' ) ]

const okFetch = ( payload ) => () => Promise.resolve( { ok: true, json: () => Promise.resolve( payload ) } )
const deadFetch = () => () => Promise.reject( new Error( 'network down' ) )

function marks( root, selector ) {
    return root.querySelectorAll( selector )
}


describe( 'PRD-42 (WI-076): identifiers in the rendered document', () => {
    let script = ''

    beforeAll( async () => {
        script = await readEmittedScript()
    } )


    // ---- T-K: the parity of the mirror, and the counter-probe that proves it can fail ----
    describe( 'T-K — the mirror is held against src/IdRegister.mjs', () => {
        it( 'mirrors the recognized prefix list character for character, in the same order', async () => {
            const pass = await makePass( { contentEl: contentWith( [] ), currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            const module = IdRegister.prefixes( { recognized: true } )
            const client = pass.idRecognizedPrefixes()

            // Both lists written out, so a reader of the run sees WHAT was compared, not just that it matched.
            expect( module.status ).toBe( true )
            expect( module.prefixes.length ).toBeGreaterThan( 0 )
            expect( client.length ).toBe( module.prefixes.length )
            expect( client.join( ',' ) ).toBe( module.prefixes.join( ',' ) )
            expect( client ).toEqual( [ 'M', 'MNT', 'T', 'B', 'G', 'WI', 'RES', 'PRD', 'REQ', 'PLAN', 'ANM', 'LL', 'REV', 'SR' ] )
        } )

        it( 'rebuilds the SAME alternation the module derives — the expression is never typed twice', async () => {
            const pass = await makePass( { contentEl: contentWith( [] ), currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )

            expect( ID_TOKEN_SOURCE.length ).toBeGreaterThan( 0 )
            expect( pass.idTokenSource() ).toBe( ID_TOKEN_SOURCE )
        } )

        it( 'mirrors SCOPE_PREFIX_SOURCE, and the qualified expression is composed from it', async () => {
            const pass = await makePass( { contentEl: contentWith( [] ), currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            const line = scopePrefixLine( script )
            const value = new Function( line + '\nreturn ID_SCOPE_PREFIX_SOURCE' )()

            expect( value ).toBe( SCOPE_PREFIX_SOURCE )
            expect( pass.idTokenPattern().source ).toBe( '\\b' + SCOPE_PREFIX_SOURCE + '(?:' + ID_TOKEN_SOURCE + ')\\b' )
        } )

        it( 'COUNTER-PROBE: an entry removed from the mirrored table breaks both comparisons', async () => {
            const damaged = sliceDeclaration( script, 'ID_VOCABULARY_MIRROR' )
                .replace( "{ prefix: 'WI', separator: 'required', min: 3, max: 4 }, ", '' )
            const separators = sliceDeclaration( script, 'ID_SEPARATOR_SOURCE' )
            const { source } = await extractFunctionSources( [ 'idTokenSource', 'idRecognizedPrefixes' ] )
            const broken = new Function( damaged + '\n' + separators + '\n' + source + '\nreturn { idTokenSource, idRecognizedPrefixes }' )()

            expect( damaged ).not.toBe( sliceDeclaration( script, 'ID_VOCABULARY_MIRROR' ) )
            expect( broken.idRecognizedPrefixes().join( ',' ) ).not.toBe( IdRegister.prefixes( { recognized: true } ).prefixes.join( ',' ) )
            expect( broken.idTokenSource() ).not.toBe( ID_TOKEN_SOURCE )
        } )
    } )


    // ---- T-A / T-M: the mark itself ----
    describe( 'T-A / T-M — the mark replaces the text node and adds no markup', () => {
        it( 'T-A: a resolved identifier becomes an anchor whose visible text is the BARE identifier', async () => {
            const root = contentWith( HEADINGS.map( ( h ) => heading( 2, h.textContent ) ).concat( [ paragraph( 'Der Gegenstand ist T055 und nichts weiter.' ) ] ) )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            const result = await pass.resolveIdLinks( DOC_LOCAL )

            expect( result.ran ).toBe( true )
            expect( result.available ).toBe( true )
            expect( result.occurrences ).toBe( 1 )
            expect( result.distinct ).toBe( 1 )

            const anchors = marks( root, 'a.id-ref-local' )
            expect( anchors.length ).toBe( 1 )
            expect( anchors[ 0 ].textContent ).toBe( 'T055' )
            expect( anchors[ 0 ].getAttribute( 'data-id-ref' ) ).toBe( 'T055' )
            // The surrounding prose survives verbatim — no bracket, no extra character.
            expect( root.querySelectorAll( 'p' )[ 0 ].textContent ).toBe( 'Der Gegenstand ist T055 und nichts weiter.' )
        } )

        it( 'T-M: a [[wiki-link]] and an identifier in one paragraph do not swallow each other', async () => {
            const prose = paragraph( 'Siehe [[memo-sop]] und T060 im selben Absatz.' )
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), prose ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            await pass.resolveIdLinks( DOC_LOCAL )

            expect( marks( root, 'a.id-ref-local' ).length ).toBe( 1 )
            // The wiki syntax is untouched by THIS pass — the [[…]] text is still literally there for
            // resolveWikiLinks, which runs before it in the shipped order.
            expect( prose.textContent ).toBe( 'Siehe [[memo-sop]] und T060 im selben Absatz.' )
        } )
    } )


    // ---- T-B / T-C: the opt-out ----
    describe( 'T-B / T-C — the skip set IS the opt-out', () => {
        it( 'T-B: an identifier in <code> and in <pre> stays text; the same one next to it is marked', async () => {
            const code = makeElement( 'code' )
            code.appendChild( makeText( 'T055' ) )
            const pre = makeElement( 'pre' )
            pre.appendChild( makeText( 'T055 im Block' ) )
            const prose = paragraph( 'Im Fliesstext steht T055.' )
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), code, pre, prose ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            const result = await pass.resolveIdLinks( DOC_LOCAL )

            // The zero and its counter-measurement in ONE case: two protected occurrences, one marked.
            expect( code.querySelectorAll( '[data-id-ref]' ).length ).toBe( 0 )
            expect( pre.querySelectorAll( '[data-id-ref]' ).length ).toBe( 0 )
            expect( prose.querySelectorAll( '[data-id-ref]' ).length ).toBe( 1 )
            expect( result.occurrences ).toBe( 1 )
        } )

        it( 'T-C: an identifier inside a diagram container stays text — a <div> the tag skip misses', async () => {
            const diagram = makeElement( 'div', [ 'mermaid' ] )
            diagram.appendChild( makeText( 'graph TD; A[T055] --> B' ) )
            const prose = paragraph( 'Daneben T055 im Text.' )
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), diagram, prose ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            await pass.resolveIdLinks( DOC_LOCAL )

            expect( diagram.querySelectorAll( '[data-id-ref]' ).length ).toBe( 0 )
            expect( prose.querySelectorAll( '[data-id-ref]' ).length ).toBe( 1 )
        } )
    } )


    // ---- T-D: idempotence ----
    it( 'T-D: a second run over the same tree produces no nested marks', async () => {
        const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'T055 und WI-076 und T060.' ) ] )
        const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )

        const first = await pass.resolveIdLinks( DOC_LOCAL )
        const afterFirst = marks( root, '[data-id-ref]' ).length
        const second = await pass.resolveIdLinks( DOC_LOCAL )
        const afterSecond = marks( root, '[data-id-ref]' ).length

        expect( first.occurrences ).toBe( 3 )
        expect( afterFirst ).toBe( 3 )
        expect( second.occurrences ).toBe( 0 )
        expect( afterSecond ).toBe( 3 )
        expect( root.querySelectorAll( 'p' )[ 0 ].textContent ).toBe( 'T055 und WI-076 und T060.' )
    } )


    // ---- T-E: class 3 stays out ----
    it( 'T-E: class 3 (F7, P1, C01, K1) is NOT marked — and T055 in the same text is', async () => {
        const prose = paragraph( 'F7 und P1 und C01 und K1 bleiben Text, T055 nicht.' )
        const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), prose ] )
        const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
        const result = await pass.resolveIdLinks( DOC_LOCAL )

        expect( result.occurrences ).toBe( 1 )
        expect( marks( root, '[data-id-ref]' ).map( ( node ) => node.textContent ) ).toEqual( [ 'T055' ] )
    } )


    // ---- T-F / T-G / T-H: the three states of the memo ----
    describe( 'T-F / T-G / T-H — the three display states', () => {
        it( 'T-F: resolved and memo-local — the anchor jumps to the chapter heading', async () => {
            const chapter = heading( 2, '31. Kennungen im Dokument' )
            const other = heading( 2, '38. Kapitel-Vertrag' )
            const root = contentWith( [ chapter, paragraph( 'T055 hier, T077 dort, WI-076 auch.' ), other ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            await pass.resolveIdLinks( DOC_LOCAL )

            const anchors = marks( root, 'a.id-ref-local' )
            expect( anchors.length ).toBe( 3 )

            // Three different identifiers clicked, each landing on ITS chapter — one address knows no spread.
            anchors.forEach( ( anchor ) => anchor.listeners.click.forEach( ( fn ) => fn( { preventDefault: () => {} } ) ) )
            expect( chapter.scrolled ).toBe( 2 )
            expect( other.scrolled ).toBe( 1 )
            expect( anchors.map( ( a ) => a.getAttribute( 'data-id-ref' ) ) ).toEqual( [ 'T055', 'T077', 'WI-076' ] )
            expect( anchors[ 0 ].getAttribute( 'title' ) ).toContain( 'Kapitel „31. Kennungen im Dokument"' )
        } )

        it( 'T-G: resolved and memo-foreign — deep link plus a tooltip that names the LIMIT verbatim', async () => {
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'Vergleiche M080-T096 im Nachbarmemo.' ) ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            await pass.resolveIdLinks( DOC_LOCAL )

            const foreign = marks( root, 'a.id-ref-foreign' )
            expect( foreign.length ).toBe( 1 )
            expect( foreign[ 0 ].textContent ).toBe( 'M080-T096' )
            expect( foreign[ 0 ].getAttribute( 'href' ) ).toBe( '/doc/' + encodeURIComponent( DOC_FOREIGN ) )
            // The limit is not a comment: the reader is TOLD the jump hits the document, not the chapter.
            expect( foreign[ 0 ].getAttribute( 'title' ) ).toBe( 'M080-T096 — liegt in Memo 080. Der Sprung trifft das Dokument, nicht das Kapitel.' )
        } )

        it( 'T-G2: a qualification into a memo the catalogue does not know is UNRESOLVED, not a link', async () => {
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'Und M999-T001 gibt es nicht.' ) ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            await pass.resolveIdLinks( DOC_LOCAL )

            expect( marks( root, 'a.id-ref-foreign' ).length ).toBe( 0 )
            const unresolved = marks( root, '.id-ref-unresolved' )
            expect( unresolved.length ).toBe( 1 )
            expect( unresolved[ 0 ].tagName ).toBe( 'SPAN' )
            expect( unresolved[ 0 ].getAttribute( 'title' ) ).toContain( 'Memo 999 ist in diesem Katalog nicht bekannt' )
        } )

        it( 'T-H: unresolved — a well-formed identifier with no entry gets the muted mark and NO anchor', async () => {
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'B048 steht nirgends im Bestand, T055 schon.' ) ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            const result = await pass.resolveIdLinks( DOC_LOCAL )

            const unresolved = marks( root, '.id-ref-unresolved' )
            expect( unresolved.length ).toBe( 1 )
            expect( unresolved[ 0 ].tagName ).toBe( 'SPAN' )
            expect( unresolved[ 0 ].getAttribute( 'href' ) ).toBe( null )
            expect( unresolved[ 0 ].getAttribute( 'title' ) ).toContain( 'kein Eintrag im Bestand dieses Memos' )
            // The counter-measurement in the same case: a resolved one right beside it.
            expect( marks( root, 'a.id-ref-local' ).length ).toBe( 1 )
            expect( result.states ).toEqual( { unresolved: 1, local: 1 } )
        } )

        it( 'T-H2: a kind this view carries NO stock for is no-carrier, never the author\'s broken reference', async () => {
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'REV-16 und PRD-42 und RES-004 kann die Ansicht nicht nachschlagen.' ) ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            const result = await pass.resolveIdLinks( DOC_LOCAL )

            expect( result.states ).toEqual( { 'no-carrier': 3 } )
            expect( marks( root, '.id-ref-unresolved' ).length ).toBe( 0 )
            expect( marks( root, '.id-ref-no-carrier' ).length ).toBe( 3 )
            expect( marks( root, '.id-ref-no-carrier' )[ 0 ].getAttribute( 'title' ) ).toContain( 'Nicht geprueft, kein Befund am Text' )
        } )
    } )


    // ---- T-I / T-J: the fourth state, and the state it must not be confused with ----
    describe( 'T-I / T-J — missing stock is not empty stock', () => {
        it( 'T-I: no stock at all marks NOTHING and says why; the SAME text with stock marks both', async () => {
            const dead = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'T055 und B048 im Text.' ) ] )
            const deadPass = await makePass( { contentEl: dead, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: deadFetch() } )
            const deadResult = await deadPass.resolveIdLinks( DOC_LOCAL )

            expect( deadResult.available ).toBe( false )
            expect( deadResult.occurrences ).toBe( 0 )
            expect( marks( dead, '[data-id-ref]' ).length ).toBe( 0 )
            const note = dead.querySelector( '.id-ref-note' )
            expect( note ).not.toBe( null )
            expect( note.textContent ).toBe( 'Kennungen: Bestand nicht geladen — keine Kennung wurde geprueft.' )

            // POSITIVE CONTROL, same text, same case: without this half "nothing marked" and
            // "everything clean" are the same picture.
            const live = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'T055 und B048 im Text.' ) ] )
            const livePass = await makePass( { contentEl: live, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            const liveResult = await livePass.resolveIdLinks( DOC_LOCAL )

            expect( liveResult.available ).toBe( true )
            expect( liveResult.occurrences ).toBe( 2 )
            expect( marks( live, 'a.id-ref-local' ).length ).toBe( 1 )
            expect( marks( live, '.id-ref-unresolved' ).length ).toBe( 1 )
            expect( live.querySelector( '.id-ref-note' ) ).toBe( null )
        } )

        it( 'T-J: an EMPTY but present stock marks every identifier as unresolved — a different statement', async () => {
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'T055 und B048 im Text.' ) ] )
            const pass = await makePass( {
                contentEl: root,
                currentDocumentId: DOC_LOCAL,
                lastTree: TREE,
                fetchImpl: okFetch( { topics: [], blocks: [], workItems: [] } )
            } )
            const result = await pass.resolveIdLinks( DOC_LOCAL )

            expect( result.available ).toBe( true )
            expect( result.comparedStockEntries ).toBe( 0 )
            expect( result.states ).toEqual( { unresolved: 2 } )
            expect( marks( root, '.id-ref-unresolved' ).length ).toBe( 2 )
            expect( root.querySelector( '.id-ref-note' ) ).toBe( null )
        } )

        it( 'T-I2: a stock that arrives but finds no identifier says THAT, instead of staying silent', async () => {
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'Dieser Absatz traegt keine Kennung.' ) ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            const result = await pass.resolveIdLinks( DOC_LOCAL )

            expect( result.available ).toBe( true )
            expect( result.occurrences ).toBe( 0 )
            expect( root.querySelector( '.id-ref-note' ).textContent ).toBe( 'Kennungen: Bestand geladen, keine Kennung im Text gefunden.' )
        } )
    } )


    // ---- T-L: one call point, one fetch, and the guard against a document switch ----
    describe( 'T-L — one call point, one request', () => {
        it( 'is called exactly once in the shipped script, immediately after resolveWikiLinks()', () => {
            const lines = script.split( '\n' )
            const calls = lines
                .map( ( line, index ) => ( { line: line.trim(), number: index + 1 } ) )
                .filter( ( entry ) => /^resolveIdLinks\(/.test( entry.line ) )
            const wiki = lines
                .map( ( line, index ) => ( { line: line.trim(), number: index + 1 } ) )
                .filter( ( entry ) => /^resolveWikiLinks\(\)$/.test( entry.line ) )

            expect( calls.length ).toBe( 1 )
            expect( wiki.length ).toBe( 1 )
            expect( calls[ 0 ].number ).toBe( wiki[ 0 ].number + 1 )
        } )

        it( 'shares ONE topic-store request with applyTopicPillsFromStore — no second fetch', async () => {
            let hits = 0
            const counting = () => { hits = hits + 1; return Promise.resolve( { ok: true, json: () => Promise.resolve( STORE ) } ) }
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'T055 im Text.' ) ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: counting } )

            await pass.resolveIdLinks( DOC_LOCAL )
            await pass.loadTopicStore( DOC_LOCAL )
            expect( hits ).toBe( 1 )

            // And a new render reads the store FRESH — the cache is per render, not forever.
            pass.resetTopicStoreCache()
            await pass.loadTopicStore( DOC_LOCAL )
            expect( hits ).toBe( 2 )
        } )

        it( 'the SKIP SET is declared once and both passes read it', () => {
            const declared = script.split( '\n' ).filter( ( line ) => /^\s*var\s+CONTENT_SKIP_TAGS\s*=/.test( line ) )
            const inlineSets = script.split( '\n' ).filter( ( line ) => /'CODE'\s*:\s*true/.test( line ) )

            expect( declared.length ).toBe( 1 )
            // The counter-measurement: exactly ONE line in the whole script carries the literal set,
            // and it is the declaration above. A second one would be the copy T060 rejects.
            expect( inlineSets.length ).toBe( 1 )
            expect( inlineSets[ 0 ] ).toBe( declared[ 0 ] )
            expect( script ).toContain( 'var skip = CONTENT_SKIP_TAGS' )
        } )

        it( 'a document switch while the stock was loading marks NOTHING in the new document', async () => {
            const root = contentWith( [ heading( 2, '31. Kennungen im Dokument' ), paragraph( 'T055 im Text.' ) ] )
            const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
            pass.setDocument( DOC_FOREIGN )
            const result = await pass.resolveIdLinks( DOC_LOCAL )

            expect( result.ran ).toBe( false )
            expect( result.reason ).toBe( 'document changed while the stock was loading' )
            expect( marks( root, '[data-id-ref]' ).length ).toBe( 0 )
        } )

        it( 'uses no for/while loop — the house rule the wiki pass states in its own comment', () => {
            const region = script.slice( script.indexOf( 'function idTokenSource(' ), script.indexOf( 'text-passage + table-row annotations' ) )

            expect( region.length ).toBeGreaterThan( 2000 )
            expect( region.match( /\b(for|while)\s*\(/g ) ).toBe( null )
        } )
    } )


    // ---- T-N: the pass states how much it looked at ----
    it( 'T-N: occurrences and distinct references are counted SEPARATELY and both reported', async () => {
        const root = contentWith( [
            heading( 2, '31. Kennungen im Dokument' ),
            paragraph( 'T055 und T055 und T060 und M080-T096 und B048.' )
        ] )
        const pass = await makePass( { contentEl: root, currentDocumentId: DOC_LOCAL, lastTree: TREE, fetchImpl: okFetch( STORE ) } )
        const result = await pass.resolveIdLinks( DOC_LOCAL )

        expect( result.occurrences ).toBe( 5 )
        expect( result.distinct ).toBe( 4 )
        expect( result.states ).toEqual( { local: 3, foreign: 1, unresolved: 1 } )
        expect( result.comparedStockEntries ).toBe( 6 )
        expect( result.comparedStockPrefixes ).toBe( 4 )
        expect( result.comparedCatalogue ).toBe( 2 )
    } )


    // ---- the CSS side: five states that must not look alike ----
    it( 'every display state carries its OWN selector — no two states share a rule', async () => {
        const { readMemoViewStyles } = await import( '../helpers/extractFunction.mjs' )
        const css = await readMemoViewStyles()
        const wanted = [ 'a.id-ref-local', 'a.id-ref-foreign', '.id-ref-resolved', '.id-ref-unresolved', '.id-ref-ambiguous', '.id-ref-no-carrier', '.id-ref-note' ]

        expect( css.length ).toBeGreaterThan( 1000 )
        wanted.forEach( ( selector ) => expect( css ).toContain( selector ) )
        // .wiki-link is deliberately untouched: shared mechanics, separate looks.
        expect( css ).toContain( '#content a.wiki-link' )
        expect( css.includes( '.id-ref !important' ) ).toBe( false )
    } )
} )
