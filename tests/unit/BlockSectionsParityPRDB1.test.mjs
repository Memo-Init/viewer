import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'

import { readEmittedScript, extractFunctionSources, sliceDeclaration } from '../helpers/extractFunction.mjs'
import { makeNode, makeRoot, makeDocument } from '../helpers/domSurrogate.mjs'
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

// Memo 081, PRD-39: WHICH core register this compares against was never a question while the two trees
// were identical — and it became one the moment a rollout changed the register in a WORKTREE. HERE is
// tests/unit of repos/viewer-wt-081, and '..','..','..','core' resolved to repos/core — the MAIN TREE,
// on main, not the branch this test's own code is on. The comparison would have been red by
// construction, and the reason would have looked like a broken register instead of a broken path.
//
// The rule is not "add repos/core-wt-081 too". It is: a test that reads ACROSS the repo boundary reads
// the boundary that belongs to ITS OWN tree. The sibling is derived from this tree's own directory name
// and the plain name is the fallback — and the case NAMES the file it compared, so a comparison can
// never again be green about a stand nobody asked for.
function coreRegisterCandidates( { viewerRoot } ) {
    const name = basename( viewerRoot )
    const suffix = name.startsWith( 'viewer' ) === true ? name.slice( 'viewer'.length ) : ''
    const names = [ 'core' + suffix, 'core' ]
        .filter( ( entry, index, all ) => all.indexOf( entry ) === index )

    return names
        .map( ( entry ) => resolve( viewerRoot, '..', entry, 'cli', 'src', 'BlockSections.mjs' ) )
}


const VIEWER_ROOT = resolve( HERE, '..', '..' )
const CORE_CANDIDATES = coreRegisterCandidates( { viewerRoot: VIEWER_ROOT } )
const CORE_REGISTER = CORE_CANDIDATES.find( ( candidate ) => existsSync( candidate ) ) ?? CORE_CANDIDATES[ CORE_CANDIDATES.length - 1 ]
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
    // Memo 081, PRD-39 / WI-116: the 19th entry. It is an ADDITION — `prdAssignment` stays in the
    // register right below it, because 411 `### PRD-Zuordnung` headings stand in the stock and dropping
    // the entry would make all of them unparseable. Only the CONTRACT loses the heading, not the register.
    [ 'dependencies', 'Abhaengigkeiten', 'generated', [] ],
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


// Memo 081, WI-113: the local shim is gone, the shared one in tests/helpers/domSurrogate.mjs took its
// place. The reason is the change under test: the pass no longer SETS A CLASS on nodes it finds, it
// MOVES them into a <details>, so the surrogate needs parentNode / insertBefore / appendChild / closest
// / querySelectorAll on top of the sibling chain. Two suites drive that pass, and a shim typed twice is
// two shims that can drift apart. Same approach as before — there is no jsdom in this project (M11).


