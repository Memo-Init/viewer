import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-001 (Memo 018 Kap 4, F7=A): the 3-state ball status (Memo 014 Kap 9) is DERIVED from the
// revision-level revisionStatus + memoFinalized. The static MemoView.deriveBallStatus mirrors
// the inline browser helper of the same name. Full mapping table from AC-11:
//   offen                    -> 'Wartet auf User-Feedback'  (◐, ball-feedback)
//   transcript-eingetragen   -> 'Transcript hinterlegt'     (◑, ball-transcript)
//   eingeloggt (+ finalized) -> 'Finalisiert (Locked)'      (✓, ball-locked)
describe( 'MemoView.deriveBallStatus (PRD-001)', () => {
    it( 'maps offen to Wartet auf User-Feedback (AC-12)', () => {
        const { ballStatus } = MemoView.deriveBallStatus( { revisionStatus: 'offen', memoFinalized: false } )

        expect( ballStatus ).toBe( 'Wartet auf User-Feedback' )
    } )


    it( 'maps transcript-eingetragen to Transcript hinterlegt (AC-13)', () => {
        const { ballStatus } = MemoView.deriveBallStatus( { revisionStatus: 'transcript-eingetragen', memoFinalized: false } )

        expect( ballStatus ).toBe( 'Transcript hinterlegt' )
    } )


    it( 'maps eingeloggt + finalisiert to Finalisiert (Locked) (AC-14)', () => {
        const { ballStatus } = MemoView.deriveBallStatus( { revisionStatus: 'eingeloggt', memoFinalized: true } )

        expect( ballStatus ).toBe( 'Finalisiert (Locked)' )
    } )


    it( 'eingeloggt without finalize does NOT lock — stays feedback', () => {
        const { ballStatus } = MemoView.deriveBallStatus( { revisionStatus: 'eingeloggt', memoFinalized: false } )

        expect( ballStatus ).toBe( 'Wartet auf User-Feedback' )
    } )


    it( 'transcript-eingetragen wins over a finalize flag (no Locked without eingeloggt)', () => {
        const { ballStatus } = MemoView.deriveBallStatus( { revisionStatus: 'transcript-eingetragen', memoFinalized: true } )

        expect( ballStatus ).toBe( 'Transcript hinterlegt' )
    } )


    it( 'an unknown revisionStatus falls back to Wartet auf User-Feedback', () => {
        const { ballStatus } = MemoView.deriveBallStatus( { revisionStatus: undefined, memoFinalized: false } )

        expect( ballStatus ).toBe( 'Wartet auf User-Feedback' )
    } )
} )
