import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// Memo 079 PRD-22 #5 (WI-045/046): the boot Altbestand-Sweep. StaleQueueSweep derives per-revision
// completion facts from DISK ALONE; MemoView.sweepStaleQueueEntries marks every fully-resolved memo
// (no honestly-open revision) 'done' so its stale queue entries leave the queue after a restart, while
// the document stays visible in the sidebar (queue-only). Driven through the REAL DocumentRegistry +
// the REAL queue computation, mirroring DismissBootRehydration — no mocks, no server boot. Writes go
// ONLY into a repo-internal temp dir (.test-tmp/), never the real .memo/ or the user home.
describe( 'Boot Altbestand-Sweep — Memo 079 PRD-22 #5 (StaleQueueSweep wired into boot)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let root = ''
    const registries = []


    const trackedRegistry = () => {
        const { registry } = DocumentRegistry.create( {} )
        registries.push( registry )

        return registry
    }


    const revBody = ( { status } ) => [
        '# Memo', '',
        '| Feld | Wert |', '| --- | --- |', `| **Status** | ${ status } |`, '',
        '## Offene Fragen', '', '### F1 — Eine offene Frage', '', 'Kontext.', ''
    ].join( '\n' )


    // Seed a memo folder. `loggedIn` drops a `<REV>.loggedin` sidecar (the Widget "Abschliessen" disk
    // fact) so the sweep classifies the head logged-in. Returns the revisions/ path addDocument expects.
    const seedMemo = async ( { name, status, loggedIn } ) => {
        const memoDir = join( root, 'projects', 'proj', '.memo', 'memos', name )
        const revDir = join( memoDir, 'revisions' )
        await mkdir( revDir, { recursive: true } )
        await writeFile( join( revDir, 'REV-01.md' ), revBody( { status: status || 'In Bearbeitung' } ), 'utf8' )

        if( loggedIn === true ) {
            await mkdir( join( memoDir, 'transcripts' ), { recursive: true } )
            await writeFile( join( memoDir, 'transcripts', 'REV-01.loggedin' ), '', 'utf8' )
        }

        return revDir
    }


    const queueMemoNames = ( { registry } ) => {
        const { tree } = registry.getDocumentTree()
        MemoView.enrichRevisionStatus( { tree, transcriptTree: {} } )
        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

        return queue.map( ( pair ) => pair.doc.memoName )
    }


    const statusOf = ( { registry, documentId } ) => {
        const { document } = registry.getDocument( { documentId } )

        return document === null ? null : document.status
    }


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        root = await mkdtemp( join( repoTmpRoot, 'stale-sweep-boot-' ) )
    } )

    afterEach( async () => {
        registries.forEach( ( registry ) => registry.shutdown() )
        registries.length = 0
        await rm( root, { recursive: true, force: true } )
    } )


    it( 'marks a fully-resolved (logged-in on disk) memo done and sweeps it from the queue; an open memo survives', async () => {
        const registry = trackedRegistry()
        await registry.addDocument( { projectId: 'proj', memoPath: await seedMemo( { name: '079-stale', loggedIn: true } ) } )
        await registry.addDocument( { projectId: 'proj', memoPath: await seedMemo( { name: '079-open', loggedIn: false } ) } )

        // ---- boot sweep (the mechanism the boot path runs after the dismiss prune) ----
        const { swept } = MemoView.sweepStaleQueueEntries( { registry } )

        expect( swept ).toEqual( [ 'proj--079-stale' ] )
        expect( statusOf( { registry, documentId: 'proj--079-stale' } ) ).toBe( 'done' )
        expect( statusOf( { registry, documentId: 'proj--079-open' } ) ).toBe( 'open' )

        // The stale memo left the queue; the open one survives. (It stays in the sidebar tree.)
        expect( queueMemoNames( { registry } ) ).toEqual( [ '079-open' ] )
    } )


    it( 'also sweeps a finalized memo (all revisions resolved), never an honestly-open one', async () => {
        const registry = trackedRegistry()
        await registry.addDocument( { projectId: 'proj', memoPath: await seedMemo( { name: '079-final', status: 'Finalisiert' } ) } )
        await registry.addDocument( { projectId: 'proj', memoPath: await seedMemo( { name: '079-work', status: 'In Bearbeitung' } ) } )

        const { swept } = MemoView.sweepStaleQueueEntries( { registry } )

        expect( swept ).toEqual( [ 'proj--079-final' ] )
        expect( statusOf( { registry, documentId: 'proj--079-work' } ) ).toBe( 'open' )
        expect( queueMemoNames( { registry } ) ).toEqual( [ '079-work' ] )
    } )


    it( 'is idempotent and returns an empty result when nothing is stale', async () => {
        const registry = trackedRegistry()
        await registry.addDocument( { projectId: 'proj', memoPath: await seedMemo( { name: '079-open-a' } ) } )
        await registry.addDocument( { projectId: 'proj', memoPath: await seedMemo( { name: '079-open-b' } ) } )

        expect( MemoView.sweepStaleQueueEntries( { registry } ).swept ).toEqual( [] )
        expect( queueMemoNames( { registry } ).sort() ).toEqual( [ '079-open-a', '079-open-b' ] )
    } )


    it( 'tolerates a missing/invalid registry (no throw, empty result)', () => {
        expect( MemoView.sweepStaleQueueEntries( {} ) ).toEqual( { swept: [] } )
        expect( MemoView.sweepStaleQueueEntries( { registry: {} } ) ).toEqual( { swept: [] } )
    } )
} )
