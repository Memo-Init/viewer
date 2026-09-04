// PRD-V7 (Memo 080 Kap 16, T082) — A17 proof against the REAL annotation store of memo 080.
//
// The three annotations of the REV-02 review (ANM-001..003) are set to `eingearbeitet` WITH their
// back-reference, through the deterministic write path — the very calls the new
// `PATCH /api/annotations/<id>` route makes:
//     registry document -> MemoView.resolveMemoDir -> AnnotationStore.setStatus -> archive-then-write
// NO hand-edit of the JSON files, and no memo-view server is booted: a full boot auto-registers every
// project of the shared session config and hydrates/sweeps THEIR memos, which this rollout's builder
// contract forbids (foreign projects are read-only). The HTTP status mapping (404/422/200) around these
// calls is held by the source-cut tests in tests/unit/AnnotationApparatusPRDV7.test.mjs.
//
// The chapter slugs are READ from REV-18 with the shared MemoView.slugify — never guessed.
//
// Run: node tests/manual/annotation-status-e2e.mjs   → exits 0 on success, 1 on any failed assertion.
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoView } from '../../src/MemoView.mjs'
import { AnnotationStore } from '../../src/AnnotationStore.mjs'


// The memo store lives OUTSIDE this repo (four levels up: tests/manual -> tests -> viewer -> repos).
// Relative only, never an absolute path — and guarded by existsSync below, because CI checks out this
// repo alone and then there is simply nothing to prove here.
const HERE = dirname( fileURLToPath( import.meta.url ) )
const MEMO_DIR = resolve( join( HERE, '..', '..', '..', '..', '.memo', 'memos', '080-db-vollausbau-und-laufzeit-transparenz' ) )
const REVISION_ID = 'REV-18'
const results = []

const check = ( label, condition ) => {
    results.push( { label, ok: condition === true } )
    process.stdout.write( `  ${ condition === true ? 'PASS' : 'FAIL' }  ${ label }\n` )
}


// The rendered H2 id of a chapter that starts with "<number>." — the same normaliser that mints the
// heading ids in the viewer, applied to the same heading text.
const chapterSlugs = async ( { revisionPath } ) => {
    const raw = await readFile( revisionPath, 'utf-8' )
    const headings = raw
        .split( '\n' )
        .filter( ( line ) => line.startsWith( '## ' ) )
        .map( ( line ) => line.slice( 3 ).trim() )

    const byNumber = new Map( headings
        .filter( ( text ) => /^\d+\./.test( text ) )
        .map( ( text ) => [ text.split( '.' )[ 0 ], MemoView.slugify( { text } )[ 'slug' ] ] ) )

    return { byNumber, headingCount: headings.length }
}


