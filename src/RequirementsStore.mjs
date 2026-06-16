// PRD-012 (Memo 011 Kap 4, F16=A) — read-only Requirements data source for the memo-view
// requirements view. Reads the calibration-layer store at .memo/requirements/:
//   - index.json            (generated index; never the source of truth, but a fast manifest)
//   - <id>.req.json         (one requirement per file: id, statement, scope, check, severity, origin)
//   - sets/<memo>.set.json  (persisted eval set: the requirement ids that a memo optimizes against)
//
// The store surfaces requirements on two levels (PRD's US-1):
//   - PRD-level   : requirements grouped by their scope.repos axis (the data-driven proxy for a
//                   "PRD" — the .req.json schema carries NO prd/phase field, so the repo scope is
//                   the honest grouping key; documented as a deviation in the PRD report).
//   - Memo-aggregate : the flat union of all requirements that the memo's eval set references.
//
// Each requirement is enriched with a derived `shortName` (from title/statement — NEVER hardcoded)
// for the hover tooltip (PRD US-2).
//
// READ-ONLY: this module only reads. No write/delete of any .req.json / set / index (NO-OVERWRITE).
// No for/while loops — array methods only. No semicolons, 4-space indent, single quotes, object
// returns (~/.claude/CLAUDE.md, node-formatting).

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'


const INDEX_FILE = 'index.json'
const SETS_DIR = 'sets'
const SHORT_NAME_MAX = 48


class RequirementsStore {
    // Resolve the canonical store paths from a requirements directory. Kept separate so tests and
    // the server agree on exactly one layout: <dir>/index.json and <dir>/sets/<memo>.set.json.
    static paths( { requirementsDir } ) {
        const indexPath = join( requirementsDir, INDEX_FILE )
        const setsDir = join( requirementsDir, SETS_DIR )

        return { indexPath, setsDir }
    }


    // Derive a compact hover label from the requirement data (US-2). Prefers the `title`, falls back
    // to the `statement`; trims a leading "<lead> — " technical prefix and clamps the length. The
    // result is purely data-derived (never hardcoded), so the same input always yields the same label.
    static shortName( { requirement } ) {
        const source = typeof requirement[ 'title' ] === 'string' && requirement[ 'title' ].trim().length > 0
            ? requirement[ 'title' ]
            : ( typeof requirement[ 'statement' ] === 'string' ? requirement[ 'statement' ] : '' )

        const firstSegment = source.split( ' — ' )[ 0 ].trim()
        const base = firstSegment.length > 0 ? firstSegment : source.trim()
        const clamped = base.length > SHORT_NAME_MAX
            ? `${ base.slice( 0, SHORT_NAME_MAX - 1 ).trimEnd() }…`
            : base

        return { shortName: clamped }
    }


    // Read every requirement referenced by index.json and return the full .req.json bodies.
    // Returns { status, count, requirements } — requirements are enriched with `shortName`.
    // A missing store (no index.json) is a benign empty result, not an error envelope.
    static async loadAll( { requirementsDir } ) {
        const { indexPath } = RequirementsStore.paths( { requirementsDir } )
        const index = await RequirementsStore.#readJson( { filePath: indexPath } )

        if( index === null || Array.isArray( index[ 'requirements' ] ) === false ) {
            return { status: 'empty', count: 0, requirements: [] }
        }

        const entries = await Promise.all(
            index[ 'requirements' ].map( async ( entry ) => {
                const fileName = typeof entry[ 'file' ] === 'string' ? entry[ 'file' ] : `${ entry[ 'id' ] }.req.json`
                const body = await RequirementsStore.#readJson( { filePath: join( requirementsDir, fileName ) } )

                if( body === null ) { return null }

                const { shortName } = RequirementsStore.shortName( { requirement: body } )

                return { ...body, shortName }
            } )
        )

        const requirements = entries.filter( ( entry ) => entry !== null )

        return { status: 'ok', count: requirements.length, requirements }
    }


    // Read a persisted eval set (sets/<memoName>.set.json). Returns { status, set, setPresent }.
    // PRD-005 (Memo 016 Kap 4, B2): `setPresent` distinguishes a MISSING set file (no
    // memo-NNN.set.json on disk) from a set that merely resolves to zero requirements. A missing
    // file is { status: 'missing', set: null, setPresent: false }; a present-but-empty set is
    // { status: 'ok', set: {...ids:[]}, setPresent: true } — the view renders different copy.
    static async memoSet( { requirementsDir, memoName } ) {
        const { setsDir } = RequirementsStore.paths( { requirementsDir } )
        const set = await RequirementsStore.#readJson( { filePath: join( setsDir, `${ memoName }.set.json` ) } )

        if( set === null || Array.isArray( set[ 'ids' ] ) === false ) {
            return { status: 'missing', set: null, setPresent: false }
        }

        return { status: 'ok', set, setPresent: true }
    }


