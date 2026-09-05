// EventChannelSunsetPRDV10.test.mjs — the event road as a NAMED transition, and the gate that ends it
// (Memo 080, Kap 19, PRD-V10, WI-207).
//
// Two blocks, two jobs.
//
// BEHAVIOUR (A1-A5, A10, A11) runs the REAL shell script against a throwaway node:http server on
// 127.0.0.1 with port 0 (assigned by the OS). Three gaps of the old script are closed here and each is
// measured, not asserted from the outside: arming and waiting are ONE action (a forgotten arm used to
// become a silent forever-wait), a failing arm ends the process LOUDLY instead of waiting for a flag
// that can never arrive, and the wait has a ceiling instead of outliving its session.
//
// A note on how "never entered the wait loop" is proven: the flag file is placed on disk BEFORE the
// failing run starts. The loop consumes a flag it finds (one-shot cleanup), so a flag that is still
// there afterwards is machine proof that the loop was never reached — stronger than measuring a
// runtime, which only says "fast".
//
// SUNSET (A6-A9, A12) is the point of this PRD. Something built as a transition tends to stay, so the
// transition gets a machine-enforced end: `detectLongRunningWait( { source } )` reads the marker
// `LONG_RUNNING_WAIT_LIVE` that PRD-V9 sets in src/MemoView.mjs after ITS first flight was green. From
// that day on this suite is RED while any entry of the sunset list still exists, and the failure names
// the entries. The gate is measured on a POSITIVE case here (spoofed source), because a gate that was
// only ever run against today's emptiness is presumed green, not proven green.
//
// THE GATE FOLLOWS THE REAL MARKER, IN BOTH DIRECTIONS (Memo 080, PRD-V10 rework).
// It did not. The direction was hard-wired — `live: false` in the verdict case and `hits === 0` against
// the real source — so sunset day, the ONE day this gate exists for, was the one day it could not work.
// Measured on a throwaway copy with the marker set: the whole red output was `Expected: 0 / Received: 2`
// (a count, no name), and with the script already deleted the gate answered "the marker is not set, so
// the transition must be COMPLETE. Missing: repos/viewer/scripts/session-wake-arm.sh" — it demanded the
// restoration of the very file whose removal it orders, while the marker was set. Two rules follow:
//   1. `REAL_MARKER` is read from src/MemoView.mjs at load time and every direction-bound claim hangs
//      off it. Nothing in this file hard-wires a direction any more.
//   2. Where the gate is red, the MESSAGE is the compared value (`expect( outcome ).toBe( 'GREEN' )`),
//      so jest prints the names instead of a bare count. A gate that only counts is the finding.
// Claims that can only hold WHILE the transition is intact live behind `withTransition`, in the same
// `existsSync( … ) ? it : it.skip` spelling — visible in the skip tally, never a quiet pass.
//
// Every check says WHAT it compared (path + hit count). A check that finds no comparison basis FAILS —
// an empty comparison field is a finding, never a pass. The one place where an unreadable file is not a
// failure is the sibling repo repos/core: CI checks this repo out ALONE, so that place is reported as
// UNJUDGED and the run states how many places it could judge.
//
// Everything that can only be answered WITH the sibling repo therefore lives in cases registered through
// `withLiveCore` (the house spelling `existsSync( … ) ? it : it.skip`), and their titles carry the count
// they could compare. A run without the sibling repo is thus distinguishable from a run with it in jest's own
// tally — never a hard failure (CI would be red for a reason that is not the code) and never a quiet pass.
// The same rule holds for LABELS: they are anchored to the repo they belong to, never to a directory
// above the checkout, whose name differs between the workbench and CI.
import { describe, it, expect } from '@jest/globals'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'


const execFileP = promisify( execFile )
const here = dirname( fileURLToPath( import.meta.url ) )
const SELF = fileURLToPath( import.meta.url )
const VIEWER_ROOT = resolve( here, '..', '..' )
const SCRIPT_NAME = 'session-wake-arm.sh'
const SCRIPT = join( VIEWER_ROOT, 'scripts', SCRIPT_NAME )
const MEMOVIEW_SRC = join( VIEWER_ROOT, 'src', 'MemoView.mjs' )
// Sibling repo — present in the workbench, ABSENT in CI. Read through an existsSync guard, never assumed.
const CORE_ROOT = resolve( VIEWER_ROOT, '..', 'core' )
const CORE_SKILL = join( CORE_ROOT, 'skills', 'memo', 'memo-revision-execute', 'SKILL.md' )
const SCRIPT_REF = /session-wake-arm\.sh/g

// The basis for every claim that needs the sibling repo. `it.skip` keeps the case in the report and in
// the skipped tally, and the note names the comparison set it did or did not have — so "ran with a
// basis" and "ran without one" are two different, readable outcomes instead of the same green. The gate
// itself is `withLiveCore` below: every one of those claims is ALSO direction-bound, so the two
// conditions are spelled as one constant rather than as an early `return` inside the case.
const CORE_READABLE = existsSync( CORE_ROOT )
const CROSS_REPO_NOTE = CORE_READABLE === true
    ? '1 of 1 cross-repo root judged'
    : 'SKIPPED, no comparison basis — repos/core is not checked out, 0 of 1 cross-repo roots judged'

// jest prints a test TITLE only on a TTY, and it swallows the `console` block of a suite that PASSES —
// measured on the full 132-suite run piped into a file: neither the title nor a console.warn survived,
// only the bare skip count. The missing basis is therefore written straight to stderr, the one channel
// that reaches the CI log unconditionally (the same road the AUTOBIND warnings already travel). The line
// names the path and the comparison set, and it is there in exactly the runs that could not judge.
if( CORE_READABLE !== true ) {
    process.stderr.write( `  SKIP EventChannelSunsetPRDV10: ${ CROSS_REPO_NOTE } — ${ CORE_ROOT }\n` )
}

const NEXT_PREFIX = 'NEXT: bash repos/viewer/scripts/session-wake-arm.sh'


const wait = ( ms ) => new Promise( ( done ) => setTimeout( done, ms ) )


const exists = async ( path ) => {
    try {
        await access( path )

        return true
    } catch {
        return false
    }
}


