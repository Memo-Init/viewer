import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'


describe( 'MemoView.computeMissionControl (Memo 005 Kap 9, U4)', () => {
    it( 'returns empty projects and zero totals for empty plans', () => {
        const { projects, totals } = MemoView.computeMissionControl( { plans: [] } )

        expect( projects ).toEqual( [] )
        expect( totals ).toEqual( { projects: 0, phases: 0 } )
    } )

    it( 'counts mixed phase status by canonical kebab enum', () => {
        const plans = [
            {
                projectId: 'nsA',
                planId: 'PLAN-001-x',
                status: 'in-progress',
                phases: [
                    { status: 'pending' },
                    { status: 'in-progress' },
                    { status: 'done' },
                    { status: 'done' },
                    { status: 'blocked' }
                ]
            }
        ]

        const { projects } = MemoView.computeMissionControl( { plans } )

        expect( projects.length ).toBe( 1 )
        expect( projects[ 0 ].phaseCounts ).toEqual( { 'pending': 1, 'in-progress': 1, 'done': 2, 'blocked': 1 } )
        expect( projects[ 0 ].phaseTotal ).toBe( 5 )
        expect( projects[ 0 ].planStatus ).toBe( 'in-progress' )
    } )

    it( 'sums totals across multiple projects', () => {
        const plans = [
            { projectId: 'nsA', planId: 'PLAN-001', status: 'done', phases: [ { status: 'done' }, { status: 'done' } ] },
            { projectId: 'nsB', planId: 'PLAN-002', status: 'in-progress', phases: [ { status: 'pending' } ] }
        ]

        const { projects, totals } = MemoView.computeMissionControl( { plans } )

        expect( projects.length ).toBe( 2 )
        expect( totals ).toEqual( { projects: 2, phases: 3 } )
    } )

    it( 'treats a plan with no phases[] as a safe default (0, no throw)', () => {
        const plans = [ { projectId: 'nsA', planId: 'PLAN-001', status: 'pending' } ]

        const { projects, totals } = MemoView.computeMissionControl( { plans } )

        expect( projects[ 0 ].phaseCounts ).toEqual( {} )
        expect( projects[ 0 ].phaseTotal ).toBe( 0 )
        expect( totals ).toEqual( { projects: 1, phases: 0 } )
    } )

    it( 'counts an unknown status into "other" without crashing', () => {
        const plans = [
            { projectId: 'nsA', planId: 'PLAN-001', status: 'pending', phases: [ { status: 'weird' }, { status: 'done' } ] }
        ]

        const { projects } = MemoView.computeMissionControl( { plans } )

        expect( projects[ 0 ].phaseCounts ).toEqual( { 'other': 1, 'done': 1 } )
    } )

    it( 'is deterministic (same input -> same output) and pure (no mutation of input)', () => {
        const plans = [ { projectId: 'nsA', planId: 'PLAN-001', status: 'done', phases: [ { status: 'done' } ] } ]
        const snapshot = JSON.stringify( plans )

        const first = MemoView.computeMissionControl( { plans } )
        const second = MemoView.computeMissionControl( { plans } )

        expect( first ).toEqual( second )
        expect( JSON.stringify( plans ) ).toBe( snapshot )
    } )

    it( 'falls back to folder for planId and unknown for missing projectId', () => {
        const plans = [ { folder: 'PLAN-009-y', phases: [] } ]

        const { projects } = MemoView.computeMissionControl( { plans } )

        expect( projects[ 0 ].projectId ).toBe( 'unknown' )
        expect( projects[ 0 ].planId ).toBe( 'PLAN-009-y' )
    } )
} )
