import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PlanRegistry } from '../../src/PlanRegistry.mjs'


// Integration tests for PlanRegistry mechanics used by REST routes.
// MemoView.mjs is a large singleton that requires a live server and port binding
// to test HTTP routes directly. Instead, we test the underlying PlanRegistry
// operations that the routes delegate to — this covers the same logic paths.


describe( 'PlanRegistry — REST route mechanics', () => {
    let tempDir
    let registryFile
    let registry


    beforeEach( async () => {
        tempDir = await mkdtemp( join( tmpdir(), 'plan-routes-test-' ) )
        registryFile = join( tempDir, 'route-registry.json' )
        const { registry: reg } = PlanRegistry.create( { registryFilePath: registryFile } )
        registry = reg
        await registry.loadFromDisk()
    } )


    afterEach( async () => {
        await rm( tempDir, { recursive: true, force: true } )
    } )


    // ─── POST /api/plans backing logic ──────────────────────────────────────

    describe( 'POST /api/plans — add root', () => {
        it( 'registers a valid plans root and returns planId', async () => {
            const plansRoot = join( tempDir, 'plans' )
            await mkdir( plansRoot, { recursive: true } )

            const result = await registry.add( { 'absolutePath': plansRoot, 'projectId': 'my-project' } )

            expect( result['status'] ).toBe( true )
            expect( result['planId'] ).toBe( 'my-project--plans' )
        } )


        it( 'fails validation when planPath is missing', () => {
            const { status, messages } = PlanRegistry.validateAdd( { 'absolutePath': undefined, 'projectId': 'proj' } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'absolutePath' )
        } )


        it( 'fails validation when projectId is missing', () => {
            const { status, messages } = PlanRegistry.validateAdd( { 'absolutePath': '/some/path', 'projectId': undefined } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'projectId' )
        } )


        it( 'fails when planPath does not exist on disk', async () => {
            const result = await registry.add( {
                'absolutePath': '/nonexistent/path/plans',
                'projectId': 'proj'
            } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'not found' )
        } )


        it( 'fails when planPath is a file, not a directory', async () => {
            const filePath = join( tempDir, 'not-a-dir.md' )
            await writeFile( filePath, '# test' )

            const result = await registry.add( { 'absolutePath': filePath, 'projectId': 'proj' } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'directory' )
        } )
    } )


    // ─── GET /api/plans backing logic ───────────────────────────────────────

    describe( 'GET /api/plans — list roots', () => {
        it( 'returns empty roots when registry is fresh', async () => {
            const { plans } = await registry.list()

            expect( plans ).toEqual( [] )
        } )


        it( 'returns all registered roots with projectId and absolutePath', async () => {
            const rootA = join( tempDir, 'plans-a' )
            const rootB = join( tempDir, 'plans-b' )
            await mkdir( rootA, { recursive: true } )
            await mkdir( rootB, { recursive: true } )

            await registry.add( { 'absolutePath': rootA, 'projectId': 'proj-a' } )
            await registry.add( { 'absolutePath': rootB, 'projectId': 'proj-b' } )

            const { plans } = await registry.list()

            expect( plans.length ).toBe( 2 )

            const projectIds = plans.map( ( p ) => p['projectId'] )

            expect( projectIds ).toContain( 'proj-a' )
            expect( projectIds ).toContain( 'proj-b' )
        } )
    } )


    // ─── DELETE /api/plans/:projectId backing logic ──────────────────────────

    describe( 'DELETE /api/plans/:projectId — remove root', () => {
        it( 'removes a registered root by planId', async () => {
            const plansRoot = join( tempDir, 'plans-del' )
            await mkdir( plansRoot, { recursive: true } )

            const addResult = await registry.add( { 'absolutePath': plansRoot, 'projectId': 'del-proj' } )
            const removeResult = await registry.remove( { 'planId': addResult['planId'] } )

            expect( removeResult['status'] ).toBe( true )

            const { plans } = await registry.list()

            expect( plans.length ).toBe( 0 )
        } )


        it( 'returns not-found status when planId does not exist', async () => {
            const result = await registry.remove( { 'planId': 'nonexistent--PLAN-999-ghost' } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'Not found' )
        } )
    } )


    // ─── cwd auto-register mechanics ────────────────────────────────────────

    describe( 'cwd auto-register mechanics', () => {
        it( 'auto-register succeeds when cwd plans path exists', async () => {
            const cwdLikePlans = join( tempDir, 'auto-plans' )
            await mkdir( cwdLikePlans, { recursive: true } )

            const result = await registry.add( { 'absolutePath': cwdLikePlans, 'projectId': 'cwd-project' } )

            expect( result['status'] ).toBe( true )
        } )


        it( 'registry persists across reload — backwards-compat roundtrip', async () => {
            const plansRoot = join( tempDir, 'persistent-plans' )
            await mkdir( plansRoot, { recursive: true } )

            await registry.add( { 'absolutePath': plansRoot, 'projectId': 'persistent-proj' } )

            const { registry: freshReg } = PlanRegistry.create( { registryFilePath: registryFile } )
            await freshReg.loadFromDisk()

            const { plans } = freshReg.getPlans()

            expect( plans.length ).toBe( 1 )
            expect( plans[0]['projectId'] ).toBe( 'persistent-proj' )
            expect( plans[0]['absolutePath'] ).toBe( plansRoot )
        } )
    } )


    // ─── onChange / watcher integration ─────────────────────────────────────

    describe( 'watcher support (onChange)', () => {
        it( 'add with onChange does not throw and returns status true', async () => {
            const plansRoot = join( tempDir, 'watch-plans' )
            await mkdir( plansRoot, { recursive: true } )

            const onChange = () => {}
            const result = await registry.add( { 'absolutePath': plansRoot, 'projectId': 'watch-proj', onChange } )

            expect( result['status'] ).toBe( true )
        } )


        it( 'remove after add with onChange completes cleanly', async () => {
            const plansRoot = join( tempDir, 'watch-remove-plans' )
            await mkdir( plansRoot, { recursive: true } )

            const onChange = () => {}
            const addResult = await registry.add( { 'absolutePath': plansRoot, 'projectId': 'watch-rm-proj', onChange } )
            const removeResult = await registry.remove( { 'planId': addResult['planId'] } )

            expect( removeResult['status'] ).toBe( true )

            const { plans } = await registry.list()

            expect( plans.length ).toBe( 0 )
        } )
    } )
} )
