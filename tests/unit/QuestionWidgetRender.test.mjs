import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'


// Phase 5 (Memo 016 Kap 11) render-side changes live inside the single inline <script> of
// the HTML page that #buildHtmlPage emits as a template literal. Rather than booting the
// full server (which opens a browser via `open` and starts watchers), we read the source,
// isolate the inline <script> body, and reproduce the template-literal escape processing.
// That yields the EXACT string the browser receives — which is what matters for PRD-025's
// escape-level fix. We then (a) assert that emitted browser script parses (vm.Script catches
// escape/syntax bugs) and (b) assert each Phase-5 render hook is present.
describe( 'Question widget render — Phase 5 (Memo 016 Kap 11)', () => {
    let emittedScript = ''


    beforeAll( async () => {
        // PRD-011 (Memo 016, F1/F2): the inline client <script> was extracted to
        // src/public/app.client.mjs, which is already the runtime-emitted form (the template-literal
        // escapes were collapsed during extraction, so `\(` / `\s` are single-backslash exactly as a
        // browser sees them). Reading it directly gives the real browser string — no slice needed.
        const here = dirname( fileURLToPath( import.meta.url ) )
        const clientPath = join( here, '..', '..', 'src', 'public', 'app.client.mjs' )
        emittedScript = await readFile( clientPath, 'utf8' )
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


    it( 'labels Hintergrund, Frage and KI-Empfehlung as distinct blocks (PRD-023)', () => {
        expect( emittedScript.includes( 'qw-hintergrund-label' ) ).toBe( true )
        expect( emittedScript.includes( 'qw-frage-label' ) ).toBe( true )
        expect( emittedScript.includes( 'qw-ai-label' ) ).toBe( true )
        expect( emittedScript.includes( "'FRAGE'" ) ).toBe( true )
        expect( emittedScript.includes( "'KI-EMPFEHLUNG'" ) ).toBe( true )
    } )


    it( 'keeps the existing block classes as hooks (PRD-023)', () => {
        expect( emittedScript.includes( 'qw-hintergrund' ) ).toBe( true )
        expect( emittedScript.includes( 'qw-frage' ) ).toBe( true )
        expect( emittedScript.includes( 'qw-ai-line' ) ).toBe( true )
    } )


    it( 'uses circular modulo wrap in the Shift+Up/Down handler (PRD-024)', () => {
        expect( emittedScript.includes( '( ( questionNav.active + delta ) % n + n ) % n' ) ).toBe( true )
        // The old clamping lines must be gone.
        expect( emittedScript.includes( 'if( next < 0 ) { next = 0 }' ) ).toBe( false )
    } )


    it( 'emits a valid, matching scrollToTopic RegExp (PRD-025)', () => {
        expect( emittedScript.includes( 'function findTopicTarget' ) ).toBe( true )
        // The emitted browser string must be single-escaped, not the broken quad-escape.
        expect( emittedScript.includes( "'kap(itel)?\\\\.?" ) ).toBe( false )
        expect( emittedScript.includes( "'kap(itel)?\\.?\\s*'" ) ).toBe( true )

        // Reproduce the exact RegExp the browser builds and prove it matches real headings.
        const pos = '11.7'
        const re = new RegExp( 'kap(itel)?\\.?\\s*' + String( pos ).replace( '.', '\\.' ) + '\\b', 'i' )
        expect( re.test( 'Kapitel 11.7 Lessons' ) ).toBe( true )
        expect( re.test( 'Kap. 11.7' ) ).toBe( true )
        expect( re.test( 'Kap 11.7' ) ).toBe( true )
        expect( re.test( 'Kap 11.70' ) ).toBe( false )
    } )


    it( 'marks topic chips without a jump target as inert (PRD-025)', () => {
        expect( emittedScript.includes( 'qw-topic-dead' ) ).toBe( true )
        // The dead-cursor CSS rule is rendered in the page <style>, outside the inline script.
    } )


    it( 'renders the full aiRecommendation reasoning in the KI-EMPFEHLUNG block (PRD-004 Bug B)', () => {
        // The widget must feed the qw-ai-text span from q.aiRecommendation (the reasoning),
        // not only from the preselected option label. Prove the reasoning string is read.
        expect( emittedScript.includes( 'q.aiRecommendation' ) ).toBe( true )
        expect( emittedScript.includes( 'var aiReasoning' ) ).toBe( true )
        // The reasoning, when present, is written into the qw-ai-text span.
        expect( emittedScript.includes( "aiText.className = 'qw-ai-text'" ) ).toBe( true )
        expect( emittedScript.includes( 'aiReasoning.length > 0' ) ).toBe( true )
        expect( emittedScript.includes( 'aiKeyPrefix + aiReasoning' ) ).toBe( true )
    } )
} )
