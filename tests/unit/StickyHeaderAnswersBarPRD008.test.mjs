import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'


// PRD-008 (Memo 024 Kap 7) introduced the answers-only bar ("ohne Transcript speichern" + "Fertig")
// in Sticky-Header Zone 2. PRD-012 (Memo 076 H8, WI-106) REMOVED that whole path: buildAnswersOnlyBar
// had no caller, mountAnswersOnlyBarInHeader only stripped a bar that was never built, and
// saveAnswersOnly/markQuestionsFertig were only reachable through buildAnswersOnlyBar — the "Prompt
// bearbeiten" popup's "Übernehmen" (applyPromptEdit) already persists both the transcript and the
// answers. No jsdom is available, so — like the original — we grep the emitted client script + the
// source (MemoView + CSS) and assert the dead path is gone. The Zone-2 fill itself stays.
describe( 'PRD-012 (Memo 076 H8, WI-106) — answers-only bar dead path removed', () => {
    let source = ''
    let emittedScript = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )
        const cssPath = join( here, '..', '..', 'src', 'public', 'app.css' )
        const clientPath = join( here, '..', '..', 'src', 'public', 'app.client.mjs' )
        const mjsSource = await readFile( sourcePath, 'utf8' )
        const cssSource = await readFile( cssPath, 'utf8' )

        emittedScript = await readFile( clientPath, 'utf8' )
        source = mjsSource + '\n' + cssSource
    } )


    it( 'removed buildAnswersOnlyBar, mountAnswersOnlyBarInHeader, saveAnswersOnly, markQuestionsFertig (WI-106)', () => {
        expect( emittedScript.includes( 'function buildAnswersOnlyBar' ) ).toBe( false )
        expect( emittedScript.includes( 'function mountAnswersOnlyBarInHeader' ) ).toBe( false )
        expect( emittedScript.includes( 'function saveAnswersOnly' ) ).toBe( false )
        expect( emittedScript.includes( 'function markQuestionsFertig' ) ).toBe( false )
    } )


    it( 'no remaining calls to the removed functions (no orphans)', () => {
        expect( emittedScript.includes( 'mountAnswersOnlyBarInHeader()' ) ).toBe( false )
        expect( emittedScript.includes( 'buildAnswersOnlyBar()' ) ).toBe( false )
        expect( emittedScript.includes( '{ saveAnswersOnly() }' ) ).toBe( false )
        expect( emittedScript.includes( '{ markQuestionsFertig() }' ) ).toBe( false )
    } )


    it( 'removed the answers-only bar CSS but kept the shared .qw-secondary-btn / .qw-note', () => {
        expect( source.includes( '.qw-answers-only-bar' ) ).toBe( false )
        expect( source.includes( '.qw-primary-btn' ) ).toBe( false )
        expect( source.includes( '.qw-answers-only-status' ) ).toBe( false )
        // Shared widget classes stay (used by the live add/reject buttons + notes).
        expect( source.includes( '.qw-secondary-btn {' ) ).toBe( true )
        expect( source.includes( '.qw-note {' ) ).toBe( true )
    } )


    it( 'keeps the Zone-2 fill + top divider untouched (PRD-006 .hdr-zone-2)', () => {
        expect( source.includes( '#main-header .hdr-zone-2 {' ) ).toBe( true )
        expect( source.includes( 'background: var(--bg-2)' ) ).toBe( true )
        expect( source.includes( '#main-header:empty { display: none; }' ) ).toBe( true )
    } )
} )
