import { describe, it, expect } from '@jest/globals'

import { SessionHead } from '../../src/SessionHead.mjs'


// Memo 072 K1 (User-Intent-Audit): the memo-view server is a long-lived SHARED server started WITHOUT a
// per-session CLAUDE_MEMO, so the ambient-env-only resolution left the Session-Kopf rendering "—" in the
// real deployment — the exact "gebaut, aber unsichtbar" gap Memo 072 set out to close. resolveActiveMemo
// adds an env-INDEPENDENT channel: when CLAUDE_MEMO is unset, the active memo is the one carrying the
// FRESHEST session mark across the project's memos (the same sessions.jsonl the rollout writes). These
// tests pin that fallback + the No-Silent-Default null.
describe( 'Memo 072 K1 — SessionHead.resolveActiveMemo (env-independent active memo)', () => {

    it( 'prefers the ambient CLAUDE_MEMO when set (source: env)', async () => {
        const listMarkedMemos = async () => [ { activeMemo: '070', latestMarkAt: '2026-07-14T00:00:00.000Z' } ]
        const out = await SessionHead.resolveActiveMemo( { env: { CLAUDE_MEMO: '072' }, listMarkedMemos } )

        expect( out ).toEqual( { activeMemo: '072', source: 'env' } )
    } )


    it( 'falls back to the FRESHEST-marked memo when CLAUDE_MEMO is unset (source: mark)', async () => {
        const listMarkedMemos = async () => [
            { activeMemo: '070', latestMarkAt: '2026-07-13T08:00:00.000Z' },
            { activeMemo: '072', latestMarkAt: '2026-07-13T18:20:00.000Z' },
            { activeMemo: '071', latestMarkAt: '2026-07-13T09:00:00.000Z' }
        ]
        const out = await SessionHead.resolveActiveMemo( { env: {}, listMarkedMemos } )

        expect( out ).toEqual( { activeMemo: '072', source: 'mark' } )
    } )


    it( 'resolves to an explicit null when there is neither an env nor any mark (No-Silent-Default)', async () => {
        const emptyList = await SessionHead.resolveActiveMemo( { env: {}, listMarkedMemos: async () => [] } )
        const noList = await SessionHead.resolveActiveMemo( { env: {} } )

        expect( emptyList ).toEqual( { activeMemo: null, source: 'none' } )
        expect( noList ).toEqual( { activeMemo: null, source: 'none' } )
    } )


    it( 'ignores malformed mark entries (missing activeMemo / latestMarkAt)', async () => {
        const listMarkedMemos = async () => [
            null,
            { activeMemo: '', latestMarkAt: '2026-07-14T00:00:00.000Z' },
            { activeMemo: '072', latestMarkAt: '' },
            { activeMemo: '069', latestMarkAt: '2026-07-10T00:00:00.000Z' }
        ]
        const out = await SessionHead.resolveActiveMemo( { env: {}, listMarkedMemos } )

        expect( out ).toEqual( { activeMemo: '069', source: 'mark' } )
    } )
} )
