import { describe, it, expect, beforeAll } from '@jest/globals'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'

import { readEmittedScript } from '../helpers/extractFunction.mjs'
import { BlockSections } from '../../src/BlockSections.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'
import { RevisionFormScore } from '../../src/RevisionFormScore.mjs'


// Memo 081, PRD-39 (WI-116 + WI-120, REV-16:3393-3402 / :4165 / :5322-5327).
//
// THE TWO DEFECTS THIS SUITE HOLDS, BOTH MEASURED OVER THE SAME 533 REVISION FILES ON 2026-09-08:
//   1. the CHAPTER CONTRACT existed THREE times and was right ONCE. The memo named
//      `### Abhaengigkeiten`, RevisionFormScore.CONTRACT_SECTIONS named five blocks with
//      `### PRD-Zuordnung`, and BlockSections knew the vocabulary but not which part of it is DUTY.
//      242 `### Abhaengigkeiten` headings stood in the stock (6 files) and the register recognised
//      ZERO of them, while 411 `### PRD-Zuordnung` headings (16 files) were recognised.
//   2. the DOCUMENT heading `## Phasen` stands in 356 of those 533 files and `## Abhaengigkeiten` in 0,
//      so renaming the schema without a transition would have handed MEMO-001 — an ERROR that sets
//      status:false — to 356 files at once.
//
// EVERY CASE THAT ASSERTS A ZERO OR AN ABSENCE MEASURES THE OPPOSITE FROM THE SAME APPARATUS. A check
// that only ever sees the empty side cannot tell "nothing is wrong" from "nothing was looked at".
//
// REPO BOUNDARY: this file reads ONLY inside repos/viewer. The one cross-boundary read is the emitted
// client script, which is repo-local. CI checks this repo out alone, so nothing here depends on a
// sibling being present.
const HERE = dirname( fileURLToPath( import.meta.url ) )
const CLIENT_PATH = resolve( HERE, '..', '..', 'src', 'public', 'app.client.mjs' )


// A `full` revision skeleton carrying exactly the ten mandatory document sections, so a case can vary
// ONE heading and attribute the verdict to that heading and to nothing else.
function documentWith( { dependencies, hints } ) {
    const head = [
        '| **Memo** | 099 |',
        '| **Memo-Name** | Probe |',
        '| **Revision** | REV-01 |',
        '| **Datum** | 2026-09-08 |',
        '| **Status** | Entwurf |',
        ''
    ]
    const sections = [ 'Kontext', 'Vorwort', 'Offene Fragen', 'Beantwortete Fragen' ]
        .concat( dependencies === null ? [] : [ dependencies ] )
        .concat( hints === null ? [] : [ hints ] )
        .concat( [ 'Finalisierungs-Checkliste', 'Ancillary Files', 'Rollout-Entry-Points', 'Lessons-Learned' ] )

    return head.concat( sections.map( ( heading ) => `## ${ heading }\n\nInhalt.\n` ) ).join( '\n' )
}


// A numbered chapter carrying the contract blocks handed in — the apparatus of the counting cases.
function chapterWith( { number, title, headings } ) {
    return [ `## ${ number }. ${ title } [Code]`, '' ]
        .concat( headings.map( ( heading ) => `### ${ heading }\n\nInhalt.\n` ) )
        .join( '\n' )
}


function codesOf( { entries } ) {
    return entries.map( ( entry ) => entry.split( ' ' )[ 0 ].replace( /[^A-Z0-9-]/g, '' ) )
}


function warn040( { result } ) {
    return result[ 'warnings' ].filter( ( entry ) => entry.includes( 'WARN-040' ) === true )
}


