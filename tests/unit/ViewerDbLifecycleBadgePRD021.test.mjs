import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-21 (Memo 079, P6a): the viewer badge takes its stage from the per-memo DB lifecycle table
// (last appended state), mapped onto the memoStatus badge axis — one status source, no third
// contradictory model. These tests drive the PUBLIC surface (getDocuments → memoStatus, the exact
// field the client badge renders) so they prove the observable behaviour, plus the mapping leaf and
// its fail-loud contract. Writes go ONLY into a repo-internal temp dir (.test-tmp/), never the real
// .memo/ and never the user home (~/.claude/CLAUDE.md § Test-Isolation).
describe( 'Viewer DB-first lifecycle badge (Memo 079, PRD-21)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let root = ''


    // Seed a memo folder: <memoDir>/memo-079.db (with a lifecycle table) + <memoDir>/revisions/REV-01.md
    // (the file whose frontmatter status the DB-first path MUST override). lifecycleStates is the ordered
    // list of appended states (empty = a fresh db with no lifecycle event yet). frontmatterStatus is the
    // Status-row written into the REV file so the test can prove the DB wins over the file parse.
    const seedMemo = ( { slug, lifecycleStates, frontmatterStatus, withDb, questions, corrupt } ) => {
        const memoDir = join( root, slug )
        const revDir = join( memoDir, 'revisions' )
        mkdirSync( revDir, { recursive: true } )

        const revBody = [
            '# ' + slug,
            '',
            '| Feld | Wert |',
            '| --- | --- |',
            '| **Status** | ' + frontmatterStatus + ' |',
            '',
            '## Offene Fragen',
            '',
            '### F1 — Platzhalter',
            '',
            '**Frage:** Platzhalter?',
            '',
            'A) eins',
            'B) zwei'
        ].join( '\n' )
        writeFileSync( join( revDir, 'REV-01.md' ), revBody )

        if( corrupt === true ) {
            writeFileSync( resolve( memoDir, 'memo-079.db' ), 'this is NOT a database — FIX C corrupt seed\n' )
        } else if( withDb === true ) {
            const dbPath = resolve( memoDir, 'memo-079.db' )
            const db = new DatabaseSync( dbPath )
            db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS lifecycle ( state TEXT, `at` TEXT, `by` TEXT, evidence TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT )' )
            db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at ) VALUES ( ?, ?, ?, ?, ? )' )
                .run( 'M079', slug, 'Implementation', 'in-progress', '2026-08-20T00:00:00Z' )
            lifecycleStates
                .forEach( ( state, index ) => {
                    db.prepare( 'INSERT INTO lifecycle ( state, `at`, `by`, evidence ) VALUES ( ?, ?, ?, ? )' )
                        .run( state, '2026-08-20T0' + index + ':00:00Z', 'lead', 'seed-' + index )
                } )
            ;( questions || [] )
                .forEach( ( q ) => {
                    db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' )
                        .run( q.id, 'M079', q.text, q.kind, q.status )
                } )
            db.close()
        }

        return { memoDir, revDir }
    }


    const memoStatusOf = ( { registry, memoName } ) => {
        const { documents } = registry.getDocuments()
        const doc = documents
            .find( ( entry ) => entry[ 'memoName' ] === memoName )

        return doc === undefined ? null : doc[ 'memoStatus' ]
    }


    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        root = mkdtempSync( join( repoTmpRoot, 'badge-' ) )
    } )

    afterEach( () => {
        rmSync( root, { recursive: true, force: true } )
    } )


    describe( 'mapLifecycleStateToMemoStatus (the explicit 10→badge mapping)', () => {
        it( 'maps the pre-finalize states', () => {
            expect( DocumentRegistry.mapLifecycleStateToMemoStatus( { state: 'angelegt' } ).memoStatus ).toBe( 'Entwurf' )
            expect( DocumentRegistry.mapLifecycleStateToMemoStatus( { state: 'in-revision' } ).memoStatus ).toBe( 'In Bearbeitung' )
        } )

        it( 'maps the finalized + rollout-progression states to Finalisiert (content frozen, not yet pushed)', () => {
            const finalized = [ 'finalisiert-research', 'finalisiert-implementation', 'rollout', 'pausiert', 'gelandet', 'gemerged' ]
            finalized
                .forEach( ( state ) => {
                    expect( DocumentRegistry.mapLifecycleStateToMemoStatus( { state } ).memoStatus ).toBe( 'Finalisiert' )
                } )
        } )

        it( 'maps the terminal end states to Abgeschlossen', () => {
            expect( DocumentRegistry.mapLifecycleStateToMemoStatus( { state: 'abgeschlossen' } ).memoStatus ).toBe( 'Abgeschlossen' )
            expect( DocumentRegistry.mapLifecycleStateToMemoStatus( { state: 'abgebrochen' } ).memoStatus ).toBe( 'Abgeschlossen' )
        } )

        it( 'fails loud on an unknown lifecycle state (NO SILENT DEFAULTS)', () => {
            expect( () => DocumentRegistry.mapLifecycleStateToMemoStatus( { state: 'not-a-state' } ) )
                .toThrow( /unknown lifecycle state/ )
        } )
    } )


    describe( 'badge source for a DB-first memo (getDocuments → memoStatus)', () => {
        it( 'derives the badge from the DB lifecycle (last state), OVERRIDING the .md frontmatter', async () => {
            // Frontmatter says Entwurf, but the DB lifecycle last state is rollout → badge Finalisiert.
            seedMemo( { slug: '079-db-rollout', lifecycleStates: [ 'angelegt', 'in-revision', 'rollout' ], frontmatterStatus: 'Entwurf', withDb: true } )

            const { registry } = DocumentRegistry.create( {} )
            await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-db-rollout', 'revisions' ) } )

            expect( memoStatusOf( { registry, memoName: '079-db-rollout' } ) ).toBe( 'Finalisiert' )
            registry.shutdown()
        } )

        it( 'reflects an in-revision DB memo as In Bearbeitung', async () => {
            seedMemo( { slug: '079-db-rev', lifecycleStates: [ 'angelegt', 'in-revision' ], frontmatterStatus: 'Entwurf', withDb: true } )

            const { registry } = DocumentRegistry.create( {} )
            await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-db-rev', 'revisions' ) } )

            expect( memoStatusOf( { registry, memoName: '079-db-rev' } ) ).toBe( 'In Bearbeitung' )
            registry.shutdown()
        } )

        it( 'reflects a pushed DB memo as Abgeschlossen', async () => {
            seedMemo( { slug: '079-db-done', lifecycleStates: [ 'gemerged', 'abgeschlossen' ], frontmatterStatus: 'Finalisiert', withDb: true } )

            const { registry } = DocumentRegistry.create( {} )
            await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-db-done', 'revisions' ) } )

            expect( memoStatusOf( { registry, memoName: '079-db-done' } ) ).toBe( 'Abgeschlossen' )
            registry.shutdown()
        } )

        it( 'falls back to the default draft badge when the DB carries no lifecycle event yet', async () => {
            seedMemo( { slug: '079-db-empty', lifecycleStates: [], frontmatterStatus: 'Finalisiert', withDb: true } )

            const { registry } = DocumentRegistry.create( {} )
            await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-db-empty', 'revisions' ) } )

            // DB-first (isDb) but no state yet → default 'Entwurf', NOT the frontmatter 'Finalisiert'
            // (no invented advanced stage, but also not the file parse).
            expect( memoStatusOf( { registry, memoName: '079-db-empty' } ) ).toBe( 'Entwurf' )
            registry.shutdown()
        } )
    } )


    describe( 'legacy (file) memo keeps the frontmatter parse (Zwei-Regime, 383 Bestand)', () => {
        it( 'reads memoStatus from the .md frontmatter when NO per-memo db is present', async () => {
            seedMemo( { slug: '079-file-only', lifecycleStates: [], frontmatterStatus: 'Finalisiert', withDb: false } )

            const { registry } = DocumentRegistry.create( {} )
            await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-file-only', 'revisions' ) } )

            // No db → unchanged file parse → the frontmatter 'Finalisiert' wins.
            expect( memoStatusOf( { registry, memoName: '079-file-only' } ) ).toBe( 'Finalisiert' )
            registry.shutdown()
        } )
    } )


    // FIX B (Memo 079): a DB-first memo takes its OPEN-questions count from the db `question` table,
    // NOT the .md parse. The seeded REV file carries exactly ONE open `### F1` block, so a DB count of
    // TWO proves the DB source wins over the file parse (one source, no Doppelpfad).
    describe( 'FIX B — question count from the DB for a DB-first memo', () => {
        const questionsOf = ( { registry, memoName } ) => {
            const { documents } = registry.getDocuments()
            const doc = documents
                .find( ( entry ) => entry[ 'memoName' ] === memoName )

            return doc === undefined ? null : doc[ 'questions' ]
        }

        it( 'derives open=2 from the DB question table, overriding the single file question', async () => {
            seedMemo( {
                slug: '079-db-questions',
                lifecycleStates: [ 'rollout' ],
                frontmatterStatus: 'Entwurf',
                withDb: true,
                questions: [
                    { id: 'F1', text: 'Soll X passieren?', kind: 'info', status: 'open' },
                    { id: 'F2', text: 'Wie geht Y?', kind: 'blocker', status: 'open' },
                    { id: 'F3', text: 'Schon geklaert', kind: 'info', status: 'answered' }
                ]
            } )

            const { registry } = DocumentRegistry.create( {} )
            await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-db-questions', 'revisions' ) } )

            expect( questionsOf( { registry, memoName: '079-db-questions' } ) ).toEqual( { open: 2, answered: 1 } )
            registry.shutdown()
        } )

        it( 'reports open=0 for a DB memo whose question table is empty', async () => {
            seedMemo( { slug: '079-db-noq', lifecycleStates: [ 'rollout' ], frontmatterStatus: 'Entwurf', withDb: true, questions: [] } )

            const { registry } = DocumentRegistry.create( {} )
            await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-db-noq', 'revisions' ) } )

            expect( questionsOf( { registry, memoName: '079-db-noq' } ) ).toEqual( { open: 0, answered: 0 } )
            registry.shutdown()
        } )
    } )


    // FIX C (Memo 079): a corrupt/unreadable memo-NNN.db must NEVER make the memo fail to load. The
    // badge derivation degrades to the default draft badge AND logs a warning (no silent mask). This
    // drives the REAL DocumentRegistry.#deriveDbMemoStatus path (via getDocuments/addDocument).
    describe( 'FIX C — corrupt db keeps the memo openable + logs a warning', () => {
        it( 'loads the memo with the default badge and logs one warning', async () => {
            const warnSpy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} )

            seedMemo( { slug: '079-corrupt-badge', lifecycleStates: [], frontmatterStatus: 'Finalisiert', corrupt: true } )

            const { registry } = DocumentRegistry.create( {} )
            await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '079-corrupt-badge', 'revisions' ) } )

            const { documents } = registry.getDocuments()
            const doc = documents
                .find( ( entry ) => entry[ 'memoName' ] === '079-corrupt-badge' )

            // The memo is present (openable) and shows the safe default badge, not a crash.
            expect( doc ).not.toBeUndefined()
            expect( doc[ 'memoStatus' ] ).toBe( 'Entwurf' )
            // The degrade is logged (belt: warn was called, no silent mask).
            expect( warnSpy.mock.calls.some( ( args ) => String( args[ 0 ] ).includes( 'badge derivation failed' ) ) ).toBe( true )

            registry.shutdown()
            warnSpy.mockRestore()
        } )
    } )
} )
