// deep-link-acceptance.mjs — PRD-34 (Memo 081, Kap 29 / WI-067) against a REAL browser.
//
// WHY THIS EXISTS. Before the /doc/ route (PRD-33) a fresh browser context could not reach a document
// at all: measured, the auto-select branch fired in 0 of 2 consecutive sockets because documents[0]
// carries 0 revisions, and every /doc/ form answered 404. Six automation attempts are on record as
// having failed (REV-16.md:2709). So every surface check so far had to invent its own way in — the last
// one (BERICHT-browser-abnahme.md) wrote SEVEN throwaway harnesses that live outside the repo. This
// file is the ONE way in, and it is a FIXTURE, not a script: successor orders import
// runDeepLinkAcceptance() instead of copying a click path.
//
// WHAT IS MEASURED PER TARGET, and why it is more than "the page answered 200":
//   * the HTTP status of the deep link itself,
//   * the FIRST `content` frame the socket delivers, read straight off the wire — it carries
//     documentId and fileName, so "did the surface open the NAMED revision" is answered by the
//     transport, not guessed from pixels,
//   * the rendered surface: the document title zone shows THIS document's memo name and #content
//     carries real text. A green transport over an empty page is not an acceptance.
// The sidebar's active row is RECORDED, never required: showOnlyFullRevisions hides prepare/update
// rows, which is PRD-35's subject (§ N2). A number that is reported is honest; a check that is
// silently skipped is not.
//
// WHAT MAKES IT NOT VACUUM-GREEN. Three guards, all mandatory, all printed:
//   (a) every run prints <checked> / <targets>; zero targets is RED, never green.
//   (b) a NEGATIVE control: an invented documentId must answer 404 and must render no document.
//       If it passes, the fixture is reading nothing and the positive numbers are worthless.
//   (c) a POSITIVE control against a defect that is open TODAY, so an assertion that can never fail
//       is detected as such.
// And determinism is the subject, not a side effect: the same targets are run N times and the full
// result object must be identical each time — six attempts failed on non-determinism, not on one
// wrong pixel.
//
// Run: MEMOVIEW_NO_BROWSER=1 node tests/manual/deep-link-acceptance.mjs --repeat 5
//      MEMOVIEW_NO_BROWSER=1 node tests/manual/deep-link-acceptance.mjs --origin http://localhost:3333
//      MEMOVIEW_NO_BROWSER=1 node tests/manual/deep-link-acceptance.mjs --force-blocked
// Exits 0 on success, 1 on any fail, 1 with BLOCKED when playwright is not resolvable.
//
// REPO BOUNDARY (§ S4). Without --origin the fixture seeds its OWN .memo tree in the OS temp dir and
// boots the server against it, so it reads nothing outside this repo and CI — which checks this repo
// out ALONE — could run it. With --origin it measures a server somebody else started; that server's
// stock is then whatever that server registered, and the run prints how much that was.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { MemoView } from '../../src/MemoView.mjs'


// The same anchor chain the four existing playwright harnesses use (graph-view-e2e.mjs:52-55). The
// viewer buys no playwright dependency; § I4 measured that it resolves from OUTSIDE this repo, and
// § A6 requires the run to say from where.
const PLAYWRIGHT_ANCHORS = [
    resolve( new URL( '../../', import.meta.url ).pathname, '..', 'memo-init.github.io', 'package.json' ),
    resolve( new URL( '../../', import.meta.url ).pathname, 'package.json' )
]

// § A0.8: 3333 is the user's shared server and is never seized. This harness owns 3392 and gives it
// back. The inventory is printed so a busy port is a named finding, not a mystery timeout.
const OWN_PORT = 3392
const PORT_INVENTORY = [ 3333, 4444, 5555, 6666, 7777, 8888, OWN_PORT ]

// The invented address of the negative control (§ A2). It must never be registrable.
const INVENTED_DOCUMENT_ID = 'erfunden--gibt-es-nicht'
const INVENTED_LABEL = 'REV-99'

// The positive control (§ A3, § S2c): a defect that is open TODAY. The assertion below MUST fail.
const POSITIVE_CONTROL = {
    'documentId': 'memo-init--081-memo-maschine-konvergenz-befunde-und-ver',
    'label': 'REV-16'
}

const DEFAULT_PER_FORM = 6
const DEFAULT_REPEATS = 5
const PAGE_TIMEOUT_MS = 20000


// ---------------------------------------------------------------------------------------------
// Pure parts. Everything below this line up to runDeepLinkAcceptance is free of browser and server,
// which is what tests/unit/DeepLinkAcceptancePRD34.test.mjs pins — tests/manual/** does not run
// under `npm test`, so without those unit cases NOTHING would protect this fixture from decay.
// ---------------------------------------------------------------------------------------------


// The label form of a revision file name. The definition of a label is the file name without .md
// (PRD-33 § S1) — this classification exists only so a run can PROVE its target set spans the forms
// instead of accidentally sampling twenty times the same shape.
const labelFormOf = ( { fileName } ) => {
    const struct = { 'form': 'other', 'label': null }

    if( typeof fileName !== 'string' || fileName.endsWith( '.md' ) !== true ) { return struct }

    const label = fileName.slice( 0, -3 )

    if( label.length === 0 ) { return struct }

    struct[ 'label' ] = label

    if( /-prepare$/.test( label ) === true ) { struct[ 'form' ] = 'prepare' }
    else if( /-update$/.test( label ) === true ) { struct[ 'form' ] = 'update' }
    else if( /^REV-\d+$/.test( label ) === true ) { struct[ 'form' ] = 'REV-NN' }

    return struct
}


