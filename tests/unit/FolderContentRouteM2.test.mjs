import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'


// Memo 079 M2 (T052 / WI-050): the generic per-folder content surface — the Specs precedent generalized so
// every declared folder tab renders REAL content instead of dead-ending on the "noch nicht verdrahtet"
// placeholder. The three pure helpers behind /api/folder + /api/folder-page are unit-tested directly here
// (resolution guard, doc listing, single-doc read); the DOM render is a Playwright concern (no jsdom).
describe( 'Memo 079 M2 — folder content helpers (resolveFolderTabDir / listFolderDocs / readFolderDoc)', () => {
    let root = ''
    let folderDir = ''

    const folderTabs = [
        { id: 'context', folder: 'context', view: 'context' },
        { id: 'escape', folder: '../outside', view: 'escape' }
    ]


    beforeAll( async () => {
        root = await mkdtemp( join( tmpdir(), 'm2-folder-' ) )
        folderDir = join( root, 'context' )
        await mkdir( folderDir, { recursive: true } )
        await writeFile( join( folderDir, 'bravo.md' ), '# Bravo\n\nzweites Dokument.\n', 'utf8' )
        await writeFile( join( folderDir, 'alpha.md' ), '# Alpha\n\nerstes Dokument.\n', 'utf8' )
        await writeFile( join( folderDir, 'notes.txt' ), 'not markdown', 'utf8' )
        await mkdir( join( folderDir, 'sub' ), { recursive: true } )
        await writeFile( join( folderDir, 'sub', 'nested.md' ), '# Nested\n', 'utf8' )
    } )


    afterAll( async () => {
        await rm( root, { recursive: true, force: true } )
    } )


    describe( 'resolveFolderTabDir (pure, path-traversal-guarded)', () => {
        it( 'resolves a declared tab id to an absolute dir under root', () => {
            const out = MemoView.resolveFolderTabDir( { folderTabs, root, id: 'context' } )

            expect( out ).not.toBeNull()
            expect( out.id ).toBe( 'context' )
            expect( out.folder ).toBe( 'context' )
            expect( out.dir ).toBe( folderDir )
        } )


        it( 'returns null for an unknown tab id', () => {
            expect( MemoView.resolveFolderTabDir( { folderTabs, root, id: 'nope' } ) ).toBeNull()
        } )


        it( 'blocks an out-of-root folder (../outside) via the traversal guard', () => {
            expect( MemoView.resolveFolderTabDir( { folderTabs, root, id: 'escape' } ) ).toBeNull()
        } )
    } )


    describe( 'listFolderDocs (pure over the filesystem)', () => {
        it( 'lists only top-level .md docs, sorted by name (ignores non-md + subdirs)', async () => {
            const docs = await MemoView.listFolderDocs( { dir: folderDir } )

            expect( docs.map( ( d ) => d.name ) ).toEqual( [ 'alpha.md', 'bravo.md' ] )
            expect( docs.map( ( d ) => d.stem ) ).toEqual( [ 'alpha', 'bravo' ] )
            expect( docs.every( ( d ) => typeof d.mtime === 'number' ) ).toBe( true )
        } )


        it( 'returns null for a missing/unreadable dir (route → 404), never throws', async () => {
            const docs = await MemoView.listFolderDocs( { dir: join( root, 'does-not-exist' ) } )

            expect( docs ).toBeNull()
        } )
    } )


    describe( 'readFolderDoc (pure, path-traversal-guarded)', () => {
        it( 'reads one doc raw markdown + provenance by stem', async () => {
            const doc = await MemoView.readFolderDoc( { dir: folderDir, stem: 'alpha' } )

            expect( doc ).not.toBeNull()
            expect( doc.content ).toContain( '# Alpha' )
            expect( doc.path.startsWith( folderDir + sep ) ).toBe( true )
        } )


        it( 'returns null for a non-existent stem', async () => {
            expect( await MemoView.readFolderDoc( { dir: folderDir, stem: 'ghost' } ) ).toBeNull()
        } )


        it( 'blocks a traversal stem (../secret) via the within-dir guard', async () => {
            await writeFile( join( root, 'secret.md' ), 'top secret', 'utf8' )

            expect( await MemoView.readFolderDoc( { dir: folderDir, stem: '../secret' } ) ).toBeNull()
        } )
    } )
} )
