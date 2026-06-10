import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-010 (Memo 024 Kap 8): a mermaid diagram with a syntax error must NOT degrade
// the viewer to a bare error ("Bombe"). The static MemoView.buildMermaidErrorHtml
// mirrors the inline browser helper of the same name and produces the error message
// PLUS the unchanged original mermaid source as an HTML-escaped <pre> block.
describe( 'MemoView.buildMermaidErrorHtml (PRD-010)', () => {
    it( 'includes the error message from err.message (AC-1)', () => {
        const { html } = MemoView.buildMermaidErrorHtml( { err: new Error( 'Parse error on line 3' ), originalText: 'flowchart TD' } )

        expect( html ).toContain( 'Mermaid Error: Parse error on line 3' )
    } )


    it( 'falls back to String(err) when err has no message (AC-1)', () => {
        const { html } = MemoView.buildMermaidErrorHtml( { err: 'raw failure', originalText: 'flowchart TD' } )

        expect( html ).toContain( 'Mermaid Error: raw failure' )
    } )


    it( 'renders the original mermaid source in a <pre> block (AC-1)', () => {
        const { html } = MemoView.buildMermaidErrorHtml( { err: new Error( 'x' ), originalText: 'flowchart TD\n  A --> B' } )

        expect( html ).toContain( '<pre class="mermaid-error-source">' )
        expect( html ).toContain( 'flowchart TD' )
        // > is escaped to &gt; — the edge arrow survives as readable text.
        expect( html ).toContain( 'A --&gt; B' )
    } )


    it( 'HTML-escapes < in the original source (AC-2)', () => {
        const broken = 'M49 -->|Doku-Payload<br/>(Kap. 6)| M52'
        const { html } = MemoView.buildMermaidErrorHtml( { err: new Error( 'x' ), originalText: broken } )

        expect( html ).toContain( '&lt;br/&gt;' )
        expect( html ).not.toContain( '<br/>' )
    } )


    it( 'HTML-escapes & before < and > so entities are not double-broken (AC-2)', () => {
        const { html } = MemoView.buildMermaidErrorHtml( { err: new Error( 'x' ), originalText: 'A & <B>' } )

        expect( html ).toContain( 'A &amp; &lt;B&gt;' )
    } )


    it( 'escapes < and > inside the error message too (AC-2)', () => {
        const { html } = MemoView.buildMermaidErrorHtml( { err: new Error( 'bad token <foo>' ), originalText: 'flowchart TD' } )

        expect( html ).toContain( 'bad token &lt;foo&gt;' )
        expect( html ).not.toContain( '<foo>' )
    } )


    it( 'keeps the special chars ( and { as literal text in the <pre> (AC-2)', () => {
        const broken = 'H[GET /plans/{planId}] --> I[resolve (planId)]'
        const { html } = MemoView.buildMermaidErrorHtml( { err: new Error( 'x' ), originalText: broken } )

        // ( and { are not HTML-special, so they stay verbatim — proving the
        // source is shown to the user rather than swallowed.
        expect( html ).toContain( '{planId}' )
        expect( html ).toContain( '(planId)' )
    } )


    it( 'handles a null originalText without throwing (defensive)', () => {
        const { html } = MemoView.buildMermaidErrorHtml( { err: new Error( 'x' ), originalText: null } )

        expect( html ).toContain( '<pre class="mermaid-error-source"></pre>' )
    } )


    it( 'returns an object with an html property (house rule)', () => {
        const result = MemoView.buildMermaidErrorHtml( { err: new Error( 'x' ), originalText: 'flowchart TD' } )

        expect( typeof result ).toBe( 'object' )
        expect( typeof result.html ).toBe( 'string' )
    } )
} )
