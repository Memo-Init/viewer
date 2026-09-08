// question-chain-acceptance.mjs — PRD-44 (Memo 081, Kap 19 / WI-065 + WI-063) against a REAL browser.
//
// WHY THIS EXISTS. REV-16.md:1761 asks for the question chain to be accepted END TO END against a real
// revision — display, counter, confirmation, submit, restart — and explicitly NOT in pieces. Every one
// of the five links is built and pinned on its own; as a CHAIN none of them has ever been measured.
// REV-14 records the user asking "why did you ask me those questions again?" and the honest answer was
// that it could not be determined WHICH of two paths had dropped the answers. That undeterminability is
// itself the defect this fixture closes — not with a sixth repair, but with one pass that measures the
// whole chain in one go and prints its numbers.
//
// WHAT IS MEASURED, in the order a human walks it:
//   K1 display      — the recommendation is visible AND distinguishable from a selection
//   K2 counter      — one set, four displays, and the difference is named rather than smoothed over
//   K3 confirmation — an unconfirmed selection is not harvested, and the edge says so out loud
//   K4 submit       — what is stored, and what is expressly not
//   K5 restart      — the state survives the process
//
// WHAT MAKES IT NOT VACUUM-GREEN. Four rules, all mandatory, all printed:
//   (a) every link names its COMPARISON SET and prints <checked> / <total>; zero targets is RED.
//   (b) every zero carries a POSITIVE CONTROL from THIS SAME fixture — a dead page also shows 0.
//   (c) the verdict is TERNARY: PASS | FAIL | INCONCLUSIVE. There is no fourth value and no silent
//       skip. A link that cannot be measured is INCONCLUSIVE with a named reason, never a pass.
//   (d) no expected value is frozen. The open-question count, the registry counter and the bundle
//       hash are read immediately before the run, and both numbers are reported.
//
// THE ORACLE IS THE REPOSITORY'S OWN PARSER. How many questions a revision has open is computed with
// DocumentRegistry.parseQuestionJsonBlock plus the status filter the client itself applies
// (openQuestionsOf) — never with an expression typed into this file. A second spelling of one rule
// drifts, and the number would then be this fixture's opinion instead of the repository's answer.
//
// THE ADDRESS FORM IS IMPORTED, NOT REBUILT. deepLinkPathFor, resolvePlaywright, formatBalance and
// compareRuns come from deep-link-acceptance.mjs, which says in its own header that it is a FIXTURE
// and that successor orders import it instead of copying a click path. Six automation attempts are on
// record as having failed (REV-16.md:2709); every one of them invented its own way in.
//
// ONE-WAY CLONE. K3 to K5 WRITE: the question state lands in <memoDir>/_question-state/<REV>.json,
// derived from the REGISTERED memo path. So this fixture is pointed at a COPY of a memo folder that
// lies outside the project, and it declares that copy consumed once it has written. A second run
// against the same copy is RED, not convenient.
//
// Run: MEMOVIEW_NO_BROWSER=1 node tests/manual/question-chain-acceptance.mjs \
//          --origin http://127.0.0.1:3333 --document <id> --revision REV-04 \
//          --revision-file <abs path to REV-04.md> --clone-dir <abs path to the cloned memo folder>
//      MEMOVIEW_NO_BROWSER=1 node tests/manual/question-chain-acceptance.mjs \
//          --origin http://127.0.0.1:3333 --document <id> --revision REV-04 --repeat 3
//      --restart-command "<cmd>" makes K5 measurable; without it K5 is INCONCLUSIVE, never green.
// Exits 0 when every link is PASS, 1 otherwise. A missing browser is BLOCKED, never SKIP.
//
// REPO BOUNDARY. Nothing outside this repository is read without an explicit argument and an
// existsSync latch. A missing path yields INCONCLUSIVE with a named reason — never a crash, never a
// green. CI checks this repository out ALONE, and tests/manual/** does not run under `npm test`; the
// pure parts are pinned by tests/unit/QuestionChainAcceptancePRD44.test.mjs.
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'

import {
    deepLinkPathFor,
    resolvePlaywright,
    formatBalance,
    compareRuns,
    PLAYWRIGHT_ANCHORS
} from './deep-link-acceptance.mjs'


// The three verdict values. INCONCLUSIVE is the machine value; UNBEWERTBAR is the German display over
// it (§ A10) and appears only in printed output, never as a field value.
const VERDICT = { 'pass': 'PASS', 'fail': 'FAIL', 'inconclusive': 'INCONCLUSIVE' }

// The five links. `consumesClone` is a PROPERTY of the link, not of a run: K1 and K2 only read, K3 to
// K5 write into the registered memo folder. Stating it per link is what lets the one-way rule be
// checked from the outside instead of trusted.
const CHAIN_LINKS = [
    { 'id': 'K1', 'title': 'Anzeige', 'consumesClone': false },
    { 'id': 'K2', 'title': 'Zaehler', 'consumesClone': false },
    { 'id': 'K3', 'title': 'Bestaetigung', 'consumesClone': true },
    { 'id': 'K4', 'title': 'Submit', 'consumesClone': true },
    { 'id': 'K5', 'title': 'Neustart', 'consumesClone': true }
]

const PAGE_TIMEOUT_MS = 25000
const WIDGET_TIMEOUT_MS = 20000
const RELOAD_WINDOW_MS = 30000


// ---------------------------------------------------------------------------------------------
// Pure parts. Everything down to the measuring section is free of browser, server and port, which is
// what tests/unit/QuestionChainAcceptancePRD44.test.mjs pins — tests/manual/** does not run under
// `npm test`, so without those unit cases NOTHING would protect this fixture from decay.
// ---------------------------------------------------------------------------------------------


// Is this link one that consumes the clone? NO SILENT DEFAULT: an unknown id is a named failure, not
// a `false` that would quietly declare a writing link harmless.
const consumesCloneOf = ( { id } ) => {
    const found = CHAIN_LINKS.find( ( link ) => link[ 'id' ] === id )

    if( found === undefined ) { return { 'status': false, 'consumesClone': null, 'reason': `unknown chain link ${ id }` } }

    return { 'status': true, 'consumesClone': found[ 'consumesClone' ], 'reason': null }
}


// THE ORACLE. How many questions does this revision have open? Answered with the repository's own
// parser and the repository's own filter — DocumentRegistry.parseQuestionJsonBlock, then
// `status === 'open'`, which is verbatim what openQuestionsOf does in app.client.mjs. The status is
// derived, not declared: a question carrying no known status is normalised to 'open' by
// #normalizeJsonQuestion, so counting it here needs no special case and gets none.
//
// `found: true` with `open: 0` is a legitimate answer (an empty revision), and it is what makes the
// empty-state latch of K2 possible. `found: false` is NOT that — it means no block was parsed at all,
// and the two must never collapse into one number.
const openQuestionsFromContent = ( { content } ) => {
    const struct = { 'status': false, 'found': false, 'total': 0, 'open': 0, 'withRecommendation': 0, 'withPreselection': 0, 'questions': [], 'reason': null }

    if( typeof content !== 'string' || content.length === 0 ) {
        struct[ 'reason' ] = 'no revision text handed in — an oracle without a text has no comparison set'

        return struct
    }

    const parsed = DocumentRegistry.parseQuestionJsonBlock( { content } )

    struct[ 'found' ] = parsed[ 'found' ]
    struct[ 'total' ] = parsed[ 'questions' ].length

    if( parsed[ 'found' ] !== true ) {
        struct[ 'reason' ] = parsed[ 'error' ] === null ? 'no questions-json block in this revision' : String( parsed[ 'error' ] )

        return struct
    }

    const open = parsed[ 'questions' ]
        .filter( ( question ) => question[ 'status' ] === 'open' )

    struct[ 'questions' ] = open
    struct[ 'open' ] = open.length
    struct[ 'withRecommendation' ] = open
        .filter( ( question ) => typeof question[ 'aiRecommendation' ] === 'string' && question[ 'aiRecommendation' ].trim().length > 0 )
        .length
    struct[ 'withPreselection' ] = open
        .filter( ( question ) => Array.isArray( question[ 'preselected' ] ) === true && question[ 'preselected' ].length > 0 )
        .length
    struct[ 'status' ] = true

    return struct
}


// Which cascade stage marked a question's recommendation? Printed per link, NEVER graded (§ N3): the
// weakness of the regex fallback is its own subject and no regression of this phase. A number that is
// reported is honest; a number that is silently folded into a verdict is not.
const cascadeStageOf = ( { question } ) => {
    if( question === null || typeof question !== 'object' ) { return { 'stage': 'none' } }

    if( Array.isArray( question[ 'aiRecommended' ] ) === true && question[ 'aiRecommended' ].length > 0 ) { return { 'stage': 'server-field' } }

    if( Array.isArray( question[ 'preselected' ] ) === true && question[ 'preselected' ].length > 0 ) { return { 'stage': 'preselected-fallback' } }

    const reasoning = typeof question[ 'aiRecommendation' ] === 'string' ? question[ 'aiRecommendation' ].trim() : ''

    if( reasoning.length > 0 && /^([A-H])\b/.test( reasoning ) === true ) { return { 'stage': 'regex-fallback' } }

    return { 'stage': 'none' }
}


// The balance line of one link. It exists so a verdict can NOT be reported without reporting how much
// it compared, and it carries the red flag for the zero case in the same object — a caller that prints
// the line therefore cannot print it without the flag being available.
const chainBalance = ( { checked, total } ) => {
    const { line } = formatBalance( { checked, total } )
    const safeTotal = Number.isInteger( total ) === true ? total : 0

    return { line, 'red': safeTotal === 0 }
}


