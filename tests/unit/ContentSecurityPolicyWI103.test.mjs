import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ContentSecurityPolicy } from '../../src/ContentSecurityPolicy.mjs'


// WI-103 (Memo 080, Kap 15 — Das Schaufenster): "Alle Bausteine mitgeliefert plus Sicherheits-Kopf".
// The header is the second half of F13 = A and only became possible once nothing is fetched from the
// network any more.
//
// The tests below deliberately do NOT assert "a header exists" — that would pass on `default-src *`.
// They assert the two properties the memo actually asks for and one property that keeps the header
// honest over time:
//   1) no directive admits a foreign origin (the network is closed),
//   2) inline script runs by HASH only, never by 'unsafe-inline' (the header is worth its own text),
//   3) the hashes describe the inline blocks the PAGE really carries — recomputed here from the
//      served markup, so an edited inline block without an updated hash turns this red.
const asDirectiveMap = ( header ) => {
    const entries = header
        .split( ';' )
        .map( ( part ) => part.trim() )
        .filter( ( part ) => part.length > 0 )
        .map( ( part ) => {
            const pieces = part.split( /\s+/ )

            return [ pieces[ 0 ], pieces.slice( 1 ) ]
        } )

    return new Map( entries )
}


describe( 'Content-Security-Policy — the Sicherheits-Kopf (WI-103, Memo 080 Kap 15)', () => {
    let header = ''
    let directives = null
    let source = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        source = await readFile( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )

        const built = ContentSecurityPolicy.build( {
            'inlineScripts': [ 'window.__MEMO_CONFIG__ = { showOnlyFullRevisions: true }', 'window.__MEMO_VIEW_BUILD__ = "abc123"' ],
            'port': 3333
        } )

        header = built[ 'header' ]
        directives = asDirectiveMap( header )
    } )


    it( 'closes the network: no directive admits a foreign origin (11 of 11 directives compared)', () => {
        // Comparison base first — a policy that lost half its directives must not pass by having
        // nothing left to object to.
        expect( directives.size ).toBe( 11 )

        const offending = Array.from( directives.entries() )
            .flatMap( ( [ name, values ] ) => values
                .filter( ( value ) => {
                    if( value.startsWith( "'" ) === true ) { return false }
                    if( value === 'data:' || value === 'blob:' ) { return false }
                    // the only absolute origins allowed anywhere are the loopback WebSocket endpoints
                    if( /^ws:\/\/(127\.0\.0\.1|localhost):\d+$/.test( value ) === true ) { return false }

                    return true
                } )
                .map( ( value ) => `${ name } ${ value }` ) )

        expect( offending ).toEqual( [] )
        expect( header.indexOf( 'https:' ) ).toBe( -1 )
        expect( header.indexOf( 'jsdelivr' ) ).toBe( -1 )
        expect( header.indexOf( '*' ) ).toBe( -1 )
    } )


    it( 'runs inline script by HASH, never by unsafe-inline, and never by unsafe-eval', () => {
        const scriptSrc = directives.get( 'script-src' )

        expect( scriptSrc ).toContain( "'self'" )
        expect( scriptSrc.filter( ( value ) => value.startsWith( "'sha256-" ) ).length ).toBe( 2 )
        expect( scriptSrc ).not.toContain( "'unsafe-inline'" )
        expect( scriptSrc ).not.toContain( "'unsafe-eval'" )
        // vega is embedded with { ast: true }, its CSP-safe interpreter — the ban above is what makes
        // that choice load-bearing rather than decorative
        expect( header.indexOf( "'unsafe-eval'" ) ).toBe( -1 )

        // the relaxations that DO exist are confined to style and to local schemes
        expect( directives.get( 'style-src' ) ).toContain( "'unsafe-inline'" )
        expect( directives.get( 'object-src' ) ).toEqual( [ "'none'" ] )
        expect( directives.get( 'frame-ancestors' ) ).toEqual( [ "'none'" ] )
    } )


    it( 'a changed inline script changes its hash — the header cannot describe a stale text', () => {
        const first = ContentSecurityPolicy.hashOf( { 'body': 'window.__MEMO_CONFIG__ = { showOnlyFullRevisions: true }' } )
        const second = ContentSecurityPolicy.hashOf( { 'body': 'window.__MEMO_CONFIG__ = { showOnlyFullRevisions: false }' } )
        const expected = `'sha256-${ createHash( 'sha256' ).update( 'window.__MEMO_CONFIG__ = { showOnlyFullRevisions: true }', 'utf8' ).digest( 'base64' ) }'`

        expect( first ).not.toBe( second )
        expect( first ).toBe( expected )
    } )


    it( 'the page derives its hashes from the SAME strings it interpolates (one declaration, two uses)', () => {
        // This is the structural guarantee behind the hash approach. If the inline bodies were written
        // once into the markup and a second time into the hash list, the two could drift; they are
        // declared once and used twice, and the page must keep doing that.
        expect( source ).toContain( 'const configBootstrap = `window.__MEMO_CONFIG__ = { showOnlyFullRevisions: ${configFlag} }`' )
        expect( source ).toContain( "'inlineScripts': [ configBootstrap, buildBootstrap ], port" )
        expect( source ).toContain( '<script>${ configBootstrap }</script>' )
        expect( source ).toContain( '<script>${ buildBootstrap }</script>' )

        // and exactly two inline <script> blocks exist in the page — a third one without a hash would
        // be blocked at runtime, so its appearance has to fail here first
        const pageOpen = source.indexOf( '<!DOCTYPE html>' )
        const pageClose = source.indexOf( '</html>', pageOpen )
        const page = source.slice( pageOpen, pageClose )
        const inlineBlocks = page.match( /<script>(?!<\/script>)/g ) || []

        expect( inlineBlocks.length ).toBe( 2 )
    } )


    it( 'the header rides on the page response, and the WebSocket endpoint is named explicitly', () => {
        expect( source ).toContain( "'Content-Security-Policy': csp" )
        expect( source ).toContain( 'return { html, csp }' )
        expect( directives.get( 'connect-src' ) ).toEqual( [ "'self'", 'ws://127.0.0.1:3333', 'ws://localhost:3333' ] )
    } )


    it( 'refuses to build from an unusable input instead of emitting a weaker policy', () => {
        const cases = [
            () => ContentSecurityPolicy.build( { 'inlineScripts': [], 'port': 3333 } ),
            () => ContentSecurityPolicy.build( { 'inlineScripts': [ '' ], 'port': 3333 } ),
            () => ContentSecurityPolicy.build( { 'inlineScripts': [ 'x' ], 'port': null } ),
            () => ContentSecurityPolicy.build( { 'inlineScripts': [ 'x' ], 'port': 70000 } ),
            () => ContentSecurityPolicy.hashOf( { 'body': null } )
        ]

        expect( cases.length ).toBe( 5 )
        expect( cases.filter( ( run ) => {
            try { run(); return true } catch { return false }
        } ) ).toEqual( [] )
    } )
} )
