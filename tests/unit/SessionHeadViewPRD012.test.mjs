import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { readMemoViewSource, readMemoViewStyles } from '../helpers/extractFunction.mjs'


// PRD-012 (Memo 072, Phase 4, F6=A): the Session-Kopf UI. This project has no jsdom/Playwright suite
// (execution-notes: @playwright/test is not a dependency), so — exactly like the other viewer UI PRD
// source-shape tests (A11yAndLabelsPRD013, ProsePolishPRD015) — we assert on the emitted source:
// the nav MARKUP (MemoView.#buildHtmlPage), the stylesheet (app.css) and the CLIENT script
// (app.client.mjs). The structural acceptance is: the #session-head region renders Namespace/Memo/Mode,
// TWO distinct lamps exist (#status = Server-Verbindung, #session-status = Session-Health), the existing
// #status lamp is NOT removed, and the /api/session route is registered before the /api/ catch-all.
describe( 'Memo 072 PRD-012 — Session-Kopf-View (Markup, CSS, Client)', () => {
    let markup = ''
    let css = ''
    let client = ''


    beforeAll( async () => {
        markup = await readMemoViewSource()
        css = await readMemoViewStyles()
        const here = dirname( fileURLToPath( import.meta.url ) )
        const clientPath = join( here, '..', '..', 'src', 'public', 'app.client.mjs' )
        client = await readFile( clientPath, 'utf8' )
    } )


    // ---- Session-Kopf-Region im Markup. ----
    describe( 'Nav-Bar rendert #session-head', () => {
        it( 'the nav bar carries a #session-head region as a labelled live status', () => {
            const open = markup.indexOf( 'id="session-head"' )
            expect( open ).toBeGreaterThan( -1 )
            const tag = markup.slice( open, markup.indexOf( '>', open ) )
            expect( tag.includes( 'role="status"' ) ).toBe( true )
            expect( tag.includes( 'aria-live="polite"' ) ).toBe( true )
        } )

        it( 'the head shows Namespace, Memo and Mode value slots (default em dash)', () => {
            expect( markup.includes( 'id="session-namespace"' ) ).toBe( true )
            expect( markup.includes( 'id="session-memo"' ) ).toBe( true )
            expect( markup.includes( 'id="session-mode"' ) ).toBe( true )
            expect( markup.includes( 'Namespace:' ) ).toBe( true )
            expect( markup.includes( 'Mode:' ) ).toBe( true )
            // No-Silent-Default: the value slots default to an em dash, not a guessed value.
            expect( /id="session-mode"[^>]*>—</.test( markup ) ).toBe( true )
        } )

        it( 'the SESSION head is distinct from the #mode-toggle VIEW switcher (both present)', () => {
            expect( markup.includes( 'id="mode-toggle"' ) ).toBe( true )
            expect( markup.includes( 'id="session-head"' ) ).toBe( true )
        } )
    } )


    // ---- Zwei getrennte Lampen (T003 #3). ----
    describe( 'Zwei getrennte Lampen: #status (Server) + #session-status (Session)', () => {
        it( 'the existing #status lamp is still present and labelled "Server-Verbindung"', () => {
            const open = markup.indexOf( 'id="status"' )
            expect( open ).toBeGreaterThan( -1 )
            const tag = markup.slice( open, markup.indexOf( '>', open ) )
            expect( tag.includes( 'Server-Verbindung' ) ).toBe( true )
        } )

        it( 'a SECOND lamp #session-status exists, labelled "Session-Health", separate from #status', () => {
            const open = markup.indexOf( 'id="session-status"' )
            expect( open ).toBeGreaterThan( -1 )
            const tag = markup.slice( open, markup.indexOf( '>', open ) )
            expect( tag.includes( 'Session-Health' ) ).toBe( true )
            // Two DISTINCT ids — the session lamp is not the server lamp.
            expect( markup.includes( 'id="session-status"' ) ).toBe( true )
            expect( markup.includes( 'id="status"' ) ).toBe( true )
        } )
    } )


    // ---- /api/session Route. ----
    describe( 'Endpoint /api/session', () => {
        it( 'registers an exact GET /api/session route', () => {
            expect( markup.includes( "url === '/api/session' && req.method === 'GET'" ) ).toBe( true )
        } )

        it( 'the /api/session route is matched BEFORE the /api/ catch-all 404', () => {
            const session = markup.indexOf( "url === '/api/session' && req.method === 'GET'" )
            const catchAll = markup.indexOf( "if( url.startsWith( '/api/' ) ) {" )
            expect( session ).toBeGreaterThan( -1 )
            expect( catchAll ).toBeGreaterThan( -1 )
            expect( session ).toBeLessThan( catchAll )
        } )

        it( 'the route answers the { namespace, activeMemo, workMode } contract via SessionHead', () => {
            expect( markup.includes( 'SessionHead.resolve' ) ).toBe( true )
            expect( markup.includes( "'workMode': head[ 'workMode' ]" ) ).toBe( true )
        } )
    } )


    // ---- CSS. ----
    describe( 'app.css — Session-Kopf-Styles', () => {
        it( 'styles the #session-head region', () => {
            expect( css.includes( '#session-head {' ) ).toBe( true )
        } )

        it( 'styles the second #session-status lamp with an active state', () => {
            expect( css.includes( '#session-status {' ) ).toBe( true )
            expect( css.includes( '#session-status.active' ) ).toBe( true )
        } )
    } )


    // ---- Client-Verdrahtung. ----
    describe( 'app.client.mjs — Fetch + Render', () => {
        it( 'defines renderSessionHead and refreshSessionHead', () => {
            expect( client.includes( 'function renderSessionHead(' ) ).toBe( true )
            expect( client.includes( 'function refreshSessionHead(' ) ).toBe( true )
        } )

        it( 'fetches the /api/session endpoint', () => {
            expect( client.includes( "fetch( '/api/session' )" ) ).toBe( true )
        } )

        it( 'toggles the session-health lamp active state from the work-mode', () => {
            expect( client.includes( "sessionStatusEl.classList.toggle( 'active', active )" ) ).toBe( true )
        } )

        it( 'refreshes the head at boot and on WS (re)connect', () => {
            const count = client.split( 'refreshSessionHead()' ).length - 1
            // one call site at boot + one in ws.onopen (the function DEFINITION uses "refreshSessionHead(" )
            expect( count ).toBeGreaterThanOrEqual( 2 )
        } )
    } )
} )
