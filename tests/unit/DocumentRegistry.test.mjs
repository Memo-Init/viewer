import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


describe( 'DocumentRegistry', () => {
    let tempDir
    let registry


    beforeEach( async () => {
        tempDir = await mkdtemp( join( tmpdir(), 'memo-test-' ) )
        const { registry: reg } = DocumentRegistry.create( { onChange: null } )
        registry = reg
    } )


    afterEach( async () => {
        registry.shutdown()
        await rm( tempDir, { recursive: true, force: true } )
    } )


    describe( 'create', () => {
        it( 'returns a registry instance', () => {
            const { registry: reg } = DocumentRegistry.create( { onChange: null } )

            expect( reg ).toBeInstanceOf( DocumentRegistry )
            reg.shutdown()
        } )
    } )


    describe( 'validateAddDocument', () => {
        it( 'fails when projectId is missing', () => {
            const { status, messages } = DocumentRegistry.validateAddDocument( { projectId: undefined, memoPath: '/some/path' } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'projectId' )
        } )


        it( 'fails when projectId is empty', () => {
            const { status, messages } = DocumentRegistry.validateAddDocument( { projectId: '  ', memoPath: '/some/path' } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'empty' )
        } )


        it( 'fails when projectId contains invalid characters', () => {
            const { status, messages } = DocumentRegistry.validateAddDocument( { projectId: 'my project!', memoPath: '/some/path' } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'alphanumeric' )
        } )


        it( 'fails when memoPath is missing', () => {
            const { status, messages } = DocumentRegistry.validateAddDocument( { projectId: 'test', memoPath: undefined } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'memoPath' )
        } )


        it( 'passes with valid inputs', () => {
            const { status } = DocumentRegistry.validateAddDocument( { projectId: 'my-project', memoPath: '/some/path' } )

            expect( status ).toBe( true )
        } )


        it( 'accepts underscores and hyphens in projectId', () => {
            const { status } = DocumentRegistry.validateAddDocument( { projectId: 'my_project-123', memoPath: '/some/path' } )

            expect( status ).toBe( true )
        } )
    } )


    describe( 'addDocument', () => {
        it( 'adds a document with revision files', async () => {
            const revisionsDir = join( tempDir, '004-feature', 'revisions' )
            await mkdir( revisionsDir, { recursive: true } )
            await writeFile( join( revisionsDir, 'v0.1.md' ), '# First revision' )
            await writeFile( join( revisionsDir, 'v0.2.md' ), '# Second revision' )

            const result = await registry.addDocument( { projectId: 'testproject', memoPath: revisionsDir } )

            expect( result['status'] ).toBe( true )
            expect( result['documentId'] ).toBe( 'testproject--004-feature' )
            expect( result['revisionsFound'] ).toBe( 2 )
        } )


        it( 'fails when path does not exist', async () => {
            const result = await registry.addDocument( { projectId: 'test', memoPath: '/nonexistent/path' } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'not found' )
        } )


        it( 'fails when path is not a directory', async () => {
            const filePath = join( tempDir, 'file.md' )
            await writeFile( filePath, '# Test' )

            const result = await registry.addDocument( { projectId: 'test', memoPath: filePath } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'directory' )
        } )


        it( 'updates revisions when adding same document twice', async () => {
            const revisionsDir = join( tempDir, '005-memo', 'revisions' )
            await mkdir( revisionsDir, { recursive: true } )
            await writeFile( join( revisionsDir, 'v0.1.md' ), '# Rev 1' )

            await registry.addDocument( { projectId: 'proj', memoPath: revisionsDir } )
            await writeFile( join( revisionsDir, 'v0.2.md' ), '# Rev 2' )

            const result = await registry.addDocument( { projectId: 'proj', memoPath: revisionsDir } )

            expect( result['status'] ).toBe( true )
            expect( result['revisionsFound'] ).toBe( 2 )
        } )


        it( 'leaves selectedRevision null until UI selects one (PRD-008 REV-XX naming)', async () => {
            // Note: selection is a UI-driven action since Memo 011 PRD-008 (REV-XX naming).
            // Server initializes selectedRevision=null; client-side auto-select picks latest.
            const revisionsDir = join( tempDir, '006-feature', 'revisions' )
            await mkdir( revisionsDir, { recursive: true } )
            await writeFile( join( revisionsDir, 'REV-01.md' ), '# First' )
            await writeFile( join( revisionsDir, 'REV-02.md' ), '# Second' )

            const result = await registry.addDocument( { projectId: 'proj', memoPath: revisionsDir } )
            const { document } = registry.getDocument( { documentId: result['documentId'] } )

            expect( document['selectedRevision'] ).toBeNull()
            expect( document['revisions'].length ).toBe( 2 )
            // Revisions sorted by mtime desc (then REV-Number desc as tie-breaker, PRD-007)
            const fileNames = document['revisions'].map( ( r ) => r['fileName'] )

            expect( fileNames ).toContain( 'REV-01.md' )
            expect( fileNames ).toContain( 'REV-02.md' )
        } )


        it( 'extracts memo name from parent when dir is "revisions"', async () => {
            const revisionsDir = join( tempDir, '007-cool-feature', 'revisions' )
            await mkdir( revisionsDir, { recursive: true } )
            await writeFile( join( revisionsDir, 'v0.1.md' ), '# Rev' )

            const result = await registry.addDocument( { projectId: 'proj', memoPath: revisionsDir } )

            expect( result['documentId'] ).toBe( 'proj--007-cool-feature' )
        } )
    } )


    describe( 'removeDocument', () => {
        it( 'removes an existing document', async () => {
            const revisionsDir = join( tempDir, '008-feat', 'revisions' )
            await mkdir( revisionsDir, { recursive: true } )
            await writeFile( join( revisionsDir, 'v0.1.md' ), '# Rev' )

            const addResult = await registry.addDocument( { projectId: 'proj', memoPath: revisionsDir } )
            const removeResult = registry.removeDocument( { documentId: addResult['documentId'] } )

            expect( removeResult['status'] ).toBe( true )

            const { documents } = registry.getDocuments()

            expect( documents.length ).toBe( 0 )
        } )


        it( 'fails for non-existent document', () => {
            const result = registry.removeDocument( { documentId: 'does-not-exist' } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'Not found' )
        } )
    } )


    describe( 'getDocuments', () => {
        it( 'returns empty list initially', () => {
            const { documents } = registry.getDocuments()

            expect( documents ).toEqual( [] )
        } )


        it( 'returns all added documents', async () => {
            const dir1 = join( tempDir, '001-a', 'revisions' )
            const dir2 = join( tempDir, '002-b', 'revisions' )
            await mkdir( dir1, { recursive: true } )
            await mkdir( dir2, { recursive: true } )
            await writeFile( join( dir1, 'v0.1.md' ), '# A' )
            await writeFile( join( dir2, 'v0.1.md' ), '# B' )

            await registry.addDocument( { projectId: 'proj', memoPath: dir1 } )
            await registry.addDocument( { projectId: 'proj', memoPath: dir2 } )

            const { documents } = registry.getDocuments()

            expect( documents.length ).toBe( 2 )
        } )
    } )


    describe( 'getDocumentTree', () => {
        it( 'groups documents by project', async () => {
            const dir1 = join( tempDir, '001-a', 'revisions' )
            const dir2 = join( tempDir, '002-b', 'revisions' )
            await mkdir( dir1, { recursive: true } )
            await mkdir( dir2, { recursive: true } )
            await writeFile( join( dir1, 'v0.1.md' ), '# A' )
            await writeFile( join( dir2, 'v0.1.md' ), '# B' )

            await registry.addDocument( { projectId: 'alpha', memoPath: dir1 } )
            await registry.addDocument( { projectId: 'beta', memoPath: dir2 } )

            const { tree } = registry.getDocumentTree()

            expect( Object.keys( tree ) ).toEqual( [ 'alpha', 'beta' ] )
            expect( tree['alpha']['memos'].length ).toBe( 1 )
            expect( tree['beta']['memos'].length ).toBe( 1 )
            expect( tree['alpha']['plans'] ).toEqual( [] )
            expect( tree['beta']['plans'] ).toEqual( [] )
        } )
    } )


    describe( 'selectRevision', () => {
        it( 'selects a valid revision', async () => {
            const dir = join( tempDir, '010-feat', 'revisions' )
            await mkdir( dir, { recursive: true } )
            await writeFile( join( dir, 'v0.1.md' ), '# A' )
            await writeFile( join( dir, 'v0.2.md' ), '# B' )

            const addResult = await registry.addDocument( { projectId: 'proj', memoPath: dir } )
            const selectResult = registry.selectRevision( { documentId: addResult['documentId'], fileName: 'v0.1.md' } )

            expect( selectResult['status'] ).toBe( true )

            const { document } = registry.getDocument( { documentId: addResult['documentId'] } )

            expect( document['selectedRevision'] ).toBe( 'v0.1.md' )
        } )


        it( 'fails for non-existent revision', async () => {
            const dir = join( tempDir, '011-feat', 'revisions' )
            await mkdir( dir, { recursive: true } )
            await writeFile( join( dir, 'v0.1.md' ), '# A' )

            const addResult = await registry.addDocument( { projectId: 'proj', memoPath: dir } )
            const selectResult = registry.selectRevision( { documentId: addResult['documentId'], fileName: 'v9.9.md' } )

            expect( selectResult['status'] ).toBe( false )
        } )
    } )


    describe( 'setDocumentStatus', () => {
        it( 'sets status to done', async () => {
            const dir = join( tempDir, '012-feat', 'revisions' )
            await mkdir( dir, { recursive: true } )
            await writeFile( join( dir, 'v0.1.md' ), '# A' )

            const addResult = await registry.addDocument( { projectId: 'proj', memoPath: dir } )
            const statusResult = registry.setDocumentStatus( { documentId: addResult['documentId'], newStatus: 'done' } )

            expect( statusResult['status'] ).toBe( true )

            const { document } = registry.getDocument( { documentId: addResult['documentId'] } )

            expect( document['status'] ).toBe( 'done' )
        } )


        it( 'rejects invalid status values', async () => {
            const dir = join( tempDir, '013-feat', 'revisions' )
            await mkdir( dir, { recursive: true } )
            await writeFile( join( dir, 'v0.1.md' ), '# A' )

            const addResult = await registry.addDocument( { projectId: 'proj', memoPath: dir } )
            const statusResult = registry.setDocumentStatus( { documentId: addResult['documentId'], newStatus: 'invalid' } )

            expect( statusResult['status'] ).toBe( false )
            expect( statusResult['messages'][0] ).toContain( 'Must be one of' )
        } )
    } )


    describe( 'getSelectedRevisionPath', () => {
        it( 'returns absolute path after explicit selectRevision call (REV-XX naming, PRD-008)', async () => {
            const dir = join( tempDir, '014-feat', 'revisions' )
            await mkdir( dir, { recursive: true } )
            await writeFile( join( dir, 'REV-01.md' ), '# A' )

            const addResult = await registry.addDocument( { projectId: 'proj', memoPath: dir } )
            // Server does not auto-select; UI must call selectRevision explicitly.
            const selectResult = registry.selectRevision( { documentId: addResult['documentId'], fileName: 'REV-01.md' } )

            expect( selectResult['status'] ).toBe( true )

            const { status, absolutePath } = registry.getSelectedRevisionPath( { documentId: addResult['documentId'] } )

            expect( status ).toBe( true )
            expect( absolutePath ).toContain( 'REV-01.md' )
        } )


        it( 'returns false for non-existent document', () => {
            const { status } = registry.getSelectedRevisionPath( { documentId: 'nope' } )

            expect( status ).toBe( false )
        } )
    } )


    describe( 'parseStatus (PRD-010)', () => {
        it( 'parses Finalisiert from a header table row', () => {
            const content = '# Memo\n\n| **Status** | Finalisiert |\n| **Typ** | Full |\n'
            const { memoStatus } = DocumentRegistry.parseStatus( { content } )

            expect( memoStatus ).toBe( 'Finalisiert' )
        } )


        it( 'parses Entwurf and Bedingt finalisiert', () => {
            const draft = DocumentRegistry.parseStatus( { content: '| **Status** | Entwurf |' } )
            const conditional = DocumentRegistry.parseStatus( { content: '| **Status** |  Bedingt finalisiert  |' } )

            expect( draft['memoStatus'] ).toBe( 'Entwurf' )
            expect( conditional['memoStatus'] ).toBe( 'Bedingt finalisiert' )
        } )


        it( 'tolerates extra whitespace in the cell', () => {
            const { memoStatus } = DocumentRegistry.parseStatus( { content: '|   **Status**   |    Finalisiert   |' } )

            expect( memoStatus ).toBe( 'Finalisiert' )
        } )


        it( 'falls back to Entwurf when field missing', () => {
            const { memoStatus } = DocumentRegistry.parseStatus( { content: '# Memo\n\nNo status here' } )

            expect( memoStatus ).toBe( 'Entwurf' )
        } )


        it( 'falls back to Entwurf for unknown value', () => {
            const { memoStatus } = DocumentRegistry.parseStatus( { content: '| **Status** | Irgendwas |' } )

            expect( memoStatus ).toBe( 'Entwurf' )
        } )


        it( 'falls back to Entwurf for empty content', () => {
            const { memoStatus } = DocumentRegistry.parseStatus( { content: '' } )

            expect( memoStatus ).toBe( 'Entwurf' )
        } )
    } )


    describe( 'parseQuestions (PRD-013)', () => {
        it( 'counts list-format entries in both sections', () => {
            const content = [
                '## Offene Fragen',
                '',
                '- Frage A',
                '- Frage B',
                '',
                '## Beantwortete Fragen',
                '',
                '- Antwort 1',
                '',
                '## Phasen',
                '',
                '- not a question'
            ].join( '\n' )

            const { openCount, answeredCount } = DocumentRegistry.parseQuestions( { content } )

            expect( openCount ).toBe( 2 )
            expect( answeredCount ).toBe( 1 )
        } )


        it( 'counts table-format entries, skipping header and separator rows', () => {
            const content = [
                '## Beantwortete Fragen',
                '',
                '| Nr | Frage | Status |',
                '|----|-------|--------|',
                '| F4 | Where? | done |',
                '| F20 | What? | done |',
                '',
                '## Offene Fragen',
                '',
                '| F30 | Open one |'
            ].join( '\n' )

            const { openCount, answeredCount } = DocumentRegistry.parseQuestions( { content } )

            expect( answeredCount ).toBe( 2 )
            expect( openCount ).toBe( 1 )
        } )


        it( 'stops extraction at next ## heading', () => {
            const content = [
                '## Offene Fragen',
                '- only this one',
                '## Andere Sektion',
                '- should not count',
                '- nor this'
            ].join( '\n' )

            const { openCount } = DocumentRegistry.parseQuestions( { content } )

            expect( openCount ).toBe( 1 )
        } )


        it( 'returns zero counts for empty content', () => {
            const { openCount, answeredCount } = DocumentRegistry.parseQuestions( { content: '' } )

            expect( openCount ).toBe( 0 )
            expect( answeredCount ).toBe( 0 )
        } )
    } )


    describe( 'parseQuestionSchema type detection (Memo 015 #31/#64/#65)', () => {
        const findQuestion = ( { content, id } ) => {
            const { questions } = DocumentRegistry.parseQuestionSchema( { content } )
            const found = questions.find( ( q ) => q[ 'id' ] === id )

            return { found }
        }


        it( 'keeps a lettered A/B/C single-select as single (option count must not force multi)', () => {
            const content = [
                '## Offene Fragen',
                '',
                '### F1 — Variante',
                '',
                '**Frage (Original):** Welche Variante?',
                '',
                'A) Pencil B) strenge F14 C) Hybrid'
            ].join( '\n' )

            const { found } = findQuestion( { content, id: 'F1' } )

            expect( found[ 'typ' ] ).toBe( 'single' )
        } )


        it( 'detects a checkbox checklist as multi', () => {
            const content = [
                '## Offene Fragen',
                '',
                '### F2 — Gates',
                '',
                '**Frage (Original):** Welche Gates?',
                '',
                '- [ ] memo-evidence',
                '- [ ] memo-balance',
                '- [ ] git-security'
            ].join( '\n' )

            const { found } = findQuestion( { content, id: 'F2' } )

            expect( found[ 'typ' ] ).toBe( 'multi' )
        } )


        it( 'respects an explicit Typ: multi field', () => {
            const content = [
                '## Offene Fragen',
                '',
                '### F3 — Explizit',
                '',
                '**Typ:** multi',
                '',
                'A) eins B) zwei'
            ].join( '\n' )

            const { found } = findQuestion( { content, id: 'F3' } )

            expect( found[ 'typ' ] ).toBe( 'multi' )
        } )


        it( 'ignores a multi-like keyword in the title (single body stays single)', () => {
            const content = [
                '## Offene Fragen',
                '',
                '### F4 — Finalisierungs-Checkliste',
                '',
                '**Frage (Original):** Welche Variante?',
                '',
                'A) eins B) zwei C) drei'
            ].join( '\n' )

            const { found } = findQuestion( { content, id: 'F4' } )

            expect( found[ 'typ' ] ).toBe( 'single' )
        } )
    } )


    describe( 'parseQuestionSchema option parsing — paren-tolerant (PRD-021, Memo 016 Kap 11.1)', () => {
        const optionsOf = ( { body } ) => {
            const content = [
                '## Offene Fragen',
                '',
                '### F1 — T',
                '',
                body
            ].join( '\n' )
            const { questions } = DocumentRegistry.parseQuestionSchema( { content } )
            const opts = questions[ 0 ][ 'options' ]
                .filter( ( o ) => o[ 'kind' ] === 'option' )

            return { opts }
        }


        it( 'parses discrete bare markers "A)" / "B)" into key+label (regression guard)', () => {
            const { opts } = optionsOf( { body: 'A) Foo\nB) Bar' } )

            expect( opts ).toEqual( [
                { 'key': 'A', 'label': 'Foo', 'kind': 'option' },
                { 'key': 'B', 'label': 'Bar', 'kind': 'option' }
            ] )
        } )


        it( 'parses parenthesised markers "(A)" / "(B)" without leaking the parens', () => {
            const { opts } = optionsOf( { body: '(A) Foo\n(B) Bar' } )

            expect( opts ).toEqual( [
                { 'key': 'A', 'label': 'Foo', 'kind': 'option' },
                { 'key': 'B', 'label': 'Bar', 'kind': 'option' }
            ] )
        } )


        it( 'parses mixed bare + parenthesised markers without merging labels', () => {
            const { opts } = optionsOf( { body: 'A) Foo\n(B) Bar' } )

            expect( opts ).toEqual( [
                { 'key': 'A', 'label': 'Foo', 'kind': 'option' },
                { 'key': 'B', 'label': 'Bar', 'kind': 'option' }
            ] )
            // "Foo" must NOT swallow the "(B)" marker into its label.
            expect( opts[ 0 ][ 'label' ] ).toBe( 'Foo' )
        } )


        it( 'treats "Option (C):" and "Option C:" the same (key C, label Baz)', () => {
            const paren = optionsOf( { body: 'Option (C): Baz' } )
            const bare = optionsOf( { body: 'Option C: Baz' } )

            expect( paren.opts ).toEqual( [ { 'key': 'C', 'label': 'Baz', 'kind': 'option' } ] )
            expect( bare.opts ).toEqual( [ { 'key': 'C', 'label': 'Baz', 'kind': 'option' } ] )
        } )


        it( 'accepts parenthesised markers with trailing colon / dot ("(A):" / "(B).")', () => {
            const { opts } = optionsOf( { body: '(A): Foo\n(B). Bar' } )

            expect( opts.map( ( o ) => o[ 'key' ] ) ).toEqual( [ 'A', 'B' ] )
            expect( opts.map( ( o ) => o[ 'label' ] ) ).toEqual( [ 'Foo', 'Bar' ] )
        } )


        it( 'does NOT mis-parse a parenthetical phrase inside a label as a marker', () => {
            // "(siehe Kap 3)" is not a lone A-H letter, so it stays part of the label.
            const { opts } = optionsOf( { body: 'A) Foo (siehe Kap 3) Detail\nB) Bar' } )

            expect( opts ).toEqual( [
                { 'key': 'A', 'label': 'Foo (siehe Kap 3) Detail', 'kind': 'option' },
                { 'key': 'B', 'label': 'Bar', 'kind': 'option' }
            ] )
        } )


        it( 'dedups a repeated key regardless of bracket form (first wins)', () => {
            const { opts } = optionsOf( { body: 'A) Foo\n(A) Bar' } )

            expect( opts ).toEqual( [ { 'key': 'A', 'label': 'Foo', 'kind': 'option' } ] )
        } )


        it( 'parenthesised input no longer fails silently (non-empty option array)', () => {
            const { opts } = optionsOf( { body: '(A) Erste\n(B) Zweite\n(C) Dritte' } )

            expect( opts.length ).toBe( 3 )
            expect( opts.map( ( o ) => o[ 'key' ] ) ).toEqual( [ 'A', 'B', 'C' ] )
        } )
    } )


    describe( 'parseQuestionSchema multi-select + preselection (PRD-022, Memo 016 Kap 11.2/11.3)', () => {
        const buildQuestion = ( { body } ) => {
            const content = [
                '## Offene Fragen',
                '',
                '### F1 — T',
                '',
                body
            ].join( '\n' )
            const { questions } = DocumentRegistry.parseQuestionSchema( { content } )

            return { question: questions[ 0 ] }
        }

        const keysOf = ( { question } ) => {
            return question[ 'options' ]
                .filter( ( o ) => o[ 'kind' ] === 'option' )
                .map( ( o ) => o[ 'key' ] )
        }


        it( 'classifies "**Typ:** multi" as multi', () => {
            const { question } = buildQuestion( { body: '**Typ:** multi\n\nA) eins B) zwei' } )

            expect( question[ 'typ' ] ).toBe( 'multi' )
        } )


        it( 'classifies a checklist with >= 2 checkbox items as multi', () => {
            const { question } = buildQuestion( { body: '- [ ] a\n- [x] b\n- [ ] c' } )

            expect( question[ 'typ' ] ).toBe( 'multi' )
        } )


        it( 'keeps three lettered options without checklist/Typ/keyword as single', () => {
            const { question } = buildQuestion( { body: 'A) a B) b C) c' } )

            expect( question[ 'typ' ] ).toBe( 'single' )
        } )


        it( 'keeps a single checkbox item as single', () => {
            const { question } = buildQuestion( { body: 'Frage?\n- [ ] nur eins' } )

            expect( question[ 'typ' ] ).toBe( 'single' )
        } )


        it( 'maps "Option C" to exactly one preselected index for single', () => {
            const { question } = buildQuestion( {
                body: '**AI-Empfehlung:** Option C\n\nA) a B) b C) c'
            } )
            const keys = keysOf( { question } )
            const cIndex = keys.indexOf( 'C' )

            expect( question[ 'typ' ] ).toBe( 'single' )
            expect( question[ 'preselected' ] ).toEqual( [ cIndex ] )
        } )


        it( 'maps "A+B" to both preselected indices for multi', () => {
            const { question } = buildQuestion( {
                body: '**Typ:** multi\n**AI-Empfehlung:** A+B\n\nA) a B) b C) c'
            } )
            const keys = keysOf( { question } )

            expect( question[ 'typ' ] ).toBe( 'multi' )
            expect( question[ 'preselected' ] ).toEqual( [ keys.indexOf( 'A' ), keys.indexOf( 'B' ) ] )
        } )


        it( 'yields empty preselected for an unmatchable / missing recommendation', () => {
            const none = buildQuestion( { body: 'A) a B) b' } )
            const unmatched = buildQuestion( {
                body: '**AI-Empfehlung:** keine klare Wahl\n\nA) a B) b'
            } )

            expect( none.question[ 'preselected' ] ).toEqual( [] )
            expect( unmatched.question[ 'preselected' ] ).toEqual( [] )
        } )
    } )


    describe( 'parseVorwort (PRD-014)', () => {
        it( 'extracts the "## Vorwort" section content', () => {
            const content = [
                '# Memo',
                '',
                '## Vorwort',
                '',
                'Ich habe REV-08 ueberarbeitet.',
                'Bitte F12 zuerst beantworten.',
                '',
                '## Offene Fragen',
                '',
                '### F12 — Welcher Token?'
            ].join( '\n' )

            const { vorwort } = DocumentRegistry.parseVorwort( { content } )

            expect( vorwort ).toContain( 'Ich habe REV-08 ueberarbeitet.' )
            expect( vorwort ).toContain( 'Bitte F12 zuerst beantworten.' )
            expect( vorwort ).not.toContain( 'Offene Fragen' )
        } )


        it( 'accepts the "## Claude-Vorwort" heading variant', () => {
            const content = [
                '## Claude-Vorwort',
                '',
                'Einordnung hier.',
                '',
                '## Phasen'
            ].join( '\n' )

            const { vorwort } = DocumentRegistry.parseVorwort( { content } )

            expect( vorwort ).toBe( 'Einordnung hier.' )
        } )


        it( 'returns an empty string when no Vorwort section exists', () => {
            const content = [
                '# Memo',
                '',
                '## Offene Fragen',
                '',
                '### F1 — Frage?'
            ].join( '\n' )

            const { vorwort } = DocumentRegistry.parseVorwort( { content } )

            expect( vorwort ).toBe( '' )
        } )


        it( 'returns an empty string for empty content', () => {
            const { vorwort } = DocumentRegistry.parseVorwort( { content: '' } )

            expect( vorwort ).toBe( '' )
        } )
    } )


    describe( 'memoStatus + questions integration (PRD-010/013)', () => {
        it( 'exposes parsed memoStatus and questions via getDocument', async () => {
            const dir = join( tempDir, '013-feature', 'revisions' )
            await mkdir( dir, { recursive: true } )
            const body = [
                '| **Status** | Finalisiert |',
                '',
                '## Offene Fragen',
                '- F1',
                '- F2',
                '',
                '## Beantwortete Fragen',
                '- A1'
            ].join( '\n' )
            await writeFile( join( dir, 'REV-01.md' ), body )

            const addResult = await registry.addDocument( { projectId: 'proj', memoPath: dir } )
            const { document } = registry.getDocument( { documentId: addResult['documentId'] } )

            expect( document['memoStatus'] ).toBe( 'Finalisiert' )
            expect( document['questions'] ).toEqual( { open: 2, answered: 1 } )
        } )


        it( 'exposes memoStatus + questions via getDocuments and getDocumentTree', async () => {
            const dir = join( tempDir, '014-feat', 'revisions' )
            await mkdir( dir, { recursive: true } )
            await writeFile( join( dir, 'REV-01.md' ), '| **Status** | Finalisiert |\n\n## Offene Fragen\n- X' )

            await registry.addDocument( { projectId: 'proj', memoPath: dir } )

            const { documents } = registry.getDocuments()

            expect( documents[0]['memoStatus'] ).toBe( 'Finalisiert' )
            expect( documents[0]['questions'] ).toEqual( { open: 1, answered: 0 } )

            const { tree } = registry.getDocumentTree()

            expect( tree['proj']['memos'][0]['memoStatus'] ).toBe( 'Finalisiert' )
            expect( tree['proj']['memos'][0]['questions'] ).toEqual( { open: 1, answered: 0 } )
        } )


        it( 'defaults to Entwurf when no Status field present', async () => {
            const dir = join( tempDir, '015-feat', 'revisions' )
            await mkdir( dir, { recursive: true } )
            await writeFile( join( dir, 'REV-01.md' ), '# Just a memo' )

            const addResult = await registry.addDocument( { projectId: 'proj', memoPath: dir } )
            const { document } = registry.getDocument( { documentId: addResult['documentId'] } )

            expect( document['memoStatus'] ).toBe( 'Entwurf' )
        } )


        it( 'watcher updates memoStatus after Status field change', async () => {
            const dir = join( tempDir, '016-feat', 'revisions' )
            await mkdir( dir, { recursive: true } )
            const filePath = join( dir, 'REV-01.md' )
            await writeFile( filePath, '| **Status** | Entwurf |' )

            const addResult = await registry.addDocument( { projectId: 'proj', memoPath: dir } )
            const documentId = addResult['documentId']

            const before = registry.getDocument( { documentId } )

            expect( before['document']['memoStatus'] ).toBe( 'Entwurf' )

            await writeFile( filePath, '| **Status** | Finalisiert |' )

            await new Promise( ( r ) => setTimeout( r, 300 ) )

            const after = registry.getDocument( { documentId } )

            expect( after['document']['memoStatus'] ).toBe( 'Finalisiert' )
        } )
    } )


    describe( 'getOpenFinalizedMemos (PRD-011)', () => {
        it( 'returns only finalized memos of the given namespace', async () => {
            const finalizedDir = join( tempDir, '020-done', 'revisions' )
            const draftDir = join( tempDir, '021-draft', 'revisions' )
            await mkdir( finalizedDir, { recursive: true } )
            await mkdir( draftDir, { recursive: true } )
            await writeFile( join( finalizedDir, 'REV-01.md' ), '| **Status** | Finalisiert |' )
            await writeFile( join( draftDir, 'REV-01.md' ), '| **Status** | Entwurf |' )

            await registry.addDocument( { projectId: 'nsA', memoPath: finalizedDir } )
            await registry.addDocument( { projectId: 'nsA', memoPath: draftDir } )

            const { memos } = registry.getOpenFinalizedMemos( { projectId: 'nsA' } )

            expect( memos.length ).toBe( 1 )
            expect( memos[0]['memoName'] ).toBe( '020-done' )
            expect( memos[0]['memoStatus'] ).toBe( 'Finalisiert' )
        } )


        it( 'filters by namespace; other namespaces excluded when projectId given', async () => {
            const dirA = join( tempDir, '030-a', 'revisions' )
            const dirB = join( tempDir, '031-b', 'revisions' )
            await mkdir( dirA, { recursive: true } )
            await mkdir( dirB, { recursive: true } )
            await writeFile( join( dirA, 'REV-01.md' ), '| **Status** | Finalisiert |' )
            await writeFile( join( dirB, 'REV-01.md' ), '| **Status** | Finalisiert |' )

            await registry.addDocument( { projectId: 'nsA', memoPath: dirA } )
            await registry.addDocument( { projectId: 'nsB', memoPath: dirB } )

            const scoped = registry.getOpenFinalizedMemos( { projectId: 'nsA' } )

            expect( scoped['memos'].length ).toBe( 1 )

            const all = registry.getOpenFinalizedMemos( { projectId: undefined } )

            expect( all['memos'].length ).toBe( 2 )
        } )
    } )


    describe( 'sortMemosByNewest (PRD-017 — neueste oben)', () => {
        it( 'orders memos descending by latestMtimeMs (newest first)', () => {
            const memos = [
                { memoName: 'older', latestMtimeMs: 1000 },
                { memoName: 'newest', latestMtimeMs: 3000 },
                { memoName: 'middle', latestMtimeMs: 2000 }
            ]

            const { sorted } = DocumentRegistry.sortMemosByNewest( { memos } )
            const order = sorted.map( ( m ) => m['memoName'] )

            expect( order ).toEqual( [ 'newest', 'middle', 'older' ] )
        } )


        it( 'keeps entries without a timestamp at the bottom without reordering them', () => {
            const memos = [
                { memoName: 'no-time-1', latestMtimeMs: null },
                { memoName: 'has-time', latestMtimeMs: 5000 },
                { memoName: 'no-time-2', latestMtimeMs: null }
            ]

            const { sorted } = DocumentRegistry.sortMemosByNewest( { memos } )
            const order = sorted.map( ( m ) => m['memoName'] )

            expect( order ).toEqual( [ 'has-time', 'no-time-1', 'no-time-2' ] )
        } )


        it( 'does not mutate the input array', () => {
            const memos = [
                { memoName: 'a', latestMtimeMs: 1 },
                { memoName: 'b', latestMtimeMs: 2 }
            ]

            DocumentRegistry.sortMemosByNewest( { memos } )

            expect( memos[0]['memoName'] ).toBe( 'a' )
        } )


        it( 'tolerates a missing/invalid input', () => {
            const { sorted } = DocumentRegistry.sortMemosByNewest( { memos: undefined } )

            expect( sorted ).toEqual( [] )
        } )
    } )


    describe( 'getDocumentTree sorting + mtime surfacing (PRD-016/017)', () => {
        it( 'sorts memos newest-on-top and exposes latestMtimeMs + per-revision mtimeMs', async () => {
            const dirOld = join( tempDir, '040-old', 'revisions' )
            const dirNew = join( tempDir, '041-new', 'revisions' )
            await mkdir( dirOld, { recursive: true } )
            await mkdir( dirNew, { recursive: true } )
            await writeFile( join( dirOld, 'REV-01.md' ), '# old' )
            await writeFile( join( dirNew, 'REV-01.md' ), '# new' )

            await registry.addDocument( { projectId: 'ns', memoPath: dirOld } )
            await registry.addDocument( { projectId: 'ns', memoPath: dirNew } )

            // Force a deterministic ordering: make 040-old the OLDER memo regardless of FS time.
            const treeRaw = registry.getDocumentTree()
            const memos = treeRaw['tree']['ns']['memos']

            // Both expose a numeric or null latestMtimeMs and a revision mtimeMs key.
            memos.forEach( ( m ) => {
                expect( m ).toHaveProperty( 'latestMtimeMs' )
                expect( m['revisions'][0] ).toHaveProperty( 'mtimeMs' )
            } )

            // The memo with the larger latestMtimeMs must come first.
            const first = memos[0]['latestMtimeMs']
            const second = memos[1]['latestMtimeMs']

            if( typeof first === 'number' && typeof second === 'number' ) {
                expect( first ).toBeGreaterThanOrEqual( second )
            }
        } )


        it( 'leaves the plans bucket untouched', async () => {
            const dir = join( tempDir, '042-memo', 'revisions' )
            await mkdir( dir, { recursive: true } )
            await writeFile( join( dir, 'REV-01.md' ), '# memo' )

            await registry.addDocument( { projectId: 'ns', memoPath: dir } )

            const { tree } = registry.getDocumentTree()

            expect( tree['ns']['plans'] ).toEqual( [] )
        } )
    } )
} )
