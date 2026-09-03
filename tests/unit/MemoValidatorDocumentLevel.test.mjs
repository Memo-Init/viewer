import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { MemoValidator } from '../../src/MemoValidator.mjs'
import { BlockSections } from '../../src/BlockSections.mjs'


// Memo 080, PRD-R1 Vollausbau — the DOCUMENT LEVEL as a check (REV-18 Z. 154-172).
//
// WHY BOTH CODES ENTER AS `WARNING` AND NOT AS `ERROR`: measured on 2026-08-31 the corpus held 333 full,
// 24 update and 157 prepare revisions, and the validator checked every one of them against the full
// schema. A blocking order/head duty would therefore have turned the whole corpus red on the day it was
// introduced, for a form most of those files were never written to. PRD-V13 made the schema type-aware;
// this PRD hangs the two new checks into THAT table for `full` only — and leaves their severity at
// WARNING until a FRESH measurement of the corpus (per type, each group naming how many files it
// compared) shows the full group at zero hits. Sharpening against the figures of a document instead of
// a new measurement would be a claim, not a gate.
//
// EVERY CASE STATES HOW MUCH IT COMPARED. A comparison basis of 0 is asserted RED, never green.

const here = dirname( fileURLToPath( import.meta.url ) )
const REAL_PREPARE = resolve( here, '../../../../.memo/memos/080-db-vollausbau-und-laufzeit-transparenz/revisions/REV-17-prepare.md' )
const withTree = existsSync( REAL_PREPARE ) ? it : it.skip


// The headings a document position is written under, taken from the ONE register — never typed here.
// A position may declare more than one ("Phasen und Phasen-Hinweise" is `## Phasen` plus
// `## Phase-Hints`), and MEMO-001 demands every one of them, so the fixture writes them all.
const headingsOf = ( { section } ) => {
    const found = BlockSections.documentSections().sections
        .find( ( entry ) => entry[ 'section' ] === section )
    if( found === undefined || found[ 'headings' ].length === 0 ) { throw new Error( `no heading declared for "${ section }"` ) }

    return found[ 'headings' ]
}


// A minimal FULL revision written in the declared document order, with the seven head fields. Built FROM
// the register, so a change to the declared order rewrites this fixture instead of contradicting it.
const buildFullDoc = ( { order } ) => {
    const positions = order === undefined
        ? BlockSections.documentSections().sections.filter( ( entry ) => entry[ 'headings' ].length > 0 ).map( ( entry ) => entry[ 'section' ] )
        : order
    const head = [
        '# Dokument-Ebene',
        '',
        '| Feld | Wert |',
        '| --- | --- |',
        '| **Memo** | M080 |',
        '| **Memo-Name** | Dokument-Ebene |',
        '| **Revision** | 01 |',
        '| **Datum** | 2026-09-01 |',
        '| **Status** | open |',
        '| **Typ** | Full |',
        '| **Aenderungen** | Erstfassung |',
        '| **Schema-Version** | 2 |',
        ''
    ]
    const body = positions
        .map( ( section ) => headingsOf( { section } )
            .map( ( heading ) => [ `## ${ heading }`, '', 'Inhalt.', '' ] )
            .reduce( ( acc, part ) => acc.concat( part ), [] ) )
        .reduce( ( acc, part ) => acc.concat( part ), [] )

    return head.concat( body ).join( '\n' )
}


const warningsOf = ( { result, code } ) => result[ 'warnings' ].filter( ( message ) => message.startsWith( code ) === true )