// Derive the targets from the STOCK the server reports, never from a constant in this file. A
// hard-wired documentId would solve the case and leave the class open (§ S1). The order is fully
// sorted before the take, so two runs against the same stock derive the SAME list — determinism
// starts here, not in the browser.
// NO SILENT DEFAULT: a missing documents array is a named failure, not an empty list that passes.
const deriveTargets = ( { documents, perForm } ) => {
    const struct = { 'status': false, 'targets': [], 'documentsRead': 0, 'revisionsRead': 0, 'formCounts': {}, 'missingForms': [], 'reason': null }

    if( Array.isArray( documents ) !== true ) {
        struct[ 'reason' ] = 'documents is not an array — nothing to derive targets from'

        return struct
    }

    const perFormCount = Number.isInteger( perForm ) === true && perForm > 0 ? perForm : DEFAULT_PER_FORM

    struct[ 'documentsRead' ] = documents.length

    const candidates = documents
        .flatMap( ( doc ) => {
            const revisions = Array.isArray( doc[ 'revisions' ] ) === true ? doc[ 'revisions' ] : []

            return revisions.map( ( rev ) => {
                const { form, label } = labelFormOf( { 'fileName': rev[ 'fileName' ] } )

                return {
                    'documentId': doc[ 'documentId' ],
                    'memoName': doc[ 'memoName' ],
                    'fileName': rev[ 'fileName' ],
                    label,
                    form
                }
            } )
        } )
        .filter( ( entry ) => typeof entry[ 'documentId' ] === 'string' && entry[ 'label' ] !== null )

    struct[ 'revisionsRead' ] = candidates.length

    const forms = [ 'REV-NN', 'prepare', 'update', 'other' ]

    struct[ 'formCounts' ] = forms
        .reduce( ( acc, form ) => {
            acc[ form ] = candidates.filter( ( entry ) => entry[ 'form' ] === form ).length

            return acc
        }, {} )

    struct[ 'missingForms' ] = forms.filter( ( form ) => struct[ 'formCounts' ][ form ] === 0 )

    struct[ 'targets' ] = forms
        .flatMap( ( form ) => {
            return candidates
                .filter( ( entry ) => entry[ 'form' ] === form )
                .sort( ( a, b ) => `${ a[ 'documentId' ] }/${ a[ 'label' ] }`.localeCompare( `${ b[ 'documentId' ] }/${ b[ 'label' ] }` ) )
                .slice( 0, perFormCount )
        } )

    if( struct[ 'targets' ].length === 0 ) {
        struct[ 'reason' ] = `no target could be derived from ${ documents.length } document(s) — an empty target set is RED, never green`

        return struct
    }

    struct[ 'status' ] = true

    return struct
}


// The balance line. It exists so that a run can NOT report a verdict without reporting how much it
// compared — § A1 and the report format both hang off this one string.
const formatBalance = ( { checked, total } ) => {
    const safeChecked = Number.isInteger( checked ) === true ? checked : 0
    const safeTotal = Number.isInteger( total ) === true ? total : 0

    return { 'line': `${ safeChecked } / ${ safeTotal }` }
}


// The address builder — ONE spelling, mirroring the client's docPathFor and the server's
// parseDeepLinkPath. The label is encoded, so a label carrying a reserved character still produces
// the address the parser reads back.
const deepLinkPathFor = ( { documentId, label } ) => {
    const base = `/doc/${ encodeURIComponent( String( documentId ) ) }`

    if( label === null || label === undefined || label === '' ) { return { 'path': base } }

    return { 'path': `${ base }/${ encodeURIComponent( String( label ) ) }` }
}


// The determinism comparator (§ A4). It compares the FULL per-target result of each run, not a
// counter: two runs with the same hit COUNT but different HITS are not identical, and saying so is
// the whole point. It also names the first difference, because "4 / 5" without the deviation is a
// number, not a finding.
const compareRuns = ( { runs } ) => {
    const struct = { 'status': false, 'identical': 0, 'total': 0, 'firstDifference': null }

    if( Array.isArray( runs ) !== true || runs.length === 0 ) {
        struct[ 'firstDifference' ] = 'no run to compare — a determinism verdict without runs is not a verdict'

        return struct
    }

    struct[ 'total' ] = runs.length

    const reference = JSON.stringify( runs[ 0 ] )

    const matches = runs.filter( ( run ) => JSON.stringify( run ) === reference )

    struct[ 'identical' ] = matches.length

    const deviating = runs
        .map( ( run, index ) => { return { index, 'json': JSON.stringify( run ) } } )
        .filter( ( entry ) => entry[ 'json' ] !== reference )

    if( deviating.length === 0 ) {
        struct[ 'status' ] = runs.length > 1

        if( struct[ 'status' ] !== true ) {
            struct[ 'firstDifference' ] = 'a single run proves nothing about repeatability — N = 1 is not a PASS'
        }

        return struct
    }

    const first = deviating[ 0 ]
    const referenceRun = runs[ 0 ]
    const otherRun = runs[ first[ 'index' ] ]

    const changed = ( Array.isArray( referenceRun ) === true ? referenceRun : [] )
        .map( ( entry, index ) => {
            const counterpart = Array.isArray( otherRun ) === true ? otherRun[ index ] : undefined

            return JSON.stringify( entry ) === JSON.stringify( counterpart )
                ? null
                : `${ entry === null || entry === undefined ? `#${ index }` : entry[ 'address' ] }: run 1 ${ JSON.stringify( entry ) } vs run ${ first[ 'index' ] + 1 } ${ JSON.stringify( counterpart ) }`
        } )
        .filter( ( entry ) => entry !== null )

    struct[ 'firstDifference' ] = changed.length === 0
        ? `run ${ first[ 'index' ] + 1 } differs in length: ${ JSON.stringify( referenceRun ).length } vs ${ first[ 'json' ].length } characters`
        : changed[ 0 ]

    return struct
}


