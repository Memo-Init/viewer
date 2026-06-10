import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-002 (Memo 018 Kap 5): the sidebar Queue (Warteschlange). Data source = OPEN revisions
// (revisionStatus === 'offen', the single Warteschlangen-Regel from DocumentRegistry.isInQueue)
// across ALL namespaces. Result = a FLAT list of { doc, rev } pairs, one entry per open revision,
// NO grouping by memo or namespace (F3=A). Order = FIFO, OLDEST ON TOP (ascending mtimeMs).
describe( 'MemoView.computeOpenRevisionQueue (PRD-002)', () => {
    const rev = ( fileName, revisionStatus, mtimeMs ) => {
        return { fileName, revisionStatus, mtimeMs }
    }

    const memo = ( projectId, memoName, revisions ) => {
        return { documentId: projectId + '--' + memoName, projectId, memoName, revisions }
    }


    // BUGFIX (fix/transcript-abschliessen-queue): the queue keeps every UNFINISHED revision —
    // 'offen' AND 'transcript-eingetragen'. ONLY 'eingeloggt' (= abgeschlossen) drops out.
    it( 'keeps offen + transcript-eingetragen, drops only eingeloggt', () => {
        const tree = {
            ns: { memos: [
                memo( 'ns', '010-a', [
                    rev( 'REV-01', 'offen', 1000 ),
                    rev( 'REV-02', 'transcript-eingetragen', 1100 ),
                    rev( 'REV-03', 'eingeloggt', 1200 )
                ] )
            ] }
        }

        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )
        const labels = queue.map( ( pair ) => pair.rev.fileName )

        expect( labels ).toEqual( [ 'REV-01', 'REV-02' ] )
    } )


    it( 'collects open revisions across multiple namespaces', () => {
        const tree = {
            alpha: { memos: [ memo( 'alpha', '010-a', [ rev( 'REV-01', 'offen', 2000 ) ] ) ] },
            beta: { memos: [ memo( 'beta', '020-b', [ rev( 'REV-01', 'offen', 1000 ) ] ) ] }
        }

        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )
        const namespaces = queue.map( ( pair ) => pair.doc.projectId )

        expect( namespaces ).toContain( 'alpha' )
        expect( namespaces ).toContain( 'beta' )
        expect( queue.length ).toBe( 2 )
    } )


    it( 'produces a flat list of { doc, rev } pairs without nested groups', () => {
        const tree = {
            ns: { memos: [ memo( 'ns', '010-a', [ rev( 'REV-01', 'offen', 1000 ) ] ) ] }
        }

        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

        expect( Array.isArray( queue ) ).toBe( true )
        expect( queue[0] ).toHaveProperty( 'doc' )
        expect( queue[0] ).toHaveProperty( 'rev' )
        expect( queue[0].rev.fileName ).toBe( 'REV-01' )
        expect( queue[0].doc.memoName ).toBe( '010-a' )
    } )


    it( 'emits one entry per open revision — multiple open revisions of the same memo = multiple entries, no grouping', () => {
        const tree = {
            ns: { memos: [
                memo( 'ns', '010-a', [
                    rev( 'REV-01', 'offen', 1000 ),
                    rev( 'REV-03', 'offen', 1300 )
                ] )
            ] }
        }

        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )
        const labels = queue.map( ( pair ) => pair.rev.fileName )

        expect( queue.length ).toBe( 2 )
        expect( labels ).toEqual( [ 'REV-01', 'REV-03' ] )
        expect( queue[0].doc ).toBe( queue[1].doc )
    } )


    it( 'sorts FIFO — oldest mtimeMs on top', () => {
        const tree = {
            alpha: { memos: [ memo( 'alpha', '010-a', [ rev( 'REV-01', 'offen', 3000 ) ] ) ] },
            beta: { memos: [
                memo( 'beta', '020-b', [ rev( 'REV-01', 'offen', 1000 ) ] ),
                memo( 'beta', '021-c', [ rev( 'REV-01', 'offen', 2000 ) ] )
            ] }
        }

        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )
        const order = queue.map( ( pair ) => pair.rev.mtimeMs )

        expect( order ).toEqual( [ 1000, 2000, 3000 ] )
    } )


    it( 'places revisions without a timestamp at the bottom', () => {
        const tree = {
            ns: { memos: [
                memo( 'ns', '010-a', [
                    rev( 'REV-02', 'offen', null ),
                    rev( 'REV-01', 'offen', 1000 )
                ] )
            ] }
        }

        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )
        const order = queue.map( ( pair ) => pair.rev.fileName )

        expect( order ).toEqual( [ 'REV-01', 'REV-02' ] )
    } )


    it( 'supports legacy bare-array namespace nodes', () => {
        const tree = {
            ns: [ memo( 'ns', '010-a', [ rev( 'REV-01', 'offen', 1000 ) ] ) ]
        }

        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

        expect( queue.length ).toBe( 1 )
        expect( queue[0].rev.fileName ).toBe( 'REV-01' )
    } )


    it( 'returns an empty queue for an empty tree', () => {
        const { queue } = MemoView.computeOpenRevisionQueue( { tree: {} } )

        expect( queue ).toEqual( [] )
    } )


    it( 'tolerates a missing/invalid tree', () => {
        const { queue } = MemoView.computeOpenRevisionQueue( { tree: undefined } )

        expect( queue ).toEqual( [] )
    } )


    it( 'does not mutate the input revisions', () => {
        const revs = [ rev( 'REV-02', 'offen', 2000 ), rev( 'REV-01', 'offen', 1000 ) ]
        const tree = { ns: { memos: [ memo( 'ns', '010-a', revs ) ] } }

        MemoView.computeOpenRevisionQueue( { tree } )

        expect( revs[0].fileName ).toBe( 'REV-02' )
    } )


    // PRD-001 (Memo 019 Kap 1): finalized memos and legacy/parseError revisions never enter the queue.
    describe( 'PRD-001 (Memo 019) — finalized + legacy exclusion', () => {
        const finalizedMemo = ( projectId, memoName, memoStatus, revisions ) => {
            return { documentId: projectId + '--' + memoName, projectId, memoName, memoStatus, revisions }
        }

        const legacyRev = ( fileName, revisionStatus, mtimeMs, flags ) => {
            return Object.assign( { fileName, revisionStatus, mtimeMs }, flags )
        }


        it( 'AC-8: a Finalisiert memo with an open revision produces an EMPTY queue', () => {
            const tree = {
                ns: { memos: [
                    finalizedMemo( 'ns', '010-a', 'Finalisiert', [ rev( 'REV-01', 'offen', 1000 ) ] )
                ] }
            }

            const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

            expect( queue ).toEqual( [] )
        } )


        it( 'AC-5: a Bedingt finalisiert memo with an open revision produces an EMPTY queue', () => {
            const tree = {
                ns: { memos: [
                    finalizedMemo( 'ns', '010-a', 'Bedingt finalisiert', [ rev( 'REV-01', 'offen', 1000 ) ] )
                ] }
            }

            const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

            expect( queue ).toEqual( [] )
        } )


        it( 'an Entwurf memo with an open revision still enters the queue', () => {
            const tree = {
                ns: { memos: [
                    finalizedMemo( 'ns', '010-a', 'Entwurf', [ rev( 'REV-01', 'offen', 1000 ) ] )
                ] }
            }

            const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

            expect( queue.length ).toBe( 1 )
        } )


        it( 'AC-4/15: a legacy open revision is excluded; a non-legacy open revision is kept', () => {
            const tree = {
                ns: { memos: [
                    memo( 'ns', '010-a', [
                        legacyRev( 'REV-01', 'offen', 1000, { isLegacy: true } ),
                        rev( 'REV-02', 'offen', 1100 )
                    ] )
                ] }
            }

            const { queue } = MemoView.computeOpenRevisionQueue( { tree } )
            const labels = queue.map( ( pair ) => pair.rev.fileName )

            expect( labels ).toEqual( [ 'REV-02' ] )
        } )


        it( 'a parseError open revision is excluded from the queue', () => {
            const tree = {
                ns: { memos: [
                    memo( 'ns', '010-a', [
                        legacyRev( 'REV-09', 'offen', 1000, { parseError: true } )
                    ] )
                ] }
            }

            const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

            expect( queue ).toEqual( [] )
        } )


        // BUG (2026-05-28): REV-XX-prepare.md ist ein Basis-Snapshot aus memo-revision-generate,
        // kein offener Transcript-Job. Prepare-Revisionen tauchten faelschlich in der Warteschlange
        // auf. Sie bleiben im Namespace-Baum sichtbar, aber nie in der Queue.
        it( 'a prepare revision is excluded from the queue (Basis-Snapshot, not a transcript job)', () => {
            const tree = {
                ns: { memos: [
                    memo( 'ns', '074-asset', [
                        legacyRev( 'REV-02-prepare', 'offen', 1000, { revisionType: 'prepare' } ),
                        legacyRev( 'REV-02', 'offen', 1100, { revisionType: 'full' } )
                    ] )
                ] }
            }

            const { queue } = MemoView.computeOpenRevisionQueue( { tree } )
            const labels = queue.map( ( pair ) => pair.rev.fileName )

            expect( labels ).toEqual( [ 'REV-02' ] )
        } )
    } )
} )
