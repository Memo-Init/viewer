import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'


// PRD-009 (Memo 024 Kap 7): the pure trigger logic is covered by QueueGrowthNotifyPRD009 against
// MemoView.detectQueueGrowth. This suite covers the browser-side WIRING that no jsdom is available
// to exercise live: the Web-Audio helper, the queue-add hook, and the regression guard that the
// disabled content-sound path stays disabled. The live ton + autoplay behaviour are Playwright ACs.
describe( 'PRD-009 — Audio-Notify wiring', () => {
    let source = ''
    let emittedScript = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )
        source = await readFile( sourcePath, 'utf8' )

        const open = source.lastIndexOf( '<script>' )
        const close = source.indexOf( '</script>', open )
        const rawSlice = source.slice( open + '<script>'.length, close )

        // eslint-disable-next-line no-new-func — controlled, escape-faithful, no interpolation.
        const toRuntime = new Function( 'return `' + rawSlice.replace( /`/g, '\\`' ) + '`' )
        emittedScript = toRuntime()
    } )


    it( 'AC-03: uses a Web-Audio oscillator helper (no external asset)', () => {
        expect( emittedScript.includes( 'function playQueueNotifyTone' ) ).toBe( true )
        expect( emittedScript.includes( 'window.AudioContext || window.webkitAudioContext' ) ).toBe( true )
        expect( emittedScript.includes( '.createOscillator()' ) ).toBe( true )
    } )


    it( 'AC-06: respects autoplay — resumes a suspended context and degrades silently', () => {
        expect( emittedScript.includes( "notifyAudioCtx.state === 'suspended'" ) ).toBe( true )
        expect( emittedScript.includes( 'notifyAudioCtx.resume' ) ).toBe( true )
        // A try/catch wraps the audio path so a blocked/missing backend never throws.
        expect( emittedScript.includes( 'try {' ) ).toBe( true )
    } )


    it( 'AC-01/AC-02: hooks the queue diff into the sidebar render via inline diff logic', () => {
        expect( emittedScript.includes( 'function maybeNotifyQueueGrowth' ) ).toBe( true )
        // The browser bundle must NOT reference the server-side MemoView class (it is not defined
        // in the browser — doing so throws "MemoView is not defined" and breaks the whole viewer).
        // The detectQueueGrowth logic is inlined client-side instead.
        expect( emittedScript.includes( 'MemoView.detectQueueGrowth(' ) ).toBe( false )
        expect( emittedScript.includes( 'var addedKeys = currentKeys.filter' ) ).toBe( true )
        // Triggered from the queue computation in renderSidebarMemos.
        expect( emittedScript.includes( 'maybeNotifyQueueGrowth( queue )' ) ).toBe( true )
    } )


    it( 'AC-04: the baseline starts as null so the initial load stays silent', () => {
        expect( emittedScript.includes( 'let lastQueueKeys = null' ) ).toBe( true )
    } )


    it( 'derives stable documentId::fileName keys for the diff (not counts)', () => {
        expect( emittedScript.includes( 'function queueKeysOf' ) ).toBe( true )
        expect( emittedScript.includes( "'::'" ) ).toBe( true )
    } )


    it( 'AC-05: the disabled content-sound path stays disabled (not reactivated)', () => {
        expect( emittedScript.includes( 'notification sound disabled in server mode' ) ).toBe( true )
        // The new trigger lives at the queue render, NOT in the content handler.
        expect( emittedScript.includes( 'playQueueNotifyTone()' ) ).toBe( true )
    } )
} )
