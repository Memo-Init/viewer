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
// EXTERNAL PAYLOAD POINTERS (Memo 080, PRD-D5). The MODEL SOURCE for everything below is the core
// RevisionAssembler: the same PointerSites register, the same PayloadPointer resolution, the same
// checksum check and the same gap render, mirrored byte-faithfully. PointerSites / PayloadPointer /
// BlockTablePayload are VENDORED copies of the core files (the worktree boundary forbids an import).
// Measured before this: `SELECT id, block_id, title, tsv FROM block_tables` read no pointer column at
// all, so a payload-backed row rendered an EMPTY table and a payload-backed diagram an EMPTY fence —
// exactly the silent substitute the error rule forbids, and a byte-parity break in the MATCHED case,
// not only in the gap case. `render` is mirrored in the same step for the same reason: with the
// authored render kind read on one side only, every CLI-authored table (which defaults to render
// 'table') rendered as a Markdown table in core and as a TSV fence here.
// No new error behaviour: an inline payload that does not check out THROWS, and the throw runs into the
// existing fallback onto the frozen file (MemoView), which stays untouched.
//
// Class architecture per node-class-architecture: static-only, object params, object returns,
// private-by-default, NO SILENT DEFAULTS (every missing argument fails loud), no for/while loops.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { PointerSites } from './PointerSites.mjs'
import { PayloadPointer } from './PayloadPointer.mjs'
import { BlockTablePayload } from './BlockTablePayload.mjs'
import { BlockSections } from './BlockSections.mjs'


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


// The reason text of a `mode: reference` gap. Byte-identical to RevisionAssembler GAP_REASON (core) —
// the words are part of the rendered body and therefore part of the cross-repo byte parity.
const GAP_REASON = {
    mismatched: 'checksum mismatch',
    missing: 'file missing',
    unhashed: 'never measured',
    escaped: 'pointer leaves its base'
}


// The six mandatory prose sections rendered from the `memo_section` carrier and the five mandatory head
// fields rendered from `memo_head` (Memo 080, PRD-R1). Byte-identical to RevisionAssembler (core): same
// headings, same order, same empty mark — a one-sided change fails the hash-gated parity fixture.
const PROSE_EMPTY = '_kein Inhalt_'

// Byte-identical to RevisionAssembler HEAD_FIELDS (core): the five mandatory lint fields plus the two the
// DOCUMENT LEVEL demands (REV-18 Z. 160 — `Typ`, `Aenderungen`; Memo 080, PRD-R1 Vollausbau). Both come
// from the head CARRIER only, so this side needs no second source either.
const HEAD_FIELDS = [ 'Memo', 'Memo-Name', 'Revision', 'Datum', 'Status' ]
    .concat( BlockSections.documentSections().sections
        .reduce( ( acc, entry ) => acc.concat( entry[ 'fields' ] ), [] )
        .filter( ( field ) => [ 'Memo', 'Memo-Name', 'Revision', 'Datum', 'Status' ].includes( field ) !== true ) )


// The visible generation note + the scope line of the head (Memo 080, PRD-R2 / WI-025, Vollausbau).
// Byte-identical to RevisionAssembler (core): same wording, same template, same figure order — a one-sided
// change fails the hash-gated parity fixture. Both lines are a PURE function of the content rows: no clock,
// no commit hash, and no count of `revision` / `provenance` / `history_journal` (those are written after
// the render, so counting them would make the frozen body drift on the next verify).
//
// The note names SOURCE, PRODUCER and CHECK, and it is German — one language per artefact (Sprach-Matrix,
// Denglish-Verbot), not one per line.
const GENERATED_NOTE_PREFIX = '_Erzeugt aus der Memo-Datenbank `'
const GENERATED_NOTE_SUFFIX = '` durch `memo revision assemble`, geprueft durch `memo revision parity` — nicht hand-geschrieben._'

// The scope-line template — VENDORED, not imported: the viewer is a separate npm package and does not
// depend on memo-cli, so the file lives twice and is held byte-identical by a parity test in both repos
// (the same arrangement BlockSections and the body fixture already use). What must NOT exist twice is the
// FORMAT: there is no format literal on either side, only this one JSON.
const SCOPE_TEMPLATE_PATH = resolve( import.meta.dirname, '..', 'tests', 'fixtures', 'revision-scope-line-v1.json' )

const SCOPE_PRUEFER_KEY = 'node'

// The NINE figures in the seven groups of the template, each with the carrier that can count it. `needs`
// names COLUMNS, not only the table: `topic.status` and `work_item.disposition` were added to existing
// tables and the schema knows no ALTER, so an older database carries the table WITHOUT the column —
// counting through it threw "no such column" and took the whole render down. A missing column is the same
// statement as a missing table here: the figure is "nicht ausweisbar", never a 0 and never an exception.
const SCOPE_FIGURES = [
    { key: 'chapters', table: 'block_chapter', column: 'DISTINCT chapter', needs: [ 'chapter' ], where: null },
    { key: 'questions', table: 'question', column: '*', needs: [], where: null },
    { key: 'prds', table: 'prd', column: '*', needs: [], where: null },
    { key: 'phases', table: 'rollout_phase', column: '*', needs: [ 'id' ], where: "id != '__state__'" },
    { key: 'topics', table: 'topic', column: '*', needs: [], where: null },
    { key: 'registered', table: 'topic', column: '*', needs: [ 'status' ], where: "status = 'registered'" },
    { key: 'wis', table: 'work_item', column: '*', needs: [], where: null },
    { key: 'alive', table: 'work_item', column: '*', needs: [ 'status', 'disposition' ], where: "status = 'offen' AND ( disposition IS NULL OR disposition = 'behalten' )" },
    { key: 'phase_items', table: 'rollout_work_item', column: '*', needs: [], where: null }
]


// THE DOCUMENT ORDER, DECLARED — the MIRROR of RevisionAssembler DOCUMENT_SECTIONS (core), Memo 080,
// PRD-R1 Vollausbau / WI-027. The twelve `document` positions and their sequence are NOT declared here:
// they come from the ONE register (BlockSections.documentSections(), REV-18 Z. 158-172), and the
// load-time gate at the bottom of this file proves this plan's document subsequence is the register's.
// A one-sided edit against the core plan additionally fails the hash-gated parity fixture, which is what
// keeps the two renderers character-identical.
const DOCUMENT_SECTIONS = [
    { section: 'Kopf', level: 'document', render: [ 'head' ], movedBy: null },
    { section: 'Kontaminations-Metadaten', level: 'document', render: [ 'contaminationMeta' ], movedBy: null },
    { section: 'Kontext', level: 'document', render: [ 'kontext' ], movedBy: null },
    { section: 'Bloecke', level: 'document', render: [ 'blocks' ], movedBy: null },
    { section: 'Vorwort', level: 'document', render: [ 'vorwort' ], movedBy: null },
    { section: 'Offene Fragen', level: 'document', render: [ 'openQuestions' ], movedBy: null },
    { section: 'Beantwortete Fragen', level: 'document', render: [ 'answeredQuestions' ], movedBy: null },
    { section: 'Phasen und Phasen-Hinweise', level: 'document', render: [ 'phases', 'phaseHints' ], movedBy: null },
    { section: 'Finalisierungs-Checkliste', level: 'document', render: [ 'finalisierungsCheckliste' ], movedBy: null },
    { section: 'Anhaenge', level: 'document', render: [ 'anhaenge' ], movedBy: null },
    { section: 'Einstiegspunkte', level: 'document', render: [ 'einstiegspunkte' ], movedBy: null },
    { section: 'Lessons-Learned', level: 'document', render: [ 'lessonsLearned' ], movedBy: null },
    { section: 'Work Items', level: 'collective', render: [ 'workItems' ], movedBy: 'PRD-R3 (P0, WI-153) verlagert die Work-Items in den Block und entfernt diese Sammel-Tabelle (F24=A)' },
    { section: 'Topics', level: 'collective', render: [ 'topics' ], movedBy: 'PRD-R3 (P0) fuellt den erzeugten Block-Abschnitt `### Topics`; bis dahin steht das Register hier' },
    { section: 'Research', level: 'collective', render: [ 'research' ], movedBy: 'PRD-R3 (P0) fuellt den erzeugten Beleg-Abschnitt des Blocks, in den das Research-Register gehoert' },
    { section: 'Zurueckgestellte Fragen', level: 'collective', render: [ 'deferredQuestions' ], movedBy: 'PRD-F1 (P10, WI-076) legt diesen Abschnitt an; die zwoelf Pflicht-Positionen der Dokument-Ebene (REV-18 Z. 158-172) bleiben unveraendert, weil der Abschnitt BEDINGT ist — er erscheint nur bei zurueckgestelltem Bestand und steht deshalb hinter ihnen, neben "Beantwortete Fragen" und nie darin' },
    { section: 'Fragen', level: 'collective', render: [ 'questionsJson' ], movedBy: 'PRD-R1 (P0, WI-059) haelt diesen maschinenlesbaren Fragen-Zaun auf Dokument-Ebene — die Dokument-Ebene fuehrt nur die beiden LESBAREN Fragen-Abschnitte, und kein PRD dieses Rollouts verlagert den Zaun in einen Block' },
    { section: 'Snags', level: 'collective', render: [ 'snags' ], movedBy: 'PRD-R1 (P0, WI-061) hat diesen Abschnitt angelegt und haelt ihn auf Dokument-Ebene — kein PRD dieses Rollouts verlagert ihn in einen Block' },
    { section: 'Goals', level: 'collective', render: [ 'goals' ], movedBy: 'PRD-R1 (P0, WI-061) hat diesen Abschnitt angelegt und haelt ihn auf Dokument-Ebene — die Ziel-Tafel ist projekt-global, nicht kapitel-lokal' },
    { section: 'Maintenance', level: 'collective', render: [ 'maintenance' ], movedBy: 'PRD-R1 (P0, WI-061) hat diesen Abschnitt angelegt und haelt ihn auf Dokument-Ebene — die Wartungs-Tafel ist repo-global, nicht kapitel-lokal' }
]


// The two RETIRED question states and the two provenance groups of the answered section (Memo 080,
// PRD-F1 / WI-076) — byte-identical twins of the RevisionAssembler (core) copies. The group headings are
// the ones DocumentRegistry.#mapAnsweredProvenance recognises, so what this renderer writes is what that
// parser reads back.
const DEFERRED_STATUS = [ 'irrelevant', 'replaced' ]

const ANSWERED_PROVENANCE_GROUPS = [
    { value: 'user', heading: 'Vom User beantwortet' },
    { value: 'ai-on-behalf', heading: 'Von der KI im Namen des Users beantwortet' }
]


// The block toolkit in REGISTER order and the two kinds that are ALWAYS rendered — byte-identical to
// RevisionAssembler (core). No heading string is typed on this side either.
const BLOCK_SECTION_ORDER = BlockSections.all().sections

const BLOCK_SECTION_ALWAYS = [ 'required', 'generated' ]


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