// Playwright resolution, and the ONE decision § S4 makes differently from two of the four existing
// harnesses: a missing browser is BLOCKED, never SKIP. A SKIP here would report success without ever
// having seen a browser — the vacuum-green form at the most sensitive spot there is.
const resolvePlaywright = ( { anchors } ) => {
    const struct = { 'status': false, 'anchor': null, 'playwright': null, 'reason': null }

    if( Array.isArray( anchors ) !== true || anchors.length === 0 ) {
        struct[ 'reason' ] = 'no anchor to resolve playwright from'

        return struct
    }

    const found = anchors
        .map( ( anchor ) => {
            try {
                return { anchor, 'playwright': createRequire( anchor )( 'playwright' ) }
            } catch {
                return null
            }
        } )
        .find( ( entry ) => entry !== null )

    if( found === undefined ) {
        struct[ 'reason' ] = `playwright not resolvable from ${ anchors.join( ' | ' ) }`

        return struct
    }

    struct[ 'status' ] = true
    struct[ 'anchor' ] = found[ 'anchor' ]
    struct[ 'playwright' ] = found[ 'playwright' ]

    return struct
}


// ---------------------------------------------------------------------------------------------
// The measuring parts.
// ---------------------------------------------------------------------------------------------


const probePort = ( { port } ) => {
    return new Promise( ( done ) => {
        const socket = createConnection( { 'host': '127.0.0.1', port } )
        const settle = ( inUse ) => { socket.destroy(); done( { port, inUse } ) }
        socket.setTimeout( 400 )
        socket.on( 'connect', () => settle( true ) )
        socket.on( 'timeout', () => settle( false ) )
        socket.on( 'error', () => settle( false ) )
    } )
}


const portInventory = async ( { ports } ) => {
    const seen = await Promise.all( ports.map( ( port ) => probePort( { port } ) ) )

    return { 'inUse': seen.filter( ( entry ) => entry[ 'inUse' ] === true ).map( ( entry ) => entry[ 'port' ] ) }
}


const fetchJson = async ( { url } ) => {
    const struct = { 'status': false, 'code': 0, 'payload': null }

    const response = await fetch( url ).catch( () => null )

    if( response === null ) { return struct }

    struct[ 'code' ] = response.status

    const text = await response.text().catch( () => '' )

    try {
        struct[ 'payload' ] = JSON.parse( text )
        struct[ 'status' ] = true
    } catch {
        struct[ 'payload' ] = null
    }

    return struct
}


// One target, in a FRESH browser context — that is the very thing the finding says was impossible.
// The socket frames are subscribed BEFORE the navigation, because the first `content` frame is the
// answer and it arrives during the load.
const measureOneTarget = async ( { browser, origin, target, expectRender } ) => {
    const { path } = deepLinkPathFor( { 'documentId': target[ 'documentId' ], 'label': target[ 'label' ] } )
    const context = await browser.newContext()
    const page = await context.newPage()

    const frames = []
    const consoleErrors = []
    const failedRequests = []

    page.on( 'websocket', ( socket ) => {
        socket.on( 'framereceived', ( frame ) => {
            try {
                const parsed = JSON.parse( String( frame[ 'payload' ] ) )

                if( parsed[ 'type' ] === 'content' ) { frames.push( parsed ) }
            } catch {
                return
            }
        } )
    } )

    page.on( 'console', ( message ) => {
        if( message.type() === 'error' ) { consoleErrors.push( message.text() ) }
    } )

    page.on( 'requestfailed', ( request ) => { failedRequests.push( request.url() ) } )

    const response = await page.goto( `${ origin }${ path }`, { 'waitUntil': 'domcontentloaded', 'timeout': PAGE_TIMEOUT_MS } )
        .catch( () => null )

    const httpCode = response === null ? 0 : response.status()

    const waited = await page.waitForFunction( () => {
        const el = document.getElementById( 'content' )

        return el !== null && el.textContent.trim().length > 40
    }, { 'timeout': expectRender === true ? PAGE_TIMEOUT_MS : 4000 } ).then( () => true ).catch( () => false )

    const surface = await page.evaluate( () => {
        const title = document.querySelector( '[data-zone1-title]' )
        const content = document.getElementById( 'content' )
        const active = document.querySelector( 'li.rev-mini-active[data-rev]' )

        return {
            'title': title === null ? null : title.textContent.trim(),
            'contentLength': content === null ? 0 : content.textContent.trim().length,
            'activeRev': active === null ? null : active.getAttribute( 'data-rev' ),
            'path': window.location.pathname
        }
    } ).catch( () => { return { 'title': null, 'contentLength': 0, 'activeRev': null, 'path': null } } )

    await context.close()

    const firstContent = frames.length === 0 ? null : frames[ 0 ]
    const frameFileName = firstContent === null ? null : firstContent[ 'fileName' ]
    const frameDocumentId = firstContent === null ? null : firstContent[ 'documentId' ]
    const expectedFileName = `${ target[ 'label' ] }.md`

    // The verdict is a conjunction on purpose: transport AND surface. Either alone can be green while
    // the other is broken, and the question this fixture answers is what the SURFACE shows after the
    // deep link.
    const passed = httpCode === 200
        && frameFileName === expectedFileName
        && waited === true
        && surface[ 'contentLength' ] > 40
        && ( target[ 'memoName' ] === undefined || target[ 'memoName' ] === null || surface[ 'title' ] === target[ 'memoName' ] )

    return {
        'address': path,
        'httpCode': httpCode,
        'frameFileName': frameFileName,
        'frameDocumentId': frameDocumentId,
        'expectedFileName': expectedFileName,
        'rendered': waited,
        'contentLength': surface[ 'contentLength' ] > 40,
        'title': surface[ 'title' ],
        'activeRev': surface[ 'activeRev' ],
        'form': target[ 'form' ],
        'consoleErrors': consoleErrors.length,
        'failedRequests': failedRequests.length,
        'questionSchemaLength': firstContent === null || Array.isArray( firstContent[ 'questionSchema' ] ) !== true ? null : firstContent[ 'questionSchema' ].length,
        'passed': passed
    }
}


