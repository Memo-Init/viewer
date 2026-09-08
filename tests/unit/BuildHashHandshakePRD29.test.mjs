import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { cp, mkdtemp, mkdir, rm, appendFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { extractFunctions } from '../helpers/extractFunction.mjs'


// PRD-29 (Memo 081, WI-068): the build-hash handshake compared two POINTS IN TIME, not two values.
// The delivered page was built once per process and closed over; the WebSocket read the same hash live
// on every connect. After any edit to app.client.mjs under a running server the two stood apart
// forever, the client reloaded on every connect and got the same frozen page back. Measured against a
// real server before the fix: 5985 of 5985 browser-equivalent cycles in 12.0 s triggered another
// reload — 100 %, and not one JS error or failed request in the whole run.
//
// There was NO test on this handshake at all, which is why it could stay broken for nine weeks
// (435588e, 2026-07-17). Every case below states HOW MUCH it compared.
//
// The server cases run against a THROWAWAY COPY of src/ under .test-tmp/: they have to move the
// bundle hash, and the only honest way to move it is to change the bundle on disk — never the tracked
// one. Nothing outside this repo is read or written; CI checks this repo out alone.
//
// The oracle is never an internal of the code under test: the expected build hash is recomputed here
// from the bytes on disk (sha1, first 12 hex chars), the same derivation the served page and the
// WebSocket both claim to publish.
const hashOfBundle = ( source ) => { return createHash( 'sha1' ).update( source ).digest( 'hex' ).slice( 0, 12 ) }

const cspHashOf = ( body ) => { return `'sha256-${ createHash( 'sha256' ).update( body, 'utf8' ).digest( 'base64' ) }'` }

const stampIn = ( html ) => {
    const found = html.match( /window\.__MEMO_VIEW_BUILD__ = "([0-9a-f]+)"/ )

    return found === null ? null : found[ 1 ]
}

const bootstrapIn = ( html ) => {
    const stamp = stampIn( html )

    return stamp === null ? null : `window.__MEMO_VIEW_BUILD__ = ${ JSON.stringify( stamp ) }`
}

const configDouble = ( { showOnlyFullRevisions } ) => {
    return { get: ( { key } ) => { return key === 'showOnlyFullRevisions' ? { value: showOnlyFullRevisions } : { value: null } } }
}


describe( 'PRD-29 T-A/T-B/T-C/T-D/T-E — the page is read live, and its rebuild is capped', () => {
    let copyRoot = ''
    let bundlePath = ''
    let Copy = null
    let getPage = null


    beforeAll( async () => {
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        copyRoot = await mkdtemp( join( process.cwd(), '.test-tmp', 'handshake-29-' ) )
        await cp( join( process.cwd(), 'src' ), join( copyRoot, 'src' ), { recursive: true } )
        bundlePath = join( copyRoot, 'src', 'public', 'app.client.mjs' )

        const loaded = await import( join( copyRoot, 'src', 'MemoView.mjs' ) )
        Copy = loaded.MemoView
        getPage = Copy.createPageReaderForTests( { port: 3333 } ).getPage
    } )


    afterAll( async () => {
        // Remove the copy FIRST and unconditionally. A teardown that puts its cleanup behind anything
        // that can throw leaves megabytes under .test-tmp/ on exactly the runs that failed — measured
        // while proving these cases red against the old state. The config double needs no reset: it
        // lives on the copy's own module instance, which is discarded with the directory.
        await rm( copyRoot, { recursive: true, force: true } )
    } )


    it( 'T-A — without a bundle change 5 calls return the identical page and build it exactly ONCE', () => {
        const seen = [ 1, 2, 3, 4, 5 ].map( () => getPage() )
        const firstBuilds = seen[ 0 ][ 'buildCount' ]

        expect( seen.every( ( page ) => page[ 'html' ] === seen[ 0 ][ 'html' ] ) ).toBe( true )
        expect( seen.every( ( page ) => page[ 'csp' ] === seen[ 0 ][ 'csp' ] ) ).toBe( true )
        expect( seen[ 4 ][ 'buildCount' ] ).toBe( firstBuilds )
        expect( seen.length ).toBe( 5 )
    } )


    it( 'T-B — a bundle change moves the stamp to the hash of the NEW bytes and costs exactly ONE further build', async () => {
        const before = getPage()
        const buildsBefore = before[ 'buildCount' ]
        const sourceBefore = await readFile( bundlePath, 'utf8' )

        expect( stampIn( before[ 'html' ] ) ).toBe( hashOfBundle( sourceBefore ) )

        await appendFile( bundlePath, '\n// PRD-29 T-B: one line the running reader never saw at boot\n', 'utf8' )
        const sourceAfter = await readFile( bundlePath, 'utf8' )

        // Vakuum-Riegel: if the bytes did not actually move, everything below would be green for the
        // wrong reason — "both hashes equal" is also true when nothing happened at all.
        expect( hashOfBundle( sourceAfter ) ).not.toBe( hashOfBundle( sourceBefore ) )

        const after = getPage()

        expect( stampIn( after[ 'html' ] ) ).toBe( hashOfBundle( sourceAfter ) )
        expect( stampIn( after[ 'html' ] ) ).not.toBe( stampIn( before[ 'html' ] ) )
        expect( after[ 'buildCount' ] ).toBe( buildsBefore + 1 )

        // And the new page is cached again: 3 further calls add no build.
        const settled = [ 1, 2, 3 ].map( () => getPage() )

        expect( settled[ 2 ][ 'buildCount' ] ).toBe( buildsBefore + 1 )
    } )


    it( 'T-C — head and body always come from one build: the sha256 of the delivered bootstrap stands in the delivered CSP (2 states compared)', async () => {
        const first = getPage()

        expect( first[ 'csp' ].includes( cspHashOf( bootstrapIn( first[ 'html' ] ) ) ) ).toBe( true )

        await appendFile( bundlePath, '\n// PRD-29 T-C: a second edit under the same reader\n', 'utf8' )
        const second = getPage()

        expect( stampIn( second[ 'html' ] ) ).not.toBe( stampIn( first[ 'html' ] ) )
        expect( second[ 'csp' ] ).not.toBe( first[ 'csp' ] )
        expect( second[ 'csp' ].includes( cspHashOf( bootstrapIn( second[ 'html' ] ) ) ) ).toBe( true )

        // The frozen head is what a half-fix would ship: the OLD header can not admit the NEW script.
        expect( first[ 'csp' ].includes( cspHashOf( bootstrapIn( second[ 'html' ] ) ) ) ).toBe( false )
    } )


    it( 'T-D — the stamp the page ships equals the hash of the bundle on disk RIGHT NOW, with no restart in between (3 bundle states compared)', async () => {
        const states = []

        await appendFile( bundlePath, '\n// PRD-29 T-D: state one\n', 'utf8' )
        states.push( { html: getPage()[ 'html' ], source: await readFile( bundlePath, 'utf8' ) } )

        await appendFile( bundlePath, '\n// PRD-29 T-D: state two\n', 'utf8' )
        states.push( { html: getPage()[ 'html' ], source: await readFile( bundlePath, 'utf8' ) } )

        await appendFile( bundlePath, '\n// PRD-29 T-D: state three\n', 'utf8' )
        states.push( { html: getPage()[ 'html' ], source: await readFile( bundlePath, 'utf8' ) } )

        const stamps = states.map( ( state ) => stampIn( state[ 'html' ] ) )

        // Vakuum-Riegel: three DISTINCT bundle states, or this proves nothing.
        expect( new Set( stamps ).size ).toBe( 3 )

        // The live side of the handshake sends getClientBundle().hash, which is this same derivation
        // over these same bytes. Equal to it means the two sides can no longer disagree without a
        // real difference — which is the whole defect.
        expect( stamps ).toEqual( states.map( ( state ) => hashOfBundle( state[ 'source' ] ) ) )
    } )


    it( 'T-E — the config flag is part of the fingerprint: flipping it must not be served from the old page (2 flags compared)', () => {
        Copy.setConfigForTests( { config: configDouble( { showOnlyFullRevisions: true } ) } )
        const withTrue = getPage()

        Copy.setConfigForTests( { config: configDouble( { showOnlyFullRevisions: false } ) } )
        const withFalse = getPage()

        expect( withTrue[ 'html' ].includes( 'showOnlyFullRevisions: true' ) ).toBe( true )
        expect( withFalse[ 'html' ].includes( 'showOnlyFullRevisions: false' ) ).toBe( true )
        expect( withFalse[ 'buildCount' ] ).toBe( withTrue[ 'buildCount' ] + 1 )

        // Back to the first flag: still not the stale page — and the CSP followed the body both ways.
        Copy.setConfigForTests( { config: configDouble( { showOnlyFullRevisions: true } ) } )
        const backToTrue = getPage()

        expect( backToTrue[ 'html' ] ).toBe( withTrue[ 'html' ] )
        expect( backToTrue[ 'csp' ].includes( cspHashOf( bootstrapIn( backToTrue[ 'html' ] ) ) ) ).toBe( true )
    } )
} )


describe( 'PRD-29 T-F/T-G — the reload throttle, proven in BOTH directions', () => {
    let decideBuildReload = null


    beforeAll( async () => {
        const lifted = await extractFunctions( [ 'decideBuildReload' ] )
        decideBuildReload = lifted[ 'decideBuildReload' ]
    } )


    it( 'T-F — the same id pairing decides to reload ONCE and warns on every further frame (5 frames delivered)', () => {
        const frames = [ 'b2', 'b2', 'b2', 'b2', 'b2' ]
        const seed = { mark: null, reloads: 0, warns: 0 }
        const seen = frames
            .reduce( ( acc, serverId ) => {
                const decision = decideBuildReload( 'b1', serverId, acc.mark )

                if( decision.action === 'reload' ) { return { mark: decision.attempt, reloads: acc.reloads + 1, warns: acc.warns } }
                if( decision.action === 'warn' ) { return { mark: acc.mark, reloads: acc.reloads, warns: acc.warns + 1 } }

                return acc
            }, seed )

        expect( seen.reloads ).toBe( 1 )
        expect( seen.warns ).toBe( 4 )
        expect( frames.length ).toBe( 5 )
    } )


    it( 'T-G — a third, genuinely new build id is NOT throttled along with it (3 build ids compared)', () => {
        const first = decideBuildReload( 'b1', 'b2', null )

        expect( first.action ).toBe( 'reload' )

        const repeat = decideBuildReload( 'b1', 'b2', first.attempt )

        expect( repeat.action ).toBe( 'warn' )

        // A throttle that always blocks is indistinguishable from one that works — so this direction
        // carries as much weight as the one above.
        const fresh = decideBuildReload( 'b1', 'b3', first.attempt )

        expect( fresh.action ).toBe( 'reload' )
        expect( fresh.attempt ).toBe( 'b1->b3' )
    } )


    it( 'T-G — agreement and missing values decide NOTHING (4 combinations compared)', () => {
        const cases = [
            [ 'b1', 'b1', null ],
            [ 'b1', null, null ],
            [ null, 'b2', null ],
            [ '', 'b2', null ]
        ]
        const actions = cases.map( ( [ pageBuild, serverId, mark ] ) => decideBuildReload( pageBuild, serverId, mark ).action )

        expect( actions ).toEqual( [ 'none', 'none', 'none', 'none' ] )
        expect( cases.length ).toBe( 4 )
    } )
} )
