// M082-09-07 (Memo 082 Kap 20a, Cluster E/F, WI-121) — ein angezeigter Zustand ist der gespeicherte.
//
// DER ZUSCHNITT IST GEAENDERT, und die Begruendung gehoert an den Anfang der Datei, weil sie bestimmt,
// wogegen hier gemessen wird. Symptom 5 ("Ansichtswechsel saet neu") ist an diesem Bau WIDERLEGT: der
// Wechsel liest das Fragen-Schema gar nicht neu, also kann die Optionsliste sich dabei nicht aendern.
// Der echte Defekt ist die Kehrseite — Fall V3 von M082-09-02: die RUNDMELDUNG saet neu, und der
// Speicher zieht nicht nach. Option 6 gewaehlt, Liste von 12 auf 6 Zeilen verkuerzt, danach zeigt die
// Karte KEINE Auswahl, waehrend der Speicher weiter `selected [6], touched true` haelt.
//
// Der Folgeschaden ist dauerhaft: beim naechsten Laden verwirft die Gueltigkeitssperre in
// seedQuestionState den Eintrag GANZ. Deshalb pruefen AB-2b und AB-2c nicht nur, dass der Wegfall
// sichtbar wird, sondern auch, dass der Speicher nachgezogen wird — eine Reparatur, die nur die Bindung
// umstellt, laesst den verwaisten Eintrag stehen.

import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extractFunctions, readEmittedScript } from '../helpers/extractFunction.mjs'


const HERE = dirname( fileURLToPath( import.meta.url ) )
const REPO = resolve( HERE, '..', '..' )
const STORE_PATH = resolve( REPO, 'src', 'QuestionStateStore.mjs' )


// Die vier eingeschobenen Zeilen, die das Widget IMMER anhaengt (DocumentRegistry). Sie stehen hier,
// damit jede Vergleichsmenge unten die GERENDERTE Liste meint und nicht die deklarierte — genau der
// Unterschied, der M082-09-02 einen Lauf gekostet hat (4 -> 2 deklariert bewegt nur 8 -> 6 gerendert).
const INJECTED = [
    { kind: 'custom', key: 'custom', label: 'ablehnen' },
    { kind: 'topic', key: 'topic', label: 'Über das Topic springen' },
    { kind: 'reframe', key: 'reframe', label: 'Frage neu formulieren' },
    { kind: 'reoption', key: 'reoption', label: 'Antwortmoeglichkeiten neu formulieren' }
]

const authorOptions = ( keys ) => keys.map( ( key ) => ( { kind: 'option', key: key, label: `Option ${ key }` } ) )

const questionWith = ( { id, keys, typ } ) => {
    return {
        id: id,
        title: `Frage ${ id }`,
        frage: `Welche Option gilt fuer ${ id }?`,
        typ: typ || 'single',
        status: 'open',
        preselected: [],
        aiRecommendation: 'A) die erste Option.',
        options: authorOptions( keys ).concat( INJECTED )
    }
}

const liveState = ( { selected, touched } ) => {
    return { selected: selected.slice(), preselected: [], custom: [], added: false, addedText: null, rejected: false, touched: touched === true }
}


