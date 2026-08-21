import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, basename } from 'node:path'


// PRD-014 (Memo 076 Phase 7, WI-006/007/010/011/133): the read side of the persistent Session-Config
// project register (ressources/.sessions/config.json). The SessionStart-Hook is the WRITER (a NO-AUTO-
// OVERWRITE read-merge-write upsert per project); this store is the READER the viewer boots from so the
// project set is the SINGLE SOURCE of the Memos namespace tree — not just the server's process.cwd().
//
// Memo 077 PRD-01 (Config Single-Source): the config carries ONLY the authoritative SHARED axis —
// `projects[].{projectId, projectRoot}`. The dead fields (`viewerUrl`, `activeMemo`, `workMode`,
// `memoPath`, `role`, `activeProject`, `lastSeenAt`, `updatedAt`) were parsed-but-discarded or write-only
// mirrors and are eliminated. `viewerUrl` in particular was parsed here yet dropped by the only caller
// (loopback is hardcoded everywhere) — so it is no longer part of the read contract.
//
// SECURITY (git-security gate, § Live-System-Sicherheit): the config path is resolved ABLEITEND — an
// explicit MEMOVIEW_SESSION_CONFIG env override wins, otherwise an ancestor walk from cwd for the first
// dir carrying .sessions/config.json. No hardcoded absolute user home path is ever baked into committed code.
//
// FAIL-OPEN: a missing, unreadable or broken config yields the empty shape (logged to STDERR, never
// thrown) — a viewer boot must never depend on the config being present or well-formed (WI-006).
class SessionConfigStore {
    // Resolve the config path deterministically. Returns { configPath } (absolute) or { configPath: null }.
    static resolveConfigPath( { cwd, env } = {} ) {
        const environment = env !== undefined && env !== null && typeof env === 'object' ? env : process.env
        const override = environment[ 'MEMOVIEW_SESSION_CONFIG' ]

        if( typeof override === 'string' && override.trim().length > 0 ) {
            return { 'configPath': resolve( override ) }
        }

        const startDir = typeof cwd === 'string' && cwd.trim().length > 0 ? resolve( cwd ) : process.cwd()
        const { configPath } = SessionConfigStore.#ascendForConfig( { 'dir': startDir } )

        return { 'configPath': configPath }
    }


    // Recursive ancestor walk (no for/while per house style): the first dir holding
    // .sessions/config.json wins; reaching the filesystem root ends the walk with null.
    static #ascendForConfig( { dir } ) {
        const candidate = join( dir, '.sessions', 'config.json' )

        if( existsSync( candidate ) === true ) {
            return { 'configPath': candidate }
        }

        const parent = dirname( dir )

        if( parent === dir ) {
            return { 'configPath': null }
        }

