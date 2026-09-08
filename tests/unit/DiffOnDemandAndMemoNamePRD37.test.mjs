import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { MemoView } from '../../src/MemoView.mjs'
import { readMemoViewSource, readEmittedScript } from '../helpers/extractFunction.mjs'


// PRD-37 (Memo 081, Kap 28 / WI-105 + N1) — der Diff reist auf Anfrage, und der Name kommt von dem
// Dokument, das angesprochen wurde.
//
// Jeder Fall nennt seine VERGLEICHSMENGE. Eine Pruefung, die nichts zu vergleichen findet, ist rot oder
// unbewertbar, nie gruen — ein totes Stueck Vorrichtung meldet ebenfalls 0. Jede Null-Behauptung misst
// daneben das Gegenteil aus derselben Vorrichtung (Vakuum-Riegel).
//
// Die lebende Haelfte laeuft gegen einen ECHTEN Server in einem KINDPROZESS, nach dem Vorbild von
// DeepLinkRoutesPRD33: eine Route, die nur in einer Attrappe existiert, beweist die Attrappe. Der Kind-
// prozess kann ausserdem die oeffentlichen Statics IM SELBEN PROZESS aufrufen, in dem die Registrierung
// lebt — dort und nur dort ist `#registry` gesetzt.
// REPO-GRENZE: gelesen und geschrieben wird ausschliesslich innerhalb dieses Repositoriums. Der Bestand
// des Kindes ist ein WEGWERF-Baum unter .test-tmp/ (gitignored), nie der echte .memo/-Bestand — die CI
// checkt dieses Repo allein aus, und ein Test, der darueber hinausgriff, riss hier schon einmal 31 Faelle.
const here = dirname( fileURLToPath( import.meta.url ) )
const repoRoot = resolve( here, '..', '..' )
const memoViewPath = resolve( repoRoot, 'src', 'MemoView.mjs' )
const runFile = promisify( execFile )

// Ausserhalb des Projekt-Inventars (3333/4444/5555/6666/7777/8888), ausserhalb der von Hand gemessenen
// 3393 und ausserhalb der Ports von PRD-33 (47933/47934). Das Kind prueft den Port und meldet eine
// Kollision, statt sie zu raten.
const CHILD_PORT = 47937


describe( 'PRD-37 — resolveMemoName: kein stiller Default, keine Aufloesung ohne Schluessel', () => {

    it( 'T-C: wirft, wenn weder documentId noch absolutePath gesetzt ist', () => {
        // Vergleichsmenge: 3 Aufrufformen ohne Schluessel — leeres Objekt, beide Felder null, beide
        // Felder undefined. Eine Aufloesung, die nicht sagen kann, wonach sie sucht, ist keine.
        const forms = [ {}, { 'documentId': null, 'absolutePath': null }, { 'documentId': undefined, 'absolutePath': undefined } ]

        expect( forms.length ).toBe( 3 )

        // Die MELDUNG wird mitgeprueft, nicht nur das Werfen. Ohne sie waere der Fall auch dann gruen,
        // wenn es die Methode gar nicht gaebe — ein fehlender Aufruf wirft ebenfalls. Gemessen: gegen den
        // alten Stand war das der einzige der 21 Faelle, der aus dem falschen Grund bestand.
        const thrown = forms
            .map( ( form ) => {
                try {
                    MemoView.resolveMemoName( form )

                    return 'kein Fehler'
                } catch( error ) {
                    return String( error[ 'message' ] )
                }
            } )

        expect( thrown.length ).toBe( 3 )
        thrown.forEach( ( message ) => expect( message ).toContain( 'resolveMemoName: needs documentId or absolutePath' ) )
    } )


    it( 'T-C2 (Vakuum-Riegel): ein Aufruf MIT Schluessel wirft NICHT', () => {
        // Ohne diesen Fall misst T-C eine Methode, die immer wirft. Ohne Registrierung ist die Antwort
        // { memoName: null } — das ist ein Ergebnis, kein Fehler.
        const answered = MemoView.resolveMemoName( { 'documentId': 'irgendeine-kennung' } )

        expect( answered[ 'memoName' ] ).toBe( null )
        expect( answered[ 'documentId' ] ).toBe( null )
    } )


    it( 'T-C3: die Signatur nimmt keinen Dateinamen mehr entgegen, und basename kommt darin nicht vor', async () => {
        // Vergleichsmenge: der Quelltext der Methode, von ihrer Signatur bis zur naechsten static-Zeile.
        // Der falsche Nachschlag ist hier nicht verboten, er ist unaussprechlich geworden.
        const source = await readMemoViewSource()
        const start = source.indexOf( 'static resolveMemoName( {' )

        expect( start ).toBeGreaterThan( -1 )

        const body = source.slice( start, source.indexOf( '\n    static ', start + 20 ) )

        expect( body.length ).toBeGreaterThan( 200 )
        expect( body ).toContain( 'documentId' )
        expect( body ).toContain( 'absolutePath' )
        expect( body ).not.toContain( 'basename(' )
        expect( body ).not.toContain( 'selectedRevision' )
    } )
} )