describe( 'BlockSections register + the three lists derived from it — Memo 080 PRD-B1 (WI-184)', () => {
    let client = ''
    let clientIsBlockBodyHeading = null
    let clientFoldBlockBodySections = null
    let clientIsNumberedChapterHeading = null

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

        // The fold pass itself, lifted with everything it walks. `contentEl` is the closure variable it
        // reads the cards from and `document` is the factory it builds the <details> with, so both are
        // injected as parameters — the rest is the real browser code, and the five module-scope literals
        // are the REAL declarations rather than re-typed copies (sliceDeclaration), so this suite cannot
        // stay green against a list the browser no longer has.
        const foldLists = [ 'BLOCK_BODY_SUFFIXES', 'CHAPTER_FOLD_SECTIONS', 'CHAPTER_FIGURE_KINDS', 'EVIDENCE_ART_VALUES', 'EVIDENCE_TAGS' ]
            .map( ( name ) => sliceDeclaration( client, name ) )
            .join( '\n' )
        const pass = await extractFunctionSources( [
            'foldBlockBodySections', 'chapterFoldLabel', 'foldOneSection', 'chapterSectionFigure',
            'countSectionUnits', 'distributionOf', 'artValueOfRow', 'headingLevel', 'hiddenSiblingsAfter',
            'isNumberedChapterHeading'
        ] )
        clientFoldBlockBodySections = new Function( 'contentEl', 'document', foldLists + '\n' + pass.source + '\nreturn foldBlockBodySections()' )

        // PRD-45: the second start region's predicate, lifted as the REAL declaration for the same
        // reason everything else here is — a re-typed copy of the regex would keep this suite green
        // exactly when the browser's predicate changes underneath it.
        const predicate = await extractFunctionSources( [ 'isNumberedChapterHeading', 'headingLevel' ] )
        clientIsNumberedChapterHeading = new Function( predicate.source + '\nreturn isNumberedChapterHeading' )()
    } )


    // ---- the register itself ----
    describe( 'register', () => {
        it( 'is closed: 19 entries, counted per kind, compared entry for entry', () => {
            const { sections } = BlockSections.all()

            expect( sections.length ).toBe( EXPECTED.length )
            expect( sections.length ).toBeGreaterThan( 0 )
            expect( KINDS.map( ( kind ) => [ kind, sections.filter( ( entry ) => entry.kind === kind ).length ] ) )
                .toEqual( [ [ 'required', 3 ], [ 'optional', 8 ], [ 'generated', 5 ], [ 'legacy', 3 ] ] )
            expect( sections.map( ( entry ) => [ entry.field, entry.heading, entry.kind, entry.aliases ] ) ).toEqual( EXPECTED )
        } )

        it( 'carries no "Diagramm" heading — a diagram is a content form (REV-18 Z. 132)', () => {
            const labels = BlockSections.all().sections
                .flatMap( ( entry ) => [ entry.heading ].concat( entry.aliases ) )

            expect( labels.length ).toBe( 20 )
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

            expect( labels.length ).toBe( 20 )
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

        it( 'the reach is level 3 only, and starts from a card region OR a numbered chapter', () => {
            // Level: everything but 3 stays untouched, on both sides.
            const levels = [ 1, 2, 4, 5, 6 ]
            const leaked = levels
                .filter( ( level ) => MemoView.isBlockBodyHeading( { level, text: 'Faktenlage' } ).isBlockBody === true )
            expect( leaked ).toEqual( [] )
            expect( clientIsBlockBodyHeading( { tagName: 'H2', textContent: 'Faktenlage' } ) ).toBe( false )
            expect( clientIsBlockBodyHeading( { tagName: 'DIV', textContent: 'Faktenlage' } ) ).toBe( false )

            // Region, and this is where PRD-45 CHANGED the contract this case used to assert. Until
            // now it required the literal line `var cards = contentEl.querySelectorAll( … )` and the
            // sentence "the fold starts from the cards and from NOTHING ELSE". That statement was
            // measured to be the reason the whole mechanism reached nothing: over all 533 revision
            // documents of the corpus, 7 carry a card, 23 carry one of the six sections, and the
            // intersection is EMPTY — 0 fold frames anywhere. The pass now starts from TWO regions.
            //
            // The two STOP conditions are the part that genuinely did not change, so they are still
            // asserted character for character; the start is asserted as two regions instead of one.
            expect( client ).toContain( 'function foldBlockBodySections(' )
            expect( client ).toContain( "if( node.classList && node.classList.contains( 'block-meta-card' ) ) { return }" )
            expect( client ).toContain( 'if( headingLevel( node ) === 2 ) { return }' )
            expect( client ).toContain( "contentEl.querySelectorAll( '.block-meta-card' ).forEach" )
            expect( client ).toContain( "contentEl.querySelectorAll( 'h2' ).forEach" )
            expect( client ).toContain( 'if( !isNumberedChapterHeading( heading ) ) { return }' )
        } )

        // Memo 081, WI-113: the SAME statement against the new mechanism. What this case proved before —
        // only inside a card, only at level 3, level-aware range, prefix-aware heading — it proves now,
        // measured on where the nodes ENDED UP instead of on a class that was set on them. It is
        // strictly stronger in one respect: a class could be set on a node and change nothing, whereas
        // a node inside a <details> is a node the reader can actually fold away and reopen.
        // PRD-45: the case is unchanged in its fixture and in every expectation — but its REASON moved,
        // and saying so is the whole value of the case. The H3 after `## Naechstes Kapitel` used to stay
        // unfolded because it was outside the CARD region. It now stays unfolded because that H2 is not
        // a NUMBERED chapter. The assertion is the same, the statement behind it is weaker, and the case
        // below ('a numbered chapter is the second start region') is what carries the other half.
        it( 'the fold pass folds only at level 3, and not under an unnumbered H2 — walked, not argued', () => {
            // Card region: card -> H3 Ist-Zustand -> P -> H3 Soll-Zustand: die Regel -> P -> H3 prose
            //              -> H2 (stop, UNNUMBERED) -> H3 Ist-Zustand (same text, OUTSIDE) -> H2 Faktenlage
            const insideHeadingA = makeNode( 'H3', 'Ist-Zustand' )
            const insideBodyA = makeNode( 'P', 'gemessen' )
            const insideHeadingB = makeNode( 'H3', 'Soll-Zustand: die Regel' )
            const insideBodyB = makeNode( 'P', 'daraus folgt' )
            const insideProse = makeNode( 'H3', 'Architektur' )
            const stop = makeNode( 'H2', 'Naechstes Kapitel' )
            const outsideHeading = makeNode( 'H3', 'Ist-Zustand' )
            const outsideH2 = makeNode( 'H2', 'Faktenlage' )
            const card = makeNode( 'DIV', '', [ 'block-meta-card' ] )
            const root = makeRoot( [ card, insideHeadingA, insideBodyA, insideHeadingB, insideBodyB, insideProse, stop, outsideHeading, outsideH2 ] )

            clientFoldBlockBodySections( root, makeDocument() )

            const folded = [ insideHeadingA, insideBodyA, insideHeadingB, insideBodyB, insideProse, stop, outsideHeading, outsideH2 ]
                .filter( ( node ) => node.closest( '.chapter-section' ) !== null )
            expect( folded ).toEqual( [ insideHeadingA, insideBodyA, insideHeadingB, insideBodyB ] )
            expect( folded.length ).toBe( 4 )

            // The four that must NOT move, each named — a prose H3 in the card region, the H2 that ends
            // the region, and the H3 with the SAME TEXT outside it.
            expect( insideProse.closest( '.chapter-section' ) ).toBe( null )
            expect( stop.closest( '.chapter-section' ) ).toBe( null )
            expect( outsideHeading.closest( '.chapter-section' ) ).toBe( null )
            expect( outsideH2.closest( '.chapter-section' ) ).toBe( null )

            // Two frames, not one: each heading opens its own, and both are CLOSED by default.
            const frames = root.querySelectorAll( 'details' )
            expect( frames.length ).toBe( 2 )
            expect( frames.every( ( frame ) => frame.classList.contains( 'chapter-section' ) ) ).toBe( true )
            expect( frames.some( ( frame ) => frame.classList.contains( 'open' ) ) ).toBe( false )

            // The suffixed heading was reached through the PREFIX rule, and its frame carries a figure
            // line rather than an empty summary.
            expect( insideHeadingB.closest( '.chapter-section' ) ).not.toBe( null )
            expect( frames[ 1 ].querySelector( 'summary' ).textContent ).toBe( '0 Aussagen' )
        } )

        // PRD-45 (Memo 081, WI-113): the second start region, and its boundary in the SAME case, because
        // a region that folds is only half the statement — the other half is where it stops.
        //
        // WHY THE REGION EXISTS AT ALL, measured rather than argued: with the card as the only start,
        // the pass produced 0 fold frames over all 533 revision documents of the corpus, REV-16 (the
        // document the order was written for) included. With this region it produces 2997, and REV-16
        // gets 265 — one per section heading it actually carries.
        it( 'a numbered chapter is the second start region, and an unnumbered one is not', () => {
            const numbered = makeNode( 'H2', '12. Ein durchgezaehltes Kapitel' )
            const belege = makeNode( 'H3', 'Belege' )
            const belegeBody = makeNode( 'P', 'gemessen' )
            const suffixed = makeNode( 'H3', 'Soll-Zustand: mit Suffix' )
            const suffixedBody = makeNode( 'P', 'daraus folgt' )
            const prose = makeNode( 'H3', 'Architektur' )
            const vorwort = makeNode( 'H2', 'Vorwort' )
            const afterVorwort = makeNode( 'H3', 'Belege' )
            const root = makeRoot( [ numbered, belege, belegeBody, suffixed, suffixedBody, prose, vorwort, afterVorwort ] )

            clientFoldBlockBodySections( root, makeDocument() )

            // Folded: both section headings with their bodies. NOT folded: the prose H3, the H2 itself,
            // and the identically named H3 under the unnumbered `## Vorwort` — the case the order asked
            // for by name, and the one the corpus measurement found 0 instances of.
            expect( belege.closest( '.chapter-section' ) ).not.toBe( null )
            expect( belegeBody.closest( '.chapter-section' ) ).not.toBe( null )
            expect( suffixed.closest( '.chapter-section' ) ).not.toBe( null )
            expect( suffixedBody.closest( '.chapter-section' ) ).not.toBe( null )
            expect( prose.closest( '.chapter-section' ) ).toBe( null )
            expect( numbered.closest( '.chapter-section' ) ).toBe( null )
            expect( vorwort.closest( '.chapter-section' ) ).toBe( null )
            expect( afterVorwort.closest( '.chapter-section' ) ).toBe( null )

            expect( root.querySelectorAll( 'details' ).length ).toBe( 2 )

            // The predicate itself, at its boundary. `13-Klarstellung.` is a real corpus heading form
            // and is deliberately NOT recognised; it carries no folding section today, which is why the
            // boundary is unobservable at the corpus and is pinned here instead.
            expect( clientIsNumberedChapterHeading( makeNode( 'H2', '12. Kapitel' ) ) ).toBe( true )
            expect( clientIsNumberedChapterHeading( makeNode( 'H2', '2.–5. Zusammengefasst' ) ) ).toBe( true )
            expect( clientIsNumberedChapterHeading( makeNode( 'H2', 'Vorwort' ) ) ).toBe( false )
            expect( clientIsNumberedChapterHeading( makeNode( 'H2', 'Offene Fragen' ) ) ).toBe( false )
            expect( clientIsNumberedChapterHeading( makeNode( 'H2', '13-Klarstellung. K3' ) ) ).toBe( false )
            expect( clientIsNumberedChapterHeading( makeNode( 'H3', '12. Kapitel' ) ) ).toBe( false )
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

        it( 'exposes EVERY writable register field as a flat key and all 19 under sections', () => {
            const doc = [ '## K', '', '```block-meta', '{ "topics": ["T001"] }', '```', '', '### Bewertung', '', 'B', '' ].join( '\n' )
            const { blocks } = BlockMeta.parse( { doc } )
            const { fields } = BlockSections.writableFields()

            const missing = fields
                .filter( ( field ) => Object.prototype.hasOwnProperty.call( blocks[ 0 ], field ) !== true )
            expect( missing ).toEqual( [] )
            expect( fields.length ).toBe( 14 )
            expect( Object.keys( blocks[ 0 ].sections ).length ).toBe( 19 )
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

    // The derivation itself, both directions — the CLASS, not the case. A worktree name must produce the
    // worktree sibling, a plain name the plain sibling, and the plain name must stay the fallback so a
    // checkout without the sibling worktree still resolves somewhere nameable.
    it( 'the core sibling is derived from this tree own directory name, both directions', () => {
        const fromWorktree = coreRegisterCandidates( { viewerRoot: '/x/repos/viewer-wt-081' } )
        const fromPlain = coreRegisterCandidates( { viewerRoot: '/x/repos/viewer' } )
        const fromForeign = coreRegisterCandidates( { viewerRoot: '/x/repos/something-else' } )

        expect( fromWorktree ).toEqual( [
            resolve( '/x/repos/core-wt-081/cli/src/BlockSections.mjs' ),
            resolve( '/x/repos/core/cli/src/BlockSections.mjs' )
        ] )
        expect( fromPlain ).toEqual( [ resolve( '/x/repos/core/cli/src/BlockSections.mjs' ) ] )
        expect( fromForeign ).toEqual( [ resolve( '/x/repos/core/cli/src/BlockSections.mjs' ) ] )

        // GEGENPROBE: the derivation must NOT hand back the main tree for a worktree — that is exactly
        // the defect this replaces, and a candidate list that starts with `repos/core` would reinstate it.
        expect( fromWorktree[ 0 ] ).not.toContain( '/repos/core/' )
        expect( CORE_CANDIDATES.length ).toBeGreaterThan( 0 )
    } )

    withCore( 'the viewer register and the core register are byte-identical below the header', async () => {
        // A parity check that does not say WHICH two files it compared cannot be told apart from one that
        // compared nothing — or from one that compared a stand nobody asked for.
        console.log( `[parity] viewer=${ resolve( HERE, '..', '..', 'src', 'BlockSections.mjs' ) } core=${ CORE_REGISTER } (candidates: ${ CORE_CANDIDATES.join( ', ' ) })` )

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
