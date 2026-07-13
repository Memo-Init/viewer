import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'


// PRD-017 (Memo 072, Phase 5): ported VERBATIM from cli/spec-view/src/lib/SpecManifest.mjs and
// STALE-FIXED for the post-Memo-064 workshop layout. The manifest is still the SINGLE source of the
// left-nav sub-categories, declared on the SPEC level, PER VERSION — but it no longer lives at
// <namespace>/<version>/spec-manifest.json (the pre-064 model). Today it sits INSIDE the channel:
//   draft channel → <namespace>/<version>/draft/spec/spec-manifest.json  (authored)
//   dist  channel → <namespace>/<version>/dist/data/spec-manifest.json   (built)
// The tiny parse rule (schema below) is unchanged; ONLY the path resolution moved. Because the Spec
// Viewer, repos/spec's generate-manifest.mjs and the public site's sidebar.mjs share no repo
// dependency, the rule stays DUPLICATED verbatim (the schema is tiny and stable) rather than
// cross-repo imported — exactly ONE parse rule per manifest, never a third hardcoded grouping table.
//
// Schema:
//   {
//     "namespace": "workbench",
//     "version": "0.1.0",
//     "groups": [
//       { "id": "introduction", "label": "Introduction", "order": 1, "pages": ["00-overview"] },
//       ...
//     ],
//     "fallback": "append-by-NN"
//   }
//
// - id        machine key (matches sidebar_group)
// - label     human display label for the left nav
// - order     group display order
// - pages[]   ordered page identifiers = the NN-slug filename stems (no .md)
// - fallback  what to do with pages not listed in any group (default append-by-NN)

const MANIFEST_FILENAME = 'spec-manifest.json'
const DEFAULT_FALLBACK = 'append-by-NN'
const DEFAULT_CHANNEL = 'draft'
// Per-channel manifest sub-path under <rootDir>/<version>/. The draft channel authors the manifest
// next to its pages (spec/), the dist channel emits it under data/ (Memo 064 / T012 #15).
const CHANNEL_MANIFEST_SUBPATH = {
    draft: [ 'draft', 'spec' ],
    dist: [ 'dist', 'data' ]
}


class SpecManifest {
    // Resolve the manifest path for a version + channel under the post-064 layout. Extracted so both
    // read() and its consumers (SpecRegistry) resolve the SAME path — no second hardcoded location.
    static pathFor( { rootDir, version, channel } ) {
        const resolvedChannel = typeof channel === 'string' && CHANNEL_MANIFEST_SUBPATH[ channel ] ? channel : DEFAULT_CHANNEL
        const segments = CHANNEL_MANIFEST_SUBPATH[ resolvedChannel ]
        const path = join( rootDir, version, segments[ 0 ], segments[ 1 ], MANIFEST_FILENAME )

        return { path, channel: resolvedChannel }
    }


    // Resolve and read the channel manifest. Never throws — a missing or malformed manifest degrades
    // to { found:false, ... } with messages, so a consumer can fall back to flat NN-ordering instead
    // of crashing.
    static read( { rootDir, version, channel } ) {
        const { path } = SpecManifest.pathFor( { rootDir, version, channel } )

        if( !existsSync( path ) ) {
            return {
                found: false,
                path,
                manifest: null,
                groups: [],
                fallback: DEFAULT_FALLBACK,
                messages: [ `No ${ MANIFEST_FILENAME } at ${ path } — falling back to flat NN order` ]
            }
        }

        let parsed

        try {
            parsed = JSON.parse( readFileSync( path, 'utf-8' ) )
        } catch( error ) {
            return {
                found: false,
                path,
                manifest: null,
                groups: [],
                fallback: DEFAULT_FALLBACK,
                messages: [ `${ MANIFEST_FILENAME } at ${ path } is not valid JSON: ${ error.message }` ]
            }
        }

        const { valid, messages } = SpecManifest.validate( { manifest: parsed } )

        if( !valid ) {
            return {
                found: false,
                path,
                manifest: parsed,
                groups: [],
                fallback: DEFAULT_FALLBACK,
                messages
            }
        }

        const fallback = typeof parsed.fallback === 'string' ? parsed.fallback : DEFAULT_FALLBACK
        const groups = SpecManifest.#sortGroups( { groups: parsed.groups } )

        return { found: true, path, manifest: parsed, groups, fallback, messages: [] }
    }


    // Pure structure check — usable without disk access (unit-testable). Validates the
    // top-level shape and every group entry, accumulating every problem (not just the first).
    static validate( { manifest } ) {
        const messages = []

        if( manifest === null || typeof manifest !== 'object' || Array.isArray( manifest ) ) {
            messages.push( 'manifest must be a JSON object' )

            return { valid: false, messages }
        }

        if( typeof manifest.namespace !== 'string' || manifest.namespace.length === 0 ) {
            messages.push( 'manifest.namespace must be a non-empty string' )
        }

        if( typeof manifest.version !== 'string' || manifest.version.length === 0 ) {
            messages.push( 'manifest.version must be a non-empty string' )
        }

        if( !Array.isArray( manifest.groups ) ) {
            messages.push( 'manifest.groups must be an array' )

            return { valid: false, messages }
        }

        manifest.groups
            .forEach( ( group, index ) => {
                const { groupMessages } = SpecManifest.#validateGroup( { group, index } )
                groupMessages
                    .forEach( ( message ) => messages.push( message ) )
            } )

        return { valid: messages.length === 0, messages }
    }


    static #validateGroup( { group, index } ) {
        const groupMessages = []
        const label = `groups[${ index }]`

        if( group === null || typeof group !== 'object' || Array.isArray( group ) ) {
            groupMessages.push( `${ label } must be an object` )

            return { groupMessages }
        }

        if( typeof group.id !== 'string' || group.id.length === 0 ) {
            groupMessages.push( `${ label }.id must be a non-empty string` )
        }

        if( typeof group.label !== 'string' || group.label.length === 0 ) {
            groupMessages.push( `${ label }.label must be a non-empty string` )
        }

        if( typeof group.order !== 'number' ) {
            groupMessages.push( `${ label }.order must be a number` )
        }

        if( !Array.isArray( group.pages ) ) {
            groupMessages.push( `${ label }.pages must be an array` )

            return { groupMessages }
        }

        const nonStrings = group.pages
            .filter( ( page ) => typeof page !== 'string' || page.length === 0 )

        if( nonStrings.length > 0 ) {
            groupMessages.push( `${ label }.pages must contain only non-empty strings` )
        }

        return { groupMessages }
    }


    // Look up the group id for a page identifier (the NN-slug filename stem, no .md).
    // Returns { groupId: null } when the page is in no group — the caller then applies the
    // fallback. The manifest groups are searched in declared order.
    static groupForPage( { groups, pageStem } ) {
        const hit = groups
            .find( ( group ) => Array.isArray( group.pages ) && group.pages.includes( pageStem ) )

        return { groupId: hit ? hit.id : null }
    }


    static #sortGroups( { groups } ) {
        const list = Array.isArray( groups ) ? groups : []

        return [ ...list ]
            .sort( ( a, b ) => {
                const orderA = typeof a.order === 'number' ? a.order : 0
                const orderB = typeof b.order === 'number' ? b.order : 0

                return orderA - orderB
            } )
    }
}


export { SpecManifest, MANIFEST_FILENAME, DEFAULT_FALLBACK, DEFAULT_CHANNEL, CHANNEL_MANIFEST_SUBPATH }
