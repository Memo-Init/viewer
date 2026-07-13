import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'


// PRD-017 (Memo 072, Phase 5, F9=A): the LOCAL 3-stage publish badge. It makes the publication gap
// visible without deciding anything (T012 §4) — a deterministic, loopback-only comparison of the
// workshop spec/ against the public promotion target repos/spec/. NO network, NO continuous
// live-site poll (that stays an on-demand "verify" concern, out of scope here).
//
//   PUBLISHED   this version exists in repos/spec AND its built dist is parity-identical
//   DRAFT-ONLY  the version exists in the workshop but was never promoted to repos/spec
//   DRIFT       the version exists on BOTH sides but the built dist content diverges
//
// The parity comparison mirrors check-dist-parity.mjs's CONTENT gate: the per-build volatile fields
// (timestamps, the provenance commit SHA in its several serializations, the llms Source: stamp) are
// stripped before comparing, so a content-stable promotion reads PUBLISHED, not a false DRIFT.

const PAGE_PATTERN = /^\d+-.+\.md$/
const DIST_SPEC_SEGMENTS = [ 'dist', 'spec' ]

const BADGE = {
    PUBLISHED: 'PUBLISHED',
    DRAFT_ONLY: 'DRAFT-ONLY',
    DRIFT: 'DRIFT'
}

// Volatile lines that differ every build by design (mirrors check-dist-parity.mjs VOLATILE +
// SOURCE_STAMP + PROVENANCE). Stripped before the content comparison so parity is a CONTENT gate,
// not a per-commit-SHA gate.
const VOLATILE = /^\s*"?(generated_at|generatedAt|at|fromCommit|source_commit|specId|generated_from|edit_warning|specDir)"?\s*[:=]/
const SOURCE_STAMP = /^Source:\s+[a-z0-9-]+@\d+\.\d+\.\d+:([0-9a-f]{7}|unknown)$/


class SpecPublishStatus {
    // Pure, disk-free content comparator over two page lists ([ { name, content } ]). Returns
    // { identical, reason }. Two dist trees are identical iff they carry the SAME page set and every
    // page's volatile-normalized body matches. Unit-testable without a filesystem.
    static compareDist( { workshopPages, publicPages } ) {
        const left = SpecPublishStatus.#byName( { pages: workshopPages } )
        const right = SpecPublishStatus.#byName( { pages: publicPages } )
        const leftNames = [ ...left.keys() ].sort()
        const rightNames = [ ...right.keys() ].sort()

        if( leftNames.join( '|' ) !== rightNames.join( '|' ) ) {
            return { identical: false, reason: 'dist page set differs between workshop and repos/spec' }
        }

        const divergent = leftNames
            .filter( ( name ) => SpecPublishStatus.#normalize( { text: left.get( name ) } ) !== SpecPublishStatus.#normalize( { text: right.get( name ) } ) )

        if( divergent.length > 0 ) {
            return { identical: false, reason: `dist content differs (${ divergent.length } page(s), e.g. ${ divergent[ 0 ] })` }
        }

        return { identical: true, reason: 'dist parity — content identical' }
    }


    // Derive the badge for ONE namespace version from the on-disk workshop ↔ repos/spec comparison.
    // workshopNsDir = spec/<ns>, publicNsDir = repos/spec/<ns>. Never throws: an unreadable side is
    // reported as a reason, defaulting to DRAFT-ONLY (the safe "not confirmed published" signal).
    static async derive( { workshopNsDir, publicNsDir, version } ) {
        if( typeof version !== 'string' || version.length === 0 ) {
            return { badge: BADGE.DRAFT_ONLY, reason: 'version: Must be a non-empty string' }
        }

        const publicHasVersion = await SpecPublishStatus.#isDirectory( { path: join( publicNsDir, version ) } )

        if( publicHasVersion === false ) {
            return { badge: BADGE.DRAFT_ONLY, reason: `version ${ version } not present in repos/spec — never promoted` }
        }

        const workshopPages = await SpecPublishStatus.#readDistPages( { nsDir: workshopNsDir, version } )
        const publicPages = await SpecPublishStatus.#readDistPages( { nsDir: publicNsDir, version } )

        if( workshopPages.length === 0 && publicPages.length === 0 ) {
            // Both promoted but neither carries a built dist — treat as published (nothing to diverge).
            return { badge: BADGE.PUBLISHED, reason: `version ${ version } promoted (no dist pages to compare)` }
        }

        const { identical, reason } = SpecPublishStatus.compareDist( { workshopPages, publicPages } )

        if( identical === true ) {
            return { badge: BADGE.PUBLISHED, reason: `version ${ version } published — ${ reason }` }
        }

        return { badge: BADGE.DRIFT, reason: `version ${ version } diverges — ${ reason }` }
    }


    static async #readDistPages( { nsDir, version } ) {
        const dir = join( nsDir, version, DIST_SPEC_SEGMENTS[ 0 ], DIST_SPEC_SEGMENTS[ 1 ] )
        let names

        try {
            names = await readdir( dir )
        } catch {
            return []
        }

        const files = names
            .filter( ( name ) => PAGE_PATTERN.test( name ) )

        const pages = await Promise.all( files.map( async ( name ) => {
            const content = await readFile( join( dir, name ), 'utf-8' )
                .catch( () => '' )

            return { name, content }
        } ) )

        return pages
    }


    static #byName( { pages } ) {
        const list = Array.isArray( pages ) ? pages : []

        return new Map( list.map( ( page ) => [ page.name, page.content ] ) )
    }


    static #normalize( { text } ) {
        return String( text == null ? '' : text )
            .split( '\n' )
            .filter( ( line ) => VOLATILE.test( line ) === false && SOURCE_STAMP.test( line ) === false )
            .join( '\n' )
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


export { SpecPublishStatus, BADGE }
