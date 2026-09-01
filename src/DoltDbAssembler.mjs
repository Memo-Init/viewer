// DoltDbAssembler.mjs — the viewer's DB-schaufenster (Memo 079, P6a).
//
// The viewer reads a per-memo `memo-NNN.db` and renders the SAME deterministic Markdown string that
// the core RevisionAssembler freezes into a REV file. This is the "Zwei-Regime" weiche (F16): a new
// memo that carries a per-memo database is rendered DB-first here; the 383 file-parsed legacy memos
// keep their existing registry/parse path untouched.
//
// The FULL render is a PURE function of the database rows and stays byte-identical to
// wt-core-079/cli/src/RevisionAssembler.mjs #renderBody and its section renderers, so the DB view and the
// assembled REV never diverge. Same SQL, same ORDER BY, same escaping, same fence formatting. The sections
// — the head table, Kontext, Vorwort, Work Items, Blocks (+diagrams), Topics, Phasen, Phase-Hints, Research,
// Snags, Goals, Maintenance, Fragen (questions-json fence), Offene Fragen, Beantwortete Fragen,
// Finalisierungs-Checkliste, Ancillary Files, Rollout-Entry-Points, Lessons-Learned — match the core
// assembler one-for-one. The header (`<!-- assembled-revision ... -->`) is deliberately NOT
// emitted here — it is the assemble-time wrapper; this class returns the hashed BODY only.
//
// Memo 079 broad build-out (PRD-16): the questions sections are now emitted by the CORE assembler too, so
// a frozen REV file carries the same `## Fragen` + `## Offene Fragen` this class renders for HEAD — the
// viewer is no longer an enrichment ahead of the core. The read-only Tag-Grenze below still routes older
// revisions to their frozen file, so a historical stand is served from disk, byte-identical to what this
// render produced when it was frozen.
//
// Read-only Tag-Grenze (doltlite 0.11.46): this schaufenster opens the db READ-ONLY. doltlite at that
// version has NO `AS OF` and cannot branch-from-tag without a WRITE, so a historical tag stand can NOT
// be rendered read-only. Therefore only the newest (== HEAD) revision is assembled from the db here;
// readLatestRevisionNo lets the caller gate on that.
//
// The viewer has no access to the core DoltStore class, so the doltlite handle is opened locally via
// DatabaseSync (node:sqlite-compatible). `source` is a reserved word and is backtick-quoted.
//
// Class architecture per node-class-architecture: static-only, object params, object returns,
// private-by-default, NO SILENT DEFAULTS (every missing argument fails loud), no for/while loops.

import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'


// A per-memo database file is named `memo-<NNN>.db` (e.g. memo-079.db) — the Zwei-Regime marker.
const DB_NAME_PATTERN = /^memo-\d+\.db$/


// Escape a nullable database value for a Markdown table cell (pipes + newlines would break the grid).
// A null/undefined column renders as an empty cell — an explicit display choice, not a silent default.
const cell = ( value ) => {
    const text = value === null || value === undefined ? '' : String( value )

    return text
        .replace( /\|/g, '\\|' )
        .replace( /\r?\n/g, ' ' )
}


// Render a nullable value verbatim (for fenced blocks where escaping would corrupt the payload).
const raw = ( value ) => {
    return value === null || value === undefined ? '' : String( value )
}


// The fence language of a block_diagram is its `kind`; only these two are legal (fail-loud on any
// other value — a diagram with an unknown kind is a hard error, never a silent skip).
const DIAGRAM_KINDS = [ 'mermaid', 'vega-lite' ]


// The six mandatory prose sections rendered from the `memo_section` carrier and the five mandatory head
// fields rendered from `memo_head` (Memo 080, PRD-R1). Byte-identical to RevisionAssembler (core): same
// headings, same order, same empty mark — a one-sided change fails the hash-gated parity fixture.
const PROSE_EMPTY = '_kein Inhalt_'

const HEAD_FIELDS = [ 'Memo', 'Memo-Name', 'Revision', 'Datum', 'Status' ]


// The visible generation note + the scope line of the head (Memo 080, PRD-R2 / WI-025). Byte-identical to
// RevisionAssembler (core): same wording, same label, same carrier order — a one-sided change fails the
// hash-gated parity fixture. Both lines are a PURE function of the content rows: no clock, no commit hash,
// and no count of `revision` / `provenance` / `history_journal` (those are written after the render, so
// counting them would make the frozen body drift on the next verify).
const GENERATED_NOTE = '_Generated from the memo database — not hand-written._'

const SCOPE_LABEL = '**Scope:**'

const SCOPE_CARRIERS = [
    { key: 'blocks', table: 'block', where: null },
    { key: 'topics', table: 'topic', where: null },
    { key: 'work items', table: 'work_item', where: null },
    { key: 'questions', table: 'question', where: null },
    { key: 'phases', table: 'rollout_phase', where: "id != '__state__'" },
    { key: 'phase items', table: 'rollout_work_item', where: null }
]


// Memo 079 PRD-22 (#4): normalize a question identifier for cross-source dedup. The `question` table
// `id` and the `user_input_answers` `question_id` are both the `F<N>` token (DoltSchema); trimming +
// upper-casing lets the answer-record source dedup against the open-question ids case/whitespace-safe.
// A null/undefined id collapses to '' (an unidentifiable question can never be matched by a record —
// it stays honestly open, never silently cleared).
const normalizeQuestionId = ( value ) => {
    return value === null || value === undefined ? '' : String( value ).trim().toUpperCase()
}


// Memo 080, PRD-V1 (WI-101) — the raw-table schaufenster. The per-memo database carries cells with very
// large payloads (`block_tables.tsv`, transcript full texts, the JSON overflow columns of rollout_phase /
// rollout_work_item), so a table page is bounded on THREE axes before it reaches the client:
//   * CELL_TRUNCATE_LIMIT   — a single cell is cut at this many characters and MARKED as cut
//   * TABLE_PAGE_DEFAULT_LIMIT — the page size when the caller names none
//   * TABLE_PAGE_MAX_LIMIT  — the hard ceiling; a larger requested limit is REJECTED, never silently capped
const CELL_TRUNCATE_LIMIT = 2000

const TABLE_PAGE_DEFAULT_LIMIT = 100

const TABLE_PAGE_MAX_LIMIT = 500


// Cut an over-long cell for transport and say so. Returns the ORIGINAL length too, so a reader (and a
// test) can see how much was withheld instead of guessing. A null/undefined cell stays null — an empty
// cell and a cut cell are different facts and must not collapse into the same rendering.
const truncateCell = ( value ) => {
    if( value === null || value === undefined ) {
        return { 'value': null, 'truncated': false, 'length': 0 }
    }

    const text = String( value )

    if( text.length <= CELL_TRUNCATE_LIMIT ) {
        return { 'value': text, 'truncated': false, 'length': text.length }
    }

    return { 'value': text.slice( 0, CELL_TRUNCATE_LIMIT ), 'truncated': true, 'length': text.length }
}


