import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionHead, WORK_MODE } from '../../src/SessionHead.mjs'


// PRD-012 (Memo 072, Phase 4, F6=A): the viewer's Session-Kopf data source. The Work-Mode is the CORE
// work-mode — SessionHead mirrors SessionMarkStore.deriveWorkMode over the memo-local sessions.jsonl
// (empty log -> null shown as "—", a Create-arc mark -> Create, a rollout mark -> Rollout, latched
// MONOTONICALLY). These tests exercise the derivation from real fixture logs, the env resolution of the
// active memo, the No-Silent-Default nulls, and the Default-AUS Auto-Open gate.
describe( 'Memo 072 PRD-012 — SessionHead (Session-Kopf-Datenquelle)', () => {
    let root = ''


    beforeAll( async () => {
        root = await mkdtemp( join( tmpdir(), 'memo-sessionhead-' ) )
    } )


    afterAll( async () => {
        if( root.length > 0 ) {
            await rm( root, { recursive: true, force: true } )
        }
    } )


    async function writeMarks( { name, lines } ) {
        const memoDir = join( root, name )
        await mkdir( memoDir, { recursive: true } )
        await writeFile( join( memoDir, 'sessions.jsonl' ), lines.join( '\n' ) + ( lines.length > 0 ? '\n' : '' ), 'utf-8' )

        return memoDir
    }


    // ---- deriveWorkMode: the three acceptance fixtures (rollout / create / empty). ----
    describe( 'deriveWorkMode — Mode aus dem Marker-Log', () => {
        it( 'a log with an event:"rollout" mark yields Mode: Rollout', async () => {
            const memoDir = await writeMarks( { name: 'wm-rollout', lines: [
                JSON.stringify( { sessionId: 's1', event: 'init', timestamp: '2026-07-13T10:00:00Z' } ),
                JSON.stringify( { sessionId: 's1', event: 'rollout', timestamp: '2026-07-13T11:00:00Z' } )
            ] } )
            const derived = await SessionHead.deriveWorkMode( { memoDir } )

            expect( derived.status ).toBe( true )
            expect( derived.workMode ).toBe( WORK_MODE.rollout )
            expect( derived.workMode ).toBe( 'Rollout' )
        } )

        it( 'a pure Create-arc log (init/revision/finalize, no rollout) yields Mode: Create', async () => {
            const memoDir = await writeMarks( { name: 'wm-create', lines: [
                JSON.stringify( { sessionId: 's1', event: 'init', timestamp: '2026-07-13T10:00:00Z' } ),
                JSON.stringify( { sessionId: 's1', event: 'revision', timestamp: '2026-07-13T10:30:00Z' } )
            ] } )
            const derived = await SessionHead.deriveWorkMode( { memoDir } )

            expect( derived.workMode ).toBe( WORK_MODE.create )
            expect( derived.workMode ).toBe( 'Create' )
        } )

        it( 'an empty log yields an explicit null mode (rendered as an em dash), never a guessed default', async () => {
            const memoDir = await writeMarks( { name: 'wm-empty', lines: [] } )
            const derived = await SessionHead.deriveWorkMode( { memoDir } )

            expect( derived.status ).toBe( true )
            expect( derived.workMode ).toBeNull()
        } )

        it( 'a missing sessions.jsonl is a valid empty state -> null mode (no crash)', async () => {
            const derived = await SessionHead.deriveWorkMode( { memoDir: join( root, 'does-not-exist' ) } )

            expect( derived.status ).toBe( true )
            expect( derived.workMode ).toBeNull()
        } )

        it( 'a rollout mark latches Rollout MONOTONICALLY — a later Create-arc append never reverts it', async () => {
            const memoDir = await writeMarks( { name: 'wm-latch', lines: [
                JSON.stringify( { sessionId: 's1', event: 'rollout', timestamp: '2026-07-13T11:00:00Z' } ),
                JSON.stringify( { sessionId: 's1', event: 'revision', timestamp: '2026-07-13T12:00:00Z' } )
            ] } )
            const derived = await SessionHead.deriveWorkMode( { memoDir } )

            expect( derived.workMode ).toBe( 'Rollout' )
        } )

        it( 'memoDir is required (no silent default)', async () => {
            const bad = await SessionHead.deriveWorkMode( { memoDir: '' } )

            expect( bad.status ).toBe( false )
            expect( bad.workMode ).toBeNull()
        } )
    } )


    // ---- readMarks: version-tolerant read, malformed lines skipped. ----
    describe( 'readMarks — versions-tolerant', () => {
        it( 'skips malformed JSON lines instead of throwing', async () => {
            const memoDir = await writeMarks( { name: 'rm-mixed', lines: [
                JSON.stringify( { sessionId: 's1', event: 'init' } ),
                'not-json-at-all',
                JSON.stringify( { sessionId: 's1', event: 'rollout' } )
            ] } )
            const { marks } = await SessionHead.readMarks( { memoDir } )

            expect( marks.length ).toBe( 2 )
            expect( marks.map( ( m ) => m.event ) ).toEqual( [ 'init', 'rollout' ] )
        } )
    } )


    // ---- activeMemo: the ambient CLAUDE_MEMO env, No-Silent-Default. ----
    describe( 'activeMemo — aus CLAUDE_MEMO', () => {
        it( 'reads the active memo number from CLAUDE_MEMO (trimmed)', () => {
            expect( SessionHead.activeMemo( { env: { CLAUDE_MEMO: ' 072 ' } } ) ).toBe( '072' )
        } )

        it( 'an unset/blank CLAUDE_MEMO resolves to an explicit null (never guessed)', () => {
            expect( SessionHead.activeMemo( { env: {} } ) ).toBeNull()
            expect( SessionHead.activeMemo( { env: { CLAUDE_MEMO: '' } } ) ).toBeNull()
            expect( SessionHead.activeMemo( { env: null } ) ).toBeNull()
        } )
    } )


    // ---- resolve: the whole head { namespace, activeMemo, workMode } via injected lookup. ----
    describe( 'resolve — vollständiger Session-Kopf', () => {
        it( 'resolves namespace + activeMemo + workMode from env and the injected memoDir lookup', async () => {
            const memoDir = await writeMarks( { name: 'resolve-rollout', lines: [
                JSON.stringify( { sessionId: 's1', event: 'rollout' } )
            ] } )
            const head = await SessionHead.resolve( {
                env: { CLAUDE_MEMO: '072' },
                lookupMemoDir: ( { activeMemo } ) => ( { memoDir, namespace: 'memo-init', activeMemo } )
            } )

            expect( head ).toEqual( { namespace: 'memo-init', activeMemo: '072', workMode: 'Rollout' } )
        } )

        it( 'no active memo (CLAUDE_MEMO unset) -> all fields null, lookup never called', async () => {
            const calls = []
            const head = await SessionHead.resolve( {
                env: {},
                lookupMemoDir: () => {
                    calls.push( 1 )

                    return { memoDir: null, namespace: null }
                }
            } )

            expect( calls.length ).toBe( 0 )
            expect( head ).toEqual( { namespace: null, activeMemo: null, workMode: null } )
        } )

        it( 'active memo set but no registry match -> activeMemo kept, namespace + workMode null', async () => {
            const head = await SessionHead.resolve( {
                env: { CLAUDE_MEMO: '999' },
                lookupMemoDir: () => ( { memoDir: null, namespace: null } )
            } )

            expect( head ).toEqual( { namespace: null, activeMemo: '999', workMode: null } )
        } )
    } )


    // ---- autoOpenEnabled: F6 Default AUS. ----
    describe( 'autoOpenEnabled — F6 Default AUS', () => {
        it( 'is Default AUS when MEMO_VIEW_AUTO_OPEN is unset', () => {
            expect( SessionHead.autoOpenEnabled( { env: {} } ).enabled ).toBe( false )
            expect( SessionHead.autoOpenEnabled( { env: null } ).enabled ).toBe( false )
        } )

        it( 'enables only on an explicit truthy flag (1/true/yes/on)', () => {
            expect( SessionHead.autoOpenEnabled( { env: { MEMO_VIEW_AUTO_OPEN: 'true' } } ).enabled ).toBe( true )
            expect( SessionHead.autoOpenEnabled( { env: { MEMO_VIEW_AUTO_OPEN: '1' } } ).enabled ).toBe( true )
            expect( SessionHead.autoOpenEnabled( { env: { MEMO_VIEW_AUTO_OPEN: 'off' } } ).enabled ).toBe( false )
            expect( SessionHead.autoOpenEnabled( { env: { MEMO_VIEW_AUTO_OPEN: 'nonsense' } } ).enabled ).toBe( false )
        } )
    } )
} )
