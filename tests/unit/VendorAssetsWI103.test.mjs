import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { VendorAssets } from '../../src/VendorAssets.mjs'


// WI-103 (Memo 080, Kap 15 — Das Schaufenster; F13 = A: "alle Bausteine mitgeliefert"). Until this
// change the page pulled five bundles from cdn.jsdelivr.net. The Soll-Zustand of the chapter is that
// they SHIP with the tool.
//
// What these tests are for: not "does a register exist" — that proves nothing — but that the register
// still describes files that are really on disk, that the page emits nothing but same-origin sources,
// and that the route serves exactly the register and nothing else. Each of the four goes red on a
// concrete regression: an uninstalled package, a re-added CDN tag, a widened route, a reordered stack.
describe( 'Vendor assets — shipped instead of fetched (WI-103, Memo 080 Kap 15, F13 = A)', () => {
    let pageTemplate = ''
    let manifest = null


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const source = await readFile( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
        manifest = JSON.parse( await readFile( join( here, '..', '..', 'package.json' ), 'utf8' ) )

        const pageOpen = source.indexOf( '<!DOCTYPE html>' )
        const pageClose = source.indexOf( '</html>', pageOpen )
        pageTemplate = source.slice( pageOpen, pageClose )
    } )


    it( 'every registered asset resolves to a real, non-empty file on disk (6 of 6 compared)', () => {
        const { assets } = VendorAssets.list()

        // The comparison base is stated: six entries, and a register that silently shrank would fail
        // here before any of the per-file assertions could pass vacuously.
        expect( assets.length ).toBe( 6 )

        const resolved = assets
            .map( ( entry ) => {
                const answer = VendorAssets.resolve( { 'route': entry[ 'route' ] } )

                return {
                    'route': entry[ 'route' ],
                    'status': answer[ 'status' ],
                    'exists': answer[ 'filePath' ] === null ? false : existsSync( answer[ 'filePath' ] ),
                    'bytes': answer[ 'bytes' ]
                }
            } )

        expect( resolved.filter( ( entry ) => entry[ 'status' ] !== true ) ).toEqual( [] )
        expect( resolved.filter( ( entry ) => entry[ 'exists' ] !== true ) ).toEqual( [] )
        expect( resolved.filter( ( entry ) => entry[ 'bytes' ] < 1000 ) ).toEqual( [] )
    } )


    it( 'every asset is a DECLARED, exactly pinned dependency — not an accidental transitive find', () => {
        const { assets } = VendorAssets.list()
        const declared = manifest[ 'dependencies' ]

        const missing = assets
            .filter( ( entry ) => Object.prototype.hasOwnProperty.call( declared, entry[ 'packageName' ] ) !== true )
            .map( ( entry ) => entry[ 'packageName' ] )
        const floating = assets
            .filter( ( entry ) => /^\d+\.\d+\.\d+$/.test( declared[ entry[ 'packageName' ] ] || '' ) !== true )
            .map( ( entry ) => entry[ 'packageName' ] )

        expect( missing ).toEqual( [] )
        expect( floating ).toEqual( [] )
    } )


    it( 'the page loads NOTHING from the network — every src/href is same-origin (positive control)', () => {
        const sources = ( pageTemplate.match( /(?:src|href)="([^"]*)"/g ) || [] )
            .map( ( match ) => match.replace( /^(?:src|href)="/, '' ).replace( /"$/, '' ) )

        // Positive control: the page really does reference assets, so "0 external" is a measured zero
        // and not the answer of a regex that matched nothing.
        expect( sources.length ).toBeGreaterThanOrEqual( 3 )

        const external = sources
            .filter( ( value ) => /^[a-z][a-z0-9+.-]*:/i.test( value ) === true )
            .filter( ( value ) => value.startsWith( 'data:' ) !== true )

        expect( external ).toEqual( [] )
        expect( pageTemplate.indexOf( 'cdn.jsdelivr.net' ) ).toBe( -1 )
        expect( pageTemplate.indexOf( 'integrity="sha384-' ) ).toBe( -1 )
    } )


    it( 'the emitted tags ARE the register, in register order — page and route cannot drift apart', () => {
        const { assets } = VendorAssets.list()
        const { tags } = VendorAssets.scriptTags()

        const emitted = ( tags.match( /src="([^"]*)"/g ) || [] )
            .map( ( match ) => match.slice( 5, -1 ) )
        const registered = assets
            .map( ( entry ) => entry[ 'route' ] )

        expect( emitted ).toEqual( registered )
        // vega -> vega-lite -> vega-embed: each builds on the global the previous one defines, so the
        // order is behaviour, not cosmetics
        expect( emitted.indexOf( '/vendor/vega.min.js' ) ).toBeLessThan( emitted.indexOf( '/vendor/vega-lite.min.js' ) )
        expect( emitted.indexOf( '/vendor/vega-lite.min.js' ) ).toBeLessThan( emitted.indexOf( '/vendor/vega-embed.min.js' ) )
    } )


    it( 'the route serves the register and NOTHING else — unknown and traversal routes are refused', () => {
        const refused = [
            '/vendor/',
            '/vendor/unknown.js',
            '/vendor/../MemoView.mjs',
            '/vendor/../../package.json',
            '/vendor/cytoscape.min.js/../../../etc/hosts',
            '/vendor/cytoscape.min.js.map'
        ]
            .map( ( route ) => ( { route, 'answer': VendorAssets.resolve( { route } ) } ) )

        expect( refused.length ).toBe( 6 )
        expect( refused.filter( ( entry ) => entry[ 'answer' ][ 'status' ] !== false ) ).toEqual( [] )
        expect( refused.filter( ( entry ) => entry[ 'answer' ][ 'filePath' ] !== null ) ).toEqual( [] )
        expect( refused.filter( ( entry ) => entry[ 'answer' ][ 'messages' ].length === 0 ) ).toEqual( [] )
    } )


    it( 'mermaid ships at the version depwatch cleared — not the CDN version it replaced', () => {
        // The old CDN pin was mermaid@11.4.1, which falls inside eight open advisories
        // (>= 11.0.0-alpha.1, < 11.16.1 and the <= 11.14.0 / < 11.10.0 ranges). Shipping it would have
        // pulled those into the tree. The pin is asserted here so a later downgrade is not silent.
        const pinned = manifest[ 'dependencies' ][ 'mermaid' ]
        const [ major, minor ] = pinned.split( '.' ).map( ( part ) => Number( part ) )

        expect( major ).toBe( 11 )
        expect( minor ).toBeGreaterThanOrEqual( 16 )

        // The INSTALLED version has to match the pin — a lockfile that resolved something else would
        // otherwise pass the manifest assertion above while shipping a different library. Read from the
        // path, not through the module graph: mermaid's exports map does not publish package.json.
        const installedPath = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..', 'node_modules', 'mermaid', 'package.json' )

        expect( existsSync( installedPath ) ).toBe( true )
        expect( statSync( installedPath ).size ).toBeGreaterThan( 0 )

        const installed = JSON.parse( readFileSync( installedPath, 'utf8' ) )

        expect( installed[ 'version' ] ).toBe( pinned )
    } )
} )
