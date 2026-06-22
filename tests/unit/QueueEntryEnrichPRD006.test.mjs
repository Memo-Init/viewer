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
            lifecycleStatus: 'Bedingt finalisiert'
        } )
    } )


    it( 'tolerates missing inputs (no throw, empty/0 defaults)', () => {
        const model = MemoView.queueEntryModel( {} )

        expect( model.memoName ).toBe( '' )
        expect( model.minutes ).toBe( 0 )
        expect( model.lifecycleStatus ).toBe( 'Entwurf' )
    } )
} )
