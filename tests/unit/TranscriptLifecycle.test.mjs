import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'
import { MemoView } from '../../src/MemoView.mjs'


// PRD-005 (Memo 018 Kap 8): Transcript-Lebenszyklus & manuelles Einloggen.
// Verifies logInTranscript / logOutTranscript state transitions, idempotency, undo,
// sidecar persistence, boot reconstruction and the EVENT-HOOK callback emission.
describe( 'TranscriptRegistry login/logout lifecycle (PRD-005)', () => {
    let tempDir


    beforeEach( async () => {
        tempDir = await mkdtemp( join( tmpdir(), 'transcript-lifecycle-' ) )
    } )


    afterEach( async () => {
        await rm( tempDir, { recursive: true, force: true } )
    } )


    const addOne = async ( { registry, memoDir } ) => {
        const result = await registry.addTranscript( {
            projectId: 'proj',
            memoId: '018-feature',
            revisionId: 'REV-01',
            content: 'Some transcript body',
            memoPath: memoDir
        } )

        return result
    }


    it( 'TL-01: logInTranscript sets loggedIn true in the in-memory object', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )
        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        await addOne( { registry, memoDir } )
        const result = await registry.logInTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )

        expect( result.status ).toBe( true )

        const { transcripts } = registry.listTranscripts( { memoId: '018-feature' } )

        expect( transcripts[ 0 ].loggedIn ).toBe( true )

        registry.shutdown()
    } )


    it( 'TL-02: logInTranscript writes the sidecar marker file', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )
        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        await addOne( { registry, memoDir } )
        await registry.logInTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )

        const markerPath = resolve( memoDir, 'transcripts', 'REV-01.loggedin' )
        const exists = await access( markerPath ).then( () => true ).catch( () => false )

        expect( exists ).toBe( true )

        registry.shutdown()
    } )


    it( 'TL-03: logOutTranscript sets loggedIn false', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )
        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        await addOne( { registry, memoDir } )
        await registry.logInTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )
        const result = await registry.logOutTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )

        expect( result.status ).toBe( true )

        const { transcripts } = registry.listTranscripts( { memoId: '018-feature' } )

        expect( transcripts[ 0 ].loggedIn ).toBe( false )

        registry.shutdown()
    } )


    it( 'TL-04: logOutTranscript removes the sidecar marker file', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )
        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        await addOne( { registry, memoDir } )
        await registry.logInTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )
        await registry.logOutTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )

        const markerPath = resolve( memoDir, 'transcripts', 'REV-01.loggedin' )
        const exists = await access( markerPath ).then( () => true ).catch( () => false )

        expect( exists ).toBe( false )

        registry.shutdown()
    } )


    it( 'TL-05: boot reconstruction restores loggedIn true from the sidecar', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )

        const first = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        await addOne( { registry: first.registry, memoDir } )
        await first.registry.logInTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )
        first.registry.shutdown()

        // Fresh registry simulates a server restart: scanMemo reads the sidecar marker.
        const second = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        await second.registry.scanMemo( { memoPath: memoDir, projectId: 'proj', memoId: '018-feature' } )

        const { transcripts } = second.registry.listTranscripts( { memoId: '018-feature' } )

        expect( transcripts.length ).toBe( 1 )
        expect( transcripts[ 0 ].loggedIn ).toBe( true )

        second.registry.shutdown()
    } )


    it( 'TL-05b: boot reconstruction yields loggedIn false without a sidecar', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )

        const first = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        await addOne( { registry: first.registry, memoDir } )
        first.registry.shutdown()

        const second = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )
        await second.registry.scanMemo( { memoPath: memoDir, projectId: 'proj', memoId: '018-feature' } )

        const { transcripts } = second.registry.listTranscripts( { memoId: '018-feature' } )

        expect( transcripts[ 0 ].loggedIn ).toBe( false )

        second.registry.shutdown()
    } )


    it( 'TL-06: logInTranscript on an unknown revision returns status false', async () => {
        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        const result = await registry.logInTranscript( { revisionId: 'REV-99', memoId: '018-feature' } )

        expect( result.status ).toBe( false )
        expect( result.messages.join( ' ' ) ).toContain( 'NOTFOUND' )

        registry.shutdown()
    } )


    it( 'TL-07: logOutTranscript on an already logged-out revision is idempotent', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )
        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        await addOne( { registry, memoDir } )

        // Never logged in — logout must still succeed (idempotent undo).
        const result = await registry.logOutTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )

        expect( result.status ).toBe( true )

        const { transcripts } = registry.listTranscripts( { memoId: '018-feature' } )

        expect( transcripts[ 0 ].loggedIn ).toBe( false )

        registry.shutdown()
    } )


    it( 'TL-07b: logInTranscript twice is idempotent (loggedIn stays true)', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )
        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        await addOne( { registry, memoDir } )
        await registry.logInTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )
        const second = await registry.logInTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )

        expect( second.status ).toBe( true )

        const { transcripts } = registry.listTranscripts( { memoId: '018-feature' } )

        expect( transcripts[ 0 ].loggedIn ).toBe( true )

        registry.shutdown()
    } )


    it( 'TL-08: onChange callback receives event transcriptLoggedIn', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )

        const events = []
        const onChange = ( payload ) => { events.push( payload ) }
        const { registry } = TranscriptRegistry.create( { onChange, host: 'http://localhost:3333' } )

        await addOne( { registry, memoDir } )
        await registry.logInTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )

        const loginEvent = events.find( ( e ) => e.event === 'transcriptLoggedIn' )

        expect( loginEvent ).toBeDefined()
        expect( loginEvent.revisionId ).toBe( 'REV-01' )
        expect( loginEvent.memoId ).toBe( '018-feature' )

        registry.shutdown()
    } )


    it( 'TL-09: onChange callback receives event transcriptLoggedOut', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )

        const events = []
        const onChange = ( payload ) => { events.push( payload ) }
        const { registry } = TranscriptRegistry.create( { onChange, host: 'http://localhost:3333' } )

        await addOne( { registry, memoDir } )
        await registry.logInTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )
        await registry.logOutTranscript( { revisionId: 'REV-01', memoId: '018-feature' } )

        const logoutEvent = events.find( ( e ) => e.event === 'transcriptLoggedOut' )

        expect( logoutEvent ).toBeDefined()
        expect( logoutEvent.revisionId ).toBe( 'REV-01' )

        registry.shutdown()
    } )


    it( 'addTranscript seeds loggedIn false by default', async () => {
        const memoDir = join( tempDir, '018-feature' )
        await mkdir( memoDir, { recursive: true } )
        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        await addOne( { registry, memoDir } )

        const { transcripts } = registry.listTranscripts( { memoId: '018-feature' } )

        expect( transcripts[ 0 ].loggedIn ).toBe( false )

        registry.shutdown()
    } )
} )