// The script is a long-running process on the happy path, so the runner never assumes an exit code of
// zero and never throws: it hands back code + output so a test can compare BOTH.
const runScript = async ( { args, env } ) => {
    const startedAt = Date.now()

    try {
        const done = await execFileP( 'bash', [ SCRIPT ].concat( args ), { 'env': env } )

        return { 'code': 0, 'stdout': done.stdout, 'stderr': done.stderr, 'elapsedMs': Date.now() - startedAt }
    } catch( error ) {
        return {
            'code': error.code === undefined ? -1 : error.code,
            'stdout': String( error.stdout ),
            'stderr': String( error.stderr ),
            'elapsedMs': Date.now() - startedAt
        }
    }
}


// A throwaway arm endpoint. Port 0 → the OS picks a free port, so parallel test files never collide.
const startArmServer = async ( { statusCode } ) => {
    const received = []
    const server = createServer( ( req, res ) => {
        const chunks = []

        req.on( 'data', ( chunk ) => { chunks.push( chunk ) } )
        req.on( 'end', () => {
            received.push( { 'method': req.method, 'url': req.url, 'body': Buffer.concat( chunks ).toString( 'utf-8' ) } )
            res.writeHead( statusCode, { 'Content-Type': 'application/json' } )
            res.end( JSON.stringify( { 'status': 'ok' } ) )
        } )
    } )

    await new Promise( ( ready ) => { server.listen( 0, '127.0.0.1', ready ) } )

    const port = server.address().port

    return {
        'url': `http://127.0.0.1:${ port }`,
        'port': port,
        'received': received,
        'stop': () => new Promise( ( done ) => { server.close( done ) } )
    }
}


const makeEnv = ( { dir, url, extra } ) => {
    return { ...process.env, 'WAKE_DIR': dir, 'MEMOVIEW_URL': url, 'WAKE_MAX_WAIT': '30', ...extra }
}


const waitUntil = async ( { probe, timeoutMs } ) => {
    const deadline = Date.now() + timeoutMs
    const attempt = async () => {
        if( probe() === true ) { return true }
        if( Date.now() > deadline ) { return false }

        await wait( 25 )

        return attempt()
    }

    return attempt()
}


const lastLine = ( { stdout } ) => {
    const lines = stdout.split( '\n' ).filter( ( line ) => line.trim().length > 0 )

    return lines.length === 0 ? '' : lines[ lines.length - 1 ]
}


// ---------------------------------------------------------------------------------------------------
// The sunset gate — pure functions, so the positive case can be measured long before it arrives.
// ---------------------------------------------------------------------------------------------------

// A6/A8: true only when the marker is present AND set to true. An empty or non-string source is NOT
// "false" — it is a missing comparison basis and therefore an error.
const detectLongRunningWait = ( { source } ) => {
    if( typeof source !== 'string' || source.length === 0 ) {
        throw new Error( 'no comparison basis — detectLongRunningWait needs a non-empty source string' )
    }

    return /LONG_RUNNING_WAIT_LIVE\s*=\s*true\b/.test( source )
}


// The ONE reading of the real marker, taken once at load time. Every direction-bound claim below hangs
// off this — a hard-wired direction is how this gate came to demand back the file it orders removed.
// src/MemoView.mjs is an IN-REPO file, so this read carries NO guard on purpose: not being able to read
// it is a defect of this repo, and the only thing added over a bare read is the sentence that names it.
const readRealMarker = () => {
    const source = readFileSync( MEMOVIEW_SRC, 'utf-8' )

    if( source.length === 0 ) {
        throw new Error( `no comparison basis — ${ MEMOVIEW_SRC } holds 0 chars` )
    }

    return {
        'path': MEMOVIEW_SRC,
        source,
        'chars': source.length,
        'hits': source.split( 'LONG_RUNNING_WAIT_LIVE' ).length - 1,
        'live': detectLongRunningWait( { source } )
    }
}


const REAL_MARKER = readRealMarker()

// The transition-intact gate. Claims like "the SOP still names the script" or "the walk finds four
// carriers" are true only while the marker is unset; after it is set the very same facts are the
// defect. `it.skip` keeps them in the report with the direction that was measured.
const withTransition = REAL_MARKER.live === false ? it : it.skip
const TRANSITION_NOTE = REAL_MARKER.live === false
    ? 'marker unset, transition intact'
    : 'SKIPPED, the marker is SET — these facts are the leftovers now, see the sunset verdict'

// Two conditions, one gate — a claim that needs the sibling repo AND an intact transition. Spelled as
// one constant instead of an early `return` inside the case, so a skip stays a skip in jest's tally.
const withLiveCore = CORE_READABLE === true && REAL_MARKER.live === false ? it : it.skip

// The script is the first entry of the sunset list, so a run in which it is already gone is a real
// state, not a broken checkout. Its absence is judged in ONE place — the sunset verdict, which names
// it as a missing required anchor while the marker is unset — instead of by ten ENOENT failures.
const SCRIPT_PRESENT = existsSync( SCRIPT )
const withScript = SCRIPT_PRESENT === true ? it : it.skip
const SCRIPT_NOTE = SCRIPT_PRESENT === true
    ? '1 of 1 script present'
    : 'SKIPPED, no script to run — 0 of 1 present, judged by the sunset verdict'

// Same channel as the cross-repo note above: jest swallows a passing suite's console block, so a
// missing basis goes to stderr, which reaches the CI log unconditionally.
if( REAL_MARKER.live !== false ) {
    process.stderr.write( `  NOTE EventChannelSunsetPRDV10: ${ TRANSITION_NOTE } — ${ REAL_MARKER.path }\n` )
}

if( SCRIPT_PRESENT !== true ) {
    process.stderr.write( `  SKIP EventChannelSunsetPRDV10: ${ SCRIPT_NOTE } — ${ SCRIPT }\n` )
}


// One straight road, no early exit: "the file is not there" is a measured OUTCOME of this reading, not
// a reason to leave. A pattern-less entry counts its own existence as its single hit.
const readOne = ( { path, pattern } ) => {
    const found = existsSync( path )
    const text = found === true ? readFileSync( path, 'utf-8' ) : ''
    const matched = pattern === null || found !== true ? null : text.match( pattern )
    const existenceHits = found === true ? 1 : 0
    const patternHits = matched === null ? 0 : matched.length

    return { path, found, 'hits': pattern === null ? existenceHits : patternHits, 'chars': text.length }
}


