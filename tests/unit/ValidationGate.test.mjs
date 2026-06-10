import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoValidator } from '../../src/MemoValidator.mjs'


// PRD-040 (Memo 016, Kap 13): the MemoValidator runs as a GATE in the server path before
// the `content` WebSocket message is delivered to the View/AI. The result is attached as a
// `validation` field. The four content-send sites are deeply nested private WebSocket
// handlers, so these tests prove the gate two ways:
//   1) Source-structural: MemoValidator is imported, the #computeValidation helper exists,
//      and ALL content-send sites carry the `validation` field.
//   2) Emitted-message: a gated content message serialises to valid JSON and the validation
//      strings are safe to embed in the HTML/JSON the server emits.

const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewPath = resolve( here, '../../src/MemoView.mjs' )


describe( 'PRD-040 gate wiring (source-structural)', () => {
    it( 'MemoView imports MemoValidator', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )

        expect( src ).toMatch( /import\s+\{\s*MemoValidator\s*\}\s+from\s+'\.\/MemoValidator\.mjs'/ )
    } )


    it( 'a centralised #computeValidation helper exists with defensive try/catch', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )

        expect( src ).toMatch( /static #computeValidation\( \{ content \} \)/ )
        expect( src ).toMatch( /try \{\s*const validation = MemoValidator\.validate\( \{ doc: content \} \)/ )
        expect( src ).toMatch( /'validation': null/ )
    } )


    it( 'every content-send message that carries questionSchema also carries validation', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )
        const lines = src.split( '\n' )

        // Each line that builds a content message with questionSchema must also list validation.
        const contentLines = lines
            .filter( ( line ) => line.includes( "'type': 'content'" ) && line.includes( 'questionSchema' ) )

        expect( contentLines.length ).toBe( 4 )

        contentLines
            .forEach( ( line ) => {
                expect( line ).toMatch( /\bvalidation\b/ )
            } )
    } )


    it( 'every site that carries validation first computes it via #computeValidation', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )
        const computeCount = ( src.match( /MemoView\.#computeValidation\( \{ content \} \)/g ) || [] ).length

        // 4 content-send sites (PRD-040) + 1 read-only /api/validate route (PRD-005, Memo 019).
        // The route reuses the same centralised, defensive validator helper instead of calling
        // MemoValidator.validate directly, so the gate behaviour stays consistent everywhere.
        expect( computeCount ).toBe( 5 )
    } )
} )


describe( 'PRD-040 gate emitted message (serialisation / safety)', () => {
    it( 'a gated content message with a failing validation serialises to valid JSON and round-trips', async () => {
        // Committed in-repo fixture (a real finalized REV-05) — self-contained, no
        // dependency on the workbench .memo/ tree (CI isolation).
        const revPath = resolve( here, '../fixtures/sample-rev.md' )
        const content = await readFile( revPath, 'utf-8' )
        const validation = MemoValidator.validate( { doc: content } )

        const message = JSON.stringify( {
            'type': 'content',
            'content': content,
            'fileName': 'REV-05.md',
            'memoName': '016-transcript-system-eintrittspunkt',
            'diff': null,
            'questionSchema': [],
            'vorwort': '',
            validation
        } )

        const parsed = JSON.parse( message )

        expect( parsed[ 'type' ] ).toBe( 'content' )
        expect( parsed[ 'validation' ] ).toBeDefined()
        expect( Object.keys( parsed[ 'validation' ] ).sort() ).toEqual( [ 'info', 'messages', 'status' ] )
        expect( typeof parsed[ 'validation' ][ 'status' ] ).toBe( 'boolean' )
    } )


    it( 'validation messages contain no raw HTML-breaking characters that could corrupt emitted output', () => {
        const brokenDoc = '## Kontext\nx'
        const validation = MemoValidator.validate( { doc: brokenDoc } )
        const all = validation[ 'messages' ].concat( validation[ 'info' ] )

        expect( all.length ).toBeGreaterThan( 0 )
        all
            .forEach( ( line ) => {
                expect( line ).not.toMatch( /[<>]/ )
                // serialise + parse must be lossless (no control chars breaking JSON/HTML).
                expect( JSON.parse( JSON.stringify( line ) ) ).toBe( line )
            } )
    } )


    it( 'a defensive validation: null is valid JSON (validator-failure fallback)', () => {
        const message = JSON.stringify( { 'type': 'content', 'validation': null } )
        const parsed = JSON.parse( message )

        expect( parsed[ 'validation' ] ).toBe( null )
    } )
} )
