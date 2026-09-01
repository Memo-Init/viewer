import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoValidator } from '../../src/MemoValidator.mjs'


// Memo 080, Kap 16 / WI-218 (T106) — PRD-V13 "Revisions-Arten getrennt validieren".
//
// The validator used to measure EVERY revision file against the full-revision schema. Prepare and
// update files carry different duties by definition, so they failed systematically (measured over
// 514 corpus files: 157 of 157 prepare files red, none of the findings a duty a prepare file can
// ever carry). These tests bind the three schemas: `full` unchanged, `update` and `prepare`
// against their own duties.
//
// No new error code is introduced — MEMO-001/MEMO-010 keep number, severity and theme; only their
// required set becomes type-dependent.


// A prepare skeleton exactly in the shape memo-revision-generate/SKILL.md prescribes
// ("REV-{XX}-prepare.md Format").
const PREPARE_DOC = [
    '# REV-07-prepare',
    '',
    '| Feld | Wert |',
    '|------|------|',
    '| **Memo** | 080-db-vollausbau-und-laufzeit-transparenz |',
    '| **Geplante Revision** | REV-07 |',
    '| **Geplanter Typ** | Full |',
    '| **Basiert auf** | REV-06 |',
    '| **Datum** | 2026-08-31 19:20 |',
    '',
    '---',
    '',
    '## Interpretation des Feedbacks',
    'Was der User gesagt hat und was es fuer das Memo bedeutet.',
    '',
    '---',
    '',
    '## Geplante Änderungen pro Kapitel',
    '- Kapitel 16: die Schema-Tabelle je Revisions-Art',
    '',
    '---',
    '',
    '## Research',
    'Research noetig: Nein',
    '',
    '---',
    '',
    '## Revisions-Blocker',
    'keine',
    '',
    '---',
    '',
    '## Offene Fragen',
    'keine'
].join( '\n' )


// An update skeleton: the two question sections are its structural duty, the five full header
// fields it carries anyway (all 24 corpus update files do).
const UPDATE_DOC = [
    '# REV-04-update',
    '',
    '| Feld | Wert |',
    '|------|------|',
    '| **Memo** | 080 |',
    '| **Memo-Name** | Test |',
    '| **Revision** | REV-04 |',
    '| **Datum** | 2026-08-31 |',
    '| **Status** | Entwurf |',
    '| **Typ** | Update (Kapitel 3, 5) |',
    'Schema-Version: 2',
    '',
    '## Offene Fragen',
    'keine',
    '',
    '## Beantwortete Fragen',
    'keine'
].join( '\n' )


// A minimal FULL document — deliberately incomplete, used to prove the full schema is untouched.
const FULL_DOC_MINIMAL = '## Kontext\nx\nSchema-Version: 2'


describe( 'MemoValidator revision types — derivation (A6)', () => {
    it( 'derives the type from the filename suffix (stage 1)', () => {
        expect( MemoValidator.validate( { doc: FULL_DOC_MINIMAL, fileName: 'REV-01.md' } )[ 'revisionType' ] ).toBe( 'full' )
        expect( MemoValidator.validate( { doc: FULL_DOC_MINIMAL, fileName: 'REV-02-prepare.md' } )[ 'revisionType' ] ).toBe( 'prepare' )
        expect( MemoValidator.validate( { doc: FULL_DOC_MINIMAL, fileName: 'REV-03-update.md' } )[ 'revisionType' ] ).toBe( 'update' )
    } )


    it( 'a path is reduced to its basename before the suffix is read', () => {
        const result = MemoValidator.validate( { doc: PREPARE_DOC, fileName: '/a/b/.memo/memos/080-x/revisions/REV-07-prepare.md' } )

        expect( result[ 'revisionType' ] ).toBe( 'prepare' )
    } )


    it( 'without a filename a document with no signal stays "full" — the pre-change behaviour', () => {
        // The 7 MemoView.#computeValidation call sites pass no fileName; they must keep the old
        // schema, otherwise this change would silently reinterpret every viewer validation.
        const result = MemoValidator.validate( { doc: FULL_DOC_MINIMAL } )

        expect( result[ 'revisionType' ] ).toBe( 'full' )
        expect( result[ 'messages' ].filter( ( m ) => m.startsWith( 'MEMO-001' ) ).length ).toBe( 9 )
        expect( result[ 'checked' ] ).toEqual( { 'sections': 10, 'headerFields': 5 } )
    } )


    it( 'without a filename a prepare document is recognised by its "# REV-NN-prepare" title (stage 2)', () => {
        const titleOnly = PREPARE_DOC.replace( '| **Geplante Revision** | REV-07 |\n', '' )
        const result = MemoValidator.validate( { doc: titleOnly } )

        expect( result[ 'revisionType' ] ).toBe( 'prepare' )
    } )


    it( 'without a filename a prepare document is recognised by the "Geplante Revision" header field (stage 2)', () => {
        const headerOnly = PREPARE_DOC.replace( '# REV-07-prepare', '# Vorbereitung' )
        const result = MemoValidator.validate( { doc: headerOnly } )

        expect( result[ 'revisionType' ] ).toBe( 'prepare' )
        expect( result[ 'status' ] ).toBe( true )
    } )


    it( 'without a filename an update document is recognised by the "Typ | Update" header field (stage 2)', () => {
        const result = MemoValidator.validate( { doc: UPDATE_DOC } )

        expect( result[ 'revisionType' ] ).toBe( 'update' )
        expect( result[ 'status' ] ).toBe( true )
    } )
} )