describe( 'PRD-37 — die Block-Text-Regel des Servers', () => {

    it( 'T-J: die sieben Bauformen — Absatz, Listenpunkt, Ueberschrift, Blockzitat, Tabellenzelle, pre, Kurztext', async () => {
        // Vergleichsmenge: 1 Vorlage mit 7 benannten Bauformen. Der pre-Block und der Zwei-Zeichen-Text
        // MUESSEN fehlen — wer nur Absaetze prueft, prueft den leichten Fall.
        const markdown = [
            'Ein ganz normaler Absatz mit **fett** und `code`.',
            '',
            '- Ein Listenpunkt mit genug Text',
            '',
            '## Eine Ueberschrift der Ebene zwei',
            '',
            '> Ein Blockzitat mit ausreichend Text',
            '',
            '| Kopf A | Kopf B |',
            '|---|---|',
            '| Zelle eins | Zelle zwei |',
            '',
            '```',
            'ein pre-Block der NICHT auftauchen darf',
            '```',
            '',
            'ab'
        ].join( '\n' )

        const { blockTexts } = await MemoView.collectBlockTexts( { markdown } )

        expect( Array.isArray( blockTexts ) ).toBe( true )
        expect( blockTexts ).toContain( 'Ein ganz normaler Absatz mit fett und code.' )
        expect( blockTexts ).toContain( 'Ein Listenpunkt mit genug Text' )
        expect( blockTexts ).toContain( 'Eine Ueberschrift der Ebene zwei' )
        expect( blockTexts ).toContain( 'Ein Blockzitat mit ausreichend Text' )
        expect( blockTexts ).toContain( 'Kopf A' )
        expect( blockTexts ).toContain( 'Zelle zwei' )
        expect( blockTexts.some( ( text ) => text.includes( 'pre-Block' ) ) ).toBe( false )
        expect( blockTexts ).not.toContain( 'ab' )
        expect( blockTexts.length ).toBe( 8 )
    } )


    it( 'T-J2: die Tag-Menge des Servers ist DIESELBE wie der Selektor des Clients', async () => {
        // Vergleichsmenge: der Selektor aus app.client.mjs (10 Eintraege) gegen die Tag-Liste in
        // MemoView.extractBlockTexts. `blockquote > p` ist eine Teilmenge von `p`, deshalb traegt die
        // Server-Liste die 9 verschiedenen Tags. Weichen die beiden Regeln ab, entstehen genau die
        // systematischen Falsch-Gruen-Markierungen, gegen die app.client.mjs gebaut wurde.
        const client = await readEmittedScript()
        const server = await readMemoViewSource()
        const selectorMatch = client.match( /var diffBlockSelector = '([^']+)'/ )

        expect( selectorMatch ).not.toBe( null )

        const clientTags = selectorMatch[ 1 ]
            .split( ',' )
            .map( ( part ) => part.trim().split( '>' ).pop().trim() )
        const uniqueClientTags = [ ...new Set( clientTags ) ].sort()
        const serverMatch = server.match( /const blockTags = \[([^\]]+)\]/ )

        expect( serverMatch ).not.toBe( null )

        const serverTags = serverMatch[ 1 ]
            .split( ',' )
            .map( ( part ) => part.trim().replace( /'/g, '' ) )
            .filter( ( part ) => part.length > 0 )
            .sort()

        expect( uniqueClientTags.length ).toBe( 10 )
        expect( serverTags ).toEqual( uniqueClientTags )
    } )


    it( 'T-J3 (Vakuum-Riegel): ein veraenderter Block erzeugt eine Differenz', async () => {
        // Ohne diesen Fall misst T-J eine Vorrichtung, die gar keine Abweichung melden KANN.
        const base = 'Ein Absatz mit genug Text fuer die Regel.'
        const changed = 'Ein GEAENDERTER Absatz mit genug Text fuer die Regel.'
        const one = await MemoView.collectBlockTexts( { 'markdown': base } )
        const two = await MemoView.collectBlockTexts( { 'markdown': changed } )
        const onlyInTwo = two[ 'blockTexts' ].filter( ( text ) => one[ 'blockTexts' ].includes( text ) !== true )

        expect( one[ 'blockTexts' ] ).toEqual( [ base ] )
        expect( onlyInTwo.length ).toBe( 1 )
    } )


    it( 'T-J4: Verschachtelung, Entitaeten und .diff-banner folgen der Browser-Regel', async () => {
        // Vergleichsmenge: 3 Faelle, die eine naive Umsetzung falsch macht — ein Listenpunkt traegt den
        // Text seiner Kinder (textContent), Entitaeten kommen DEKODIERT an (der Browser dekodiert sie
        // auch), und ein Block innerhalb von .diff-banner zaehlt nicht mit.
        const nested = MemoView.extractBlockTexts( { 'html': '<ul><li>Aussen <em>innen</em> Ende</li></ul>' } )
        const entity = MemoView.extractBlockTexts( { 'html': '<p>Fu&auml;nf &amp; mehr &#8212; Ende</p>' } )
        const banner = MemoView.extractBlockTexts( { 'html': '<div class="diff-banner"><p>Bannertext bleibt draussen</p></div><p>Dieser Absatz zaehlt</p>' } )

        expect( nested[ 'blockTexts' ] ).toEqual( [ 'Aussen innen Ende' ] )
        expect( entity[ 'blockTexts' ] ).toEqual( [ 'Fuänf & mehr — Ende' ] )
        expect( banner[ 'blockTexts' ] ).toEqual( [ 'Dieser Absatz zaehlt' ] )
    } )
} )


