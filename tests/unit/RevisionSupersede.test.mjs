import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-P1-03 (Memo 075, WI-008): abgelöste Revisionen bleiben nicht mehr "offen". A revision used to
// leave the queue only by logging in its transcript or by memo finalization — a revision WITHOUT a
// transcript was a dead end and stayed 'offen' forever (live 075: REV-01/REV-02). The join
// MemoView.#markSupersededRevisions marks every revision of a memo except the newest non-prepare one
// with isSuperseded: true, and DocumentRegistry.isInQueue drops superseded revisions.
describe( 'DocumentRegistry.isInQueue — isSuperseded drops a revision (PRD-P1-03)', () => {
    it( 'a superseded open revision is NOT in the queue', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen', isSuperseded: true } } )

        expect( inQueue ).toBe( false )
    } )


    it( 'a non-superseded open revision stays in the queue', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen', isSuperseded: false } } )

        expect( inQueue ).toBe( true )
    } )


    it( 'a revision without the flag (undefined) stays in the queue (back-compat)', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen' } } )

        expect( inQueue ).toBe( true )
    } )
} )


describe( 'MemoView.enrichRevisionStatus — supersede join (PRD-P1-03, memo-075 shape)', () => {
    const memo075Tree = () => {
        return {
            ns: { memos: [
                {
                    documentId: 'ns--075-x',
                    projectId: 'ns',
                    memoName: '075-x',
                    memoStatus: 'Entwurf',
                    revisions: [
                        { fileName: 'REV-01.md', revisionType: 'full', revisionStatus: 'offen', mtimeMs: 1 },
                        { fileName: 'REV-02.md', revisionType: 'full', revisionStatus: 'offen', mtimeMs: 2 },
                        { fileName: 'REV-03.md', revisionType: 'full', revisionStatus: 'offen', mtimeMs: 3 },
                        { fileName: 'REV-04-prepare.md', revisionType: 'prepare', revisionStatus: 'offen', mtimeMs: 4 },
                        { fileName: 'REV-04.md', revisionType: 'full', revisionStatus: 'offen', mtimeMs: 5 },
                        { fileName: 'REV-05.md', revisionType: 'full', revisionStatus: 'offen', mtimeMs: 6 },
                        { fileName: 'REV-06.md', revisionType: 'full', revisionStatus: 'offen', mtimeMs: 7 }
                    ]
                }
            ] }
        }
    }


    it( 'marks every non-prepare revision except the newest (REV-06) as superseded', () => {
        const tree = memo075Tree()

        MemoView.enrichRevisionStatus( { tree, transcriptTree: {} } )

        const byFile = {}
        tree.ns.memos[ 0 ].revisions.forEach( ( r ) => { byFile[ r.fileName ] = r } )

        expect( byFile[ 'REV-01.md' ].isSuperseded ).toBe( true )
        expect( byFile[ 'REV-02.md' ].isSuperseded ).toBe( true )
        expect( byFile[ 'REV-03.md' ].isSuperseded ).toBe( true )
        expect( byFile[ 'REV-04.md' ].isSuperseded ).toBe( true )
        expect( byFile[ 'REV-05.md' ].isSuperseded ).toBe( true )
        expect( byFile[ 'REV-06.md' ].isSuperseded ).toBe( false )
        // Prepare revisions never carry the supersede flag (already excluded via isPrepare).
        expect( byFile[ 'REV-04-prepare.md' ].isSuperseded ).toBe( false )
    } )


    it( 'only the newest revision remains in the queue (REV-01/REV-02 no longer perpetually open)', () => {
        const tree = memo075Tree()

        MemoView.enrichRevisionStatus( { tree, transcriptTree: {} } )
        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )
        const labels = queue.map( ( pair ) => pair.rev.fileName )

        expect( labels ).toEqual( [ 'REV-06.md' ] )
    } )
} )


describe( 'MemoView.enrichDocumentsList — supersede join mirrors the tree path (PRD-P1-03)', () => {
    it( 'marks older revisions superseded in the flat REST list too', () => {
        const documents = [
            {
                documentId: 'ns--075-x',
                projectId: 'ns',
                memoName: '075-x',
                revisions: [
                    { fileName: 'REV-01.md', revisionType: 'full', revisionStatus: 'offen' },
                    { fileName: 'REV-02.md', revisionType: 'full', revisionStatus: 'offen' },
                    { fileName: 'REV-03.md', revisionType: 'full', revisionStatus: 'offen' }
                ]
            }
        ]

        MemoView.enrichDocumentsList( { documents, transcriptTree: {} } )

        const byFile = {}
        documents[ 0 ].revisions.forEach( ( r ) => { byFile[ r.fileName ] = r } )

        expect( byFile[ 'REV-01.md' ].isSuperseded ).toBe( true )
        expect( byFile[ 'REV-02.md' ].isSuperseded ).toBe( true )
        expect( byFile[ 'REV-03.md' ].isSuperseded ).toBe( false )
    } )
} )
