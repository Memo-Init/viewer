import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'
import { TranscriptHeader } from '../../src/TranscriptHeader.mjs'


// PRD-P1-02 (Memo 075, WI-007): the spoken-minutes chip read a stale/inflated word count.
// (1) updateTranscript only refreshed mtime, never `words`, so a PUT with more words did not move
//     the count until a server restart.
// (2) scanMemo counted the raw file INCLUDING the server-injected transcript header (~115 words),
//     so the re-scanned count disagreed with the POST/PUT counts and inflated the estimate.
const bodyOf = ( count ) => {
    const tokens = Array.from( { length: count }, ( _value, index ) => `wort${ index }` )

    return tokens.join( ' ' )
}


describe( 'TranscriptRegistry.updateTranscript recomputes words on PUT (PRD-P1-02)', () => {
    let tempDir


    beforeEach( async () => {
        tempDir = await mkdtemp( join( tmpdir(), 'transcript-words-put-' ) )
    } )


    afterEach( async () => {
        await rm( tempDir, { recursive: true, force: true } )
    } )


    it( 'a PUT with +N words raises transcript.words immediately (no restart)', async () => {
        const memoDir = join( tempDir, '075-words' )
        await mkdir( memoDir, { recursive: true } )
        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        const add = await registry.addTranscript( { projectId: 'proj', memoId: '075-words', revisionId: 'REV-01', content: bodyOf( 3 ), memoPath: memoDir } )
        const transcriptId = add.transcriptId

        // The persisted word count is surfaced via getTranscriptTree (listTranscripts does not project it).
        const before = registry.getTranscriptTree().tree[ 'proj' ][ '075-words' ][ 0 ]

        expect( before.words ).toBe( 3 )

        const result = await registry.updateTranscript( { transcriptId, content: bodyOf( 12 ) } )

        expect( result.status ).toBe( true )

        const after = registry.getTranscriptTree().tree[ 'proj' ][ '075-words' ][ 0 ]

        expect( after.words ).toBe( 12 )

        registry.shutdown()
    } )
} )


describe( 'TranscriptRegistry.scanMemo counts the header-stripped body (PRD-P1-02)', () => {
    let tempDir


    beforeEach( async () => {
        tempDir = await mkdtemp( join( tmpdir(), 'transcript-words-scan-' ) )
    } )


    afterEach( async () => {
        await rm( tempDir, { recursive: true, force: true } )
    } )


    it( 're-scanned words equal the body count, not the header-inflated file count', async () => {
        const memoDir = join( tempDir, '075-scan' )
        await mkdir( memoDir, { recursive: true } )

        // Write a transcript to disk WITH the server-injected header (addTranscript does the wrap).
        const first = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        const add = await first.registry.addTranscript( { projectId: 'proj', memoId: '075-scan', revisionId: 'REV-01', content: bodyOf( 20 ), memoPath: memoDir } )
        const filePath = add.absolutePath
        first.registry.shutdown()

        // The on-disk file carries the header, so the raw file count is strictly larger than the body.
        const fileContent = await readFile( filePath, 'utf-8' )
        const rawFileWords = TranscriptRegistry.wordCount( { content: fileContent } ).words
        const strippedWords = TranscriptRegistry.wordCount( { content: TranscriptHeader.stripHeader( { content: fileContent } ).body } ).words

        expect( strippedWords ).toBe( 20 )
        expect( rawFileWords ).toBeGreaterThan( strippedWords )

        // A fresh registry simulates a server restart: scanMemo must count the header-stripped body.
        const second = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        await second.registry.scanMemo( { memoPath: memoDir, projectId: 'proj', memoId: '075-scan' } )

        const scanned = second.registry.getTranscriptTree().tree[ 'proj' ][ '075-scan' ]

        expect( scanned.length ).toBe( 1 )
        expect( scanned[ 0 ].words ).toBe( 20 )
        expect( scanned[ 0 ].words ).toBe( strippedWords )

        second.registry.shutdown()
    } )
} )
