import { describe, it, expect, beforeAll } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { extractFunctions } from '../helpers/extractFunction.mjs'


// Memo 020 / PRD-005 (Phase 3): the scientific renderer test — Parse -> Validator -> Render-Hook.
// The pure validator (validateVegaSpec + findUrlKey) and the error fallback (buildVegaErrorHtml) are
// lifted out of the browser script and executed directly; the vegaEmbed render hook (which needs the
// CDN globals) is asserted by source shape. The README example specs are run through the validator so
// the authoring docs and the security gate can never drift apart.
const clientSource = readFileSync(
    fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ),
    'utf8'
)
const readmeSource = readFileSync(
    fileURLToPath( new URL( '../../README.md', import.meta.url ) ),
    'utf8'
)


let validateVegaSpec
let buildVegaErrorHtml

beforeAll( async () => {
    const lifted = await extractFunctions( [ 'findUrlKey', 'validateVegaSpec', 'buildVegaErrorHtml' ] )
    validateVegaSpec = lifted.validateVegaSpec
    buildVegaErrorHtml = lifted.buildVegaErrorHtml
} )


function readmeVegaSpecs() {
    const blocks = []
    const re = /```vega-lite\n([\s\S]*?)```/g
    let match = re.exec( readmeSource )
    while( match !== null ) {
        blocks.push( match[ 1 ] )
        match = re.exec( readmeSource )
    }

    return blocks
}


describe( 'PRD-005 — validateVegaSpec (parse + remote-data gate)', () => {
    it( 'accepts an inline-data spec and returns the parsed spec', () => {
        const out = validateVegaSpec( '{ "data": { "values": [ { "a": 1 } ] }, "mark": "bar" }' )
        expect( out.ok ).toBe( true )
        expect( out.spec.mark ).toBe( 'bar' )
    } )

    it( 'accepts a spec with no data block at all', () => {
        expect( validateVegaSpec( '{ "mark": "point" }' ).ok ).toBe( true )
    } )

    it( 'rejects a top-level data.url (remote data)', () => {
        const out = validateVegaSpec( '{ "data": { "url": "https://evil.example/data.json" }, "mark": "line" }' )
        expect( out.ok ).toBe( false )
        expect( out.reason ).toMatch( /Remote data/ )
    } )

    it( 'rejects a url nested inside a layer (deep scan, not just top level)', () => {
        const spec = JSON.stringify( {
            layer: [
                { mark: 'point', encoding: {} },
                { data: { url: 'https://evil.example/x.csv' }, mark: 'rule' }
            ]
        } )
        expect( validateVegaSpec( spec ).ok ).toBe( false )
    } )

    it( 'rejects a url hidden in a transform.from.data', () => {
        const spec = JSON.stringify( {
            data: { values: [] },
            transform: [ { lookup: 'k', from: { data: { url: 'http://evil/x' }, key: 'k' } } ]
        } )
        expect( validateVegaSpec( spec ).ok ).toBe( false )
    } )

    it( 'rejects invalid JSON with a clear reason', () => {
        const out = validateVegaSpec( '{ not json' )
        expect( out.ok ).toBe( false )
        expect( out.reason ).toMatch( /Invalid JSON/ )
    } )
} )


describe( 'PRD-005 — README example specs are valid + median example intact', () => {
    it( 'finds three example specs in the README', () => {
        expect( readmeVegaSpecs() ).toHaveLength( 3 )
    } )

    it( 'every README example spec passes the validator (docs <-> gate never drift)', () => {
        readmeVegaSpecs().forEach( ( block ) => {
            const out = validateVegaSpec( block )
            expect( out.ok ).toBe( true )
        } )
    } )

    it( 'the median example is a layered spec with a median aggregate rule', () => {
        const median = readmeVegaSpecs().find( ( b ) => b.includes( '"aggregate": "median"' ) )
        expect( median ).toBeDefined()
        const out = validateVegaSpec( median )
        expect( out.ok ).toBe( true )
        expect( Array.isArray( out.spec.layer ) ).toBe( true )
        const ruleLayer = out.spec.layer.find( ( l ) => l.encoding && l.encoding.y && l.encoding.y.aggregate === 'median' )
        expect( ruleLayer ).toBeDefined()
    } )
} )


describe( 'PRD-005 — render hook + error fallback', () => {
    it( 'registers a vega-lite renderer that embeds with the hardening config', () => {
        expect( clientSource ).toContain( "'vega-lite': {" )
        expect( clientSource ).toContain( "selector: '.vega-lite'" )
        expect( clientSource ).toContain( 'vegaEmbed( el, check.spec, {' )
        // CSP-safe interpreter + no export menu + svg renderer + credential-less loader
        expect( clientSource ).toContain( 'ast: true' )
        expect( clientSource ).toContain( 'actions: false' )
        expect( clientSource ).toContain( "renderer: 'svg'" )
        expect( clientSource ).toContain( "credentials: 'omit'" )
    } )

    it( 'routes a rejected/invalid spec to the error fallback instead of embedding', () => {
        expect( clientSource ).toContain( 'var check = validateVegaSpec( spec )' )
        expect( clientSource ).toContain( 'el.innerHTML = buildVegaErrorHtml( check.reason, spec )' )
    } )

    it( 'never attaches the View to window (no VEGA_DEBUG / window assignment in the renderer)', () => {
        expect( clientSource ).not.toContain( 'VEGA_DEBUG' )
        expect( clientSource ).not.toContain( 'window.vegaView' )
    } )

    it( 'buildVegaErrorHtml escapes the message and the original source', () => {
        const html = buildVegaErrorHtml( new Error( 'bad <tag>' ), '{ "x": "a < b & c" }' )
        expect( html ).toContain( 'vega-error-source' )
        expect( html ).toContain( 'bad &lt;tag&gt;' )
        expect( html ).toContain( 'a &lt; b &amp; c' )
    } )
} )
