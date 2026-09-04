import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { readEmittedScript, extractFunctionSources } from '../helpers/extractFunction.mjs'
import { BlockSections, KINDS, SUFFIX_SEPARATORS } from '../../src/BlockSections.mjs'
import { BlockMeta } from '../../src/BlockMeta.mjs'
import { MemoView } from '../../src/MemoView.mjs'


// Memo 080, PRD-B1 (REV-18 Kap 2): the toolkit of block headings is ONE closed register, and the three
// places that used to keep their own copy read from it — the parser (BlockMeta), the display mirror
// (MemoView.isBlockBodyHeading) and the browser list (app.client.mjs BLOCK_BODY_HEADINGS).
//
// THIS SUITE IS THE THING THAT MAKES THE UNIFICATION HOLD. The three lists had ALREADY drifted before
// this PRD: the browser carried the legacy alias "problem-beschreibung" while the parser's canonical
// name was "Faktenlage", and nothing compared them. Every case here states HOW MUCH it compared; a
// comparison basis of 0 is asserted RED, never reported as a green zero.
//
// Two cases reach OUTSIDE this repository (the workbench .memo/ tree and the core repo). CI checks
// this repo out alone, so they are guarded with existsSync and SKIPPED with a reason — never silently
// passed. Everything else is repo-local and always runs.
const HERE = dirname( fileURLToPath( import.meta.url ) )
const CORE_REGISTER = resolve( HERE, '..', '..', '..', 'core', 'cli', 'src', 'BlockSections.mjs' )
const MEMO_ROOT = resolve( HERE, '..', '..', '..', '..', '.memo', 'memos' )
const REAL_REV18 = join( MEMO_ROOT, '080-db-vollausbau-und-laufzeit-transparenz', 'revisions', 'REV-18.md' )
const withCore = existsSync( CORE_REGISTER ) ? it : it.skip
const withTree = existsSync( REAL_REV18 ) ? it : it.skip


// The declared shape of the register, written out in FULL. The core repo carries the same table in its
// own suite: a change on either side turns that side's own suite red, so the two copies cannot drift
// even where the other repo is absent (M10 — the viewer does not depend on memo-cli).
const EXPECTED = [
    [ 'userMandate', 'User-Auftrag', 'required', [] ],
    [ 'currentState', 'Ist-Zustand', 'required', [] ],
    [ 'targetState', 'Soll-Zustand', 'required', [] ],
    [ 'assessment', 'Bewertung', 'optional', [] ],
    [ 'delimitation', 'Abgrenzung', 'optional', [] ],
    [ 'decision', 'Entscheidung', 'optional', [] ],
    [ 'measurement', 'Messung', 'optional', [] ],
    [ 'example', 'Beispiel', 'optional', [] ],
    [ 'risk', 'Risiko', 'optional', [] ],
    [ 'counterArgument', 'Gegenargument', 'optional', [] ],
    [ 'openItems', 'Offene Punkte', 'optional', [] ],
    [ 'topics', 'Topics', 'generated', [] ],
    [ 'workItems', 'Work-Items', 'generated', [] ],
    [ 'prdAssignment', 'PRD-Zuordnung', 'generated', [] ],
    [ 'evidence', 'Belege', 'generated', [] ],
    [ 'factualAccount', 'Faktenlage', 'legacy', [ 'Problem-Beschreibung' ] ],
    [ 'solution', 'Loesungsansatz', 'legacy', [] ],
    [ 'openQuestions', 'Offene Fragen', 'legacy', [] ]
]

// The three labels the browser list carried BEFORE this PRD. They are the reference value of the
// "nothing that was visible disappears" check — not a new source of truth.
const PRE_PRD_LABELS = [ 'problem-beschreibung', 'loesungsansatz', 'offene fragen' ]

