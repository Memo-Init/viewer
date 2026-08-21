// Serve-E2E (Memo 079, P6b — PRD-22, WI-045/046): boot the REAL memo-view server TWICE against a temp
// workbench and prove the persistent-dismiss contract over real HTTP — no mocks, no reach into private
// statics. Proves that:
//   (boot 1)  the session-config projects[] gate AUTO-REGISTERS the memo; it shows in the queue.
//   (DELETE)  DELETE /api/documents/<id> answers 200 AND writes the dismissal into the on-disk ledger.
//   (boot 2)  a fresh server (= restart) auto-registers the memo again but the BOOT PRUNE reads the
//             ledger and drops it — the dismissed Karteileiche does NOT come back (queue + list empty).
// Run: MEMOVIEW_NO_BROWSER=1 node tests/manual/dismiss-persist-e2e.mjs  → exits 0 on success, 1 on fail.
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'


const PORT_ONE = 47921
const PORT_TWO = 47922
const results = []

const check = ( label, condition ) => {
    results.push( { label, ok: condition === true } )
    process.stdout.write( `  ${ condition === true ? 'PASS' : 'FAIL' }  ${ label }\n` )
}


const revBody = [
    '# Karteileiche', '',
    '| Feld | Wert |', '| --- | --- |', '| **Status** | In Bearbeitung |', '',
    '## Offene Fragen', '', '### F1 — Eine offene Frage', '', 'Kontext.', ''
].join( '\n' )


const listDocIds = async ( { port } ) => {
    const resp = await fetch( `http://localhost:${ port }/api/documents` )
    const body = await resp.json()
    const docs = Array.isArray( body.documents ) ? body.documents : []

    return docs.map( ( d ) => d.documentId )
}


const main = async () => {
    process.env[ 'MEMOVIEW_NO_BROWSER' ] = '1'

    const workbench = await mkdtemp( join( tmpdir(), 'dismiss-persist-' ) )
    process.chdir( workbench )

    // A project 'proj' with one memo carrying an OPEN question (so it enters the queue).
    const projectRoot = join( workbench, 'proj' )
    const memoDir = join( projectRoot, '.memo', 'memos', '079-x' )
    await mkdir( join( memoDir, 'revisions' ), { recursive: true } )
    writeFileSync( join( memoDir, 'revisions', 'REV-01.md' ), revBody )

    // The session-config projects[] gate points at that project so BOTH boots auto-register it.
    const sessionsDir = join( workbench, '.sessions' )
    await mkdir( sessionsDir, { recursive: true } )
    const configPath = join( sessionsDir, 'config.json' )
    writeFileSync( configPath, JSON.stringify( {
        projects: [ { projectId: 'proj', projectRoot } ],
        folderTabs: [ { id: 'specs', folder: 'spec', view: 'spec' } ]
    } ) )

    const dismissStore = join( sessionsDir, 'memo-view-dismissed.json' )
    process.env[ 'MEMOVIEW_SESSION_CONFIG' ] = configPath
    process.env[ 'MEMOVIEW_DISMISS_STORE' ] = dismissStore

    // documentId = <basename(projectRoot)>--<memoName> (ProjectAutoRegister derives from the folder).
    const documentId = 'proj--079-x'

    // ---- boot 1 ----
    await MemoView.startServer( { port: PORT_ONE } )
    const idsBoot1 = await listDocIds( { port: PORT_ONE } )
    check( 'boot 1: the memo is auto-registered from projects[]', idsBoot1.includes( documentId ) )

    // PRD-23: the declarative folderTabs are surfaced on the /api/index snapshot.
    const indexBoot1 = await ( await fetch( `http://localhost:${ PORT_ONE }/api/index` ) ).json()
    check( 'boot 1: /api/index surfaces the resolved folderTabs', Array.isArray( indexBoot1.folderTabs ) && indexBoot1.folderTabs.length === 1 && indexBoot1.folderTabs[ 0 ].id === 'specs' )

    // ---- DELETE: dismiss the memo ----
    const delResp = await fetch( `http://localhost:${ PORT_ONE }/api/documents/${ documentId }`, { method: 'DELETE' } )
    check( 'DELETE answers 200', delResp.status === 200 )

    const ledgerRaw = await readFile( dismissStore, 'utf8' ).catch( () => null )
    const ledger = ledgerRaw !== null ? JSON.parse( ledgerRaw ) : { dismissed: [] }
    check( 'the dismissal is persisted to the on-disk ledger', ledger.dismissed.some( ( e ) => e.documentId === documentId ) )

    const idsAfterDelete = await listDocIds( { port: PORT_ONE } )
    check( 'after DELETE the memo is gone from the live list', idsAfterDelete.includes( documentId ) === false )

    // ---- boot 2 (a real restart on a fresh port): auto-register again, then the boot prune runs ----
    await MemoView.startServer( { port: PORT_TWO } )
    const idsBoot2 = await listDocIds( { port: PORT_TWO } )
    check( 'boot 2: the dismissed memo does NOT come back (boot prune from the ledger)', idsBoot2.includes( documentId ) === false )

    await rm( workbench, { recursive: true, force: true } )

    const failed = results.filter( ( r ) => !r.ok )
    process.stdout.write( `\n  ${ results.length - failed.length }/${ results.length } checks passed\n\n` )
    process.exit( failed.length === 0 ? 0 : 1 )
}


main().catch( ( err ) => {
    process.stderr.write( `ERROR: ${ err.stack || err.message }\n` )
    process.exit( 1 )
} )
