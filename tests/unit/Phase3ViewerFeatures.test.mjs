import { describe, it, expect, beforeAll, afterEach } from '@jest/globals'
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { MemoView } from '../../src/MemoView.mjs'


const execFileP = promisify( execFile )


// Memo 075 Phase 3 — viewer features. As elsewhere in this suite the private #createHttpHandler is
// asserted on the MemoView.mjs source string, while the real behaviour is exercised through the public
// static methods the routes call. Client-side pipeline pieces are asserted by app.client.mjs shape.
const here = dirname( fileURLToPath( import.meta.url ) )
const WAKE_DIR = join( tmpdir(), 'memo-view-wake' )


const exists = async ( path ) => {
    try {
        await access( path )

        return true
    } catch {
        return false
    }
}


describe( 'PRD-P3-01 — client registry (register/list/derive)', () => {
    it( 'registers a client and lists it with a derived status', () => {
        const reg = MemoView.registerClient( { sessionId: 'p301-a', projectId: 'flowmcp', memoNumber: '155', workMode: 'Create' } )
        expect( reg.status ).toBe( true )

        const { clients } = MemoView.listClients( {} )
        const mine = clients.find( ( c ) => c.sessionId === 'p301-a' )
        expect( mine ).toBeDefined()
        expect( mine.projectId ).toBe( 'flowmcp' )
        expect( mine.memoNumber ).toBe( '155' )
        expect( mine.workMode ).toBe( 'Create' )
        expect( [ 'working', 'waiting-for-user-answer', 'stale' ] ).toContain( mine.status )
    } )


    it( 'rejects a path-traversal sessionId (validateSessionId reuse)', () => {
        const reg = MemoView.registerClient( { sessionId: '../evil', projectId: 'x' } )
        expect( reg.status ).toBe( false )
    } )


    it( 'a heartbeat keeps a previously registered field (upsert)', () => {
        MemoView.registerClient( { sessionId: 'p301-b', projectId: 'memo-init', memoNumber: '075', workMode: 'Rollout' } )
        MemoView.registerClient( { sessionId: 'p301-b' } )

        const { clients } = MemoView.listClients( {} )
        const mine = clients.find( ( c ) => c.sessionId === 'p301-b' )
        expect( mine.projectId ).toBe( 'memo-init' )
        expect( mine.workMode ).toBe( 'Rollout' )
    } )


    it( 'deregister removes the client', () => {
        MemoView.registerClient( { sessionId: 'p301-c', projectId: 'x' } )
        MemoView.deregisterClient( { sessionId: 'p301-c' } )

        const { clients } = MemoView.listClients( {} )
        expect( clients.find( ( c ) => c.sessionId === 'p301-c' ) ).toBeUndefined()
    } )
} )


describe( 'PRD-P3-01 — deriveClientStatus (r6-F11 pure derivation)', () => {
    const open = new Set( [ 'T-open' ] )

    it( 'stale wins first when no heartbeat within the TTL', () => {
        const s = MemoView.deriveClientStatus( { lastSeenAt: 0, now: 999999, ttlMs: 1000, armedTranscriptIds: [ 'T-open' ], openTranscriptIds: open } )
        expect( s.status ).toBe( 'stale' )
    } )


    it( 'waiting-for-user-answer = armed on an OPEN transcript', () => {
        const s = MemoView.deriveClientStatus( { lastSeenAt: 100, now: 200, ttlMs: 1000, armedTranscriptIds: [ 'T-open' ], openTranscriptIds: open } )
        expect( s.status ).toBe( 'waiting-for-user-answer' )
    } )


    it( 'working = fresh but not armed on any open transcript', () => {
        const s = MemoView.deriveClientStatus( { lastSeenAt: 100, now: 200, ttlMs: 1000, armedTranscriptIds: [ 'T-closed' ], openTranscriptIds: open } )
        expect( s.status ).toBe( 'working' )
    } )


    it( 'armed but on a CLOSED (not open) transcript is only working', () => {
        const s = MemoView.deriveClientStatus( { lastSeenAt: 100, now: 200, ttlMs: 1000, armedTranscriptIds: [], openTranscriptIds: open } )
        expect( s.status ).toBe( 'working' )
    } )
} )


describe( 'PRD-P3-01 — listClients TTL derivation (stale marking)', () => {
    it( 'marks a client stale once now - lastSeenAt > TTL', () => {
        MemoView.registerClient( { sessionId: 'p301-ttl', projectId: 'x' } )
        // A far-future now with a tiny TTL forces the stale branch regardless of real time.
        const { clients } = MemoView.listClients( { now: Date.now() + 1000000, ttlMs: 1 } )
        const mine = clients.find( ( c ) => c.sessionId === 'p301-ttl' )
        expect( mine.status ).toBe( 'stale' )
    } )
} )


