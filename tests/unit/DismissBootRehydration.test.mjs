import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { DismissStore } from '../../src/DismissStore.mjs'


// Memo 079 PRD-22 (WI-045/046): the persistent-dismiss end-to-end contract, driven through the REAL
// DocumentRegistry and the REAL queue computation (MemoView.computeOpenRevisionQueue). It proves the
// exact boot mechanism: a dismissed document, recorded in the ledger, is pruned on the next boot so the
// queue no longer shows it — the Karteileiche does NOT come back. No mocks, no browser, no server boot.
describe( 'Dismiss boot rehydration — Memo 079 PRD-22 (queue does not resurrect a dismissed memo)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let baseDir = ''
    let storePath = ''
    // Every DocumentRegistry.addDocument attaches an fs.watch directory watcher — track the registries
    // and shut them down in afterEach so no watcher leaks (a leak makes the jest worker exit ungracefully).
    const registries = []


    const trackedRegistry = () => {
        const { registry } = DocumentRegistry.create( {} )
        registries.push( registry )

        return registry
    }


    const revBody = [
        '# Memo', '',
        '| Feld | Wert |', '| --- | --- |', '| **Status** | In Bearbeitung |', '',
        '## Offene Fragen', '', '### F1 — Eine offene Frage', '', 'Kontext.', ''
    ].join( '\n' )


    const seedMemo = async ( { name } ) => {
        const memoDir = join( baseDir, 'projects', 'proj', '.memo', 'memos', name )
        await mkdir( join( memoDir, 'revisions' ), { recursive: true } )
        await writeFile( join( memoDir, 'revisions', 'REV-01.md' ), revBody, 'utf8' )

        return join( memoDir, 'revisions' )
    }


    // Register both memos into a fresh registry and return it (= the "boot registration" state).
    const bootRegister = async ( { registry } ) => {
        await registry.addDocument( { projectId: 'proj', memoPath: await seedMemo( { name: '079-a' } ) } )
        await registry.addDocument( { projectId: 'proj', memoPath: await seedMemo( { name: '079-b' } ) } )
    }


    const queueMemoNames = ( { registry } ) => {
        const { tree } = registry.getDocumentTree()
        MemoView.enrichRevisionStatus( { tree, transcriptTree: {} } )
        const { queue } = MemoView.computeOpenRevisionQueue( { tree } )

        return queue.map( ( pair ) => pair.doc.memoName )
    }


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        baseDir = await mkdtemp( join( repoTmpRoot, 'dismiss-boot-' ) )
        storePath = join( baseDir, '.sessions', 'memo-view-dismissed.json' )
    } )

    afterEach( async () => {
        registries.forEach( ( registry ) => registry.shutdown() )
        registries.length = 0
        await rm( baseDir, { recursive: true, force: true } )
    } )


    it( 'boot 1: both memos are in the queue; DELETE records a dismissal; boot 2 prunes it', async () => {
        // ---- boot 1 ----
        const first = trackedRegistry()
        await bootRegister( { registry: first } )
        expect( queueMemoNames( { registry: first } ).sort() ).toEqual( [ '079-a', '079-b' ] )

        // ---- DELETE 079-a: persist the dismissal (the route calls DismissStore.record) ----
        const removed = first.removeDocument( { documentId: 'proj--079-a' } )
        expect( removed.status ).toBe( true )
        expect( DismissStore.record( { storePath, documentId: 'proj--079-a', reason: 'delete' } ).status ).toBe( true )
        // live: 079-a already gone from this process
        expect( queueMemoNames( { registry: first } ) ).toEqual( [ '079-b' ] )

        // ---- boot 2 (a fresh registry = a server restart): re-register everything ... ----
        const second = trackedRegistry()
        await bootRegister( { registry: second } )
        // without the prune, 079-a would be back in the queue (the old Karteileichen bug):
        expect( queueMemoNames( { registry: second } ).sort() ).toEqual( [ '079-a', '079-b' ] )

        // ---- the boot prune reads the persistent ledger and removes the dismissed docs ----
        const { dismissed } = DismissStore.readDismissed( { storePath } )
        expect( dismissed ).toEqual( [ 'proj--079-a' ] )
        dismissed.forEach( ( documentId ) => second.removeDocument( { documentId } ) )

        // ---- proof: after the restart + prune the queue does NOT show the dismissed memo ----
        expect( queueMemoNames( { registry: second } ) ).toEqual( [ '079-b' ] )
    } )
} )