// Memo 080, PRD-V2 (WI-102) — the KNOWLEDGE GRAPH, stage 1. The four tables the graph is built from, each
// with the FIXED select it is read with. This list is the only place a table or column of this surface is
// named: no name is ever assembled from a caller argument, so nothing from a request can reach the SQL
// (US-4). `kind` is both the node-id prefix and the mermaid class of that node kind.
const GRAPH_SOURCES = [
    { 'key': 'topics', 'kind': 'T', 'table': 'topic', 'sql': 'SELECT id, title, phase, block FROM topic ORDER BY id' },
    { 'key': 'workItems', 'kind': 'W', 'table': 'work_item', 'sql': 'SELECT id, topic, title, status FROM work_item ORDER BY id' },
    { 'key': 'phases', 'kind': 'P', 'table': 'rollout_phase', 'sql': "SELECT id, name, status FROM rollout_phase WHERE id != '__state__' ORDER BY id" },
    { 'key': 'prds', 'kind': 'R', 'table': 'rollout_work_item', 'sql': 'SELECT id, phase_id, title, status, target, wi_type FROM rollout_work_item ORDER BY phase_id, id' }
]


// The four node kinds with their mermaid class. Colours only — no interaction, no click handler: the
// existing renderer runs with securityLevel 'strict', which is left untouched by this stage (F13 / WI-103).
const GRAPH_CLASS_DEFS = [
    { 'kind': 'T', 'name': 'graphTopic', 'style': 'fill:#1f3a5f,stroke:#4a90d9,color:#e6f0fa' },
    { 'kind': 'W', 'name': 'graphWorkItem', 'style': 'fill:#24402b,stroke:#5aa75a,color:#e8f5e8' },
    { 'kind': 'P', 'name': 'graphPhase', 'style': 'fill:#4a3a1f,stroke:#c9a227,color:#faf3e0' },
    { 'kind': 'R', 'name': 'graphPrd', 'style': 'fill:#3f2b4a,stroke:#9b6ad9,color:#f2e8fa' }
]


// The seven figures every graph answer carries. Declared once so the leaf, the empty answer and the route
// all speak the SAME shape — a field can not go missing on one path only.
const GRAPH_COUNT_KEYS = [ 'topics', 'workItems', 'phases', 'prds', 'edgesTopicWorkItem', 'edgesPhasePrd', 'edgesTopicPrd' ]


// Memo 080, PRD-V2 rework — the diagram source carries a SIZE BUDGET, enforced on the producing side.
// Measured cause: mermaid does not fail loudly on an oversize source. Above `maxTextSize` characters
// (11.4.1 ships 50000 as the default, read back from mermaidAPI.getConfig() in real Chromium) the renderer
// THROWS THE SOURCE AWAY and resolves with a one-node placeholder tile "Maximum text size in diagram
// exceeded" — so the caller believes it drew what it asked for. The real inventory of memo 080 produced
// 53362 characters (102 topics · 223 work items · 221 edges): over the limit, and the view stated
// "325 Knoten / 221 Kanten" above that placeholder.
// The budget lies BELOW the limit the client declares (app.client.mjs MERMAID_MAX_TEXT_SIZE), with headroom,
// so no source that leaves this leaf can reach the substitution path. It is a function of the budget, not of
// today's 53362 — whatever the inventory grows to, the source either fits or the answer says that it does not.
const GRAPH_SOURCE_BUDGET = 45000


// The condensation ladder, walked from the widest cap down: the FIRST cap whose rendered source fits the
// budget wins. `null` = no cap (the full title), a number = the title truncated to that many characters,
// `0` = the identifier alone. Nodes and edges are NEVER dropped — the STRUCTURE stays complete, only the
// labels get shorter, and the step that was taken is named in `warnings` with its measured figures.
const GRAPH_LABEL_CAPS = [ null, 96, 72, 56, 40, 28, 16, 0 ]


// Is this column value a usable reference? An unset reference (null / empty / whitespace) is NOT an edge —
// it is simply no statement, and it is never guessed into one.
const hasGraphRef = ( value ) => {
    return value !== null && value !== undefined && String( value ).trim().length > 0
}


// A mermaid node id derived from a database id. INJECTIVE by construction: an alphanumeric character
// stays, EVERY other code point becomes `_<hex>_`, and the kind prefix separates the four node kinds. The
// naive rule ("replace anything unusual with _") would collapse `T-1` and `T_1` onto the same node — the
// whole CLASS of collisions is closed here, not the one reported case. The result carries [A-Za-z0-9_] only.
const graphNodeId = ( { kind, id } ) => {
    const encoded = Array.from( id === null || id === undefined ? '' : String( id ) )
        .map( ( char ) => /^[A-Za-z0-9]$/.test( char ) === true ? char : `_${ char.codePointAt( 0 ).toString( 16 ) }_` )
        .join( '' )

    return `${ kind }_${ encoded }`
}


