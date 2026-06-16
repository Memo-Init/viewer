import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { readMemoViewSource } from '../helpers/extractFunction.mjs'


// PRD-013 (Memo 016 Kap 9, Katalog F6/F7/F8/E5): A11y semantics + hierarchy landmarks + label fix.
// The page MARKUP lives in MemoView.#buildHtmlPage; the CLIENT JS lives in src/public/app.client.mjs
// (classic <script src>). As in the other PRD source-shape tests (Phase3Politur, BlockViewPRD014)
// this project has no jsdom — so we assert on the emitted source text: landmarks present in the
// markup, the modal dialog/aria-live semantics, the umlaut label, and the converted handlers wired
// via addEventListener (no inline on* left on the mermaid modal).
describe( 'Memo 016 PRD-013 — A11y, Hierarchie, Labels', () => {
    let markup = ''
    let client = ''


    beforeAll( async () => {
        markup = await readMemoViewSource()
        const here = dirname( fileURLToPath( import.meta.url ) )
        const clientPath = join( here, '..', '..', 'src', 'public', 'app.client.mjs' )
        client = await readFile( clientPath, 'utf8' )
    } )


    // ---- F7/F6: landmark + region semantics in the markup. ----
    describe( 'F7/F6 — Landmarks und Regionen im Markup', () => {
        it( 'the content area is a main landmark (role="main")', () => {
            expect( markup.includes( '<div id="main" role="main"' ) ).toBe( true )
        } )

        it( 'the document sidebar is a labelled navigation landmark', () => {
            expect( markup.includes( '<nav id="doc-sidebar" aria-label="Dokumente">' ) ).toBe( true )
        } )

        it( 'the table-of-contents sidebar is a labelled navigation landmark', () => {
            expect( /<nav id="toc-sidebar" aria-label="[^"]+">/.test( markup ) ).toBe( true )
        } )

        it( 'the nav bar carries a navigation role with an accessible name', () => {
            expect( markup.includes( '<div id="nav-bar" role="navigation" aria-label=' ) ).toBe( true )
        } )

        it( 'there is exactly one role="main" landmark', () => {
            const count = markup.split( 'role="main"' ).length - 1
            expect( count ).toBe( 1 )
        } )
    } )


    // ---- F7: dialog semantics on every modal. ----
    describe( 'F7 — Modale als role="dialog" mit aria-modal und Label', () => {
        const modalIds = [
            'mermaid-modal',
            'transcript-modal',
            'plan-modal',
            'requirement-modal',
            'block-modal'
        ]

        modalIds.forEach( ( id ) => {
            it( '#' + id + ' is a labelled modal dialog', () => {
                const open = markup.indexOf( 'id="' + id + '"' )
                expect( open ).toBeGreaterThan( -1 )
                // The dialog/aria-modal/label attributes sit on the SAME opening tag as the id.
                const tag = markup.slice( open, markup.indexOf( '>', open ) )
                expect( tag.includes( 'role="dialog"' ) ).toBe( true )
                expect( tag.includes( 'aria-modal="true"' ) ).toBe( true )
                expect( /aria-label(ledby)?="[^"]+"/.test( tag ) ).toBe( true )
            } )
        } )
    } )


    // ---- F7: live region for the connection status. ----
    describe( 'F7 — Status-Region mit aria-live', () => {
        it( '#status is a polite live region', () => {
            const open = markup.indexOf( 'id="status"' )
            expect( open ).toBeGreaterThan( -1 )
            const tag = markup.slice( open, markup.indexOf( '>', open ) )
            expect( tag.includes( 'aria-live="polite"' ) ).toBe( true )
            expect( tag.includes( 'role="status"' ) ).toBe( true )
        } )
    } )


    // ---- E5: ASCII "Bloecke" -> umlaut "Blöcke". ----
    describe( 'E5 — Label "Blöcke" mit Umlaut', () => {
        it( 'the umlaut label is present in the client script', () => {
            expect( client.includes( 'Blöcke' ) ).toBe( true )
        } )

        it( 'no ASCII "Bloecke" label remains in the markup or client script', () => {
            expect( markup.includes( 'Bloecke' ) ).toBe( false )
            expect( client.includes( 'Bloecke' ) ).toBe( false )
        } )

        it( 'the block-view toggle button carries the umlaut label and title', () => {
            expect( client.includes( '>Blöcke</button>' ) ).toBe( true )
            expect( client.includes( 'title="Blöcke anzeigen"' ) ).toBe( true )
        } )
    } )


    // ---- F8: inline on* handlers of the mermaid modal converted to addEventListener. ----
    describe( 'F8 — Inline on*-Handler des Mermaid-Modals via addEventListener', () => {
        it( 'the mermaid modal markup no longer carries inline on* handlers', () => {
            const open = markup.indexOf( 'id="mermaid-modal"' )
            const close = markup.indexOf( 'id="mermaid-modal-svg"', open )
            const block = markup.slice( open, close )
            expect( /onclick=/.test( block ) ).toBe( false )
        } )

        it( 'the overlay close is wired via addEventListener', () => {
            expect( client.includes( "mermaidModal.addEventListener( 'click', function() { closeMermaidModal() } )" ) ).toBe( true )
        } )

        it( 'the inner box stops propagation via addEventListener', () => {
            expect( client.includes( "mermaidModalInner.addEventListener( 'click', function( e ) { e.stopPropagation() } )" ) ).toBe( true )
        } )

        it( 'the close button is wired via addEventListener', () => {
            expect( client.includes( "mermaidModalClose.addEventListener( 'click', function() { closeMermaidModal() } )" ) ).toBe( true )
        } )
    } )
} )
