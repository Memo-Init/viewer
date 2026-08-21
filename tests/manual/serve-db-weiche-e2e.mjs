// Serve-E2E (Memo 079, P6a — PRD-20 + PRD-21 + FIX A/B/C): boot the REAL memo-view server against a
// temp .memo tree and drive the PRIVATE serve path end-to-end over real HTTP + WebSocket — no mocks,
// no reach into private statics. Proves that:
//   (PRD-20)  a DB-first memo's HEAD revision is served as DB-ASSEMBLED markdown, NOT the .md file.
//   (FIX A)   with two revisions (HEAD=rev-02): a REV-01 request serves the FROZEN REV-01 FILE (the
//             read-only Tag-Grenze), a REV-02 request serves the DB HEAD render.
//   (FIX B)   the DB HEAD body carries an `## Offene Fragen` section from the db question table, and
//             the document badge count (getDocuments → questions.open) comes from the db, not the file.
//   (PRD-21)  the badge (getDocuments → memoStatus) of the DB memo comes from the DB lifecycle table
//             (last state) and OVERRIDES its .md frontmatter; a legacy memo keeps the frontmatter.
// Run: node tests/manual/serve-db-weiche-e2e.mjs  → exits 0 on success, 1 on any failed assertion.
import { WebSocket } from 'ws'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { MemoView } from '../../src/MemoView.mjs'


const PORT = 47913
const results = []

const check = ( label, condition ) => {
    results.push( { label, ok: condition === true } )
    process.stdout.write( `  ${ condition === true ? 'PASS' : 'FAIL' }  ${ label }\n` )
}

const FILE_PLACEHOLDER = 'DATEI-PLATZHALTER — dieser Text darf im DB-first HEAD-Viewer NICHT erscheinen'


const seedDb = ( { dbPath, memoName, lifecycleStates, revisionNos, questions } ) => {
    const db = new DatabaseSync( dbPath )
    db.exec( 'CREATE TABLE IF NOT EXISTS memo ( id TEXT PRIMARY KEY, name TEXT, memo_type TEXT, status TEXT, created_at TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS work_item ( id TEXT PRIMARY KEY, topic TEXT, title TEXT, status TEXT, grp TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS block ( id TEXT PRIMARY KEY, title TEXT, sort INTEGER )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS block_tables ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, tsv TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS block_diagrams ( id TEXT PRIMARY KEY, block_id TEXT, title TEXT, kind TEXT, `source` TEXT, feed TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS lifecycle ( state TEXT, `at` TEXT, `by` TEXT, evidence TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS revision ( rev_no INTEGER PRIMARY KEY, md_sha256 TEXT, md_path TEXT, dolt_commit TEXT, tag TEXT, created_at TEXT )' )
    db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT )' )
    db.prepare( 'INSERT INTO memo ( id, name, memo_type, status, created_at ) VALUES ( ?, ?, ?, ?, ? )' )
        .run( 'M079', memoName, 'Implementation', 'in-progress', '2026-08-20T00:00:00Z' )
    db.prepare( 'INSERT INTO work_item ( id, topic, title, status, grp ) VALUES ( ?, ?, ?, ?, ? )' )
        .run( 'WI-1', 'viewer', 'Weiche verdrahten', 'done', 'P6a' )
    lifecycleStates
        .forEach( ( state, index ) => {
            db.prepare( 'INSERT INTO lifecycle ( state, `at`, `by`, evidence ) VALUES ( ?, ?, ?, ? )' )
                .run( state, '2026-08-20T0' + index + ':00:00Z', 'lead', 'seed-' + index )
        } )
    ;( revisionNos || [] )
        .forEach( ( revNo ) => {
            db.prepare( 'INSERT INTO revision ( rev_no, md_sha256, created_at ) VALUES ( ?, ?, ? )' )
                .run( revNo, 'sha-' + revNo, '2026-08-20T00:00:00Z' )
        } )
    ;( questions || [] )
        .forEach( ( q ) => {
            db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' )
                .run( q.id, 'M079', q.text, q.kind, q.status )
        } )
    db.close()
}


const revFile = ( { title, status, marker } ) => [
    '# ' + title,
    '',
    '| Feld | Wert |',
    '| --- | --- |',
    '| **Status** | ' + status + ' |',
    '',
    FILE_PLACEHOLDER + ' [' + marker + ']',
    ''
].join( '\n' )


