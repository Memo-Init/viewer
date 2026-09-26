import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'
import { extractFunctions, extractFunctionSources } from '../helpers/extractFunction.mjs'


// PRD-16 (Memo 082 Phase 9, WI-237) — S6: a cross-reference opens a WINDOW, it does not abduct a page.
//
// Two halves, and this suite covers both:
//   server  the READ-ONLY route GET /api/documents/<id>/overview and the pure statics behind it
//           (selectOverviewRevision, extractOverviewHeadings, overviewState, overviewNote,
//           buildDocumentOverview) — exercised as functions, no server stood up.
//   client  the interception of a FOREIGN reference and the popup's renderer seam — the pure decision
//           functions are LIFTED out of the classic client script with the extractFunction helper and
//           really called; the wiring that needs a DOM is asserted on the emitted source, following the
//           convention of the other client-pipeline suites (this project has no jsdom).
//
// Every case states HOW MUCH it compared. A case that compared nothing is red, never green — a check
// over an empty comparison set is the vacuum-green gate this phase keeps paying for.
//
// What is deliberately NOT here: the click path itself. A click is measured against a real surface, and
// that proof is .browser/scripts/p9-ref-popup.mjs (AB-1, AB-2, AB-6, AB-7 over Playwright, port 3333).
const here = dirname( fileURLToPath( import.meta.url ) )

let serverSource = ''
let clientSource = ''
let cssSource = ''


