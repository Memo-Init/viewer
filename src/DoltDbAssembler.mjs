// DoltDbAssembler.mjs — the viewer's DB-schaufenster (Memo 079, P6a).
//
// The viewer reads a per-memo `memo-NNN.db` and renders the SAME deterministic Markdown string that
// the core RevisionAssembler freezes into a REV file. This is the "Zwei-Regime" weiche (F16): a new
// memo that carries a per-memo database is rendered DB-first here; the 383 file-parsed legacy memos
// keep their existing registry/parse path untouched.
//
// The memo/work-item/block render is a PURE function of the database rows and stays byte-identical to
// wt-core-079/cli/src/RevisionAssembler.mjs #renderBody/#renderBlocks/#renderDiagram/#interpolate,
// so the DB view and the assembled REV never diverge. Same SQL, same ORDER BY, same escaping, same
// fence formatting. The header (`<!-- assembled-revision ... -->`) is deliberately NOT emitted here —
// it is the assemble-time wrapper; this class returns the hashed BODY only.
//
// Memo 079 P6a (FIX B): the DB render ADDITIONALLY appends an `## Offene Fragen` section derived from
// the `question` table (WHERE status='open') — a deliberate viewer-side enrichment beyond the core
// #renderBody (the core assembler does not yet render questions). This is only ever shown for the
// CURRENT/HEAD revision (see the serve weiche in MemoView.#loadRevisionSource): historical revisions
// are served from their frozen REV-NN.md file, so the enrichment never has to match a frozen file.
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


// Memo 079 PRD-22 (#4): normalize a question identifier for cross-source dedup. The `question` table
// `id` and the `user_input_answers` `question_id` are both the `F<N>` token (DoltSchema); trimming +
// upper-casing lets the answer-record source dedup against the open-question ids case/whitespace-safe.
// A null/undefined id collapses to '' (an unidentifiable question can never be matched by a record —
// it stays honestly open, never silently cleared).
const normalizeQuestionId = ( value ) => {
    return value === null || value === undefined ? '' : String( value ).trim().toUpperCase()
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


    // Does a table exist in this database? doltlite is node:sqlite-compatible and exposes sqlite_master,
    // so a MISSING table (early/hand-seeded db) can be detected WITHOUT a "no such table" throw. `table`
    // is an internal literal ('revision' / 'question'), never user input — no injection surface.
    static #tableExists( { db, table } ) {
        const row = DoltDbAssembler.#get( { db, sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${ table }'` } )

        return row !== null
    }


    static #renderBody( { db } ) {
        const memo = DoltDbAssembler.#memoRow( { db } )
        const workItems = DoltDbAssembler.#all( { db, sql: 'SELECT id, topic, title, status, grp FROM work_item ORDER BY id' } )
        const blocks = DoltDbAssembler.#all( { db, sql: 'SELECT id, title, sort FROM block ORDER BY sort, id' } )
        const blockTables = DoltDbAssembler.#all( { db, sql: 'SELECT id, block_id, title, tsv FROM block_tables ORDER BY block_id, id' } )
        const blockDiagrams = DoltDbAssembler.#all( { db, sql: 'SELECT id, block_id, title, kind, `source`, feed FROM block_diagrams ORDER BY block_id, id' } )

        const head = [
            `# ${ cell( memo[ 'name' ] ) }`,
            '',
            `- ID: ${ cell( memo[ 'id' ] ) }`,
            `- Type: ${ cell( memo[ 'memo_type' ] ) }`,
            `- Status: ${ cell( memo[ 'status' ] ) }`,
            ''
        ]

        const workItemSection = DoltDbAssembler.#renderWorkItems( { workItems } )
        const blockSection = DoltDbAssembler.#renderBlocks( { blocks, blockTables, blockDiagrams } )
        // Memo 079 FIX B: viewer-side enrichment — append the open questions from the `question` table.
        const questionSection = DoltDbAssembler.#renderOpenQuestions( { db } )

        return head
            .concat( workItemSection )
            .concat( blockSection )
            .concat( questionSection )
            .join( '\n' )
    }


    // Memo 079 FIX B: render the `## Offene Fragen` section from the `question` table (WHERE
    // status='open', ORDER BY id) — one line per open question, or a single 'keine' line when none
    // (the memo convention). This is a viewer-side enrichment: the DB body carries no such section
    // otherwise, so the served HEAD render surfaces the live open questions. A MISSING `question`
    // table reads as "keine" (sqlite_master guard), never a throw.
    static #renderOpenQuestions( { db } ) {
        const heading = [ '## Offene Fragen', '' ]

        if( DoltDbAssembler.#tableExists( { db, table: 'question' } ) !== true ) {
            return heading.concat( [ 'keine', '' ] )
        }

        const openQuestions = DoltDbAssembler.#all( { db, sql: "SELECT id, text, kind, status FROM question WHERE status = 'open' ORDER BY id" } )
        if( openQuestions.length === 0 ) {
            return heading.concat( [ 'keine', '' ] )
        }

        const rows = openQuestions
            .map( ( row ) => `- **${ cell( row[ 'id' ] ) }** (${ cell( row[ 'kind' ] ) }): ${ cell( row[ 'text' ] ) }` )

        return heading
            .concat( rows )
            .concat( [ '' ] )
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
