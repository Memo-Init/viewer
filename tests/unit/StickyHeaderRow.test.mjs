import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-004 (Memo 018 Kap 7): the Transcript-Statuszeile model. Validates the words/min guard
// (015 REV-05 R1), the einloggen-button gate (AC-3), the unified badge class (AC-6) and the
// reversible login/logout mode. PRD-005 (Kap 8): logged-in revisions leave the queue.
describe( 'MemoView.stickyHeaderRow (PRD-004 Transcript-Statuszeile)', () => {
    describe( 'words/min guard (015 REV-05 R1, AC-4 / AC-5)', () => {
        it( 'hides words/min when no transcriptUrl is present', () => {
            const row = MemoView.stickyHeaderRow( { hasTranscript: false, isLoggedIn: false, transcriptUrl: '' } )

            expect( row.wordsVisible ).toBe( false )
        } )


        it( 'shows words/min when a transcriptUrl is present', () => {
            const row = MemoView.stickyHeaderRow( { hasTranscript: true, isLoggedIn: false, transcriptUrl: 'http://x/t1' } )

            expect( row.wordsVisible ).toBe( true )
        } )


        it( 'treats null transcriptUrl as not present', () => {
            const row = MemoView.stickyHeaderRow( { hasTranscript: false, isLoggedIn: false, transcriptUrl: null } )

            expect( row.wordsVisible ).toBe( false )
        } )
    } )


    describe( 'revisionStatus mapping (reuses the Phase-1 status model)', () => {
        it( 'offen when no transcript', () => {
            const row = MemoView.stickyHeaderRow( { hasTranscript: false, isLoggedIn: false, transcriptUrl: '' } )

            expect( row.revisionStatus ).toBe( 'offen' )
        } )


        it( 'transcript-eingetragen when a transcript exists but not logged in', () => {
            const row = MemoView.stickyHeaderRow( { hasTranscript: true, isLoggedIn: false, transcriptUrl: 'http://x/t1' } )

            expect( row.revisionStatus ).toBe( 'transcript-eingetragen' )
        } )


        it( 'eingeloggt when logged in', () => {
            const row = MemoView.stickyHeaderRow( { hasTranscript: true, isLoggedIn: true, transcriptUrl: 'http://x/t1' } )

            expect( row.revisionStatus ).toBe( 'eingeloggt' )
        } )
    } )


    describe( 'einloggen button gate (AC-3) + reversible mode (PRD-005 #8)', () => {
        it( 'disabled while status is offen', () => {
            const row = MemoView.stickyHeaderRow( { hasTranscript: false, isLoggedIn: false, transcriptUrl: '' } )

            expect( row.einloggenEnabled ).toBe( false )
        } )


        it( 'enabled + login mode when transcript-eingetragen', () => {
            const row = MemoView.stickyHeaderRow( { hasTranscript: true, isLoggedIn: false, transcriptUrl: 'http://x/t1' } )

            expect( row.einloggenEnabled ).toBe( true )
            expect( row.einloggenMode ).toBe( 'login' )
        } )


        it( 'enabled + logout mode when eingeloggt (undo path)', () => {
            const row = MemoView.stickyHeaderRow( { hasTranscript: true, isLoggedIn: true, transcriptUrl: 'http://x/t1' } )

            expect( row.einloggenEnabled ).toBe( true )
            expect( row.einloggenMode ).toBe( 'logout' )
        } )
    } )


    describe( 'unified badge class naming (AC-6)', () => {
        it( 'uses the mh-badge--{typ} prefix for all states', () => {
            const offen = MemoView.stickyHeaderRow( { hasTranscript: false, isLoggedIn: false, transcriptUrl: '' } )
            const trans = MemoView.stickyHeaderRow( { hasTranscript: true, isLoggedIn: false, transcriptUrl: 'http://x/t1' } )
            const ein = MemoView.stickyHeaderRow( { hasTranscript: true, isLoggedIn: true, transcriptUrl: 'http://x/t1' } )

            expect( offen.statusBadgeClass.startsWith( 'mh-badge--' ) ).toBe( true )
            expect( trans.statusBadgeClass.startsWith( 'mh-badge--' ) ).toBe( true )
            expect( ein.statusBadgeClass.startsWith( 'mh-badge--' ) ).toBe( true )
        } )
    } )
} )


// PRD-005 (Memo 018 Kap 8 #7 / AC-8 / TL-13): a logged-in revision leaves the queue.
// BUGFIX (fix/transcript-abschliessen-queue): the queue filter (computeOpenRevisionQueue ->
// DocumentRegistry.isInQueue) keeps every revision whose status is NOT 'eingeloggt' — i.e. both
// 'offen' and 'transcript-eingetragen' stay. Only 'eingeloggt' (= abgeschlossen) drops out.
describe( 'queue excludes logged-in revisions (PRD-005 #7)', () => {
    it( 'TL-13: deriveRevisionStatus eingeloggt -> not in queue', () => {
        const { revisionStatus } = DocumentRegistry.deriveRevisionStatus( { hasTranscript: true, isLoggedIn: true } )

        expect( revisionStatus ).toBe( 'eingeloggt' )

        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus } } )

        expect( inQueue ).toBe( false )
    } )


    it( 'AC-8: computeOpenRevisionQueue drops the eingeloggt revision, keeps the offen one', () => {
        const tree = {
            nsA: {
                memos: [
                    {
                        documentId: 'nsA--018',
                        revisions: [
                            { fileName: 'REV-01.md', revisionStatus: 'eingeloggt', mtimeMs: 1 },
                            { fileName: 'REV-02.md', revisionStatus: 'offen', mtimeMs: 2 }
                        ]
                    }
                ]
            }
        }

        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

        expect( queue.length ).toBe( 1 )
        expect( queue[ 0 ].rev.fileName ).toBe( 'REV-02.md' )
    } )


    // BUGFIX (fix/transcript-abschliessen-queue): transcript-eingetragen is UNFINISHED work and
    // stays in the queue until the user closes it via Einloggen ('eingeloggt').
    it( 'transcript-eingetragen but not logged in STAYS in the queue', () => {
        const { revisionStatus } = DocumentRegistry.deriveRevisionStatus( { hasTranscript: true, isLoggedIn: false } )

        expect( revisionStatus ).toBe( 'transcript-eingetragen' )
        expect( DocumentRegistry.isInQueue( { revision: { revisionStatus } } ).inQueue ).toBe( true )
    } )
} )
