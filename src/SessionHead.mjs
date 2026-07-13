// SessionHead.mjs — PRD-012 (Memo 072, Phase 4, F6=A). The viewer's Session-Kopf data source.
//
// The memo-viewer becomes the INTERFACE that makes the RUNNING session visible (Memo 072 REV-03 Kap 3):
// the Session-Kopf shows Namespace + active Memo + Work-Mode + a session-health lamp. This module is the
// READ side of that head. It resolves the session-driven snapshot { namespace, activeMemo, workMode }
// from the ambient environment the harness exports (CLAUDE_MEMO = the active memo NUMBER) plus the
// memo-local append-only marker log (sessions.jsonl).
//
// Work-Mode: this MIRRORS core SessionMarkStore.deriveWorkMode (repos/core/cli/src/SessionMarkStore.mjs
// Z.38-41,112-128) — the SAME immutable append-only log, the SAME monotonic rule (a single `rollout`
// mark latches Rollout and never reverts; a Create-arc mark yields Create; an empty/absent log is an
// explicit null), and the SAME WORK_MODE enum values ('Create'/'Rollout'). The viewer only READS: the
// mode is a pure function of the log on every request, so this introduces NO new work-mode STATE
// (Memo 072 F6 Nicht-Ziel). The rule is kept in the viewer (not a cross-repo import of core) so the
// viewer stays a self-contained, standalone-testable repo; the intent is byte-identical to core.
//
// House style: static methods, object params/returns, no loops, NO SILENT DEFAULTS (a missing source is
// an explicit null — the client renders it as an em dash — never a guessed value, T003 #6 discipline).

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'


// Mirror of core SessionMarkStore (the Create arc = authoring events, the Rollout arc = the autonomous
// event) and its WORK_MODE enum. The union is what every mark is guarded against; the split is what the
// mode derivation reads to place a memo in a mode.
const CREATE_EVENTS = [ 'init', 'revision', 'finalize' ]
const ROLLOUT_EVENTS = [ 'rollout' ]
const WORK_MODE = { create: 'Create', rollout: 'Rollout' }

// The Session-Kopf Auto-Open opt-in flag (Memo 072 F6: Default AUS). The SessionStart path
// (~/.claude/hooks/sessionstart-register.sh) consults this contract; UNSET keeps the historic skip
// behaviour (no auto-start). Arming the hook path is PRD-014 (a user-gated settings.json diff) — NOTHING
// here writes settings.json or arms a hook.
const AUTO_OPEN_ENV = 'MEMO_VIEW_AUTO_OPEN'


class SessionHead {
    // Resolve the session-driven head { namespace, activeMemo, workMode }. Inputs are injected so the
    // resolver is unit-testable without the real environment or registry:
    //  - env: the ambient environment (process.env). CLAUDE_MEMO = the active memo NUMBER; a missing
    //    value stays an explicit null (rendered as an em dash by the client), never a guessed memo.
    //  - lookupMemoDir: async ({ activeMemo }) => ({ memoDir, namespace }) — maps the active memo number
    //    to its memo-local dir + project namespace (the viewer backs it with the DocumentRegistry; a test
    //    passes a fixture). No match -> { memoDir: null, namespace: null } (never a silent default).
    static async resolve( { env, lookupMemoDir } ) {
        const activeMemo = SessionHead.activeMemo( { env } )
        const located = activeMemo === null || typeof lookupMemoDir !== 'function'
            ? { memoDir: null, namespace: null }
            : await lookupMemoDir( { activeMemo } )

        const safe = located !== null && typeof located === 'object' ? located : {}
        const memoDir = typeof safe.memoDir === 'string' && safe.memoDir.length > 0 ? safe.memoDir : null
        const namespace = typeof safe.namespace === 'string' && safe.namespace.length > 0 ? safe.namespace : null
        const derived = memoDir === null ? { workMode: null } : await SessionHead.deriveWorkMode( { memoDir } )

        return { namespace, activeMemo, workMode: derived.workMode }
    }


    // The active memo NUMBER from the ambient env (CLAUDE_MEMO), or an explicit null when unset/blank —
    // never a guessed memo (T003 #6: the viewer reads neither CLAUDE_MEMO nor the work-mode today).
    static activeMemo( { env } ) {
        const environment = env !== null && typeof env === 'object' ? env : {}
        const raw = environment[ 'CLAUDE_MEMO' ]

        return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
    }


    // Derive the work-mode from the memo-local append-only marker log. PURE READ — mirrors core
    // SessionMarkStore.deriveWorkMode: a single `rollout` mark latches Rollout MONOTONICALLY (the log only
    // grows, no later append un-says it); absent any rollout mark a Create-arc mark (init/revision/
    // finalize) yields Create; an empty/absent log yields an explicit null (no mode established yet — the
    // client renders it as an em dash), never a guessed default.
    static async deriveWorkMode( { memoDir } ) {
        if( typeof memoDir !== 'string' || memoDir.length === 0 ) {
            return { status: false, workMode: null, messages: [ 'memoDir is required — the work-mode is read from the memo-local marker log, never defaulted' ] }
        }

        const { marks } = await SessionHead.readMarks( { memoDir } )
        const hasRollout = marks.some( ( mark ) => ROLLOUT_EVENTS.includes( mark.event ) === true )
        const hasCreate = marks.some( ( mark ) => CREATE_EVENTS.includes( mark.event ) === true )
        const workMode = hasRollout === true
            ? WORK_MODE.rollout
            : hasCreate === true ? WORK_MODE.create : null

        return { status: true, workMode, markCount: marks.length }
    }


    // Read the memo-local sessions.jsonl marker lines version-tolerantly. A missing file is NOT an error
    // (a memo without any mark yet is a valid empty state -> []); malformed lines are skipped, not fatal
    // (schema drift). Same read shape as core SessionMarkStore.readMarks.
    static async readMarks( { memoDir } ) {
        const path = resolve( memoDir, 'sessions.jsonl' )
        const raw = await readFile( path, 'utf-8' )
            .then( ( text ) => text )
            .catch( () => null )
        if( raw === null ) {
            return { marks: [], path }
        }

        const marks = raw
            .split( '\n' )
            .map( ( line ) => line.trim() )
            .filter( ( line ) => line.length > 0 )
            .map( ( line ) => SessionHead.#parseLine( { line } ) )
            .filter( ( parsed ) => parsed !== null )

        return { marks, path }
    }


    // The Auto-Open opt-in gate (Memo 072 F6: Default AUS). Returns enabled:true ONLY when the
    // MEMO_VIEW_AUTO_OPEN env flag is explicitly truthy (1/true/yes/on); absent — or anything else —
    // stays false. Pure: the SessionStart hook reads this contract to decide whether to auto-start the
    // viewer; NOTHING here writes settings.json or arms a hook (that is PRD-014, a user-gated diff).
    static autoOpenEnabled( { env } ) {
        const environment = env !== null && typeof env === 'object' ? env : {}
        const raw = environment[ AUTO_OPEN_ENV ]
        const enabled = typeof raw === 'string' && [ '1', 'true', 'yes', 'on' ].includes( raw.trim().toLowerCase() )

        return { enabled }
    }


    static #parseLine( { line } ) {
        try {
            return JSON.parse( line )
        } catch {
            return null
        }
    }
}


export { SessionHead, CREATE_EVENTS, ROLLOUT_EVENTS, WORK_MODE, AUTO_OPEN_ENV }
