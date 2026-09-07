import { describe, it, expect } from '@jest/globals'

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoView } from '../../src/MemoView.mjs'
import { extractFunctions } from '../helpers/extractFunction.mjs'


// Memo 080, Kap 14 / WI-171 (PRD-R5) — make deleted lines visible, prepare the entity comparison.
//
// The diff view was never broken: it compared correctly. It simply had NO RED. The removed strings
// were computed, put into the payload, shipped to the browser — and read by nobody (0 readers in the
// whole client). 101 deleted lines in the two most recent comparisons of this memo alone were never
// shown to anyone. And a comparison with no finding looked exactly like a comparison with no basis,
// which is the same defect one level up: a green message without a stated comparison size is not a
// green message.
//
// Two comparison bases on purpose:
//   1. a SYNTHETIC in-repo fixture pair — always runs, in CI too, numbers derived by hand below, and
//      it covers every path (chapter-less lines, renamed chapter, deleted heading, frequency limit),
//   2. the REAL memo-080 revisions — the numbers the PRD measured (1932/1910/61/43/13). They live
//      OUTSIDE this repo (memo working artifacts are never committed here, see .gitignore), so they
//      are read path-guarded and visibly skipped when absent.
// Every check states HOW MANY entries it compared; a check with nothing to compare fails.

const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewPath = resolve( here, '../../src/MemoView.mjs' )
const clientPath = resolve( here, '../../src/public/app.client.mjs' )
const cssPath = resolve( here, '../../src/public/app.css' )

const memoViewSource = readFileSync( memoViewPath, 'utf-8' )
const clientSource = readFileSync( clientPath, 'utf-8' )
const cssSource = readFileSync( cssPath, 'utf-8' )

const fixtureDir = join( here, '..', 'fixtures', 'diff-removed-r5' )
const fixturePrevious = readFileSync( join( fixtureDir, 'previous.md' ), 'utf-8' )
const fixtureCurrent = readFileSync( join( fixtureDir, 'current.md' ), 'utf-8' )

// The real revisions of memo 080. Outside the repo by design — guarded, never assumed.
const revisionsDir = resolve( here, '../../../../.memo/memos/080-db-vollausbau-und-laufzeit-transparenz/revisions' )
const revisionPath = ( name ) => join( revisionsDir, name )
const revisionsPresent = [ 'REV-16.md', 'REV-17.md', 'REV-18.md' ]
    .every( ( name ) => existsSync( revisionPath( name ) ) )


// ---- hand-derived expectation for the synthetic pair --------------------------------------------
// previous.md carries 23 lines, 16 of them non-blank; current.md carries 20 lines, 13 non-blank.
// Removed sit at the 1-based previous positions 5, 6 (before the first "## " -> chapter null), 11,
// 13 (the heading itself, bold in the previous side), 16, 17, 21 (heading of a chapter that gets
// renamed) and 23. "Wiederholte Zeile." drops from two occurrences to one and is deliberately NOT
// reported — that is the documented set-membership limit.
const EXPECTED = {
    currentCount: 13,
    previousCount: 16,
    addedCount: 6,
    removedCount: 8,
    removedSectionCount: 4,
    previousLineNumbers: [ 5, 6, 11, 13, 16, 17, 21, 23 ],
    chapters: [
        null,
        null,
        'Kapitel 1 — Ueberblick',
        'Kapitel 2 — Details',
        'Kapitel 2 — Details',
        'Kapitel 2 — Details',
        'Kapitel 3 — Alter Name',
        'Kapitel 3 — Alter Name'
    ]
}