describe( 'MemoValidator revision types — the prepare schema (A1, A3, A5)', () => {
    it( 'a prepare skeleton per SKILL.md format is green', () => {
        const result = MemoValidator.validate( { doc: PREPARE_DOC, fileName: 'REV-07-prepare.md' } )

        expect( result[ 'messages' ] ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'revisionType' ] ).toBe( 'prepare' )
    } )


    it( 'states its comparison basis: 3 sections and 2 header fields were examined', () => {
        const result = MemoValidator.validate( { doc: PREPARE_DOC, fileName: 'REV-07-prepare.md' } )

        expect( result[ 'checked' ] ).toEqual( { 'sections': 3, 'headerFields': 2 } )
    } )


    it( 'a missing "## Revisions-Blocker" yields exactly one MEMO-001 naming the revision type', () => {
        const doc = PREPARE_DOC.replace( '## Revisions-Blocker', '## Entfernt-Revisions-Blocker' )
        const result = MemoValidator.validate( { doc, fileName: 'REV-07-prepare.md' } )
        const sectionMsgs = result[ 'messages' ].filter( ( m ) => m.startsWith( 'MEMO-001' ) )

        expect( sectionMsgs.length ).toBe( 1 )
        expect( sectionMsgs[ 0 ] ).toContain( 'section.Revisions-Blocker:' )
        expect( sectionMsgs[ 0 ] ).toContain( 'revision type "prepare"' )
    } )


    it( 'a missing "Geplante Revision" header field yields one MEMO-010 naming the revision type', () => {
        const doc = PREPARE_DOC.replace( '| **Geplante Revision** | REV-07 |\n', '' )
        const result = MemoValidator.validate( { doc, fileName: 'REV-07-prepare.md' } )
        const headerMsgs = result[ 'messages' ].filter( ( m ) => m.startsWith( 'MEMO-010' ) )

        expect( headerMsgs.length ).toBe( 1 )
        expect( headerMsgs[ 0 ] ).toContain( 'header.GeplanteRevision:' )
        expect( headerMsgs[ 0 ] ).toContain( 'revision type "prepare"' )
    } )


    it( 'accepts the transliterated "Geplante Aenderungen pro Kapitel" heading alias', () => {
        const doc = PREPARE_DOC.replace( '## Geplante Änderungen pro Kapitel', '## Geplante Aenderungen pro Kapitel' )
        const result = MemoValidator.validate( { doc, fileName: 'REV-07-prepare.md' } )

        expect( result[ 'messages' ] ).toEqual( [] )
    } )


    it( 'accepts the plain "Revision" header field as an alias of "Geplante Revision"', () => {
        const doc = PREPARE_DOC.replace( '| **Geplante Revision** | REV-07 |', '| **Revision** | REV-07 |' )
        const result = MemoValidator.validate( { doc, fileName: 'REV-07-prepare.md' } )

        expect( result[ 'messages' ] ).toEqual( [] )
        expect( result[ 'revisionType' ] ).toBe( 'prepare' )
    } )


    it( 'the full-revision sections and header fields are NOT demanded from a prepare file', () => {
        const result = MemoValidator.validate( { doc: PREPARE_DOC, fileName: 'REV-07-prepare.md' } )
        const all = result[ 'messages' ].join( ' | ' )

        expect( all ).not.toContain( 'section.Kontext' )
        expect( all ).not.toContain( 'section.Lessons-Learned' )
        expect( all ).not.toContain( 'header.Memo-Name' )
        expect( all ).not.toContain( 'header.Status' )
    } )


    it( 'A5: a prepare file with a malformed "### F{N}" block produces no question-family message', () => {
        // The question surface of a prepare artefact is an informal planning note; the binding
        // surface is the revision itself, where the families keep applying unchanged.
        const doc = PREPARE_DOC.replace(
            '## Offene Fragen\nkeine',
            '## Offene Fragen\n\n### F1 — Unvollstaendig\n\n**A)** Erste\n**B)** Zweite\n'
        )
        const result = MemoValidator.validate( { doc, fileName: 'REV-07-prepare.md' } )
        const questionFamilies = result[ 'messages' ]
            .filter( ( m ) => /^MEMO-(020|025|030|031|032|033|040|050)/.test( m ) )

        expect( questionFamilies ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
    } )


    it( 'A5: a malformed questions-json block in a prepare file produces no MEMO-050', () => {
        const doc = `${ PREPARE_DOC }\n\n\`\`\`questions-json\n{ not valid json ]\n\`\`\``
        const result = MemoValidator.validate( { doc, fileName: 'REV-07-prepare.md' } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-050' ) ) ).toBe( false )
    } )


    it( 'INFO-010 (Schema-Version) is off for a prepare file', () => {
        const result = MemoValidator.validate( { doc: PREPARE_DOC, fileName: 'REV-07-prepare.md' } )

        expect( result[ 'info' ].some( ( m ) => m.startsWith( 'INFO-010' ) ) ).toBe( false )
    } )


    it( 'MEMO-070 is off for a prepare file — an open research marker is its intended state', () => {
        const doc = PREPARE_DOC.replace( 'Research noetig: Nein', 'Research noetig: Ja [Research offen]' )
        const result = MemoValidator.validate( { doc, fileName: 'REV-07-prepare.md' } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-070' ) ) ).toBe( false )
    } )


    it( 'MEMO-060 stays ON for a prepare file (filename suffix is checked for every type)', () => {
        const result = MemoValidator.validate( { doc: PREPARE_DOC, fileName: 'PREPARE-REV-7.md' } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-060' ) ) ).toBe( true )
    } )


    it( 'MEMO-080 stays ON for a prepare file (block-meta is checked for every type)', () => {
        const doc = `${ PREPARE_DOC }\n\n\`\`\`block-meta\n{ broken\n\`\`\``
        const result = MemoValidator.validate( { doc, fileName: 'REV-07-prepare.md' } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-080' ) ) ).toBe( true )
    } )
} )


describe( 'MemoValidator revision types — the update schema (A4)', () => {
    it( 'an update skeleton with both question sections and the 5 header fields is green', () => {
        const result = MemoValidator.validate( { doc: UPDATE_DOC, fileName: 'REV-04-update.md' } )

        expect( result[ 'messages' ] ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'revisionType' ] ).toBe( 'update' )
        expect( result[ 'checked' ] ).toEqual( { 'sections': 2, 'headerFields': 5 } )
    } )


    it( 'a missing "## Beantwortete Fragen" is a real defect and stays red', () => {
        const doc = UPDATE_DOC.replace( '## Beantwortete Fragen', '## Entfernt-Beantwortete Fragen' )
        const result = MemoValidator.validate( { doc, fileName: 'REV-04-update.md' } )
        const sectionMsgs = result[ 'messages' ].filter( ( m ) => m.startsWith( 'MEMO-001' ) )

        expect( sectionMsgs.length ).toBe( 1 )
        expect( sectionMsgs[ 0 ] ).toContain( 'section.BeantworteteFragen:' )
        expect( sectionMsgs[ 0 ] ).toContain( 'revision type "update"' )
        expect( result[ 'status' ] ).toBe( false )
    } )


    it( 'the four delivery sections are NOT demanded from an update file', () => {
        const result = MemoValidator.validate( { doc: UPDATE_DOC, fileName: 'REV-04-update.md' } )
        const all = result[ 'messages' ].join( ' | ' )

        expect( all ).not.toContain( 'section.Finalisierungs-Checkliste' )
        expect( all ).not.toContain( 'section.AncillaryFiles' )
        expect( all ).not.toContain( 'section.Rollout-Entry-Points' )
        expect( all ).not.toContain( 'section.Lessons-Learned' )
    } )


    it( 'the question families and MEMO-070 stay ON for an update file', () => {
        const withMarker = UPDATE_DOC.replace( 'keine\n\n## Beantwortete Fragen', 'keine [Research offen]\n\n## Beantwortete Fragen' )
        // A `### F5` heading OUTSIDE the question sections is counted by the whole-doc heading
        // regex but never parsed into a question — the MEMO-025 silent-degradation case.
        const withStray = `${ UPDATE_DOC }\n\n## Anhang\n\n### F5 — Verirrt\n`

        expect( MemoValidator.validate( { doc: withMarker, fileName: 'REV-04-update.md' } )[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-070' ) ) ).toBe( true )
        expect( MemoValidator.validate( { doc: withStray, fileName: 'REV-04-update.md' } )[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-025' ) ) ).toBe( true )
    } )
} )


describe( 'MemoValidator revision types — no new error code (A8)', () => {
    it( 'getCatalog() carries exactly the 19 codes it carried before the change', () => {
        const { catalog } = MemoValidator.getCatalog()
        const codes = catalog.map( ( entry ) => entry[ 'code' ] ).sort()

        expect( codes ).toEqual( [
            'INFO-010', 'MEMO-001', 'MEMO-002', 'MEMO-010', 'MEMO-020a', 'MEMO-020b', 'MEMO-020c',
            'MEMO-020d', 'MEMO-025', 'MEMO-030', 'MEMO-031', 'MEMO-032', 'MEMO-033', 'MEMO-040',
            'MEMO-050', 'MEMO-060', 'MEMO-070', 'MEMO-080', 'WARN-010'
        ] )
    } )
} )


// The real belege, not a fixture: REV-17-prepare.md is the file that reproduced the defect
// (12 messages before the change). It lives in the workbench .memo/ tree, which a standalone
// checkout of this repo does not have — so the case is EXPLICITLY skipped there (jest reports
// "skipped", never a silent pass) and runs as the real proof wherever the tree exists.
const here = dirname( fileURLToPath( import.meta.url ) )
const REAL_PREPARE = resolve( here, '../../../../.memo/memos/080-db-vollausbau-und-laufzeit-transparenz/revisions/REV-17-prepare.md' )
const REAL_FULL = resolve( here, '../../../../.memo/memos/080-db-vollausbau-und-laufzeit-transparenz/revisions/REV-18.md' )
const withTree = existsSync( REAL_PREPARE ) && existsSync( REAL_FULL ) ? it : it.skip

describe( 'MemoValidator revision types — the reproduced defect on the real files (A1)', () => {
    withTree( 'the real REV-17-prepare.md is valid against the prepare schema', async () => {
        const content = await readFile( REAL_PREPARE, 'utf-8' )
        const result = MemoValidator.validate( { doc: content, fileName: 'REV-17-prepare.md' } )

        expect( result[ 'revisionType' ] ).toBe( 'prepare' )
        expect( result[ 'messages' ] ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
    } )


    withTree( 'the real REV-18.md is still valid against the unchanged full schema', async () => {
        const content = await readFile( REAL_FULL, 'utf-8' )
        const result = MemoValidator.validate( { doc: content, fileName: 'REV-18.md' } )

        expect( result[ 'revisionType' ] ).toBe( 'full' )
        expect( result[ 'messages' ] ).toEqual( [] )
        expect( result[ 'checked' ] ).toEqual( { 'sections': 10, 'headerFields': 5 } )
    } )
} )
