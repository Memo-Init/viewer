import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { readMemoViewSource, readMemoViewStyles } from '../helpers/extractFunction.mjs'


// PRD-013 (Memo 072, Phase 4, F6=A): the MERGED cockpit line in the viewer's Session-Kopf. This project
// has no jsdom/Playwright suite (execution-notes: @playwright/test is not a dependency), so — exactly
// like the SessionHeadViewPRD012 source-shape test — we assert on the emitted source: the nav MARKUP
// (MemoView.#buildHtmlPage), the stylesheet (app.css), the /api/cockpit route (MemoView) and the CLIENT
// script (app.client.mjs). Structural acceptance: the cockpit line lives INSIDE #session-head (the ONE
// surface, F6=A), the /api/cockpit route is registered before the /api/ catch-all and uses the vendored
// CockpitLine, NO second serve()/listen is added by the viewer, and the client fetches + renders it.
describe( 'Memo 072 PRD-013 — Cockpit-Merge-View (Markup, Route, CSS, Client)', () => {
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


    // ---- Cockpit-Zeile INSIDE the #session-head (F6=A merge, not a second surface). ----
    describe( 'Cockpit-Zeile im #session-head (F6=A)', () => {
        it( 'the cockpit slot #session-cockpit sits INSIDE the #session-head region', () => {
            const headOpen = markup.indexOf( 'id="session-head"' )
            const headClose = markup.indexOf( '</div>', markup.indexOf( 'id="session-status"' ) )
            const cockpit = markup.indexOf( 'id="session-cockpit"' )
            expect( headOpen ).toBeGreaterThan( -1 )
            expect( cockpit ).toBeGreaterThan( headOpen )
            expect( cockpit ).toBeLessThan( headClose )
        } )

        it( 'the cockpit slot carries a Cockpit label and defaults to an em dash (No-Silent-Default)', () => {
            expect( markup.includes( 'Cockpit:' ) ).toBe( true )
            expect( /id="session-cockpit"[^>]*>—</.test( markup ) ).toBe( true )
        } )

        it( 'the PRD-012 session head slots (Namespace/Memo/Mode) are still present (merge, not replace)', () => {
            expect( markup.includes( 'id="session-namespace"' ) ).toBe( true )
            expect( markup.includes( 'id="session-memo"' ) ).toBe( true )
            expect( markup.includes( 'id="session-mode"' ) ).toBe( true )
        } )
    } )


    // ---- /api/cockpit route: vendored CockpitLine, before catch-all, ONE surface. ----
    describe( 'Endpoint /api/cockpit', () => {
        it( 'registers an exact GET /api/cockpit route', () => {
            expect( markup.includes( "url === '/api/cockpit' && req.method === 'GET'" ) ).toBe( true )
        } )

        it( 'the /api/cockpit route is matched BEFORE the /api/ catch-all 404', () => {
            const cockpit = markup.indexOf( "url === '/api/cockpit' && req.method === 'GET'" )
            const catchAll = markup.indexOf( "if( url.startsWith( '/api/' ) ) {" )
            expect( cockpit ).toBeGreaterThan( -1 )
            expect( catchAll ).toBeGreaterThan( -1 )
            expect( cockpit ).toBeLessThan( catchAll )
        } )

        it( 'the route reads the snapshot via the VENDORED CockpitLine (no cross-repo core import)', () => {
            expect( markup.includes( "import { CockpitLine } from './CockpitLine.mjs'" ) ).toBe( true )
            expect( markup.includes( 'CockpitLine.resolveLine' ) ).toBe( true )
            // No cross-repo dependency on core — the viewer stays standalone (PRD-012 posture). The
            // serve()-bearing CockpitWatcher class is NEVER imported; only the pure render/read logic
            // was vendored into CockpitLine.mjs.
            expect( markup.includes( '../../core' ) ).toBe( false )
            expect( markup.includes( "import { CockpitWatcher }" ) ).toBe( false )
        } )

        it( 'the viewer opens NO second listener for the cockpit (F6=A: one port, the viewer loopback)', () => {
            // The merge means the cockpit route answers on the viewer's OWN server via the shared
            // sendJson responder — it never creates a second http server / listener for the cockpit.
            const start = markup.indexOf( "url === '/api/cockpit' && req.method === 'GET'" )
            const end = markup.indexOf( 'return', start )
            const routeBody = markup.slice( start, end )
            expect( routeBody.includes( 'sendJson' ) ).toBe( true )
            expect( routeBody.includes( 'createServer' ) ).toBe( false )
            expect( routeBody.includes( '.listen(' ) ).toBe( false )
        } )
    } )


    // ---- CSS. ----
    describe( 'app.css — Cockpit-Slot-Style', () => {
        it( 'styles the merged #session-cockpit slot', () => {
            expect( css.includes( '#session-cockpit {' ) ).toBe( true )
        } )
    } )


    // ---- Client wiring: fetch + render + boot/reconnect refresh. ----
    describe( 'app.client.mjs — Fetch + Render', () => {
        it( 'defines renderCockpit and refreshCockpit', () => {
            expect( client.includes( 'function renderCockpit(' ) ).toBe( true )
            expect( client.includes( 'function refreshCockpit(' ) ).toBe( true )
        } )

        it( 'fetches the /api/cockpit endpoint', () => {
            expect( client.includes( "fetch( '/api/cockpit' )" ) ).toBe( true )
        } )

        it( 'drops the cockpit line into #session-cockpit textContent', () => {
            expect( client.includes( "document.getElementById( 'session-cockpit' )" ) ).toBe( true )
            expect( client.includes( 'sessionCockpitEl.textContent = line' ) ).toBe( true )
        } )

        it( 'refreshes the cockpit at boot AND on WS (re)connect (>= 2 call sites)', () => {
            const count = client.split( 'refreshCockpit()' ).length - 1
            // one call site at boot + one in ws.onopen (the DEFINITION uses "refreshCockpit(" )
            expect( count ).toBeGreaterThanOrEqual( 2 )
        } )
    } )
} )