describe( 'PRD-R5 the comparison verdict (A1, A3, A4)', () => {
    it( 'returns a comparison with a declared basis, every number checked one by one', () => {
        const { comparison } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )

        expect( comparison.mode ).toBe( 'lines' )
        expect( comparison.basis ).toBe( 'non-empty-lines' )
        expect( comparison.currentCount ).toBe( EXPECTED.currentCount )
        expect( comparison.previousCount ).toBe( EXPECTED.previousCount )
        expect( comparison.addedCount ).toBe( EXPECTED.addedCount )
        expect( comparison.removedCount ).toBe( EXPECTED.removedCount )
        expect( comparison.removedSectionCount ).toBe( EXPECTED.removedSectionCount )
    } )


    it( 'every removed entry carries line, previousLineNumber and chapter — ALL of them read back (A3)', () => {
        const { removed } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )
        const previousLines = fixturePrevious.split( '\n' )

        // Comparison size of this check: all 8 entries, not a sample.
        expect( removed.length ).toBe( EXPECTED.removedCount )
        expect( removed.map( ( entry ) => entry.previousLineNumber ) ).toEqual( EXPECTED.previousLineNumbers )
        expect( removed.map( ( entry ) => entry.chapter ) ).toEqual( EXPECTED.chapters )

        const readBack = removed.filter( ( entry ) => previousLines[ entry.previousLineNumber - 1 ] === entry.line )

        expect( readBack.length ).toBe( removed.length )
    } )


    it( 'a line removed before the first heading has chapter null — a state of its own, not empty text', () => {
        const { removed } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )
        const headless = removed.filter( ( entry ) => entry.chapter === null )

        expect( headless.length ).toBe( 2 )
        expect( headless.every( ( entry ) => entry.chapter !== '' ) ).toBe( true )
        // The headless group COUNTS in removedSectionCount: 3 chapters plus 1 headless group.
        expect( EXPECTED.removedSectionCount ).toBe( 4 )
    } )


    it( 'a removed heading belongs to ITS OWN chapter and runs through the same cleaning', () => {
        const { removed } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )
        const heading = removed.find( ( entry ) => entry.line === '## Kapitel 2 — **Details**' )

        expect( heading ).toBeDefined()
        expect( heading.chapter ).toBe( 'Kapitel 2 — Details' )
        expect( MemoView.stripHeadingMarkdown( { text: 'Kapitel 2 — **Details**' } ).cleaned ).toBe( 'Kapitel 2 — Details' )
    } )


    it( 'ONE declared basis: no blank line in the verdict, and the numbers agree with each other (A4)', () => {
        const { comparison, removed } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )
        const blanks = removed.filter( ( entry ) => entry.line.trim().length === 0 )

        expect( blanks.length ).toBe( 0 )
        expect( comparison.removedCount ).toBe( removed.length )
        expect( comparison.removedCount ).toBeLessThanOrEqual( comparison.previousCount )
        expect( comparison.addedCount ).toBeLessThanOrEqual( comparison.currentCount )

        // The basis itself counts no blank line either.
        const previousNonBlank = fixturePrevious.split( '\n' ).filter( ( line ) => line.trim().length > 0 ).length
        const currentNonBlank = fixtureCurrent.split( '\n' ).filter( ( line ) => line.trim().length > 0 ).length

        expect( comparison.previousCount ).toBe( previousNonBlank )
        expect( comparison.currentCount ).toBe( currentNonBlank )
    } )


    it( 'the named set limit is pinned: a drop in FREQUENCY is not reported', () => {
        const { removed } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )
        const repeated = removed.filter( ( entry ) => entry.line === 'Wiederholte Zeile.' )
        const previousOccurrences = fixturePrevious.split( '\n' ).filter( ( line ) => line === 'Wiederholte Zeile.' ).length
        const currentOccurrences = fixtureCurrent.split( '\n' ).filter( ( line ) => line === 'Wiederholte Zeile.' ).length

        // 2 -> 1: a real drop the set view cannot see. This is the limit named in the source comment,
        // held here as BEHAVIOUR rather than passed over in silence.
        expect( previousOccurrences ).toBe( 2 )
        expect( currentOccurrences ).toBe( 1 )
        expect( repeated.length ).toBe( 0 )
    } )
} )


