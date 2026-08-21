import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, sep } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'


// Memo 079 M3=A (T059): UNLOCK annotating served research docs. The server annotation POST already accepts
// targetKind:'research' + researchFile; the missing halves were (a) a GET route to OPEN a research MD as an
// annotatable view and (b) the client sending targetKind/researchFile. This covers the new server read
// helper (path-guarded) and asserts the client wiring at source level (DOM = Playwright, no jsdom).
describe( 'Memo 079 M3=A — research-doc serve helper (MemoView.readResearchDoc)', () => {
    let memoDir = ''

    beforeAll( async () => {
        memoDir = await mkdtemp( join( tmpdir(), 'm3-research-' ) )
        await mkdir( join( memoDir, 'context', 'research' ), { recursive: true } )
        await writeFile( join( memoDir, 'context', 'research', 'deep.md' ), '# Deep Research\n\nInhalt zum Annotieren.\n', 'utf8' )
        await writeFile( join( dirname( memoDir ), 'outside-secret.md' ), 'top secret', 'utf8' )
    } )


    afterAll( async () => {
        await rm( memoDir, { recursive: true, force: true } )
    } )


    it( 'reads a research MD by its memoDir-relative path', async () => {
        const doc = await MemoView.readResearchDoc( { memoDir, researchFile: 'context/research/deep.md' } )

        expect( doc ).not.toBeNull()
        expect( doc.content ).toContain( '# Deep Research' )
        expect( doc.researchFile ).toBe( 'context/research/deep.md' )
        expect( doc.path.startsWith( memoDir + sep ) ).toBe( true )
    } )


    it( 'returns null for a missing research file', async () => {
        expect( await MemoView.readResearchDoc( { memoDir, researchFile: 'context/research/ghost.md' } ) ).toBeNull()
    } )


    it( 'blocks a path-traversal researchFile (../outside-secret.md) via the within-memo guard', async () => {
        expect( await MemoView.readResearchDoc( { memoDir, researchFile: '../outside-secret.md' } ) ).toBeNull()
    } )


    it( 'returns null for an empty/absent researchFile', async () => {
        expect( await MemoView.readResearchDoc( { memoDir, researchFile: '' } ) ).toBeNull()
        expect( await MemoView.readResearchDoc( { memoDir, researchFile: null } ) ).toBeNull()
    } )
} )


describe( 'Memo 079 M3=A — client research-annotation wiring (source-level; DOM = Playwright)', () => {
    let client = ''

    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        client = await readFile( join( here, '..', '..', 'src', 'public', 'app.client.mjs' ), 'utf8' )
    } )


    it( 'defines openResearchDoc and renders a clickable research link', () => {
        expect( client.includes( 'function openResearchDoc( researchFile )' ) ).toBe( true )
        expect( client.includes( "setAttribute( 'data-research-file', file )" ) ).toBe( true )
        expect( /fetch\(\s*qs\s*\)/.test( client ) || client.includes( '/api/research-page?documentId=' ) ).toBe( true )
        expect( client.includes( '/api/research-page?documentId=' ) ).toBe( true )
    } )


    it( 'tracks currentResearchFile and clears it when a real revision renders', () => {
        expect( client.includes( 'let currentResearchFile = null' ) ).toBe( true )
        expect( client.includes( 'currentResearchFile = researchFile' ) ).toBe( true )
        // cleared on a real revision content broadcast (currentFileName assignment path).
        expect( /currentResearchFile = null/.test( client ) ).toBe( true )
    } )


    it( 'saveAnnotation POSTs targetKind:research + researchFile when a research view is open', () => {
        expect( client.includes( "targetKind: 'research'" ) ).toBe( true )
        expect( client.includes( 'researchFile: currentResearchFile' ) ).toBe( true )
        // the hard REV-NN block no longer fires when a research view is open.
        expect( client.includes( 'if( !currentResearchFile && !rev )' ) ).toBe( true )
    } )


    it( 'refreshAnnotations scopes by researchFile when a research view is open', () => {
        expect( client.includes( "'?researchFile=' + encodeURIComponent( currentResearchFile )" ) ).toBe( true )
    } )
} )
