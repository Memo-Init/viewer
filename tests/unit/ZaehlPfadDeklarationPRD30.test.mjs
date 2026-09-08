import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseSync } from '@dolthub/doltlite'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { MemoView } from '../../src/MemoView.mjs'
import { extractFunctions, readEmittedScript, readMemoViewSource } from '../helpers/extractFunction.mjs'


// PRD-30 (Memo 081, WI-064/WI-069) — the count and aggregation path.
//
// The reported defect: the header read "0 von 0 beantwortet" and the sidebar card "? 0" while fifteen
// question cards rendered underneath. The number was not merely wrong — it was UNREADABLE. "0 von 0" is
// the same string whether a memo has no questions or whether nothing was ever counted, and no display
// site could tell the two apart. REV-16:1955 binds this rollout to the opposite rule: a check with
// `compared == 0` is red, not green, so every count states the set it was held against.
//
// Every case below asserts something that was demonstrably FALSE before the change. Fixtures are built
// in the OS temp directory, never outside the repository: CI checks this repo out alone, and a test that
// reads `../../../../.memo/…` took down 31 cases once already (M080/PRD-V4).
describe( 'PRD-30 — jede Fragen-Zahl nennt die Menge, die sie gezählt hat', () => {
    let workspace = ''
    let client = null
    let clientSource = ''
    let serverSource = ''


    // Lift the client helpers, tolerating absent ones. This matters for the proof this file has to carry:
    // run against the PRE-change source, a hard lift throws in beforeAll and reports every case as red
    // without having evaluated a single assertion — a vacuum red, which is worth exactly as much as a
    // vacuum green. Degraded mode replaces a missing function with one that names itself, so each case
    // fails on its own merits and the count of reds means something.
    const liftClient = async ( names ) => {
        try {
            const lifted = await extractFunctions( names )

            return Object.assign( { 'missing': [] }, lifted )
        } catch {
            const perName = await names
                .reduce( async ( accPromise, name ) => {
                    const acc = await accPromise

                    try {
                        const one = await extractFunctions( [ name ] )
                        acc[ name ] = one[ name ]
                    } catch {
                        acc[ 'missing' ] = acc[ 'missing' ].concat( [ name ] )
                        acc[ name ] = () => { throw new Error( `client function absent: ${ name }` ) }
                    }

                    return acc
                }, Promise.resolve( { 'missing': [] } ) )

            return perName
        }
    }


    beforeAll( async () => {
        workspace = await mkdtemp( join( tmpdir(), 'prd30-' ) )
        client = await liftClient( [ 'normalizeQuestions', 'openQuestionsOf', 'countQuestionsOf', 'questionCountTitle' ] )
        clientSource = await readEmittedScript()
        serverSource = await readMemoViewSource()
    } )


    afterAll( async () => {
        await rm( workspace, { 'recursive': true, 'force': true } )
    } )


    // Register a memo folder, read the parsed document, then drop it again. The drop is not tidiness:
    // addDocument starts an fs watcher, and a watcher left open holds the whole jest worker alive.
    const registerAndRead = async ( { memoPath, before } ) => {
        const { registry } = DocumentRegistry.create( { 'onChange': null } )
        const { documentId } = await registry.addDocument( { 'projectId': 'prd30', memoPath } )

        if( typeof before === 'function' ) {
            await before()
            await registry.addDocument( { 'projectId': 'prd30', memoPath } )
        }

        const { documents } = registry.getDocuments()
        registry.removeDocument( { documentId } )

        return documents[ 0 ]
    }

    // A registered memo folder with one full revision carrying the given questions-json block.
    const memoWith = async ( { name, jsonBlock } ) => {
        const memoPath = join( workspace, name )
        await mkdir( memoPath, { 'recursive': true } )
        const body = [ '# Memo', '', '## Offene Fragen', '', jsonBlock, '' ].join( '\n' )
        await writeFile( join( memoPath, 'REV-01.md' ), body, 'utf-8' )

        return registerAndRead( { memoPath } )
    }

    const emptyMemo = async ( { name } ) => {
        const memoPath = join( workspace, name )
        await mkdir( memoPath, { 'recursive': true } )

        return registerAndRead( { memoPath } )
    }

    const jsonFence = ( questions ) => [ '```questions-json', JSON.stringify( { questions }, null, 2 ), '```' ].join( '\n' )


    describe( 'Vorbedingung — die Vergleichsgrundlage dieses Laufs', () => {
        it( 'alle vier Client-Helfer konnten aus dem ausgelieferten Skript gehoben werden', () => {
            // Names the comparison basis of every client case below. Against a source that does not carry
            // them, this line reports WHICH are absent instead of letting the file die in setup.
            expect( client.missing ).toEqual( [] )
        } )
    } )


    describe( 'T-A — der Datenbank-Zweig nennt Datei und Menge', () => {
        it( 'baut aus einem DB-Zählstand eine Deklaration mit source, countedIn und counted', () => {
            const counts = DocumentRegistry.questionCounts( {
                'open': 4, 'answered': 0, 'deferred': 0,
                'source': 'db', 'countedIn': 'memo-081.db', 'counted': 4, 'note': null
            } )

            expect( counts.basis ).toBe( true )
            expect( counts.comparison.source ).toBe( 'db' )
            expect( counts.comparison.countedIn ).toBe( 'memo-081.db' )
            expect( counts.comparison.counted ).toBe( 4 )
            expect( counts.open ).toBe( 4 )
        } )


        // The live DB read cannot be fixtured inside this repo (a memo database lives in the memo store,
        // outside it). What IS assertable here is the wiring that was missing: `readQuestionAnswerState`
        // has always returned `total`, and `resolveDbPath` the path — both were dropped on the floor, which
        // is exactly why the DB branch produced a number without a denominator. This is a grep against
        // CODE, never against the prose that ordered it.
        // The live DB branch, driven end to end against a real memo database — not a grep. `total` and
        // the database file name were both available before (readQuestionAnswerState returns the one,
        // resolveDbPath the other) and both were dropped on the floor, which is precisely why the DB
        // branch produced a number with no denominator behind it.
        it( 'ein DB-Memo meldet source db, den Datenbank-Dateinamen und die gezählte Menge', async () => {
            const memoDir = join( workspace, '007-db-memo' )
            const revDir = join( memoDir, 'revisions' )
            await mkdir( revDir, { 'recursive': true } )
            await writeFile( join( revDir, 'REV-01.md' ), '# Memo\n\n## Offene Fragen\n\n### F1 — Eine\n\nKontext.\n', 'utf-8' )

            const db = new DatabaseSync( join( memoDir, 'memo-030.db' ) )
            db.exec( 'CREATE TABLE IF NOT EXISTS question ( id TEXT PRIMARY KEY, memo_id TEXT, text TEXT, kind TEXT, status TEXT )' )
            ;[ [ 'F1', 'open' ], [ 'F2', 'open' ], [ 'F3', 'answered' ] ]
                .forEach( ( [ id, status ] ) => {
                    db.prepare( 'INSERT INTO question ( id, memo_id, text, kind, status ) VALUES ( ?, ?, ?, ?, ? )' )
                        .run( id, 'M030', id, 'info', status )
                } )
            db.close()

            const doc = await registerAndRead( { 'memoPath': revDir } )

            expect( doc.questions.comparison.source ).toBe( 'db' )
            expect( doc.questions.comparison.countedIn ).toBe( 'memo-030.db' )
            expect( doc.questions.comparison.counted ).toBe( 3 )
            expect( doc.questions.basis ).toBe( true )
            // The counted set is the whole question table; `open` is the subset that is open. The old
            // path shipped the subset alone, and a "2" told the reader nothing about the 3 it came from.
            expect( doc.questions.open ).toBe( 2 )
            expect( doc.questions.comparison.counted ).toBeGreaterThan( doc.questions.open )
        } )
    } )


    describe( 'T-B — der Datei-Zweig nennt die Revision, die er gelesen hat', () => {
        it( 'source file, countedIn ist der Dateiname, counted ist open + answered + deferred', async () => {
            const doc = await memoWith( {
                'name': '001-datei-zweig',
                'jsonBlock': jsonFence( [
                    { 'id': 'F1', 'title': 'offen a', 'status': 'open' },
                    { 'id': 'F2', 'title': 'offen b', 'status': 'open' },
                    { 'id': 'F3', 'title': 'beantwortet', 'status': 'answered', 'answered': true },
                    { 'id': 'F4', 'title': 'zurückgestellt', 'status': 'irrelevant' }
                ] )
            } )

            expect( doc.questions.comparison.source ).toBe( 'file' )
            expect( doc.questions.comparison.countedIn ).toBe( 'REV-01.md' )
            expect( doc.questions.basis ).toBe( true )
            expect( doc.questions.comparison.counted )
                .toBe( doc.questions.open + doc.questions.answered + doc.questions.deferred )
            expect( doc.questions.comparison.counted ).toBe( 4 )
            expect( doc.questions.open ).toBe( 2 )
        } )


        it( 'eine gelesene Revision OHNE Fragen ist eine gemessene Null, keine ungezählte', async () => {
            const doc = await memoWith( { 'name': '002-leer-aber-gelesen', 'jsonBlock': jsonFence( [] ) } )

            // The distinction the whole PRD is about: this zero was LOOKED AT. It renders as a number.
            expect( doc.questions.open ).toBe( 0 )
            expect( doc.questions.basis ).toBe( true )
            expect( doc.questions.comparison.source ).toBe( 'file' )
            expect( doc.questions.comparison.counted ).toBe( 0 )
        } )
    } )


    describe( 'T-C — das Vakuum meldet nicht mehr grün', () => {
        it( 'keine Full-Revision und keine Datenbank: basis false, source none, note gesetzt', async () => {
            const doc = await emptyMemo( { 'name': '003-vakuum' } )

            expect( doc.questions.open ).toBe( 0 )
            expect( doc.questions.basis ).toBe( false )
            expect( doc.questions.comparison.source ).toBe( 'none' )
            expect( doc.questions.comparison.counted ).toBe( 0 )
            expect( doc.questions.comparison.note ).not.toBe( null )
            expect( typeof doc.questions.comparison.note ).toBe( 'string' )
        } )


        it( 'die Null des Vakuums ist von der gemessenen Null unterscheidbar — das ist der Gegenstand', async () => {
            const gemessen = await memoWith( { 'name': '004-gemessene-null', 'jsonBlock': jsonFence( [] ) } )
            const ungezaehlt = await emptyMemo( { 'name': '005-ungezaehlt' } )

            // Both show open === 0. Before the change that was ALL they showed, and the two states were
            // one state on screen. Now the declaration separates them.
            expect( gemessen.questions.open ).toBe( ungezaehlt.questions.open )
            expect( gemessen.questions.basis ).not.toBe( ungezaehlt.questions.basis )
            expect( gemessen.questions.comparison.source ).not.toBe( ungezaehlt.questions.comparison.source )
        } )
    } )


    describe( 'T-D — ein Lesefehler trägt seinen Grund, nicht eine stille Null', () => {
        it( 'unlesbare Full-Revision: basis false, note nennt die Revision', async () => {
            const memoPath = join( workspace, '006-lesefehler' )
            await mkdir( memoPath, { 'recursive': true } )
            const revisionPath = join( memoPath, 'REV-01.md' )
            await writeFile( revisionPath, '# Memo\n', 'utf-8' )

            // Make the file unreadable AFTER registration, then force a re-parse.
            const doc = await registerAndRead( { memoPath, 'before': () => chmod( revisionPath, 0o000 ) } )
            await chmod( revisionPath, 0o644 )

            // Running as root would defeat the chmod; the case is then not exercised and says so rather
            // than passing vacuously.
            if( doc.questions.comparison.source === 'file' ) {
                expect( process.getuid && process.getuid() === 0 ).toBe( true )

                return
            }

            expect( doc.questions.basis ).toBe( false )
            expect( doc.questions.comparison.source ).toBe( 'none' )
            expect( doc.questions.comparison.note ).toContain( 'REV-01.md' )
            expect( doc.questions.comparison.note ).not.toBe( null )
        } )
    } )


    describe( 'T-E / T-F — der Client hält eine undeklarierte Zahl für undeklariert', () => {
        it( 'T-E: normalizeQuestions( null ) meldet basis false und source none — nicht {0,0,0}', () => {
            const q = client.normalizeQuestions( null )

            expect( q.open ).toBe( 0 )
            expect( q.basis ).toBe( false )
            expect( q.comparison.source ).toBe( 'none' )
            expect( q.comparison.note ).not.toBe( null )
        } )


        it( 'T-F: eine Zahl ohne Deklaration (Alt-Server) gilt als undeklariert, nicht als gut', () => {
            const q = client.normalizeQuestions( { 'open': 4, 'answered': 0, 'deferred': 0 } )

            expect( q.open ).toBe( 4 )
            expect( q.basis ).toBe( false )
            expect( q.comparison.source ).toBe( 'none' )
        } )


        it( 'eine deklarierte Zahl wird unverändert durchgereicht', () => {
            const q = client.normalizeQuestions( {
                'open': 4, 'answered': 1, 'deferred': 0, 'basis': true,
                'comparison': { 'source': 'db', 'countedIn': 'memo-081.db', 'counted': 5, 'note': null }
            } )

            expect( q.basis ).toBe( true )
            expect( q.comparison.countedIn ).toBe( 'memo-081.db' )
            expect( q.comparison.counted ).toBe( 5 )
        } )
    } )


    describe( 'T-G — die drei Server-Stellen können nicht wieder auseinanderlaufen', () => {
        it( 'der Rückfall ist byte-gleich, wo er früher in zwei Formen vorlag', () => {
            const a = JSON.stringify( DocumentRegistry.undeclaredQuestionCounts() )
            const b = JSON.stringify( DocumentRegistry.undeclaredQuestionCounts() )

            expect( a ).toBe( b )
            // The old copies were `{ open, answered }` twice and `{ open, answered, deferred }` once —
            // the same absent datum answered in two shapes depending on the route.
            expect( JSON.parse( a ).deferred ).toBe( 0 )
            expect( JSON.parse( a ).basis ).toBe( false )
            expect( JSON.parse( a ).comparison.source ).toBe( 'none' )
        } )


        it( 'keine der vier alten Rückfall-Literale steht noch im Code', async () => {
            const fs = await import( 'node:fs/promises' )
            const registrySource = await fs.readFile( new URL( '../../src/DocumentRegistry.mjs', import.meta.url ), 'utf-8' )

            expect( registrySource.includes( "doc['questions'] || { 'open': 0, 'answered': 0 }" ) ).toBe( false )
            expect( serverSource.includes( "doc['questions'] || { 'open': 0, 'answered': 0, 'deferred': 0 }" ) ).toBe( false )
            expect( serverSource.includes( 'DocumentRegistry.undeclaredQuestionCounts()' ) ).toBe( true )
        } )
    } )


    describe( 'T-H — openQuestionsOf zählt Elemente mit status open, sonst nichts', () => {
        it( 'gemischte Status: open zählt, answered und die zwei Retired-Status nicht', () => {
            const schema = [
                { 'id': 'F1', 'status': 'open' },
                { 'id': 'F2', 'status': 'answered' },
                { 'id': 'F3', 'status': 'irrelevant' },
                { 'id': 'F4', 'status': 'replaced' },
                { 'id': 'F5', 'status': 'open' },
                null
            ]

            expect( client.openQuestionsOf( schema ).length ).toBe( 2 )
            expect( client.countQuestionsOf( schema ).open ).toBe( 2 )
            expect( client.countQuestionsOf( schema ).answered ).toBe( 1 )
            expect( client.countQuestionsOf( schema ).total ).toBe( 3 )
            expect( client.countQuestionsOf( schema ).elements ).toBe( 6 )
        } )


        it( 'renderQuestionWidgets benutzt denselben Ausdruck — eine Bedingung, keine zwei Kopien', () => {
            expect( clientSource.includes( 'var open = openQuestionsOf( schema )' ) ).toBe( true )
            // The inlined copy of the filter is gone from the renderer.
            expect( clientSource.includes( "var open = ( schema || [] ).filter( function( q ) { return q && q.status === 'open' } )" ) ).toBe( false )
        } )
    } )


    describe( 'T-I — die Kennungs-Falle: 15 Elemente, nicht 16 Kennungen', () => {
        it( 'F2–F12 und F14–F17 sind 15 offene Fragen, obwohl die Spannweite 16 beträgt', () => {
            const ids = [ 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17 ]
            const schema = ids.map( ( n ) => ( { 'id': 'F' + n, 'status': 'open' } ) )
            const spannweite = Math.max( ...ids ) - Math.min( ...ids ) + 1

            expect( client.openQuestionsOf( schema ).length ).toBe( 15 )
            expect( spannweite ).toBe( 16 )
            // Both figures are true statements about different sets. The counter counts ELEMENTS.
            expect( client.openQuestionsOf( schema ).length ).not.toBe( spannweite )
        } )
    } )


    describe( 'die Label-Ebene: "0 von 0" gegen "nicht gezählt"', () => {
        it( 'promptStatusLine mit basis false meldet nicht gezählt statt einer Null', () => {
            const ungezaehlt = MemoView.promptStatusLine( {
                'words': 0, 'spokenMinutes': 0, 'questionsAnswered': 0, 'questionsTotal': 0,
                'transcriptUrl': '', 'basis': false
            } )
            const gemessen = MemoView.promptStatusLine( {
                'words': 0, 'spokenMinutes': 0, 'questionsAnswered': 0, 'questionsTotal': 0,
                'transcriptUrl': '', 'basis': true
            } )

            expect( ungezaehlt.answeredLabel ).toBe( 'nicht gezählt' )
            expect( ungezaehlt.openLabel ).toBe( 'nicht gezählt' )
            expect( ungezaehlt.counted ).toBe( false )
            // The measured zero keeps the form it always had — this is not a rename, it is a distinction.
            expect( gemessen.answeredLabel ).toBe( '0 von 0 beantwortet' )
            expect( gemessen.counted ).toBe( true )
            expect( ungezaehlt.answeredLabel ).not.toBe( gemessen.answeredLabel )
        } )


        it( 'der Browser-Zwilling trägt dieselbe Regel (1:1-Spiegel, sonst driften sie)', () => {
            expect( clientSource.includes( "opts.basis === false ? 'nicht gezählt'" ) ).toBe( true )
            expect( serverSource.includes( "basis === false ? 'nicht gezählt'" ) ).toBe( true )
        } )


        it( 'questionCountTitle nennt Datei und Menge, bei basis false den Grund', () => {
            const counted = client.questionCountTitle( {
                'open': 4, 'answered': 0, 'deferred': 0, 'basis': true,
                'comparison': { 'source': 'db', 'countedIn': 'memo-081.db', 'counted': 4, 'note': null }
            } )
            const uncounted = client.questionCountTitle( {
                'open': 0, 'answered': 0, 'deferred': 0, 'basis': false,
                'comparison': { 'source': 'none', 'countedIn': null, 'counted': 0, 'note': 'keine Full-Revision' }
            } )

            expect( counted ).toContain( 'memo-081.db' )
            expect( counted ).toContain( '4' )
            expect( uncounted ).toContain( 'Nicht gezählt' )
            expect( uncounted ).toContain( 'keine Full-Revision' )
        } )
    } )


    describe( 'die fünf plus eine Anzeigestelle — die Klasse, nicht der Fall', () => {
        it( 'Stelle 1 (Zone-2-Kopfzeile) zählt das Schema der betrachteten Revision, nicht die Registry', () => {
            expect( clientSource.includes( 'var psView = viewedRevision ? countQuestionsOf( lastQuestionSchema ) : null' ) ).toBe( true )
            expect( clientSource.includes( 'var psAnswered = psBasis ? psView.answered : 0' ) ).toBe( true )
            // The old registry-fed pair is gone.
            expect( clientSource.includes( 'var psAnswered = qMeta.answered' ) ).toBe( false )
            expect( clientSource.includes( 'var psTotal = qMeta.answered + qMeta.open' ) ).toBe( false )
        } )


        it( 'Stelle 2 (Warteschlangen-Karte) und Stelle 3 (Sidebar-Zeile) tragen basis und einen Titel', () => {
            expect( clientSource.includes( 'var qCard = normalizeQuestions( doc.questions )' ) ).toBe( true )
            expect( clientSource.includes( 'var qRow = normalizeQuestions( doc.questions )' ) ).toBe( true )
            expect( clientSource.includes( "data-basis=\"' + ( qCard.basis ? '1' : '0' ) + '\"" ) ).toBe( true )
            expect( clientSource.includes( "data-basis=\"' + ( qRow.basis ? '1' : '0' ) + '\"" ) ).toBe( true )
            // The two silent `|| {}` reads are gone.
            expect( clientSource.includes( 'var openCount = ( doc.questions || {} ).open' ) ).toBe( false )
        } )


        it( 'Stelle 4 (Popup-Label) zählt dieselbe Menge wie die Liste, die es beschriftet', () => {
            expect( clientSource.includes( 'var qView = countQuestionsOf( lastQuestionSchema )' ) ).toBe( true )
            expect( clientSource.includes( "'2 · FRAGEN BEANTWORTEN (' + qView.answered + ' / ' + qView.total + ')'" ) ).toBe( true )
            expect( clientSource.includes( "'2 · FRAGEN BEANTWORTEN (' + qMeta.answered + ' / ' + total + ')'" ) ).toBe( false )
        } )


        it( 'Stelle 5 (HTML-Literal) ist kein (0 / 0) mehr', () => {
            expect( serverSource.includes( '2 · FRAGEN BEANTWORTEN (0 / 0)' ) ).toBe( false )
            expect( serverSource.includes( '2 · FRAGEN BEANTWORTEN (…)' ) ).toBe( true )
        } )


        it( 'Stelle 6 (Revisions-Chip) — vom PRD nicht inventarisiert — zeigt keine ungezählte Null mehr', () => {
            expect( clientSource.includes( 'var revMeta = normalizeQuestions( doc.questions )' ) ).toBe( true )
            expect( clientSource.includes( 'var revCounted = isSelected && revMeta.basis === true' ) ).toBe( true )
            expect( clientSource.includes( "var revOpen = isSelected ? ( ( doc.questions || {} ).open || 0 ) : 0" ) ).toBe( false )
        } )


        // Found while building, not after: renderQuestionWidgets runs in the content handler BEFORE
        // `currentMemoName` is adopted, so a name-keyed lookup there would have held this revision's cards
        // against the PREVIOUSLY viewed memo's count — the defect of this PRD, one level deeper.
        // `currentDocumentId` is adopted before the render pipeline and is the correct handle.
        it( 'die zweite Achse schlägt das Memo über currentDocumentId nach, nicht über currentMemoName', () => {
            expect( clientSource.includes( 'var registryEntry = lookupMemoEntryById( currentDocumentId )' ) ).toBe( true )
            expect( clientSource.includes( 'var registryEntry = lookupMemoEntry( currentMemoName )' ) ).toBe( false )
            // Both lookups walk ONE tree walker — a second copy is where the next divergence starts.
            expect( clientSource.includes( 'function findMemoEntry( matches )' ) ).toBe( true )

            // Scoped to the content handler: renderQuestionWidgets has several call sites, so a bare
            // indexOf would compare the wrong occurrence — it did, on the first run of this case.
            const adoptId = clientSource.indexOf( 'if( data.documentId ) { currentDocumentId = data.documentId }' )
            const render = clientSource.indexOf( 'renderQuestionWidgets( lastQuestionSchema )', adoptId )
            const adoptName = clientSource.indexOf( 'currentMemoName = data.memoName', adoptId )

            expect( adoptId ).toBeGreaterThan( -1 )
            expect( render ).toBeGreaterThan( adoptId )
            // The very ordering that makes the name-keyed lookup wrong — asserted, not assumed.
            expect( adoptName ).toBeGreaterThan( render )
        } )


        it( 'die zweite Achse steht am selben Ort wie das vorhandene Parse-Banner', () => {
            expect( clientSource.includes( "divergence.id = 'qw-source-warn'" ) ).toBe( true )
            expect( clientSource.includes( "divergence.className = 'qw-parse-warn'" ) ).toBe( true )
            expect( clientSource.includes( "container.setAttribute( 'data-qw-rendered', String( open.length ) )" ) ).toBe( true )
            // The parse axis survives untouched.
            expect( clientSource.includes( 'Fragen konnten nicht als Widget geparst werden' ) ).toBe( true )
        } )
    } )


    describe( 'die Deklaration ist erzwungen, nicht erbeten', () => {
        it( 'ein Aufruf ohne source ist ein Fehler, kein Default', () => {
            expect( () => DocumentRegistry.questionCounts( {
                'open': 0, 'answered': 0, 'deferred': 0, 'countedIn': null, 'counted': 0, 'note': null
            } ) ).toThrow( /source must be one of/ )
        } )


        it( 'ein unbekannter source-Wert wird abgewiesen', () => {
            expect( () => DocumentRegistry.questionCounts( {
                'open': 0, 'answered': 0, 'deferred': 0,
                'source': 'guessed', 'countedIn': null, 'counted': 0, 'note': null
            } ) ).toThrow( /source must be one of/ )
        } )


        it( 'eine fehlende Zahl ist ein Fehler, keine Null', () => {
            expect( () => DocumentRegistry.questionCounts( {
                'open': 0, 'answered': 0, 'deferred': 0,
                'source': 'none', 'countedIn': null, 'note': null
            } ) ).toThrow( /must be a number/ )
        } )
    } )
} )
