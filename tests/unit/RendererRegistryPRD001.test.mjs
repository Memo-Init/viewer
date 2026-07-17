import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'


// Memo 020 / PRD-001 (Phase 1, Kap 4): the formerly 5 hardcoded 'mermaid' sites (1 renderer.code
// branch + 4 render callsites: prose, diff-new, diff-prev, ws-update) are unified into ONE renderer
// registry { selector, render(spec, el) } + ONE renderAllDiagrams() pass. This is a pure refactor:
// Mermaid behaviour (securityLevel strict, buildMermaidErrorHtml fallback) is unchanged, and every
// view renders through the SAME registry pass — so the next renderer is a registry entry, not a 5th
// hardcoded callsite. This file is the Non-Regression-Gate for that refactor.
const clientSource = readFileSync(
    fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ),
    'utf8'
)


// Lift `function renderAllDiagrams() {…}` out of the global browser script and run it against an
// INJECTED document + registry. Proves the pass is registry-driven (iterates every entry) rather
// than hardcoded to '.mermaid', so a second renderer added in Phase 2 is covered automatically.
function buildRenderAllDiagrams( { document, diagramRegistry } ) {
    const marker = 'function renderAllDiagrams('
    const start = clientSource.indexOf( marker )
    if( start === -1 ) { throw new Error( 'renderAllDiagrams not found' ) }
    const braceStart = clientSource.indexOf( '{', start )
    let depth = 0
    let idx = braceStart
    while( idx < clientSource.length ) {
        const ch = clientSource[ idx ]
        if( ch === '{' ) { depth += 1 }
        else if( ch === '}' ) {
            depth -= 1
            if( depth === 0 ) { break }
        }
        idx += 1
    }
    const body = clientSource.slice( start, idx + 1 )
    const factory = new Function( 'document', 'diagramRegistry', body + '\nreturn renderAllDiagrams' )

    return factory( document, diagramRegistry )
}


describe( 'PRD-001 — renderer registry replaces the 5 hardcoded mermaid sites', () => {
    it( 'defines a diagramRegistry with a mermaid entry keyed by selector .mermaid', () => {
        expect( clientSource ).toContain( 'var diagramRegistry = {' )
        expect( clientSource ).toContain( 'mermaid: {' )
        expect( clientSource ).toContain( "selector: '.mermaid'" )
    } )

    it( 'renderer.code dispatches via the registry (not a hardcoded lang === mermaid branch)', () => {
        expect( clientSource ).toContain( 'if( diagramRegistry[ token.lang ] ) {' )
        // PRD-003 (Memo 076 WI-031): the raw source is now ESCAPED into data-src with an EMPTY body,
        // not interpolated unescaped into innerHTML (which corrupted <br/>/entities/[[slug]]).
        expect( clientSource ).toContain( "return '<div class=\"' + token.lang + '\" data-src=\"' + escapeHtml( token.text ) + '\"></div>'" )
        // the old hardcoded mermaid branch must be gone
        expect( clientSource ).not.toContain( "if( token.lang === 'mermaid' ) {" )
    } )

    it( 'keeps mermaid.render and buildMermaidErrorHtml in exactly ONE place (the registry entry)', () => {
        const renders = clientSource.split( 'mermaid.render(' ).length - 1
        expect( renders ).toBe( 1 )
    } )

    it( 'preserves the mermaid security posture (strict, never loose)', () => {
        expect( clientSource ).toContain( "securityLevel: 'strict'" )
        expect( clientSource ).not.toContain( "securityLevel: 'loose'" )
    } )

    it( 'routes all four view render points through the single renderAllDiagrams() pass', () => {
        const calls = clientSource.split( 'renderAllDiagrams()' ).length - 1
        // 4 callsites (prose, diff-new, diff-view, ws-update) + 1 definition line `renderAllDiagrams() {`
        expect( calls ).toBeGreaterThanOrEqual( 5 )
        // the old per-callsite render loop must be gone
        expect( clientSource ).not.toContain( "document.querySelectorAll( '.mermaid' ).forEach" )
    } )

    it( 'renderAllDiagrams iterates EVERY registry entry and renders each matched element', () => {
        const rendered = []
        // PRD-003 (Memo 076 WI-030/WI-031/WI-040): the source is read from data-src (via getAttribute),
        // NOT textContent, and a per-element dataset.renderedSrc guard makes the pass idempotent.
        const makeEl = ( id, src ) => ( {
            id: id,
            dataset: {},
            getAttribute: function( name ) { return name === 'data-src' ? src : null },
            textContent: src
        } )
        const elsBySelector = {
            '.mermaid': [ makeEl( 'm1', 'graph TD; A-->B' ) ],
            '.vega-lite': [ makeEl( 'v1', '{"mark":"bar"}' ), makeEl( 'v2', '{}' ) ]
        }
        const fakeDocument = {
            querySelectorAll: function( selector ) { return elsBySelector[ selector ] || [] }
        }
        const fakeRegistry = {
            mermaid: {
                selector: '.mermaid',
                render: function( spec, el ) { rendered.push( { type: 'mermaid', spec, id: el.id } ) }
            },
            'vega-lite': {
                selector: '.vega-lite',
                render: function( spec, el ) { rendered.push( { type: 'vega-lite', spec, id: el.id } ) }
            }
        }

        const renderAllDiagrams = buildRenderAllDiagrams( { document: fakeDocument, diagramRegistry: fakeRegistry } )
        renderAllDiagrams()

        expect( rendered ).toHaveLength( 3 )
        expect( rendered.filter( ( r ) => r.type === 'mermaid' ) ).toHaveLength( 1 )
        expect( rendered.filter( ( r ) => r.type === 'vega-lite' ) ).toHaveLength( 2 )
        // each element's data-src source is passed as the spec
        expect( rendered[ 0 ].spec ).toBe( 'graph TD; A-->B' )

        // PRD-003 (Memo 076 WI-030/WI-040): a second pass over the SAME elements (unchanged data-src)
        // is a no-op via the renderedSrc guard — no double/duplicate render, no "No diagram type detected".
        renderAllDiagrams()
        expect( rendered ).toHaveLength( 3 )
    } )
} )
