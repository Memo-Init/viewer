import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoValidator } from '../../src/MemoValidator.mjs'


// Memo 080, Kap 14 / WI-172 (PRD-R4) — WARN-011 "Eigenstaendigkeit der Revision".
//
// A revision carries its whole content itself. When a chapter survives into the next revision but
// its substance does not, the line diff shows green while the document lost information. WARN-011 is
// the cross-revision counterpart of the SR-13 lint: it names what left the document.
//
// The comparison basis rides in EVERY result (`comparedChapters`). That is the point of the check,
// not decoration: REV-02 -> REV-03 renamed every heading, so a naive comparison would have reported
// "0 losses" over 0 compared chapters and read as a pass.


const here = dirname( fileURLToPath( import.meta.url ) )
const REV_DIR = resolve( here, '../../../../.memo/memos/080-db-vollausbau-und-laufzeit-transparenz/revisions' )

const readRevision = async ( name ) => readFile( resolve( REV_DIR, name ), 'utf-8' )

const hasRevisions = [ 'REV-01.md', 'REV-02.md', 'REV-03.md', 'REV-17.md', 'REV-18.md' ]
    .every( ( name ) => existsSync( resolve( REV_DIR, name ) ) )
// The revisions live OUTSIDE this repo; CI checks the viewer out alone. Skip loudly, never return.
const withTree = hasRevisions ? it : it.skip


// Two synthetic revisions, kept in-repo so the rule keeps its bite where the workbench tree is
// absent. Chapter 1 keeps everything, chapter 2 drops its User-Auftrag block and most of its lines,
// chapter 3 is untouched — the [Tag] suffix and the chapter number change to prove the normalisation.
const PREVIOUS_DOC = [
    '## 1. Ausgangslage [Docs]',
    '**User-Auftrag:** "Bau das vollstaendig."',
    'Ist-Zustand: [FAKT] die Projektion verliert Felder.',
    'Ist-Zustand: [FAKT] der PUT-Zweig hat keinen Spiegel.',
    '',
    '## 2. Traceability [Code]',
    '**User-Auftrag:** "Ich will jeden Commit zurueckverfolgen."',
    'Ist-Zustand: [FAKT] der Commit-Hash fehlt in der Tabelle.',
    'Ist-Zustand: [ANNAHME] die Sessions lassen sich verbinden.',
    'Ist-Zustand: [VERMUTUNG] die Kontamination ist messbar.',
    'Grenzen: der HTTP-Pfad ist nicht erfasst.',
    '',
    '## 3. Ausblick [Docs]',
    'Ein Satz, der bleibt.'
].join( '\n' )

const CURRENT_DOC = [
    '## 1. Ausgangslage [Code]',
    '**User-Auftrag:** "Bau das vollstaendig."',
    'Ist-Zustand: [FAKT] die Projektion verliert Felder.',
    'Ist-Zustand: [FAKT] der PUT-Zweig hat keinen Spiegel.',
    '',
    '## 2. Traceability [Code]',
    'Ist-Zustand unveraendert gueltig aus der letzten Revision.',
    '',
    '## 3. Ausblick [Docs]',
    'Ein Satz, der bleibt.'
].join( '\n' )


