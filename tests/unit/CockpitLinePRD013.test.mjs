import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { CockpitLine, INIT_DASHBOARD_AUTO } from '../../src/CockpitLine.mjs'


// PRD-013 (Memo 072, Phase 4, F6=A): the viewer's cockpit-line data source — VENDORED byte-identical in
// intent from core CockpitWatcher.render/readSnapshot, merged INTO the viewer (F6=A) instead of a second
// CockpitWatcher.serve() port. These tests exercise the pure render, the missing/corrupt-snapshot "—"
// fallback (readSnapshot semantics), the memo-local snapshot path, the whole resolveLine, and the
// documented InitDashboard non-auto decision (WI-T004-3).
describe( 'Memo 072 PRD-013 — CockpitLine (Cockpit-Zeile-Datenquelle)', () => {
    let root = ''


    beforeAll( async () => {
        root = await mkdtemp( join( tmpdir(), 'memo-cockpitline-' ) )
    } )


    afterAll( async () => {
        if( root.length > 0 ) {
            await rm( root, { recursive: true, force: true } )
        }
    } )


    async function writeSnapshot( { name, snapshot } ) {
        const memoDir = join( root, name )
        await mkdir( join( memoDir, 'rollout' ), { recursive: true } )
        await writeFile( join( memoDir, 'rollout', 'cockpit-snapshot.json' ), JSON.stringify( snapshot, null, 4 ) + '\n', 'utf-8' )

        return memoDir
    }


    // ---- render: PURE mapping snapshot -> { line, ...fields }. ----
    describe( 'render — reine Snapshot->Zeile-Abbildung', () => {
        it( 'renders a full snapshot into the line + fields (phase/pct carried)', () => {
            const now = '2026-07-13T12:00:12Z'
            const view = CockpitLine.render( {
                snapshot: { phase: 4, pct: 50, worker: 'prd-013', updatedAt: '2026-07-13T12:00:00Z' },
                now
            } )

            expect( view.phase ).toBe( '4' )
            expect( view.pct ).toBe( '50%' )
            expect( view.worker ).toBe( 'prd-013' )
            expect( view.budget ).toBe( 'ok' )
            expect( view.ageSec ).toBe( 12 )
            expect( view.line ).toBe( 'phase 4 • 50% • worker prd-013 • budget ok • age 12s' )
            // The acceptance line CARRIES Phase and Prozent (what #session-cockpit shows).
            expect( view.line ).toContain( 'phase 4' )
            expect( view.line ).toContain( '50%' )
        } )

        it( 'a null snapshot (missing) renders the "—" fallback fields, never a crash', () => {
            const view = CockpitLine.render( { snapshot: null, now: '2026-07-13T12:00:00Z' } )

            expect( view.phase ).toBe( '—' )
            expect( view.pct ).toBe( '—' )
            expect( view.worker ).toBe( 'idle' )
            expect( view.budget ).toBe( 'ok' )
            expect( view.ageSec ).toBeNull()
            expect( view.line ).toBe( 'phase — • — • worker idle • budget ok • age —' )
        } )

        it( 'a budget alarm surfaces ALARM(reason)', () => {
            const view = CockpitLine.render( {
                snapshot: { phase: 2, pct: 10, budget: { alarm: true, reason: 'week95' } },
                now: '2026-07-13T12:00:00Z'
            } )

            expect( view.budget ).toBe( 'ALARM(week95)' )
        } )

        it( 'ageSec is null when updatedAt or now is unparseable (no NaN leak)', () => {
            expect( CockpitLine.render( { snapshot: { phase: 1 }, now: 'nonsense' } ).ageSec ).toBeNull()
            expect( CockpitLine.render( { snapshot: { phase: 1, updatedAt: 'nope' }, now: '2026-07-13T12:00:00Z' } ).ageSec ).toBeNull()
        } )
    } )


    // ---- readSnapshot: missing/corrupt -> null (readSnapshot semantics). ----
    describe( 'readSnapshot — fehlend/korrupt -> null', () => {
        it( 'reads a present snapshot file into an object', async () => {
            const memoDir = await writeSnapshot( { name: 'rs-present', snapshot: { phase: 3, pct: 25 } } )
            const snap = await CockpitLine.readSnapshot( { path: resolve( memoDir, 'rollout', 'cockpit-snapshot.json' ) } )

            expect( snap ).toEqual( { phase: 3, pct: 25 } )
        } )

        it( 'a missing file yields null (not a throw)', async () => {
            const snap = await CockpitLine.readSnapshot( { path: join( root, 'does-not-exist', 'rollout', 'cockpit-snapshot.json' ) } )

            expect( snap ).toBeNull()
        } )

        it( 'a corrupt (non-JSON) file yields null (not a throw)', async () => {
            const memoDir = join( root, 'rs-corrupt' )
            await mkdir( join( memoDir, 'rollout' ), { recursive: true } )
            await writeFile( join( memoDir, 'rollout', 'cockpit-snapshot.json' ), '{ not json', 'utf-8' )
            const snap = await CockpitLine.readSnapshot( { path: resolve( memoDir, 'rollout', 'cockpit-snapshot.json' ) } )

            expect( snap ).toBeNull()
        } )
    } )


    // ---- snapshotPath: <memoDir>/rollout/cockpit-snapshot.json, No-Silent-Default. ----
    describe( 'snapshotPath — memo-lokaler Pfad', () => {
        it( 'builds <memoDir>/rollout/cockpit-snapshot.json', () => {
            const { path } = CockpitLine.snapshotPath( { memoDir: '/tmp/memo-072' } )

            expect( path ).toBe( resolve( '/tmp/memo-072', 'rollout', 'cockpit-snapshot.json' ) )
        } )

        it( 'a null/blank memoDir yields a null path (never guessed)', () => {
            expect( CockpitLine.snapshotPath( { memoDir: null } ).path ).toBeNull()
            expect( CockpitLine.snapshotPath( { memoDir: '' } ).path ).toBeNull()
        } )
    } )


    // ---- resolveLine: whole line for a memo dir; the /api/cockpit backing. ----
    describe( 'resolveLine — vollständige Zeile', () => {
        it( 'reads the memo-local snapshot and renders its line', async () => {
            const memoDir = await writeSnapshot( { name: 'rl-real', snapshot: { phase: 4, pct: 50, worker: 'prd-013' } } )
            const view = await CockpitLine.resolveLine( { memoDir, now: '2026-07-13T12:00:00Z' } )

            expect( view.phase ).toBe( '4' )
            expect( view.pct ).toBe( '50%' )
            expect( view.worker ).toBe( 'prd-013' )
            expect( view.line ).toContain( 'phase 4' )
            expect( view.line ).toContain( '50%' )
        } )

        it( 'no active memo (null memoDir) -> the "—" fallback line, no crash', async () => {
            const view = await CockpitLine.resolveLine( { memoDir: null, now: '2026-07-13T12:00:00Z' } )

            expect( view.line ).toBe( 'phase — • — • worker idle • budget ok • age —' )
        } )

        it( 'a memo with no snapshot file -> the SAME "—" fallback (idle == missing)', async () => {
            const memoDir = join( root, 'rl-nosnap' )
            await mkdir( memoDir, { recursive: true } )
            const view = await CockpitLine.resolveLine( { memoDir, now: '2026-07-13T12:00:00Z' } )

            expect( view.line ).toBe( 'phase — • — • worker idle • budget ok • age —' )
        } )
    } )


    // ---- WI-T004-3: InitDashboard non-auto decision, documented + testable. ----
    describe( 'INIT_DASHBOARD_AUTO — dokumentierter, testbarer Zustand (WI-T004-3)', () => {
        it( 'is a deliberate NON-auto decision (autoTrigger false), no silent intermediate state', () => {
            expect( INIT_DASHBOARD_AUTO.autoTrigger ).toBe( false )
        } )

        it( 'names the CORRECTED leaf `memo dashboard` (not `memo init dashboard`)', () => {
            expect( INIT_DASHBOARD_AUTO.leaf ).toBe( 'memo dashboard' )
            expect( INIT_DASHBOARD_AUTO.leaf ).not.toContain( 'init dashboard' )
        } )

        it( 'points the monitoring at the ONE merged viewer surface (session-head + cockpit)', () => {
            expect( INIT_DASHBOARD_AUTO.surface ).toContain( '/api/session' )
            expect( INIT_DASHBOARD_AUTO.surface ).toContain( '/api/cockpit' )
        } )
    } )
} )
