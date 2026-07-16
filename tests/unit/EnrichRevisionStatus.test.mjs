import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// BUGFIX (fix/transcript-abschliessen-queue): the JOIN-Punkt. MemoView.enrichRevisionStatus
// derives every revision's revisionStatus from the transcript facts (hasTranscript / loggedIn)
// via DocumentRegistry.deriveRevisionStatus — the single source of truth (AC-17). After the join
// the queue (computeOpenRevisionQueue + browser computeQueue) reads the correct status, so a
// logged-in (= abgeschlossene) revision leaves the queue while a transcript-eingetragen one stays.
describe( 'MemoView.enrichRevisionStatus — transcript -> revisionStatus join', () => {
    const docTree = () => {
        return {
            ns: { memos: [
                {
                    documentId: 'ns--010-a',
                    projectId: 'ns',
                    memoName: '010-a',
                    revisions: [
                        { fileName: 'REV-01.md', revisionStatus: 'offen' },
                        { fileName: 'REV-02.md', revisionStatus: 'offen' },
                        { fileName: 'REV-03.md', revisionStatus: 'offen' }
                    ]
                }
            ] }
        }
    }


    it( 'derives offen when no transcript exists for the revision', () => {
        const tree = docTree()

        MemoView.enrichRevisionStatus( { tree, transcriptTree: {} } )

        const statuses = tree.ns.memos[ 0 ].revisions.map( ( r ) => r.revisionStatus )

        expect( statuses ).toEqual( [ 'offen', 'offen', 'offen' ] )
    } )


    it( 'derives transcript-eingetragen for a present-but-not-logged-in transcript', () => {
        const tree = docTree()
        const transcriptTree = {
            ns: { '010-a': [ { revisionId: 'REV-02', loggedIn: false } ] }
        }

        MemoView.enrichRevisionStatus( { tree, transcriptTree } )

        const byFile = {}
        tree.ns.memos[ 0 ].revisions.forEach( ( r ) => { byFile[ r.fileName ] = r.revisionStatus } )

        expect( byFile[ 'REV-01.md' ] ).toBe( 'offen' )
        expect( byFile[ 'REV-02.md' ] ).toBe( 'transcript-eingetragen' )
        expect( byFile[ 'REV-03.md' ] ).toBe( 'offen' )
    } )


    it( 'derives eingeloggt for a logged-in transcript', () => {
        const tree = docTree()
        const transcriptTree = {
            ns: { '010-a': [ { revisionId: 'REV-03', loggedIn: true } ] }
        }

        MemoView.enrichRevisionStatus( { tree, transcriptTree } )

        const byFile = {}
        tree.ns.memos[ 0 ].revisions.forEach( ( r ) => { byFile[ r.fileName ] = r.revisionStatus } )

        expect( byFile[ 'REV-03.md' ] ).toBe( 'eingeloggt' )
    } )


    it( 'leaves legacy/parseError revisions untouched (they never queue)', () => {
        const tree = {
            ns: { memos: [
                {
                    documentId: 'ns--010-a',
                    projectId: 'ns',
                    memoName: '010-a',
                    revisions: [
                        { fileName: 'REV-01.md', revisionStatus: 'offen', isLegacy: true },
                        { fileName: 'REV-02.md', revisionStatus: 'offen', parseError: true }
                    ]
                }
            ] }
        }
        const transcriptTree = {
            ns: { '010-a': [ { revisionId: 'REV-01', loggedIn: true }, { revisionId: 'REV-02', loggedIn: true } ] }
        }

        MemoView.enrichRevisionStatus( { tree, transcriptTree } )

        const statuses = tree.ns.memos[ 0 ].revisions.map( ( r ) => r.revisionStatus )

        expect( statuses ).toEqual( [ 'offen', 'offen' ] )
    } )


    it( 'supports legacy bare-array namespace nodes', () => {
        const tree = {
            ns: [ { documentId: 'ns--010-a', projectId: 'ns', memoName: '010-a', revisions: [ { fileName: 'REV-01.md', revisionStatus: 'offen' } ] } ]
        }
        const transcriptTree = { ns: { '010-a': [ { revisionId: 'REV-01', loggedIn: true } ] } }

        MemoView.enrichRevisionStatus( { tree, transcriptTree } )

        expect( tree.ns[ 0 ].revisions[ 0 ].revisionStatus ).toBe( 'eingeloggt' )
    } )


    it( 'tolerates missing/invalid trees (no throw)', () => {
        expect( () => MemoView.enrichRevisionStatus( { tree: undefined, transcriptTree: undefined } ) ).not.toThrow()
        expect( () => MemoView.enrichRevisionStatus( { tree: {}, transcriptTree: {} } ) ).not.toThrow()
    } )


    // The decisive end-to-end behavior: after the join, the queue drops the logged-in revision
    // and keeps the newest UNFINISHED revision. PRD-P1-03 (Memo 075, WI-008): older revisions of the
    // SAME memo are now SUPERSEDED by the newest non-prepare one and leave the queue even when they
    // never got a transcript (they used to stay 'offen' forever — live 075: REV-01/REV-02). Here
    // REV-03 is the newest (transcript-eingetragen -> stays); REV-01 (offen, no transcript) and
    // REV-02 (eingeloggt) are older -> superseded -> both drop. Queue = only the newest.
    it( 'feeds computeOpenRevisionQueue so eingeloggt + superseded drop, the newest unfinished stays', () => {
        const tree = {
            ns: { memos: [
                {
                    documentId: 'ns--010-a',
                    projectId: 'ns',
                    memoName: '010-a',
                    memoStatus: 'Entwurf',
                    revisions: [
                        { fileName: 'REV-01.md', revisionStatus: 'offen', mtimeMs: 1 },
                        { fileName: 'REV-02.md', revisionStatus: 'offen', mtimeMs: 2 },
                        { fileName: 'REV-03.md', revisionStatus: 'offen', mtimeMs: 3 }
                    ]
                }
            ] }
        }
        const transcriptTree = {
            ns: { '010-a': [
                { revisionId: 'REV-02', loggedIn: true },
                { revisionId: 'REV-03', loggedIn: false }
            ] }
        }

        MemoView.enrichRevisionStatus( { tree, transcriptTree } )

        const byFile = {}
        tree.ns.memos[ 0 ].revisions.forEach( ( r ) => { byFile[ r.fileName ] = r } )
        expect( byFile[ 'REV-01.md' ].isSuperseded ).toBe( true )
        expect( byFile[ 'REV-02.md' ].isSuperseded ).toBe( true )
        expect( byFile[ 'REV-03.md' ].isSuperseded ).toBe( false )

        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )
        const labels = queue.map( ( pair ) => pair.rev.fileName )

        expect( labels ).toEqual( [ 'REV-03.md' ] )
    } )
} )


