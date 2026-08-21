import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { DatabaseSync } from '@dolthub/doltlite'

import { DoltDbAssembler } from './DoltDbAssembler.mjs'
import { DocumentRegistry } from './DocumentRegistry.mjs'
import { isRenderable } from './QuestionContract.mjs'


// P6a (Memo 079): the viewer's DB-schaufenster renders a per-memo `memo-NNN.db` into the SAME
// deterministic Markdown body that the core RevisionAssembler freezes. Tests write ONLY into a
// repo-internal temp directory (.test-tmp/), NEVER the real .memo/ and NEVER the user home
// (~/.claude/CLAUDE.md § Test-Isolation).
describe( 'DoltDbAssembler — P6a DB-schaufenster (Memo 079)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let memoDir = ''
    let dbPath = ''


    // Seed a per-memo memo-079.db with the full set of tables the render touches (mirroring the real
    // DoltSchema, which always creates all tables). Returns nothing — writes the DB file to disk.
    const seedDb = ( { path } ) => {
        const db = new DatabaseSync( path )
        db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_diagrams ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT )' )

        db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'M079', 'Datenbank-Traceability', 'Strategie', 'finalized', '2026-08-20T00:00:00Z' )

        db.prepare( 'INSERT INTO block ( id, title, sort ) VALUES ( ?, ?, ? )' )
            .run( 'B001', 'Erster Block', 1 )
        db.prepare( 'INSERT INTO block ( id, title, sort ) VALUES ( ?, ?, ? )' )
            .run( 'B002', 'Zweiter Block', 2 )

        db.prepare( 'INSERT INTO block_tables ( id, block_id, title, tsv ) VALUES ( ?, ?, ?, ? )' )
            .run( 'T1', 'B001', 'Kennzahlen', 'metric\tvalue\nlatency\t42' )

        db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'WI-1', 'traceability', 'Assembler bauen', 'done', 'P6a' )
        db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'WI-2', 'viewer', 'Weiche verdrahten', 'open', 'P6a' )

        db.close()
    }


    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        memoDir = mkdtempSync( join( repoTmpRoot, 'memo-079-' ) )
        dbPath = resolve( memoDir, 'memo-079.db' )
    } )

    afterEach( () => {
        rmSync( memoDir, { recursive: true, force: true } )
    } )


    describe( 'assembleFromDb', () => {
        it( 'renders the header from the memo row', () => {
            seedDb( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toContain( '# Datenbank-Traceability' )
            expect( markdown ).toContain( '- ID: M079' )
            expect( markdown ).toContain( '- Type: Strategie' )
            expect( markdown ).toContain( '- Status: finalized' )
        } )

        it( 'renders block titles ORDER BY sort with their ids', () => {
            seedDb( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toContain( '## Blocks' )
            expect( markdown ).toContain( '### Erster Block (B001)' )
            expect( markdown ).toContain( '### Zweiter Block (B002)' )
            // sort ascending: B001 (sort 1) appears before B002 (sort 2).
            expect( markdown.indexOf( '(B001)' ) ).toBeLessThan( markdown.indexOf( '(B002)' ) )
        } )

        it( 'renders block_tables as a tsv fence with the row data', () => {
            seedDb( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toContain( '#### Kennzahlen' )
            expect( markdown ).toContain( '```tsv' )
            expect( markdown ).toContain( 'metric\tvalue' )
            expect( markdown ).toContain( 'latency\t42' )
        } )

        it( 'renders the work_item table with one row per item', () => {
            seedDb( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toContain( '## Work Items' )
            expect( markdown ).toContain( '| ID | Topic | Title | Status | Group |' )
            expect( markdown ).toContain( '| WI-1 | traceability | Assembler bauen | done | P6a |' )
            expect( markdown ).toContain( '| WI-2 | viewer | Weiche verdrahten | open | P6a |' )
        } )

        it( 'renders a block_diagram as a mermaid fence', () => {
            seedDb( { path: dbPath } )
            const db = new DatabaseSync( dbPath )
            db.prepare( 'INSERT INTO block_diagrams ( id, block_id, title, kind, `source`, feed ) VALUES ( ?, ?, ?, ?, ?, ? )' )
                .run( 'D1', 'B001', 'Fluss', 'mermaid', 'graph TD\n  A --> B', null )
            db.close()

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toContain( '#### Fluss' )
            expect( markdown ).toContain( '```mermaid' )
            expect( markdown ).toContain( 'graph TD' )
            expect( markdown ).toContain( '  A --> B' )
        } )

        it( 'fails loud when dbPath is missing', () => {
            expect( () => DoltDbAssembler.assembleFromDb( {} ) )
                .toThrow( /"dbPath" is required/ )
        } )

        it( 'fails loud when the database file does not exist', () => {
            const ghost = resolve( memoDir, 'memo-999.db' )

            expect( () => DoltDbAssembler.assembleFromDb( { dbPath: ghost } ) )
                .toThrow( /does not exist/ )
        } )
    } )


    describe( 'hasDb (Zwei-Regime weiche)', () => {
        it( 'returns true when a memo-NNN.db exists', () => {
            seedDb( { path: dbPath } )

            const { hasDb } = DoltDbAssembler.hasDb( { memoDir } )

            expect( hasDb ).toBe( true )
        } )

        it( 'returns false when no per-memo database is present', () => {
            const { hasDb } = DoltDbAssembler.hasDb( { memoDir } )

            expect( hasDb ).toBe( false )
        } )

        it( 'returns false when the directory does not exist', () => {
            const { hasDb } = DoltDbAssembler.hasDb( { memoDir: resolve( memoDir, 'nope' ) } )

            expect( hasDb ).toBe( false )
        } )

        it( 'fails loud when memoDir is missing', () => {
            expect( () => DoltDbAssembler.hasDb( {} ) )
                .toThrow( /"memoDir" is required/ )
        } )
    } )


    // Memo 079 FIX A: the read-only Tag-Grenze leaf. Only the newest (== HEAD) revision may be
    // DB-assembled; the serve weiche uses this to route older revisions to their frozen file.
    describe( 'readLatestRevisionNo (Memo 079 FIX A)', () => {
        it( 'returns hasRevisionRows:false when the db has no revision table (early live stand)', () => {
            seedDb( { path: dbPath } )

            const { latestRevNo, hasRevisionRows } = DoltDbAssembler.readLatestRevisionNo( { dbPath } )

            expect( hasRevisionRows ).toBe( false )
            expect( latestRevNo ).toBeNull()
        } )

        it( 'returns the newest rev_no when revision rows are present', () => {
            seedDb( { path: dbPath } )
            const db = new DatabaseSync( dbPath )
            db.exec( 'CREATE TABLE IF NOT EXISTS revision ( rev_no INTEGER PRIMARY KEY, md_sha256 TEXT, md_path TEXT, dolt_commit TEXT, tag TEXT, created_at TEXT )' )
            db.prepare( 'INSERT INTO revision ( rev_no, md_sha256 ) VALUES ( ?, ? )' ).run( 1, 'a' )
            db.prepare( 'INSERT INTO revision ( rev_no, md_sha256 ) VALUES ( ?, ? )' ).run( 3, 'c' )
            db.prepare( 'INSERT INTO revision ( rev_no, md_sha256 ) VALUES ( ?, ? )' ).run( 2, 'b' )
            db.close()

            const { latestRevNo, hasRevisionRows } = DoltDbAssembler.readLatestRevisionNo( { dbPath } )

            expect( hasRevisionRows ).toBe( true )
            expect( latestRevNo ).toBe( 3 )
        } )

        it( 'returns hasRevisionRows:false for a present-but-empty revision table', () => {
            seedDb( { path: dbPath } )
            const db = new DatabaseSync( dbPath )
            db.exec( 'CREATE TABLE IF NOT EXISTS revision ( rev_no INTEGER PRIMARY KEY, md_sha256 TEXT, md_path TEXT, dolt_commit TEXT, tag TEXT, created_at TEXT )' )
            db.close()

            const { latestRevNo, hasRevisionRows } = DoltDbAssembler.readLatestRevisionNo( { dbPath } )

            expect( hasRevisionRows ).toBe( false )
            expect( latestRevNo ).toBeNull()
        } )

        it( 'fails loud on a missing db path and a missing argument', () => {
            expect( () => DoltDbAssembler.readLatestRevisionNo( { dbPath: resolve( memoDir, 'nope.db' ) } ) )
                .toThrow( /does not exist/ )
            expect( () => DoltDbAssembler.readLatestRevisionNo( {} ) )
                .toThrow( /"dbPath" is required/ )
        } )
    } )


    // Memo 079 FIX B: the DocumentRegistry question count for DB memos reads this leaf (one source).
    describe( 'readOpenQuestionCounts (Memo 079 FIX B)', () => {
        it( 'returns { open:0, answered:0 } when the db has no question table', () => {
            seedDb( { path: dbPath } )

            expect( DoltDbAssembler.readOpenQuestionCounts( { dbPath } ) ).toEqual( { open: 0, answered: 0 } )
        } )

        it( 'counts open vs answered rows from the question table', () => {
            seedDb( { path: dbPath } )
            const db = new DatabaseSync( dbPath )
            db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT )' )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'F1', 'M079', 'Soll X?', 'info', 'open' )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'F2', 'M079', 'Wie Y?', 'blocker', 'open' )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'F3', 'M079', 'Alt?', 'info', 'answered' )
            db.close()

            expect( DoltDbAssembler.readOpenQuestionCounts( { dbPath } ) ).toEqual( { open: 2, answered: 1 } )
        } )

        it( 'fails loud on a missing db path and a missing argument', () => {
            expect( () => DoltDbAssembler.readOpenQuestionCounts( { dbPath: resolve( memoDir, 'nope.db' ) } ) )
                .toThrow( /does not exist/ )
            expect( () => DoltDbAssembler.readOpenQuestionCounts( {} ) )
                .toThrow( /"dbPath" is required/ )
        } )
    } )


    // Memo 079 PRD-22 #4: the answer-record source. A widget OR terminal answer writes the SAME
    // `user_input_answers` row (question_id "F<N>") via the single-writer; the viewer reads it back to
    // clear the terminal-answer Karteileiche (forensics b5). These seed the question + user_input_answers
    // tables ad-hoc (the DoltSchema always creates all tables; seedDb here omits them for the base case).
    const seedQuestions = ( { path, questions } ) => {
        const db = new DatabaseSync( path )
        db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT )' )
        questions
            .forEach( ( q ) => {
                db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' )
                    .run( q.id, 'M079', q.text || q.id, q.kind || 'info', q.status )
            } )
        db.close()
    }


    const seedAnswers = ( { path, answers } ) => {
        const db = new DatabaseSync( path )
        db.exec( 'CREATE TABLE IF NOT EXISTS user_input_answers ( input_id TEXT, question_id TEXT, option_key TEXT, answer_verbatim TEXT, preselected INTEGER )' )
        answers
            .forEach( ( a ) => {
                db.prepare( 'INSERT INTO user_input_answers ( input_id, question_id, option_key, answer_verbatim, preselected ) VALUES ( ?, ?, ?, ?, ? )' )
                    .run( a.inputId || 'UI-0001', a.questionId, a.optionKey || null, a.answer || 'geantwortet', 0 )
            } )
        db.close()
    }


    describe( 'readAnswerRecords (Memo 079 PRD-22 #4)', () => {
        it( 'returns an empty set when the db has no user_input_answers table', () => {
            seedDb( { path: dbPath } )

            expect( DoltDbAssembler.readAnswerRecords( { dbPath } ) ).toEqual( { answeredQuestionIds: [] } )
        } )

        it( 'returns the DISTINCT normalized answered question ids (dedup + upper-case)', () => {
            seedDb( { path: dbPath } )
            seedAnswers( { path: dbPath, answers: [
                { questionId: 'F1' },
                { questionId: 'f1', inputId: 'UI-0002' },
                { questionId: ' F2 ' },
                { questionId: '' }
            ] } )

            const { answeredQuestionIds } = DoltDbAssembler.readAnswerRecords( { dbPath } )

            expect( answeredQuestionIds.sort() ).toEqual( [ 'F1', 'F2' ] )
        } )

        it( 'fails loud on a missing db path and a missing argument', () => {
            expect( () => DoltDbAssembler.readAnswerRecords( { dbPath: resolve( memoDir, 'nope.db' ) } ) )
                .toThrow( /does not exist/ )
            expect( () => DoltDbAssembler.readAnswerRecords( {} ) )
                .toThrow( /"dbPath" is required/ )
        } )
    } )


    describe( 'readQuestionAnswerState (Memo 079 PRD-22 #4 — additive-dedup)', () => {
        it( 'returns all-zero / allAnswered:false when the db has no question table', () => {
            seedDb( { path: dbPath } )

            expect( DoltDbAssembler.readQuestionAnswerState( { dbPath } ) )
                .toEqual( { open: 0, answered: 0, total: 0, allAnswered: false } )
        } )

        it( 'without any answer record it mirrors the status-based counts (no behavior change)', () => {
            seedDb( { path: dbPath } )
            seedQuestions( { path: dbPath, questions: [
                { id: 'F1', status: 'open' },
                { id: 'F2', status: 'open' },
                { id: 'F3', status: 'answered' }
            ] } )

            expect( DoltDbAssembler.readQuestionAnswerState( { dbPath } ) )
                .toEqual( { open: 2, answered: 1, total: 3, allAnswered: false } )
        } )

        it( 'folds answer records onto OPEN questions — all open questions covered => allAnswered', () => {
            seedDb( { path: dbPath } )
            seedQuestions( { path: dbPath, questions: [
                { id: 'F1', status: 'open' },
                { id: 'F2', status: 'open' }
            ] } )
            seedAnswers( { path: dbPath, answers: [ { questionId: 'F1' }, { questionId: 'F2' } ] } )

            expect( DoltDbAssembler.readQuestionAnswerState( { dbPath } ) )
                .toEqual( { open: 0, answered: 2, total: 2, allAnswered: true } )
        } )

        it( 'is additive+deduped: a record for an already-answered question does NOT double-count, a record for an open question clears it', () => {
            seedDb( { path: dbPath } )
            seedQuestions( { path: dbPath, questions: [
                { id: 'F1', status: 'open' },
                { id: 'F2', status: 'open' },
                { id: 'F3', status: 'answered' }
            ] } )
            // F1 (open) gets a record -> cleared; F3 (already answered) gets a record -> no double-count;
            // F2 stays honestly open (no record).
            seedAnswers( { path: dbPath, answers: [ { questionId: 'F1' }, { questionId: 'F3' } ] } )

            expect( DoltDbAssembler.readQuestionAnswerState( { dbPath } ) )
                .toEqual( { open: 1, answered: 2, total: 3, allAnswered: false } )
        } )

        it( 'fails loud on a missing db path and a missing argument', () => {
            expect( () => DoltDbAssembler.readQuestionAnswerState( { dbPath: resolve( memoDir, 'nope.db' ) } ) )
                .toThrow( /does not exist/ )
            expect( () => DoltDbAssembler.readQuestionAnswerState( {} ) )
                .toThrow( /"dbPath" is required/ )
        } )
    } )


    // Memo 079 FIX B: the assembled body carries an `## Offene Fragen` section from the question table.
    describe( 'Offene Fragen section (Memo 079 FIX B)', () => {
        it( 'renders "keine" when the db has no question table', () => {
            seedDb( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toContain( '## Offene Fragen' )
            expect( markdown ).toMatch( /## Offene Fragen\n\nkeine/ )
        } )

        it( 'renders one line per OPEN question (answered rows excluded)', () => {
            seedDb( { path: dbPath } )
            const db = new DatabaseSync( dbPath )
            db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT )' )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'F1', 'M079', 'Soll X passieren?', 'info', 'open' )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'F2', 'M079', 'Wie geht Y?', 'blocker', 'open' )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'F3', 'M079', 'Schon geklaert', 'info', 'answered' )
            db.close()

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toContain( '## Offene Fragen' )
            expect( markdown ).toContain( '- **F1** (info): Soll X passieren?' )
            expect( markdown ).toContain( '- **F2** (blocker): Wie geht Y?' )
            // the answered F3 is excluded from the OPEN list — scoped to the `## Offene Fragen` section, since
            // the broad build-out now ALSO emits every question (open + answered) in the `## Fragen` json fence.
            const openSection = markdown.split( '## Offene Fragen' )[ 1 ]
            expect( openSection ).not.toContain( 'Schon geklaert' )
        } )
    } )


    // Broad build-out (Memo 079, PRD-16) + NIEDRIG-1 cross-repo parity gate: the viewer render emits the
    // FULL section set (Kontext, Topics, Phasen, Fragen json fence, Offene Fragen), byte-identical to the
    // core RevisionAssembler. The golden is NO LONGER a hand-copied literal (which let a one-sided renderer
    // edit drift silently) — it is the SAME hash-manifested fixture the core repo owns, VENDORED byte-identically
    // into tests/fixtures/revision-body-v1/ (PRD-30 mechanism: single-source enforced by a hash-gated fixture,
    // not a cross-repo import the worktree boundary forbids). This test asserts (a) viewer render === fixture
    // AND (b) sha256(fixture) === manifest.sha256, so a one-sided edit of EITHER the viewer renderer OR the
    // fixture fails HERE. Regenerate both repo copies together after any intentional render change.
    describe( 'full render + cross-repo byte-parity (Memo 079 PRD-16)', () => {
        const FIXTURE_DIR = resolve( process.cwd(), 'tests', 'fixtures', 'revision-body-v1' )
        const GOLDEN_FULL_BODY = readFileSync( resolve( FIXTURE_DIR, 'full-body.md' ), 'utf8' )
        const GOLDEN_MANIFEST = JSON.parse( readFileSync( resolve( FIXTURE_DIR, 'manifest.json' ), 'utf8' ) )


        // Seed a memo-079.db whose rows are IDENTICAL to the core seedCanonical fixture (memo+context, work
        // items, one block with a table + fed mermaid diagram, a topic register, a normalized rollout phase
        // incl. the excluded `__state__` sentinel, and a mixed open/answered question set).
        const seedFullCanonical = ( { path } ) => {
            const db = new DatabaseSync( path )
            db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT, context TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block_diagrams ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT, origin TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, depends_on TEXT, can_parallel_with TEXT, commit_hash TEXT, spillover TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, commit_hash TEXT, depends_on TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT, title TEXT, background TEXT, typ TEXT, ai_recommendation TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS question_option ( question_id TEXT, opt_key TEXT, label TEXT, kind TEXT, sort INTEGER )' )

            db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at, context ) VALUES ( ?, ?, ?, ?, ?, ? )' )
                .run( 'M079', 'DB Traceability', 'strategy', 'finalized', '2026-08-20T00:00:00.000Z', 'Kontext Zeile eins.\nKontext Zeile zwei.' )
            db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'WI-02', 'assemble', 'render from DB', 'open', 'B' )
            db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'WI-01', 'store', 'adapter', 'done', 'A' )
            db.prepare( 'INSERT INTO block ( id, title, sort ) VALUES ( ?, ?, ? )' ).run( 'B001', 'Backbone', 1 )
            db.prepare( 'INSERT INTO block_tables ( id, block_id, title, tsv ) VALUES ( ?, ?, ?, ? )' ).run( 'BT001', 'B001', 'Primitives', 'name\tstatus\ncommit\tok' )
            db.prepare( 'INSERT INTO block_diagrams ( id, block_id, title, kind, `source`, feed ) VALUES ( ?, ?, ?, ?, ?, ? )' )
                .run( 'M1', 'B001', 'Flow', 'mermaid', 'graph TD{{#rows}}\n  {{name}} --> {{status}}{{/rows}}', 'BT001' )
            db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block, origin ) VALUES ( ?, ?, ?, ?, ?, ? )' ).run( 'T01', 'M079', 'DB als SoT', 'P1', 'B001', 'init' )
            db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block, origin ) VALUES ( ?, ?, ?, ?, ?, ? )' ).run( 'T02', 'M079', 'Traceability', 'P2', null, null )
            db.prepare( 'INSERT INTO rollout_phase ( id, memo_id, name, status, depends_on, can_parallel_with, commit_hash, spillover ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ? )' )
                .run( '__state__', 'M079', null, null, null, null, null, '{"memo":"M079","branch":"MEMO-079"}' )
            db.prepare( 'INSERT INTO rollout_phase ( id, memo_id, name, status, depends_on, can_parallel_with, commit_hash, spillover ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ? )' )
                .run( 'P1', 'M079', 'Backbone', 'done', null, null, null, '{"__ord":0}' )
            db.prepare( 'INSERT INTO rollout_work_item ( id, phase_id, title, status, commit_hash, depends_on, target, wi_type, spillover ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ? )' )
                .run( 'PRD-01', 'P1', 'adapter', 'done', null, null, 'core', 'code', '{"__ord":0}' )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status, title, background, typ, ai_recommendation ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ? )' )
                .run( 'F1', 'M079', 'Soll die DB die SoT sein?', 'info', 'open', 'DB als Source of Truth', 'Kap 5: die Datenbank traegt die Wahrheit.', 'single', 'A' )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status, title, background, typ, ai_recommendation ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ? )' )
                .run( 'F2', 'M079', 'Wie werden Phasen normalisiert?', 'info', 'answered', 'Phasen-Normalisierung', 'Rollout-State liegt normalisiert in der DB.', 'single', 'A' )
            const insertOption = db.prepare( 'INSERT INTO question_option ( question_id, opt_key, label, kind, sort ) VALUES ( ?, ?, ?, ?, ? )' )
            insertOption.run( 'F1', 'A', 'Ja — die DB ist die SoT', 'option', 0 )
            insertOption.run( 'F1', 'B', 'Nein — die Files bleiben SoT', 'option', 1 )
            insertOption.run( 'F2', 'A', 'Aus rollout/state.json projizieren', 'option', 0 )
            insertOption.run( 'F2', 'B', 'Manuell in der DB pflegen', 'option', 1 )
            db.close()
        }


        it( 'renders the full section set byte-identical to the core assembler golden', () => {
            seedFullCanonical( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toBe( GOLDEN_FULL_BODY )

            // hand-edit guard: the vendored fixture must hash to the recorded manifest sha256 (same value the
            // core repo records), so a doctored golden that would silently satisfy the equality is caught.
            const fixtureSha = createHash( 'sha256' ).update( GOLDEN_FULL_BODY, 'utf8' ).digest( 'hex' )
            expect( fixtureSha ).toBe( GOLDEN_MANIFEST[ 'sha256' ] )
            expect( Buffer.byteLength( GOLDEN_FULL_BODY, 'utf8' ) ).toBe( GOLDEN_MANIFEST[ 'byteLength' ] )
        } )

        it( 'reads the memo context via PRAGMA — a memo table WITHOUT a context column degrades to _kein Kontext_', () => {
            // the base seedDb() creates the memo table WITHOUT the context column (an early hand-seeded db).
            seedDb( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toContain( '## Kontext\n\n_kein Kontext_' )
        } )

        it( 'a db missing the topic/phase/question tables renders the same empty sentinels as an empty table', () => {
            // seedDb() omits topic/rollout_phase/question entirely — the #tableExists guards degrade each to [].
            seedDb( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toContain( '## Topics\n\n_no topics_' )
            expect( markdown ).toContain( '## Phasen\n\n_no phases_' )
            expect( markdown ).toContain( '## Fragen\n\n```questions-json\n[]\n```' )
            expect( markdown ).toContain( '## Offene Fragen\n\nkeine' )
        } )
    } )


    // Slice-2a (Memo 079, Kap 9): the WHOLE POINT of re-emitting the full canonical fence is that the
    // DB-served questions widget is ANSWERABLE — the assembled `## Fragen` fence, fed through the SAME parse
    // path the file regime uses (DocumentRegistry.parseQuestionJsonBlock → #normalizeJsonQuestion), yields a
    // question the render contract accepts as an interactive card (QuestionContract.isRenderable === true).
    // Before this slice the fence carried only id/frage/kind so isRenderable was FALSE (< 2 real options) and
    // the widget fell back to raw text. These tests seed a per-memo db, assemble the body from the DB rows,
    // and prove renderability off the DB-first fence exactly as the file regime would off the same source.
    describe( 'answerable DB-first widget (Slice-2a, QuestionContract.isRenderable)', () => {
        // Seed one memo-079.db with a single answerable question (F1: 2 real options + aiRecommendation),
        // mirroring the widened schema `memo new` applies.
        const seedAnswerable = ( { path } ) => {
            const db = new DatabaseSync( path )
            db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT, context TEXT )' )
            // the tracer tables #renderBody reads unconditionally (empty here — this test targets the fence only).
            db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block_diagrams ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT, title TEXT, background TEXT, typ TEXT, ai_recommendation TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS question_option ( question_id TEXT, opt_key TEXT, label TEXT, kind TEXT, sort INTEGER )' )

            db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at, context ) VALUES ( ?, ?, ?, ?, ?, ? )' )
                .run( 'M079', 'DB Traceability', 'strategy', 'draft', '2026-08-20T00:00:00.000Z', null )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status, title, background, typ, ai_recommendation ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ? )' )
                .run( 'F1', 'M079', 'Soll die DB die SoT sein?', 'blocker', 'open', 'DB als Source of Truth', 'Kap 5.', 'single', 'A' )
            const insertOption = db.prepare( 'INSERT INTO question_option ( question_id, opt_key, label, kind, sort ) VALUES ( ?, ?, ?, ?, ? )' )
            insertOption.run( 'F1', 'A', 'Ja — die DB ist die SoT', 'option', 0 )
            insertOption.run( 'F1', 'B', 'Nein — die Files bleiben SoT', 'option', 1 )
            db.close()
        }


        it( 'the assembled DB-first fence is answerable — isRenderable === true, matching the file regime', () => {
            seedAnswerable( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            // parse the assembled body exactly as the viewer parses a REV FILE (the file regime) — same
            // authoritative path, so a DB-first memo and a file-parsed memo of the same fence are identical.
            const { found, questions } = DocumentRegistry.parseQuestionJsonBlock( { content: markdown } )
            expect( found ).toBe( true )
            expect( questions.length ).toBe( 1 )

            const question = questions[ 0 ]
            // the render contract accepts it as an interactive card — the answerability proof.
            expect( isRenderable( { question } ) ).toBe( true )

            // the answerable payload survived the DB round-trip: id, two REAL options, the recommendation.
            expect( question[ 'id' ] ).toBe( 'F1' )
            expect( question[ 'aiRecommendation' ] ).toBe( 'A' )
            const realOptions = question[ 'options' ]
                .filter( ( option ) => option[ 'kind' ] === 'option' )
            expect( realOptions.map( ( option ) => option[ 'key' ] ) ).toEqual( [ 'A', 'B' ] )
            expect( realOptions.map( ( option ) => option[ 'label' ] ) ).toEqual( [ 'Ja — die DB ist die SoT', 'Nein — die Files bleiben SoT' ] )
        } )


        it( 'a pre-Slice-2a db (no options / no widened columns) degrades to a NON-answerable fence, never a throw', () => {
            // the base seedDb() creates a memo table WITHOUT the widened columns and NO question_option child.
            seedDb( { path: dbPath } )
            const db = new DatabaseSync( dbPath )
            db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT )' )
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'F1', 'M079', 'Alt?', 'info', 'open' )
            db.close()

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )
            const { found, questions } = DocumentRegistry.parseQuestionJsonBlock( { content: markdown } )

            expect( found ).toBe( true )
            // the widened scalars degraded to null, options to [] — honestly NOT answerable (no options).
            expect( isRenderable( { question: questions[ 0 ] } ) ).toBe( false )
        } )
    } )


    // AUTHORED-ORDER (Memo 079, REV-03 Kap 9 = viewer 1:1 Schaufenster; Kap 3/F16 = no silent DB-first
    // downgrade). `question.id` is a TEXT primary key, so a naive `ORDER BY id` sorts LEXICALLY
    // (F1 < F10 < F11 < F12 < F13 < F2), NOT the authored order the fence carries. The viewer widget must
    // therefore ORDER BY the authored-order `sort` ordinal so the DB-first render matches the authored fence
    // (and stays byte-identical to the core RevisionAssembler). This mirrors the real >=10-question fence of
    // memo 036 REV-02: 13 questions, authored order F1,F3,…,F13,F2 with F2 authored LAST.
    describe( 'authored question order (Slice-2a ordering, REV-03 Kap 9)', () => {
        const AUTHORED_ORDER = [ 'F1', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F2' ]

        const fenceIdsInOrder = ( { markdown } ) => {
            const fence = markdown.split( '## Fragen' )[ 1 ].split( '## Offene Fragen' )[ 0 ]

            return [ ...fence.matchAll( /"id":\s*"(F\d+)"/g ) ]
                .map( ( match ) => match[ 1 ] )
        }

        const openIdsInOrder = ( { markdown } ) => {
            const list = markdown.split( '## Offene Fragen' )[ 1 ]

            return [ ...list.matchAll( /-\s+\*\*(F\d+)\*\*/g ) ]
                .map( ( match ) => match[ 1 ] )
        }

        // Seed a widened `question` table (WITH the `sort` column, as `memo new` now applies) whose 13 rows
        // carry sort = the AUTHORED-order index. The rows are INSERTED in a lexically-sorted order on purpose,
        // so a passing test can only come from ORDER BY sort, never from insertion or id order.
        const seedThirteen = ( { path } ) => {
            const db = new DatabaseSync( path )
            db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT, context TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block_diagrams ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT, title TEXT, background TEXT, typ TEXT, ai_recommendation TEXT, sort INTEGER )' )

            db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at, context ) VALUES ( ?, ?, ?, ?, ?, ? )' )
                .run( 'M079', 'DB Traceability', 'strategy', 'draft', '2026-08-20T00:00:00.000Z', null )

            const insert = db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status, sort ) VALUES ( ?, ?, ?, ?, ?, ? )' )
            // INSERT in LEXICAL id order — the exact order a broken ORDER BY id would emit.
            const lexical = [ ...AUTHORED_ORDER ].sort( ( a, b ) => a.localeCompare( b ) )
            lexical
                .forEach( ( id ) => {
                    const status = id === 'F2' ? 'answered' : 'open'
                    insert.run( id, 'M079', `Frage ${ id }`, 'info', status, AUTHORED_ORDER.indexOf( id ) )
                } )

            db.close()
        }


        it( 'renders the questions-json fence + Offene-Fragen in authored order, not the lexical id sort', () => {
            seedThirteen( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            // (a) the fence follows the authored order (NOT F1,F10,F11,F12,F13,F2,F3,…).
            expect( fenceIdsInOrder( { markdown } ) ).toEqual( AUTHORED_ORDER )

            // (b) the ## Offene Fragen list follows the authored order minus the answered F2.
            const expectedOpen = AUTHORED_ORDER.filter( ( id ) => id !== 'F2' )
            expect( openIdsInOrder( { markdown } ) ).toEqual( expectedOpen )

            // (c) explicit anti-lexical discriminators: F3 precedes F10, and F2 is LAST.
            const ids = fenceIdsInOrder( { markdown } )
            expect( ids.indexOf( 'F3' ) ).toBeLessThan( ids.indexOf( 'F10' ) )
            expect( ids[ ids.length - 1 ] ).toBe( 'F2' )
        } )
    } )
} )