        return SessionConfigStore.#ascendForConfig( { 'dir': parent } )
    }


    // Fail-open read → { projects, configPath }. `projects` is filtered to well-formed entries (object
    // with a string projectId). A missing/broken/non-object config degrades to an empty list — never
    // throws. Memo 077 PRD-01: `viewerUrl` is no longer read (eliminated dead field — was parsed then
    // discarded by the only caller).
    static readProjects( { cwd, env } = {} ) {
        const { configPath } = SessionConfigStore.resolveConfigPath( { cwd, env } )

        if( configPath === null || existsSync( configPath ) !== true ) {
            return { 'projects': [], 'configPath': null }
        }

        let raw = null

        try {
            raw = readFileSync( configPath, 'utf8' )
        } catch( e ) {
            process.stderr.write( `[SessionConfigStore] unreadable config ${ configPath } — fail-open empty\n` )

            return { 'projects': [], 'configPath': configPath }
        }

        let parsed = null

        try {
            parsed = JSON.parse( raw )
        } catch( e ) {
            process.stderr.write( `[SessionConfigStore] broken JSON ${ configPath } — fail-open empty\n` )

            return { 'projects': [], 'configPath': configPath }
        }

        if( parsed === null || typeof parsed !== 'object' || Array.isArray( parsed ) ) {
            return { 'projects': [], 'configPath': configPath }
        }

        const projects = Array.isArray( parsed[ 'projects' ] )
            ? parsed[ 'projects' ].filter( ( entry ) => entry !== null && typeof entry === 'object' && typeof entry[ 'projectId' ] === 'string' && entry[ 'projectId' ].length > 0 )
            : []

        return { 'projects': projects, 'configPath': configPath }
    }


    // Memo 079 PRD-23 (WI-050): read the FULL declarative config → { projects, discover, folderTabs,
    // configPath }. Adds two declarative blocks over readProjects's explicit list:
    //   * `discover` = { projectsDir, includeRoot } — an ableitungs-regel so a fresh workbench with no
    //     upserted projects[] yet is NOT a dead tree ("Viewer startet heute leer", forensics d). Instead
    //     of a hand-maintained list, sibling projects are DERIVED by scanning <root>/<projectsDir>/*/.
    //   * `folderTabs` = [ { id, folder, view } ] — the per-folder tab carrier (WI-052), surfaced on the
    //     projects[] axis so each resolved project can bring its own folder tabs.
    // Fail-open at every level: an absent/broken config yields the empty shape; a malformed block is
    // dropped, never thrown. `projects` keeps the exact readProjects filter (parity, single source).
    static readConfig( { cwd, env } = {} ) {
        const { projects, configPath } = SessionConfigStore.readProjects( { cwd, env } )
        const empty = { projects, 'discover': null, 'folderTabs': [], configPath }

        if( configPath === null || existsSync( configPath ) !== true ) {
            return empty
        }

        let parsed = null

        try {
            parsed = JSON.parse( readFileSync( configPath, 'utf8' ) )
        } catch {
            return empty
        }

        if( parsed === null || typeof parsed !== 'object' || Array.isArray( parsed ) ) {
            return empty
        }

        const discover = SessionConfigStore.#normalizeDiscover( { 'raw': parsed[ 'discover' ] } )
        const folderTabs = SessionConfigStore.#normalizeFolderTabs( { 'raw': parsed[ 'folderTabs' ] } )

        return { projects, discover, folderTabs, configPath }
    }


    // Memo 079 PRD-23 (WI-050): resolve the AUTHORITATIVE project set with a single, declared priority —
    // explicit `projects[]` > `discover` scan > cwd fallback. Returns { projects, source, folderTabs }:
    //   * `explicit`  — projects[] is non-empty: exactly those win (the SessionStart hook keeps it fresh).
    //   * `discover`  — projects[] empty but a discover block resolves: scan <root>/<projectsDir>/*/ for
    //     dirs carrying `.memo/`, plus the workbench root itself when includeRoot is true.
    //   * `cwd`       — neither yields anything: empty list here, the caller (MemoView) keeps its explicit
    //     cwd bootstrap fallback (unchanged Gate-Semantik, only a declarative middle inserted).
    // Every resolved project carries { projectId, projectRoot }. Fail-open: an unreadable projectsDir
    // yields zero discovered projects (logged by the caller), never a throw.
    static resolveProjects( { cwd, env } = {} ) {
        const { projects, discover, folderTabs, configPath } = SessionConfigStore.readConfig( { cwd, env } )

        if( projects.length > 0 ) {
            return { 'projects': projects, 'source': 'explicit', folderTabs, configPath }
        }

        if( discover !== null && configPath !== null ) {
            const workbenchRoot = dirname( dirname( configPath ) )
            const { discovered } = SessionConfigStore.#scanDiscover( { workbenchRoot, discover } )

            if( discovered.length > 0 ) {
                return { 'projects': discovered, 'source': 'discover', folderTabs, configPath }
            }
        }

        return { 'projects': [], 'source': 'cwd', folderTabs, configPath }
    }


    // ---- private (declarative blocks) ----

    static #normalizeDiscover( { raw } ) {
        if( raw === null || typeof raw !== 'object' || Array.isArray( raw ) ) {
            return null
        }

        const projectsDir = typeof raw[ 'projectsDir' ] === 'string' && raw[ 'projectsDir' ].trim().length > 0
            ? raw[ 'projectsDir' ].trim()
            : 'projects'
        const includeRoot = raw[ 'includeRoot' ] === true

        return { 'projectsDir': projectsDir, 'includeRoot': includeRoot }
    }


    static #normalizeFolderTabs( { raw } ) {
        if( Array.isArray( raw ) !== true ) {
            return []
        }

        return raw
            .filter( ( tab ) => tab !== null && typeof tab === 'object' && typeof tab[ 'id' ] === 'string' && tab[ 'id' ].length > 0 && typeof tab[ 'folder' ] === 'string' && tab[ 'folder' ].length > 0 )
            .map( ( tab ) => ( {
                'id': tab[ 'id' ],
                'folder': tab[ 'folder' ],
                'view': typeof tab[ 'view' ] === 'string' && tab[ 'view' ].length > 0 ? tab[ 'view' ] : tab[ 'id' ]
            } ) )
    }


    static #scanDiscover( { workbenchRoot, discover } ) {
        const projectsDir = resolve( workbenchRoot, discover[ 'projectsDir' ] )
        const siblings = SessionConfigStore.#hasMemo( { 'dir': projectsDir } ) === false
            ? SessionConfigStore.#listMemoProjects( { 'dir': projectsDir } )
            : []

        const rootEntry = discover[ 'includeRoot' ] === true && SessionConfigStore.#hasMemo( { 'dir': workbenchRoot } ) === true
            ? [ { 'projectId': SessionConfigStore.#deriveProjectId( { 'dir': workbenchRoot } ), 'projectRoot': workbenchRoot } ]
            : []

        // Dedup by projectRoot so the root is never listed twice if it also sits under projectsDir.
        const merged = new Map()
        rootEntry.concat( siblings )
            .forEach( ( entry ) => {
                if( merged.has( entry[ 'projectRoot' ] ) !== true ) {
                    merged.set( entry[ 'projectRoot' ], entry )
                }
            } )

        return { 'discovered': [ ...merged.values() ] }
    }


    static #listMemoProjects( { dir } ) {
        let names = []

        try {
            names = readdirSync( dir, { 'withFileTypes': true } )
                .filter( ( entry ) => entry.isDirectory() === true )
                .map( ( entry ) => entry.name )
        } catch {
            return []
        }

        return names
            .map( ( name ) => resolve( dir, name ) )
            .filter( ( projectRoot ) => SessionConfigStore.#hasMemo( { 'dir': projectRoot } ) === true )
            .sort()
            .map( ( projectRoot ) => ( { 'projectId': SessionConfigStore.#deriveProjectId( { 'dir': projectRoot } ), 'projectRoot': projectRoot } ) )
    }


    static #hasMemo( { dir } ) {
        try {
            return statSync( join( dir, '.memo' ) ).isDirectory()
        } catch {
            return false
        }
    }


    static #deriveProjectId( { dir } ) {
        return basename( resolve( dir ) ).replace( /[^a-zA-Z0-9_-]/g, '-' )
    }
}


export { SessionConfigStore }