// The public entry point successor orders import (§ A5). Object in, object out — never a bare
// boolean, and never a silent default: a missing target list is a NAMED failure, because an empty
// list would otherwise pass every assertion it does not make.
const runDeepLinkAcceptance = async ( { origin, targets, repeats, browser } ) => {
    const struct = {
        'status': false,
        'checked': 0,
        'total': 0,
        'balance': '0 / 0',
        'perTarget': [],
        'negativeControl': null,
        'positiveControl': null,
        'deterministic': false,
        'runs': [],
        'reason': null
    }

    if( typeof origin !== 'string' || origin.length === 0 ) {
        struct[ 'reason' ] = 'origin is missing — a run without a server is not a run'

        return struct
    }

    if( Array.isArray( targets ) !== true ) {
        struct[ 'reason' ] = 'targets is missing — an absent target list is a failure, never an empty run that passes'

        return struct
    }

    if( targets.length === 0 ) {
        struct[ 'reason' ] = '0 targets — an empty target set is RED, never green'
        struct[ 'total' ] = 0
        struct[ 'balance' ] = formatBalance( { 'checked': 0, 'total': 0 } )[ 'line' ]

        return struct
    }

    if( browser === undefined || browser === null ) {
        struct[ 'reason' ] = 'browser is missing — BLOCKED, never a skipped run that reports success'

        return struct
    }

    const repeatCount = Number.isInteger( repeats ) === true && repeats > 0 ? repeats : DEFAULT_REPEATS

    struct[ 'total' ] = targets.length

    // The repeats run against the SAME target list in the SAME server process — § A4 forbids a
    // restart in between, because a restart would make the repetition a different measurement.
    const runs = await Array.from( { 'length': repeatCount } )
        .reduce( async ( previous ) => {
            const collected = await previous

            const oneRun = await targets.reduce( async ( pendingList, target ) => {
                const list = await pendingList
                const measured = await measureOneTarget( { browser, origin, target, 'expectRender': true } )

                return list.concat( [ measured ] )
            }, Promise.resolve( [] ) )

            return collected.concat( [ oneRun ] )
        }, Promise.resolve( [] ) )

    struct[ 'runs' ] = runs
    struct[ 'perTarget' ] = runs[ runs.length - 1 ]
    struct[ 'checked' ] = struct[ 'perTarget' ].filter( ( entry ) => entry[ 'passed' ] === true ).length
    struct[ 'balance' ] = formatBalance( { 'checked': struct[ 'checked' ], 'total': struct[ 'total' ] } )[ 'line' ]

    const determinism = compareRuns( { runs } )

    struct[ 'deterministic' ] = determinism[ 'status' ]
    struct[ 'determinism' ] = determinism

    struct[ 'status' ] = struct[ 'checked' ] === struct[ 'total' ] && determinism[ 'status' ] === true

    return struct
}


// § A2. Two invented addresses, not one: an invented DOCUMENT and a real document with an invented
// LABEL. Before PRD-33 both fell into the collective 404 — the second one is what proves the 404 is
// now the result of a LOOKUP and not of a path nobody routed.
const runNegativeControl = async ( { browser, origin, realDocumentId } ) => {
    const inventedDoc = await measureOneTarget( {
        browser,
        origin,
        'target': { 'documentId': INVENTED_DOCUMENT_ID, 'label': INVENTED_LABEL, 'form': 'negative', 'memoName': null },
        'expectRender': false
    } )

    const inventedLabel = await measureOneTarget( {
        browser,
        origin,
        'target': { 'documentId': realDocumentId, 'label': 'REV-9999-does-not-exist', 'form': 'negative', 'memoName': null },
        'expectRender': false
    } )

    const passed = inventedDoc[ 'httpCode' ] === 404
        && inventedDoc[ 'passed' ] === false
        && inventedLabel[ 'httpCode' ] === 404
        && inventedLabel[ 'passed' ] === false

    return {
        'passed': passed,
        'inventedDocument': { 'address': inventedDoc[ 'address' ], 'httpCode': inventedDoc[ 'httpCode' ], 'verdict': inventedDoc[ 'passed' ] === true ? 'PASS' : 'FAIL' },
        'inventedLabel': { 'address': inventedLabel[ 'address' ], 'httpCode': inventedLabel[ 'httpCode' ], 'verdict': inventedLabel[ 'passed' ] === true ? 'PASS' : 'FAIL' }
    }
}


