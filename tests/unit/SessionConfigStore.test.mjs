import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { SessionConfigStore } from '../../src/SessionConfigStore.mjs'


// PRD-014 (Memo 076 Phase 7, WI-006/007/010/011): the READ side of the persistent Session-Config
// project register. readProjects() must be fail-open (full / empty / broken / missing) and resolve the
// config path ABLEITEND (env override + ancestor walk) so no absolute user home path is ever hardcoded.
// Tests write ONLY into a repo-internal temp dir (.test-tmp/), never the real .sessions/config.json or
// the user home (~/.claude/CLAUDE.md § Test-Isolation).
describe( 'SessionConfigStore — Memo 076 Phase 7 (session-config reader, fail-open)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let baseDir = ''


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        baseDir = await mkdtemp( join( repoTmpRoot, 'sesscfg-' ) )
    } )

    afterEach( async () => {
        await rm( baseDir, { recursive: true, force: true } )
    } )


    const writeConfig = async ( { text } ) => {
        const configPath = join( baseDir, 'config.json' )
        await writeFile( configPath, text, 'utf-8' )

        return configPath
    }


    it( 'reads a FULL config → both projects + viewerUrl', async () => {
        const configPath = await writeConfig( { 'text': JSON.stringify( {
            'role': 'root',
            'activeProject': 'memo-init',
            'viewerUrl': 'http://127.0.0.1:3333',
            'projects': [
                { 'projectId': 'memo-init', 'projectRoot': '/abs/projects/memo-init', 'memoPath': '/abs/projects/memo-init/.memo/memos' },
                { 'projectId': 'flowmcp', 'projectRoot': '/abs/projects/flowmcp', 'memoPath': '/abs/projects/flowmcp/.memo/memos' }
            ]
        } ) } )

        const { projects, viewerUrl } = SessionConfigStore.readProjects( { 'env': { 'MEMOVIEW_SESSION_CONFIG': configPath } } )

        expect( projects.length ).toBe( 2 )
        expect( projects.map( ( p ) => p[ 'projectId' ] ) ).toEqual( [ 'memo-init', 'flowmcp' ] )
        expect( viewerUrl ).toBe( 'http://127.0.0.1:3333' )
    } )


    it( 'reads a SCALAR/empty config (no projects, no viewerUrl) → fail-open empty list, null url', async () => {
        const configPath = await writeConfig( { 'text': JSON.stringify( {
            'role': 'root', 'activeProject': 'memo-init', 'updatedAt': '2026-07-16T22:04Z'
        } ) } )

        const { projects, viewerUrl } = SessionConfigStore.readProjects( { 'env': { 'MEMOVIEW_SESSION_CONFIG': configPath } } )

        expect( projects ).toEqual( [] )
        expect( viewerUrl ).toBe( null )
    } )


    it( 'reads a BROKEN (invalid JSON) config → fail-open empty, never throws', async () => {
        const configPath = await writeConfig( { 'text': '{ this is : not json' } )

        const result = SessionConfigStore.readProjects( { 'env': { 'MEMOVIEW_SESSION_CONFIG': configPath } } )

        expect( result[ 'projects' ] ).toEqual( [] )
        expect( result[ 'viewerUrl' ] ).toBe( null )
        expect( result[ 'configPath' ] ).toBe( resolve( configPath ) )
    } )


    it( 'reads a MISSING config path → fail-open empty, configPath null', () => {
        const missing = join( baseDir, 'does-not-exist.json' )

        const result = SessionConfigStore.readProjects( { 'env': { 'MEMOVIEW_SESSION_CONFIG': missing } } )

        expect( result[ 'projects' ] ).toEqual( [] )
        expect( result[ 'viewerUrl' ] ).toBe( null )
        expect( result[ 'configPath' ] ).toBe( null )
    } )


    it( 'filters malformed projects[] entries (no string projectId dropped)', async () => {
        const configPath = await writeConfig( { 'text': JSON.stringify( {
            'projects': [
                { 'projectId': 'ok', 'projectRoot': '/abs/ok' },
                { 'projectRoot': '/abs/no-id' },
                null,
                42,
                { 'projectId': '' }
            ]
        } ) } )

        const { projects } = SessionConfigStore.readProjects( { 'env': { 'MEMOVIEW_SESSION_CONFIG': configPath } } )

        expect( projects.length ).toBe( 1 )
        expect( projects[ 0 ][ 'projectId' ] ).toBe( 'ok' )
    } )


    it( 'resolveConfigPath prefers the MEMOVIEW_SESSION_CONFIG override', () => {
        const override = join( baseDir, 'config.json' )
        const { configPath } = SessionConfigStore.resolveConfigPath( { 'env': { 'MEMOVIEW_SESSION_CONFIG': override } } )

        expect( configPath ).toBe( resolve( override ) )
    } )


    it( 'resolveConfigPath ASCENDS from cwd to the first .sessions/config.json ancestor', async () => {
        const sessionsDir = join( baseDir, '.sessions' )
        await mkdir( sessionsDir, { recursive: true } )
        const configPath = join( sessionsDir, 'config.json' )
        await writeFile( configPath, JSON.stringify( { 'projects': [] } ), 'utf-8' )

        const deepChild = join( baseDir, 'projects', 'memo-init', 'repos', 'viewer' )
        await mkdir( deepChild, { recursive: true } )

        const { configPath: found } = SessionConfigStore.resolveConfigPath( { 'cwd': deepChild, 'env': {} } )

        expect( found ).toBe( configPath )
    } )


    it( 'resolveConfigPath returns null when no ancestor holds .sessions/config.json', async () => {
        // Isolated under os.tmpdir() so no real .sessions/config.json (which lives above the repo)
        // is on the ancestor chain — the walk must reach the filesystem root and return null.
        const isolated = await mkdtemp( join( tmpdir(), 'sesscfg-null-' ) )

        try {
            const { configPath } = SessionConfigStore.resolveConfigPath( { 'cwd': isolated, 'env': {} } )

            expect( configPath ).toBe( null )
        } finally {
            await rm( isolated, { recursive: true, force: true } )
        }
    } )
} )
