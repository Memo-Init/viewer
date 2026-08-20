import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { SessionConfigStore } from '../../src/SessionConfigStore.mjs'


// Memo 079 PRD-23 (WI-050/052): the declarative `discover` block + `folderTabs`, with the priority
// explicit projects[] > discover scan > cwd fallback. A fresh workbench with no upserted projects[] is
// no longer a dead tree — sibling projects are DERIVED by scanning <root>/<projectsDir>/*/. Tests build
// a fake workbench under .test-tmp/ and point the env override at its .sessions/config.json so the
// ancestor walk (dirname(dirname(configPath))) resolves the workbench root deterministically.
describe( 'SessionConfigStore discover — Memo 079 PRD-23', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let workbenchRoot = ''
    let configPath = ''


    const writeConfig = async ( { config } ) => {
        await mkdir( join( workbenchRoot, '.sessions' ), { recursive: true } )
        configPath = join( workbenchRoot, '.sessions', 'config.json' )
        await writeFile( configPath, JSON.stringify( config ), 'utf8' )
    }


    const seedProject = async ( { name } ) => {
        await mkdir( join( workbenchRoot, 'projects', name, '.memo' ), { recursive: true } )
    }


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        workbenchRoot = await mkdtemp( join( repoTmpRoot, 'wb-' ) )
    } )

    afterEach( async () => {
        await rm( workbenchRoot, { recursive: true, force: true } )
    } )


    it( 'reads a discover block and folderTabs via readConfig', async () => {
        await writeConfig( { config: {
            discover: { projectsDir: 'projects', includeRoot: true },
            folderTabs: [ { id: 'specs', folder: 'spec', view: 'spec' }, { id: 'bad' } ]
        } } )

        const { discover, folderTabs } = SessionConfigStore.readConfig( { env: { MEMOVIEW_SESSION_CONFIG: configPath } } )
        expect( discover ).toEqual( { projectsDir: 'projects', includeRoot: true } )
        // the malformed folderTab (no folder) is dropped, the valid one kept.
        expect( folderTabs ).toEqual( [ { id: 'specs', folder: 'spec', view: 'spec' } ] )
    } )


    it( 'PRIORITY explicit: a non-empty projects[] wins over discover', async () => {
        await seedProject( { name: 'proj-a' } )
        await writeConfig( { config: {
            projects: [ { projectId: 'explicit-one', projectRoot: '/abs/explicit-one' } ],
            discover: { projectsDir: 'projects', includeRoot: false }
        } } )

        const { projects, source } = SessionConfigStore.resolveProjects( { env: { MEMOVIEW_SESSION_CONFIG: configPath } } )
        expect( source ).toBe( 'explicit' )
        expect( projects.map( ( p ) => p.projectId ) ).toEqual( [ 'explicit-one' ] )
    } )


    it( 'PRIORITY discover: an empty projects[] falls back to the discover scan (siblings with .memo)', async () => {
        await seedProject( { name: 'proj-a' } )
        await seedProject( { name: 'proj-b' } )
        // a projects/ child WITHOUT .memo must be skipped
        await mkdir( join( workbenchRoot, 'projects', 'no-memo' ), { recursive: true } )
        await writeConfig( { config: { discover: { projectsDir: 'projects', includeRoot: false } } } )

        const { projects, source } = SessionConfigStore.resolveProjects( { env: { MEMOVIEW_SESSION_CONFIG: configPath } } )
        expect( source ).toBe( 'discover' )
        expect( projects.map( ( p ) => p.projectId ).sort() ).toEqual( [ 'proj-a', 'proj-b' ] )
        expect( projects.every( ( p ) => typeof p.projectRoot === 'string' && p.projectRoot.length > 0 ) ).toBe( true )
    } )


    it( 'discover includeRoot adds the workbench root itself when it carries .memo', async () => {
        await mkdir( join( workbenchRoot, '.memo' ), { recursive: true } )
        await seedProject( { name: 'proj-a' } )
        await writeConfig( { config: { discover: { projectsDir: 'projects', includeRoot: true } } } )

        const { projects, source } = SessionConfigStore.resolveProjects( { env: { MEMOVIEW_SESSION_CONFIG: configPath } } )
        expect( source ).toBe( 'discover' )
        const roots = projects.map( ( p ) => p.projectRoot )
        expect( roots ).toContain( workbenchRoot )
        expect( projects.length ).toBe( 2 )
    } )


    it( 'PRIORITY cwd: neither explicit nor a resolving discover → empty list, source cwd', async () => {
        await writeConfig( { config: {} } )

        const { projects, source } = SessionConfigStore.resolveProjects( { env: { MEMOVIEW_SESSION_CONFIG: configPath } } )
        expect( source ).toBe( 'cwd' )
        expect( projects ).toEqual( [] )
    } )


    it( 'readConfig stays fail-open for a broken config (empty discover/folderTabs, projects [])', async () => {
        await mkdir( join( workbenchRoot, '.sessions' ), { recursive: true } )
        configPath = join( workbenchRoot, '.sessions', 'config.json' )
        await writeFile( configPath, '{ broken', 'utf8' )

        const result = SessionConfigStore.readConfig( { env: { MEMOVIEW_SESSION_CONFIG: configPath } } )
        expect( result.projects ).toEqual( [] )
        expect( result.discover ).toBeNull()
        expect( result.folderTabs ).toEqual( [] )
    } )
} )