// THE TERNARY JUDGEMENT, in one place. Three rules, in this order, and the order is the point:
//   1. no comparison set  -> INCONCLUSIVE. Never PASS. A check that compared nothing has not run.
//   2. no condition       -> INCONCLUSIVE. A link that asserted nothing has not been measured either.
//   3. otherwise          -> PASS when every condition holds, else FAIL.
// The FULL error text of every failed condition is carried in the result object AND kept in `reason`,
// because four orders of this rollout lost a red run to a loop that printed only the balance.
const judgeLink = ( { id, compared, total, conditions, expected, measured, evidence, errorText } ) => {
    const clone = consumesCloneOf( { id } )
    const safeConditions = Array.isArray( conditions ) === true ? conditions : []
    const safeCompared = Number.isInteger( compared ) === true ? compared : 0
    const safeTotal = Number.isInteger( total ) === true ? total : safeCompared

    const struct = {
        id,
        'verdict': VERDICT[ 'inconclusive' ],
        'compared': safeCompared,
        'total': safeTotal,
        'balance': chainBalance( { 'checked': safeCompared, 'total': safeTotal } )[ 'line' ],
        'expected': expected === undefined ? null : expected,
        'measured': measured === undefined ? null : measured,
        'evidence': Array.isArray( evidence ) === true ? evidence : [],
        'consumesClone': clone[ 'consumesClone' ],
        'conditions': safeConditions,
        'reason': null,
        'errorText': typeof errorText === 'string' && errorText.length > 0 ? errorText : null
    }

    if( safeCompared === 0 ) {
        struct[ 'reason' ] = struct[ 'errorText' ] !== null
            ? struct[ 'errorText' ]
            : 'empty comparison set — a check without a basis is INCONCLUSIVE, never green'

        return struct
    }

    if( safeConditions.length === 0 ) {
        struct[ 'reason' ] = 'no condition was asserted — a link that asserts nothing has not been measured'

        return struct
    }

    const failed = safeConditions
        .filter( ( condition ) => condition[ 'passed' ] !== true )

    if( failed.length === 0 ) {
        struct[ 'verdict' ] = VERDICT[ 'pass' ]

        return struct
    }

    struct[ 'verdict' ] = VERDICT[ 'fail' ]

    const detail = failed
        .map( ( condition ) => `${ condition[ 'name' ] }: ${ condition[ 'detail' ] }` )
        .join( ' | ' )

    struct[ 'errorText' ] = struct[ 'errorText' ] === null ? detail : `${ struct[ 'errorText' ] } | ${ detail }`
    struct[ 'reason' ] = struct[ 'errorText' ]

    return struct
}


// One condition row. Its `detail` is written even when it passes, so a green run still says what it
// held against — the same reason the balance line exists.
const condition = ( { name, passed, detail } ) => {
    return { name, 'passed': passed === true, 'detail': String( detail ) }
}


// The one-way statement. It is printed by every run that reached a writing link, so the fact that a
// clone is spent is in the RECORD and not only in the head of whoever ran it.
const cloneConsumedNotice = ( { reached } ) => {
    if( reached !== true ) { return { 'consumed': false, 'text': 'no writing link was reached; the clone is untouched and still usable' } }

    return { 'consumed': true, 'text': 'this run consumed its clone; a second run needs a fresh one' }
}


// Collapse runs of whitespace so a DOM textContent (which folds markup boundaries into single spaces)
// can be compared against a source string that carries its own line breaks. Comparing the raw forms
// would produce a FAIL that is about whitespace and not about the recommendation.
const normalizeSpace = ( { text } ) => {
    return { 'text': String( text === null || text === undefined ? '' : text ).replace( /\s+/g, ' ' ).trim() }
}


// ---------------------------------------------------------------------------------------------
// The measuring parts.
// ---------------------------------------------------------------------------------------------


// The proof that four links ran in ONE browser context (§ A6). The stamp is registered on the
// CONTEXT, so every page it opens carries the same value and a page from a different context carries
// a different one — the identity is established by construction rather than asserted in prose.
const stampContext = async ( { context } ) => {
    const stamp = randomUUID()

    await context.addInitScript( `window.__CHAIN_CONTEXT__ = ${ JSON.stringify( stamp ) }` )

    return { stamp }
}


