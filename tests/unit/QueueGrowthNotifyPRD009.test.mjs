import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-009 (Memo 024 Kap 7, F5=A): Audio-Notify bei NEUEM Queue-Eintrag. Die Trigger-Entscheidung
// ist eine reine, testbare Funktion (MemoView.detectQueueGrowth). Sie vergleicht den vorherigen
// Key-Snapshot mit dem aktuellen und feuert NUR bei einem echten Neuzugang:
//   - previous === null  -> Initial-Load: kein Trigger, nur Baseline setzen (AC-04)
//   - gewachsen          -> Trigger (AC-01)
//   - unveraendert       -> kein Trigger (AC-02)
//   - geschrumpft        -> kein Trigger (AC-02)
//   - Swap (gleiche Zahl, andere Keys) -> Trigger (echter Neuzugang)
describe( 'MemoView.detectQueueGrowth (PRD-009)', () => {
    it( 'AC-04: initial load (previous === null) seeds the baseline and never triggers', () => {
        const { trigger, addedKeys, nextKeys } = MemoView.detectQueueGrowth( {
            previous: null,
            current: [ 'ns--010::REV-01', 'ns--020::REV-01' ]
        } )

        expect( trigger ).toBe( false )
        expect( addedKeys ).toEqual( [] )
        expect( nextKeys ).toEqual( [ 'ns--010::REV-01', 'ns--020::REV-01' ] )
    } )


    it( 'treats undefined previous like initial load (no trigger)', () => {
        const { trigger } = MemoView.detectQueueGrowth( {
            previous: undefined,
            current: [ 'ns--010::REV-01' ]
        } )

        expect( trigger ).toBe( false )
    } )


    it( 'AC-01: a new queue entry triggers and reports the added key', () => {
        const { trigger, addedKeys, nextKeys } = MemoView.detectQueueGrowth( {
            previous: [ 'ns--010::REV-01' ],
            current: [ 'ns--010::REV-01', 'ns--020::REV-01' ]
        } )

        expect( trigger ).toBe( true )
        expect( addedKeys ).toEqual( [ 'ns--020::REV-01' ] )
        expect( nextKeys ).toEqual( [ 'ns--010::REV-01', 'ns--020::REV-01' ] )
    } )


    it( 'AC-02: an unchanged queue (plain re-render) does not trigger', () => {
        const { trigger, addedKeys } = MemoView.detectQueueGrowth( {
            previous: [ 'ns--010::REV-01', 'ns--020::REV-01' ],
            current: [ 'ns--010::REV-01', 'ns--020::REV-01' ]
        } )

        expect( trigger ).toBe( false )
        expect( addedKeys ).toEqual( [] )
    } )


    it( 'AC-02: a shrunk queue (entry left, none arrived) does not trigger', () => {
        const { trigger, addedKeys, nextKeys } = MemoView.detectQueueGrowth( {
            previous: [ 'ns--010::REV-01', 'ns--020::REV-01' ],
            current: [ 'ns--010::REV-01' ]
        } )

        expect( trigger ).toBe( false )
        expect( addedKeys ).toEqual( [] )
        expect( nextKeys ).toEqual( [ 'ns--010::REV-01' ] )
    } )


    it( 'triggers on a swap with unchanged count (one entry leaves, a different one arrives)', () => {
        const { trigger, addedKeys } = MemoView.detectQueueGrowth( {
            previous: [ 'ns--010::REV-01' ],
            current: [ 'ns--020::REV-01' ]
        } )

        expect( trigger ).toBe( true )
        expect( addedKeys ).toEqual( [ 'ns--020::REV-01' ] )
    } )


    it( 'reports multiple added keys when several new entries arrive at once', () => {
        const { trigger, addedKeys } = MemoView.detectQueueGrowth( {
            previous: [ 'ns--010::REV-01' ],
            current: [ 'ns--010::REV-01', 'ns--020::REV-01', 'ns--030::REV-01' ]
        } )

        expect( trigger ).toBe( true )
        expect( addedKeys ).toEqual( [ 'ns--020::REV-01', 'ns--030::REV-01' ] )
    } )


    it( 'empty -> empty does not trigger and keeps an empty baseline', () => {
        const { trigger, nextKeys } = MemoView.detectQueueGrowth( {
            previous: [],
            current: []
        } )

        expect( trigger ).toBe( false )
        expect( nextKeys ).toEqual( [] )
    } )


    it( 'tolerates a non-array current (no trigger, empty baseline)', () => {
        const { trigger, nextKeys } = MemoView.detectQueueGrowth( {
            previous: [ 'ns--010::REV-01' ],
            current: undefined
        } )

        expect( trigger ).toBe( false )
        expect( nextKeys ).toEqual( [] )
    } )


    it( 'filters non-string keys out of both sides', () => {
        const { trigger, addedKeys, nextKeys } = MemoView.detectQueueGrowth( {
            previous: [ 'ns--010::REV-01', 42, null ],
            current: [ 'ns--010::REV-01', undefined, 'ns--020::REV-01' ]
        } )

        expect( trigger ).toBe( true )
        expect( addedKeys ).toEqual( [ 'ns--020::REV-01' ] )
        expect( nextKeys ).toEqual( [ 'ns--010::REV-01', 'ns--020::REV-01' ] )
    } )


    // Lifecycle simulation: initial-load seeds, then a real add fires once, a re-render is silent,
    // and the next add fires again. The caller feeds nextKeys back as the new previous.
    it( 'lifecycle: seed -> add (fire) -> re-render (silent) -> add (fire)', () => {
        const initial = MemoView.detectQueueGrowth( { previous: null, current: [ 'a::REV-01' ] } )
        expect( initial.trigger ).toBe( false )

        const added = MemoView.detectQueueGrowth( { previous: initial.nextKeys, current: [ 'a::REV-01', 'b::REV-01' ] } )
        expect( added.trigger ).toBe( true )

        const reRender = MemoView.detectQueueGrowth( { previous: added.nextKeys, current: [ 'a::REV-01', 'b::REV-01' ] } )
        expect( reRender.trigger ).toBe( false )

        const added2 = MemoView.detectQueueGrowth( { previous: reRender.nextKeys, current: [ 'a::REV-01', 'b::REV-01', 'c::REV-01' ] } )
        expect( added2.trigger ).toBe( true )
        expect( added2.addedKeys ).toEqual( [ 'c::REV-01' ] )
    } )
} )
