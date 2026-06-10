import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'
import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'


// PRD-001 (Memo 019 Kap 1): the finalized-memo minutes chip aggregates the spoken minutes of ALL
// transcripts of a memo. Pure, deterministic: sum of per-transcript word counts converted at
// ~200 Woerter/Min (Math.ceil). 0 transcripts -> 0 Min (no invented default, no date fallback).
describe( 'aggregateMemoMinutes (PRD-001 Memo 019)', () => {
    const cases = [
        [ MemoView, 'MemoView' ],
        [ TranscriptRegistry, 'TranscriptRegistry' ]
    ]

    cases.forEach( ( [ Klass, name ] ) => {
        describe( name + '.aggregateMemoMinutes', () => {
            it( 'AC-20: 0 transcripts -> 0 Min', () => {
                const { minutes } = Klass.aggregateMemoMinutes( { transcripts: [] } )

                expect( minutes ).toBe( 0 )
            } )


            it( 'AC-18: sums word counts across all transcripts and converts at ~200/min', () => {
                const transcripts = [ { words: 200 }, { words: 200 }, { words: 100 } ]
                const { words, minutes } = Klass.aggregateMemoMinutes( { transcripts } )

                expect( words ).toBe( 500 )
                expect( minutes ).toBe( 3 )
            } )


            it( 'rounds up partial minutes (Math.ceil)', () => {
                const { minutes } = Klass.aggregateMemoMinutes( { transcripts: [ { words: 201 } ] } )

                expect( minutes ).toBe( 2 )
            } )


            it( 'ignores entries without a numeric word count (no invented default)', () => {
                const transcripts = [ { words: 200 }, {}, { words: null }, { words: -5 } ]
                const { words, minutes } = Klass.aggregateMemoMinutes( { transcripts } )

                expect( words ).toBe( 200 )
                expect( minutes ).toBe( 1 )
            } )


            it( 'tolerates an invalid transcripts argument (no throw)', () => {
                const { words, minutes } = Klass.aggregateMemoMinutes( { transcripts: undefined } )

                expect( words ).toBe( 0 )
                expect( minutes ).toBe( 0 )
            } )
        } )
    } )
} )
