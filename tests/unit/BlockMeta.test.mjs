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


describe( 'BlockMeta PRD-008 — id (B-id), tags, body sections, no strand', () => {
    const FULL_BLOCK = [
        '## 6. Block-Struktur',
        'prose intro',
        '```block-meta',
        '{ "id": "B001", "topics": ["T014"], "repos": ["repos/core"], "tags": ["nodejs", "outward-facing"], "prds": ["PRD-008"] }',
        '```',
        '',
        '### Problem-Beschreibung',
        'The block format lacks an id and tags.',
        'Second problem line.',
        '',
        '### Loesungsansatz',
        'Add B-id, tags and three body sections.',
        '',
        '### Offene Fragen',
        'How do tags feed auto-requirements?',
        ''
    ].join( '\n' )

    it( 'parses id, tags, factualAccount (via alias), solution, openQuestions for a full block', () => {
        const { blocks } = BlockMeta.parse( { doc: FULL_BLOCK } )

        expect( blocks ).toHaveLength( 1 )
        const block = blocks[ 0 ]
        expect( block.id ).toBe( 'B001' )
        expect( block.tags ).toEqual( [ 'nodejs', 'outward-facing' ] )
        // "### Problem-Beschreibung" is the legacy alias for factualAccount (PRD-003 Memo 054 Kap 6)
        expect( block.factualAccount ).toBe( 'The block format lacks an id and tags.\nSecond problem line.' )
        expect( block.problem ).toBeUndefined()
        expect( block.assessment ).toBeNull()
        expect( block.solution ).toBe( 'Add B-id, tags and three body sections.' )
        expect( block.openQuestions ).toBe( 'How do tags feed auto-requirements?' )
    } )

    it( 'validateShape accepts a valid B-id and flags a non-B block id', () => {
        const valid = BlockMeta.parse( {
            doc: '## X\n```block-meta\n{ "id": "B001", "topics": ["T014"] }\n```'
        } ).blocks[ 0 ]
        expect( BlockMeta.validateShape( { block: valid } ).messages ).toEqual( [] )

        const bad = BlockMeta.parse( {
            doc: '## X\n```block-meta\n{ "id": "BX1", "topics": ["T014"] }\n```'
        } ).blocks[ 0 ]
        const { messages } = BlockMeta.validateShape( { block: bad } )
        expect( messages.some( ( m ) => m.includes( 'is not a B-id' ) ) ).toBe( true )
    } )

    it( 'a block with NO id stays valid (additive — id is optional)', () => {
        const block = BlockMeta.parse( {
            doc: '## X\n```block-meta\n{ "topics": ["T014"], "tags": ["nodejs"] }\n```'
        } ).blocks[ 0 ]

        expect( block.id ).toBeNull()
        expect( BlockMeta.validateShape( { block } ).messages ).toEqual( [] )
    } )

    it( 'F18=B: tags are parsed at block level; missing tags yield an empty array', () => {
        const tagged = BlockMeta.parse( {
            doc: '## X\n```block-meta\n{ "topics": ["T014"], "tags": ["nodejs"] }\n```'
        } ).blocks[ 0 ]
        expect( tagged.tags ).toEqual( [ 'nodejs' ] )

        const untagged = BlockMeta.parse( {
            doc: '## X\n```block-meta\n{ "topics": ["T014"] }\n```'
        } ).blocks[ 0 ]
        expect( untagged.tags ).toEqual( [] )
    } )

    it( 'missing body sections yield null (no silent default)', () => {
        const block = BlockMeta.parse( {
            doc: '## X\n```block-meta\n{ "id": "B002", "topics": ["T014"] }\n```\n### Problem-Beschreibung\nonly a problem here.\n'
        } ).blocks[ 0 ]

        // "### Problem-Beschreibung" is the legacy alias — resolves to factualAccount
        expect( block.factualAccount ).toBe( 'only a problem here.' )
        expect( block.assessment ).toBeNull()
        expect( block.solution ).toBeNull()
        expect( block.openQuestions ).toBeNull()
    } )

    it( 'body sections are scoped to THIS block (a following ## chapter ends the region)', () => {
        const doc = [
            '## 6. First',
            '```block-meta',
            '{ "id": "B001", "topics": ["T014"] }',
            '```',
            '### Problem-Beschreibung',
            'first block problem.',
            '',
            '## 7. Second',
            '### Loesungsansatz',
            'this belongs to no block.'
        ].join( '\n' )
        const block = BlockMeta.parse( { doc } ).blocks[ 0 ]

        // "### Problem-Beschreibung" is the legacy alias — resolves to factualAccount
        expect( block.factualAccount ).toBe( 'first block problem.' )
        // the second chapter's ### Loesungsansatz must NOT leak into the first block
        expect( block.solution ).toBeNull()
    } )

    it( 'a strand:"x" key is ignored — the parsed block exposes NO strand field', () => {
        const block = BlockMeta.parse( {
            doc: '## X\n```block-meta\n{ "id": "B001", "topics": ["T014"], "strand": "x" }\n```'
        } ).blocks[ 0 ]

        expect( Object.prototype.hasOwnProperty.call( block, 'strand' ) ).toBe( false )
        expect( block.strand ).toBeUndefined()
    } )
} )


