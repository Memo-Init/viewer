// VENDORED FROM THE CORE REPO — repos/core/cli/src/PointerSites.mjs is the single source. This copy
// exists because the viewer is its own checkout and must resolve the same pointers with the same rules;
// re-vendor by copying the core file over this one and re-applying these three lines. Never edit one side
// alone: the cross-repo byte-parity fixture (tests/fixtures/revision-body-pointer-v1) is what catches it.

// PointerSites.mjs — the ONE declaration of every place the database points at a file that lies
// OUTSIDE it (Memo 080, PRD-D5 Vollausbau, Kapitel 4 "das eine Prozent").
//
// The database owns 99 percent of a memo. The remaining one percent — large research payloads,
// diagram templates, attachments — stays a FILE, and the row carries only the pointer: a path, a
// reference point, and a checksum. What binds the two back together is the checksum AT READ TIME,
// not a transaction.
//
// A NEW POINTER SITE IS AN ENTRY HERE, NEVER NEW RESOLVER CODE. PayloadPointer (resolve/read/verify),
// PointerVerifier (the counting check) and PointerMigration (the additive schema top-up) all read
// THIS list; none of them names a table of its own. Adding a fifth site is one object literal below
// — nothing else changes.
//
// `base` is the reference point the pointer resolves against and is ALWAYS explicit:
//   - 'memo'    → the memo folder (<projectRoot>/.memo/memos/NNN-slug)
//   - 'project' → the project root
// `base` is NEVER the caller's working directory. A pointer that resolves against the shell's cwd is
// not reproducible: the same row would mean a different file depending on where the command ran, which
// is exactly the defect this register closes.
//
// `mode` is the read behaviour and decides the error branch (see the error rule in PayloadPointer):
//   - 'inline'    → the content is pulled INTO the render; any non-matching state ABORTS
//   - 'reference' → only the pointer is rendered; any non-matching state is reported as a GAP
//
// Class architecture per node-class-architecture: static-only, object params, object returns,
// private-by-default, NO SILENT DEFAULTS — an entry missing `base` or `mode` fails at load time.

const BASES = [ 'memo', 'project' ]
const MODES = [ 'inline', 'reference' ]
const REQUIRED_FIELDS = [ 'table', 'pathColumn', 'shaColumn', 'base', 'mode', 'kind' ]


// The register itself. Every field is mandatory; nothing is defaulted at read time.
const SITES = [
    {
        table: 'block_tables',
        pathColumn: 'payload_ref',
        shaColumn: 'payload_sha256',
        base: 'memo',
        mode: 'inline',
        kind: 'block-table-payload'
    },
    {
        table: 'research_files',
        pathColumn: 'path',
        shaColumn: 'sha256',
        base: 'project',
        mode: 'reference',
        kind: 'research-payload'
    },
    {
        table: 'documents',
        pathColumn: 'path',
        shaColumn: 'sha256',
        base: 'project',
        mode: 'reference',
        kind: 'attachment'
    },
    {
        table: 'block_diagrams',
        pathColumn: 'source_ref',
        shaColumn: 'source_sha256',
        base: 'memo',
        mode: 'inline',
        kind: 'diagram-source'
    }
]


class PointerSites {
    // Every declared pointer site, in declaration order. Returns a defensive copy of each entry so a
    // caller can never mutate the register it is reading.
    static list() {
        const sites = SITES
            .map( ( entry ) => PointerSites.assertComplete( { entry } ).entry )

        return { sites }
    }


    static bySite( { table } ) {
        if( typeof table !== 'string' || table.length === 0 ) {
            throw new Error( 'PointerSites.bySite: "table" is required (non-empty string)' )
        }

        const found = SITES
            .find( ( entry ) => entry[ 'table' ] === table )
        const site = found === undefined ? null : PointerSites.assertComplete( { entry: found } ).entry

        return { site }
    }


    // The completeness gate. Every field of REQUIRED_FIELDS must be a non-empty string, `base` must be
    // one of BASES and `mode` one of MODES. There is no fallback: an incomplete entry is a defect in the
    // register, and a silently defaulted reference point would resolve a pointer against the wrong root.
    static assertComplete( { entry } ) {
        if( entry === undefined || entry === null || typeof entry !== 'object' ) {
            throw new Error( 'PointerSites.assertComplete: "entry" is required (object)' )
        }

        const missing = REQUIRED_FIELDS
            .filter( ( field ) => typeof entry[ field ] !== 'string' || entry[ field ].length === 0 )
        if( missing.length > 0 ) {
            throw new Error( `PointerSites.assertComplete: pointer site "${ entry[ 'table' ] }" is missing required field(s) ${ missing.join( ', ' ) } — every field is mandatory, none is defaulted` )
        }
        if( BASES.includes( entry[ 'base' ] ) !== true ) {
            throw new Error( `PointerSites.assertComplete: pointer site "${ entry[ 'table' ] }" has base "${ entry[ 'base' ] }" — expected one of ${ BASES.join( ', ' ) } (the reference point is never the caller's working directory)` )
        }
        if( MODES.includes( entry[ 'mode' ] ) !== true ) {
            throw new Error( `PointerSites.assertComplete: pointer site "${ entry[ 'table' ] }" has mode "${ entry[ 'mode' ] }" — expected one of ${ MODES.join( ', ' ) }` )
        }

        const copy = {
            table: entry[ 'table' ],
            pathColumn: entry[ 'pathColumn' ],
            shaColumn: entry[ 'shaColumn' ],
            base: entry[ 'base' ],
            mode: entry[ 'mode' ],
            kind: entry[ 'kind' ]
        }

        return { entry: copy }
    }
}


// LOAD-TIME GATE: an entry without `base` or `mode` breaks the import of this module, not some later
// read. A half-declared pointer site must never reach a resolver.
PointerSites.list()


export { PointerSites, BASES, MODES, REQUIRED_FIELDS }