// § A3. An assertion that runs against a defect that is open TODAY. It MUST report FAIL — an
// assertion that can never fail measures nothing, and this control is how that is detected instead
// of assumed. The fixture does NOT repair the defect (§ N6); it uses it.
//
// WHICH DEFECT, AND WHY THIS ONE. The PRD named the questions-count contradiction of memo 081 ("4
// against 0", BERICHT-browser-abnahme.md:126-166). Re-measured on 2026-09-07 that contradiction is
// GONE: the API answers questions.open = 0 with basis = true, and the revision carries an empty
// questions-json — 0 against 0, so the assertion HOLDS and the control would be blind. § A3 orders
// exactly this case: measure both numbers again, report the change, pick another MEASURED-OPEN
// defect, never drop the control.
// The replacement is measured on the same stock: 7 of 385 registered documents carry ZERO revisions.
// Their SHORT address answers 200 and then shows a DIFFERENT document — measured, /doc/flowmcp--047-
// content-strategie renders "001-agent-directory". The cause is in the connect handler: the deep-link
// branch requires fileName !== null, a zero-revision document resolves to fileName: null, so the
// address falls through to the auto-select fallback and the fallback picks documents[ 0 ].
// So "a deep link shows the document it NAMES" is an assertion this stock refutes today, and it is
// the sharpest possible control for this fixture, because it is a statement about the deep link
// itself rather than about a number standing beside it.
// This is a FINDING AGAINST PRD-33, not a repair order here (§ N1): the fixture uses the defect, it
// does not close it.
const runPositiveControl = async ( { browser, origin, zeroRevisionDocumentId, zeroRevisionMemoName, zeroRevisionCount, totalDocuments, questionsProbe } ) => {
    const struct = {
        'passed': false,
        'address': null,
        'httpCode': 0,
        'expectedTitle': zeroRevisionMemoName,
        'shownTitle': null,
        'assertionVerdict': null,
        'zeroRevisionCount': zeroRevisionCount,
        'totalDocuments': totalDocuments,
        'questionsProbe': questionsProbe
    }

    if( typeof zeroRevisionDocumentId !== 'string' || zeroRevisionDocumentId.length === 0 ) {
        struct[ 'reason' ] = 'no zero-revision document in this stock — the control is UNMEASURED, not passed'

        return struct
    }

    const measured = await measureOneTarget( {
        browser,
        origin,
        'target': { 'documentId': zeroRevisionDocumentId, 'label': null, 'form': 'positive', 'memoName': null },
        'expectRender': false
    } )

    // The asserted claim: the surface behind this address shows the document the address names.
    const assertionHolds = measured[ 'httpCode' ] === 200 && measured[ 'title' ] === zeroRevisionMemoName

    struct[ 'address' ] = measured[ 'address' ]
    struct[ 'httpCode' ] = measured[ 'httpCode' ]
    struct[ 'shownTitle' ] = measured[ 'title' ]
    struct[ 'assertionVerdict' ] = assertionHolds === true ? 'PASS' : 'FAIL'
    // "passed" here means: the control did what a control must do — it FAILED the assertion.
    struct[ 'passed' ] = assertionHolds === false && measured[ 'httpCode' ] === 200

    return struct
}


// The questions-count comparison the PRD originally nominated as the positive control. It is kept and
// REPORTED — not deleted — so the change from "4 against 0" to "0 against 0" is visible instead of
// quietly replaced. Both numbers are measured here, never carried over from the report that found it.
const measureQuestionsProbe = async ( { browser, origin, apiOpenQuestions } ) => {
    const measured = await measureOneTarget( {
        browser,
        origin,
        'target': { 'documentId': POSITIVE_CONTROL[ 'documentId' ], 'label': POSITIVE_CONTROL[ 'label' ], 'form': 'probe', 'memoName': null },
        'expectRender': true
    } )

    return {
        'address': measured[ 'address' ],
        'httpCode': measured[ 'httpCode' ],
        'apiOpenQuestions': apiOpenQuestions,
        'revisionQuestions': measured[ 'questionSchemaLength' ],
        'agrees': apiOpenQuestions !== null && measured[ 'questionSchemaLength' ] !== null && apiOpenQuestions === measured[ 'questionSchemaLength' ]
    }
}


// § A6 part 2. The memo says "WebSocket push destroys evaluation contexts". § I6 measured that the
// mechanism today is a documentList broadcast that re-renders the SIDEBAR. This measures it instead
// of grading it by label: open a deep link, fire a real broadcast, look at the open document again.
// The POST re-registers a document that is ALREADY registered — idempotent by documentId, so the
// stock is unchanged and only the broadcast fires.
// Pick a document whose re-registration actually succeeds. Measured: a POST answers 422 when the
// document's latest revision fails the memo schema — that is a property of THAT document, not of the
// broadcast, and picking a candidate blindly would turn a foreign validation error into an unmeasured
// probe. The candidates are tried in the stock's own order and the run reports how many it needed.
// The POST fires while NO page is open, so this selection can not disturb any measurement.
const pickBroadcastCandidate = async ( { origin, documents } ) => {
    const candidates = documents
        .filter( ( doc ) => typeof doc[ 'memoPath' ] === 'string' && typeof doc[ 'projectId' ] === 'string' )
        .slice( 0, 20 )

    const found = await candidates.reduce( async ( previous, doc ) => {
        const settled = await previous

        if( settled[ 'doc' ] !== null ) { return settled }

        const code = await fetch( `${ origin }/api/documents`, {
            'method': 'POST',
            'headers': { 'Content-Type': 'application/json' },
            'body': JSON.stringify( { 'projectId': doc[ 'projectId' ], 'memoPath': doc[ 'memoPath' ] } )
        } ).then( ( response ) => response.status ).catch( () => 0 )

        return code === 200
            ? { 'doc': doc, 'tried': settled[ 'tried' ] + 1 }
            : { 'doc': null, 'tried': settled[ 'tried' ] + 1 }
    }, Promise.resolve( { 'doc': null, 'tried': 0 } ) )

    return { 'doc': found[ 'doc' ], 'tried': found[ 'tried' ], 'available': candidates.length }
}


