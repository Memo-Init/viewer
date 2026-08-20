import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { DoltDbAssembler } from './DoltDbAssembler.mjs'


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
            expect( markdown ).not.toContain( 'Schon geklaert' )
        } )
    } )
} )