describe( 'MemoValidator document level — the catalogue (A14, A17)', () => {
    it( 'carries WARN-020 and WARN-021 as WARNING, and the catalogue grew from 19 to 21', () => {
        const { catalog } = MemoValidator.getCatalog()
        const added = catalog.filter( ( entry ) => [ 'WARN-020', 'WARN-021' ].includes( entry[ 'code' ] ) === true )

        expect( catalog.length ).toBe( 21 )
        expect( added.length ).toBe( 2 )
        expect( added.map( ( entry ) => [ entry[ 'code' ], entry[ 'severity' ], entry[ 'theme' ] ] ) ).toEqual( [
            [ 'WARN-020', 'WARNING', 'dokument-ebene' ],
            [ 'WARN-021', 'WARNING', 'header' ]
        ] )
        expect( MemoValidator.classify( { code: 'WARN-020' } ).severity ).toBe( 'WARNING' )
        expect( MemoValidator.classify( { code: 'WARN-021' } ).severity ).toBe( 'WARNING' )
    } )


    it( 'states the sharpening condition next to the entries — measure again, full group at zero, else snag', async () => {
        // The RULE is part of the artefact, not of a chat: a later reader must find WHY these two are
        // WARNING and WHAT has to be true before either becomes an ERROR.
        const source = await readFile( resolve( here, '../../src/MemoValidator.mjs' ), 'utf-8' )
        const marker = source.indexOf( 'THE SHARPENING RULE' )

        expect( marker ).toBeGreaterThan( -1 )
        const rule = source.slice( marker, source.indexOf( "{ 'code': 'WARN-020'", marker ) )
        expect( rule ).toContain( 'measure the corpus AGAIN' )
        expect( rule ).toContain( '0 compared files is RED' )
        expect( rule ).toContain( 'memo snag add' )
    } )
} )


describe( 'MemoValidator document level — WARN-020, the section sequence (A16)', () => {
    it( 'is silent on a document written in the declared order, and says how much it compared', () => {
        const result = MemoValidator.validate( { doc: buildFullDoc( {} ), fileName: 'REV-01.md' } )

        expect( result[ 'revisionType' ] ).toBe( 'full' )
        expect( warningsOf( { result, code: 'WARN-020' } ) ).toEqual( [] )
        expect( result[ 'checked' ][ 'comparedSections' ] ).toBe( 11 )
        expect( result[ 'checked' ][ 'comparedSections' ] ).toBeGreaterThan( 0 )
    } )


    it( 'fires on a swapped sequence and names the expected AND the found position', () => {
        const declared = BlockSections.documentSections().sections
            .filter( ( entry ) => entry[ 'headings' ].length > 0 )
            .map( ( entry ) => entry[ 'section' ] )
        // swap the first two heading-bearing positions — the smallest possible divergence
        const swapped = [ declared[ 1 ], declared[ 0 ] ].concat( declared.slice( 2 ) )
        const result = MemoValidator.validate( { doc: buildFullDoc( { order: swapped } ), fileName: 'REV-01.md' } )
        const hits = warningsOf( { result, code: 'WARN-020' } )

        expect( hits.length ).toBe( 1 )
        expect( hits[ 0 ] ).toContain( `expected "${ declared[ 0 ] }"` )
        expect( hits[ 0 ] ).toContain( `found "${ declared[ 1 ] }"` )
        expect( hits[ 0 ] ).toContain( `of ${ declared.length } compared positions` )
        // a WARNING is NOT a blocker: the file stays valid, which is the whole point of the channel
        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'messages' ] ).toEqual( [] )
    } )


    it( 'reports RED when it recognised NO position at all — a check without a comparison basis', () => {
        const doc = [ '# Nichts', '', '| **Memo** | M080 |', '| **Typ** | Full |', '| **Aenderungen** | x |', '', '## Irgendwas', '', 'Text.' ].join( '\n' )
        const result = MemoValidator.validate( { doc, fileName: 'REV-01.md' } )
        const hits = warningsOf( { result, code: 'WARN-020' } )

        expect( result[ 'checked' ][ 'comparedSections' ] ).toBe( 0 )
        expect( hits.length ).toBe( 1 )
        expect( hits[ 0 ] ).toContain( 'reports red, not green' )
    } )
} )