const runBroadcastProbe = async ( { browser, origin, target, memoPath, projectId } ) => {
    const { path } = deepLinkPathFor( { 'documentId': target[ 'documentId' ], 'label': target[ 'label' ] } )
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto( `${ origin }${ path }`, { 'waitUntil': 'domcontentloaded', 'timeout': PAGE_TIMEOUT_MS } ).catch( () => null )

    const readSurface = () => {
        return page.evaluate( () => {
            const doc = document.querySelector( '[data-zone1-doc]' )
            const content = document.getElementById( 'content' )

            return {
                'doc': doc === null ? null : doc.textContent.trim(),
                'contentLength': content === null ? 0 : content.textContent.trim().length,
                'path': window.location.pathname
            }
        } ).catch( () => { return { 'doc': null, 'contentLength': 0, 'path': null } } )
    }

    await page.waitForFunction( () => {
        const el = document.getElementById( 'content' )

        return el !== null && el.textContent.trim().length > 40
    }, { 'timeout': PAGE_TIMEOUT_MS } ).catch( () => false )

    const before = await readSurface()

    const posted = await fetch( `${ origin }/api/documents`, {
        'method': 'POST',
        'headers': { 'Content-Type': 'application/json' },
        'body': JSON.stringify( { projectId, memoPath } )
    } ).then( ( response ) => response.status ).catch( () => 0 )

    await page.waitForTimeout( 1200 )

    const after = await readSurface()

    await context.close()

    // A POST that was refused fired NO broadcast, so there is nothing to judge. That case is
    // UNMEASURED (`passed: null`), never a confirmed finding — reading a failed trigger as "the
    // document survived" or as "the document was destroyed" would both be inventions.
    const survived = before[ 'doc' ] === after[ 'doc' ] && before[ 'contentLength' ] === after[ 'contentLength' ] && before[ 'path' ] === after[ 'path' ]

    return {
        'passed': posted === 200 ? survived : null,
        'reason': posted === 200 ? undefined : `the re-registration POST answered ${ posted }, so no broadcast fired — nothing was measured`,
        'postCode': posted,
        'before': before,
        'after': after
    }
}


// ---------------------------------------------------------------------------------------------
// The command-line shell.
// ---------------------------------------------------------------------------------------------


// Boot a server against a SEEDED temp tree so the fixture is self-sufficient and stays inside the
// repo boundary (§ S4). Four label forms are seeded on purpose — the real stock carries four, and a
// fixture that can only exercise one shape would prove one shape.
const seedOwnStock = async ( { memoCount } ) => {
    const tempDir = await mkdtemp( join( tmpdir(), 'deep-link-acceptance-' ) )

    const seeded = await Array.from( { 'length': memoCount } )
        .reduce( async ( previous, _unused, index ) => {
            const collected = await previous
            const memoName = `${ String( 900 + index ).padStart( 3, '0' ) }-deep-link-fixture-${ index }`
            const revisionsDir = join( tempDir, '.memo', 'memos', memoName, 'revisions' )

            await mkdir( revisionsDir, { recursive: true } )

            const files = [ 'REV-01.md', 'REV-01-prepare.md', 'REV-02-update.md', 'v0.4.md' ]

            await Promise.all( files.map( ( fileName ) => {
                const body = `# ${ memoName } · ${ fileName }\n\nSeeded revision body for the PRD-34 acceptance fixture. It has to be long enough that the rendered content is unmistakably a document and not a placeholder, so this sentence exists purely to carry weight.\n`

                return writeFile( join( revisionsDir, fileName ), body, 'utf8' )
            } ) )

            return collected.concat( [ memoName ] )
        }, Promise.resolve( [] ) )

    // One memo WITHOUT any revision. The real stock carries 7 of those in 385, and their short address
    // is what the positive control measures — a seeded stock that has none could not exercise its own
    // control and would report it UNMEASURED forever.
    await mkdir( join( tempDir, '.memo', 'memos', '999-deep-link-fixture-empty', 'revisions' ), { recursive: true } )

    return { tempDir, 'memoNames': seeded }
}


const printLine = ( { text } ) => { process.stdout.write( `${ text }\n` ) }


