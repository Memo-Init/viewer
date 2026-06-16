import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-006 (Memo 016 Kap 5, C1-C9): ONE level-aware section helper resolves the disagreement
// between the DOM layer and DocumentRegistry.#extractSection (H2-exact, H2-stop) about what
// "Offene Fragen" is. MemoView.questionsSection mirrors that notion for the DOM — it picks the
// canonical anchor by an EXACT H2 text match (never an H3/H4 chapter copy) and computes the
// level-aware collapse range (up to the next heading of level <= the start level). The headings
// argument is an ordered list of { level, text }; indices are into that same list.
describe( 'MemoView.questionsSection — anchor resolution (PRD-006 C2/C3)', () => {
    it( 'anchors on the EXACT H2 "Offene Fragen", not the first h1-h4 match', () => {
        const headings = [
            { level: 1, text: 'Memo 015' },
            { level: 2, text: 'Kapitel 5' },
            { level: 3, text: 'Offene Fragen' },
            { level: 2, text: 'Offene Fragen' },
            { level: 3, text: 'F1 — Was tun?' }
        ]

        const { anchorIndex } = MemoView.questionsSection( { headings } )

        // The chapter-5 H3 (index 2) appears FIRST, but the canonical anchor is the real H2.
        expect( anchorIndex ).toBe( 3 )
    } )


    it( 'never anchors on an H3/H4 even when there is no H2 question section', () => {
        const headings = [
            { level: 1, text: 'Memo' },
            { level: 3, text: 'Offene Fragen' }
        ]

        const { anchorIndex } = MemoView.questionsSection( { headings } )

        expect( anchorIndex ).toBe( -1 )
    } )


    it( 'matches "Offene Fragen" case-insensitively at H2', () => {
        const headings = [
            { level: 1, text: 'Memo' },
            { level: 2, text: 'OFFENE FRAGEN' }
        ]

        const { anchorIndex } = MemoView.questionsSection( { headings } )

        expect( anchorIndex ).toBe( 1 )
    } )


    it( 'ignores "Beantwortete Fragen" for the open-questions anchor', () => {
        const headings = [
            { level: 2, text: 'Beantwortete Fragen' },
            { level: 2, text: 'Offene Fragen' }
        ]

        const { anchorIndex } = MemoView.questionsSection( { headings } )

        expect( anchorIndex ).toBe( 1 )
    } )


    it( 'guards a non-array headings argument', () => {
        const { anchorIndex, hiddenSections } = MemoView.questionsSection( { headings: undefined } )

        expect( anchorIndex ).toBe( -1 )
        expect( hiddenSections ).toEqual( [] )
    } )
} )


describe( 'MemoView.questionsSection — level-aware collapse (PRD-006 C1/C4/C9)', () => {
    it( 'an H2 section collapses until the next H2 (the #extractSection rule)', () => {
        const headings = [
            { level: 2, text: 'Offene Fragen' },
            { level: 3, text: 'F1' },
            { level: 3, text: 'F2' },
            { level: 2, text: 'Naechstes Kapitel' }
        ]

        const { collapseRangeFrom } = MemoView.questionsSection( { headings } )
        const { startIndex, endIndex } = collapseRangeFrom( 0 )

        expect( startIndex ).toBe( 1 )
        // F1 + F2 belong to the body; collapse stops AT the next H2 (index 3).
        expect( endIndex ).toBe( 3 )
    } )


    it( 'an H3 "### Offene Fragen" copy collapses until the next H2 OR H3 (C1)', () => {
        const headings = [
            { level: 2, text: 'Kapitel 5' },
            { level: 3, text: 'Offene Fragen' },
            { level: 4, text: 'Detail' },
            { level: 3, text: 'Andere Unter-Sektion' },
            { level: 2, text: 'Kapitel 6' }
        ]

        const { collapseRangeFrom } = MemoView.questionsSection( { headings } )
        const { startIndex, endIndex } = collapseRangeFrom( 1 )

        expect( startIndex ).toBe( 2 )
        // The H4 detail belongs to the H3 body; collapse stops at the next H3 (index 3),
        // NOT only at an H2 — level-aware, not an H2-only stop (C4).
        expect( endIndex ).toBe( 3 )
    } )


    it( 'collapses to the end of the document when no stop heading follows', () => {
        const headings = [
            { level: 2, text: 'Offene Fragen' },
            { level: 3, text: 'F1' },
            { level: 4, text: 'note' }
        ]

        const { collapseRangeFrom } = MemoView.questionsSection( { headings } )
        const { startIndex, endIndex } = collapseRangeFrom( 0 )

        expect( startIndex ).toBe( 1 )
        expect( endIndex ).toBe( 3 )
    } )


    it( 'reports a hidden section for BOTH the H3 chapter copy and the real H2 (C1/C9)', () => {
        const headings = [
            { level: 2, text: 'Kapitel 5' },
            { level: 3, text: 'Offene Fragen' },
            { level: 3, text: 'F1 (F9) im Fliesstext' },
            { level: 2, text: 'Offene Fragen' },
            { level: 3, text: 'F1 — Was tun?' }
        ]

        const { hiddenSections } = MemoView.questionsSection( { headings } )

        // Two question-section headings exist (the H3 copy at index 1 + the real H2 at index 3),
        // so both get a collapse range — the duplicate H3 copy is no longer left visible.
        expect( hiddenSections.length ).toBe( 2 )
    } )


    it( 'does not treat a freetext "(F9)" line as a section heading (C9)', () => {
        // Freetext mentions are not headings; only headings whose TEXT is a question section
        // produce a hidden range. A plain paragraph never enters the headings list.
        const headings = [
            { level: 2, text: 'Offene Fragen' },
            { level: 3, text: 'F1 — Frage' }
        ]

        const { hiddenSections } = MemoView.questionsSection( { headings } )

        expect( hiddenSections.length ).toBe( 1 )
        expect( hiddenSections[ 0 ] ).toEqual( { startIndex: 1, endIndex: 2 } )
    } )
} )


