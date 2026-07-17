import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-015 (Memo 076 Phase 8) — Turn-Zähler (WI-022) + idle-Status (WI-023). The pure statics are
// exercised directly; the F6 prehook (folder-validate.sh, WI-024/025/026) is a live hook and is
// self-tested with a stdin harness, not from Jest.
const here = dirname( fileURLToPath( import.meta.url ) )


describe( 'PRD-015 WI-022 — registerClient turnCount (tick vs no-tick)', () => {
    it( 'starts at 0 and stays 0 without a tick', () => {
        MemoView.registerClient( { sessionId: 'p8-tc-a', projectId: 'x' } )
        const first = MemoView.listClients( {} ).clients.find( ( c ) => c.sessionId === 'p8-tc-a' )
        expect( first.turnCount ).toBe( 0 )

        // a plain heartbeat (no tick) keeps the counter
        MemoView.registerClient( { sessionId: 'p8-tc-a', projectId: 'x' } )
        const second = MemoView.listClients( {} ).clients.find( ( c ) => c.sessionId === 'p8-tc-a' )
        expect( second.turnCount ).toBe( 0 )
    } )


    it( 'increments by exactly 1 per tick:true', () => {
        MemoView.registerClient( { sessionId: 'p8-tc-b', projectId: 'x', tick: true } )
        MemoView.registerClient( { sessionId: 'p8-tc-b', tick: true } )
        MemoView.registerClient( { sessionId: 'p8-tc-b', tick: true } )
        const rec = MemoView.listClients( {} ).clients.find( ( c ) => c.sessionId === 'p8-tc-b' )
        expect( rec.turnCount ).toBe( 3 )
    } )


    it( 'a tick restamps lastSeenAt AND keeps other fields (upsert)', () => {
        MemoView.registerClient( { sessionId: 'p8-tc-c', projectId: 'memo-init', workMode: 'Rollout' } )
        const before = MemoView.registerClient( { sessionId: 'p8-tc-c', tick: true } ).record
        expect( before.turnCount ).toBe( 1 )
        expect( before.projectId ).toBe( 'memo-init' )
        expect( before.workMode ).toBe( 'Rollout' )
        expect( typeof before.lastSeenAt ).toBe( 'number' )
    } )
} )


describe( 'PRD-015 WI-023 — deriveClientStatus idle branch + ordering', () => {
    const noOpen = new Set()

    it( 'turnCount < 10 (default threshold) -> idle', () => {
        const s = MemoView.deriveClientStatus( { lastSeenAt: 100, now: 200, ttlMs: 1000, armedTranscriptIds: [], openTranscriptIds: noOpen, turnCount: 9 } )
        expect( s.status ).toBe( 'idle' )
    } )


    it( 'turnCount === 10 (>= threshold) -> working (boundary)', () => {
        const s = MemoView.deriveClientStatus( { lastSeenAt: 100, now: 200, ttlMs: 1000, armedTranscriptIds: [], openTranscriptIds: noOpen, turnCount: 10 } )
        expect( s.status ).toBe( 'working' )
    } )


    it( 'stale still wins first even below the idle threshold', () => {
        const s = MemoView.deriveClientStatus( { lastSeenAt: 0, now: 999999, ttlMs: 1000, armedTranscriptIds: [], openTranscriptIds: noOpen, turnCount: 0 } )
        expect( s.status ).toBe( 'stale' )
    } )


    it( 'waiting-for-user-answer wins over idle (armed on open, few turns)', () => {
        const open = new Set( [ 'T-open' ] )
        const s = MemoView.deriveClientStatus( { lastSeenAt: 100, now: 200, ttlMs: 1000, armedTranscriptIds: [ 'T-open' ], openTranscriptIds: open, turnCount: 0 } )
        expect( s.status ).toBe( 'waiting-for-user-answer' )
    } )


    it( 'a custom idleThreshold is honoured', () => {
        const s = MemoView.deriveClientStatus( { lastSeenAt: 100, now: 200, ttlMs: 1000, armedTranscriptIds: [], openTranscriptIds: noOpen, turnCount: 3, idleThreshold: 3 } )
        expect( s.status ).toBe( 'working' )
    } )
} )


describe( 'PRD-015 WI-023 — listClients exposes turnCount + idle in the view model', () => {
    it( 'lists turnCount and derives idle for a fresh, unarmed client', () => {
        MemoView.registerClient( { sessionId: 'p8-idle', projectId: 'x' } )
        const mine = MemoView.listClients( {} ).clients.find( ( c ) => c.sessionId === 'p8-idle' )
        expect( mine.turnCount ).toBe( 0 )
        expect( mine.status ).toBe( 'idle' )
    } )


    it( 'flips idle -> working once turnCount reaches 10', () => {
        Array.from( { length: 10 } ).forEach( () => MemoView.registerClient( { sessionId: 'p8-flip', projectId: 'x', tick: true } ) )
        const mine = MemoView.listClients( {} ).clients.find( ( c ) => c.sessionId === 'p8-flip' )
        expect( mine.turnCount ).toBe( 10 )
        expect( mine.status ).toBe( 'working' )
    } )
} )


describe( 'PRD-015 — POST /api/clients passes tick through (source assertion)', () => {
    let server = ''

    beforeAll( async () => {
        server = await readFile( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
    } )


    it( 'wires parsed.tick into registerClient', () => {
        expect( server.includes( "'tick': parsed[ 'tick' ]" ) ).toBe( true )
    } )
} )
