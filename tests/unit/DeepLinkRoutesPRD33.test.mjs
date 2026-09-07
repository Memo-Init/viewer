import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-33 (Memo 081, Kap 29 / WI-066) — one address per document and per revision, and the address wins.
//
// Every case states HOW MUCH it compared. A check that finds nothing to compare is RED or UNJUDGEABLE,
// never green (lesson deterministic-gates-can-be-vacuum-green): a dead page also reports 0.
//
// The live half runs against a REAL server in a CHILD PROCESS. Two reasons, both deliberate:
//   * a route that only exists in a mock proves the mock. The 404 measured before this PRD was a real
//     404 over the wire, so the 200 after it has to be one too.
//   * MemoView.startServer keeps a listening socket and process-wide shutdown handlers with no public
//     close. Booting it inside the Jest worker would leave an open handle behind; a child process
//     releases the port by exiting.
// REPO BOUNDARY: nothing outside this repository is read or written. The registry the child serves is
// built from a THROWAWAY tree under .test-tmp/ (gitignored), never from the real .memo/ stock — CI
// checks out this repo alone, and a test reaching past it once tore 31 cases here (M080/PRD-V4).
const here = dirname( fileURLToPath( import.meta.url ) )
const repoRoot = resolve( here, '..', '..' )
const memoViewPath = resolve( repoRoot, 'src', 'MemoView.mjs' )
const clientPath = resolve( repoRoot, 'src', 'public', 'app.client.mjs' )
const runFile = promisify( execFile )

// A port outside the project's inventory (3333/4444/5555/6666/7777/8888) and outside the range this
// rollout measures by hand (3391). The child probes it and reports a collision instead of guessing.
const CHILD_PORT = 47933


describe( 'PRD-33 — parseDeepLinkPath: die Form, nicht die Existenz (rein, ohne Server)', () => {

    it( 'T-A: erkennt alle vier gemessenen Label-Formen und die kurze Form ohne Label', () => {
        // Vergleichsmenge: 5 Adressen — vier Label-Formen (REV-NN, -prepare, -update, vN.M, gemessen
        // ueber 2385 registrierte Revisionen) plus die kurze Form. Der Parser setzt am DATEINAMEN an,
        // nicht an einer Typ-Liste, deshalb deckt er auch die vierte Form, die das Memo nicht nennt.
        const cases = [
            { 'pathname': '/doc/memo-init--081-x/REV-16', 'fileName': 'REV-16.md' },
            { 'pathname': '/doc/memo-init--081-x/REV-06-update', 'fileName': 'REV-06-update.md' },
            { 'pathname': '/doc/memo-init--081-x/REV-02-prepare', 'fileName': 'REV-02-prepare.md' },
            { 'pathname': '/doc/memo-init--081-x/v0.4', 'fileName': 'v0.4.md' },
            { 'pathname': '/doc/memo-init--081-x', 'fileName': null }
        ]

        expect( cases.length ).toBe( 5 )

        const parsed = cases
            .map( ( entry ) => {
                const out = MemoView.parseDeepLinkPath( { 'pathname': entry[ 'pathname' ] } )

                return { 'expected': entry, 'out': out }
            } )

        parsed
            .forEach( ( { expected, out } ) => {
                expect( out[ 'status' ] ).toBe( true )
                expect( out[ 'documentId' ] ).toBe( 'memo-init--081-x' )
                expect( out[ 'fileName' ] ).toBe( expected[ 'fileName' ] )
            } )
    } )


    it( 'T-A: eine prozent-kodierte Kennung wird dekodiert, nicht durchgereicht', () => {
        const out = MemoView.parseDeepLinkPath( { 'pathname': '/doc/proj%2D%2Dmemo%20eins/REV-01' } )

        expect( out[ 'status' ] ).toBe( true )
        expect( out[ 'documentId' ] ).toBe( 'proj--memo eins' )
        expect( out[ 'fileName' ] ).toBe( 'REV-01.md' )
    } )


    it( 'T-B: verweigert 9 missgebildete Formen — je { status: false }, kein Wurf', () => {
        // Vergleichsmenge: 9 Formen. Jede einzeln aufgefuehrt, damit sichtbar bleibt, WAS geprueft wurde.
        const rejected = [
            '/doc/',
            '/doc//REV-01',
            '/doc/a/REV-01/zuviel',
            '/doc/../REV-01',
            '/doc/a/..',
            '/doc/a/%E0%A4%A',
            '/docs/a/REV-01',
            '/doc',
            '/memos'
        ]

        expect( rejected.length ).toBe( 9 )

        const outcomes = rejected
            .map( ( pathname ) => {
                return { pathname, 'out': MemoView.parseDeepLinkPath( { pathname } ) }
            } )

        outcomes
            .forEach( ( { pathname, out } ) => {
                expect( { pathname, 'status': out[ 'status' ] } ).toEqual( { pathname, 'status': false } )
                expect( out[ 'documentId' ] ).toBe( null )
                expect( out[ 'fileName' ] ).toBe( null )
            } )
    } )


    it( 'T-B: ein kodierter Schraegstrich schmuggelt kein Pfadtrennzeichen in ein Segment', () => {
        const out = MemoView.parseDeepLinkPath( { 'pathname': '/doc/a%2F..%2Fb/REV-01' } )

        expect( out[ 'status' ] ).toBe( false )
    } )


    it( 'T-B: nicht-Zeichenketten sind ein Ergebnis, kein Wurf', () => {
        const shapes = [ undefined, null, 42, {} ]

        expect( shapes.length ).toBe( 4 )

        shapes
            .forEach( ( pathname ) => {
                expect( MemoView.parseDeepLinkPath( { pathname } )[ 'status' ] ).toBe( false )
            } )
    } )
} )


