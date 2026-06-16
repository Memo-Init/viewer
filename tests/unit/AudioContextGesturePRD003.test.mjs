import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-003 (Memo 016 Kap 2, E4): no AudioContext before a user gesture, exactly one instance
// afterwards. MemoView.audioContextGate mirrors the inline acquireNotifyAudioCtx decision.
describe( 'MemoView.audioContextGate (PRD-003, E4)', () => {
    it( 'forbids any context before the first gesture', () => {
        const gate = MemoView.audioContextGate( { gestureSeen: false, hasContext: false } )

        expect( gate.mayUse ).toBe( false )
        expect( gate.create ).toBe( false )
    } )


    it( 'never creates a context before a gesture even if asked repeatedly', () => {
        const gate = MemoView.audioContextGate( { gestureSeen: false, hasContext: true } )

        expect( gate.mayUse ).toBe( false )
        expect( gate.create ).toBe( false )
    } )


    it( 'creates exactly one context on the first use after a gesture', () => {
        const gate = MemoView.audioContextGate( { gestureSeen: true, hasContext: false } )

        expect( gate.mayUse ).toBe( true )
        expect( gate.create ).toBe( true )
    } )


    it( 'reuses the existing context on later uses (no per-call leak)', () => {
        const gate = MemoView.audioContextGate( { gestureSeen: true, hasContext: true } )

        expect( gate.mayUse ).toBe( true )
        expect( gate.create ).toBe( false )
    } )
} )


// Source-shape regression: the inline tones must go through the single gated accessor and the
// gesture must unlock via pointerdown/keydown — no naked new AudioContext per call.
describe( 'inline audio is gesture-gated and single-instance (PRD-003, E4)', () => {
    const mjsSource = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
    const clientSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )
    const source = mjsSource + '\n' + clientSource

    it( 'has a single gated accessor acquireNotifyAudioCtx', () => {
        expect( source ).toContain( 'function acquireNotifyAudioCtx()' )
        expect( source ).toContain( 'if( !audioGestureSeen ) { return null }' )
    } )


    it( 'unlocks audio on the first pointerdown and keydown gesture (once)', () => {
        expect( source ).toContain( "document.addEventListener( 'pointerdown', unlockAudioGesture, { once: true } )" )
        expect( source ).toContain( "document.addEventListener( 'keydown', unlockAudioGesture, { once: true } )" )
    } )


    it( 'no notify tone constructs its own AudioContext directly anymore', () => {
        // The only place a context is constructed is inside acquireNotifyAudioCtx.
        const constructions = source.match( /new Ctx\(\)/g ) || []
        const directNew = source.match( /new \( window\.AudioContext \|\| window\.webkitAudioContext \)\(\)/g ) || []

        expect( constructions.length ).toBe( 1 )
        expect( directNew.length ).toBe( 0 )
    } )
} )
