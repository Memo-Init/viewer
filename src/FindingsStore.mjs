// PRD-010 (Memo 011 Kap 9) — per-memo append-only Findings-Store (fan-out shared memory).
//
// Purpose (§7.3, Memo 007 REV-03): parallel subagents share findings so they do not re-discover
// the same thing and do not overwrite each other. The orchestrator generates the Hash-IDs and hands
// them to each subagent via the initial prompt; the subagent always writes with that ID through the
// CLI gate; duplicate IDs are rejected (reducer-merge per ID) -> no re-discovery, no overwrite.
//
// Storage: a per-memo `findings.db` (node:sqlite, built into Node 22), WAL mode, server-less and
// in-process. APPEND-ONLY: the only SQL ever issued is CREATE TABLE / PRAGMA / INSERT / SELECT.
// No row-mutating or row-removing SQL exists anywhere in this module — that is a HARD assertion of
// the PRD (the source-grep must come up empty). The CLI gate (bin/memo-findings.mjs) is the ONLY writer.
//
// No for/while loops — array methods only. No semicolons, 4-space indent, single quotes, object
// returns (~/.claude/CLAUDE.md, node-formatting).

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { access } from 'node:fs/promises'


const SCHEMA_VERSION = 1
const DB_FILE = 'findings.db'


class FindingsStore {
    // Resolve the per-memo db path from a memo directory. Kept separate so tests and the CLI agree
    // on exactly one location: <memoPath>/findings.db.
    static dbPath( { memoPath } ) {
        const path = join( memoPath, DB_FILE )

        return { path }
    }


    // Deterministic Hash-ID helper. The orchestrator is the ID source per §7.3, but the store ships
    // the same hashing the orchestrator should use so IDs are reproducible and dedup-able: a 16-char
    // hex prefix of sha256( thread + NUL + payload ). The separator is the NUL char written as the
    // escape '\x00' (source stays plain ASCII text — never a literal null byte in the file) so that
    // it cannot occur inside thread/payload and field boundaries are unambiguous. Same thread+payload
    // -> same ID -> dedup.
    static hashId( { thread, payload } ) {
        const material = `${ String( thread ) }\x00${ String( payload ) }`
        const id = createHash( 'sha256' )
            .update( material )
            .digest( 'hex' )
            .slice( 0, 16 )

        return { id }
    }


    // US-1: initialize <memoPath>/findings.db with WAL mode and the append-only schema.
    // NO-OVERWRITE: if findings.db already exists it is NOT clobbered -> { status: 'exists', path }.
    // Returns an object { status, path, schemaVersion } (never a primitive).
    static async init( { memoPath } ) {
        const { path } = FindingsStore.dbPath( { memoPath } )
        const present = await FindingsStore.#exists( { filePath: path } )

        if( present === true ) {
            return { status: 'exists', path, schemaVersion: SCHEMA_VERSION }
        }

        const db = new DatabaseSync( path )

        try {
            db.exec( 'PRAGMA journal_mode=WAL' )
            db.exec( FindingsStore.#createTableSql() )
        } finally {
            db.close()
        }

        return { status: 'created', path, schemaVersion: SCHEMA_VERSION }
    }


    // US-2: append exactly one finding with the orchestrator-assigned Hash-ID.
    // - missing id -> error envelope { status:'error', error:'MEMO-FND-001 id required', fix }, NO insert.
    // - duplicate id -> { status:'duplicate', id }, row-count unchanged (reducer-merge per ID).
    // - success -> { status:'inserted', id }.
    // Uses INSERT OR IGNORE on the PRIMARY KEY for atomic dedup, then checks the change count.
    static put( { memoPath, id, thread, author, payload } ) {
        if( typeof id !== 'string' || id.trim().length === 0 ) {
            return {
                status: 'error',
                error: 'MEMO-FND-001 id required',
                fix: 'pass --id <hash> (orchestrator-generated)'
            }
        }

        const { path } = FindingsStore.dbPath( { memoPath } )
        const db = new DatabaseSync( path )

        try {
            db.exec( 'PRAGMA journal_mode=WAL' )
            db.exec( FindingsStore.#createTableSql() )

            const createdAt = new Date().toISOString()
            const statement = db.prepare(
                'INSERT OR IGNORE INTO findings (id, thread, author, payload, created_at) VALUES (?, ?, ?, ?, ?)'
            )
            const result = statement.run(
                id,
                thread === undefined ? null : thread,
                author === undefined ? null : author,
                payload === undefined ? null : payload,
                createdAt
            )

            const { changes } = result
            const inserted = Number( changes ) === 1

            return inserted === true
                ? { status: 'inserted', id }
                : { status: 'duplicate', id }
        } finally {
            db.close()
        }
    }


    // US-3: read shared findings, optionally filtered by thread. SELECT only.
    // Deterministic order (created_at, id). Returns { status, count, items }.
    static get( { memoPath, thread } ) {
        const { path } = FindingsStore.dbPath( { memoPath } )
        const db = new DatabaseSync( path )

        try {
            db.exec( FindingsStore.#createTableSql() )

            const hasThread = typeof thread === 'string' && thread.length > 0
            const sql = hasThread === true
                ? 'SELECT id, thread, author, payload, created_at FROM findings WHERE thread = ? ORDER BY created_at, id'
                : 'SELECT id, thread, author, payload, created_at FROM findings ORDER BY created_at, id'

            const statement = db.prepare( sql )
            const rows = hasThread === true ? statement.all( thread ) : statement.all()
            const items = rows
                .map( ( row ) => {
                    const { id, author, payload } = row
                    const createdAt = row[ 'created_at' ]
                    const rowThread = row[ 'thread' ]

                    return { id, thread: rowThread, author, payload, createdAt }
                } )

            return { status: 'ok', count: items.length, items }
        } finally {
            db.close()
        }
    }


    // The single append-only schema. Idempotent (IF NOT EXISTS) so put/get can self-heal a fresh db.
    static #createTableSql() {
        const sql = 'CREATE TABLE IF NOT EXISTS findings ('
            + ' id TEXT PRIMARY KEY,'
            + ' thread TEXT,'
            + ' author TEXT,'
            + ' payload TEXT,'
            + ' created_at TEXT'
            + ' )'

        return sql
    }


    static async #exists( { filePath } ) {
        try {
            await access( filePath )

            return true
        } catch( error ) {
            return false
        }
    }
}


export { FindingsStore, SCHEMA_VERSION }
