import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AnnotationStore } from '../../src/AnnotationStore.mjs'
import { MemoView } from '../../src/MemoView.mjs'


// PRD-005 (Memo 076 Phase 3, WI-115/116/122/123/124/127/128/129): the AnnotationStore anchor schema gains
// a `sourceLine` (1-based markdown line, server-computed) in BOTH anchor branches, the server-side line
// search (MemoView.computeSourceLine — pure) mirrors the client anchor resolution, and the missing-revision
// validation message is precise. append-only semantics are untouched (sourceLine is set at create only).
describe( 'Memo 076 PRD-005 — AnnotationStore.normalizeAnchor carries sourceLine', () => {
    let memoDir = ''


    beforeEach( async () => {
        memoDir = await mkdtemp( join( tmpdir(), 'memo-anm-sl-' ) )
    } )


    afterEach( async () => {
        if( memoDir.length > 0 ) {
            await rm( memoDir, { recursive: true, force: true } )
        }
    } )


    it( 'persists sourceLine on a text-quote anchor', async () => {
        const anchor = { type: 'text-quote', exact: 'Trajectory', prefix: '', suffix: '', chapterSlug: '3-t', sourceLine: 42 }
        const result = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor, comment: 'x', memoDir } )

        expect( result.status ).toBe( true )
        expect( result.annotation.anchor.sourceLine ).toBe( 42 )

        const record = JSON.parse( await readFile( result.path, 'utf-8' ) )
        expect( record.anchor.sourceLine ).toBe( 42 )
    } )


    it( 'persists sourceLine on a table-row anchor', async () => {
        const anchor = { type: 'table-row', rowKey: 'WI-013', rowText: 'WI-013 row', tableLabel: 'Work-Items', chapterSlug: '4-t', sourceLine: 7 }
        const result = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor, comment: 'x', memoDir } )

        expect( result.annotation.anchor.sourceLine ).toBe( 7 )
    } )


    it( 'defaults sourceLine to null (no silent default) when absent or non-integer', async () => {
        const noLine = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: { type: 'text-quote', exact: 'A' }, comment: 'x', memoDir } )
        expect( noLine.annotation.anchor.sourceLine ).toBe( null )

        const badLine = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: { type: 'text-quote', exact: 'B', sourceLine: '5' }, comment: 'x', memoDir } )
        expect( badLine.annotation.anchor.sourceLine ).toBe( null )
    } )


    it( 'gives a precise revisionId message when the open file is not a revision (WI-127)', async () => {
        const result = await AnnotationStore.create( { documentId: 'doc-1', revisionId: '', anchor: { type: 'text-quote', exact: 'A' }, comment: 'x', memoDir } )

        expect( result.status ).toBe( false )
        expect( result.messages.some( ( m ) => m.includes( 'not a revision (REV-NN)' ) ) ).toBe( true )
    } )
} )


describe( 'Memo 076 PRD-005 — MemoView.computeSourceLine (pure line search)', () => {
    const md = [
        '# Titel',                 // 1
        '',                        // 2
        '## Kapitel',              // 3
        'Ein Wort kommt hier vor.',// 4
        'und Wort noch einmal.',   // 5
        '',                        // 6
        '| WI-012 | Symptom |',    // 7
        '| C++    | legit   |'     // 8
    ].join( '\n' )


    it( 'returns the 1-based line for a text-quote exact match', () => {
        const out = MemoView.computeSourceLine( { content: md, anchor: { type: 'text-quote', exact: 'kommt hier' } } )
        expect( out.sourceLine ).toBe( 4 )
    } )


    it( 'disambiguates multiple exact matches by prefix/suffix (not the first)', () => {
        // "Wort" is on line 4 and line 5; suffix "noch" only follows the line-5 occurrence.
        const out = MemoView.computeSourceLine( { content: md, anchor: { type: 'text-quote', exact: 'Wort', prefix: 'und', suffix: 'noch' } } )
        expect( out.sourceLine ).toBe( 5 )
    } )


    it( 'falls back to the first occurrence without prefix/suffix', () => {
        const out = MemoView.computeSourceLine( { content: md, anchor: { type: 'text-quote', exact: 'Wort' } } )
        expect( out.sourceLine ).toBe( 4 )
    } )


    it( 'finds a table-row line by rowKey', () => {
        const out = MemoView.computeSourceLine( { content: md, anchor: { type: 'table-row', rowKey: 'WI-012' } } )
        expect( out.sourceLine ).toBe( 7 )
    } )


    it( 'finds a table-row line by a rowText fragment when rowKey is absent', () => {
        const out = MemoView.computeSourceLine( { content: md, anchor: { type: 'table-row', rowKey: null, rowText: 'C++ legit' } } )
        expect( out.sourceLine ).toBe( 8 )
    } )


    it( 'returns null for null content, empty content, or no match', () => {
        expect( MemoView.computeSourceLine( { content: null, anchor: { type: 'text-quote', exact: 'A' } } ).sourceLine ).toBe( null )
        expect( MemoView.computeSourceLine( { content: '', anchor: { type: 'text-quote', exact: 'A' } } ).sourceLine ).toBe( null )
        expect( MemoView.computeSourceLine( { content: md, anchor: { type: 'text-quote', exact: 'nichtdrin' } } ).sourceLine ).toBe( null )
    } )
} )