const registerDoc = async ( { memoDir } ) => {
    // The door-gate may answer 422 for a DB-first REV file, but the memo stays REGISTERED regardless
    // (MemoView.mjs). We only need it registered — the served content is proven over WS below.
    await fetch( `http://localhost:${ PORT }/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { projectId: 'memo-init', memoPath: join( memoDir, 'revisions' ) } )
    } )
}


// Open a fresh WS, select one revision by fileName, and resolve with the `type:'content'` payload.
const fetchContent = ( { documentId, fileName } ) => new Promise( ( resolvePromise, rejectPromise ) => {
    const ws = new WebSocket( `ws://localhost:${ PORT }/` )
    const timer = setTimeout( () => { ws.close(); rejectPromise( new Error( 'timeout waiting for content ' + documentId + ' ' + fileName ) ) }, 4000 )

    ws.on( 'open', () => {
        ws.send( JSON.stringify( { type: 'selectRevision', documentId, fileName } ) )
    } )
    ws.on( 'message', ( raw ) => {
        try {
            const msg = JSON.parse( raw.toString() )
            if( msg.type === 'content' && msg.documentId === documentId ) {
                clearTimeout( timer )
                ws.close()
                resolvePromise( { content: msg.content } )
            }
        } catch {}
    } )
    ws.on( 'error', ( err ) => { clearTimeout( timer ); rejectPromise( err ) } )
} )


