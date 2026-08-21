import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { StaleQueueSweep } from '../../src/StaleQueueSweep.mjs'


// Memo 079 PRD-22 (WI-045/046): the F18 Altbestand-Sweep derives per-revision completion facts from
// DISK ALONE — deterministic, honest, never inventing a "done". This suite uses a repo-internal fixture
// tree (.test-tmp/), never a real .memo. Rules: a newer non-prepare revision exists = superseded; a
// `.loggedin` sidecar = logged-in; a Finalisiert status = finalized; else honestly open.
describe( 'StaleQueueSweep — Memo 079 PRD-22 (disk-derived completion facts)', () => {
    const repoTmpRoot = join( process.cwd(), '.test-tmp' )
    let memoDir = ''


    const revFile = ( { status } ) => [
        '# Test-Memo', '',
        '| Feld | Wert |', '| --- | --- |',
        `| **Status** | ${ status } |`, '',
        '## Offene Fragen', '',
        '### F1 — Eine Frage', ''
    ].join( '\n' )


    const seed = async ( { files, transcripts } ) => {
        await mkdir( join( memoDir, 'revisions' ), { recursive: true } )
        await Promise.all( Object.keys( files ).map( ( name ) => writeFile( join( memoDir, 'revisions', name ), files[ name ], 'utf8' ) ) )

        const sidecars = Array.isArray( transcripts ) ? transcripts : []
        if( sidecars.length > 0 ) {
            await mkdir( join( memoDir, 'transcripts' ), { recursive: true } )
            await Promise.all( sidecars.map( ( name ) => writeFile( join( memoDir, 'transcripts', name ), '', 'utf8' ) ) )
        }
    }


    beforeEach( async () => {
        await mkdir( repoTmpRoot, { recursive: true } )
        memoDir = await mkdtemp( join( repoTmpRoot, 'sweep-' ) )
    } )

    afterEach( async () => {
        await rm( memoDir, { recursive: true, force: true } )
    } )


    it( 'marks an older revision superseded when a newer non-prepare revision exists (Folge-REV = erledigt)', async () => {
        await seed( { files: {
            'REV-01.md': revFile( { status: 'In Bearbeitung' } ),
            'REV-02.md': revFile( { status: 'In Bearbeitung' } ),
            'REV-03-prepare.md': revFile( { status: 'In Bearbeitung' } )
        } } )

        const { status, entries, summary } = StaleQueueSweep.sweepMemo( { memoDir } )
        expect( status ).toBe( true )

        // prepare revisions are excluded entirely; REV-01 superseded, REV-02 the honest open head.
        const byId = Object.fromEntries( entries.map( ( e ) => [ e.revisionId, e ] ) )
        expect( byId[ 'REV-01' ].disposition ).toBe( 'superseded' )
        expect( byId[ 'REV-02' ].disposition ).toBe( 'open' )
        expect( entries.some( ( e ) => e.revisionId === 'REV-03' ) ).toBe( false )
        expect( summary ).toMatchObject( { total: 2, superseded: 1, open: 1 } )
    } )


    it( 'marks a revision logged-in when its .loggedin sidecar is present on disk', async () => {
        await seed( {
            files: { 'REV-01.md': revFile( { status: 'In Bearbeitung' } ) },
            transcripts: [ 'REV-01.loggedin' ]
        } )

        const { entries, summary } = StaleQueueSweep.sweepMemo( { memoDir } )
        expect( entries[ 0 ].disposition ).toBe( 'logged-in' )
        expect( entries[ 0 ].resolved ).toBe( true )
        expect( summary.loggedIn ).toBe( 1 )
    } )


    it( 'marks a single unfinished revision honestly OPEN — no completion fact invented', async () => {
        await seed( { files: { 'REV-01.md': revFile( { status: 'In Bearbeitung' } ) } } )

        const { entries } = StaleQueueSweep.sweepMemo( { memoDir } )
        expect( entries.length ).toBe( 1 )
        expect( entries[ 0 ].disposition ).toBe( 'open' )
        expect( entries[ 0 ].resolved ).toBe( false )
    } )


    it( 'marks all revisions finalized when the newest full revision carries a Finalisiert status', async () => {
        await seed( { files: { 'REV-01.md': revFile( { status: 'Finalisiert' } ) } } )

        const { entries } = StaleQueueSweep.sweepMemo( { memoDir } )
        expect( entries[ 0 ].disposition ).toBe( 'finalized' )
    } )


    it( 'accepts either the memo dir or its revisions/ subfolder', async () => {
        await seed( { files: { 'REV-01.md': revFile( { status: 'In Bearbeitung' } ) } } )

        const viaRevisions = StaleQueueSweep.sweepMemo( { memoDir: join( memoDir, 'revisions' ) } )
        expect( viaRevisions.status ).toBe( true )
        expect( viaRevisions.entries.length ).toBe( 1 )
    } )


    it( 'fails with a message when no revisions/ folder exists (fail-loud, no crash)', async () => {
        const { status, messages } = StaleQueueSweep.sweepMemo( { memoDir } )
        expect( status ).toBe( false )
        expect( messages.join( ' ' ) ).toMatch( /revisions/ )
    } )
} )
