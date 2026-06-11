import { describe, it, expect, beforeAll } from '@jest/globals'

import { extractFunctions, readMemoViewSource } from '../helpers/extractFunction.mjs'


// PRD-018 (Memo 002 REV-03 Kap 10): Transcript-Bereich Zweck schärfen. The sidebar history is
// sorted newest-first and the primary "Memo erstellen" path is hoisted; the pure helpers are
// lifted out and unit-tested. US-2 — recency sort + primary-type lift. No hard-delete (US-2/AC).
describe( 'PRD-018 Transcript sidebar focus', () => {
    let fns = {}


    beforeAll( async () => {
        fns = await extractFunctions( [
            'isPrimaryTranscriptType',
            'sortTranscriptEntries'
        ] )
    } )


    describe( 'isPrimaryTranscriptType', () => {
        it( 'marks memo-init as the primary type', () => {
            expect( fns.isPrimaryTranscriptType( 'memo-init' ) ).toBe( true )
        } )


        it( 'treats frei / revision / plan-start as nachrangig', () => {
            expect( fns.isPrimaryTranscriptType( 'frei' ) ).toBe( false )
            expect( fns.isPrimaryTranscriptType( 'revision' ) ).toBe( false )
            expect( fns.isPrimaryTranscriptType( 'plan-start' ) ).toBe( false )
        } )
    } )


    describe( 'sortTranscriptEntries — US-2 recency ordering', () => {
        it( 'orders by mtime descending', () => {
            const entries = [
                { transcriptId: 'a', mtime: '2026-06-01T10:00:00Z' },
                { transcriptId: 'b', mtime: '2026-06-11T10:00:00Z' },
                { transcriptId: 'c', mtime: '2026-06-05T10:00:00Z' }
            ]
            const out = fns.sortTranscriptEntries( entries )

            expect( out.map( ( e ) => e.transcriptId ) ).toEqual( [ 'b', 'c', 'a' ] )
        } )


        it( 'falls back to sequence descending when mtime is equal', () => {
            const entries = [
                { transcriptId: 'a', mtime: '2026-06-01T10:00:00Z', sequence: 1 },
                { transcriptId: 'b', mtime: '2026-06-01T10:00:00Z', sequence: 3 },
                { transcriptId: 'c', mtime: '2026-06-01T10:00:00Z', sequence: 2 }
            ]
            const out = fns.sortTranscriptEntries( entries )

            expect( out.map( ( e ) => e.transcriptId ) ).toEqual( [ 'b', 'c', 'a' ] )
        } )


        it( 'sorts entries without mtime stably after dated ones', () => {
            const entries = [
                { transcriptId: 'a' },
                { transcriptId: 'b', mtime: '2026-06-01T10:00:00Z' },
                { transcriptId: 'c' }
            ]
            const out = fns.sortTranscriptEntries( entries )

            expect( out.map( ( e ) => e.transcriptId ) ).toEqual( [ 'b', 'a', 'c' ] )
        } )


        it( 'copies the input (no in-place mutation, no data loss)', () => {
            const entries = [
                { transcriptId: 'a', mtime: '2026-06-01T10:00:00Z' },
                { transcriptId: 'b', mtime: '2026-06-11T10:00:00Z' }
            ]
            const out = fns.sortTranscriptEntries( entries )

            expect( out ).not.toBe( entries )
            expect( entries.map( ( e ) => e.transcriptId ) ).toEqual( [ 'a', 'b' ] )
            expect( out ).toHaveLength( entries.length )
        } )


        it( 'tolerates undefined input', () => {
            expect( fns.sortTranscriptEntries( undefined ) ).toEqual( [] )
        } )
    } )


    describe( 'source — primary affordance present, no delete in the sidebar render', () => {
        it( 'hoists a "Memo erstellen" affordance wired to openTranscriptModal', async () => {
            const source = await readMemoViewSource()
            const start = source.indexOf( 'async function renderSidebarTranscripts(' )
            const end = source.indexOf( 'async function loadTranscriptIntoContent(', start )
            const fnSource = source.slice( start, end )

            expect( fnSource.includes( 'transcript-sb-new' ) ).toBe( true )
            expect( fnSource.includes( '&#43; Memo erstellen' ) ).toBe( true )
            expect( fnSource.includes( 'openTranscriptModal' ) ).toBe( true )
            // US-2 / Out of Scope: the sidebar render adds no hard-delete affordance.
            expect( /delete/i.test( fnSource ) ).toBe( false )
        } )
    } )
} )
