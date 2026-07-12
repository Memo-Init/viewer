import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { ProjectAutoRegister } from '../../src/ProjectAutoRegister.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// Memo 070, Phase 4 — the memo-viewer AUTO-REGISTRATION trigger. A valid-structure project is
// auto-registered via the EXISTING DocumentRegistry.addDocument mechanism (never reinvented). Tests
// write ONLY into a repo-internal temp directory (.test-tmp/), never the real .memo/ or the user home
// (~/.claude/CLAUDE.md § Test-Isolation). The feature is "auto-registration" — deliberately NOT
// "auto-login": this suite touches NO transcript loggedIn field.
describe( 'ProjectAutoRegister — Memo 070 Phase 4 (auto-registration trigger)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let projectRoot = ''
    let registry = null


    const makeMemo = async ( { root, layout, name } ) => {
        const base = layout === 'canonical' ? resolve( root, '.memo', 'memos', name ) : resolve( root, '.memo', name )
        await mkdir( resolve( base, 'revisions' ), { recursive: true } )
        await writeFile( resolve( base, 'revisions', 'REV-01.md' ), `# ${name}\n\n| **Status** | Entwurf |\n`, 'utf-8' )

        return base
    }


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        projectRoot = await mkdtemp( join( repoTmpRoot, 'autoreg-' ) )
    } )

    afterEach( async () => {
        if( registry !== null && typeof registry.shutdown === 'function' ) {
            registry.shutdown()
            registry = null
        }
        await rm( projectRoot, { recursive: true, force: true } )
    } )


    describe( 'validateStructure', () => {
        it( 'AC: a .memo/ with two canonical numbered memos is valid', async () => {
            await makeMemo( { root: projectRoot, layout: 'canonical', name: '070-alpha' } )
            await makeMemo( { root: projectRoot, layout: 'canonical', name: '071-beta' } )

            const result = await ProjectAutoRegister.validateStructure( { projectRoot } )

            expect( result[ 'valid' ] ).toBe( true )
            expect( result[ 'memoDirs' ] ).toHaveLength( 2 )
            expect( result[ 'reasons' ] ).toEqual( [] )
        } )


        it( 'AC: the legacy flat .memo/NNN-slug/ layout is also valid', async () => {
            await makeMemo( { root: projectRoot, layout: 'legacy', name: '099-legacy' } )

            const result = await ProjectAutoRegister.validateStructure( { projectRoot } )

            expect( result[ 'valid' ] ).toBe( true )
            expect( result[ 'memoDirs' ] ).toHaveLength( 1 )
        } )


        it( 'AC: a project without a .memo/ directory is invalid', async () => {
            const result = await ProjectAutoRegister.validateStructure( { projectRoot } )

            expect( result[ 'valid' ] ).toBe( false )
            expect( result[ 'reasons' ][ 0 ] ).toMatch( /No \.memo\/ directory/ )
        } )


        it( 'AC: a .memo/ with no numbered memo carrying revisions is invalid', async () => {
            await mkdir( resolve( projectRoot, '.memo', 'chronic' ), { recursive: true } )
            await mkdir( resolve( projectRoot, '.memo', 'memos', 'not-a-memo' ), { recursive: true } )

            const result = await ProjectAutoRegister.validateStructure( { projectRoot } )

            expect( result[ 'valid' ] ).toBe( false )
            expect( result[ 'reasons' ][ 0 ] ).toMatch( /No numbered memo/ )
        } )


        it( 'AC: an empty/absent projectRoot is invalid (no silent guess)', async () => {
            const result = await ProjectAutoRegister.validateStructure( { projectRoot: '' } )

            expect( result[ 'valid' ] ).toBe( false )
            expect( result[ 'reasons' ][ 0 ] ).toMatch( /non-empty string/ )
        } )
    } )


    describe( 'autoRegister — the trigger fires against a real DocumentRegistry', () => {
        it( 'AC: registers every memo of a valid project (documents become visible)', async () => {
            await makeMemo( { root: projectRoot, layout: 'canonical', name: '070-alpha' } )
            await makeMemo( { root: projectRoot, layout: 'canonical', name: '071-beta' } )

            const created = DocumentRegistry.create( { onChange: null } )
            registry = created[ 'registry' ]

            const result = await ProjectAutoRegister.autoRegister( { projectRoot, registry } )

            // The trigger fired: both memos are now registered documents in the registry.
            expect( result[ 'status' ] ).toBe( true )
            expect( result[ 'registered' ] ).toHaveLength( 2 )
            expect( result[ 'skipped' ] ).toEqual( [] )

            const { documents } = registry.getDocuments()
            expect( documents ).toHaveLength( 2 )
            const names = documents
                .map( ( doc ) => doc[ 'memoName' ] )
                .sort()
            expect( names ).toEqual( [ '070-alpha', '071-beta' ] )
        } )


        it( 'AC: the projectId is derived from the project folder name', async () => {
            await makeMemo( { root: projectRoot, layout: 'canonical', name: '070-alpha' } )

            const created = DocumentRegistry.create( { onChange: null } )
            registry = created[ 'registry' ]

            const result = await ProjectAutoRegister.autoRegister( { projectRoot, registry } )

            expect( result[ 'projectId' ] ).toMatch( /^[a-zA-Z0-9_-]+$/ )
            expect( result[ 'registered' ][ 0 ] ).toContain( result[ 'projectId' ] )
        } )


        it( 'AC: an invalid structure does NOT register anything (fail-open)', async () => {
            const created = DocumentRegistry.create( { onChange: null } )
            registry = created[ 'registry' ]

            const result = await ProjectAutoRegister.autoRegister( { projectRoot, registry } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'registered' ] ).toEqual( [] )
            expect( result[ 'reasons' ].length ).toBeGreaterThan( 0 )
            expect( registry.getDocuments()[ 'documents' ] ).toEqual( [] )
        } )


        it( 'AC: a registry without addDocument is rejected, never thrown', async () => {
            const result = await ProjectAutoRegister.autoRegister( { projectRoot, registry: {} } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'reasons' ][ 0 ] ).toMatch( /addDocument/ )
        } )
    } )
} )