// One measurement shape for every sunset entry — an entry is a LIST of paths and an optional pattern,
// so "the file is gone" and "the reference is gone" are the same question asked twice.
const measurePlace = ( { id, label, paths, pattern, crossRepo, required } ) => {
    const readings = paths.map( ( path ) => readOne( { path, pattern } ) )
    const hits = readings.reduce( ( sum, reading ) => sum + reading.hits, 0 )
    const chars = readings.reduce( ( sum, reading ) => sum + reading.chars, 0 )
    const anyFile = readings.some( ( reading ) => reading.found === true )
    // A cross-repo path that is simply not checked out cannot be judged in either direction.
    const judged = crossRepo === false || anyFile === true

    return { id, label, paths, readings, hits, chars, judged, required, 'present': hits > 0 }
}


// ---------------------------------------------------------------------------------------------------
// THE LIST FINDS ITS OWN CARRIERS (Memo 080, Phase 9 close-out).
//
// It used to be COPIED — five entries, written down on the day the PRD was cut. Two carriers were built
// afterwards, repos/core/tests/event-channel-sop-rule8.test.mjs (7 cases nailed to the wording of rule 8)
// and repos/viewer/tests/manual/event-channel-wake-e2e.mjs, and neither reached the copy. Executing the
// copied list literally therefore BROKE: step 2 rewrites the SOP rule, and the core test that holds that
// exact wording was still there — measured, 0 pass / 7 fail. A copied list is wrong the moment the next
// file is written, so this one is a SEARCH: every file under the two repos that names the script is a
// carrier and is found on the day it is created. The walk states how many files it compared; a walk that
// finds nothing is a broken walk, never an empty green.
// ---------------------------------------------------------------------------------------------------
const WALK_ROOTS = [
    { 'root': VIEWER_ROOT, 'crossRepo': false },
    { 'root': CORE_ROOT, 'crossRepo': true }
]
const SKIP_DIRS = [ 'node_modules', 'coverage', 'test-results', 'dist', 'build' ]
const TEXT_EXTENSIONS = [ '.mjs', '.js', '.cjs', '.sh', '.md', '.json', '.yml', '.yaml' ]


const walkFiles = ( { dir } ) => {
    return readdirSync( dir, { 'withFileTypes': true } )
        .flatMap( ( entry ) => {
            const full = join( dir, entry.name )

            if( entry.isDirectory() === true ) {
                return SKIP_DIRS.includes( entry.name ) === true || entry.name.startsWith( '.' ) === true
                    ? []
                    : walkFiles( { 'dir': full } )
            }

            return entry.isFile() === true && TEXT_EXTENSIONS.includes( extname( entry.name ) ) === true ? [ full ] : []
        } )
}


const discoverCarriers = () => {
    const readable = WALK_ROOTS.filter( ( entry ) => existsSync( entry.root ) === true )
    const readings = readable.map( ( entry ) => {
        const files = walkFiles( { 'dir': entry.root } )

        return {
            'root': entry.root,
            'crossRepo': entry.crossRepo,
            'scanned': files.length,
            'carriers': files.filter( ( path ) => readFileSync( path, 'utf-8' ).includes( SCRIPT_NAME ) === true )
        }
    } )

    return {
        'rootsDeclared': WALK_ROOTS.length,
        'rootsRead': readable.length,
        'scanned': readings.reduce( ( sum, reading ) => sum + reading.scanned, 0 ),
        'carriers': readings.flatMap( ( reading ) => reading.carriers.map( ( path ) => ( { path, 'crossRepo': reading.crossRepo } ) ) )
    }
}


// A label is anchored to the repo it belongs to, NEVER to a directory above the checkout. Two levels up
// is called `memo-init` in the workbench and something else on any CI runner, so a label built from there
// is a different string in every environment and every assertion on it is a coin toss. `repos/viewer/…`
// and `repos/core/…` are the same string everywhere, and they are pure string work — an absent sibling
// repo still gets its correct name.
const REPO_LABELS = [
    { 'root': VIEWER_ROOT, 'prefix': 'repos/viewer' },
    { 'root': CORE_ROOT, 'prefix': 'repos/core' }
]


const labelOf = ( { path } ) => {
    const anchored = REPO_LABELS
        .map( ( entry ) => ( { 'prefix': entry.prefix, 'rest': relative( entry.root, path ) } ) )
        .filter( ( entry ) => entry.rest.length > 0 && entry.rest.startsWith( '..' ) !== true )

    if( anchored.length === 0 ) {
        throw new Error( `no repo anchor for ${ path } — a sunset label must be relative to its own repo` )
    }

    return `${ anchored[ 0 ][ 'prefix' ] }/${ anchored[ 0 ][ 'rest' ] }`
}


// The anchors WITHOUT which the transition is already broken. They are named, because the discovered
// half can only ever answer "is it still there" — it can never notice that something REQUIRED is gone.
const requiredPlaces = () => {
    return [
        { 'id': 'script', 'label': labelOf( { 'path': SCRIPT } ), 'paths': [ SCRIPT ], 'pattern': null, 'crossRepo': false },
        { 'id': 'sop-rule', 'label': `${ labelOf( { 'path': CORE_SKILL } ) } — rule 8 + workflow step 11`, 'paths': [ CORE_SKILL ], 'pattern': SCRIPT_REF, 'crossRepo': true },
        { 'id': 'sunset-test', 'label': labelOf( { 'path': SELF } ), 'paths': [ SELF ], 'pattern': null, 'crossRepo': false }
    ]
}


const sunsetPlaces = () => {
    const found = discoverCarriers()
    const anchors = requiredPlaces()
    const anchorPaths = anchors.flatMap( ( place ) => place.paths )
    const discovered = found.carriers
        .filter( ( carrier ) => anchorPaths.includes( carrier.path ) !== true )
        .map( ( carrier ) => ( {
            'id': labelOf( { 'path': carrier.path } ),
            'label': labelOf( { 'path': carrier.path } ),
            'paths': [ carrier.path ],
            'pattern': SCRIPT_REF,
            'crossRepo': carrier.crossRepo,
            'required': false
        } ) )
    const places = anchors
        .map( ( place ) => ( { ...place, 'required': true } ) )
        .concat( discovered )
        .map( ( place ) => measurePlace( place ) )

    return {
        places,
        'scanned': found.scanned,
        'rootsRead': found.rootsRead,
        'rootsDeclared': found.rootsDeclared,
        'discoveredCount': discovered.length
    }
}


const nameThem = ( { places } ) => places.map( ( place ) => place.label ).join( ' | ' )