describe( 'PRD-R5 the measured numbers against the real revisions (A1, A2)', () => {
    const pairs = [
        { label: 'REV-17 -> REV-18', current: 'REV-18.md', previous: 'REV-17.md', currentCount: 1932, previousCount: 1910, addedCount: 61, removedCount: 43, removedSectionCount: 13 },
        { label: 'REV-16 -> REV-17', current: 'REV-17.md', previous: 'REV-16.md', currentCount: 1910, previousCount: 1899, addedCount: 69, removedCount: 58, removedSectionCount: 11 }
    ]

    // The memo revisions live OUTSIDE this repo (.gitignore: memo working artifacts are never
    // committed in the viewer repo, which is public). A standalone CI checkout does not have them, so
    // this skips VISIBLY instead of reporting a silent green. The comparison basis that always runs is
    // the synthetic pair above — no code path is left unchecked by the skip.
    const runOnRevisions = revisionsPresent === true ? it : it.skip

    pairs.forEach( ( pair ) => {
        runOnRevisions( `${ pair.label }: every number one by one`, () => {
            const currentContent = readFileSync( revisionPath( pair.current ), 'utf-8' )
            const previousContent = readFileSync( revisionPath( pair.previous ), 'utf-8' )
            const { comparison, removed } = MemoView.diffComparison( { currentContent, previousContent } )

            expect( comparison.currentCount ).toBe( pair.currentCount )
            expect( comparison.previousCount ).toBe( pair.previousCount )
            expect( comparison.addedCount ).toBe( pair.addedCount )
            expect( comparison.removedCount ).toBe( pair.removedCount )
            expect( comparison.removedSectionCount ).toBe( pair.removedSectionCount )
            expect( removed.length ).toBe( pair.removedCount )

            // Every removed line read back byte-exact at its position in the previous file.
            const previousLines = previousContent.split( '\n' )
            const exact = removed.filter( ( entry ) => previousLines[ entry.previousLineNumber - 1 ] === entry.line )

            expect( exact.length ).toBe( removed.length )
        } )
    } )
} )


describe( 'PRD-R5 the empty set reports, the missing basis is a defect (A5, A6, A10)', () => {
    it( 'two byte-equal sides: 0 removed WITH a stated comparison size, never an empty string (A5)', () => {
        const { comparison } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixtureCurrent } )
        const summary = MemoView.diffSummary( { comparison } )

        expect( comparison.removedCount ).toBe( 0 )
        expect( comparison.currentCount ).toBeGreaterThan( 0 )
        expect( summary.state ).toBe( 'empty' )
        expect( summary.text ).toBe( '0 geloeschte Zeilen, ueber 13 Zeilen verglichen (13 im Vorgaenger)' )
        expect( summary.text.length ).toBeGreaterThan( 0 )
    } )


    it( 'a verdict states the count AND the comparison size', () => {
        const summary = MemoView.diffSummary( {
            comparison: { mode: 'lines', basis: 'non-empty-lines', currentCount: 1932, previousCount: 1910, addedCount: 61, removedCount: 43, removedSectionCount: 13 }
        } )

        expect( summary.state ).toBe( 'verdict' )
        expect( summary.text ).toBe( '43 geloeschte Zeilen, ueber 1932 Zeilen verglichen (1910 im Vorgaenger)' )
    } )


    it( 'missing basis: currentCount 0 AND previousCount 0, each on its own — never a calm zero (A6)', () => {
        const cases = [
            { label: 'currentCount 0', comparison: { mode: 'lines', basis: 'non-empty-lines', currentCount: 0, previousCount: 1910, addedCount: 0, removedCount: 1910, removedSectionCount: 4 } },
            { label: 'previousCount 0', comparison: { mode: 'lines', basis: 'non-empty-lines', currentCount: 1932, previousCount: 0, addedCount: 1932, removedCount: 0, removedSectionCount: 0 } }
        ]

        // Comparison size of this check: 2 cases, each asserted separately.
        expect( cases.length ).toBe( 2 )
        cases.forEach( ( entry ) => {
            const summary = MemoView.diffSummary( { comparison: entry.comparison } )

            expect( summary.state ).toBe( 'missing-basis' )
            expect( summary.text ).toBe( 'Vergleichsgrundlage fehlt — dieser Befund traegt nicht' )
            expect( summary.text ).not.toMatch( /geloeschte/ )
            expect( summary.text ).not.toMatch( /keine Aenderungen/ )
        } )
    } )


    it( 'a comparison against an empty previous file is the defect state, not "no changes"', () => {
        const { comparison } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: '' } )

        expect( comparison.previousCount ).toBe( 0 )
        expect( MemoView.diffSummary( { comparison } ).state ).toBe( 'missing-basis' )
    } )


    it( 'an unreadable or unlabelled verdict does not carry — no plausible-looking sentence', () => {
        const cases = [ null, undefined, {}, { mode: 'blocks', currentCount: 5, previousCount: 5, removedCount: 0 }, { mode: 'lines', currentCount: 'viele', previousCount: 5, removedCount: 0 } ]

        expect( cases.length ).toBe( 5 )
        cases.forEach( ( comparison ) => {
            expect( MemoView.diffSummary( { comparison } ).state ).toBe( 'missing-basis' )
        } )
    } )


    it( 'diffSummary is pure, and the entity branch changes ONLY the unit (A10)', () => {
        const numbers = { basis: 'non-empty-lines', currentCount: 120, previousCount: 117, addedCount: 9, removedCount: 3, removedSectionCount: 2 }
        const asLines = MemoView.diffSummary( { comparison: Object.assign( { mode: 'lines' }, numbers ) } )
        const asLinesAgain = MemoView.diffSummary( { comparison: Object.assign( { mode: 'lines' }, numbers ) } )
        const asEntities = MemoView.diffSummary( { comparison: Object.assign( { mode: 'entities' }, numbers ) } )

        expect( asLinesAgain ).toEqual( asLines )
        expect( asLines.text ).toBe( '3 geloeschte Zeilen, ueber 120 Zeilen verglichen (117 im Vorgaenger)' )
        expect( asEntities.text ).toBe( '3 geloeschte Eintraege, ueber 120 Eintraege verglichen (117 im Vorgaenger)' )
        expect( asEntities.state ).toBe( asLines.state )
        // Only the unit separates the two sentences — every number stays.
        expect( asEntities.text.replace( /Eintraege/g, 'Zeilen' ) ).toBe( asLines.text )
    } )


    it( 'this PRD builds NO producer for mode entities — the branch is a label with a test', () => {
        const producers = ( memoViewSource.match( /'mode': 'entities'/g ) || [] ).length

        expect( producers ).toBe( 0 )
        expect( ( memoViewSource.match( /'mode': 'lines'/g ) || [] ).length ).toBe( 1 )
    } )
} )


