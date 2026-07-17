import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'


// PRD-014 (Memo 076 Phase 7, WI-006/007/010/011/133): the read side of the persistent Session-Config
// project register (ressources/.sessions/config.json). The SessionStart-Hook is the WRITER (a NO-AUTO-
// OVERWRITE read-merge-write upsert per project); this store is the READER the viewer boots from so the
// project set is the SINGLE SOURCE of the Memos namespace tree — not just the server's process.cwd().
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


    // Fail-open read → { projects, viewerUrl, configPath }. `projects` is filtered to well-formed
    // entries (object with a string projectId); `viewerUrl` is a non-empty string or null. A missing/
    // broken/non-object config degrades to an empty list — never throws.
    static readProjects( { cwd, env } = {} ) {
        const { configPath } = SessionConfigStore.resolveConfigPath( { cwd, env } )

        if( configPath === null || existsSync( configPath ) !== true ) {
            return { 'projects': [], 'viewerUrl': null, 'configPath': null }
        }

        let raw = null

        try {
            raw = readFileSync( configPath, 'utf8' )
        } catch( e ) {
            process.stderr.write( `[SessionConfigStore] unreadable config ${ configPath } — fail-open empty\n` )

            return { 'projects': [], 'viewerUrl': null, 'configPath': configPath }
        }

        let parsed = null

        try {
            parsed = JSON.parse( raw )
        } catch( e ) {
            process.stderr.write( `[SessionConfigStore] broken JSON ${ configPath } — fail-open empty\n` )

            return { 'projects': [], 'viewerUrl': null, 'configPath': configPath }
        }

        if( parsed === null || typeof parsed !== 'object' || Array.isArray( parsed ) ) {
            return { 'projects': [], 'viewerUrl': null, 'configPath': configPath }
        }

        const projects = Array.isArray( parsed[ 'projects' ] )
            ? parsed[ 'projects' ].filter( ( entry ) => entry !== null && typeof entry === 'object' && typeof entry[ 'projectId' ] === 'string' && entry[ 'projectId' ].length > 0 )
            : []
        const viewerUrl = typeof parsed[ 'viewerUrl' ] === 'string' && parsed[ 'viewerUrl' ].length > 0 ? parsed[ 'viewerUrl' ] : null

        return { 'projects': projects, 'viewerUrl': viewerUrl, 'configPath': configPath }
    }
}


export { SessionConfigStore }
