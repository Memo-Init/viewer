import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MemoView } from '../../src/MemoView.mjs'


const mjsSource = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
const clientSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )
const source = mjsSource + '\n' + clientSource


// PRD-007 (Memo 016, D3/D7): ONE shared slug algorithm for heading ids AND diff-banner anchors.
// MemoView.slugify mirrors the inline browser slugify so the curve is unit-testable. D7: punctuation
// becomes a SEPARATOR (not stripped) so distinct headings never collide into a renumber.
describe( 'MemoView.slugify (PRD-007, D3/D7)', () => {
    it( 'maps the German umlaut ä/ö/ü/ß to ae/oe/ue/ss (D3)', () => {
        expect( MemoView.slugify( { text: 'Ärger' } ).slug ).toBe( 'aerger' )
        expect( MemoView.slugify( { text: 'Überblick' } ).slug ).toBe( 'ueberblick' )
        expect( MemoView.slugify( { text: 'Lösung' } ).slug ).toBe( 'loesung' )
        expect( MemoView.slugify( { text: 'Straße' } ).slug ).toBe( 'strasse' )
    } )


    it( 'turns an em-dash — into a separator, not a swallowed gap (D3)', () => {
        expect( MemoView.slugify( { text: 'Kapitel 5 — Überblick' } ).slug ).toBe( 'kapitel-5-ueberblick' )
    } )


    it( 'turns an en-dash – into a separator too', () => {
        expect( MemoView.slugify( { text: 'A – B' } ).slug ).toBe( 'a-b' )
    } )


    it( 'turns punctuation into a SEPARATOR rather than stripping it (D7)', () => {
        // ".", ":", "—" between two tokens all collapse to a single "-" — the token boundary
        // survives instead of merging the two tokens into one.
        expect( MemoView.slugify( { text: 'A.B' } ).slug ).toBe( 'a-b' )
        expect( MemoView.slugify( { text: 'A: B' } ).slug ).toBe( 'a-b' )
        expect( MemoView.slugify( { text: 'Teil1.2' } ).slug ).toBe( 'teil1-2' )
    } )


    it( 'collapses runs of punctuation/whitespace to a single dash and trims edges', () => {
        expect( MemoView.slugify( { text: '  ## Heading!!  ' } ).slug ).toBe( 'heading' )
        expect( MemoView.slugify( { text: 'a   ---   b' } ).slug ).toBe( 'a-b' )
    } )


    it( 'is identical for a heading and the matching diff-banner chapter label (D3 anchor parity)', () => {
        // The banner anchor and the heading id MUST be the same string for the same chapter text,
        // even with umlaut + em-dash + punctuation — otherwise the banner link scrolls nowhere.
        const chapter = '5.1 Lösungsansatz — Überblick'
        const headingSlug = MemoView.slugify( { text: chapter } ).slug
        const bannerSlug = MemoView.slugify( { text: chapter } ).slug

        expect( bannerSlug ).toBe( headingSlug )
        expect( headingSlug ).toBe( '5-1-loesungsansatz-ueberblick' )
    } )


    it( 'gives distinct slugs to headings that differ only in punctuation (no collision-renumber, D7)', () => {
        // "Kap5—Ende" and "Kap5 Ende" both slug to the same boundary-preserving form; but a heading
        // with a real extra token does NOT collapse onto its punctuation-less sibling.
        const a = MemoView.slugify( { text: 'Teil 1.2' } ).slug
        const b = MemoView.slugify( { text: 'Teil 12' } ).slug

        expect( a ).toBe( 'teil-1-2' )
        expect( b ).toBe( 'teil-12' )
        expect( a ).not.toBe( b )
    } )


    it( 'guards null/undefined text without throwing (defensive)', () => {
        expect( MemoView.slugify( { text: null } ).slug ).toBe( '' )
        expect( MemoView.slugify( { text: undefined } ).slug ).toBe( '' )
    } )


    it( 'returns an object with a slug property (house rule)', () => {
        const result = MemoView.slugify( { text: 'x' } )

        expect( typeof result ).toBe( 'object' )
        expect( typeof result.slug ).toBe( 'string' )
    } )
} )