describe( 'PRD-R5 assignment and completeness of the display (A7, A8, A9)', () => {
    const loadClient = () => extractFunctions( [ 'slugify', 'escapeHtml', 'escapeAttr', 'groupRemovedLines', 'removedBlockMarkup' ] )


    it( 'NO removed line falls off: chapter groups plus collecting block equal removedCount (A7, A8)', async () => {
        const { groupRemovedLines } = await loadClient()
        const { comparison, removed } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )
        const currentChapterSlugs = [ 'kapitel-1-ueberblick', 'kapitel-2-details', 'kapitel-3-neuer-name' ]
        const grouped = groupRemovedLines( removed, currentChapterSlugs )
        const placed = grouped.groups.reduce( ( sum, group ) => sum + group.entries.length, 0 )

        expect( grouped.assignedCount ).toBe( comparison.removedCount )
        expect( placed + grouped.orphans.length ).toBe( comparison.removedCount )
        expect( placed ).toBe( 4 )
        expect( grouped.orphans.length ).toBe( 4 )
    } )


    it( 'chapter-less lines AND lines of a renamed chapter land in the collecting block, not nowhere (A8)', async () => {
        const { groupRemovedLines } = await loadClient()
        const { removed } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )
        const grouped = groupRemovedLines( removed, [ 'kapitel-1-ueberblick', 'kapitel-2-details', 'kapitel-3-neuer-name' ] )
        const orphanChapters = grouped.orphans.map( ( entry ) => entry.chapter )

        expect( orphanChapters ).toEqual( [ null, null, 'Kapitel 3 — Alter Name', 'Kapitel 3 — Alter Name' ] )
        expect( grouped.groups.map( ( group ) => group.slug ) ).toEqual( [ 'kapitel-1-ueberblick', 'kapitel-2-details' ] )
    } )


    it( 'a document WITHOUT any heading loses nothing — everything goes to the collecting block', async () => {
        const { groupRemovedLines } = await loadClient()
        const { comparison, removed } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )
        const grouped = groupRemovedLines( removed, [] )

        expect( grouped.groups.length ).toBe( 0 )
        expect( grouped.orphans.length ).toBe( comparison.removedCount )
        expect( grouped.assignedCount ).toBe( comparison.removedCount )
    } )


    it( 'two chapters of the same name collapse into ONE group — bundled, but nothing is lost', async () => {
        const { groupRemovedLines } = await loadClient()
        const entries = [
            { line: 'a', previousLineNumber: 1, chapter: 'Doppelt' },
            { line: 'b', previousLineNumber: 2, chapter: 'Doppelt' }
        ]
        const grouped = groupRemovedLines( entries, [ 'doppelt', 'doppelt' ] )

        expect( grouped.groups.length ).toBe( 1 )
        expect( grouped.assignedCount ).toBe( entries.length )
    } )


    it( 'an entry without a chapter field does not slip through, it lands in the collecting block', async () => {
        const { groupRemovedLines } = await loadClient()
        const grouped = groupRemovedLines( [ { line: 'a', previousLineNumber: 1 } ], [ 'irgendwas' ] )

        expect( grouped.orphans.length ).toBe( 1 )
        expect( grouped.assignedCount ).toBe( 1 )
    } )


    it( 'the assignment survives formatting drift between the raw chapter and the rendered heading', async () => {
        const { groupRemovedLines } = await loadClient()
        const entries = [ { line: 'x', previousLineNumber: 1, chapter: 'Kapitel 5 — Überblick' } ]
        const grouped = groupRemovedLines( entries, [ 'kapitel-5-ueberblick' ] )

        expect( grouped.orphans.length ).toBe( 0 )
        expect( grouped.groups[ 0 ].entries.length ).toBe( 1 )
    } )


    it( 'the number of .diff-removed elements equals removedCount — the sum, not "red appears" (A7)', async () => {
        const { groupRemovedLines, removedBlockMarkup } = await loadClient()
        const { comparison, removed } = MemoView.diffComparison( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )
        const grouped = groupRemovedLines( removed, [ 'kapitel-1-ueberblick', 'kapitel-2-details', 'kapitel-3-neuer-name' ] )
        const blocks = grouped.groups
            .map( ( group ) => removedBlockMarkup( `Aus diesem Kapitel entfernt (${ group.entries.length } Zeilen)`, group.entries ) )
            .concat( [ removedBlockMarkup( `Entfernt, ohne Kapitel im aktuellen Stand (${ grouped.orphans.length } Zeilen)`, grouped.orphans ) ] )
            .join( '' )
        const rendered = ( blocks.match( /class="diff-removed"/g ) || [] ).length

        expect( rendered ).toBe( comparison.removedCount )
        expect( blocks ).toMatch( /Aus diesem Kapitel entfernt \(3 Zeilen\)/ )
        expect( blocks ).toMatch( /Entfernt, ohne Kapitel im aktuellen Stand \(4 Zeilen\)/ )
    } )


    it( 'every line carries its previous line number', async () => {
        const { removedBlockMarkup } = await loadClient()
        const markup = removedBlockMarkup( 'Titel', [ { line: 'weg', previousLineNumber: 4225 } ] )

        expect( markup ).toMatch( /data-previous-line="4225"/ )
        expect( markup ).toMatch( />4225</ )
    } )


    it( 'masking is a duty: neither content nor line number can produce markup (A9)', async () => {
        const { removedBlockMarkup } = await loadClient()
        const markup = removedBlockMarkup( '<b>Titel</b>', [
            { line: '<img src=x onerror=alert(1)>', previousLineNumber: '1" onmouseover="alert(2)' }
        ] )

        // No new element appears: the ONLY tags in the block are div and span. That is the check —
        // not "the word onerror is absent", because as escaped TEXT it is allowed to be there.
        const tags = new Set( ( markup.match( /<\/?([a-zA-Z][a-zA-Z0-9]*)/g ) || [] ).map( ( tag ) => tag.replace( /[<\/]/g, '' ) ) )

        expect( [ ...tags ].sort() ).toEqual( [ 'div', 'span' ] )
        expect( markup ).not.toMatch( /<img/ )
        expect( markup ).not.toMatch( /<b>/ )
        // And no break-out of the attribute: the quote inside the line number is escaped.
        expect( markup ).not.toMatch( /onmouseover="/ )
        expect( markup ).toMatch( /data-previous-line="1&quot; onmouseover=&quot;alert\(2\)"/ )
        expect( markup ).toMatch( /&lt;img src=x onerror=alert\(1\)&gt;/ )
        expect( markup ).toMatch( /&lt;b&gt;Titel&lt;\/b&gt;/ )
    } )
} )


