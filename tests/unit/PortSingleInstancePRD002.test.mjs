import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-002 (Memo 016 Kap 2, E2): port probe and real bind must agree on the host, and the
// first free port wins. selectAvailablePort is the pure selection extracted from
// #findAvailablePort so it is testable without opening real sockets.
describe( 'MemoView.selectAvailablePort (PRD-002, E2)', () => {
    it( 'picks the first not-in-use port in probe order', () => {
        const probeResults = [
            { port: 3333, inUse: true },
            { port: 4444, inUse: false },
            { port: 5555, inUse: false }
        ]
        const { availablePort } = MemoView.selectAvailablePort( { probeResults } )

        expect( availablePort ).toBe( 4444 )
    } )


    it( 'returns 3333 when the first port is free', () => {
        const probeResults = [
            { port: 3333, inUse: false },
            { port: 4444, inUse: true }
        ]
        const { availablePort } = MemoView.selectAvailablePort( { probeResults } )

        expect( availablePort ).toBe( 3333 )
    } )


    it( 'returns null when every port is in use', () => {
        const probeResults = [
            { port: 3333, inUse: true },
            { port: 4444, inUse: true }
        ]
        const { availablePort } = MemoView.selectAvailablePort( { probeResults } )

        expect( availablePort ).toBe( null )
    } )


    it( 'returns null for an empty or invalid probe set', () => {
        expect( MemoView.selectAvailablePort( { probeResults: [] } ).availablePort ).toBe( null )
        expect( MemoView.selectAvailablePort( { probeResults: undefined } ).availablePort ).toBe( null )
    } )
} )


// Source-shape regression: probe and BOTH real server binds use the single BIND_HOST
// constant — no bare listen(port) and no stray 0.0.0.0 / literal host in the listen calls.
describe( 'single bind host (PRD-002, E2)', () => {
    const source = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )

    it( 'defines a single BIND_HOST constant set to the IPv4 loopback literal', () => {
        expect( source ).toMatch( /const BIND_HOST = '127\.0\.0\.1'/ )
    } )


    it( 'never binds 0.0.0.0 and never resolves the ambiguous localhost name on listen', () => {
        expect( source ).not.toContain( "listen( port, '0.0.0.0'" )
        expect( source ).not.toMatch( /server\.listen\([^)]*'localhost'/ )
    } )


    it( 'the probe binds the same host as the server', () => {
        expect( source ).toContain( 'testServer.listen( port, BIND_HOST )' )
    } )


    it( 'both real server listens use BIND_HOST (no remaining bare listen(portNumber, callback))', () => {
        const bindHostListens = source.match( /server\.listen\( portNumber, BIND_HOST,/g ) || []

        expect( bindHostListens.length ).toBe( 2 )
        expect( source ).not.toMatch( /server\.listen\( portNumber, \(\) =>/ )
    } )
} )


// Security (Memo 016, E2): the bind host must be loopback only — reachable from the local
// machine, NOT from the network ("sicher und von aussen nicht sichtbar"). Binding the same
// host literal the server uses must yield a loopback address, never 0.0.0.0.
describe( 'bind host is loopback only — not externally reachable (PRD-002, E2)', () => {
    const source = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
    const bindHost = ( source.match( /const BIND_HOST = '([^']+)'/ ) || [] )[1]

    it( 'BIND_HOST is the IPv4 loopback literal', () => {
        expect( bindHost ).toBe( '127.0.0.1' )
    } )


    it( 'binding BIND_HOST reports a loopback address, never 0.0.0.0', async () => {
        const server = createServer()

        const address = await new Promise( ( resolvePromise ) => {
            server.listen( 0, bindHost, () => {
                resolvePromise( server.address() )
            } )
        } )

        expect( address.address ).toBe( '127.0.0.1' )
        expect( address.address ).not.toBe( '0.0.0.0' )

        await new Promise( ( resolvePromise ) => server.close( resolvePromise ) )
    } )
} )