describe( 'M082-09-07 (WI-121) — die Bindung haengt an der Frage-/Options-Kennung', () => {

    // ---------------------------------------------------------------------------------------------
    // AB-1 — eine VERSCHOBENE Option verliert die Auswahl nicht.
    // Vergleichsmenge: 1 Frage mit N gerenderten Optionen, N wird protokolliert und ist > 2.
    // ---------------------------------------------------------------------------------------------
    it( 'AB-1: eine verschobene Option behaelt die Auswahl — sie folgt der Option, nicht der Position', async () => {
        const { optionIdentitiesOf, captureSelectedKeys, rebindQuestionSelections } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections' ]
        )

        const before = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H' ] } )
        // Eine NEUE Option vorne eingeschoben: G wandert von Position 6 auf Position 7.
        const after = questionWith( { id: 'F1', keys: [ 'Z', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H' ] } )

        const N = optionIdentitiesOf( before.options ).compared
        // Die Vergleichsmenge wird genannt UND geprueft: bei zwei Optionen waere eine Verschiebung von
        // einer Vertauschung nicht zu unterscheiden.
        expect( N ).toBe( 12 )
        expect( N ).toBeGreaterThan( 2 )
        expect( optionIdentitiesOf( after.options ).compared ).toBe( 13 )

        const map = { F1: liveState( { selected: [ 6 ], touched: true } ) }
        captureSelectedKeys( map, [ before ] )

        expect( map.F1.selectedKeys ).toEqual( [ 'option:G' ] )

        const report = rebindQuestionSelections( map, [ after ] )

        expect( map.F1.selected ).toEqual( [ 7 ] )
        expect( map.F1.selectedKeys ).toEqual( [ 'option:G' ] )
        expect( report.dropped ).toEqual( [] )
        expect( report.moved ).toBe( 1 )
        expect( report.changed ).toBe( 1 )
        // Vakuum-Sperre: der Lauf hat wirklich etwas verglichen.
        expect( report.compared ).toBe( 1 )
        expect( report.rebound ).toBe( 1 )
    } )


    // Die Gegenrichtung von AB-1: eine UNVERAENDERTE Liste bewegt nichts. Ohne diese Richtung waere eine
    // Fassung, die jede Auswahl irgendwohin schiebt, von der richtigen nicht zu unterscheiden.
    it( 'AB-1 Gegenrichtung: eine unveraenderte Liste laesst die Auswahl exakt stehen', async () => {
        const { captureSelectedKeys, rebindQuestionSelections } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections' ]
        )

        const q = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H' ] } )
        const map = { F1: liveState( { selected: [ 6 ], touched: true } ) }

        captureSelectedKeys( map, [ q ] )
        const report = rebindQuestionSelections( map, [ q ] )

        expect( map.F1.selected ).toEqual( [ 6 ] )
        expect( report.changed ).toBe( 0 )
        expect( report.moved ).toBe( 0 )
        expect( report.dropped ).toEqual( [] )
        expect( report.compared ).toBe( 1 )
    } )


    // Optionen HINZUGEKOMMEN, aber hinter der Auswahl: die Position bleibt, die Auswahl auch.
    it( 'AB-1 dritte Lage: hinten angehaengte Optionen lassen die Auswahl unveraendert', async () => {
        const { captureSelectedKeys, rebindQuestionSelections } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections' ]
        )

        const before = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C' ] } )
        const after = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C', 'D', 'E' ] } )
        const map = { F1: liveState( { selected: [ 1 ], touched: true } ) }

        captureSelectedKeys( map, [ before ] )
        const report = rebindQuestionSelections( map, [ after ] )

        expect( map.F1.selected ).toEqual( [ 1 ] )
        expect( report.changed ).toBe( 0 )
        expect( report.dropped ).toEqual( [] )
    } )


    // ---------------------------------------------------------------------------------------------
    // AB-2 — eine ENTFERNTE Option faellt SICHTBAR weg, die uebrigen bleiben.
    // Das ist der Kern des Befunds: heute loest genau dieser Fall die stille Neu-Aussaat aus.
    // ---------------------------------------------------------------------------------------------
    it( 'AB-2: eine entfernte Option faellt weg, die uebrigen Auswahlen bleiben, und der Wegfall ist benannt', async () => {
        const { captureSelectedKeys, rebindQuestionSelections } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections' ]
        )

        // Multi, damit "die uebrigen bleiben" ueberhaupt eine Vergleichsmenge hat: zwei Auswahlen, eine
        // davon faellt weg. Bei einer einzigen Auswahl waere "die uebrigen" die leere Menge.
        const before = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H' ], typ: 'multi' } )
        const after = questionWith( { id: 'F1', keys: [ 'A', 'B' ], typ: 'multi' } )
        const map = { F1: liveState( { selected: [ 1, 6 ], touched: true } ) }

        captureSelectedKeys( map, [ before ] )

        expect( map.F1.selectedKeys ).toEqual( [ 'option:B', 'option:G' ] )

        const report = rebindQuestionSelections( map, [ after ] )

        // Die verbleibende Auswahl steht noch — und sie steht an der richtigen Stelle.
        expect( map.F1.selected ).toEqual( [ 1 ] )
        expect( map.F1.selectedKeys ).toEqual( [ 'option:B' ] )
        // Der Wegfall ist BENANNT, mit Frage und Option.
        expect( report.dropped ).toEqual( [ { question: 'F1', option: 'option:G', title: 'Frage F1' } ] )
        expect( report.changed ).toBe( 1 )
        // Kein stiller Wegfall und KEINE Neu-Aussaat: der Eintrag ist derselbe, nur um eine Auswahl aermer.
        expect( map.F1.touched ).toBe( true )
        expect( report.legacy ).toBe( 0 )
        expect( report.compared ).toBe( 1 )
    } )


    // AB-2b — das, was die alte Gueltigkeitssperre an derselben Lage getan haette. Der Vergleich ist die
    // eigentliche Aussage des Auftrags, und er wird hier gegen die ECHTE Funktion gefahren, nicht gegen
    // eine Beschreibung von ihr.
    it( 'AB-2b: ohne Namen verwirft die Gueltigkeitssperre den GANZEN Eintrag — mit Namen nur die eine Auswahl', async () => {
        const { seedQuestionState, captureSelectedKeys, rebindQuestionSelections } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections', 'seedQuestionState' ]
        )

        const before = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H' ] } )
        const after = questionWith( { id: 'F1', keys: [ 'A', 'B' ] } )

        // Der ALTE Weg: ohne Namen greift die Sperre, weil 6 nicht mehr passt.
        const legacyMap = { F1: liveState( { selected: [ 6 ], touched: true } ) }
        legacyMap.F1.custom = [ 'eigener Eintrag des Nutzers' ]
        const legacySeeded = seedQuestionState( [ after ], legacyMap )[ 0 ]

        expect( legacySeeded.selected ).toEqual( [] )
        expect( legacySeeded.touched ).toBe( false )
        // Und das ist der Preis, der bisher unsichtbar war: der eigene Eintrag geht mit.
        expect( legacySeeded.custom ).toEqual( [] )

        // Der NEUE Weg: derselbe Ausgangszustand, aber vorher benannt und nachgebunden.
        const boundMap = { F1: liveState( { selected: [ 6 ], touched: true } ) }
        boundMap.F1.custom = [ 'eigener Eintrag des Nutzers' ]
        captureSelectedKeys( boundMap, [ before ] )
        const report = rebindQuestionSelections( boundMap, [ after ] )
        const boundSeeded = seedQuestionState( [ after ], boundMap )[ 0 ]

        expect( report.dropped.length ).toBe( 1 )
        expect( boundSeeded.selected ).toEqual( [] )
        // Der Unterschied: touched und der eigene Eintrag ueberleben, die Lage ist gemeldet.
        expect( boundSeeded.touched ).toBe( true )
        expect( boundSeeded.custom ).toEqual( [ 'eigener Eintrag des Nutzers' ] )
    } )


    // AB-2c — der VERWAISTE Speicher-Eintrag. Ohne diesen Nachweis waere die Reparatur halb: die Ansicht
    // zoege nach, der Speicher hielte weiter einen Index auf eine Option, die es nicht mehr gibt.
    it( 'AB-2c: der nachgezogene Zustand erzeugt einen Datensatz OHNE den verwaisten Index', async () => {
        const script = await readEmittedScript()
        const { buildQuestionStateRecords, captureSelectedKeys, rebindQuestionSelections } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections', 'isConfirmedAnswer', 'buildQuestionStateRecords' ]
        )

        const before = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H' ] } )
        const after = questionWith( { id: 'F1', keys: [ 'A', 'B' ] } )
        const map = { F1: liveState( { selected: [ 6 ], touched: true } ) }

        captureSelectedKeys( map, [ before ] )
        rebindQuestionSelections( map, [ after ] )

        // buildQuestionStateRecords liest questionNav — hier gestellt, wie der Klient es zur Schreibzeit
        // haelt: die NEUEN Fragen und der nachgebundene Zustand.
        globalThis.questionNav = { questions: [ after ], state: [ map.F1 ] }
        const built = buildQuestionStateRecords()
        delete globalThis.questionNav

        expect( built.seen ).toBe( 1 )
        expect( built.skipped ).toBe( 0 )
        // Der Waise ist weg: kein Index 6 mehr, und die Namen stehen daneben.
        expect( built.entries.F1.intent.selected ).toEqual( [] )
        expect( built.entries.F1.intent.selectedKeys ).toEqual( [] )
        expect( built.entries.F1.intent.touched ).toBe( true )

        // Und der Schreibweg wird wirklich angestossen: der Renderer ruft persistQuestionState genau dann,
        // wenn etwas nachgezogen wurde. Gegen die Quelle gemessen, weil renderQuestionWidgets das DOM
        // braucht und hier nicht laufen kann.
        expect( script ).toContain( 'if( rebind.changed > 0 || rebind.dropped.length > 0 ) { persistQuestionState() }' )
    } )


    // ---------------------------------------------------------------------------------------------
    // AB-3 — Zaehler und Felder stimmen ueberein. Drei Zahlen, alle drei genannt.
    // ---------------------------------------------------------------------------------------------
    it( 'AB-3: Zaehler, gerenderte Karten und Traeger-Bestand zaehlen dieselbe Menge', async () => {
        const { openQuestionsOf, countQuestionsOf, seedQuestionState, buildQuestionStateRecords } = await extractFunctions(
            [ 'openQuestionsOf', 'countQuestionsOf', 'seedQuestionState', 'isConfirmedAnswer', 'optionIdentityOf', 'optionIdentitiesOf', 'buildQuestionStateRecords' ]
        )

        // EIN benanntes Dokument: die Fixture-Revision 900-p9-prd02-fixture/REV-01 in der Form, in der
        // sie der Server ausliefert — zwei offene Fragen, eine beantwortete.
        const dokument = '900-p9-prd02-fixture/REV-01'
        const schema = [
            questionWith( { id: 'F1', keys: [ 'A', 'B', 'C' ] } ),
            questionWith( { id: 'F2', keys: [ 'A', 'B' ] } ),
            { ...questionWith( { id: 'F3', keys: [ 'A', 'B' ] } ), status: 'answered' }
        ]

        const open = openQuestionsOf( schema )
        const zaehler = countQuestionsOf( schema ).open
        const karten = open.length

        globalThis.questionNav = { questions: open, state: seedQuestionState( open, {} ) }
        const traeger = buildQuestionStateRecords().seen
        delete globalThis.questionNav

        // Alle drei Zahlen stehen im Protokoll, und M > 0 — bei null offenen Fragen waeren drei Nullen
        // trivial gleich.
        expect( { dokument: dokument, zaehler: zaehler, karten: karten, traeger: traeger } ).toEqual(
            { dokument: dokument, zaehler: 2, karten: 2, traeger: 2 }
        )
        expect( zaehler ).toBeGreaterThan( 0 )
        expect( zaehler ).toBe( karten )
        expect( karten ).toBe( traeger )
    } )


    // AB-3 zweite Haelfte: die Quelle ist EINE. Gegen die Quelle gemessen, weil der Beleg eine Aussage
    // ueber die Kopplung zweier Anzeigestellen ist und nicht ueber einen Rueckgabewert.
    it( 'AB-3 Quelle: Kopfzeile und Popup-Etikett zaehlen dasselbe Schema, das die Karten rendern', async () => {
        const src = await readEmittedScript()

        // Die drei Stellen, die dieselbe Menge lesen muessen.
        expect( src ).toContain( 'var psView = viewedRevision ? countQuestionsOf( lastQuestionSchema ) : null' )
        expect( src ).toContain( 'var qView = countQuestionsOf( lastQuestionSchema )' )
        expect( src ).toContain( 'var open = openQuestionsOf( schema )' )

        // countQuestionsOf zaehlt ueber openQuestionsOf — dieselbe Bedingung, EINMAL geschrieben.
        expect( src.split( 'function openQuestionsOf(' ).length - 1 ).toBe( 1 )
        expect( src.split( "q.status === 'open'" ).length - 1 ).toBe( 1 )

        // Die EINE verbliebene Registry-Lesung ist NICHT eine zweite Quelle fuer denselben Wert: sie wird
        // gelesen, um die Differenz sichtbar zu machen. Gemessen, nicht behauptet.
        expect( src.split( 'memoEntry.doc.questions' ).length - 1 ).toBe( 1 )
        expect( src ).toContain( "divergence.id = 'qw-source-warn'" )
    } )


    // ---------------------------------------------------------------------------------------------
    // AB-4 — der Zwischenspeicher ist beim ERSTEN Aufruf richtig initialisiert.
    // Der erwartete Ausgangszustand ist hier BENANNT, sonst misst die Bedingung nichts.
    // ---------------------------------------------------------------------------------------------
    it( 'AB-4: der erste Aufruf legt den benannten Ausgangszustand an — nicht leer und nicht aus der Empfehlung', async () => {
        const { seedQuestionState } = await extractFunctions( [ 'seedQuestionState' ] )

        // Eine Frage MIT Vorauswahl, damit "nicht aus der Empfehlung" ueberhaupt pruefbar ist: ohne
        // Vorauswahl waere ein leeres `selected` mit jeder Fassung vereinbar.
        const q = { ...questionWith( { id: 'F1', keys: [ 'A', 'B', 'C' ] } ), preselected: [ 2 ] }

        // DER BENANNTE AUSGANGSZUSTAND, vollstaendig ausgeschrieben.
        const ERWARTET = {
            selected: [],
            preselected: [ 2 ],
            custom: [],
            added: false,
            addedText: null,
            rejected: false,
            touched: false
        }

        const state = seedQuestionState( [ q ], {} )[ 0 ]

        expect( state ).toEqual( ERWARTET )
        // Nicht leer: die Empfehlung ist da, aber als ANZEIGE.
        expect( state.preselected ).toEqual( [ 2 ] )
        // Nicht aus der Empfehlung: sie ist keine Entscheidung.
        expect( state.selected ).toEqual( [] )
        expect( state.touched ).toBe( false )
    } )


    // AB-4 zweite Haelfte: der Zwischenspeicher traegt den Zustand ueber einen Ansichtswechsel, und
    // `touched` bleibt, wie es war. Der Wechsel rendert aus lastQuestionSchema — dieselbe Menge, also
    // dieselben Namen, also dieselben Positionen.
    it( 'AB-4/S3: ein Ansichtswechsel traegt Zustand und touched unveraendert durch', async () => {
        const { captureSelectedKeys, rebindQuestionSelections, seedQuestionState } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections', 'seedQuestionState' ]
        )

        const q = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C' ] } )
        const gewaehlt = liveState( { selected: [ 1 ], touched: true } )
        const map = { F1: gewaehlt }

        // Der Wechsel ruft renderQuestionWidgets mit DEMSELBEN Schema — hier in genau der Reihenfolge des
        // Renderers nachgefahren.
        captureSelectedKeys( map, [ q ] )
        const report = rebindQuestionSelections( map, [ q ] )
        const nachWechsel = seedQuestionState( [ q ], map )[ 0 ]

        expect( nachWechsel.selected ).toEqual( [ 1 ] )
        expect( nachWechsel.touched ).toBe( true )
        expect( report.changed ).toBe( 0 )
        expect( report.dropped ).toEqual( [] )
    } )


    // ---------------------------------------------------------------------------------------------
    // AB-6 — eine Rundmeldung saet keinen Zustand neu. AB-7 ist die Gegenrichtung und steht daneben,
    // weil ohne sie eine Fassung, die Rundmeldungen IGNORIERT, von der richtigen nicht zu unterscheiden
    // waere.
    // ---------------------------------------------------------------------------------------------
    it( 'AB-6: eine Rundmeldung mit unveraendertem Schema laesst touched und Auswahl stehen', async () => {
        const { captureSelectedKeys, rebindQuestionSelections, seedQuestionState } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections', 'seedQuestionState' ]
        )

        const q = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H' ] } )
        const map = { F1: liveState( { selected: [ 6 ], touched: true } ) }

        captureSelectedKeys( map, [ q ] )
        rebindQuestionSelections( map, [ q ] )
        const nachher = seedQuestionState( [ q ], map )[ 0 ]

        expect( nachher.selected ).toEqual( [ 6 ] )
        expect( nachher.touched ).toBe( true )
    } )


    it( 'AB-7 Gegenrichtung: eine Rundmeldung mit einer NEUEN Frage bringt die neue Frage', async () => {
        const { captureSelectedKeys, rebindQuestionSelections, seedQuestionState } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections', 'seedQuestionState' ]
        )

        const f1 = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C' ] } )
        const f2 = questionWith( { id: 'F2', keys: [ 'A', 'B' ] } )
        const map = { F1: liveState( { selected: [ 1 ], touched: true } ) }

        captureSelectedKeys( map, [ f1 ] )
        const report = rebindQuestionSelections( map, [ f1, f2 ] )
        const state = seedQuestionState( [ f1, f2 ], map )

        // Die neue Frage ist da, frisch gesaet — und die alte ist unberuehrt.
        expect( state.length ).toBe( 2 )
        expect( state[ 0 ].selected ).toEqual( [ 1 ] )
        expect( state[ 0 ].touched ).toBe( true )
        expect( state[ 1 ].selected ).toEqual( [] )
        expect( state[ 1 ].touched ).toBe( false )
        // Die neue Frage hatte nichts nachzubinden — sie zaehlt nicht in die Vergleichsmenge.
        expect( report.compared ).toBe( 1 )
    } )


    // ---------------------------------------------------------------------------------------------
    // AB-8 — der Zwischenspeicher bleibt lokal. Die geprueften Wege werden GEZAEHLT, sonst meldet die
    // Pruefung ueber null Wegen grundlos gruen.
    // ---------------------------------------------------------------------------------------------
    it( 'AB-8: der per-Session-Zwischenspeicher hat keinen eigenen Schreibweg an Server oder Datenbank', async () => {
        const src = await readEmittedScript()

        // Die Schreibwege AUF den Zwischenspeicher: jede Zuweisung an questionNav.state.
        const schreibwege = src.split( 'questionNav.state = ' ).length - 1

        expect( schreibwege ).toBeGreaterThan( 0 )
        expect( schreibwege ).toBe( 1 )

        // Keiner dieser Wege fuehrt hinaus. Der EINZIGE Netzweg des Frage-Zustands ist der benannte,
        // bewusst dauerhafte Speicher aus Memo 081 WI-118 — und der schreibt ueber
        // buildQuestionStateRecords, nicht ueber den Zwischenspeicher.
        const netzwege = src.split( "/question-state'" ).length - 1 + src.split( "/question-state?" ).length - 1

        expect( netzwege ).toBeGreaterThan( 0 )
        expect( src ).toContain( "method: 'PUT'" )
        // Der Zwischenspeicher selbst geht nirgends hin: keine Zuweisung an questionNav.state steht in
        // einem fetch-Koerper, und der einzige PUT-Koerper nennt `entries`, nicht `questionNav`.
        expect( src ).toContain( 'body: JSON.stringify( { revisionId: rev, entries: built.entries } )' )
        expect( src.split( 'JSON.stringify( questionNav' ).length - 1 ).toBe( 0 )
    } )


    // ---------------------------------------------------------------------------------------------
    // DIE VAKUUM-PROBE — ein Abgleich ueber NULL Fragen meldet rot, nicht gruen.
    // ---------------------------------------------------------------------------------------------
    it( 'Vakuum: ein Nachbinden ueber null Fragen meldet seine leere Vergleichsmenge, nicht ein Bestehen', async () => {
        const { optionIdentitiesOf, rebindQuestionSelections } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections' ]
        )

        const report = rebindQuestionSelections( {}, [] )

        // `compared: 0` ist ein BEFUND. Die Bedingung prueft, dass die Zahl DA ist und 0 sagt — nicht,
        // dass "nichts weggefallen ist", denn das waere ueber einer Nullmenge trivial wahr.
        expect( report.compared ).toBe( 0 )
        expect( report.rebound ).toBe( 0 )

        // Dasselbe eine Ebene tiefer: eine leere Optionsliste nennt ihre Menge.
        const leer = optionIdentitiesOf( [] )

        expect( leer.compared ).toBe( 0 )
        expect( leer.identities ).toEqual( [] )
    } )


    // ---------------------------------------------------------------------------------------------
    // NICHT ENTSCHEIDBAR IST NICHT "KEINE AENDERUNG" — die Bauform, die in diesem Bestand jetzt zum
    // vierten Mal steht (mergeAnswerBlocks, checkTranscriptShrink, scanCodeFences, und hier).
    // ---------------------------------------------------------------------------------------------
    it( 'nicht entscheidbar: eine Liste ohne eindeutige Namen wird benannt, nicht geraten', async () => {
        const { optionIdentityOf, optionIdentitiesOf, captureSelectedKeys, rebindQuestionSelections } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'captureSelectedKeys', 'rebindQuestionSelections' ]
        )

        // Eine Option ohne brauchbaren Schluessel ist NICHT benennbar.
        expect( optionIdentityOf( { kind: 'option', key: '  ', label: 'ohne Schluessel' } ) ).toBe( null )
        // Die vier eingeschobenen tragen ihre Art als Namen.
        expect( optionIdentityOf( { kind: 'topic', key: 'topic', label: 'Über das Topic springen' } ) ).toBe( 'topic' )
        // Fehlende Art heisst `option` — der dokumentierte Default von VALID_OPTION_KINDS.
        expect( optionIdentityOf( { key: 'A', label: 'Erste' } ) ).toBe( 'option:A' )

        const ohneName = optionIdentitiesOf( [ { kind: 'option', key: 'A', label: 'Erste' }, { kind: 'option', key: '', label: 'Zweite' } ] )

        expect( ohneName.decidable ).toBe( false )
        expect( ohneName.code ).toBe( 'unnamed-option' )
        expect( ohneName.unnamed ).toBe( 1 )

        const doppelt = optionIdentitiesOf( [ { kind: 'option', key: 'A', label: 'Erste' }, { kind: 'option', key: 'A', label: 'noch einmal A' } ] )

        expect( doppelt.decidable ).toBe( false )
        expect( doppelt.code ).toBe( 'duplicate-option-name' )
        expect( doppelt.duplicated ).toEqual( [ 'option:A' ] )

        // Und der Rebind RAET nicht: er meldet die Frage mit ihrem Kode und laesst den Eintrag stehen.
        const vorher = questionWith( { id: 'F1', keys: [ 'A', 'B', 'C' ] } )
        const nachher = { ...vorher, options: [ { kind: 'option', key: 'A', label: 'Erste' }, { kind: 'option', key: 'A', label: 'noch einmal A' } ] }
        const map = { F1: liveState( { selected: [ 1 ], touched: true } ) }

        captureSelectedKeys( map, [ vorher ] )
        const report = rebindQuestionSelections( map, [ nachher ] )

        expect( report.undecidable ).toEqual( [ { question: 'F1', code: 'duplicate-option-name' } ] )
        expect( report.rebound ).toBe( 0 )
        // Der Eintrag ist UNVERAENDERT — nicht umgedeutet, nicht verworfen.
        expect( map.F1.selected ).toEqual( [ 1 ] )
    } )


    // ---------------------------------------------------------------------------------------------
    // S5 — ein Alt-Zustand OHNE Options-Kennung wird ERKANNT und nach heutiger Regel gelesen.
    // ---------------------------------------------------------------------------------------------
    it( 'S5: ein Alt-Zustand ohne Namen wird erkannt und der Index-Regel ueberlassen, nicht umgedeutet', async () => {
        const { stateFromStoredRecord, rebindQuestionSelections, seedQuestionState } = await extractFunctions(
            [ 'optionIdentityOf', 'optionIdentitiesOf', 'rebindQuestionSelections', 'stateFromStoredRecord', 'seedQuestionState' ]
        )

        const alt = stateFromStoredRecord( { intent: { selected: [ 6 ], custom: [], rejected: false, touched: true } } )

        // Kein Namensfeld — das ist die Erkennung, und sie haengt an der FORM des Datensatzes.
        expect( Object.keys( alt ).includes( 'selectedKeys' ) ).toBe( false )

        const neu = stateFromStoredRecord( { intent: { selected: [ 6 ], selectedKeys: [ 'option:G' ], custom: [], rejected: false, touched: true } } )

        expect( neu.selectedKeys ).toEqual( [ 'option:G' ] )

        // Ein Datensatz, dessen beide Haelften nicht zusammenpassen, gilt als namenlos — lieber die alte
        // Regel als eine Namensliste, die etwas anderes beschreibt als ihre Indizes.
        const halb = stateFromStoredRecord( { intent: { selected: [ 1, 6 ], selectedKeys: [ 'option:G' ], custom: [], rejected: false, touched: true } } )

        expect( Object.keys( halb ).includes( 'selectedKeys' ) ).toBe( false )

        // Der Alt-Zustand laeuft in die Gueltigkeitssperre — die heutige Regel, unveraendert.
        const kurz = questionWith( { id: 'F1', keys: [ 'A', 'B' ] } )
        const map = { F1: alt }
        const report = rebindQuestionSelections( map, [ kurz ] )

        expect( report.legacy ).toBe( 1 )
        expect( report.rebound ).toBe( 0 )
        expect( seedQuestionState( [ kurz ], map )[ 0 ].selected ).toEqual( [] )
    } )


    // ---------------------------------------------------------------------------------------------
    // Der Speicher nimmt die Namen an, prueft sie und lehnt einen halben Datensatz GANZ ab.
    // ---------------------------------------------------------------------------------------------
    it( 'der Speicher traegt die Namen durch einen echten Schreib-/Lese-Umlauf', async () => {
        const { QuestionStateStore } = await import( STORE_PATH )
        const memoDir = await mkdtemp( join( tmpdir(), 'p9-prd07-qstate-' ) )

        const written = await QuestionStateStore.write( {
            memoDir: memoDir,
            revisionId: 'REV-01',
            entries: {
                F1: { intent: { selected: [ 6 ], selectedKeys: [ 'option:G' ], custom: [], rejected: false, touched: true } },
                F2: { intent: { selected: [ 0 ], custom: [], rejected: false, touched: true } }
            }
        } )
        const read = await QuestionStateStore.read( { memoDir: memoDir, revisionId: 'REV-01' } )

        expect( written.status ).toBe( true )
        expect( written.written ).toBe( 2 )
        expect( read.seen ).toBe( 2 )
        // Die Namen kommen zurueck...
        expect( read.entries.F1.intent.selectedKeys ).toEqual( [ 'option:G' ] )
        // ...und ein Datensatz ohne Namen bleibt ohne, statt leere zu bekommen.
        expect( Object.keys( read.entries.F2.intent ).includes( 'selectedKeys' ) ).toBe( false )

        await rm( memoDir, { recursive: true, force: true } )
    } )


    it( 'der Speicher lehnt eine Namensliste ab, die nicht zu ihren Indizes passt', async () => {
        const { QuestionStateStore } = await import( STORE_PATH )
        const memoDir = await mkdtemp( join( tmpdir(), 'p9-prd07-qstate-' ) )

        const result = await QuestionStateStore.write( {
            memoDir: memoDir,
            revisionId: 'REV-01',
            entries: {
                F1: { intent: { selected: [ 1, 6 ], selectedKeys: [ 'option:G' ], custom: [], rejected: false, touched: true } },
                F2: { intent: { selected: [ 0 ], selectedKeys: [ 7 ], custom: [], rejected: false, touched: true } },
                F3: { intent: { selected: [ 0 ], selectedKeys: [ 'option:A' ], custom: [], rejected: false, touched: true } }
            }
        } )

        // Zwei abgelehnt, einer geschrieben — die Vergleichsmenge ist genannt und nicht null.
        expect( result.written ).toBe( 1 )
        expect( result.skipped ).toBe( 2 )
        // Jede Ablehnung traegt einen benannten Grund; nichts wird still verworfen.
        expect( result.messages.length ).toBe( 2 )
        expect( result.messages.join( ' ' ) ).toContain( 'selectedKeys' )

        await rm( memoDir, { recursive: true, force: true } )
    } )


    // ---------------------------------------------------------------------------------------------
    // Die Meldung existiert und wird an der Lage gebaut, nicht an einem Meldungstext.
    // ---------------------------------------------------------------------------------------------
    it( 'die Meldung wird aus dem maschinellen Kode gebaut und nur ueber einer nicht-leeren Menge gezeigt', async () => {
        const src = await readEmittedScript()

        expect( src ).toContain( 'function renderQuestionStateRebindNotice(' )
        expect( src ).toContain( "box.id = 'qw-state-rebind-warn'" )
        // Keine Meldung ueber einer leeren Menge — die Bedingung steht im Kode und wird hier gepinnt,
        // weil eine Warnung auf jedem Render eine ist, die niemand liest.
        expect( src ).toContain( 'if( dropped.length === 0 && undecidable.length === 0 ) { return }' )
        // Der Kode ist das Datum, der Satz die Anzeige — die beiden Kodes stehen genau einmal je Seite.
        expect( src.split( "'unnamed-option'" ).length - 1 ).toBe( 1 )
        expect( src.split( "'duplicate-option-name'" ).length - 1 ).toBe( 1 )
    } )
} )
