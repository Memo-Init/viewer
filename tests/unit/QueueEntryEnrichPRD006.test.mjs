import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-006 (Memo 024 Kap 5): the Queue-Card carries the memo's Minuten-Chip (same source as the
// sidebar, PRD-005) and the LIFECYCLE status (PRD-004 model), not the raw revision enum.
// queueEntryModel is the pure, testable model mirrored by the inline renderQueueEntry.
describe( 'MemoView.queueEntryModel (PRD-006)', () => {
    it( 'AC: a queue entry carries a minutes field from aggregateMemoMinutes (same source as sidebar)', () => {
        const model = MemoView.queueEntryModel( {
            memoName: '024-feature',
            frontmatterStatus: 'Entwurf',
            revisionCount: 1,
            transcripts: [ { words: 200 }, { words: 100 } ]
        } )

        // Memo 038 Kap 13: 300 words / 130 = 2.31 -> ceil 3 (was 2 at the old 200 wpm).
        expect( model.minutes ).toBe( 3 )
    } )


    it( 'AC: a memo without a transcript shows 0 minutes (no invented default)', () => {
        const model = MemoView.queueEntryModel( {
            memoName: '024-feature',
            frontmatterStatus: 'Entwurf',
            revisionCount: 1,
            transcripts: []
        } )

        expect( model.minutes ).toBe( 0 )
    } )


    it( 'AC: a queue entry carries a lifecycle status field (PRD-004 model)', () => {
        const model = MemoView.queueEntryModel( {
            memoName: '024-feature',
            frontmatterStatus: 'Finalisiert',
            revisionCount: 3,
            transcripts: []
        } )

        expect( model.lifecycleStatus ).toBe( 'Finalisiert' )
    } )


    it( 'AC: the lifecycle status is the PRD-004 derived value, not the raw revision enum', () => {
        // revisionStatus enums are 'offen'/'transcript-eingetragen'/'eingeloggt' — the model must
        // never surface those. A non-finalized memo with >1 revision derives to "In Bearbeitung".
        const model = MemoView.queueEntryModel( {
            memoName: '024-feature',
            frontmatterStatus: 'Entwurf',
            revisionCount: 2,
            transcripts: []
        } )

        expect( model.lifecycleStatus ).toBe( 'In Bearbeitung' )
        expect( [ 'offen', 'transcript-eingetragen', 'eingeloggt' ] ).not.toContain( model.lifecycleStatus )
    } )


    it( 'a single-revision draft keeps the lifecycle status "Entwurf"', () => {
        const model = MemoView.queueEntryModel( {
            memoName: '024-feature',
            frontmatterStatus: 'Entwurf',
            revisionCount: 1,
            transcripts: []
        } )

        expect( model.lifecycleStatus ).toBe( 'Entwurf' )
    } )


    it( 'planCompleted derives the lifecycle status to "Abgeschlossen" (plan source wins)', () => {
        const model = MemoView.queueEntryModel( {
            memoName: '024-feature',
            frontmatterStatus: 'Finalisiert',
            revisionCount: 3,
            transcripts: [ { words: 200 } ],
            planCompleted: true
        } )

        expect( model.lifecycleStatus ).toBe( 'Abgeschlossen' )
        // Memo 038 Kap 13: 200 words / 130 = 1.54 -> ceil 2 (was 1 at the old 200 wpm).
        expect( model.minutes ).toBe( 2 )
    } )


    it( 'the model contains BOTH a minutes field and a lifecycle status field together', () => {
        const model = MemoView.queueEntryModel( {
            memoName: '024-feature',
            frontmatterStatus: 'Bedingt finalisiert',
            revisionCount: 4,
            transcripts: [ { words: 400 } ]
        } )

        expect( model ).toEqual( {
            memoName: '024-feature',
            // Memo 038 Kap 13: 400 words / 130 = 3.08 -> ceil 4 (was 2 at the old 200 wpm).
            minutes: 4,
            lifecycleStatus: 'Bedingt finalisiert',
            // Memo 079 M4: a memo without a raw db lifecycle state keeps the coarse label (no sub-label).
            lifecycleState: null,
            rolloutSubLabel: null,
            lifecycleDisplay: 'Bedingt finalisiert'
        } )
    } )


    it( 'tolerates missing inputs (no throw, empty/0 defaults)', () => {
        const model = MemoView.queueEntryModel( {} )

        expect( model.memoName ).toBe( '' )
        expect( model.minutes ).toBe( 0 )
        expect( model.lifecycleStatus ).toBe( 'Entwurf' )
    } )


    // Memo 079 M4 (T013): un-collapse the rollout lifecycle. A db-backed memo carrying a raw progression
    // state shows a DISTINCT sub-label instead of the collapsed 'Finalisiert'/'Abgeschlossen'.
    describe( 'Memo 079 M4 — rollout lifecycle sub-label (T013)', () => {
        it( 'rolloutSubLabel maps the four progression states + abgebrochen distinctly, else null', () => {
            expect( MemoView.rolloutSubLabel( { lifecycleState: 'rollout' } ).subLabel ).toBe( 'Rollout läuft' )
            expect( MemoView.rolloutSubLabel( { lifecycleState: 'pausiert' } ).subLabel ).toBe( 'Pausiert' )
            expect( MemoView.rolloutSubLabel( { lifecycleState: 'gelandet' } ).subLabel ).toBe( 'Gelandet' )
            expect( MemoView.rolloutSubLabel( { lifecycleState: 'gemerged' } ).subLabel ).toBe( 'Gemerged' )
            expect( MemoView.rolloutSubLabel( { lifecycleState: 'abgebrochen' } ).subLabel ).toBe( 'Abgebrochen' )
            expect( MemoView.rolloutSubLabel( { lifecycleState: 'finalisiert-research' } ).subLabel ).toBeNull()
            expect( MemoView.rolloutSubLabel( { lifecycleState: null } ).subLabel ).toBeNull()
            expect( MemoView.rolloutSubLabel( {} ).subLabel ).toBeNull()
        } )


        it( 'a memo mid-rollout DISPLAYS "Rollout läuft" instead of the collapsed "Finalisiert"', () => {
            const model = MemoView.queueEntryModel( {
                memoName: '079-mid-rollout',
                frontmatterStatus: 'Finalisiert',
                revisionCount: 3,
                transcripts: [],
                lifecycleState: 'rollout'
            } )

            // The coarse badge axis still reads Finalisiert, but the DISPLAY un-collapses it.
            expect( model.lifecycleStatus ).toBe( 'Finalisiert' )
            expect( model.rolloutSubLabel ).toBe( 'Rollout läuft' )
            expect( model.lifecycleDisplay ).toBe( 'Rollout läuft' )
            expect( model.lifecycleState ).toBe( 'rollout' )
        } )


        it( 'a paused memo and a landed memo read distinctly (no longer identical to finalized)', () => {
            const paused = MemoView.queueEntryModel( { memoName: 'a', frontmatterStatus: 'Finalisiert', revisionCount: 2, transcripts: [], lifecycleState: 'pausiert' } )
            const landed = MemoView.queueEntryModel( { memoName: 'b', frontmatterStatus: 'Finalisiert', revisionCount: 2, transcripts: [], lifecycleState: 'gelandet' } )

            expect( paused.lifecycleDisplay ).toBe( 'Pausiert' )
            expect( landed.lifecycleDisplay ).toBe( 'Gelandet' )
            expect( paused.lifecycleDisplay ).not.toBe( landed.lifecycleDisplay )
        } )


        it( 'a legacy (no db state) memo keeps the coarse lifecycle label unchanged', () => {
            const model = MemoView.queueEntryModel( { memoName: 'legacy', frontmatterStatus: 'Finalisiert', revisionCount: 1, transcripts: [] } )

            expect( model.rolloutSubLabel ).toBeNull()
            expect( model.lifecycleDisplay ).toBe( 'Finalisiert' )
        } )
    } )
} )