describe( 'PRD-33 — Quelltext-Anker (T-J, T-K)', () => {
    let serverSource = ''
    let clientSource = ''


    beforeAll( async () => {
        serverSource = await readFile( memoViewPath, 'utf8' )
        clientSource = await readFile( clientPath, 'utf8' )
    } )


    it( 'T-J: genau EIN Adress-Bauer im Client, und er beginnt mit dem Routen-Praefix', () => {
        const builders = clientSource.match( /function docPathFor\(/g ) || []

        expect( builders.length ).toBe( 1 )
        expect( clientSource ).toContain( "'/doc/' + encodeURIComponent(" )
    } )


    it( 'T-J: genau EIN Adress-Leser im Client (kein zweiter Ad-hoc-split)', () => {
        const parsers = clientSource.match( /function parseDocPath\(/g ) || []

        expect( parsers.length ).toBe( 1 )
    } )


    it( 'T-J: drei Markup-Stellen der Seitenleiste erzeugen eine Dokument-Adresse', () => {
        // Vergleichsmenge, zwei Mengen ausgewiesen statt einer weggedefinierten:
        //   5 Vorkommen von docPathFor( insgesamt = 1 Definition + 1 pushState-Aufruf + 3 Markup,
        //   davon 3 im Markup (das Muster href="' + escapeAttr( docPathFor( ).
        // Gezaehlt wird die Markup-Menge; die Gesamtmenge steht daneben, damit die Differenz sichtbar
        // ist und nicht behauptet wird.
        const all = clientSource.match( /docPathFor\( /g ) || []
        const inMarkup = clientSource.match( /href="' \+ escapeAttr\( docPathFor\( /g ) || []

        expect( all.length ).toBe( 5 )
        expect( inMarkup.length ).toBe( 3 )
    } )


    it( 'T-J: der Klick-Handler verhindert nur den einfachen Linksklick', () => {
        expect( clientSource ).toContain( 'function isPlainLeftClick( ev )' )
        expect( clientSource ).toMatch( /ev\.metaKey/ )
        expect( clientSource ).toMatch( /ev\.ctrlKey/ )
        expect( clientSource ).toMatch( /ev\.shiftKey/ )
        expect( clientSource ).toMatch( /ev\.altKey/ )
        expect( clientSource ).toContain( 'ev.preventDefault()' )
    } )


    it( 'T-K: die Loopback-Bindung ist unveraendert — 1 Konstante + 2 listen-Aufrufe', () => {
        // Vergleichsmenge: 3 Quelltextstellen. Die Route-Erweiterung ist genau die Stelle, an der eine
        // Bindung "aus Versehen" aufgeweitet wird, deshalb wird sie gezaehlt statt zugesichert.
        const constant = serverSource.match( /const BIND_HOST = '127\.0\.0\.1'/g ) || []
        const listens = serverSource.match( /server\.listen\( portNumber, BIND_HOST/g ) || []

        expect( constant.length ).toBe( 1 )
        expect( listens.length ).toBe( 2 )
    } )


    it( 'T-K: die SPA-Weiche bleibt eine Aufzaehlung von Gleichheiten (kein Praefix-Match)', () => {
        // DbTablesRoutePRDV1 prueft die Teilzeichenkette url === '/dbtables' am Quelltext — sie muss
        // woertlich stehen bleiben. /transcripts tritt der Aufzaehlung bei (Ä3), OHNE Schraegstrich,
        // damit die frueher greifende Transcript-Route /transcripts/{id} unberuehrt bleibt.
        expect( serverSource ).toContain( "url === '/dbtables'" )
        expect( serverSource ).toContain( "url === '/transcripts'" )
        expect( serverSource ).not.toMatch( /isSpaRoute = .*startsWith\( '\/memos'/ )
    } )
} )


describe( 'PRD-33 — am LAUFENDEN Server: Route, Rangfolge, Negativ-Kontrollen', () => {
    let sandbox = ''
    let report = null
    let control = null
    let blocker = null


    // Build one throwaway project tree and boot ONE child server against it. Returns the child's JSON
    // report, or a blocker string when it produced no result block.
    const measure = async ( { name, port, mode, memos } ) => {
        const root = join( sandbox, name )
        const project = join( root, 'proj' )

        await Promise.all(
            memos.map( async ( memo ) => {
                const revisions = join( project, '.memo', 'memos', memo[ 'dir' ], 'revisions' )
                await mkdir( revisions, { 'recursive': true } )

                await Promise.all(
                    memo[ 'files' ].map( ( fileName ) => writeFile( join( revisions, fileName ), `# ${ memo[ 'dir' ] } ${ fileName }\n`, 'utf8' ) )
                )
            } )
        )

        // The session config is the SINGLE gate for the namespace tree — pointing the child at a
        // throwaway one is what keeps the real 385-document stock out of this test.
        const configPath = join( root, '.sessions', 'config.json' )
        await mkdir( join( root, '.sessions' ), { 'recursive': true } )
        await writeFile( configPath, JSON.stringify( { 'projects': [ { 'projectId': 'proj', 'projectRoot': project } ] }, null, 4 ), 'utf8' )
        await writeFile( join( root, 'harness.mjs' ), harnessSource, 'utf8' )

        const answered = await runFile(
            process.execPath,
            [ join( root, 'harness.mjs' ) ],
            {
                'cwd': root,
                'maxBuffer': 32 * 1024 * 1024,
                'env': {
                    ...process.env,
                    'MEMOVIEW_NO_BROWSER': '1',
                    'MEMOVIEW_SESSION_CONFIG': configPath,
                    'PRD33_PORT': String( port ),
                    'PRD33_MODE': mode,
                    'PRD33_SRC': memoViewPath
                }
            }
        ).catch( ( error ) => {
            return { 'stdout': error[ 'stdout' ] === undefined ? '' : error[ 'stdout' ], 'stderr': error[ 'stderr' ] === undefined ? '' : error[ 'stderr' ] }
        } )

        const marked = String( answered[ 'stdout' ] ).split( '###PRD33###' )

        if( marked.length !== 3 ) {
            return { 'result': null, 'blocker': `${ name }: kein Ergebnisblock — stderr: ${ String( answered[ 'stderr' ] ).slice( -600 ) }` }
        }

        return { 'result': JSON.parse( marked[ 1 ] ), 'blocker': null }
    }


    beforeAll( async () => {
        await mkdir( join( repoRoot, '.test-tmp' ), { 'recursive': true } )
        sandbox = await mkdtemp( join( repoRoot, '.test-tmp', 'deeplink-prd33-' ) )

        // Bestand A, gemischt. `proj` becomes the projectId (folder name), the memo folder name becomes
        // the memoName, so documentId = proj--<memo folder>.
        //   001-alpha  — three REV label shapes
        //   002-beta   — the deep-link target, incl. the fourth (vN.M) shape
        //   003-leer   — a registered document with ZERO revisions (7 of 385 in the real stock)
        const mixed = await measure( {
            'name': 'mixed',
            'port': CHILD_PORT,
            'mode': 'main',
            'memos': [
                { 'dir': '001-alpha', 'files': [ 'REV-02.md', 'REV-01.md', 'REV-01-prepare.md', 'REV-01-update.md' ] },
                { 'dir': '002-beta', 'files': [ 'REV-01.md', 'v0.2.md' ] },
                { 'dir': '003-leer', 'files': [] }
            ]
        } )

        // Bestand B, die Positiv-Kontrolle des Rueckfalls: JEDES Dokument traegt Revisionen, damit der
        // Rueckfall unabhaengig vom Registrierungs-Wettrennen etwas zu liefern hat.
        const allWithRevisions = await measure( {
            'name': 'control',
            'port': CHILD_PORT + 1,
            'mode': 'fallback',
            'memos': [
                { 'dir': '001-alpha', 'files': [ 'REV-02.md', 'REV-01.md' ] },
                { 'dir': '002-beta', 'files': [ 'REV-01.md' ] }
            ]
        } )

        blocker = mixed[ 'blocker' ] === null ? allWithRevisions[ 'blocker' ] : mixed[ 'blocker' ]
        report = mixed[ 'result' ]
        control = allWithRevisions[ 'result' ]
    }, 180000 )


    afterAll( async () => {
        if( sandbox.length > 0 ) {
            await rm( sandbox, { 'recursive': true, 'force': true } )
        }
    } )


    it( 'Vakuum-Riegel: beide Kindprozesse haben ueberhaupt gemessen', () => {
        expect( blocker ).toBe( null )
        expect( report ).not.toBe( null )
        expect( control ).not.toBe( null )
        expect( report[ 'portCollision' ] ).toBe( false )
        expect( control[ 'portCollision' ] ).toBe( false )
        // Ohne registrierte Dokumente misst jede Zeile darunter nichts. 3 Dokumente, 6 Revisionen.
        expect( report[ 'documentCount' ] ).toBe( 3 )
        expect( report[ 'revisionCount' ] ).toBe( 6 )
    } )


    it( 'T-C: jede echte (documentId, Label)-Paarung antwortet 200 — die Klasse, nicht der Fall', () => {
        // Vergleichsmenge: ALLE registrierten Paarungen des Testbestands, nicht eine Stichprobe.
        expect( report[ 'longForm' ][ 'total' ] ).toBe( 6 )
        expect( report[ 'longForm' ][ 'ok' ] ).toBe( 6 )
        expect( report[ 'longForm' ][ 'shapes' ].sort() ).toEqual( [ 'REV-NN', 'REV-NN-prepare', 'REV-NN-update', 'vN.M' ] )
    } )


    it( 'T-C: die kurze Form antwortet 200 — auch fuer ein Dokument OHNE Revisionen', () => {
        expect( report[ 'shortForm' ][ 'total' ] ).toBe( 3 )
        expect( report[ 'shortForm' ][ 'ok' ] ).toBe( 3 )
        expect( report[ 'shortForm' ][ 'zeroRevisionDocs' ] ).toEqual( [ 'proj--003-leer' ] )
    } )


    it( 'T-C: der Rumpf ist byte-identisch mit dem von / (dieselbe Seite, nicht eine aehnliche)', () => {
        expect( report[ 'bodyCompare' ][ 'rootLength' ] ).toBeGreaterThan( 0 )
        expect( report[ 'bodyCompare' ][ 'docLength' ] ).toBe( report[ 'bodyCompare' ][ 'rootLength' ] )
        expect( report[ 'bodyCompare' ][ 'docSha' ] ).toBe( report[ 'bodyCompare' ][ 'rootSha' ] )
    } )


    it( 'T-D: die drei Negativ-Kontrollen antworten 404', () => {
        // Ohne diese drei ist die Positiv-Messung wertlos: ein Durchreicher antwortet auf alles 200.
        expect( report[ 'negative' ] ).toEqual( {
            'unknownDocument': 404,
            'knownDocumentUnknownLabel': 404,
            'bareDoc': 404
        } )
    } )


    it( 'T-F: /transcripts wird SPA-Route, die Nachbarroute /transcripts/{id} bleibt unberuehrt', () => {
        // Vergleichsmenge: 3 Pfade. Die beiden Nachbar-Werte sind am ALTEN Stand nachgemessen (gegen
        // den laufenden Server der Hauptbaum-Fassung, 2026-09-07): ein aufloesender Composite antwortet
        // 301 auf seine kanonische API-Adresse, eine undurchsichtige Kennung 404. Beide muessen
        // unveraendert bleiben — die SPA-Weiche ist eine Aufzaehlung von GLEICHHEITEN, kein
        // Praefix-Match, sonst haette sie die Nachbarroute mitgenommen.
        expect( report[ 'transcripts' ][ 'bare' ] ).toBe( 200 )
        expect( report[ 'transcripts' ][ 'composite301' ] ).toBe( 301 )
        expect( report[ 'transcripts' ][ 'opaqueId' ] ).toBe( 404 )
    } )


    it( 'T-H (Positiv-Kontrolle, eigener Server): ein Socket OHNE Adresse bekommt den Rueckfall', () => {
        // Der Rueckfall braucht einen Bestand, in dem documents[ 0 ] ueberhaupt eine Revision traegt —
        // sonst vergliche T-G zwei Stillen. Dieser Bestand ist ein ZWEITER Kindprozess: im gemischten
        // Bestand ist documents[ 0 ] nicht vorhersagbar (siehe die Zeile darunter), und ein Nachbessern
        // AN der Reihenfolge waere ein Eingriff in die Vorauswahl-Regel, die PRD-35 gehoert.
        // Vergleichsmenge: 1 Socket gegen einen Bestand aus 2 Dokumenten, beide mit Revisionen.
        expect( control[ 'documentCount' ] ).toBe( 2 )
        expect( control[ 'zeroRevisionDocs' ] ).toEqual( [] )
        expect( control[ 'fallback' ][ 'contentSeen' ] ).toBe( true )
        expect( control[ 'fallback' ][ 'fileName' ] ).toBe( control[ 'expectedFallbackFile' ] )
        expect( control[ 'fallback' ][ 'documentGuess' ] ).toBe( control[ 'firstDocumentId' ] )
    } )


    it( 'Befund (nicht repariert): der Rueckfall haengt an documents[ 0 ], und das ist ein Wettrennen', () => {
        // § I4 in klein, reproduziert: documents[ 0 ] ist die Position, die das WETTRENNEN der
        // nebenlaeufigen Registrierung gewinnt (ProjectAutoRegister nutzt Promise.all), und das leere
        // Memo gewinnt es meist, weil es nichts zu lesen hat. Genau die Form, wegen der der Rueckfall im
        // echten Bestand in 0 von 385 Faellen feuert. Dieses PRD macht ihn entbehrlich, es repariert ihn
        // nicht — Adressat ist PRD-35. Behauptet wird deshalb nicht, WELCHES Dokument gewinnt (das waere
        // ein flackernder Test), sondern die Kopplung: der Rueckfall liefert genau dann etwas, wenn das
        // erste Dokument eine Revision traegt.
        const firstHasRevisions = report[ 'firstDocumentRevisions' ] > 0

        expect( report[ 'sockets' ][ 'fallbackInMixed' ][ 'contentSeen' ] ).toBe( firstHasRevisions )
    } )


    it( 'T-G: die Anweisung schlaegt den Rueckfall — und zwar auf ein ANDERES Dokument', () => {
        expect( report[ 'sockets' ][ 'deepLink' ][ 'contentSeen' ] ).toBe( true )
        expect( report[ 'sockets' ][ 'deepLink' ][ 'fileName' ] ).toBe( 'v0.2.md' )
        expect( report[ 'sockets' ][ 'deepLink' ][ 'documentGuess' ] ).toBe( 'proj--002-beta' )
    } )


    it( 'T-I: ein unparsbarer Adress-Pfad stuerzt den Server nicht ab', () => {
        expect( report[ 'sockets' ][ 'broken' ][ 'opened' ] ).toBe( true )
        expect( report[ 'sockets' ][ 'broken' ][ 'crashed' ] ).toBe( false )
        expect( report[ 'sockets' ][ 'broken' ][ 'httpAfter' ] ).toBe( 200 )
    } )
} )


// The child harness. Written into the throwaway sandbox at run time, never a tracked fourth file.
// It boots the REAL server module of this worktree, measures over the wire, prints ONE JSON block
// between markers and exits — which is what releases the port.
const harnessSource = `import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { WebSocket } from 'ws'

const PORT = Number( process.env[ 'PRD33_PORT' ] )
const SRC = process.env[ 'PRD33_SRC' ]
const MODE = process.env[ 'PRD33_MODE' ]
const base = 'http://127.0.0.1:' + PORT

const probe = () => {
    return new Promise( ( done ) => {
        const socket = createConnection( { 'host': '127.0.0.1', 'port': PORT } )
        const settle = ( inUse ) => { socket.destroy(); done( inUse ) }
        socket.setTimeout( 400 )
        socket.on( 'connect', () => settle( true ) )
        socket.on( 'timeout', () => settle( false ) )
        socket.on( 'error', () => settle( false ) )
    } )
}

const statusOf = async ( path ) => {
    const answered = await fetch( base + path, { 'redirect': 'manual' } )

    return answered.status
}

const shapeOf = ( label ) => {
    if( /^REV-[0-9]+$/.test( label ) ) { return 'REV-NN' }
    if( /^REV-[0-9]+-prepare$/.test( label ) ) { return 'REV-NN-prepare' }
    if( /^REV-[0-9]+-update$/.test( label ) ) { return 'REV-NN-update' }
    if( /^v[0-9]+\\.[0-9]+$/.test( label ) ) { return 'vN.M' }

    return 'ANDERE'
}

// One socket, one verdict: what is the FIRST content message this connection receives?
const firstContent = ( path ) => {
    return new Promise( ( done ) => {
        const socket = new WebSocket( 'ws://127.0.0.1:' + PORT + path )
        const outcome = { 'opened': false, 'contentSeen': false, 'fileName': null, 'documentGuess': null, 'crashed': false }
        const settle = () => { try { socket.close() } catch { /* already gone */ } done( outcome ) }
        const timer = setTimeout( settle, 4000 )

        socket.on( 'open', () => { outcome[ 'opened' ] = true } )
        socket.on( 'error', () => { outcome[ 'crashed' ] = true; clearTimeout( timer ); settle() } )
        socket.on( 'message', ( raw ) => {
            const msg = JSON.parse( raw.toString() )

            if( msg[ 'type' ] === 'documentList' && outcome[ 'contentSeen' ] === false ) {
                const nodes = Object.keys( msg[ 'tree' ] || {} )
                    .flatMap( ( key ) => {
                        const node = msg[ 'tree' ][ key ]

                        return Array.isArray( node ) ? node : ( node && node[ 'memos' ] ? node[ 'memos' ] : [] )
                    } )
                const selected = nodes.filter( ( entry ) => entry && entry[ 'selectedRevision' ] )
                outcome[ 'documentGuess' ] = selected.length === 1 ? selected[ 0 ][ 'documentId' ] : null
            }

            if( msg[ 'type' ] === 'content' && outcome[ 'contentSeen' ] === false ) {
                outcome[ 'contentSeen' ] = true
                outcome[ 'fileName' ] = msg[ 'fileName' ]
                clearTimeout( timer )
                setTimeout( settle, 120 )
            }
        } )
    } )
}

const main = async () => {
    const collision = await probe()
    const report = { 'portCollision': collision, 'documentCount': 0, 'revisionCount': 0 }

    if( collision === true ) {
        process.stdout.write( '###PRD33###' + JSON.stringify( report ) + '###PRD33###' )
        process.exit( 0 )
    }

    const { MemoView } = await import( SRC )
    await MemoView.startServer( { 'port': PORT } )

    const listed = await ( await fetch( base + '/api/documents' ) ).json()
    const documents = listed[ 'documents' ] || []
    const pairs = documents.flatMap( ( doc ) => {
        return ( doc[ 'revisions' ] || [] )
            .map( ( rev ) => { return { 'documentId': doc[ 'documentId' ], 'label': rev[ 'fileName' ].replace( /\\.md$/, '' ) } } )
    } )

    report[ 'documentCount' ] = documents.length
    report[ 'revisionCount' ] = pairs.length
    report[ 'firstDocumentId' ] = documents.length > 0 ? documents[ 0 ][ 'documentId' ] : null
    report[ 'firstDocumentRevisions' ] = documents.length > 0 ? ( documents[ 0 ][ 'revisions' ] || [] ).length : 0
    report[ 'zeroRevisionDocs' ] = documents.filter( ( doc ) => ( doc[ 'revisions' ] || [] ).length === 0 ).map( ( doc ) => doc[ 'documentId' ] )

    // MODE fallback: the positive control lives in its OWN process because state.absolutePath is
    // process-wide — an observation of the fallback is only worth something before the first selection.
    if( MODE === 'fallback' ) {
        report[ 'expectedFallbackFile' ] = report[ 'firstDocumentRevisions' ] > 0 ? documents[ 0 ][ 'revisions' ][ 0 ][ 'fileName' ] : null
        report[ 'fallback' ] = await firstContent( '/' )

        process.stdout.write( '###PRD33###' + JSON.stringify( report ) + '###PRD33###' )
        process.exit( 0 )
    }

    const longStatus = await Promise.all(
        pairs.map( ( pair ) => statusOf( '/doc/' + encodeURIComponent( pair[ 'documentId' ] ) + '/' + encodeURIComponent( pair[ 'label' ] ) ) )
    )
    report[ 'longForm' ] = {
        'total': pairs.length,
        'ok': longStatus.filter( ( code ) => code === 200 ).length,
        'shapes': [ ...new Set( pairs.map( ( pair ) => shapeOf( pair[ 'label' ] ) ) ) ]
    }

    const shortStatus = await Promise.all(
        documents.map( ( doc ) => statusOf( '/doc/' + encodeURIComponent( doc[ 'documentId' ] ) ) )
    )
    report[ 'shortForm' ] = {
        'total': documents.length,
        'ok': shortStatus.filter( ( code ) => code === 200 ).length,
        'zeroRevisionDocs': documents.filter( ( doc ) => ( doc[ 'revisions' ] || [] ).length === 0 ).map( ( doc ) => doc[ 'documentId' ] )
    }

    const rootBody = await ( await fetch( base + '/' ) ).text()
    const docBody = await ( await fetch( base + '/doc/' + encodeURIComponent( pairs[ 0 ][ 'documentId' ] ) + '/' + encodeURIComponent( pairs[ 0 ][ 'label' ] ) ) ).text()
    report[ 'bodyCompare' ] = {
        'rootLength': rootBody.length,
        'docLength': docBody.length,
        'rootSha': createHash( 'sha256' ).update( rootBody ).digest( 'hex' ),
        'docSha': createHash( 'sha256' ).update( docBody ).digest( 'hex' )
    }

    report[ 'negative' ] = {
        'unknownDocument': await statusOf( '/doc/erfunden--gibt-es-nicht/REV-99' ),
        'knownDocumentUnknownLabel': await statusOf( '/doc/' + encodeURIComponent( pairs[ 0 ][ 'documentId' ] ) + '/REV-99' ),
        'bareDoc': await statusOf( '/doc' )
    }

    report[ 'transcripts' ] = {
        'bare': await statusOf( '/transcripts' ),
        'composite301': await statusOf( '/transcripts/erfunden--gibt-es-nicht--REV-01--01' ),
        'opaqueId': await statusOf( '/transcripts/opaque-legacy-id' )
    }

    // ORDER MATTERS: state.absolutePath is process-wide, so the fallback can only be observed before
    // the first selection. Observation first, instruction second, broken address last.
    const fallbackInMixed = await firstContent( '/' )
    const deepLink = await firstContent( '/doc/' + encodeURIComponent( 'proj--002-beta' ) + '/v0.2' )
    const broken = await firstContent( '/doc/erfunden--gibt-es-nicht/REV-99' )
    const httpAfter = await statusOf( '/' )

    report[ 'sockets' ] = { fallbackInMixed, deepLink, 'broken': { ...broken, httpAfter } }

    process.stdout.write( '###PRD33###' + JSON.stringify( report ) + '###PRD33###' )
    process.exit( 0 )
}

main()
`


// The harness lives in the sandbox only. Guard the assumption that the module it boots exists, so a
// moved source fails loud here instead of turning the live half silently unjudgeable.
describe( 'PRD-33 — Vorbedingung des Kindprozesses', () => {
    it( 'die Serverquelle, die der Kindprozess bootet, liegt im Repo', () => {
        expect( existsSync( memoViewPath ) ).toBe( true )
        expect( existsSync( clientPath ) ).toBe( true )
        expect( harnessSource.length ).toBeGreaterThan( 2000 )
    } )
} )