describe( 'PRD-37 — der Client: der Ansichts-Zustand gehoert dem Leser', () => {
    let client = ''


    beforeAll( async () => {
        client = await readEmittedScript()
    } )


    it( 'T-K: die content-Nachricht ueberschreibt showDiff NICHT mehr', () => {
        // Vergleichsmenge: alle Zuweisungen an showDiff im Client-Bundle. Vor dieser Aenderung stand in
        // dem content-Zweig `showDiff = true` / `showDiff = false` — die Entscheidung des Lesers hielt
        // exakt bis zum naechsten Klick. Gezaehlt werden die Zuweisungen, nicht zugesichert.
        const assignments = client.match( /^\s*showDiff = /gm ) || []
        const initial = client.match( /let showDiff = (true|false)/ )

        expect( initial ).not.toBe( null )
        expect( initial[ 1 ] ).toBe( 'false' )

        const contentBranchStart = client.indexOf( "if( data.type === 'content' )" )
        const contentBranchEnd = client.indexOf( "if( data.type === 'diff' )", contentBranchStart )

        expect( contentBranchStart ).toBeGreaterThan( -1 )
        expect( contentBranchEnd ).toBeGreaterThan( contentBranchStart )

        const contentBranch = client.slice( contentBranchStart, contentBranchEnd )

        expect( contentBranch.length ).toBeGreaterThan( 500 )
        expect( contentBranch ).not.toMatch( /showDiff = (true|false)/ )
        expect( contentBranch ).toContain( 'diffAvailable = data.diffAvailable === true' )
        expect( assignments.length ).toBeGreaterThan( 0 )
    } )


    it( 'T-K2: der Umschalter wird auf die ANKUENDIGUNG angeboten, nicht auf eine Nutzlast', () => {
        const start = client.indexOf( 'function bindDiffToggle()' )

        expect( start ).toBeGreaterThan( -1 )

        const body = client.slice( start, start + 900 )

        expect( body ).toContain( 'if( diffAvailable === true )' )
        expect( body ).not.toContain( 'if( currentDiff && currentDiff.hasDiff )' )
    } )


    it( 'T-L: renderDiffView nimmt die Menge, nicht den Rohtext — und markiert bei null NICHTS', () => {
        // Vergleichsmenge: der Rumpf von renderDiffView. `previousContent` darf im GESAMTEN Client-
        // Bundle nicht mehr vorkommen; die Markierung haengt an previousTextSet.size > 0, also markiert
        // eine nicht gebildete Menge (null -> leeres Set) keinen einzigen Block.
        const start = client.indexOf( 'var previousTextSet = new Set()' )

        expect( start ).toBeGreaterThan( -1 )

        const body = client.slice( start, start + 400 )

        expect( body ).toContain( 'Array.isArray( diff.previousBlockTexts )' )
        expect( client ).not.toContain( 'diff.previousContent' )
        expect( client ).toContain( 'if( previousTextSet.size > 0 )' )
    } )


    it( 'T-M: die Anfrage geht hoechstens einmal je Revision raus und traegt beide Kennungen', () => {
        const start = client.indexOf( 'function requestDiffIfNeeded()' )

        expect( start ).toBeGreaterThan( -1 )

        const body = client.slice( start, start + 900 )

        expect( body ).toContain( "type: 'requestDiff'" )
        expect( body ).toContain( 'documentId: currentDocumentId' )
        expect( body ).toContain( 'fileName: currentFileName' )
        expect( body ).toContain( 'if( requestedDiffKey === key ) { return false }' )
    } )
} )