// The state of BlockMeta.parse over the eleven revisions with ```block-meta fences, MEASURED on the
// tree BEFORE the parser was switched to the register (11 files, 89 blocks). The digest covers the
// four old fields of every block of every file; if the switch had changed any of them by one
// character it would not match.
const PRE_PRD_PARSE = {
    files: 11,
    blocks: 89,
    perFile: [
        [ '015-requirements-kuration-cross-memo-scoring/REV-02.md', 5 ],
        [ '016-memo-view-overhaul-rendering-der-4-conte/REV-01.md', 0 ],
        [ '072-interface-sichtbarkeit-spec-hygiene-und/REV-02-prepare.md', 0 ],
        [ '072-interface-sichtbarkeit-spec-hygiene-und/REV-02.md', 0 ],
        [ '072-interface-sichtbarkeit-spec-hygiene-und/REV-03.md', 0 ],
        [ '078-sop-und-skill-system-spezifikation-v4/REV-07.md', 13 ],
        [ '078-sop-und-skill-system-spezifikation-v4/REV-08.md', 13 ],
        [ '078-sop-und-skill-system-spezifikation-v4/REV-09.md', 13 ],
        [ '078-sop-und-skill-system-spezifikation-v4/REV-10.md', 15 ],
        [ '078-sop-und-skill-system-spezifikation-v4/REV-11.md', 15 ],
        [ '078-sop-und-skill-system-spezifikation-v4/REV-12.md', 15 ]
    ],
    digest: '58f386e27d88662d2832e62a13641b8e2fd56b786f8b677da5525abd923519d7'
}

const FENCE = /```block-meta\s*\n([\s\S]*?)\n```/g


