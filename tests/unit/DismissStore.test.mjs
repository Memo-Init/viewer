import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DismissStore } from '../../src/DismissStore.mjs'


// Memo 079 PRD-22 (WI-045): the PERSISTENT dismiss ledger. A DELETE was in-memory only, so every boot
// re-registered the dismissed Karteileiche. This suite proves the append-only ledger survives a
// "restart" (a fresh read of the same path) and stays project-local (never user-home). Tests write ONLY
// into a repo-internal temp dir (.test-tmp/) per CLAUDE.md § Test-Isolation.
describe( 'DismissStore — Memo 079 PRD-22 (persistent dismiss ledger)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let baseDir = ''
    let storePath = ''


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        baseDir = await mkdtemp( join( repoTmpRoot, 'dismiss-' ) )
        storePath = join( baseDir, 'memo-view-dismissed.json' )
    } )

    afterEach( async () => {
        await rm( baseDir, { recursive: true, force: true } )
    } )


    it( 'records a dismissal and reads it back (survives a restart = fresh read)', () => {
        const recorded = DismissStore.record( { storePath, documentId: 'memo-init--079-foo', reason: 'delete' } )
        expect( recorded.status ).toBe( true )

        // A fresh readDismissed (no in-memory carry-over) is exactly the boot rehydration path.
        const { dismissed } = DismissStore.readDismissed( { storePath } )
        expect( dismissed ).toEqual( [ 'memo-init--079-foo' ] )
    } )


    it( 'is append-only across multiple records and dedupes ids at read time', () => {
        DismissStore.record( { storePath, documentId: 'p--a' } )
        DismissStore.record( { storePath, documentId: 'p--b' } )
        DismissStore.record( { storePath, documentId: 'p--a' } )

        const { dismissed } = DismissStore.readDismissed( { storePath } )
        expect( dismissed.sort() ).toEqual( [ 'p--a', 'p--b' ] )
    } )


    it( 'isDismissed reflects a recorded id and rejects an unknown one', () => {
        DismissStore.record( { storePath, documentId: 'p--x' } )

        expect( DismissStore.isDismissed( { storePath, documentId: 'p--x' } ).dismissed ).toBe( true )
        expect( DismissStore.isDismissed( { storePath, documentId: 'p--y' } ).dismissed ).toBe( false )
    } )


    it( 'fail-open: a missing ledger reads empty, never throws', () => {
        const { dismissed } = DismissStore.readDismissed( { storePath: join( baseDir, 'does-not-exist.json' ) } )
        expect( dismissed ).toEqual( [] )
    } )


    it( 'fail-open: a broken JSON ledger reads empty', async () => {
        await writeFile( storePath, '{ not json', 'utf8' )
        const { dismissed } = DismissStore.readDismissed( { storePath } )
        expect( dismissed ).toEqual( [] )
    } )


    it( 'rejects an empty documentId / empty storePath (no silent default)', () => {
        expect( DismissStore.record( { storePath, documentId: '' } ).status ).toBe( false )
        expect( DismissStore.record( { storePath: '', documentId: 'p--z' } ).status ).toBe( false )
    } )


    it( 'persists the canonical entry shape { documentId, dismissedAt, reason }', async () => {
        DismissStore.record( { storePath, documentId: 'p--shape', reason: 'delete' } )
        const parsed = JSON.parse( await readFile( storePath, 'utf8' ) )

        expect( Array.isArray( parsed.dismissed ) ).toBe( true )
        expect( parsed.dismissed[ 0 ].documentId ).toBe( 'p--shape' )
        expect( parsed.dismissed[ 0 ].reason ).toBe( 'delete' )
        expect( typeof parsed.dismissed[ 0 ].dismissedAt ).toBe( 'string' )
    } )


    it( 'resolveStorePath honours the MEMOVIEW_DISMISS_STORE env override and lands in .sessions otherwise', () => {
        const override = DismissStore.resolveStorePath( { env: { MEMOVIEW_DISMISS_STORE: storePath } } )
        expect( override.storePath ).toBe( storePath )

        const walked = DismissStore.resolveStorePath( { cwd: baseDir, env: {} } )
        expect( walked.storePath.endsWith( join( '.sessions', 'memo-view-dismissed.json' ) ) ).toBe( true )
    } )
} )
