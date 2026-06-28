import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'


// PRD-002 (Memo 024 Kap 2): the Initial-Transcript must be bound to the memo as
// transcripts/memo-init-transcript.md (via addInitTranscript), NOT only stored as a loose global
// "other" transcript. PRD-004 (Memo 054 Kap 2): canonical filename is 'memo-init-transcript.md'.
// These integration tests use a repo-local, isolated test-home (NEVER the user home) and verify:
// addOther → binding writes the file with the correct content, the global other transcript
// survives, and the NO-OVERWRITE rule blocks a silent second write.
const __dirname = dirname( fileURLToPath( import.meta.url ) )
const testHomeRoot = resolve( __dirname, '..', '..', '.test-home' )


describe( 'PRD-002 Initial-Transcript-Bindung', () => {
    let tempDir
    let registry


    beforeEach( async () => {
        await mkdir( testHomeRoot, { recursive: true } )
        tempDir = await mkdtemp( join( testHomeRoot, 'init-promo-' ) )
        const { registry: reg } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        registry = reg
    } )


    afterEach( async () => {
        registry.shutdown()
        await rm( tempDir, { recursive: true, force: true } )
    } )


    it( 'binds a transcript as transcripts/memo-init-transcript.md with the correct content', async () => {
        const memoDir = join( tempDir, '.memo', 'memos', '050-new-idea' )
        await mkdir( memoDir, { recursive: true } )

        const result = await registry.addInitTranscript( {
            projectId: 'proj',
            memoId: '050-new-idea',
            content: 'Die ursprüngliche Idee für dieses Memo.',
            memoPath: memoDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        // PRD-004: canonical name is memo-init-transcript.md
        expect( result[ 'absolutePath' ].endsWith( 'memo-init-transcript.md' ) ).toBe( true )

        const written = await readFile( result[ 'absolutePath' ], 'utf-8' )
        expect( written ).toContain( 'Die ursprüngliche Idee für dieses Memo.' )

        let initExists = true
        try {
            await access( join( memoDir, 'transcripts', 'memo-init-transcript.md' ) )
        } catch {
            initExists = false
        }
        expect( initExists ).toBe( true )
    } )


    it( 'does not destroy an existing global "other" transcript when binding memo-init-transcript.md', async () => {
        const other = await registry.addOtherTranscript( {
            projectId: 'proj',
            content: 'Eine lose Notiz, die erhalten bleiben muss.',
            otherRoot: tempDir
        } )
        expect( other[ 'status' ] ).toBe( true )

        const memoDir = join( tempDir, '.memo', 'memos', '051-keep-other' )
        await mkdir( memoDir, { recursive: true } )

        const init = await registry.addInitTranscript( {
            projectId: 'proj',
            memoId: '051-keep-other',
            content: 'Gebundener Init-Inhalt.',
            memoPath: memoDir
        } )
        expect( init[ 'status' ] ).toBe( true )

        // the loose other transcript file must still exist (no delete/move)
        let otherStillThere = true
        try {
            await access( other[ 'absolutePath' ] )
        } catch {
            otherStillThere = false
        }
        expect( otherStillThere ).toBe( true )

        const { transcripts: others } = registry.listOtherTranscripts( { otherRoot: tempDir } )
        const stillListed = others.some( ( entry ) => entry[ 'transcriptId' ] === other[ 'transcriptId' ] )
        expect( stillListed ).toBe( true )
    } )


    it( 'is idempotent: a second init binding never silently overwrites memo-init-transcript.md', async () => {
        const memoDir = join( tempDir, '.memo', 'memos', '052-idempotent' )
        await mkdir( memoDir, { recursive: true } )

        const first = await registry.addInitTranscript( {
            projectId: 'proj',
            memoId: '052-idempotent',
            content: 'ERSTER Inhalt — soll bleiben.',
            memoPath: memoDir
        } )
        expect( first[ 'status' ] ).toBe( true )

        const second = await registry.addInitTranscript( {
            projectId: 'proj',
            memoId: '052-idempotent',
            content: 'ZWEITER Inhalt — darf NICHT überschreiben.',
            memoPath: memoDir
        } )

        expect( second[ 'status' ] ).toBe( false )
        expect( second[ 'messages' ].join( ' ' ) ).toContain( 'already exists' )

        const afterContent = await readFile( join( memoDir, 'transcripts', 'memo-init-transcript.md' ), 'utf-8' )
        expect( afterContent ).toContain( 'ERSTER Inhalt — soll bleiben.' )
        expect( afterContent ).not.toContain( 'ZWEITER Inhalt' )
    } )


    it( 'promoteOtherTranscript binds an existing other transcript into the memo (review file, source removed)', async () => {
        const other = await registry.addOtherTranscript( {
            projectId: 'proj',
            content: 'Transcript, das promotet wird.',
            otherRoot: tempDir
        } )
        expect( other[ 'status' ] ).toBe( true )

        const memoDir = join( tempDir, '.memo', 'memos', '053-promote' )
        await mkdir( memoDir, { recursive: true } )

        const promoted = await registry.promoteOtherTranscript( {
            transcriptId: other[ 'transcriptId' ],
            targetMemoPath: memoDir,
            memoId: '053-promote',
            revisionId: 'REV-01'
        } )

        expect( promoted[ 'status' ] ).toBe( true )
        const movedContent = await readFile( promoted[ 'absolutePath' ], 'utf-8' )
        expect( movedContent ).toContain( 'Transcript, das promotet wird.' )

        // promote MOVES the source (rename) — it is intentionally gone from the other store
        let sourceGone = false
        try {
            await access( other[ 'absolutePath' ] )
        } catch {
            sourceGone = true
        }
        expect( sourceGone ).toBe( true )
    } )
} )


describe( 'PRD-004 (Memo 054 Kap 2) — autoBindInitTranscript', () => {
    let tempDir
    let registry


    beforeEach( async () => {
        await mkdir( testHomeRoot, { recursive: true } )
        tempDir = await mkdtemp( join( testHomeRoot, 'auto-bind-' ) )
        const { registry: reg } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        registry = reg
    } )


    afterEach( async () => {
        registry.shutdown()
        await rm( tempDir, { recursive: true, force: true } )
    } )


    it( 'auto-binds the first memo-init other-transcript when the memo has no init transcript yet', async () => {
        // add a memo-init typed "other" transcript
        const other = await registry.addOtherTranscript( {
            projectId: 'proj',
            content: 'Die erste Idee fuer das neue Memo.',
            otherRoot: tempDir,
            type: 'memo-init'
        } )
        expect( other[ 'status' ] ).toBe( true )

        const memoDir = join( tempDir, '.memo', 'memos', '060-auto-bind' )
        await mkdir( memoDir, { recursive: true } )

        const result = await registry.autoBindInitTranscript( {
            projectId: 'proj',
            memoId: '060-auto-bind',
            memoPath: memoDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'absolutePath' ].endsWith( 'memo-init-transcript.md' ) ).toBe( true )

        const written = await readFile( result[ 'absolutePath' ], 'utf-8' )
        expect( written ).toContain( 'Die erste Idee fuer das neue Memo.' )
    } )


    it( 'skips auto-bind (NO-OVERWRITE) when an init transcript is already bound to the memo', async () => {
        const other = await registry.addOtherTranscript( {
            projectId: 'proj',
            content: 'Zweiter Anlauf — soll NICHT ueberschreiben.',
            otherRoot: tempDir,
            type: 'memo-init'
        } )
        expect( other[ 'status' ] ).toBe( true )

        const memoDir = join( tempDir, '.memo', 'memos', '061-no-overwrite' )
        await mkdir( memoDir, { recursive: true } )

        // bind once manually
        const first = await registry.addInitTranscript( {
            projectId: 'proj',
            memoId: '061-no-overwrite',
            content: 'ERSTER Inhalt — soll bleiben.',
            memoPath: memoDir
        } )
        expect( first[ 'status' ] ).toBe( true )

        // auto-bind must skip silently
        const result = await registry.autoBindInitTranscript( {
            projectId: 'proj',
            memoId: '061-no-overwrite',
            memoPath: memoDir
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'skipped' ] ).toBe( true )
        expect( result[ 'reason' ] ).toBe( 'already-bound' )

        // original file must be unchanged
        const content = await readFile( join( memoDir, 'transcripts', 'memo-init-transcript.md' ), 'utf-8' )
        expect( content ).toContain( 'ERSTER Inhalt — soll bleiben.' )
        expect( content ).not.toContain( 'Zweiter Anlauf' )
    } )


    it( 'returns skipped=true when no memo-init other-transcript exists for the projectId', async () => {
        const memoDir = join( tempDir, '.memo', 'memos', '062-no-candidate' )
        await mkdir( memoDir, { recursive: true } )

        const result = await registry.autoBindInitTranscript( {
            projectId: 'proj',
            memoId: '062-no-candidate',
            memoPath: memoDir
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'skipped' ] ).toBe( true )
        expect( result[ 'reason' ] ).toBe( 'no-candidate' )
    } )


    it( 'does not treat a plain "frei" other-transcript as an auto-bind candidate', async () => {
        await registry.addOtherTranscript( {
            projectId: 'proj',
            content: 'Lose Notiz ohne Init-Kontext.',
            otherRoot: tempDir
            // default type = frei
        } )

        const memoDir = join( tempDir, '.memo', 'memos', '063-frei-not-candidate' )
        await mkdir( memoDir, { recursive: true } )

        const result = await registry.autoBindInitTranscript( {
            projectId: 'proj',
            memoId: '063-frei-not-candidate',
            memoPath: memoDir
        } )

        expect( result[ 'skipped' ] ).toBe( true )
        expect( result[ 'reason' ] ).toBe( 'no-candidate' )
    } )
} )