const readContextStamp = async ( { page } ) => {
    const stamp = await page.evaluate( () => {
        return typeof window.__CHAIN_CONTEXT__ === 'string' ? window.__CHAIN_CONTEXT__ : null
    } ).catch( () => null )

    return { stamp }
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


// Open one target and wait until the question widgets are rendered. The console and request listeners
// are attached BEFORE the navigation, because the errors this asks about happen during the load.
const openTarget = async ( { context, origin, documentId, label, requireWidgets } ) => {
    const { path } = deepLinkPathFor( { documentId, label } )
    const page = await context.newPage()
    const consoleErrors = []
    const failedRequests = []
    const navigations = []

    page.on( 'console', ( message ) => {
        if( message.type() === 'error' ) { consoleErrors.push( message.text() ) }
    } )

    page.on( 'requestfailed', ( request ) => { failedRequests.push( request.url() ) } )

    page.on( 'framenavigated', ( frame ) => {
        if( frame === page.mainFrame() ) { navigations.push( Date.now() ) }
    } )

    const response = await page.goto( `${ origin }${ path }`, { 'waitUntil': 'domcontentloaded', 'timeout': PAGE_TIMEOUT_MS } )
        .catch( () => null )

    const httpCode = response === null ? 0 : response.status()

    const rendered = await page.waitForFunction( () => {
        const container = document.getElementById( 'question-widgets' )
        const content = document.getElementById( 'content' )

        if( content === null || content.textContent.trim().length <= 40 ) { return false }

        return container !== null
    }, { 'timeout': requireWidgets === true ? WIDGET_TIMEOUT_MS : 6000 } ).then( () => true ).catch( () => false )

    return { page, path, httpCode, rendered, consoleErrors, failedRequests, navigations }
}


// Read the whole question surface of the open page in ONE evaluation. One read keeps the numbers
// mutually consistent: counting cards in one call and the header in another can straddle a re-render
// and produce a difference that exists only in the measurement.
const readQuestionSurface = async ( { page, documentId } ) => {
    return await page.evaluate( ( docId ) => {
        const container = document.getElementById( 'question-widgets' )
        const cards = Array.from( document.querySelectorAll( '#question-widgets .qw-card' ) )
        const zone2 = document.querySelector( '[data-zone2-counted]' )
        const qmark = document.querySelector( '[data-zone2-qmark]' )
        const warn = document.getElementById( 'qw-source-warn' )
        const sidebar = document.querySelector( `.questions-link[data-document-id="${ docId }"]` )
        const empty = document.querySelector( '.qw-empty, .pp-questions-empty' )

        const textOf = ( node ) => { return node === null ? null : node.textContent.trim() }

        return {
            'containerPresent': container !== null,
            'qwRendered': container === null ? null : container.getAttribute( 'data-qw-rendered' ),
            'qwSource': container === null ? null : container.getAttribute( 'data-qw-source' ),
            'qwRegistryOpen': container === null ? null : container.getAttribute( 'data-qw-registry-open' ),
            'cardCount': cards.length,
            'zone2Counted': zone2 === null ? null : zone2.getAttribute( 'data-zone2-counted' ),
            'zone2Basis': zone2 === null ? null : zone2.getAttribute( 'data-zone2-basis' ),
            'zone2Text': textOf( zone2 ),
            'qmarkText': textOf( qmark ),
            'divergencePresent': warn !== null,
            'divergenceText': textOf( warn ),
            'sidebarPresent': sidebar !== null,
            'sidebarText': textOf( sidebar ),
            'sidebarOpen': sidebar === null ? null : sidebar.getAttribute( 'data-open' ),
            'sidebarBasis': sidebar === null ? null : sidebar.getAttribute( 'data-basis' ),
            'sidebarTitle': sidebar === null ? null : sidebar.getAttribute( 'title' ),
            'emptyText': textOf( empty ),
            'buildStamp': typeof window.__MEMO_VIEW_BUILD__ === 'string' ? window.__MEMO_VIEW_BUILD__ : null,
            'cards': cards.map( ( card ) => {
                const aiLines = Array.from( card.querySelectorAll( '.qw-ai-line' ) )
                const marked = Array.from( card.querySelectorAll( '.qw-option.qw-ai' ) )
                const selected = Array.from( card.querySelectorAll( '.qw-option.qw-selected' ) )
                const idNode = card.querySelector( '.qw-id' )

                return {
                    'qidx': card.getAttribute( 'data-qidx' ),
                    'questionId': idNode === null ? null : idNode.textContent.trim(),
                    'aiLineCount': aiLines.length,
                    'aiLineText': aiLines.length === 0 ? '' : aiLines[ 0 ].textContent.trim(),
                    'optionCount': card.querySelectorAll( '.qw-option' ).length,
                    'markedCount': marked.length,
                    'markedWithHint': marked.filter( ( row ) => row.querySelector( '.qw-ai-hint' ) !== null ).length,
                    'markedAlsoSelected': marked.filter( ( row ) => row.classList.contains( 'qw-selected' ) ).length,
                    'selectedCount': selected.length
                }
            } )
        }
    }, documentId )
}


// K1 — the recommendation is VISIBLE and DISTINGUISHABLE from a selection.
//
// The comparison set is every open question of the target revision that carries a non-empty
// recommendation text, computed by the oracle immediately before the run. The vacuum latch is the
// positive control: "0 options selected" says nothing until this same fixture has been shown to SEE a
// selection, so a second target carrying a real preselection is measured in the same pass.
const measureDisplay = async ( { surface, oracle, consoleErrors, failedRequests, positiveControl } ) => {
    const recommended = oracle[ 'questions' ]
        .filter( ( question ) => typeof question[ 'aiRecommendation' ] === 'string' && question[ 'aiRecommendation' ].trim().length > 0 )

    const compared = recommended.length

    if( compared === 0 ) {
        return judgeLink( {
            'id': 'K1',
            'compared': 0,
            'total': oracle[ 'open' ],
            'conditions': [],
            'expected': { 'withRecommendation': 0 },
            'measured': { 'cards': surface[ 'cardCount' ] },
            'evidence': [],
            'errorText': `the target revision carries ${ oracle[ 'open' ] } open question(s) and none of them a recommendation text — K1 has no comparison set`
        } )
    }

    const byId = surface[ 'cards' ]
        .reduce( ( acc, card ) => {
            if( card[ 'questionId' ] !== null ) { acc[ card[ 'questionId' ] ] = card }

            return acc
        }, {} )

    const perQuestion = recommended
        .map( ( question ) => {
            const card = byId[ question[ 'id' ] ] === undefined ? null : byId[ question[ 'id' ] ]
            const expectedText = normalizeSpace( { 'text': question[ 'aiRecommendation' ] } )[ 'text' ]
            const shownText = card === null ? '' : normalizeSpace( { 'text': card[ 'aiLineText' ] } )[ 'text' ]

            return {
                'id': question[ 'id' ],
                'cardFound': card !== null,
                'aiLineCount': card === null ? 0 : card[ 'aiLineCount' ],
                'carriesFullText': card !== null && shownText.includes( expectedText ) === true,
                'markedCount': card === null ? 0 : card[ 'markedCount' ],
                'markedWithHint': card === null ? 0 : card[ 'markedWithHint' ],
                'markedAlsoSelected': card === null ? 0 : card[ 'markedAlsoSelected' ],
                'selectedCount': card === null ? 0 : card[ 'selectedCount' ],
                'cascade': cascadeStageOf( { question } )[ 'stage' ]
            }
        } )

    const missingCard = perQuestion.filter( ( row ) => row[ 'cardFound' ] !== true )
    const wrongLineCount = perQuestion.filter( ( row ) => row[ 'aiLineCount' ] !== 1 )
    const missingText = perQuestion.filter( ( row ) => row[ 'carriesFullText' ] !== true )
    const hintMissing = perQuestion.filter( ( row ) => row[ 'markedWithHint' ] !== row[ 'markedCount' ] )
    const alsoSelected = perQuestion.filter( ( row ) => row[ 'markedAlsoSelected' ] > 0 )

    const cascade = perQuestion
        .reduce( ( acc, row ) => {
            acc[ row[ 'cascade' ] ] = ( acc[ row[ 'cascade' ] ] === undefined ? 0 : acc[ row[ 'cascade' ] ] ) + 1

            return acc
        }, {} )

    const conditions = [
        condition( { 'name': 'every recommended question has a card', 'passed': missingCard.length === 0, 'detail': `${ compared - missingCard.length } / ${ compared } found; missing ${ missingCard.map( ( row ) => row[ 'id' ] ).join( ', ' ) }` } ),
        condition( { 'name': 'exactly one recommendation line per question', 'passed': wrongLineCount.length === 0, 'detail': `${ compared - wrongLineCount.length } / ${ compared } carry exactly one .qw-ai-line` } ),
        condition( { 'name': 'the line carries the FULL recommendation text', 'passed': missingText.length === 0, 'detail': `${ compared - missingText.length } / ${ compared } contain the source text verbatim; missing ${ missingText.map( ( row ) => row[ 'id' ] ).join( ', ' ) }` } ),
        condition( { 'name': 'every marked option carries the (KI-Empfehlung) hint', 'passed': hintMissing.length === 0, 'detail': `${ compared - hintMissing.length } / ${ compared } questions have hint == marker count` } ),
        condition( { 'name': 'no marked option is also selected', 'passed': alsoSelected.length === 0, 'detail': `${ alsoSelected.length } question(s) carry an option that is qw-ai AND qw-selected — a recommendation is display, never a selection` } ),
        condition( { 'name': 'no console error', 'passed': consoleErrors.length === 0, 'detail': `${ consoleErrors.length } console error(s): ${ consoleErrors.slice( 0, 3 ).join( ' // ' ) }` } ),
        condition( { 'name': 'no failed request', 'passed': failedRequests.length === 0, 'detail': `${ failedRequests.length } failed request(s): ${ failedRequests.slice( 0, 3 ).join( ' // ' ) }` } ),
        condition( { 'name': 'VACUUM LATCH — this fixture can SEE a selection', 'passed': positiveControl[ 'selectedSeen' ] > 0, 'detail': positiveControl[ 'detail' ] } )
    ]

    return judgeLink( {
        'id': 'K1',
        compared,
        'total': compared,
        conditions,
        'expected': { 'withRecommendation': compared, 'openQuestions': oracle[ 'open' ] },
        'measured': { 'cards': surface[ 'cardCount' ], 'cascade': cascade, 'positiveControlSelected': positiveControl[ 'selectedSeen' ] },
        'evidence': perQuestion
    } )
}


// The positive control of K1 — a target that really carries a preselection, so "0 selected" on the
// main target is a MEASUREMENT and not the silence of a dead page. Which target it is, is derived by
// the caller from the running stock and handed in; nothing here is copied from a previous report.
const measurePositiveControl = async ( { context, origin, documentId, label } ) => {
    if( typeof documentId !== 'string' || documentId.length === 0 ) {
        return { 'selectedSeen': 0, 'detail': 'no target carrying a non-empty preselection was found in the stock — K1 stays INCONCLUSIVE rather than green' }
    }

    const opened = await openTarget( { context, origin, documentId, label, 'requireWidgets': true } )
    const surface = await readQuestionSurface( { 'page': opened[ 'page' ], documentId } )

    await opened[ 'page' ].close()

    const selectedSeen = surface[ 'cards' ]
        .reduce( ( sum, card ) => sum + card[ 'selectedCount' ], 0 )

    return {
        selectedSeen,
        'documentId': documentId,
        'label': label,
        'cards': surface[ 'cardCount' ],
        'detail': `${ documentId }/${ label } renders ${ surface[ 'cardCount' ] } card(s) and ${ selectedSeen } selected option(s) — the same reader therefore CAN see a selection`
    }
}


// K2 — one set, four displays, and the difference is NAMED.
//
// The comparison set is the oracle of EVERY target revision, recomputed before the run. The vacuum
// latch is the empty revision: a target with 0 open questions must show the empty state while the SAME
// fixture in the SAME pass measures a non-zero count elsewhere. A zero standing alone is a dead page;
// a zero beside a measured twelve is a reading.
const measureCounters = ( { perRevision, registryOpen, registryBasis } ) => {
    const compared = perRevision.length

    if( compared === 0 ) {
        return judgeLink( {
            'id': 'K2',
            'compared': 0,
            'total': 0,
            'conditions': [],
            'evidence': [],
            'errorText': 'no revision could be measured — K2 has no comparison set'
        } )
    }

    const nonZero = perRevision.filter( ( row ) => row[ 'expectedOpen' ] > 0 )
    const zero = perRevision.filter( ( row ) => row[ 'expectedOpen' ] === 0 )

    const zoneWrong = perRevision.filter( ( row ) => row[ 'zone2Counted' ] !== row[ 'expectedOpen' ] )
    const renderedWrong = perRevision.filter( ( row ) => row[ 'qwRendered' ] !== row[ 'expectedOpen' ] )
    const cardsWrong = perRevision.filter( ( row ) => row[ 'cardCount' ] !== row[ 'expectedOpen' ] )
    const popupWrong = perRevision.filter( ( row ) => row[ 'popupMeasured' ] === true && ( row[ 'popupTotal' ] !== row[ 'expectedOpen' ] || row[ 'popupFields' ] !== row[ 'expectedOpen' ] ) )
    const popupUnmeasured = perRevision.filter( ( row ) => row[ 'popupMeasured' ] !== true )
    const sidebarBare = perRevision.filter( ( row ) => row[ 'sidebarPresent' ] === true && row[ 'sidebarText' ] === '0' )
    const divergenceWrong = perRevision.filter( ( row ) => row[ 'divergenceExpected' ] !== row[ 'divergencePresent' ] )
    const divergenceSilent = perRevision
        .filter( ( row ) => row[ 'divergencePresent' ] === true )
        .filter( ( row ) => row[ 'divergenceNamesBoth' ] !== true )

    const conditions = [
        condition( { 'name': 'zone-2 header counts the oracle', 'passed': zoneWrong.length === 0, 'detail': `${ compared - zoneWrong.length } / ${ compared } revisions agree; ${ zoneWrong.map( ( row ) => `${ row[ 'label' ] } shows ${ row[ 'zone2Counted' ] } expected ${ row[ 'expectedOpen' ] }` ).join( ', ' ) }` } ),
        condition( { 'name': 'data-qw-rendered counts the oracle', 'passed': renderedWrong.length === 0, 'detail': `${ compared - renderedWrong.length } / ${ compared } agree; ${ renderedWrong.map( ( row ) => `${ row[ 'label' ] } ${ row[ 'qwRendered' ] } vs ${ row[ 'expectedOpen' ] }` ).join( ', ' ) }` } ),
        condition( { 'name': 'the rendered cards count the oracle', 'passed': cardsWrong.length === 0, 'detail': `${ compared - cardsWrong.length } / ${ compared } agree; ${ cardsWrong.map( ( row ) => `${ row[ 'label' ] } ${ row[ 'cardCount' ] } vs ${ row[ 'expectedOpen' ] }` ).join( ', ' ) }` } ),
        condition( { 'name': 'popup label and answer fields count the oracle', 'passed': popupWrong.length === 0 && popupUnmeasured.length === 0, 'detail': `measured on ${ compared - popupUnmeasured.length } / ${ compared }; mismatches ${ popupWrong.map( ( row ) => `${ row[ 'label' ] } label-total ${ row[ 'popupTotal' ] } fields ${ row[ 'popupFields' ] } vs ${ row[ 'expectedOpen' ] }` ).join( ', ' ) }; unmeasured ${ popupUnmeasured.map( ( row ) => `${ row[ 'label' ] } (${ row[ 'popupReason' ] })` ).join( ', ' ) }` } ),
        condition( { 'name': 'the sidebar row carries no bare zero', 'passed': sidebarBare.length === 0, 'detail': `${ sidebarBare.length } revision(s) show a bare 0 in the sidebar chip; registry open=${ registryOpen }, basis=${ registryBasis }` } ),
        condition( { 'name': 'the divergence band fires exactly when the two sets differ', 'passed': divergenceWrong.length === 0, 'detail': `${ compared - divergenceWrong.length } / ${ compared } agree; ${ divergenceWrong.map( ( row ) => `${ row[ 'label' ] } expected ${ row[ 'divergenceExpected' ] } got ${ row[ 'divergencePresent' ] }` ).join( ', ' ) }` } ),
        condition( { 'name': 'the divergence band names BOTH numbers', 'passed': divergenceSilent.length === 0, 'detail': `${ divergenceSilent.length } band(s) fail to name both figures verbatim` } ),
        condition( { 'name': 'VACUUM LATCH — a non-zero count was measured by the SAME reader', 'passed': nonZero.length > 0, 'detail': `${ nonZero.length } revision(s) with a non-zero count (${ nonZero.map( ( row ) => `${ row[ 'label' ] }=${ row[ 'expectedOpen' ] }` ).join( ', ' ) }) beside ${ zero.length } empty one(s) (${ zero.map( ( row ) => row[ 'label' ] ).join( ', ' ) })` } ),
        condition( { 'name': 'VACUUM LATCH — the empty revision shows the empty state', 'passed': zero.length === 0 || zero.every( ( row ) => row[ 'cardCount' ] === 0 ) === true, 'detail': `${ zero.filter( ( row ) => row[ 'cardCount' ] === 0 ).length } / ${ zero.length } empty revision(s) render zero cards` } )
    ]

    return judgeLink( {
        'id': 'K2',
        compared,
        'total': compared,
        conditions,
        'expected': perRevision.map( ( row ) => { return { 'label': row[ 'label' ], 'open': row[ 'expectedOpen' ] } } ),
        'measured': { 'registryOpen': registryOpen, 'registryBasis': registryBasis },
        'evidence': perRevision
    } )
}


// Read the popup: its label and its answer fields, plus the amber placeholder state per field. The
// popup is opened, read and closed inside ONE call so a later link never inherits an open modal.
const readPopup = async ( { page } ) => {
    const opener = await page.$( '#ps-edit-prompt' )

    if( opener === null ) { return { 'measured': false, 'reason': 'the prompt button #ps-edit-prompt is not on this surface' } }

    await opener.click().catch( () => null )

    const appeared = await page.waitForFunction( () => {
        const panel = document.getElementById( 't-panel-prompt' )

        return panel !== null && panel.classList.contains( 't-hidden' ) !== true
    }, { 'timeout': 8000 } ).then( () => true ).catch( () => false )

    if( appeared !== true ) { return { 'measured': false, 'reason': 'the prompt panel did not open within 8000 ms' } }

    const read = await page.evaluate( () => {
        const label = document.getElementById( 'pp-questions-label' )
        const fields = Array.from( document.querySelectorAll( '#pp-questions-list .pp-question-input' ) )
        const empty = document.querySelector( '.pp-questions-empty' )
        const notice = document.getElementById( 'pp-unconfirmed' )
        const labelText = label === null ? '' : label.textContent.trim()
        const match = labelText.match( /\((\d+)\s*\/\s*(\d+)\)/ )

        return {
            'labelText': labelText,
            'labelAnswered': match === null ? null : Number.parseInt( match[ 1 ], 10 ),
            'labelTotal': match === null ? null : Number.parseInt( match[ 2 ], 10 ),
            'fieldCount': fields.length,
            'emptyText': empty === null ? null : empty.textContent.trim(),
            'noticeHidden': notice === null ? null : notice.classList.contains( 't-hidden' ),
            'noticeText': notice === null ? null : notice.textContent.trim(),
            'fields': fields.map( ( field ) => {
                return {
                    'idx': field.getAttribute( 'data-pp-answer' ),
                    'value': field.value,
                    'placeholder': field.placeholder,
                    'unconfirmed': field.classList.contains( 'pp-question-input-unconfirmed' )
                }
            } )
        }
    } )

    return { 'measured': true, 'reason': null, ...read }
}


const closePopup = async ( { page } ) => {
    await page.evaluate( () => {
        const modal = document.getElementById( 'transcript-modal' )

        if( modal !== null ) { modal.classList.add( 't-hidden' ) }
    } ).catch( () => null )
}


// K3 + K4 — one interaction, two verdicts.
//
// The two halves are measured in ONE pass on purpose: one half alone would be either the old defect
// (an unconfirmed selection gets harvested) or the withdrawal of WI-109 (nothing gets harvested at
// all). Together they are the loud edge. BOTH report paths are driven, never one: the popup path
// (applyPromptEdit -> #pp-unconfirmed) and the transcript path (saveTranscript -> #t-unconfirmed).
// Driving one would close the case and leave the class open.
const driveConfirmationAndSubmit = async ( { page, oracle } ) => {
    const struct = { 'status': false, 'reason': null, 'questionA': null, 'questionB': null, 'pathB': null, 'pathA': null, 'stateBefore': null }

    if( oracle[ 'open' ] < 2 ) {
        struct[ 'reason' ] = `the target revision carries ${ oracle[ 'open' ] } open question(s); the assert pair needs at least two`

        return struct
    }

    // Question A is served but NOT confirmed, question B is served AND confirmed. Card 0 is the only
    // one rendered expanded, so B (the one whose add button must be clicked) is card 0 and A is card 1
    // — the collapsed card still takes an option click, but the add button of a collapsed card is not
    // reachable without opening it, and opening it would be a third interaction with its own failure
    // mode.
    const idB = oracle[ 'questions' ][ 0 ][ 'id' ]
    const idA = oracle[ 'questions' ][ 1 ][ 'id' ]

    const clicked = await page.evaluate( () => {
        const pick = ( qidx ) => {
            const card = document.querySelector( `#question-widgets .qw-card[data-qidx="${ qidx }"]` )

            if( card === null ) { return null }

            const options = Array.from( card.querySelectorAll( '.qw-option' ) )
            const real = options.find( ( row ) => row.querySelector( '.qw-option-key' ) !== null )

            return real === undefined ? ( options.length === 0 ? null : options[ 0 ] ) : real
        }

        const optionB = pick( 0 )
        const optionA = pick( 1 )

        if( optionB === null || optionA === null ) { return { 'ok': false, 'reason': 'could not find a clickable option on both cards' } }

        optionB.click()
        optionA.click()

        const addBtn = document.querySelector( '#question-widgets .qw-card[data-qidx="0"] .qw-add-btn' )

        if( addBtn === null ) { return { 'ok': false, 'reason': 'card 0 carries no add button' } }

        addBtn.click()

        return { 'ok': true, 'reason': null, 'addLabel': addBtn.textContent.trim() }
    } )

    if( clicked[ 'ok' ] !== true ) {
        struct[ 'reason' ] = clicked[ 'reason' ]

        return struct
    }

    // Let the debounced question-state write (250 ms) run before anything reads the store.
    await page.waitForTimeout( 900 )

    const cardState = await page.evaluate( () => {
        const cards = Array.from( document.querySelectorAll( '#question-widgets .qw-card' ) )

        return cards
            .slice( 0, 2 )
            .map( ( card ) => {
                const addBtn = card.querySelector( '.qw-add-btn' )
                const idNode = card.querySelector( '.qw-id' )

                return {
                    'qidx': card.getAttribute( 'data-qidx' ),
                    'questionId': idNode === null ? null : idNode.textContent.trim(),
                    'selectedCount': card.querySelectorAll( '.qw-option.qw-selected' ).length,
                    'addLabel': addBtn === null ? null : addBtn.textContent.trim(),
                    'addDone': addBtn === null ? false : addBtn.classList.contains( 'qw-add-btn--done' )
                }
            } )
    } )

    // Path B — the popup. Its answer fields are the WI-109 gate made visible: the confirmed answer
    // carries a value, the unconfirmed one carries only an amber placeholder.
    const popup = await readPopup( { page } )

    if( popup[ 'measured' ] !== true ) {
        struct[ 'reason' ] = `path B unmeasurable: ${ popup[ 'reason' ] }`
        struct[ 'questionA' ] = idA
        struct[ 'questionB' ] = idB
        struct[ 'stateBefore' ] = cardState

        return struct
    }

    const applied = await page.evaluate( () => {
        const button = document.getElementById( 'pp-apply' )

        if( button === null ) { return { 'ok': false, 'reason': 'the popup carries no #pp-apply button' } }

        button.click()

        return { 'ok': true, 'reason': null }
    } )

    await page.waitForTimeout( 1500 )

    const pathB = await page.evaluate( () => {
        const notice = document.getElementById( 'pp-unconfirmed' )
        const success = document.getElementById( 'pp-success' )
        const error = document.getElementById( 'pp-error' )

        return {
            'noticePresent': notice !== null,
            'noticeHidden': notice === null ? null : notice.classList.contains( 't-hidden' ),
            'noticeText': notice === null ? '' : notice.textContent.trim(),
            'successText': success === null ? '' : success.textContent.trim(),
            'errorText': error === null ? '' : error.textContent.trim()
        }
    } )

    await closePopup( { page } )

    // Path A — the transcript modal, and it must be opened in REVISION mode. Measured on this build:
    // openTranscriptModal derives `revisionMode` from opts (transcriptId / revisionId / seed content)
    // and otherwise switches to the "Memo erstellen" tab, where saveTranscript returns at its first
    // branch — LONG before the notice call. The generic Transcript button therefore never reaches
    // path A, and driving it would report a hidden box as a defect of the product instead of a defect
    // of the driving. The "+ Frage" footer action of a question card is the surface route that seeds
    // content and so opens revision mode; that is what is clicked here.
    //
    // The branch actually taken is READ BACK (which panel is visible) and reported. If the surface did
    // not end up in revision mode, path A is INCONCLUSIVE with that reason — never a FAIL, because a
    // box that was never asked to speak has not been shown to be silent.
    const pathA = await page.evaluate( async () => {
        const addQ = Array.from( document.querySelectorAll( '#question-widgets .qw-card[data-qidx="1"] .qw-secondary-btn' ) )
            .find( ( button ) => button.textContent.trim().startsWith( '+' ) )

        if( addQ === undefined ) { return { 'ok': false, 'reason': 'no "+ Frage" action on card 1 — the revision-mode entry point is absent' } }

        addQ.click()

        await new Promise( ( done ) => setTimeout( done, 800 ) )

        const revisionPanel = document.getElementById( 't-panel-revision' )
        const inRevisionMode = revisionPanel !== null && revisionPanel.classList.contains( 't-hidden' ) !== true

        if( inRevisionMode !== true ) {
            return { 'ok': false, 'inRevisionMode': false, 'reason': 'the transcript modal did not open in revision mode; saveTranscript returns at the new/add branch before the notice is produced' }
        }

        const content = document.getElementById( 't-content' )
        const revision = document.getElementById( 't-revision' )

        if( content === null ) { return { 'ok': false, 'reason': 'the transcript modal carries no #t-content' } }

        content.value = `${ content.value }\nPRD-44 chain acceptance probe`
        content.dispatchEvent( new Event( 'input', { 'bubbles': true } ) )

        const save = document.getElementById( 't-save' )

        if( save === null ) { return { 'ok': false, 'reason': 'the transcript modal carries no #t-save' } }

        save.click()

        await new Promise( ( done ) => setTimeout( done, 2000 ) )

        const notice = document.getElementById( 't-unconfirmed' )
        const error = document.getElementById( 't-error' )

        return {
            'ok': true,
            'inRevisionMode': true,
            'reason': null,
            'revisionValue': revision === null ? null : revision.value,
            'errorText': error === null ? '' : error.textContent.trim(),
            'noticePresent': notice !== null,
            'noticeHidden': notice === null ? null : notice.classList.contains( 't-hidden' ),
            'noticeText': notice === null ? '' : notice.textContent.trim()
        }
    } )

    struct[ 'status' ] = true
    struct[ 'questionA' ] = idA
    struct[ 'questionB' ] = idB
    struct[ 'stateBefore' ] = cardState
    struct[ 'popup' ] = popup
    struct[ 'applied' ] = applied
    struct[ 'pathB' ] = pathB
    struct[ 'pathA' ] = pathA

    return struct
}


const measureConfirmation = ( { drive, oracle } ) => {
    if( drive[ 'status' ] !== true ) {
        return judgeLink( {
            'id': 'K3',
            'compared': 0,
            'total': oracle[ 'open' ],
            'conditions': [],
            'evidence': [],
            'errorText': `K3 could not be driven: ${ drive[ 'reason' ] }`
        } )
    }

    const popup = drive[ 'popup' ]
    const fields = Array.isArray( popup[ 'fields' ] ) === true ? popup[ 'fields' ] : []
    const fieldB = fields.length === 0 ? null : fields[ 0 ]
    const fieldA = fields.length < 2 ? null : fields[ 1 ]
    const cards = Array.isArray( drive[ 'stateBefore' ] ) === true ? drive[ 'stateBefore' ] : []
    const cardB = cards.length === 0 ? null : cards[ 0 ]
    const cardA = cards.length < 2 ? null : cards[ 1 ]

    const noticeB = drive[ 'pathB' ][ 'noticeText' ]
    const noticeA = drive[ 'pathA' ][ 'ok' ] === true ? drive[ 'pathA' ][ 'noticeText' ] : ''

    const namesBoth = ( text ) => {
        return /\b1\s+von\s+\d+\b/.test( String( text ) ) === true
    }

    const conditions = [
        condition( { 'name': 'question B is confirmed', 'passed': cardB !== null && cardB[ 'addDone' ] === true, 'detail': `card 0 (${ drive[ 'questionB' ] }) add button reads "${ cardB === null ? 'n/a' : cardB[ 'addLabel' ] }"` } ),
        condition( { 'name': 'question A is selected but NOT confirmed', 'passed': cardA !== null && cardA[ 'selectedCount' ] > 0 && cardA[ 'addDone' ] !== true, 'detail': `card 1 (${ drive[ 'questionA' ] }) has ${ cardA === null ? 0 : cardA[ 'selectedCount' ] } selected option(s), add button "${ cardA === null ? 'n/a' : cardA[ 'addLabel' ] }"` } ),
        condition( { 'name': 'B carries an answer VALUE in the popup', 'passed': fieldB !== null && String( fieldB[ 'value' ] ).trim().length > 0, 'detail': `field 0 value "${ fieldB === null ? '' : fieldB[ 'value' ] }"` } ),
        condition( { 'name': 'A carries an EMPTY value and an amber placeholder', 'passed': fieldA !== null && String( fieldA[ 'value' ] ).length === 0 && fieldA[ 'unconfirmed' ] === true, 'detail': `field 1 value "${ fieldA === null ? 'n/a' : fieldA[ 'value' ] }", amber=${ fieldA === null ? 'n/a' : fieldA[ 'unconfirmed' ] }, placeholder "${ fieldA === null ? '' : String( fieldA[ 'placeholder' ] ).slice( 0, 60 ) }"` } ),
        condition( { 'name': 'path B (#pp-unconfirmed) is VISIBLE and names both numbers', 'passed': drive[ 'pathB' ][ 'noticeHidden' ] === false && namesBoth( noticeB ), 'detail': `hidden=${ drive[ 'pathB' ][ 'noticeHidden' ] }, text "${ String( noticeB ).slice( 0, 140 ) }"` } ),
        condition( { 'name': 'path B names question A by its identifier', 'passed': String( noticeB ).includes( drive[ 'questionA' ] ) === true, 'detail': `looking for ${ drive[ 'questionA' ] } in the path B notice` } ),
        condition( { 'name': 'path A (#t-unconfirmed) is VISIBLE and names both numbers', 'passed': drive[ 'pathA' ][ 'ok' ] === true && drive[ 'pathA' ][ 'noticeHidden' ] === false && namesBoth( noticeA ), 'detail': `driven=${ drive[ 'pathA' ][ 'ok' ] }, hidden=${ drive[ 'pathA' ][ 'noticeHidden' ] }, text "${ String( noticeA ).slice( 0, 140 ) }"` } ),
        condition( { 'name': 'path A names question A by its identifier', 'passed': String( noticeA ).includes( drive[ 'questionA' ] ) === true, 'detail': `looking for ${ drive[ 'questionA' ] } in the path A notice` } ),
        condition( { 'name': 'VACUUM LATCH — the SAME box was measured in its silent state', 'passed': popup[ 'noticeHidden' ] === true, 'detail': `before the save the popup notice was hidden=${ popup[ 'noticeHidden' ] } with text "${ String( popup[ 'noticeText' ] ).slice( 0, 60 ) }" — a box that is never seen quiet proves nothing when it is loud` } )
    ]

    // BOTH report paths are part of the comparison set. If one of them could not be put into the state
    // where it produces at all, the link is INCONCLUSIVE — not PASS (it was only half measured) and
    // not FAIL (a box that was never asked to speak has not been shown to be silent). The conditions
    // that DID hold stay in the object, so the record shows what was measured either way.
    const pathADrivable = drive[ 'pathA' ][ 'ok' ] === true

    return judgeLink( {
        'id': 'K3',
        'compared': pathADrivable === true ? 2 : 0,
        'total': oracle[ 'open' ],
        conditions,
        'expected': { 'openQuestions': oracle[ 'open' ], 'served': 2, 'confirmed': 1, 'selectedOnly': 1, 'reportPaths': 2 },
        'measured': { 'questionA': drive[ 'questionA' ], 'questionB': drive[ 'questionB' ], 'popupFields': fields.length, 'pathADrivable': pathADrivable },
        'evidence': [ { 'cards': cards }, { 'pathB': drive[ 'pathB' ] }, { 'pathA': drive[ 'pathA' ] } ],
        'errorText': pathADrivable === true ? undefined : `report path A could not be driven: ${ drive[ 'pathA' ][ 'reason' ] } — one of the two mandatory paths is therefore UNMEASURED, and a half-measured link is never a pass`
    } )
}


// K4 — what is stored, and what expressly is not. Counted on the text that was ACTUALLY WRITTEN, read
// back off the clone, never claimed from the DOM. The byte size of the file is named alongside, and
// the positive control is the same counter finding the confirmed answer: a counter that finds nothing
// anywhere has not shown that it can find.
const measureSubmit = async ( { drive, oracle, cloneDir, since } ) => {
    if( drive[ 'status' ] !== true ) {
        return judgeLink( {
            'id': 'K4',
            'compared': 0,
            'total': oracle[ 'open' ],
            'conditions': [],
            'evidence': [],
            'errorText': `K4 could not be driven: ${ drive[ 'reason' ] }`
        } )
    }

    if( typeof cloneDir !== 'string' || cloneDir.length === 0 || existsSync( cloneDir ) !== true ) {
        return judgeLink( {
            'id': 'K4',
            'compared': 0,
            'total': oracle[ 'open' ],
            'conditions': [],
            'evidence': [],
            'errorText': `the clone directory ${ cloneDir } was not handed in or does not exist — the written text cannot be read back, so K4 is INCONCLUSIVE rather than assumed`
        } )
    }

    const found = await collectWrittenText( { cloneDir, since } )

    if( found[ 'files' ].length === 0 ) {
        return judgeLink( {
            'id': 'K4',
            'compared': 0,
            'total': oracle[ 'open' ],
            'conditions': [],
            'evidence': [ found ],
            'errorText': `no file under ${ cloneDir } was modified at or after the watermark — nothing this run wrote can be counted, so K4 is INCONCLUSIVE. Scanned ${ found[ 'scanned' ] } directory entries`
        } )
    }

    const text = found[ 'text' ]
    const headingB = `## Antwort auf ${ drive[ 'questionB' ] }`
    const headingBCount = text.split( headingB ).length - 1

    // PER FILE, not across the corpus. This run drives BOTH report paths, and each of them writes its
    // own transcript — so the confirmed answer legitimately appears once per written document. The
    // rule that matters is the idempotency rule: no single document may carry it twice. Counting the
    // corpus instead would turn "both paths were exercised" into a defect, which is the measurement
    // being wrong about the product rather than the product being wrong.
    const perFileB = found[ 'perFile' ]
        .map( ( entry ) => { return { 'file': entry[ 'file' ], 'count': entry[ 'content' ].split( headingB ).length - 1 } } )
    const doubledInOneFile = perFileB.filter( ( entry ) => entry[ 'count' ] > 1 )
    const carryingFiles = perFileB.filter( ( entry ) => entry[ 'count' ] === 1 )

    const questionA = oracle[ 'questions' ][ 1 ]
    const optionTextA = ( questionA[ 'options' ] || [] )
        .filter( ( option ) => option !== null && option[ 'kind' ] === 'option' )
        .map( ( option ) => String( option[ 'label' ] ) )
        .find( ( label ) => label.length > 12 )

    const headingA = `## Antwort auf ${ drive[ 'questionA' ] }`
    const headingACount = text.split( headingA ).length - 1
    const optionACount = optionTextA === undefined ? null : text.split( optionTextA ).length - 1

    const conditions = [
        condition( { 'name': 'the confirmed answer arrived, and EXACTLY once per written document', 'passed': carryingFiles.length > 0 && doubledInOneFile.length === 0, 'detail': `"${ headingB }" occurs ${ headingBCount }x in ${ found[ 'bytes' ] } bytes across ${ found[ 'files' ].length } file(s) written by THIS run (of ${ found[ 'scanned' ] } directory entries scanned); ${ carryingFiles.length } file(s) carry it exactly once, ${ doubledInOneFile.length } carry it more than once` } ),
        condition( { 'name': 'the unconfirmed selection was NOT harvested', 'passed': headingACount === 0, 'detail': `"${ headingA }" occurs ${ headingACount }x — the intent of ${ drive[ 'questionA' ] } must not be in the stored text` } ),
        condition( { 'name': 'the option text of the unconfirmed question is absent', 'passed': optionACount === 0 || optionACount === null, 'detail': optionTextA === undefined ? 'no option label long enough to be a distinctive probe — this half is reported, not asserted' : `"${ String( optionTextA ).slice( 0, 40 ) }" occurs ${ optionACount }x` } ),
        condition( { 'name': 'the notice stood BEFORE the write and named A', 'passed': drive[ 'pathB' ][ 'noticeHidden' ] === false && String( drive[ 'pathB' ][ 'noticeText' ] ).includes( drive[ 'questionA' ] ) === true, 'detail': `path B notice visible=${ drive[ 'pathB' ][ 'noticeHidden' ] === false }, names ${ drive[ 'questionA' ] }=${ String( drive[ 'pathB' ][ 'noticeText' ] ).includes( drive[ 'questionA' ] ) }` } ),
        condition( { 'name': 'VACUUM LATCH — the same counter CAN find', 'passed': headingBCount > 0, 'detail': `the identical split-counter found ${ headingBCount } occurrence(s) of the confirmed heading, so a 0 for the unconfirmed one is a reading and not a blind counter` } )
    ]

    return judgeLink( {
        'id': 'K4',
        'compared': 2,
        'total': oracle[ 'open' ],
        conditions,
        'expected': { 'confirmedHeadings': 1, 'unconfirmedHeadings': 0, 'openQuestions': oracle[ 'open' ] },
        'measured': { 'bytes': found[ 'bytes' ], 'files': found[ 'files' ].length, 'scannedEntries': found[ 'scanned' ], 'newerThanWatermark': found[ 'newerThanWatermark' ], 'headingBCount': headingBCount, 'headingBPerFile': perFileB, 'headingACount': headingACount },
        'evidence': [ { 'files': found[ 'files' ] } ]
    } )
}


// Read back what THIS RUN wrote into the clone. Only inside the handed-in directory, only with an
// existsSync latch — the repo boundary rule, and the reason a missing path is INCONCLUSIVE and not a
// crash.
//
// THE WATERMARK IS THE WHOLE POINT. A clone carries the memo's ENTIRE transcript history, and those
// files are full of "## Antwort auf F…" headings from real earlier answers. Counting the folder would
// measure the memo's past and call it this run's output — measured on the first run of this fixture:
// 11 hits for a heading that had been written exactly once. So only files modified at or after the
// watermark taken immediately before the interaction are counted, and the run reports how many files
// it looked at and how many survived the cut.
const collectWrittenText = async ( { cloneDir, since } ) => {
    const struct = { 'files': [], 'perFile': [], 'text': '', 'bytes': 0, 'scanned': 0, 'newerThanWatermark': 0, 'watermark': since }
    const candidates = [ join( cloneDir, 'transcripts' ), cloneDir ]

    const readings = await Promise.all( candidates.map( async ( dir ) => {
        if( existsSync( dir ) !== true ) { return [] }

        const entries = await readdir( dir, { 'withFileTypes': true } ).catch( () => [] )

        struct[ 'scanned' ] = struct[ 'scanned' ] + entries.length

        const files = entries
            .filter( ( entry ) => entry.isFile() === true )
            .filter( ( entry ) => entry.name.endsWith( '.md' ) === true || entry.name.endsWith( '.json' ) === true )
            .map( ( entry ) => join( dir, entry.name ) )

        return await Promise.all( files.map( async ( file ) => {
            const info = await stat( file ).catch( () => null )

            if( info === null || info.mtimeMs < since ) { return null }

            const content = await readFile( file, 'utf-8' ).catch( () => null )

            return content === null ? null : { file, content }
        } ) )
    } ) )

    const flat = readings
        .flat()
        .filter( ( entry ) => entry !== null )

    struct[ 'newerThanWatermark' ] = flat.length
    struct[ 'perFile' ] = flat
    struct[ 'files' ] = flat.map( ( entry ) => entry[ 'file' ] )
    struct[ 'text' ] = flat.map( ( entry ) => entry[ 'content' ] ).join( '\n' )
    struct[ 'bytes' ] = struct[ 'text' ].length

    return struct
}


// K5 — the state survives the process. The process change is REAL: the caller stops the server, proves
// the death (pid gone AND port free) and starts a new one, then hands the two pids in here. A
// "presumably stopped" does not count, and a restart that could not be performed is INCONCLUSIVE with
// a named reason — never green.
const measureRestart = async ( { restart, oracle, drive } ) => {
    if( restart === null || restart[ 'performed' ] !== true ) {
        return judgeLink( {
            'id': 'K5',
            'compared': 0,
            'total': oracle[ 'open' ],
            'conditions': [],
            'evidence': [],
            'errorText': `no real process change was performed: ${ restart === null ? 'no restart command handed in' : restart[ 'reason' ] }`
        } )
    }

    const after = restart[ 'surface' ]
    const stateResponse = restart[ 'questionState' ]
    const records = stateResponse === null || stateResponse[ 'payload' ] === null ? {} : ( stateResponse[ 'payload' ][ 'entries' ] === undefined ? {} : stateResponse[ 'payload' ][ 'entries' ] )
    const recordB = records[ drive[ 'questionB' ] ] === undefined ? null : records[ drive[ 'questionB' ] ]
    const recordA = records[ drive[ 'questionA' ] ] === undefined ? null : records[ drive[ 'questionA' ] ]

    const answerTextB = recordB === null || recordB[ 'confirmed' ] === undefined || recordB[ 'confirmed' ] === null ? null : recordB[ 'confirmed' ][ 'answerText' ]
    const serializedA = JSON.stringify( recordA )

    const ids = after[ 'cards' ].map( ( card ) => card[ 'questionId' ] )
    const duplicated = ids.filter( ( id, index ) => ids.indexOf( id ) !== index )

    const conditions = [
        condition( { 'name': 'the server really changed process', 'passed': restart[ 'pidBefore' ] !== restart[ 'pidAfter' ] && restart[ 'deathVerified' ] === true, 'detail': `pid ${ restart[ 'pidBefore' ] } -> ${ restart[ 'pidAfter' ] }, death verified=${ restart[ 'deathVerified' ] } (pid gone AND port free)` } ),
        condition( { 'name': 'B returns as a CONFIRMED answer with its exact text', 'passed': typeof answerTextB === 'string' && answerTextB.length > 0, 'detail': `${ drive[ 'questionB' ] } answerText "${ String( answerTextB ).slice( 0, 60 ) }"` } ),
        condition( { 'name': 'A returns as an INTENT, without any answer text', 'passed': recordA !== null && recordA[ 'confirmed' ] === undefined && Array.isArray( recordA[ 'intent' ][ 'selected' ] ) === true && recordA[ 'intent' ][ 'selected' ].length > 0, 'detail': `${ drive[ 'questionA' ] } record ${ String( serializedA ).slice( 0, 120 ) }` } ),
        condition( { 'name': 'the answer text of B does NOT appear inside the record of A', 'passed': typeof answerTextB !== 'string' || answerTextB.length === 0 || String( serializedA ).includes( answerTextB ) !== true, 'detail': 'otherwise the store would treat both states alike and the separation would be an illusion' } ),
        condition( { 'name': 'the card count survives the restart', 'passed': after[ 'cardCount' ] === oracle[ 'open' ] && Number.parseInt( after[ 'qwRendered' ], 10 ) === oracle[ 'open' ], 'detail': `${ after[ 'cardCount' ] } cards, data-qw-rendered=${ after[ 'qwRendered' ] }, expected ${ oracle[ 'open' ] }` } ),
        condition( { 'name': 'no question is rendered twice', 'passed': duplicated.length === 0, 'detail': `${ duplicated.length } duplicated identifier(s): ${ duplicated.join( ', ' ) }` } ),
        condition( { 'name': 'the question-state route answers 200 with seen > 0 and skipped == 0', 'passed': stateResponse !== null && stateResponse[ 'code' ] === 200 && stateResponse[ 'payload' ] !== null && stateResponse[ 'payload' ][ 'seen' ] > 0 && stateResponse[ 'payload' ][ 'skipped' ] === 0, 'detail': `http ${ stateResponse === null ? 'n/a' : stateResponse[ 'code' ] }, seen ${ stateResponse === null || stateResponse[ 'payload' ] === null ? 'n/a' : stateResponse[ 'payload' ][ 'seen' ] }, skipped ${ stateResponse === null || stateResponse[ 'payload' ] === null ? 'n/a' : stateResponse[ 'payload' ][ 'skipped' ] }` } ),
        condition( { 'name': 'no reload loop in a fixed 30.0 s window', 'passed': restart[ 'navigationsInWindow' ] === 0, 'detail': `${ restart[ 'navigationsInWindow' ] } navigation(s) after the first load within ${ RELOAD_WINDOW_MS } ms` } ),
        condition( { 'name': 'VACUUM LATCH — the build handshake is DEFINED', 'passed': typeof after[ 'buildStamp' ] === 'string' && after[ 'buildStamp' ].length > 0, 'detail': `window.__MEMO_VIEW_BUILD__ = ${ after[ 'buildStamp' ] } — an undefined value would make the quiet loop quiet for the WRONG reason` } ),
        condition( { 'name': 'VACUUM LATCH — the three state classes are DISTINGUISHABLE', 'passed': recordA !== null && recordB !== null && JSON.stringify( recordA ) !== JSON.stringify( recordB ), 'detail': `confirmed / intent / untouched must differ; A and B ${ recordA !== null && recordB !== null && JSON.stringify( recordA ) !== JSON.stringify( recordB ) ? 'do' : 'do NOT' } differ` } ),
        condition( { 'name': 'no console error after the restart', 'passed': restart[ 'consoleErrors' ].length === 0, 'detail': `${ restart[ 'consoleErrors' ].length } console error(s): ${ restart[ 'consoleErrors' ].slice( 0, 3 ).join( ' // ' ) }` } )
    ]

    return judgeLink( {
        'id': 'K5',
        'compared': Object.keys( records ).length,
        'total': oracle[ 'open' ],
        conditions,
        'expected': { 'confirmed': 1, 'intent': 1, 'untouched': oracle[ 'open' ] - 2 },
        'measured': { 'records': Object.keys( records ).length, 'pidBefore': restart[ 'pidBefore' ], 'pidAfter': restart[ 'pidAfter' ], 'contextStamp': restart[ 'contextStamp' ] },
        'evidence': [ { 'recordA': recordA }, { 'recordB': recordB } ]
    } )
}


// The fingerprint a repeated read-only pass is compared on. It is the FULL per-link result reduced to
// the parts a second pass must reproduce — verdict, comparison set, measured figures and the pass/fail
// of every single condition. A counter alone would call two passes identical that agreed on HOW MANY
// conditions held and disagreed on WHICH, and saying so is the whole point of repeating at all.
const readOnlyFingerprint = ( { k1, k2 } ) => {
    const reduce = ( link ) => {
        return {
            'address': link[ 'id' ],
            'verdict': link[ 'verdict' ],
            'compared': link[ 'compared' ],
            'balance': link[ 'balance' ],
            'measured': link[ 'measured' ],
            'conditions': link[ 'conditions' ].map( ( entry ) => { return { 'name': entry[ 'name' ], 'passed': entry[ 'passed' ] } } )
        }
    }

    return [ reduce( k1 ), reduce( k2 ) ]
}


// ONE read-only pass: K1 and K2, nothing that writes. It is its own function because --repeat drives
// it N times and because K3 needs the main page left open exactly once — a repeated pass closes
// everything it opened.
const measureReadOnlyPass = async ( { context, origin, documentId, targets, oracles, mainLabel, mainOracle, positiveControlTarget, keepMainPage } ) => {
    const mainOpen = await openTarget( { context, origin, documentId, 'label': mainLabel, 'requireWidgets': true } )
    const mainSurface = await readQuestionSurface( { 'page': mainOpen[ 'page' ], documentId } )
    const stampK1 = await readContextStamp( { 'page': mainOpen[ 'page' ] } )

    const positive = await measurePositiveControl( {
        context,
        origin,
        'documentId': positiveControlTarget === null || positiveControlTarget === undefined ? null : positiveControlTarget[ 'documentId' ],
        'label': positiveControlTarget === null || positiveControlTarget === undefined ? null : positiveControlTarget[ 'label' ]
    } )

    const k1 = await measureDisplay( {
        'surface': mainSurface,
        'oracle': mainOracle,
        'consoleErrors': mainOpen[ 'consoleErrors' ],
        'failedRequests': mainOpen[ 'failedRequests' ],
        'positiveControl': positive
    } )

    const registryAnswer = await fetchJson( { 'url': `${ origin }/api/documents` } )
    const registryDoc = registryAnswer[ 'payload' ] === null
        ? null
        : ( registryAnswer[ 'payload' ][ 'documents' ] || [] ).find( ( doc ) => doc[ 'documentId' ] === documentId )
    const registryOpen = registryDoc === undefined || registryDoc === null || registryDoc[ 'questions' ] === undefined ? null : registryDoc[ 'questions' ][ 'open' ]
    const registryBasis = registryDoc === undefined || registryDoc === null || registryDoc[ 'questions' ] === undefined ? null : registryDoc[ 'questions' ][ 'basis' ]

    const perRevision = await targets
        .reduce( async ( carry, label ) => {
            const rows = await carry
            const oracle = oracles[ label ] === undefined ? null : oracles[ label ]

            if( oracle === null || oracle[ 'status' ] !== true ) {
                return rows.concat( [ { label, 'expectedOpen': null, 'popupMeasured': false, 'popupReason': 'no oracle' } ] )
            }

            const opened = label === mainLabel
                ? { 'page': mainOpen[ 'page' ] }
                : await openTarget( { context, origin, documentId, label, 'requireWidgets': oracle[ 'open' ] > 0 } )
            const surface = label === mainLabel ? mainSurface : await readQuestionSurface( { 'page': opened[ 'page' ], documentId } )
            const popup = await readPopup( { 'page': opened[ 'page' ] } )

            await closePopup( { 'page': opened[ 'page' ] } )

            if( label !== mainLabel ) { await opened[ 'page' ].close() }

            const divergenceExpected = registryBasis === true && registryOpen !== oracle[ 'open' ]
            const namesBoth = surface[ 'divergenceText' ] === null
                ? false
                : String( surface[ 'divergenceText' ] ).includes( String( registryOpen ) ) === true && String( surface[ 'divergenceText' ] ).includes( String( oracle[ 'open' ] ) ) === true

            return rows.concat( [ {
                label,
                'expectedOpen': oracle[ 'open' ],
                'schemaTotal': oracle[ 'total' ],
                'zone2Counted': surface[ 'zone2Counted' ] === null ? null : Number.parseInt( surface[ 'zone2Counted' ], 10 ),
                'zone2Text': surface[ 'zone2Text' ],
                'qmarkText': surface[ 'qmarkText' ],
                'qwRendered': surface[ 'qwRendered' ] === null ? null : Number.parseInt( surface[ 'qwRendered' ], 10 ),
                'cardCount': surface[ 'cardCount' ],
                'popupMeasured': popup[ 'measured' ],
                'popupReason': popup[ 'reason' ],
                'popupLabel': popup[ 'labelText' ] === undefined ? null : popup[ 'labelText' ],
                'popupAnswered': popup[ 'labelAnswered' ] === undefined ? null : popup[ 'labelAnswered' ],
                'popupTotal': popup[ 'labelTotal' ] === undefined ? null : popup[ 'labelTotal' ],
                'popupFields': popup[ 'fieldCount' ] === undefined ? null : popup[ 'fieldCount' ],
                'popupEmptyText': popup[ 'emptyText' ] === undefined ? null : popup[ 'emptyText' ],
                'sidebarPresent': surface[ 'sidebarPresent' ],
                'sidebarText': surface[ 'sidebarText' ],
                'sidebarBasis': surface[ 'sidebarBasis' ],
                'sidebarTitle': surface[ 'sidebarTitle' ],
                'divergenceExpected': divergenceExpected,
                'divergencePresent': surface[ 'divergencePresent' ],
                'divergenceText': surface[ 'divergenceText' ],
                'divergenceNamesBoth': namesBoth
            } ] )
        }, Promise.resolve( [] ) )

    const k2 = measureCounters( { perRevision, registryOpen, registryBasis } )

    if( keepMainPage !== true ) { await mainOpen[ 'page' ].close() }

    return { k1, k2, perRevision, registryOpen, registryBasis, 'stamp': stampK1[ 'stamp' ], 'mainOpen': keepMainPage === true ? mainOpen : null, 'positiveControl': positive }
}


// The public entry point a successor order imports. Object in, object out — never a bare boolean, and
// never a silent default: a missing origin or a missing oracle is a NAMED failure, because an absent
// comparison set would otherwise pass every assertion it does not make.
const runQuestionChainAcceptance = async ( { origin, documentId, targets, oracles, cloneDir, positiveControlTarget, browser, restartHook, repeats } ) => {
    const struct = {
        'status': false,
        'links': [],
        'balance': '0 / 5',
        'oneRun': { 'proven': false, 'stamps': {}, 'reason': null },
        'determinism': { 'status': null, 'identical': 0, 'total': 0, 'firstDifference': 'not reached' },
        'clone': cloneConsumedNotice( { 'reached': false } ),
        'timeline': [],
        'reason': null
    }

    if( typeof origin !== 'string' || origin.length === 0 ) {
        struct[ 'reason' ] = 'origin is missing — a run without a server is not a run'

        return struct
    }

    if( typeof documentId !== 'string' || documentId.length === 0 ) {
        struct[ 'reason' ] = 'documentId is missing — a run without a target is not a run'

        return struct
    }

    if( Array.isArray( targets ) !== true || targets.length === 0 ) {
        struct[ 'reason' ] = 'no target revision handed in — an empty target list is RED, never green'

        return struct
    }

    const mainLabel = targets[ 0 ]
    const mainOracle = oracles[ mainLabel ] === undefined ? null : oracles[ mainLabel ]

    if( mainOracle === null || mainOracle[ 'status' ] !== true ) {
        struct[ 'reason' ] = `the oracle for ${ mainLabel } could not be computed — without it every number below would be this fixture's own opinion`

        return struct
    }

    const context = await browser.newContext()

    await stampContext( { context } )

    const startedAt = Date.now()

    const mark = ( id ) => { struct[ 'timeline' ].push( { id, 'atMs': Date.now() - startedAt } ) }

    // --- K1 + K2 -------------------------------------------------------------------------------
    mark( 'K1-start' )

    const first = await measureReadOnlyPass( { context, origin, documentId, targets, oracles, mainLabel, mainOracle, positiveControlTarget, 'keepMainPage': true } )
    const mainOpen = first[ 'mainOpen' ]
    const stampK1 = { 'stamp': first[ 'stamp' ] }
    const k1 = first[ 'k1' ]
    const k2 = first[ 'k2' ]

    mark( 'K2-end' )

    // Determinism of the READING links (§ Ä1.7). K3 to K5 are excluded by construction: they write,
    // and repeating a write is not a repetition of the same measurement but a different second one.
    const wanted = Number.isInteger( repeats ) === true && repeats > 1 ? repeats : 1

    const extraPasses = await Array.from( { 'length': wanted - 1 } )
        .reduce( async ( carry ) => {
            const done = await carry
            const pass = await measureReadOnlyPass( { context, origin, documentId, targets, oracles, mainLabel, mainOracle, positiveControlTarget, 'keepMainPage': false } )

            return done.concat( [ readOnlyFingerprint( { 'k1': pass[ 'k1' ], 'k2': pass[ 'k2' ] } ) ] )
        }, Promise.resolve( [] ) )

    const fingerprints = [ readOnlyFingerprint( { k1, k2 } ) ].concat( extraPasses )

    struct[ 'determinism' ] = wanted === 1
        ? { 'status': null, 'identical': 1, 'total': 1, 'firstDifference': 'not exercised — --repeat was not given, so repeatability is UNMEASURED rather than passed' }
        : compareRuns( { 'runs': fingerprints } )

    mark( 'K2-repeat-end' )

    // --- K3 + K4 -------------------------------------------------------------------------------
    mark( 'K3-start' )

    const writeWatermark = Date.now()
    const drive = await driveConfirmationAndSubmit( { 'page': mainOpen[ 'page' ], 'oracle': mainOracle } )
    const stampK3 = await readContextStamp( { 'page': mainOpen[ 'page' ] } )
    const k3 = measureConfirmation( { drive, 'oracle': mainOracle } )

    mark( 'K3-end' )
    mark( 'K4-start' )

    const k4 = await measureSubmit( { drive, 'oracle': mainOracle, cloneDir, 'since': writeWatermark } )

    mark( 'K4-end' )

    struct[ 'clone' ] = cloneConsumedNotice( { 'reached': true } )

    await mainOpen[ 'page' ].close()
    await context.close()

    // --- K5 ------------------------------------------------------------------------------------
    mark( 'K5-start' )

    const restart = typeof restartHook === 'function'
        ? await restartHook( { browser, origin, documentId, 'label': mainLabel } )
        : null

    const k5 = await measureRestart( { restart, 'oracle': mainOracle, drive } )

    mark( 'K5-end' )

    struct[ 'links' ] = [ k1, k2, k3, k4, k5 ]

    const stamps = { 'K1': stampK1[ 'stamp' ], 'K3': stampK3[ 'stamp' ], 'K5': restart === null ? null : restart[ 'contextStamp' ] }
    const sameFirstFour = stampK1[ 'stamp' ] !== null && stampK1[ 'stamp' ] === stampK3[ 'stamp' ]
    const freshFifth = restart !== null && restart[ 'contextStamp' ] !== null && restart[ 'contextStamp' ] !== stampK1[ 'stamp' ]

    struct[ 'oneRun' ] = {
        'proven': sameFirstFour === true && freshFifth === true,
        stamps,
        'reason': sameFirstFour !== true
            ? 'K1 and K3/K4 did not report the same browser-context stamp — this was not ONE pass'
            : ( freshFifth !== true ? 'K5 did not report a NEW context stamp against a NEW server pid' : null )
    }

    const passed = struct[ 'links' ].filter( ( link ) => link[ 'verdict' ] === VERDICT[ 'pass' ] ).length

    struct[ 'balance' ] = chainBalance( { 'checked': passed, 'total': struct[ 'links' ].length } )[ 'line' ]
    struct[ 'status' ] = passed === struct[ 'links' ].length && struct[ 'oneRun' ][ 'proven' ] === true

    return struct
}


// ---------------------------------------------------------------------------------------------
// Command line.
// ---------------------------------------------------------------------------------------------


const printLine = ( { text } ) => { process.stdout.write( `${ text }\n` ) }


const germanVerdict = ( { verdict } ) => {
    return verdict === VERDICT[ 'inconclusive' ] ? 'UNBEWERTBAR' : verdict
}


const loadOracles = async ( { revisionFiles } ) => {
    const entries = await Promise.all( Object.keys( revisionFiles ).map( async ( label ) => {
        const file = revisionFiles[ label ]

        if( existsSync( file ) !== true ) {
            return [ label, { 'status': false, 'open': 0, 'total': 0, 'questions': [], 'reason': `revision file ${ file } does not exist — INCONCLUSIVE, never assumed` } ]
        }

        const content = await readFile( file, 'utf-8' ).catch( () => null )

        return [ label, openQuestionsFromContent( { content } ) ]
    } ) )

    return entries.reduce( ( acc, [ label, oracle ] ) => {
        acc[ label ] = oracle

        return acc
    }, {} )
}


const main = async () => {
    const { values } = parseArgs( {
        'args': process.argv.slice( 2 ),
        'options': {
            'origin': { 'type': 'string' },
            'document': { 'type': 'string' },
            'revision': { 'type': 'string', 'multiple': true },
            'revision-file': { 'type': 'string', 'multiple': true },
            'clone-dir': { 'type': 'string' },
            'control-document': { 'type': 'string' },
            'control-revision': { 'type': 'string' },
            'restart-command': { 'type': 'string' },
            'repeat': { 'type': 'string' },
            'force-blocked': { 'type': 'boolean', 'default': false }
        },
        'allowPositionals': false
    } )

    printLine( { 'text': '' } )
    printLine( { 'text': '  question-chain-acceptance — PRD-44 (Memo 081, Kap 19 / WI-065 + WI-063)' } )
    printLine( { 'text': '' } )

    const anchors = values[ 'force-blocked' ] === true ? [] : PLAYWRIGHT_ANCHORS
    const resolved = resolvePlaywright( { anchors } )

    if( resolved[ 'status' ] !== true ) {
        process.stderr.write( `  BLOCKED: ${ resolved[ 'reason' ] }\n\n` )
        process.exit( 1 )
    }

    printLine( { 'text': `  playwright resolved from : ${ resolved[ 'anchor' ] }` } )

    const origin = values[ 'origin' ] === undefined ? 'http://127.0.0.1:3333' : values[ 'origin' ]
    const labels = values[ 'revision' ] === undefined ? [] : values[ 'revision' ]
    const files = values[ 'revision-file' ] === undefined ? [] : values[ 'revision-file' ]

    if( labels.length === 0 || labels.length !== files.length ) {
        process.stderr.write( '  RED: --revision and --revision-file must be given in equal number — an oracle without a source is not an oracle\n\n' )
        process.exit( 1 )
    }

    const revisionFiles = labels.reduce( ( acc, label, index ) => {
        acc[ label ] = files[ index ]

        return acc
    }, {} )

    const oracles = await loadOracles( { revisionFiles } )

    labels.forEach( ( label ) => {
        const oracle = oracles[ label ]

        printLine( { 'text': `  oracle ${ label.padEnd( 18 ) }: found=${ oracle[ 'found' ] } total=${ oracle[ 'total' ] } open=${ oracle[ 'open' ] } withRecommendation=${ oracle[ 'withRecommendation' ] } withPreselection=${ oracle[ 'withPreselection' ] }${ oracle[ 'reason' ] === null ? '' : ` reason=${ oracle[ 'reason' ] }` }` } )
    } )

    const browser = await resolved[ 'playwright' ].chromium.launch( { 'headless': true } )

    const restartHook = values[ 'restart-command' ] === undefined ? null : buildRestartHook( { 'command': values[ 'restart-command' ], origin } )

    const result = await runQuestionChainAcceptance( {
        origin,
        'documentId': values[ 'document' ],
        'targets': labels,
        oracles,
        'cloneDir': values[ 'clone-dir' ],
        'positiveControlTarget': values[ 'control-document' ] === undefined
            ? null
            : { 'documentId': values[ 'control-document' ], 'label': values[ 'control-revision' ] },
        browser,
        restartHook,
        'repeats': values[ 'repeat' ] === undefined ? 1 : Number.parseInt( values[ 'repeat' ], 10 )
    } )

    await browser.close()

    printLine( { 'text': '' } )

    if( result[ 'reason' ] !== null ) {
        process.stderr.write( `  RED: ${ result[ 'reason' ] }\n\n` )
        process.exit( 1 )
    }

    result[ 'links' ]
        .forEach( ( link ) => {
            printLine( { 'text': `  ${ link[ 'id' ] } ${ germanVerdict( { 'verdict': link[ 'verdict' ] } ).padEnd( 13 ) } compared ${ link[ 'balance' ] }  consumesClone=${ link[ 'consumesClone' ] }` } )

            link[ 'conditions' ]
                .forEach( ( entry ) => printLine( { 'text': `       ${ entry[ 'passed' ] === true ? 'ok  ' : 'FAIL' } ${ entry[ 'name' ] } — ${ entry[ 'detail' ] }` } ) )

            if( link[ 'errorText' ] !== null ) { printLine( { 'text': `       FULL ERROR TEXT: ${ link[ 'errorText' ] }` } ) }
        } )

    printLine( { 'text': '' } )
    printLine( { 'text': `  one pass proven          : ${ result[ 'oneRun' ][ 'proven' ] } ${ result[ 'oneRun' ][ 'reason' ] === null ? '' : `(${ result[ 'oneRun' ][ 'reason' ] })` }` } )
    printLine( { 'text': `  context stamps           : ${ JSON.stringify( result[ 'oneRun' ][ 'stamps' ] ) }` } )
    printLine( { 'text': `  timeline                 : ${ result[ 'timeline' ].map( ( entry ) => `${ entry[ 'id' ] }@${ entry[ 'atMs' ] }ms` ).join( ' ' ) }` } )
    printLine( { 'text': `  determinism (K1/K2 only) : ${ result[ 'determinism' ][ 'identical' ] } / ${ result[ 'determinism' ][ 'total' ] } identical read-only passes${ result[ 'determinism' ][ 'firstDifference' ] === null ? '' : ` — ${ result[ 'determinism' ][ 'firstDifference' ] }` }` } )
    printLine( { 'text': `  clone                    : ${ result[ 'clone' ][ 'text' ] }` } )
    printLine( { 'text': `  balance                  : ${ result[ 'balance' ] } links PASS` } )
    printLine( { 'text': `  VERDICT                  : ${ result[ 'status' ] === true ? 'PASS' : 'FAIL' }` } )
    printLine( { 'text': '' } )

    process.stdout.write( `${ JSON.stringify( result, null, 2 ) }\n` )

    process.exit( result[ 'status' ] === true ? 0 : 1 )
}


// The restart hook is built here and not inside the runner, so the runner stays free of process
// control and the unit cases can drive it with a stub. It is deliberately the ONLY place that stops
// anything.
const buildRestartHook = ( { command, origin } ) => {
    return async ( { browser, documentId, label } ) => {
        const struct = { 'performed': false, 'reason': null, 'pidBefore': null, 'pidAfter': null, 'deathVerified': false, 'contextStamp': null, 'surface': null, 'questionState': null, 'navigationsInWindow': 0, 'consoleErrors': [] }

        const before = await fetchJson( { 'url': `${ origin }/api/health` } )

        struct[ 'pidBefore' ] = before[ 'payload' ] === null ? null : before[ 'payload' ][ 'pid' ]

        const { spawn } = await import( 'node:child_process' )

        const ran = await new Promise( ( done ) => {
            const child = spawn( command, { 'shell': true, 'stdio': 'ignore', 'detached': false } )

            child.on( 'error', ( error ) => done( { 'ok': false, 'reason': String( error[ 'message' ] ) } ) )
            child.on( 'exit', ( code ) => done( { 'ok': code === 0, 'reason': `restart command exited with ${ code }` } ) )
        } )

        if( ran[ 'ok' ] !== true ) {
            struct[ 'reason' ] = ran[ 'reason' ]

            return struct
        }

        const after = await fetchJson( { 'url': `${ origin }/api/health` } )

        struct[ 'pidAfter' ] = after[ 'payload' ] === null ? null : after[ 'payload' ][ 'pid' ]
        struct[ 'deathVerified' ] = struct[ 'pidBefore' ] !== null && struct[ 'pidAfter' ] !== null && struct[ 'pidBefore' ] !== struct[ 'pidAfter' ]

        if( struct[ 'deathVerified' ] !== true ) {
            struct[ 'reason' ] = `the server did not change process: pid ${ struct[ 'pidBefore' ] } -> ${ struct[ 'pidAfter' ] }`

            return struct
        }

        const context = await browser.newContext()
        const { stamp } = await stampContext( { context } )

        struct[ 'contextStamp' ] = stamp

        const opened = await openTarget( { context, origin, documentId, label, 'requireWidgets': true } )
        const firstLoadAt = Date.now()

        struct[ 'surface' ] = await readQuestionSurface( { 'page': opened[ 'page' ], documentId } )
        struct[ 'questionState' ] = await fetchJson( { 'url': `${ origin }/api/documents/${ encodeURIComponent( documentId ) }/question-state?revisionId=${ encodeURIComponent( label ) }` } )

        await opened[ 'page' ].waitForTimeout( RELOAD_WINDOW_MS )

        struct[ 'navigationsInWindow' ] = opened[ 'navigations' ].filter( ( at ) => at > firstLoadAt + 1500 ).length
        struct[ 'consoleErrors' ] = opened[ 'consoleErrors' ]
        struct[ 'performed' ] = true

        await opened[ 'page' ].close()
        await context.close()

        return struct
    }
}


// The module stays importable: a successor order imports runQuestionChainAcceptance and never the
// command-line shell. Same is-main guard the rest of the repo uses.
if( process.argv[ 1 ] !== undefined && import.meta.url === new URL( `file://${ process.argv[ 1 ] }` ).href ) {
    await main()
}


export {
    runQuestionChainAcceptance,
    openQuestionsFromContent,
    cascadeStageOf,
    judgeLink,
    condition,
    chainBalance,
    consumesCloneOf,
    cloneConsumedNotice,
    normalizeSpace,
    readOnlyFingerprint,
    measureReadOnlyPass,
    measureDisplay,
    measureSubmit,
    measureCounters,
    measureConfirmation,
    measureRestart,
    buildRestartHook,
    VERDICT,
    CHAIN_LINKS
}