describe( 'PRD-R5 the wiring inside the view', () => {
    it( 'the headline comes ALWAYS and from diff.comparison — before the conditional banner parts', () => {
        const summaryAt = clientSource.indexOf( 'diff.comparison && diff.comparison.summary' )
        const skippedAt = clientSource.indexOf( 'if( diff.skippedUpdates && diff.skippedUpdates.length > 0 )' )
        const changedAt = clientSource.indexOf( 'if( diff.changedSections && diff.changedSections.length > 0 )' )

        expect( summaryAt ).toBeGreaterThan( -1 )
        expect( skippedAt ).toBeGreaterThan( -1 )
        expect( changedAt ).toBeGreaterThan( -1 )
        expect( summaryAt ).toBeLessThan( skippedAt )
        expect( summaryAt ).toBeLessThan( changedAt )
        // Not gated on there BEING deletions: the empty set reports as well.
        expect( clientSource ).not.toMatch( /if\( diff\.comparison\.removedCount > 0 \)/ )
    } )


    it( 'the defect state looks like a defect and carries the very sentence the server produces', () => {
        const serverText = MemoView.diffSummary( { comparison: null } ).text

        expect( clientSource ).toContain( `text: '${ serverText }'` )
        expect( clientSource ).toMatch( /summary\.state === 'missing-basis' \? 'var\(--danger\)'/ )
    } )


    it( 'the view reads ONLY comparison and removed, never a line field and never a hard-coded unit', () => {
        expect( clientSource ).toMatch( /diff\.removed/ )
        expect( clientSource ).not.toMatch( /diff\.removedLines/ )
        // The headline is NOT built over there — the unit comes from mode, inside the server mirror.
        // (The block title "... (N Zeilen)" is the heading the PRD prescribes verbatim for the
        // deletion block, not the unit of the verdict.)
        expect( clientSource ).not.toMatch( /geloeschte/ )
        expect( clientSource ).toMatch( /summary\.text/ )
    } )


    it( 'the deleted lines are inserted AFTER the .diff-added pass has run', () => {
        const addedPassAt = clientSource.indexOf( "el.classList.add( 'diff-added' )" )
        const definitionAt = clientSource.indexOf( 'function renderRemovedBlocks( diff )' )
        const removedCallAt = clientSource.lastIndexOf( 'renderRemovedBlocks( diff )' )

        expect( addedPassAt ).toBeGreaterThan( -1 )
        expect( definitionAt ).toBeGreaterThan( -1 )
        // The last hit is the CALL, not the definition — otherwise this test checks nothing.
        expect( removedCallAt ).toBeGreaterThan( definitionAt )
        expect( removedCallAt ).toBeGreaterThan( addedPassAt )
    } )


    it( 'the chapter block goes to the end of its chapter, the collecting block to the document end', () => {
        expect( clientSource ).toMatch( /insertBefore\( block, before \)/ )
        expect( clientSource ).toMatch( /contentEl\.appendChild\( block \)/ )
        expect( clientSource ).toMatch( /insertBlock\( removedBlockMarkup\( tailTitle, grouped\.orphans \), null \)/ )
    } )
} )


