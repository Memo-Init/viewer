import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'
import { SpecRegistry } from '../../src/SpecRegistry.mjs'
import { SessionConfigStore } from '../../src/SessionConfigStore.mjs'


// Memo 079 PRD-23 (WI-051, finding e): the spec roots derive PER PROJECT from the resolved projects[]
// axis (explicit > discover > cwd), NOT from the server cwd — otherwise the folder-tab / spec discovery
// sees only ONE project (the WI-133 crossed axis repeating at the spec level). Two pure/behavioural
// seams cover it: MemoView.resolveSpecRoots (config → per-project { workshopRoot, publicRoot }) and
// MemoView.registerSpecRootsInto (discover + register with FIRST-WINS on a namespace collision, plus the
// per-namespace root map the publish badge reads). Writes go ONLY into a repo-internal temp dir
// (.test-tmp/), never the real .memo/ or the user home (§ Test-Isolation).
describe( 'Per-project spec roots — Memo 079 PRD-23 (WI-051)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let root = ''


    const seedNamespace = async ( { projectRoot, namespace } ) => {
        const nsDir = resolve( projectRoot, 'spec', namespace )
        await mkdir( nsDir, { recursive: true } )
        await writeFile( resolve( nsDir, 'spec.json' ), JSON.stringify( { namespace } ), 'utf8' )
    }


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        root = await mkdtemp( join( repoTmpRoot, 'specroots-' ) )
    } )

    afterEach( async () => {
        await rm( root, { recursive: true, force: true } )
    } )


    describe( 'resolveSpecRoots — pure config → per-project roots', () => {
        it( 'maps each project to <root>/spec + <root>/repos/spec, carrying the projectId', () => {
            const { specRoots } = MemoView.resolveSpecRoots( { projects: [
                { projectId: 'proj-a', projectRoot: '/abs/proj-a' },
                { projectId: 'proj-b', projectRoot: '/abs/proj-b' }
            ], cwd: '/somewhere/else' } )

            expect( specRoots ).toEqual( [
                { projectId: 'proj-a', workshopRoot: resolve( '/abs/proj-a', 'spec' ), publicRoot: resolve( '/abs/proj-a', 'repos', 'spec' ) },
                { projectId: 'proj-b', workshopRoot: resolve( '/abs/proj-b', 'spec' ), publicRoot: resolve( '/abs/proj-b', 'repos', 'spec' ) }
            ] )
        } )


        it( 'an EMPTY projects[] falls back to a SINGLE cwd root (projectId null) — today\'s bare-project behaviour', () => {
            const { specRoots } = MemoView.resolveSpecRoots( { projects: [], cwd: '/work/dir' } )

            expect( specRoots ).toEqual( [
                { projectId: null, workshopRoot: resolve( '/work/dir', 'spec' ), publicRoot: resolve( '/work/dir', 'repos', 'spec' ) }
            ] )
        } )


        it( 'drops entries without a usable projectRoot (fail-open)', () => {
            const { specRoots } = MemoView.resolveSpecRoots( { projects: [
                { projectId: 'ok', projectRoot: '/abs/ok' },
                { projectId: 'broken' },
                { projectId: 'empty', projectRoot: '' }
            ], cwd: '/cwd' } )

            expect( specRoots.map( ( s ) => s.projectId ) ).toEqual( [ 'ok' ] )
        } )
    } )


    describe( 'registerSpecRootsInto — discover + FIRST-WINS + per-namespace root map', () => {
        it( 'registers every project\'s namespaces and records which project each came from', async () => {
            const projA = resolve( root, 'proj-a' )
            const projB = resolve( root, 'proj-b' )
            await seedNamespace( { projectRoot: projA, namespace: 'memo' } )
            await seedNamespace( { projectRoot: projA, namespace: 'session' } )
            await seedNamespace( { projectRoot: projB, namespace: 'workbench' } )

            const { specRoots } = MemoView.resolveSpecRoots( { projects: [
                { projectId: 'proj-a', projectRoot: projA },
                { projectId: 'proj-b', projectRoot: projB }
            ] } )

            const registry = new SpecRegistry()
            const { rootsByNamespace, outcomes } = await MemoView.registerSpecRootsInto( { specRoots, specRegistry: registry } )

            const registered = registry.listNamespaces().namespaces.map( ( n ) => n.namespace ).sort()
            expect( registered ).toEqual( [ 'memo', 'session', 'workbench' ] )

            // each namespace maps back to ITS OWN project's workshop/public roots (not the server cwd).
            expect( rootsByNamespace.get( 'memo' ) ).toEqual( { workshopRoot: resolve( projA, 'spec' ), publicRoot: resolve( projA, 'repos', 'spec' ) } )
            expect( rootsByNamespace.get( 'workbench' ) ).toEqual( { workshopRoot: resolve( projB, 'spec' ), publicRoot: resolve( projB, 'repos', 'spec' ) } )

            const byProject = {}
            outcomes.forEach( ( o ) => { byProject[ o.projectId ] = o.registered.sort() } )
            expect( byProject[ 'proj-a' ] ).toEqual( [ 'memo', 'session' ] )
            expect( byProject[ 'proj-b' ] ).toEqual( [ 'workbench' ] )
        } )


        it( 'FIRST-WINS on a namespace-name collision — an earlier project keeps the namespace (NO-AUTO-OVERWRITE)', async () => {
            const projA = resolve( root, 'proj-a' )
            const projB = resolve( root, 'proj-b' )
            // both projects declare a `memo` namespace — the org-wide identical spec pattern.
            await seedNamespace( { projectRoot: projA, namespace: 'memo' } )
            await seedNamespace( { projectRoot: projB, namespace: 'memo' } )
            await seedNamespace( { projectRoot: projB, namespace: 'workbench' } )

            const { specRoots } = MemoView.resolveSpecRoots( { projects: [
                { projectId: 'proj-a', projectRoot: projA },
                { projectId: 'proj-b', projectRoot: projB }
            ] } )

            const registry = new SpecRegistry()
            const { rootsByNamespace, outcomes } = await MemoView.registerSpecRootsInto( { specRoots, specRegistry: registry } )

            // proj-a (earlier) OWNS `memo`; proj-b's `memo` is dropped, only its `workbench` registers.
            expect( registry.rootDirFor( { namespace: 'memo' } ).rootDir ).toBe( resolve( projA, 'spec', 'memo' ) )
            expect( rootsByNamespace.get( 'memo' ).workshopRoot ).toBe( resolve( projA, 'spec' ) )

            const byProject = {}
            outcomes.forEach( ( o ) => { byProject[ o.projectId ] = o.registered.sort() } )
            expect( byProject[ 'proj-a' ] ).toEqual( [ 'memo' ] )
            expect( byProject[ 'proj-b' ] ).toEqual( [ 'workbench' ] )
        } )


        it( 'a project with no spec/ contributes zero namespaces (fail-open, reasons carried)', async () => {
            const projA = resolve( root, 'proj-a' )
            await seedNamespace( { projectRoot: projA, namespace: 'memo' } )
            const projNone = resolve( root, 'proj-none' )
            await mkdir( projNone, { recursive: true } )

            const { specRoots } = MemoView.resolveSpecRoots( { projects: [
                { projectId: 'proj-a', projectRoot: projA },
                { projectId: 'proj-none', projectRoot: projNone }
            ] } )

            const registry = new SpecRegistry()
            const { outcomes } = await MemoView.registerSpecRootsInto( { specRoots, specRegistry: registry } )

            const none = outcomes.find( ( o ) => o.projectId === 'proj-none' )
            expect( none.registered ).toEqual( [] )
            expect( none.reasons.length ).toBeGreaterThan( 0 )
        } )
    } )


    describe( 'the spec axis follows the SAME explicit > discover > cwd priority as documents', () => {
        const writeConfig = async ( { workbenchRoot, config } ) => {
            await mkdir( join( workbenchRoot, '.sessions' ), { recursive: true } )
            const configPath = join( workbenchRoot, '.sessions', 'config.json' )
            await writeFile( configPath, JSON.stringify( config ), 'utf8' )

            return configPath
        }


        it( 'PRIORITY explicit: resolveProjects → resolveSpecRoots pins the explicit project roots, ignoring discover', async () => {
            const workbenchRoot = await mkdtemp( join( repoTmpRoot, 'wb-' ) )
            await mkdir( join( workbenchRoot, 'projects', 'sibling', '.memo' ), { recursive: true } )
            const configPath = await writeConfig( { workbenchRoot, config: {
                projects: [ { projectId: 'pinned', projectRoot: '/abs/pinned' } ],
                discover: { projectsDir: 'projects', includeRoot: false }
            } } )

            const { projects, source } = SessionConfigStore.resolveProjects( { env: { MEMOVIEW_SESSION_CONFIG: configPath } } )
            const { specRoots } = MemoView.resolveSpecRoots( { projects } )

            expect( source ).toBe( 'explicit' )
            expect( specRoots.map( ( s ) => s.workshopRoot ) ).toEqual( [ resolve( '/abs/pinned', 'spec' ) ] )

            await rm( workbenchRoot, { recursive: true, force: true } )
        } )


        it( 'PRIORITY discover: an empty projects[] derives sibling spec roots from the discover scan', async () => {
            const workbenchRoot = await mkdtemp( join( repoTmpRoot, 'wb-' ) )
            await mkdir( join( workbenchRoot, 'projects', 'alpha', '.memo' ), { recursive: true } )
            await mkdir( join( workbenchRoot, 'projects', 'beta', '.memo' ), { recursive: true } )
            const configPath = await writeConfig( { workbenchRoot, config: {
                discover: { projectsDir: 'projects', includeRoot: false }
            } } )

            const { projects, source } = SessionConfigStore.resolveProjects( { env: { MEMOVIEW_SESSION_CONFIG: configPath } } )
            const { specRoots } = MemoView.resolveSpecRoots( { projects } )

            expect( source ).toBe( 'discover' )
            expect( specRoots.map( ( s ) => s.workshopRoot ).sort() ).toEqual( [
                resolve( workbenchRoot, 'projects', 'alpha', 'spec' ),
                resolve( workbenchRoot, 'projects', 'beta', 'spec' )
            ] )

            await rm( workbenchRoot, { recursive: true, force: true } )
        } )
    } )
} )
