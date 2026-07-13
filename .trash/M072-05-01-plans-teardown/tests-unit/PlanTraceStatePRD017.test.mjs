import { describe, it, expect, beforeAll } from '@jest/globals'

import { extractFunctions } from '../helpers/extractFunction.mjs'


// PRD-017 (Memo 002 REV-03 Kap 10): Plan-View state rendering. The trace builders are pure
// functions inside MemoView's inline <script>; they are lifted out and unit-tested here.
// US-1 — HEAD-Commit shown for in-progress rows. US-2 — executionOrder sorts the rows.
// US-3 — legacy/empty plans degrade to the prior array-order behaviour.
describe( 'PRD-017 Plan-Trace state rendering', () => {
    let fns = {}


    beforeAll( async () => {
        fns = await extractFunctions( [
            'phaseProgress',
            'phaseRowFromPhase',
            'rowPhaseRef',
            'executionOrderKey',
            'orderRows',
            'collectTraceRows'
        ] )
    } )


    describe( 'phaseProgress', () => {
        it( 'counts done phases and computes percent', () => {
            const result = fns.phaseProgress( [ { status: 'done' }, { status: 'in-progress' }, { status: 'pending' }, { status: 'done' } ] )

            expect( result ).toEqual( { done: 2, total: 4, percent: 50 } )
        } )


        it( 'returns zero percent for an empty list', () => {
            const result = fns.phaseProgress( [] )

            expect( result ).toEqual( { done: 0, total: 0, percent: 0 } )
        } )


        it( 'tolerates undefined input', () => {
            const result = fns.phaseProgress( undefined )

            expect( result ).toEqual( { done: 0, total: 0, percent: 0 } )
        } )
    } )


    describe( 'phaseRowFromPhase — US-1 HEAD-Commit for in-progress', () => {
        it( 'shows the headCommit for an in-progress phase without PRDs', () => {
            const rows = fns.phaseRowFromPhase( { id: 'P5', status: 'in-progress', headCommit: 'abc1234def' }, 'memo-init', 'M002' )

            expect( rows ).toHaveLength( 1 )
            expect( rows[ 0 ].headCommit ).toBe( 'abc1234def' )
        } )


        it( 'still shows the headCommit for a done phase', () => {
            const rows = fns.phaseRowFromPhase( { id: 'P5', status: 'done', headCommit: 'abc1234def' }, 'ns', 'M002' )

            expect( rows[ 0 ].headCommit ).toBe( 'abc1234def' )
        } )


        it( 'leaves the commit empty for a pending phase', () => {
            const rows = fns.phaseRowFromPhase( { id: 'P5', status: 'pending', headCommit: 'abc1234def' }, 'ns', 'M002' )

            expect( rows[ 0 ].headCommit ).toBe( '' )
        } )


        it( 'returns an empty string (no undefined) when no headCommit is present', () => {
            const rows = fns.phaseRowFromPhase( { id: 'P5', status: 'in-progress' }, 'ns', 'M002' )

            expect( rows[ 0 ].headCommit ).toBe( '' )
        } )


        it( 'shows a per-PRD headCommit for an in-progress PRD', () => {
            const phase = { id: 'P5', status: 'in-progress', prds: [ { id: 'PRD-017', execute: 'in-progress', headCommit: 'deadbee0' } ] }
            const rows = fns.phaseRowFromPhase( phase, 'ns', 'M002' )

            expect( rows[ 0 ].headCommit ).toBe( 'deadbee0' )
        } )


        it( 'shows the commit for a fully done PRD', () => {
            const phase = { id: 'P5', status: 'in-progress', headCommit: 'phaseAAA', prds: [ { id: 'PRD-017', execute: 'done', evaluate: 'done' } ] }
            const rows = fns.phaseRowFromPhase( phase, 'ns', 'M002' )

            expect( rows[ 0 ].headCommit ).toBe( 'phaseAAA' )
        } )


        it( 'leaves a pending PRD commit empty', () => {
            const phase = { id: 'P5', status: 'in-progress', headCommit: 'phaseAAA', prds: [ { id: 'PRD-017', generate: 'pending', execute: 'pending', evaluate: 'pending' } ] }
            const rows = fns.phaseRowFromPhase( phase, 'ns', 'M002' )

            expect( rows[ 0 ].headCommit ).toBe( '' )
        } )
    } )


    describe( 'orderRows — US-2 executionOrder sorting', () => {
        const make = ( ref ) => ( { phaseRef: ref } )


        it( 'is the identity (copy) without an executionOrder', () => {
            const rows = [ make( 'a' ), make( 'b' ), make( 'c' ) ]
            const out = fns.orderRows( rows, undefined )

            expect( out ).toEqual( rows )
            expect( out ).not.toBe( rows )
        } )


        it( 'sorts rows by string executionOrder entries', () => {
            const rows = [ make( 'a' ), make( 'b' ), make( 'c' ) ]
            const out = fns.orderRows( rows, [ 'c', 'a', 'b' ] )

            expect( out.map( ( r ) => r.phaseRef ) ).toEqual( [ 'c', 'a', 'b' ] )
        } )


        it( 'places unmatched rows stably at the end in array order', () => {
            const rows = [ make( 'x' ), make( 'b' ), make( 'y' ), make( 'a' ) ]
            const out = fns.orderRows( rows, [ 'a', 'b' ] )

            expect( out.map( ( r ) => r.phaseRef ) ).toEqual( [ 'a', 'b', 'x', 'y' ] )
        } )


        it( 'accepts object executionOrder entries with phaseRef', () => {
            const rows = [ make( 'ns · M002 · P5' ), make( 'ns · M002 · P4' ) ]
            const out = fns.orderRows( rows, [ { phaseRef: 'ns · M002 · P4' }, { phaseRef: 'ns · M002 · P5' } ] )

            expect( out.map( ( r ) => r.phaseRef ) ).toEqual( [ 'ns · M002 · P4', 'ns · M002 · P5' ] )
        } )
    } )


    describe( 'collectTraceRows — integration over the schema', () => {
        it( 'sorts a multi-memo plan by executionOrder and keeps in-progress commits', () => {
            const plan = {
                memos: [
                    { namespace: 'ns', memoId: 'M001', phases: [ { id: 'P1', status: 'done', headCommit: 'c0001111' } ] },
                    { namespace: 'ns', memoId: 'M002', phases: [ { id: 'P5', status: 'in-progress', headCommit: 'c0005555' } ] }
                ],
                executionOrder: [ 'ns · M002 · P5', 'ns · M001 · P1' ]
            }
            const rows = fns.collectTraceRows( plan )

            expect( rows.map( ( r ) => r.phaseRef ) ).toEqual( [ 'ns · M002 · P5', 'ns · M001 · P1' ] )
            const inProgress = rows.find( ( r ) => r.phaseRef === 'ns · M002 · P5' )
            expect( inProgress.headCommit ).toBe( 'c0005555' )
        } )


        it( 'keeps legacy top-level phases in array order when no executionOrder is given', () => {
            const plan = { phases: [ { id: 'P1', status: 'done', headCommit: 'aaa' }, { id: 'P2', status: 'pending' } ] }
            const rows = fns.collectTraceRows( plan )

            expect( rows ).toHaveLength( 2 )
            expect( rows[ 0 ].headCommit ).toBe( 'aaa' )
            expect( rows[ 1 ].headCommit ).toBe( '' )
        } )


        it( 'returns an empty array for a plan without phases', () => {
            const rows = fns.collectTraceRows( {} )

            expect( rows ).toEqual( [] )
        } )
    } )
} )