describe( 'BlockMeta PRD-003 (Memo 054 Kap 6) — 4-section migration: factualAccount/assessment/solution/openQuestions', () => {
    it( 'parses all four canonical sections (### Faktenlage, ### Bewertung, ### Loesungsansatz, ### Offene Fragen)', () => {
        const doc = [
            '## 7. Neues Block-Format',
            '```block-meta',
            '{ "id": "B002", "topics": ["T054"], "prds": ["PRD-003"] }',
            '```',
            '',
            '### Faktenlage',
            'Der Ist-Zustand vor der Migration.',
            '',
            '### Bewertung',
            'Die Migration ist notwendig fuer die Konsistenz.',
            '',
            '### Loesungsansatz',
            'Sektionen umbenennen und Alias einbauen.',
            '',
            '### Offene Fragen',
            'Wie lange bleibt der Alias aktiv?',
            ''
        ].join( '\n' )
        const { blocks } = BlockMeta.parse( { doc } )

        expect( blocks ).toHaveLength( 1 )
        const block = blocks[ 0 ]
        expect( block.factualAccount ).toBe( 'Der Ist-Zustand vor der Migration.' )
        expect( block.assessment ).toBe( 'Die Migration ist notwendig fuer die Konsistenz.' )
        expect( block.solution ).toBe( 'Sektionen umbenennen und Alias einbauen.' )
        expect( block.openQuestions ).toBe( 'Wie lange bleibt der Alias aktiv?' )
    } )

    it( 'legacy "### Problem-Beschreibung" is accepted as factualAccount alias (additive, no hard break)', () => {
        const doc = [
            '## 8. Legacy-Memo',
            '```block-meta',
            '{ "id": "B003", "topics": ["T054"] }',
            '```',
            '',
            '### Problem-Beschreibung',
            'Das alte Problem.',
            '',
            '### Loesungsansatz',
            'Die alte Loesung.',
            ''
        ].join( '\n' )
        const { blocks } = BlockMeta.parse( { doc } )

        expect( blocks ).toHaveLength( 1 )
        const block = blocks[ 0 ]
        // alias maps to factualAccount — the `problem` field no longer exists
        expect( block.factualAccount ).toBe( 'Das alte Problem.' )
        expect( block.problem ).toBeUndefined()
        expect( block.assessment ).toBeNull()
        expect( block.solution ).toBe( 'Die alte Loesung.' )
    } )

    it( 'parsed block has no `problem` field — only factualAccount and assessment', () => {
        const doc = '## X\n```block-meta\n{ "topics": ["T054"] }\n```\n'
        const { blocks } = BlockMeta.parse( { doc } )
        const block = blocks[ 0 ]

        expect( Object.prototype.hasOwnProperty.call( block, 'factualAccount' ) ).toBe( true )
        expect( Object.prototype.hasOwnProperty.call( block, 'assessment' ) ).toBe( true )
        expect( Object.prototype.hasOwnProperty.call( block, 'problem' ) ).toBe( false )
    } )

    it( 'all four sections missing each yield null independently', () => {
        const doc = '## X\n```block-meta\n{ "topics": ["T054"] }\n```\n'
        const { blocks } = BlockMeta.parse( { doc } )
        const block = blocks[ 0 ]

        expect( block.factualAccount ).toBeNull()
        expect( block.assessment ).toBeNull()
        expect( block.solution ).toBeNull()
        expect( block.openQuestions ).toBeNull()
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
