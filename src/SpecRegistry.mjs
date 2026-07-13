import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { SpecManifest, DEFAULT_CHANNEL } from './lib/SpecManifest.mjs'


// PRD-017 (Memo 072, Phase 5): ported from cli/spec-view/src/SpecRegistry.mjs and STALE-FIXED for the
// post-Memo-064 workshop layout. A "namespace" is a registered main folder (a spec); its immediate
// subfolders are "versions"; the pages of a version's channel are the files NN-*.md UNDER
// <namespace>/<version>/<channel>/spec/ — NOT directly under <namespace>/<version>/ (the pre-064
// model the CLI still assumes, which empirically found 0 pages against spec/memo, T012 #6/#7).
// Sub-categories come from the per-version/-channel spec-manifest.json (via SpecManifest) when
// present, else a flat NN order.
//
// Channel: the second post-064 axis. draft = authored preview, dist = built/promotable. The default
// is 'draft' (the private-preview value). The version comparator, getLatest, page grouping, title
// derivation and validate are unchanged from the CLI original — only the on-disk page path moved.

const PAGE_PATTERN = /^(\d+)-(.+)\.md$/
const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/


class SpecRegistry {
    #namespaces

    constructor() {
        this.#namespaces = new Map()
    }


    // Register (or replace) a namespace → root folder. Pure bookkeeping; the disk is read
    // lazily by getLatest/listPages/readPage/validate so a stale path is reported, not thrown.
    register( { namespace, rootDir } ) {
        const messages = []

        if( typeof namespace !== 'string' || namespace.length === 0 ) {
            messages.push( 'namespace must be a non-empty string' )
        }

        if( typeof rootDir !== 'string' || rootDir.length === 0 ) {
            messages.push( 'rootDir must be a non-empty string' )
        }

        if( messages.length > 0 ) {
            return { status: false, namespace: null, messages }
        }

        this.#namespaces.set( namespace, { namespace, rootDir } )

        return { status: true, namespace, messages: [] }
    }


    unregister( { namespace } ) {
        const existed = this.#namespaces.delete( namespace )

        return { status: existed }
    }


    has( { namespace } ) {
        return { status: this.#namespaces.has( namespace ) }
    }


    // Snapshot of all registered namespaces (no disk access — cheap, sync). The latest
    // version is resolved lazily elsewhere; here only the registration is returned.
    listNamespaces() {
        const namespaces = [ ...this.#namespaces.values() ]
            .map( ( entry ) => ( { namespace: entry.namespace, rootDir: entry.rootDir } ) )

        return { namespaces }
    }


    // Resolve the root folder registered for a namespace (or null). Small accessor so the
    // publish-status deriver / server can locate the disk root without touching #namespaces.
    rootDirFor( { namespace } ) {
        const entry = this.#namespaces.get( namespace )

        return { rootDir: entry ? entry.rootDir : null }
    }


    // Pure version comparator — strip a leading 'v', parse up to three numeric segments.
    // Unit-testable without disk. Returns { valid, tuple } where tuple is [major,minor,patch].
    static parseVersion( { name } ) {
        const match = typeof name === 'string' ? name.match( VERSION_PATTERN ) : null

        if( !match ) {
            return { valid: false, tuple: [ 0, 0, 0 ] }
        }

        const tuple = [
            parseInt( match[ 1 ], 10 ),
            match[ 2 ] === undefined ? 0 : parseInt( match[ 2 ], 10 ),
            match[ 3 ] === undefined ? 0 : parseInt( match[ 3 ], 10 )
        ]

        return { valid: true, tuple }
    }


    static #compareVersions( { a, b } ) {
        const ta = SpecRegistry.parseVersion( { name: a } ).tuple
        const tb = SpecRegistry.parseVersion( { name: b } ).tuple
        const diffMajor = ta[ 0 ] - tb[ 0 ]
        const diffMinor = ta[ 1 ] - tb[ 1 ]
        const diffPatch = ta[ 2 ] - tb[ 2 ]

        if( diffMajor !== 0 ) { return diffMajor }
        if( diffMinor !== 0 ) { return diffMinor }

        return diffPatch
    }


    async #scanVersions( { rootDir } ) {
        let entries

        try {
            entries = await readdir( rootDir, { withFileTypes: true } )
        } catch( error ) {
            return { dirs: [], versions: [], ignored: [], error: error.message }
        }

        const dirs = entries
            .filter( ( entry ) => entry.isDirectory() )
            .map( ( entry ) => entry.name )

        const versions = dirs
            .filter( ( name ) => SpecRegistry.parseVersion( { name } ).valid )
        const ignored = dirs
            .filter( ( name ) => !SpecRegistry.parseVersion( { name } ).valid )

        return { dirs, versions, ignored, error: null }
    }


