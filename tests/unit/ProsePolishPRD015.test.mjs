import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MemoView } from '../../src/MemoView.mjs'


// The client prose pipeline lives in app.client.mjs (classic <script src>, global scope). The
// static MemoView.xxx mirrors are unit-tested directly; the inline wiring is asserted by shape.
const mjsSource = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
const clientSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )
const cssSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.css', import.meta.url ) ), 'utf8' )
const source = mjsSource + '\n' + clientSource


// PRD-015 (Memo 016, D5): the diff layer must compare server `changedSections` (raw strings)
// against rendered heading text via a SHARED slugify so Umlaut/Em-dash/punctuation never break
// the match. MemoView.changedSectionMatch is the pure mirror of that comparison.
describe( 'MemoView.changedSectionMatch (PRD-015, D5)', () => {
    it( 'matches a raw changed chapter against its rendered heading after slug normalisation', () => {
        const out = MemoView.changedSectionMatch( {
            changedSections: [ 'Kapitel 5 — Überblick' ],
            headingText: 'Kapitel 5 — Überblick'
        } )

        expect( out.matched ).toBe( true )
    } )


    it( 'matches across umlaut/punctuation drift (raw string vs differently-spaced rendered text)', () => {
        // both sides slugify to "kapitel-5-ueberblick" — raw-vs-rendered equality would have failed.
        const out = MemoView.changedSectionMatch( {
            changedSections: [ 'Kapitel 5 — Überblick' ],
            headingText: 'Kapitel 5  —  Überblick'
        } )

        expect( out.matched ).toBe( true )
    } )


    it( 'does not match an unrelated heading', () => {
        const out = MemoView.changedSectionMatch( {
            changedSections: [ 'Andere Sektion' ],
            headingText: 'Kapitel 5'
        } )

        expect( out.matched ).toBe( false )
    } )


    it( 'is empty-set safe (no changedSections -> no match, no throw)', () => {
        expect( MemoView.changedSectionMatch( { changedSections: undefined, headingText: 'X' } ).matched ).toBe( false )
        expect( MemoView.changedSectionMatch( { changedSections: [], headingText: 'X' } ).matched ).toBe( false )
    } )
} )


// PRD-015 (Memo 016, D6): a block's three structured H3 body headings (### Problem-Beschreibung /
// Loesungsansatz / Offene Fragen below a block-meta fence) are detected at level 3 + exact text and
// hidden, consistent with the Kap-3/5 collapse logic. MemoView.isBlockBodyHeading is the mirror.
describe( 'MemoView.isBlockBodyHeading (PRD-015, D6)', () => {
    it( 'detects the three block-body section headings at h3', () => {
        expect( MemoView.isBlockBodyHeading( { level: 3, text: 'Problem-Beschreibung' } ).isBlockBody ).toBe( true )
        expect( MemoView.isBlockBodyHeading( { level: 3, text: 'Loesungsansatz' } ).isBlockBody ).toBe( true )
        expect( MemoView.isBlockBodyHeading( { level: 3, text: 'Offene Fragen' } ).isBlockBody ).toBe( true )
    } )


    it( 'is case/space tolerant on the label', () => {
        expect( MemoView.isBlockBodyHeading( { level: 3, text: '  PROBLEM-BESCHREIBUNG  ' } ).isBlockBody ).toBe( true )
    } )


    it( 'only fires at h3 — a real H2 chapter of the same name is NOT a block body (detect only h2 boundary)', () => {
        expect( MemoView.isBlockBodyHeading( { level: 2, text: 'Problem-Beschreibung' } ).isBlockBody ).toBe( false )
        expect( MemoView.isBlockBodyHeading( { level: 2, text: 'Offene Fragen' } ).isBlockBody ).toBe( false )
    } )


    it( 'does not fire on an ordinary prose H3', () => {
        expect( MemoView.isBlockBodyHeading( { level: 3, text: 'Architektur' } ).isBlockBody ).toBe( false )
    } )


    it( 'guards null/undefined text (defensive)', () => {
        expect( MemoView.isBlockBodyHeading( { level: 3, text: null } ).isBlockBody ).toBe( false )
        expect( MemoView.isBlockBodyHeading( { level: 3, text: undefined } ).isBlockBody ).toBe( false )
    } )
} )


