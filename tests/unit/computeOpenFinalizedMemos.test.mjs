import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'


describe( 'MemoView.computeOpenFinalizedMemos (PRD-011)', () => {
    const documents = [
        { documentId: 'nsA--013-viewer', projectId: 'nsA', memoName: '013-viewer', documentKind: 'memo', memoStatus: 'Finalisiert' },
        { documentId: 'nsA--014-other', projectId: 'nsA', memoName: '014-other', documentKind: 'memo', memoStatus: 'Finalisiert' },
        { documentId: 'nsA--015-draft', projectId: 'nsA', memoName: '015-draft', documentKind: 'memo', memoStatus: 'Entwurf' },
        { documentId: 'nsB--020-b', projectId: 'nsB', memoName: '020-b', documentKind: 'memo', memoStatus: 'Finalisiert' }
    ]


    it( 'returns only finalized memos of the given namespace', () => {
        const { openMemos } = MemoView.computeOpenFinalizedMemos( { projectId: 'nsA', plans: [], documents } )

        const ids = openMemos.map( ( m ) => m['memoName'] )

        expect( ids ).toContain( '013-viewer' )
        expect( ids ).toContain( '014-other' )
        expect( ids ).not.toContain( '015-draft' )
        expect( ids ).not.toContain( '020-b' )
    } )


    it( 'returns all namespaces when projectId is undefined', () => {
        const { openMemos } = MemoView.computeOpenFinalizedMemos( { projectId: undefined, plans: [], documents } )

        expect( openMemos.length ).toBe( 3 )
    } )


    it( 'excludes a memo referenced in a plan (namespace + memoId match)', () => {
        const plans = [
            { planId: 'PLAN-001-x', memos: [ { namespace: 'nsA', memoId: '013', name: 'viewer' } ] }
        ]

        const { openMemos } = MemoView.computeOpenFinalizedMemos( { projectId: 'nsA', plans, documents } )

        const ids = openMemos.map( ( m ) => m['memoName'] )

        expect( ids ).not.toContain( '013-viewer' )
        expect( ids ).toContain( '014-other' )
    } )


    it( 'never excludes a memo when the plan lacks the namespace/memo-aware field (safe default)', () => {
        const plans = [
            { planId: 'PLAN-002-legacy', phases: [] }
        ]

        const { openMemos } = MemoView.computeOpenFinalizedMemos( { projectId: 'nsA', plans, documents } )

        const ids = openMemos.map( ( m ) => m['memoName'] )

        expect( ids ).toContain( '013-viewer' )
        expect( ids ).toContain( '014-other' )
    } )


    it( 'never includes a non-finalized memo', () => {
        const { openMemos } = MemoView.computeOpenFinalizedMemos( { projectId: 'nsA', plans: [], documents } )

        const draft = openMemos.find( ( m ) => m['memoName'] === '015-draft' )

        expect( draft ).toBeUndefined()
    } )
} )