describe( 'MemoValidator.checkStandaloneContinuity — the substance findings (WARN-011)', () => {
    it( 'reports the dropped User-Auftrag block, the shrunken chapter and the evidence balance', () => {
        const result = MemoValidator.checkStandaloneContinuity( { current: CURRENT_DOC, previous: PREVIOUS_DOC } )

        expect( result.comparedChapters ).toBe( 3 )
        const joined = result.warnings.join( '\n' )
        expect( joined ).toMatch( /WARN-011 User-Auftrag: 1 of 3 compared chapters lost their User-Auftrag block/ )
        expect( joined ).toMatch( /Traceability/ )
        expect( joined ).toMatch( /WARN-011 Kapitel: 1 of 3 compared chapters shrank below half their non-empty lines/ )
        expect( joined ).toMatch( /WARN-011 Evidenz: evidence markers over the 3 compared chapters fell from 5 to 2/ )
        // The basis is sufficient (3 of 3), so there is NO basis warning.
        expect( joined ).not.toMatch( /comparison basis/ )
    } )


    it( 'normalises the heading: the [Tag] suffix and the chapter number never break a match', () => {
        const renumbered = PREVIOUS_DOC.replace( '## 2. Traceability [Code]', '## 7. Traceability [Diagramme]' )
        const result = MemoValidator.checkStandaloneContinuity( { current: CURRENT_DOC, previous: renumbered } )

        expect( result.comparedChapters ).toBe( 3 )
    } )


    it( 'stays silent on an unchanged revision but still states the comparison basis', () => {
        const result = MemoValidator.checkStandaloneContinuity( { current: PREVIOUS_DOC, previous: PREVIOUS_DOC } )

        expect( result.warnings ).toEqual( [] )
        expect( result.comparedChapters ).toBe( 3 )
    } )


    it( 'ignores a chapter heading that sits inside a fenced code block', () => {
        const fenced = [ '```', '## 9. Beispielkapitel [Docs]', 'nur ein Beispiel', '```', PREVIOUS_DOC ].join( '\n' )
        const result = MemoValidator.checkStandaloneContinuity( { current: fenced, previous: PREVIOUS_DOC } )

        expect( result.comparedChapters ).toBe( 3 )
    } )
} )


describe( 'MemoValidator.checkStandaloneContinuity — no vacuum green (A7)', () => {
    it( 'a zero comparison basis is its OWN finding, never an empty clean result', () => {
        const renamed = [ '## 1. Voellig anderer Titel', 'Inhalt.' ].join( '\n' )
        const result = MemoValidator.checkStandaloneContinuity( { current: renamed, previous: PREVIOUS_DOC } )

        expect( result.comparedChapters ).toBe( 0 )
        expect( result.warnings.length ).toBe( 1 )
        expect( result.warnings[ 0 ] ).toMatch( /no sufficient comparison basis: 0 of 3 predecessor chapters matched/ )
    } )


    it( 'a thin basis is reported ALONGSIDE the losses it did find, not instead of them', () => {
        // Only chapter 2 survives -> 1 of 3, below half; the dropped User-Auftrag must still surface.
        const thin = [ '## 4. Traceability [Docs]', 'Ist-Zustand: wie zuvor.', '', '## 5. Neu', 'Neu.' ].join( '\n' )
        const result = MemoValidator.checkStandaloneContinuity( { current: thin, previous: PREVIOUS_DOC } )

        expect( result.comparedChapters ).toBe( 1 )
        const joined = result.warnings.join( '\n' )
        expect( joined ).toMatch( /no sufficient comparison basis: 1 of 3 predecessor chapters matched/ )
        expect( joined ).toMatch( /lost their User-Auftrag block/ )
    } )


    it( 'a missing predecessor is stated, not silently passed', () => {
        const result = MemoValidator.checkStandaloneContinuity( { current: CURRENT_DOC, previous: null } )

        expect( result.comparedChapters ).toBe( 0 )
        expect( result.warnings[ 0 ] ).toMatch( /no comparison basis: no predecessor revision was handed in/ )
    } )


    it( 'comparedChapters is present in EVERY result shape', () => {
        const shapes = [
            MemoValidator.checkStandaloneContinuity( { current: CURRENT_DOC, previous: PREVIOUS_DOC } ),
            MemoValidator.checkStandaloneContinuity( { current: PREVIOUS_DOC, previous: PREVIOUS_DOC } ),
            MemoValidator.checkStandaloneContinuity( { current: '', previous: '' } ),
            MemoValidator.checkStandaloneContinuity( { current: CURRENT_DOC, previous: undefined } )
        ]

        expect( shapes.length ).toBe( 4 )
        shapes.forEach( ( shape ) => { expect( typeof shape.comparedChapters ).toBe( 'number' ) } )
    } )
} )


