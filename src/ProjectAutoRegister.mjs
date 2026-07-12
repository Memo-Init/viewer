import { readdir, stat } from 'node:fs/promises'
import { resolve, basename } from 'node:path'


// Memo 070, Phase 4 — the memo-viewer AUTO-REGISTRATION trigger.
//
// The gap: registering a project's memos was a MANUAL act (one POST /api/documents per memo). When a
// project already carries a VALID structure on disk (a .memo/ directory holding at least one numbered
// memo with a revisions/ subfolder), the viewer should register it ON ITS OWN instead of waiting for
// the manual add.
//
// TERM DISCIPLINE (deliberate — do NOT let it drift): this feature is "AUTO-REGISTRATION", never
// "auto-login". The viewer ALREADY uses loggedIn / "eingeloggt" as a TRANSCRIPT status
// (TranscriptRegistry). Reusing "login" for this project-level trigger would collide with that
// established transcript vocabulary, so the project trigger keeps its own, non-overlapping name. This
// module deliberately does NOT touch TranscriptRegistry or its loggedIn field.
//
// The registration mechanism is REUSED, not reinvented: validateStructure decides eligibility, then
// autoRegister calls the EXISTING DocumentRegistry.addDocument({ projectId, memoPath }) once per
// discovered memo. Read-only against the project tree and fail-open: an unregisterable memo is
// recorded as skipped, never thrown.
class ProjectAutoRegister {
    // Decide whether a project is auto-registerable: a .memo/ directory that holds at least one
    // numbered memo (NNN-slug) with a revisions/ subfolder. Handles BOTH layouts — the canonical
    // .memo/memos/NNN-slug/ and the legacy flat .memo/NNN-slug/. Never throws.
    static async validateStructure( { projectRoot } ) {
        const struct = { 'valid': false, 'reasons': [], 'memoDirs': [] }

        if( typeof projectRoot !== 'string' || projectRoot.trim().length === 0 ) {
            struct[ 'reasons' ].push( 'projectRoot: Must be a non-empty string' )

            return struct
        }

        const memoRoot = resolve( projectRoot, '.memo' )
        const memoRootIsDir = await ProjectAutoRegister.#isDirectory( { path: memoRoot } )

        if( !memoRootIsDir ) {
            struct[ 'reasons' ].push( `No .memo/ directory at ${memoRoot}` )

            return struct
        }

        const { memoDirs: canonical } = await ProjectAutoRegister.#scanMemoDirs( { root: resolve( memoRoot, 'memos' ) } )
        const { memoDirs: legacy } = await ProjectAutoRegister.#scanMemoDirs( { root: memoRoot } )
        const memoDirs = [ ...new Set( [ ...canonical, ...legacy ] ) ].sort()

        if( memoDirs.length === 0 ) {
            struct[ 'reasons' ].push( 'No numbered memo (NNN-slug) with a revisions/ subfolder found under .memo/' )

            return struct
        }

        struct[ 'valid' ] = true
        struct[ 'memoDirs' ] = memoDirs

        return struct
    }


    // Auto-register every memo of a valid-structure project via the EXISTING addDocument mechanism.
    // The projectId is derived from the project folder name (the same sanitisation the boot cwd hook
    // uses). Returns the registered documentIds and the skipped memos with their reasons. Fail-open:
    // an invalid structure returns status:false + reasons, never an exception.
    static async autoRegister( { projectRoot, registry } ) {
        const struct = { 'status': false, 'projectId': null, 'registered': [], 'skipped': [], 'reasons': [] }

        if( registry === undefined || registry === null || typeof registry.addDocument !== 'function' ) {
            struct[ 'reasons' ].push( 'registry: Must provide an addDocument method' )

            return struct
        }

        const { valid, reasons, memoDirs } = await ProjectAutoRegister.validateStructure( { projectRoot } )

        if( !valid ) {
            struct[ 'reasons' ] = reasons

            return struct
        }

        const projectId = ProjectAutoRegister.#deriveProjectId( { projectRoot } )
        struct[ 'projectId' ] = projectId

        const outcomes = await Promise.all(
            memoDirs.map( async ( memoDir ) => {
                const memoPath = resolve( memoDir, 'revisions' )
                const result = await registry.addDocument( { projectId, memoPath } )

                return { memoPath, result }
            } )
        )

        outcomes
            .forEach( ( { memoPath, result } ) => {
                if( result && result[ 'status' ] === true ) {
                    struct[ 'registered' ].push( result[ 'documentId' ] )
                } else {
                    struct[ 'skipped' ].push( { memoPath, 'messages': ( result && result[ 'messages' ] ) || [] } )
                }
            } )

        struct[ 'status' ] = struct[ 'registered' ].length > 0

        return struct
    }


    static #deriveProjectId( { projectRoot } ) {
        return basename( resolve( projectRoot ) ).replace( /[^a-zA-Z0-9_-]/g, '-' )
    }


    static async #scanMemoDirs( { root } ) {
        const struct = { 'memoDirs': [] }
        const rootIsDir = await ProjectAutoRegister.#isDirectory( { path: root } )

        if( !rootIsDir ) {
            return struct
        }

        const entries = await readdir( root, { 'withFileTypes': true } )
            .catch( () => [] )
        const candidates = entries
            .filter( ( entry ) => entry.isDirectory() === true && /^\d{3}-/.test( entry.name ) )
            .map( ( entry ) => resolve( root, entry.name ) )

        const checked = await Promise.all(
            candidates.map( async ( dir ) => {
                const hasRevisions = await ProjectAutoRegister.#isDirectory( { path: resolve( dir, 'revisions' ) } )

                return hasRevisions === true ? dir : null
            } )
        )

        struct[ 'memoDirs' ] = checked
            .filter( ( dir ) => dir !== null )

        return struct
    }


    static async #isDirectory( { path } ) {
        try {
            const info = await stat( path )

            return info.isDirectory()
        } catch {
            return false
        }
    }
}


export { ProjectAutoRegister }
