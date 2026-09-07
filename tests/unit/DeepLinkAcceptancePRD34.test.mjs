import { describe, it, expect } from '@jest/globals'

import {
    runDeepLinkAcceptance,
    deriveTargets,
    labelFormOf,
    formatBalance,
    compareRuns,
    deepLinkPathFor,
    resolvePlaywright
} from '../manual/deep-link-acceptance.mjs'


// PRD-34 (Memo 081, Kap 29 / WI-067) — the acceptance fixture gets an acceptance of its own.
//
// WHY THIS FILE EXISTS. tests/manual/** does not match jest's testMatch, so it does NOT run under
// `npm test` (measured: jest.config.mjs carries only testPathIgnorePatterns). That is what keeps a
// browser harness out of CI — and it is also what would leave the fixture with NOTHING protecting it
// from decay. These cases pin the fixture's PURE parts: no browser, no server, no port.
//
// Every case states HOW MUCH it compared. The heart of it is T-B/T-E/T-F: they check the VACUUM
// GUARDS themselves. A fixture whose guards are merely asserted in prose is a fixture whose guards
// are untested — and a guard that has never been seen to fire is not a guard.
//
// REPO BOUNDARY: nothing outside this repository is read, nothing is written, no port is bound.


// A stand-in browser for T-D. It is deliberately a full stub of the four calls measureOneTarget makes
// — newContext / newPage / goto / evaluate — because a two-sided verdict needs a run that genuinely
// FAILS as well as one that genuinely PASSES, and a fake that can only succeed would be exactly the
// blind assertion the positive control in the fixture exists to catch.
const fakeBrowser = ( { httpCode, frameFileName, contentLength, title } ) => {
    return {
        newContext: async () => {
            return {
                newPage: async () => {
                    const socketHandlers = []

                    return {
                        on: ( event, handler ) => {
                            if( event === 'websocket' ) { socketHandlers.push( handler ) }
                        },
                        goto: async () => {
                            socketHandlers.forEach( ( handler ) => {
                                handler( {
                                    on: ( frameEvent, frameHandler ) => {
                                        if( frameEvent !== 'framereceived' ) { return }
                                        if( frameFileName === null ) { return }

                                        frameHandler( { 'payload': JSON.stringify( { 'type': 'content', 'fileName': frameFileName, 'documentId': 'doc-a', 'questionSchema': [] } ) } )
                                    }
                                } )
                            } )

                            return { status: () => httpCode }
                        },
                        waitForFunction: async () => {
                            if( contentLength > 40 ) { return true }

                            throw new Error( 'timeout' )
                        },
                        evaluate: async () => {
                            return { 'title': title, 'contentLength': contentLength, 'activeRev': null, 'path': '/doc/x' }
                        }
                    }
                },
                close: async () => { return true }
            }
        }
    }
}


const stock = [
    { 'documentId': 'doc-a', 'memoName': '900-a', 'revisions': [ { 'fileName': 'REV-01.md' }, { 'fileName': 'REV-01-prepare.md' }, { 'fileName': 'REV-02-update.md' }, { 'fileName': 'v0.4.md' } ] },
    { 'documentId': 'doc-b', 'memoName': '901-b', 'revisions': [ { 'fileName': 'REV-03.md' }, { 'fileName': 'REV-03-prepare.md' } ] },
    { 'documentId': 'doc-c', 'memoName': '902-c', 'revisions': [] }
]


