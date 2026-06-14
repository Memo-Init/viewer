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
        const block = BlockMeta.parse( {
            doc: '## X\n```block-meta\n{ "topics": ["T012", "banana"], "prds": ["PRD-001", "X"] }\n```'
        } ).blocks[ 0 ]
        const { messages } = BlockMeta.validateShape( { block } )

        expect( messages.some( ( m ) => m.includes( 'banana' ) ) ).toBe( true )
        expect( messages.some( ( m ) => m.includes( '"X"' ) ) ).toBe( true )
    } )
} )


describe( 'BlockMeta Parent/Child + inheritance — Memo 013 Kap 3', () => {
    it( 'classifies a block with plural topics + prds + requirements as a parent', () => {
        const doc = [
            '## 3. Block-Struktur',
            '```block-meta',
            '{ "topics": ["T012"], "repos": ["repos/core"], "prds": ["PRD-001"], "requirements": ["req-secrets"] }',
            '```'
        ].join( '\n' )
        const { blocks } = BlockMeta.parse( { doc } )

        expect( blocks ).toHaveLength( 1 )
        expect( blocks[ 0 ].role ).toBe( 'parent' )
        expect( blocks[ 0 ].topics ).toEqual( [ 'T012' ] )
        expect( blocks[ 0 ].prds ).toEqual( [ 'PRD-001' ] )
        expect( blocks[ 0 ].requirements ).toEqual( [ 'req-secrets' ] )
        expect( BlockMeta.validateShape( { block: blocks[ 0 ] } ).messages ).toEqual( [] )
    } )

    it( 'classifies a block with singular topic + requirements+ (no prds) as a child', () => {
        const doc = [
            '## 3. Block-Struktur',
            '```block-meta',
            '{ "topic": "T012", "requirements+": ["req-coverage"] }',
            '```'
        ].join( '\n' )
        const { blocks } = BlockMeta.parse( { doc } )

        expect( blocks ).toHaveLength( 1 )
        expect( blocks[ 0 ].role ).toBe( 'child' )
        expect( blocks[ 0 ].topic ).toBe( 'T012' )
        expect( blocks[ 0 ].requirementsPlus ).toEqual( [ 'req-coverage' ] )
        expect( blocks[ 0 ].prds ).toEqual( [] )
        expect( BlockMeta.validateShape( { block: blocks[ 0 ] } ).messages ).toEqual( [] )
    } )

    it( 'effectiveRequirements unions parent requirements with child requirements+ (deduped)', () => {
        const parent = BlockMeta.parse( {
            doc: '## P\n```block-meta\n{ "topics": ["T012"], "requirements": ["req-secrets", "req-shared"] }\n```'
        } ).blocks[ 0 ]
        const child = BlockMeta.parse( {
            doc: '## C\n```block-meta\n{ "topic": "T012", "requirements+": ["req-shared", "req-coverage"] }\n```'
        } ).blocks[ 0 ]

        const { requirements } = BlockMeta.effectiveRequirements( { parent, child } )

        expect( requirements ).toEqual( [ 'req-secrets', 'req-shared', 'req-coverage' ] )
    } )

    it( 'effectiveRequirements falls back to parent-only when child has no requirements+', () => {
        const parent = BlockMeta.parse( {
            doc: '## P\n```block-meta\n{ "topics": ["T012"], "requirements": ["req-secrets"] }\n```'
        } ).blocks[ 0 ]
        const child = BlockMeta.parse( {
            doc: '## C\n```block-meta\n{ "topic": "T012" }\n```'
        } ).blocks[ 0 ]

        const { requirements } = BlockMeta.effectiveRequirements( { parent, child } )

        expect( requirements ).toEqual( [ 'req-secrets' ] )
    } )

    it( 'validateShape flags a child that carries prds (PRDs belong to the parent)', () => {
        const child = BlockMeta.parse( {
            doc: '## C\n```block-meta\n{ "topic": "T012", "prds": ["PRD-002"] }\n```'
        } ).blocks[ 0 ]
        const { messages } = BlockMeta.validateShape( { block: child } )

        expect( messages.some( ( m ) => m.includes( 'must not carry prds' ) ) ).toBe( true )
    } )

    it( 'validateShape flags a block mixing singular topic with plural topics', () => {
        const mixed = BlockMeta.parse( {
            doc: '## C\n```block-meta\n{ "topic": "T012", "topics": ["T013"] }\n```'
        } ).blocks[ 0 ]
        const { messages } = BlockMeta.validateShape( { block: mixed } )

        expect( messages.some( ( m ) => m.includes( 'either parent or child' ) ) ).toBe( true )
    } )

    it( 'validateShape flags a grandchild reference (second level) on a child', () => {
        const grandchild = BlockMeta.parse( {
            doc: '## C\n```block-meta\n{ "topic": "T012", "children": [{ "topic": "T013" }] }\n```'
        } ).blocks[ 0 ]
        const { messages } = BlockMeta.validateShape( { block: grandchild } )

        expect( messages.some( ( m ) => m.includes( 'no grandchildren' ) ) ).toBe( true )
    } )

    it( 'validateShape flags a child declaring a parent-default requirements set (grandchild)', () => {
        const child = BlockMeta.parse( {
            doc: '## C\n```block-meta\n{ "topic": "T012", "requirements": ["req-x"] }\n```'
        } ).blocks[ 0 ]
        const { messages } = BlockMeta.validateShape( { block: child } )

        expect( messages.some( ( m ) => m.includes( 'no grandchildren' ) ) ).toBe( true )
    } )

    it( 'validateShape flags an invalid singular topic id on a child', () => {
        const child = BlockMeta.parse( {
            doc: '## C\n```block-meta\n{ "topic": "banana", "requirements+": ["req-x"] }\n```'
        } ).blocks[ 0 ]
        const { messages } = BlockMeta.validateShape( { block: child } )

        expect( messages.some( ( m ) => m.includes( 'banana' ) ) ).toBe( true )
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

    it( 'a child carrying prds trips MEMO-080 (blocking, not silent)', () => {
        const doc = '## 3. X\n```block-meta\n{ "topic": "T012", "prds": ["PRD-002"] }\n```\n'
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-080' ) && m.includes( 'must not carry prds' ) ) ).toBe( true )
    } )

    it( 'a grandchild reference trips MEMO-080 (blocking, not silent)', () => {
        const doc = '## 3. X\n```block-meta\n{ "topic": "T012", "children": [{ "topic": "T013" }] }\n```\n'
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-080' ) && m.includes( 'no grandchildren' ) ) ).toBe( true )
    } )

    it( 'a well-formed parent + child fence pair does not trip MEMO-080', () => {
        const doc = [
            '## 3. Block-Struktur',
            '```block-meta',
            '{ "topics": ["T012"], "repos": ["repos/core"], "prds": ["PRD-001"], "requirements": ["req-secrets"] }',
            '```',
            '',
            '```block-meta',
            '{ "topic": "T012", "requirements+": ["req-coverage"] }',
            '```'
        ].join( '\n' )
        const result = MemoValidator.validate( { doc } )

        expect( result[ 'messages' ].some( ( m ) => m.startsWith( 'MEMO-080' ) ) ).toBe( false )
    } )
} )
