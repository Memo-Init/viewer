import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { DatabaseSync } from '@dolthub/doltlite'

import { DoltDbAssembler } from './DoltDbAssembler.mjs'
import { BlockSections } from './BlockSections.mjs'
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
        it( 'renders the header from the memo row as the mandatory head TABLE (Memo 080, PRD-R1)', () => {
            seedDb( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            // The former bullet head (`- ID:` / `- Type:` / `- Status:`) carried NONE of the five mandatory
            // head fields, so every assembled revision failed five header checks. The head is a table now —
            // the shape the validator expects — and the memo row is still its source.
            expect( markdown ).toContain( '# Datenbank-Traceability' )
            expect( markdown ).toContain( '| Feld | Wert |' )
            expect( markdown ).toContain( '| **Memo** | M079 |' )
            expect( markdown ).toContain( '| **Memo-Name** | Datenbank-Traceability |' )
            expect( markdown ).toContain( '| **Datum** | 2026-08-20T00:00:00Z |' )
            expect( markdown ).toContain( '| **Status** | finalized |' )
            expect( markdown ).not.toContain( '- ID: M079' )
        } )

        it( 'renders the VISIBLE generation note and the scope line in the head (Memo 080, PRD-R2)', () => {
            seedDb( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            // the note is plain Markdown, not an HTML comment nobody sees while reading — and it names
            // SOURCE, PRODUCER and CHECK, in the language of the artefact (Memo 080, PRD-R2 Vollausbau).
            expect( markdown ).toContain( '_Erzeugt aus der Memo-Datenbank `memo-079.db` durch `memo revision assemble`, geprueft durch `memo revision parity` — nicht hand-geschrieben._' )
            expect( markdown ).not.toContain( '<!--' )
            // NINE figures in SEVEN groups. This db carries 2 work items and has NO topic / question /
            // rollout / prd / block_chapter table at all — an absent carrier renders `nicht ausweisbar`,
            // never an invented 0, and it never throws. `work_item` EXISTS but predates the `disposition`
            // column, so `wis` is a real count while `lebendig` is not ausweisbar: the guard works at BOTH
            // granularities.
            expect( markdown ).toContain( '**Umfang dieses Memos:** nicht ausweisbar Kapitel · nicht ausweisbar gestellte und beantwortete Fragen · nicht ausweisbar PRDs · nicht ausweisbar Phasen (P0–Pnicht ausweisbar) · nicht ausweisbar Topics (nicht ausweisbar registriert) · 2 Work-Items (nicht ausweisbar lebendig) · nicht ausweisbar Phasen-Items. Gerechnet, nicht behauptet — `memo revision parity`.' )
            expect( markdown ).not.toContain( '0 Kapitel' )
            // and the note stands ABOVE the head table, in the shared render order the core assembler fixes.
            expect( markdown.indexOf( '_Erzeugt aus der Memo-Datenbank' ) ).toBeLessThan( markdown.indexOf( '| Feld | Wert |' ) )
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

            // LEVEL THREE since Memo 080 / PRD-R3 Vollausbau: the fourth level gets no anchor here in the
            // viewer, which is why the markdown form rule of that same phase forbids it.
            expect( markdown ).toContain( '### Kennzahlen' )
            expect( markdown ).not.toContain( '#### Kennzahlen' )
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

            expect( markdown ).toContain( '### Fluss' )
            expect( markdown ).not.toContain( '#### Fluss' )
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
            // the answered F3 is excluded from the OPEN list — scoped to the `## Offene Fragen` section body
            // (up to the next `## `), since the broad build-out now ALSO emits every question in the `## Fragen`
            // json fence AND the answered F3 legitimately appears in the sibling `## Beantwortete Fragen` section.
            const openSection = markdown.split( '## Offene Fragen' )[ 1 ].split( '\n## ' )[ 0 ]
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
            db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT, disposition TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
            // Memo 080, PRD-R3 Vollausbau: the canonical seed carries the WIDENED shape (sort + section) the
            // core schema declares, so this fixture exercises the authored order and the section anchor. The
            // other seeds in this file deliberately keep the narrow shape — they are what proves the additive
            // PRAGMA probe still degrades to the old ORDER BY instead of throwing.
            db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT, render TEXT, payload_ref TEXT, payload_sha256 TEXT, sort INTEGER, section TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS block_diagrams ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT, source_ref TEXT, source_sha256 TEXT, sort INTEGER, section TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT, origin TEXT, status TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, depends_on TEXT, can_parallel_with TEXT, commit_hash TEXT, spillover TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, commit_hash TEXT, depends_on TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT, title TEXT, background TEXT, typ TEXT, ai_recommendation TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS question_option ( question_id TEXT, opt_key TEXT, label TEXT, kind TEXT, sort INTEGER )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS research ( r_no INTEGER PRIMARY KEY, memo_id TEXT, title TEXT, kind TEXT, path TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS research_topics ( r_no INTEGER, topic_id TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS research_files ( r_no INTEGER, path TEXT, sha256 TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS user_input_answers ( input_id TEXT, question_id TEXT, option_key TEXT, answer_verbatim TEXT, preselected INTEGER )' )
            // Memo 080, PRD-R1: the three formerly unrendered kinds of data plus the two new carriers.
            db.exec( 'CREATE TABLE IF NOT EXISTS snag ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, status TEXT, verdict TEXT, disposition TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS goal ( id TEXT PRIMARY KEY, name TEXT, kind TEXT, pct INTEGER, status TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS maintenance_card ( repo TEXT PRIMARY KEY, freshness INTEGER, blast TEXT, maint_status TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS memo_section ( id TEXT PRIMARY KEY, heading TEXT, body TEXT, sort INTEGER )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS memo_head ( field TEXT PRIMARY KEY, value TEXT, sort INTEGER )' )
            // Memo 080, PRD-R1 Vollausbau: the block toolkit carrier (PRD-D1 builds it) and the session
            // table that feeds the mandatory `## Kontaminations-Metadaten` section.
            db.exec( 'CREATE TABLE IF NOT EXISTS block_section ( id TEXT PRIMARY KEY, block_id TEXT, name TEXT, body TEXT, sort INTEGER )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS sessions ( session_id TEXT PRIMARY KEY, memo_id TEXT, parent_session_id TEXT, role TEXT, model TEXT, started_at TEXT, tokens INTEGER, tool_calls INTEGER )' )
            // Memo 080, PRD-R2 Vollausbau: the carriers of the NINE scope figures. `topic.status` and
            // `work_item.disposition` are COLUMNS added to the two tables above; `block_chapter` and `prd`
            // are whole tables. None of the four is rendered into the body — they exist so this seed
            // reproduces the core seed's scope line byte for byte instead of reporting "nicht ausweisbar".
            db.exec( 'CREATE TABLE IF NOT EXISTS block_chapter ( block_id TEXT, memo_id TEXT, chapter INTEGER, heading TEXT )' )
            db.exec( 'CREATE TABLE IF NOT EXISTS prd ( prd_id TEXT PRIMARY KEY, memo_id TEXT, phase_id TEXT, chapter TEXT, title TEXT, category TEXT, prd_file TEXT, status TEXT, commit_hash TEXT )' )

            db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at, context ) VALUES ( ?, ?, ?, ?, ?, ? )' )
                .run( 'M079', 'DB Traceability', 'strategy', 'finalized', '2026-08-20T00:00:00.000Z', 'Kontext Zeile eins.\nKontext Zeile zwei.' )
            db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'WI-02', 'assemble', 'render from DB', 'open', 'B' )
            db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'WI-01', 'store', 'adapter', 'done', 'A' )
            db.prepare( 'INSERT INTO block ( id, title, sort ) VALUES ( ?, ?, ? )' ).run( 'B001', 'Backbone', 1 )
            // The rows the core seed produces through MemoContentStore.setBlocks: the key is
            // <block_id>.<handle>, `sort` is the AUTHORED position and `section` the anchor. TWO tables and
            // TWO diagrams on one block — one diagram fed from a block-local handle, one table plus one
            // diagram anchored to `targetState`.
            const insertBlockTable = db.prepare( 'INSERT INTO block_tables ( id, block_id, title, tsv, render, sort, section ) VALUES ( ?, ?, ?, ?, ?, ?, ? )' )
            insertBlockTable.run( 'B001.BT001', 'B001', 'Primitives', 'name\tstatus\ncommit\tok', null, 0, null )
            insertBlockTable.run( 'B001.BT002', 'B001', 'Anker-Tabelle', 'stufe\twert\nzwei\tja', 'table', 1, 'targetState' )
            const insertBlockDiagram = db.prepare( 'INSERT INTO block_diagrams ( id, block_id, title, kind, `source`, feed, sort, section ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ? )' )
            insertBlockDiagram.run( 'B001.M1', 'B001', 'Flow', 'mermaid', 'graph TD{{#rows}}\n  {{name}} --> {{status}}{{/rows}}', 'BT001', 0, null )
            insertBlockDiagram.run( 'B001.M2', 'B001', 'Anker-Diagramm', 'mermaid', 'graph LR\n  A --> B', null, 1, 'targetState' )
            db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block, origin, status ) VALUES ( ?, ?, ?, ?, ?, ?, ? )' ).run( 'T01', 'M079', 'DB als SoT', 'P1', 'B001', 'init', 'registered' )
            db.prepare( 'INSERT INTO topic ( id, memo_id, title, phase, block, origin, status ) VALUES ( ?, ?, ?, ?, ?, ?, ? )' ).run( 'T02', 'M079', 'Traceability', 'P2', null, null, null )
            db.prepare( 'INSERT INTO block_chapter ( block_id, memo_id, chapter, heading ) VALUES ( ?, ?, ?, ? )' ).run( 'B001', 'M079', 13, 'Die erzeugte Revision' )
            db.prepare( 'INSERT INTO prd ( prd_id, memo_id, phase_id, chapter, title ) VALUES ( ?, ?, ?, ?, ? )' ).run( 'PRD-16', 'M079', 'P1', '13', 'Assembled revision' )
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
            // the memo-local Research register — rows IDENTICAL to what the core MemoContentStore.setResearch
            // writer produces from seedCanonical, so the ## Research render is byte-identical across both repos.
            const insertResearch = db.prepare( 'INSERT INTO research ( r_no, memo_id, title, kind, path ) VALUES ( ?, ?, ?, ?, ? )' )
            insertResearch.run( 1, 'M079', 'doltlite Machbarkeit', 'wave-2', null )
            insertResearch.run( 2, 'M079', 'Memo-Korpus', 'wave-2', null )
            const insertResearchTopic = db.prepare( 'INSERT INTO research_topics ( r_no, topic_id ) VALUES ( ?, ? )' )
            insertResearchTopic.run( 1, 'T01' )
            insertResearchTopic.run( 2, 'T01' )
            insertResearchTopic.run( 2, 'T02' )
            db.prepare( 'INSERT INTO research_files ( r_no, path, sha256 ) VALUES ( ?, ?, ? )' )
                .run( 1, 'context/research/2026-08-19--doltlite-machbarkeit.md', null )
            // the durable user decision for the answered F2 — IDENTICAL to what the core UserInputStore writer
            // produces from seedCanonical (input_id UI-0001, chosen option A + verbatim), so the
            // ## Beantwortete Fragen render is byte-identical across both repos (Memo 079 audit T2-M1).
            db.prepare( 'INSERT INTO user_input_answers ( input_id, question_id, option_key, answer_verbatim, preselected ) VALUES ( ?, ?, ?, ?, ? )' )
                .run( 'UI-0001', 'F2', 'A', 'A — Normalisierung laeuft aus rollout/state.json.', 0 )
            // Memo 080, PRD-R1 — rows IDENTICAL to what the core production writers (MemoContentStore
            // setSnags / setGoals / setMaintenanceCards / setSections / setHeadFields) produce from
            // seedCanonical, so the new sections and the head table render byte-identically in both repos.
            db.prepare( 'INSERT INTO snag ( id, memo_id, title, status, verdict, disposition ) VALUES ( ?, ?, ?, ?, ?, ? )' )
                .run( '079-tag-grenze', 'M079', 'tag-grenze', 'open', 'offen', 'traced' )
            db.prepare( 'INSERT INTO goal ( id, name, kind, pct, status ) VALUES ( ?, ?, ?, ?, ? )' )
                .run( 'G-001', 'DB als SoT', 'capability', 65, 'open' )
            db.prepare( 'INSERT INTO maintenance_card ( repo, freshness, blast, maint_status ) VALUES ( ?, ?, ?, ? )' )
                .run( 'core', 82, '3', 'ok' )
            const insertSection = db.prepare( 'INSERT INTO memo_section ( id, heading, body, sort ) VALUES ( ?, ?, ?, ? )' )
            insertSection.run( 'S-vorwort', 'Vorwort', 'Diese Revision entsteht aus der Datenbank.', 0 )
            insertSection.run( 'S-phase-hints', 'Phase-Hints', '- P1 kann parallel zu P2 laufen.', 1 )
            insertSection.run( 'S-finalisierungs-checkliste', 'Finalisierungs-Checkliste', '- [x] Evidenz geprueft', 2 )
            insertSection.run( 'S-ancillary-files', 'Ancillary Files', '1. `context/research/2026-08-19--doltlite-machbarkeit.md`', 3 )
            insertSection.run( 'S-rollout-entry-points', 'Rollout-Entry-Points', '1. `cli/src/RevisionAssembler.mjs`', 4 )
            insertSection.run( 'S-lessons-learned', 'Lessons-Learned', 'Ein Traeger fehlt erst dann auf, wenn er gerendert werden soll.', 5 )
            const insertHead = db.prepare( 'INSERT INTO memo_head ( field, value, sort ) VALUES ( ?, ?, ? )' )
            insertHead.run( 'Memo', 'M079', 0 )
            insertHead.run( 'Memo-Name', 'DB Traceability', 1 )
            insertHead.run( 'Revision', '01', 2 )
            insertHead.run( 'Datum', '2026-08-20', 3 )
            insertHead.run( 'Status', 'finalized', 4 )
            // Memo 080, PRD-R1 Vollausbau — the two head fields the DOCUMENT LEVEL demands (REV-18 Z. 160),
            // the block toolkit rows the core seed writes through MemoContentStore.setBlocks (sort = the
            // register ordinal), and the two sessions that feed the contamination section. All rows are
            // IDENTICAL to the core seed, so both renderers reproduce the same fixture bytes.
            insertHead.run( 'Typ', 'Full', 5 )
            insertHead.run( 'Aenderungen', 'Erstfassung aus der Datenbank', 6 )
            const insertBlockSection = db.prepare( 'INSERT INTO block_section ( id, block_id, name, body, sort ) VALUES ( ?, ?, ?, ?, ? )' )
            insertBlockSection.run( 'B001:userMandate', 'B001', 'userMandate', '> "Die Revision soll aus der Datenbank entstehen."', 0 )
            insertBlockSection.run( 'B001:currentState', 'B001', 'currentState', '- **[FAKT]** Der Erzeuger rendert je Block nur die Ueberschrift.', 1 )
            insertBlockSection.run( 'B001:assessment', 'B001', 'assessment', 'Der Block war formal gueltig und trotzdem unlesbar.', 3 )
            const insertSession = db.prepare( 'INSERT INTO sessions ( session_id, memo_id, parent_session_id, role, model, started_at, tokens, tool_calls ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ? )' )
            insertSession.run( 'sess-worker', 'M079', 'sess-lead', 'worker', 'opus', '2026-08-20T10:00:00.000Z', 4200, 17 )
            insertSession.run( 'sess-lead', 'M079', null, 'orchestrator', 'opus', '2026-08-20T09:00:00.000Z', 12800, 42 )
            db.close()
        }


        it( 'renders the full section set byte-identical to the core assembler golden', () => {
            seedFullCanonical( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            expect( markdown ).toBe( GOLDEN_FULL_BODY )

            // Slice-2b: the memo-local Research register + its topic/file edges RENDER from the DB, byte-identical
            // to the core assembler (REV-03 Kap 3 Punkt 1 "Research-Kanten leben in der DB").
            expect( markdown ).toContain( '## Research\n\n| R | Title | Kind | Topics | Files |' )
            expect( markdown ).toContain( '| R1 | doltlite Machbarkeit | wave-2 | T01 | context/research/2026-08-19--doltlite-machbarkeit.md |' )
            expect( markdown ).toContain( '| R2 | Memo-Korpus | wave-2 | T01, T02 |  |' )

            // Memo 080, PRD-R1: the head table, the six mandatory prose sections and the three formerly
            // unrendered kinds of data appear in the viewer render exactly as in the frozen core revision.
            expect( markdown ).toContain( '| Feld | Wert |\n| --- | --- |\n| **Memo** | M079 |' )
            expect( markdown ).toContain( '| **Revision** | 01 |' )
            // Memo 080, PRD-R2 Vollausbau: the visible generation note + the scope line are part of the
            // canonical bytes both renderers must reproduce; the NINE figures count content carriers ONLY
            // (this db carries no `revision` / `provenance` / `history_journal` rows and the line must not
            // depend on them anyway). Both lines come out of the SHARED template, so a one-sided wording
            // change fails here AND in the core.
            expect( markdown ).toContain( '_Erzeugt aus der Memo-Datenbank `memo-079.db` durch `memo revision assemble`, geprueft durch `memo revision parity` — nicht hand-geschrieben._' )
            expect( markdown ).toContain( '**Umfang dieses Memos:** 1 Kapitel · 2 gestellte und beantwortete Fragen · 1 PRDs · 1 Phasen (P0–P0) · 2 Topics (1 registriert) · 2 Work-Items (0 lebendig) · 1 Phasen-Items. Gerechnet, nicht behauptet — `memo revision parity`.' )
            expect( markdown ).toContain( '## Vorwort\n\nDiese Revision entsteht aus der Datenbank.' )
            expect( markdown ).toContain( '## Phase-Hints\n\n- P1 kann parallel zu P2 laufen.' )
            expect( markdown ).toContain( '## Snags\n\n| ID | Title | Status | Verdict | Disposition |' )
            expect( markdown ).toContain( '## Goals\n\n| ID | Name | Kind | Pct | Status |' )
            expect( markdown ).toContain( '## Maintenance\n\n| Repo | Freshness | Blast | Status |' )
            expect( markdown ).toContain( '## Finalisierungs-Checkliste\n\n- [x] Evidenz geprueft' )
            expect( markdown ).toContain( '## Ancillary Files\n\n1. `context/research/2026-08-19--doltlite-machbarkeit.md`' )
            expect( markdown ).toContain( '## Rollout-Entry-Points\n\n1. `cli/src/RevisionAssembler.mjs`' )
            expect( markdown ).toContain( '## Lessons-Learned\n\nEin Traeger fehlt erst dann auf, wenn er gerendert werden soll.' )

            // hand-edit guard: the vendored fixture must hash to the recorded manifest sha256 (same value the
            // core repo records), so a doctored golden that would silently satisfy the equality is caught.
            const fixtureSha = createHash( 'sha256' ).update( GOLDEN_FULL_BODY, 'utf8' ).digest( 'hex' )
            expect( fixtureSha ).toBe( GOLDEN_MANIFEST[ 'sha256' ] )
            expect( Buffer.byteLength( GOLDEN_FULL_BODY, 'utf8' ) ).toBe( GOLDEN_MANIFEST[ 'byteLength' ] )
        } )

        it( 'renders `## Beantwortete Fragen` with the AI-vs-user decision pair from the DB (T2-M1)', () => {
            seedFullCanonical( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            // the answered F2 surfaces the decision PAIR — AI recommendation vs the durable user_input_answers
            // decision (chosen option + verbatim) — the datum the user called "das aller aller wichtigste".
            expect( markdown ).toContain( '## Beantwortete Fragen' )
            expect( markdown ).toContain( '### F2 — Phasen-Normalisierung' )
            expect( markdown ).toContain( '- **AI-Empfehlung war:** A' )
            expect( markdown ).toContain( '- **User-Entscheidung:** A — Aus rollout/state.json projizieren' )
            expect( markdown ).toContain( '- **Wortlaut:** A — Normalisierung laeuft aus rollout/state.json.' )
        } )

        it( 'the DB-generated Beantwortete-Fragen section is parsed back by the DocumentRegistry consumer', () => {
            seedFullCanonical( { path: dbPath } )

            const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

            // the whole point: the SAME parser the file regime uses extracts the AI-vs-user pair from the
            // DB-first render — alles aus der DB generierbar, inkl. der User-Entscheidungen (Memo 038 Kap 6).
            const { questions } = DocumentRegistry.parseQuestionSchema( { content: markdown } )
            const f2 = questions.find( ( q ) => q[ 'id' ] === 'F2' )

            expect( f2[ 'answered' ] ).toBe( true )
            expect( f2[ 'aiRecommendationWas' ] ).toBe( 'A' )
            expect( f2[ 'userDecision' ] ).toBe( 'A — Aus rollout/state.json projizieren' )
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
            expect( markdown ).toContain( '## Research\n\n_no research_' )
            expect( markdown ).toContain( '## Fragen\n\n```questions-json\n[]\n```' )
            expect( markdown ).toContain( '## Offene Fragen\n\nkeine' )
            // no question / user_input_answers table → the answered section degrades to the empty sentinel.
            expect( markdown ).toContain( '## Beantwortete Fragen\n\n_keine beantworteten Fragen_' )
            // Memo 080, PRD-R1: the three new data sections and the six mandatory prose sections degrade the
            // same way — the heading is ALWAYS there, the emptiness is stated, nothing is silently dropped.
            expect( markdown ).toContain( '## Snags\n\n_no snags_' )
            expect( markdown ).toContain( '## Goals\n\n_no goals_' )
            expect( markdown ).toContain( '## Maintenance\n\n_no maintenance cards_' )
            const mandatoryProse = [ 'Vorwort', 'Phase-Hints', 'Finalisierungs-Checkliste', 'Ancillary Files', 'Rollout-Entry-Points', 'Lessons-Learned' ]
            expect( mandatoryProse.length ).toBe( 6 )
            mandatoryProse
                .forEach( ( heading ) => {
                    expect( markdown ).toContain( `## ${ heading }\n\n_kein Inhalt_` )
                } )
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


// PRD-V1 (Memo 080, Kap 15 — Das Schaufenster / WI-101): the READ-ONLY raw-table window. Every case below
// states HOW MUCH it compared (table count / row count / number of rejected names), so an empty result is
// only ever honest emptiness and never a check that found nothing to compare
// (lesson deterministic-gates-can-be-vacuum-green). Tests write ONLY into the repo-internal .test-tmp/.
describe( 'DoltDbAssembler — PRD-V1 raw-table window (Memo 080, Kap 15)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let memoDir = ''
    let dbPath = ''

    // The seeded database carries exactly these tables — the number every listing case compares against.
    const SEEDED_TABLES = [ 'block', 'block_tables', 'lifecycle', 'memo', 'work_item' ]

    // The four identifier-injection shapes named in the PRD assertions. None of them is a table in the
    // seeded database, so all four must die at the whitelist — NOT at a character filter.
    const INJECTION_NAMES = [ 'work_item; DROP TABLE memo', 'work_item"', 'work_item`', '../work_item' ]

    const LONG_CELL_LENGTH = 5000


    const seedRawDb = ( { path } ) => {
        const db = new DatabaseSync( path )
        db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS lifecycle ( state TEXT, at TEXT, by TEXT, evidence TEXT )' )

        db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'M080', 'DB-Vollausbau', 'strategy', 'draft', '2026-08-31T00:00:00.000Z' )

        const insertWorkItem = db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' )
        // 7 rows — enough to page twice with limit 3 and still overshoot with a large offset.
        const ids = [ 'WI-1', 'WI-2', 'WI-3', 'WI-4', 'WI-5', 'WI-6', 'WI-7' ]
        ids
            .forEach( ( id, index ) => {
                insertWorkItem.run( id, 'schaufenster', `Titel ${ id }`, index === 0 ? 'done' : 'open', 'P0' )
            } )

        // One over-long cell (5 000 chars) to exercise the 2 000-char server-side truncation, plus a cell
        // that carries markup so the client-side escaping has a real payload to neutralise.
        db.prepare( 'INSERT INTO block_tables ( id, block_id, title, tsv ) VALUES ( ?, ?, ?, ? )' )
            .run( 'T1', 'B001', 'Kennzahlen', 'x'.repeat( LONG_CELL_LENGTH ) )
        db.prepare( 'INSERT INTO block ( id, title, sort ) VALUES ( ?, ?, ? )' )
            .run( 'B001', '<script>alert(1)</script>', 1 )

        db.close()
    }


    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        memoDir = mkdtempSync( join( repoTmpRoot, 'memo-080-raw-' ) )
        dbPath = resolve( memoDir, 'memo-080.db' )
        seedRawDb( { path: dbPath } )
    } )

    afterEach( () => {
        rmSync( memoDir, { recursive: true, force: true } )
    } )


    describe( 'readTableList (US-1 — die Tabellen der Datenbank sehen)', () => {
        it( 'lists every seeded table WITH its row count and states how many it compared', () => {
            const { tables, tableCount } = DoltDbAssembler.readTableList( { dbPath } )

            // (a) the count is the measured comparison base — 5 seeded tables, not "some".
            expect( tableCount ).toBe( SEEDED_TABLES.length )
            expect( tables.length ).toBe( SEEDED_TABLES.length )
            expect( tables.map( ( t ) => t[ 'name' ] ) ).toEqual( SEEDED_TABLES )

            // (b) the row counts are real per-table facts, not a shared placeholder.
            const byName = Object.fromEntries( tables.map( ( t ) => [ t[ 'name' ], t[ 'rowCount' ] ] ) )
            expect( byName[ 'work_item' ] ).toBe( 7 )
            expect( byName[ 'memo' ] ).toBe( 1 )
            expect( byName[ 'lifecycle' ] ).toBe( 0 )
        } )


        it( 'fails loud on a missing / empty dbPath instead of returning an empty list', () => {
            expect( () => DoltDbAssembler.readTableList( {} ) ).toThrow( /"dbPath" is required/ )
            expect( () => DoltDbAssembler.readTableList( { dbPath: '' } ) ).toThrow( /"dbPath" is required/ )
            expect( () => DoltDbAssembler.readTableList( { dbPath: resolve( memoDir, 'nope.db' ) } ) ).toThrow( /does not exist/ )
        } )
    } )


    describe( 'readTablePage (US-2 — eine Tabelle seitenweise lesen)', () => {
        it( 'returns column heads, rows, total, limit and offset for a named table', () => {
            const page = DoltDbAssembler.readTablePage( { dbPath, table: 'work_item', limit: 3, offset: 0 } )

            expect( page[ 'found' ] ).toBe( true )
            expect( page[ 'columns' ] ).toEqual( [ 'id', 'topic', 'title', 'status', 'grp' ] )
            expect( page[ 'rows' ].length ).toBe( 3 )
            expect( page[ 'totalRows' ] ).toBe( 7 )
            expect( page[ 'limit' ] ).toBe( 3 )
            expect( page[ 'offset' ] ).toBe( 0 )
            expect( page[ 'rows' ][ 0 ][ 0 ][ 'value' ] ).toBe( 'WI-1' )
            // the cell count per row matches the column count — 5 columns compared, none dropped.
            expect( page[ 'rows' ][ 0 ].length ).toBe( page[ 'columns' ].length )
        } )


        it( 'pages forward: offset 3 with limit 3 yields the next 3 of the same 7 rows', () => {
            const page = DoltDbAssembler.readTablePage( { dbPath, table: 'work_item', limit: 3, offset: 3 } )

            expect( page[ 'rows' ].length ).toBe( 3 )
            expect( page[ 'totalRows' ] ).toBe( 7 )
            expect( page[ 'offset' ] ).toBe( 3 )
            expect( page[ 'rows' ][ 0 ][ 0 ][ 'value' ] ).toBe( 'WI-4' )
        } )


        it( 'applies the documented default limit of 100 when the caller names none', () => {
            const page = DoltDbAssembler.readTablePage( { dbPath, table: 'work_item' } )

            expect( page[ 'limit' ] ).toBe( 100 )
            expect( page[ 'offset' ] ).toBe( 0 )
            expect( page[ 'rows' ].length ).toBe( 7 )
            expect( page[ 'totalRows' ] ).toBe( 7 )
        } )


        it( 'an offset beyond the total yields EMPTY rows WITH the total stated — not an error, not a mute zero', () => {
            const page = DoltDbAssembler.readTablePage( { dbPath, table: 'work_item', limit: 10, offset: 500 } )

            expect( page[ 'found' ] ).toBe( true )
            expect( page[ 'rows' ] ).toEqual( [] )
            expect( page[ 'totalRows' ] ).toBe( 7 )
            expect( page[ 'offset' ] ).toBe( 500 )
        } )
    } )


    describe( 'Whitelist (US-3 — der Name einer Tabelle ist keine Einfallsschneise)', () => {
        it( 'rejects an unknown table name WITHOUT querying it, and says how many names it checked against', () => {
            const page = DoltDbAssembler.readTablePage( { dbPath, table: 'does_not_exist' } )

            expect( page[ 'found' ] ).toBe( false )
            expect( page[ 'rows' ] ).toEqual( [] )
            expect( page[ 'columns' ] ).toEqual( [] )
            // the comparison base is stated: 5 known names were checked, so found:false is a real miss.
            expect( page[ 'tableCount' ] ).toBe( SEEDED_TABLES.length )
        } )


        it( 'rejects ALL FOUR injection shapes — because they are not in the list, not by filtering characters', () => {
            const verdicts = INJECTION_NAMES
                .map( ( name ) => DoltDbAssembler.readTablePage( { dbPath, table: name } ) )

            // 4 of 4 rejected — the count is stated so a shrunken input list cannot pass unnoticed.
            expect( verdicts.length ).toBe( 4 )
            expect( verdicts.filter( ( v ) => v[ 'found' ] === false ).length ).toBe( 4 )
            // the rejected name is echoed VERBATIM (no character was stripped to make it "safe").
            expect( verdicts.map( ( v ) => v[ 'table' ] ) ).toEqual( INJECTION_NAMES )

            // and the database is untouched: the same 5 tables with the same 7 work_item rows.
            const after = DoltDbAssembler.readTableList( { dbPath } )
            expect( after[ 'tableCount' ] ).toBe( SEEDED_TABLES.length )
            expect( after[ 'tables' ].map( ( t ) => t[ 'name' ] ) ).toEqual( SEEDED_TABLES )
            expect( DoltDbAssembler.readTablePage( { dbPath, table: 'work_item' } )[ 'totalRows' ] ).toBe( 7 )
        } )


        it( 'fails loud on a missing table argument (no silent "list everything")', () => {
            expect( () => DoltDbAssembler.readTablePage( { dbPath } ) ).toThrow( /"table" is required/ )
            expect( () => DoltDbAssembler.readTablePage( { dbPath, table: '' } ) ).toThrow( /"table" is required/ )
        } )
    } )


    describe( 'normalizeTablePage (US-2 — eine unsinnige Begrenzung erreicht die Datenbank nie)', () => {
        it( 'takes the documented default for an absent window', () => {
            expect( DoltDbAssembler.normalizeTablePage( {} ) ).toEqual( { limit: 100, offset: 0 } )
            expect( DoltDbAssembler.normalizeTablePage( { limit: null, offset: '' } ) ).toEqual( { limit: 100, offset: 0 } )
        } )


        it( 'accepts numeric strings (the query-parameter shape) as real numbers', () => {
            expect( DoltDbAssembler.normalizeTablePage( { limit: '25', offset: '50' } ) ).toEqual( { limit: 25, offset: 50 } )
        } )


        it( 'rejects EVERY unusable window shape — non-numeric, negative, fractional, zero, above the ceiling', () => {
            const bad = [
                { limit: 'abc' }, { limit: '10; DROP TABLE memo' }, { limit: -5 }, { limit: 0 },
                { limit: 1.5 }, { limit: 100000 }, { offset: -1 }, { offset: 'x' }
            ]

            // 8 of 8 shapes rejected — the count is stated so a shrunken input list cannot pass unnoticed.
            const thrown = bad
                .filter( ( window ) => {
                    try {
                        DoltDbAssembler.normalizeTablePage( window )

                        return false
                    } catch {
                        return true
                    }
                } )

            expect( bad.length ).toBe( 8 )
            expect( thrown.length ).toBe( 8 )
        } )


        it( 'readTablePage refuses a bad window BEFORE it touches the database', () => {
            expect( () => DoltDbAssembler.readTablePage( { dbPath, table: 'work_item', limit: 'abc' } ) )
                .toThrow( /normalizeTablePage/ )
            expect( () => DoltDbAssembler.readTablePage( { dbPath, table: 'work_item', offset: -1 } ) )
                .toThrow( /normalizeTablePage/ )
        } )


        it( 'the paged SELECT binds limit/offset as `?` — no number is concatenated into the SQL', () => {
            const source = readFileSync( resolve( process.cwd(), 'src', 'DoltDbAssembler.mjs' ), 'utf-8' )

            expect( source ).toContain( 'LIMIT ? OFFSET ?' )
            // no interpolated numeric window anywhere in the module (`LIMIT ${...}` / `OFFSET ${...}`).
            expect( /LIMIT \$\{/.test( source ) ).toBe( false )
            expect( /OFFSET \$\{/.test( source ) ).toBe( false )
        } )
    } )


    describe( 'Zell-Kuerzung (US-2 — grosse Zellen kommen gekuerzt und markiert an)', () => {
        it( 'cuts a 5 000-char cell at 2 000 chars, marks it and reports the original length', () => {
            const page = DoltDbAssembler.readTablePage( { dbPath, table: 'block_tables' } )
            const tsvIndex = page[ 'columns' ].indexOf( 'tsv' )
            const cellValue = page[ 'rows' ][ 0 ][ tsvIndex ]

            expect( page[ 'rows' ].length ).toBe( 1 )
            expect( cellValue[ 'truncated' ] ).toBe( true )
            expect( cellValue[ 'value' ].length ).toBe( 2000 )
            expect( cellValue[ 'length' ] ).toBe( LONG_CELL_LENGTH )
            // exactly ONE cell of this page was cut — stated, not implied.
            expect( page[ 'truncatedCells' ] ).toBe( 1 )
        } )


        it( 'leaves a short cell untouched and unmarked, and passes markup through verbatim (escaping is the client\'s job)', () => {
            const page = DoltDbAssembler.readTablePage( { dbPath, table: 'block' } )
            const titleIndex = page[ 'columns' ].indexOf( 'title' )
            const cellValue = page[ 'rows' ][ 0 ][ titleIndex ]

            expect( cellValue[ 'truncated' ] ).toBe( false )
            expect( cellValue[ 'value' ] ).toBe( '<script>alert(1)</script>' )
            expect( page[ 'truncatedCells' ] ).toBe( 0 )
        } )


        it( 'keeps a NULL cell null (an empty cell and a cut cell stay different facts)', () => {
            const page = DoltDbAssembler.readTablePage( { dbPath, table: 'memo' } )
            const typeIndex = page[ 'columns' ].indexOf( 'memo_type' )

            expect( page[ 'rows' ].length ).toBe( 1 )
            expect( page[ 'rows' ][ 0 ][ typeIndex ][ 'value' ] ).toBe( 'strategy' )
            expect( page[ 'rows' ][ 0 ][ typeIndex ][ 'truncated' ] ).toBe( false )
        } )
    } )


    describe( 'Nur lesend (US-4 — die Ein-Schreiber-Disziplin bleibt unberuehrt)', () => {
        it( 'the raw-table leaves carry no write verb at all', () => {
            const source = readFileSync( resolve( process.cwd(), 'src', 'DoltDbAssembler.mjs' ), 'utf-8' )
            const start = source.indexOf( 'static normalizeTablePage' )
            const end = source.indexOf( '// ---- private ----' )
            const added = source.slice( start, end )

            expect( start ).toBeGreaterThan( -1 )
            expect( end ).toBeGreaterThan( start )
            // the whole new public surface is scanned — 1 contiguous region, 5 forbidden verbs.
            const verbs = [ 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE' ]
            expect( verbs.length ).toBe( 5 )
            expect( verbs.filter( ( verb ) => added.indexOf( verb ) !== -1 ) ).toEqual( [] )
        } )


        it( 'the retired "no injection surface" claim is gone and the whitelist is named instead', () => {
            const source = readFileSync( resolve( process.cwd(), 'src', 'DoltDbAssembler.mjs' ), 'utf-8' )

            expect( source ).not.toContain( 'never user input — no injection surface' )
            expect( source ).toContain( 'whitelist is the safeguard' )
        } )
    } )
} )


// ── Memo 080, PRD-D5 — external payload pointers in the viewer ──────────────────────────────────────
//
// MEASURED DEFECT this closes: the render read `SELECT id, block_id, title, tsv FROM block_tables` and
// `SELECT ... source, feed FROM block_diagrams` — neither pointer column was read at all. A payload-backed
// row therefore rendered an EMPTY table and a payload-backed diagram an EMPTY fence: the silent substitute
// the error rule forbids, and a byte-parity break in the MATCHED case, not only in the gap case.
//
// The gate is the THIRD cross-repo fixture, `revision-body-pointer-v1`, vendored BYTE-IDENTICALLY from
// repos/core/cli/test/fixtures/ (same sha256 in the manifest). Both halves are asserted: viewer render ===
// fixture AND sha256(fixture) === manifest.sha256, so neither this renderer nor the fixture can drift alone.
describe( 'DoltDbAssembler — external payload pointers (Memo 080, PRD-D5)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    const FIXTURE_DIR = resolve( process.cwd(), 'tests', 'fixtures', 'revision-body-pointer-v1' )
    const POINTER_GOLDEN_BODY = readFileSync( resolve( FIXTURE_DIR, 'full-body.md' ), 'utf8' )
    const POINTER_MANIFEST = JSON.parse( readFileSync( resolve( FIXTURE_DIR, 'manifest.json' ), 'utf8' ) )

    // The canonical payloads — the SAME bytes the core fixture seed writes (RevisionAssembler.test
    // TEMPLATE_BODY / TABLE_PAYLOAD / RESEARCH_BODY). Identical bytes in, identical bytes out.
    const TEMPLATE_BODY = 'graph TD{{#rows}}\n  {{name}} --> {{status}}{{/rows}}'
    const TABLE_PAYLOAD = '{"columns":["name","status"],"rows":[["commit","ok"]]}'
    const RESEARCH_BODY = '# doltlite Machbarkeit\n'
    const digestOf = ( { text } ) => createHash( 'sha256' ).update( Buffer.from( text, 'utf8' ) ).digest( 'hex' )

    let projectRoot = ''
    let memoDir = ''
    let dbPath = ''


    // A REAL reference-point layout (`<projectRoot>/.memo/memos/NNN-slug`), because the resolution derives
    // both roots from the database path: a bare temp folder would carry no `.memo` segment and therefore no
    // project reference point at all.
    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        projectRoot = mkdtempSync( join( repoTmpRoot, 'pointer-' ) )
        memoDir = resolve( projectRoot, '.memo', 'memos', '080-pointer' )
        mkdirSync( resolve( memoDir, 'context' ), { recursive: true } )
        mkdirSync( resolve( projectRoot, 'context' ), { recursive: true } )
        dbPath = resolve( memoDir, 'memo-080.db' )
    } )

    afterEach( () => {
        rmSync( projectRoot, { recursive: true, force: true } )
    } )


    // The schema shape a per-memo database has after DoltSchema.apply for every table this render touches,
    // including the two pointer pairs. `withPointerColumns:false` reproduces a database that PREDATES them.
    const createSchema = ( { db, withPointerColumns } ) => {
        const tableColumns = withPointerColumns === true
            ? 'id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT, render TEXT, payload_ref TEXT, payload_sha256 TEXT'
            : 'id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT'
        const diagramColumns = withPointerColumns === true
            ? 'id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT, source_ref TEXT, source_sha256 TEXT'
            : 'id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT'

        db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT, context TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT, disposition TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
        db.exec( `CREATE TABLE IF NOT EXISTS block_tables ( ${ tableColumns } )` )
        db.exec( `CREATE TABLE IF NOT EXISTS block_diagrams ( ${ diagramColumns } )` )
        db.exec( 'CREATE TABLE IF NOT EXISTS topic ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, phase TEXT, block TEXT, origin TEXT, status TEXT )' )
        // Memo 080, PRD-R2 Vollausbau: the two remaining carriers of the nine scope figures. This helper
        // states "the shape DoltSchema.apply leaves", so it must carry them — otherwise the viewer would
        // render `nicht ausweisbar` where the core, which applies the real schema, renders a count.
        db.exec( 'CREATE TABLE IF NOT EXISTS block_chapter ( block_id TEXT, memo_id TEXT, chapter INTEGER, heading TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS prd ( prd_id TEXT PRIMARY KEY, memo_id TEXT, phase_id TEXT, chapter TEXT, title TEXT, category TEXT, prd_file TEXT, status TEXT, commit_hash TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS rollout_phase ( id TEXT PRIMARY KEY, memo_id TEXT, name TEXT, status TEXT, depends_on TEXT, can_parallel_with TEXT, commit_hash TEXT, spillover TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS rollout_work_item ( id TEXT PRIMARY KEY, phase_id TEXT, title TEXT, status TEXT, commit_hash TEXT, depends_on TEXT, target TEXT, wi_type TEXT, spillover TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT, title TEXT, background TEXT, typ TEXT, ai_recommendation TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS question_option ( question_id TEXT, opt_key TEXT, label TEXT, kind TEXT, sort INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS research ( r_no INTEGER PRIMARY KEY, memo_id TEXT, title TEXT, kind TEXT, path TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS research_topics ( r_no INTEGER, topic_id TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS research_files ( r_no INTEGER, path TEXT, sha256 TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS user_input_answers ( input_id TEXT, question_id TEXT, option_key TEXT, answer_verbatim TEXT, preselected INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS snag ( id TEXT PRIMARY KEY, memo_id TEXT, title TEXT, status TEXT, verdict TEXT, disposition TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS goal ( id TEXT PRIMARY KEY, name TEXT, kind TEXT, pct INTEGER, status TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS maintenance_card ( repo TEXT PRIMARY KEY, freshness INTEGER, blast TEXT, maint_status TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS memo_section ( id TEXT PRIMARY KEY, heading TEXT, body TEXT, sort INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS memo_head ( field TEXT PRIMARY KEY, value TEXT, sort INTEGER )' )
    }


    // The CANONICAL pointer fixture, row for row the same state the core seed produces: one payload-backed
    // block table, one payload-backed diagram fed from it, and four research file edges covering
    // matched / mismatched / missing / unhashed in ONE render.
    const seedPointerCanonical = ( { render } ) => {
        writeFileSync( resolve( memoDir, 'context', 'table.json' ), TABLE_PAYLOAD, 'utf8' )
        writeFileSync( resolve( memoDir, 'context', 'diagram.mmd' ), TEMPLATE_BODY, 'utf8' )
        writeFileSync( resolve( projectRoot, 'context', 'matched.md' ), RESEARCH_BODY, 'utf8' )
        writeFileSync( resolve( projectRoot, 'context', 'drifted.md' ), '# drifted since it was measured\n', 'utf8' )
        writeFileSync( resolve( projectRoot, 'context', 'unmeasured.md' ), '# never measured\n', 'utf8' )

        const db = new DatabaseSync( dbPath )
        createSchema( { db, withPointerColumns: true } )
        db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at, context ) VALUES ( ?, ?, ?, ?, ?, ? )' )
            .run( 'M080', 'Externe Payload-Referenz', 'strategy', 'finalized', '2026-08-31T00:00:00.000Z', 'Die Klammer endet an der Datei-Grenze.' )
        db.prepare( 'INSERT INTO block ( id, title, sort ) VALUES ( ?, ?, ? )' ).run( 'B001', 'Zeiger', 1 )
        db.prepare( 'INSERT INTO block_tables ( id, block_id, title, tsv, render, payload_ref, payload_sha256 ) VALUES ( ?, ?, ?, ?, ?, ?, ? )' )
            .run( 'BT001', 'B001', 'Primitives', null, render === undefined ? null : render, 'context/table.json', digestOf( { text: TABLE_PAYLOAD } ) )
        db.prepare( 'INSERT INTO block_diagrams ( id, block_id, title, kind, `source`, feed, source_ref, source_sha256 ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ? )' )
            .run( 'BT001', 'B001', 'Flow', 'mermaid', null, 'BT001', 'context/diagram.mmd', digestOf( { text: TEMPLATE_BODY } ) )
        db.prepare( 'INSERT INTO research ( r_no, memo_id, title, kind, path ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 1, 'M080', 'Vier Zustaende', 'wave-1', null )
        const insertFile = db.prepare( 'INSERT INTO research_files ( r_no, path, sha256 ) VALUES ( ?, ?, ? )' )
        insertFile.run( 1, 'context/matched.md', digestOf( { text: RESEARCH_BODY } ) )
        insertFile.run( 1, 'context/drifted.md', 'c'.repeat( 64 ) )
        insertFile.run( 1, 'context/gone.md', 'd'.repeat( 64 ) )
        insertFile.run( 1, 'context/unmeasured.md', null )
        const insertHead = db.prepare( 'INSERT INTO memo_head ( field, value, sort ) VALUES ( ?, ?, ? )' )
        insertHead.run( 'Memo', 'M080', 0 )
        insertHead.run( 'Memo-Name', 'Externe Payload-Referenz', 1 )
        insertHead.run( 'Revision', '01', 2 )
        insertHead.run( 'Datum', '2026-08-31', 3 )
        insertHead.run( 'Status', 'finalized', 4 )
        db.close()
    }


    it( 'renders the pointer body byte-identical to the core fixture — payload pulled in, gaps named', () => {
        seedPointerCanonical( {} )

        const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

        expect( markdown ).toBe( POINTER_GOLDEN_BODY )

        // the INLINE pointers were pulled in THROUGH their checksum — not left empty
        expect( markdown ).toContain( '```tsv\nname\tstatus\ncommit\tok\n```' )
        expect( markdown ).toContain( '```mermaid\ngraph TD\n  commit --> ok\n```' )

        // the REFERENCE pointers: matched renders bare, every other state renders a NAMED gap
        const researchRow = markdown.split( '\n' ).find( ( line ) => line.startsWith( '| R1 |' ) )
        expect( researchRow ).toContain( 'context/matched.md' )
        expect( researchRow ).toContain( 'project:context/drifted.md (GAP: checksum mismatch)' )
        expect( researchRow ).toContain( 'project:context/gone.md (GAP: file missing)' )
        expect( researchRow ).toContain( 'project:context/unmeasured.md (GAP: never measured)' )
        expect( researchRow.split( 'context/' ).length - 1 ).toBe( 4 )      // compared 4 reference pointers
        expect( markdown ).not.toContain( '_no research_' )

        // hand-edit guard: the vendored fixture must hash to the manifest sha256 the CORE repo records,
        // so a doctored golden that would silently satisfy the equality above is caught here.
        const fixtureSha = createHash( 'sha256' ).update( POINTER_GOLDEN_BODY, 'utf8' ).digest( 'hex' )
        expect( fixtureSha ).toBe( POINTER_MANIFEST[ 'sha256' ] )
        expect( Buffer.byteLength( POINTER_GOLDEN_BODY, 'utf8' ) ).toBe( POINTER_MANIFEST[ 'byteLength' ] )
        // Measured after the heading-level change (Memo 080, PRD-R3 Vollausbau): 1857 bytes, two fewer than
        // the 1859 before, because the two `#### ` table/diagram headings became `### `. The figure is
        // re-measured, never carried over.
        expect( POINTER_MANIFEST[ 'byteLength' ] ).toBe( 1857 )             // compared 1857 bytes, > 0
    } )


    // The NEIGHBOURING presentation branch, not the noticed one: `memo block add-table` defaults the
    // authored kind to "table", so this is what a CLI-authored payload table renders as. The pointer
    // resolution may not hang on one branch, and the Markdown table must match the core render exactly.
    it( 'a payload-backed table authored as render "table" renders the Markdown table, not the fence', () => {
        seedPointerCanonical( { render: 'table' } )

        const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

        expect( markdown ).toContain( '| name | status |\n|---|---|\n| commit | ok |' )
        expect( markdown ).not.toContain( '```tsv' )                        // compared 2 render kinds
        // and the diagram fed FROM that same table still interpolates the pulled-in payload
        expect( markdown ).toContain( '```mermaid\ngraph TD\n  commit --> ok\n```' )
    } )


    it( 'a drifted inline payload ABORTS — never an empty table, never a stale one', () => {
        seedPointerCanonical( {} )
        writeFileSync( resolve( memoDir, 'context', 'table.json' ), '{"columns":["name","status"],"rows":[["commit","BROKEN"]]}', 'utf8' )

        // the throw is the CONTRACT: MemoView catches it and falls back to the frozen revision file.
        expect( () => DoltDbAssembler.assembleFromDb( { dbPath } ) ).toThrow( /mismatched/ )
        expect( () => DoltDbAssembler.assembleFromDb( { dbPath } ) ).toThrow( /context\/table\.json/ )
    } )


    it( 'a missing inline payload and a drifted diagram TEMPLATE abort as well — both branches', () => {
        seedPointerCanonical( {} )
        const db = new DatabaseSync( dbPath )
        db.prepare( 'UPDATE block_tables SET payload_ref = ? WHERE id = ?' ).run( 'context/never-written.json', 'BT001' )
        db.close()
        expect( () => DoltDbAssembler.assembleFromDb( { dbPath } ) ).toThrow( /missing/ )

        const second = new DatabaseSync( dbPath )
        second.prepare( 'UPDATE block_tables SET payload_ref = ? WHERE id = ?' ).run( 'context/table.json', 'BT001' )
        second.close()
        writeFileSync( resolve( memoDir, 'context', 'diagram.mmd' ), 'graph TD; A-->B', 'utf8' )
        expect( () => DoltDbAssembler.assembleFromDb( { dbPath } ) ).toThrow( /mismatched/ )   // compared 2 abort branches
    } )


    it( 'a database WITHOUT the pointer columns renders exactly as before — the additive degrade', () => {
        const db = new DatabaseSync( dbPath )
        createSchema( { db, withPointerColumns: false } )
        db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at, context ) VALUES ( ?, ?, ?, ?, ?, ? )' )
            .run( 'M080', 'Externe Payload-Referenz', 'strategy', 'finalized', '2026-08-31T00:00:00.000Z', 'Die Klammer endet an der Datei-Grenze.' )
        db.prepare( 'INSERT INTO block ( id, title, sort ) VALUES ( ?, ?, ? )' ).run( 'B001', 'Zeiger', 1 )
        db.prepare( 'INSERT INTO block_tables ( id, block_id, title, tsv ) VALUES ( ?, ?, ?, ? )' )
            .run( 'BT001', 'B001', 'Primitives', 'name\tstatus\ncommit\tok' )
        db.prepare( 'INSERT INTO block_diagrams ( id, block_id, title, kind, `source`, feed ) VALUES ( ?, ?, ?, ?, ?, ? )' )
            .run( 'M1', 'B001', 'Flow', 'mermaid', TEMPLATE_BODY, 'BT001' )
        db.close()

        const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

        expect( markdown ).toContain( '```tsv\nname\tstatus\ncommit\tok\n```' )
        expect( markdown ).toContain( '```mermaid\ngraph TD\n  commit --> ok\n```' )
        expect( markdown ).toContain( '## Research\n\n_no research_' )      // compared 1 table + 1 diagram
    } )


    // The register, not the case: the resolution reads PointerSites, so the viewer names no table of its
    // own. A one-sided edit that hard-codes a table name here would show up as a missing declaration.
    it( 'every pointer site the viewer resolves comes OUT of the register, not out of this file', () => {
        const source = readFileSync( resolve( process.cwd(), 'src', 'DoltDbAssembler.mjs' ), 'utf-8' )
        const resolverStart = source.indexOf( 'external payload pointers (Memo 080, PRD-D5)' )
        const resolverEnd = source.indexOf( 'ONE dataset table body' )
        const region = source.slice( resolverStart, resolverEnd )

        expect( resolverStart ).toBeGreaterThan( -1 )
        expect( resolverEnd ).toBeGreaterThan( resolverStart )
        // the three site lookups in the region all go through PointerSites.bySite via #site( { table } )
        const lookups = region.split( 'PointerSites.bySite' ).length - 1
        expect( lookups ).toBe( 1 )                                          // ONE lookup helper, 3 callers
        expect( region.split( '#site( { table:' ).length - 1 ).toBe( 3 )     // compared 3 declared sites used
    } )
} )


// ── Memo 080, PRD-R1 Vollausbau — the mirror carries the FORM, not only the sections ────────────
//
// The byte-parity fixture above already proves character equality for the canonical database. These
// cases name WHAT the mirror has to carry, so a future one-sided edit fails with a readable reason
// instead of a 4000-character diff: the declared document order, the toolkit body of a block, the
// contamination section and the seven head fields.
//
// EVERY CASE STATES HOW MUCH IT COMPARED. A comparison basis of 0 is asserted RED, never green.
describe( 'DoltDbAssembler — the document form (Memo 080, PRD-R1 Vollausbau)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let tmpRoot = ''
    let dbPath = ''

    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        tmpRoot = mkdtempSync( join( repoTmpRoot, 'form-' ) )
        dbPath = join( tmpRoot, 'memo-080.db' )
    } )

    afterEach( () => {
        rmSync( tmpRoot, { recursive: true, force: true } )
    } )


    const seedForm = ( { sections } ) => {
        const db = new DatabaseSync( dbPath )
        db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT, context TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_diagrams ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_section ( id TEXT PRIMARY KEY, block_id TEXT, name TEXT, body TEXT, sort INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS sessions ( session_id TEXT PRIMARY KEY, memo_id TEXT, parent_session_id TEXT, role TEXT, model TEXT, started_at TEXT, tokens INTEGER, tool_calls INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS memo_head ( field TEXT PRIMARY KEY, value TEXT, sort INTEGER )' )
        db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at, context ) VALUES ( ?, ?, ?, ?, ?, ? )' )
            .run( 'M080', 'Form', 'strategy', 'open', '2026-09-01T00:00:00.000Z', 'Kontext.' )
        db.prepare( 'INSERT INTO block ( id, title, sort ) VALUES ( ?, ?, ? )' ).run( 'B001', 'Form', 0 )
        const insertSection = db.prepare( 'INSERT INTO block_section ( id, block_id, name, body, sort ) VALUES ( ?, ?, ?, ?, ? )' )
        sections.forEach( ( entry ) => insertSection.run( `B001:${ entry[ 0 ] }`, 'B001', entry[ 0 ], entry[ 1 ], entry[ 2 ] ) )
        db.prepare( 'INSERT INTO sessions ( session_id, memo_id, parent_session_id, role, model, started_at, tokens, tool_calls ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ? )' )
            .run( 'sess-a', 'M080', null, 'orchestrator', 'opus', '2026-09-01T09:00:00.000Z', 100, 4 )
        const insertHead = db.prepare( 'INSERT INTO memo_head ( field, value, sort ) VALUES ( ?, ?, ? )' )
        insertHead.run( 'Typ', 'Full', 5 )
        insertHead.run( 'Aenderungen', 'Erstfassung', 6 )
        db.close()
    }


    it( 'renders the level-2 sequence in the DECLARED document order — the register decides, not the code path', () => {
        seedForm( { sections: [] } )

        const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )
        const emitted = markdown.split( '\n' )
            .filter( ( line ) => /^##\s/.test( line ) === true )
            .map( ( line ) => line.replace( /^##\s+/, '' ) )
        const declared = BlockSections.documentSections().sections
            .filter( ( entry ) => entry[ 'headings' ].length > 0 )
            .map( ( entry ) => entry[ 'headings' ][ 0 ] )
        const found = declared.filter( ( heading ) => emitted.includes( heading ) === true )

        expect( found.length ).toBe( declared.length )
        expect( found.length ).toBeGreaterThan( 0 )
        // the declared positions appear in the declared order, before every collective position
        const positionsInDoc = declared.map( ( heading ) => emitted.indexOf( heading ) )
        const ascending = positionsInDoc.filter( ( index, order ) => order === 0 || index > positionsInDoc[ order - 1 ] )
        expect( ascending.length ).toBe( positionsInDoc.length )
        expect( emitted.indexOf( 'Work Items' ) ).toBeGreaterThan( emitted.indexOf( 'Lessons-Learned' ) )
    } )


    it( 'renders the toolkit body of a block in register order and marks every empty mandatory heading', () => {
        seedForm( { sections: [ [ 'currentState', 'Gemessen.', 1 ], [ 'assessment', 'Bewertet.', 3 ] ] } )

        const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )
        const lines = markdown.split( '\n' )
        const start = lines.findIndex( ( line ) => line === '## Blocks' )
        const rest = lines.slice( start + 1 )
        const endOffset = rest.findIndex( ( line ) => /^##\s/.test( line ) === true )
        const headings = ( endOffset === -1 ? rest : rest.slice( 0, endOffset ) )
            .filter( ( line ) => /^###\s/.test( line ) === true )
            .map( ( line ) => line.replace( /^###\s+/, '' ) )
            .filter( ( heading ) => heading.startsWith( 'Form (' ) !== true )
        const registerOrder = BlockSections.all().sections
            .map( ( entry ) => entry[ 'heading' ] )
            .filter( ( heading ) => headings.includes( heading ) === true )

        expect( headings.length ).toBe( 8 )                    // 3 mandatory + 4 generated + 1 optional
        expect( headings ).toEqual( registerOrder )
        expect( markdown ).toContain( '### Ist-Zustand\n\nGemessen.' )
        expect( markdown ).toContain( '### User-Auftrag\n\n_kein Inhalt_' )
        expect( markdown ).toContain( '### Belege\n\n_kein Inhalt_' )
        // no fourth-level heading is produced by the toolkit render (a level 4 gets no anchor)
        expect( markdown.split( '\n' ).filter( ( line ) => /^####\s/.test( line ) === true ) ).toEqual( [] )
    } )


    it( 'renders the contamination section and the seven head fields, mirroring the core assembler', () => {
        seedForm( { sections: [] } )

        const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )
        const headRows = markdown.split( '\n' )
            .filter( ( line ) => /^\|\s\*\*[^*]+\*\*\s\|/.test( line ) === true )

        expect( headRows.length ).toBe( 7 )
        expect( markdown ).toContain( '| **Typ** | Full |' )
        expect( markdown ).toContain( '| **Aenderungen** | Erstfassung |' )
        expect( markdown ).toContain( '## Kontaminations-Metadaten\n\n| Session | Role | Model | Started | Tokens | Tool calls |' )
        expect( markdown ).toContain( '| sess-a | orchestrator | opus | 2026-09-01T09:00:00.000Z | 100 | 4 |' )
    } )


    it( 'aborts LOUD on a section heading outside the closed register — never a silent skip', () => {
        seedForm( { sections: [ [ 'erfunden', 'Inhalt, der sonst verschwindet', 99 ] ] } )

        expect( () => DoltDbAssembler.assembleFromDb( { dbPath } ) )
            .toThrow( /block "B001" section "erfunden".*permitted: userMandate, currentState, targetState/ )
    } )
} )


// ── Memo 080, PRD-R3 Vollausbau — the viewer mirror of the anchored 1:n render ───────────────────────
//
// The two renderers are held against each other byte for byte by the vendored revision-body-v1 fixture;
// this suite adds the BEHAVIOUR the fixture can only show once: several tables and diagrams per block, the
// section anchor, and the absence of the fourth heading level (which gets no anchor in this very viewer).
//
// EVERY CASE STATES HOW MUCH IT COMPARED.
describe( 'DoltDbAssembler — anchored tables and diagrams per block (Memo 080, PRD-R3 Vollausbau)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let memoDir = ''
    let dbPath = ''

    const seedAnchored = ( { path } ) => {
        const db = new DatabaseSync( path )
        db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT, render TEXT, sort INTEGER, section TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_diagrams ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT, sort INTEGER, section TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS block_section ( id TEXT PRIMARY KEY, block_id TEXT, name TEXT, body TEXT, sort INTEGER )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )

        db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'M080', 'Anker', 'Strategie', 'open', '2026-09-01T00:00:00Z' )
        db.prepare( 'INSERT INTO block ( id, title, sort ) VALUES ( ?, ?, ? )' ).run( 'B001', 'Anker', 0 )
        db.prepare( 'INSERT INTO block_section ( id, block_id, name, body, sort ) VALUES ( ?, ?, ?, ?, ? )' )
            .run( 'B001:targetState', 'B001', 'targetState', 'Der Soll-Satz.', 2 )

        const insertTable = db.prepare( 'INSERT INTO block_tables ( id, block_id, title, tsv, render, sort, section ) VALUES ( ?, ?, ?, ?, ?, ?, ? )' )
        insertTable.run( 'B001.d1', 'B001', 'Am Block', 'a\tb\n1\t2', 'table', 0, null )
        insertTable.run( 'B001.d2', 'B001', 'Im Abschnitt', 'c\td\n3\t4', 'table', 1, 'targetState' )
        const insertDiagram = db.prepare( 'INSERT INTO block_diagrams ( id, block_id, title, kind, `source`, feed, sort, section ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ? )' )
        insertDiagram.run( 'B001.g1', 'B001', 'Am Block', 'mermaid', 'graph TD', null, 0, null )
        insertDiagram.run( 'B001.g2', 'B001', 'Im Abschnitt', 'mermaid', 'graph LR', null, 1, 'targetState' )

        db.close()
    }

    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        memoDir = mkdtempSync( join( repoTmpRoot, 'memo-080-anchor-' ) )
        dbPath = resolve( memoDir, 'memo-080.db' )
    } )

    afterEach( () => {
        rmSync( memoDir, { recursive: true, force: true } )
    } )

    it( 'renders NO fourth-level heading and puts the anchored entries inside their section', () => {
        seedAnchored( { path: dbPath } )

        const { markdown } = DoltDbAssembler.assembleFromDb( { dbPath } )

        const lines = markdown.split( '\n' )
        const h4 = lines.filter( ( line ) => line.startsWith( '#### ' ) === true )
        const h3 = lines.filter( ( line ) => line.startsWith( '### ' ) === true )
        expect( h4 ).toEqual( [] )
        expect( h3.length ).toBeGreaterThan( 0 )                       // compared h3.length third-level headings

        const target = markdown.indexOf( '### Soll-Zustand' )
        const nextSection = markdown.indexOf( '### Topics' )
        const anchoredTable = markdown.indexOf( '| c | d |' )
        const anchoredDiagram = markdown.indexOf( 'graph LR' )
        const looseTable = markdown.indexOf( '| a | b |' )
        const looseDiagram = markdown.indexOf( 'graph TD' )
        expect( target ).toBeGreaterThan( -1 )
        expect( anchoredTable ).toBeGreaterThan( target )
        expect( anchoredTable ).toBeLessThan( nextSection )
        expect( anchoredDiagram ).toBeGreaterThan( target )
        expect( anchoredDiagram ).toBeLessThan( nextSection )
        expect( looseTable ).toBeGreaterThan( nextSection )
        expect( looseDiagram ).toBeGreaterThan( looseTable )
        // nothing is rendered twice — 2 tables and 2 diagrams compared
        expect( markdown.split( '| c | d |' ).length - 1 ).toBe( 1 )
        expect( markdown.split( 'graph LR' ).length - 1 ).toBe( 1 )
    } )

    it( 'aborts on an anchor outside the closed register, naming the row and the permitted set', () => {
        seedAnchored( { path: dbPath } )
        const db = new DatabaseSync( dbPath )
        db.prepare( 'UPDATE block_tables SET section = ? WHERE id = ?' ).run( 'erfunden', 'B001.d2' )
        db.close()

        expect( () => DoltDbAssembler.assembleFromDb( { dbPath } ) )
            .toThrow( /B001\.d2.*erfunden/ )
    } )
} )