const main = async () => {
    const { values } = parseArgs( {
        'args': process.argv.slice( 2 ),
        'options': {
            'repeat': { 'type': 'string' },
            'origin': { 'type': 'string' },
            'per-form': { 'type': 'string' },
            'force-blocked': { 'type': 'boolean', 'default': false }
        },
        'allowPositionals': false
    } )

    const anchors = values[ 'force-blocked' ] === true ? [] : PLAYWRIGHT_ANCHORS
    const resolved = resolvePlaywright( { anchors } )

    printLine( { 'text': '' } )
    printLine( { 'text': '  deep-link-acceptance — PRD-34 (Memo 081, WI-067)' } )
    printLine( { 'text': '' } )

    if( resolved[ 'status' ] !== true ) {
        process.stderr.write( `  BLOCKED: ${ resolved[ 'reason' ] }\n\n` )
        process.exit( 1 )
    }

    printLine( { 'text': `  playwright resolved from : ${ resolved[ 'anchor' ] }` } )

    const inventory = await portInventory( { 'ports': PORT_INVENTORY } )

    printLine( { 'text': `  ports in use before      : ${ inventory[ 'inUse' ].length === 0 ? '(none)' : inventory[ 'inUse' ].join( ', ' ) }` } )

    const repeats = Number.parseInt( values[ 'repeat' ] === undefined ? String( DEFAULT_REPEATS ) : values[ 'repeat' ], 10 )
    const perForm = Number.parseInt( values[ 'per-form' ] === undefined ? String( DEFAULT_PER_FORM ) : values[ 'per-form' ], 10 )

    const foreignOrigin = values[ 'origin' ]
    const ownServer = foreignOrigin === undefined

    const seeded = ownServer === true ? await seedOwnStock( { 'memoCount': 8 } ) : null

    if( ownServer === true ) {
        if( inventory[ 'inUse' ].includes( OWN_PORT ) === true ) {
            process.stderr.write( `  BLOCKED: port ${ OWN_PORT } is in use — this harness never seizes a port it does not own\n\n` )
            process.exit( 1 )
        }

        process.chdir( seeded[ 'tempDir' ] )
        await MemoView.startServer( { 'port': OWN_PORT } )
    }

    const origin = ownServer === true ? `http://localhost:${ OWN_PORT }` : foreignOrigin

    printLine( { 'text': `  origin                   : ${ origin }${ ownServer === true ? ' (own seeded stock)' : ' (foreign server)' }` } )

    const documentsAnswer = await fetchJson( { 'url': `${ origin }/api/documents` } )
    const documents = documentsAnswer[ 'payload' ] === null ? null : documentsAnswer[ 'payload' ][ 'documents' ]
    const derived = deriveTargets( { documents, perForm } )

    printLine( { 'text': `  documents read           : ${ derived[ 'documentsRead' ] }` } )
    printLine( { 'text': `  revisions read           : ${ derived[ 'revisionsRead' ] }` } )
    printLine( { 'text': `  label forms in stock     : ${ JSON.stringify( derived[ 'formCounts' ] ) }` } )
    printLine( { 'text': `  label forms MISSING      : ${ derived[ 'missingForms' ].length === 0 ? '(none)' : derived[ 'missingForms' ].join( ', ' ) }` } )
    printLine( { 'text': `  targets derived          : ${ derived[ 'targets' ].length }` } )

    if( derived[ 'status' ] !== true ) {
        process.stderr.write( `  RED: ${ derived[ 'reason' ] }\n\n` )
        process.exit( 1 )
    }

    const browser = await resolved[ 'playwright' ].chromium.launch( { 'headless': true } )

    const result = await runDeepLinkAcceptance( { origin, 'targets': derived[ 'targets' ], repeats, browser } )

    printLine( { 'text': '' } )

    result[ 'runs' ]
        .forEach( ( run, index ) => {
            const passedCount = run.filter( ( entry ) => entry[ 'passed' ] === true ).length
            const consoleErrors = run.reduce( ( sum, entry ) => sum + entry[ 'consoleErrors' ], 0 )
            const failedRequests = run.reduce( ( sum, entry ) => sum + entry[ 'failedRequests' ], 0 )
            const sidebarActive = run.filter( ( entry ) => entry[ 'activeRev' ] !== null ).length

            printLine( { 'text': `  run ${ index + 1 } checked          : ${ formatBalance( { 'checked': passedCount, 'total': run.length } )[ 'line' ] }  ·  console errors ${ consoleErrors }  ·  failed requests ${ failedRequests }  ·  sidebar row visible ${ sidebarActive } / ${ run.length }` } )
        } )

    result[ 'perTarget' ]
        .filter( ( entry ) => entry[ 'passed' ] !== true )
        .forEach( ( entry ) => printLine( { 'text': `  FAIL target              : ${ entry[ 'address' ] } — http ${ entry[ 'httpCode' ] }, frame ${ entry[ 'frameFileName' ] }, expected ${ entry[ 'expectedFileName' ] }, rendered ${ entry[ 'rendered' ] }` } ) )

    const negative = await runNegativeControl( { browser, origin, 'realDocumentId': derived[ 'targets' ][ 0 ][ 'documentId' ] } )

    printLine( { 'text': '' } )
    printLine( { 'text': `  negative (invented doc)  : ${ negative[ 'inventedDocument' ][ 'address' ] } → http ${ negative[ 'inventedDocument' ][ 'httpCode' ] }, verdict ${ negative[ 'inventedDocument' ][ 'verdict' ] }` } )
    printLine( { 'text': `  negative (invented label): ${ negative[ 'inventedLabel' ][ 'address' ] } → http ${ negative[ 'inventedLabel' ][ 'httpCode' ] }, verdict ${ negative[ 'inventedLabel' ][ 'verdict' ] }` } )
    printLine( { 'text': `  negative control         : ${ negative[ 'passed' ] === true ? 'OK   (both fell through, as they must)' : 'FAIL (an invented address passed — this fixture reads nothing)' }` } )

    const allDocuments = Array.isArray( documents ) === true ? documents : []
    const controlDoc = allDocuments.find( ( doc ) => doc[ 'documentId' ] === POSITIVE_CONTROL[ 'documentId' ] )

    const questionsProbe = controlDoc === undefined
        ? { 'reason': `${ POSITIVE_CONTROL[ 'documentId' ] } is not in this stock` }
        : await measureQuestionsProbe( { browser, origin, 'apiOpenQuestions': controlDoc[ 'questions' ] === undefined ? null : controlDoc[ 'questions' ][ 'open' ] } )

    const zeroRevisionDocs = allDocuments
        .filter( ( doc ) => Array.isArray( doc[ 'revisions' ] ) !== true || doc[ 'revisions' ].length === 0 )
        .sort( ( a, b ) => String( a[ 'documentId' ] ).localeCompare( String( b[ 'documentId' ] ) ) )

    const positive = await runPositiveControl( {
        browser,
        origin,
        'zeroRevisionDocumentId': zeroRevisionDocs.length === 0 ? null : zeroRevisionDocs[ 0 ][ 'documentId' ],
        'zeroRevisionMemoName': zeroRevisionDocs.length === 0 ? null : zeroRevisionDocs[ 0 ][ 'memoName' ],
        'zeroRevisionCount': zeroRevisionDocs.length,
        'totalDocuments': allDocuments.length,
        questionsProbe
    } )

    printLine( { 'text': '' } )

    if( questionsProbe[ 'reason' ] === undefined ) {
        printLine( { 'text': `  questions probe target   : ${ questionsProbe[ 'address' ] } → http ${ questionsProbe[ 'httpCode' ] }` } )
        printLine( { 'text': `  api questions.open       : ${ questionsProbe[ 'apiOpenQuestions' ] }` } )
        printLine( { 'text': `  revision questions-json  : ${ questionsProbe[ 'revisionQuestions' ] }` } )
        printLine( { 'text': `  questions probe          : the two numbers ${ questionsProbe[ 'agrees' ] === true ? 'AGREE — the contradiction this PRD nominated as control is CLOSED, so it can not serve as one' : 'DISAGREE — the contradiction is open' }` } )
    } else {
        printLine( { 'text': `  questions probe          : UNMEASURED — ${ questionsProbe[ 'reason' ] }` } )
    }

    printLine( { 'text': '' } )

    if( positive[ 'reason' ] === undefined ) {
        printLine( { 'text': `  positive control target  : ${ positive[ 'address' ] } → http ${ positive[ 'httpCode' ] }` } )
        printLine( { 'text': `  address names            : ${ positive[ 'expectedTitle' ] }` } )
        printLine( { 'text': `  surface shows            : ${ positive[ 'shownTitle' ] }` } )
        printLine( { 'text': `  its comparison set       : ${ positive[ 'zeroRevisionCount' ] } of ${ positive[ 'totalDocuments' ] } documents carry zero revisions` } )
        printLine( { 'text': `  asserted                 : "a deep link shows the document it names"` } )
        printLine( { 'text': `  assertion verdict        : ${ positive[ 'assertionVerdict' ] }  (FAIL is required — a control that can not fail measures nothing)` } )
        printLine( { 'text': `  positive control         : ${ positive[ 'passed' ] === true ? 'OK   (the assertion failed, as it must)' : 'FAIL (the assertion held — the fixture is blind)' }` } )
    } else {
        printLine( { 'text': `  positive control         : UNMEASURED — ${ positive[ 'reason' ] }` } )
    }

    // The broadcast is triggered by RE-registering a document that is already registered — idempotent
    // by documentId, so the stock does not change and only the documentList message fires.
    const candidate = await pickBroadcastCandidate( { origin, 'documents': allDocuments } )

    const broadcast = candidate[ 'doc' ] === null
        ? { 'passed': null, 'reason': `none of ${ candidate[ 'tried' ] } candidate documents could be re-registered — the broadcast probe is UNMEASURED, not passed` }
        : await runBroadcastProbe( { browser, origin, 'target': derived[ 'targets' ][ 0 ], 'memoPath': candidate[ 'doc' ][ 'memoPath' ], 'projectId': candidate[ 'doc' ][ 'projectId' ] } )

    printLine( { 'text': '' } )

    if( broadcast[ 'passed' ] === null ) {
        printLine( { 'text': `  broadcast probe          : UNMEASURED — ${ broadcast[ 'reason' ] }` } )
    } else {
        printLine( { 'text': `  broadcast POST code      : ${ broadcast[ 'postCode' ] } (re-registering ${ candidate[ 'doc' ][ 'documentId' ] }, chosen after ${ candidate[ 'tried' ] } of ${ candidate[ 'available' ] } candidates)` } )
        printLine( { 'text': `  broadcast comparison set : 1 documentList broadcast against 1 open deep link` } )
        printLine( { 'text': `  document before / after  : "${ broadcast[ 'before' ][ 'doc' ] }" / "${ broadcast[ 'after' ][ 'doc' ] }"  ·  content ${ broadcast[ 'before' ][ 'contentLength' ] } / ${ broadcast[ 'after' ][ 'contentLength' ] }  ·  path ${ broadcast[ 'before' ][ 'path' ] } / ${ broadcast[ 'after' ][ 'path' ] }` } )
        printLine( { 'text': `  broadcast probe          : ${ broadcast[ 'passed' ] === true ? 'OK   (the open document survived a documentList broadcast)' : 'FAIL (the open document changed — the memo finding is confirmed, addressee PRD-38)' }` } )
    }

    await browser.close()

    printLine( { 'text': '' } )
    printLine( { 'text': `  determinism              : ${ result[ 'determinism' ][ 'identical' ] } / ${ result[ 'determinism' ][ 'total' ] } identical runs` } )

    if( result[ 'determinism' ][ 'firstDifference' ] !== null ) {
        printLine( { 'text': `  first difference         : ${ result[ 'determinism' ][ 'firstDifference' ] }` } )
    }

    printLine( { 'text': `  balance                  : ${ result[ 'balance' ] }` } )
    printLine( { 'text': '' } )

    const inventoryAfter = await portInventory( { 'ports': PORT_INVENTORY } )

    printLine( { 'text': `  ports in use after       : ${ inventoryAfter[ 'inUse' ].length === 0 ? '(none)' : inventoryAfter[ 'inUse' ].join( ', ' ) }` } )

    // MemoView.startServer keeps its listening socket with no public close, so THIS reading still shows
    // the harness's own port. It is released by the process exit below — which is a claim the caller can
    // check from the outside, and the honest way to say it is to name it instead of printing a number
    // that looks like a leak.
    if( ownServer === true ) {
        printLine( { 'text': `  own port ${ OWN_PORT }             : still bound in this reading; released by the process exit — verify from outside with lsof after the run` } )
    }

    // The three MANDATORY guards decide the verdict: the target balance, the negative control and the
    // positive control. The broadcast probe (§ A6 part 2) is a separate measurement with its own
    // verdict — it does not gate this one, and when it could not fire the verdict line SAYS so instead
    // of quietly counting an unmeasured probe as a pass.
    const positiveOk = positive[ 'reason' ] === undefined ? positive[ 'passed' ] === true : false
    const broadcastOk = broadcast[ 'passed' ] === null ? true : broadcast[ 'passed' ] === true
    const overall = result[ 'status' ] === true && negative[ 'passed' ] === true && positiveOk === true && broadcastOk === true
    const caveat = broadcast[ 'passed' ] === null ? '  (broadcast probe UNMEASURED — it does not gate this verdict)' : ''

    printLine( { 'text': `  VERDICT                  : ${ overall === true ? 'PASS' : 'FAIL' }${ caveat }` } )
    printLine( { 'text': '' } )

    process.exit( overall === true ? 0 : 1 )
}


// The module stays importable (§ A5): a successor order imports runDeepLinkAcceptance and never the
// command-line shell. The guard is the same is-main test the rest of the repo uses.
if( process.argv[ 1 ] !== undefined && import.meta.url === new URL( `file://${ process.argv[ 1 ] }` ).href ) {
    await main()
}


export { runDeepLinkAcceptance, deriveTargets, labelFormOf, formatBalance, compareRuns, deepLinkPathFor, resolvePlaywright, measureOneTarget, PLAYWRIGHT_ANCHORS }
