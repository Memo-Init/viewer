import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-018 (Memo 072 Kap 13, F10=A): the deterministic Block↔Topic UI reads the STORE, not fences.
// This suite covers the server-side store reader (resolveMemoDir + readTopicStore — the data the new
// /api/documents/<id>/topics route emits) functionally against a temp fixture, plus the client-side
// shape assertions (collapsible tables default OPEN, wiki-links, chapter topic-pille) mirroring how
// the other client-pipeline tests assert app.client.mjs by source shape (no jsdom in this suite).
const clientSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )
const serverSource = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
const cssSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.css', import.meta.url ) ), 'utf8' )


describe( 'Memo 072 PRD-018 — Topic/Block store reader (route data source)', () => {
    let root = ''


    beforeAll( async () => {
        root = await mkdtemp( join( tmpdir(), 'memo-topicstore-' ) )
    } )


    afterAll( async () => {
        if( root.length > 0 ) {
            await rm( root, { recursive: true, force: true } )
        }
    } )


    // Build a memo dir with a canonical topic, an ARCHIVED topic version (must be excluded), and a
    // block, mirroring the real .memo/memos/<id>/{_topics,blocks} layout.
    async function writeFixtureMemo( { name } ) {
        const memoDir = join( root, name )
        await mkdir( join( memoDir, '_topics' ), { recursive: true } )
        await mkdir( join( memoDir, 'blocks', 'B001' ), { recursive: true } )

        const t001 = {
            id: 'T001',
            title: 'Block-UI deterministisch',
            status: 'registered',
            blockId: 'B001',
            chapter: '13. Block-UI deterministisch',
            workItemIds: [ 'WI-001', 'WI-002' ],
            researchFile: 'context/T013-block-ui-research.md',
            dependsOn: [ 'T002' ]
        }
        await writeFile( join( memoDir, '_topics', 'T001.json' ), JSON.stringify( t001, null, 4 ) + '\n', 'utf-8' )
        // an archived version — MUST be excluded from the read (only canonical <Tid>.json counts).
        await writeFile( join( memoDir, '_topics', 'T001.2026-07-13T16-58-01-788Z.json' ), JSON.stringify( { ...t001, chapter: null }, null, 4 ) + '\n', 'utf-8' )

        const block = { blockId: 'B001', memo: name, topicIds: [ 'T001' ], tags: [ 'root', 'spec-hygiene' ] }
        await writeFile( join( memoDir, 'blocks', 'B001', 'block.json' ), JSON.stringify( block, null, 4 ) + '\n', 'utf-8' )
        // an archived block version — must be ignored (block.<stamp>.json is not block.json).
        await writeFile( join( memoDir, 'blocks', 'B001', 'block.2026-07-13T16-59-40-982Z.json' ), JSON.stringify( { ...block, tags: [] }, null, 4 ) + '\n', 'utf-8' )

        return memoDir
    }


    describe( 'resolveMemoDir — memoPath -> memo directory', () => {
        it( 'returns the memoPath itself when it already points at the memo dir', () => {
            const out = MemoView.resolveMemoDir( { memoPath: '/x/.memo/memos/072-foo' } )

            expect( out.status ).toBe( true )
            expect( out.memoDir ).toBe( '/x/.memo/memos/072-foo' )
        } )


        it( 'ascends to the memo dir when the memoPath points at revisions/', () => {
            const out = MemoView.resolveMemoDir( { memoPath: '/x/.memo/memos/072-foo/revisions' } )

            expect( out.status ).toBe( true )
            expect( out.memoDir ).toBe( '/x/.memo/memos/072-foo' )
        } )


        it( 'fails loudly on a missing/empty memoPath (no silent guess)', () => {
            expect( MemoView.resolveMemoDir( { memoPath: '' } ).status ).toBe( false )
            expect( MemoView.resolveMemoDir( { memoPath: undefined } ).status ).toBe( false )
        } )
    } )


    describe( 'readTopicStore — canonical topics + blocks, chapter field carried', () => {
        it( 'reads the canonical topic (with chapter/blockId/workItemIds) and excludes archived versions', async () => {
            const memoDir = await writeFixtureMemo( { name: '072-foo' } )
            const store = await MemoView.readTopicStore( { memoDir } )

            // exactly ONE topic (the archived T001.<stamp>.json is excluded)
            expect( store.topics ).toHaveLength( 1 )
            const t = store.topics[ 0 ]
            expect( t.id ).toBe( 'T001' )
            expect( t.chapter ).toBe( '13. Block-UI deterministisch' )
            expect( t.blockId ).toBe( 'B001' )
            expect( t.workItemIds ).toEqual( [ 'WI-001', 'WI-002' ] )
            expect( t.researchFile ).toBe( 'context/T013-block-ui-research.md' )
            expect( t.dependsOn ).toEqual( [ 'T002' ] )
        } )


        it( 'reads the canonical block.json (topicIds + tags), ignoring archived block versions', async () => {
            const memoDir = await writeFixtureMemo( { name: '072-bar' } )
            const store = await MemoView.readTopicStore( { memoDir } )

            expect( store.blocks ).toHaveLength( 1 )
            const b = store.blocks[ 0 ]
            expect( b.blockId ).toBe( 'B001' )
            expect( b.topicIds ).toEqual( [ 'T001' ] )
            // the canonical block has both tags; the archived (empty-tags) version must not win.
            expect( b.tags ).toEqual( [ 'root', 'spec-hygiene' ] )
        } )


        it( 'yields the empty shape (not a throw) for a memo with no store', async () => {
            const empty = join( root, 'no-store-memo' )
            await mkdir( empty, { recursive: true } )
            const store = await MemoView.readTopicStore( { memoDir: empty } )

            expect( store ).toEqual( { topics: [], blocks: [] } )
        } )


        it( 'is empty-safe for a missing memoDir argument', async () => {
            expect( await MemoView.readTopicStore( { memoDir: '' } ) ).toEqual( { topics: [], blocks: [] } )
        } )
    } )
} )


