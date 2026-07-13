import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'


// PRD-017 (Memo 072, Phase 5): the memo-viewer's SPEC AUTO-DISCOVERY trigger — the analogue of
// ProjectAutoRegister for the project's spec/ workshop. The gap it closes (T012 #10): the separate
// cli/spec-view kept a USER-LOCAL registry (~/.spec-view/registry.json) and required a manual
// POST /api/specs per namespace. Inside the memo-viewer we instead DISCOVER the project's spec/
// namespaces on disk and register them ON OUR OWN — no user-local store, no manual POST.
//
// A "namespace" is an immediate subfolder of spec/ that carries a spec.json family head
// (memo, meta-spec, session, workbench). Read-only against the tree and fail-open: an unreadable
// spec/ returns an empty discovery, never a throw.
class SpecAutoRegister {
    // Discover the namespaces under a spec/ root: every immediate subfolder holding a spec.json.
    // Returns { namespaces: [ { namespace, rootDir } ], reasons: [] }. Never throws.
    static async discover( { specRoot } ) {
        const struct = { 'namespaces': [], 'reasons': [] }

        if( typeof specRoot !== 'string' || specRoot.trim().length === 0 ) {
            struct[ 'reasons' ].push( 'specRoot: Must be a non-empty string' )

            return struct
        }

        const rootIsDir = await SpecAutoRegister.#isDirectory( { path: specRoot } )

        if( !rootIsDir ) {
            struct[ 'reasons' ].push( `No spec/ directory at ${ specRoot }` )

            return struct
        }

        const entries = await readdir( specRoot, { 'withFileTypes': true } )
            .catch( () => [] )
        const candidates = entries
            .filter( ( entry ) => entry.isDirectory() === true )
            .map( ( entry ) => ( { namespace: entry.name, rootDir: resolve( specRoot, entry.name ) } ) )

        const checked = await Promise.all(
            candidates.map( async ( candidate ) => {
                const hasHead = await SpecAutoRegister.#isFile( { path: resolve( candidate.rootDir, 'spec.json' ) } )

                return hasHead === true ? candidate : null
            } )
        )

        struct[ 'namespaces' ] = checked
            .filter( ( candidate ) => candidate !== null )
            .sort( ( a, b ) => a.namespace.localeCompare( b.namespace ) )

        if( struct[ 'namespaces' ].length === 0 ) {
            struct[ 'reasons' ].push( `No namespace (subfolder with spec.json) found under ${ specRoot }` )
        }

        return struct
    }


    // Discover + register every namespace into the given SpecRegistry. Returns the registered
    // namespace names and the reasons for an empty discovery. Fail-open: a registry without a
    // register() method returns status:false + reasons, never an exception.
    static async autoRegister( { specRoot, registry } ) {
        const struct = { 'status': false, 'registered': [], 'reasons': [] }

        if( registry === undefined || registry === null || typeof registry.register !== 'function' ) {
            struct[ 'reasons' ].push( 'registry: Must provide a register method' )

            return struct
        }

        const { namespaces, reasons } = await SpecAutoRegister.discover( { specRoot } )

        if( namespaces.length === 0 ) {
            struct[ 'reasons' ] = reasons

            return struct
        }

        namespaces
            .forEach( ( { namespace, rootDir } ) => {
                const result = registry.register( { namespace, rootDir } )

                if( result && result[ 'status' ] === true ) {
                    struct[ 'registered' ].push( namespace )
                } else {
                    struct[ 'reasons' ].push( `register failed for ${ namespace }: ${ ( result && result[ 'messages' ] || [] ).join( '; ' ) }` )
                }
            } )

        struct[ 'status' ] = struct[ 'registered' ].length > 0

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


    static async #isFile( { path } ) {
        try {
            const info = await stat( path )

            return info.isFile()
        } catch {
            return false
        }
    }
}


export { SpecAutoRegister }