describe( 'PRD-37 — am LAUFENDEN Server: Name unter Gleichzeitigkeit, Diff auf Anfrage', () => {
    let sandbox = ''
    let report = null
    let blocker = null


    beforeAll( async () => {
        await mkdir( join( repoRoot, '.test-tmp' ), { 'recursive': true } )
        sandbox = await mkdtemp( join( repoRoot, '.test-tmp', 'diff-on-demand-prd37-' ) )

        const root = join( sandbox, 'run' )
        const project = join( root, 'proj' )

        // Der Bestand ist auf die Mehrdeutigkeit hin gebaut, die N1 traegt: ZWEI Dokumente mit derselben
        // Revisions-Datei REV-01.md. Im echten Bestand sind das 367 von 385 Dokumenten.
        //   001-alpha — zwei volle Revisionen, hat also einen Vorgaenger
        //   002-beta  — zwei volle Revisionen, dieselben Dateinamen wie alpha
        //   003-solo  — GENAU EINE Revision, hat also KEINEN Vorgaenger (Vakuum-Riegel)
        const memos = [
            { 'dir': '001-alpha', 'files': { 'REV-01.md': '# alpha eins\n\nEin Absatz aus der ersten Fassung von alpha.\n', 'REV-02.md': '# alpha zwei\n\nEin Absatz aus der zweiten Fassung von alpha.\n' } },
            { 'dir': '002-beta', 'files': { 'REV-01.md': '# beta eins\n\nEin Absatz aus der ersten Fassung von beta.\n', 'REV-02.md': '# beta zwei\n\nEin Absatz aus der zweiten Fassung von beta.\n' } },
            { 'dir': '003-solo', 'files': { 'REV-01.md': '# solo eins\n\nEin Absatz ohne jeden Vorgaenger.\n' } }
        ]

        await Promise.all(
            memos.map( async ( memo ) => {
                const revisions = join( project, '.memo', 'memos', memo[ 'dir' ], 'revisions' )
                await mkdir( revisions, { 'recursive': true } )

                await Promise.all(
                    Object.keys( memo[ 'files' ] )
                        .map( ( fileName ) => writeFile( join( revisions, fileName ), memo[ 'files' ][ fileName ], 'utf8' ) )
                )
            } )
        )

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
                    'PRD37_PORT': String( CHILD_PORT ),
                    'PRD37_SRC': memoViewPath
                }
            }
        ).catch( ( error ) => {
            return { 'stdout': error[ 'stdout' ] === undefined ? '' : error[ 'stdout' ], 'stderr': error[ 'stderr' ] === undefined ? '' : error[ 'stderr' ] }
        } )

        const parts = String( answered[ 'stdout' ] ).split( '###PRD37###' )

        if( parts.length !== 3 ) {
            blocker = `kein Ergebnisblock — stderr: ${ String( answered[ 'stderr' ] ).slice( -800 ) }`

            return
        }

        report = JSON.parse( parts[ 1 ] )
    }, 180000 )


    afterAll( async () => {
        if( sandbox.length > 0 ) {
            await rm( sandbox, { 'recursive': true, 'force': true } )
        }
    } )


    it( 'Vakuum-Riegel: der Kindprozess hat ueberhaupt gemessen', () => {
        expect( blocker ).toBe( null )
        expect( report ).not.toBe( null )
        expect( report[ 'portCollision' ] ).toBe( false )
        expect( report[ 'documentCount' ] ).toBe( 3 )
        // Die Mehrdeutigkeit, um die es geht: REV-01.md kommt in DREI Dokumenten vor.
        expect( report[ 'rev01Documents' ] ).toBe( 3 )
    } )


    it( 'T-A: der Name kommt von DIESEM Dokument, auch wenn ein anderes dieselbe Revision ausgewaehlt hat', () => {
        // Vergleichsmenge: 2 Dokumente, dieselbe Revisions-Datei REV-01.md, und zwischen den beiden
        // Aufloesungen waehlt das ANDERE Dokument aus — genau der Zustand, den sechs gleichzeitige
        // Sockets erzeugen. Der alte Nachschlag lieferte hier den fremden Namen oder null.
        expect( report[ 'byDocumentId' ] ).toEqual( { 'proj--001-alpha': '001-alpha', 'proj--002-beta': '002-beta' } )
        expect( report[ 'afterForeignSelection' ] ).toEqual( { 'proj--001-alpha': '001-alpha', 'proj--002-beta': '002-beta' } )
    } )


    it( 'T-B: die Aufloesung ueber den vollen Pfad trifft bei zwei gleichnamigen Dateien das richtige Dokument', () => {
        expect( report[ 'byAbsolutePath' ] ).toEqual( { 'proj--001-alpha': '001-alpha', 'proj--002-beta': '002-beta' } )
        // und sie nennt zusaetzlich die Kennung, aus der der Client seine Anfrage bauen kann
        expect( report[ 'byAbsolutePathIds' ] ).toEqual( { 'proj--001-alpha': 'proj--001-alpha', 'proj--002-beta': 'proj--002-beta' } )
    } )


    it( 'T-D (Vakuum-Riegel): eine unbekannte Kennung und ein fremder Pfad liefern null', () => {
        // Ohne diesen Fall misst T-A eine Funktion, die immer irgendeinen Namen findet.
        expect( report[ 'unknownDocumentId' ] ).toBe( null )
        expect( report[ 'unknownAbsolutePath' ] ).toBe( null )
    } )


    it( 'T-E: die content-Nachricht traegt kein diff und kein previousContent, aber diffAvailable', () => {
        // Vergleichsmenge: 2 Staende — einer MIT Vorgaenger (alpha/REV-02) und einer OHNE (solo/REV-01).
        // Ausgegeben werden die Schluessel woertlich, nicht die Zusicherung.
        expect( report[ 'contentKeys' ] ).not.toContain( 'diff' )
        expect( report[ 'contentKeys' ] ).not.toContain( 'previousContent' )
        expect( report[ 'contentKeys' ] ).toContain( 'diffAvailable' )
        expect( report[ 'contentKeys' ] ).toContain( 'diffInfo' )
        expect( report[ 'diffAvailableWithPrevious' ] ).toBe( true )
        expect( report[ 'diffAvailableWithoutPrevious' ] ).toBe( false )
    } )


    it( 'T-F: requestDiff mit gueltiger Paarung liefert eine diff-Nachricht, die beide Kennungen echot', () => {
        expect( report[ 'validDiff' ][ 'type' ] ).toBe( 'diff' )
        expect( report[ 'validDiff' ][ 'documentId' ] ).toBe( 'proj--001-alpha' )
        expect( report[ 'validDiff' ][ 'fileName' ] ).toBe( 'REV-02.md' )
        expect( report[ 'validDiff' ][ 'hasDiff' ] ).toBe( true )
    } )


    it( 'T-G: eine fremde Paarung wird ABGEWIESEN und liefert nicht den Diff des zuletzt gewaehlten Dokuments', () => {
        // proj--003-solo traegt kein REV-02.md. Die alte Fehlerform waere gewesen, die Anfrage mit dem
        // zuletzt ausgewaehlten Dokument zu beantworten — hier also mit dem Diff von alpha.
        expect( report[ 'foreignDiff' ][ 'diff' ] ).toBe( null )
        expect( report[ 'foreignDiff' ][ 'reason' ] ).toContain( 'does not belong to' )
        expect( report[ 'foreignDiff' ][ 'documentId' ] ).toBe( 'proj--003-solo' )
    } )


    it( 'T-H: der Diff traegt previousBlockTexts und KEIN previousContent', () => {
        expect( report[ 'diffKeys' ] ).toContain( 'previousBlockTexts' )
        expect( report[ 'diffKeys' ] ).not.toContain( 'previousContent' )
        // die uebrigen Felder bleiben unveraendert
        expect( report[ 'diffKeys' ] ).toEqual( expect.arrayContaining( [ 'lines', 'removed', 'comparison', 'changedSections', 'hasDiff', 'previousFile', 'currentFullFile', 'skippedUpdates', 'continuity' ] ) )
    } )


    it( 'T-I: previousBlockTexts ist null ohne Vorgaenger — und ein nicht-leeres Array mit Vorgaenger', () => {
        // Positiv-Kontrolle direkt daneben: "nicht gebildet" und "leer gebildet" sind zwei Aussagen, und
        // ohne den zweiten Wert misst der erste eine Vorrichtung, die nie etwas findet.
        expect( report[ 'soloDiff' ][ 'diff' ] ).toBe( null )
        expect( report[ 'soloDiff' ][ 'reason' ] ).toBe( 'no previous full revision' )
        expect( Array.isArray( report[ 'previousBlockTexts' ] ) ).toBe( true )
        expect( report[ 'previousBlockTexts' ].length ).toBeGreaterThan( 0 )
        expect( report[ 'previousBlockTexts' ] ).toContain( 'Ein Absatz aus der ersten Fassung von alpha.' )
    } )


    it( 'T-N: requestDiff bewegt die prozessweite Auswahl NICHT', () => {
        // Eine Anfrage ist keine Auswahl. Waere sie eine, wuerde jedes Lesen eines Diffs die Auswahl
        // jedes anderen Dokuments loeschen (DocumentRegistry.mjs:549) — genau der Mechanismus, aus dem
        // die null-Haelfte von N1 entstand.
        expect( report[ 'selectionBeforeRequest' ] ).toBe( report[ 'selectionAfterRequest' ] )
        // Memo 081, WI-106 (PRD-38): der Erwartungswert ist gewachsen, weil eine Auswahl keine andere
        // mehr loescht — der Socket behaelt BEIDE Dokumente, die dieser Fall gewaehlt hat. Frueher
        // stand hier genau EINES, weil jede neue Auswahl die uebrigen geloescht hat; das war der
        // Defekt. Auf ein exaktes Mengen-Gleichheits-Urteil wird bewusst verzichtet: die Auto-Auswahl
        // beim Verbindungsaufbau (resolveAutoSelectTarget, neuestes aktives Dokument) faellt bei drei
        // im selben Millisekunden-Fenster geschriebenen Wegwerf-Memos nicht immer gleich aus —
        // gemessen in zwei Laeufen einmal MIT und einmal OHNE proj--003-solo. Der Kern des Falls
        // (vorher === nachher) steht unveraendert darueber.
        expect( report[ 'selectionAfterRequest' ] ).toContain( 'proj--001-alpha' )
        expect( report[ 'selectionAfterRequest' ] ).toContain( 'proj--002-beta' )
    } )
} )