// Escaping for a QUOTED mermaid label. `#` goes FIRST so a literal hash in a title can never form one of
// the entity codes the later rules emit. Every remaining glyph that ends a label or opens a second node
// shape becomes its numeric entity, which mermaid decodes back to the original character — the title keeps
// its meaning instead of being mangled. Again the CLASS, not the case: quote, all four bracket kinds,
// angle brackets, pipe and backtick. The existing `cell` helper above is for Markdown tables and covers
// none of these, which is why the graph carries its own.
const GRAPH_LABEL_ESCAPES = [
    [ /#/g, '#35;' ],
    [ /"/g, '#quot;' ],
    [ /\[/g, '#91;' ],
    [ /\]/g, '#93;' ],
    [ /\{/g, '#123;' ],
    [ /\}/g, '#125;' ],
    [ /</g, '#60;' ],
    [ />/g, '#62;' ],
    [ /\|/g, '#124;' ],
    [ /`/g, '#96;' ]
]


// A line break ends a mermaid node statement, so line breaks and tabs collapse to a single space BEFORE
// the entity escaping runs.
const graphLabel = ( value ) => {
    const text = ( value === null || value === undefined ? '' : String( value ) )
        .replace( /[\r\n\t]+/g, ' ' )
        .trim()

    return GRAPH_LABEL_ESCAPES
        .reduce( ( acc, entry ) => acc.replace( entry[ 0 ], entry[ 1 ] ), text )
}


// `<id> · <title>` — a row without a title renders its id alone rather than a dangling separator.
// `cap` is the condensation step (see GRAPH_LABEL_CAPS): `null` keeps the full title, `0` drops it, and a
// number truncates it. The cut runs on the RAW title, BEFORE the entity escaping — cutting afterwards could
// slice one of the `#quot;` codes in two and hand mermaid a broken label (same rule as the error-box cap).
const graphNodeLabel = ( { id, title, cap } ) => {
    const head = graphLabel( id )
    const raw = ( title === null || title === undefined ? '' : String( title ) )
    const kept = cap === 0
        ? ''
        : ( cap === null || cap === undefined || raw.length <= cap ? raw : `${ raw.slice( 0, cap ) }…` )
    const tail = graphLabel( kept )

    return tail.length === 0 ? head : `${ head } · ${ tail }`
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
            const markdown = DoltDbAssembler.#renderBody( { db, dbPath } )

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


    // Read the open/answered/deferred question counts of a per-memo database (Memo 079 FIX B). The pure
    // `question`-table counter. Memo 080, PRD-F1: "every other row is answered" was the SAME defect the
    // richer reader above carried — a retired question was reported as a decision that was never taken —
    // so this baseline gets the third figure from the same declared retired set. Since
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
                return { open: 0, answered: 0, deferred: 0 }
            }

            const openRow = DoltDbAssembler.#get( { db, sql: "SELECT count( * ) AS n FROM question WHERE status = 'open'" } )
            const totalRow = DoltDbAssembler.#get( { db, sql: 'SELECT count( * ) AS n FROM question' } )
            const deferredRow = DoltDbAssembler.#get( { db, sql: `SELECT count( * ) AS n FROM question WHERE status IN ( ${ DEFERRED_STATUS.map( ( status ) => `'${ status }'` ).join( ', ' ) } )` } )
            const open = openRow === null ? 0 : Number( openRow[ 'n' ] )
            const total = totalRow === null ? 0 : Number( totalRow[ 'n' ] )
            const deferred = deferredRow === null ? 0 : Number( deferredRow[ 'n' ] )

            return { open, answered: total - open - deferred, deferred }
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
                return { open: 0, answered: 0, deferred: 0, total: 0, allAnswered: false }
            }

            const openRows = DoltDbAssembler.#all( { db, sql: "SELECT id FROM question WHERE status = 'open'" } )
            const totalRow = DoltDbAssembler.#get( { db, sql: 'SELECT count( * ) AS n FROM question' } )
            const total = totalRow === null ? 0 : Number( totalRow[ 'n' ] )

            // Memo 080, PRD-F1 / WI-076: the RETIRED stock is its own figure. Before this it fell into
            // `answered` (everything that was not open counted as answered), which stated a decision that
            // was never taken. The `IN` list is the declared retired set, so a database that predates the
            // lifecycle simply reports 0 here and every other figure is exactly what it was.
            const deferredRow = DoltDbAssembler.#get( { db, sql: `SELECT count( * ) AS n FROM question WHERE status IN ( ${ DEFERRED_STATUS.map( ( status ) => `'${ status }'` ).join( ', ' ) } )` } )
            const deferred = deferredRow === null ? 0 : Number( deferredRow[ 'n' ] )

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
            const answered = ( total - openIds.length - deferred ) + cleared
            const allAnswered = total > 0 && open === 0

            return { open, answered, deferred, total, allAnswered }
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


    // The seven graph figures, all zero (Memo 080, PRD-V2 / WI-102). PUBLIC + pure so the route can answer
    // "this memo has no database" in the SAME shape a real read produces — the count shape exists once, and
    // a field can not go missing on the no-database path only.
    static emptyGraphCounts() {
        const counts = GRAPH_COUNT_KEYS
            .reduce( ( acc, key ) => Object.assign( acc, { [ key ]: 0 } ), {} )

        return counts
    }


    // The size facts of a graph that has no source at all (no database, empty database). PUBLIC + pure for
    // the same reason as emptyGraphCounts: the `source` shape exists ONCE, so no answer path can leave a
    // field out. `budget` is the single place the client's declared mermaid limit is mirrored against.
    // The seven fields: `chars` = the length of the source the answer SPEAKS OF (the one handed out, or the
    // narrowest one measured when none can be handed out), `fullChars` = the same graph at full title width,
    // `budget` = the declared ceiling, `labelCap` / `condensed` = the ladder step taken, `nodes` / `edges` =
    // how much was compared.
    static emptyGraphSourceFacts() {
        return { 'chars': 0, 'fullChars': 0, 'budget': GRAPH_SOURCE_BUDGET, 'labelCap': null, 'condensed': false, 'nodes': 0, 'edges': 0 }
    }


    // Memo 080, PRD-V2 (WI-102) — the KNOWLEDGE GRAPH of one memo, stage 1: the server builds the diagram
    // SOURCE deterministically from four tables, the client's EXISTING diagram registry draws it. No new
    // display building block, no new dependency, no second drawing path.
    //
    // The edge the user asked for — "welches Topic steckt in welchem PRD" — has no column of its own. It is
    // built over the WORK-ITEM BRIDGE: a rollout row whose `id` or `target` names a work_item inherits that
    // work item's `topic`. Where the bridge does not close, NO edge is invented.
    //
    // Every node has a read row behind it, and every edge has BOTH of its endpoints among those nodes — so
    // mermaid's implicit "a node named by an edge springs into existence" can never add a node the database
    // does not carry. A reference that points nowhere is not dropped in silence: it is counted and named in
    // `warnings` (Oelstand-Regel — a value at the edge of the accepted range is itself the finding).
    //
    // Returns { mermaid, counts, empty, warnings, reason, source }. `mermaid` is null in TWO cases, and
    // `reason` tells them apart: an empty database (`empty` true, reason 'empty-db') and a source that stays
    // over the size budget even with bare identifiers as labels (`empty` FALSE, reason 'source-too-large' —
    // see #fitGraphSource). A drawn graph answers reason null.
    // `counts` always carries all seven figures so the view can state HOW MUCH it compared, instead of an
    // empty canvas that would equally mean "nothing in the database" and "the read failed"; `source` carries
    // the seven measured size facts (emptyGraphSourceFacts) on EVERY path, drawn or not.
    //
    // Read-only open, close in `finally`; every table guarded by #tableExists, so an early database that
    // lacks these tables reads as all-zero instead of throwing.
    static readKnowledgeGraph( { dbPath } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readKnowledgeGraph: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readKnowledgeGraph: "${ dbPath }" does not exist — cannot read the knowledge graph` )
        }

        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            const rows = GRAPH_SOURCES
                .reduce( ( acc, source ) => {
                    const read = DoltDbAssembler.#tableExists( { db, 'table': source[ 'table' ] } ) === true
                        ? DoltDbAssembler.#all( { db, 'sql': source[ 'sql' ] } )
                        : []

                    return Object.assign( acc, { [ source[ 'key' ] ]: read } )
                }, {} )

            return DoltDbAssembler.#buildKnowledgeGraph( { rows } )
        } finally {
            db.close()
        }
    }


    // Is this file name a per-memo database? Memo 080, PRD-V3 (WI-104): the file-watcher needs the SAME
    // marker the Zwei-Regime weiche uses, and the pattern has exactly ONE home (DB_NAME_PATTERN above).
    // Public + pure so the watcher imports a rule instead of re-typing a regex — a second spelling of the
    // same pattern is the class of defect this avoids, not just the one call site.
    static isDbFileName( { fileName } ) {
        const isDbFile = typeof fileName === 'string' && DB_NAME_PATTERN.test( fileName ) === true

        return { isDbFile }
    }


    // Memo 080, PRD-V3 (WI-104) — the RUNTIME STATUS of one memo, read from the change-ledger. The eighth
    // public read leaf, and the cheapest possible change-signal: `history_journal` carries a MONOTONIC `seq`
    // (HistoryJournal.#nextSeq writes MAX(seq)+1 per commit), so ONE query on the maximum answers "did
    // anything change" without a full comparison, and the newest row names WHAT changed.
    //
    // Returns { seq, latest, phases, workItems, rolloutInDb }:
    //   * seq         — MAX(seq) of the ledger; 0 for an empty ledger and 0 for a database that has no
    //                   `history_journal` table at all (both are "nothing recorded", never a throw).
    //   * latest      — the newest ledger row { seq, entity, entityId, sessionId, at } or null. An empty
    //                   ledger yields null, NOT an invented row.
    //   * phases      — rows in `rollout_phase` WITHOUT the reserved `__state__` sentinel (the JSON
    //                   spillover row RolloutStateStore writes). The sentinel is not a phase and must not
    //                   be counted as one — same rule the scope line already applies (SCOPE_FIGURES).
    //   * workItems   — rows in `rollout_work_item`.
    //   * rolloutInDb — did the projection leave ANY row (sentinel INCLUDED)? This is the field that keeps
    //                   "nothing to report" apart from "nothing compared": a memo whose rollout state was
    //                   never normalized reads 0/0 exactly like a memo with an empty rollout, and a bare
    //                   0-of-0 balance would look green while nothing was ever measured. The sentinel
    //                   counts here — its presence proves the projection RAN, even if it wrote no phase.
    //
    // Read-only open, close in `finally`; every table guarded by #tableExists. NO write statement — the
    // single-writer discipline (F4=A) stays with the core CLI, the viewer stays a pure reader.
    static readRuntimeStatus( { dbPath } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readRuntimeStatus: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readRuntimeStatus: "${ dbPath }" does not exist — cannot read the history journal` )
        }

        const db = DoltDbAssembler.#open( { dbPath } )
        try {
            const hasJournal = DoltDbAssembler.#tableExists( { db, 'table': 'history_journal' } )
            const maxRow = hasJournal === true
                ? DoltDbAssembler.#get( { db, 'sql': 'SELECT MAX( seq ) AS m FROM history_journal' } )
                : null
            const maxSeq = maxRow === null || maxRow[ 'm' ] === null || maxRow[ 'm' ] === undefined
                ? 0
                : Number( maxRow[ 'm' ] )
            const latestRow = hasJournal === true && maxSeq > 0
                ? DoltDbAssembler.#get( { db, 'sql': 'SELECT seq, entity, entity_id, session_id, `at` FROM history_journal ORDER BY seq DESC LIMIT 1' } )
                : null
            const latest = latestRow === null
                ? null
                : {
                    'seq': Number( latestRow[ 'seq' ] ),
                    'entity': latestRow[ 'entity' ] === undefined ? null : latestRow[ 'entity' ],
                    'entityId': latestRow[ 'entity_id' ] === undefined ? null : latestRow[ 'entity_id' ],
                    'sessionId': latestRow[ 'session_id' ] === undefined ? null : latestRow[ 'session_id' ],
                    'at': latestRow[ 'at' ] === undefined ? null : latestRow[ 'at' ]
                }

            const countOf = ( { table, where } ) => {
                if( DoltDbAssembler.#tableExists( { db, table } ) !== true ) {
                    return 0
                }
                const clause = where === null ? '' : ` WHERE ${ where }`
                const row = DoltDbAssembler.#get( { db, 'sql': `SELECT count( * ) AS n FROM \`${ table }\`${ clause }` } )

                return row === null ? 0 : Number( row[ 'n' ] )
            }

            const phases = countOf( { 'table': 'rollout_phase', 'where': "id != '__state__'" } )
            const phaseRowsAll = countOf( { 'table': 'rollout_phase', 'where': null } )
            const workItems = countOf( { 'table': 'rollout_work_item', 'where': null } )
            const rolloutInDb = phaseRowsAll > 0 || workItems > 0

            return { 'seq': maxSeq, latest, phases, workItems, rolloutInDb }
        } finally {
            db.close()
        }
    }


    // Memo 080, Kap 19, PRD-V9 (WI-098) — the durable answers that belong to ONE transcript.
    //
    // THE BINDING PROBLEM, MEASURED FIRST: `user_input_answers` has no transcript column, and neither
    // has `user_inputs`. What both DO carry is the payload the capture wrote: `user_inputs.payload_sha256`
    // is sha256 over the RAW transcript content the viewer piped into `memo user-input record`
    // (UserInputStore.recordInput). So the transcript file on disk and its input row share a fingerprint.
    // Measured against the live memo-080 store before this leaf was written: 10 of 11 transcript files
    // resolve to their input row by sha256; the one miss is REV-09--terminal--01.md, a terminal transcript
    // that never ran through the widget capture. Re-measure with
    //   node -e "…createHash('sha256').update(readFileSync(f)).digest('hex')…" vs
    //   SELECT payload_sha256 FROM user_inputs
    //
    // NO GUESSED BINDING. If the fingerprint does not resolve, the answer set is EMPTY and `match` says
    // 'none' — the leaf never falls back to "the newest review row of this memo", because two open
    // revisions would then hand a session the wrong user's decision. `comparedInputs` states how many
    // input rows were searched, so an empty answer set is a measured empty and not a vacuum (lesson
    // deterministic-gates-can-be-vacuum-green).
    //
    // Returns { answers, inputId, match, comparedInputs }:
    //   * answers       — [ { questionId, optionKey, answerVerbatim, preselected } ], ordered by question
    //   * inputId       — the resolved user_inputs row id, or null
    //   * match         — 'sha256' | 'none' | 'no-table'
    //   * comparedInputs— how many user_inputs rows the fingerprint was compared against
    //
    // Read-only open, close in `finally`; both tables guarded by #tableExists. NO write statement.
    static readAnswersForPayload( { dbPath, payload } ) {
        if( typeof dbPath !== 'string' || dbPath.length === 0 ) {
            throw new Error( 'DoltDbAssembler.readAnswersForPayload: "dbPath" is required (non-empty string)' )
        }
        if( existsSync( dbPath ) !== true ) {
            throw new Error( `DoltDbAssembler.readAnswersForPayload: "${ dbPath }" does not exist — cannot read the answer store` )
        }
        if( typeof payload !== 'string' ) {
            throw new Error( 'DoltDbAssembler.readAnswersForPayload: "payload" is required (string — the raw transcript content)' )
        }

        const sha256 = createHash( 'sha256' ).update( payload ).digest( 'hex' )
        const db = DoltDbAssembler.#open( { dbPath } )

        try {
            if( DoltDbAssembler.#tableExists( { db, 'table': 'user_inputs' } ) !== true ) {
                return { 'answers': [], 'inputId': null, 'match': 'no-table', 'comparedInputs': 0, sha256 }
            }

            const countRow = DoltDbAssembler.#get( { db, 'sql': 'SELECT count( * ) AS n FROM user_inputs' } )
            const comparedInputs = countRow === null ? 0 : Number( countRow[ 'n' ] )
            const hit = DoltDbAssembler.#getWith( {
                db,
                'sql': 'SELECT input_id FROM user_inputs WHERE payload_sha256 = ? ORDER BY captured_at DESC LIMIT 1',
                'params': [ sha256 ]
            } )

            if( hit === null ) {
                return { 'answers': [], 'inputId': null, 'match': 'none', comparedInputs, sha256 }
            }

            const inputId = hit[ 'input_id' ]

            if( DoltDbAssembler.#tableExists( { db, 'table': 'user_input_answers' } ) !== true ) {
                return { 'answers': [], inputId, 'match': 'no-table', comparedInputs, sha256 }
            }

            const rows = DoltDbAssembler.#allWith( {
                db,
                'sql': 'SELECT question_id, option_key, answer_verbatim, preselected FROM user_input_answers WHERE input_id = ? ORDER BY question_id',
                'params': [ inputId ]
            } )
            const answers = rows
                .map( ( row ) => ( {
                    'questionId': row[ 'question_id' ] === undefined ? null : row[ 'question_id' ],
                    'optionKey': row[ 'option_key' ] === undefined ? null : row[ 'option_key' ],
                    'answerVerbatim': row[ 'answer_verbatim' ] === undefined ? null : row[ 'answer_verbatim' ],
                    'preselected': Number( row[ 'preselected' ] ) === 1
                } ) )

            return { answers, inputId, 'match': 'sha256', comparedInputs, sha256 }
        } finally {
            db.close()
        }
    }


    // ---- private ----

    // The PURE part of readKnowledgeGraph: rows in, { mermaid, counts, empty, warnings, reason, source } out
    // — the same shape on every path, including the two `mermaid: null` cases named above readKnowledgeGraph.
    // Split out so the reading and the graph rule are separable, and so the whole edge logic is one place.
    static #buildKnowledgeGraph( { rows } ) {
        const topics = rows[ 'topics' ]
        const workItems = rows[ 'workItems' ]
        const phases = rows[ 'phases' ]
        const prds = rows[ 'prds' ]

        const topicIds = new Set( topics.map( ( row ) => String( row[ 'id' ] ) ) )
        const phaseIds = new Set( phases.map( ( row ) => String( row[ 'id' ] ) ) )
        const workItemById = new Map( workItems.map( ( row ) => [ String( row[ 'id' ] ), row ] ) )

        // A node carries the RAW identifier and title, not a finished label: the label is built per
        // condensation step in #renderGraphSource, so the same node set can be rendered at several label
        // widths without reading the database twice.
        const nodes = []
            .concat( topics.map( ( row ) => ( { 'kind': 'T', 'id': graphNodeId( { 'kind': 'T', 'id': row[ 'id' ] } ), 'rawId': row[ 'id' ], 'rawTitle': row[ 'title' ] } ) ) )
            .concat( workItems.map( ( row ) => ( { 'kind': 'W', 'id': graphNodeId( { 'kind': 'W', 'id': row[ 'id' ] } ), 'rawId': row[ 'id' ], 'rawTitle': row[ 'title' ] } ) ) )
            .concat( phases.map( ( row ) => ( { 'kind': 'P', 'id': graphNodeId( { 'kind': 'P', 'id': row[ 'id' ] } ), 'rawId': row[ 'id' ], 'rawTitle': row[ 'name' ] } ) ) )
            .concat( prds.map( ( row ) => ( { 'kind': 'R', 'id': graphNodeId( { 'kind': 'R', 'id': row[ 'id' ] } ), 'rawId': row[ 'id' ], 'rawTitle': row[ 'title' ] } ) ) )

        // Topic -> Work-Item, straight from work_item.topic.
        const topicWorkItemRefs = workItems
            .filter( ( row ) => hasGraphRef( row[ 'topic' ] ) === true )
        const topicWorkItemEdges = DoltDbAssembler.#dedupeEdges( {
            'edges': topicWorkItemRefs
                .filter( ( row ) => topicIds.has( String( row[ 'topic' ] ).trim() ) === true )
                .map( ( row ) => ( {
                    'from': graphNodeId( { 'kind': 'T', 'id': String( row[ 'topic' ] ).trim() } ),
                    'to': graphNodeId( { 'kind': 'W', 'id': row[ 'id' ] } )
                } ) )
        } )

        // Phase -> PRD, straight from rollout_work_item.phase_id.
        const phasePrdRefs = prds
            .filter( ( row ) => hasGraphRef( row[ 'phase_id' ] ) === true )
        const phasePrdEdges = DoltDbAssembler.#dedupeEdges( {
            'edges': phasePrdRefs
                .filter( ( row ) => phaseIds.has( String( row[ 'phase_id' ] ).trim() ) === true )
                .map( ( row ) => ( {
                    'from': graphNodeId( { 'kind': 'P', 'id': String( row[ 'phase_id' ] ).trim() } ),
                    'to': graphNodeId( { 'kind': 'R', 'id': row[ 'id' ] } )
                } ) )
        } )

        // Topic -> PRD over the work-item bridge: `id` first, `target` second. A rollout row that names no
        // known work item, or a work item that carries no known topic, yields NOTHING — never a guess.
        const topicPrdEdges = DoltDbAssembler.#dedupeEdges( {
            'edges': prds
                .map( ( row ) => {
                    const bridge = [ row[ 'id' ], row[ 'target' ] ]
                        .filter( ( candidate ) => hasGraphRef( candidate ) === true )
                        .map( ( candidate ) => workItemById.get( String( candidate ).trim() ) )
                        .find( ( found ) => found !== undefined && hasGraphRef( found[ 'topic' ] ) === true && topicIds.has( String( found[ 'topic' ] ).trim() ) === true )

                    return bridge === undefined
                        ? null
                        : {
                            'from': graphNodeId( { 'kind': 'T', 'id': String( bridge[ 'topic' ] ).trim() } ),
                            'to': graphNodeId( { 'kind': 'R', 'id': row[ 'id' ] } )
                        }
                } )
                .filter( ( edge ) => edge !== null )
        } )

        const counts = {
            'topics': topics.length,
            'workItems': workItems.length,
            'phases': phases.length,
            'prds': prds.length,
            'edgesTopicWorkItem': topicWorkItemEdges.length,
            'edgesPhasePrd': phasePrdEdges.length,
            'edgesTopicPrd': topicPrdEdges.length
        }
        const empty = topics.length === 0 && workItems.length === 0 && phases.length === 0 && prds.length === 0

        if( empty === true ) {
            const emptyWarnings = DoltDbAssembler.#graphWarnings( {
                counts, empty, 'danglingTopicRefs': 0, 'danglingPhaseRefs': 0,
                'source': DoltDbAssembler.emptyGraphSourceFacts()
            } )

            return {
                'mermaid': null, counts, 'empty': true, 'warnings': emptyWarnings, 'reason': 'empty-db',
                'source': DoltDbAssembler.emptyGraphSourceFacts()
            }
        }

        const edges = [].concat( topicWorkItemEdges ).concat( phasePrdEdges ).concat( topicPrdEdges )
        const fitted = DoltDbAssembler.#fitGraphSource( { nodes, edges } )
        const warnings = DoltDbAssembler.#graphWarnings( {
            counts, empty,
            'danglingTopicRefs': topicWorkItemRefs.length - topicWorkItemEdges.length,
            'danglingPhaseRefs': phasePrdRefs.length - phasePrdEdges.length,
            'source': fitted[ 'source' ]
        } )

        return {
            'mermaid': fitted[ 'mermaid' ], counts, 'empty': false, warnings,
            'reason': fitted[ 'mermaid' ] === null ? 'source-too-large' : null,
            'source': fitted[ 'source' ]
        }
    }


    // Fit the diagram source into GRAPH_SOURCE_BUDGET. The full-width source is rendered and measured first;
    // only when it is over budget is the condensation ladder walked, and the FIRST cap that fits wins. The
    // reduce short-circuits on the first hit, so a graph that fits at full width is rendered exactly once.
    // Nothing is dropped: every node and every edge is in every attempt, only the label width changes. If
    // even bare identifiers stay over budget, `mermaid` is null and the caller reports that honestly — an
    // oversize source is NEVER handed to the renderer, because the renderer would silently substitute a
    // placeholder for it and the view would claim a drawing that never happened.
    //
    // The two measured lengths are kept apart, because a report may only name the figure its sentence is
    // about: `fullChars` is ALWAYS the source at full title width, and `chars` is ALWAYS the source the
    // statement speaks of — the one that is handed out when there is one, and the NARROWEST one the ladder
    // reached when there is none. Naming the full width in the "not even bare identifiers fit" case reported
    // a number that was never measured against the budget in that sentence (measured on 1400 nodes / 700
    // edges: 370402 characters at full width against 69622 with bare identifiers).
    static #fitGraphSource( { nodes, edges } ) {
        const full = DoltDbAssembler.#renderGraphSource( { nodes, edges, 'cap': null } )
        const fullChars = full.length

        // The caps run from wide to narrow and the walk stops at the first fit, so the LAST source that was
        // rendered is always the narrowest one that was measured. It starts at the full width, which is the
        // right answer when no narrower attempt was needed at all.
        const walked = full.length <= GRAPH_SOURCE_BUDGET
            ? { 'fitted': { 'mermaid': full, 'cap': null, 'chars': full.length }, 'narrowestChars': fullChars }
            : GRAPH_LABEL_CAPS
                .filter( ( cap ) => cap !== null )
                .reduce( ( acc, cap ) => {
                    if( acc[ 'fitted' ] !== null ) {
                        return acc
                    }
                    const source = DoltDbAssembler.#renderGraphSource( { nodes, edges, cap } )

                    return {
                        'fitted': source.length <= GRAPH_SOURCE_BUDGET ? { 'mermaid': source, cap, 'chars': source.length } : null,
                        'narrowestChars': source.length
                    }
                }, { 'fitted': null, 'narrowestChars': fullChars } )

        const fitted = walked[ 'fitted' ]
        const facts = {
            'chars': fitted === null ? walked[ 'narrowestChars' ] : fitted[ 'chars' ],
            'fullChars': fullChars,
            'budget': GRAPH_SOURCE_BUDGET,
            'labelCap': fitted === null ? null : fitted[ 'cap' ],
            'condensed': fitted !== null && fitted[ 'cap' ] !== null,
            'nodes': nodes.length,
            'edges': edges.length
        }

        return { 'mermaid': fitted === null ? null : fitted[ 'mermaid' ], 'source': facts }
    }


    // Drop a repeated reference: a doubled bridge produces ONE edge, not two. The pair is the key, so two
    // different pairs are never folded together.
    static #dedupeEdges( { edges } ) {
        const seen = new Set()

        return edges
            .filter( ( edge ) => {
                const key = `${ edge[ 'from' ] }-->${ edge[ 'to' ] }`

                if( seen.has( key ) === true ) {
                    return false
                }
                seen.add( key )

                return true
            } )
    }


    // The honest findings about THIS graph. Every branch names the measured figures, so a reader can tell
    // "nothing is there" from "something is there but does not connect" — the two cases an empty canvas
    // would render identically.
    static #graphWarnings( { counts, empty, danglingTopicRefs, danglingPhaseRefs, source } ) {
        const emptyWarning = empty === true
            ? [ 'Keine Zeilen in topic, work_item, rollout_phase und rollout_work_item — 0 Knoten und 0 Kanten verglichen.' ]
            : []
        const unlinkedWarning = empty !== true && counts[ 'topics' ] > 0 && counts[ 'prds' ] > 0 && counts[ 'edgesTopicPrd' ] === 0
            ? [ `Auffaellig: ${ counts[ 'topics' ] } Topics und ${ counts[ 'prds' ] } PRDs gelesen, aber keine einzige Topic-zu-PRD-Kante — die Work-Item-Bruecke traegt nicht.` ]
            : []
        // The same rule one step earlier: if ONE end of the requested Topic->PRD edge has no rows at all,
        // an edge count of zero is arithmetically unavoidable and would otherwise look like a clean result.
        // Naming it keeps "there is nothing to connect" apart from "it does not connect" — the two cases a
        // bare zero would render identically.
        const missingSideWarning = empty !== true
            && ( counts[ 'topics' ] === 0 || counts[ 'prds' ] === 0 )
            && ( counts[ 'topics' ] > 0 || counts[ 'prds' ] > 0 )
            ? [ `Auffaellig: ${ counts[ 'topics' ] } Topics und ${ counts[ 'prds' ] } PRD-Zeilen gelesen — eine Seite der Topic-zu-PRD-Kante fehlt ganz, sie kann derzeit gar nicht entstehen.` ]
            : []
        const danglingTopicWarning = danglingTopicRefs > 0
            ? [ `Auffaellig: ${ danglingTopicRefs } Work-Item-Zeile(n) verweisen auf ein Topic, das nicht in der Tabelle topic steht — die Kante wird nicht gezeichnet.` ]
            : []
        const danglingPhaseWarning = danglingPhaseRefs > 0
            ? [ `Auffaellig: ${ danglingPhaseRefs } Rollout-Zeile(n) verweisen auf eine Phase, die nicht in der Tabelle rollout_phase steht — die Kante wird nicht gezeichnet.` ]
            : []
        // The size findings. All three name the measured characters against the budget, because "the drawing
        // is complete" and "the labels were shortened to make it fit" look identical on the canvas — and the
        // near-edge case is itself the finding, not something to wave through (Oelstand-Regel). Every figure
        // is named for what it IS: `chars` is the source the sentence is about (bare identifiers in the
        // not-drawn case), `fullChars` the same graph at full title width. Mixing the two states a number
        // that was never measured against the budget in that sentence.
        const tooLargeWarning = source[ 'chars' ] > source[ 'budget' ]
            ? [ `Nicht gezeichnet: auch mit reinen Kennungen als Beschriftung bleibt die Quelle mit ${ source[ 'chars' ] } Zeichen ueber dem Budget von ${ source[ 'budget' ] } (mit vollen Titeln waeren es ${ source[ 'fullChars' ] } Zeichen) — ${ source[ 'nodes' ] } Knoten und ${ source[ 'edges' ] } Kanten sind zu gross fuer den Zeichner.` ]
            : []
        const condensedWarning = source[ 'condensed' ] === true
            ? [ `Beschriftungen auf ${ source[ 'labelCap' ] } Zeichen gekuerzt: die volle Quelle waere ${ source[ 'fullChars' ] } Zeichen lang, das Budget liegt bei ${ source[ 'budget' ] }. Alle ${ source[ 'nodes' ] } Knoten und ${ source[ 'edges' ] } Kanten sind gezeichnet, nur die Titel sind beschnitten.` ]
            : []
        const nearEdgeWarning = source[ 'condensed' ] !== true && source[ 'chars' ] <= source[ 'budget' ] && source[ 'chars' ] > Math.floor( source[ 'budget' ] * 0.9 )
            ? [ `Auffaellig: die Quelle liegt mit ${ source[ 'chars' ] } Zeichen dicht unter dem Budget von ${ source[ 'budget' ] } — der naechste Zuwachs im Bestand kuerzt die Beschriftungen.` ]
            : []

        return [].concat( emptyWarning ).concat( unlinkedWarning ).concat( missingSideWarning )
            .concat( danglingTopicWarning ).concat( danglingPhaseWarning )
            .concat( tooLargeWarning ).concat( condensedWarning ).concat( nearEdgeWarning )
    }


    // The diagram source: `flowchart LR`, one line per node, one line per edge, the four classDef lines and
    // a class assignment per kind that actually has nodes. Nothing else — the source is a pure function of
    // the read rows AND the label cap, so the same database at the same cap always produces the same drawing.
    static #renderGraphSource( { nodes, edges, cap } ) {
        const classDefLines = GRAPH_CLASS_DEFS
            .map( ( entry ) => `    classDef ${ entry[ 'name' ] } ${ entry[ 'style' ] }` )
        const nodeLines = nodes
            .map( ( node ) => `    ${ node[ 'id' ] }["${ graphNodeLabel( { 'id': node[ 'rawId' ], 'title': node[ 'rawTitle' ], cap } ) }"]` )
        const edgeLines = edges
            .map( ( edge ) => `    ${ edge[ 'from' ] } --> ${ edge[ 'to' ] }` )
        const classLines = GRAPH_CLASS_DEFS
            .map( ( entry ) => {
                const members = nodes
                    .filter( ( node ) => node[ 'kind' ] === entry[ 'kind' ] )
                    .map( ( node ) => node[ 'id' ] )

                return members.length === 0 ? null : `    class ${ members.join( ',' ) } ${ entry[ 'name' ] }`
            } )
            .filter( ( line ) => line !== null )

        return [ 'flowchart LR' ]
            .concat( classDefLines )
            .concat( nodeLines )
            .concat( edgeLines )
            .concat( classLines )
            .join( '\n' )
    }



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


    // Bound-parameter siblings of #all/#get (Memo 080, PRD-V9). A transcript fingerprint and an input id
    // are caller-supplied values, so they travel as `?` parameters — never spliced into the statement.
    static #allWith( { db, sql, params } ) {
        return db.prepare( sql ).all( ...params )
    }


    static #getWith( { db, sql, params } ) {
        const row = db.prepare( sql ).get( ...params )

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


    static #renderBody( { db, dbPath } ) {
        const memo = DoltDbAssembler.#memoRow( { db } )
        const context = DoltDbAssembler.#readContext( { db } )
        const workItems = DoltDbAssembler.#all( { db, sql: 'SELECT id, topic, title, status, grp FROM work_item ORDER BY id' } )
        const blocks = DoltDbAssembler.#all( { db, sql: 'SELECT id, title, sort FROM block ORDER BY sort, id' } )
        // Memo 080, PRD-D5 — mirrors RevisionAssembler.#renderBody. `block_tables` is read with SELECT *
        // because it carries TWO independent additive sets (the `render` kind and the pointer pair), and
        // every field is read defensively so an early hand-seeded db that has neither still renders exactly
        // as before; `block_diagrams` carries one additive set and is PRAGMA-probed. Where a pointer IS
        // present the payload is pulled in and CHECKED here, before any interpolation.
        // Memo 080, PRD-R3 Vollausbau — mirrors RevisionAssembler: the AUTHORED order (`sort`) leads and the
        // id is only the tie-break. `sort` / `section` are ADDITIVE and PRAGMA-probed with the identical
        // probe, so both renderers degrade to the old ORDER BY on a database that predates them and stay
        // byte-identical on ANY database state.
        const pointer = DoltDbAssembler.#pointerContext( { dbPath } )
        const hasTableSort = DoltDbAssembler.#hasColumns( { db, table: 'block_tables', columns: [ 'sort' ] } )
        const rawBlockTables = DoltDbAssembler.#all( { db, sql: hasTableSort === true
            ? 'SELECT * FROM block_tables ORDER BY block_id, sort, id'
            : 'SELECT * FROM block_tables ORDER BY block_id, id'
        } )
        const blockTables = DoltDbAssembler.#resolveTablePayloads( { rows: rawBlockTables, pointer } )
        const hasDiagramPointer = DoltDbAssembler.#hasColumns( { db, table: 'block_diagrams', columns: [ 'source_ref', 'source_sha256' ] } )
        const hasDiagramSort = DoltDbAssembler.#hasColumns( { db, table: 'block_diagrams', columns: [ 'sort', 'section' ] } )
        const diagramColumns = [ 'id', 'block_id', 'title', 'kind', '`source`', 'feed' ]
            .concat( hasDiagramPointer === true ? [ 'source_ref', 'source_sha256' ] : [] )
            .concat( hasDiagramSort === true ? [ 'sort', 'section' ] : [] )
        const rawBlockDiagrams = DoltDbAssembler.#all( {
            db,
            sql: `SELECT ${ diagramColumns.join( ', ' ) } FROM block_diagrams ORDER BY block_id, ${ hasDiagramSort === true ? 'sort, ' : '' }id`
        } )
        const blockDiagrams = DoltDbAssembler.#resolveDiagramPayloads( { rows: rawBlockDiagrams, pointer } )
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
        // PRD-F3 (Memo 080 Kap 18, WI-078): `preselected` joins the read so #latestAnswer can break a
        // TIE. Column-guarded, not assumed: a database predating the column keeps the four-column read
        // and every row then carries no provenance at all — which the tie-break reads as "not stated"
        // and leaves the existing order untouched, rather than inventing a 0 that would look measured.
        // Byte-identical to the core RevisionAssembler read.
        const hasPreselected = DoltDbAssembler.#hasColumns( { db, table: 'user_input_answers', columns: [ 'preselected' ] } )
        const answerColumns = hasPreselected === true
            ? 'input_id, question_id, option_key, answer_verbatim, preselected'
            : 'input_id, question_id, option_key, answer_verbatim'
        const answers = DoltDbAssembler.#tableExists( { db, table: 'user_input_answers' } ) === true
            ? DoltDbAssembler.#all( { db, sql: `SELECT ${ answerColumns } FROM user_input_answers ORDER BY question_id, input_id` } )
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
        // The block toolkit carrier and the session table (Memo 080, PRD-R1 Vollausbau) — the same reads,
        // the same ORDER BY and the same #tableExists guard-and-degrade the core RevisionAssembler applies.
        const blockSections = DoltDbAssembler.#tableExists( { db, table: 'block_section' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT id, block_id, name, body, sort FROM block_section ORDER BY block_id, sort, id' } )
            : []
        const sessionRows = DoltDbAssembler.#tableExists( { db, table: 'sessions' } ) === true
            ? DoltDbAssembler.#all( { db, sql: 'SELECT session_id, role, model, started_at, tokens, tool_calls FROM sessions ORDER BY started_at, session_id' } )
            : []

        const head = DoltDbAssembler.#renderHead( { db, memo, headRows } )
        const rendered = DoltDbAssembler.#renderBlocks( { blocks, blockTables, blockDiagrams, blockSections } )

        // ONE renderer per declared position — the mirror of the core render map.
        const parts = {
            head: head.lines,
            contaminationMeta: DoltDbAssembler.#renderContaminationMeta( { rows: sessionRows } ),
            kontext: DoltDbAssembler.#renderKontext( { context } ),
            blocks: rendered.lines,
            vorwort: DoltDbAssembler.#renderProse( { sections, heading: 'Vorwort' } ),
            openQuestions: DoltDbAssembler.#renderOpenQuestions( { questions } ),
            answeredQuestions: DoltDbAssembler.#renderAnsweredQuestions( { questions, questionOptions, answers } ),
            deferredQuestions: DoltDbAssembler.#renderDeferredQuestions( { questions } ),
            // ONE document-level position, TWO renderers — the position binds a LIST of handles, exactly
            // as the core plan does, so no `.concat()` chain composes the body order on either side.
            phases: DoltDbAssembler.#renderPhases( { phases, phaseWorkItems } ),
            phaseHints: DoltDbAssembler.#renderProse( { sections, heading: 'Phase-Hints' } ),
            finalisierungsCheckliste: DoltDbAssembler.#renderProse( { sections, heading: 'Finalisierungs-Checkliste' } ),
            anhaenge: DoltDbAssembler.#renderProse( { sections, heading: 'Ancillary Files' } ),
            einstiegspunkte: DoltDbAssembler.#renderProse( { sections, heading: 'Rollout-Entry-Points' } ),
            lessonsLearned: DoltDbAssembler.#renderProse( { sections, heading: 'Lessons-Learned' } ),
            workItems: DoltDbAssembler.#renderWorkItems( { workItems } ),
            topics: DoltDbAssembler.#renderTopics( { topics } ),
            research: DoltDbAssembler.#renderResearch( { research, researchTopics, researchFiles, pointer } ),
            questionsJson: DoltDbAssembler.#renderQuestionsJson( { questions, questionOptions } ),
            snags: DoltDbAssembler.#renderSnags( { snags } ),
            goals: DoltDbAssembler.#renderGoals( { goals } ),
            maintenance: DoltDbAssembler.#renderMaintenance( { cards: maintenanceCards } )
        }

        // The section ORDER mirrors RevisionAssembler.#renderBody exactly — it is part of the byte
        // equality, and since Memo 080 / PRD-R1 Vollausbau it is the SAME declared list on both sides
        // instead of two call chains that could drift without a check noticing.
        return DOCUMENT_SECTIONS
            .map( ( entry ) => DoltDbAssembler.#sectionLines( { entry, parts } ) )
            .reduce( ( acc, part ) => acc.concat( part ), [] )
            .join( '\n' )
    }


    // Byte-identical to RevisionAssembler.#sectionLines: a position binds a LIST of render handles, and
    // an unknown handle fails LOUD.
    static #sectionLines( { entry, parts } ) {
        const unknown = entry[ 'render' ]
            .filter( ( handle ) => Object.prototype.hasOwnProperty.call( parts, handle ) !== true )
        if( unknown.length > 0 ) {
            throw new Error( `DoltDbAssembler: document position "${ entry[ 'section' ] }" names renderer(s) "${ unknown.join( ', ' ) }", which this render does not provide — declared handles: ${ Object.keys( parts ).join( ', ' ) }` )
        }

        return entry[ 'render' ]
            .map( ( handle ) => parts[ handle ] )
            .reduce( ( acc, part ) => acc.concat( part ), [] )
    }


    // Byte-identical to RevisionAssembler.#renderContaminationMeta — the mandatory document-level section
    // fed by the `sessions` table (REV-18 Z. 159). Empty renders `_no sessions_`.
    static #renderContaminationMeta( { rows } ) {
        const heading = [ '## Kontaminations-Metadaten', '' ]
        if( rows.length === 0 ) {
            return heading.concat( [ '_no sessions_', '' ] )
        }

        const table = [
            '| Session | Role | Model | Started | Tokens | Tool calls |',
            '| --- | --- | --- | --- | --- | --- |'
        ]
        const bodyRows = rows
            .map( ( row ) => `| ${ cell( row[ 'session_id' ] ) } | ${ cell( row[ 'role' ] ) } | ${ cell( row[ 'model' ] ) } | ${ cell( row[ 'started_at' ] ) } | ${ cell( row[ 'tokens' ] ) } | ${ cell( row[ 'tool_calls' ] ) } |` )

        return heading
            .concat( table )
            .concat( bodyRows )
            .concat( [ '' ] )
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
        const lines = [ `# ${ cell( memo[ 'name' ] ) }`, '', DoltDbAssembler.#generatedNote( { memo } ), '', DoltDbAssembler.#scopeLine( { db } ), '', '| Feld | Wert |', '| --- | --- |' ]
            .concat( rows )
            .concat( [ '' ] )

        return { lines, fields: rows.length }
    }


    // Byte-identical to RevisionAssembler.#generatedNote (core): the source is the per-memo database FILE
    // NAME derived from the memo id (`M080` -> `memo-080.db`), so the note points at a file the reader can
    // open. An id without a number yields the id itself — a stated fallback, never an invented file name.
    static #generatedNote( { memo } ) {
        const id = memo[ 'id' ] === null || memo[ 'id' ] === undefined ? '' : String( memo[ 'id' ] )
        const digits = id.replace( /^\D+/, '' )
        const source = digits.length > 0 ? `memo-${ digits }.db` : `memo-${ id }.db`

        return `${ GENERATED_NOTE_PREFIX }${ source }${ GENERATED_NOTE_SUFFIX }`
    }


    // Byte-identical to RevisionAssembler.#scopeLine (core): the NINE figures of the Umfangszeile in the
    // seven groups of the SHARED template, each figure named WITH its carrier. Every count is
    // column-guarded; a MISSING carrier renders the template's `nicht ausweisbar` wording and never a 0 —
    // an invented number in a head that ASSERTS is exactly the vacuum this memo closes.
    static #scopeLine( { db } ) {
        const template = DoltDbAssembler.#scopeTemplate()
        const figures = SCOPE_FIGURES
            .reduce( ( acc, carrier ) => ( { ...acc, [ carrier[ 'key' ] ]: DoltDbAssembler.#countCarrier( { db, carrier } ) } ), {} )
        const values = DoltDbAssembler.#scopeSlots( { template, figures } )
        const groups = template[ 'groups' ]
            .map( ( group ) => DoltDbAssembler.#fillSlots( { format: group[ 'format' ], values } ) )
        const tail = DoltDbAssembler.#fillSlots( { format: template[ 'tail' ], values: { pruefer: template[ 'pruefer' ][ SCOPE_PRUEFER_KEY ] } } )

        return `${ template[ 'label' ] } ${ groups.join( template[ 'separator' ] ) }${ tail }`
    }


    // The vendored template. Read on every render (never cached in a module variable), so a divergent copy
    // is caught by the parity fixture instead of by a stale process.
    static #scopeTemplate() {
        return JSON.parse( readFileSync( SCOPE_TEMPLATE_PATH, 'utf8' ) )
    }


    // Mirror of RevisionAssembler.#scopeSlots: a figure without a carrier is `null` and becomes the
    // template's `unavailable` wording — and so does every slot derived from it.
    static #scopeSlots( { template, figures } ) {
        const base = template[ 'figures' ]
            .reduce( ( acc, key ) => ( { ...acc, [ key ]: typeof figures[ key ] === 'number' ? `${ figures[ key ] }` : template[ 'unavailable' ] } ), {} )
        const derived = Object.entries( template[ 'derived' ] )
            .reduce( ( acc, [ name, rule ] ) => {
                const source = figures[ rule[ 'figure' ] ]

                return { ...acc, [ name ]: typeof source === 'number' ? `${ source + rule[ 'offset' ] }` : template[ 'unavailable' ] }
            }, {} )

        return { ...base, ...derived }
    }


    // Mirror of RevisionAssembler.#fillSlots — an unknown slot fails loud rather than rendering `{prds}`.
    static #fillSlots( { format, values } ) {
        return format
            .replace( /\{(\w+)\}/g, ( _, name ) => {
                if( values[ name ] === undefined ) {
                    throw new Error( `DoltDbAssembler: the scope-line template names the slot "{${ name }}" but no value was supplied — a rendered revision may not carry an unfilled placeholder` )
                }

                return values[ name ]
            } )
    }


    // One carrier row count, or null when the carrier is absent. `table` / `column` / `where` are internal
    // literals from SCOPE_FIGURES, never user input.
    static #countCarrier( { db, carrier } ) {
        const { table, column, needs, where } = carrier
        if( DoltDbAssembler.#hasColumns( { db, table, columns: needs } ) !== true ) {
            return null
        }

        const clause = where === null ? '' : ` WHERE ${ where }`
        const row = DoltDbAssembler.#get( { db, sql: `SELECT count(${ column }) AS n FROM ${ table }${ clause }` } )

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
    static #renderResearch( { research, researchTopics, researchFiles, pointer } ) {
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
                    .map( ( edge ) => DoltDbAssembler.#researchFileCell( { edge, pointer } ) )
                    .join( ', ' )

                return `| R${ cell( entry[ 'r_no' ] ) } | ${ cell( entry[ 'title' ] ) } | ${ cell( entry[ 'kind' ] ) } | ${ cell( topics ) } | ${ cell( files ) } |`
            } )

        return heading
            .concat( table )
            .concat( bodyRows )
            .concat( [ '' ] )
    }


    // ---- external payload pointers (Memo 080, PRD-D5) — mirrored from RevisionAssembler (core) ----

    // The reference points THIS render resolves pointers against, derived from the DATABASE PATH: the memo
    // folder is the directory holding memo-<NNN>.db, the project root is its `.memo` ancestor's parent.
    // A db outside a `.memo` tree (a bare fixture) has NO project reference point; that is a MISSING
    // PRECONDITION and the READ path then degrades to the pre-PRD-D5 rendering for `mode: reference`
    // — the ONE documented degrade. It never applies to `mode: inline`, which aborts instead.
    static #pointerContext( { dbPath } ) {
        const hasDbPath = typeof dbPath === 'string' && dbPath.length > 0
        const memoDir = hasDbPath === true ? resolve( dbPath, '..' ) : null
        const marker = `${ sep }.memo${ sep }`
        const index = memoDir === null ? -1 : memoDir.indexOf( marker )
        const projectRoot = index === -1 ? null : memoDir.slice( 0, index )

        return {
            memoDir,
            projectRoot,
            memoAvailable: memoDir !== null,
            projectAvailable: projectRoot !== null
        }
    }


    static #availableFor( { base, pointer } ) {
        return base === 'memo' ? pointer.memoAvailable === true : pointer.projectAvailable === true
    }


    static #site( { table } ) {
        const { site } = PointerSites.bySite( { table } )
        if( site === null ) {
            throw new Error( `DoltDbAssembler: "${ table }" is not a declared pointer site — declare it in PointerSites instead of resolving it here` )
        }

        return { site }
    }


    // Pull every payload-backed block table IN, through its checksum. `mode: inline` means any state other
    // than matched ABORTS (PayloadPointer throws, naming path, expected and read hash) — the viewer never
    // substitutes the last known content, an empty table, or a skipped row; the throw runs into the frozen-
    // file fallback the serve path already carries.
    static #resolveTablePayloads( { rows, pointer } ) {
        const { site } = DoltDbAssembler.#site( { table: 'block_tables' } )

        return rows
            .map( ( row ) => {
                const ref = row[ site.pathColumn ]
                if( typeof ref !== 'string' || ref.length === 0 ) {
                    return row
                }
                if( DoltDbAssembler.#availableFor( { base: site.base, pointer } ) !== true ) {
                    throw new Error( `DoltDbAssembler: block table "${ row[ 'id' ] }" points at payload "${ ref }" but the render was given no ${ site.base } reference point — an inline payload is never rendered unchecked` )
                }

                const { tsv } = BlockTablePayload.load( {
                    memoDir: pointer.memoDir,
                    projectRoot: pointer.projectRoot,
                    ref,
                    expected: row[ site.shaColumn ]
                } )

                return { ...row, tsv }
            } )
    }


    // Pull every payload-backed diagram TEMPLATE in — checked BEFORE it is interpolated, so a changed
    // template can never be displayed as if it were the frozen one. Same inline rule: no match, no render.
    static #resolveDiagramPayloads( { rows, pointer } ) {
        const { site } = DoltDbAssembler.#site( { table: 'block_diagrams' } )

        return rows
            .map( ( row ) => {
                const ref = row[ site.pathColumn ]
                if( typeof ref !== 'string' || ref.length === 0 ) {
                    return row
                }
                if( DoltDbAssembler.#availableFor( { base: site.base, pointer } ) !== true ) {
                    throw new Error( `DoltDbAssembler: block_diagram "${ row[ 'id' ] }" points at template "${ ref }" but the render was given no ${ site.base } reference point — an inline payload is never rendered unchecked` )
                }

                const { content } = PayloadPointer.readVerified( {
                    base: site.base,
                    memoDir: pointer.memoDir,
                    projectRoot: pointer.projectRoot,
                    ref,
                    expected: row[ site.shaColumn ]
                } )

                return { ...row, source: content }
            } )
    }


    // ONE research file edge as a table cell. `mode: reference` means the pointer is RENDERED, never pulled
    // in: a matched pointer renders as the bare path, any other state renders as a GAP naming the resolved
    // pointer and the reason. The entry is never dropped and never blanked. The resolution is stated as
    // `<base>:<path-relative-to-that-base>` — the absolute path is deliberately NOT rendered, because it
    // would make the bytes machine-dependent. Byte-identical to RevisionAssembler.#researchFileCell.
    static #researchFileCell( { edge, pointer } ) {
        const { site } = DoltDbAssembler.#site( { table: 'research_files' } )
        const path = edge[ site.pathColumn ]
        if( DoltDbAssembler.#availableFor( { base: site.base, pointer } ) !== true ) {
            return path
        }

        const { state, resolvedRef, escaped } = DoltDbAssembler.#checkReference( { site, pointer, ref: path, expected: edge[ site.shaColumn ] } )
        if( state === 'matched' ) {
            return path
        }

        const where = resolvedRef === null ? path : `${ site.base }:${ resolvedRef }`
        const reason = escaped === true && state === 'unhashed'
            ? `${ GAP_REASON[ state ] }; the pointer also leaves its base "${ site.base }"`
            : GAP_REASON[ state ]

        return `${ where } (GAP: ${ reason })`
    }


    // The reference-mode check. SAME RANKING AS the core reader: an absent checksum outranks an
    // unresolvable path, because `sha256 IS NULL` is a property of the row that no filesystem lookup can
    // change. The resolver's own message is NOT rendered — it carries absolute paths.
    static #checkReference( { site, pointer, ref, expected } ) {
        const hasExpected = typeof expected === 'string' && expected.length > 0
        try {
            const result = PayloadPointer.verify( {
                base: site.base,
                memoDir: pointer.memoDir,
                projectRoot: pointer.projectRoot,
                ref,
                expected,
                mode: 'reference'
            } )

            return { state: result.state, resolvedRef: result.resolvedRef, escaped: false }
        } catch( error ) {
            const detail = error.message

            return { state: hasExpected === true ? 'escaped' : 'unhashed', resolvedRef: null, escaped: true, detail }
        }
    }


    // Does a table carry every one of these columns? The pointer pairs are ADDITIVE, so a database that
    // predates them must read without a "no such column" throw. Mirrors RevisionAssembler.#hasColumns.
    static #hasColumns( { db, table, columns } ) {
        if( DoltDbAssembler.#tableExists( { db, table } ) !== true ) {
            return false
        }

        const rows = DoltDbAssembler.#all( { db, sql: `PRAGMA table_info(\`${ table }\`)` } )
        const names = rows
            .map( ( row ) => row[ 'name' ] )

        return columns.every( ( column ) => names.includes( column ) === true )
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
    // order is fixed (id, title, hintergrund, frage, aiRecommendation, typ, options, answered, then the six
    // lifecycle fields). MUST stay byte-identical to RevisionAssembler.#questionEntry (core).
    //
    // THE FENCE CARRIES THE LIFECYCLE (Memo 080, PRD-F1 / WI-076). The core projection reads this fence back
    // with a delete-then-insert, so a field the fence does not emit is destroyed on the next run: a question
    // retired as `irrelevant` used to come back as plain `open` with its reason and its edge gone. `answered`
    // STAYS (every older reader keys on it) and `status` stands beside it as the four-value axis.
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
            answered: row[ 'status' ] === 'answered',
            status: DoltDbAssembler.#questionStatus( { row } ),
            statusReason: DoltDbAssembler.#strOrNull( { value: row[ 'status_reason' ] } ),
            replacedBy: DoltDbAssembler.#strOrNull( { value: row[ 'replaced_by_id' ] } ),
            answeredBy: DoltDbAssembler.#strOrNull( { value: row[ 'answered_by' ] } ),
            answeredInRev: DoltDbAssembler.#strOrNull( { value: row[ 'answered_in_rev' ] } ),
            note: DoltDbAssembler.#strOrNull( { value: row[ 'note' ] } )
        }
    }


    // Byte-identical to RevisionAssembler.#questionStatus (core): the status a row carries, degraded to
    // 'open' when the column is absent or empty. It is NEVER reconstructed from the boolean `answered` —
    // that would turn every retired question back into an open one, the exact loss the field prevents.
    static #questionStatus( { row } ) {
        const value = row[ 'status' ]

        return typeof value === 'string' && value.length > 0 ? value : 'open'
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
    //
    // SPLIT BY PROVENANCE (Memo 080, PRD-F1 / WI-076): the stock is grouped under the two `###` subsection
    // headings the FILE parser already reads (DocumentRegistry.#mapAnsweredProvenance), so a DB-first memo
    // no longer renders every answer as an anonymous block that the parser folds into its 'user' default. A
    // group is written only when it holds something, in the fixed order user-then-ai.
    static #renderAnsweredQuestions( { questions, questionOptions, answers } ) {
        const heading = [ '## Beantwortete Fragen', '' ]
        const answered = questions
            .filter( ( row ) => row[ 'status' ] === 'answered' )
        if( answered.length === 0 ) {
            return heading.concat( [ '_keine beantworteten Fragen_', '' ] )
        }

        const sections = ANSWERED_PROVENANCE_GROUPS
            .map( ( group ) => ( {
                group,
                rows: answered.filter( ( row ) => DoltDbAssembler.#answeredByOf( { row } ) === group[ 'value' ] )
            } ) )
            .filter( ( entry ) => entry[ 'rows' ].length > 0 )
            .map( ( entry ) => [ `### ${ entry[ 'group' ][ 'heading' ] }`, '' ]
                .concat( entry[ 'rows' ]
                    .map( ( row ) => DoltDbAssembler.#answeredEntry( { row, questionOptions, answers } ) )
                    .reduce( ( acc, part ) => acc.concat( part ), [] ) ) )
            .reduce( ( acc, part ) => acc.concat( part ), [] )

        return heading.concat( sections )
    }


    // Byte-identical to RevisionAssembler.#answeredByOf (core): the provenance of one answered row, degraded
    // to 'user' on an absent column or an unknown value — the same rule DocumentRegistry.#normalizeAnsweredBy
    // applies, so the degrade is one statement on both sides rather than two opinions.
    static #answeredByOf( { row } ) {
        const value = row[ 'answered_by' ]

        return value === 'ai-on-behalf' ? 'ai-on-behalf' : 'user'
    }


    // Byte-identical to RevisionAssembler.#renderDeferredQuestions (core) — the `## Zurueckgestellte Fragen`
    // section (REV-18 Kap 18: "eigener Abschnitt statt Durchstreichen"). Striking through is styling and
    // styling carries no reason, so each entry states its mark and its reason on lines of its own. It stands
    // BESIDE `## Beantwortete Fragen`, never inside it: the answered section is the decision record. On an
    // empty stock the section is omitted entirely — no heading, no placeholder body.
    static #renderDeferredQuestions( { questions } ) {
        const deferred = questions
            .filter( ( row ) => DEFERRED_STATUS.includes( row[ 'status' ] ) === true )
        if( deferred.length === 0 ) {
            return []
        }

        const sections = deferred
            .map( ( row ) => DoltDbAssembler.#deferredEntry( { row } ) )
            .reduce( ( acc, part ) => acc.concat( part ), [] )

        return [ '## Zurueckgestellte Fragen', '' ].concat( sections )
    }


    // Byte-identical to RevisionAssembler.#deferredEntry (core).
    static #deferredEntry( { row } ) {
        const reason = row[ 'status_reason' ]

        return [
            `### ${ cell( row[ 'id' ] ) } — ${ DoltDbAssembler.#answeredTitle( { row } ) }`,
            '',
            `- **Frage (Original):** ${ cell( row[ 'text' ] ) }`,
            `- **Zurueckgestellt:** ${ DoltDbAssembler.#deferredMark( { row } ) }`,
            `- **Begruendung:** ${ typeof reason === 'string' && reason.length > 0 ? cell( reason ) : '—' }`,
            ''
        ]
    }


    // Byte-identical to RevisionAssembler.#deferredMark (core).
    static #deferredMark( { row } ) {
        if( row[ 'status' ] !== 'replaced' ) {
            return cell( row[ 'status' ] )
        }

        const target = row[ 'replaced_by_id' ]

        return typeof target === 'string' && target.length > 0 ? `ersetzt durch ${ cell( target ) }` : 'ersetzt'
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
            .concat( DoltDbAssembler.#answeredContext( { row } ) )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#answeredContext (core) — the two OPTIONAL context lines of an
    // answered block: in WHICH revision the decision fell and WHICH remark belongs to it. Emitted only when
    // the column holds something, exactly the rule #answeredWortlaut follows.
    static #answeredContext( { row } ) {
        return [
            { label: 'Beantwortet in', value: row[ 'answered_in_rev' ] },
            { label: 'Anmerkung', value: row[ 'note' ] }
        ]
            .filter( ( entry ) => typeof entry[ 'value' ] === 'string' && entry[ 'value' ].length > 0 )
            .map( ( entry ) => `- **${ entry[ 'label' ] }:** ${ cell( entry[ 'value' ] ) }` )
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
            .reduce( ( acc, row ) => DoltDbAssembler.#answerWins( { row, acc } ) === true ? row : acc, forQuestion[ 0 ] )
    }


    // Byte-identical to RevisionAssembler.#answerWins — which of two records for the SAME question the
    // block shows. The existing rule decides first and is unchanged: the greater input_id, the freshest
    // capture, wins. PRD-F3 (Memo 080 Kap 18, WI-078) only adds the TIE, which the old reduce resolved by
    // accident (equal ids compare false, so whichever row the ORDER BY put first won).
    //
    // ON A TIE THE NOT-PRESELECTED ROW WINS. A tie is one capture that wrote two answers to one question —
    // measured 22 times in memo-080.db, once (F12) with two different option keys. When one merely repeats
    // what the AI had preselected and the other does not, the one the user actually formed is the decision.
    static #answerWins( { row, acc } ) {
        const rowId = String( row[ 'input_id' ] )
        const accId = String( acc[ 'input_id' ] )

        if( rowId !== accId ) {
            return rowId > accId
        }

        return DoltDbAssembler.#isPreselected( { row: acc } ) === true && DoltDbAssembler.#isPreselected( { row } ) !== true
    }


    // Byte-identical to RevisionAssembler.#isPreselected. `preselected` as the writer stores it: INTEGER
    // 1/0. A row from a database predating the column carries undefined — read as "not stated", never as
    // a measured 0.
    static #isPreselected( { row } ) {
        const value = row[ 'preselected' ]

        return value === 1 || value === true
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


    // ONE dataset table body. The AUTHORED render kind decides the presentation: 'table' emits a Markdown
    // table, anything else (including an absent/NULL kind on a database that predates the column) keeps the
    // TSV fence the render always emitted. Byte-identical to RevisionAssembler.#renderBlockTableBody — the
    // named cross-repo divergence that stood here before (viewer always emitting the fence) is closed with
    // this method: `memo block add-table` defaults the kind to 'table', so the divergence was reachable by
    // every CLI-authored table, not only by a hypothetical future one.
    static #renderBlockTableBody( { entry } ) {
        const tsv = raw( entry[ 'tsv' ] )
        if( entry[ 'render' ] !== 'table' ) {
            return [ '```tsv', tsv, '```', '' ]
        }

        const { header, rows } = DoltDbAssembler.#parseTsv( { tsv } )
        if( header.length === 0 ) {
            return [ '```tsv', tsv, '```', '' ]
        }

        return [ `| ${ header.map( ( name ) => cell( name ) ).join( ' | ' ) } |`, `|${ header.map( () => '---' ).join( '|' ) }|` ]
            .concat( rows.map( ( row ) => `| ${ header.map( ( name, index ) => cell( row[ index ] === undefined ? null : row[ index ] ) ).join( ' | ' ) } |` ) )
            .concat( [ '' ] )
    }


    // Byte-identical to RevisionAssembler.#renderBlocks (core) — since Memo 080 / PRD-R1 Vollausbau WITH
    // the toolkit body of each block, read from the `block_section` carrier and ordered by the register.
    static #renderBlocks( { blocks, blockTables, blockDiagrams, blockSections } ) {
        const heading = [ '## Blocks', '' ]
        if( blocks.length === 0 ) {
            return { lines: heading.concat( [ '_no blocks_', '' ] ), sections: 0 }
        }

        DoltDbAssembler.#assertKnownBlockSections( { blockSections } )
        DoltDbAssembler.#assertKnownAnchors( { blockTables, blockDiagrams } )

        const rendered = blocks
            .map( ( block ) => {
                const tables = blockTables
                    .filter( ( entry ) => entry[ 'block_id' ] === block[ 'id' ] )
                const diagrams = blockDiagrams
                    .filter( ( entry ) => entry[ 'block_id' ] === block[ 'id' ] )
                const body = DoltDbAssembler.#renderBlockSections( { block, blockSections, tables, diagrams, blockTables } )

                // Memo 080, PRD-R3 Vollausbau: only the UNANCHORED entries stand at the block — an anchored
                // one was already emitted inside its section.
                const loose = ( entry ) => DoltDbAssembler.#anchorOf( { entry } ) === null
                const tableLines = tables
                    .filter( loose )
                    .map( ( entry ) => DoltDbAssembler.#renderBlockTable( { entry } ) )
                    .reduce( ( acc, part ) => acc.concat( part ), [] )
                const diagramLines = diagrams
                    .filter( loose )
                    .map( ( diagram ) => DoltDbAssembler.#renderDiagram( { diagram, blockTables } ) )
                    .reduce( ( acc, part ) => acc.concat( part ), [] )

                return {
                    lines: [ `### ${ cell( block[ 'title' ] ) } (${ cell( block[ 'id' ] ) })`, '' ]
                        .concat( body.lines )
                        .concat( tableLines )
                        .concat( diagramLines ),
                    sections: body.count
                }
            } )

        return {
            lines: heading.concat( rendered.reduce( ( acc, part ) => acc.concat( part.lines ), [] ) ),
            sections: rendered.reduce( ( acc, part ) => acc + part.sections, 0 )
        }
    }


    // Byte-identical to RevisionAssembler.#renderBlockSections: register order, level-three headings, the
    // three mandatory plus the four generated positions ALWAYS rendered (absent ones with the empty mark),
    // and since Memo 080 / PRD-R3 Vollausbau the tables and diagrams anchored to each section.
    static #renderBlockSections( { block, blockSections, tables, diagrams, blockTables } ) {
        const carried = blockSections
            .filter( ( row ) => row[ 'block_id' ] === block[ 'id' ] )

        const parts = BLOCK_SECTION_ORDER
            .map( ( entry ) => {
                const row = carried
                    .find( ( candidate ) => candidate[ 'name' ] === entry[ 'field' ] )
                const body = row === undefined ? '' : raw( row[ 'body' ] )
                const always = BLOCK_SECTION_ALWAYS.includes( entry[ 'kind' ] )
                const anchoredTables = tables
                    .filter( ( candidate ) => DoltDbAssembler.#anchorOf( { entry: candidate } ) === entry[ 'field' ] )
                const anchoredDiagrams = diagrams
                    .filter( ( candidate ) => DoltDbAssembler.#anchorOf( { entry: candidate } ) === entry[ 'field' ] )
                const anchored = anchoredTables
                    .map( ( candidate ) => DoltDbAssembler.#renderBlockTable( { entry: candidate } ) )
                    .concat( anchoredDiagrams.map( ( candidate ) => DoltDbAssembler.#renderDiagram( { diagram: candidate, blockTables } ) ) )
                    .reduce( ( acc, part ) => acc.concat( part ), [] )
                if( body.length === 0 && always !== true && anchored.length === 0 ) {
                    return null
                }

                return [ `### ${ entry[ 'heading' ] }`, '' ]
                    .concat( body.length === 0 ? [ PROSE_EMPTY ] : body.split( '\n' ) )
                    .concat( [ '' ] )
                    .concat( anchored )
            } )
            .filter( ( part ) => part !== null )

        return {
            lines: parts.reduce( ( acc, part ) => acc.concat( part ), [] ),
            count: parts.length
        }
    }


    // Byte-identical to RevisionAssembler.#renderBlockTable: the heading of an authored table is LEVEL
    // THREE — a fourth-level heading gets no anchor here in the viewer, which is precisely why the markdown
    // form rule of this phase forbids it.
    static #renderBlockTable( { entry } ) {
        return [ `### ${ cell( entry[ 'title' ] ) }`, '' ]
            .concat( DoltDbAssembler.#renderBlockTableBody( { entry } ) )
    }


    // Byte-identical to RevisionAssembler.#anchorOf / #handleOf: the anchored section of a row (null =
    // anchored to the block itself) and the block-local handle behind the global `<block_id>.<handle>` key.
    static #anchorOf( { entry } ) {
        const value = entry[ 'section' ]

        return typeof value === 'string' && value.length > 0 ? value : null
    }


    static #handleOf( { entry } ) {
        const id = typeof entry[ 'id' ] === 'string' ? entry[ 'id' ] : ''
        const prefix = `${ entry[ 'block_id' ] }.`

        return id.startsWith( prefix ) === true ? id.slice( prefix.length ) : id
    }


    // Byte-identical to RevisionAssembler.#assertKnownAnchors: an anchor outside the closed register aborts
    // the render, naming every offender and the permitted set.
    static #assertKnownAnchors( { blockTables, blockDiagrams } ) {
        const known = BLOCK_SECTION_ORDER
            .map( ( entry ) => entry[ 'field' ] )
        const offenders = blockTables
            .map( ( entry ) => ( { axis: 'block_tables', entry } ) )
            .concat( blockDiagrams.map( ( entry ) => ( { axis: 'block_diagrams', entry } ) ) )
            .filter( ( candidate ) => {
                const section = DoltDbAssembler.#anchorOf( { entry: candidate[ 'entry' ] } )

                return section !== null && known.includes( section ) !== true
            } )
        if( offenders.length === 0 ) {
            return { ok: true, checked: blockTables.length + blockDiagrams.length }
        }

        const named = offenders
            .map( ( candidate ) => `${ candidate[ 'axis' ] } "${ candidate[ 'entry' ][ 'id' ] }" section "${ candidate[ 'entry' ][ 'section' ] }"` )
            .join( ', ' )

        throw new Error( `DoltDbAssembler: ${ named } — not in the closed heading register; permitted: ${ known.join( ', ' ) }` )
    }


    // Byte-identical to RevisionAssembler.#assertKnownBlockSections: a heading outside the closed register
    // aborts the render, naming every offender and the permitted set.
    static #assertKnownBlockSections( { blockSections } ) {
        const known = BLOCK_SECTION_ORDER
            .map( ( entry ) => entry[ 'field' ] )
        const unknown = blockSections
            .filter( ( row ) => known.includes( row[ 'name' ] ) !== true )
        if( unknown.length === 0 ) {
            return { ok: true, checked: blockSections.length }
        }

        const named = unknown
            .map( ( row ) => `block "${ row[ 'block_id' ] }" section "${ row[ 'name' ] }"` )
            .join( ', ' )

        throw new Error( `DoltDbAssembler: ${ named } — not in the closed heading register; permitted: ${ known.join( ', ' ) }` )
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

        // LEVEL THREE since Memo 080 / PRD-R3 Vollausbau, byte-identical to the core renderer.
        const titleLines = diagram[ 'title' ] === null || diagram[ 'title' ] === undefined
            ? []
            : [ `### ${ cell( diagram[ 'title' ] ) }`, '' ]

        return titleLines
            .concat( [ '```' + kind ] )
            .concat( rendered.split( '\n' ) )
            .concat( [ '```', '' ] )
    }


    static #feedDiagram( { source, feed, blockTables, diagramId, blockId } ) {
        const table = blockTables
            .find( ( entry ) => entry[ 'block_id' ] === blockId && DoltDbAssembler.#handleOf( { entry } ) === feed )
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


// LOAD-TIME GATE for the render plan — byte-identical in intent to the core gate (Memo 080, PRD-R1
// Vollausbau). It proves that the plan's `document` positions ARE the register's twelve in the
// register's sequence, and that every `collective` position states which PRD relocates it. It names how
// much it compared; an empty comparison basis is refused, never reported green.
const assertDocumentPlan = () => {
    const declared = BlockSections.documentSections().sections
        .map( ( entry ) => entry[ 'section' ] )
    const planned = DOCUMENT_SECTIONS
        .filter( ( entry ) => entry[ 'level' ] === 'document' )
        .map( ( entry ) => entry[ 'section' ] )
    if( declared.length === 0 || planned.length === 0 ) {
        throw new Error( `DoltDbAssembler: the document order compared ${ planned.length } planned positions against ${ declared.length } declared ones — an empty comparison basis is refused, not reported green` )
    }

    const drift = planned
        .map( ( section, index ) => ( { index, planned: section, declared: declared[ index ] } ) )
        .filter( ( entry ) => entry[ 'planned' ] !== entry[ 'declared' ] )
    if( planned.length !== declared.length || drift.length > 0 ) {
        const detail = drift
            .map( ( entry ) => `position ${ entry[ 'index' ] + 1 }: plan "${ entry[ 'planned' ] }" vs register "${ entry[ 'declared' ] }"` )
            .join( '; ' )

        throw new Error( `DoltDbAssembler: the render plan drifted from the document-level register (${ planned.length } planned vs ${ declared.length } declared)${ detail.length === 0 ? '' : ` — ${ detail }` }` )
    }

    const unattributed = DOCUMENT_SECTIONS
        .filter( ( entry ) => entry[ 'level' ] === 'collective' )
        .filter( ( entry ) => typeof entry[ 'movedBy' ] !== 'string' || entry[ 'movedBy' ].length === 0 )
    if( unattributed.length > 0 ) {
        throw new Error( `DoltDbAssembler: collective document position(s) without a relocating PRD: ${ unattributed.map( ( entry ) => entry[ 'section' ] ).join( ', ' ) }` )
    }

    return { ok: true, declared: declared.length, planned: planned.length }
}


assertDocumentPlan()


export { DoltDbAssembler, DOCUMENT_SECTIONS, HEAD_FIELDS }