describe( 'PRD-P3-01 — waiting-for-user-answer via the live arm map', () => {
    it( 'a client armed on an OPEN transcript derives waiting-for-user-answer', () => {
        MemoView.registerClient( { sessionId: 'p301-wait', projectId: 'x' } )
        MemoView.armSession( { sessionId: 'p301-wait', transcriptId: 'T-live-open' } )
        // Inject the open set (no transcript registry in this unit context).
        const { clients } = MemoView.listClients( { openTranscriptIds: new Set( [ 'T-live-open' ] ) } )
        const mine = clients.find( ( c ) => c.sessionId === 'p301-wait' )
        expect( mine.status ).toBe( 'waiting-for-user-answer' )
        expect( mine.armedTranscriptIds ).toContain( 'T-live-open' )
    } )
} )


describe( 'PRD-P3-03 — writeWakeFlag carries the transcriptId payload', () => {
    afterEach( async () => {
        await rm( join( WAKE_DIR, 'p303-a.flag' ), { force: true } )
        await rm( join( WAKE_DIR, 'p303-b.flag' ), { force: true } )
    } )


    it( 'writes the transcriptId INTO the flag (no longer empty)', async () => {
        const result = await MemoView.writeWakeFlag( { sessionId: 'p303-a', payload: 'T-9' } )
        expect( result.status ).toBe( true )
        expect( result.payload ).toBe( 'T-9' )
        expect( await exists( result.flagPath ) ).toBe( true )
        const body = await readFile( result.flagPath, 'utf-8' )
        expect( body ).toBe( 'T-9' )
    } )


    it( 'no payload keeps the historical empty flag (backward compatible)', async () => {
        const result = await MemoView.writeWakeFlag( { sessionId: 'p303-b' } )
        expect( result.status ).toBe( true )
        const body = await readFile( result.flagPath, 'utf-8' )
        expect( body ).toBe( '' )
    } )
} )


describe( 'PRD-P3-03 — session-wake-arm.sh emits the flag payload after WOKEN', () => {
    const SCRIPT = join( here, '..', '..', 'scripts', 'session-wake-arm.sh' )

    it( 'echoes "WOKEN <id> <payload>" when the flag carries a transcriptId', async () => {
        const dir = join( tmpdir(), 'memo-view-wake-p3jest' )
        await mkdir( dir, { recursive: true } )
        await writeFile( join( dir, 'jx.flag' ), 'T-payload-9' )

        const { stdout } = await execFileP( 'bash', [ SCRIPT, 'jx' ], { env: { ...process.env, WAKE_DIR: dir } } )
        expect( stdout ).toContain( 'WOKEN jx T-payload-9' )

        await rm( dir, { recursive: true, force: true } )
    } )

    it( 'keeps "WOKEN <id>" when the flag is empty (backward compatible)', async () => {
        const dir = join( tmpdir(), 'memo-view-wake-p3jest2' )
        await mkdir( dir, { recursive: true } )
        await writeFile( join( dir, 'jy.flag' ), '' )

        const { stdout } = await execFileP( 'bash', [ SCRIPT, 'jy' ], { env: { ...process.env, WAKE_DIR: dir } } )
        expect( stdout ).toContain( 'WOKEN jy' )
        expect( stdout ).not.toContain( 'WOKEN jy ' )

        await rm( dir, { recursive: true, force: true } )
    } )
} )


