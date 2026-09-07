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

        // Memo 081, WI-080 (PRD-36): the helper takes the file name too, and hands it on. Both strings
        // are SHARPENED, not loosened — the first pins the two-parameter signature (no default, no
        // optional marker), the second pins that the name actually reaches MemoValidator. A helper that
        // accepted the name and dropped it would satisfy the old assertion and defeat the whole change.
        expect( src ).toMatch( /static #computeValidation\( \{ content, fileName \} \)/ )
        expect( src ).toMatch( /try \{\s*const validation = MemoValidator\.validate\( \{ 'doc': content, fileName \} \)/ )
        expect( src ).toMatch( /'validation': null/ )
    } )


    it( 'every content-send message that carries questionSchema also carries validation', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )
        const lines = src.split( '\n' )

        // Each line that builds a content message with questionSchema must also list validation.
        const contentLines = lines
            .filter( ( line ) => line.includes( "'type': 'content'" ) && line.includes( 'questionSchema' ) )

        // Memo 081, WI-025 (PRD-35): FIVE sites now, not four. The new one is the empty state a socket
        // gets when its address names a document that holds no revision (7 of 385 in the real stock) —
        // before, such a socket was served the process-wide leftover, a foreign memo under this
        // document's address. The assertion below is unchanged and covers the new site with the rest.
        expect( contentLines.length ).toBe( 5 )

        contentLines
            .forEach( ( line ) => {
                expect( line ).toMatch( /\bvalidation\b/ )
            } )
    } )


    it( 'every site that carries validation first computes it via #computeValidation', async () => {
        const src = await readFile( memoViewPath, 'utf-8' )
        const calls = ( src.match( /MemoView\.#computeValidation\( \{ [^}]*\} \)/g ) || [] )
        const withNull = calls.filter( ( call ) => /'fileName': null/.test( call ) === true )
        const withName = calls.filter( ( call ) => /'fileName': null/.test( call ) === false )

        // Memo 081, WI-080 (PRD-36): the old count pinned the number 6 against a single exact literal
        // (`{ content }`). That number happened to equal the number of sites written in that one form —
        // the door-gate and dbBodyServeable were never in it, so the assertion silently compared 6 of 8.
        // It is SHARPENED here into a total against its two named parts: ALL 8 call sites, 5 of which
        // hand a file name on and 3 of which have no file at all and say so with an explicit null (the
        // raw /api/validate body, the empty state of a document without revisions, the body assembled
        // from the db). A ninth site, or a site that silently omitted the argument, breaks this.
        expect( calls.length ).toBe( 8 )
        expect( withName.length ).toBe( 5 )
        expect( withNull.length ).toBe( 3 )
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
        // Memo 080: the envelope grew additively — `checked` (PRD-R1, the comparison basis),
        // `revisionType` (PRD-V13, WHICH schema was applied) and `optionQuality` (PRD-F4, the basis of
        // the option-quality family). The assertion stays EXACT.
        expect( Object.keys( parsed[ 'validation' ] ).sort() ).toEqual( [ 'checked', 'info', 'messages', 'optionQuality', 'revisionType', 'status', 'warnings' ] )
        expect( typeof parsed[ 'validation' ][ 'status' ] ).toBe( 'boolean' )
        expect( parsed[ 'validation' ][ 'revisionType' ] ).toBe( 'full' )
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
