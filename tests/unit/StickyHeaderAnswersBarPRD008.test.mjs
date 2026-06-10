import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'


// PRD-008 (Memo 024 Kap 7): the answers-only bar ("ohne Transcript speichern" + "Fertig") moves
// from the scrolling content flow into Sticky-Header Zone 2 (.hdr-zone-2). No jsdom is available,
// so — like Phase3Politur / SidebarConformance — we read the source + the escape-faithful emitted
// inline script and assert on the wiring (mount target, no content append, CSS) instead of a live
// DOM. The runtime DOM behaviour (sticky position, single ID, click handlers) is the Playwright AC.
describe( 'PRD-008 — Sticky-Header answers-only bar (Zone 2)', () => {
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


    it( 'defines mountAnswersOnlyBarInHeader that targets the Zone-2 element', () => {
        expect( emittedScript.includes( 'function mountAnswersOnlyBarInHeader' ) ).toBe( true )
        expect( emittedScript.includes( ".querySelector( '.hdr-zone-2' )" ) ).toBe( true )
    } )


    it( 'AC-03: the bar is NOT appended into the content widget container anymore', () => {
        // The old content-flow append (container.appendChild( buildAnswersOnlyBar() )) is gone.
        expect( emittedScript.includes( 'container.appendChild( buildAnswersOnlyBar() )' ) ).toBe( false )
        // renderQuestionWidgets now mounts into the header instead.
        expect( emittedScript.includes( 'mountAnswersOnlyBarInHeader()' ) ).toBe( true )
    } )


    it( 'AC-01/AC-02: updateSidebarSticky re-mounts the bar after rebuilding the header', () => {
        // The mount call appears inside the header-render path (updateSidebarSticky rebuilds
        // #main-header.innerHTML, so the bar must be re-mounted afterwards). At least two call
        // sites exist: renderQuestionWidgets and updateSidebarSticky.
        const calls = emittedScript.split( 'mountAnswersOnlyBarInHeader()' ).length - 1
        expect( calls ).toBeGreaterThanOrEqual( 2 )
    } )


    it( 'AC-06: the bar is only mounted while there are open questions, removed otherwise', () => {
        expect( emittedScript.includes( 'questionNav.questions.length > 0' ) ).toBe( true )
        // When not relevant, a stray bar is removed so #main-header:empty can hide itself.
        expect( emittedScript.includes( "removeChild( existing )" ) ).toBe( true )
    } )


    it( 'AC-04: existing functionality preserved — save + fertig handlers still bound', () => {
        expect( emittedScript.includes( 'saveBtn.addEventListener' ) ).toBe( true )
        expect( emittedScript.includes( '{ saveAnswersOnly() }' ) ).toBe( true )
        expect( emittedScript.includes( '{ markQuestionsFertig() }' ) ).toBe( true )
        // The disabled-state recompute still runs after mounting.
        expect( emittedScript.includes( 'updateSaveAnswersOnlyState()' ) ).toBe( true )
    } )


    it( 'AC-05: Zone-2 bar styling is present (header variant + primary/secondary buttons)', () => {
        expect( source.includes( '.qw-answers-only-bar.qw-answers-only-bar--header' ) ).toBe( true )
        expect( source.includes( '.qw-primary-btn {' ) ).toBe( true )
        expect( source.includes( '.qw-answers-only-bar.qw-fertig-done .qw-primary-btn' ) ).toBe( true )
    } )


    it( 'keeps the Zone-2 fill + top divider untouched (PRD-006 .hdr-zone-2)', () => {
        expect( source.includes( '#main-header .hdr-zone-2 {' ) ).toBe( true )
        expect( source.includes( 'background: var(--bg-2)' ) ).toBe( true )
        expect( source.includes( '#main-header:empty { display: none; }' ) ).toBe( true )
    } )
} )