describe( 'MemoValidator document level — WARN-021, the head fields (A16)', () => {
    it( 'compares exactly the remainder beyond MEMO-010 — today Typ and Aenderungen', () => {
        const result = MemoValidator.validate( { doc: buildFullDoc( {} ), fileName: 'REV-01.md' } )

        expect( result[ 'checked' ][ 'comparedHeaderFields' ] ).toBe( 2 )
        expect( warningsOf( { result, code: 'WARN-021' } ) ).toEqual( [] )
    } )


    it( 'fires per missing field and per EMPTY field, naming the field and the comparison basis', () => {
        const missing = buildFullDoc( {} ).replace( '| **Typ** | Full |\n', '' )
        const emptied = buildFullDoc( {} ).replace( '| **Aenderungen** | Erstfassung |', '| **Aenderungen** |  |' )

        const missingHits = warningsOf( { result: MemoValidator.validate( { doc: missing, fileName: 'REV-01.md' } ), code: 'WARN-021' } )
        const emptyHits = warningsOf( { result: MemoValidator.validate( { doc: emptied, fileName: 'REV-01.md' } ), code: 'WARN-021' } )

        expect( missingHits.length ).toBe( 1 )
        expect( missingHits[ 0 ] ).toContain( 'header.Typ' )
        expect( missingHits[ 0 ] ).toContain( 'missing' )
        expect( missingHits[ 0 ] ).toContain( '2 document-level head field(s) compared' )

        expect( emptyHits.length ).toBe( 1 )
        expect( emptyHits[ 0 ] ).toContain( 'header.Aenderungen' )
        expect( emptyHits[ 0 ] ).toContain( 'empty' )

        // still non-blocking — MEMO-010 keeps its own five fields and its own severity
        expect( MemoValidator.validate( { doc: missing, fileName: 'REV-01.md' } )[ 'status' ] ).toBe( true )
    } )
} )


describe( 'MemoValidator document level — full-ONLY typing (A15)', () => {
    it( 'neither code runs on an update file, and both comparison bases report 0', () => {
        // A document that would trip BOTH codes if they were on: no Typ, no Aenderungen, wrong order.
        const doc = [
            '# Update', '', '| Feld | Wert |', '| --- | --- |',
            '| **Memo** | M080 |', '| **Memo-Name** | X |', '| **Revision** | 04 |',
            '| **Datum** | 2026-09-01 |', '| **Status** | open |', '| **Schema-Version** | 2 |', '',
            '## Beantwortete Fragen', '', 'keine', '', '## Offene Fragen', '', 'keine', ''
        ].join( '\n' )
        const result = MemoValidator.validate( { doc, fileName: 'REV-04-update.md' } )

        expect( result[ 'revisionType' ] ).toBe( 'update' )
        expect( result[ 'warnings' ] ).toEqual( [] )
        expect( result[ 'checked' ] ).toEqual( { 'sections': 2, 'headerFields': 5, 'comparedSections': 0, 'comparedHeaderFields': 0 } )
        expect( result[ 'status' ] ).toBe( true )
    } )


    it( 'neither code runs on a synthetic prepare file', () => {
        const doc = [
            '# REV-07-prepare', '', '| **Memo** | M080 |', '| **Geplante Revision** | 07 |', '',
            '## Interpretation des Feedbacks', '', 'x', '',
            '## Geplante Änderungen pro Kapitel', '', 'x', '',
            '## Revisions-Blocker', '', 'keine', ''
        ].join( '\n' )
        const result = MemoValidator.validate( { doc, fileName: 'REV-07-prepare.md' } )

        expect( result[ 'revisionType' ] ).toBe( 'prepare' )
        expect( result[ 'warnings' ] ).toEqual( [] )
        expect( result[ 'checked' ][ 'comparedSections' ] ).toBe( 0 )
        expect( result[ 'checked' ][ 'comparedHeaderFields' ] ).toBe( 0 )
    } )


    // The REAL belege, not a fixture. It lives in the workbench .memo/ tree, which a standalone checkout
    // of this repo does not have — so the case is EXPLICITLY skipped there (jest reports "skipped", never
    // a silent pass) and runs as the real proof wherever the tree exists.
    withTree( 'neither code fires on the real REV-17-prepare.md', async () => {
        const content = await readFile( REAL_PREPARE, 'utf-8' )
        const result = MemoValidator.validate( { doc: content, fileName: 'REV-17-prepare.md' } )

        expect( content.length ).toBeGreaterThan( 0 )
        expect( result[ 'revisionType' ] ).toBe( 'prepare' )
        expect( result[ 'warnings' ] ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
    } )
} )