describe( 'MemoValidator.checkStandaloneContinuity — Realbeleg against the memo-080 revisions (A6)', () => {
    withTree( 'REV-01 -> REV-02 reports 8 dropped User-Auftrag blocks over 9 compared chapters', async () => {
        const previous = await readRevision( 'REV-01.md' )
        const current = await readRevision( 'REV-02.md' )
        const result = MemoValidator.checkStandaloneContinuity( { current, previous } )

        expect( result.comparedChapters ).toBe( 9 )
        expect( result.warnings.join( '\n' ) ).toMatch( /8 of 9 compared chapters lost their User-Auftrag block/ )
    } )


    withTree( 'REV-02 -> REV-03 compared ZERO chapters and says so instead of reading clean', async () => {
        const previous = await readRevision( 'REV-02.md' )
        const current = await readRevision( 'REV-03.md' )
        const result = MemoValidator.checkStandaloneContinuity( { current, previous } )

        expect( result.comparedChapters ).toBe( 0 )
        expect( result.warnings.length ).toBe( 1 )
        expect( result.warnings[ 0 ] ).toMatch( /no sufficient comparison basis: 0 of 21 predecessor chapters matched/ )
    } )


    withTree( 'REV-17 -> REV-18 is clean over 25 compared chapters', async () => {
        const previous = await readRevision( 'REV-17.md' )
        const current = await readRevision( 'REV-18.md' )
        const result = MemoValidator.checkStandaloneContinuity( { current, previous } )

        expect( result.comparedChapters ).toBe( 25 )
        expect( result.warnings ).toEqual( [] )
    } )
} )


describe( 'MemoValidator catalogue and validate stay untouched (A10)', () => {
    it( 'getCatalog carries WARN-011 as a WARNING, additively', () => {
        const { catalog } = MemoValidator.getCatalog()
        const entry = catalog.find( ( row ) => row[ 'code' ] === 'WARN-011' )

        expect( entry ).toBeDefined()
        expect( entry[ 'severity' ] ).toBe( 'WARNING' )
        expect( entry[ 'theme' ] ).toBe( 'standalone-continuity' )
        // Additive: the codes that existed before are all still there, unchanged.
        const codes = catalog.map( ( row ) => row[ 'code' ] )
        expect( codes ).toEqual( expect.arrayContaining( [ 'MEMO-001', 'MEMO-060', 'MEMO-080', 'INFO-010', 'WARN-010', 'WARN-020', 'WARN-021' ] ) )
        expect( new Set( codes ).size ).toBe( codes.length )
    } )


    it( 'classify routes WARN-011 into the non-blocking WARNING channel', () => {
        expect( MemoValidator.classify( { code: 'WARN-011' } ).severity ).toBe( 'WARNING' )
    } )


    it( 'validate does not gain a WARN-011 message — the check is cross-revision only', () => {
        const result = MemoValidator.validate( { doc: CURRENT_DOC, fileName: 'REV-02.md' } )

        expect( result.messages.join( '\n' ) ).not.toMatch( /WARN-011/ )
        expect( result.warnings.join( '\n' ) ).not.toMatch( /WARN-011/ )
        expect( result.status ).toBe( result.messages.length === 0 )
    } )


    it( 'the check never throws, whatever it is handed', () => {
        const inputs = [
            { current: 42, previous: PREVIOUS_DOC },
            { current: CURRENT_DOC, previous: {} },
            { current: '', previous: '' }
        ]

        expect( inputs.length ).toBe( 3 )
        inputs.forEach( ( input ) => {
            expect( () => MemoValidator.checkStandaloneContinuity( input ) ).not.toThrow()
        } )
    } )
} )
