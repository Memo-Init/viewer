import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename, dirname } from 'node:path'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'
import { TranscriptHeader } from '../../src/TranscriptHeader.mjs'


// Memo 019 Phase 2 — PRD-002 (memo-init transcript) + PRD-003 (frei transcript am Memo).
describe( 'TranscriptRegistry Phase 2 (Memo 019 PRD-002/003)', () => {
    let tempDir
    let registry


    beforeEach( async () => {
        // Repo-internes Temp-Verzeichnis (OS tmpdir) — niemals User-Home.
        tempDir = await mkdtemp( join( tmpdir(), 'transcript-p2-' ) )
        const { registry: reg } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        registry = reg
    } )


    afterEach( async () => {
        registry.shutdown()
        await rm( tempDir, { recursive: true, force: true } )
    } )


    describe( 'addOtherTranscript — type: memo-init (PRD-002)', () => {
        it( 'writes the memo-init default header (no number, no path)', async () => {
            const { status, absolutePath } = await registry.addOtherTranscript( {
                projectId: 'myproject',
                content: 'Bootstrap-Text fuer ein neues Memo',
                otherRoot: tempDir,
                type: 'memo-init'
            } )

            expect( status ).toBe( true )

            const raw = await readFile( absolutePath, 'utf-8' )

            expect( raw.startsWith( '# Transcript fuer neues Memo (memo-init)' ) ).toBe( true )
            expect( raw ).toContain( 'Schema-Version: 2' )
            expect( raw ).not.toMatch( /REV-\d+/ )
            expect( raw ).not.toContain( 'Memo-Pfad:' )
        } )


        it( 'detectType on the saved file is memo-init', async () => {
            const { absolutePath } = await registry.addOtherTranscript( {
                projectId: 'myproject',
                content: 'Inhalt',
                otherRoot: tempDir,
                type: 'memo-init'
            } )

            const raw = await readFile( absolutePath, 'utf-8' )
            const { type } = TranscriptHeader.detectType( { content: raw } )

            expect( type ).toBe( 'memo-init' )
        } )


        it( 'default without type stays frei (regression)', async () => {
            const { absolutePath } = await registry.addOtherTranscript( {
                projectId: 'myproject',
                content: 'Freier Inhalt',
                otherRoot: tempDir
            } )

            const raw = await readFile( absolutePath, 'utf-8' )
            const { type } = TranscriptHeader.detectType( { content: raw } )

            expect( type ).toBe( 'frei' )
            expect( raw.startsWith( '# Transcript (frei / undefiniert)' ) ).toBe( true )
        } )


        it( 'rejects an unsupported type', async () => {
            const { status, messages } = await registry.addOtherTranscript( {
                projectId: 'myproject',
                content: 'Inhalt',
                otherRoot: tempDir,
                type: 'revision'
            } )

            expect( status ).toBe( false )
            expect( messages.join( ' ' ) ).toContain( 'TRANSCRIPT-VAL-001' )
        } )
    } )


    describe( 'addFreeMemoTranscript — frei am Memo (PRD-003)', () => {
        async function makeMemo() {
            const memoPath = resolve( tempDir, '.memo', 'memos', '042-feature' )
            await mkdir( resolve( memoPath, 'revisions' ), { recursive: true } )

            return { memoPath }
        }


        it( 'stores a frei transcript in the memo transcripts/ folder, no REV in name/header', async () => {
            const { memoPath } = await makeMemo()
            const { status, absolutePath } = await registry.addFreeMemoTranscript( {
                projectId: 'myproject',
                memoId: '042-feature',
                content: 'Schwieriges Problem dokumentiert',
                memoPath
            } )

            expect( status ).toBe( true )
            expect( basename( dirname( absolutePath ) ) ).toBe( 'transcripts' )
            expect( basename( absolutePath ) ).toBe( 'frei--01.md' )
            expect( basename( absolutePath ).startsWith( 'REV-' ) ).toBe( false )

            const raw = await readFile( absolutePath, 'utf-8' )

            expect( raw.startsWith( '# Transcript (frei / undefiniert)' ) ).toBe( true )
            expect( raw ).not.toMatch( /REV-\d+/ )

            const { type } = TranscriptHeader.detectType( { content: raw } )

            expect( type ).toBe( 'frei' )
        } )


        it( 'second add gets a fortlaufende, distinct sequence (no overwrite)', async () => {
            const { memoPath } = await makeMemo()
            const first = await registry.addFreeMemoTranscript( { projectId: 'myproject', memoId: '042-feature', content: 'A', memoPath } )
            const second = await registry.addFreeMemoTranscript( { projectId: 'myproject', memoId: '042-feature', content: 'B', memoPath } )

            expect( first[ 'status' ] ).toBe( true )
            expect( second[ 'status' ] ).toBe( true )
            expect( basename( first[ 'absolutePath' ] ) ).toBe( 'frei--01.md' )
            expect( basename( second[ 'absolutePath' ] ) ).toBe( 'frei--02.md' )
            expect( first[ 'url' ] ).not.toBe( second[ 'url' ] )
        } )


        it( 'scanMemo re-registers frei--NN files without misreading them as revisions', async () => {
            const { memoPath } = await makeMemo()
            await registry.addFreeMemoTranscript( { projectId: 'myproject', memoId: '042-feature', content: 'A', memoPath } )

            const { registry: fresh } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
            const { status, registered } = await fresh.scanMemo( { memoPath, projectId: 'myproject', memoId: '042-feature' } )

            expect( status ).toBe( true )
            expect( registered ).toBe( 1 )

            const { tree } = fresh.getTranscriptTree()
            // free memo transcripts have no revisionId -> NOT part of the revision-bound tree.
            const revisionBound = tree[ 'myproject' ] && tree[ 'myproject' ][ '042-feature' ] ? tree[ 'myproject' ][ '042-feature' ] : []

            expect( revisionBound.length ).toBe( 0 )
            fresh.shutdown()
        } )


        it( 'rejects missing memoId', async () => {
            const { memoPath } = await makeMemo()
            const { status, messages } = await registry.addFreeMemoTranscript( { projectId: 'myproject', content: 'A', memoPath } )

            expect( status ).toBe( false )
            expect( messages.join( ' ' ) ).toContain( 'memoId' )
        } )
    } )


    describe( 'Typ -> Default-Header-Zuordnung (PRD-003 US-4)', () => {
        it( 'frei -> FREI header first line', () => {
            const { header } = TranscriptHeader.build( { type: 'frei' } )
            const { type } = TranscriptHeader.detectType( { content: header } )

            expect( type ).toBe( 'frei' )
        } )


        it( 'memo-init -> memo-init header first line (no number)', () => {
            const { header } = TranscriptHeader.build( { type: 'memo-init' } )
            const { type } = TranscriptHeader.detectType( { content: header } )

            expect( type ).toBe( 'memo-init' )
            expect( header ).not.toMatch( /REV-\d+/ )
        } )


        it( 'revision -> revision header with REV-NEXT = max+1', () => {
            const { header } = TranscriptHeader.build( { type: 'revision', memoId: '042-feature', maxRevNumber: 4 } )
            const { type } = TranscriptHeader.detectType( { content: header } )

            expect( type ).toBe( 'revision' )
            expect( header ).toContain( 'REV-05' )
            expect( header ).toContain( 'REV-04' )
        } )
    } )
} )
