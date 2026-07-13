import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { SpecRegistry } from '../../src/SpecRegistry.mjs'
import { SpecAutoRegister } from '../../src/SpecAutoRegister.mjs'
import { SpecPublishStatus, BADGE } from '../../src/SpecPublishStatus.mjs'


// PRD-017 (Memo 072, Phase 5, F9=A): the merged Spec-Viewer. This suite proves the two load-bearing
// claims of the port:
//   (1) the STALE-FIX — SpecRegistry now finds pages under <ns>/<version>/<channel>/spec/NN-*.md
//       (post-Memo-064), so listPages.flatCount > 0 where the pre-064 model empirically found 0;
//   (2) the local publish badge deriver returns PUBLISHED / DRAFT-ONLY / DRIFT across fixtures.
// Tests write ONLY into a repo-internal temp dir (.test-tmp/), never the real spec/ or the user home
// (~/.claude/CLAUDE.md § Test-Isolation).
describe( 'PRD-017 — merged Spec-Viewer (stale-fix + publish badge)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let workRoot = ''


    // Author a post-064 workshop spec on disk: <root>/<ns>/<version>/<channel>/spec/NN-*.md plus its
    // per-channel spec-manifest.json. The channel manifest sub-path mirrors SpecManifest (draft→spec/,
    // dist→data/). Returns the namespace rootDir (<root>/<ns>).
    const makeSpec = async ( { root, ns, version, channel, pages, groups } ) => {
        const manifestSub = channel === 'dist' ? [ 'dist', 'data' ] : [ 'draft', 'spec' ]
        const pageDir = resolve( root, ns, version, channel, 'spec' )
        await mkdir( pageDir, { recursive: true } )

        await Promise.all( pages.map( ( page ) => {
            return writeFile( resolve( pageDir, page.name ), page.content, 'utf-8' )
        } ) )

        if( Array.isArray( groups ) ) {
            const manifestDir = resolve( root, ns, version, manifestSub[ 0 ], manifestSub[ 1 ] )
            await mkdir( manifestDir, { recursive: true } )
            await writeFile( resolve( manifestDir, 'spec-manifest.json' ), JSON.stringify( { namespace: ns, version, groups, fallback: 'append-by-NN' } ), 'utf-8' )
        }

        return resolve( root, ns )
    }


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        workRoot = await mkdtemp( join( repoTmpRoot, 'specview-' ) )
    } )

    afterEach( async () => {
        await rm( workRoot, { recursive: true, force: true } )
    } )


    describe( 'SpecRegistry — the STALE-FIX (pages under <version>/<channel>/spec/)', () => {
        it( 'AC(a): listPages against a post-064 layout yields flatCount > 0 (was 0 in the CLI)', async () => {
            const rootDir = await makeSpec( {
                root: workRoot, ns: 'memo', version: '0.2.0', channel: 'draft',
                pages: [
                    { name: '00-overview.md', content: '# Overview\n\nThe memo MUST do X.\n' },
                    { name: '01-philosophy.md', content: '# 1. Philosophy\n\nIt SHOULD do Y.\n' }
                ],
                groups: [ { id: 'introduction', label: 'Introduction', order: 1, pages: [ '00-overview' ] },
                    { id: 'core', label: 'Core', order: 2, pages: [ '01-philosophy' ] } ]
            } )

            const reg = new SpecRegistry()
            reg.register( { namespace: 'memo', rootDir } )

            const latest = await reg.getLatest( { namespace: 'memo' } )
            const pages = await reg.listPages( { namespace: 'memo' } )
            const report = await reg.validate( { namespace: 'memo' } )

            expect( latest.found ).toBe( true )
            expect( latest.version ).toBe( '0.2.0' )
            expect( pages.found ).toBe( true )
            // THE stale-fix assertion: pages are discovered under draft/spec/, not 0.
            expect( pages.flat.length ).toBeGreaterThan( 0 )
            expect( pages.flat.length ).toBe( 2 )
            expect( pages.manifestFound ).toBe( true )
            expect( report.understood ).toBe( true )
            expect( report.pageCount ).toBe( 2 )
            // Titles from the first H1 (NN. prefix stripped), grouped by the manifest.
            expect( pages.groups.map( ( g ) => g.label ) ).toEqual( [ 'Introduction', 'Core' ] )
            expect( pages.groups[ 0 ].pages[ 0 ].title ).toBe( 'Overview' )
            expect( pages.groups[ 1 ].pages[ 0 ].title ).toBe( 'Philosophy' )
        } )


        it( 'AC(a): the pre-064 layout (pages directly under <version>/) is NOT understood → flatCount 0', async () => {
            // Prove the fix TARGETS the channel layer: NN-*.md placed at the OLD location
            // <ns>/<version>/NN-*.md (the CLI model) is deliberately not found by the fixed registry.
            const staleRoot = resolve( workRoot, 'legacy' )
            const staleDir = resolve( staleRoot, '0.2.0' )
            await mkdir( staleDir, { recursive: true } )
            await writeFile( resolve( staleDir, '00-overview.md' ), '# Overview\n', 'utf-8' )

            const reg = new SpecRegistry()
            reg.register( { namespace: 'legacy', rootDir: staleRoot } )

            const pages = await reg.listPages( { namespace: 'legacy' } )
            const report = await reg.validate( { namespace: 'legacy' } )

            expect( pages.flat.length ).toBe( 0 )
            expect( report.understood ).toBe( false )
        } )


        it( 'AC: an explicit older ?version resolves that version; an unknown version falls back to latest', async () => {
            const rootDir = await makeSpec( { root: workRoot, ns: 'multi', version: '0.1.0', channel: 'draft',
                pages: [ { name: '00-a.md', content: '# A\n' } ] } )
            await makeSpec( { root: workRoot, ns: 'multi', version: '0.2.0', channel: 'draft',
                pages: [ { name: '00-a.md', content: '# A\n' }, { name: '01-b.md', content: '# B\n' } ] } )

            const reg = new SpecRegistry()
            reg.register( { namespace: 'multi', rootDir } )

            const latest = await reg.getLatest( { namespace: 'multi' } )
            expect( latest.version ).toBe( '0.2.0' )
            expect( latest.versions ).toEqual( [ '0.1.0', '0.2.0' ] )

            const older = await reg.listPages( { namespace: 'multi', version: '0.1.0' } )
            expect( older.version ).toBe( '0.1.0' )
            expect( older.flat.length ).toBe( 1 )

            const fallback = await reg.listPages( { namespace: 'multi', version: '9.9.9' } )
            expect( fallback.version ).toBe( '0.2.0' )
            expect( fallback.flat.length ).toBe( 2 )
        } )


        // The exact stale-fix proof the PRD names, run only when the real workshop is on disk (skipped
        // in CI where ../../spec is absent). Guarded so the suite stays deterministic + CI-safe.
        it( 'AC(a): the REAL workshop spec/memo/0.2.0 yields flatCount > 0 (guarded)', async () => {
            const realMemo = resolve( process.cwd(), '..', '..', 'spec', 'memo' )
            if( !existsSync( realMemo ) ) {
                expect( true ).toBe( true )

                return
            }

            const reg = new SpecRegistry()
            reg.register( { namespace: 'memo', rootDir: realMemo } )
            const pages = await reg.listPages( { namespace: 'memo' } )

            expect( pages.found ).toBe( true )
            expect( pages.flat.length ).toBeGreaterThan( 0 )
        } )
    } )


    describe( 'SpecAutoRegister — discover spec/ namespaces (no user-local store)', () => {
        it( 'AC: discovers every immediate subfolder that carries a spec.json', async () => {
            await makeSpec( { root: workRoot, ns: 'memo', version: '0.2.0', channel: 'draft', pages: [ { name: '00-a.md', content: '# A\n' } ] } )
            await makeSpec( { root: workRoot, ns: 'session', version: '0.2.0', channel: 'draft', pages: [ { name: '00-a.md', content: '# A\n' } ] } )
            await writeFile( resolve( workRoot, 'memo', 'spec.json' ), JSON.stringify( { currentVersion: '0.2.0' } ), 'utf-8' )
            await writeFile( resolve( workRoot, 'session', 'spec.json' ), JSON.stringify( { currentVersion: '0.2.0' } ), 'utf-8' )
            // A subfolder WITHOUT a spec.json is not a namespace.
            await mkdir( resolve( workRoot, 'not-a-ns' ), { recursive: true } )

            const { namespaces } = await SpecAutoRegister.discover( { specRoot: workRoot } )
            expect( namespaces.map( ( n ) => n.namespace ) ).toEqual( [ 'memo', 'session' ] )

            const reg = new SpecRegistry()
            const result = await SpecAutoRegister.autoRegister( { specRoot: workRoot, registry: reg } )
            expect( result.status ).toBe( true )
            expect( result.registered.sort() ).toEqual( [ 'memo', 'session' ] )
            expect( reg.has( { namespace: 'memo' } ).status ).toBe( true )
        } )


        it( 'AC: an absent spec/ root discovers nothing (fail-open), never throws', async () => {
            const { namespaces, reasons } = await SpecAutoRegister.discover( { specRoot: resolve( workRoot, 'nope' ) } )
            expect( namespaces ).toEqual( [] )
            expect( reasons.length ).toBeGreaterThan( 0 )
        } )
    } )


    describe( 'SpecPublishStatus — the local 3-stage badge (PUBLISHED / DRAFT-ONLY / DRIFT)', () => {
        it( 'AC: DRAFT-ONLY when the version exists in the workshop but not in repos/spec', async () => {
            const workshop = resolve( workRoot, 'workshop' )
            const publicRepo = resolve( workRoot, 'public' )
            await makeSpec( { root: workshop, ns: 'memo', version: '0.3.0', channel: 'dist', pages: [ { name: '00-a.md', content: '# A\nbody\n' } ] } )
            // public only carries an older, promoted version → 0.3.0 was never promoted.
            await makeSpec( { root: publicRepo, ns: 'memo', version: '0.2.0', channel: 'dist', pages: [ { name: '00-a.md', content: '# A\nbody\n' } ] } )

            const result = await SpecPublishStatus.derive( {
                workshopNsDir: resolve( workshop, 'memo' ),
                publicNsDir: resolve( publicRepo, 'memo' ),
                version: '0.3.0'
            } )

            expect( result.badge ).toBe( BADGE.DRAFT_ONLY )
            expect( result.badge ).toBe( 'DRAFT-ONLY' )
        } )


        it( 'AC: PUBLISHED when both sides carry the version and the dist is parity-identical (volatile stripped)', async () => {
            const workshop = resolve( workRoot, 'workshop' )
            const publicRepo = resolve( workRoot, 'public' )
            // Same body; ONLY a volatile provenance line differs → must still read PUBLISHED.
            await makeSpec( { root: workshop, ns: 'memo', version: '0.2.0', channel: 'dist',
                pages: [ { name: '00-a.md', content: '---\ngenerated_at: 111\nfromCommit: aaaaaaa\n---\n# A\n\nThe body is identical.\n' } ] } )
            await makeSpec( { root: publicRepo, ns: 'memo', version: '0.2.0', channel: 'dist',
                pages: [ { name: '00-a.md', content: '---\ngenerated_at: 999\nfromCommit: bbbbbbb\n---\n# A\n\nThe body is identical.\n' } ] } )

            const result = await SpecPublishStatus.derive( {
                workshopNsDir: resolve( workshop, 'memo' ),
                publicNsDir: resolve( publicRepo, 'memo' ),
                version: '0.2.0'
            } )

            expect( result.badge ).toBe( BADGE.PUBLISHED )
            expect( result.badge ).toBe( 'PUBLISHED' )
        } )


        it( 'AC: DRIFT when both sides carry the version but the dist content diverges', async () => {
            const workshop = resolve( workRoot, 'workshop' )
            const publicRepo = resolve( workRoot, 'public' )
            await makeSpec( { root: workshop, ns: 'memo', version: '0.2.0', channel: 'dist',
                pages: [ { name: '00-a.md', content: '# A\n\nThe workshop body was edited AFTER promotion.\n' } ] } )
            await makeSpec( { root: publicRepo, ns: 'memo', version: '0.2.0', channel: 'dist',
                pages: [ { name: '00-a.md', content: '# A\n\nThe stale promoted body.\n' } ] } )

            const result = await SpecPublishStatus.derive( {
                workshopNsDir: resolve( workshop, 'memo' ),
                publicNsDir: resolve( publicRepo, 'memo' ),
                version: '0.2.0'
            } )

            expect( result.badge ).toBe( BADGE.DRIFT )
            expect( result.badge ).toBe( 'DRIFT' )
        } )


        it( 'AC: DRIFT when the dist page SET differs (a page added/removed on one side)', async () => {
            const workshop = resolve( workRoot, 'workshop' )
            const publicRepo = resolve( workRoot, 'public' )
            await makeSpec( { root: workshop, ns: 'memo', version: '0.2.0', channel: 'dist',
                pages: [ { name: '00-a.md', content: '# A\n' }, { name: '01-b.md', content: '# B\n' } ] } )
            await makeSpec( { root: publicRepo, ns: 'memo', version: '0.2.0', channel: 'dist',
                pages: [ { name: '00-a.md', content: '# A\n' } ] } )

            const result = await SpecPublishStatus.derive( {
                workshopNsDir: resolve( workshop, 'memo' ),
                publicNsDir: resolve( publicRepo, 'memo' ),
                version: '0.2.0'
            } )

            expect( result.badge ).toBe( BADGE.DRIFT )
        } )


        it( 'AC: compareDist is a pure content comparator (volatile lines ignored)', () => {
            const identical = SpecPublishStatus.compareDist( {
                workshopPages: [ { name: '00-a.md', content: 'generated_at: 1\n# A\nbody\n' } ],
                publicPages: [ { name: '00-a.md', content: 'generated_at: 2\n# A\nbody\n' } ]
            } )
            expect( identical.identical ).toBe( true )

            const differ = SpecPublishStatus.compareDist( {
                workshopPages: [ { name: '00-a.md', content: '# A\nbody one\n' } ],
                publicPages: [ { name: '00-a.md', content: '# A\nbody two\n' } ]
            } )
            expect( differ.identical ).toBe( false )
        } )
    } )
} )
