import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'


describe( 'TranscriptRegistry', () => {
    let tempDir
    let registry


    beforeEach( async () => {
        tempDir = await mkdtemp( join( tmpdir(), 'transcript-test-' ) )
        const { registry: reg } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        registry = reg
    } )


    afterEach( async () => {
        registry.shutdown()
        await rm( tempDir, { recursive: true, force: true } )
    } )


    describe( 'buildPlanUrl (PRD-014)', () => {
        it( 'builds a valid plan URL', () => {
            const { status, url } = TranscriptRegistry.buildPlanUrl( { planId: 'PLAN-001-my-plan', host: 'http://localhost:3333' } )

            expect( status ).toBe( true )
            expect( url ).toBe( 'http://localhost:3333/plans/PLAN-001-my-plan' )
        } )


        it( 'rejects an invalid planId pattern', () => {
            const { status, messages, url } = TranscriptRegistry.buildPlanUrl( { planId: 'plan-1', host: 'http://localhost:3333' } )

            expect( status ).toBe( false )
            expect( url ).toBeNull()
            expect( messages[0] ).toContain( 'pattern' )
        } )


        it( 'rejects missing planId', () => {
            const { status } = TranscriptRegistry.buildPlanUrl( { planId: undefined, host: 'http://localhost:3333' } )

            expect( status ).toBe( false )
        } )


        it( 'uses default host when host omitted', () => {
            const { url } = TranscriptRegistry.buildPlanUrl( { planId: 'PLAN-013-viewer' } )

            expect( url ).toBe( 'http://localhost:3333/plans/PLAN-013-viewer' )
        } )
    } )


    describe( 'isContentDuplicate + updateTranscript unchanged path (PRD-014)', () => {
        it( 'detects duplicate body and skips write (unchanged=true)', async () => {
            const memoDir = join( tempDir, '013-feature' )
            await mkdir( memoDir, { recursive: true } )

            const add = await registry.addTranscript( {
                projectId: 'proj',
                memoId: '013-feature',
                revisionId: 'REV-01',
                content: 'Original transcript body',
                memoPath: memoDir
            } )

            expect( add['status'] ).toBe( true )

            const dup = await registry.isContentDuplicate( { transcriptId: add['transcriptId'], content: 'Original transcript body' } )

            expect( dup['status'] ).toBe( true )
            expect( dup['isDuplicate'] ).toBe( true )

            const statBefore = await stat( add['absolutePath'] )

            await new Promise( ( r ) => setTimeout( r, 20 ) )

            const upd = await registry.updateTranscript( { transcriptId: add['transcriptId'], content: 'Original transcript body' } )

            expect( upd['status'] ).toBe( true )
            expect( upd['unchanged'] ).toBe( true )

            const statAfter = await stat( add['absolutePath'] )

            expect( statAfter.mtimeMs ).toBe( statBefore.mtimeMs )
        } )


        it( 'returns isDuplicate=false for changed content and writes', async () => {
            const memoDir = join( tempDir, '014-feature' )
            await mkdir( memoDir, { recursive: true } )

            const add = await registry.addTranscript( {
                projectId: 'proj',
                memoId: '014-feature',
                revisionId: 'REV-01',
                content: 'First body',
                memoPath: memoDir
            } )

            const dup = await registry.isContentDuplicate( { transcriptId: add['transcriptId'], content: 'Different body' } )

            expect( dup['isDuplicate'] ).toBe( false )

            const upd = await registry.updateTranscript( { transcriptId: add['transcriptId'], content: 'Different body' } )

            expect( upd['status'] ).toBe( true )
            expect( upd['unchanged'] ).toBe( false )

            const raw = await readFile( add['absolutePath'], 'utf-8' )

            expect( raw ).toContain( 'Different body' )
        } )


        it( 'fails for unknown transcriptId', async () => {
            const dup = await registry.isContentDuplicate( { transcriptId: 'nope--x--REV-01', content: 'x' } )

            expect( dup['status'] ).toBe( false )
            expect( dup['messages'][0] ).toContain( 'NOTFOUND' )
        } )
    } )


    describe( 'addTranscript url timing + multiple sequences (PRD-014)', () => {
        it( 'returns url only after successful write', async () => {
            const memoDir = join( tempDir, '015-feature' )
            await mkdir( memoDir, { recursive: true } )

            const add = await registry.addTranscript( {
                projectId: 'proj',
                memoId: '015-feature',
                revisionId: 'REV-01',
                content: 'Body',
                memoPath: memoDir
            } )

            expect( add['url'] ).not.toBeNull()
            await access( add['absolutePath'] )
        } )


        it( 'keeps multiple transcripts per revision via sequence', async () => {
            const memoDir = join( tempDir, '016-feature' )
            await mkdir( memoDir, { recursive: true } )

            const first = await registry.addTranscript( { projectId: 'proj', memoId: '016-feature', revisionId: 'REV-01', content: 'A', memoPath: memoDir } )
            const second = await registry.addTranscript( { projectId: 'proj', memoId: '016-feature', revisionId: 'REV-01', content: 'B', memoPath: memoDir } )

            expect( first['status'] ).toBe( true )
            expect( second['status'] ).toBe( true )
            expect( first['transcriptId'] ).not.toBe( second['transcriptId'] )

            await access( first['absolutePath'] )
            await access( second['absolutePath'] )

            const { transcripts } = registry.listTranscripts( { memoId: '016-feature' } )

            expect( transcripts.length ).toBe( 2 )
        } )
    } )


    describe( 'addOtherTranscript / listOtherTranscripts / scanOther (PRD-012)', () => {
        // PRD-007: storage moved from .memo/other/transcripts/ to .memo/transcripts/
        // and free transcripts now carry the "frei" type (not memo-init).
        it( 'writes a free transcript with the frei header under .memo/transcripts/', async () => {
            const result = await registry.addOtherTranscript( { projectId: 'proj', content: 'Future memo idea', otherRoot: tempDir } )

            expect( result['status'] ).toBe( true )
            expect( result['transcriptId'] ).toBe( 'proj--other--01' )
            expect( result['absolutePath'] ).toContain( join( '.memo', 'transcripts' ) )
            expect( result['absolutePath'] ).not.toContain( join( '.memo', 'other', 'transcripts' ) )

            const raw = await readFile( result['absolutePath'], 'utf-8' )

            // PRD-007: free transcripts use the "frei" template — no memo number, no memo-init.
            expect( raw ).toContain( '# Transcript (frei / undefiniert)' )
            expect( raw ).not.toContain( '# Transcript zu Memo' )
            expect( raw ).not.toContain( '# Transcript fuer neues Memo' )
            expect( raw ).toContain( 'Future memo idea' )
        } )


        // PRD-007: the type field is exposed in listOtherTranscripts.
        it( 'exposes the frei type field in listOtherTranscripts', async () => {
            await registry.addOtherTranscript( { projectId: 'proj', content: 'idea', otherRoot: tempDir } )

            const { transcripts } = registry.listOtherTranscripts( { otherRoot: tempDir } )

            expect( transcripts.length ).toBe( 1 )
            expect( transcripts[0]['type'] ).toBe( 'frei' )
        } )


        // PRD-007: scanOther reconstructs the type from the header on restart.
        it( 'scanOther recovers the frei type field from the header on restart', async () => {
            await registry.addOtherTranscript( { projectId: 'restart-slug', content: 'persisted', otherRoot: tempDir } )

            const { registry: fresh } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
            const scan = await fresh.scanOther( { otherRoot: tempDir } )

            expect( scan['status'] ).toBe( true )
            expect( scan['registered'] ).toBe( 1 )

            const { transcripts } = fresh.listOtherTranscripts( { otherRoot: tempDir } )

            expect( transcripts.length ).toBe( 1 )
            expect( transcripts[0]['type'] ).toBe( 'frei' )
            fresh.shutdown()
        } )


        // PRD-007 (F5): no auto-migration — old files under .memo/other/transcripts/ are
        // not scanned from the new location (and not touched).
        it( 'does not scan legacy files under .memo/other/transcripts/', async () => {
            const legacyDir = join( tempDir, '.memo', 'other', 'transcripts' )
            await mkdir( legacyDir, { recursive: true } )
            await writeFile( join( legacyDir, 'legacy--other--01.md' ), '# Transcript (frei / undefiniert)\n\nold body', 'utf-8' )

            const { registry: fresh } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
            const scan = await fresh.scanOther( { otherRoot: tempDir } )

            // The legacy directory is no longer the resolved location → nothing registered.
            expect( scan['status'] ).toBe( true )
            expect( scan['registered'] ).toBe( 0 )

            // The legacy file is still present (neither moved nor deleted).
            let stillThere = true
            try {
                await access( join( legacyDir, 'legacy--other--01.md' ) )
            } catch {
                stillThere = false
            }
            expect( stillThere ).toBe( true )
            fresh.shutdown()
        } )


        it( 'assigns sequential collision-free names', async () => {
            const a = await registry.addOtherTranscript( { projectId: 'proj', content: 'one', otherRoot: tempDir } )
            const b = await registry.addOtherTranscript( { projectId: 'proj', content: 'two', otherRoot: tempDir } )

            expect( a['transcriptId'] ).toBe( 'proj--other--01' )
            expect( b['transcriptId'] ).toBe( 'proj--other--02' )

            const { transcripts } = registry.listOtherTranscripts( { otherRoot: tempDir } )

            expect( transcripts.length ).toBe( 2 )
        } )


        it( 'fails validation for missing projectId', async () => {
            const result = await registry.addOtherTranscript( { projectId: undefined, content: 'x', otherRoot: tempDir } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'projectId' )
        } )


        it( 'scanOther recovers projectId + transcriptId from filename on restart', async () => {
            const add = await registry.addOtherTranscript( { projectId: 'my-slug', content: 'persisted', otherRoot: tempDir } )

            const { registry: fresh } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
            const scan = await fresh.scanOther( { otherRoot: tempDir } )

            expect( scan['status'] ).toBe( true )
            expect( scan['registered'] ).toBe( 1 )

            const { transcripts } = fresh.listOtherTranscripts( { otherRoot: tempDir } )

            expect( transcripts.length ).toBe( 1 )
            expect( transcripts[0]['projectId'] ).toBe( 'my-slug' )
            expect( transcripts[0]['transcriptId'] ).toBe( add['transcriptId'] )
            fresh.shutdown()
        } )


        it( 'getTranscript resolves an other transcript by its own URL id (regression: NOTFOUND bug)', async () => {
            const add = await registry.addOtherTranscript( { projectId: 'url-slug', content: 'reachable body', otherRoot: tempDir } )

            const result = await registry.getTranscript( { transcriptId: add['transcriptId'] } )

            expect( result['status'] ).toBe( true )
            expect( result['content'] ).toContain( 'reachable body' )
            expect( result['meta']['memoId'] ).toBe( 'other' )
            expect( result['meta']['revisionId'] ).toBe( 'REV-01' )
            // PRD-007/008: the type is exposed in meta for the Transcript-View injection.
            expect( result['meta']['type'] ).toBe( 'frei' )
        } )


        it( 'assigns per-slug sequences (two different names both start at 01)', async () => {
            const a = await registry.addOtherTranscript( { projectId: 'name-a', content: 'a', otherRoot: tempDir } )
            const b = await registry.addOtherTranscript( { projectId: 'name-b', content: 'b', otherRoot: tempDir } )

            expect( a['transcriptId'] ).toBe( 'name-a--other--01' )
            expect( b['transcriptId'] ).toBe( 'name-b--other--01' )
        } )
    } )


    describe( 'promoteOtherTranscript (PRD-012)', () => {
        it( 'moves the file into the target memo transcripts dir (no delete)', async () => {
            const add = await registry.addOtherTranscript( { projectId: 'proj', content: 'promote me', otherRoot: tempDir } )
            const sourcePath = add['absolutePath']

            const targetMemo = join( tempDir, '.memo', 'memos', '040-new-memo' )
            await mkdir( targetMemo, { recursive: true } )

            const result = await registry.promoteOtherTranscript( {
                transcriptId: add['transcriptId'],
                targetMemoPath: targetMemo,
                memoId: '040-new-memo',
                revisionId: 'REV-01'
            } )

            // PRD-001 (Memo 022): review schema always carries a sequence — first promote -> --01.
            expect( result['status'] ).toBe( true )
            expect( result['transcriptId'] ).toBe( 'proj--040-new-memo--REV-01--01' )
            expect( result['url'] ).toContain( '/transcripts/proj--040-new-memo--REV-01--01' )

            // PRD-001 (Memo 022): physical file follows the review schema (binding key = discussed
            // revision REV-01). This would be red under the old REV-01.md binding.
            expect( result['absolutePath'].endsWith( 'REV-01--review--01.md' ) ).toBe( true )

            // file moved to target (content preserved), source gone
            const movedRaw = await readFile( result['absolutePath'], 'utf-8' )

            expect( movedRaw ).toContain( 'promote me' )

            let sourceStillThere = true

            try {
                await access( sourcePath )
            } catch {
                sourceStillThere = false
            }

            expect( sourceStillThere ).toBe( false )

            // removed from other list, added to main list
            const { transcripts: others } = registry.listOtherTranscripts( { otherRoot: tempDir } )

            expect( others.length ).toBe( 0 )

            const { transcripts: main } = registry.listTranscripts( { memoId: '040-new-memo' } )

            expect( main.length ).toBe( 1 )
        } )


        it( 'fails for unknown other transcript', async () => {
            const targetMemo = join( tempDir, '.memo', 'memos', '041-x' )
            await mkdir( targetMemo, { recursive: true } )

            const result = await registry.promoteOtherTranscript( {
                transcriptId: 'proj--other--99',
                targetMemoPath: targetMemo,
                memoId: '041-x',
                revisionId: 'REV-01'
            } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'NOTFOUND' )
        } )


        it( 'fails for invalid revisionId', async () => {
            const add = await registry.addOtherTranscript( { projectId: 'proj', content: 'x', otherRoot: tempDir } )
            const targetMemo = join( tempDir, '.memo', 'memos', '042-y' )
            await mkdir( targetMemo, { recursive: true } )

            const result = await registry.promoteOtherTranscript( {
                transcriptId: add['transcriptId'],
                targetMemoPath: targetMemo,
                memoId: '042-y',
                revisionId: 'NOPE'
            } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'REV-XX' )
        } )
    } )


    describe( 'Nummern-Logik next=max+1 wiring (PRD-002)', () => {
        it( 'derives next from the revisions/ bestand, not from the passed suffix (off-by-one)', async () => {
            // Bestand: highest existing revision is REV-05.
            const memoDir = join( tempDir, '.memo', 'memos', '016-feature' )
            const revisionsDir = join( memoDir, 'revisions' )
            await mkdir( revisionsDir, { recursive: true } )
            await writeFile( join( revisionsDir, 'REV-04.md' ), 'r4', 'utf-8' )
            await writeFile( join( revisionsDir, 'REV-05.md' ), 'r5', 'utf-8' )

            // Suffix says REV-02 — must be ignored in favour of the bestand max (5).
            const result = await registry.addTranscript( { projectId: 'proj', memoId: '016-feature', revisionId: 'REV-02', content: 'feedback', memoPath: memoDir } )

            expect( result['status'] ).toBe( true )

            const raw = await readFile( result['absolutePath'], 'utf-8' )

            expect( raw ).toContain( 'Feedback zu REV-05 → erzeugt REV-06' )
            expect( raw ).not.toContain( 'REV-07' )
            expect( raw ).not.toContain( 'REV-03' )
            expect( raw ).toContain( 'Schema-Version: 2' )
        } )


        it( 'no 000: a numbered memoId always renders its real number', async () => {
            const memoDir = join( tempDir, '.memo', 'memos', '016-feature' )
            await mkdir( memoDir, { recursive: true } )

            const result = await registry.addTranscript( { projectId: 'proj', memoId: '016-feature', revisionId: 'REV-01', content: 'body', memoPath: memoDir } )
            const raw = await readFile( result['absolutePath'], 'utf-8' )

            expect( raw ).toContain( '# Transcript zu Memo 016 feature' )
            expect( raw ).not.toContain( '000' )
        } )
    } )


    describe( 'Legacy-Detection im Scan (PRD-003)', () => {
        it( 'scanMemo marks files without the marker as legacy and never migrates them', async () => {
            const memoDir = join( tempDir, '.memo', 'memos', '016-feature' )
            const transcriptsDir = join( memoDir, 'transcripts' )
            await mkdir( transcriptsDir, { recursive: true } )

            // PRD-001 (Memo 022): review schema REV-<N>--review--<NN>.md is the transcript binding
            // key. A file named REV-01.md (old binding) would no longer be scanned at all.
            const legacyPath = join( transcriptsDir, 'REV-01--review--01.md' )
            const legacyContent = '# Old transcript without marker\n\nlegacy body'
            await writeFile( legacyPath, legacyContent, 'utf-8' )

            const scan = await registry.scanMemo( { memoPath: memoDir, projectId: 'proj', memoId: '016-feature' } )

            expect( scan['status'] ).toBe( true )
            expect( scan['registered'] ).toBe( 1 )

            const { transcripts } = registry.listTranscripts( { memoId: '016-feature' } )
            const id = transcripts[ 0 ]['transcriptId']
            const detail = await registry.getTranscript( { transcriptId: id } )

            expect( detail['meta']['isLegacy'] ).toBe( true )
            expect( detail['meta']['schemaVersion'] ).toBe( null )

            // No auto-migration: the file on disk is unchanged.
            const onDisk = await readFile( legacyPath, 'utf-8' )

            expect( onDisk ).toBe( legacyContent )
        } )


        it( 'a freshly written Schema-2 transcript scans as non-legacy', async () => {
            const memoDir = join( tempDir, '.memo', 'memos', '017-fresh' )
            await mkdir( memoDir, { recursive: true } )

            await registry.addTranscript( { projectId: 'proj', memoId: '017-fresh', revisionId: 'REV-01', content: 'fresh body', memoPath: memoDir } )

            const { registry: fresh } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
            await fresh.scanMemo( { memoPath: memoDir, projectId: 'proj', memoId: '017-fresh' } )

            const { transcripts } = fresh.listTranscripts( { memoId: '017-fresh' } )
            const detail = await fresh.getTranscript( { transcriptId: transcripts[ 0 ]['transcriptId'] } )

            expect( detail['meta']['isLegacy'] ).toBe( false )
            expect( detail['meta']['schemaVersion'] ).toBe( 2 )
            fresh.shutdown()
        } )
    } )


    describe( 'Vollstaendigkeits-Flag (PRD-027)', () => {
        it( 'addTranscript without an explicit flag marks the entry as complete (echter Transcript)', async () => {
            const memoDir = join( tempDir, '018-complete' )
            await mkdir( memoDir, { recursive: true } )

            const add = await registry.addTranscript( {
                projectId: 'proj',
                memoId: '018-complete',
                revisionId: 'REV-01',
                content: 'real transcript text',
                memoPath: memoDir
            } )

            expect( add['status'] ).toBe( true )

            const { transcripts } = registry.listTranscripts( { memoId: '018-complete' } )

            expect( transcripts.length ).toBe( 1 )
            expect( transcripts[ 0 ]['complete'] ).toBe( true )
        } )


        it( 'addTranscript with complete:true is complete (explicit default echoes the implicit one)', async () => {
            const memoDir = join( tempDir, '022-complete' )
            await mkdir( memoDir, { recursive: true } )

            const add = await registry.addTranscript( {
                projectId: 'proj',
                memoId: '022-complete',
                revisionId: 'REV-01',
                content: 'real text',
                memoPath: memoDir,
                complete: true
            } )

            expect( add['status'] ).toBe( true )

            const { transcripts } = registry.listTranscripts( { memoId: '022-complete' } )

            expect( transcripts[ 0 ]['complete'] ).toBe( true )
        } )


        it( 'addTranscript with complete:false marks the entry as "nur Antworten" (nicht vollstaendig)', async () => {
            const memoDir = join( tempDir, '019-answers-only' )
            await mkdir( memoDir, { recursive: true } )

            const add = await registry.addTranscript( {
                projectId: 'proj',
                memoId: '019-answers-only',
                revisionId: 'REV-01',
                content: '## Antwort auf F1 — Titel\n\nA) Option',
                memoPath: memoDir,
                complete: false
            } )

            expect( add['status'] ).toBe( true )

            const { transcripts } = registry.listTranscripts( { memoId: '019-answers-only' } )

            expect( transcripts.length ).toBe( 1 )
            expect( transcripts[ 0 ]['complete'] ).toBe( false )
        } )


        it( 'listTranscripts exposes the complete flag per entry', async () => {
            const memoDir = join( tempDir, '020-mixed' )
            await mkdir( memoDir, { recursive: true } )

            await registry.addTranscript( { projectId: 'proj', memoId: '020-mixed', revisionId: 'REV-01', content: 'full', memoPath: memoDir } )
            await registry.addTranscript( { projectId: 'proj', memoId: '020-mixed', revisionId: 'REV-01', content: 'answers', memoPath: memoDir, complete: false } )

            const { transcripts } = registry.listTranscripts( { memoId: '020-mixed' } )

            expect( transcripts.length ).toBe( 2 )
            transcripts.forEach( ( t ) => {
                expect( typeof t['complete'] ).toBe( 'boolean' )
            } )
            const completes = transcripts.map( ( t ) => t['complete'] )

            expect( completes ).toContain( true )
            expect( completes ).toContain( false )
        } )


        it( 'scanMemo reconstructs the complete flag as true (existing files are real transcripts)', async () => {
            const memoDir = join( tempDir, '.memo', 'memos', '021-scan' )
            const transcriptsDir = join( memoDir, 'transcripts' )
            await mkdir( transcriptsDir, { recursive: true } )

            // PRD-001 (Memo 022): review schema is the transcript binding key on disk.
            await writeFile( join( transcriptsDir, 'REV-01--review--01.md' ), '# Some transcript on disk\n\nbody', 'utf-8' )

            const { registry: fresh } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
            const scan = await fresh.scanMemo( { memoPath: memoDir, projectId: 'proj', memoId: '021-scan' } )

            expect( scan['status'] ).toBe( true )
            expect( scan['registered'] ).toBe( 1 )

            const { transcripts } = fresh.listTranscripts( { memoId: '021-scan' } )

            expect( transcripts[ 0 ]['complete'] ).toBe( true )
            fresh.shutdown()
        } )
    } )


    describe( 'transformOtherTranscript frei -> memo-init (PRD-012)', () => {
        it( 'swaps the header to memo-init and preserves the body verbatim', async () => {
            const bodyText = 'Eine spontane Idee, die ein neues Memo werden koennte.'
            const add = await registry.addOtherTranscript( { projectId: 'idea-slug', content: bodyText, otherRoot: tempDir } )

            // Before: the free transcript carries the "frei" header.
            const beforeRaw = await readFile( add['absolutePath'], 'utf-8' )

            expect( beforeRaw ).toContain( '# Transcript (frei / undefiniert)' )

            const result = await registry.transformOtherTranscript( { transcriptId: add['transcriptId'], targetType: 'memo-init' } )

            expect( result['status'] ).toBe( true )
            expect( result['type'] ).toBe( 'memo-init' )

            const afterRaw = await readFile( add['absolutePath'], 'utf-8' )

            // After: memo-init header, body preserved.
            expect( afterRaw ).toContain( '# Transcript fuer neues Memo (memo-init)' )
            expect( afterRaw ).not.toContain( '# Transcript (frei / undefiniert)' )
            expect( afterRaw ).toContain( bodyText )

            // Re-Injection constraint (Kap 3): no memo number, no path, no revision fields.
            expect( afterRaw ).not.toMatch( /REV-\d+/ )
            expect( afterRaw ).not.toContain( 'Memo-Pfad:' )
            expect( afterRaw ).not.toContain( 'Vorherige Revision' )
        } )


        it( 'is idempotent — a second transform does not double-wrap', async () => {
            const add = await registry.addOtherTranscript( { projectId: 'idea2', content: 'idempotent body', otherRoot: tempDir } )

            await registry.transformOtherTranscript( { transcriptId: add['transcriptId'], targetType: 'memo-init' } )
            const firstRaw = await readFile( add['absolutePath'], 'utf-8' )

            const second = await registry.transformOtherTranscript( { transcriptId: add['transcriptId'], targetType: 'memo-init' } )
            const secondRaw = await readFile( add['absolutePath'], 'utf-8' )

            expect( second['status'] ).toBe( true )
            expect( secondRaw ).toBe( firstRaw )

            // exactly one memo-init header line
            const occurrences = secondRaw.split( '# Transcript fuer neues Memo (memo-init)' ).length - 1

            expect( occurrences ).toBe( 1 )
        } )


        it( 'updates the stored record type so listOtherTranscripts reflects memo-init', async () => {
            const add = await registry.addOtherTranscript( { projectId: 'idea3', content: 'list body', otherRoot: tempDir } )

            await registry.transformOtherTranscript( { transcriptId: add['transcriptId'], targetType: 'memo-init' } )

            const { transcripts } = registry.listOtherTranscripts( { otherRoot: tempDir } )
            const entry = transcripts.find( ( t ) => t['transcriptId'] === add['transcriptId'] )

            expect( entry['type'] ).toBe( 'memo-init' )
        } )


        it( 'rejects an unsupported target type', async () => {
            const add = await registry.addOtherTranscript( { projectId: 'idea4', content: 'x', otherRoot: tempDir } )

            const result = await registry.transformOtherTranscript( { transcriptId: add['transcriptId'], targetType: 'revision' } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'TRANSCRIPT-TRANSFORM-001' )
        } )


        it( 'returns NOTFOUND for an unknown transcriptId', async () => {
            const result = await registry.transformOtherTranscript( { transcriptId: 'nope--other--01', targetType: 'memo-init' } )

            expect( result['status'] ).toBe( false )
            expect( result['messages'][0] ).toContain( 'NOTFOUND' )
        } )


        it( 'survives a scan + transform round-trip after restart (type recovered from header)', async () => {
            const add = await registry.addOtherTranscript( { projectId: 'restart-idea', content: 'roundtrip body', otherRoot: tempDir } )

            await registry.transformOtherTranscript( { transcriptId: add['transcriptId'], targetType: 'memo-init' } )

            const { registry: fresh } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
            await fresh.scanOther( { otherRoot: tempDir } )

            const { transcripts } = fresh.listOtherTranscripts( { otherRoot: tempDir } )
            const entry = transcripts.find( ( t ) => t['transcriptId'] === add['transcriptId'] )

            expect( entry['type'] ).toBe( 'memo-init' )
            fresh.shutdown()
        } )
    } )


    // PRD-001 (Memo 022): Bindungsmodell — Dateiname = besprochene Revision. Every assertion here
    // would be RED under the old "erzeugt REV-(N+1)" binding (Memo-021-Muster).
    describe( 'Bindungsmodell — Dateiname = besprochene Revision (PRD-001 Memo 022)', () => {
        it( 'AC-1: feedback ZU REV-01 lands physically as REV-01--review--01.md (not REV-02.md)', async () => {
            const memoDir = join( tempDir, '022-bind' )
            await mkdir( memoDir, { recursive: true } )

            const add = await registry.addTranscript( {
                projectId: 'proj',
                memoId: '022-bind',
                revisionId: 'REV-01',
                content: 'Feedback zu REV-01',
                memoPath: memoDir
            } )

            expect( add['status'] ).toBe( true )
            expect( add['absolutePath'].endsWith( 'REV-01--review--01.md' ) ).toBe( true )
            // The old binding would have produced REV-02.md / REV-02--01.md — explicitly excluded.
            expect( add['absolutePath'].includes( 'REV-02' ) ).toBe( false )
        } )


        it( 'AC-2: after scanMemo the transcript has revisionId === REV-01 (discussed revision)', async () => {
            const memoDir = join( tempDir, '022-scan' )
            const transcriptsDir = join( memoDir, 'transcripts' )
            await mkdir( transcriptsDir, { recursive: true } )

            await writeFile( join( transcriptsDir, 'REV-01--review--01.md' ), '# T\n\nbody', 'utf-8' )

            const { registry: fresh } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
            const scan = await fresh.scanMemo( { memoPath: memoDir, projectId: 'proj', memoId: '022-scan' } )

            expect( scan['registered'] ).toBe( 1 )

            const { transcripts } = fresh.listTranscripts( { memoId: '022-scan' } )

            expect( transcripts[ 0 ]['revisionId'] ).toBe( 'REV-01' )
            expect( transcripts[ 0 ]['sequence'] ).toBe( '01' )
            fresh.shutdown()
        } )


        it( 'AC-5: multiple reviews of REV-01 increment sequence (review--01, --02), all bound to REV-01', async () => {
            const memoDir = join( tempDir, '022-multi' )
            await mkdir( memoDir, { recursive: true } )

            const first = await registry.addTranscript( { projectId: 'proj', memoId: '022-multi', revisionId: 'REV-01', content: 'erstes Feedback', memoPath: memoDir } )
            const second = await registry.addTranscript( { projectId: 'proj', memoId: '022-multi', revisionId: 'REV-01', content: 'zweites Feedback', memoPath: memoDir } )

            expect( first['absolutePath'].endsWith( 'REV-01--review--01.md' ) ).toBe( true )
            expect( second['absolutePath'].endsWith( 'REV-01--review--02.md' ) ).toBe( true )

            const { transcripts } = registry.listTranscripts( { memoId: '022-multi' } )
            const revIds = transcripts.map( ( t ) => t['revisionId'] )

            expect( revIds ).toEqual( [ 'REV-01', 'REV-01' ] )
        } )


        it( 'AC-6: init.md is scanned as a separate transcript WITHOUT revisionId (never REV-bound)', async () => {
            const memoDir = join( tempDir, '022-init-scan' )
            const transcriptsDir = join( memoDir, 'transcripts' )
            await mkdir( transcriptsDir, { recursive: true } )

            await writeFile( join( transcriptsDir, 'init.md' ), '# Transcript fuer neues Memo (memo-init)\n\nidea', 'utf-8' )

            const { registry: fresh } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
            const scan = await fresh.scanMemo( { memoPath: memoDir, projectId: 'proj', memoId: '022-init-scan' } )

            expect( scan['registered'] ).toBe( 1 )

            // init.md must NOT appear as a revision transcript.
            const { transcripts: revTranscripts } = fresh.listTranscripts( { memoId: '022-init-scan' } )

            expect( revTranscripts.length ).toBe( 0 )

            // It lives in the other-map with no revisionId, tagged memo-init.
            const { transcripts: others } = fresh.listOtherTranscripts( {} )
            const initEntry = others.find( ( t ) => t['transcriptId'] === 'proj--022-init-scan--init' )

            expect( initEntry ).toBeDefined()
            expect( initEntry['revisionId'] ).toBeUndefined()
            expect( initEntry['type'] ).toBe( 'memo-init' )
            fresh.shutdown()
        } )


        it( 'AC-7: addInitTranscript writes memo-init-transcript.md and does NOT overwrite an existing one', async () => {
            const memoDir = join( tempDir, '022-init-write' )
            await mkdir( memoDir, { recursive: true } )

            const first = await registry.addInitTranscript( { projectId: 'proj', memoId: '022-init-write', content: 'original idea', memoPath: memoDir } )

            expect( first['status'] ).toBe( true )
            // PRD-004 (Memo 054 Kap 2): canonical filename is memo-init-transcript.md
            expect( first['absolutePath'].endsWith( 'memo-init-transcript.md' ) ).toBe( true )
            expect( first['transcriptId'] ).toBe( 'proj--022-init-write--init' )

            const originalRaw = await readFile( first['absolutePath'], 'utf-8' )

            // NO-OVERWRITE: a second call must fail with a SEQ message and leave the file intact.
            const second = await registry.addInitTranscript( { projectId: 'proj', memoId: '022-init-write', content: 'DIFFERENT idea', memoPath: memoDir } )

            expect( second['status'] ).toBe( false )
            expect( second['messages'][0] ).toContain( 'TRANSCRIPT-SEQ-001' )

            const afterRaw = await readFile( first['absolutePath'], 'utf-8' )

            expect( afterRaw ).toBe( originalRaw )
            expect( afterRaw ).not.toContain( 'DIFFERENT idea' )
        } )


        it( 'AC-9 (Forensik): review of REV-N is bound to REV-N, never to a phantom REV-(N+1)', async () => {
            const memoDir = join( tempDir, '022-forensik' )
            await mkdir( memoDir, { recursive: true } )

            // Three reviews of REV-01 (the Memo-021 pattern: 3 identical reviews). All must bind REV-01.
            await registry.addTranscript( { projectId: 'proj', memoId: '022-forensik', revisionId: 'REV-01', content: 'a', memoPath: memoDir } )
            await registry.addTranscript( { projectId: 'proj', memoId: '022-forensik', revisionId: 'REV-01', content: 'b', memoPath: memoDir } )
            await registry.addTranscript( { projectId: 'proj', memoId: '022-forensik', revisionId: 'REV-01', content: 'c', memoPath: memoDir } )

            const { transcripts } = registry.listTranscripts( { memoId: '022-forensik' } )

            expect( transcripts.length ).toBe( 3 )
            expect( transcripts.every( ( t ) => t['revisionId'] === 'REV-01' ) ).toBe( true )
            // No transcript bound to a phantom REV-02.
            expect( transcripts.some( ( t ) => t['revisionId'] === 'REV-02' ) ).toBe( false )
        } )
    } )
} )
