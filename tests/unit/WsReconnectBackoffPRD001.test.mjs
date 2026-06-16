import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-001 (Memo 016 Kap 2): WS reconnect must use capped exponential backoff with a hard
// stop (E1) and onerror must not double-count attempts (E10). MemoView.reconnectDelay
// mirrors the inline browser ws.onclose handler so the curve is testable.
describe( 'MemoView.reconnectDelay (PRD-001, E1)', () => {
    it( 'returns 2s on the first attempt', () => {
        const { delay } = MemoView.reconnectDelay( { attempts: 1 } )

        expect( delay ).toBe( 2000 )
    } )


    it( 'grows exponentially: 2s, 4s, 8s, 16s', () => {
        const curve = [ 1, 2, 3, 4 ]
            .map( ( attempts ) => MemoView.reconnectDelay( { attempts } ).delay )

        expect( curve ).toEqual( [ 2000, 4000, 8000, 16000 ] )
    } )


    it( 'caps the delay at 30s', () => {
        const { delay } = MemoView.reconnectDelay( { attempts: 8 } )

        expect( delay ).toBe( 30000 )
    } )


    it( 'never exceeds the 30s cap for very high attempt counts', () => {
        const { delay } = MemoView.reconnectDelay( { attempts: 99 } )

        expect( delay ).toBe( 30000 )
    } )


    it( 'is monotonically non-decreasing', () => {
        const curve = [ 1, 2, 3, 4, 5, 6, 7, 8, 9 ]
            .map( ( attempts ) => MemoView.reconnectDelay( { attempts } ).delay )
        const sorted = [ ...curve ].sort( ( a, b ) => a - b )

        expect( curve ).toEqual( sorted )
    } )


    it( 'does not signal stop within the cap (attempts <= 8)', () => {
        const { shouldStop } = MemoView.reconnectDelay( { attempts: 8 } )

        expect( shouldStop ).toBe( false )
    } )


    it( 'signals stop once attempts exceed the cap (attempts > 8)', () => {
        const { shouldStop } = MemoView.reconnectDelay( { attempts: 9 } )

        expect( shouldStop ).toBe( true )
    } )


    it( 'guards a non-numeric attempts argument to the first-attempt delay', () => {
        const { delay } = MemoView.reconnectDelay( { attempts: undefined } )

        expect( delay ).toBe( 2000 )
    } )
} )


// Source-shape regression: the inline browser handler must keep mirroring the static
// curve (E1 backoff present, no naked setInterval reconnect, onerror does not increment).
describe( 'inline ws reconnect handler shape (PRD-001, E1/E10)', () => {
    const mjsSource = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
    const clientSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )
    const source = mjsSource + '\n' + clientSource

    it( 'uses setTimeout with exponential backoff in onclose, not a fixed setInterval', () => {
        expect( source ).toContain( 'RECONNECT_BASE_MS * Math.pow( 2, reconnectAttempts - 1 )' )
        expect( source ).not.toMatch( /setInterval\(\s*function\(\)\s*\{\s*connect\(\)/ )
    } )


    it( 'stops reconnecting once the cap is exceeded (E1 hard stop)', () => {
        expect( source ).toContain( 'reconnectAttempts > MAX_RECONNECT_ATTEMPTS' )
    } )


    it( 'onerror does not increment reconnectAttempts (E10)', () => {
        const onerror = source.slice( source.indexOf( 'ws.onerror = function()' ) )
            .slice( 0, 200 )

        expect( onerror ).not.toContain( 'reconnectAttempts++' )
    } )
} )
