import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { readEmittedScript, extractFunctionSources, sliceDeclaration } from '../helpers/extractFunction.mjs'
import { makeNode, makeRoot, makeDocument } from '../helpers/domSurrogate.mjs'
import { BlockSections } from '../../src/BlockSections.mjs'


// Memo 081, PRD-43 (WI-113 + WI-114, T075/T076, REV-16:4107-4141).
//
// The subject is a NUMBER THE RENDERER COMPUTES ITSELF, and the memo justifies it with the sentence
// that a typed figure "is a claim about the content from the next edit onwards that nobody maintains".
// A suite that asserted the figure against a second typed constant would be exactly that claim one
// level up, so every count below is built from a fixture whose units are visible in the fixture itself.
//
// EVERY CASE THAT ASSERTS A ZERO OR AN ABSENCE MEASURES THE OPPOSITE FROM THE SAME APPARATUS. A vacuum
// check that never had anything to find is indistinguishable from a broken one, and this file is the
// place that difference has to be made.
//
// No browser and no jsdom (M11): the real browser functions are lifted out of the EMITTED script with
// extractFunction and driven against the shared DOM surrogate. What runs here is the shipped code.


const HERE = dirname( fileURLToPath( import.meta.url ) )
const CLIENT_PATH = resolve( HERE, '..', '..', 'src', 'public', 'app.client.mjs' )
const CSS_PATH = resolve( HERE, '..', '..', 'src', 'public', 'app.css' )


function heading( level, text ) {
    return makeNode( 'H' + level, text )
}


function paragraph( text ) {
    return makeNode( 'P', text )
}


function bulletList( items ) {
    const list = makeNode( 'UL' )
    items.forEach( ( text ) => list.appendChild( makeNode( 'LI', text ) ) )

    return list
}


// A rendered markdown table: header row in <thead>, data rows in <tbody>. The distinction is not
// decoration — the counting rule says DATA rows, and a header row that counted as a finding would add
// one phantom unit to every single Belege section in the corpus.
function table( headers, rows ) {
    const element = makeNode( 'TABLE' )
    const head = makeNode( 'THEAD' )
    const headRow = makeNode( 'TR' )
    headers.forEach( ( text ) => headRow.appendChild( makeNode( 'TH', text ) ) )
    head.appendChild( headRow )

    const body = makeNode( 'TBODY' )
    rows.forEach( ( cells ) => {
        const row = makeNode( 'TR' )
        cells.forEach( ( text ) => row.appendChild( makeNode( 'TD', text ) ) )
        body.appendChild( row )
    } )

    element.appendChild( head )
    element.appendChild( body )

    return element
}


function card() {
    return makeNode( 'DIV', '', [ 'block-meta-card' ] )
}


function summaryTextsOf( root, selector ) {
    return root.querySelectorAll( selector ).map( ( frame ) => frame.querySelector( 'summary' ).textContent )
}