    // Resolve the latest version of a namespace. Latest = highest semver after v-strip;
    // ties never happen across a single family. Reports the full version list + any
    // ignored (non-version) subfolders so validate() can surface mixed levels.
    async getLatest( { namespace } ) {
        const entry = this.#namespaces.get( namespace )

        if( !entry ) {
            return { found: false, version: null, versions: [], ignored: [], messages: [ `namespace not registered: ${ namespace }` ] }
        }

        const { versions, ignored, error } = await this.#scanVersions( { rootDir: entry.rootDir } )

        if( error ) {
            return { found: false, version: null, versions: [], ignored: [], messages: [ `cannot read rootDir ${ entry.rootDir }: ${ error }` ] }
        }

        if( versions.length === 0 ) {
            return { found: false, version: null, versions: [], ignored, messages: [ `no version subfolders under ${ entry.rootDir }` ] }
        }

        const sorted = [ ...versions ]
            .sort( ( a, b ) => SpecRegistry.#compareVersions( { a, b } ) )
        const version = sorted[ sorted.length - 1 ]

        return { found: true, version, versions: sorted, ignored, messages: [] }
    }


    // Resolve a requested version to a concrete one. An explicit, existing version wins; an
    // absent/invalid request falls back to the latest. Returns { version } or { version:null }.
    async #resolveVersion( { namespace, version } ) {
        const latest = await this.getLatest( { namespace } )

        if( !latest.found ) {
            return { version: null, messages: latest.messages }
        }

        if( typeof version === 'string' && latest.versions.includes( version ) ) {
            return { version, messages: [] }
        }

        return { version: latest.version, messages: [] }
    }


    // STALE-FIX (T012 #6/#7): pages live under <rootDir>/<version>/<channel>/spec/, not directly
    // under <rootDir>/<version>/. Everything downstream (grouping, title, read) resolves through here.
    static #pagesDir( { rootDir, version, channel } ) {
        const resolvedChannel = channel === 'dist' ? 'dist' : DEFAULT_CHANNEL

