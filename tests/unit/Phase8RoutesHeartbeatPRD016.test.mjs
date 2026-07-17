import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'
import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'


// PRD-016 (Memo 076 Phase 8) — additive canonical routes (WI-018), GET /api/index snapshot (WI-019),
// 301 aliases (WI-020) and asset live-read (WI-021, already served via the mtime-invalidated bundle
// readers). Pure statics are exercised directly; route presence is asserted on the source string
// (the suite convention for the private #createHttpHandler).
const here = dirname( fileURLToPath( import.meta.url ) )


describe( 'PRD-016 WI-018 — parseTranscriptId is the exact inverse of buildUrl', () => {
    it( 'round-trips a composite WITH a sequence', () => {
        const { transcriptId } = TranscriptRegistry.buildUrl( { projectId: 'memo-init', memoId: '076-slug', revisionId: 'REV-01', sequence: '02' } )
        const parsed = TranscriptRegistry.parseTranscriptId( { transcriptId } )
        expect( parsed.status ).toBe( true )
        expect( parsed.projectId ).toBe( 'memo-init' )
        expect( parsed.memoId ).toBe( '076-slug' )
        expect( parsed.revisionId ).toBe( 'REV-01' )
        expect( parsed.sequence ).toBe( '02' )
    } )


    it( 'round-trips a composite WITHOUT a sequence', () => {
        const { transcriptId } = TranscriptRegistry.buildUrl( { projectId: 'flowmcp', memoId: '155-x', revisionId: 'REV-03' } )
        const parsed = TranscriptRegistry.parseTranscriptId( { transcriptId } )
        expect( parsed.status ).toBe( true )
        expect( parsed.projectId ).toBe( 'flowmcp' )
        expect( parsed.revisionId ).toBe( 'REV-03' )
        expect( parsed.sequence ).toBe( null )
    } )


    it( 'rejects an opaque / non-parsable id (no rateschluss)', () => {
        expect( TranscriptRegistry.parseTranscriptId( { transcriptId: 'totally-opaque' } ).status ).toBe( false )
        expect( TranscriptRegistry.parseTranscriptId( { transcriptId: '' } ).status ).toBe( false )
    } )
} )


describe( 'PRD-016 WI-020 — canonicalTranscriptLocation (301 Location builder)', () => {
    it( 'maps a parsable composite to the canonical hierarchical path', () => {
        const { location } = MemoView.canonicalTranscriptLocation( { transcriptId: 'memo-init--076-slug--REV-01--02' } )
        expect( location ).toBe( '/api/p/memo-init/m/076-slug/transcripts/REV-01/02' )
    } )


    it( 'omits the seq segment when the id has no sequence', () => {
        const { location } = MemoView.canonicalTranscriptLocation( { transcriptId: 'flowmcp--155-x--REV-03' } )
        expect( location ).toBe( '/api/p/flowmcp/m/155-x/transcripts/REV-03' )
    } )


    it( 'returns null for an opaque id (caller then direct-serves, fail-safe)', () => {
        const { location } = MemoView.canonicalTranscriptLocation( { transcriptId: 'legacy-opaque-blob' } )
        expect( location ).toBe( null )
    } )


    it( 'a 301 Location round-trips back to the same composite via buildUrl', () => {
        const original = 'memo-init--076-slug--REV-01--02'
        const { location } = MemoView.canonicalTranscriptLocation( { transcriptId: original } )
        const segs = location.split( '/' ).filter( ( s ) => s.length > 0 )
        const rebuilt = TranscriptRegistry.buildUrl( { projectId: segs[ 2 ], memoId: segs[ 4 ], revisionId: segs[ 6 ], sequence: segs[ 7 ] } )
        expect( rebuilt.transcriptId ).toBe( original )
    } )
} )


describe( 'PRD-016 — route wiring (source assertions)', () => {
    let server = ''

    beforeAll( async () => {
        server = await readFile( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
    } )


    it( 'wires GET /api/index returning { documents, transcripts, latest } (WI-019)', () => {
        expect( server.includes( "url === '/api/index' && req.method === 'GET'" ) ).toBe( true )
        expect( server.includes( "sendJson( res, 200, { documents, transcripts, latest } )" ) ).toBe( true )
    } )


    it( 'wires the canonical /api/p/{project}/m/{memo}/transcripts namespace (WI-018)', () => {
        expect( server.includes( "url.startsWith( '/api/p/' ) && req.method === 'GET'" ) ).toBe( true )
        expect( server.includes( "segments[ 3 ] === 'm'" ) ).toBe( true )
        expect( server.includes( "segments[ 5 ] === 'transcripts'" ) ).toBe( true )
    } )


    it( 'the legacy GET routes 301 to the canonical path with a fail-safe direct-serve (WI-020)', () => {
        // both the /api/transcripts/{id} and /transcripts/{id} GET branches use the helper + 301
        const count = ( server.match( /MemoView\.canonicalTranscriptLocation\( \{ transcriptId \} \)/g ) || [] ).length
        expect( count ).toBe( 2 )
        expect( server.includes( "res.writeHead( 301, { 'Location': location, 'Cache-Control': 'no-cache' } )" ) ).toBe( true )
    } )


    it( 'asset routes re-read from disk via the mtime-invalidated bundle readers (WI-021)', () => {
        // WI-021 is served by makeBundleReader: an edit is picked up (mtime change) without a restart.
        expect( server.includes( 'const makeBundleReader' ) ).toBe( true )
        expect( server.includes( 'stat.mtimeMs !== cache.mtimeMs' ) ).toBe( true )
        expect( server.includes( "url === '/app.css' && req.method === 'GET'" ) ).toBe( true )
        expect( server.includes( 'const cssBundle = getCssBundle()' ) ).toBe( true )
        expect( server.includes( 'const clientBundle = getClientBundle()' ) ).toBe( true )
    } )


    it( 'introduces NO new listener — the new routes hang off the loopback-bound server (r6-F16)', () => {
        const listenCount = ( server.match( /\.listen\(/g ) || [] ).length
        expect( listenCount ).toBe( 3 )
    } )
} )
