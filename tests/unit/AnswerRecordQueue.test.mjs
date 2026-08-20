import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { MemoView } from '../../src/MemoView.mjs'


// Memo 079 PRD-22 #4 (WI-044): a revision must LEAVE the open-questions queue once its questions have
// an answer record — whether answered via the review widget OR typed in the terminal (the SAME
// user_input_answers row is written by the single-writer). Before this a terminal answer left no
// transcript file / `.loggedin` marker and the revision stayed 'offen' forever (forensics b5, the
// Karteileichen root). This suite drives the REAL DocumentRegistry + the REAL queue join
// (MemoView.enrichRevisionStatus -> #markAnsweredRevisions -> computeOpenRevisionQueue). Writes go ONLY
// into a repo-internal temp dir (.test-tmp/), never the real .memo/ or the user home.
describe( 'Answer records drop a revision from the queue — Memo 079 PRD-22 #4', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let root = ''
    // Every addDocument attaches an fs.watch watcher — track + shut down so no worker leaks.
    const registries = []


    const trackedRegistry = () => {
        const { registry } = DocumentRegistry.create( {} )
        registries.push( registry )

        return registry
    }


    const revBody = [
        '# Memo', '',
        '| Feld | Wert |', '| --- | --- |', '| **Status** | In Bearbeitung |', '',
        '## Offene Fragen', '', '### F1 — Eine offene Frage', '', 'Kontext.', ''
    ].join( '\n' )


    // Seed a DB-first memo folder: a REV-01.md file plus a memo-079.db carrying the question table and
    // (optionally) user_input_answers records. lifecycle keeps the memo non-finalized so it is
    // queue-eligible. Returns the revisions/ path addDocument expects.
    const seedDbMemo = ( { slug, questions, answers } ) => {
        const memoDir = join( root, slug )
        const revDir = join( memoDir, 'revisions' )
        mkdirSync( revDir, { recursive: true } )
        writeFileSync( join( revDir, 'REV-01.md' ), revBody, 'utf8' )

        const db = new DatabaseSync( resolve( memoDir, 'memo-079.db' ) )
        db.exec( 'CREATE TABLE IF NOT EXISTS lifecycle ( state TEXT, `at` TEXT, `by` TEXT, evidence TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT )' )
        db.exec( 'CREATE TABLE IF NOT EXISTS user_input_answers ( input_id TEXT, question_id TEXT, option_key TEXT, answer_verbatim TEXT, preselected INTEGER )' )
        db.prepare( 'INSERT INTO lifecycle ( state, `at`, `by`, evidence ) VALUES ( ?, ?, ?, ? )' )
            .run( 'in-revision', '2026-08-20T00:00:00Z', 'lead', 'seed' )
        questions
            .forEach( ( q ) => {
                db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' )
                    .run( q.id, 'M079', q.id, 'info', q.status )
            } )
        ;( answers || [] )
            .forEach( ( questionId ) => {
                db.prepare( 'INSERT INTO user_input_answers ( input_id, question_id, option_key, answer_verbatim, preselected ) VALUES ( ?, ?, ?, ?, ? )' )
                    .run( 'UI-0001', questionId, null, 'geantwortet', 0 )
            } )
        db.close()

        return revDir
    }


    // Seed a plain file-only memo (no db) — the 383-legacy path, untouched by the answer-record join.
    const seedFileMemo = ( { slug } ) => {
        const revDir = join( root, slug, 'revisions' )
        mkdirSync( revDir, { recursive: true } )
        writeFileSync( join( revDir, 'REV-01.md' ), revBody, 'utf8' )

        return revDir
    }


    const queueMemoNames = ( { registry } ) => {
        const { tree } = registry.getDocumentTree()
        MemoView.enrichRevisionStatus( { tree, transcriptTree: {} } )
        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

        return queue.map( ( pair ) => pair.doc.memoName )
    }


    beforeEach( () => {
        mkdirSync( repoTmpRoot, { recursive: true } )
        root = mkdtempSync( join( repoTmpRoot, 'answer-queue-' ) )
    } )

    afterEach( () => {
        registries.forEach( ( registry ) => registry.shutdown() )
        registries.length = 0
        rmSync( root, { recursive: true, force: true } )
    } )


    // ── isInQueue unit contract: the joined per-revision flag drops the revision ──
    it( 'isInQueue drops a revision whose answeredComplete flag is set; keeps it otherwise', () => {
        expect( DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen', answeredComplete: true } } ).inQueue ).toBe( false )
        expect( DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen', answeredComplete: false } } ).inQueue ).toBe( true )
        expect( DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen' } } ).inQueue ).toBe( true )
    } )


    it( 'a DB memo whose open questions ALL have an answer record leaves the queue', async () => {
        const registry = trackedRegistry()
        const revDir = seedDbMemo( { slug: '079-all-answered', questions: [ { id: 'F1', status: 'open' }, { id: 'F2', status: 'open' } ], answers: [ 'F1', 'F2' ] } )
        await registry.addDocument( { projectId: 'proj', memoPath: revDir } )

        // The counts reflect the folded answer records (open=0), and the revision is out of the queue.
        const { document } = registry.getDocument( { documentId: 'proj--079-all-answered' } )
        expect( document.questions ).toEqual( { open: 0, answered: 2 } )
        expect( document.answerRecordsComplete ).toBe( true )
        expect( queueMemoNames( { registry } ) ).toEqual( [] )
    } )


    it( 'a DB memo with only a PARTIAL answer record stays in the queue (honestly open)', async () => {
        const registry = trackedRegistry()
        const revDir = seedDbMemo( { slug: '079-partial', questions: [ { id: 'F1', status: 'open' }, { id: 'F2', status: 'open' } ], answers: [ 'F1' ] } )
        await registry.addDocument( { projectId: 'proj', memoPath: revDir } )

        const { document } = registry.getDocument( { documentId: 'proj--079-partial' } )
        expect( document.questions ).toEqual( { open: 1, answered: 1 } )
        expect( document.answerRecordsComplete ).toBe( false )
        expect( queueMemoNames( { registry } ) ).toEqual( [ '079-partial' ] )
    } )


    it( 'the additive-dedup holds: a record for an already-answered question does not double-count', async () => {
        const registry = trackedRegistry()
        // F1 open (record clears it), F2 open (no record — honest open), F3 already answered (record = dedup).
        const revDir = seedDbMemo( {
            slug: '079-dedup',
            questions: [ { id: 'F1', status: 'open' }, { id: 'F2', status: 'open' }, { id: 'F3', status: 'answered' } ],
            answers: [ 'F1', 'F3' ]
        } )
        await registry.addDocument( { projectId: 'proj', memoPath: revDir } )

        const { document } = registry.getDocument( { documentId: 'proj--079-dedup' } )
        expect( document.questions ).toEqual( { open: 1, answered: 2 } )
        expect( document.answerRecordsComplete ).toBe( false )
        expect( queueMemoNames( { registry } ) ).toEqual( [ '079-dedup' ] )
    } )


    it( 'a file-only memo (no db, no answer records) is unaffected and stays in the queue', async () => {
        const registry = trackedRegistry()
        const revDir = seedFileMemo( { slug: '079-file' } )
        await registry.addDocument( { projectId: 'proj', memoPath: revDir } )

        const { document } = registry.getDocument( { documentId: 'proj--079-file' } )
        expect( document.answerRecordsComplete ).toBe( false )
        expect( queueMemoNames( { registry } ) ).toEqual( [ '079-file' ] )
    } )
} )
