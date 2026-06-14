import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { FindingsStore, SCHEMA_VERSION } from '../../src/FindingsStore.mjs'


// PRD-010 (Memo 011 Kap 9): per-memo, append-only Findings-Store (fan-out shared memory).
// node:sqlite, WAL, INSERT/SELECT only, Hash-IDs, dedup per ID, NO-OVERWRITE on init, ID required on
// put. Tests write ONLY into a repo-internal temp directory (.test-tmp/), NEVER the real .memo/ and
// NEVER the user home (~/.claude/CLAUDE.md § Test-Isolation).
describe( 'FindingsStore — PRD-010 (Memo 011 Kap 9)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let memoPath = ''

    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        memoPath = await mkdtemp( join( repoTmpRoot, 'findings-' ) )
    } )

    afterEach( async () => {
        await rm( memoPath, { recursive: true, force: true } )
    } )


    describe( 'init (US-1)', () => {
        it( 'AC: creates findings.db with the append-only schema and WAL mode', async () => {
            const result = await FindingsStore.init( { memoPath } )

            expect( result.status ).toBe( 'created' )
            expect( result.schemaVersion ).toBe( SCHEMA_VERSION )

            // WAL is actually set on the file.
            const db = new DatabaseSync( result.path )
            const mode = db.prepare( 'PRAGMA journal_mode' ).get()
            db.close()
            expect( String( mode[ 'journal_mode' ] ).toLowerCase() ).toBe( 'wal' )
        } )


        it( 'AC: returns an object { status, path, schemaVersion } (no primitive)', async () => {
            const result = await FindingsStore.init( { memoPath } )

            expect( typeof result ).toBe( 'object' )
            expect( Object.keys( result ).sort() ).toEqual( [ 'path', 'schemaVersion', 'status' ] )
        } )


        it( 'AC: NO-OVERWRITE — second init on an existing findings.db is { status: exists } and does not clobber', async () => {
            const first = await FindingsStore.init( { memoPath } )

            // put a row so we can prove the data survives a second init.
            FindingsStore.put( { memoPath, id: 'keep-1', thread: 't', author: 'a', payload: '{"k":1}' } )
            const before = await stat( first.path )

            const second = await FindingsStore.init( { memoPath } )

            expect( second.status ).toBe( 'exists' )
            expect( second.path ).toBe( first.path )

            // mtime unchanged (no write happened) and the earlier row still readable.
            const after = await stat( first.path )
            expect( after.mtimeMs ).toBe( before.mtimeMs )

            const read = FindingsStore.get( { memoPath } )
            expect( read.count ).toBe( 1 )
            expect( read.items[ 0 ].id ).toBe( 'keep-1' )
        } )
    } )


    describe( 'put (US-2)', () => {
        it( 'AC: roundtrip — put a finding then get it back', async () => {
            await FindingsStore.init( { memoPath } )

            const put = FindingsStore.put( {
                memoPath,
                id: 'abc123',
                thread: 'research',
                author: 'scout',
                payload: '{"claim":"node:sqlite is built-in"}'
            } )
            expect( put ).toEqual( { status: 'inserted', id: 'abc123' } )

            const got = FindingsStore.get( { memoPath } )
            expect( got.count ).toBe( 1 )
            expect( got.items[ 0 ] ).toMatchObject( {
                id: 'abc123',
                thread: 'research',
                author: 'scout',
                payload: '{"claim":"node:sqlite is built-in"}'
            } )
            expect( typeof got.items[ 0 ].createdAt ).toBe( 'string' )
        } )


        it( 'AC: dedup per ID — two writers with the same ID do NOT overwrite, only one row survives', async () => {
            await FindingsStore.init( { memoPath } )

            const writerA = FindingsStore.put( {
                memoPath, id: 'shared-id', thread: 'topic', author: 'writer-A', payload: '{"v":"A"}'
            } )
            const writerB = FindingsStore.put( {
                memoPath, id: 'shared-id', thread: 'topic', author: 'writer-B', payload: '{"v":"B"}'
            } )

            expect( writerA ).toEqual( { status: 'inserted', id: 'shared-id' } )
            expect( writerB ).toEqual( { status: 'duplicate', id: 'shared-id' } )

            // append-only / reducer-merge: exactly one row, and it is the FIRST writer's payload.
            const got = FindingsStore.get( { memoPath } )
            expect( got.count ).toBe( 1 )
            expect( got.items[ 0 ].author ).toBe( 'writer-A' )
            expect( got.items[ 0 ].payload ).toBe( '{"v":"A"}' )
        } )


        it( 'AC: two DIFFERENT ids both survive (append-only — both rows present)', async () => {
            await FindingsStore.init( { memoPath } )

            FindingsStore.put( { memoPath, id: 'id-1', thread: 't', author: 'a', payload: '{"n":1}' } )
            FindingsStore.put( { memoPath, id: 'id-2', thread: 't', author: 'b', payload: '{"n":2}' } )

            const got = FindingsStore.get( { memoPath } )
            const ids = got.items.map( ( item ) => item.id )

            expect( got.count ).toBe( 2 )
            expect( ids.sort() ).toEqual( [ 'id-1', 'id-2' ] )
        } )


        it( 'AC: missing --id -> error envelope, NO insert', async () => {
            await FindingsStore.init( { memoPath } )

            const result = FindingsStore.put( { memoPath, thread: 't', author: 'a', payload: '{}' } )

            expect( result ).toEqual( {
                status: 'error',
                error: 'MEMO-FND-001 id required',
                fix: 'pass --id <hash> (orchestrator-generated)'
            } )

            const got = FindingsStore.get( { memoPath } )
            expect( got.count ).toBe( 0 )
        } )
    } )


    describe( 'get (US-3)', () => {
        beforeEach( async () => {
            await FindingsStore.init( { memoPath } )
            FindingsStore.put( { memoPath, id: 'g1', thread: 'alpha', author: 'a', payload: '{"i":1}' } )
            FindingsStore.put( { memoPath, id: 'g2', thread: 'beta', author: 'b', payload: '{"i":2}' } )
            FindingsStore.put( { memoPath, id: 'g3', thread: 'alpha', author: 'c', payload: '{"i":3}' } )
        } )


        it( 'AC: without --thread returns all findings', () => {
            const got = FindingsStore.get( { memoPath } )

            expect( got.status ).toBe( 'ok' )
            expect( got.count ).toBe( 3 )
        } )


        it( 'AC: --thread filters', () => {
            const got = FindingsStore.get( { memoPath, thread: 'alpha' } )

            expect( got.count ).toBe( 2 )
            const ids = got.items.map( ( item ) => item.id ).sort()
            expect( ids ).toEqual( [ 'g1', 'g3' ] )
        } )


        it( 'AC: deterministic order (created_at, id)', () => {
            const got = FindingsStore.get( { memoPath } )
            const ids = got.items.map( ( item ) => item.id )
            const sorted = [ ...ids ].sort()

            // created_at is identical-ish within a ms tick, so the tiebreak is id — order is stable.
            expect( ids ).toEqual( sorted )
        } )
    } )


    describe( 'hashId', () => {
        it( 'AC: deterministic — same thread+payload -> same 16-hex id', () => {
            const a = FindingsStore.hashId( { thread: 'research', payload: '{"k":1}' } )
            const b = FindingsStore.hashId( { thread: 'research', payload: '{"k":1}' } )

            expect( a.id ).toBe( b.id )
            expect( a.id ).toMatch( /^[0-9a-f]{16}$/ )
        } )


        it( 'AC: different input -> different id', () => {
            const a = FindingsStore.hashId( { thread: 'research', payload: '{"k":1}' } )
            const b = FindingsStore.hashId( { thread: 'research', payload: '{"k":2}' } )

            expect( a.id ).not.toBe( b.id )
        } )
    } )


    describe( 'append-only source contract', () => {
        it( 'AC: the store module contains no UPDATE or DELETE SQL', async () => {
            const source = await readFile( join( process.cwd(), 'src', 'FindingsStore.mjs' ), 'utf8' )

            expect( /UPDATE\s/i.test( source ) ).toBe( false )
            expect( /DELETE\s/i.test( source ) ).toBe( false )
        } )
    } )
} )