describe( 'PRD-34 T-A — target derivation from the stock, all label forms covered', () => {

    it( 'derives (documentId, label) pairs and reports each form with its count', () => {
        const derived = deriveTargets( { 'documents': stock, 'perForm': 6 } )

        // Compared: 3 documents, 6 revisions, 4 label forms.
        expect( derived[ 'status' ] ).toBe( true )
        expect( derived[ 'documentsRead' ] ).toBe( 3 )
        expect( derived[ 'revisionsRead' ] ).toBe( 6 )
        expect( derived[ 'formCounts' ] ).toEqual( { 'REV-NN': 2, 'prepare': 2, 'update': 1, 'other': 1 } )
        expect( derived[ 'missingForms' ] ).toEqual( [] )
        expect( derived[ 'targets' ].length ).toBe( 6 )

        const addresses = derived[ 'targets' ].map( ( target ) => `${ target[ 'documentId' ] }/${ target[ 'label' ] }` )

        expect( addresses ).toEqual( [ 'doc-a/REV-01', 'doc-b/REV-03', 'doc-a/REV-01-prepare', 'doc-b/REV-03-prepare', 'doc-a/REV-02-update', 'doc-a/v0.4' ] )
    } )


    it( 'names a missing label form instead of quietly expecting it', () => {
        const derived = deriveTargets( { 'documents': [ stock[ 1 ] ], 'perForm': 6 } )

        // Compared: 1 document, 2 revisions, 4 label forms — 2 of them absent.
        expect( derived[ 'status' ] ).toBe( true )
        expect( derived[ 'missingForms' ] ).toEqual( [ 'update', 'other' ] )
        expect( derived[ 'formCounts' ][ 'update' ] ).toBe( 0 )
    } )


    it( 'derives the SAME list twice from the same stock — determinism starts before the browser', () => {
        const first = deriveTargets( { 'documents': stock, 'perForm': 3 } )
        const second = deriveTargets( { 'documents': [ stock[ 2 ], stock[ 1 ], stock[ 0 ] ], 'perForm': 3 } )

        // Compared: 2 derivations over the same 3 documents in DIFFERENT input order.
        expect( JSON.stringify( first[ 'targets' ] ) ).toBe( JSON.stringify( second[ 'targets' ] ) )
    } )


    it( 'classifies every label form and refuses a name that is not a revision file', () => {
        const measured = [ 'REV-16.md', 'REV-06-update.md', 'REV-02-prepare.md', 'v0.4.md', 'REV-16', '', '.md' ]
            .map( ( fileName ) => labelFormOf( { fileName } )[ 'form' ] )

        // Compared: 7 names, 4 valid forms plus 3 rejects.
        expect( measured ).toEqual( [ 'REV-NN', 'update', 'prepare', 'other', 'other', 'other', 'other' ] )
        expect( labelFormOf( { 'fileName': 'REV-16' } )[ 'label' ] ).toBe( null )
        expect( labelFormOf( { 'fileName': 'REV-16.md' } )[ 'label' ] ).toBe( 'REV-16' )
    } )


    it( 'builds both address forms and encodes the segments', () => {
        // Compared: 3 addresses — long form, short form, and one carrying a reserved character.
        expect( deepLinkPathFor( { 'documentId': 'a--b', 'label': 'REV-16' } )[ 'path' ] ).toBe( '/doc/a--b/REV-16' )
        expect( deepLinkPathFor( { 'documentId': 'a--b', 'label': null } )[ 'path' ] ).toBe( '/doc/a--b' )
        expect( deepLinkPathFor( { 'documentId': 'a/b', 'label': 'x y' } )[ 'path' ] ).toBe( '/doc/a%2Fb/x%20y' )
    } )

} )


describe( 'PRD-34 T-B — the vacuum guard itself, not the claim that it exists', () => {

    it( 'an empty target set is a named failure, never a green empty run', async () => {
        const result = await runDeepLinkAcceptance( { 'origin': 'http://localhost:1', 'targets': [], 'repeats': 5, 'browser': {} } )

        // Compared: 1 run over 0 targets.
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'total' ] ).toBe( 0 )
        expect( result[ 'reason' ] ).toContain( '0 targets' )
    } )


    it( 'a stock with no revision at all yields 0 targets and says why', () => {
        const derived = deriveTargets( { 'documents': [ stock[ 2 ] ], 'perForm': 6 } )

        // Compared: 1 document, 0 revisions.
        expect( derived[ 'status' ] ).toBe( false )
        expect( derived[ 'targets' ].length ).toBe( 0 )
        expect( derived[ 'reason' ] ).toContain( 'no target could be derived' )
    } )


    it( 'a missing browser is BLOCKED, not a skipped run that reports success', async () => {
        const result = await runDeepLinkAcceptance( { 'origin': 'http://localhost:1', 'targets': [ { 'documentId': 'doc-a', 'label': 'REV-01' } ], 'repeats': 2, 'browser': null } )

        // Compared: 1 run with 1 target and no browser.
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'reason' ] ).toContain( 'BLOCKED' )
    } )


    it( 'an empty anchor list resolves to BLOCKED with a named reason', () => {
        const blocked = resolvePlaywright( { 'anchors': [] } )
        const alsoBlocked = resolvePlaywright( { 'anchors': [ '/does/not/exist/package.json' ] } )

        // Compared: 2 anchor lists, both unresolvable — the two ways this can fail.
        expect( blocked[ 'status' ] ).toBe( false )
        expect( blocked[ 'reason' ] ).toContain( 'no anchor' )
        expect( alsoBlocked[ 'status' ] ).toBe( false )
        expect( alsoBlocked[ 'reason' ] ).toContain( 'not resolvable' )
    } )

} )