        return join( rootDir, version, resolvedChannel, 'spec' )
    }


    async #listPageFiles( { rootDir, version, channel } ) {
        const dir = SpecRegistry.#pagesDir( { rootDir, version, channel } )
        let names

        try {
            names = await readdir( dir )
        } catch( error ) {
            return { files: [], error: error.message }
        }

        const files = names
            .filter( ( name ) => PAGE_PATTERN.test( name ) )
            .sort( ( a, b ) => {
                const orderA = parseInt( a.match( PAGE_PATTERN )[ 1 ], 10 )
                const orderB = parseInt( b.match( PAGE_PATTERN )[ 1 ], 10 )

                return orderA - orderB
            } )

        return { files, error: null }
    }


    // Derive a display title from a page's first H1 ('# NN. Title' → 'Title'). Falls back
    // to the slug when no H1 is found. Mirrors generate-docs-payload's title derivation so
    // the local left nav reads like the published site.
    static deriveTitle( { content, slug } ) {
        const lines = content.split( '\n' )
        const h1 = lines
            .find( ( line ) => /^#\s+/.test( line ) )

        if( !h1 ) {
            return { title: slug }
        }

        const title = h1
            .replace( /^#\s+/, '' )
            .replace( /^\d+\.\s*/, '' )
            .trim()

        return { title: title.length > 0 ? title : slug }
    }


    static #stemOf( { filename } ) {
        return filename.replace( /\.md$/, '' )
    }


    static #slugOf( { filename } ) {
        return filename
            .replace( PAGE_PATTERN, '$2' )
    }


    // The left-nav model for a namespace version+channel: pages grouped by the spec-manifest
    // sub-categories, with any unlisted page appended in NN order under the fallback. Each page
    // carries { stem, slug, title }. When no manifest is present, ONE flat group holds all pages in
    // NN order. version defaults to latest, channel defaults to draft.
    async listPages( { namespace, version, channel } ) {
        const { version: resolved, messages } = await this.#resolveVersion( { namespace, version } )

        if( resolved === null ) {
            return { found: false, version: null, groups: [], flat: [], manifestFound: false, messages }
        }

        const entry = this.#namespaces.get( namespace )
        const { files } = await this.#listPageFiles( { rootDir: entry.rootDir, version: resolved, channel } )

        const pages = await Promise.all( files.map( async ( filename ) => {
            const stem = SpecRegistry.#stemOf( { filename } )
            const slug = SpecRegistry.#slugOf( { filename } )
            const raw = await readFile( join( SpecRegistry.#pagesDir( { rootDir: entry.rootDir, version: resolved, channel } ), filename ), 'utf-8' )
            const { title } = SpecRegistry.deriveTitle( { content: raw, slug } )

            return { stem, slug, title }
        } ) )

        const manifestResult = SpecManifest.read( { rootDir: entry.rootDir, version: resolved, channel } )
        const { groups } = SpecRegistry.#groupPages( {
            pages,
            manifestGroups: manifestResult.groups,
            manifestFound: manifestResult.found
        } )

        return { found: true, version: resolved, groups, flat: pages, manifestFound: manifestResult.found, messages: [] }
    }


    static #groupPages( { pages, manifestGroups, manifestFound } ) {
        if( !manifestFound || manifestGroups.length === 0 ) {
            const fallbackGroup = { id: 'pages', label: 'Pages', order: 1, pages: [ ...pages ] }

            return { groups: [ fallbackGroup ], flat: pages }
        }

        const buckets = manifestGroups
            .map( ( group ) => ( { id: group.id, label: group.label, order: group.order, pages: [] } ) )
        const byId = new Map( buckets.map( ( bucket ) => [ bucket.id, bucket ] ) )

        const unlisted = []

        pages
            .forEach( ( page ) => {
                const { groupId } = SpecManifest.groupForPage( { groups: manifestGroups, pageStem: page.stem } )

                if( groupId !== null && byId.has( groupId ) ) {
                    byId.get( groupId ).pages.push( page )
                } else {
                    unlisted.push( page )
                }
            } )

        const nonEmpty = buckets
            .filter( ( bucket ) => bucket.pages.length > 0 )

        if( unlisted.length > 0 ) {
            nonEmpty.push( { id: 'other', label: 'Other', order: 999, pages: unlisted } )
        }

        return { groups: nonEmpty, flat: pages }
    }


    // Read one page's RAW markdown (no build, no transform — the private-preview value).
    // Returns provenance too: the absolute path, the resolved version, and the file's
    // last-modified time (mtimeMs) so the viewer can show where a page comes from.
    async readPage( { namespace, pageStem, version, channel } ) {
        const { version: resolved, messages } = await this.#resolveVersion( { namespace, version } )

        if( resolved === null ) {
            return { found: false, content: null, title: null, version: null, path: null, mtime: null, messages }
        }

        const entry = this.#namespaces.get( namespace )
        const filename = `${ pageStem }.md`
        const path = join( SpecRegistry.#pagesDir( { rootDir: entry.rootDir, version: resolved, channel } ), filename )

        try {
            const content = await readFile( path, 'utf-8' )
            const stats = await stat( path )
            const slug = SpecRegistry.#slugOf( { filename } )
            const { title } = SpecRegistry.deriveTitle( { content, slug } )

            return { found: true, content, title, version: resolved, path, mtime: stats.mtimeMs, messages: [] }
        } catch( error ) {
            return { found: false, content: null, title: null, version: resolved, path, mtime: null, messages: [ `cannot read page ${ path }: ${ error.message }` ] }
        }
    }


    // Struct-Validation: does the viewer UNDERSTAND this namespace's layout? Reports the resolved
    // version, page count, whether a spec-manifest was found, and any mixed-level (non-version)
    // subfolders. Warn, never block — it MELDET ("verstehe ich / verstehe ich nicht"), it does not
    // refuse to serve.
    async validate( { namespace, version, channel } ) {
        const entry = this.#namespaces.get( namespace )

        if( !entry ) {
            return { understood: false, version: null, pageCount: 0, manifestFound: false, warnings: [], messages: [ `namespace not registered: ${ namespace }` ] }
        }

        const { version: resolved, messages } = await this.#resolveVersion( { namespace, version } )
        const warnings = []

        if( resolved === null ) {
            return { understood: false, version: null, pageCount: 0, manifestFound: false, warnings, messages }
        }

        const latest = await this.getLatest( { namespace } )

        if( latest.ignored.length > 0 ) {
            warnings.push( `mixed levels: ${ latest.ignored.join( ', ' ) } is not a version folder (ignored)` )
        }

        const { files } = await this.#listPageFiles( { rootDir: entry.rootDir, version: resolved, channel } )
        const manifestResult = SpecManifest.read( { rootDir: entry.rootDir, version: resolved, channel } )

        if( !manifestResult.found ) {
            warnings.push( `no spec-manifest.json for ${ namespace }/${ resolved } — left nav falls back to flat NN order` )
        }

        const understood = files.length > 0

        if( !understood ) {
            warnings.push( `no NN-*.md pages found in ${ namespace }/${ resolved }` )
        }

        return {
            understood,
            version: resolved,
            pageCount: files.length,
            manifestFound: manifestResult.found,
            warnings,
            messages: []
        }
    }
}


export { SpecRegistry, PAGE_PATTERN, VERSION_PATTERN }
