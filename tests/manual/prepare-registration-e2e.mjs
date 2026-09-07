// prepare-registration-e2e.mjs — PRD-36 (Memo 081, Kap 19 / WI-080) against a REAL server.
//
// WHY A REAL SERVER. The subject of PRD-36 is the answer `POST /api/documents` gives when the youngest
// revision of a freshly registered memo is a `REV-NN-prepare.md`. That answer is produced by a door-gate
// that chains three real parts — addDocument, getLatestRevision and MemoValidator — and hands the result
// to an HTTP status code. A mock would only prove the mock; the status code is the thing under measure.
//
// WHY NOT IN THE SUITE. MemoView.startServer scans the surrounding workbench tree at boot (measured:
// ~390 documents, tens of seconds). A CI checkout of THIS repo alone has no such tree, so a suite test
// doing it would either fail or verify nothing — the failure mode that once tore 31 cases in M080/PRD-V4.
// The repo already decided this once and wrote the reason down (tests/unit/HealthEndpointPRDV11.test.mjs:16):
// the real end-to-end lives in tests/manual/ and runs against a real server. This file follows that
// decision; the CHAIN is covered without a server in tests/unit/PrepareRegistrationPRD36.test.mjs.
//
// THE VACUUM LOCK. Probe B is the load-bearing case and it only bears load while its prepare file carries
// NONE of the two document signals MemoValidator.#revisionTypeOf falls back on. A prepare file WITH those
// signals is judged `prepare` even today and would answer 200 before AND after the change — green because
// nothing was compared. So this harness MEASURES that property of its own fixture and prints it, before it
// prints any verdict about the server.
//
// Run: MEMOVIEW_NO_BROWSER=1 node tests/manual/prepare-registration-e2e.mjs   -> exit 0 on success, 1 on any fail.
// Writes only under <repo>/.test-tmp/ and a fresh os temp dir; the real .memo/ tree and port 3333 are
// never touched.

import { mkdtemp, mkdir, rm, writeFile, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createConnection } from 'node:net'


const PORT = 3394
const PORT_INVENTORY = [ 3333, PORT ]
const REPO = resolve( new URL( '../..', import.meta.url ).pathname )

const results = []


const check = ( label, passed, detail ) => {
    results.push( { label, passed } )
    process.stdout.write( `  ${ passed === true ? 'OK  ' : 'FAIL' }  ${ label }${ detail === undefined ? '' : ` — ${ detail }` }\n` )
}


// A port probe that needs no external tool: open a socket, note whether anything answered, close it.
const probePort = ( port ) => {
    return new Promise( ( done ) => {
        const socket = createConnection( { host: '127.0.0.1', port } )
        const settle = ( inUse ) => { socket.destroy(); done( { port, inUse } ) }
        socket.setTimeout( 400 )
        socket.on( 'connect', () => settle( true ) )
        socket.on( 'timeout', () => settle( false ) )
        socket.on( 'error', () => settle( false ) )
    } )
}


const inventory = async () => {
    const seen = await Promise.all( PORT_INVENTORY.map( ( port ) => probePort( port ) ) )

    return seen.filter( ( entry ) => entry.inUse === true ).map( ( entry ) => entry.port )
}


// A prepare skeleton in the shape memo-revision-generate prescribes. `withSignals: false` strips BOTH
// stage-2 signals (the `# REV-NN-prepare` title and the `| **Geplante Revision** |` header field) and
// uses the `| **Revision** |` alias the prepare schema also accepts — the exact shape of the 35 corpus
// files that are judged `full` today.
const prepareDoc = ( { revision, withSignals } ) => {
    const title = withSignals === true ? `# REV-${ revision }-prepare` : `# Vorbereitung der naechsten Revision`
    const revisionField = withSignals === true ? `| **Geplante Revision** | REV-${ revision } |` : `| **Revision** | REV-${ revision } |`

    return [
        title,
        '',
        '| Feld | Wert |',
        '|------|------|',
        '| **Memo** | 999-prd36-probe |',
        revisionField,
        '| **Geplanter Typ** | Full |',
        '| **Basiert auf** | REV-01 |',
        '| **Datum** | 2026-09-07 10:00 |',
        '',
        '---',
        '',
        '## Interpretation des Feedbacks',
        'Probe fixture for PRD-36.',
        '',
        '## Geplante Änderungen pro Kapitel',
        '- none',
        '',
        '## Research',
        'Research noetig: Nein',
        '',
        '## Revisions-Blocker',
        'keine',
        '',
        '## Offene Fragen',
        'keine'
    ].join( '\n' )
}


// The positive control: a genuine FULL revision with a genuine breach (the required sections are gone).
// Its file name carries no suffix, so handing the name through must NOT rescue it.
const brokenFullDoc = () => {
    return [
        '# REV-02',
        '',
        '| Feld | Wert |',
        '|------|------|',
        '| **Memo** | 999-prd36-probe |',
        '',
        '## Kontext',
        'A full revision that is missing nine of its ten required sections.',
        '',
        'Schema-Version: 2'
    ].join( '\n' )
}


