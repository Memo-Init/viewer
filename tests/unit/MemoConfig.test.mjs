import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MemoConfig } from '../../src/MemoConfig.mjs'


// PRD-003 (Memo 011 Kap 6): the project-prefix reader. .memo/config.json holds { projectPrefix: 'MEMO' }
// ONCE at the .memo/ root. read() is graceful when the file is absent; init() is NO-OVERWRITE — it never
// clobbers an existing config.json. Tests write only into a repo-internal temp directory (.test-tmp/),
// never into the user home (~/.claude/CLAUDE.md § Test-Isolation).
describe( 'MemoConfig — PRD-003 (Memo 011 Kap 6)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let memoDir = ''

    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        memoDir = await mkdtemp( join( repoTmpRoot, 'memoconfig-' ) )
    } )

    afterEach( async () => {
        await rm( memoDir, { recursive: true, force: true } )
    } )


    it( 'AC: read() returns { projectPrefix: "MEMO", found: true } when config.json exists', async () => {
        const filePath = join( memoDir, 'config.json' )
        await writeFile( filePath, JSON.stringify( { projectPrefix: 'MEMO' } ) )

        const result = await MemoConfig.read( { memoDir } )
        expect( result ).toEqual( { projectPrefix: 'MEMO', found: true } )
    } )


    it( 'AC: read() returns { projectPrefix: null, found: false } and does NOT write when file is absent', async () => {
        const result = await MemoConfig.read( { memoDir } )
        expect( result ).toEqual( { projectPrefix: null, found: false } )

        const { found } = await MemoConfig.has( { memoDir } )
        expect( found ).toBe( false )
    } )


    it( 'read() is graceful on malformed JSON -> { projectPrefix: null, found: true }', async () => {
        const filePath = join( memoDir, 'config.json' )
        await writeFile( filePath, '{ not valid json' )

        const result = await MemoConfig.read( { memoDir } )
        expect( result ).toEqual( { projectPrefix: null, found: true } )
    } )


    it( 'has() reports presence/absence of config.json', async () => {
        const absent = await MemoConfig.has( { memoDir } )
        expect( absent ).toEqual( { found: false } )

        await writeFile( join( memoDir, 'config.json' ), JSON.stringify( { projectPrefix: 'MEMO' } ) )
        const present = await MemoConfig.has( { memoDir } )
        expect( present ).toEqual( { found: true } )
    } )


    it( 'AC: init() writes config.json when absent -> { written: true }', async () => {
        const result = await MemoConfig.init( { memoDir, projectPrefix: 'MEMO' } )
        expect( result ).toEqual( { written: true } )

        const raw = await readFile( join( memoDir, 'config.json' ), 'utf8' )
        const parsed = JSON.parse( raw )
        expect( parsed ).toEqual( { projectPrefix: 'MEMO' } )
    } )


    it( 'AC: init() NO-OVERWRITE — existing config.json is never clobbered -> { written: false, reason: "exists" }', async () => {
        const filePath = join( memoDir, 'config.json' )
        const original = JSON.stringify( { projectPrefix: 'KEEP_ME' } )
        await writeFile( filePath, original )

        const result = await MemoConfig.init( { memoDir, projectPrefix: 'OVERWRITE_ATTEMPT' } )
        expect( result ).toEqual( { written: false, reason: 'exists' } )

        const after = await readFile( filePath, 'utf8' )
        expect( after ).toBe( original )
    } )
} )