describe( 'route + client wiring (source assertions)', () => {
    let server = ''
    let client = ''
    let css = ''


    beforeAll( async () => {
        server = await readFile( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
        client = await readFile( join( here, '..', '..', 'src', 'public', 'app.client.mjs' ), 'utf8' )
        css = await readFile( join( here, '..', '..', 'src', 'public', 'app.css' ), 'utf8' )
    } )


    it( 'wires the three /api/clients routes (P3-01)', () => {
        expect( server.includes( "url === '/api/clients' && req.method === 'POST'" ) ).toBe( true )
        expect( server.includes( "url === '/api/clients' && req.method === 'GET'" ) ).toBe( true )
        expect( server.includes( "url.startsWith( '/api/clients/' ) && req.method === 'DELETE'" ) ).toBe( true )
    } )


    it( 'wires the annotation routes before the generic /api/documents/<id> GET (P3-04)', () => {
        expect( server.includes( "url === '/api/annotations' && req.method === 'POST'" ) ).toBe( true )
        const annIdx = server.indexOf( "url.endsWith( '/annotations' ) && req.method === 'GET'" )
        const genIdx = server.indexOf( "if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {" )
        expect( annIdx ).toBeGreaterThan( -1 )
        expect( genIdx ).toBeGreaterThan( annIdx )
    } )


    it( 'broadcasts clientList + annotationList (P3-01/04)', () => {
        expect( server.includes( "'type': 'clientList', clients" ) ).toBe( true )
        expect( server.includes( "'type': 'annotationList', documentId, annotations" ) ).toBe( true )
    } )


    it( 'introduces NO new listener — every new route hangs off the loopback-bound server (r6-F16)', () => {
        const listenCount = ( server.match( /\.listen\(/g ) || [] ).length
        expect( listenCount ).toBe( 3 )
        expect( server.includes( "const BIND_HOST = '127.0.0.1'" ) ).toBe( true )
    } )


    it( 'the wake route passes the transcriptId payload through (P3-03)', () => {
        expect( server.includes( "await MemoView.writeWakeFlag( { sessionId, payload } )" ) ).toBe( true )
        expect( client.includes( "body: JSON.stringify( { transcriptId: transcriptId } )" ) ).toBe( true )
    } )


    // PRD-002 (Memo 076, Phase 1, F10): Clients is no longer a 4th VIEW mode/tab — it is an
    // overlay-popup opened from #clients-head. The #mode-clients tab and the /clients route are
    // removed; renderClientsArea became renderClientsModal (writes into #clients-modal-body).
    it( 'the client wires the Clients overlay (opener, modal, WS branch, render) (P3-02 / M076 F10)', () => {
        // The 4th-tab is gone; #clients-head is the only opener, and the overlay markup exists.
        expect( server.includes( 'id="mode-clients"' ) ).toBe( false )
        expect( server.includes( 'id="clients-head"' ) ).toBe( true )
        expect( server.includes( 'id="clients-modal"' ) ).toBe( true )
        expect( server.includes( 'id="clients-modal-body"' ) ).toBe( true )
        expect( client.includes( "data.type === 'clientList'" ) ).toBe( true )
        // Render target moved from #content (renderClientsArea) to the overlay body (renderClientsModal).
        expect( client.includes( 'function renderClientsArea(' ) ).toBe( false )
        expect( client.includes( 'function renderClientsModal(' ) ).toBe( true )
        expect( client.includes( 'function openClientsModal(' ) ).toBe( true )
        expect( client.includes( 'function renderClientsSummary(' ) ).toBe( true )
        expect( client.includes( "modeForPath( window.location.pathname )" ) ).toBe( true )
        // The /clients mode route is removed with the tab.
        expect( client.includes( "if( pathname === '/clients'" ) ).toBe( false )
    } )


    it( 'the client wires the annotation render pass + authoring UI (P3-05/06)', () => {
        expect( client.includes( 'function applyAnnotations(' ) ).toBe( true )
        expect( client.includes( 'function anchorTextQuote(' ) ).toBe( true )
        expect( client.includes( 'function anchorTableRow(' ) ).toBe( true )
        expect( client.includes( "class=\"anm-mark\"" ) || client.includes( "'anm-mark'" ) ).toBe( true )
        expect( client.includes( "data.type === 'annotationList'" ) ).toBe( true )
        expect( client.includes( 'buildTextQuoteAnchorFromSelection' ) ).toBe( true )
        expect( client.includes( "fetch( '/api/annotations'" ) ).toBe( true )
        // applyAnnotations is hooked into applyContentStructure (runs on all render paths).
        const acsIdx = client.indexOf( 'function applyContentStructure(' )
        const hookIdx = client.indexOf( 'applyAnnotations()', acsIdx )
        expect( acsIdx ).toBeGreaterThan( -1 )
        expect( hookIdx ).toBeGreaterThan( acsIdx )
    } )


    it( 'annotation + clients use the reused .t-modal overlay / no while-loops added (house style)', () => {
        expect( server.includes( 'id="annotation-modal"' ) ).toBe( true )
        expect( server.includes( 'class="t-modal t-hidden"' ) ).toBe( true )
    } )


    it( 'the feedback modal carries the 4 quality-check boxes and the payload section (P3-08)', () => {
        expect( server.includes( 'data-quality="evidence"' ) ).toBe( true )
        expect( server.includes( 'data-quality="coherence"' ) ).toBe( true )
        expect( server.includes( 'data-quality="balance"' ) ).toBe( true )
        expect( server.includes( 'data-quality="references"' ) ).toBe( true )
        expect( client.includes( '## Quality-Checks angefragt' ) ).toBe( true )
        expect( client.includes( '.pp-quality-check' ) ).toBe( true )
    } )


    it( 'the client folds annotations into a ## Anmerkungen transcript section (P3-07 flow-back)', () => {
        expect( client.includes( '## Anmerkungen' ) ).toBe( true )
        expect( client.includes( "'### ' + a.id + ' — Anmerkung '" ) ).toBe( true )
        // typeof-guard keeps the isolated applyPromptEdit vm-eval safe.
        expect( client.includes( "typeof lastAnnotations !== 'undefined'" ) ).toBe( true )
    } )


    it( 'CSS additions are present for the new elements (non-overlay)', () => {
        expect( css.includes( '.clients-table' ) ).toBe( true )
        expect( css.includes( 'mark.anm-mark' ) ).toBe( true )
        expect( css.includes( '.anm-badge' ) ).toBe( true )
    } )
} )