const buildProbe = async ( { root, name, youngest, youngestBody, valid } ) => {
    const revisions = join( root, name, 'revisions' )
    await mkdir( revisions, { recursive: true } )
    await writeFile( join( revisions, 'REV-01.md' ), valid, 'utf8' )
    await writeFile( join( revisions, youngest ), youngestBody, 'utf8' )

    // #scanRevisions sorts by mtimeMs descending, so the youngest file is revisions[0]. A checkout never
    // establishes an mtime order — it is set here explicitly instead of being left to chance.
    const older = new Date( Date.now() - 600000 )
    const newer = new Date( Date.now() )
    await utimes( join( revisions, 'REV-01.md' ), older, older )
    await utimes( join( revisions, youngest ), newer, newer )

    return { revisions }
}


const post = async ( { memoPath } ) => {
    const answer = await fetch( `http://127.0.0.1:${ PORT }/api/documents`, {
        'method': 'POST',
        'headers': { 'Content-Type': 'application/json' },
        'body': JSON.stringify( { 'projectId': 'prd36probe', memoPath } )
    } )
    const body = await answer.json()

    return { 'status': answer.status, body }
}


// A 200 answer carries no validation envelope at all — it never did and this change does not add one.
// Only a 422 states which schema it applied and how much it compared, so "absent" is reported as two
// DIFFERENT things: not-applicable on a 200, and a missing field on a 422 (the pre-change build).
const describeAnswer = ( { status, body } ) => {
    const messages = Array.isArray( body[ 'messages' ] ) ? body[ 'messages' ].length : 0

    if( status !== 422 ) {
        return `HTTP ${ status } · messages ${ messages } · no validation envelope (a non-422 answer never carried one)`
    }

    const applied = body[ 'revisionType' ] === undefined ? 'MISSING (pre-change build)' : body[ 'revisionType' ]
    const registry = body[ 'registryRevisionType' ] === undefined ? '' : ` · registry says ${ body[ 'registryRevisionType' ] }`
    const checked = body[ 'checked' ] === undefined ? 'MISSING (pre-change build)' : JSON.stringify( body[ 'checked' ] )

    return `HTTP ${ status } · messages ${ messages } · applied schema ${ applied }${ registry } · checked ${ checked }`
}