const main = async () => {
    if( existsSync( MEMO_DIR ) !== true ) {
        process.stdout.write( `  SKIP  memo 080 is not present at ${ MEMO_DIR } — nothing to prove here.\n` )

        return 0
    }

    const location = MemoView.resolveMemoDir( { memoPath: join( MEMO_DIR, 'revisions' ) } )
    check( 'the registered memoPath resolves to the memo dir (the chain the route walks)', location.status === true && location.memoDir === MEMO_DIR )

    const { byNumber, headingCount } = await chapterSlugs( { revisionPath: join( MEMO_DIR, 'revisions', `${ REVISION_ID }.md` ) } )
    process.stdout.write( `  read ${ headingCount } headings from ${ REVISION_ID }.md, ${ byNumber.size } of them numbered chapters\n` )

    const chapter16 = byNumber.get( '16' )
    const chapter2 = byNumber.get( '2' )
    const chapter24 = byNumber.get( '24' )
    check( 'chapter 16, 2 and 24 all resolve to a real slug (3 of 3)', [ chapter16, chapter2, chapter24 ].every( ( slug ) => typeof slug === 'string' && slug.length > 0 ) )
    process.stdout.write( `  16 -> ${ chapter16 }\n  2  -> ${ chapter2 }\n  24 -> ${ chapter24 }\n` )

    // ── counter-proofs FIRST: a refused write must leave the store untouched ──
    const beforeOne = await readFile( join( MEMO_DIR, '_annotations', 'ANM-001.json' ), 'utf-8' )
    const badStatus = await AnnotationStore.setStatus( { id: 'ANM-001', anmStatus: 'erledigt', memoDir: MEMO_DIR } )
    const noBackRef = await AnnotationStore.setStatus( { id: 'ANM-001', anmStatus: 'eingearbeitet', memoDir: MEMO_DIR } )
    const unknownId = await AnnotationStore.setStatus( { id: 'ANM-404', anmStatus: 'offen', memoDir: MEMO_DIR } )
    const afterRefusals = await readFile( join( MEMO_DIR, '_annotations', 'ANM-001.json' ), 'utf-8' )

    check( 'an unknown status is refused (the 422 branch of the route)', badStatus.status === false )
    check( '"eingearbeitet" without a back-reference is refused (the 422 branch of the route)', noBackRef.status === false )
    check( 'an unknown annotation id is refused (the 422 branch of the route)', unknownId.status === false )
    check( 'all three refusals wrote NOTHING — the file is byte-identical', afterRefusals === beforeOne )

    // ── the real write ──
    const plan = [
        { id: 'ANM-001', chapters: [ chapter16 ] },
        { id: 'ANM-002', chapters: [ chapter16, chapter2 ] },
        { id: 'ANM-003', chapters: [ chapter24 ] }
    ]

    const written = await Promise.all( plan.map( ( entry ) => AnnotationStore.setStatus( {
        id: entry.id,
        anmStatus: 'eingearbeitet',
        resolvedIn: { revisionId: REVISION_ID, chapters: entry.chapters },
        memoDir: MEMO_DIR
    } ) ) )

    check( 'all three annotations were written (3 of 3)', written.filter( ( entry ) => entry.status === true ).length === 3 )

    const stored = await Promise.all( plan.map( async ( entry ) => JSON.parse( await readFile( join( MEMO_DIR, '_annotations', `${ entry.id }.json` ), 'utf-8' ) ) ) )

    check( 'A17: all three carry anmStatus "eingearbeitet"', stored.every( ( record ) => record.anmStatus === 'eingearbeitet' ) )
    check( `A17: all three carry resolvedIn.revisionId ${ REVISION_ID }`, stored.every( ( record ) => record.resolvedIn && record.resolvedIn.revisionId === REVISION_ID ) )
    check( 'A17: ANM-001 -> chapter 16', stored[ 0 ].resolvedIn.chapters.join( ',' ) === chapter16 )
    check( 'A17: ANM-002 -> chapter 16 AND chapter 2', stored[ 1 ].resolvedIn.chapters.join( ',' ) === [ chapter16, chapter2 ].join( ',' ) )
    check( 'A17: ANM-003 -> chapter 24', stored[ 2 ].resolvedIn.chapters.join( ',' ) === chapter24 )
    check( 'A17: the ids and the created stamps are unchanged (no record was replaced by a new one)', stored.every( ( record, idx ) => record.id === plan[ idx ].id && typeof record.createdAt === 'string' ) )

    const files = await readdir( join( MEMO_DIR, '_annotations' ) )
    const archived = files.filter( ( name ) => /^ANM-\d{3}\..+\.json$/.test( name ) )
    check( `A12: one archived pre-version per annotation exists (${ archived.length } archived files)`, archived.length >= 3 )

    const listed = await AnnotationStore.list( { memoDir: MEMO_DIR } )
    check( 'the list still reports exactly the 3 canonical annotations (archives are not listed)', listed.status === true && listed.annotations.length === 3 )

    const failed = results.filter( ( entry ) => entry.ok !== true )
    process.stdout.write( `\n  ${ results.length - failed.length }/${ results.length } checks passed\n` )

    return failed.length === 0 ? 0 : 1
}


main()
    .then( ( code ) => { process.exitCode = code } )
    .catch( ( error ) => {
        process.stderr.write( `  FAIL  ${ error.message }\n` )
        process.exitCode = 1
    } )