describe( 'PRD-39 — chapter contract and schema transition', () => {
    let client

    beforeAll( async () => {
        client = await readEmittedScript()
    } )


    // ---- T-A / T-B / T-D: the register entry, in both directions ----
    it( 'T-A: the register recognises "Abhaengigkeiten" as the generated field `dependencies`', () => {
        const verdict = BlockSections.match( { text: 'Abhaengigkeiten' } )

        expect( verdict.matched ).toBe( true )
        expect( verdict.field ).toBe( 'dependencies' )
        expect( verdict.kind ).toBe( 'generated' )
        expect( verdict.heading ).toBe( 'Abhaengigkeiten' )

        // Before this PRD every one of these four lines was false — the 242 headings in the stock were
        // invisible to the parser, to the collapse pass and to every count.
        expect( BlockSections.match( { text: 'Abhaengigkeiten: die Kanten' } ).field ).toBe( 'dependencies' )
    } )

    it( 'T-B: "PRD-Zuordnung" stays recognised — 411 headings in the stock must not go dark', () => {
        const verdict = BlockSections.match( { text: 'PRD-Zuordnung' } )

        expect( verdict.matched ).toBe( true )
        expect( verdict.field ).toBe( 'prdAssignment' )
        expect( verdict.kind ).toBe( 'generated' )

        // VAKUUM-RIEGEL against a rename accident: an invented heading must NOT resolve, or the two
        // assertions above would pass for a recogniser that recognises everything.
        expect( BlockSections.match( { text: 'Zustaendigkeiten' } ).matched ).toBe( false )
    } )

    it( 'T-C: the contract carries 8 headings, WITHOUT PRD-Zuordnung and WITH Abhaengigkeiten', () => {
        const { contract } = BlockSections.chapterContract()
        const headings = contract.map( ( entry ) => entry.heading )

        expect( headings ).toEqual( [
            'Kontext', 'User-Auftrag', 'Ist-Zustand', 'Soll-Zustand',
            'Belege', 'Topics', 'Work-Items', 'Abhaengigkeiten'
        ] )
        expect( headings ).not.toContain( 'PRD-Zuordnung' )
        expect( contract.filter( ( entry ) => entry.repeatable === true ).map( ( entry ) => entry.heading ) )
            .toEqual( [ 'Soll-Zustand' ] )
    } )

    it( 'T-D: every contract heading resolves, and the load-time gate throws on one that does not', () => {
        const { contract } = BlockSections.chapterContract()
        const registered = contract.filter( ( entry ) => entry.registered === true )
        const unresolved = registered
            .filter( ( entry ) => BlockSections.match( { text: entry.heading } ).matched !== true )

        expect( unresolved ).toEqual( [] )
        expect( registered.length ).toBe( 7 )

        // The measured exception, named rather than hidden: `### Kontext` is a MANDATORY contract block
        // that the register does not carry. It cannot be added here — as a writable entry it would shift
        // the persisted block_section.sort ordinal of ten sections, as `generated` it would make the
        // write path refuse a hand-written section. The gate holds the exception to exactly this one.
        expect( contract.filter( ( entry ) => entry.registered !== true ).map( ( entry ) => entry.heading ) )
            .toEqual( [ 'Kontext' ] )

        expect( BlockSections.assertChapterContract() )
            .toEqual( { ok: true, checked: 8, registered: 7, exceptions: 1, register: 19 } )
        expect( BlockSections.matchContract( { text: 'Kontext' } ).matched ).toBe( true )
    } )

    it( 'T-D positive control: an invented contract heading breaks the IMPORT, not a later read', async () => {
        // A gate asserted only through its own green return value is indistinguishable from no gate. So
        // the module is really mutated and really imported: the register source is copied out of THIS
        // repo into a temp dir, one bogus contract entry is injected, and the import must throw. Without
        // this case the assertions above would also pass for a gate that never fires.
        const source = await readFile( resolve( HERE, '..', '..', 'src', 'BlockSections.mjs' ), 'utf8' )
        const marker = "    { heading: 'Kontext', required: true, repeatable: false, registered: false },"

        expect( source ).toContain( marker )

        const dir = await mkdtemp( join( tmpdir(), 'prd39-gate-' ) )
        const broken = join( dir, 'BlockSections.mjs' )
        await writeFile( broken, source.replace( marker, marker + "\n    { heading: 'Erfundene-Sektion', required: true, repeatable: false, registered: true }," ) )

        await expect( import( pathToFileURL( broken ).href ) ).rejects.toThrow( /assertChapterContract/ )

        // GEGENPROBE from the same apparatus: the UNMUTATED copy, written and imported the same way,
        // loads cleanly — so the rejection above is the injected entry and not the copying.
        const intact = join( dir, 'Intact.mjs' )
        await writeFile( intact, source )
        const reloaded = await import( pathToFileURL( intact ).href )

        expect( reloaded.BlockSections.chapterContract().contract.length ).toBe( 8 )

        await rm( dir, { recursive: true, force: true } )
    } )

    it( 'T-E: the new entry moves no persisted ordinal — 14 writable fields, [0,1,2,3] unchanged', () => {
        const { fields } = BlockSections.writableFields()

        expect( fields.length ).toBe( 14 )
        expect( fields ).not.toContain( 'dependencies' )
        expect( [ 'factualAccount', 'assessment', 'solution', 'openQuestions' ]
            .map( ( field ) => BlockSections.sortOf( { field } ).sort ) ).toEqual( [ 0, 1, 2, 3 ] )
        expect( () => BlockSections.sortOf( { field: 'dependencies' } ) ).toThrow( /not a writable block section/ )
        expect( BlockSections.assertSortOrder() ).toEqual( { ok: true, checked: 14, established: 4 } )
    } )


    // ---- T-F / T-G: WI-120, the document-level transition ----
    it( 'T-F: "## Phasen" raises no MEMO-001, "## Abhaengigkeiten" raises none — and absence does', () => {
        const withOld = MemoValidator.validate( {
            doc: documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } ), fileName: 'REV-01.md'
        } )
        const withNew = MemoValidator.validate( {
            doc: documentWith( { dependencies: 'Abhaengigkeiten', hints: 'Abhaengigkeits-Hinweise' } ), fileName: 'REV-01.md'
        } )
        const withNeither = MemoValidator.validate( {
            doc: documentWith( { dependencies: null, hints: null } ), fileName: 'REV-01.md'
        } )

        expect( withOld[ 'messages' ].filter( ( entry ) => entry.includes( 'MEMO-001' ) ) ).toEqual( [] )
        expect( withNew[ 'messages' ].filter( ( entry ) => entry.includes( 'MEMO-001' ) ) ).toEqual( [] )

        // POSITIV-KONTROLLE: without EITHER spelling the code must fire — twice, once per position.
        // Without this line "0 errors" cannot be told apart from "the validator stopped reporting".
        expect( withNeither[ 'messages' ].filter( ( entry ) => entry.includes( 'MEMO-001' ) ).length ).toBe( 2 )
        expect( withNeither[ 'status' ] ).toBe( false )
    } )

    it( 'T-G: both umlaut spellings are accepted at the document level', () => {
        const umlaut = MemoValidator.validate( {
            doc: documentWith( { dependencies: 'Abhängigkeiten', hints: 'Abhängigkeits-Hinweise' } ), fileName: 'REV-01.md'
        } )
        const mixed = MemoValidator.validate( {
            doc: documentWith( { dependencies: 'Phasen', hints: 'Abhaengigkeits-Hinweise' } ), fileName: 'REV-01.md'
        } )

        expect( umlaut[ 'messages' ].filter( ( entry ) => entry.includes( 'MEMO-001' ) ) ).toEqual( [] )
        expect( mixed[ 'messages' ].filter( ( entry ) => entry.includes( 'MEMO-001' ) ) ).toEqual( [] )

        // The block-level register deliberately does NOT fold umlauts — measured 0 occurrences of
        // `### Abhängigkeiten` in the stock against 242 of `### Abhaengigkeiten`. The decision is held
        // here so that changing it later is a visible edit rather than a silent widening.
        expect( BlockSections.match( { text: 'Abhängigkeiten' } ).matched ).toBe( false )
        expect( BlockSections.match( { text: 'Abhaengigkeiten' } ).matched ).toBe( true )
    } )


    // ---- T-H / T-I / T-J / T-K / T-L: the counting ----
    it( 'T-H: the count is a set difference and names the missing block', () => {
        const complete = [ 'Kontext', 'User-Auftrag', 'Ist-Zustand', 'Soll-Zustand', 'Belege', 'Topics', 'Work-Items', 'Abhaengigkeiten' ]
        const twoComplete = documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } )
            + '\n' + chapterWith( { number: 1, title: 'Erstes', headings: complete } )
            + '\n' + chapterWith( { number: 2, title: 'Zweites', headings: complete } )
        const oneShort = documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } )
            + '\n' + chapterWith( { number: 1, title: 'Erstes', headings: complete } )
            + '\n' + chapterWith( { number: 2, title: 'Zweites', headings: complete.filter( ( entry ) => entry !== 'Belege' ) } )

        const clean = warn040( { result: MemoValidator.validate( { doc: twoComplete, fileName: 'REV-01.md' } ) } )
        const short = warn040( { result: MemoValidator.validate( { doc: oneShort, fileName: 'REV-01.md' } ) } )

        expect( clean ).toEqual( [] )
        expect( short.length ).toBe( 1 )
        expect( short[ 0 ] ).toContain( 'chapters=2' )
        expect( short[ 0 ] ).toContain( 'blocks=8' )
        expect( short[ 0 ] ).toContain( 'expected=16' )
        expect( short[ 0 ] ).toContain( 'found=15' )
        expect( short[ 0 ] ).toContain( 'missing=1' )
        expect( short[ 0 ] ).toContain( 'Belege' )
        expect( short[ 0 ] ).toContain( 'Zweites' )
    } )

    it( 'T-I: a document without numbered chapters reports RED, not a silent pass', () => {
        const noChapters = MemoValidator.validate( {
            doc: documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } ), fileName: 'REV-01.md'
        } )
        const oneChapter = MemoValidator.validate( {
            doc: documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } )
                + '\n' + chapterWith( { number: 1, title: 'Erstes', headings: [ 'Kontext', 'User-Auftrag', 'Ist-Zustand', 'Soll-Zustand', 'Belege', 'Topics', 'Work-Items', 'Abhaengigkeiten' ] } ),
            fileName: 'REV-01.md'
        } )

        const vacuum = warn040( { result: noChapters } )

        expect( vacuum.length ).toBe( 1 )
        expect( vacuum[ 0 ] ).toContain( 'chapters=0' )
        expect( vacuum[ 0 ] ).toContain( 'red, not green' )

        // The GEGENSTUECK from the same apparatus: with one complete chapter the very same check is
        // silent. Without this line the case would also pass for a check that always reports.
        expect( warn040( { result: oneChapter } ) ).toEqual( [] )
    } )

    it( 'T-J: a qualified heading counts, a longer word does not — prefix, not equality', () => {
        expect( BlockSections.matchContract( { text: 'Soll-Zustand: der Werkzeugkoffer' } ).heading ).toBe( 'Soll-Zustand' )
        expect( BlockSections.matchContract( { text: 'Soll-Zustandsbericht' } ).matched ).toBe( false )

        const qualified = [ 'Kontext', 'User-Auftrag', 'Ist-Zustand', 'Soll-Zustand: ein Aspekt', 'Belege', 'Topics', 'Work-Items', 'Abhaengigkeiten' ]
        const bogus = [ 'Kontext', 'User-Auftrag', 'Ist-Zustand', 'Soll-Zustandsbericht', 'Belege', 'Topics', 'Work-Items', 'Abhaengigkeiten' ]
        const head = documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } )

        expect( warn040( { result: MemoValidator.validate( { doc: head + '\n' + chapterWith( { number: 1, title: 'A', headings: qualified } ), fileName: 'REV-01.md' } ) } ) ).toEqual( [] )
        expect( warn040( { result: MemoValidator.validate( { doc: head + '\n' + chapterWith( { number: 1, title: 'A', headings: bogus } ), fileName: 'REV-01.md' } ) } )[ 0 ] )
            .toContain( 'Soll-Zustand' )
    } )

    it( 'T-K: the count does not run for prepare and update', () => {
        const body = '\n## 1. Erstes [Code]\n\nkein einziger Vertrags-Baustein.\n'
        const prepare = MemoValidator.validate( {
            doc: '| **Memo** | 099 |\n| **Geplante Revision** | REV-02 |\n\n## Interpretation des Feedbacks\n\nx\n\n## Geplante Änderungen pro Kapitel\n\nx\n\n## Revisions-Blocker\n\nx\n' + body,
            fileName: 'REV-02-prepare.md'
        } )
        const update = MemoValidator.validate( {
            doc: '| **Memo** | 099 |\n| **Memo-Name** | P |\n| **Revision** | REV-02 |\n| **Datum** | 2026-09-08 |\n| **Status** | Entwurf |\n\n## Offene Fragen\n\nx\n\n## Beantwortete Fragen\n\nx\n' + body,
            fileName: 'REV-02-update.md'
        } )

        expect( prepare[ 'revisionType' ] ).toBe( 'prepare' )
        expect( update[ 'revisionType' ] ).toBe( 'update' )
        expect( warn040( { result: prepare } ) ).toEqual( [] )
        expect( warn040( { result: update } ) ).toEqual( [] )

        // GEGENPROBE: the identical chapter under `full` DOES produce the finding, so the two zeros above
        // are the schema switch and not a check that never fires.
        const full = MemoValidator.validate( {
            doc: documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } ) + body, fileName: 'REV-01.md'
        } )

        expect( warn040( { result: full } ).length ).toBe( 1 )
    } )

    it( 'T-L: the finding lands in warnings, never in messages, and status stays true', () => {
        const result = MemoValidator.validate( {
            doc: documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } ) + '\n## 1. Erstes [Code]\n\nleer.\n',
            fileName: 'REV-01.md'
        } )

        expect( warn040( { result } ).length ).toBe( 1 )
        expect( result[ 'messages' ].filter( ( entry ) => entry.includes( 'WARN-040' ) ) ).toEqual( [] )
        expect( result[ 'info' ].filter( ( entry ) => entry.includes( 'WARN-040' ) ) ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
        expect( codesOf( { entries: result[ 'messages' ] } ) ).toEqual( [] )
    } )


    // ---- T-M / T-N: the two derived copies ----
    it( 'T-M: RevisionFormScore derives its contract list — counted, not typed out', () => {
        const { contract } = BlockSections.chapterContract()
        const mandatory = contract.filter( ( entry ) => entry.required === true )
        const complete = [ 'Kontext', 'User-Auftrag', 'Ist-Zustand', 'Soll-Zustand', 'Belege', 'Topics', 'Work-Items', 'Abhaengigkeiten' ]
        const doc = documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } )
            + '\n' + chapterWith( { number: 1, title: 'Erstes', headings: complete } )
        const withoutDependencies = documentWith( { dependencies: 'Phasen', hints: 'Phase-Hints' } )
            + '\n' + chapterWith( { number: 1, title: 'Erstes', headings: complete.filter( ( entry ) => entry !== 'Abhaengigkeiten' ) } )

        const full = RevisionFormScore.score( { doc, fileName: 'REV-01.md' } )
        const short = RevisionFormScore.score( { doc: withoutDependencies, fileName: 'REV-01.md' } )

        // K8 is the contracted share. A chapter carrying every mandatory block scores 100, one missing
        // `### Abhaengigkeiten` scores 0 — which is the whole point: before this PRD the same chapter
        // would have had to carry `### PRD-Zuordnung` instead.
        expect( full[ 'metrics' ][ 'K8' ][ 'numerator' ] ).toBe( 1 )
        expect( short[ 'metrics' ][ 'K8' ][ 'numerator' ] ).toBe( 0 )

        // The list is DERIVED: its length is held against the contract, never against a typed 8.
        expect( mandatory.length ).toBe( 8 )
        expect( mandatory.map( ( entry ) => entry.heading ) ).toContain( 'Abhaengigkeiten' )
        expect( mandatory.map( ( entry ) => entry.heading ) ).not.toContain( 'PRD-Zuordnung' )
    } )

    it( 'T-N: the browser literal carries 20 labels and IS the register list', () => {
        const line = client.split( '\n' )
            .find( ( entry ) => entry.trim().startsWith( 'var BLOCK_BODY_HEADINGS = [' ) )

        expect( line ).toBeDefined()

        const declared = JSON.parse( line.slice( line.indexOf( '[' ) ).replace( /'/g, '"' ) )
        const { labels } = BlockSections.labels()

        expect( declared.length ).toBe( 20 )
        expect( declared ).toEqual( labels )
        expect( declared ).toContain( 'abhaengigkeiten' )
        expect( declared ).toContain( 'prd-zuordnung' )

        // GEGENPROBE: an artificially removed entry must break the comparison, or `toEqual` above would
        // also pass for two lists nobody compared.
        expect( declared.filter( ( entry ) => entry !== 'abhaengigkeiten' ) ).not.toEqual( labels )
    } )


    it( 'the client script was read from this repo and is not empty', () => {
        expect( existsSync( CLIENT_PATH ) ).toBe( true )
        expect( basename( CLIENT_PATH ) ).toBe( 'app.client.mjs' )
        expect( client.length ).toBeGreaterThan( 1000 )
    } )
} )