describe( 'PRD-34 T-C — the balance line carries its comparison set in every case', () => {

    it( 'formats <checked> / <total> for the normal, the empty and the broken case', () => {
        // Compared: 3 balance calls, one of them with values that are not numbers at all.
        expect( formatBalance( { 'checked': 24, 'total': 24 } )[ 'line' ] ).toBe( '24 / 24' )
        expect( formatBalance( { 'checked': 0, 'total': 0 } )[ 'line' ] ).toBe( '0 / 0' )
        expect( formatBalance( { 'checked': undefined, 'total': null } )[ 'line' ] ).toBe( '0 / 0' )
    } )


    it( 'the failing empty run still carries a balance line', async () => {
        const result = await runDeepLinkAcceptance( { 'origin': 'http://localhost:1', 'targets': [], 'repeats': 5, 'browser': {} } )

        // Compared: 1 failing run — the balance must exist precisely where the verdict is red.
        expect( result[ 'balance' ] ).toBe( '0 / 0' )
        expect( result[ 'balance' ] ).toMatch( /^\d+ \/ \d+$/ )
    } )

} )


describe( 'PRD-34 T-D — the verdict is two-sided against a real code path', () => {

    const targets = [ { 'documentId': 'doc-a', 'memoName': '900-a', 'label': 'REV-01', 'form': 'REV-NN' } ]


    it( 'a reachable target that shows the NAMED revision passes', async () => {
        const browser = fakeBrowser( { 'httpCode': 200, 'frameFileName': 'REV-01.md', 'contentLength': 500, 'title': '900-a' } )
        const result = await runDeepLinkAcceptance( { 'origin': 'http://x', targets, 'repeats': 3, browser } )

        // Compared: 3 runs over 1 target.
        expect( result[ 'balance' ] ).toBe( '1 / 1' )
        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'perTarget' ][ 0 ][ 'frameFileName' ] ).toBe( 'REV-01.md' )
    } )


    it( 'a target that opens a DIFFERENT revision fails — 200 alone is not an acceptance', async () => {
        const browser = fakeBrowser( { 'httpCode': 200, 'frameFileName': 'REV-99.md', 'contentLength': 500, 'title': '900-a' } )
        const result = await runDeepLinkAcceptance( { 'origin': 'http://x', targets, 'repeats': 3, browser } )

        // Compared: 3 runs over 1 target, served with the wrong revision.
        expect( result[ 'balance' ] ).toBe( '0 / 1' )
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'perTarget' ][ 0 ][ 'expectedFileName' ] ).toBe( 'REV-01.md' )
    } )


    it( 'a 200 with an empty page fails — a green transport over a dead surface is not green', async () => {
        const browser = fakeBrowser( { 'httpCode': 200, 'frameFileName': 'REV-01.md', 'contentLength': 3, 'title': '900-a' } )
        const result = await runDeepLinkAcceptance( { 'origin': 'http://x', targets, 'repeats': 2, browser } )

        // Compared: 2 runs over 1 target that renders nothing.
        expect( result[ 'balance' ] ).toBe( '0 / 1' )
        expect( result[ 'perTarget' ][ 0 ][ 'rendered' ] ).toBe( false )
    } )


    it( 'a 404 fails, and a socket that never delivers content fails', async () => {
        const notFound = await runDeepLinkAcceptance( { 'origin': 'http://x', targets, 'repeats': 2, 'browser': fakeBrowser( { 'httpCode': 404, 'frameFileName': null, 'contentLength': 0, 'title': null } ) } )
        const silent = await runDeepLinkAcceptance( { 'origin': 'http://x', targets, 'repeats': 2, 'browser': fakeBrowser( { 'httpCode': 200, 'frameFileName': null, 'contentLength': 500, 'title': '900-a' } ) } )

        // Compared: 2 runs each over 1 target — one refused by HTTP, one silent on the socket.
        expect( notFound[ 'balance' ] ).toBe( '0 / 1' )
        expect( notFound[ 'perTarget' ][ 0 ][ 'httpCode' ] ).toBe( 404 )
        expect( silent[ 'balance' ] ).toBe( '0 / 1' )
        expect( silent[ 'perTarget' ][ 0 ][ 'frameFileName' ] ).toBe( null )
    } )

} )