// PRD-015 (Memo 016, D11): the TOC indexes BOTH h2 AND h3 (was h2-only) and skips collapsed
// headings (block-body / raw-question / vorwort) so a hidden heading never pollutes the list.
// MemoView.tocEntries is the pure mirror of the inline buildTOC selection.
describe( 'MemoView.tocEntries (PRD-015, D11)', () => {
    it( 'includes h2 AND h3 (no longer h2-only)', () => {
        const out = MemoView.tocEntries( {
            headings: [
                { level: 1, text: 'Title' },
                { level: 2, text: 'A' },
                { level: 3, text: 'A.1' },
                { level: 2, text: 'B' }
            ]
        } )

        expect( out.entries.map( ( e ) => e.text ) ).toEqual( [ 'A', 'A.1', 'B' ] )
    } )


    it( 'tags each entry with its level class for indentation', () => {
        const out = MemoView.tocEntries( {
            headings: [ { level: 2, text: 'A' }, { level: 3, text: 'A.1' } ]
        } )

        expect( out.entries[ 0 ].levelClass ).toBe( 'toc-h2' )
        expect( out.entries[ 1 ].levelClass ).toBe( 'toc-h3' )
    } )


    it( 'skips hidden (collapsed) headings so block-body H3s never pollute the TOC (D6+D11)', () => {
        const out = MemoView.tocEntries( {
            headings: [
                { level: 2, text: 'A' },
                { level: 3, text: 'A.1' },
                { level: 3, text: 'Problem-Beschreibung', hidden: true },
                { level: 2, text: 'B' }
            ]
        } )

        expect( out.entries.map( ( e ) => e.text ) ).toEqual( [ 'A', 'A.1', 'B' ] )
    } )


    it( 'ignores h1/h4 (only h2,h3 are TOC rows)', () => {
        const out = MemoView.tocEntries( {
            headings: [ { level: 1, text: 'T' }, { level: 4, text: 'deep' }, { level: 2, text: 'A' } ]
        } )

        expect( out.entries.map( ( e ) => e.text ) ).toEqual( [ 'A' ] )
    } )
} )


