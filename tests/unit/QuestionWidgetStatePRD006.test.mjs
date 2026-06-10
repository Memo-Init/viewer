import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'


// PRD-006 (Memo 018 Kap 9) widget changes live inside the single inline <script> the page
// emits as a template literal. There is no jsdom in this project, so — exactly like the
// existing QuestionWidgetRender.test.mjs — these tests (a) prove the emitted browser script
// is syntactically valid after the template-literal escape collapse, and (b) assert each
// behavioural hook is present and the old destructive behaviour is gone.
//
// FLAGGED: the live DOM flows (real click on "Hinzufügen"/"Ablehnen"/"Fertig", real Enter/
// Tab keystrokes, real reattachment of the answered-questions section on transcript reopen)
// are NOT driven through a browser here — they are covered by the implemented code paths and
// asserted structurally. The PRD's Playwright suite is the browser-level complement.
describe( 'Question widget state — PRD-006 (Memo 018 Kap 9)', () => {
    let emittedScript = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )
        const source = await readFile( sourcePath, 'utf8' )

        const open = source.lastIndexOf( '<script>' )
        const close = source.indexOf( '</script>', open )
        const rawSlice = source.slice( open + '<script>'.length, close )

        expect( rawSlice.includes( '${' ) ).toBe( false )

        // eslint-disable-next-line no-new-func — controlled, escape-faithful, no interpolation.
        const toRuntime = new Function( 'return `' + rawSlice.replace( /`/g, '\\`' ) + '`' )
        emittedScript = toRuntime()
    } )


    it( 'emits a syntactically valid inline browser script', () => {
        let message = ''
        try {
            new vm.Script( emittedScript )
        } catch( err ) {
            message = err.message
        }
        expect( message ).toBe( '' )
    } )


    // AC-07 — "Hinzufügen" reversible.
    it( 'makes "Hinzufügen" reversible via undoQuestionAnswer (AC-07)', () => {
        expect( emittedScript.includes( 'function undoQuestionAnswer' ) ).toBe( true )
        // A second submit on an already-added question delegates to the undo path.
        expect( emittedScript.includes( 'if( st.added ) {' ) ).toBe( true )
        expect( emittedScript.includes( 'undoQuestionAnswer( qIdx )' ) ).toBe( true )
        // The done-state button stays clickable and advertises the undo (no dead end).
        expect( emittedScript.includes( 'hinzugefügt ✓ (rückgängig)' ) ).toBe( true )
        expect( emittedScript.includes( 'addBtn.disabled = false' ) ).toBe( true )
    } )


    // AC-08 — Ablehnen without data loss + reversible.
    it( 'rejectQuestion no longer clears st.selected (AC-08)', () => {
        // The old destructive line must be gone.
        expect( emittedScript.includes( 'if( st ) { st.selected = [] }' ) ).toBe( false )
        // And the new reject sets the rejected flag instead of wiping the selection.
        expect( emittedScript.includes( 'st.rejected = true' ) ).toBe( true )
        expect( emittedScript.includes( 'Deliberately do NOT touch st.selected' ) ).toBe( true )
    } )


    it( 'provides an "Ablehnen rückgängig" undo path (AC-08)', () => {
        expect( emittedScript.includes( 'function undoRejectQuestion' ) ).toBe( true )
        expect( emittedScript.includes( 'function toggleRejectQuestion' ) ).toBe( true )
        expect( emittedScript.includes( "'Ablehnen rückgängig'" ) ).toBe( true )
        expect( emittedScript.includes( "card.classList.remove( 'qw-collapsed', 'qw-rejected' )" ) ).toBe( true )
    } )


    // AC-05 — "Fertig"-Button.
    it( 'renders a "Fertig" button gating workflow completion (AC-05)', () => {
        expect( emittedScript.includes( 'qw-fertig-btn' ) ).toBe( true )
        expect( emittedScript.includes( 'function markQuestionsFertig' ) ).toBe( true )
        expect( emittedScript.includes( 'questionNav.fertig' ) ).toBe( true )
    } )


    // AC-06 — full keyboard control.
    it( 'binds Enter to "Hinzufügen" and Tab to footer cycling (AC-06)', () => {
        expect( emittedScript.includes( "if( ev.key === 'Enter' )" ) ).toBe( true )
        expect( emittedScript.includes( 'submitQuestionAnswer( questionNav.active )' ) ).toBe( true )
        expect( emittedScript.includes( "if( ev.key === 'Tab' )" ) ).toBe( true )
        expect( emittedScript.includes( 'function cycleFooterFocus' ) ).toBe( true )
        // The "log in via keyboard" shortcut (Ctrl/Cmd+L).
        expect( emittedScript.includes( "ev.key === 'l' && ( ev.ctrlKey || ev.metaKey )" ) ).toBe( true )
    } )


    it( 'keeps the existing Shift+Up/Down, Up/Down, Left/Right, Space navigation (AC-06)', () => {
        expect( emittedScript.includes( "ev.shiftKey && ( ev.key === 'ArrowUp' || ev.key === 'ArrowDown' )" ) ).toBe( true )
        expect( emittedScript.includes( "ev.key === 'ArrowLeft' || ev.key === 'ArrowRight'" ) ).toBe( true )
        expect( emittedScript.includes( "ev.key === ' ' || ev.key === 'Spacebar'" ) ).toBe( true )
    } )


    // AC-09 — answers changeable.
    it( 'overwrites st.addedText when re-adding after a selection change (AC-09)', () => {
        // toggleOption resets the added state so a re-add produces a fresh addedText.
        expect( emittedScript.includes( 'if( st.added ) {' ) ).toBe( true )
        expect( emittedScript.includes( 'st.addedText = null' ) ).toBe( true )
        expect( emittedScript.includes( 'st.addedText = built.text' ) ).toBe( true )
    } )


    // AC-03 / AC-04 — answered-questions persistence + reattachment.
    it( 'appends confirmed answers on the normal save path (AC-03)', () => {
        expect( emittedScript.includes( 'function appendAddedAnswers' ) ).toBe( true )
        expect( emittedScript.includes( 'content = appendAddedAnswers( content )' ) ).toBe( true )
    } )


    it( 'splits + reattaches the answered-questions section on reopen (AC-04)', () => {
        expect( emittedScript.includes( 'function splitAnswerBlocks' ) ).toBe( true )
        expect( emittedScript.includes( 'transcript-answers' ) ).toBe( true )
        expect( emittedScript.includes( 'Beantwortete Fragen (angehängt · unveränderlich)' ) ).toBe( true )
        // Reattachment only for "Memo" transcripts.
        expect( emittedScript.includes( "type === 'memo-init' && split.answersMd.trim().length > 0" ) ).toBe( true )
    } )


    // The state shape carries the new reversible-reject flag.
    it( 'initialises per-question state with a rejected flag (AC-08)', () => {
        expect( emittedScript.includes( 'rejected: false' ) ).toBe( true )
    } )


    // splitAnswerBlocks is a PURE string function — extract its definition from the emitted
    // browser script and execute it in isolation to prove the AC-04 split actually works.
    it( 'splitAnswerBlocks separates persisted answer blocks from the body (AC-04, executable)', () => {
        const start = emittedScript.indexOf( 'function splitAnswerBlocks' )
        expect( start ).toBeGreaterThan( -1 )

        // Slice up to the matching closing brace of the function (it ends just before the
        // next top-level "// PRD-006" comment block following it in the source).
        const tailMarker = '// PRD-006 (Kap 9, AC-04): split persisted'
        const beforeTail = emittedScript.indexOf( tailMarker )
        const region = emittedScript.slice( beforeTail )
        const fnStart = region.indexOf( 'function splitAnswerBlocks' )
        const afterFn = region.indexOf( '\n        }', fnStart )
        const fnSource = region.slice( fnStart, afterFn + '\n        }'.length )

        const factory = new Function( fnSource + '\n        return splitAnswerBlocks' )
        const splitAnswerBlocks = factory()

        const body = [
            'Hier steht der echte Transcript-Text.',
            '',
            '## Antwort auf F1 — Begriffswahl',
            '',
            'A) Context Rot',
            '',
            '## Antwort auf F2 — Verhältnis',
            '',
            'B) Erweiterung',
            ''
        ].join( '\n' )

        const result = splitAnswerBlocks( body )

        expect( result.bodyWithoutAnswers ).toBe( 'Hier steht der echte Transcript-Text.' )
        expect( result.answersMd.includes( '## Antwort auf F1' ) ).toBe( true )
        expect( result.answersMd.includes( '## Antwort auf F2' ) ).toBe( true )
        expect( result.answersMd.includes( 'A) Context Rot' ) ).toBe( true )
    } )
} )