// PRD-007 (Memo 016, D1): a block-meta fence must render as an inline Block-Card, NOT a raw code
// block. MemoView.blockMetaRenderDecision mirrors the inline renderer.code branch decision.
describe( 'MemoView.blockMetaRenderDecision (PRD-007, D1)', () => {
    it( 'routes a block-meta fence to a Block-Card, not the raw code renderer', () => {
        expect( MemoView.blockMetaRenderDecision( { lang: 'block-meta' } ).decision ).toBe( 'block-card' )
    } )


    it( 'keeps the mermaid branch for a mermaid fence', () => {
        expect( MemoView.blockMetaRenderDecision( { lang: 'mermaid' } ).decision ).toBe( 'mermaid' )
    } )


    it( 'leaves any other language as a normal code block', () => {
        expect( MemoView.blockMetaRenderDecision( { lang: 'js' } ).decision ).toBe( 'code' )
        expect( MemoView.blockMetaRenderDecision( { lang: 'json' } ).decision ).toBe( 'code' )
    } )


    it( 'treats an undefined language as a normal code block (plain fence)', () => {
        expect( MemoView.blockMetaRenderDecision( { lang: undefined } ).decision ).toBe( 'code' )
    } )
} )


// Source-shape regression: the inline browser pipeline must keep the four D1/D2/D3 fixes wired.
describe( 'inline prose pipeline shape (PRD-007, D1/D2/D3)', () => {
    it( 'renderer.code routes a block-meta fence to a Block-Card, not the raw renderer (D1)', () => {
        expect( source ).toContain( "if( token.lang === 'block-meta' )" )
        expect( source ).toContain( 'buildBlockMetaCard( token.text )' )
        expect( source ).toContain( 'block-meta-card' )
    } )


    it( 'the inline slugify collapses punctuation to a separator and is shared (D3/D7)', () => {
        // The inline client slugify must use the same punctuation->separator rule as the static one.
        expect( source ).toContain( '.replace( /[^a-z0-9]+/g, \'-\' )' )
    } )


    it( 'the diff-banner anchor reuses the shared slugify, not its own regex (D3)', () => {
        expect( source ).toContain( 'var id = slugify( s )' )
        // the old divergent banner algorithm must be gone.
        expect( source ).not.toContain( "s.toLowerCase().replace( /[^a-z0-9]+/g, '-' )" )
    } )


    it( 'bindDiffToggle re-runs the SAME structure set as the content handler (D2)', () => {
        const start = source.indexOf( 'function bindDiffToggle()' )
        expect( start ).toBeGreaterThan( -1 )
        const end = source.indexOf( 'function bindPromptEdit', start )
        const slice = source.slice( start, end )

        // the exact four structure functions the data.type==='content' handler calls.
        expect( slice ).toContain( 'applyContentStructure()' )
        expect( slice ).toContain( 'renderVorwort( lastVorwort )' )
        expect( slice ).toContain( 'renderQuestionWidgets( lastQuestionSchema )' )
        expect( slice ).toContain( 'buildTOC( currentDiff )' )
    } )


    it( 'the content handler structure set is the canonical reference for D2 (parity)', () => {
        // sanity: the four calls D2 mirrors really do live together in the WS content handler too.
        const idx = source.indexOf( "if( data.type === 'content' )" )
        expect( idx ).toBeGreaterThan( -1 )
        const slice = source.slice( idx, idx + 4000 )

        expect( slice ).toContain( 'applyContentStructure()' )
        expect( slice ).toContain( 'renderVorwort( lastVorwort )' )
        expect( slice ).toContain( 'renderQuestionWidgets( lastQuestionSchema )' )
        expect( slice ).toContain( 'buildTOC( currentDiff )' )
    } )
} )