// Sanity: deriveRevisionStatus is the single transition function the join uses.
describe( 'DocumentRegistry.deriveRevisionStatus (join contract)', () => {
    it( 'no transcript -> offen', () => {
        expect( DocumentRegistry.deriveRevisionStatus( { hasTranscript: false, isLoggedIn: false } ).revisionStatus ).toBe( 'offen' )
    } )

    it( 'transcript present, not logged -> transcript-eingetragen', () => {
        expect( DocumentRegistry.deriveRevisionStatus( { hasTranscript: true, isLoggedIn: false } ).revisionStatus ).toBe( 'transcript-eingetragen' )
    } )

    it( 'logged in -> eingeloggt', () => {
        expect( DocumentRegistry.deriveRevisionStatus( { hasTranscript: true, isLoggedIn: true } ).revisionStatus ).toBe( 'eingeloggt' )
    } )
} )


// BUGFIX (fix/transcript-abschliessen-queue): the flat-list counterpart used by the REST
// GET /api/documents endpoint. Must enrich identically to the WS tree path so both agree.
describe( 'MemoView.enrichDocumentsList — flat REST list join', () => {
    const documents = () => {
        return [
            {
                documentId: 'ns--010-a',
                projectId: 'ns',
                memoName: '010-a',
                revisions: [
                    { fileName: 'REV-01.md', revisionStatus: 'offen', isLegacy: false, parseError: false },
                    { fileName: 'REV-02.md', revisionStatus: 'offen', isLegacy: false, parseError: false }
                ]
            }
        ]
    }

    const transcriptTree = {
        ns: {
            '010-a': [
                { revisionId: 'REV-01', loggedIn: true },
                { revisionId: 'REV-02', loggedIn: false }
            ]
        }
    }

    it( 'logged-in revision -> eingeloggt, transcript-only -> transcript-eingetragen', () => {
        const docs = documents()
        MemoView.enrichDocumentsList( { documents: docs, transcriptTree } )
        const revs = docs[ 0 ].revisions

        expect( revs[ 0 ].revisionStatus ).toBe( 'eingeloggt' )
        expect( revs[ 1 ].revisionStatus ).toBe( 'transcript-eingetragen' )
    } )

    it( 'no transcript -> offen', () => {
        const docs = documents()
        MemoView.enrichDocumentsList( { documents: docs, transcriptTree: {} } )

        expect( docs[ 0 ].revisions[ 0 ].revisionStatus ).toBe( 'offen' )
    } )
} )
