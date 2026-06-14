import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoInit } from '../../src/MemoInit.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'


// PRD-001 (Memo 011 Kap 10): `memo init` core. Scans .memo/ for the highest NNN, assigns the next
// zero-padded number, derives the slug, and lays down .memo/{NNN}-{slug}/revisions/REV-01.md from
// templates/REV.md.template (PRD-002). NO-OVERWRITE is a hard rule. Tests write ONLY into a
// repo-internal temp directory (.test-tmp/), never the real .memo/ and never the user home
// (~/.claude/CLAUDE.md § Test-Isolation).
describe( 'MemoInit — PRD-001 (Memo 011 Kap 10)', () => {
    const here = dirname( fileURLToPath( import.meta.url ) )
    const templatePath = resolve( here, '../../templates/REV.md.template' )
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let memoDir = ''

    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        memoDir = await mkdtemp( join( repoTmpRoot, 'memoinit-' ) )
    } )

    afterEach( async () => {
        await rm( memoDir, { recursive: true, force: true } )
    } )


    const exists = async ( filePath ) => {
        try {
            await access( filePath )

            return true
        } catch( error ) {
            return false
        }
    }


    describe( 'scanHighestNumber', () => {
        it( 'AC: missing .memo/ directory -> { highest: 0 }', async () => {
            const absent = join( memoDir, 'does-not-exist' )
            const result = await MemoInit.scanHighestNumber( { memoDir: absent } )

            expect( result ).toEqual( { highest: 0 } )
        } )


        it( 'AC: empty directory -> { highest: 0 }', async () => {
            const result = await MemoInit.scanHighestNumber( { memoDir } )

            expect( result ).toEqual( { highest: 0 } )
        } )


        it( 'AC: filters folders by ^(\\d{3})- and returns the highest number (legacy flat layout)', async () => {
            await mkdir( join( memoDir, '001-first' ) )
            await mkdir( join( memoDir, '007-seventh' ) )
            await mkdir( join( memoDir, '011-eleventh' ) )

            const result = await MemoInit.scanHighestNumber( { memoDir } )

            expect( result ).toEqual( { highest: 11 } )
        } )


        it( 'AC: non-numeric folders are ignored (no crash)', async () => {
            await mkdir( join( memoDir, '003-third' ) )
            await mkdir( join( memoDir, 'plans' ) )
            await mkdir( join( memoDir, 'requirements' ) )
            await writeFile( join( memoDir, 'config.json' ), '{}' )

            const result = await MemoInit.scanHighestNumber( { memoDir } )

            expect( result ).toEqual( { highest: 3 } )
        } )


        // PRD-002 (Memo 013 Kap 9): dual-scan migration awareness.
        it( 'AC: scans the co-located memos/ layer (new layout)', async () => {
            await mkdir( join( memoDir, 'memos', '001-first' ), { recursive: true } )
            await mkdir( join( memoDir, 'memos', '013-thirteenth' ), { recursive: true } )

            const result = await MemoInit.scanHighestNumber( { memoDir } )

            expect( result ).toEqual( { highest: 13 } )
        } )


        it( 'AC: dual-layout takes the maximum across <root>/memos AND <root> (legacy + new)', async () => {
            // legacy flat 005 + co-located 012 -> max wins (12), so next is 013
            await mkdir( join( memoDir, '005-legacy' ) )
            await mkdir( join( memoDir, 'memos', '012-newish' ), { recursive: true } )

            const result = await MemoInit.scanHighestNumber( { memoDir } )

            expect( result ).toEqual( { highest: 12 } )
        } )
    } )


    describe( 'nextNumber', () => {
        it( 'AC: { highest: 0 } -> "001"', () => {
            expect( MemoInit.nextNumber( { highest: 0 } ) ).toEqual( { number: '001' } )
        } )


        it( 'AC: { highest: 11 } -> "012" (zero-padded 3 digits)', () => {
            expect( MemoInit.nextNumber( { highest: 11 } ) ).toEqual( { number: '012' } )
        } )


        it( 'AC: { highest: 99 } -> "100"', () => {
            expect( MemoInit.nextNumber( { highest: 99 } ) ).toEqual( { number: '100' } )
        } )
    } )


    describe( 'slugFromTopic', () => {
        it( 'AC: lowercase + hyphens', () => {
            expect( MemoInit.slugFromTopic( { topic: 'OAuth Integration' } ) ).toEqual( { slug: 'oauth-integration' } )
        } )


        it( 'AC: collapses non-alphanumerics and trims edge hyphens', () => {
            expect( MemoInit.slugFromTopic( { topic: '  Foo / Bar:  Baz!  ' } ) ).toEqual( { slug: 'foo-bar-baz' } )
        } )


        it( 'AC: caps at max 40 chars and never ends on a hyphen', () => {
            const topic = 'this is a really long memo topic that exceeds the forty char limit'
            const { slug } = MemoInit.slugFromTopic( { topic } )

            expect( slug.length ).toBeLessThanOrEqual( 40 )
            expect( slug.endsWith( '-' ) ).toBe( false )
        } )
    } )


    describe( 'createMemoStructure', () => {
        it( 'AC: creates .memo/memos/{NNN}-{slug}/revisions/REV-01.md with the next free number', async () => {
            // legacy flat 011 present -> next is 012, but the WRITE lands under memos/ (PRD-002)
            await mkdir( join( memoDir, '011-eleventh' ) )

            const result = await MemoInit.createMemoStructure( {
                memoDir,
                topic: 'OAuth Integration',
                templatePath,
                date: '2026-06-14'
            } )

            expect( result.number ).toBe( '012' )
            expect( result.slug ).toBe( 'oauth-integration' )

            const expectedRev = join( memoDir, 'memos', '012-oauth-integration', 'revisions', 'REV-01.md' )
            expect( result.revPath ).toBe( expectedRev )
            expect( await exists( expectedRev ) ).toBe( true )
        } )


        it( 'AC: starts numbering at 001 when .memo/ has no numbered folders (writes under memos/)', async () => {
            const result = await MemoInit.createMemoStructure( {
                memoDir,
                topic: 'First Memo',
                templatePath,
                date: '2026-06-14'
            } )

            expect( result.number ).toBe( '001' )
            expect( await exists( join( memoDir, 'memos', '001-first-memo', 'revisions', 'REV-01.md' ) ) ).toBe( true )
        } )


        // PRD-002 (Memo 013 Kap 9): next number resolves over the co-located memos/ layer.
        it( 'AC: next number is computed over the memos/ layer (013 present -> 014)', async () => {
            await mkdir( join( memoDir, 'memos', '013-thirteenth' ), { recursive: true } )

            const result = await MemoInit.createMemoStructure( {
                memoDir,
                topic: 'Probe',
                templatePath,
                date: '2026-06-14'
            } )

            expect( result.number ).toBe( '014' )

            const expectedRev = join( memoDir, 'memos', '014-probe', 'revisions', 'REV-01.md' )
            expect( result.revPath ).toBe( expectedRev )
            expect( await exists( expectedRev ) ).toBe( true )
        } )


        // PRD-002: the write target is under memos/, NEVER directly in the flat root (anti-pollution).
        it( 'AC: write target is under memos/ and does NOT pollute the flat root', async () => {
            const result = await MemoInit.createMemoStructure( {
                memoDir,
                topic: 'Root Pollution Check',
                templatePath,
                date: '2026-06-14'
            } )

            expect( result.path ).toBe( join( memoDir, 'memos', '001-root-pollution-check' ) )
            // NO folder directly in the flat root
            expect( await exists( join( memoDir, '001-root-pollution-check' ) ) ).toBe( false )
            // it lives under memos/
            expect( await exists( join( memoDir, 'memos', '001-root-pollution-check' ) ) ).toBe( true )
        } )


        it( 'AC: REV-01.md is the template with header placeholders filled', async () => {
            await mkdir( join( memoDir, '011-eleventh' ) )

            const result = await MemoInit.createMemoStructure( {
                memoDir,
                topic: 'OAuth Integration',
                templatePath,
                date: '2026-06-14'
            } )

            const content = await readFile( result.revPath, 'utf8' )

            // header placeholders resolved
            expect( content ).toContain( '| **Memo** | 012 |' )
            expect( content ).toContain( '| **Memo-Name** | OAuth Integration |' )
            expect( content ).toContain( '| **Datum** | 2026-06-14 |' )
            expect( content ).toContain( '# OAuth Integration' )
            // header placeholders are gone
            expect( content ).not.toContain( '{XXX}' )
            expect( content ).not.toContain( '{TOPIC}' )
            expect( content ).not.toContain( '{YYYY-MM-DD HH:MM}' )
        } )


        it( 'AC: created skeleton passes MemoValidator section check (10-section round-trip)', async () => {
            const result = await MemoInit.createMemoStructure( {
                memoDir,
                topic: 'OAuth Integration',
                templatePath,
                date: '2026-06-14'
            } )

            const content = await readFile( result.revPath, 'utf8' )
            const validated = MemoValidator.validate( { doc: content } )
            const sectionMsgs = validated[ 'messages' ].filter( ( m ) => m.startsWith( 'MEMO-001' ) )

            // No mandatory section is missing (same contract as PRD-002 template round-trip).
            expect( sectionMsgs ).toEqual( [] )
            // Full clean: a freshly scaffolded memo must pass validation outright (status=true),
            // not merely lack missing-section findings. Guards against the MEMO-040 question-block
            // bleed (F1 absorbing the Phasen checkboxes) regressing silently.
            expect( validated[ 'status' ] ).toBe( true )
            expect( validated[ 'messages' ] ).toEqual( [] )
        } )


        it( 'AC: NO-OVERWRITE — existing target folder aborts without clobbering', async () => {
            // The scan is collision-free by construction (next = max+1), so the guard is only
            // reachable when the scan under-reports — a TOCTOU / concurrent-run race. Force that
            // race with a spy that reports highest=0 while the 001-folder already exists on disk.
            // The target now lives under memos/ (PRD-002), so the collision folder is seeded there.
            const topic = 'Collision Topic'
            const { slug } = MemoInit.slugFromTopic( { topic } )

            const targetFolder = join( memoDir, 'memos', `001-${ slug }` )
            const targetRev = join( targetFolder, 'revisions', 'REV-01.md' )
            await mkdir( join( targetFolder, 'revisions' ), { recursive: true } )
            const sentinel = 'DO NOT OVERWRITE'
            await writeFile( targetRev, sentinel )

            const spy = jest
                .spyOn( MemoInit, 'scanHighestNumber' )
                .mockResolvedValue( { highest: 0 } )

            await expect( MemoInit.createMemoStructure( {
                memoDir,
                topic,
                templatePath,
                date: '2026-06-14'
            } ) ).rejects.toThrow( /NO-OVERWRITE/ )

            // The existing file is untouched.
            const after = await readFile( targetRev, 'utf8' )
            expect( after ).toBe( sentinel )

            spy.mockRestore()
        } )
    } )
} )