// PRD-001 (Memo 022): end-to-end binding — add review to REV-N -> scan -> tree -> MemoView JOIN.
// Every assertion would be RED under the old "erzeugt REV-(N+1)" binding (Memo-021-Muster).
describe( 'Bindungsmodell end-to-end add -> scan -> enrich (PRD-001 Memo 022)', () => {
    let tempDir


    beforeEach( async () => {
        tempDir = await mkdtemp( join( tmpdir(), 'transcript-bind-e2e-' ) )
    } )


    afterEach( async () => {
        await rm( tempDir, { recursive: true, force: true } )
    } )


    it( 'AC-3 + AC-4: review of REV-01 is bound to REV-01 in tree, JOIN sets REV-01 transcript-eingetragen, REV-02 stays offen', async () => {
        const memoDir = join( tempDir, '022-e2e' )
        await mkdir( memoDir, { recursive: true } )

        const { registry } = TranscriptRegistry.create( { onChange: null, host: 'http://localhost:3333' } )

        // Feedback ZU REV-01 — bound to REV-01, physical file REV-01--review--01.md.
        await registry.addTranscript( { projectId: 'ns', memoId: '022-e2e', revisionId: 'REV-01', content: 'feedback to REV-01', memoPath: memoDir } )

        const { tree: transcriptTree } = registry.getTranscriptTree()

        // AC-3: transcriptsForRevision REV-01 finds it; REV-02 does not.
        const { transcripts: forRev01 } = MemoView.transcriptsForRevision( { transcriptTree, memoName: '022-e2e', revisionId: 'REV-01' } )
        const { transcripts: forRev02 } = MemoView.transcriptsForRevision( { transcriptTree, memoName: '022-e2e', revisionId: 'REV-02' } )

        expect( forRev01.length ).toBe( 1 )
        expect( forRev02.length ).toBe( 0 )

        // AC-4: enrichRevisionStatus marks the REV-01.md revision transcript-eingetragen, REV-02 offen.
        const docTree = {
            ns: { memos: [
                {
                    documentId: 'ns--022-e2e',
                    projectId: 'ns',
                    memoName: '022-e2e',
                    revisions: [
                        { fileName: 'REV-01.md', revisionStatus: 'offen' },
                        { fileName: 'REV-02.md', revisionStatus: 'offen' }
                    ]
                }
            ] }
        }

        MemoView.enrichRevisionStatus( { tree: docTree, transcriptTree } )

        const byFile = {}
        docTree.ns.memos[ 0 ].revisions.forEach( ( r ) => { byFile[ r.fileName ] = r.revisionStatus } )

        expect( byFile[ 'REV-01.md' ] ).toBe( 'transcript-eingetragen' )
        expect( byFile[ 'REV-02.md' ] ).toBe( 'offen' )

        registry.shutdown()
    } )
} )
