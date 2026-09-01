import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { Readable, pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-V5 (Memo 080, Kap 16 — WI-136, US-2): blockweise Auslieferung. The client bundle left the server
// as ONE res.end() of ~460 KB with no error listener — a peer that aborts mid-write produced exactly
// the `write EPIPE` on a Socket recorded in evidence-server-crash-epipe-2026-08-23.log.
//
// The route bodies now go through stream.pipeline with ONE error sink. The chunking leaf
// (MemoView.buildDeliveryChunks) is exercised against the REAL bundle, and the abort behaviour is
// proven on a real loopback server that uses the same pipeline construction as the route.
// Every case states HOW MUCH it compared (bytes, blocks, header fields).
const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewPath = resolve( here, '..', '..', 'src', 'MemoView.mjs' )
const clientBundlePath = resolve( here, '..', '..', 'src', 'public', 'app.client.mjs' )
const cssBundlePath = resolve( here, '..', '..', 'src', 'public', 'app.css' )

const CHUNK_SIZE = 65536

let memoViewSource = ''
let clientSource = ''
let cssSource = ''
let clientBytes = 0


beforeAll( async () => {
    memoViewSource = await readFile( memoViewPath, 'utf8' )
    clientSource = await readFile( clientBundlePath, 'utf8' )
    cssSource = await readFile( cssBundlePath, 'utf8' )
    clientBytes = ( await stat( clientBundlePath ) ).size
} )


describe( 'PRD-V5 — buildDeliveryChunks gegen die ECHTE Client-Datei', () => {

    it( 'liefert die Datei vollstaendig und byte-gleich zur Quelle (Vergleich: alle Bytes)', () => {
        const { chunks, count } = MemoView.buildDeliveryChunks( { 'source': clientSource, 'chunkSize': CHUNK_SIZE } )
        const rejoined = chunks.join( '' )

        expect( Buffer.byteLength( clientSource ) ).toBe( clientBytes )
        expect( rejoined.length ).toBe( clientSource.length )
        expect( rejoined ).toBe( clientSource )
        expect( count ).toBe( chunks.length )
    } )


    it( 'liefert in MEHR ALS EINEM Block — die Zahl wird ausgewiesen', () => {
        const { count } = MemoView.buildDeliveryChunks( { 'source': clientSource, 'chunkSize': CHUNK_SIZE } )
        const expected = Math.ceil( clientSource.length / CHUNK_SIZE )

        // Ausgewiesene Vergleichsgrundlage: Quellgroesse, Blockgroesse, Blockzahl.
        expect( clientBytes ).toBeGreaterThan( CHUNK_SIZE )
        expect( count ).toBe( expected )
        expect( count ).toBeGreaterThan( 1 )
    } )


    it( 'jeder Block ausser dem letzten ist exakt CHUNK_SIZE gross (Rest = letzter Block)', () => {
        const { chunks, count } = MemoView.buildDeliveryChunks( { 'source': clientSource, 'chunkSize': CHUNK_SIZE } )
        const fullBlocks = chunks.slice( 0, count - 1 )
        const oversized = fullBlocks.filter( ( chunk ) => chunk.length !== CHUNK_SIZE )

        expect( fullBlocks.length ).toBe( count - 1 )
        expect( oversized.length ).toBe( 0 )
        expect( chunks[ count - 1 ].length ).toBe( clientSource.length - ( count - 1 ) * CHUNK_SIZE )
    } )


    it( 'die CSS-Datei folgt demselben Muster (byte-gleich, Blockzahl ausgewiesen)', () => {
        const { chunks, count } = MemoView.buildDeliveryChunks( { 'source': cssSource, 'chunkSize': CHUNK_SIZE } )

        expect( chunks.join( '' ) ).toBe( cssSource )
        expect( count ).toBe( Math.ceil( cssSource.length / CHUNK_SIZE ) )
        expect( count ).toBeGreaterThanOrEqual( 1 )
    } )


    it( 'Randfaelle: leere Quelle -> 0 Bloecke, exakt ein Block bei genau CHUNK_SIZE (3 Faelle)', () => {
        const empty = MemoView.buildDeliveryChunks( { 'source': '', 'chunkSize': CHUNK_SIZE } )
        const exact = MemoView.buildDeliveryChunks( { 'source': 'a'.repeat( CHUNK_SIZE ), 'chunkSize': CHUNK_SIZE } )
        const overflow = MemoView.buildDeliveryChunks( { 'source': 'a'.repeat( CHUNK_SIZE + 1 ), 'chunkSize': CHUNK_SIZE } )

        expect( empty[ 'count' ] ).toBe( 0 )
        expect( exact[ 'count' ] ).toBe( 1 )
        expect( overflow[ 'count' ] ).toBe( 2 )
    } )
} )


describe( 'PRD-V5 — die Routen liefern ueber die Strom-Verkettung, Kopfzeilen unveraendert', () => {

    it( 'beide Bundle-Routen rufen sendBundle statt res.end( source ) (2 Routen, 0 Alt-Aufrufe)', () => {
        const sendBundleCalls = memoViewSource.match( /sendBundle\( req, res, \w+Bundle\.source \)/g ) || []
        const legacyEnds = memoViewSource.match( /res\.end\( \w+Bundle\.source \)/g ) || []

        expect( sendBundleCalls.length ).toBe( 2 )
        expect( legacyEnds.length ).toBe( 0 )
    } )


    it( 'Content-Length und ETag bleiben an beiden Routen erhalten (je 1 Paar)', () => {
        const cssStart = memoViewSource.indexOf( "if( url === '/app.css' && req.method === 'GET' )" )
        const jsStart = memoViewSource.indexOf( "if( url === '/app.client.mjs' && req.method === 'GET' )" )
        const cssRoute = memoViewSource.slice( cssStart, cssStart + 600 )
        const jsRoute = memoViewSource.slice( jsStart, jsStart + 600 )

        expect( cssStart ).toBeGreaterThan( -1 )
        expect( jsStart ).toBeGreaterThan( -1 )
        expect( cssRoute ).toContain( "'Content-Length': Buffer.byteLength( cssBundle.source )" )
        expect( cssRoute ).toContain( "'ETag': '\"' + cssBundle.hash + '\"'" )
        expect( jsRoute ).toContain( "'Content-Length': Buffer.byteLength( clientBundle.source )" )
        expect( jsRoute ).toContain( "'ETag': '\"' + clientBundle.hash + '\"'" )
    } )


    it( 'die Auslieferung haengt an GENAU EINER Fehlersenke (1 pipeline, 1 Rueckruf)', () => {
        const start = memoViewSource.indexOf( 'const sendBundle = ( req, res, source ) =>' )
        const body = memoViewSource.slice( start, start + 900 )
        const pipelines = body.match( /pipeline\( Readable\.from\( chunks \), res, \( err \) =>/g ) || []

        expect( start ).toBeGreaterThan( -1 )
        expect( pipelines.length ).toBe( 1 )
    } )


    it( 'ein Gegenueber-Abbruch wird STILL verworfen, jeder andere Fehler protokolliert (4 Abbruch-Codes)', () => {
        const start = memoViewSource.indexOf( 'const sendBundle = ( req, res, source ) =>' )
        const body = memoViewSource.slice( start, start + 900 )
        const codes = [ 'EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED' ]
        const present = codes.filter( ( code ) => body.includes( code ) === true )

        expect( present.length ).toBe( 4 )
        expect( body ).toContain( 'if( peerGone === true ) { return }' )
        expect( body ).toContain( "'kind': 'bundle'" )
    } )
} )


describe( 'PRD-V5 — echter Abbruch auf einem laufenden Server', () => {

    // The route construction under test, on a throwaway loopback server: same chunking leaf, same
    // pipeline, same single error sink. What is proven here is behaviour, not a source string.
    const startBundleServer = async ( { source, sink } ) => {
        const server = createServer( ( req, res ) => {
            res.writeHead( 200, {
                'Content-Type': 'text/javascript; charset=utf-8',
                'Content-Length': Buffer.byteLength( source ),
                'Cache-Control': 'no-cache',
                'ETag': '"testhash"'
            } )

            const { chunks } = MemoView.buildDeliveryChunks( { source, 'chunkSize': CHUNK_SIZE } )

            pipeline( Readable.from( chunks ), res, ( err ) => {
                if( err === undefined || err === null ) { return }

                const peerGone = [ 'EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED' ].includes( err.code )
                sink.push( { 'code': err.code, peerGone } )
            } )
        } )

        await new Promise( ( resolvePromise ) => server.listen( 0, '127.0.0.1', resolvePromise ) )

        return { server, 'port': server.address().port }
    }


    it( 'die Auslieferung ist ueber HTTP byte-gleich zur Quelle (Vergleich: volle Bytezahl)', async () => {
        const sink = []
        const { server, port } = await startBundleServer( { 'source': clientSource, sink } )

        const response = await fetch( `http://127.0.0.1:${ port }/app.client.mjs` )
        const text = await response.text()

        expect( response.status ).toBe( 200 )
        expect( response.headers.get( 'content-length' ) ).toBe( String( Buffer.byteLength( clientSource ) ) )
        expect( response.headers.get( 'etag' ) ).toBe( '"testhash"' )
        expect( Buffer.byteLength( text ) ).toBe( clientBytes )
        expect( text ).toBe( clientSource )
        expect( sink.length ).toBe( 0 )

        await new Promise( ( resolvePromise ) => server.close( resolvePromise ) )
    } )


    it( 'ein Abbruch nach dem ersten Block laesst den Prozess laufen; der Folge-Aufruf wird bedient', async () => {
        const sink = []
        const { server, port } = await startBundleServer( { 'source': clientSource, sink } )

        // Raw socket: send the request, read the first bytes, then destroy mid-delivery — this is the
        // abort that produced `write EPIPE` on the old single-res.end path.
        const aborted = await new Promise( ( resolvePromise ) => {
            const socket = connect( port, '127.0.0.1', () => {
                socket.write( 'GET /app.client.mjs HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' )
            } )
            let received = 0
            socket.on( 'data', ( chunk ) => {
                received = received + chunk.length
                if( received > 1024 ) {
                    socket.destroy()
                    resolvePromise( { received } )
                }
            } )
            socket.on( 'error', () => resolvePromise( { received } ) )
        } )

        // Give the pipeline callback a tick to fire.
        await new Promise( ( resolvePromise ) => setTimeout( resolvePromise, 150 ) )

        const followUp = await fetch( `http://127.0.0.1:${ port }/app.client.mjs` )
        const followUpText = await followUp.text()

        expect( aborted[ 'received' ] ).toBeGreaterThan( 1024 )
        expect( aborted[ 'received' ] ).toBeLessThan( clientBytes )
        // Der Abbruch endet in DER EINEN Fehlersenke und wird als Normalbetrieb erkannt.
        const escaped = sink.filter( ( entry ) => entry[ 'peerGone' ] === false )
        expect( escaped.length ).toBe( 0 )
        // Der Prozess lebt: der Folge-Aufruf wird vollstaendig bedient.
        expect( followUp.status ).toBe( 200 )
        expect( Buffer.byteLength( followUpText ) ).toBe( clientBytes )

        await new Promise( ( resolvePromise ) => server.close( resolvePromise ) )
    } )


    it( 'ein ECHTER Fehler bleibt sichtbar — die Waechter verschlucken nicht pauschal', async () => {
        const sink = []
        const server = createServer( ( req, res ) => {
            res.writeHead( 200, { 'Content-Type': 'text/javascript; charset=utf-8' } )

            const broken = new Readable( {
                read() {
                    this.destroy( Object.assign( new Error( 'unreadable source file' ), { 'code': 'EACCES' } ) )
                }
            } )

            pipeline( broken, res, ( err ) => {
                if( err === undefined || err === null ) { return }

                const peerGone = [ 'EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED' ].includes( err.code )
                sink.push( { 'code': err.code, peerGone } )
            } )
        } )

        await new Promise( ( resolvePromise ) => server.listen( 0, '127.0.0.1', resolvePromise ) )
        const port = server.address().port

        await fetch( `http://127.0.0.1:${ port }/app.client.mjs` )
            .then( ( resp ) => resp.text() )
            .catch( () => '' )

        await new Promise( ( resolvePromise ) => setTimeout( resolvePromise, 150 ) )

        expect( sink.length ).toBe( 1 )
        expect( sink[ 0 ][ 'code' ] ).toBe( 'EACCES' )
        expect( sink[ 0 ][ 'peerGone' ] ).toBe( false )

        await new Promise( ( resolvePromise ) => server.close( resolvePromise ) )
    } )
} )
