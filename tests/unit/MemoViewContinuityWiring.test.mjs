import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoValidator } from '../../src/MemoValidator.mjs'


// Memo 080, Kap 14 / WI-172 (PRD-R4) — the WIRING, not the method.
//
// WARN-010 (checkQuestionContinuity, Memo 067) was built, tested and documented in two spec chapters
// as "the viewer warns" — and had NO production caller: the only reference outside MemoValidator.mjs
// was a unit test. A method nobody calls is not a check. These tests exist so WARN-011 cannot repeat
// that, and so the carry-along fix for WARN-010 stays fixed:
//
//   A8  the continuity result reaches the `diff` field of the content WebSocket message and the
//       comparison banner of the client,
//   A9  `checkQuestionContinuity` has at least one caller outside MemoValidator.mjs.
//
// The four content-send sites are deeply nested private WebSocket handlers, so the wiring is proven
// the way this repo already proves the validation gate (ValidationGate.test.mjs): source-structural
// over the real files plus a serialisation round-trip of the emitted message.

const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewPath = resolve( here, '../../src/MemoView.mjs' )
const validatorPath = resolve( here, '../../src/MemoValidator.mjs' )
const clientPath = resolve( here, '../../src/public/app.client.mjs' )


describe( 'PRD-R4 continuity wiring in MemoView (A8)', () => {
    it( 'a centralised #computeContinuity helper exists and is defensively wrapped', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )

        expect( src ).toMatch( /static #computeContinuity\( \{ currentContent, previousContent \} \)/ )
        expect( src ).toMatch( /MemoValidator\.checkStandaloneContinuity\( \{ 'current': currentContent, 'previous': previousContent \} \)/ )
        expect( src ).toMatch( /'continuity': null/ )
    } )


    it( 'EVERY diff-building site attaches continuity — as many as attach previousContent', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )
        const previousContentSites = ( src.match( /diffResult\['previousContent'\] = previousRaw/g ) || [] ).length
        const continuitySites = ( src.match( /diffResult\['continuity'\] = MemoView\.#computeContinuity\(/g ) || [] ).length

        // The comparison basis of THIS check: four diff sites in the file today.
        expect( previousContentSites ).toBe( 4 )
        expect( continuitySites ).toBe( previousContentSites )
    } )


    it( 'the helper passes the SAME pair the diff is computed from', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )
        const calls = src.match( /MemoView\.#computeContinuity\( \{ currentContent: currentRaw, previousContent: previousRaw \} \)/g ) || []

        expect( calls.length ).toBe( 4 )
    } )


    it( 'the client comparison banner reads diff.continuity and states the comparison basis', async () => {
        const client = await readFile( clientPath, 'utf-8' )

        expect( client ).toMatch( /if\( diff\.continuity \)/ )
        expect( client ).toMatch( /diff\.continuity\.comparedChapters/ )
        expect( client ).toMatch( /Kapitel verglichen/ )
        // The warnings are memo-derived text -> escaped, like every neighbouring banner part.
        expect( client ).toMatch( /continuityWarnings\.map\( function\( w \) \{[\s\S]{0,160}escapeHtml\( w \)/ )
    } )


    it( 'a content message carrying the continuity result round-trips through JSON', () => {
        const previous = [ '## 1. Traceability [Code]', '**User-Auftrag:** "Zurueckverfolgen."', 'Ist-Zustand: [FAKT] ein Beleg.', 'Und noch eine Zeile.' ].join( '\n' )
        const current = [ '## 1. Traceability [Docs]', 'Ist-Zustand: unveraendert.' ].join( '\n' )
        const continuity = MemoValidator.checkStandaloneContinuity( { current, previous } )

        const message = JSON.stringify( {
            'type': 'content',
            'content': current,
            'fileName': 'REV-02.md',
            'diff': { 'previousFile': 'REV-01.md', 'previousContent': previous, 'skippedUpdates': [], continuity }
        } )
        const parsed = JSON.parse( message )

        expect( parsed[ 'diff' ][ 'continuity' ][ 'comparedChapters' ] ).toBe( 1 )
        expect( parsed[ 'diff' ][ 'continuity' ][ 'warnings' ].join( '\n' ) ).toMatch( /WARN-011/ )
    } )
} )


describe( 'PRD-R4 carry-along: WARN-010 gets its missing production caller (A9)', () => {
    it( 'checkQuestionContinuity is called from MemoView, not only from MemoValidator', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )
        const callSites = ( src.match( /MemoValidator\.checkQuestionContinuity\(/g ) || [] ).length

        expect( callSites ).toBeGreaterThan( 0 )
    } )


    it( 'the only OTHER file naming checkQuestionContinuity in src/ is its own definition', async () => {
        const validator = await readFile( validatorPath, 'utf-8' )

        // Sanity of the comparison basis: the method really is defined where we think it is.
        expect( validator ).toMatch( /static checkQuestionContinuity\( \{ current, previous \} \)/ )
    } )


    it( 'both warning channels arrive in ONE continuity list', () => {
        // Predecessor: two open questions. Current: one open question, none moved to answered — the
        // WARN-010 case. The chapter also loses its User-Auftrag block — the WARN-011 case.
        const previous = [
            '## 1. Traceability [Code]',
            '**User-Auftrag:** "Zurueckverfolgen."',
            'Ist-Zustand: [FAKT] ein Beleg.',
            'Noch eine Zeile Substanz.',
            '',
            '## Offene Fragen',
            '',
            '### F1 — Erste Frage',
            'Text.',
            '',
            '### F2 — Zweite Frage',
            'Text.',
            '',
            '## Beantwortete Fragen',
            'keine'
        ].join( '\n' )
        const current = [
            '## 1. Traceability [Docs]',
            'Ist-Zustand: unveraendert.',
            '',
            '## Offene Fragen',
            '',
            '### F1 — Erste Frage',
            'Text.',
            '',
            '## Beantwortete Fragen',
            'keine'
        ].join( '\n' )

        const standalone = MemoValidator.checkStandaloneContinuity( { current, previous } )
        const questions = MemoValidator.checkQuestionContinuity( { current, previous } )
        const merged = standalone[ 'warnings' ].concat( questions[ 'warnings' ] )

        expect( merged.join( '\n' ) ).toMatch( /WARN-011/ )
        expect( merged.join( '\n' ) ).toMatch( /WARN-010/ )
    } )
} )
