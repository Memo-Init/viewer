import { describe, it, expect } from '@jest/globals'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'


// PRD-003 (Memo 024 Kap 3): the Bootstrap-Modal live counter ("X Wörter · Y Min") must use
// the canonical Math.ceil( words / 200 ) reading-time formula for every tab. The browser-side
// updateTranscriptWordCount mirrors exactly this contract; TranscriptRegistry.wordCount is the
// importable single source of truth, so this unit test pins the formula deterministically:
//   0 words -> 0 Min, 1 word -> 1 Min, 200 words -> 1 Min, 201 words -> 2 Min.
const buildWords = ( count ) => {
    const tokens = Array.from( { length: count }, ( _value, index ) => `wort${ index }` )

    return { content: tokens.join( ' ' ) }
}


describe( 'PRD-003 Wörter-/Minuten-Logik (Math.ceil( words / 200 ))', () => {
    const cases = [
        [ 0, 0, 0 ],
        [ 1, 1, 1 ],
        [ 200, 200, 1 ],
        [ 201, 201, 2 ]
    ]

    cases.forEach( ( [ wordCount, expectedWords, expectedMinutes ] ) => {
        it( `${ wordCount } words -> ${ expectedWords } Wörter · ${ expectedMinutes } Min`, () => {
            const { content } = buildWords( wordCount )
            const { words, minutes } = TranscriptRegistry.wordCount( { content } )

            expect( words ).toBe( expectedWords )
            expect( minutes ).toBe( expectedMinutes )
        } )
    } )


    it( 'empty content yields 0 Wörter · 0 Min', () => {
        const { words, minutes } = TranscriptRegistry.wordCount( { content: '' } )

        expect( words ).toBe( 0 )
        expect( minutes ).toBe( 0 )
    } )


    it( 'whitespace-only content yields 0 Wörter · 0 Min', () => {
        const { words, minutes } = TranscriptRegistry.wordCount( { content: '   \n  \t ' } )

        expect( words ).toBe( 0 )
        expect( minutes ).toBe( 0 )
    } )
} )