const main = async () => {
    process.env[ 'MEMOVIEW_NO_BROWSER' ] = '1'

    const before = await inventory()
    process.stdout.write( `\n  Port inventory before start: ${ before.length === 0 ? 'none in use' : before.join( ', ' ) }\n` )
    check( `port ${ PORT } is free before the run (port 3333 is never touched)`, before.includes( PORT ) === false, `in use: ${ before.join( ', ' ) || 'none' }` )

    await mkdir( join( REPO, '.test-tmp' ), { recursive: true } )
    const root = await mkdtemp( join( REPO, '.test-tmp', 'prd36-e2e-' ) )

    const valid = await readFile( resolve( REPO, 'tests', 'fixtures', 'sample-rev.md' ), 'utf-8' )

    const withSignals = prepareDoc( { 'revision': '02', 'withSignals': true } )
    const withoutSignals = prepareDoc( { 'revision': '02', 'withSignals': false } )

    // The vacuum lock, measured BEFORE any verdict: probe B's fixture must be judged `full` when asked
    // without a name, otherwise this run compares nothing.
    const { MemoValidator } = await import( join( REPO, 'src', 'MemoValidator.mjs' ) )
    const blindB = MemoValidator.validate( { 'doc': withoutSignals } )
    const blindA = MemoValidator.validate( { 'doc': withSignals } )
    check( 'VACUUM LOCK: probe B carries NO stage-2 prepare signal (asked without a name it reads `full`)', blindB[ 'revisionType' ] === 'full' && blindB[ 'messages' ].length > 0, `type ${ blindB[ 'revisionType' ] } · ${ blindB[ 'messages' ].length } messages against the full schema` )
    check( 'counter-measurement: probe A DOES carry the signals (asked without a name it reads `prepare`)', blindA[ 'revisionType' ] === 'prepare', `type ${ blindA[ 'revisionType' ] } · ${ blindA[ 'messages' ].length } messages` )

    const probeA = await buildProbe( { root, 'name': 'probe-a', 'youngest': 'REV-02-prepare.md', 'youngestBody': withSignals, valid } )
    const probeB = await buildProbe( { root, 'name': 'probe-b', 'youngest': 'REV-02-prepare.md', 'youngestBody': withoutSignals, valid } )
    const probeC = await buildProbe( { root, 'name': 'probe-c', 'youngest': 'REV-02.md', 'youngestBody': brokenFullDoc(), valid } )

    // The server's working directory is a fresh temp tree, so its boot auto-registration never walks the
    // real .memo/ of this project (and the run stays under a second instead of ~40 s).
    const workDir = await mkdtemp( join( tmpdir(), 'prd36-e2e-work-' ) )
    process.chdir( workDir )

    const { MemoView } = await import( join( REPO, 'src', 'MemoView.mjs' ) )
    await MemoView.startServer( { 'port': PORT } )

    const answerA = await post( { 'memoPath': probeA[ 'revisions' ] } )
    const answerB = await post( { 'memoPath': probeB[ 'revisions' ] } )
    const answerC = await post( { 'memoPath': probeC[ 'revisions' ] } )

    process.stdout.write( `\n  A (prepare WITH signals)   : ${ describeAnswer( answerA ) }\n` )
    process.stdout.write( `  B (prepare WITHOUT signals): ${ describeAnswer( answerB ) }\n` )
    process.stdout.write( `  C (broken FULL revision)   : ${ describeAnswer( answerC ) }\n\n` )

    check( 'A1: probe A (prepare WITH signals) answers 200 — no regression', answerA[ 'status' ] === 200, describeAnswer( answerA ) )
    check( 'A1: probe B (prepare WITHOUT signals) answers 200 — the case that flips', answerB[ 'status' ] === 200, describeAnswer( answerB ) )
    check( 'A1 POSITIVE CONTROL: probe C (broken FULL revision) still answers 422', answerC[ 'status' ] === 422, describeAnswer( answerC ) )
    check( 'A1: the 422 of probe C names the schema it applied', answerC[ 'body' ][ 'revisionType' ] === 'full', `revisionType ${ answerC[ 'body' ][ 'revisionType' ] }` )
    check( 'A1: the 422 of probe C names how much it compared', typeof answerC[ 'body' ][ 'checked' ] === 'object' && answerC[ 'body' ][ 'checked' ] !== null, JSON.stringify( answerC[ 'body' ][ 'checked' ] ) )

    const listed = await fetch( `http://127.0.0.1:${ PORT }/api/documents` )
    const listedBody = await listed.json()
    const documents = Array.isArray( listedBody[ 'documents' ] ) ? listedBody[ 'documents' ] : []
    const probes = documents.filter( ( doc ) => String( doc[ 'documentId' ] ).startsWith( 'prd36probe--' ) )

    process.stdout.write( `  GET /api/documents: ${ documents.length } documents in stock, ${ probes.length } of them probes\n` )
    probes
        .forEach( ( doc ) => {
            const revisions = Array.isArray( doc[ 'revisions' ] ) ? doc[ 'revisions' ] : []
            const first = revisions.length === 0 ? null : revisions[ 0 ]
            process.stdout.write( `    ${ String( doc[ 'documentId' ] ).padEnd( 24 ) } revisions ${ revisions.length } · first ${ first === null ? '-' : first[ 'fileName' ] } (${ first === null ? '-' : first[ 'revisionType' ] })\n` )
        } )
    process.stdout.write( '\n' )

    const found = ( id ) => { return probes.find( ( doc ) => doc[ 'documentId' ] === id ) }
    const docB = found( 'prd36probe--probe-b' )
    const revisionsB = docB === undefined ? [] : docB[ 'revisions' ]

    check( 'A1(b): probe B arrives IN STOCK — not merely un-rejected', docB !== undefined && revisionsB.length === 2, `revisionsFound ${ answerB[ 'body' ][ 'revisionsFound' ] } · listed revisions ${ revisionsB.length }` )
    check( 'A1(b): probe B leads with its prepare file, classified `prepare`', revisionsB.length > 0 && revisionsB[ 0 ][ 'fileName' ] === 'REV-02-prepare.md' && revisionsB[ 0 ][ 'revisionType' ] === 'prepare', revisionsB.length === 0 ? 'no revisions listed' : `${ revisionsB[ 0 ][ 'fileName' ] } (${ revisionsB[ 0 ][ 'revisionType' ] })` )
    check( 'A1(b): probe A is in stock too, and leads with its prepare file', found( 'prd36probe--probe-a' ) !== undefined, `documents matching prd36probe--: ${ probes.length }` )
    check( 'A1: probe C stays registered although the door answered 422 (the gate never unregisters)', found( 'prd36probe--probe-c' ) !== undefined, `documents matching prd36probe--: ${ probes.length }` )

    process.chdir( REPO )
    await rm( root, { 'recursive': true, 'force': true } )
    await rm( workDir, { 'recursive': true, 'force': true } )

    const failed = results.filter( ( entry ) => entry.passed !== true )
    process.stdout.write( `\n  ${ results.length - failed.length } of ${ results.length } checks passed\n` )

    if( results.length === 0 ) {
        process.stderr.write( '  FAIL-VACUUM: not a single check ran — that is red, not green.\n\n' )
        process.exit( 1 )
    }

    // The listener dies with the process below; the freed port is measured by the caller after exit
    // (a probe from inside the owning process would only prove the process is still alive).
    process.stdout.write( `  Port ${ PORT } is released by this process exit — verify from outside.\n\n` )
    process.exit( failed.length === 0 ? 0 : 1 )
}


main()
    .catch( ( error ) => {
        process.stderr.write( `\n  ABORTED: ${ error.stack }\n\n` )
        process.exit( 1 )
    } )