// Der Kind-Prozess. Wird zur Laufzeit in den Wegwerf-Baum geschrieben, nie eine vierte verfolgte Datei.
// Er startet das ECHTE Server-Modul dieses Worktrees, misst ueber die Leitung UND im selben Prozess,
// druckt EINEN JSON-Block zwischen Markierungen und beendet sich — was den Port wieder freigibt.
const harnessSource = `import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import { WebSocket } from 'ws'

const PORT = Number( process.env[ 'PRD37_PORT' ] )
const SRC = process.env[ 'PRD37_SRC' ]
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

// Eine Verbindung, die eine Nachricht schickt und auf die erste Antwort EINES Typs wartet.
const ask = ( socket, payload, wanted ) => {
    return new Promise( ( done ) => {
        const timer = setTimeout( () => { socket.off( 'message', onMessage ); done( null ) }, 8000 )

        const onMessage = ( raw ) => {
            const msg = JSON.parse( raw.toString() )
            if( msg[ 'type' ] !== wanted ) { return }
            clearTimeout( timer )
            socket.off( 'message', onMessage )
            done( msg )
        }

        socket.on( 'message', onMessage )
        socket.send( JSON.stringify( payload ) )
    } )
}

const main = async () => {
    const collision = await probe()
    const report = { 'portCollision': collision, 'documentCount': 0 }

    if( collision === true ) {
        process.stdout.write( '###PRD37###' + JSON.stringify( report ) + '###PRD37###' )
        process.exit( 0 )
    }

    const { MemoView } = await import( SRC )
    await MemoView.startServer( { 'port': PORT } )

    const listed = await ( await fetch( base + '/api/documents' ) ).json()
    const documents = listed[ 'documents' ] || []
    report[ 'documentCount' ] = documents.length
    report[ 'rev01Documents' ] = documents.filter( ( doc ) => ( doc[ 'revisions' ] || [] ).some( ( rev ) => rev[ 'fileName' ] === 'REV-01.md' ) ).length

    const byId = documents.reduce( ( acc, doc ) => { acc[ doc[ 'documentId' ] ] = doc; return acc }, {} )
    const alpha = byId[ 'proj--001-alpha' ]
    const beta = byId[ 'proj--002-beta' ]

    // IM SELBEN PROZESS: hier lebt die Registrierung, also sind die oeffentlichen Statics hier messbar.
    report[ 'byDocumentId' ] = {
        'proj--001-alpha': MemoView.resolveMemoName( { 'documentId': 'proj--001-alpha' } )[ 'memoName' ],
        'proj--002-beta': MemoView.resolveMemoName( { 'documentId': 'proj--002-beta' } )[ 'memoName' ]
    }

    const alphaRev01 = resolve( alpha[ 'memoPath' ], 'REV-01.md' )
    const betaRev01 = resolve( beta[ 'memoPath' ], 'REV-01.md' )

    report[ 'byAbsolutePath' ] = {
        'proj--001-alpha': MemoView.resolveMemoName( { 'absolutePath': alphaRev01 } )[ 'memoName' ],
        'proj--002-beta': MemoView.resolveMemoName( { 'absolutePath': betaRev01 } )[ 'memoName' ]
    }
    report[ 'byAbsolutePathIds' ] = {
        'proj--001-alpha': MemoView.resolveMemoName( { 'absolutePath': alphaRev01 } )[ 'documentId' ],
        'proj--002-beta': MemoView.resolveMemoName( { 'absolutePath': betaRev01 } )[ 'documentId' ]
    }

    // Der Kern von N1: eine FREMDE Auswahl laeuft dazwischen. Sie loescht die Auswahl jedes anderen
    // Dokuments — die Aufloesung muss trotzdem beide Namen richtig liefern.
    const socket = new WebSocket( 'ws://127.0.0.1:' + PORT + '/' )
    await new Promise( ( ok ) => socket.on( 'open', ok ) )
    // Der Verbindungsaufbau schickt selbst eine content-Nachricht (Auto-Auswahl). Ohne dieses Abwarten
    // faengt die erste Frage unten DIESE Antwort ab, und jede folgende Messung ist um eins verschoben —
    // gemessen: diffAvailable wurde dann von der falschen Revision berichtet.
    await new Promise( ( ok ) => setTimeout( ok, 3000 ) )
    await ask( socket, { 'type': 'selectRevision', 'documentId': 'proj--002-beta', 'fileName': 'REV-01.md' }, 'content' )

    report[ 'afterForeignSelection' ] = {
        'proj--001-alpha': MemoView.resolveMemoName( { 'absolutePath': alphaRev01 } )[ 'memoName' ],
        'proj--002-beta': MemoView.resolveMemoName( { 'absolutePath': betaRev01 } )[ 'memoName' ]
    }

    report[ 'unknownDocumentId' ] = MemoView.resolveMemoName( { 'documentId': 'proj--999-gibtsnicht' } )[ 'memoName' ]
    report[ 'unknownAbsolutePath' ] = MemoView.resolveMemoName( { 'absolutePath': resolve( alpha[ 'memoPath' ], 'REV-77.md' ) } )[ 'memoName' ]

    // Ueber die Leitung: die content-Nachricht mit und ohne Vorgaenger.
    const withPrevious = await ask( socket, { 'type': 'selectRevision', 'documentId': 'proj--001-alpha', 'fileName': 'REV-02.md' }, 'content' )
    report[ 'contentKeys' ] = Object.keys( withPrevious )
    report[ 'diffAvailableWithPrevious' ] = withPrevious[ 'diffAvailable' ]
    report[ 'contentMemoName' ] = withPrevious[ 'memoName' ]

    // Memo 081, WI-106 (PRD-38): die Auswahl ist nicht mehr prozessweit, also gibt es sie in der
    // REST-Antwort nicht mehr — ein REST-Aufruf hat keinen Betrachter. Die AUSSAGE dieses Falls ist
    // unveraendert ("eine Diff-Anfrage bewegt die Auswahl nicht"); sie wird jetzt an der Flaeche
    // gemessen, die die Auswahl heute traegt: dem documentList dieses Sockets. Ein ausdrueckliches
    // requestProjectScope erzwingt die Antwort auch bei unveraenderten Bytes.
    const socketSelection = async () => {
        const list = await ask( socket, { 'type': 'requestProjectScope', 'projectIds': [ 'proj' ] }, 'documentList' )

        return Object.keys( list[ 'tree' ] )
            .reduce( ( acc, projectId ) => acc.concat( list[ 'tree' ][ projectId ][ 'memos' ] || [] ), [] )
            .filter( ( doc ) => doc[ 'selectedRevision' ] !== null )
            .map( ( doc ) => doc[ 'documentId' ] )
            .sort()
            .join( ',' )
    }

    report[ 'selectionBeforeRequest' ] = await socketSelection()

    const validDiff = await ask( socket, { 'type': 'requestDiff', 'documentId': 'proj--001-alpha', 'fileName': 'REV-02.md' }, 'diff' )
    report[ 'validDiff' ] = { 'type': validDiff[ 'type' ], 'documentId': validDiff[ 'documentId' ], 'fileName': validDiff[ 'fileName' ], 'hasDiff': validDiff[ 'diff' ][ 'hasDiff' ] }
    report[ 'diffKeys' ] = Object.keys( validDiff[ 'diff' ] )
    report[ 'previousBlockTexts' ] = validDiff[ 'diff' ][ 'previousBlockTexts' ]

    report[ 'selectionAfterRequest' ] = await socketSelection()

    const foreign = await ask( socket, { 'type': 'requestDiff', 'documentId': 'proj--003-solo', 'fileName': 'REV-02.md' }, 'diff' )
    report[ 'foreignDiff' ] = { 'diff': foreign[ 'diff' ], 'reason': foreign[ 'reason' ], 'documentId': foreign[ 'documentId' ] }

    const solo = await ask( socket, { 'type': 'selectRevision', 'documentId': 'proj--003-solo', 'fileName': 'REV-01.md' }, 'content' )
    report[ 'diffAvailableWithoutPrevious' ] = solo[ 'diffAvailable' ]

    const soloDiff = await ask( socket, { 'type': 'requestDiff', 'documentId': 'proj--003-solo', 'fileName': 'REV-01.md' }, 'diff' )
    report[ 'soloDiff' ] = { 'diff': soloDiff[ 'diff' ], 'reason': soloDiff[ 'reason' ] }

    socket.close()

    process.stdout.write( '###PRD37###' + JSON.stringify( report ) + '###PRD37###' )
    process.exit( 0 )
}

main().catch( ( error ) => {
    process.stderr.write( String( error && error.stack ? error.stack : error ) )
    process.exit( 1 )
} )
`