// The red message hands over the search, not only its result: whoever reads it can re-derive the list
// on the spot, including files written after this run. Same command as the script header (A12).
const REPRODUCE = `grep -rl ${ SCRIPT_NAME } repos/viewer repos/core --exclude-dir=node_modules`


// The sibling repo is present in the workbench and ABSENT in CI, so this read has to be able to come
// back with "not checked out" as a NAMED outcome. An early return would count the unreadable case as a
// pass and hide it behind "# skipped 0".
const readCoreSkill = () => {
    const skipped = existsSync( CORE_SKILL ) !== true
    const text = skipped === true ? '' : readFileSync( CORE_SKILL, 'utf-8' )

    return {
        skipped,
        'chars': text.length,
        'scriptHits': text.split( 'session-wake-arm.sh' ).length - 1,
        'marker': text.includes( 'LONG_RUNNING_WAIT_LIVE' )
    }
}


// A7/A9: one verdict function, both directions. Marker not set → the REQUIRED anchors must be present.
// Marker set → EVERY place, anchor and discovered carrier alike, must be GONE, and the message names
// what is left. Only the anchors can go "missing": a discovered carrier is present by construction, so
// asking that half about the discovered ones would be a question that can never fail.
const evaluateSunset = ( { live, places } ) => {
    const judged = places.filter( ( place ) => place.judged === true )
    const unjudged = places.filter( ( place ) => place.judged !== true )
    const leftovers = judged.filter( ( place ) => place.present === true )
    const missing = judged.filter( ( place ) => place.present === false && place.required === true )
    const base = {
        live,
        'judgedCount': judged.length,
        'unjudgedCount': unjudged.length,
        'requiredCount': judged.filter( ( place ) => place.required === true ).length,
        leftovers,
        missing,
        unjudged
    }

    if( judged.length === 0 ) {
        return { ...base, 'status': false, 'message': 'no comparison basis — not a single sunset place could be read' }
    }

    if( live === true ) {
        return leftovers.length === 0
            ? { ...base, 'status': true, 'message': `sunset done — ${ judged.length } places compared, none left` }
            : {
                ...base,
                'status': false,
                'message': `LONG_RUNNING_WAIT_LIVE is set — remove the transition. Still present (${ leftovers.length } of ${ judged.length } places compared): ${ nameThem( { 'places': leftovers } ) } · this file goes with them, it is the last step · re-derive: ${ REPRODUCE }`
            }
    }

    return missing.length === 0
        ? { ...base, 'status': true, 'message': `transition intact — ${ judged.length } places compared, ${ base.requiredCount } of them required anchors, all present` }
        : {
            ...base,
            'status': false,
            'message': `the marker is not set, so the transition must be COMPLETE. Missing (${ missing.length } of ${ base.requiredCount } required anchors, ${ judged.length } places compared): ${ nameThem( { 'places': missing } ) }`
        }
}


