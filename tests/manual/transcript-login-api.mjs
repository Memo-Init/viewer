// Manual integration verification (PRD-005, Memo 018 Kap 8): boot the real memo-view server
// against a temp .memo tree, POST a transcript, then exercise the login/logout endpoints over
// real HTTP and assert the WebSocket transcriptLoggedIn broadcast. Run with:
//   node tests/manual/transcript-login-api.mjs
// Exits 0 on success, 1 on any failed assertion.
import { WebSocket } from 'ws'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'


const PORT = 4455
const results = []


const check = ( label, condition ) => {
    results.push( { label, ok: condition === true } )
    process.stdout.write( `  ${ condition === true ? 'PASS' : 'FAIL' }  ${ label }\n` )
}


const main = async () => {
    const tempDir = await mkdtemp( join( tmpdir(), 'login-api-' ) )
    const memoDir = join( tempDir, '.memo', 'memos', '018-feature' )
    await mkdir( memoDir, { recursive: true } )

    // The server resolves transcripts/ relative to process.cwd() when no memoPath is given,
    // so run from the temp root.
    process.chdir( tempDir )

    await MemoView.startServer( { port: PORT } )

    // 1) Register a transcript via the existing POST endpoint.
    const addResp = await fetch( `http://localhost:${ PORT }/api/transcripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( {
            projectId: 'proj',
            memoId: '018-feature',
            revisionId: 'REV-01',
            content: 'Integration transcript body',
            memoPath: memoDir
        } )
    } )
    const addBody = await addResp.json()
    check( 'POST /api/transcripts returns 200 + transcriptId', addResp.status === 200 && typeof addBody.transcriptId === 'string' )

    const transcriptId = addBody.transcriptId

    // 2) Subscribe to the WebSocket to observe the transcriptLoggedIn broadcast (AC-7).
    const ws = new WebSocket( `ws://localhost:${ PORT }/` )
    const wsEvents = []
    ws.on( 'message', ( raw ) => {
        try { wsEvents.push( JSON.parse( raw.toString() ).type ) } catch {}
    } )
    await new Promise( ( res ) => ws.on( 'open', res ) )

    // 3) TL-10: login -> 200 { status: 'ok' }.
    const loginResp = await fetch( `http://localhost:${ PORT }/api/transcripts/${ transcriptId }/login`, { method: 'POST' } )
    const loginBody = await loginResp.json()
    check( 'TL-10: POST /login returns 200 { status: ok }', loginResp.status === 200 && loginBody.status === 'ok' )

    // 4) TL-11: login on an unknown id -> 404.
    const notFoundResp = await fetch( `http://localhost:${ PORT }/api/transcripts/proj--018-feature--REV-99/login`, { method: 'POST' } )
    check( 'TL-11: POST /login unknown id returns 404', notFoundResp.status === 404 )

    // 5) AC-7: transcriptLoggedIn broadcast received.
    await new Promise( ( res ) => setTimeout( res, 200 ) )
    check( 'AC-7: WS transcriptLoggedIn broadcast received', wsEvents.includes( 'transcriptLoggedIn' ) )

    // 6) TL-12: logout -> 200.
    const logoutResp = await fetch( `http://localhost:${ PORT }/api/transcripts/${ transcriptId }/logout`, { method: 'POST' } )
    check( 'TL-12: POST /logout returns 200', logoutResp.status === 200 )

    ws.close()
    await rm( tempDir, { recursive: true, force: true } )

    const failed = results.filter( ( r ) => !r.ok )
    process.stdout.write( `\n  ${ results.length - failed.length }/${ results.length } checks passed\n\n` )
    process.exit( failed.length === 0 ? 0 : 1 )
}


main().catch( ( err ) => {
    process.stderr.write( `ERROR: ${ err.stack || err.message }\n` )
    process.exit( 1 )
} )