beforeAll( async () => {
    serverSource = await readFile( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
    clientSource = await readFile( join( here, '..', '..', 'src', 'public', 'app.client.mjs' ), 'utf8' )
    cssSource = await readFile( join( here, '..', '..', 'src', 'public', 'app.css' ), 'utf8' )
} )


describe( 'PRD-16 — selectOverviewRevision: WHICH revision the overview describes', () => {
    it( 'picks the highest revision number and reports the set it compared (4 candidates)', () => {
        const revisions = [
            { 'fileName': 'REV-01.md' },
            { 'fileName': 'REV-09.md' },
            { 'fileName': 'REV-10.md' },
            { 'fileName': 'REV-02.md' }
        ]
        const picked = MemoView.selectOverviewRevision( { revisions } )

        expect( picked[ 'comparedCount' ] ).toBe( 4 )
        expect( picked[ 'revision' ][ 'fileName' ] ).toBe( 'REV-10.md' )
    } )


    it( 'prefers the plain form over -prepare / -update at the same number (3 candidates)', () => {
        const revisions = [
            { 'fileName': 'REV-07-prepare.md' },
            { 'fileName': 'REV-07.md' },
            { 'fileName': 'REV-07-update.md' }
        ]
        const picked = MemoView.selectOverviewRevision( { revisions } )

        expect( picked[ 'comparedCount' ] ).toBe( 3 )
        expect( picked[ 'revision' ][ 'fileName' ] ).toBe( 'REV-07.md' )
    } )


    // The zero case is NAMED, not silently answered: comparedCount 0 next to revision null says "there
    // was nothing to choose from", which is a different statement from "the choice landed on nothing".
    it( 'answers a NAMED zero for an empty list (comparedCount 0, revision null)', () => {
        const picked = MemoView.selectOverviewRevision( { 'revisions': [] } )

        expect( picked[ 'comparedCount' ] ).toBe( 0 )
        expect( picked[ 'revision' ] ).toBe( null )
    } )
} )


describe( 'PRD-16 — extractOverviewHeadings: the chapter outline, fences excluded', () => {
    const content = [
        '# Titel',
        '',
        '## Kapitel eins',
        'Text.',
        '## Kapitel zwei',
        '```text',
        '## Diese Zeile steht in einem Code-Zaun und ist keine Ueberschrift',
        '```',
        '## Kapitel drei',
        '### Unterabschnitt bleibt draussen',
        ''
    ].join( '\n' )


    it( 'collects the H2 titles and states capped list AGAINST uncapped count (3 of 3, 11 lines read)', () => {
        const out = MemoView.extractOverviewHeadings( { content, 'limit': 12 } )

        expect( content.split( '\n' ) ).toHaveLength( 11 )
        expect( out[ 'headingCount' ] ).toBe( 3 )
        expect( out[ 'headings' ] ).toEqual( [ 'Kapitel eins', 'Kapitel zwei', 'Kapitel drei' ] )
        expect( out[ 'limit' ] ).toBe( 12 )
    } )


    // The discriminating case: the M082-09-02 fixture carries exactly such a fenced line, so a reader
    // that counted substrings instead of tracking the fence would report FOUR chapters for three.
    it( 'does not read a "## …" line inside a code fence as a heading (1 fenced line among 3 headings)', () => {
        const out = MemoView.extractOverviewHeadings( { content, 'limit': 12 } )
        const fencedCandidates = content.split( '\n' ).filter( ( line ) => /^##\s+\S/.test( line ) )

        expect( fencedCandidates ).toHaveLength( 4 )
        expect( out[ 'headingCount' ] ).toBe( 3 )
        expect( out[ 'headings' ].join( ' | ' ) ).not.toContain( 'Code-Zaun' )
    } )


    it( 'caps the list and keeps the total honest (limit 2 of 3 present)', () => {
        const out = MemoView.extractOverviewHeadings( { content, 'limit': 2 } )

        expect( out[ 'headings' ] ).toHaveLength( 2 )
        expect( out[ 'headingCount' ] ).toBe( 3 )
    } )


    // NO SILENT DEFAULTS: a preview whose size nobody named is not a preview.
    it( 'refuses a missing, zero or non-finite limit LOUDLY (4 refused shapes)', () => {
        expect( () => MemoView.extractOverviewHeadings( { content } ) ).toThrow( /limit must be a positive finite number/ )
        expect( () => MemoView.extractOverviewHeadings( { content, 'limit': 0 } ) ).toThrow( /limit/ )
        expect( () => MemoView.extractOverviewHeadings( { content, 'limit': -3 } ) ).toThrow( /limit/ )
        expect( () => MemoView.extractOverviewHeadings( { content, 'limit': Number.POSITIVE_INFINITY } ) ).toThrow( /limit/ )
    } )
} )


describe( 'PRD-16 — the FOUR named states: no state answers with an empty hull', () => {
    // One named case per Lage of the Soll-Zustand, and the reason is asserted, not just the state:
    // "empty" arrives for two different worlds and a caller has to be able to tell them apart.
    const cases = [
        { 'label': 'unknown identifier', 'input': { 'found': false, 'readable': false, 'revisionCount': 0, 'contentLength': 0 }, 'state': 'unknown', 'reason': 'document-id-not-registered' },
        { 'label': 'known identifier without a revision', 'input': { 'found': true, 'readable': false, 'revisionCount': 0, 'contentLength': 0 }, 'state': 'empty', 'reason': 'no-revision-in-document' },
        { 'label': 'known revision that cannot be read', 'input': { 'found': true, 'readable': false, 'revisionCount': 3, 'contentLength': 0 }, 'state': 'unreadable', 'reason': 'revision-source-not-readable' },
        { 'label': 'readable revision with no content', 'input': { 'found': true, 'readable': true, 'revisionCount': 1, 'contentLength': 0 }, 'state': 'empty', 'reason': 'revision-has-no-content' },
        { 'label': 'a real overview', 'input': { 'found': true, 'readable': true, 'revisionCount': 1, 'contentLength': 4096 }, 'state': 'ok', 'reason': null }
    ]

    cases.forEach( ( row ) => {
        it( `${ row[ 'label' ] } -> state "${ row[ 'state' ] }" with its own reason`, () => {
            const out = MemoView.overviewState( row[ 'input' ] )

            expect( out[ 'state' ] ).toBe( row[ 'state' ] )
            expect( out[ 'reason' ] ).toBe( row[ 'reason' ] )
        } )
    } )


    it( 'every non-ok state carries a NON-empty reason (5 cases compared, 4 non-ok)', () => {
        const nonOk = cases.filter( ( row ) => row[ 'state' ] !== 'ok' )

        expect( cases ).toHaveLength( 5 )
        expect( nonOk ).toHaveLength( 4 )
        expect( nonOk.filter( ( row ) => typeof row[ 'reason' ] === 'string' && row[ 'reason' ].length > 0 ) ).toHaveLength( 4 )
    } )


    it( 'overviewNote speaks a German sentence for each of the four states and NAMES an unknown one', () => {
        const states = [ 'ok', 'unknown', 'unreadable', 'empty' ]
        const notes = states.map( ( state ) => MemoView.overviewNote( { state } )[ 'note' ] )

        expect( notes ).toHaveLength( 4 )
        expect( notes.filter( ( note ) => typeof note === 'string' && note.length > 0 ) ).toHaveLength( 4 )
        expect( new Set( notes ).size ).toBe( 4 )
        // the closed list refuses to answer with a blank — it says the state is unrecognised
        expect( MemoView.overviewNote( { 'state': 'nonsense' } )[ 'note' ] ).toMatch( /Unbekannter Zustand/ )
    } )
} )


describe( 'PRD-16 — buildDocumentOverview: one key set, four states, no empty hull', () => {
    const document = {
        'documentId': 'proj--900-fixture',
        'projectId': 'proj',
        'memoName': '900-fixture',
        'documentKind': 'memo',
        'memoStatus': 'Entwurf',
        'questions': { 'open': 2, 'answered': 1, 'deferred': 0, 'basis': true, 'comparison': {} },
        'revisions': [ { 'fileName': 'REV-01.md', 'sizeKb': 7, 'mtime': '2026-09-27', 'revisionType': 'full' } ]
    }
    const content = [ '# Titel', '', '## Kapitel eins', '', '## Kapitel zwei', '' ].join( '\n' )

    const build = ( overrides ) => {
        return MemoView.buildDocumentOverview( {
            'documentId': 'proj--900-fixture',
            'document': document,
            'revision': document[ 'revisions' ][ 0 ],
            'revisionCount': 1,
            'content': content,
            'readable': true,
            'headingLimit': 12,
            ...overrides
        } )[ 'overview' ]
    }


    it( 'a known identifier yields an overview with MORE THAN 0 fields and a real outline (2 chapters)', () => {
        const overview = build( {} )

        expect( Object.keys( overview ).length ).toBeGreaterThan( 0 )
        expect( Object.keys( overview ).length ).toBe( 17 )
        expect( overview[ 'state' ] ).toBe( 'ok' )
        expect( overview[ 'readOnly' ] ).toBe( true )
        expect( overview[ 'memoName' ] ).toBe( '900-fixture' )
        expect( overview[ 'headings' ] ).toEqual( [ 'Kapitel eins', 'Kapitel zwei' ] )
        expect( overview[ 'headingCount' ] ).toBe( 2 )
        expect( overview[ 'latestRevision' ][ 'fileName' ] ).toBe( 'REV-01.md' )
        expect( overview[ 'fullViewPath' ] ).toBe( '/doc/proj--900-fixture' )
    } )


    // The key set is the same in every state ON PURPOSE: a reader must decide on `state`, never on
    // which fields happen to be missing. An absent key and a null value are two different claims.
    it( 'all four states speak the SAME key set (5 shapes compared, 17 keys each)', () => {
        const shapes = [
            build( {} ),
            build( { 'document': null, 'revision': null, 'revisionCount': 0, 'content': '', 'readable': false } ),
            build( { 'revisionCount': 0, 'revision': null, 'content': '', 'readable': false } ),
            build( { 'revisionCount': 2, 'content': '', 'readable': false } ),
            build( { 'content': '', 'readable': true } )
        ]
        const keySets = shapes.map( ( shape ) => Object.keys( shape ).sort().join( ',' ) )

        expect( shapes.map( ( shape ) => shape[ 'state' ] ) ).toEqual( [ 'ok', 'unknown', 'empty', 'unreadable', 'empty' ] )
        expect( new Set( shapes.map( ( shape ) => shape[ 'state' ] ) ).size ).toBe( 4 )
        expect( new Set( keySets ).size ).toBe( 1 )
        expect( Object.keys( shapes[ 0 ] ) ).toHaveLength( 17 )
    } )


    it( 'the unknown identifier is NAMED and offers no full-view bridge (1 shape)', () => {
        const overview = build( { 'document': null, 'revision': null, 'revisionCount': 0, 'content': '', 'readable': false } )

        expect( overview[ 'state' ] ).toBe( 'unknown' )
        expect( overview[ 'reason' ] ).toBe( 'document-id-not-registered' )
        expect( overview[ 'note' ] ).toMatch( /kennt der Viewer nicht/ )
        expect( overview[ 'fullViewPath' ] ).toBe( null )
        expect( overview[ 'memoName' ] ).toBe( null )
    } )


    // The vacuum probe of D6: an overview over an EMPTY document must name its emptiness. A valid
    // preview with zero chapters would be indistinguishable from "this memo carries nothing".
    it( 'the VACUUM probe — an empty document names its emptiness instead of passing as a preview', () => {
        const overview = build( { 'content': '   \n\n', 'readable': true } )

        expect( overview[ 'state' ] ).toBe( 'empty' )
        expect( overview[ 'reason' ] ).toBe( 'revision-has-no-content' )
        expect( overview[ 'headingCount' ] ).toBe( 0 )
        expect( overview[ 'note' ] ).not.toBe( '' )
    } )
} )


describe( 'PRD-16 — the route: /api/documents/<id>/overview, read-only and matched in the right order', () => {
    it( 'registers a /overview GET route and slices the id WITHOUT the suffix', () => {
        expect( serverSource ).toMatch( /url\.endsWith\(\s*'\/overview'\s*\)\s*&&\s*req\.method\s*===\s*'GET'/ )
        expect( serverSource ).toMatch( /url\.slice\(\s*'\/api\/documents\/'\.length,\s*url\.length\s*-\s*'\/overview'\.length\s*\)/ )
    } )


    // MEASURED, not asserted from the comment: the generic /api/documents/<id> GET would swallow
    // "<id>/overview" as the id, so the specific branch has to come first. Two positions compared.
    it( 'is matched BEFORE the generic /api/documents/<id> GET (2 source positions compared)', () => {
        const overviewAt = serverSource.indexOf( "url.endsWith( '/overview' ) && req.method === 'GET'" )
        const genericAt = serverSource.indexOf( "if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {" )

        expect( overviewAt ).toBeGreaterThan( -1 )
        expect( genericAt ).toBeGreaterThan( -1 )
        expect( overviewAt ).toBeLessThan( genericAt )
    } )


    // AB-5 on the source side: the route body carries no writing verb at all. The live N>1 proof that
    // the store is byte-identical before and after runs in .browser/scripts/p9-ref-popup.mjs.
    it( 'AB-5 — the route body contains NONE of the 7 writing verbs (7 tokens compared)', () => {
        const start = serverSource.indexOf( "url.endsWith( '/overview' ) && req.method === 'GET'" )
        const end = serverSource.indexOf( "if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {", start )
        const block = serverSource.slice( start, end )
        const forbidden = [ 'writeFile', 'appendFile', 'mkdir', 'addDocument', 'removeDocument', 'selectRevision', 'unlink' ]
        const hits = forbidden.filter( ( verb ) => block.includes( verb ) )

        expect( start ).toBeGreaterThan( -1 )
        expect( end ).toBeGreaterThan( start )
        expect( block.length ).toBeGreaterThan( 0 )
        expect( forbidden ).toHaveLength( 7 )
        expect( hits ).toEqual( [] )
        // and it DOES read: one revision file, through the pair-checked resolver
        expect( block ).toContain( 'MemoView.resolveRevisionPath(' )
        expect( block ).toContain( 'readFile(' )
    } )


    it( 'answers an unknown identifier with the NAMED body, not a bare 404 (1 branch)', () => {
        const start = serverSource.indexOf( "url.endsWith( '/overview' ) && req.method === 'GET'" )
        const end = serverSource.indexOf( "if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {", start )
        const block = serverSource.slice( start, end )

        expect( block ).toMatch( /sendJson\(\s*res,\s*404,\s*missing\[\s*'overview'\s*\]\s*\)/ )
    } )
} )


describe( 'PRD-16 — the client: a FOREIGN reference is intercepted, every other one is not', () => {
    let lifted = null


    beforeAll( async () => {
        lifted = await extractFunctions(
            [ 'escapeHtml', 'idRefOverlayDecision', 'idRefOverviewBody', 'renderIdRefOverview' ],
            [ 'idRefOverviewRenderers' ]
        )
    } )


    // AB-1, source half: the interception sits in buildIdMark's FOREIGN branch, it calls preventDefault
    // and it opens the popup. This is the case the AB-9 mutant has to turn red — removing the
    // interception removes exactly these three shapes.
    it( 'AB-1 — the foreign branch of buildIdMark intercepts the click and opens the popup', () => {
        const start = clientSource.indexOf( "if( verdict.state === 'foreign' ) {" )
        const end = clientSource.indexOf( 'if( target !== null ) {', start )
        const branch = clientSource.slice( start, end )

        expect( start ).toBeGreaterThan( -1 )
        expect( end ).toBeGreaterThan( start )
        expect( branch ).toContain( 'idRefOverlayDecision( verdict )' )
        expect( branch ).toContain( 'e.preventDefault()' )
        expect( branch ).toContain( 'openIdRefOverlay( overlay.documentId, entry, verdict )' )
        // the href STAYS — middle-click, copy-link and the full-view bridge live on it
        expect( branch ).toContain( "node.setAttribute( 'href', verdict.href )" )
    } )


    it( 'AB-1 — a foreign verdict with a /doc/ target opens, and names the document it opens', () => {
        const decision = lifted.idRefOverlayDecision( { 'state': 'foreign', 'href': '/doc/p9prd16--901-ziel', 'hint': 'x' } )

        expect( decision[ 'open' ] ).toBe( true )
        expect( decision[ 'documentId' ] ).toBe( 'p9prd16--901-ziel' )
        expect( decision[ 'reason' ] ).toBe( null )
    } )


    // AB-6: without this direction a version that intercepted EVERY reference would be
    // indistinguishable from the right one — until the in-document jumps stopped working.
    it( 'AB-6 — every non-foreign state keeps its in-document jump (5 states compared)', () => {
        const states = [ 'local', 'resolved', 'unresolved', 'ambiguous', 'no-carrier' ]
        const decisions = states.map( ( state ) => lifted.idRefOverlayDecision( { state, 'href': '#' } ) )

        expect( decisions ).toHaveLength( 5 )
        expect( decisions.filter( ( decision ) => decision[ 'open' ] === true ) ).toEqual( [] )
        expect( decisions.filter( ( decision ) => typeof decision[ 'reason' ] === 'string' ) ).toHaveLength( 5 )
    } )


    // MEASURED HARDENING. The case above guards the decision FUNCTION; it stayed green under a mutant
    // that opened the popup from the LOCAL branch of buildIdMark directly, because that path never asks
    // the function. The structural guarantee of AB-6 is the CALL SITE: inside buildIdMark the popup is
    // opened exactly once, and that one place sits in the foreign branch. So the call site is pinned too.
    it( 'AB-6 — buildIdMark opens the popup in EXACTLY ONE place, and it is the foreign branch', () => {
        const start = clientSource.indexOf( 'function buildIdMark( entry, verdict, headings )' )
        const end = clientSource.indexOf( 'function renderIdStockNote(', start )
        const body = clientSource.slice( start, end )
        const foreignAt = body.indexOf( "if( verdict.state === 'foreign' ) {" )
        const localAt = body.indexOf( 'if( target !== null ) {' )
        const openings = body.split( 'openIdRefOverlay(' ).length - 1

        expect( start ).toBeGreaterThan( -1 )
        expect( end ).toBeGreaterThan( start )
        expect( openings ).toBe( 1 )
        expect( foreignAt ).toBeGreaterThan( -1 )
        expect( localAt ).toBeGreaterThan( foreignAt )
        // the single opening lies BETWEEN the foreign branch and the local branch that follows it
        expect( body.indexOf( 'openIdRefOverlay(' ) ).toBeGreaterThan( foreignAt )
        expect( body.indexOf( 'openIdRefOverlay(' ) ).toBeLessThan( localAt )
    } )


    it( 'a foreign verdict WITHOUT a document target is refused with a reason (2 broken shapes)', () => {
        const noHref = lifted.idRefOverlayDecision( { 'state': 'foreign' } )
        const wrongHref = lifted.idRefOverlayDecision( { 'state': 'foreign', 'href': 'https://example.invalid/doc/x' } )

        expect( noHref[ 'open' ] ).toBe( false )
        expect( wrongHref[ 'open' ] ).toBe( false )
        expect( noHref[ 'reason' ] ).toMatch( /without a document target/ )
        expect( wrongHref[ 'reason' ] ).toMatch( /without a document target/ )
    } )


    it( 'the generic rendering states the outline against its total and never renders a blank plate', () => {
        const ok = lifted.idRefOverviewBody( {
            'state': 'ok', 'reason': null, 'note': 'Uebersicht geladen.', 'documentId': 'p--900',
            'memoName': '900-fixture', 'documentKind': 'memo', 'memoStatus': 'Entwurf',
            'questions': { 'open': 2, 'answered': 1, 'deferred': 0, 'basis': true },
            'revisionCount': 3, 'latestRevision': { 'fileName': 'REV-03.md', 'sizeKb': 12 },
            'headings': [ 'Kapitel eins' ], 'headingCount': 4, 'headingLimit': 12
        } )

        expect( ok ).toContain( '1 von 4 angezeigt' )
        expect( ok ).toContain( '900-fixture' )
        expect( ok ).toContain( 'REV-03.md' )
        expect( ok.length ).toBeGreaterThan( 0 )
    } )


    it( 'a non-ok answer renders its NOTE and its reason, never an empty body (3 states)', () => {
        const rendered = [ 'unknown', 'unreadable', 'empty' ]
            .map( ( state ) => lifted.idRefOverviewBody( { state, 'reason': state + '-reason', 'note': 'Satz zu ' + state, 'documentId': 'p--900' } ) )

        expect( rendered ).toHaveLength( 3 )
        expect( rendered.filter( ( html ) => html.includes( 'idref-overlay-error' ) ) ).toHaveLength( 3 )
        expect( rendered.filter( ( html ) => html.includes( '-reason' ) ) ).toHaveLength( 3 )
    } )


    it( 'memo content reaching the popup is escaped before it becomes markup', () => {
        const html = lifted.idRefOverviewBody( {
            'state': 'ok', 'reason': null, 'note': 'x', 'documentId': 'p--900',
            'memoName': '<script>alert(1)</script>', 'documentKind': 'memo', 'memoStatus': 'Entwurf',
            'questions': null, 'revisionCount': 1, 'latestRevision': null,
            'headings': [ '<b>fett</b>' ], 'headingCount': 1, 'headingLimit': 12
        } )

        expect( html ).not.toContain( '<script>' )
        expect( html ).toContain( '&lt;script&gt;' )
        expect( html ).toContain( '&lt;b&gt;fett&lt;/b&gt;' )
    } )
} )


describe( 'PRD-16 — AB-8: the renderer seam is named, commented and really pluggable', () => {
    it( 'the seam is declared under a name PRD-17 can find, and its comment says what a key is', () => {
        expect( clientSource ).toContain( 'var idRefOverviewRenderers = {}' )
        expect( clientSource ).toMatch( /idRefOverviewRenderers — THE SEAM/ )
        expect( clientSource ).toMatch( /WI-238/ )
        expect( clientSource ).toContain( 'function renderIdRefOverview( overview, entry )' )
    } )


    // Not only present — pluggable. The lifted function is evaluated with a PRE-SEEDED map, so the
    // dispatch itself is measured instead of read.
    it( 'a registered renderer WINS for its prefix and the generic body stays the fallback (2 kinds)', async () => {
        const { source } = await extractFunctionSources( [ 'renderIdRefOverview' ] )
        const factory = new Function( 'idRefOverviewRenderers', 'idRefOverviewBody', source + '\nreturn renderIdRefOverview' )
        const render = factory(
            { 'M': ( overview, entry ) => 'TYPED:' + entry[ 'prefix' ] },
            () => 'GENERIC'
        )

        expect( render( { 'state': 'ok' }, { 'prefix': 'M' } ) ).toBe( 'TYPED:M' )
        expect( render( { 'state': 'ok' }, { 'prefix': 'WI' } ) ).toBe( 'GENERIC' )
    } )
} )


describe( 'PRD-16 — the overlay: research-modal pattern reused, the template untouched', () => {
    it( 'the popup markup is a labelled dialog carrying body, close and full-view (5 ids)', () => {
        const ids = [ 'idref-modal', 'idref-modal-title', 'idref-modal-full', 'idref-modal-close', 'idref-modal-body' ]
        const present = ids.filter( ( id ) => serverSource.includes( `id="${ id }"` ) )
        const open = serverSource.indexOf( 'id="idref-modal"' )
        const tag = serverSource.slice( open, serverSource.indexOf( '>', open ) )

        expect( present ).toHaveLength( 5 )
        expect( tag ).toContain( 'role="dialog"' )
        expect( tag ).toContain( 'aria-modal="true"' )
        expect( tag ).toMatch( /aria-label(ledby)?="[^"]+"/ )
        // it REUSES the shared modal classes — backdrop, dimming and centering are inherited
        expect( tag ).toContain( 'class="t-modal t-hidden"' )
    } )


    it( 'AB-2 — close is wired three ways: button, backdrop and Escape (3 wirings)', () => {
        expect( clientSource ).toContain( "idRefModalCloseBtn.addEventListener( 'click', closeIdRefOverlay )" )
        expect( clientSource ).toMatch( /idRefModalEl\.addEventListener\(\s*'click'/ )
        expect( clientSource ).toMatch( /ev\.key === 'Escape' && isIdRefOverlayOpen\(\)/ )
        expect( clientSource ).toContain( 'function closeIdRefOverlay()' )
    } )


    it( 'AB-7 — the full-view bridge exists and is a decision, not a consequence', () => {
        expect( serverSource ).toContain( 'id="idref-modal-full"' )
        expect( clientSource ).toMatch( /idRefModalFullBtn\.addEventListener\(\s*'click'/ )
        expect( clientSource ).toContain( 'window.location.assign( path )' )
        // the address comes from the answer, not from a re-derived path
        expect( serverSource ).toContain( "'fullViewPath'" )
    } )


    // G2: named selectors only, and no second overlay block. #research-modal is the template and stays
    // byte-identical — the popup inherits from .t-modal instead of redefining it.
    it( 'the CSS adds only NAMED #idref-modal selectors and no new overlay rule (4 named, 0 fixed)', () => {
        const named = [ '#idref-modal .t-modal-content', '#idref-modal .t-modal-body', '#idref-modal .idref-overlay-loading', '#idref-modal .idref-overlay-error' ]
        const present = named.filter( ( selector ) => cssSource.includes( selector ) )
        const block = cssSource.slice( cssSource.indexOf( '#idref-modal .t-modal-content' ), cssSource.indexOf( '#content a.wiki-link' ) )

        expect( present ).toHaveLength( 4 )
        expect( block.length ).toBeGreaterThan( 0 )
        expect( block ).not.toContain( 'position: fixed' )
        expect( block ).not.toContain( 'z-index' )
    } )


    it( 'the research overlay is NOT touched — it is the template (4 shapes still present)', () => {
        const untouched = [
            'function openResearchOverlay( researchFile )',
            'function closeResearchOverlay()',
            "var researchModalFullBtn = document.getElementById( 'research-modal-full' )",
            "id=\"research-modal-body\""
        ]
        const present = untouched.filter( ( shape ) => ( clientSource + serverSource ).includes( shape ) )

        expect( present ).toHaveLength( 4 )
    } )
} )