class DoltDbAssembler {
    static assembleFromDb( { dbPath } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.assembleFromDb: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.assembleFromDb: "${ dbPath }" does not exist — cannot open the per-memo database` )
        }

        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            const markdown = DoltDbAssembler.#renderBody( { db } )

            return { markdown }
        } finally {
            db.close()
        }
    }


    static hasDb( { memoDir } ) {
        if( typeof memoDir !== 'string' || memoDir.length === 0 ) {
            throw new Error( 'DoltDbAssembler.hasDb: "memoDir" is required (non-empty string)' )
        }

        // A missing directory is a legitimate "no db" answer for the weiche (not a silent default).
        if( existsSync( memoDir ) !== true ) {
            return { hasDb: false }
        }

        const hasDb = readdirSync( memoDir )
            .some( ( entry ) => DB_NAME_PATTERN.test( entry ) === true )

        return { hasDb }
    }


    // Resolve the absolute path of the per-memo `memo-NNN.db` inside a memo folder. The Zwei-Regime
    // weiche (MemoView serve path / DocumentRegistry badge) calls hasDb first; this leaf then turns
    // the marker into a concrete path. Fail-loud when the folder is missing or carries no db file
    // (NO SILENT DEFAULTS) — a caller must gate on hasDb before resolving.
    static resolveDbPath( { memoDir } ) {
        if( typeof memoDir !== 'string' || memoDir.length === 0 ) {
            throw new Error( 'DoltDbAssembler.resolveDbPath: "memoDir" is required (non-empty string)' )
        }
        if( existsSync( memoDir ) !== true ) {
            throw new Error( `DoltDbAssembler.resolveDbPath: "${ memoDir }" does not exist — cannot locate a per-memo database` )
        }

        const entry = readdirSync( memoDir )
            .find( ( name ) => DB_NAME_PATTERN.test( name ) === true )
        if( entry === undefined ) {
            throw new Error( `DoltDbAssembler.resolveDbPath: no memo-NNN.db in "${ memoDir }" — gate on hasDb before resolving` )
        }

        return { dbPath: resolve( memoDir, entry ) }
    }


    // Read the CURRENT lifecycle stage of a per-memo database (Memo 079, PRD-21). The DB `lifecycle`
    // table is APPEND-ONLY (state, at, by, evidence), so the last appended row is the current state —
    // `ORDER BY rowid DESC LIMIT 1` mirrors the core LifecycleStore.deriveState "events[last]" rule.
    // An empty table (a fresh db with no lifecycle event yet) returns state:null — the caller decides
    // the display fallback; this leaf never invents a stage. Read-only open (the schaufenster never
    // mutates). Same reserved-word care as assembleFromDb (none needed here; `state` is not reserved).
    static readLifecycleState( { dbPath } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readLifecycleState: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readLifecycleState: "${ dbPath }" does not exist — cannot read the lifecycle table` )
        }

        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            const row = DoltDbAssembler.#get( { db, sql: 'SELECT state FROM lifecycle ORDER BY rowid DESC LIMIT 1' } )
            const state = row === null ? null : row[ 'state' ]

            return { state }
        } finally {
            db.close()
        }
    }


    // Read the NEWEST revision number from the per-memo `revision` table (rev_no INTEGER PRIMARY KEY,
    // core DoltSchema). The serve weiche (MemoView.#loadRevisionSource, Memo 079 FIX A) uses this to
    // decide the read-only Tag-Grenze: ONLY the request for the newest (== HEAD) revision is
    // DB-assembled; every OLDER revision is served from its frozen REV-NN.md file. A db whose
    // `revision` table is MISSING (an early live stand hand-seeded before the first core assemble) or
    // EMPTY returns hasRevisionRows:false — the caller then prefers the frozen file when it exists.
    // The missing-table case is detected via sqlite_master so it is not a throw. Read-only open.
    static readLatestRevisionNo( { dbPath } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readLatestRevisionNo: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readLatestRevisionNo: "${ dbPath }" does not exist — cannot read the revision table` )
        }

        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            if( DoltDbAssembler.#tableExists( { db, table: 'revision' } ) !== true ) {
                return { latestRevNo: null, hasRevisionRows: false }
            }

            const row = DoltDbAssembler.#get( { db, sql: 'SELECT max( rev_no ) AS maxRev FROM revision' } )
            const maxRev = row === null ? null : row[ 'maxRev' ]

            if( maxRev === null || maxRev === undefined ) {
                return { latestRevNo: null, hasRevisionRows: false }
            }

            return { latestRevNo: Number( maxRev ), hasRevisionRows: true }
        } finally {
            db.close()
        }
    }


    // Read the open/answered question counts of a per-memo database (Memo 079 FIX B). The pure
    // `question`-table counter (open = rows WHERE status='open'; answered = every other row). Since
    // PRD-22 #4 the DocumentRegistry badge path reads the richer readQuestionAnswerState (which folds in
    // the user_input_answers records); this leaf is the status-only baseline it builds on and remains a
    // tested public API. A MISSING `question` table (hand-seeded / early db) reads as { open:0,
    // answered:0 } via the sqlite_master guard, never a throw. Read-only open; same fail-loud contract.
    static readOpenQuestionCounts( { dbPath } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readOpenQuestionCounts: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readOpenQuestionCounts: "${ dbPath }" does not exist — cannot read the question table` )
        }

        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            if( DoltDbAssembler.#tableExists( { db, table: 'question' } ) !== true ) {
                return { open: 0, answered: 0 }
            }

            const openRow = DoltDbAssembler.#get( { db, sql: "SELECT count( * ) AS n FROM question WHERE status = 'open'" } )
            const totalRow = DoltDbAssembler.#get( { db, sql: 'SELECT count( * ) AS n FROM question' } )
            const open = openRow === null ? 0 : Number( openRow[ 'n' ] )
            const total = totalRow === null ? 0 : Number( totalRow[ 'n' ] )

            return { open, answered: total - open }
        } finally {
            db.close()
        }
    }


    // Read the DISTINCT answered question ids from the per-memo `user_input_answers` table (Memo 079
    // PRD-22 #4). Every answer — given via the memo-view widget OR typed in the terminal — is written
    // as the SAME `user_input_answers` row by the `memo user-input answer` single-writer (WI-044), so
    // this is the ONE durable answer-record source that closes the terminal-answer Karteileiche
    // (forensics b5: a terminal answer left no transcript file and the revision stayed 'offen' forever).
    // question_id is the `F<N>` token, normalized for cross-source dedup. A MISSING `user_input_answers`
    // table (a memo whose review widget was never used) reads as an empty set via the sqlite_master
    // guard, never a throw. Read-only open; same fail-loud arg/existence contract as the sibling leaves.
    static readAnswerRecords( { dbPath } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readAnswerRecords: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readAnswerRecords: "${ dbPath }" does not exist — cannot read the user_input_answers table` )
        }

        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            if( DoltDbAssembler.#tableExists( { db, table: 'user_input_answers' } ) !== true ) {
                return { answeredQuestionIds: [] }
            }

            const rows = DoltDbAssembler.#all( { db, sql: 'SELECT DISTINCT question_id FROM user_input_answers' } )
            const answeredQuestionIds = [ ...new Set(
                rows
                    .map( ( row ) => normalizeQuestionId( row[ 'question_id' ] ) )
                    .filter( ( id ) => id.length > 0 )
            ) ]

            return { answeredQuestionIds }
        } finally {
            db.close()
        }
    }


    // Fold the answer records (readAnswerRecords) additively onto the `question`-table counts (Memo 079
    // PRD-22 #4). The `question` table alone counts a row answered only once its `status` column flips;
    // a terminal/widget answer, however, lands in `user_input_answers` WITHOUT necessarily flipping that
    // status. This leaf reclassifies every OPEN question that carries an answer record as answered —
    // deduped by the normalized F-id so a record for an already-answered question never double-counts.
    // Returns:
    //   * open        — open questions that have NO answer record (the honest remaining work)
    //   * answered    — status-answered rows PLUS open rows cleared by a record
    //   * total       — count( question )
    //   * allAnswered — total > 0 && open === 0 (the memo's open questions are ALL covered by records)
    // A missing `question` table reads as all-zero / allAnswered:false (no invented completion). Same
    // fail-loud arg/existence contract; a single read-only open for every sub-query.
    static readQuestionAnswerState( { dbPath } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readQuestionAnswerState: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readQuestionAnswerState: "${ dbPath }" does not exist — cannot read the question table` )
        }

        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            if( DoltDbAssembler.#tableExists( { db, table: 'question' } ) !== true ) {
                return { open: 0, answered: 0, total: 0, allAnswered: false }
            }

            const openRows = DoltDbAssembler.#all( { db, sql: "SELECT id FROM question WHERE status = 'open'" } )
            const totalRow = DoltDbAssembler.#get( { db, sql: 'SELECT count( * ) AS n FROM question' } )
            const total = totalRow === null ? 0 : Number( totalRow[ 'n' ] )

            const openIds = openRows
                .map( ( row ) => normalizeQuestionId( row[ 'id' ] ) )

            const answeredRecordIds = DoltDbAssembler.#tableExists( { db, table: 'user_input_answers' } ) === true
                ? DoltDbAssembler.#all( { db, sql: 'SELECT DISTINCT question_id FROM user_input_answers' } )
                    .map( ( row ) => normalizeQuestionId( row[ 'question_id' ] ) )
                : []
            const answeredSet = new Set( answeredRecordIds )

            const openWithoutRecord = openIds
                .filter( ( id ) => id.length === 0 || answeredSet.has( id ) !== true )
            const open = openWithoutRecord.length
            const cleared = openIds.length - open
            const answered = ( total - openIds.length ) + cleared
            const allAnswered = total > 0 && open === 0

            return { open, answered, total, allAnswered }
        } finally {
            db.close()
        }
    }


    // Bring a caller-supplied page window into a usable range (Memo 080, PRD-V1 / WI-101). PURE + public so
    // the route layer can reject a bad window BEFORE opening the database, and so the rule is testable on
    // its own. An ABSENT limit/offset takes the documented default (100 / 0) — that is the published
    // contract, not a silent default. A PRESENT but unusable value (non-numeric, fractional, negative, or
    // above the ceiling) FAILS LOUD; it is never quietly bent into something else and never reaches the
    // database. Numeric strings are accepted because the values arrive as query parameters.
    static normalizeTablePage( { limit, offset } ) {
        const readBound = ( { value, fallback, min, max, name } ) => {
            const isAbsent = value === undefined || value === null || value === ''

            if( isAbsent === true ) {
                return fallback
            }

            const numeric = Number( value )

            if( Number.isInteger( numeric ) !== true ) {
                throw new Error( `DoltDbAssembler.normalizeTablePage: "${ name }" must be an integer — got "${ value }"` )
            }
            if( numeric < min || numeric > max ) {
                throw new Error( `DoltDbAssembler.normalizeTablePage: "${ name }" must be between ${ min } and ${ max } — got "${ value }"` )
            }

            return numeric
        }

        return {
            'limit': readBound( { 'value': limit, 'fallback': TABLE_PAGE_DEFAULT_LIMIT, 'min': 1, 'max': TABLE_PAGE_MAX_LIMIT, 'name': 'limit' } ),
            'offset': readBound( { 'value': offset, 'fallback': 0, 'min': 0, 'max': Number.MAX_SAFE_INTEGER, 'name': 'offset' } )
        }
    }


    // List every table of a per-memo database with its row count (Memo 080, PRD-V1 / WI-101 — US-1). The
    // names come from `sqlite_master`, so the count is a measured fact about THIS file, never a hard-coded
    // schema list. `tableCount` is returned alongside the list on purpose: a check must be able to say how
    // much it compared, so an EMPTY list is only ever honest emptiness and never a lookup that found
    // nothing (lesson deterministic-gates-can-be-vacuum-green). Read-only open, close in `finally`.
    static readTableList( { dbPath } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readTableList: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readTableList: "${ dbPath }" does not exist — cannot list the tables` )
        }

        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            const names = DoltDbAssembler.#tableNames( { db } )
            const tables = names
                .map( ( name ) => {
                    const row = DoltDbAssembler.#get( { db, 'sql': `SELECT count( * ) AS n FROM \`${ name }\`` } )

                    return { name, 'rowCount': row === null ? 0 : Number( row[ 'n' ] ) }
                } )

            return { tables, 'tableCount': tables.length }
        } finally {
            db.close()
        }
    }


    // Read ONE page of ONE table (Memo 080, PRD-V1 / WI-101 — US-2/US-3). The incoming `table` is the only
    // value in this class that may come from outside, so it is checked against the list read from
    // `sqlite_master` by EXACT string comparison — a whitelist, not a character filter. A name that is not
    // in the list returns found:false WITHOUT running a query against it, so a name carrying a semicolon
    // and a second statement, a quote, a backtick or a `../` traversal all die at the list check. Only the
    // matched name (a value that came OUT of the database) is ever interpolated; limit and offset travel
    // as bound `?` parameters. Read-only open, close in `finally`.
    static readTablePage( { dbPath, table, limit, offset } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readTablePage: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readTablePage: "${ dbPath }" does not exist — cannot read a table` )
        }
        if( typeof table !== 'string' || table.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readTablePage: "table" is required (non-empty string)' )
        }

        const window = DoltDbAssembler.normalizeTablePage( { limit, offset } )
        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            const names = DoltDbAssembler.#tableNames( { db } )
            const match = names
                .find( ( name ) => name === table )

            if( match === undefined ) {
                return {
                    'found': false, 'table': table, 'columns': [], 'rows': [], 'totalRows': 0,
                    'limit': window[ 'limit' ], 'offset': window[ 'offset' ], 'truncatedCells': 0, 'tableCount': names.length
                }
            }

            const columns = DoltDbAssembler.#all( { db, 'sql': `PRAGMA table_info(\`${ match }\`)` } )
                .map( ( row ) => String( row[ 'name' ] ) )
            const totalRow = DoltDbAssembler.#get( { db, 'sql': `SELECT count( * ) AS n FROM \`${ match }\`` } )
            const totalRows = totalRow === null ? 0 : Number( totalRow[ 'n' ] )
            const raw = DoltDbAssembler.#allPaged( {
                db, 'sql': `SELECT * FROM \`${ match }\` LIMIT ? OFFSET ?`, 'limit': window[ 'limit' ], 'offset': window[ 'offset' ]
            } )
            const rows = raw
                .map( ( row ) => columns.map( ( column ) => truncateCell( row[ column ] ) ) )
            const truncatedCells = rows
                .reduce( ( sum, cells ) => sum + cells.filter( ( cell ) => cell[ 'truncated' ] === true ).length, 0 )

            return {
                'found': true, 'table': match, columns, rows, totalRows,
                'limit': window[ 'limit' ], 'offset': window[ 'offset' ], truncatedCells, 'tableCount': names.length
            }
        } finally {
            db.close()
        }
    }


    // ---- private ----

    static #open( { dbPath } ) {
        // The viewer only reads — open read-only so the schaufenster can never mutate the DB.
        try {
            return new DatabaseSync( dbPath, { readOnly: true } )
        } catch( error ) {
            throw new Error( `DoltDbAssembler.assembleFromDb: cannot open "${ dbPath }" — ${ error.message }` )
        }
    }


    static #all( { db, sql } ) {
        return db.prepare( sql ).all()
    }


    static #get( { db, sql } ) {
        const row = db.prepare( sql ).get()

        return row === undefined ? null : row
    }


    // A page read with BOUND value parameters (Memo 080, PRD-V1). limit/offset are passed as `?` values —
    // never string-concatenated into the SQL — so no number from the outside can carry a second statement.
    static #allPaged( { db, sql, limit, offset } ) {
        return db.prepare( sql ).all( limit, offset )
    }


    // Every table name of this database, read from `sqlite_master`. This list is BOTH the raw-table
    // listing (readTableList) and the whitelist a caller-supplied name is checked against (readTablePage).
    static #tableNames( { db } ) {
        const rows = DoltDbAssembler.#all( { db, sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" } )

        return rows
            .map( ( row ) => String( row[ 'name' ] ) )
    }


    // The ORDER BY clause for the question read: the authored-order `sort` ordinal with `id` as a stable
    // tie-break when the column exists (a widened / production db), degrading to plain `id` on a pre-this-fix
    // or early hand-seeded db that lacks the column. Probed via PRAGMA table_info so a missing column never
    // throws — byte-identical to RevisionAssembler.#questionOrderBy (core) so both renderers pick the same
    // clause and never diverge.
    static #questionOrderBy( { db } ) {
        const rows = DoltDbAssembler.#all( { db, sql: 'PRAGMA table_info(question)' } )
        const hasSort = rows
            .some( ( row ) => row[ 'name' ] === 'sort' )

        return hasSort === true ? 'sort, id' : 'id'
    }


    // Does a table exist in this database? doltlite is node:sqlite-compatible and exposes sqlite_master,
    // so a MISSING table (early/hand-seeded db) can be detected WITHOUT a "no such table" throw.
    // Memo 080, PRD-V1: the older note here promised the table name is "never user input". That promise no
    // longer holds for the class as a whole — readTablePage takes a name from the raw-table route. The
    // sentence is replaced by the guarantee that actually carries the risk: the ONLY name that is ever
    // interpolated is one that came OUT of `sqlite_master` (readTableList / #tableNames). readTablePage
    // matches the incoming name against that list by exact comparison and returns found:false on a miss —
    // the whitelist is the safeguard, not the (still true) fact that THIS private leaf is called with
    // internal literals ('revision' / 'question' / 'user_input_answers') only.
    static #tableExists( { db, table } ) {
        const row = DoltDbAssembler.#get( { db, sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${ table }'` } )

        return row !== null
    }


    static #renderBody( { db } ) {
        const memo = DoltDbAssembler.#memoRow( { db } )
        const context = DoltDbAssembler.#readContext( { db } )
        const workItems = DoltDbAssembler.#all( { db, sql: 'SELECT id, topic, title, status, grp FROM work_item ORDER BY id' } )
        const blocks = DoltDbAssembler.#all( { db, sql: 'SELECT id, title, sort FROM block ORDER BY sort, id' } )
        const blockTables = DoltDbAssembler.#all( { db, sql: 'SELECT id, block_id, title, tsv FROM block_tables ORDER BY block_id, id' } )
        const blockDiagrams = DoltDbAssembler.#all( { db, sql: 'SELECT id, block_id, title, kind, `source`, feed FROM block_diagrams ORDER BY block_id, id' } )
        // topic / rollout_phase / rollout_work_item / question mirror the core RevisionAssembler read. The
        // viewer, however, may open an EARLY hand-seeded db that predates these tables, so each read is
        // guarded by #tableExists and degrades to an empty array — which renders byte-identically to the
        // core render of an empty (but present) table. The reserved rollout_phase sentinel `__state__` is
        // metadata, excluded here exactly as in core.
        const topics = DoltDbAssembler.#tableExists( { db, table: 'topic' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT id, title, phase, block, origin FROM topic ORDER BY id' } )
            : []
        const phases = DoltDbAssembler.#tableExists( { db, table: 'rollout_phase' } ) === true
            ? DoltDbAssembler.#all( { db, sql: "SELECT id, name, status FROM rollout_phase WHERE id != '__state__' ORDER BY id" } )
            : []
        const phaseWorkItems = DoltDbAssembler.#tableExists( { db, table: 'rollout_work_item' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT id, phase_id, title, status, target, wi_type FROM rollout_work_item ORDER BY phase_id, id' } )
            : []
        // SELECT * so a pre-Slice-2a `question` table (only id/text/kind/status) and a widened one (+ title/
        // background/typ/ai_recommendation) both read without a "no such column" throw — the emit reads each
        // widened field defensively and degrades a missing/null one to a JSON null (byte-identical to the core
        // RevisionAssembler render of the same db). ORDER BY the AUTHORED-order `sort` ordinal (id as a stable
        // tie-break) so the fence + Offene-Fragen keep the authored order (F1,F3,…,F13,F2), never the lexical
        // TEXT-id sort (F1,F10,F11,…). A db WITHOUT the `sort` column (pre-this-fix / early hand-seeded)
        // degrades to ORDER BY id — the exact old behaviour, no throw — via the SAME probe the core renderer
        // runs, so the two stay byte-identical on ANY db state. `question_option` is the answerable child
        // (options[]); a pre-Slice-2a db lacks it, so it is #tableExists-guarded and degrades to [] (a text-
        // only, non-answerable fence — the honest old behaviour), read ORDER BY question_id, sort for a stable
        // order.
        const questionOrder = DoltDbAssembler.#tableExists( { db, table: 'question' } ) === true
            ? DoltDbAssembler.#questionOrderBy( { db } )
            : 'id'
        const questions = DoltDbAssembler.#tableExists( { db, table: 'question' } ) === true
            ? DoltDbAssembler.#all( { db, sql: `SELECT * FROM question ORDER BY ${ questionOrder }` } )
            : []
        const questionOptions = DoltDbAssembler.#tableExists( { db, table: 'question_option' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT question_id, opt_key, label, kind, sort FROM question_option ORDER BY question_id, sort' } )
            : []
        // The durable user-decision records (`user_input_answers`, PRD-11) — the answer VERBATIM + chosen option
        // a widget/terminal answer wrote for a question. The `## Beantwortete Fragen` render joins these onto the
        // answered questions so the DB-served memo re-surfaces the AI-Empfehlung-war vs User-Entscheidung pair the
        // User Mental Model reads (Memo 038 Kap 6). #tableExists-guarded and degraded to [] on a pre-PRD-11 db —
        // byte-identical to the core RevisionAssembler read. ORDER BY question_id, input_id so the latest record
        // per question (max input_id, "opinions can change") is deterministic across both renderers.
        const answers = DoltDbAssembler.#tableExists( { db, table: 'user_input_answers' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT input_id, question_id, option_key, answer_verbatim FROM user_input_answers ORDER BY question_id, input_id' } )
            : []
        // research (+ research_topics / research_files edges) — the memo-local R-circle REV-03 Kap 3 Punkt 1
        // enumerates as DB-resident memo-body data ("Research-Kanten leben in der DB"). Mirrors the core
        // RevisionAssembler read: #tableExists-guarded, degraded to [] on an early hand-seeded db that predates
        // the tables, ORDER BY r_no with each edge read ORDER BY r_no then its own stable second key, so the
        // viewer render stays byte-identical to the frozen REV.
        const research = DoltDbAssembler.#tableExists( { db, table: 'research' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT r_no, title, kind, path FROM research ORDER BY r_no' } )
            : []
        const researchTopics = DoltDbAssembler.#tableExists( { db, table: 'research_topics' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT r_no, topic_id FROM research_topics ORDER BY r_no, topic_id' } )
            : []
        const researchFiles = DoltDbAssembler.#tableExists( { db, table: 'research_files' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT r_no, path, sha256 FROM research_files ORDER BY r_no, path' } )
            : []
        // snag / goal / maintenance_card + the memo_section / memo_head carriers (Memo 080, PRD-R1):
        // the same reads, the same ORDER BY and the same #tableExists guard-and-degrade the core
        // RevisionAssembler applies, so both renderers stay byte-identical on ANY database state.
        const snags = DoltDbAssembler.#tableExists( { db, table: 'snag' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT id, title, status, verdict, disposition FROM snag ORDER BY id' } )
            : []
        const goals = DoltDbAssembler.#tableExists( { db, table: 'goal' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT id, name, kind, pct, status FROM goal ORDER BY id' } )
            : []
        const maintenanceCards = DoltDbAssembler.#tableExists( { db, table: 'maintenance_card' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT repo, freshness, blast, maint_status FROM maintenance_card ORDER BY repo' } )
            : []
        const sections = DoltDbAssembler.#tableExists( { db, table: 'memo_section' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT id, heading, body, sort FROM memo_section ORDER BY sort, id' } )
            : []
        const headRows = DoltDbAssembler.#tableExists( { db, table: 'memo_head' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT field, value, sort FROM memo_head ORDER BY sort, field' } )
            : []

        const head = DoltDbAssembler.#renderHead( { db, memo, headRows } )

        // The section ORDER mirrors RevisionAssembler.#renderBody exactly — it is part of the byte equality.
        return head
            .concat( DoltDbAssembler.#renderKontext( { context } ) )
            .concat( DoltDbAssembler.#renderProse( { sections, heading: 'Vorwort' } ) )
            .concat( DoltDbAssembler.#renderWorkItems( { workItems } ) )
            .concat( DoltDbAssembler.#renderBlocks( { blocks, blockTables, blockDiagrams } ) )
            .concat( DoltDbAssembler.#renderTopics( { topics } ) )
            .concat( DoltDbAssembler.#renderPhases( { phases, phaseWorkItems } ) )
            .concat( DoltDbAssembler.#renderProse( { sections, heading: 'Phase-Hints' } ) )
            .concat( DoltDbAssembler.#renderResearch( { research, researchTopics, researchFiles } ) )
            .concat( DoltDbAssembler.#renderSnags( { snags } ) )
            .concat( DoltDbAssembler.#renderGoals( { goals } ) )
            .concat( DoltDbAssembler.#renderMaintenance( { cards: maintenanceCards } ) )
            .concat( DoltDbAssembler.#renderQuestionsJson( { questions, questionOptions } ) )
            .concat( DoltDbAssembler.#renderOpenQuestions( { questions } ) )
            .concat( DoltDbAssembler.#renderAnsweredQuestions( { questions, questionOptions, answers } ) )
            .concat( DoltDbAssembler.#renderProse( { sections, heading: 'Finalisierungs-Checkliste' } ) )
            .concat( DoltDbAssembler.#renderProse( { sections, heading: 'Ancillary Files' } ) )
            .concat( DoltDbAssembler.#renderProse( { sections, heading: 'Rollout-Entry-Points' } ) )
            .concat( DoltDbAssembler.#renderProse( { sections, heading: 'Lessons-Learned' } ) )
            .join( '\n' )
    }


    // Byte-identical to RevisionAssembler.#renderHead: the memo name as H1, the visible generation note,
    // the scope line, then the head TABLE the validator expects (`| **Feld** | Wert |`). The one difference
    // is WHERE the revision number comes from: the core render is handed the number it is freezing, the
    // viewer renders HEAD — so it reads the newest frozen `revision` row, which after an assemble IS that
    // same number.
    static #renderHead( { db, memo, headRows } ) {
        const latestRevNo = DoltDbAssembler.#latestRevNo( { db } )
        const rows = HEAD_FIELDS
            .map( ( field ) => `| **${ field }** | ${ cell( DoltDbAssembler.#headValue( { field, memo, headRows, latestRevNo } ) ) } |` )

        return [ `# ${ cell( memo[ 'name' ] ) }`, '', GENERATED_NOTE, '', DoltDbAssembler.#scopeLine( { db } ), '', '| Feld | Wert |', '| --- | --- |' ]
            .concat( rows )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#scopeLine (core): `**Scope:** N blocks · N topics · …`, one
    // figure per content carrier in the shared carrier order, each figure named WITH its carrier. Every
    // count is #tableExists-guarded and degrades to 0, so an early hand-seeded db renders the same bytes the
    // core renderer produces for the same state instead of throwing.
    static #scopeLine( { db } ) {
        const parts = SCOPE_CARRIERS
            .map( ( carrier ) => `${ DoltDbAssembler.#countCarrier( { db, carrier } ) } ${ carrier[ 'key' ] }` )

        return `${ SCOPE_LABEL } ${ parts.join( ' · ' ) }`
    }


    // One carrier row count. `table` / `where` are internal literals from SCOPE_CARRIERS, never user input.
    static #countCarrier( { db, carrier } ) {
        const { table, where } = carrier
        if( DoltDbAssembler.#tableExists( { db, table } ) !== true ) {
            return 0
        }

        const clause = where === null ? '' : ` WHERE ${ where }`
        const row = DoltDbAssembler.#get( { db, sql: `SELECT count(*) AS n FROM ${ table }${ clause }` } )

        return row === null ? 0 : Number( row[ 'n' ] )
    }


    // The newest frozen revision number, or null on a db without a `revision` table or without rows.
    static #latestRevNo( { db } ) {
        if( DoltDbAssembler.#tableExists( { db, table: 'revision' } ) !== true ) {
            return null
        }

        const row = DoltDbAssembler.#get( { db, sql: 'SELECT max( rev_no ) AS maxRev FROM revision' } )
        const maxRev = row === null ? null : row[ 'maxRev' ]

        return typeof maxRev === 'number' ? maxRev : null
    }


    // ONE head-field value — the same precedence per field the core render applies (see
    // RevisionAssembler.#headValue), with the newest frozen revision number standing in for the core's
    // passed parameter. An unresolvable field yields the explicit em-dash mark, never an empty cell.
    static #headValue( { field, memo, headRows, latestRevNo } ) {
        const carried = headRows
            .find( ( row ) => row[ 'field' ] === field )
        const carriedValue = carried !== undefined && typeof carried[ 'value' ] === 'string' && carried[ 'value' ].length > 0
            ? carried[ 'value' ]
            : null
        if( field === 'Revision' ) {
            const frozen = latestRevNo === null ? null : String( latestRevNo ).padStart( 2, '0' )

            return DoltDbAssembler.#firstFilled( { values: [ frozen, carriedValue ] } )
        }

        const derived = {
            'Memo': memo[ 'id' ],
            'Memo-Name': memo[ 'name' ],
            'Datum': memo[ 'created_at' ],
            'Status': memo[ 'status' ]
        }

        return DoltDbAssembler.#firstFilled( { values: [ carriedValue, derived[ field ] ] } )
    }


    // Byte-identical to RevisionAssembler.#firstFilled.
    static #firstFilled( { values } ) {
        const found = values
            .find( ( value ) => value !== null && value !== undefined && String( value ).length > 0 )

        return found === undefined ? '—' : String( found )
    }


    // Byte-identical to RevisionAssembler.#renderProse — one mandatory prose section from the
    // `memo_section` carrier, all matching rows in (sort, id) order, empty renders the explicit mark.
    static #renderProse( { sections, heading } ) {
        const matched = sections
            .filter( ( row ) => row[ 'heading' ] === heading )
        const bodies = matched
            .map( ( row ) => raw( row[ 'body' ] ) )
            .filter( ( body ) => body.length > 0 )
        if( bodies.length === 0 ) {
            return [ `## ${ heading }`, '', PROSE_EMPTY, '' ]
        }

        return [ `## ${ heading }`, '' ]
            .concat( bodies.join( '\n\n' ).split( '\n' ) )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#renderSnags.
    static #renderSnags( { snags } ) {
        const heading = [ '## Snags', '' ]
        if( snags.length === 0 ) {
            return heading.concat( [ '_no snags_', '' ] )
        }

        const table = [
            '| ID | Title | Status | Verdict | Disposition |',
            '| --- | --- | --- | --- | --- |'
        ]
        const bodyRows = snags
            .map( ( row ) => `| ${ cell( row[ 'id' ] ) } | ${ cell( row[ 'title' ] ) } | ${ cell( row[ 'status' ] ) } | ${ cell( row[ 'verdict' ] ) } | ${ cell( row[ 'disposition' ] ) } |` )

        return heading
            .concat( table )
            .concat( bodyRows )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#renderGoals.
    static #renderGoals( { goals } ) {
        const heading = [ '## Goals', '' ]
        if( goals.length === 0 ) {
            return heading.concat( [ '_no goals_', '' ] )
        }

        const table = [
            '| ID | Name | Kind | Pct | Status |',
            '| --- | --- | --- | --- | --- |'
        ]
        const bodyRows = goals
            .map( ( row ) => `| ${ cell( row[ 'id' ] ) } | ${ cell( row[ 'name' ] ) } | ${ cell( row[ 'kind' ] ) } | ${ cell( row[ 'pct' ] ) } | ${ cell( row[ 'status' ] ) } |` )

        return heading
            .concat( table )
            .concat( bodyRows )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#renderMaintenance.
    static #renderMaintenance( { cards } ) {
        const heading = [ '## Maintenance', '' ]
        if( cards.length === 0 ) {
            return heading.concat( [ '_no maintenance cards_', '' ] )
        }

        const table = [
            '| Repo | Freshness | Blast | Status |',
            '| --- | --- | --- | --- |'
        ]
        const bodyRows = cards
            .map( ( row ) => `| ${ cell( row[ 'repo' ] ) } | ${ cell( row[ 'freshness' ] ) } | ${ cell( row[ 'blast' ] ) } | ${ cell( row[ 'maint_status' ] ) } |` )

        return heading
            .concat( table )
            .concat( bodyRows )
            .concat( [ '' ] )
    }


    // Read the memo context prose. The `context` column was added to the memo schema in Memo 079 (PRD-16
    // broad build-out); an EARLY hand-seeded memo table may lack it, so the column presence is probed via
    // PRAGMA table_info before the read — a missing column reads as null (renders `_kein Kontext_`), never
    // a "no such column" throw. Byte-identical to the core render of a null context.
    static #readContext( { db } ) {
        const columns = DoltDbAssembler.#all( { db, sql: 'PRAGMA table_info(memo)' } )
        const hasContext = columns
            .some( ( column ) => column[ 'name' ] === 'context' )
        if( hasContext !== true ) {
            return null
        }

        const row = DoltDbAssembler.#get( { db, sql: 'SELECT context FROM memo ORDER BY id LIMIT 1' } )

        return row === null ? null : row[ 'context' ]
    }


    // Byte-identical to RevisionAssembler.#renderKontext.
    static #renderKontext( { context } ) {
        const heading = [ '## Kontext', '' ]
        const isEmpty = context === null || context === undefined || String( context ).length === 0
        const lines = isEmpty === true
            ? [ '_kein Kontext_' ]
            : raw( context ).split( '\n' )

        return heading
            .concat( lines )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#renderTopics.
    static #renderTopics( { topics } ) {
        const heading = [ '## Topics', '' ]
        if( topics.length === 0 ) {
            return heading.concat( [ '_no topics_', '' ] )
        }

        const table = [
            '| ID | Title | Phase | Block | Origin |',
            '| --- | --- | --- | --- | --- |'
        ]
        const bodyRows = topics
            .map( ( row ) => `| ${ cell( row[ 'id' ] ) } | ${ cell( row[ 'title' ] ) } | ${ cell( row[ 'phase' ] ) } | ${ cell( row[ 'block' ] ) } | ${ cell( row[ 'origin' ] ) } |` )

        return heading
            .concat( table )
            .concat( bodyRows )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#renderPhases.
    static #renderPhases( { phases, phaseWorkItems } ) {
        const heading = [ '## Phasen', '' ]
        if( phases.length === 0 ) {
            return heading.concat( [ '_no phases_', '' ] )
        }

        const sections = phases
            .map( ( phase ) => {
                const items = phaseWorkItems
                    .filter( ( entry ) => entry[ 'phase_id' ] === phase[ 'id' ] )
                const itemLines = items.length === 0
                    ? [ '_no work items_', '' ]
                    : [ '| ID | Title | Status | Target | Type |', '| --- | --- | --- | --- | --- |' ]
                        .concat( items.map( ( entry ) => `| ${ cell( entry[ 'id' ] ) } | ${ cell( entry[ 'title' ] ) } | ${ cell( entry[ 'status' ] ) } | ${ cell( entry[ 'target' ] ) } | ${ cell( entry[ 'wi_type' ] ) } |` ) )
                        .concat( [ '' ] )

                return [ `### ${ cell( phase[ 'name' ] ) } (${ cell( phase[ 'id' ] ) })`, '', `- Status: ${ cell( phase[ 'status' ] ) }`, '' ]
                    .concat( itemLines )
            } )
            .reduce( ( acc, part ) => acc.concat( part ), [] )

        return heading.concat( sections )
    }


    // Byte-identical to RevisionAssembler.#renderResearch — the memo-local Research register (Kap 3 Punkt 1
    // "Research-Kanten leben in der DB") from the `research` table + its `research_topics` / `research_files`
    // edges, ORDER BY r_no, with the bound topic ids and produced file paths as joined cells. The always-null
    // `research.path` scalar is omitted (superseded by the research_files edges). Empty renders `_no research_`.
    static #renderResearch( { research, researchTopics, researchFiles } ) {
        const heading = [ '## Research', '' ]
        if( research.length === 0 ) {
            return heading.concat( [ '_no research_', '' ] )
        }

        const table = [
            '| R | Title | Kind | Topics | Files |',
            '| --- | --- | --- | --- | --- |'
        ]
        const bodyRows = research
            .map( ( entry ) => {
                const topics = researchTopics
                    .filter( ( edge ) => edge[ 'r_no' ] === entry[ 'r_no' ] )
                    .map( ( edge ) => edge[ 'topic_id' ] )
                    .join( ', ' )
                const files = researchFiles
                    .filter( ( edge ) => edge[ 'r_no' ] === entry[ 'r_no' ] )
                    .map( ( edge ) => edge[ 'path' ] )
                    .join( ', ' )

                return `| R${ cell( entry[ 'r_no' ] ) } | ${ cell( entry[ 'title' ] ) } | ${ cell( entry[ 'kind' ] ) } | ${ cell( topics ) } | ${ cell( files ) } |`
            } )

        return heading
            .concat( table )
            .concat( bodyRows )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#renderQuestionsJson — the machine-readable `questions-json` fence
    // the memo-view questions widget parses (DocumentRegistry.parseQuestionJsonBlock / #normalizeJsonQuestion).
    // Re-emitting the canonical fields (id, title, hintergrund, frage, aiRecommendation, typ, options[]) makes
    // a DB-served memo render a REAL, ANSWERABLE card (QuestionContract.isRenderable === true) instead of raw
    // text. There is deliberately NO top-level `kind` (zero real memos carry one; the DB `kind` is the blocker/
    // info gate axis, surfaced only in `## Offene Fragen`). Every question (open AND answered) is emitted;
    // identical rows -> identical JSON bytes (same key order, 2-space indent) across both renderers.
    static #renderQuestionsJson( { questions, questionOptions } ) {
        const heading = [ '## Fragen', '' ]
        const entries = questions
            .map( ( row ) => DoltDbAssembler.#questionEntry( { row, questionOptions } ) )
        const jsonLines = JSON.stringify( entries, null, 2 ).split( '\n' )

        return heading
            .concat( [ '```questions-json' ] )
            .concat( jsonLines )
            .concat( [ '```', '' ] )
    }


    // Build ONE canonical questions-json entry from a `question` row + its `question_option` children. Field
    // order is fixed (id, title, hintergrund, frage, aiRecommendation, typ, options, answered). MUST stay
    // byte-identical to RevisionAssembler.#questionEntry (core).
    static #questionEntry( { row, questionOptions } ) {
        const options = questionOptions
            .filter( ( option ) => option[ 'question_id' ] === row[ 'id' ] )
            .map( ( option ) => ( {
                key: raw( option[ 'opt_key' ] ),
                label: raw( option[ 'label' ] ),
                kind: DoltDbAssembler.#optionKind( { value: option[ 'kind' ] } )
            } ) )

        return {
            id: raw( row[ 'id' ] ),
            title: DoltDbAssembler.#strOrNull( { value: row[ 'title' ] } ),
            hintergrund: DoltDbAssembler.#strOrNull( { value: row[ 'background' ] } ),
            frage: DoltDbAssembler.#jsonVal( { value: row[ 'text' ] } ),
            aiRecommendation: DoltDbAssembler.#strOrNull( { value: row[ 'ai_recommendation' ] } ),
            typ: DoltDbAssembler.#strOrNull( { value: row[ 'typ' ] } ),
            options,
            answered: row[ 'status' ] === 'answered'
        }
    }


    // A missing option kind defaults to 'option' — the same default the viewer normalizer applies, so the
    // option renders as a real answer choice. Byte-identical to RevisionAssembler.#optionKind.
    static #optionKind( { value } ) {
        return typeof value === 'string' && value.length > 0 ? value : 'option'
    }


    // An optional questions-json scalar: a non-empty string passes through, anything else (undefined column on
    // a pre-Slice-2a db, SQL NULL, or empty string) collapses to an explicit JSON null. Byte-identical to
    // RevisionAssembler.#strOrNull.
    static #strOrNull( { value } ) {
        return typeof value === 'string' && value.length > 0 ? value : null
    }


    static #jsonVal( { value } ) {
        return value === undefined ? null : value
    }


    // Byte-identical to RevisionAssembler.#renderOpenQuestions — the human-readable `## Offene Fragen`
    // list (status='open'), filtered from the SAME authored-order (sort, id) question read so fence and list
    // agree on order and both follow the authored order rather than the lexical id sort. A missing `question`
    // table already degraded the read to [] in #renderBody, so this renders 'keine' without a further guard.
    static #renderOpenQuestions( { questions } ) {
        const heading = [ '## Offene Fragen', '' ]
        const open = questions
            .filter( ( row ) => row[ 'status' ] === 'open' )
        if( open.length === 0 ) {
            return heading.concat( [ 'keine', '' ] )
        }

        const rows = open
            .map( ( row ) => `- **${ cell( row[ 'id' ] ) }** (${ cell( row[ 'kind' ] ) }): ${ cell( row[ 'text' ] ) }` )

        return heading
            .concat( rows )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#renderAnsweredQuestions (core) — the `## Beantwortete Fragen`
    // section, the User-Mental-Model source (Memo 038 Kap 6; Memo 079 audit T2-M1). For every ANSWERED
    // question it re-surfaces the decision PAIR the mental-model derive walk reads: `**AI-Empfehlung war:** X`
    // (the question's `ai_recommendation`) vs `**User-Entscheidung:** Y` (the durable `user_input_answers`
    // record — chosen option + verbatim). Answered questions are filtered from the SAME authored-order read as
    // `## Offene Fragen`. Empty degrades to `_keine beantworteten Fragen_`.
    static #renderAnsweredQuestions( { questions, questionOptions, answers } ) {
        const heading = [ '## Beantwortete Fragen', '' ]
        const answered = questions
            .filter( ( row ) => row[ 'status' ] === 'answered' )
        if( answered.length === 0 ) {
            return heading.concat( [ '_keine beantworteten Fragen_', '' ] )
        }

        const sections = answered
            .map( ( row ) => DoltDbAssembler.#answeredEntry( { row, questionOptions, answers } ) )
            .reduce( ( acc, part ) => acc.concat( part ), [] )

        return heading.concat( sections )
    }


    // Byte-identical to RevisionAssembler.#answeredEntry (core). Field order fixed (heading, Frage,
    // AI-Empfehlung war, User-Entscheidung, optional Wortlaut).
    static #answeredEntry( { row, questionOptions, answers } ) {
        const id = row[ 'id' ]
        const record = DoltDbAssembler.#latestAnswer( { answers, questionId: id } )
        const base = [
            `### ${ cell( id ) } — ${ DoltDbAssembler.#answeredTitle( { row } ) }`,
            '',
            `- **Frage (Original):** ${ cell( row[ 'text' ] ) }`,
            `- **AI-Empfehlung war:** ${ DoltDbAssembler.#answeredAi( { row } ) }`,
            `- **User-Entscheidung:** ${ DoltDbAssembler.#answeredDecision( { record, questionOptions, questionId: id } ) }`
        ]

        return base
            .concat( DoltDbAssembler.#answeredWortlaut( { record } ) )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#answeredTitle.
    static #answeredTitle( { row } ) {
        const title = row[ 'title' ]

        return cell( typeof title === 'string' && title.length > 0 ? title : row[ 'text' ] )
    }


    // Byte-identical to RevisionAssembler.#answeredAi.
    static #answeredAi( { row } ) {
        const value = row[ 'ai_recommendation' ]

        return typeof value === 'string' && value.length > 0 ? cell( value ) : '—'
    }


    // Byte-identical to RevisionAssembler.#latestAnswer — the newest record per question (max input_id).
    static #latestAnswer( { answers, questionId } ) {
        const forQuestion = answers
            .filter( ( row ) => row[ 'question_id' ] === questionId )
        if( forQuestion.length === 0 ) {
            return null
        }

        return forQuestion
            .reduce( ( acc, row ) => String( row[ 'input_id' ] ) > String( acc[ 'input_id' ] ) ? row : acc, forQuestion[ 0 ] )
    }


    // Byte-identical to RevisionAssembler.#answeredDecision.
    static #answeredDecision( { record, questionOptions, questionId } ) {
        if( record === null ) {
            return '—'
        }

        const optionKey = record[ 'option_key' ]
        if( typeof optionKey === 'string' && optionKey.length > 0 ) {
            const option = questionOptions
                .find( ( entry ) => entry[ 'question_id' ] === questionId && entry[ 'opt_key' ] === optionKey )
            const label = option !== undefined ? option[ 'label' ] : null

            return typeof label === 'string' && label.length > 0 ? `${ cell( optionKey ) } — ${ cell( label ) }` : cell( optionKey )
        }

        const verbatim = record[ 'answer_verbatim' ]

        return typeof verbatim === 'string' && verbatim.length > 0 ? cell( verbatim ) : '—'
    }


    // Byte-identical to RevisionAssembler.#answeredWortlaut.
    static #answeredWortlaut( { record } ) {
        if( record === null ) {
            return []
        }

        const optionKey = record[ 'option_key' ]
        const verbatim = record[ 'answer_verbatim' ]
        const hasOption = typeof optionKey === 'string' && optionKey.length > 0
        const hasVerbatim = typeof verbatim === 'string' && verbatim.length > 0
        if( hasOption !== true || hasVerbatim !== true ) {
            return []
        }

        return [ `- **Wortlaut:** ${ cell( verbatim ) }` ]
    }


    static #renderWorkItems( { workItems } ) {
        const heading = [ '## Work Items', '' ]
        if( workItems.length === 0 ) {
            return heading.concat( [ '_no work items_', '' ] )
        }

        const table = [
            '| ID | Topic | Title | Status | Group |',
            '| --- | --- | --- | --- | --- |'
        ]
        const bodyRows = workItems
            .map( ( row ) => `| ${ cell( row[ 'id' ] ) } | ${ cell( row[ 'topic' ] ) } | ${ cell( row[ 'title' ] ) } | ${ cell( row[ 'status' ] ) } | ${ cell( row[ 'grp' ] ) } |` )

        return heading
            .concat( table )
            .concat( bodyRows )
            .concat( [ '' ] )
    }


    static #renderBlocks( { blocks, blockTables, blockDiagrams } ) {
        const heading = [ '## Blocks', '' ]
        if( blocks.length === 0 ) {
            return heading.concat( [ '_no blocks_', '' ] )
        }

        const sections = blocks
            .map( ( block ) => {
                const tables = blockTables
                    .filter( ( entry ) => entry[ 'block_id' ] === block[ 'id' ] )
                const tableLines = tables
                    .map( ( entry ) => [ `#### ${ cell( entry[ 'title' ] ) }`, '', '```tsv', raw( entry[ 'tsv' ] ), '```', '' ] )
                    .reduce( ( acc, part ) => acc.concat( part ), [] )

                const diagrams = blockDiagrams
                    .filter( ( entry ) => entry[ 'block_id' ] === block[ 'id' ] )
                const diagramLines = diagrams
                    .map( ( diagram ) => DoltDbAssembler.#renderDiagram( { diagram, blockTables } ) )
                    .reduce( ( acc, part ) => acc.concat( part ), [] )

                return [ `### ${ cell( block[ 'title' ] ) } (${ cell( block[ 'id' ] ) })`, '' ]
                    .concat( tableLines )
                    .concat( diagramLines )
            } )
            .reduce( ( acc, part ) => acc.concat( part ), [] )

        return heading.concat( sections )
    }


    // Render one block_diagram as a fenced code block. The fence language is the diagram's `kind`
    // (validated against {mermaid, vega-lite}); a diagram WITH `feed` deterministically interpolates
    // the referenced block_tables rows into the `source` template, a diagram WITHOUT `feed` emits
    // `source` verbatim. Byte-identical to RevisionAssembler.#renderDiagram.
    static #renderDiagram( { diagram, blockTables } ) {
        const kind = diagram[ 'kind' ]
        if( DIAGRAM_KINDS.includes( kind ) !== true ) {
            throw new Error( `DoltDbAssembler: block_diagram "${ diagram[ 'id' ] }" has invalid kind "${ kind }" — expected one of ${ DIAGRAM_KINDS.join( ', ' ) }` )
        }

        const feed = diagram[ 'feed' ]
        const source = raw( diagram[ 'source' ] )
        const isFed = feed !== null && feed !== undefined && feed !== ''
        const rendered = isFed === true
            ? DoltDbAssembler.#feedDiagram( { source, feed, blockTables, diagramId: diagram[ 'id' ], blockId: diagram[ 'block_id' ] } )
            : source

        const titleLines = diagram[ 'title' ] === null || diagram[ 'title' ] === undefined
            ? []
            : [ `#### ${ cell( diagram[ 'title' ] ) }`, '' ]

        return titleLines
            .concat( [ '```' + kind ] )
            .concat( rendered.split( '\n' ) )
            .concat( [ '```', '' ] )
    }


    static #feedDiagram( { source, feed, blockTables, diagramId, blockId } ) {
        const table = blockTables
            .find( ( entry ) => entry[ 'id' ] === feed && entry[ 'block_id' ] === blockId )
        if( table === undefined ) {
            throw new Error( `DoltDbAssembler: block_diagram "${ diagramId }" feed "${ feed }" references an unknown block_tables handle in block "${ blockId }"` )
        }

        return DoltDbAssembler.#interpolate( { source, tsv: table[ 'tsv' ] } )
    }


    static #interpolate( { source, tsv } ) {
        const { header, rows } = DoltDbAssembler.#parseTsv( { tsv } )
        const sectionPattern = /\{\{#rows\}\}([\s\S]*?)\{\{\/rows\}\}/g

        return source
            .replace( sectionPattern, ( match, inner ) => rows
                .map( ( row ) => DoltDbAssembler.#fillRow( { template: inner, header, row } ) )
                .join( '' )
            )
    }


    static #fillRow( { template, header, row } ) {
        return template
            .replace( /\{\{\s*([^}]+?)\s*\}\}/g, ( match, key ) => DoltDbAssembler.#cellByKey( { key, header, row } ) )
    }


    static #cellByKey( { key, header, row } ) {
        if( /^\d+$/.test( key ) === true ) {
            const index = Number( key )
            if( index < 0 || index >= row.length ) {
                throw new Error( `DoltDbAssembler: diagram feed column index ${ index } out of range` )
            }

            return row[ index ]
        }

        const index = header.indexOf( key )
        if( index === -1 ) {
            throw new Error( `DoltDbAssembler: diagram feed column "${ key }" not found in table header` )
        }

        return row[ index ]
    }


    static #parseTsv( { tsv } ) {
        const lines = raw( tsv ).split( '\n' )
        const header = lines[ 0 ] === undefined ? [] : lines[ 0 ].split( '\t' )
        const rows = lines
            .slice( 1 )
            .filter( ( line ) => line.length > 0 )
            .map( ( line ) => line.split( '\t' ) )

        return { header, rows }
    }


    static #memoRow( { db } ) {
        const row = DoltDbAssembler.#get( { db, sql: 'SELECT id, name, memo_type, status, created_at FROM memo ORDER BY id LIMIT 1' } )
        if( row === null ) {
            throw new Error( 'DoltDbAssembler: no memo row in the per-memo database — cannot render a revision header' )
        }

        return row
    }
}


export { DoltDbAssembler }