describe( 'Memo 072 PRD-018 — server route wiring (/api/documents/<id>/topics)', () => {
    it( 'registers a /topics GET route BEFORE the generic /api/documents/<id> GET', () => {
        expect( serverSource ).toMatch( /url\.endsWith\(\s*'\/topics'\s*\)\s*&&\s*req\.method\s*===\s*'GET'/ )
        // the route reads the store, not fences: it calls readTopicStore
        expect( serverSource ).toMatch( /MemoView\.readTopicStore\(/ )
        // and it emits topics + blocks
        expect( serverSource ).toMatch( /'topics':\s*store\[\s*'topics'\s*\]/ )
        expect( serverSource ).toMatch( /'blocks':\s*store\[\s*'blocks'\s*\]/ )
    } )
} )


describe( 'Memo 072 PRD-018 — client shape (collapsible tables, wiki-links, chapter pille)', () => {
    it( 'wraps tables in <details class="table-collapsible"> with the OPEN default (F10=A)', () => {
        expect( clientSource ).toMatch( /details\.className\s*=\s*'table-collapsible'/ )
        // default OPEN — the reading flow stays intact; collapsing is a user action
        expect( clientSource ).toMatch( /details\.setAttribute\(\s*'open'\s*,\s*''\s*\)/ )
        expect( clientSource ).toMatch( /function wrapTablesCollapsible\(/ )
    } )


    it( 'CSS keeps the details OPEN by default and hides the native marker', () => {
        expect( cssSource ).toMatch( /\.table-collapsible\[open\]/ )
        expect( cssSource ).toMatch( /table-collapsible-summary/ )
    } )


    it( 'turns [[slug]] into a navigable wiki-link (not literal text)', () => {
        expect( clientSource ).toMatch( /function resolveWikiLinks\(/ )
        expect( clientSource ).toMatch( /a\.className\s*=\s*'wiki-link'/ )
        // navigation reuses the WS navigate channel (or an in-page scroll)
        expect( clientSource ).toMatch( /type:\s*'navigate'/ )
    } )


    it( 'injects the chapter topic-pille + cross-link line from the STORE route (not fences)', () => {
        expect( clientSource ).toMatch( /function applyTopicPillsFromStore\(/ )
        expect( clientSource ).toMatch( /\/api\/documents\/'\s*\+\s*encodeURIComponent\(\s*documentId\s*\)\s*\+\s*'\/topics'/ )
        expect( clientSource ).toMatch( /class="topic-pill"|'topic-pill'/ )
        expect( clientSource ).toMatch( /topic-crosslink-line/ )
        // the chapter mapping is deterministic (matchChapterHeading over the `chapter` field)
        expect( clientSource ).toMatch( /function matchChapterHeading\(/ )
    } )


    it( 'wires the pill injection into applyContentStructure', () => {
        expect( clientSource ).toMatch( /applyTopicPillsFromStore\(\s*currentDocumentId\s*\)/ )
    } )
} )