// The literal array of a `var NAME = [ ... ]` one-liner in the client script, parsed back into a list.
// Reading the LINE (not a re-implementation of it) is what makes this a parity check.
function parseClientList( source, name ) {
    const line = source
        .split( '\n' )
        .find( ( entry ) => entry.trim().startsWith( 'var ' + name + ' = [' ) )
    if( line === undefined ) { throw new Error( 'client list not found: ' + name ) }
    const body = line.slice( line.indexOf( '[' ) )

    return JSON.parse( body.replace( /'/g, '"' ) )
}


// The H3 headings inside the NUMBERED chapters of a revision, code fences excluded — the same window
// M1 of the PRD was measured in.
function chapterHeadings( doc ) {
    const seed = { inChapter: false, inFence: false, chapters: 0, headings: [] }

    return doc.split( '\n' ).reduce( ( acc, line ) => {
        if( /^```/.test( line ) ) { acc.inFence = !acc.inFence; return acc }
        if( acc.inFence ) { return acc }
        if( /^##\s+\d+\.\s+/.test( line ) ) { acc.inChapter = true; acc.chapters += 1; return acc }
        if( /^##\s+/.test( line ) && !/^###/.test( line ) ) { acc.inChapter = false; return acc }
        if( acc.inChapter && /^###\s+/.test( line ) ) { acc.headings.push( line.replace( /^###\s+/, '' ).trim() ) }

        return acc
    }, seed )
}


// Every revision file under .memo/memos/*/revisions that carries a ```block-meta fence.
async function readFencedRevisions() {
    const memos = ( await readdir( MEMO_ROOT ).catch( () => [] ) ).sort()
    const files = ( await Promise.all( memos.map( async ( memo ) => {
        const dir = join( MEMO_ROOT, memo, 'revisions' )
        const entries = await readdir( dir ).catch( () => [] )

        return entries
            .filter( ( name ) => name.endsWith( '.md' ) )
            .map( ( name ) => ( { key: memo + '/' + name, path: join( dir, name ) } ) )
    } ) ) ).flat()

    const read = await Promise.all( files.map( async ( entry ) => {
        const doc = await readFile( entry.path, 'utf8' )

        return doc.includes( '```block-meta' ) ? { key: entry.key, doc } : null
    } ) )

    return read
        .filter( ( entry ) => entry !== null )
        .sort( ( a, b ) => a.key.localeCompare( b.key ) )
}


// A minimal DOM node with the surface hideBlockBodySections walks: classList, tagName, textContent and
// the nextElementSibling chain. Same approach as BlockViewPRD014 — there is no jsdom in this project
// (M11), so the traversal is driven against a shim instead of being asserted on source form alone.
function makeNode( tag, text, classes ) {
    const node = {
        tagName: String( tag ).toUpperCase(),
        textContent: text === undefined ? '' : text,
        nextElementSibling: null,
        _classes: new Set( classes === undefined ? [] : classes )
    }
    node.classList = {
        add: ( ...names ) => names.forEach( ( name ) => node._classes.add( name ) ),
        contains: ( name ) => node._classes.has( name )
    }

    return node
}


function chain( nodes ) {
    nodes.forEach( ( node, index ) => { node.nextElementSibling = index + 1 < nodes.length ? nodes[ index + 1 ] : null } )

    return nodes
}


describe( 'BlockSections register + the three lists derived from it — Memo 080 PRD-B1 (WI-184)', () => {
    let client = ''
    let clientIsBlockBodyHeading = null
    let clientHideBlockBodySections = null

    beforeAll( async () => {
        client = await readEmittedScript()

        // The client function is lifted WITH its two module-level lists, so what is exercised here is
        // the real browser code and the real literal lines — not a re-typed copy of them.
        const { source } = await extractFunctionSources( [ 'isBlockBodyHeading', 'headingLevel' ] )
        const lists = client
            .split( '\n' )
            .filter( ( line ) => line.trim().startsWith( 'var BLOCK_BODY_HEADINGS = [' ) || line.trim().startsWith( 'var BLOCK_BODY_SUFFIXES = [' ) )
            .join( '\n' )
        expect( lists.split( '\n' ).length ).toBe( 2 )
        clientIsBlockBodyHeading = new Function( lists + '\n' + source + '\nreturn isBlockBodyHeading' )()

        // The collapse pass itself, lifted with everything it walks. `contentEl` is the closure variable
        // it reads the cards from, so it is injected as a parameter — the rest is the real browser code.
        const pass = await extractFunctionSources( [ 'hideBlockBodySections', 'isBlockBodyHeading', 'headingLevel', 'hiddenSiblingsAfter' ] )
        clientHideBlockBodySections = new Function( 'contentEl', lists + '\n' + pass.source + '\nreturn hideBlockBodySections()' )
    } )


    // ---- the register itself ----
    describe( 'register', () => {
        it( 'is closed: 18 entries, counted per kind, compared entry for entry', () => {
            const { sections } = BlockSections.all()

            expect( sections.length ).toBe( EXPECTED.length )
            expect( sections.length ).toBeGreaterThan( 0 )
            expect( KINDS.map( ( kind ) => [ kind, sections.filter( ( entry ) => entry.kind === kind ).length ] ) )
                .toEqual( [ [ 'required', 3 ], [ 'optional', 8 ], [ 'generated', 4 ], [ 'legacy', 3 ] ] )
            expect( sections.map( ( entry ) => [ entry.field, entry.heading, entry.kind, entry.aliases ] ) ).toEqual( EXPECTED )
        } )

        it( 'carries no "Diagramm" heading — a diagram is a content form (REV-18 Z. 132)', () => {
            const labels = BlockSections.all().sections
                .flatMap( ( entry ) => [ entry.heading ].concat( entry.aliases ) )

            expect( labels.length ).toBe( 19 )
            expect( labels.filter( ( label ) => label.toLowerCase() === 'diagramm' ) ).toEqual( [] )
            expect( BlockSections.match( { text: 'Diagramm' } ).matched ).toBe( false )
        } )

        it( 'documentSections provides the 12 document-level sections in order (REV-18 Z. 158-172)', () => {
            const { sections } = BlockSections.documentSections()

            expect( sections.length ).toBe( 12 )
            expect( sections[ 0 ].section ).toBe( 'Kopf' )
            expect( sections[ 11 ].section ).toBe( 'Lessons-Learned' )
            expect( sections.filter( ( entry ) => entry.required !== true || !entry.source ).length ).toBe( 0 )
        } )
    } )


    // ---- parity: register <-> MemoView mirror <-> browser list ----
    describe( 'parity of the three lists', () => {
        it( 'the browser list IS the register label list, character for character', () => {
            const declared = parseClientList( client, 'BLOCK_BODY_HEADINGS' )
            const { labels } = BlockSections.labels()

            expect( labels.length ).toBe( 19 )
            expect( declared.length ).toBe( labels.length )
            expect( declared ).toEqual( labels )

            // GEGENPROBE: an artificially dropped entry MUST break the comparison. A parity check that
            // stays green under an injected divergence has compared nothing.
            expect( declared.slice( 1 ) ).not.toEqual( labels )
        } )

        it( 'the browser suffix list IS the register separator list', () => {
            const declared = parseClientList( client, 'BLOCK_BODY_SUFFIXES' )

            expect( declared.length ).toBe( 2 )
            expect( declared ).toEqual( SUFFIX_SEPARATORS )
            expect( declared.slice( 1 ) ).not.toEqual( SUFFIX_SEPARATORS )
        } )

        it( 'the browser function and MemoView.isBlockBodyHeading agree on every probe', () => {
            const { sections } = BlockSections.all()
            const positives = sections
                .flatMap( ( entry ) => [ entry.heading ].concat( entry.aliases ) )
                .flatMap( ( label ) => [ label, label.toUpperCase(), '  ' + label + '  ', label + ': Zusatz', label + ' (Zusatz)' ] )
            const negatives = [ 'Architektur', 'Zustand', 'Soll', 'Diagramm', '', 'Soll-Zustandsbericht', 'Offene' ]
            const probes = positives.concat( negatives )

            expect( probes.length ).toBeGreaterThan( 90 )

            const disagreements = probes
                .map( ( text ) => ( {
                    text,
                    server: MemoView.isBlockBodyHeading( { level: 3, text } ).isBlockBody,
                    browser: clientIsBlockBodyHeading( { tagName: 'H3', textContent: text } )
                } ) )
                .filter( ( row ) => row.server !== row.browser )
            expect( disagreements ).toEqual( [] )

            const missed = positives
                .filter( ( text ) => MemoView.isBlockBodyHeading( { level: 3, text } ).isBlockBody !== true )
            expect( missed ).toEqual( [] )
            const falsePositives = negatives
                .filter( ( text ) => MemoView.isBlockBodyHeading( { level: 3, text } ).isBlockBody === true )
            expect( falsePositives ).toEqual( [] )
        } )

        it( 'the canonical name is recognised where only the legacy alias used to be (M4)', () => {
            expect( MemoView.isBlockBodyHeading( { level: 3, text: 'Faktenlage' } ).isBlockBody ).toBe( true )
            expect( MemoView.isBlockBodyHeading( { level: 3, text: 'Bewertung' } ).isBlockBody ).toBe( true )
            expect( clientIsBlockBodyHeading( { tagName: 'H3', textContent: 'Faktenlage' } ) ).toBe( true )
            expect( clientIsBlockBodyHeading( { tagName: 'H3', textContent: 'Bewertung' } ) ).toBe( true )
        } )

        it( 'the reach is unchanged: level 3 only, and only inside a .block-meta-card region', () => {
            // Level: everything but 3 stays untouched, on both sides.
            const levels = [ 1, 2, 4, 5, 6 ]
            const leaked = levels
                .filter( ( level ) => MemoView.isBlockBodyHeading( { level, text: 'Faktenlage' } ).isBlockBody === true )
            expect( leaked ).toEqual( [] )
            expect( clientIsBlockBodyHeading( { tagName: 'H2', textContent: 'Faktenlage' } ) ).toBe( false )
            expect( clientIsBlockBodyHeading( { tagName: 'DIV', textContent: 'Faktenlage' } ) ).toBe( false )

            // Region: the collapse still starts from the cards and from nothing else (M11 — no jsdom, so
            // the boundary is asserted on the source form, exactly as PRD-015 already did).
            expect( client ).toContain( 'function hideBlockBodySections(' )
            expect( client ).toContain( "var cards = contentEl.querySelectorAll( '.block-meta-card' )" )
            expect( client ).toContain( "if( node.classList && node.classList.contains( 'block-meta-card' ) ) { return }" )
            expect( client ).toContain( 'if( headingLevel( node ) === 2 ) { return }' )
        } )

        it( 'the collapse pass marks ONLY inside a card and ONLY at level 3 — walked, not argued', () => {
            // Card region: card -> H3 Ist-Zustand -> P -> H3 Soll-Zustand: die Regel -> P -> H2 (stop)
            // Outside: H3 Ist-Zustand (same text!) and an H2 Faktenlage — neither may be marked.
            const insideHeadingA = makeNode( 'H3', 'Ist-Zustand' )
            const insideBodyA = makeNode( 'P', 'gemessen' )
            const insideHeadingB = makeNode( 'H3', 'Soll-Zustand: die Regel' )
            const insideBodyB = makeNode( 'P', 'daraus folgt' )
            const insideProse = makeNode( 'H3', 'Architektur' )
            const stop = makeNode( 'H2', 'Naechstes Kapitel' )
            const outsideHeading = makeNode( 'H3', 'Ist-Zustand' )
            const outsideH2 = makeNode( 'H2', 'Faktenlage' )
            const card = makeNode( 'DIV', '', [ 'block-meta-card' ] )
            chain( [ card, insideHeadingA, insideBodyA, insideHeadingB, insideBodyB, insideProse, stop, outsideHeading, outsideH2 ] )

            clientHideBlockBodySections( { querySelectorAll: ( selector ) => ( selector === '.block-meta-card' ? [ card ] : [] ) } )

            const marked = [ insideHeadingA, insideBodyA, insideHeadingB, insideBodyB, insideProse, stop, outsideHeading, outsideH2 ]
                .filter( ( node ) => node.classList.contains( 'block-body-hidden' ) )
            expect( marked ).toEqual( [ insideHeadingA, insideBodyA, insideHeadingB, insideBodyB ] )
            expect( marked.length ).toBe( 4 )
            expect( outsideHeading.classList.contains( 'block-body-hidden' ) ).toBe( false )
            expect( outsideH2.classList.contains( 'block-body-hidden' ) ).toBe( false )
            expect( insideProse.classList.contains( 'block-body-hidden' ) ).toBe( false )
            expect( stop.classList.contains( 'block-body-hidden' ) ).toBe( false )
        } )

        it( 'the block-detail modal renders the register fields, not four hand-typed names', () => {
            const declared = parseClientList( client, 'BLOCK_DETAIL_SECTIONS' )
            const { fields } = BlockSections.writableFields()

            expect( declared.length ).toBe( fields.length )
            expect( declared.map( ( entry ) => entry[ 0 ] ).sort() ).toEqual( fields.slice().sort() )
            // The four rows the modal has always shown keep rendering unconditionally.
            expect( declared.filter( ( entry ) => entry[ 3 ] === 'always' ).map( ( entry ) => entry[ 0 ] ) )
                .toEqual( [ 'factualAccount', 'assessment', 'solution', 'openQuestions' ] )
            const labels = declared.map( ( entry ) => entry[ 2 ] )
            const wrongLabel = declared
                .filter( ( entry ) => BlockSections.byField( { field: entry[ 0 ] } ).section.heading !== entry[ 2 ] )
            expect( wrongLabel ).toEqual( [] )
            expect( labels.length ).toBe( 14 )
        } )
    } )


    // ---- the parser is additive ----
    describe( 'parser', () => {
        it( 'fills the new fields and keeps the four old ones', () => {
            const doc = [
                '## Kapitel', '', '```block-meta', '{ "topics": ["T012"], "prds": ["PRD-001"] }', '```', '',
                '### Ist-Zustand', '', 'Gemessen.', '',
                '### Soll-Zustand: die Regel', '', 'Daraus folgt.', '',
                '### Problem-Beschreibung', '', 'Alt.', ''
            ].join( '\n' )
            const { blocks } = BlockMeta.parse( { doc } )

            expect( blocks.length ).toBe( 1 )
            expect( blocks[ 0 ].currentState ).toBe( 'Gemessen.' )
            expect( blocks[ 0 ].targetState ).toBe( 'Daraus folgt.' )
            expect( blocks[ 0 ].factualAccount ).toBe( 'Alt.' )
            expect( blocks[ 0 ].topics ).toEqual( [ 'T012' ] )
        } )

        it( 'exposes EVERY writable register field as a flat key and all 18 under sections', () => {
            const doc = [ '## K', '', '```block-meta', '{ "topics": ["T001"] }', '```', '', '### Bewertung', '', 'B', '' ].join( '\n' )
            const { blocks } = BlockMeta.parse( { doc } )
            const { fields } = BlockSections.writableFields()

            const missing = fields
                .filter( ( field ) => Object.prototype.hasOwnProperty.call( blocks[ 0 ], field ) !== true )
            expect( missing ).toEqual( [] )
            expect( fields.length ).toBe( 14 )
            expect( Object.keys( blocks[ 0 ].sections ).length ).toBe( 18 )
            // The fence's own topics axis is NOT overwritten by the generated section of the same name.
            expect( blocks[ 0 ].topics ).toEqual( [ 'T001' ] )
            expect( blocks[ 0 ].sections.topics ).toBe( null )
        } )
    } )


    // The PERSISTED ordinal of a block section (`block_section.sort`). The viewer only READS that column
    // (DoltDbAssembler orders by it), but it carries the register as a copy, so the ordinal has to be the
    // same one on this side — a mirror that agreed on the headings and disagreed on the order would be the
    // very drift M4 already produced once. It is DELIBERATELY NOT the register index: deriving it that way
    // moved factualAccount from 0 to 11 while assessment moved from 1 to 3, which reverses the documented
    // "facts before judgment" order (Memo 053 Kap 8) and disagrees with every row an older database holds.
    it( 'the persisted ordinal keeps the established sections on their stored positions', () => {
        const { fields } = BlockSections.sortOrder()
        const writable = BlockSections.writableFields().fields

        expect( fields.length ).toBeGreaterThan( 0 )
        expect( fields.length ).toBe( writable.length )
        expect( fields.slice().sort() ).toEqual( writable.slice().sort() )
        expect( fields.slice( 0, 4 ) ).toEqual( [ 'factualAccount', 'assessment', 'solution', 'openQuestions' ] )

        const ordinals = [ 'factualAccount', 'assessment', 'solution', 'openQuestions' ]
            .map( ( field ) => BlockSections.sortOf( { field } ).sort )
        expect( ordinals ).toEqual( [ 0, 1, 2, 3 ] )
        // the counter-probe: register index and persisted ordinal are two different answers
        expect( writable.indexOf( 'factualAccount' ) ).toBe( 11 )
        expect( BlockSections.assertSortOrder() ).toEqual( { ok: true, checked: writable.length, established: 4 } )
        expect( () => BlockSections.sortOf( { field: 'topics' } ) ).toThrow( /not a writable block section/ )
    } )


    // ---- the two cross-boundary cases ----
    withCore( 'the viewer register and the core register are byte-identical below the header', async () => {
        const mirror = await import( CORE_REGISTER )
        const here = BlockSections.all().sections
        const there = mirror.BlockSections.all().sections

        expect( here.length ).toBeGreaterThan( 0 )
        expect( there ).toEqual( here )
        expect( there.slice( 1 ) ).not.toEqual( here )
        expect( mirror.SUFFIX_SEPARATORS ).toEqual( SUFFIX_SEPARATORS )

        const [ coreSource, viewerSource ] = await Promise.all( [
            readFile( CORE_REGISTER, 'utf8' ),
            readFile( resolve( HERE, '..', '..', 'src', 'BlockSections.mjs' ), 'utf8' )
        ] )
        const marker = 'const KINDS = ['
        const coreBody = coreSource.slice( coreSource.indexOf( marker ) )
        const viewerBody = viewerSource.slice( viewerSource.indexOf( marker ) )
        expect( coreBody.length ).toBeGreaterThan( 100 )
        expect( viewerBody ).toBe( coreBody )
    } )


    withTree( 'the register recognises all 146 third-level headings of the real REV-18 (M1)', async () => {
        const doc = await readFile( REAL_REV18, 'utf8' )
        const { chapters, headings } = chapterHeadings( doc )

        expect( headings.length ).toBeGreaterThan( 0 )

        const verdicts = headings.map( ( text ) => BlockSections.match( { text } ) )
        const verbatim = verdicts.filter( ( v ) => v.matched && v.suffix === null && v.kind !== 'generated' ).length
        const suffixed = verdicts.filter( ( v ) => v.matched && v.suffix !== null ).length
        const generated = verdicts.filter( ( v ) => v.matched && v.kind === 'generated' ).length
        const unrecognised = headings.filter( ( text, index ) => verdicts[ index ].matched !== true )

        expect( { chapters, headings: headings.length, verbatim, suffixed, generated, unrecognised: unrecognised.length } )
            .toEqual( { chapters: 25, headings: 146, verbatim: 70, suffixed: 26, generated: 50, unrecognised: 0 } )
        expect( verbatim + suffixed + generated ).toBe( headings.length )
    } )


    withTree( 'the eleven fenced revisions parse EXACTLY as they did before the switch (M9)', async () => {
        const revisions = await readFencedRevisions()

        expect( revisions.length ).toBeGreaterThan( 0 )
        expect( revisions.length ).toBe( PRE_PRD_PARSE.files )

        const rows = revisions.map( ( entry ) => {
            const { blocks, errors } = BlockMeta.parse( { doc: entry.doc } )

            return {
                key: entry.key,
                blocks: blocks.length,
                errors: errors.length,
                body: blocks.map( ( block ) => ( {
                    factualAccount: block.factualAccount === undefined ? null : block.factualAccount,
                    assessment: block.assessment === undefined ? null : block.assessment,
                    solution: block.solution === undefined ? null : block.solution,
                    openQuestions: block.openQuestions === undefined ? null : block.openQuestions
                } ) )
            }
        } )

        expect( rows.map( ( row ) => [ row.key, row.blocks ] ) ).toEqual( PRE_PRD_PARSE.perFile )
        expect( rows.reduce( ( acc, row ) => acc + row.blocks, 0 ) ).toBe( PRE_PRD_PARSE.blocks )
        expect( createHash( 'sha256' ).update( JSON.stringify( rows ) ).digest( 'hex' ) ).toBe( PRE_PRD_PARSE.digest )
    } )


    // Beleg 2.7, the trap this PRD is about: a wider heading set must not make anything DISAPPEAR that
    // was visible before. Measured over the real corpus, region by region — not argued.
    withTree( 'no heading that was visible before is hidden now (Beleg 2.7)', async () => {
        const revisions = await readFencedRevisions()
        const regions = revisions.flatMap( ( entry ) => {
            const matches = [ ...entry.doc.matchAll( FENCE ) ]

            return matches.map( ( match ) => {
                const after = entry.doc.slice( match.index + match[ 0 ].length )
                const nextChapter = after.search( /^##\s+/m )
                const nextFence = after.search( /```block-meta/ )
                const bounds = [ nextChapter, nextFence ].filter( ( index ) => index >= 0 )

                return after.slice( 0, bounds.length === 0 ? after.length : Math.min( ...bounds ) )
            } )
        } )
        const headings = regions
            .flatMap( ( region ) => region.split( '\n' ).filter( ( line ) => /^###\s+/.test( line ) ) )
            .map( ( line ) => line.replace( /^###\s+/, '' ).trim() )

        expect( regions.length ).toBeGreaterThan( 0 )
        expect( headings.length ).toBeGreaterThan( 0 )

        const before = headings.filter( ( text ) => PRE_PRD_LABELS.indexOf( text.toLowerCase() ) !== -1 )
        const after = headings.filter( ( text ) => MemoView.isBlockBodyHeading( { level: 3, text } ).isBlockBody === true )
        const vanished = before.filter( ( text ) => after.indexOf( text ) === -1 )

        expect( vanished ).toEqual( [] )
        expect( { regions: regions.length, headings: headings.length, hiddenBefore: before.length, hiddenAfter: after.length } )
            .toEqual( { regions: 89, headings: 6, hiddenBefore: 3, hiddenAfter: 3 } )
    } )
} )
