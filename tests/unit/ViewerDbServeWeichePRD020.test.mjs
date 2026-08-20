import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DatabaseSync } from '@dolthub/doltlite'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'


// PRD-20 (Memo 079, P6a + FIX A/C): the Zwei-Regime serve weiche. A memo folder that carries a
// per-memo memo-NNN.db is served DB-first, but ONLY the newest (== HEAD) revision is DB-assembled;
// every OLDER revision keeps its frozen REV-NN.md file (doltlite 0.11.46 read-only Tag-Grenze — no
// AS OF, no branch-from-tag write). The DB weiche fires ONLY for a revisions/REV-NN.md path — every
// other file (HANDOVER.md, notes) is served verbatim (FIX A: no over-reach). A broken db degrades to
// the frozen file (FIX C). The 383 legacy memos (no db) keep the unchanged file-parse path.
// #readFileContent / #loadRevisionSource are private static in MemoView, so (following this suite's
// convention) the weiche is proven three ways: (1) the DoltDbAssembler leaves are unit-tested here,
// (2) the served-SOURCE decision is reproduced against real DocumentRegistry state, and (3) the
// MemoView.mjs wiring is asserted on source. The full private serve path is additionally driven
// end-to-end by tests/manual/serve-db-weiche-e2e.mjs (real server round-trip). Writes go ONLY into
// a repo-internal temp dir (.test-tmp/), never the real .memo/ or the user home.
describe( 'Viewer DB-first serve weiche (Memo 079, PRD-20)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    const FILE_PLACEHOLDER = 'DATEI-PLATZHALTER — dieser Text darf im DB-first HEAD-Viewer NICHT erscheinen'
    const OVERREACH_PLACEHOLDER = 'OVERREACH-PLATZHALTER — Nicht-Revisions-Datei, NIE DB-assembliert'
    let root = ''


    // Seed a per-memo memo-079.db. Optional revisionNos seed the `revision` table (rev_no) so the
    // weiche can resolve HEAD; optional questions seed the `question` table (FIX B). The DB memo name
    // is DISTINCT from the file placeholder so a served string can be attributed to exactly one source.
    const seedDb = ( { dbPath, memoName, lifecycleStates, revisionNos, questions } ) => {
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
        db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'WI-1', 'viewer', 'Weiche verdrahten', 'done', 'P6a' )
        lifecycleStates
            .forEach( ( state, index ) => {
                db.prepare( 'INSERT INTO lifecycle ( state, `at`, `by`, evidence ) VALUES ( ?, ?, ?, ? )' )
                    .run( state, '2026-08-20T0' + index + ':00:00Z', 'lead', 'seed-' + index )
            } )
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


    // Seed a memo folder. revFiles are the REV-NN.md files (each body carries a per-file marker so a
    // served string proves WHICH revision file was read). revExtraFiles are non-revision files placed
    // INSIDE revisions/ (e.g. HANDOVER.md) to prove the over-reach guard. When withDb, the DB memo name
    // is DISTINCT from the file placeholder.
    const seedMemo = ( { slug, withDb, lifecycleStates, revisionNos, questions, revFiles, revExtraFiles, corrupt } ) => {
        const memoDir = join( root, slug )
        const revDir = join( memoDir, 'revisions' )
        mkdirSync( revDir, { recursive: true } )

        const files = revFiles || [ 'REV-01.md' ]
        files
            .forEach( ( name ) => {
                writeFileSync( join( revDir, name ), '# ' + slug + '\n\n' + FILE_PLACEHOLDER + ' [' + name + ']\n' )
            } )
        ;( revExtraFiles || [] )
            .forEach( ( name ) => {
                writeFileSync( join( revDir, name ), '# ' + name + '\n\n' + OVERREACH_PLACEHOLDER + ' [' + name + ']\n' )
            } )

        if( corrupt === true ) {
            writeFileSync( resolve( memoDir, 'memo-079.db' ), 'this is NOT a database — FIX C corrupt seed\n' )
        } else if( withDb === true ) {
            seedDb( { dbPath: resolve( memoDir, 'memo-079.db' ), memoName: 'DB-ASSEMBLED ' + slug, lifecycleStates, revisionNos, questions } )
        }

        return { memoDir, revDir }
    }


    // Reproduce EXACTLY what MemoView.#loadRevisionSource does to pick the markdown source for a path.
    // (The MemoView method is private static — the identity of this reproduction to the production code
    // is separately asserted on MemoView.mjs source below, and driven end-to-end by the manual e2e.)
    const servedSource = async ( { absolutePath } ) => {
        const dir = dirname( absolutePath )
        const fileName = basename( absolutePath )
        const isRevisionFile = basename( dir ) === 'revisions' && /^REV-\d+\.md$/.test( fileName )

        if( isRevisionFile !== true ) {
            const raw = await readFile( absolutePath, 'utf-8' )

            return { raw, branch: 'file' }
        }

        const memoDir = dirname( dir )
        const { hasDb } = DoltDbAssembler.hasDb( { memoDir } )

        if( hasDb !== true ) {
            const raw = await readFile( absolutePath, 'utf-8' )

            return { raw, branch: 'file' }
        }

        try {
            const { dbPath } = DoltDbAssembler.resolveDbPath( { memoDir } )
            const requestedRevNo = Number( fileName.match( /^REV-(\d+)\.md$/ )[ 1 ] )
            const { latestRevNo, hasRevisionRows } = DoltDbAssembler.readLatestRevisionNo( { dbPath } )
            const serveHead = hasRevisionRows === true
                ? requestedRevNo === latestRevNo
                : existsSync( absolutePath ) !== true

            if( serveHead === true ) {
                const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

                return { raw: markdown, branch: 'db' }
            }

            const raw = await readFile( absolutePath, 'utf-8' )

            return { raw, branch: 'file' }
        } catch( error ) {
            const raw = await readFile( absolutePath, 'utf-8' )

            return { raw, branch: 'file-fallback' }
        }
    }


    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        root = mkdtempSync( join( repoTmpRoot, 'weiche-' ) )
    } )

    afterEach( () => {
        rmSync( root, { recursive: true, force: true } )
    } )


    describe( 'DoltDbAssembler.resolveDbPath', () => {
        it( 'resolves the memo-NNN.db path inside a memo folder', () => {
            const { memoDir } = seedMemo( { slug: '079-resolve', withDb: true, lifecycleStates: [ 'rollout' ], revisionNos: [ 1 ] } )

            const { dbPath } = DoltDbAssembler.resolveDbPath( { memoDir } )

            expect( basename( dbPath ) ).toBe( 'memo-079.db' )
            expect( dbPath ).toBe( resolve( memoDir, 'memo-079.db' ) )
        } )

        it( 'fails loud when the folder carries no per-memo db', () => {
            const { memoDir } = seedMemo( { slug: '079-nodb', withDb: false, lifecycleStates: [] } )

            expect( () => DoltDbAssembler.resolveDbPath( { memoDir } ) )
                .toThrow( /no memo-NNN\.db/ )
        } )

        it( 'fails loud on a missing folder and a missing argument', () => {
            expect( () => DoltDbAssembler.resolveDbPath( { memoDir: resolve( root, 'ghost' ) } ) )
                .toThrow( /does not exist/ )
            expect( () => DoltDbAssembler.resolveDbPath( {} ) )
                .toThrow( /"memoDir" is required/ )
        } )
    } )


    describe( 'DoltDbAssembler.readLifecycleState', () => {
        it( 'returns the LAST appended state (append-only, rowid DESC)', () => {
            const { memoDir } = seedMemo( { slug: '079-life', withDb: true, lifecycleStates: [ 'angelegt', 'in-revision', 'gelandet' ], revisionNos: [ 1 ] } )
            const { dbPath } = DoltDbAssembler.resolveDbPath( { memoDir } )

            expect( DoltDbAssembler.readLifecycleState( { dbPath } ).state ).toBe( 'gelandet' )
        } )

        it( 'returns state null when the lifecycle table is empty', () => {
            const { memoDir } = seedMemo( { slug: '079-life-empty', withDb: true, lifecycleStates: [], revisionNos: [ 1 ] } )
            const { dbPath } = DoltDbAssembler.resolveDbPath( { memoDir } )

            expect( DoltDbAssembler.readLifecycleState( { dbPath } ).state ).toBeNull()
        } )

        it( 'fails loud on a missing db path and a missing argument', () => {
            expect( () => DoltDbAssembler.readLifecycleState( { dbPath: resolve( root, 'nope.db' ) } ) )
                .toThrow( /does not exist/ )
            expect( () => DoltDbAssembler.readLifecycleState( {} ) )
                .toThrow( /"dbPath" is required/ )
        } )
    } )


    describe( 'served source decision — HEAD DB-assemble vs file (real DocumentRegistry state)', () => {
        it( 'serves the DB-assembled markdown for the HEAD revision of a DB-first memo, NOT the .md file', async () => {
            seedMemo( { slug: '079-served-db', withDb: true, lifecycleStates: [ 'rollout' ], revisionNos: [ 1 ] } )

            const { registry } = DocumentRegistry.create( {} )
            const { documentId } = await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-served-db', 'revisions' ) } )
            registry.selectRevision( { documentId, fileName: 'REV-01.md' } )
            const { absolutePath } = registry.getSelectedRevisionPath( { documentId } )

            const { raw, branch } = await servedSource( { absolutePath } )

            expect( branch ).toBe( 'db' )
            expect( raw ).toContain( '# DB-ASSEMBLED 079-served-db' )
            expect( raw ).toContain( 'Weiche verdrahten' )
            expect( raw ).not.toContain( FILE_PLACEHOLDER )
            registry.shutdown()
        } )

        it( 'serves the unchanged .md file for a legacy memo with no db', async () => {
            seedMemo( { slug: '079-served-file', withDb: false, lifecycleStates: [] } )

            const { registry } = DocumentRegistry.create( {} )
            const { documentId } = await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-served-file', 'revisions' ) } )
            registry.selectRevision( { documentId, fileName: 'REV-01.md' } )
            const { absolutePath } = registry.getSelectedRevisionPath( { documentId } )

            const { raw, branch } = await servedSource( { absolutePath } )

            expect( branch ).toBe( 'file' )
            expect( raw ).toContain( FILE_PLACEHOLDER )
            expect( raw ).not.toContain( 'DB-ASSEMBLED' )
            registry.shutdown()
        } )

        it( 'the HEAD DB-assembled source is byte-identical to a direct DoltDbAssembler.assembleFromDb', async () => {
            seedMemo( { slug: '079-served-identity', withDb: true, lifecycleStates: [ 'rollout' ], revisionNos: [ 1 ] } )

            const { registry } = DocumentRegistry.create( {} )
            const { documentId } = await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-served-identity', 'revisions' ) } )
            registry.selectRevision( { documentId, fileName: 'REV-01.md' } )
            const { absolutePath } = registry.getSelectedRevisionPath( { documentId } )

            const { raw } = await servedSource( { absolutePath } )
            const { dbPath } = DoltDbAssembler.resolveDbPath( { memoDir: join( root, '079-served-identity' ) } )
            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( raw ).toBe( markdown )
            registry.shutdown()
        } )
    } )


    // FIX A (Memo 079): revisions-identity + no over-reach. HEAD=rev-02; a REV-01 request must serve the
    // FROZEN REV-01 FILE (never the HEAD/rev-02 body); a REV-02 request serves the DB HEAD render; a
    // non-revision file (HANDOVER.md) in the same revisions/ folder serves its OWN file content.
    describe( 'FIX A — revisions-identity + no over-reach (HEAD=rev-02)', () => {
        const seedTwo = () => seedMemo( {
            slug: '079-two-revs',
            withDb: true,
            lifecycleStates: [ 'rollout' ],
            revisionNos: [ 1, 2 ],
            revFiles: [ 'REV-01.md', 'REV-02.md' ],
            revExtraFiles: [ 'HANDOVER.md' ]
        } )

        it( 'serves the FROZEN REV-01 FILE for the older revision, not the HEAD/rev-02 body', async () => {
            const { revDir } = seedTwo()

            const { raw, branch } = await servedSource( { absolutePath: join( revDir, 'REV-01.md' ) } )

            expect( branch ).toBe( 'file' )
            expect( raw ).toContain( FILE_PLACEHOLDER + ' [REV-01.md]' )
            expect( raw ).not.toContain( 'DB-ASSEMBLED' )
        } )

        it( 'serves the DB HEAD render for the newest revision REV-02', async () => {
            const { revDir } = seedTwo()

            const { raw, branch } = await servedSource( { absolutePath: join( revDir, 'REV-02.md' ) } )

            expect( branch ).toBe( 'db' )
            expect( raw ).toContain( '# DB-ASSEMBLED 079-two-revs' )
            expect( raw ).not.toContain( FILE_PLACEHOLDER )
        } )

        it( 'serves a non-revision file (HANDOVER.md in revisions/) verbatim — never DB-assembled', async () => {
            const { revDir } = seedTwo()

            const { raw, branch } = await servedSource( { absolutePath: join( revDir, 'HANDOVER.md' ) } )

            expect( branch ).toBe( 'file' )
            expect( raw ).toContain( OVERREACH_PLACEHOLDER + ' [HANDOVER.md]' )
            expect( raw ).not.toContain( 'DB-ASSEMBLED' )
        } )

        it( 'serves the frozen file for an old revision even when the db has no revision rows yet', async () => {
            // Early live stand: db present but the `revision` table is empty. An EXISTING REV file wins.
            const { revDir } = seedMemo( {
                slug: '079-early-stand',
                withDb: true,
                lifecycleStates: [ 'in-revision' ],
                revisionNos: [],
                revFiles: [ 'REV-01.md' ]
            } )

            const { raw, branch } = await servedSource( { absolutePath: join( revDir, 'REV-01.md' ) } )

            expect( branch ).toBe( 'file' )
            expect( raw ).toContain( FILE_PLACEHOLDER + ' [REV-01.md]' )
        } )
    } )


    // FIX C (Memo 079): a corrupt/empty db must NEVER make a memo unopenable — the serve decision
    // degrades to the frozen file. (The real console.warn on the serve path is covered by the manual
    // e2e; the real badge-path warn is covered by ViewerDbLifecycleBadgePRD021.)
    describe( 'FIX C — corrupt db degrades to the frozen file', () => {
        it( 'falls back to the .md file when the db cannot be opened/read', async () => {
            const { revDir } = seedMemo( { slug: '079-corrupt', corrupt: true, revFiles: [ 'REV-01.md' ] } )

            const { raw, branch } = await servedSource( { absolutePath: join( revDir, 'REV-01.md' ) } )

            expect( branch ).toBe( 'file-fallback' )
            expect( raw ).toContain( FILE_PLACEHOLDER + ' [REV-01.md]' )
        } )
    } )


    describe( 'MemoView.mjs wiring (private #readFileContent / #loadRevisionSource)', () => {
        let source = ''

        beforeAll( () => {
            const here = dirname( fileURLToPath( import.meta.url ) )
            source = readFileSync( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
        } )

        it( 'imports DoltDbAssembler', () => {
            expect( source ).toContain( "import { DoltDbAssembler } from './DoltDbAssembler.mjs'" )
        } )

        it( '#readFileContent delegates source selection to #loadRevisionSource', () => {
            expect( source ).toContain( 'await MemoView.#loadRevisionSource( { absolutePath, dir } )' )
        } )

        it( '#loadRevisionSource gates on a revisions/REV-NN.md path, routes HEAD via the DB, and falls back to readFile', () => {
            const open = source.indexOf( 'static async #loadRevisionSource(' )
            expect( open ).toBeGreaterThan( -1 )
            const region = source.slice( open, open + 3000 )

            // FIX A over-reach guard: only a revisions/REV-NN.md path enters the DB weiche.
            expect( region ).toContain( "basename( dir ) === 'revisions'" )
            expect( region ).toContain( '/^REV-\\d+\\.md$/' )
            // The DB weiche + HEAD gate.
            expect( region ).toContain( 'DoltDbAssembler.hasDb( { memoDir } )' )
            expect( region ).toContain( 'DoltDbAssembler.resolveDbPath( { memoDir } )' )
            expect( region ).toContain( 'DoltDbAssembler.readLatestRevisionNo( { dbPath } )' )
            expect( region ).toContain( 'DoltDbAssembler.assembleFromDb( { dbPath } )' )
            // The file path (older revision + fallback).
            expect( region ).toContain( "await readFile( absolutePath, 'utf-8' )" )
            // FIX C: a db error is caught and logged (no silent mask).
            expect( region ).toContain( 'console.warn(' )
        } )
    } )
} )
