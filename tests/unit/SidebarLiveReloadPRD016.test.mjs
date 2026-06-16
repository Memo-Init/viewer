import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-016 (Memo 016, E3): WS heartbeat. The server pings every interval and marks a client that
// did not pong as stale. MemoView.heartbeatDecision is the per-tick decision, mirrored by the
// sweep in #setupWebSocket. A stale connection (isAlive false) must be distinguishable from a
// healthy one (isAlive true) so "server up, wrong path" is no longer the same as "down".
describe( 'MemoView.heartbeatDecision (PRD-016, E3)', () => {
    it( 'terminates a client that did not pong since the last ping', () => {
        const decision = MemoView.heartbeatDecision( { isAlive: false } )

        expect( decision.terminate ).toBe( true )
        expect( decision.ping ).toBe( false )
    } )


    it( 'keeps a healthy client and pings it again', () => {
        const decision = MemoView.heartbeatDecision( { isAlive: true } )

        expect( decision.terminate ).toBe( false )
        expect( decision.ping ).toBe( true )
    } )


    it( 'always resets the alive flag to false before the next ping window', () => {
        const healthy = MemoView.heartbeatDecision( { isAlive: true } )
        const stale = MemoView.heartbeatDecision( { isAlive: false } )

        expect( healthy.nextIsAlive ).toBe( false )
        expect( stale.nextIsAlive ).toBe( false )
    } )


    it( 'distinguishes a stale connection from a healthy one (E3 core)', () => {
        const healthy = MemoView.heartbeatDecision( { isAlive: true } )
        const stale = MemoView.heartbeatDecision( { isAlive: false } )

        expect( healthy.terminate ).not.toBe( stale.terminate )
    } )
} )


// PRD-016 (Memo 016, E8): the sidebar no-op-skip decision. The WS broadcast rebuilds the sidebar
// innerHTML on every message; when the incoming signature equals the last rendered one the rebuild
// is skipped. MemoView.sidebarSignatureChanged mirrors the inline renderSidebar guard.
describe( 'MemoView.sidebarSignatureChanged (PRD-016, E8)', () => {
    it( 'always changes on the first render (prev null)', () => {
        const result = MemoView.sidebarSignatureChanged( { prev: null, next: '{"a":1}' } )

        expect( result.changed ).toBe( true )
    } )


    it( 'always changes on the first render (prev undefined)', () => {
        const result = MemoView.sidebarSignatureChanged( { prev: undefined, next: '{"a":1}' } )

        expect( result.changed ).toBe( true )
    } )


    it( 'skips (no change) when the signatures are identical', () => {
        const signature = JSON.stringify( { tree: { p: [ 'm1' ] }, latest: [] } )
        const result = MemoView.sidebarSignatureChanged( { prev: signature, next: signature } )

        expect( result.changed ).toBe( false )
    } )


    it( 're-renders (change) when the signature differs', () => {
        const prev = JSON.stringify( { tree: { p: [ 'm1' ] } } )
        const next = JSON.stringify( { tree: { p: [ 'm1', 'm2' ] } } )
        const result = MemoView.sidebarSignatureChanged( { prev, next } )

        expect( result.changed ).toBe( true )
    } )
} )


// PRD-016 (Memo 016, E9): the offline-banner visibility decision. The banner must be visible from
// the FIRST failed attempt (was only at >= 2). MemoView.offlineBannerVisible mirrors the inline
// updateConnectionStatus -> offlineBannerVisible helper.
describe( 'MemoView.offlineBannerVisible (PRD-016, E9)', () => {
    it( 'hides the banner while connected', () => {
        const result = MemoView.offlineBannerVisible( { state: 'connected', attempts: 5 } )

        expect( result.visible ).toBe( false )
    } )


    it( 'shows the banner from the FIRST failed attempt', () => {
        const result = MemoView.offlineBannerVisible( { state: 'offline', attempts: 1 } )

        expect( result.visible ).toBe( true )
    } )


    it( 'keeps the banner visible on later attempts', () => {
        const result = MemoView.offlineBannerVisible( { state: 'offline', attempts: 4 } )

        expect( result.visible ).toBe( true )
    } )


    it( 'does not show the banner before any attempt (attempts 0)', () => {
        const result = MemoView.offlineBannerVisible( { state: 'offline', attempts: 0 } )

        expect( result.visible ).toBe( false )
    } )


    it( 'guards a non-numeric attempts argument to not-visible', () => {
        const result = MemoView.offlineBannerVisible( { state: 'offline', attempts: undefined } )

        expect( result.visible ).toBe( false )
    } )
} )


// Source-shape regression: the server WS setup must wire the heartbeat (E3), the inline client
// must do the no-op skip (E8) and show the offline banner from the 1st attempt (E9). These guard
// against a silent revert of the runtime wiring that the pure helpers above cannot catch.
describe( 'sidebar / live-reload source shape (PRD-016, E3/E8/E9)', () => {
    const mjsSource = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
    const clientSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )
    const cssSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.css', import.meta.url ) ), 'utf8' )

    it( 'E3: server WS sets up a ping/pong heartbeat interval', () => {
        expect( mjsSource ).toContain( "ws.on( 'pong'" )
        expect( mjsSource ).toContain( 'ws.ping()' )
        expect( mjsSource ).toContain( 'setInterval' )
        expect( mjsSource ).toContain( 'ws.isAlive' )
    } )


    it( 'E3: the heartbeat interval is cleared when the wss closes (no leak)', () => {
        expect( mjsSource ).toContain( "wss.on( 'close'" )
        expect( mjsSource ).toContain( 'clearInterval( heartbeat )' )
    } )


    it( 'E8: renderSidebar does a no-op skip on an unchanged signature', () => {
        expect( clientSource ).toContain( 'function computeSidebarSignature()' )
        expect( clientSource ).toContain( 'lastSidebarSignature' )
        expect( clientSource ).toContain( 'sidebarSignatureChanged( lastSidebarSignature, nextSignature )' )
        // the guard returns early instead of always rebuilding innerHTML
        expect( clientSource ).toMatch( /if\( !sidebarSignatureChanged\([^)]*\) \) \{\s*return\s*\}/ )
    } )


    it( 'E9: the offline banner element + style exist', () => {
        expect( mjsSource ).toContain( 'id="offline-banner"' )
        expect( cssSource ).toContain( '.offline-banner' )
        expect( cssSource ).toContain( '.offline-banner-hidden' )
    } )


    it( 'E9: the offline indicator shows from the FIRST attempt, not only after 2', () => {
        expect( clientSource ).toContain( 'reconnectAttempts >= 1' )
        expect( clientSource ).not.toContain( 'reconnectAttempts >= 2' )
        expect( clientSource ).toContain( 'function offlineBannerVisible(' )
    } )


    it( 'E1 NOT regressed: the capped exponential backoff + hard stop stay intact', () => {
        expect( clientSource ).toContain( 'RECONNECT_BASE_MS * Math.pow( 2, reconnectAttempts - 1 )' )
        expect( clientSource ).toContain( 'reconnectAttempts > MAX_RECONNECT_ATTEMPTS' )
        expect( clientSource ).toContain( 'MAX_RECONNECT_ATTEMPTS = 8' )
    } )
} )
