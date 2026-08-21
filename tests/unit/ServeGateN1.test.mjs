import { describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DatabaseSync } from '@dolthub/doltlite'

import { MemoView } from '../../src/MemoView.mjs'
import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'


// Memo 079 N1 serve-gate (contained): when the DB-serve branch fires for a db-backed memo HEAD, the
// DoltDbAssembler still emits a TRACER-CUT body — no `questions-json` fence and it fails MemoValidator —
// which would render the Fragen-Widget empty and mark the memo invalid. The contained fix prefers the
// frozen REV file whenever the DB body is not self-sufficient. MemoView.dbBodyServeable is the (public,
// pure) gate the serve path consults; these tests drive it directly and assert the fallback wiring.
describe( 'Memo 079 N1 serve-gate — tracer-cut DB body triggers file-serve fallback', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let root = ''

    // Seed a minimal per-memo db whose assembleFromDb output is exactly the tracer-cut body (no fence).
    const seedDb = ( { dbPath, memoName, revisionNos, questions } ) => {
        const db = new DatabaseSync( dbPath )
        db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_diagrams ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS lifecycle ( state TEXT, `at` TEXT, `by` TEXT, evidence TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS revision ( rev_no INTEGER PRIMARY KEY, md_sha256 TEXT, md_path TEXT, dolt_commit TEXT, tag TEXT, created_at TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT )' )

        db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'M079', memoName, 'Implementation', 'in-progress', '2026-08-20T00:00:00Z' )
        ;( revisionNos || [] )
            .forEach( ( revNo ) => {
                db.prepare( 'INSERT INTO revision ( rev_no, md_sha256, created_at ) VALUES ( ?, ?, ? )' )
                    .run( revNo, 'sha-' + revNo, '2026-08-20T00:00:00Z' )
            } )
        ;( questions || [] )
            .forEach( ( q ) => {
                db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' )
                    .run( q.id, 'M079', q.text, q.kind, q.status )
            } )
        db.close()
    }


    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        root = mkdtempSync( join( repoTmpRoot, 'serve-gate-' ) )
    } )

    afterEach( () => {
        rmSync( root, { recursive: true, force: true } )
    } )


    it( 'the REAL DoltDbAssembler HEAD body (tracer-cut) is NOT serveable (no questions-json fence / invalid)', () => {
        const memoDir = join( root, '079-tracer' )
        mkdirSync( memoDir, { recursive: true } )
        seedDb( {
            dbPath: resolve( memoDir, 'memo-079.db' ),
            memoName: 'tracer-cut memo',
            revisionNos: [ 1 ],
            questions: [ { id: 'F1', text: 'Soll X?', kind: 'info', status: 'open' } ]
        } )

        const { dbPath } = DoltDbAssembler.resolveDbPath( { memoDir } )
        const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

        // The assembled body has open questions in the DB but emits them as `## Offene Fragen` bullets
        // (no `### F{N}` blocks, no fence) — the widget would render empty → NOT serveable.
        expect( MemoView.dbBodyServeable( { markdown } ) ).toBe( false )
    } )


    it( 'a body with a questions-json fence but NO header/Kontext (fails MemoValidator) is NOT serveable', () => {
        const fenceOnly = [ '# X', '', '```questions-json', '[]', '```', '' ].join( '\n' )

        expect( MemoView.dbBodyServeable( { markdown: fenceOnly } ) ).toBe( false )
    } )


    it( 'an empty / non-string body is NOT serveable (defensive)', () => {
        expect( MemoView.dbBodyServeable( { markdown: '' } ) ).toBe( false )
        expect( MemoView.dbBodyServeable( { markdown: null } ) ).toBe( false )
    } )


    it( 'a full valid revision WITH a questions-json fence IS serveable (the assembler-complete target)', () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const validBody = readFileSync( join( here, '..', 'fixtures', 'memo-038-REV-05.md' ), 'utf8' )

        expect( MemoView.dbBodyServeable( { markdown: validBody } ) ).toBe( true )
    } )


    it( 'the gate decision: a tracer-cut DB body + an existing frozen REV file → the FILE is preferred', () => {
        const memoDir = join( root, '079-fallback' )
        const revDir = join( memoDir, 'revisions' )
        mkdirSync( revDir, { recursive: true } )
        const frozenPath = join( revDir, 'REV-01.md' )
        writeFileSync( frozenPath, '# frozen\n\nFROZEN-FILE-CONTENT\n' )
        seedDb( { dbPath: resolve( memoDir, 'memo-079.db' ), memoName: 'fallback memo', revisionNos: [ 1 ], questions: [ { id: 'F1', text: 'Q?', kind: 'info', status: 'open' } ] } )

        const { dbPath } = DoltDbAssembler.resolveDbPath( { memoDir } )
        const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

        // The gate says: DB body not serveable AND the frozen file exists → serve the frozen file.
        const dbUsable = MemoView.dbBodyServeable( { markdown } )
        const preferFile = dbUsable !== true && existsSync( frozenPath ) === true

        expect( dbUsable ).toBe( false )
        expect( preferFile ).toBe( true )
    } )


    describe( 'MemoView.mjs wiring (private #loadRevisionSource consults the gate)', () => {
        let source = ''

        beforeAll( () => {
            const here = dirname( fileURLToPath( import.meta.url ) )
            source = readFileSync( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
        } )

        it( '#loadRevisionSource serves the DB body ONLY when dbBodyServeable (or no frozen file), else the frozen file', () => {
            const open = source.indexOf( 'static async #loadRevisionSource(' )
            const region = source.slice( open, open + 3500 )

            expect( region ).toContain( 'MemoView.dbBodyServeable( { markdown } ) === true || existsSync( absolutePath ) !== true' )
            expect( region ).toContain( 'N1 serve-gate' )
            expect( region ).toContain( "await readFile( absolutePath, 'utf-8' )" )
        } )
    } )
} )