    // List the memo names that have a recorded eval set (sets/<name>.set.json). Skips _schema/ and
    // the .gitkeep. Returns { status, memos } sorted for deterministic rendering.
    static async listMemoSets( { requirementsDir } ) {
        const { setsDir } = RequirementsStore.paths( { requirementsDir } )

        try {
            const dirEntries = await readdir( setsDir, { withFileTypes: true } )
            const memos = dirEntries
                .filter( ( dirent ) => dirent.isFile() === true )
                .map( ( dirent ) => dirent.name )
                .filter( ( name ) => name.endsWith( '.set.json' ) )
                .map( ( name ) => name.slice( 0, name.length - '.set.json'.length ) )
                .sort()

            return { status: 'ok', memos }
        } catch( error ) {
            return { status: 'empty', memos: [] }
        }
    }


    // US-1: build the requirements view model for one memo. Resolves the memo's eval-set ids to full
    // requirement bodies, then produces BOTH levels:
    //   - groups[] : PRD-level proxy — one group per distinct scope.repos signature (sorted).
    //                Requirements with an empty repos scope land in the '(all repos)' group.
    //   - aggregate[] : the flat union of all resolved requirements (the memo-wide roll-up).
    // Returns { status, memoName, groups, aggregate, count }. Unknown ids in the set are skipped
    // (they cannot be rendered without a body) but counted as `missingIds`.
    static async aggregate( { requirementsDir, memoName } ) {
        const all = await RequirementsStore.loadAll( { requirementsDir } )
        const { set, setPresent } = await RequirementsStore.memoSet( { requirementsDir, memoName } )

        const byId = {}
        all[ 'requirements' ].forEach( ( requirement ) => { byId[ requirement[ 'id' ] ] = requirement } )

        const ids = set !== null ? set[ 'ids' ] : []
        const resolved = ids
            .map( ( id ) => byId[ id ] )
            .filter( ( requirement ) => requirement !== undefined )
        const missingIds = ids.filter( ( id ) => byId[ id ] === undefined )

        const groups = RequirementsStore.#groupByRepoScope( { requirements: resolved } )

        // PRD-005 (Memo 016 Kap 4, B2/B5): `setPresent` lets the view tell a missing eval set apart
        // from an empty one. `knownIds` is the full store id index (REQ-NNN) so the route can lint
        // block requirement names (req-*) against the real store namespace (B3/B5).
        return {
            status: 'ok',
            memoName,
            groups,
            aggregate: resolved,
            count: resolved.length,
            missingIds,
            setPresent,
            knownIds: all[ 'requirements' ].map( ( requirement ) => requirement[ 'id' ] )
        }
    }


    // Group requirements by their scope.repos signature (the PRD-level proxy). An empty repos
    // array maps to the synthetic '(all repos)' key so every requirement lands in exactly one group.
    static #groupByRepoScope( { requirements } ) {
        const buckets = {}

        requirements.forEach( ( requirement ) => {
            const scope = requirement[ 'scope' ] || {}
            const repos = Array.isArray( scope[ 'repos' ] ) ? scope[ 'repos' ] : []
            const key = repos.length > 0 ? [ ...repos ].sort().join( ', ' ) : '(all repos)'

            if( buckets[ key ] === undefined ) { buckets[ key ] = [] }
            buckets[ key ].push( requirement )
        } )

        return Object.keys( buckets )
            .sort()
            .map( ( groupKey ) => {
                return { groupKey, requirements: buckets[ groupKey ] }
            } )
    }


    // Tolerant JSON reader: returns the parsed object, or null on any read/parse failure (the
    // requirements store is an optional, read-only side car — a missing file must never crash the
    // server). NO writes anywhere in this module.
    static async #readJson( { filePath } ) {
        try {
            const raw = await readFile( filePath, 'utf8' )

            return JSON.parse( raw )
        } catch( error ) {
            return null
        }
    }
}


export { RequirementsStore, SHORT_NAME_MAX }
