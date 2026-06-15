// PRD-010 (Memo 011 Kap 9) — per-memo append-only Findings-Store (fan-out shared memory).
//
// Purpose (§7.3, Memo 007 REV-03): parallel subagents share findings so they do not re-discover
// the same thing and do not overwrite each other. The orchestrator generates the Hash-IDs and hands
// them to each subagent via the initial prompt; the subagent always writes with that ID through the
// CLI gate; duplicate IDs are rejected (reducer-merge per ID) -> no re-discovery, no overwrite.
//
// Storage: a per-memo `findings.db` (node:sqlite, built into Node 22), WAL mode, server-less and
// in-process. APPEND-ONLY: the only SQL ever issued is CREATE TABLE / ALTER TABLE ADD COLUMN /
// PRAGMA / INSERT / SELECT. No row-mutating or row-removing SQL exists anywhere in this module —
// that is a HARD assertion of the PRD (the source-grep must come up empty). The CLI gate
// (bin/memo-findings.mjs) is the ONLY writer.
//
// PRD-013 (Memo 014 Kap 10) — identity half added ADDITIVELY: rooms/users tables (secret_hash),
// topic/done columns on findings, and a write-own gate in put(). register() mints a strong random
// secret once; verify() checks sha256(secret) against the stored hash; a put() carrying auth context
// (room+username+secret) sets author SERVER-SIDE from the verified user (a passed author is ignored).
// get() stays creds-free read-all. ADD COLUMN is schema migration, not a row mutation; done is set
// at INSERT time only (no row-mutating SQL) — the append-only contract is preserved. No salt/PBKDF
// here (local, non-public chatroom; the memo only requires a hash check) — possible follow-up.
//
// No for/while loops — array methods only. No semicolons, 4-space indent, single quotes, object
// returns (~/.claude/CLAUDE.md, node-formatting).

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
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
    //
    // PRD-013 write-own gate: when an auth context is present (room + username + secret all given),
    // the secret is verified against the stored hash. On a failed/missing-user check -> error envelope
    // and NO insert. On success the author is set SERVER-SIDE from the verified username; any passed
    // `author` is ignored. Without an auth context the legacy behaviour is unchanged (author is the
    // passed self-report). topic is an optional column; done is a flag set at INSERT time only (no
    // row-mutating SQL), defaulting to 0.
    static put( { memoPath, id, thread, author, payload, room, username, secret, topic, done } ) {
        if( typeof id !== 'string' || id.trim().length === 0 ) {
            return {
                status: 'error',
                error: 'MEMO-FND-001 id required',
                fix: 'pass --id <hash> (orchestrator-generated)'
            }
        }

        const hasAuth = [ room, username, secret ]
            .every( ( field ) => typeof field === 'string' && field.length > 0 )
        const effectiveAuthor = author

        if( hasAuth === true ) {
            const { status } = FindingsStore.verify( { memoPath, room, username, secret } )

            if( status !== true ) {
                return {
                    status: 'error',
                    error: 'MEMO-FND-003 auth failed',
                    fix: 'register first, then pass --room/--username/--secret with the issued secret'
                }
            }
        }

        const writeAuthor = hasAuth === true ? username : effectiveAuthor
        const { path } = FindingsStore.dbPath( { memoPath } )
        const db = new DatabaseSync( path )

        try {
            db.exec( 'PRAGMA journal_mode=WAL' )
            db.exec( FindingsStore.#createTableSql() )
            FindingsStore.#ensureFindingColumns( { db } )

            const createdAt = new Date().toISOString()
            const doneFlag = done === true || done === 1 || done === '1' ? 1 : 0
            const statement = db.prepare(
                'INSERT OR IGNORE INTO findings (id, thread, author, payload, topic, done, created_at)'
                    + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
            )
            const result = statement.run(
                id,
                thread === undefined ? null : thread,
                writeAuthor === undefined ? null : writeAuthor,
                payload === undefined ? null : payload,
                topic === undefined ? null : topic,
                doneFlag,
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


    // PRD-013: hash a plaintext secret. sha256 hex, matching the createHash('sha256') pattern used by
    // hashId. Object return { hash } (never a primitive).
    static hashSecret( { secret } ) {
        const hash = createHash( 'sha256' )
            .update( String( secret ) )
            .digest( 'hex' )

        return { hash }
    }


    // PRD-013: register a user in a room with a freshly minted, strong random secret.
    // - Creates the room (CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE on the room name).
    // - Generates the secret via crypto.randomBytes (32 bytes -> 64 hex chars), stores ONLY its
    //   sha256 hash, and returns the plaintext secret EXACTLY ONCE -> { status:'registered', room,
    //   username, secret }.
    // - If the (room, username) pair already exists, INSERT OR IGNORE is a no-op and we report
    //   { status:'exists', room, username } WITHOUT a secret (the original secret cannot be recovered).
    static register( { memoPath, room, username } ) {
        const validRoom = typeof room === 'string' && room.trim().length > 0
        const validUser = typeof username === 'string' && username.trim().length > 0

        if( validRoom === false || validUser === false ) {
            return {
                status: 'error',
                error: 'MEMO-FND-004 room and username required',
                fix: 'pass --room <name> and --username <name>'
            }
        }

        const secret = randomBytes( 32 ).toString( 'hex' )
        const { hash } = FindingsStore.hashSecret( { secret } )
        const { path } = FindingsStore.dbPath( { memoPath } )
        const db = new DatabaseSync( path )

        try {
            db.exec( 'PRAGMA journal_mode=WAL' )
            db.exec( FindingsStore.#createRoomsSql() )
            db.exec( FindingsStore.#createUsersSql() )

            const createdAt = new Date().toISOString()
            db.prepare( 'INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)' )
                .run( room, createdAt )

            const result = db.prepare(
                'INSERT OR IGNORE INTO users (room_id, username, secret_hash, created_at)'
                    + ' VALUES (?, ?, ?, ?)'
            ).run( room, username, hash, createdAt )

            const created = Number( result[ 'changes' ] ) === 1

            return created === true
                ? { status: 'registered', room, username, secret }
                : { status: 'exists', room, username }
        } finally {
            db.close()
        }
    }


    // PRD-013: verify a plaintext secret against the stored sha256 hash for (room, username).
    // SELECT only. Returns { status: true } on a match, { status: false } on a mismatch or an unknown
    // user. Used by the put() write-own gate.
    static verify( { memoPath, room, username, secret } ) {
        const { path } = FindingsStore.dbPath( { memoPath } )
        const db = new DatabaseSync( path )

        try {
            db.exec( FindingsStore.#createRoomsSql() )
            db.exec( FindingsStore.#createUsersSql() )

            const row = db.prepare(
                'SELECT secret_hash FROM users WHERE room_id = ? AND username = ?'
            ).get( room, username )

            if( row === undefined || row === null ) {
                return { status: false }
            }

            const { hash } = FindingsStore.hashSecret( { secret } )
            const stored = row[ 'secret_hash' ]

            return { status: stored === hash }
        } finally {
            db.close()
        }
    }


    // US-3: read shared findings, optionally filtered by thread. SELECT only. read-all, NO creds
    // (the write-own gate is on put, not get). Deterministic order (created_at, id). Returns
    // { status, count, items }. PRD-013 adds topic/done to each item (additive — older rows read
    // back as topic: null, done: 0).
    static get( { memoPath, thread } ) {
        const { path } = FindingsStore.dbPath( { memoPath } )
        const db = new DatabaseSync( path )

        try {
            db.exec( FindingsStore.#createTableSql() )
            FindingsStore.#ensureFindingColumns( { db } )

            const hasThread = typeof thread === 'string' && thread.length > 0
            const columns = 'id, thread, author, payload, topic, done, created_at'
            const sql = hasThread === true
                ? `SELECT ${ columns } FROM findings WHERE thread = ? ORDER BY created_at, id`
                : `SELECT ${ columns } FROM findings ORDER BY created_at, id`

            const statement = db.prepare( sql )
            const rows = hasThread === true ? statement.all( thread ) : statement.all()
            const items = rows
                .map( ( row ) => {
                    const { id, author, payload, topic } = row
                    const createdAt = row[ 'created_at' ]
                    const rowThread = row[ 'thread' ]
                    const done = Number( row[ 'done' ] ) === 1

                    return { id, thread: rowThread, author, payload, topic, done, createdAt }
                } )

            return { status: 'ok', count: items.length, items }
        } finally {
            db.close()
        }
    }


    // The single append-only schema. Idempotent (IF NOT EXISTS) so put/get can self-heal a fresh db.
    // PRD-013: topic/done declared here for fresh dbs; #ensureFindingColumns migrates older dbs.
    static #createTableSql() {
        const sql = 'CREATE TABLE IF NOT EXISTS findings ('
            + ' id TEXT PRIMARY KEY,'
            + ' thread TEXT,'
            + ' author TEXT,'
            + ' payload TEXT,'
            + ' topic TEXT,'
            + ' done INTEGER DEFAULT 0,'
            + ' created_at TEXT'
            + ' )'

        return sql
    }


    // PRD-013: rooms table — one row per chatroom, keyed by its name. CREATE TABLE IF NOT EXISTS so
    // register/verify can self-heal a fresh db (same idempotent pattern as #createTableSql).
    static #createRoomsSql() {
        const sql = 'CREATE TABLE IF NOT EXISTS rooms ('
            + ' name TEXT PRIMARY KEY,'
            + ' created_at TEXT'
            + ' )'

        return sql
    }


    // PRD-013: users table — one row per (room, user). secret_hash holds the sha256 of the minted
    // secret (the plaintext is shown once at register time and never persisted). Composite PRIMARY
    // KEY (room_id, username) so re-register is an INSERT OR IGNORE no-op (-> { status:'exists' }).
    static #createUsersSql() {
        const sql = 'CREATE TABLE IF NOT EXISTS users ('
            + ' room_id TEXT,'
            + ' username TEXT,'
            + ' secret_hash TEXT,'
            + ' created_at TEXT,'
            + ' PRIMARY KEY ( room_id, username )'
            + ' )'

        return sql
    }


    // PRD-013: idempotent schema migration for findings dbs created before topic/done existed.
    // ADD COLUMN is a schema change, NOT a row mutation — it leaves every existing row untouched
    // (the append-only contract holds; no row is rewritten or removed). The PRAGMA tells us which
    // columns already exist; a missing one is added via ADD COLUMN. Wrapped in try/catch so a race
    // (another writer adding the same column) is harmless.
    static #ensureFindingColumns( { db } ) {
        const present = db.prepare( 'PRAGMA table_info( findings )' )
            .all()
            .map( ( row ) => row[ 'name' ] )
        const wanted = [
            { name: 'topic', ddl: 'ALTER TABLE findings ADD COLUMN topic TEXT' },
            { name: 'done', ddl: 'ALTER TABLE findings ADD COLUMN done INTEGER DEFAULT 0' }
        ]

        wanted
            .filter( ( column ) => present.includes( column[ 'name' ] ) === false )
            .forEach( ( column ) => {
                try {
                    db.exec( column[ 'ddl' ] )
                } catch( error ) {
                    const ignored = error
                }
            } )

        return { status: 'ok' }
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
