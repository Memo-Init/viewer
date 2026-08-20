import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AnnotationStore, ANM_TARGET_KINDS } from '../../src/AnnotationStore.mjs'


// Memo 079 PRD-24 (T059): the AnnotationStore is extended so an annotation can anchor into a served
// research MD (targetKind 'research', scoped by researchFile) instead of a discussed revision — reusing
// the identical ANM-NNN store and the line-based anchor. The existing revision path stays byte-identical.
describe( 'AnnotationStore research target — Memo 079 T059', () => {
    let memoDir = ''

    const lineAnchor = { type: 'text-quote', exact: 'DB-Direct-Read', prefix: '', suffix: '', sourceLine: 42 }


    beforeEach( async () => {
        memoDir = await mkdtemp( join( tmpdir(), 'memo-anm-research-' ) )
    } )

    afterEach( async () => {
        if( memoDir.length > 0 ) { await rm( memoDir, { recursive: true, force: true } ) }
    } )


    it( 'exports the two target kinds', () => {
        expect( ANM_TARGET_KINDS ).toEqual( [ 'revision', 'research' ] )
    } )


    it( 'creates a research annotation scoped by researchFile (revisionId optional)', async () => {
        const result = await AnnotationStore.create( {
            documentId: 'memo-init--079-x',
            targetKind: 'research',
            researchFile: 'context/research/2026-08-20--w3-viewer-deep.md',
            anchor: lineAnchor,
            comment: 'Karteileichen-Wurzel',
            memoDir
        } )

        expect( result.status ).toBe( true )
        expect( result.annotation.targetKind ).toBe( 'research' )
        expect( result.annotation.researchFile ).toBe( 'context/research/2026-08-20--w3-viewer-deep.md' )
        expect( result.annotation.revisionId ).toBeNull()
        expect( result.annotation.anchor.sourceLine ).toBe( 42 )
    } )


    it( 'rejects a research annotation without a researchFile', async () => {
        const result = await AnnotationStore.create( {
            documentId: 'memo-init--079-x',
            targetKind: 'research',
            anchor: lineAnchor,
            comment: 'x',
            memoDir
        } )

        expect( result.status ).toBe( false )
        expect( result.messages.join( ' ' ) ).toMatch( /researchFile/ )
    } )


    it( 'list filters by researchFile', async () => {
        await AnnotationStore.create( { documentId: 'd', targetKind: 'research', researchFile: 'a.md', anchor: lineAnchor, comment: 'A', memoDir } )
        await AnnotationStore.create( { documentId: 'd', targetKind: 'research', researchFile: 'b.md', anchor: lineAnchor, comment: 'B', memoDir } )

        const onlyA = await AnnotationStore.list( { memoDir, researchFile: 'a.md' } )
        expect( onlyA.annotations.length ).toBe( 1 )
        expect( onlyA.annotations[ 0 ].researchFile ).toBe( 'a.md' )

        const all = await AnnotationStore.list( { memoDir } )
        expect( all.annotations.length ).toBe( 2 )
    } )


    it( 'the revision path is unchanged: targetKind defaults to revision and requires revisionId', async () => {
        const ok = await AnnotationStore.create( { documentId: 'd', revisionId: 'REV-06', anchor: lineAnchor, comment: 'A', memoDir } )
        expect( ok.status ).toBe( true )
        expect( ok.annotation.targetKind ).toBe( 'revision' )
        expect( ok.annotation.researchFile ).toBeNull()

        const missingRev = await AnnotationStore.create( { documentId: 'd', anchor: lineAnchor, comment: 'A', memoDir } )
        expect( missingRev.status ).toBe( false )
        expect( missingRev.messages.join( ' ' ) ).toMatch( /revisionId/ )
    } )
} )