describe( 'PRD-43 — six chapter sections fold, their figure is computed, no heading is shown twice', () => {
    let client = ''
    let cssSource = ''
    let fold = null
    let wrapTables = null

    beforeAll( async () => {
        client = await readEmittedScript()
        cssSource = await readFile( CSS_PATH, 'utf8' )

        // The five module-scope literals are lifted as the REAL declarations, not re-typed: a copy here
        // would keep this suite green precisely when the browser's list changes underneath it.
        const lists = [ 'BLOCK_BODY_SUFFIXES', 'CHAPTER_FOLD_SECTIONS', 'CHAPTER_FIGURE_KINDS', 'EVIDENCE_ART_VALUES', 'EVIDENCE_TAGS' ]
            .map( ( name ) => sliceDeclaration( client, name ) )
            .join( '\n' )

        const foldPass = await extractFunctionSources( [
            'foldBlockBodySections', 'chapterFoldLabel', 'foldOneSection', 'chapterSectionFigure',
            'countSectionUnits', 'distributionOf', 'artValueOfRow', 'headingLevel', 'hiddenSiblingsAfter'
        ] )
        fold = new Function( 'contentEl', 'document', lists + '\n' + foldPass.source + '\nreturn foldBlockBodySections()' )

        const tablePass = await extractFunctionSources( [
            'wrapTablesCollapsible', 'tableSummaryLabel', 'sameFoldFrame', 'headingLevel'
        ] )
        wrapTables = new Function( 'contentEl', 'document', tablePass.source + '\nreturn wrapTablesCollapsible()' )
    } )


    // ---- T-A: the mechanism itself ----
    it( 'T-A: a Belege section becomes a <details> whose <summary> IS the figure line', () => {
        const belege = heading( 3, 'Belege' )
        const root = makeRoot( [
            card(),
            belege,
            table( [ 'Nr', 'Fundstelle', 'Art' ], [ [ '1.1', 'a.mjs:1', 'gemessen' ], [ '1.2', 'b.mjs:2', 'gelesen' ] ] )
        ] )

        fold( root, makeDocument() )

        const frames = root.querySelectorAll( '.chapter-section' )
        expect( frames.length ).toBe( 1 )
        expect( frames[ 0 ].tagName ).toBe( 'DETAILS' )
        expect( belege.closest( '.chapter-section' ) ).toBe( frames[ 0 ] )
        expect( frames[ 0 ].querySelector( 'summary' ).textContent ).toBe( '2 Belege · 1 gemessen · 1 gelesen' )
        // The heading stays INSIDE the frame — it is the anchor the TOC and the id jumps address.
        expect( frames[ 0 ].querySelectorAll( 'h3' ).length ).toBe( 1 )
    } )


    // ---- T-B: the overview level stays open ----
    it( 'T-B: Kontext and User-Auftrag are NOT folded — and user-auftrag WAS collapsed before', () => {
        const kontext = heading( 3, 'Kontext' )
        const auftrag = heading( 3, 'User-Auftrag' )
        const belege = heading( 3, 'Belege' )
        const root = makeRoot( [ card(), kontext, paragraph( 'worum es geht' ), auftrag, paragraph( 'der Wunsch' ), belege, paragraph( 'leer' ) ] )

        fold( root, makeDocument() )

        expect( kontext.closest( '.chapter-section' ) ).toBe( null )
        expect( auftrag.closest( '.chapter-section' ) ).toBe( null )
        // POSITIV-KONTROLLE from the same apparatus: a section that DOES fold, so "not folded" above is
        // an outcome and not a pass that folded nothing at all.
        expect( belege.closest( '.chapter-section' ) ).not.toBe( null )

        // `user-auftrag` is in the VOCABULARY list, which is what the old pass collapsed. That it is not
        // in the FOLD list is the whole difference between the two lists.
        expect( client ).toContain( "'user-auftrag'" )
        const foldList = sliceDeclaration( client, 'CHAPTER_FOLD_SECTIONS' )
        expect( foldList ).not.toContain( 'user-auftrag' )
        expect( foldList ).not.toContain( 'kontext' )
    } )


    // ---- T-C: exactly the six ----
    it( 'T-C: all six fold and ONLY the six — a Bewertung in the same build stays open', () => {
        const six = [ 'Ist-Zustand', 'Soll-Zustand', 'Belege', 'Topics', 'Work-Items', 'Abhaengigkeiten' ]
            .map( ( text ) => heading( 3, text ) )
        const bewertung = heading( 3, 'Bewertung' )
        const messung = heading( 3, 'Messung' )
        const nodes = six.flatMap( ( node ) => [ node, paragraph( 'inhalt' ) ] )
        const root = makeRoot( [ card() ].concat( nodes ).concat( [ bewertung, paragraph( 'x' ), messung, paragraph( 'y' ) ] ) )

        fold( root, makeDocument() )

        expect( six.filter( ( node ) => node.closest( '.chapter-section' ) !== null ).length ).toBe( 6 )
        expect( root.querySelectorAll( '.chapter-section' ).length ).toBe( 6 )
        // The other direction in the SAME case: two vocabulary headings that are not contract sections
        // keep their prose. They used to be collapsed; that they no longer are is a measured, intended
        // behaviour change (thirteen headings in total across the corpus).
        expect( bewertung.closest( '.chapter-section' ) ).toBe( null )
        expect( messung.closest( '.chapter-section' ) ).toBe( null )
    } )


    // ---- T-D: prefix, both directions ----
    it( 'T-D: `Soll-Zustand: die Regel` folds, `Soll-Zustandsbericht` does not', () => {
        const suffixed = heading( 3, 'Soll-Zustand: die Regel' )
        const parenthesised = heading( 3, 'Soll-Zustand (zweiter Teil)' )
        const lookalike = heading( 3, 'Soll-Zustandsbericht' )
        const root = makeRoot( [ card(), suffixed, paragraph( 'a' ), parenthesised, paragraph( 'b' ), lookalike, paragraph( 'c' ) ] )

        fold( root, makeDocument() )

        expect( suffixed.closest( '.chapter-section' ) ).not.toBe( null )
        expect( parenthesised.closest( '.chapter-section' ) ).not.toBe( null )
        // GEGENPROBE: a heading that merely STARTS with the same letters is a different section. Without
        // this half, a recogniser matching on `indexOf === 0` alone would pass.
        expect( lookalike.closest( '.chapter-section' ) ).toBe( null )
        expect( root.querySelectorAll( '.chapter-section' ).length ).toBe( 2 )
    } )


    // ---- T-E: the two rules stand side by side ----
    it( 'T-E: the section starts CLOSED and the table inside it starts OPEN (F10=A untouched)', () => {
        const root = makeRoot( [
            card(),
            heading( 3, 'Belege' ),
            table( [ 'Nr', 'Art' ], [ [ '1.1', 'gemessen' ] ] )
        ] )
        const doc = makeDocument()

        fold( root, doc )
        wrapTables( root, doc )

        const section = root.querySelectorAll( '.chapter-section' )[ 0 ]
        const tableFrame = root.querySelectorAll( '.table-collapsible' )[ 0 ]
        expect( section.hasAttribute( 'open' ) ).toBe( false )
        expect( tableFrame.hasAttribute( 'open' ) ).toBe( true )
        // Both in the same case, because they are the two rules REV-16:4124 puts side by side: opening
        // the section must reveal an already-open table, not a second thing to click.
        expect( tableFrame.closest( '.chapter-section' ) ).toBe( section )
    } )


    // ---- T-F / T-G: the Belege figure and its remainder ----
    it( 'T-F: five rows with gemessen x3 / gelesen x2 read "5 Belege · 3 gemessen · 2 gelesen"', () => {
        const rows = [
            [ '1.1', 'a', 'gemessen' ], [ '1.2', 'b', 'gemessen' ], [ '1.3', 'c', 'gemessen' ],
            [ '1.4', 'd', 'gelesen' ], [ '1.5', 'e', 'gelesen' ]
        ]
        const root = makeRoot( [ card(), heading( 3, 'Belege' ), table( [ 'Nr', 'Ort', 'Art' ], rows ) ] )

        fold( root, makeDocument() )

        expect( summaryTextsOf( root, '.chapter-section' ) ).toEqual( [ '5 Belege · 3 gemessen · 2 gelesen' ] )
    } )


    it( 'T-G: a row without an Art value is NAMED as remainder, not dropped', () => {
        const rows = [
            [ '1.1', 'a', 'gemessen' ], [ '1.2', 'b', 'gemessen' ], [ '1.3', 'c', 'gemessen' ],
            [ '1.4', 'd', 'gelesen' ], [ '1.5', 'e', 'gelesen' ], [ '1.6', 'f', '' ]
        ]
        const root = makeRoot( [ card(), heading( 3, 'Belege' ), table( [ 'Nr', 'Ort', 'Art' ], rows ) ] )

        fold( root, makeDocument() )

        // Without this case the line would list the six known values and stop — over REV-16 that would
        // silently drop seven of 399 rows.
        expect( summaryTextsOf( root, '.chapter-section' ) ).toEqual( [ '6 Belege · 3 gemessen · 2 gelesen · 1 ohne Angabe' ] )
    } )


    // ---- T-H: the evidence distribution ----
    it( 'T-H: Ist-Zustand carries the evidence-tag distribution, all five tags in one build', () => {
        const items = [
            '[GEMESSEN] eins', '[FAKT] zwei', '[ABGELEITET] drei', '[ANNAHME] vier', '[VERMUTUNG] fuenf'
        ]
        const root = makeRoot( [ card(), heading( 3, 'Ist-Zustand' ), bulletList( items ) ] )

        fold( root, makeDocument() )

        expect( summaryTextsOf( root, '.chapter-section' ) )
            .toEqual( [ '5 Befunde · 1 gemessen · 1 fakt · 1 abgeleitet · 1 annahme · 1 vermutung' ] )
    } )


    // ---- T-I: the three that carry only a count ----
    it( 'T-I: Topics, Work-Items and Abhaengigkeiten carry a plain count', () => {
        const root = makeRoot( [
            card(),
            heading( 3, 'Topics' ), bulletList( [ 'T075', 'T076' ] ),
            heading( 3, 'Work-Items' ), bulletList( [ 'WI-113', 'WI-114', 'WI-116' ] ),
            heading( 3, 'Abhaengigkeiten' ), bulletList( [ 'haengt an WI-116' ] )
        ] )

        fold( root, makeDocument() )

        expect( summaryTextsOf( root, '.chapter-section' ) ).toEqual( [ '2 Topics', '3 Work-Items', '1 Kanten' ] )
    } )


    // ---- T-J: the vacuum rule ----
    it( 'T-J: an EMPTY section states "0 Belege" — and a filled one states more than zero', () => {
        const root = makeRoot( [
            card(),
            heading( 3, 'Belege' ), paragraph( 'Keine Belege in diesem Kapitel.' ),
            heading( 3, 'Topics' ), bulletList( [ 'T075' ] )
        ] )

        fold( root, makeDocument() )

        const texts = summaryTextsOf( root, '.chapter-section' )
        // The line is PRESENT and says zero. A missing figure line is a renderer defect, not an empty
        // section (REV-16:4135), and the two must never look alike.
        expect( texts[ 0 ] ).toBe( '0 Belege' )
        // POSITIV-KONTROLLE in the same case: without it, "0" is indistinguishable from "never counts".
        expect( texts[ 1 ] ).toBe( '1 Topics' )
        expect( root.querySelectorAll( '.chapter-section' ).length ).toBe( 2 )
        expect( texts.filter( ( text ) => text.length === 0 ).length ).toBe( 0 )
    } )


    // ---- T-K: typed figures are not a source ----
    it( 'T-K: an author line claiming 9 does not move the computed 3', () => {
        const root = makeRoot( [
            card(),
            heading( 3, 'Belege' ),
            paragraph( '9 Belege — gemessen 5 · gelesen 4' ),
            table( [ 'Nr', 'Art' ], [ [ '1.1', 'gemessen' ], [ '1.2', 'gemessen' ], [ '1.3', 'gemessen' ] ] )
        ] )

        fold( root, makeDocument() )

        // The typed line stays in the body where it belongs — it is the author's — and it is not read.
        expect( summaryTextsOf( root, '.chapter-section' ) ).toEqual( [ '3 Belege · 3 gemessen' ] )
        expect( root.querySelectorAll( '.chapter-section' )[ 0 ].textContent ).toContain( '9 Belege' )
    } )


    // ---- T-L / T-M: WI-114, the class rather than the case ----
    it( 'T-L: a table directly under `### Belege` inside the frame gets NO "Belege" label', () => {
        const root = makeRoot( [ card(), heading( 3, 'Belege' ), table( [ 'Nr', 'Art' ], [ [ '1.1', 'gemessen' ] ] ) ] )
        const doc = makeDocument()

        fold( root, doc )
        wrapTables( root, doc )

        const label = root.querySelectorAll( '.table-collapsible' )[ 0 ].querySelector( 'summary' ).textContent
        expect( label ).toBe( '' )
        expect( label ).not.toBe( 'Belege' )
    } )


    it( 'T-M: the same holds for Topics, Work-Items and Abhaengigkeiten — four sections, one case', () => {
        const names = [ 'Belege', 'Topics', 'Work-Items', 'Abhaengigkeiten' ]
        const nodes = names.flatMap( ( name ) => [ heading( 3, name ), table( [ 'Nr' ], [ [ '1.1' ] ] ) ] )
        const root = makeRoot( [ card() ].concat( nodes ) )
        const doc = makeDocument()

        fold( root, doc )
        wrapTables( root, doc )

        const labels = summaryTextsOf( root, '.table-collapsible' )
        // A fix that only caught the word "Belege" would leave three of these four reading their own
        // heading back at the reader. That is the difference between closing the case and the class.
        expect( labels ).toEqual( [ '', '', '', '' ] )
        expect( labels.length ).toBe( 4 )
    } )


    it( 'T-N: a table OUTSIDE a fold frame keeps its heading label', () => {
        const root = makeRoot( [ card(), heading( 3, 'Bewertung' ), table( [ 'Nr' ], [ [ '1.1' ] ] ) ] )
        const doc = makeDocument()

        fold( root, doc )
        wrapTables( root, doc )

        // Without this case, "no duplication" cannot be told apart from "all labels destroyed".
        const frames = root.querySelectorAll( '.table-collapsible' )
        expect( frames.length ).toBe( 1 )
        expect( frames[ 0 ].querySelector( 'summary' ).textContent ).toBe( 'Bewertung' )
        expect( frames[ 0 ].closest( '.chapter-section' ) ).toBe( null )
    } )


    it( 'T-O: a table with a bold lead-in keeps the lead-in as its label', () => {
        const lead = makeNode( 'P' )
        lead.appendChild( makeNode( 'STRONG', 'Messreihe A' ) )
        const root = makeRoot( [ card(), heading( 3, 'Bewertung' ), lead, table( [ 'Nr' ], [ [ '1.1' ] ] ) ] )
        const doc = makeDocument()

        fold( root, doc )
        wrapTables( root, doc )

        expect( summaryTextsOf( root, '.table-collapsible' ) ).toEqual( [ 'Messreihe A' ] )
    } )


    // ---- T-P: idempotency ----
    it( 'T-P: a second pass over the same DOM adds no second frame and no second figure line', () => {
        const root = makeRoot( [
            card(),
            heading( 3, 'Belege' ), table( [ 'Nr', 'Art' ], [ [ '1.1', 'gemessen' ] ] ),
            heading( 3, 'Topics' ), bulletList( [ 'T075' ] )
        ] )
        const doc = makeDocument()

        fold( root, doc )
        const first = summaryTextsOf( root, '.chapter-section' )
        fold( root, doc )
        const second = summaryTextsOf( root, '.chapter-section' )

        expect( first.length ).toBe( 2 )
        expect( second ).toEqual( first )
        expect( root.querySelectorAll( '.chapter-section' ).length ).toBe( 2 )
        expect( root.querySelectorAll( 'summary' ).length ).toBe( 2 )
    } )


    // ---- T-Q: the old mechanism is gone, measured against a live control ----
    it( 'T-Q: `block-body-hidden` has no live occurrence left, while `table-collapsible` still has many', () => {
        const liveIn = ( text, token ) => text
            .split( '\n' )
            .filter( ( line ) => line.includes( token ) && !/^\s*(\/\/|\/\*|\*)/.test( line ) )

        expect( liveIn( client, 'block-body-hidden' ) ).toEqual( [] )
        expect( cssSource ).not.toContain( '.block-body-hidden { display: none; }' )
        // VAKUUM-RIEGEL: the same probe over a token that IS still live. Without it, an empty result
        // above would also be what a probe that cannot find anything returns.
        expect( liveIn( client, 'table-collapsible' ).length ).toBeGreaterThan( 0 )
        expect( liveIn( client, 'chapter-section' ).length ).toBeGreaterThan( 0 )
    } )


    // ---- T-R: the fold list IS the contract, not a third copy ----
    it( 'T-R: the browser fold list is the contract derivation, character for character', () => {
        const { contract } = BlockSections.chapterContract()
        const derived = contract
            .filter( ( entry ) => entry.overview === false )
            .map( ( entry ) => entry.heading.toLowerCase() )

        const declared = JSON.parse(
            sliceDeclaration( client, 'CHAPTER_FOLD_SECTIONS' )
                .replace( 'var CHAPTER_FOLD_SECTIONS = ', '' )
                .replace( /'/g, '"' )
        )

        expect( declared ).toEqual( derived )
        expect( declared.length ).toBe( 6 )
        // GEGENPROBE: an entry removed from the derivation breaks the comparison, so the equality above
        // is a real one and not two empty lists agreeing.
        expect( declared ).not.toEqual( derived.slice( 1 ) )
        // And the contract really does mark exactly two sections as overview level.
        expect( contract.filter( ( entry ) => entry.overview === true ).map( ( entry ) => entry.heading ) )
            .toEqual( [ 'Kontext', 'User-Auftrag' ] )
    } )


    it( 'T-R2: the emitted script is the file on disk — the lift reads what the browser is served', async () => {
        const onDisk = await readFile( CLIENT_PATH, 'utf8' )

        expect( client ).toBe( onDisk )
        expect( client.length ).toBeGreaterThan( 0 )
    } )
} )