// Source-shape regression: the inline browser helpers must keep mirroring the static rules —
// level-aware sibling collapse (C4), the exact-H2 anchor scan (C2), the h2,h3,h4 hide scan (C1),
// the source-position Vorwort placeholder (C5/C6), and the canonical #offene-fragen scroll (C8).
describe( 'inline section-helper shape (PRD-006 C1-C9)', () => {
    const clientPath = fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) )
    const source = readFileSync( clientPath, 'utf8' )


    it( 'walks siblings level-aware (lvl <= startLevel), not just an H2 stop (C4)', () => {
        expect( source ).toContain( 'function hiddenSiblingsAfter( heading )' )
        expect( source ).toContain( 'var startLevel = headingLevel( heading )' )
        expect( source ).toContain( 'if( lvl > 0 && lvl <= startLevel ) { return }' )
        // The old h2-only stop must be gone from hiddenSiblingsAfter.
        expect( source ).not.toContain( "if( !node || node.tagName === 'H2' ) { return }" )
    } )


    it( 'hides raw question bodies across h2,h3,h4 — the H3 copy too (C1/C9)', () => {
        const fn = source.slice( source.indexOf( 'function hideRawQuestionBodies()' ) )
            .slice( 0, 700 )

        expect( fn ).toContain( "contentEl.querySelectorAll( 'h2, h3, h4' )" )
    } )


    it( 'anchors applyContentStructure on the EXACT H2 (C2/C3)', () => {
        const fn = source.slice( source.indexOf( 'function applyContentStructure()' ) )
            .slice( 0, 1200 )

        expect( fn ).toContain( "h.tagName === 'H2' && /offene\\s+fragen/i.test" )
    } )


    it( 'places the Vorwort placeholder at its source position + creates it defensively (C5/C6)', () => {
        expect( source ).toContain( 'rawVorwortHeading.parentNode.insertBefore( vorwort, rawVorwortHeading )' )
        // The unconditional top-forced insertion is gone (now a fallback only).
        const structFn = source.slice( source.indexOf( 'function applyContentStructure()' ) )
            .slice( 0, 4500 )

        expect( structFn ).toContain( 'if( rawVorwortHeading && rawVorwortHeading.parentNode )' )
    } )


    it( 'scrolls to the canonical #offene-fragen anchor (C8)', () => {
        const fn = source.slice( source.indexOf( 'function scrollToOpenQuestions()' ) )
            .slice( 0, 700 )

        expect( fn ).toContain( "document.getElementById( 'offene-fragen' )" )
    } )


    it( 'exposes a headingLevel + isExactSectionH2 helper mirroring the static rules', () => {
        expect( source ).toContain( 'function headingLevel( node )' )
        expect( source ).toContain( 'function isExactSectionH2( node )' )
    } )
} )


// The static helper + the inline mirror agree on the same anchor decision for a Memo-015-like
// heading shape (chapter H3 "Offene Fragen" copy precedes the real H2 section).
describe( 'static vs inline agreement (PRD-006)', () => {
    const clientPath = fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) )
    const emittedScript = readFileSync( clientPath, 'utf8' )


    it( 'emits a syntactically valid inline browser script after the C-fixes', () => {
        let message = ''
        try {
            new vm.Script( emittedScript )
        } catch( err ) {
            message = err.message
        }
        expect( message ).toBe( '' )
    } )
} )
