import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { RequirementsStore, SHORT_NAME_MAX } from '../../src/RequirementsStore.mjs'


// PRD-012 (Memo 011 Kap 4, F16=A): the requirements-view data source. Reads the calibration-layer
// store (.memo/requirements/) and produces PRD-level groups + the memo aggregate. Tests write ONLY
// into a repo-internal temp directory (.test-tmp/), NEVER the real .memo/ and NEVER the user home
// (~/.claude/CLAUDE.md § Test-Isolation). READ-ONLY module — nothing here writes back to the store.
describe( 'RequirementsStore — PRD-012 (Memo 011 Kap 4, F16=A)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let requirementsDir = ''


    const writeReq = async ( req ) => {
        await writeFile( join( requirementsDir, `${ req.id }.req.json` ), JSON.stringify( req ), 'utf8' )
    }

    const writeIndex = async ( ids ) => {
        const requirements = ids.map( ( id ) => {
            return { id, file: `${ id }.req.json` }
        } )

        await writeFile(
            join( requirementsDir, 'index.json' ),
            JSON.stringify( { generatedBy: 'test', count: ids.length, requirements } ),
            'utf8'
        )
    }

    const writeSet = async ( name, ids ) => {
        const set = {
            name,
            context: { repos: [], categories: [], tags: [] },
            ids
        }

        await writeFile( join( requirementsDir, 'sets', `${ name }.set.json` ), JSON.stringify( set ), 'utf8' )
    }


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        requirementsDir = await mkdtemp( join( repoTmpRoot, 'req-' ) )
        await mkdir( join( requirementsDir, 'sets' ), { recursive: true } )
    } )

    afterEach( async () => {
        await rm( requirementsDir, { recursive: true, force: true } )
    } )


    describe( 'shortName (US-2: hover -> Kurzname, data-derived)', () => {
        it( 'AC: derives the short name from the title leading segment (before " — ")', () => {
            const requirement = {
                id: 'REQ-0001',
                title: 'Prompt output in terminal — must be displayed for copy-paste',
                statement: 'long statement'
            }
            const { shortName } = RequirementsStore.shortName( { requirement } )

            expect( shortName ).toBe( 'Prompt output in terminal' )
        } )


        it( 'AC: falls back to statement when title is missing', () => {
            const requirement = { id: 'REQ-0002', statement: 'Tool names must be unique' }
            const { shortName } = RequirementsStore.shortName( { requirement } )

            expect( shortName ).toBe( 'Tool names must be unique' )
        } )


        it( 'AC: clamps overly long names and appends an ellipsis', () => {
            const longTitle = 'X'.repeat( 200 )
            const { shortName } = RequirementsStore.shortName( { requirement: { id: 'REQ-0003', title: longTitle } } )

            expect( shortName.length ).toBeLessThanOrEqual( SHORT_NAME_MAX )
            expect( shortName.endsWith( '…' ) ).toBe( true )
        } )
    } )


    describe( 'loadAll (US-1: read .req.json bodies)', () => {
        it( 'AC: reads every indexed requirement and enriches each with a shortName', async () => {
            await writeReq( { id: 'REQ-0001', title: 'Alpha', statement: 'a', scope: { repos: [ 'viewer' ], categories: [], tags: [] }, severity: 'blocker', origin: 'ai-added' } )
            await writeReq( { id: 'REQ-0002', title: 'Beta', statement: 'b', scope: { repos: [], categories: [], tags: [] }, severity: 'warning', origin: 'predefined' } )
            await writeIndex( [ 'REQ-0001', 'REQ-0002' ] )

            const result = await RequirementsStore.loadAll( { requirementsDir } )

            expect( result.status ).toBe( 'ok' )
            expect( result.count ).toBe( 2 )
            expect( result.requirements.map( ( r ) => r.shortName ) ).toEqual( [ 'Alpha', 'Beta' ] )
        } )


        it( 'AC: a missing store (no index.json) is a benign empty result, not an error', async () => {
            const result = await RequirementsStore.loadAll( { requirementsDir } )

            expect( result.status ).toBe( 'empty' )
            expect( result.count ).toBe( 0 )
            expect( result.requirements ).toEqual( [] )
        } )
    } )


    describe( 'aggregate (US-1: PRD-level groups + Memo-aggregate)', () => {
        it( 'AC: resolves the memo eval-set ids to full bodies as the memo aggregate', async () => {
            await writeReq( { id: 'REQ-0001', title: 'Alpha', statement: 'a', scope: { repos: [ 'viewer' ], categories: [], tags: [] }, severity: 'blocker', origin: 'ai-added' } )
            await writeReq( { id: 'REQ-0002', title: 'Beta', statement: 'b', scope: { repos: [ 'spec' ], categories: [], tags: [] }, severity: 'warning', origin: 'predefined' } )
            await writeReq( { id: 'REQ-0003', title: 'Gamma', statement: 'c', scope: { repos: [], categories: [], tags: [] }, severity: 'info', origin: 'predefined' } )
            await writeIndex( [ 'REQ-0001', 'REQ-0002', 'REQ-0003' ] )
            await writeSet( 'memo-011', [ 'REQ-0001', 'REQ-0002' ] )

            const view = await RequirementsStore.aggregate( { requirementsDir, memoName: 'memo-011' } )

            expect( view.status ).toBe( 'ok' )
            expect( view.count ).toBe( 2 )
            expect( view.aggregate.map( ( r ) => r.id ).sort() ).toEqual( [ 'REQ-0001', 'REQ-0002' ] )
            // REQ-0003 is NOT in the memo set -> must not leak into the aggregate.
            expect( view.aggregate.map( ( r ) => r.id ) ).not.toContain( 'REQ-0003' )
        } )


        it( 'AC: groups requirements on PRD-level by their scope.repos signature', async () => {
            await writeReq( { id: 'REQ-0001', title: 'Alpha', statement: 'a', scope: { repos: [ 'viewer' ], categories: [], tags: [] }, severity: 'blocker', origin: 'ai-added' } )
            await writeReq( { id: 'REQ-0002', title: 'Beta', statement: 'b', scope: { repos: [ 'viewer' ], categories: [], tags: [] }, severity: 'warning', origin: 'predefined' } )
            await writeReq( { id: 'REQ-0003', title: 'Gamma', statement: 'c', scope: { repos: [], categories: [], tags: [] }, severity: 'info', origin: 'predefined' } )
            await writeIndex( [ 'REQ-0001', 'REQ-0002', 'REQ-0003' ] )
            await writeSet( 'memo-011', [ 'REQ-0001', 'REQ-0002', 'REQ-0003' ] )

            const view = await RequirementsStore.aggregate( { requirementsDir, memoName: 'memo-011' } )

            const keys = view.groups.map( ( g ) => g.groupKey )
            expect( keys ).toContain( 'viewer' )
            expect( keys ).toContain( '(all repos)' )

            const viewerGroup = view.groups.filter( ( g ) => g.groupKey === 'viewer' )[ 0 ]
            expect( viewerGroup.requirements.map( ( r ) => r.id ).sort() ).toEqual( [ 'REQ-0001', 'REQ-0002' ] )

            const allGroup = view.groups.filter( ( g ) => g.groupKey === '(all repos)' )[ 0 ]
            expect( allGroup.requirements.map( ( r ) => r.id ) ).toEqual( [ 'REQ-0003' ] )
        } )


        it( 'AC: every aggregate requirement appears in exactly one PRD-level group', async () => {
            await writeReq( { id: 'REQ-0001', title: 'Alpha', statement: 'a', scope: { repos: [ 'viewer' ], categories: [], tags: [] }, severity: 'blocker', origin: 'ai-added' } )
            await writeReq( { id: 'REQ-0002', title: 'Beta', statement: 'b', scope: { repos: [ 'spec' ], categories: [], tags: [] }, severity: 'warning', origin: 'predefined' } )
            await writeIndex( [ 'REQ-0001', 'REQ-0002' ] )
            await writeSet( 'memo-011', [ 'REQ-0001', 'REQ-0002' ] )

            const view = await RequirementsStore.aggregate( { requirementsDir, memoName: 'memo-011' } )
            const grouped = view.groups
                .map( ( g ) => g.requirements.map( ( r ) => r.id ) )
                .flat()
                .sort()

            expect( grouped ).toEqual( view.aggregate.map( ( r ) => r.id ).sort() )
        } )


        it( 'AC: unknown set ids are skipped but reported in missingIds', async () => {
            await writeReq( { id: 'REQ-0001', title: 'Alpha', statement: 'a', scope: { repos: [], categories: [], tags: [] }, severity: 'blocker', origin: 'ai-added' } )
            await writeIndex( [ 'REQ-0001' ] )
            await writeSet( 'memo-011', [ 'REQ-0001', 'REQ-9999' ] )

            const view = await RequirementsStore.aggregate( { requirementsDir, memoName: 'memo-011' } )

            expect( view.count ).toBe( 1 )
            expect( view.missingIds ).toEqual( [ 'REQ-9999' ] )
        } )


        it( 'AC: a memo without a recorded set yields an empty (not error) view', async () => {
            await writeReq( { id: 'REQ-0001', title: 'Alpha', statement: 'a', scope: { repos: [], categories: [], tags: [] }, severity: 'blocker', origin: 'ai-added' } )
            await writeIndex( [ 'REQ-0001' ] )

            const view = await RequirementsStore.aggregate( { requirementsDir, memoName: 'memo-999' } )

            expect( view.status ).toBe( 'ok' )
            expect( view.count ).toBe( 0 )
            expect( view.aggregate ).toEqual( [] )
            expect( view.groups ).toEqual( [] )
        } )
    } )


    describe( 'listMemoSets', () => {
        it( 'AC: lists recorded memo set names without the .set.json suffix, sorted', async () => {
            await writeSet( 'memo-011', [] )
            await writeSet( 'memo-005', [] )

            const result = await RequirementsStore.listMemoSets( { requirementsDir } )

            expect( result.status ).toBe( 'ok' )
            expect( result.memos ).toEqual( [ 'memo-005', 'memo-011' ] )
        } )
    } )
} )
