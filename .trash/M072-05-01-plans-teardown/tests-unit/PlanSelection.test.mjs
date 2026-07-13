import { describe, it, expect } from '@jest/globals'

import { PlanSelection } from '../../src/PlanSelection.mjs'


describe( 'PlanSelection.toggle — Multi-Select (PRD-041)', () => {
    it( 'adds a new documentId to an empty selection', () => {
        const { selected } = PlanSelection.toggle( { selected: [], documentId: 'p--016' } )

        expect( selected ).toEqual( [ 'p--016' ] )
    } )


    it( 'adds multiple memos in selection order', () => {
        const step1 = PlanSelection.toggle( { selected: [], documentId: 'a' } )
        const step2 = PlanSelection.toggle( { selected: step1.selected, documentId: 'b' } )
        const step3 = PlanSelection.toggle( { selected: step2.selected, documentId: 'c' } )

        expect( step3.selected ).toEqual( [ 'a', 'b', 'c' ] )
    } )


    it( 'removes an already-selected id without touching the others', () => {
        const { selected } = PlanSelection.toggle( { selected: [ 'a', 'b', 'c' ], documentId: 'b' } )

        expect( selected ).toEqual( [ 'a', 'c' ] )
    } )


    it( 're-adding a removed id appends it at the end', () => {
        const removed = PlanSelection.toggle( { selected: [ 'a', 'b' ], documentId: 'a' } )
        const readded = PlanSelection.toggle( { selected: removed.selected, documentId: 'a' } )

        expect( readded.selected ).toEqual( [ 'b', 'a' ] )
    } )
} )


describe( 'PlanSelection.canCreate — Button-Gate (PRD-041)', () => {
    it( 'is false for an empty selection', () => {
        const { canCreate } = PlanSelection.canCreate( { selected: [] } )

        expect( canCreate ).toBe( false )
    } )


    it( 'is true with one selected memo', () => {
        const { canCreate } = PlanSelection.canCreate( { selected: [ 'a' ] } )

        expect( canCreate ).toBe( true )
    } )


    it( 'is true with several selected memos', () => {
        const { canCreate } = PlanSelection.canCreate( { selected: [ 'a', 'b' ] } )

        expect( canCreate ).toBe( true )
    } )
} )


describe( 'PlanSelection.resolvePaths — documentId → absolute path (PRD-042)', () => {
    it( 'resolves selected ids to their absolute paths in order', () => {
        const pathById = { a: '/abs/.memo/memos/016-x/revisions', b: '/abs/.memo/memos/017-y/revisions' }
        const { memoPaths } = PlanSelection.resolvePaths( { selected: [ 'a', 'b' ], pathById } )

        expect( memoPaths ).toEqual( [ '/abs/.memo/memos/016-x/revisions', '/abs/.memo/memos/017-y/revisions' ] )
    } )


    it( 'drops ids that have no known path (no invented paths)', () => {
        const pathById = { a: '/abs/a' }
        const { memoPaths } = PlanSelection.resolvePaths( { selected: [ 'a', 'missing' ], pathById } )

        expect( memoPaths ).toEqual( [ '/abs/a' ] )
    } )


    it( 'returns an empty list for an empty selection', () => {
        const { memoPaths } = PlanSelection.resolvePaths( { selected: [], pathById: { a: '/abs/a' } } )

        expect( memoPaths ).toEqual( [] )
    } )
} )
