import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, rm, readdir, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AnnotationStore, ANM_ID_PATTERN } from '../../src/AnnotationStore.mjs'


// PRD-P3-04 (Memo 075 Phase 3, WI-012/013): the AnnotationStore mirrors WorkItemStore — memo-scoped
// ANM-NNN.json under <memoDir>/_annotations, id = max+1 padStart(3) (NO reuse), NO-OVERWRITE, and a
// broken file is dropped rather than crashing the read. This suite exercises the public behaviour.
describe( 'Memo 075 PRD-P3-04 — AnnotationStore', () => {
    let memoDir = ''


    beforeEach( async () => {
        memoDir = await mkdtemp( join( tmpdir(), 'memo-anm-' ) )
    } )


    afterEach( async () => {
        if( memoDir.length > 0 ) {
            await rm( memoDir, { recursive: true, force: true } )
        }
    } )


    const textAnchor = { type: 'text-quote', exact: 'Trajectory', prefix: '', suffix: '', chapterSlug: '3-trajectory' }


    it( 'assigns ANM-001 for the first annotation and writes the file', async () => {
        const result = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'Test', memoDir } )

        expect( result.status ).toBe( true )
        expect( result.id ).toBe( 'ANM-001' )
        expect( ANM_ID_PATTERN.test( result.id ) ).toBe( true )

        const files = await readdir( join( memoDir, '_annotations' ) )
        expect( files ).toContain( 'ANM-001.json' )
    } )


    it( 'increments max+1 (ANM-002) — no reuse', async () => {
        const first = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'A', memoDir } )
        const second = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'B', memoDir } )

        expect( first.id ).toBe( 'ANM-001' )
        expect( second.id ).toBe( 'ANM-002' )
    } )


    it( 'persists the canonical record shape { id, documentId, revisionId, anchor, comment, anmStatus, createdAt }', async () => {
        const result = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'Hallo', memoDir } )
        const raw = await readFile( result.path, 'utf-8' )
        const record = JSON.parse( raw )

        expect( record.id ).toBe( 'ANM-001' )
        expect( record.documentId ).toBe( 'doc-1' )
        expect( record.revisionId ).toBe( 'REV-06' )
        expect( record.anchor.type ).toBe( 'text-quote' )
        expect( record.anchor.exact ).toBe( 'Trajectory' )
        expect( record.comment ).toBe( 'Hallo' )
        expect( record.anmStatus ).toBe( 'offen' )
        expect( typeof record.createdAt ).toBe( 'string' )
    } )


    it( 'accepts a table-row anchor with a rowKey', async () => {
        const anchor = { type: 'table-row', rowKey: 'WI-013', rowText: 'WI-013 Tabellenzeile', tableLabel: 'Work-Items', chapterSlug: '4-tabellen' }
        const result = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor, comment: 'Zeilenkommentar', memoDir } )

        expect( result.status ).toBe( true )
        expect( result.annotation.anchor.type ).toBe( 'table-row' )
        expect( result.annotation.anchor.rowKey ).toBe( 'WI-013' )
    } )


    it( 'lists annotations and filters by revisionId', async () => {
        await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'A', memoDir } )
        await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-05', anchor: textAnchor, comment: 'B', memoDir } )

        const all = await AnnotationStore.list( { memoDir } )
        expect( all.annotations.length ).toBe( 2 )

        const only6 = await AnnotationStore.list( { memoDir, revisionId: 'REV-06' } )
        expect( only6.annotations.length ).toBe( 1 )
        expect( only6.annotations[ 0 ].revisionId ).toBe( 'REV-06' )
    } )


    it( 'get returns a stored annotation and rejects a bad id', async () => {
        await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'A', memoDir } )

        const good = await AnnotationStore.get( { id: 'ANM-001', memoDir } )
        expect( good.status ).toBe( true )
        expect( good.annotation.id ).toBe( 'ANM-001' )

        const bad = await AnnotationStore.get( { id: '../evil', memoDir } )
        expect( bad.status ).toBe( false )
    } )


    it( 'rejects a missing comment / missing anchor / bad anchor type', async () => {
        const noComment = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: '  ', memoDir } )
        expect( noComment.status ).toBe( false )

        const noAnchor = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: null, comment: 'x', memoDir } )
        expect( noAnchor.status ).toBe( false )

        const badType = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: { type: 'nope', exact: 'x' }, comment: 'x', memoDir } )
        expect( badType.status ).toBe( false )
    } )


    it( 'requires a memoDir (memo-scoped, never project-global)', async () => {
        const result = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'x', memoDir: '' } )
        expect( result.status ).toBe( false )
    } )


    it( 'drops a broken JSON file instead of crashing the list', async () => {
        await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'A', memoDir } )
        await mkdir( join( memoDir, '_annotations' ), { recursive: true } )
        await writeFile( join( memoDir, '_annotations', 'ANM-999.json' ), '{ not json', 'utf-8' )

        const listed = await AnnotationStore.list( { memoDir } )
        expect( listed.status ).toBe( true )
        // Only the valid ANM-001 survives; the broken ANM-999 is dropped.
        expect( listed.annotations.map( ( a ) => a.id ) ).toEqual( [ 'ANM-001' ] )
    } )


    it( 'ignores archived ANM-NNN.<stamp>.json versions in nextId + list (NO-OVERWRITE parity)', async () => {
        await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'A', memoDir } )
        // Simulate an archived version file — must not count as ANM-001 nor bump the next id.
        await writeFile( join( memoDir, '_annotations', 'ANM-001.2026-07-16T00-00-00-000Z.json' ), JSON.stringify( { id: 'ANM-001' } ), 'utf-8' )

        const next = await AnnotationStore.create( { documentId: 'doc-1', revisionId: 'REV-06', anchor: textAnchor, comment: 'B', memoDir } )
        expect( next.id ).toBe( 'ANM-002' )

        const listed = await AnnotationStore.list( { memoDir } )
        expect( listed.annotations.map( ( a ) => a.id ).sort() ).toEqual( [ 'ANM-001', 'ANM-002' ] )
    } )
} )