// Source-shape regression: the inline browser pipeline must keep the seven D-fixes wired.
describe( 'inline prose pipeline shape (PRD-015, D4/D5/D6/D8/D9/D10/D11)', () => {
    it( 'D4: the diff-banner anchor null-guards the target before scrollIntoView', () => {
        // the onclick must look up the node and only scroll when it exists (no throw on a null node).
        // (the source escapes the inner apostrophes as \', so match the literal source text.)
        expect( clientSource ).toContain( 'var t=document.getElementById(' )
        expect( clientSource ).toContain( 'if(t){t.scrollIntoView({behavior:\\\'smooth\\\'})}' )
        // the old unguarded direct-call form (getElementById(...).scrollIntoView, no guard) is gone.
        expect( clientSource ).not.toContain( '\\\').scrollIntoView({behavior:\\\'smooth\\\'})">' )
    } )


    it( 'D5: changedSections are slugify-normalised on both sides (set build + gate + TOC)', () => {
        expect( clientSource ).toContain( 'changedSectionSet.add( slugify( s ) )' )
        expect( clientSource ).toContain( '!changedSectionSet.has( slugify( currentChapter ) )' )
        expect( clientSource ).toContain( 'changedSet.add( slugify( s ) )' )
        expect( clientSource ).toContain( 'changedSet.has( slugify( text ) )' )
    } )


    it( 'D6: a hideBlockBodySections pass runs from applyContentStructure and tags block-body-hidden', () => {
        expect( clientSource ).toContain( 'function hideBlockBodySections()' )
        expect( clientSource ).toContain( 'hideBlockBodySections()' )
        expect( clientSource ).toContain( 'block-body-hidden' )
        expect( clientSource ).toContain( 'function isBlockBodyHeading(' )
        // it reuses the level-aware Kap-3/5 collapse helper, not its own walker.
        expect( clientSource ).toContain( 'hiddenSiblingsAfter( node ).forEach' )
    } )


    it( 'D6: block-body H3 detection only fires at h3 and uses the BODY_SECTIONS labels', () => {
        expect( clientSource ).toContain( 'headingLevel( node ) !== 3' )
        expect( clientSource ).toContain( 'problem-beschreibung' )
        expect( clientSource ).toContain( 'loesungsansatz' )
        // the card-body walk stops at the next H2 boundary (detect only h2 there).
        expect( clientSource ).toContain( 'headingLevel( node ) === 2' )
    } )


    it( 'D8: the previous-content render isolates slugCounts (snapshot/restore around it)', () => {
        const start = clientSource.indexOf( 'if( diff.previousContent )' )
        expect( start ).toBeGreaterThan( -1 )
        const slice = clientSource.slice( start, start + 1200 )

        // snapshot the live map, clear, render previous, then restore -> live anchors untouched.
        expect( slice ).toContain( 'var liveSlugCounts = new Map( slugCounts )' )
        expect( slice ).toContain( 'slugCounts.clear()' )
        expect( slice ).toContain( 'liveSlugCounts.forEach(' )
    } )


    it( 'D9: marked is configured with explicit gfm:true', () => {
        expect( clientSource ).toContain( 'marked.setOptions( { renderer, gfm: true, breaks: false } )' )
    } )


    it( 'D10: mermaid is initialised with securityLevel strict, not loose', () => {
        expect( clientSource ).toContain( "securityLevel: 'strict'" )
        expect( clientSource ).not.toContain( "securityLevel: 'loose'" )
    } )


    it( 'D10: banner labels built from content are HTML-escaped', () => {
        expect( clientSource ).toContain( 'function escapeHtml(' )
        // the changed-chapter label and skipped-update names go through escapeHtml.
        expect( clientSource ).toContain( 'escapeHtml( s )' )
        expect( clientSource ).toContain( 'escapeHtml( u )' )
        // the old raw-interpolated label form must be gone.
        expect( clientSource ).not.toContain( '\'\'\' + s + \'</a>\'' )
    } )


    it( 'D11: buildTOC selects h2,h3 and is re-run after every re-render path', () => {
        expect( clientSource ).toContain( "contentEl.querySelectorAll( 'h2, h3' )" )
        // re-run on the WS content handler, the diff-toggle (D2), and the back-to-prose path.
        const occurrences = clientSource.split( 'buildTOC( currentDiff )' ).length - 1
        expect( occurrences ).toBeGreaterThanOrEqual( 3 )
    } )


    it( 'D11: buildTOC skips collapsed (block-body / raw-question) headings', () => {
        const start = clientSource.indexOf( 'function buildTOC(' )
        const end = clientSource.indexOf( 'function updateActiveTOC(', start )
        const slice = clientSource.slice( start, end )

        expect( slice ).toContain( "heading.classList.contains( 'block-body-hidden' )" )
        expect( slice ).toContain( "heading.classList.contains( 'raw-question-hidden' )" )
    } )
} )


// CSS shape: the two new view rules must exist (block-body hidden + h3 TOC indent + tables).
describe( 'prose-polish CSS (PRD-015, D6/D9/D11)', () => {
    it( 'D6: .block-body-hidden collapses out of the prose', () => {
        expect( cssSource ).toContain( '.block-body-hidden { display: none; }' )
    } )


    it( 'D11: h3 TOC entries are indented under their h2', () => {
        expect( cssSource ).toContain( 'li.toc-h3' )
    } )


    it( 'D9: table CSS exists so gfm tables render (th, td borders)', () => {
        expect( cssSource ).toContain( 'th, td {' )
        expect( cssSource ).toContain( 'border-collapse: collapse' )
    } )
} )
