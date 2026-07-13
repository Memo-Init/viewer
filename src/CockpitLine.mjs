// CockpitLine.mjs — PRD-013 (Memo 072, Phase 4, F6=A). The viewer's cockpit-line data source.
//
// Decision F6=A MERGES the cockpit INTO the memo-viewer instead of the separate CockpitWatcher.serve()
// loopback surface (repos/core/cli/src/CockpitWatcher.mjs:73) — ONE interface surface, no second port,
// no tunnel (this dissolves the T003 #10/#11 "Tunnel/Handy"-Sorge directly). This module VENDORS the two
// PURE pieces the viewer needs from CockpitWatcher — render() (snapshot -> { line, phase, pct, worker,
// budget, ageSec }) and readSnapshot() (a missing/corrupt file -> null so render shows "—") — BYTE-
// IDENTICAL IN INTENT to CockpitWatcher.render (Z.21) / readSnapshot (Z.56). It deliberately does NOT
// vendor serve()/watchFile(): the viewer never opens a second listener; the line is served on the
// viewer's OWN loopback :3333 via the /api/cockpit route. The only intentional trim vs. the core render
// is the tasks-mtime field — the viewer stats no tasks file, so it would always be null; the line string
// and every rendered field are identical. Keeping the logic in the viewer (not a cross-repo import of
// core) preserves the viewer as a self-contained, standalone-testable repo — the SAME posture
// SessionHead.mjs took (PRD-012).
//
// House style: static methods, object params/returns, no loops, NO SILENT DEFAULTS (a missing snapshot
// is an explicit "—", never a guessed value — the same discipline as CockpitWatcher and SessionHead).

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'


// WI-T004-3 — InitDashboard auto-behaviour as a DOCUMENTED, TESTABLE decision (no silent intermediate
// state). The `memo dashboard` leaf (repos/core/cli/src/InitDashboard.mjs, build/render — note the
// CORRECTED leaf name: it is `memo dashboard`, NOT `memo init dashboard`) is built but deliberately NOT
// auto-triggered by the viewer. F6=A folds the running-session monitoring into the ONE viewer surface —
// the Session-Kopf (PRD-012 /api/session) plus this cockpit line (/api/cockpit) — so a SECOND auto-run of
// the five-signal dashboard is NOT wired. The InitDashboard work-items that still read "offen" are a
// KNOWN cosmetic non-auto state, marked here rather than left as a silent gap. This object is exported so
// a test can assert the decision (autoTrigger === false, the corrected leaf name), not just prose.
const INIT_DASHBOARD_AUTO = {
    leaf: 'memo dashboard',
    autoTrigger: false,
    surface: 'viewer session-head (/api/session) + cockpit line (/api/cockpit)',
    reason: 'F6=A merges monitoring into the ONE viewer surface; the dashboard stays an explicit on-demand CLI leaf, and its "offen" work-items are a known cosmetic non-auto state (WI-T004-3), not a silent gap'
}


class CockpitLine {

    // render — PURE (vendored, byte-identical intent to CockpitWatcher.render Z.21). Maps a snapshot
    // (+ optional now ISO) onto a status object AND a one-line string. Deterministic: `now` is passed so
    // ageSec is reproducible (no clock read here). Every absent field degrades ("—" / 'idle' / 'ok')
    // instead of crashing — the No-Silent-Default fallback the merged surface shows for an idle session.
    static render( { snapshot, now } ) {
        const snap = ( snapshot !== null && typeof snapshot === 'object' ) ? snapshot : {}
        const phase = ( snap.phase !== undefined && snap.phase !== null ) ? String( snap.phase ) : '—'
        const pct = Number.isFinite( snap.pct ) ? `${ snap.pct }%` : '—'
        const worker = typeof snap.worker === 'string' ? snap.worker : 'idle'
        const budget = CockpitLine.#budget( { snapshot: snap } )
        const ageSec = CockpitLine.#ageSec( { updatedAt: snap.updatedAt, now } )
        const age = ageSec === null ? '—' : `${ ageSec }s`
        const line = `phase ${ phase } • ${ pct } • worker ${ worker } • budget ${ budget } • age ${ age }`

        return { line, phase, pct, worker, budget, ageSec }
    }


    static #budget( { snapshot } ) {
        const b = snapshot.budget
        if( b !== null && typeof b === 'object' && b.alarm === true ) {
            const reason = typeof b.reason === 'string' ? b.reason : 'unknown'

            return `ALARM(${ reason })`
        }

        return 'ok'
    }


    static #ageSec( { updatedAt, now } ) {
        if( typeof updatedAt !== 'string' || typeof now !== 'string' ) { return null }
        const t0 = Date.parse( updatedAt )
        const t1 = Date.parse( now )
        if( Number.isNaN( t0 ) === true || Number.isNaN( t1 ) === true ) { return null }

        return Math.max( 0, Math.round( ( t1 - t0 ) / 1000 ) )
    }


    // readSnapshot — vendored (byte-identical intent to CockpitWatcher.readSnapshot Z.56). Load + parse
    // the snapshot file; a missing OR corrupt file yields null so render shows "—" instead of crashing.
    static async readSnapshot( { path } ) {
        const raw = await readFile( path, 'utf8' ).catch( () => null )
        if( raw === null ) { return null }

        return CockpitLine.#parse( { raw } )
    }


    static #parse( { raw } ) {
        try {
            return JSON.parse( raw )
        } catch {
            return null
        }
    }


    // snapshotPath — the memo-local cockpit snapshot lives at <memoDir>/rollout/cockpit-snapshot.json,
    // the SAME path the core `memo cockpit write`/`memo cockpit watch` leaves use (command-tree.mjs
    // :4364/:4396). A null/blank memoDir (no active memo resolved) yields a null path — No-Silent-Default:
    // the route reads no file and renders the "—" fallback instead of guessing a path.
    static snapshotPath( { memoDir } ) {
        if( typeof memoDir !== 'string' || memoDir.length === 0 ) {
            return { path: null }
        }

        return { path: resolve( memoDir, 'rollout', 'cockpit-snapshot.json' ) }
    }


    // resolveLine — the whole cockpit line for a memo dir. A null/blank memoDir (no active memo) reads no
    // file and renders the "—" fallback line — the SAME shape a present-but-missing/corrupt snapshot
    // yields, so an idle viewer and a memo-without-snapshot look identical (both "—"), never a crash and
    // never a guessed value. This is what the /api/cockpit route calls.
    static async resolveLine( { memoDir, now } ) {
        const { path } = CockpitLine.snapshotPath( { memoDir } )
        const snapshot = path === null ? null : await CockpitLine.readSnapshot( { path } )

        return CockpitLine.render( { snapshot, now } )
    }
}


export { CockpitLine, INIT_DASHBOARD_AUTO }