describe( 'PRD-R5 source shape and untouched neighbourhood (A11, A12, A13, A14)', () => {
    it( 'the old flat removed-strings field no longer occurs in repos/viewer (A11)', () => {
        const files = [ memoViewSource, clientSource ]

        // Comparison size: the two files that ever carried the field.
        expect( files.length ).toBe( 2 )
        files.forEach( ( source ) => {
            expect( ( source.match( /removedLines/g ) || [] ).length ).toBe( 0 )
        } )
    } )


    it( 'the four dead names are gone — named one by one, not as a bulk cleanup (A11)', () => {
        const dead = [
            { name: 'diffLines', pattern: /\bdiffLines\b/g },
            { name: 'maxLen', pattern: /\bmaxLen\b/g },
            { name: 'ci', pattern: /\bconst ci\b|\blet ci\b/g },
            { name: 'pi', pattern: /\bconst pi\b|\blet pi\b/g }
        ]

        expect( dead.length ).toBe( 4 )
        dead.forEach( ( entry ) => {
            expect( ( memoViewSource.match( entry.pattern ) || [] ).length ).toBe( 0 )
        } )
    } )


    it( 'the comment names the set limit with the measured value and the date (A12)', () => {
        expect( memoViewSource ).toMatch( /KNOWN LIMIT — set membership, not position/ )
        expect( memoViewSource ).toMatch( /Measured 2026-09-03 against REV-17 -> REV-18 of memo 080: 0 affected strings/ )
    } )


    // Memo 081, PRD-37 (WI-105): the point of this case — no call site computes `removed`/`comparison`
    // itself, the addition sits at ONE place — is unchanged and asserted below unchanged. Only the number
    // of call sites moved:
    //   before: 4 call sites, 4x `diffResult['previousContent'] = previousRaw`  -> expected 4 / 4
    //   after:  1 call site (#buildDiff), 1x `diffResult['previousBlockTexts']` -> expected 1 / 1
    // The diff is built only on request now, so the four duplicated blocks became one; the raw previous
    // revision stopped travelling, so counting by it would count nothing and report green.
    it( 'the single call site is untouched — the verdict travels in the existing result object (A13)', () => {
        const callSites = ( memoViewSource.match( /const \{ diffResult \} = MemoView\.#computeDiff\( \{ currentContent: currentRaw, previousContent: previousRaw \} \)/g ) || [] ).length
        const previousSideSites = ( memoViewSource.match( /diffResult\['previousBlockTexts'\] = blockTexts/g ) || [] ).length

        expect( callSites ).toBe( 1 )
        expect( previousSideSites ).toBe( 1 )
        // No call site sets comparison/removed itself — the addition sits at ONE place.
        expect( memoViewSource ).not.toMatch( /diffResult\['removed'\] =/ )
        expect( memoViewSource ).not.toMatch( /diffResult\['comparison'\] =/ )
    } )


    it( 'the existing diff view stays intact: changedSections unchanged (A14)', () => {
        const { diffResult } = MemoView.computeDiffResult( { currentContent: fixtureCurrent, previousContent: fixturePrevious } )

        expect( diffResult.changedSections ).toEqual( [ 'Kapitel 1 — Ueberblick', 'Kapitel 3 — Neuer Name' ] )
        expect( diffResult.hasDiff ).toBe( true )
        expect( diffResult.lines.length ).toBe( fixtureCurrent.split( '\n' ).length )
        expect( diffResult.lines.filter( ( entry ) => entry.type === 'added' ).length ).toBe( EXPECTED.addedCount )
        expect( diffResult.comparison.summary.state ).toBe( 'verdict' )
        expect( diffResult.removed.length ).toBe( EXPECTED.removedCount )
    } )


    it( 'the existing .diff-removed class keeps its colour and strike-through, the frame is added', () => {
        expect( cssSource ).toMatch( /\.diff-removed \{\n\s+background-color: var\(--diff-del-bg\);\n\s+border-left: 3px solid var\(--danger\);\n\s+padding-left: 8px;\n\s+text-decoration: line-through;\n\s+opacity: 0\.6;\n\s+\}/ )

        const added = [ '.diff-removed-block', '.diff-removed-title', '.diff-removed-no', '.diff-removed-text' ]

        expect( added.length ).toBe( 4 )
        added.forEach( ( selector ) => {
            expect( cssSource ).toContain( `${ selector } {` )
        } )
    } )
} )
