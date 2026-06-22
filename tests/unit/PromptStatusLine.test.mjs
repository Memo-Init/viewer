import { describe, it, expect } from '@jest/globals'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-008 (Memo 019 Kap 9): the Prompt-Statuszeile (Zone 2) model. Validates the Minuten-
// Leitkennzahl (minutes BEFORE words, Kap 9.4), the spoken-vs-estimated distinction (AC-11),
// the "N von M beantwortet" computation (Kap 9.3), and the "kein Wegklicken"-invariant (Kap 9.2).
describe( 'MemoView.promptStatusLine (PRD-008 Prompt-Statuszeile, Zone 2)', () => {
    describe( 'Minuten-Leitkennzahl: minutes BEFORE words (Kap 9.4 / AC-02)', () => {
        it( 'uses a measured spoken duration as "N Min gesprochen"', () => {
            const ps = MemoView.promptStatusLine( {
                words: 1480, spokenMinutes: 8, questionsAnswered: 3, questionsTotal: 8, transcriptUrl: 'http://x/t1'
            } )

            expect( ps.minutes ).toBe( 8 )
            expect( ps.minutesEstimated ).toBe( false )
            expect( ps.minutesLabel ).toBe( '8 Min gesprochen' )
        } )


        it( 'falls back to the derived estimate without a spoken duration, flagged geschätzt (AC-11)', () => {
            const ps = MemoView.promptStatusLine( {
                words: 400, spokenMinutes: 0, questionsAnswered: 0, questionsTotal: 0, transcriptUrl: 'http://x/t1'
            } )

            // Memo 038 Kap 13: 400 words / 130 = 3.08 -> ceil 4 min estimate (was 2 at 200 wpm);
            // never faked as "gesprochen".
            expect( ps.minutes ).toBe( 4 )
            expect( ps.minutesEstimated ).toBe( true )
            expect( ps.minutesLabel ).toBe( '4 Min geschätzt' )
            expect( ps.minutesLabel.includes( 'gesprochen' ) ).toBe( false )
        } )


        it( 'words stay secondary and are formatted with a de-DE thousands separator', () => {
            const ps = MemoView.promptStatusLine( {
                words: 1480, spokenMinutes: 8, questionsAnswered: 0, questionsTotal: 0, transcriptUrl: 'http://x/t1'
            } )

            expect( ps.words ).toBe( 1480 )
            expect( ps.wordsLabel ).toBe( '1.480 Wörter' )
        } )
    } )


    describe( '"X von Y beantwortet" + open count (Kap 9.3 / AC-04)', () => {
        it( 'computes the answered label and the open count', () => {
            const ps = MemoView.promptStatusLine( {
                words: 0, spokenMinutes: 0, questionsAnswered: 3, questionsTotal: 8, transcriptUrl: ''
            } )

            expect( ps.answered ).toBe( 3 )
            expect( ps.total ).toBe( 8 )
            expect( ps.open ).toBe( 5 )
            expect( ps.answeredLabel ).toBe( '3 von 8 beantwortet' )
            expect( ps.openLabel ).toBe( '5 offen' )
        } )


        it( 'never produces a negative open count when answered exceeds total', () => {
            const ps = MemoView.promptStatusLine( {
                words: 0, spokenMinutes: 0, questionsAnswered: 9, questionsTotal: 8, transcriptUrl: ''
            } )

            expect( ps.open ).toBe( 0 )
        } )


        it( 'handles zero questions cleanly', () => {
            const ps = MemoView.promptStatusLine( {
                words: 0, spokenMinutes: 0, questionsAnswered: 0, questionsTotal: 0, transcriptUrl: ''
            } )

            expect( ps.answeredLabel ).toBe( '0 von 0 beantwortet' )
            expect( ps.openLabel ).toBe( '0 offen' )
        } )
    } )


    describe( 'kein-Wegklicken-Invariante (Kap 9.2 / AC-05)', () => {
        it( 'transcriptInPrompt mirrors a present transcript exactly — no opt-out', () => {
            const withT = MemoView.promptStatusLine( {
                words: 100, spokenMinutes: 0, questionsAnswered: 0, questionsTotal: 0, transcriptUrl: 'http://x/t1'
            } )
            const withoutT = MemoView.promptStatusLine( {
                words: 0, spokenMinutes: 0, questionsAnswered: 0, questionsTotal: 0, transcriptUrl: ''
            } )

            expect( withT.transcriptInPrompt ).toBe( true )
            expect( withT.hasTranscript ).toBe( true )
            expect( withoutT.transcriptInPrompt ).toBe( false )
            expect( withoutT.hasTranscript ).toBe( false )
        } )


        it( 'a present transcript can never be reported as "not in prompt" (no toggle field exists)', () => {
            const ps = MemoView.promptStatusLine( {
                words: 100, spokenMinutes: 5, questionsAnswered: 0, questionsTotal: 0, transcriptUrl: 'http://x/t1'
            } )

            // The model exposes no toggle/opt-out flag — transcriptInPrompt is derived, not settable.
            expect( ps.transcriptInPrompt ).toBe( ps.hasTranscript )
        } )
    } )


    describe( 'kein Transcript: no faked minutes/words (Kap 9.5)', () => {
        it( 'reports 0 minutes / 0 words when no transcript url is present', () => {
            const ps = MemoView.promptStatusLine( {
                words: 0, spokenMinutes: 0, questionsAnswered: 1, questionsTotal: 3, transcriptUrl: ''
            } )

            expect( ps.hasTranscript ).toBe( false )
            expect( ps.minutes ).toBe( 0 )
            expect( ps.words ).toBe( 0 )
        } )
    } )
} )
