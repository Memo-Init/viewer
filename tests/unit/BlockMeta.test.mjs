import { describe, it, expect } from '@jest/globals'

import { BlockMeta } from '../../src/BlockMeta.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'


describe( 'BlockMeta.parse — Memo 012 Kap 7 overlay', () => {
    it( 'returns an empty list for a doc with no block-meta fence (no false positives)', () => {
        const { blocks, errors } = BlockMeta.parse( { doc: '## Kontext\nprose only\n' } )

        expect( blocks ).toEqual( [] )
        expect( errors ).toEqual( [] )
    } )

    it( 'parses topics/repos/prds and associates the nearest preceding chapter', () => {
        const doc = [
            '## 8. Auto-Requirements',
            'prose',
            '```block-meta',
            '{ "topics": ["T012"], "repos": ["repos/core"], "prds": ["PRD-001"] }',
            '```'
        ].join( '\n' )
        const { blocks } = BlockMeta.parse( { doc } )

        expect( blocks ).toHaveLength( 1 )
        expect( blocks[ 0 ].topics ).toEqual( [ 'T012' ] )
        expect( blocks[ 0 ].repos ).toEqual( [ 'repos/core' ] )
        expect( blocks[ 0 ].prds ).toEqual( [ 'PRD-001' ] )
        expect( blocks[ 0 ].chapter ).toBe( '8. Auto-Requirements' )
    } )

    it( 'reports invalid JSON as an error entry, never throws', () => {
        const doc = '## X\n```block-meta\n{ not json }\n```'
        const { blocks, errors } = BlockMeta.parse( { doc } )

        expect( blocks ).toEqual( [] )
        expect( errors ).toHaveLength( 1 )
        expect( errors[ 0 ].reason ).toMatch( /invalid JSON/ )
    } )

    it( 'validateShape flags non-T topic ids and non-PRD prd ids', () => {
        const block = { topics: [ 'T012', 'banana' ], repos: [], prds: [ 'PRD-001', 'X' ], chapter: 'X' }
        const { messages } = BlockMeta.validateShape( { block } )

        expect( messages.some( ( m ) => m.includes( 'banana' ) ) ).toBe( true )
        expect( messages.some( ( m ) => m.includes( '"X"' ) ) ).toBe( true )
    } )
} )


describe( 'MemoValidator MEMO-080 — block-meta integration (memo lint SSOT)', () => {
    it( 'flags malformed block-meta JSON via MEMO-080', () => {
        const doc = '## Kontext\nk\n\n## 8. X\n```block-meta\n{ broken\n```\n'
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-080' ) ) ).toBe( true )
    } )

    it( 'flags bad ids inside an otherwise valid block-meta via MEMO-080', () => {
        const doc = '## 8. X\n```block-meta\n{ "topics": ["nope"], "prds": ["PRD-1"] }\n```\n'
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-080' ) ) ).toBe( true )
    } )

    it( 'a well-formed block-meta does not trip MEMO-080', () => {
        const doc = '## 8. X\n```block-meta\n{ "topics": ["T012"], "prds": ["PRD-001"] }\n```\n'
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-080' ) ) ).toBe( false )
    } )
} )
