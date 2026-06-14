import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-001 (Memo 024 Kap 1): tolerant question parsing. The parser must accept the
// "KI-Empfehlung" alias, a space before the colon ("Label :"), and a lower-case heading
// ("### f1") — all of which previously produced a silent count-vs-parse mismatch (the
// sidebar promised N questions but no widgets rendered). These fixture-based tests pin the
// contract: every declared heading becomes a parsed question with a non-empty frage, and
// the heading count equals the parsed count (countMismatch === false).
const __dirname = dirname( fileURLToPath( import.meta.url ) )
const fixturesDir = resolve( __dirname, '..', 'fixtures', 'questions' )

const loadFixture = async ( name ) => {
    const content = await readFile( resolve( fixturesDir, name ), 'utf-8' )

    return { content }
}


describe( 'PRD-001 Parser-Härtung — Label-Aliase & Spacing & Case', () => {
    it( 'parses the KI-Empfehlung alias onto the AI-recommendation field', async () => {
        const { content } = await loadFixture( 'ki-empfehlung-alias.md' )
        const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

        expect( questions.length ).toBe( 1 )
        expect( questions[ 0 ][ 'frage' ] ).toBe( 'Welchen Begriff durchgehend verwenden?' )
        expect( questions[ 0 ][ 'aiRecommendation' ].length ).toBeGreaterThan( 0 )
        expect( questions[ 0 ][ 'aiRecommendation' ] ).toContain( 'A' )
    } )


    it( 'tolerates a space (and double space) before the colon', async () => {
        const { content } = await loadFixture( 'label-spacing.md' )
        const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

        expect( questions.length ).toBe( 1 )
        expect( questions[ 0 ][ 'frage' ] ).toBe( 'Wird der Frage-Text trotz doppeltem Leerzeichen geparst?' )
        expect( questions[ 0 ][ 'hintergrund' ] ).toBe( 'Das Label hat ein Leerzeichen vor dem Doppelpunkt.' )
        expect( questions[ 0 ][ 'aiRecommendation' ] ).toContain( 'B' )
    } )


    it( 'recognises a lower-case "### f1" heading and normalises the id to "F1"', async () => {
        const { content } = await loadFixture( 'lowercase-heading.md' )
        const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

        expect( questions.length ).toBe( 1 )
        expect( questions[ 0 ][ 'id' ] ).toBe( 'F1' )
        expect( questions[ 0 ][ 'frage' ].length ).toBeGreaterThan( 0 )
    } )
} )


describe( 'PRD-001 Parser-Härtung — Count == Parse (kein stiller Mismatch)', () => {
    const fixtures = [
        [ 'ki-empfehlung-alias.md', 1 ],
        [ 'label-spacing.md', 1 ],
        [ 'lowercase-heading.md', 1 ],
        [ 'multi-question.md', 3 ]
    ]

    fixtures.forEach( ( [ fixtureName, expectedCount ] ) => {
        it( `${ fixtureName }: parses exactly ${ expectedCount } question(s), each with a non-empty frage`, async () => {
            const { content } = await loadFixture( fixtureName )
            const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

            expect( questions.length ).toBe( expectedCount )

            questions.forEach( ( question ) => {
                expect( typeof question[ 'frage' ] ).toBe( 'string' )
                expect( question[ 'frage' ].trim().length ).toBeGreaterThan( 0 )
            } )
        } )


        it( `${ fixtureName }: headingCount equals parsed question count (countMismatch false)`, async () => {
            const { content } = await loadFixture( fixtureName )
            const { questions, headingCount, countMismatch } = DocumentRegistry.parseQuestionSchema( { content } )

            expect( headingCount ).toBe( questions.length )
            expect( countMismatch ).toBe( false )
        } )
    } )
} )


describe( 'PRD-004 (Memo 011 Kap 11) — Optionen-/Key-Regex verankert (Bug C)', () => {
    it( 'does not turn a bare A-H letter buried in prose into a phantom option', async () => {
        const { content } = await loadFixture( 'prose-phantom.md' )
        const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

        expect( questions.length ).toBe( 1 )

        const realOptions = questions[ 0 ][ 'options' ]
            .filter( ( option ) => option[ 'kind' ] === 'option' )

        // The word "INCONCLUSIVE:" ends with an "E" right before a colon — the old unanchored
        // marker matched it as a phantom option "E". After anchoring only the two real,
        // line-leading options survive.
        const keys = realOptions.map( ( option ) => option[ 'key' ] ).sort()
        expect( keys ).toEqual( [ 'A', 'B' ] )

        const hasPhantomLabel = realOptions
            .some( ( option ) => /INCONCLUSIVE|Variante|denkbar/i.test( option[ 'label' ] ) )
        expect( hasPhantomLabel ).toBe( false )
    } )


    it( 'does not preselect a phantom key from a bare prose letter', async () => {
        const { content } = await loadFixture( 'prose-phantom.md' )
        const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

        // AI-Empfehlung is "B" -> the second real option. "Variante A" in the Hintergrund prose
        // must NOT pull A into preselected.
        const real = questions[ 0 ][ 'options' ].filter( ( option ) => option[ 'kind' ] === 'option' )
        const bIndex = real.findIndex( ( option ) => option[ 'key' ] === 'B' )
        expect( questions[ 0 ][ 'preselected' ] ).toEqual( [ bIndex ] )
    } )
} )


describe( 'PRD-001 Parser-Härtung — multi-question aliases & mixed casing', () => {
    it( 'binds AI- and KI-Empfehlung across three questions with mixed casing/spacing', async () => {
        const { content } = await loadFixture( 'multi-question.md' )
        const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

        const ids = questions.map( ( question ) => question[ 'id' ] )
        expect( ids ).toEqual( [ 'F1', 'F2', 'F3' ] )

        questions.forEach( ( question ) => {
            expect( question[ 'aiRecommendation' ].trim().length ).toBeGreaterThan( 0 )
        } )
    } )
} )