const main = async () => {
    const tempDir = await mkdtemp( join( tmpdir(), 'serve-db-weiche-' ) )

    // A temp cwd under tmpdir has no ancestor .sessions/config.json → no projects[] auto-register;
    // scanOther(cwd) finds nothing. This isolates the server to the memos we POST explicitly.
    process.chdir( tempDir )

    // DB-first memo, single HEAD revision (rev-01) + two OPEN questions in the db: frontmatter says
    // Entwurf, DB lifecycle last state is 'rollout' → badge must be 'Finalisiert' (DB); the served
    // HEAD content must be DB-ASSEMBLED (with the Offene-Fragen section), not the file placeholder.
    const dbMemoDir = join( tempDir, '.memo', 'memos', '079-db-schaufenster' )
    await mkdir( join( dbMemoDir, 'revisions' ), { recursive: true } )
    writeFileSync( join( dbMemoDir, 'revisions', 'REV-01.md' ), revFile( { title: '079-db-schaufenster', status: 'Entwurf', marker: 'REV-01.md' } ) )
    seedDb( {
        dbPath: resolve( dbMemoDir, 'memo-079.db' ),
        memoName: 'DB-ASSEMBLED Schaufenster',
        lifecycleStates: [ 'angelegt', 'in-revision', 'rollout' ],
        revisionNos: [ 1 ],
        questions: [
            { id: 'F1', text: 'Soll die Weiche HEAD-only assemblen?', kind: 'info', status: 'open' },
            { id: 'F2', text: 'Wie alte Revisionen ausliefern?', kind: 'blocker', status: 'open' }
        ]
    } )

    // DB-first memo with TWO revisions (HEAD=rev-02): REV-01 must serve the FROZEN file, REV-02 the DB.
    const twoRevMemoDir = join( tempDir, '.memo', 'memos', '079-zwei-revisionen' )
    await mkdir( join( twoRevMemoDir, 'revisions' ), { recursive: true } )
    writeFileSync( join( twoRevMemoDir, 'revisions', 'REV-01.md' ), revFile( { title: '079-zwei-revisionen', status: 'Entwurf', marker: 'REV-01.md' } ) )
    writeFileSync( join( twoRevMemoDir, 'revisions', 'REV-02.md' ), revFile( { title: '079-zwei-revisionen', status: 'Entwurf', marker: 'REV-02.md' } ) )
    seedDb( {
        dbPath: resolve( twoRevMemoDir, 'memo-079.db' ),
        memoName: 'DB-ASSEMBLED Zwei-Revisionen',
        lifecycleStates: [ 'rollout' ],
        revisionNos: [ 1, 2 ],
        questions: []
    } )

    // Legacy memo: no db → served from the file, badge from the frontmatter 'Finalisiert'.
    const fileMemoDir = join( tempDir, '.memo', 'memos', '079-legacy-datei' )
    await mkdir( join( fileMemoDir, 'revisions' ), { recursive: true } )
    writeFileSync( join( fileMemoDir, 'revisions', 'REV-01.md' ), revFile( { title: '079-legacy-datei', status: 'Finalisiert', marker: 'REV-01.md' } ) )

    await MemoView.startServer( { port: PORT } )

    await registerDoc( { memoDir: dbMemoDir } )
    await registerDoc( { memoDir: twoRevMemoDir } )
    await registerDoc( { memoDir: fileMemoDir } )

    // ── PRD-21 + FIX B: badge + question count from getDocuments (the fields the client renders) ──
    const listResp = await fetch( `http://localhost:${ PORT }/api/documents` )
    const listBody = await listResp.json()
    const docs = Array.isArray( listBody.documents ) ? listBody.documents : []
    const dbDoc = docs.find( ( d ) => d.memoName === '079-db-schaufenster' )
    const twoDoc = docs.find( ( d ) => d.memoName === '079-zwei-revisionen' )
    const fileDoc = docs.find( ( d ) => d.memoName === '079-legacy-datei' )

    check( 'all three memos are registered', dbDoc !== undefined && twoDoc !== undefined && fileDoc !== undefined )
    check( 'PRD-21: DB memo badge = Finalisiert (from DB lifecycle rollout, overrides frontmatter Entwurf)', dbDoc !== undefined && dbDoc.memoStatus === 'Finalisiert' )
    check( 'PRD-21: legacy memo badge = Finalisiert (from .md frontmatter, unchanged)', fileDoc !== undefined && fileDoc.memoStatus === 'Finalisiert' )
    check( 'FIX B: DB memo question count = 2 open (from DB question table, not the file parse)', dbDoc !== undefined && dbDoc.questions && dbDoc.questions.open === 2 )

    // ── PRD-20 + FIX A/B: served markdown source over WS (drives private #readFileContent) ──
    const dbContent = await fetchContent( { documentId: dbDoc.documentId, fileName: 'REV-01.md' } )
    check( 'PRD-20: DB HEAD served as DB-ASSEMBLED markdown (memo name from DB)', dbContent.content.includes( '# DB-ASSEMBLED Schaufenster' ) )
    check( 'PRD-20: DB HEAD served content carries the DB work item', dbContent.content.includes( 'Weiche verdrahten' ) )
    check( 'PRD-20: DB HEAD served content does NOT contain the .md file placeholder', dbContent.content.includes( FILE_PLACEHOLDER ) === false )
    check( 'FIX B: DB HEAD body carries the Offene-Fragen section with both open questions', dbContent.content.includes( '## Offene Fragen' ) && dbContent.content.includes( 'Soll die Weiche HEAD-only assemblen?' ) && dbContent.content.includes( 'Wie alte Revisionen ausliefern?' ) )

    const rev01 = await fetchContent( { documentId: twoDoc.documentId, fileName: 'REV-01.md' } )
    check( 'FIX A: older REV-01 served from the FROZEN FILE (marker [REV-01.md] present)', rev01.content.includes( FILE_PLACEHOLDER + ' [REV-01.md]' ) )
    check( 'FIX A: older REV-01 is NOT the DB HEAD body', rev01.content.includes( 'DB-ASSEMBLED' ) === false )

    const rev02 = await fetchContent( { documentId: twoDoc.documentId, fileName: 'REV-02.md' } )
    check( 'FIX A: newest REV-02 served as DB HEAD render (memo name from DB)', rev02.content.includes( '# DB-ASSEMBLED Zwei-Revisionen' ) )
    check( 'FIX A: newest REV-02 does NOT contain the .md file placeholder', rev02.content.includes( FILE_PLACEHOLDER ) === false )

    const fileContent = await fetchContent( { documentId: fileDoc.documentId, fileName: 'REV-01.md' } )
    check( 'PRD-20: legacy memo served UNCHANGED from the .md file (placeholder present)', fileContent.content.includes( FILE_PLACEHOLDER ) )
    check( 'PRD-20: legacy memo served content is NOT DB-assembled', fileContent.content.includes( 'DB-ASSEMBLED' ) === false )

    await rm( tempDir, { recursive: true, force: true } )

    const failed = results.filter( ( r ) => !r.ok )
    process.stdout.write( `\n  ${ results.length - failed.length }/${ results.length } checks passed\n\n` )
    process.exit( failed.length === 0 ? 0 : 1 )
}


main().catch( ( err ) => {
    process.stderr.write( `ERROR: ${ err.stack || err.message }\n` )
    process.exit( 1 )
} )
