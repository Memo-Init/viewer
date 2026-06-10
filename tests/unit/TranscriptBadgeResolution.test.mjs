import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-011 (Memo 016 Kap 5): pro-revision badge resolution. The frontend transcript tree is
// shaped lastTranscriptTree[ projectId ][ memoId ] = [ { url, revisionId, ... }, ... ].
// These static methods encode the same resolution logic the inline browser helpers mirror.
describe( 'MemoView pro-revision badge resolution (PRD-011)', () => {
    const tree = {
        'nsA': {
            '016-feature': [
                { transcriptId: 't1', url: 'http://x/t1', revisionId: 'REV-01' },
                { transcriptId: 't2', url: 'http://x/t2', revisionId: 'REV-03' }
            ]
        }
    }


    describe( 'transcriptsForMemo (lose / memo-weit)', () => {
        it( 'returns all transcripts of the memo regardless of revision', () => {
            const { transcripts } = MemoView.transcriptsForMemo( { transcriptTree: tree, memoName: '016-feature' } )

            expect( transcripts.length ).toBe( 2 )
        } )


        it( 'returns an empty list for an unknown memo', () => {
            const { transcripts } = MemoView.transcriptsForMemo( { transcriptTree: tree, memoName: '999-nope' } )

            expect( transcripts ).toEqual( [] )
        } )


        it( 'tolerates a missing/invalid tree', () => {
            const { transcripts } = MemoView.transcriptsForMemo( { transcriptTree: null, memoName: '016-feature' } )

            expect( transcripts ).toEqual( [] )
        } )
    } )


    describe( 'transcriptsForRevision (explizit fuer eine Revision)', () => {
        it( 'returns only transcripts whose revisionId matches', () => {
            const { transcripts } = MemoView.transcriptsForRevision( { transcriptTree: tree, memoName: '016-feature', revisionId: 'REV-03' } )

            expect( transcripts.length ).toBe( 1 )
            expect( transcripts[ 0 ].transcriptId ).toBe( 't2' )
        } )


        it( 'returns an empty list for a revision without its own transcript', () => {
            const { transcripts } = MemoView.transcriptsForRevision( { transcriptTree: tree, memoName: '016-feature', revisionId: 'REV-02' } )

            expect( transcripts ).toEqual( [] )
        } )
    } )


    describe( 'hasTranscriptForRevision (the REV-03 badge-bug fix)', () => {
        it( 'is true for a revision WITH its own transcript', () => {
            const { hasTranscript } = MemoView.hasTranscriptForRevision( { transcriptTree: tree, memoName: '016-feature', revisionId: 'REV-01' } )

            expect( hasTranscript ).toBe( true )
        } )


        it( 'is FALSE for a revision WITHOUT its own transcript, even though the memo has others', () => {
            const { hasTranscript } = MemoView.hasTranscriptForRevision( { transcriptTree: tree, memoName: '016-feature', revisionId: 'REV-02' } )

            expect( hasTranscript ).toBe( false )
        } )
    } )


    describe( 'hasTranscriptForMemo (aggregate / lose)', () => {
        it( 'is true when the memo has at least one transcript on any revision', () => {
            const { hasTranscript } = MemoView.hasTranscriptForMemo( { transcriptTree: tree, memoName: '016-feature' } )

            expect( hasTranscript ).toBe( true )
        } )


        it( 'is false for a memo without transcripts', () => {
            const { hasTranscript } = MemoView.hasTranscriptForMemo( { transcriptTree: tree, memoName: '999-nope' } )

            expect( hasTranscript ).toBe( false )
        } )
    } )


    describe( 'revisionIdFromFileName', () => {
        it( 'extracts the REV id from a fileName', () => {
            const { revisionId } = MemoView.revisionIdFromFileName( { fileName: 'REV-03.md' } )

            expect( revisionId ).toBe( 'REV-03' )
        } )


        it( 'returns null when the fileName encodes no revision', () => {
            const { revisionId } = MemoView.revisionIdFromFileName( { fileName: 'phase-2' } )

            expect( revisionId ).toBeNull()
        } )
    } )
} )


// PRD-013 (Memo 016 Kap 3): Soll-Nummern-Logik. next = max(existing REV)+1, previous = max.
// Crucially NOT derived from the viewed revision suffix.
describe( 'MemoView.nextRevisionNumbers (PRD-013)', () => {
    it( 'computes next = max+1 from the revisions bestand', () => {
        const revisions = [
            { fileName: 'REV-01.md' },
            { fileName: 'REV-02.md' },
            { fileName: 'REV-03.md' }
        ]

        const { previous, next, previousId, nextId } = MemoView.nextRevisionNumbers( { revisions } )

        expect( previous ).toBe( 3 )
        expect( next ).toBe( 4 )
        expect( previousId ).toBe( 'REV-03' )
        expect( nextId ).toBe( 'REV-04' )
    } )


    it( 'ignores the viewed revision — max is computed across ALL revisions (off-by-one fix)', () => {
        // Viewing REV-02 must still yield next = REV-04 when REV-03 exists.
        const revisions = [
            { fileName: 'REV-01.md' },
            { fileName: 'REV-02.md' },
            { fileName: 'REV-03.md' }
        ]

        const { nextId } = MemoView.nextRevisionNumbers( { revisions } )

        expect( nextId ).toBe( 'REV-04' )
        expect( nextId ).not.toBe( 'REV-03' )
    } )


    it( 'starts at REV-01 when there are no revisions yet', () => {
        const { previous, next, nextId } = MemoView.nextRevisionNumbers( { revisions: [] } )

        expect( previous ).toBe( 0 )
        expect( next ).toBe( 1 )
        expect( nextId ).toBe( 'REV-01' )
    } )


    it( 'handles non-array input safely', () => {
        const { nextId } = MemoView.nextRevisionNumbers( { revisions: undefined } )

        expect( nextId ).toBe( 'REV-01' )
    } )
} )
