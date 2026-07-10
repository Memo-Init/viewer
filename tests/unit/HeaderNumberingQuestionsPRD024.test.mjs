import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'


// Memo 067 PRD-024 — WI-6-08 (revision-number scan counts update revisions) and
// WI-6-09 (questions-json completeness across all blocks + shrink WARN viewer-lint).


function block( questions ) {
    return '```questions-json\n' + JSON.stringify( questions ) + '\n```'
}


function question( n, answered ) {
    return {
        'id': `F${ n }`,
        'title': `Frage ${ n }`,
        'hintergrund': 'ctx',
        'frage': `Frage ${ n }?`,
        'aiRecommendation': 'A',
        'typ': 'single',
        'options': [ { 'key': 'A', 'label': 'a', 'kind': 'option' }, { 'key': 'B', 'label': 'b', 'kind': 'option' } ],
        'answered': answered === true
    }
}


describe( 'WI-6-08 — #maxRevNumber counts every REV suffix form (update/consolidated)', () => {
    let memoDir
    let registry


    beforeEach( async () => {
        memoDir = await mkdtemp( join( tmpdir(), 'prd024-num-' ) )
        const { registry: reg } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        registry = reg
    } )


    afterEach( async () => {
        registry.shutdown()
        await rm( memoDir, { recursive: true, force: true } )
    } )


    async function discussedMax( fileNames ) {
        const revisionsDir = resolve( memoDir, 'revisions' )
        await mkdir( revisionsDir, { recursive: true } )
        await Promise.all(
            fileNames.map( ( name ) => writeFile( resolve( revisionsDir, name ), '# stub\n', 'utf-8' ) )
        )

        const result = await registry.addTranscript( {
            'projectId': 'memo-init',
            'memoId': '067-x',
            'revisionId': 'REV-01',
            'content': 'body',
            'memoPath': memoDir
        } )

        const written = await readFile( result[ 'absolutePath' ], 'utf-8' )
        const match = written.split( '\n' )[ 0 ].match( /— Revision REV-(\d+)/ )

        return match === null ? null : parseInt( match[ 1 ], 10 )
    }


    it( 'REV-01/02 + REV-0x-update → max 5 (not the pre-fix 2)', async () => {
        const max = await discussedMax( [ 'REV-01.md', 'REV-02.md', 'REV-03-update.md', 'REV-04-update.md', 'REV-05-update.md' ] )

        expect( max ).toBe( 5 )
    } )


    it( 'the real 067 fileset (up to REV-07.md) → max 7', async () => {
        const max = await discussedMax( [ 'REV-01.md', 'REV-02.md', 'REV-03-update.md', 'REV-04-update.md', 'REV-05-update.md', 'REV-06.md', 'REV-07.md' ] )

        expect( max ).toBe( 7 )
    } )


    it( 'ignores PREPARE-REV-*.md (no leading REV- prefix)', async () => {
        const max = await discussedMax( [ 'REV-01.md', 'REV-02.md', 'PREPARE-REV-09.md' ] )

        expect( max ).toBe( 2 )
    } )
} )


describe( 'WI-6-09 — parseQuestionJsonBlock reads ALL blocks (completeness)', () => {
    it( 'merges 17 questions spread across three questions-json blocks', () => {
        const doc = [
            block( [ 1, 2, 3, 4, 5 ].map( ( n ) => question( n ) ) ),
            block( [ 6, 7, 8, 9, 10 ].map( ( n ) => question( n ) ) ),
            block( [ 11, 12, 13, 14, 15, 16, 17 ].map( ( n ) => question( n ) ) )
        ].join( '\n\n' )

        const { questions, found } = DocumentRegistry.parseQuestionJsonBlock( { content: doc } )

        expect( found ).toBe( true )
        expect( questions.length ).toBe( 17 )
        expect( questions.map( ( q ) => q[ 'id' ] ) ).toContain( 'F17' )
    } )


    it( 'dedupes by id across blocks (later block wins per key)', () => {
        const doc = [
            block( [ 1, 2, 3 ].map( ( n ) => question( n ) ) ),
            block( [ 1, 2, 3, 4 ].map( ( n ) => question( n ) ) )
        ].join( '\n\n' )

        const { questions } = DocumentRegistry.parseQuestionJsonBlock( { content: doc } )

        expect( questions.length ).toBe( 4 )
    } )


    it( 'single block behaves exactly as before (found:true, count preserved)', () => {
        const { questions, found, error } = DocumentRegistry.parseQuestionJsonBlock( { content: block( [ question( 1 ), question( 2 ) ] ) } )

        expect( found ).toBe( true )
        expect( error ).toBe( null )
        expect( questions.length ).toBe( 2 )
    } )


    it( 'a single malformed block still yields found:false + error', () => {
        const { found, error, questions } = DocumentRegistry.parseQuestionJsonBlock( { content: '```questions-json\n{ broken ]\n```' } )

        expect( found ).toBe( false )
        expect( questions ).toEqual( [] )
        expect( typeof error ).toBe( 'string' )
    } )


    it( 'keeps valid blocks even when a later block is malformed', () => {
        const doc = [ block( [ question( 1 ), question( 2 ) ] ), '```questions-json\n{ broken ]\n```' ].join( '\n\n' )
        const { found, questions } = DocumentRegistry.parseQuestionJsonBlock( { content: doc } )

        expect( found ).toBe( true )
        expect( questions.length ).toBe( 2 )
    } )
} )


describe( 'WI-6-09 — checkQuestionContinuity viewer-lint (WARN-010)', () => {
    it( 'WARNs when the open set shrinks without matching answers', () => {
        const previous = block( [ 1, 2, 3, 4, 5 ].map( ( n ) => question( n ) ) )
        const current = block( [ 1, 2, 3 ].map( ( n ) => question( n ) ) )

        const { warnings } = MemoValidator.checkQuestionContinuity( { current, previous } )

        expect( warnings.length ).toBe( 1 )
        expect( warnings[ 0 ] ).toContain( 'WARN-010' )
    } )


    it( 'does NOT warn when the full open set is carried forward', () => {
        const previous = block( [ 1, 2, 3, 4, 5 ].map( ( n ) => question( n ) ) )
        const current = block( [ 1, 2, 3, 4, 5 ].map( ( n ) => question( n ) ) )

        const { warnings } = MemoValidator.checkQuestionContinuity( { current, previous } )

        expect( warnings.length ).toBe( 0 )
    } )


    it( 'does NOT warn when the shrink is covered by newly answered questions', () => {
        const previous = block( [ 1, 2, 3, 4, 5 ].map( ( n ) => question( n ) ) )
        const current = block( [ question( 1 ), question( 2 ), question( 3 ), question( 4, true ), question( 5, true ) ] )

        const { warnings } = MemoValidator.checkQuestionContinuity( { current, previous } )

        expect( warnings.length ).toBe( 0 )
    } )


    it( 'WARN-010 classifies as WARNING severity', () => {
        const { severity } = MemoValidator.classify( { code: 'WARN-010' } )

        expect( severity ).toBe( 'WARNING' )
    } )
} )