// ---------------------------------------------------------------------------------------------------
describe( `PRD-V10 behaviour — arming, loud failure, ceiling, restart line (real shell script, ${ SCRIPT_NOTE })`, () => {

    withScript( 'A1: two arguments send EXACTLY ONE arm POST, and it happens BEFORE the wait loop', async () => {
        const dir = await mkdtemp( join( tmpdir(), 'memo-view-wake-v10a-' ) )
        const arm = await startArmServer( { 'statusCode': 200 } )
        const flag = join( dir, 'a1.flag' )

        const pending = runScript( { 'args': [ 'a1', 'T-a1' ], 'env': makeEnv( { dir, 'url': arm.url, 'extra': {} } ) } )
        const armed = await waitUntil( { 'probe': () => arm.received.length > 0, 'timeoutMs': 8000 } )

        // The flag is written only AFTER the arm was observed — so a WOKEN below proves the loop ran
        // after the arming, not instead of it.
        expect( armed ).toBe( true )
        expect( await exists( flag ) ).toBe( false )

        await writeFile( flag, 'T-a1' )

        const result = await pending

        expect( arm.received.length ).toBe( 1 )
        expect( arm.received[ 0 ][ 'method' ] ).toBe( 'POST' )
        expect( arm.received[ 0 ][ 'url' ] ).toBe( '/api/session/a1/arm' )
        expect( JSON.parse( arm.received[ 0 ][ 'body' ] ) ).toEqual( { 'transcriptId': 'T-a1' } )
        expect( result.stdout ).toContain( 'WOKEN a1 T-a1' )
        expect( result.code ).toBe( 0 )

        await arm.stop()
        await rm( dir, { 'recursive': true, 'force': true } )
    }, 30000 )

    withScript( 'A2: a NON-2xx arm answers ARM-FAILED / code 3 and never enters the loop (untouched flag proves it)', async () => {
        const dir = await mkdtemp( join( tmpdir(), 'memo-view-wake-v10b-' ) )
        const arm = await startArmServer( { 'statusCode': 500 } )
        const flag = join( dir, 'a2.flag' )

        // A flag that IS there: the loop would consume it instantly (one-shot). It survives → no loop.
        await writeFile( flag, 'T-a2' )

        const result = await runScript( { 'args': [ 'a2', 'T-a2' ], 'env': makeEnv( { dir, 'url': arm.url, 'extra': {} } ) } )

        expect( result.stdout ).toContain( 'ARM-FAILED a2' )
        expect( result.code ).toBe( 3 )
        expect( result.stdout ).not.toContain( 'WOKEN' )
        expect( result.stdout ).not.toContain( NEXT_PREFIX )
        expect( await exists( flag ) ).toBe( true )
        expect( arm.received.length ).toBe( 1 )

        await arm.stop()
        await rm( dir, { 'recursive': true, 'force': true } )
    }, 30000 )

    withScript( 'A2: a CLOSED port fails the same way — the class, not the case (2 failure modes compared)', async () => {
        const dir = await mkdtemp( join( tmpdir(), 'memo-view-wake-v10c-' ) )
        const arm = await startArmServer( { 'statusCode': 200 } )
        const closedUrl = arm.url

        await arm.stop()

        const flag = join( dir, 'a2b.flag' )

        await writeFile( flag, 'T-a2b' )

        const result = await runScript( { 'args': [ 'a2b', 'T-a2b' ], 'env': makeEnv( { dir, 'url': closedUrl, 'extra': {} } ) } )

        expect( result.stdout ).toContain( 'ARM-FAILED a2b' )
        expect( result.code ).toBe( 3 )
        expect( await exists( flag ) ).toBe( true )

        await rm( dir, { 'recursive': true, 'force': true } )
    }, 30000 )

    withScript( 'A3: ONE argument stays unchanged — no network call, no NEXT, payload echoed, flag consumed', async () => {
        const dir = await mkdtemp( join( tmpdir(), 'memo-view-wake-v10d-' ) )
        const arm = await startArmServer( { 'statusCode': 200 } )
        const flag = join( dir, 'a3.flag' )

        await writeFile( flag, 'T-a3-payload' )

        const result = await runScript( { 'args': [ 'a3' ], 'env': makeEnv( { dir, 'url': arm.url, 'extra': {} } ) } )

        expect( result.code ).toBe( 0 )
        expect( result.stdout ).toContain( 'WOKEN a3 T-a3-payload' )
        expect( result.stdout ).not.toContain( 'NEXT' )
        expect( await exists( flag ) ).toBe( false )
        // The url was handed in and pointed at a LIVE server — zero requests is a measurement, not a guess.
        expect( arm.received.length ).toBe( 0 )

        await arm.stop()
        await rm( dir, { 'recursive': true, 'force': true } )
    }, 30000 )

    withScript( 'A3: ONE argument with an EMPTY flag keeps the historical "WOKEN <id>" form', async () => {
        const dir = await mkdtemp( join( tmpdir(), 'memo-view-wake-v10e-' ) )
        const flag = join( dir, 'a3b.flag' )

        await writeFile( flag, '' )

        const result = await runScript( { 'args': [ 'a3b' ], 'env': makeEnv( { dir, 'url': 'http://127.0.0.1:1', 'extra': {} } ) } )

        expect( result.code ).toBe( 0 )
        expect( lastLine( { 'stdout': result.stdout } ) ).toBe( 'WOKEN a3b' )

        await rm( dir, { 'recursive': true, 'force': true } )
    }, 30000 )

    withScript( 'A4: the LAST line is the full restart command with two arguments, and absent with one (2 runs compared)', async () => {
        const dir = await mkdtemp( join( tmpdir(), 'memo-view-wake-v10f-' ) )
        const arm = await startArmServer( { 'statusCode': 200 } )
        const twoFlag = join( dir, 'a4.flag' )
        const oneFlag = join( dir, 'a4one.flag' )

        await writeFile( twoFlag, 'T-a4' )
        await writeFile( oneFlag, 'T-a4' )

        const two = await runScript( { 'args': [ 'a4', 'T-a4' ], 'env': makeEnv( { dir, 'url': arm.url, 'extra': {} } ) } )
        const one = await runScript( { 'args': [ 'a4one' ], 'env': makeEnv( { dir, 'url': arm.url, 'extra': {} } ) } )

        expect( lastLine( { 'stdout': two.stdout } ) ).toBe( `${ NEXT_PREFIX } a4 T-a4` )
        expect( one.stdout ).not.toContain( 'NEXT' )
        expect( one.stdout.split( '\n' ).filter( ( line ) => line.startsWith( 'NEXT' ) ).length ).toBe( 0 )

        await arm.stop()
        await rm( dir, { 'recursive': true, 'force': true } )
    }, 30000 )

    withScript( 'A5: WAKE_MAX_WAIT=1 without a flag ends as WAIT-EXPIRED / code 4 + NEXT, and leaves no process', async () => {
        const dir = await mkdtemp( join( tmpdir(), 'memo-view-wake-v10g-' ) )
        const arm = await startArmServer( { 'statusCode': 200 } )
        const sessionId = `a5-${ process.pid }`

        const result = await runScript( {
            'args': [ sessionId, 'T-a5' ],
            'env': makeEnv( { dir, 'url': arm.url, 'extra': { 'WAKE_MAX_WAIT': '1' } } )
        } )

        expect( result.stdout ).toContain( `WAIT-EXPIRED ${ sessionId }` )
        expect( result.code ).toBe( 4 )
        expect( lastLine( { 'stdout': result.stdout } ) ).toBe( `${ NEXT_PREFIX } ${ sessionId } T-a5` )
        expect( result.elapsedMs ).toBeLessThan( 3000 )

        // Counter-probe scoped to THIS run's session id: a machine-wide count would measure other
        // people's watchers, and the leak this asserts is our own. The bracket around the first letter
        // keeps the probe out of its OWN result — measured: without it the count was 2 (the `bash -c`
        // and the `grep`, both carrying the pattern in their argv), which would have been a phantom leak.
        const probe = await execFileP( 'bash', [ '-c', `ps -Ao args= | grep -c "[s]ession-wake-arm.sh ${ sessionId }" || true` ] )

        expect( probe.stdout.trim() ).toBe( '0' )

        await arm.stop()
        await rm( dir, { 'recursive': true, 'force': true } )
    }, 30000 )

    withScript( 'A10: the background-tasks guard is FIRST — no arm call, no wait, message unchanged', async () => {
        const dir = await mkdtemp( join( tmpdir(), 'memo-view-wake-v10h-' ) )
        const arm = await startArmServer( { 'statusCode': 200 } )

        const result = await runScript( {
            'args': [ 'a10', 'T-a10' ],
            'env': makeEnv( { dir, 'url': arm.url, 'extra': { 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS': '1' } } )
        } )

        expect( result.code ).toBe( 0 )
        expect( result.stdout ).toContain( 'background tasks disabled' )
        expect( result.stdout ).not.toContain( 'WOKEN' )
        expect( result.stdout ).not.toContain( 'NEXT' )
        expect( arm.received.length ).toBe( 0 )

        await arm.stop()
        await rm( dir, { 'recursive': true, 'force': true } )
    }, 30000 )

    withScript( 'A10: the guard also holds for "true" and still makes no network call (2 spellings compared)', async () => {
        const dir = await mkdtemp( join( tmpdir(), 'memo-view-wake-v10i-' ) )
        const arm = await startArmServer( { 'statusCode': 200 } )

        const result = await runScript( {
            'args': [ 'a10b', 'T-a10b' ],
            'env': makeEnv( { dir, 'url': arm.url, 'extra': { 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS': 'true' } } )
        } )

        expect( result.code ).toBe( 0 )
        expect( result.stdout ).toContain( 'background tasks disabled' )
        expect( arm.received.length ).toBe( 0 )

        await arm.stop()
        await rm( dir, { 'recursive': true, 'force': true } )
    }, 30000 )

    withScript( 'usage without a sessionId still exits 2 and names both arguments', async () => {
        const result = await runScript( { 'args': [], 'env': { ...process.env } } )

        expect( result.code ).toBe( 2 )
        expect( result.stderr ).toContain( 'usage: session-wake-arm.sh <sessionId> [transcriptId]' )
    }, 30000 )
} )


describe( `PRD-V10 source shape — loopback only, transitional header, house style (A11, A12, A15, ${ SCRIPT_NOTE })`, () => {

    const scriptSource = () => {
        const text = readFileSync( SCRIPT, 'utf-8' )

        expect( text.length ).toBeGreaterThan( 0 )

        return text
    }

    const codeLines = () => {
        return scriptSource()
            .split( '\n' )
            .filter( ( line ) => line.trim().startsWith( '#' ) !== true )
            .filter( ( line ) => line.trim().length > 0 )
    }

    withScript( 'A11: only loopback addresses appear, and none of them binds or listens (4 patterns compared)', () => {
        const source = scriptSource()
        const lines = codeLines()
        const foreign = source.match( /https?:\/\/(?!127\.0\.0\.1)[A-Za-z0-9._-]+/g )
        const listeners = lines.filter( ( line ) => /(^|\s)(nc|ncat|socat)\s|--listen|http\.server|listen\(/.test( line ) )

        expect( source.includes( '0.0.0.0' ) ).toBe( false )
        expect( foreign ).toBe( null )
        expect( source.includes( 'http://127.0.0.1:3333' ) ).toBe( true )
        expect( listeners.length ).toBe( 0 )
        expect( lines.length ).toBeGreaterThan( 20 )
    } )

    withScript( 'A12: the header names successor, marker, sunset test and HOW to reproduce the list (7 phrases)', () => {
        const header = scriptSource().split( 'set -u' )[ 0 ]
        // The header names the SEARCH, not a copy of its result. A copied enumeration in a comment is the
        // very drift this PRD's close-out removed: it was right on the day it was written and wrong two
        // files later. What must stand here is the reproduce command and the required anchors.
        const phrases = [
            'TRANSITIONAL',
            'PRD-V9',
            'LONG_RUNNING_WAIT_LIVE',
            'tests/unit/EventChannelSunsetPRDV10.test.mjs',
            'Sunset list',
            'memo-revision-execute/SKILL.md',
            `grep -rl ${ SCRIPT_NAME } repos/viewer repos/core`
        ]
        const missing = phrases.filter( ( phrase ) => header.includes( phrase ) !== true )

        expect( header.length ).toBeGreaterThan( 500 )
        expect( missing ).toEqual( [] )
    } )

    withScript( 'A15: set -u stays, the loop stays an until-loop, and no code line uses while (2 counts compared)', () => {
        const lines = codeLines()
        const whileLoops = lines.filter( ( line ) => /^\s*while\s/.test( line ) )
        const untilLoops = lines.filter( ( line ) => /^\s*until\s/.test( line ) )

        expect( lines.filter( ( line ) => line.trim() === 'set -u' ).length ).toBe( 1 )
        expect( whileLoops.length ).toBe( 0 )
        expect( untilLoops.length ).toBe( 1 )
    } )

    withScript( 'WAKE_DIR is a TEST seam only — the server side has no such override (2 sides compared)', () => {
        const script = scriptSource()
        const server = readFileSync( MEMOVIEW_SRC, 'utf-8' )

        expect( server.length ).toBeGreaterThan( 1000 )
        // The script may be pointed at a throwaway dir; the SERVER writes to a constant. Measured in the
        // first e2e run: overriding WAKE_DIR there produced WAIT-EXPIRED while the server reported
        // "woke 1 armed session[s]" — the two were looking at different directories. Whoever drives the
        // REAL server must leave the default alone, and this pair of counts says why.
        expect( script.includes( 'WAKE_DIR="${WAKE_DIR:-' ) ).toBe( true )
        expect( server.includes( "process.env[ 'WAKE_DIR' ]" ) ).toBe( false )
        expect( server.includes( 'const WAKE_DIR = join( tmpdir(), \'memo-view-wake\' )' ) ).toBe( true )
    } )

    withScript( 'the three named ends and their exit codes exist in the script, each exactly once (3 compared)', () => {
        const source = scriptSource()
        const counted = [ 'WOKEN $SESSION_ID', 'ARM-FAILED $SESSION_ID', 'WAIT-EXPIRED $SESSION_ID' ]
            .map( ( needle ) => ( { needle, 'hits': source.split( needle ).length - 1 } ) )

        expect( counted.filter( ( entry ) => entry.hits === 0 ) ).toEqual( [] )
        expect( source.includes( 'exit 3' ) ).toBe( true )
        expect( source.includes( 'exit 4' ) ).toBe( true )
        // ONE home for the restart line — a second spelling would drift on the first edit.
        expect( source.split( 'NEXT_LINE="NEXT: bash' ).length - 1 ).toBe( 1 )
    } )
} )


describe( 'PRD-V10 sunset gate — the transition has a machine-enforced end (A6-A9)', () => {

    it( 'A6: the marker is read in all three shapes — set, set to false, absent (3 samples compared)', () => {
        const samples = [
            { 'label': 'set', 'source': "const LONG_RUNNING_WAIT_LIVE = true\nexport { LONG_RUNNING_WAIT_LIVE }\n", 'expected': true },
            { 'label': 'false', 'source': "const LONG_RUNNING_WAIT_LIVE = false\nexport { LONG_RUNNING_WAIT_LIVE }\n", 'expected': false },
            { 'label': 'absent', 'source': "const SOMETHING_ELSE = true\nexport { SOMETHING_ELSE }\n", 'expected': false }
        ]
        const wrong = samples.filter( ( sample ) => detectLongRunningWait( { 'source': sample.source } ) !== sample.expected )

        expect( samples.length ).toBe( 3 )
        expect( wrong.map( ( sample ) => sample.label ) ).toEqual( [] )
    } )

    it( 'A8: an EMPTY or non-string source FAILS loudly — a missing basis is never a quiet false (3 inputs)', () => {
        const bad = [ '', null, undefined ]
        const survived = bad.filter( ( source ) => {
            try {
                detectLongRunningWait( { source } )

                return true
            } catch {
                return false
            }
        } )

        expect( survived ).toEqual( [] )
        expect( () => detectLongRunningWait( { 'source': '' } ) ).toThrow( /no comparison basis/ )
    } )

    it( `A7: the REAL src/MemoView.mjs is the basis and two independent readings agree (1 file, ${ REAL_MARKER.hits } hits)`, () => {
        // The direction is MEASURED here, never assumed — and by two mechanisms that fail differently:
        // the gate's regex, and a split on the marker name that only accepts a real assignment. A single
        // reading would be an assumption; `=== true` in some later comparison must not read as "set".
        const assignments = REAL_MARKER.source
            .split( 'LONG_RUNNING_WAIT_LIVE' )
            .slice( 1 )
            .filter( ( rest ) => rest.trimStart().startsWith( '= true' ) === true )

        expect( REAL_MARKER.path ).toBe( MEMOVIEW_SRC )
        expect( REAL_MARKER.chars ).toBeGreaterThan( 1000 )
        expect( detectLongRunningWait( { 'source': REAL_MARKER.source } ) ).toBe( assignments.length > 0 )
        expect( REAL_MARKER.live ).toBe( assignments.length > 0 )
    } )

    // A7 + A9 on the road that really fires. This case used to hard-wire `live: false`, which made the
    // gate demand back the deleted script on the very day its removal was ordered — and the only red
    // line sunset day produced was a bare `Expected: 0 / Received: 2`. Both halves are fixed here: the
    // direction comes from the real marker, and the compared VALUE is the message, so the names of the
    // remaining places are what jest prints.
    it( `A7/A9: the gate follows the REAL marker and the failure NAMES every place left (marker live=${ REAL_MARKER.live })`, () => {
        const { places, scanned, rootsRead, rootsDeclared } = sunsetPlaces()
        const verdict = evaluateSunset( { 'live': REAL_MARKER.live, 'places': places } )
        const outcome = verdict.status === true ? 'GREEN' : verdict.message

        // Say what was compared, and never pass on an empty comparison field: a walk that scanned no
        // file is a broken walk, not an empty green. What may NOT be demanded here is a fixed number of
        // carriers — after the sunset there are none left, and that is the goal, not a defect.
        expect( rootsDeclared ).toBe( 2 )
        expect( rootsRead ).toBeGreaterThanOrEqual( 1 )
        expect( scanned ).toBeGreaterThan( 100 )
        expect( verdict.judgedCount ).toBeGreaterThanOrEqual( 2 )
        expect( places.filter( ( place ) => place.present === true && place.chars === 0 ) ).toEqual( [] )
        expect( outcome ).toBe( 'GREEN' )
    } )

    withTransition( `A7: while the transition is intact every required anchor is present (${ TRANSITION_NOTE })`, () => {
        const { places, discoveredCount } = sunsetPlaces()
        const verdict = evaluateSunset( { 'live': false, 'places': places } )
        const outcome = verdict.status === true ? 'GREEN' : verdict.message

        // The floors belong in THIS direction only: while the marker is unset the walk must find the
        // carriers it was built to find. They are the counter-probe against a silently shrinking search.
        expect( discoveredCount ).toBeGreaterThanOrEqual( 3 )
        expect( verdict.requiredCount ).toBeGreaterThanOrEqual( 2 )
        expect( verdict.judgedCount ).toBeGreaterThanOrEqual( 5 )
        expect( verdict.missing ).toEqual( [] )
        expect( outcome ).toBe( 'GREEN' )
    } )

    withTransition( `the walk FINDS the in-repo carrier the copied list never had (1 named path, 4 labels, ${ TRANSITION_NOTE })`, () => {
        const { places } = sunsetPlaces()
        const labels = places.map( ( place ) => place.label )

        // This one was built after the list was written down and is a reason the list is a search now.
        // It is cross-checked against the source of truth: it is on the list because it names the
        // script, and the assertion says so with the hit count.
        const late = 'repos/viewer/tests/manual/event-channel-wake-e2e.mjs'
        const found = places.find( ( place ) => place.label === late )

        expect( labels ).toContain( late )
        expect( found.hits ).toBeGreaterThan( 0 )
        // and the older three are still on it — the search replaced the copy, it did not shrink it
        expect( labels ).toContain( 'repos/viewer/scripts/session-wake-arm.sh' )
        expect( labels ).toContain( 'repos/viewer/tests/unit/ReverseChannelWakePRD031.test.mjs' )
        expect( labels ).toContain( 'repos/viewer/tests/unit/Phase3ViewerFeatures.test.mjs' )
    } )

    it( 'the in-repo half is compared in FULL even when the sibling repo is absent (2 places minimum)', () => {
        const { places } = sunsetPlaces()
        const judged = places.filter( ( place ) => place.judged === true ).length
        const unjudged = places.filter( ( place ) => place.judged !== true )

        // Whatever the sibling repo does, the in-repo places must have been compared — the skip may
        // never shrink the comparison to nothing. And an unjudged place can only ever be a cross-repo
        // one: an in-repo file that cannot be read is a failure, not an excuse. The floor is the two
        // in-repo ANCHORS, which exist as questions in both directions; the carriers on top of them are
        // counted in the transition-intact case, because after the sunset there are none.
        expect( judged ).toBeGreaterThanOrEqual( 2 )
        expect( unjudged.filter( ( place ) => place.label.startsWith( 'repos/core/' ) !== true ) ).toEqual( [] )
    } )

    withTransition( `the in-repo half carries its four carriers while the transition lives (${ TRANSITION_NOTE })`, () => {
        const { places } = sunsetPlaces()
        const judged = places.filter( ( place ) => place.judged === true ).length

        expect( judged ).toBeGreaterThanOrEqual( 4 )
    } )

    withLiveCore( `A7: the running SOP rule in repos/core names the script (${ CROSS_REPO_NOTE }, ${ TRANSITION_NOTE })`, () => {
        const reading = readCoreSkill()

        expect( reading.skipped ).toBe( false )
        expect( reading.chars ).toBeGreaterThan( 1000 )
        expect( reading.scriptHits ).toBeGreaterThanOrEqual( 2 )
        expect( reading.marker ).toBe( true )
    } )

    withLiveCore( `the walk FINDS the cross-repo carrier and NAMES it in the red verdict (${ CROSS_REPO_NOTE }, ${ TRANSITION_NOTE })`, () => {
        const { places } = sunsetPlaces()
        const late = 'repos/core/tests/event-channel-sop-rule8.test.mjs'
        const found = places.find( ( place ) => place.label === late )
        const verdict = evaluateSunset( { 'live': true, 'places': places } )

        expect( found ).not.toBeUndefined()
        expect( found.judged ).toBe( true )
        expect( found.hits ).toBeGreaterThan( 0 )
        expect( verdict.message ).toContain( 'event-channel-sop-rule8.test.mjs' )
    } )

    withTransition( `A9: a spoofed source WITH the marker turns the gate red and NAMES every remaining place (${ TRANSITION_NOTE })`, () => {
        const spoofed = "// spoofed for the gate probe\nconst LONG_RUNNING_WAIT_LIVE = true\n"
        const live = detectLongRunningWait( { 'source': spoofed } )
        const { places } = sunsetPlaces()
        const verdict = evaluateSunset( { live, 'places': places } )

        expect( live ).toBe( true )
        expect( verdict.status ).toBe( false )
        expect( verdict.leftovers.length ).toBe( verdict.judgedCount )
        expect( verdict.message ).toContain( 'LONG_RUNNING_WAIT_LIVE is set' )
        expect( verdict.message ).toContain( 'session-wake-arm.sh' )
        expect( verdict.message ).toContain( 'EventChannelSunsetPRDV10.test.mjs' )
        expect( verdict.message ).toContain( 'ReverseChannelWakePRD031.test.mjs' )
        expect( verdict.message ).toContain( `of ${ verdict.judgedCount } places compared` )
    } )

    // The naming property, proven WITHOUT the tree: the message has to carry every leftover label even
    // when the walk finds nothing at all. The spoofed-source case above measures the real carriers while
    // they exist; this one keeps the property measured on the day they do not.
    it( 'A9: the red message names EVERY leftover, one label per place (3 synthetic places compared)', () => {
        const synthetic = [ 'alpha.sh', 'beta.md', 'gamma.test.mjs' ]
            .map( ( label, index ) => ( {
                'id': label,
                label,
                'paths': [ label ],
                'readings': [],
                'hits': index + 1,
                'chars': 10,
                'judged': true,
                'required': false,
                'present': true
            } ) )
        const verdict = evaluateSunset( { 'live': true, 'places': synthetic } )
        const unnamed = synthetic.filter( ( place ) => verdict.message.includes( place.label ) !== true )

        expect( verdict.status ).toBe( false )
        expect( unnamed ).toEqual( [] )
        expect( verdict.message ).toContain( '3 of 3 places compared' )
        expect( verdict.message ).toContain( REPRODUCE )
    } )

    it( 'A9: with the marker set and every place gone the gate goes green again (3 anchors minimum)', () => {
        const { places } = sunsetPlaces()
        const gone = places.map( ( place ) => ( { ...place, 'hits': 0, 'present': false } ) )
        const verdict = evaluateSunset( { 'live': true, 'places': gone } )

        // The three REQUIRED anchors are questions, not files — they are asked in both directions, so
        // this floor holds before and after the sunset. Carriers on top of them are counted elsewhere.
        expect( gone.length ).toBeGreaterThanOrEqual( 3 )
        expect( verdict.status ).toBe( true )
        expect( verdict.message ).toContain( 'sunset done' )
    } )

    it( 'A8: a verdict with NOTHING to compare is a FAILURE, not an empty green', () => {
        const verdict = evaluateSunset( { 'live': false, 'places': [] } )

        expect( verdict.status ).toBe( false )
        expect( verdict.judgedCount ).toBe( 0 )
        expect( verdict.message ).toContain( 'no comparison basis' )
    } )

    it( 'A8: an unreadable cross-repo place is reported as UNJUDGED, never as removed', () => {
        const missingCrossRepo = measurePlace( {
            'id': 'sibling',
            'label': 'a sibling repo that is not checked out',
            'paths': [ join( VIEWER_ROOT, 'no-such-sibling', 'SKILL.md' ) ],
            'pattern': SCRIPT_REF,
            'crossRepo': true,
            'required': true
        } )
        const inRepoGone = measurePlace( {
            'id': 'gone',
            'label': 'an in-repo REQUIRED anchor that is really gone',
            'paths': [ join( VIEWER_ROOT, 'no-such-file.sh' ) ],
            'pattern': null,
            'crossRepo': false,
            'required': true
        } )

        expect( missingCrossRepo.judged ).toBe( false )
        expect( inRepoGone.judged ).toBe( true )
        expect( inRepoGone.present ).toBe( false )

        const verdict = evaluateSunset( { 'live': false, 'places': [ missingCrossRepo, inRepoGone ] } )

        expect( verdict.unjudgedCount ).toBe( 1 )
        expect( verdict.judgedCount ).toBe( 1 )
        expect( verdict.status ).toBe( false )
    } )

    // The other half of the same rule: a DISCOVERED carrier can never be "missing" — it is on the list
    // BECAUSE it was found — so asking that question about it would be a check that cannot fail. This
    // states which of the two halves carries the "transition intact" direction, and that it is not empty.
    it( 'a discovered carrier that vanished is not counted as a missing anchor (2 kinds compared)', () => {
        const discoveredGone = measurePlace( {
            'id': 'discovered',
            'label': 'a discovered carrier that is no longer there',
            'paths': [ join( VIEWER_ROOT, 'no-such-carrier.mjs' ) ],
            'pattern': SCRIPT_REF,
            'crossRepo': false,
            'required': false
        } )
        // The present anchor is THIS file: it is a required anchor of the list and it necessarily
        // exists while it is running — so the case measures the two kinds against each other in both
        // directions, instead of borrowing a file the sunset is allowed to delete.
        const anchorPresent = measurePlace( {
            'id': 'sunset-test',
            'label': labelOf( { 'path': SELF } ),
            'paths': [ SELF ],
            'pattern': null,
            'crossRepo': false,
            'required': true
        } )

        const verdict = evaluateSunset( { 'live': false, 'places': [ discoveredGone, anchorPresent ] } )

        expect( anchorPresent.present ).toBe( true )
        expect( discoveredGone.present ).toBe( false )
        expect( verdict.judgedCount ).toBe( 2 )
        expect( verdict.requiredCount ).toBe( 1 )
        expect( verdict.missing ).toEqual( [] )
        expect( verdict.status ).toBe( true )
        expect( verdict.message ).toContain( '1 of them required anchors' )
    } )
} )
