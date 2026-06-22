import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'
import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'


// PRD-001 (Memo 019 Kap 1): the finalized-memo minutes chip aggregates the spoken minutes of ALL
// transcripts of a memo. Pure, deterministic: sum of per-transcript word counts converted at the
// realistic dictation rate ~130 Woerter/Min (Memo 038 Kap 13, Math.ceil; was a too-fast 200).
// 0 transcripts -> 0 Min (no invented default). The sum is deduped by identity (Memo 038 Kap 13).
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


            it( 'AC-18: sums word counts across all transcripts and converts at ~130/min', () => {
                const transcripts = [ { words: 200 }, { words: 200 }, { words: 100 } ]
                const { words, minutes } = Klass.aggregateMemoMinutes( { transcripts } )

                expect( words ).toBe( 500 )
                // Memo 038 Kap 13: 500 / 130 = 3.85 -> ceil 4 (was 3 at the old 200 wpm).
                expect( minutes ).toBe( 4 )
            } )


            it( 'rounds up partial minutes (Math.ceil)', () => {
                const { minutes } = Klass.aggregateMemoMinutes( { transcripts: [ { words: 201 } ] } )

                expect( minutes ).toBe( 2 )
            } )


            it( 'ignores entries without a numeric word count (no invented default)', () => {
                const transcripts = [ { words: 200 }, {}, { words: null }, { words: -5 } ]
                const { words, minutes } = Klass.aggregateMemoMinutes( { transcripts } )

                expect( words ).toBe( 200 )
                // Memo 038 Kap 13: 200 / 130 = 1.54 -> ceil 2 (was 1 at the old 200 wpm).
                expect( minutes ).toBe( 2 )
            } )


            it( 'Memo 038 Kap 13: dedupes transcripts by identity (id|transcriptId|url) before summing', () => {
                const transcripts = [ { id: 't1', words: 200 }, { id: 't1', words: 200 }, { url: 'u2', words: 100 } ]
                const { words, minutes } = Klass.aggregateMemoMinutes( { transcripts } )

                // The doubly-registered t1 counts once: 200 + 100 = 300 (NOT 500).
                expect( words ).toBe( 300 )
                expect( minutes ).toBe( 3 )
            } )


            it( 'Memo 038 Kap 13: entries without an identity key are all kept (no invented identity)', () => {
                const transcripts = [ { words: 200 }, { words: 200 } ]
                const { words } = Klass.aggregateMemoMinutes( { transcripts } )

                expect( words ).toBe( 400 )
            } )


            it( 'tolerates an invalid transcripts argument (no throw)', () => {
                const { words, minutes } = Klass.aggregateMemoMinutes( { transcripts: undefined } )

                expect( words ).toBe( 0 )
                expect( minutes ).toBe( 0 )
            } )
        } )
    } )
} )