describe( 'PRD-34 T-E — the determinism comparator has its own positive control', () => {

    it( 'reports deterministic:false for two DIFFERENT result objects and names the difference', () => {
        const compared = compareRuns( { 'runs': [
            [ { 'address': '/doc/a/REV-01', 'passed': true } ],
            [ { 'address': '/doc/a/REV-01', 'passed': false } ]
        ] } )

        // Compared: 2 runs over 1 target with differing verdicts.
        expect( compared[ 'status' ] ).toBe( false )
        expect( compared[ 'identical' ] ).toBe( 1 )
        expect( compared[ 'total' ] ).toBe( 2 )
        expect( compared[ 'firstDifference' ] ).toContain( '/doc/a/REV-01' )
    } )


    it( 'the same hit COUNT with different HITS is not identical', () => {
        const compared = compareRuns( { 'runs': [
            [ { 'address': '/doc/a/REV-01', 'passed': true }, { 'address': '/doc/b/REV-02', 'passed': false } ],
            [ { 'address': '/doc/a/REV-01', 'passed': false }, { 'address': '/doc/b/REV-02', 'passed': true } ]
        ] } )

        // Compared: 2 runs over 2 targets, both scoring 1 of 2 — the counter agrees, the runs do not.
        expect( compared[ 'status' ] ).toBe( false )
        expect( compared[ 'identical' ] ).toBe( 1 )
    } )


    it( 'reports deterministic:true only for N > 1 identical runs — N = 1 proves nothing', () => {
        const five = compareRuns( { 'runs': Array.from( { 'length': 5 } ).map( () => [ { 'address': '/doc/a/REV-01', 'passed': true } ] ) } )
        const one = compareRuns( { 'runs': [ [ { 'address': '/doc/a/REV-01', 'passed': true } ] ] } )
        const none = compareRuns( { 'runs': [] } )

        // Compared: 3 comparator calls with 5, 1 and 0 runs.
        expect( five[ 'status' ] ).toBe( true )
        expect( five[ 'identical' ] ).toBe( 5 )
        expect( one[ 'status' ] ).toBe( false )
        expect( one[ 'firstDifference' ] ).toContain( 'N = 1' )
        expect( none[ 'status' ] ).toBe( false )
        expect( none[ 'firstDifference' ] ).toContain( 'no run to compare' )
    } )

} )


describe( 'PRD-34 T-F — no silent defaults', () => {

    it( 'a missing targets argument is a named error, not an empty list that passes', async () => {
        const result = await runDeepLinkAcceptance( { 'origin': 'http://x', 'repeats': 5, 'browser': {} } )

        // Compared: 1 call with the target list absent entirely.
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'reason' ] ).toContain( 'targets is missing' )
    } )


    it( 'a missing origin is a named error', async () => {
        const result = await runDeepLinkAcceptance( { 'targets': [], 'repeats': 5, 'browser': {} } )

        // Compared: 1 call with no origin.
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'reason' ] ).toContain( 'origin is missing' )
    } )


    it( 'a stock that is not an array is a named error, never 0 targets that pass', () => {
        const derived = deriveTargets( { 'documents': null, 'perForm': 6 } )

        // Compared: 1 derivation over a stock that does not exist.
        expect( derived[ 'status' ] ).toBe( false )
        expect( derived[ 'documentsRead' ] ).toBe( 0 )
        expect( derived[ 'reason' ] ).toContain( 'not an array' )
    } )


    it( 'the returned value is an OBJECT with the documented keys, never a bare boolean', async () => {
        const result = await runDeepLinkAcceptance( {
            'origin': 'http://x',
            'targets': [ { 'documentId': 'doc-a', 'memoName': '900-a', 'label': 'REV-01', 'form': 'REV-NN' } ],
            'repeats': 2,
            'browser': fakeBrowser( { 'httpCode': 200, 'frameFileName': 'REV-01.md', 'contentLength': 500, 'title': '900-a' } )
        } )

        // Compared: 8 documented keys against the returned object.
        expect( typeof result ).toBe( 'object' )
        expect( Object.keys( result ) ).toEqual( expect.arrayContaining( [ 'status', 'checked', 'total', 'perTarget', 'negativeControl', 'positiveControl', 'deterministic', 'runs' ] ) )
    } )

} )
