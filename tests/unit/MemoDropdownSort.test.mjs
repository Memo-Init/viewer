import { describe, it, expect } from '@jest/globals'

import { MemoDropdownSort } from '../../src/MemoDropdownSort.mjs'


// Memo 019 PRD-003 US-1 — Memo-Dropdown "neuestes zuerst".
describe( 'MemoDropdownSort.newestFirst (PRD-003)', () => {
    it( 'orders memos by highest revision number, descending', () => {
        const memos = [
            { memoName: 'a', revisions: [ { fileName: 'REV-01.md' } ] },
            { memoName: 'b', revisions: [ { fileName: 'REV-01.md' }, { fileName: 'REV-03.md' } ] },
            { memoName: 'c', revisions: [ { fileName: 'REV-02.md' } ] }
        ]

        const { memos: sorted } = MemoDropdownSort.newestFirst( { memos } )

        expect( sorted.map( ( m ) => m.memoName ) ).toEqual( [ 'b', 'c', 'a' ] )
    } )


    it( 'falls back to mtime (newest first) when revision numbers tie', () => {
        const memos = [
            { memoName: 'old', revisions: [ { fileName: 'REV-01.md' } ], mtime: '2026-01-01T00:00:00.000Z' },
            { memoName: 'new', revisions: [ { fileName: 'REV-01.md' } ], mtime: '2026-05-01T00:00:00.000Z' }
        ]

        const { memos: sorted } = MemoDropdownSort.newestFirst( { memos } )

        expect( sorted.map( ( m ) => m.memoName ) ).toEqual( [ 'new', 'old' ] )
    } )


    it( 'treats a memo without revisions as revision 0', () => {
        const { highest } = MemoDropdownSort.highestRevisionNumber( { memo: { memoName: 'x' } } )

        expect( highest ).toBe( 0 )
    } )


    it( 'does not mutate the input array', () => {
        const memos = [
            { memoName: 'a', revisions: [ { fileName: 'REV-01.md' } ] },
            { memoName: 'b', revisions: [ { fileName: 'REV-09.md' } ] }
        ]
        const original = memos.slice()

        MemoDropdownSort.newestFirst( { memos } )

        expect( memos ).toEqual( original )
    } )


    it( 'handles an empty list', () => {
        const { memos } = MemoDropdownSort.newestFirst( { memos: [] } )

        expect( memos ).toEqual( [] )
    } )
} )
