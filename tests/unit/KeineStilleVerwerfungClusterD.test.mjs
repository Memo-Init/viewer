import { describe, it, expect, beforeAll } from '@jest/globals'
import vm from 'node:vm'

import { extractFunctionSources, sliceDeclaration, readEmittedScript } from '../helpers/extractFunction.mjs'


// M082-09-04 (Memo 082 Kap 20, Cluster D — WI-118): keine stille Verwerfung mehr.
//
// Der Befund: das Antwortfeld wurde nur aus einer bestaetigten Antwort vorbelegt, und ein leeres Feld
// wurde beim Speichern uebersprungen — ohne ein Wort. Der Nutzer hat gewaehlt, gespeichert, und nichts
// ist passiert. PRD-22 (Memo 081) hat davon EINE Lage benannt (ausgewaehlt, nicht bestaetigt). Zwei
// weitere blieben still, und eine davon ist schlimmer als still: "Hinzufügen" ohne jede Auswahl legte
// einen bestaetigten Eintrag mit leerem Antworttext an und quittierte mit "hinzugefügt ✓" (gemessen in
// M082-09-03, AB-4).
//
// Diese Datei prueft die drei Lagen EINZELN. Eine Sammelmeldung waere derselbe Fehler in kleiner: sie
// liest drei Lagen als eine und verdeckt genau den Unterschied, an dem der Nutzer ablesen kann, was zu
// tun ist. Jeder Fall nennt in seinem Titel seine Vergleichsmenge.
let clientScript = ''


async function loadCollector( state, questions ) {
    const script = await readEmittedScript()
    // M082-09-07: buildQuestionStateRecords leitet fuer den Speicher die Options-NAMEN ab, deshalb werden
    // optionIdentitiesOf und optionIdentityOf MITGEHOBEN. Eine typeof-Wache am Aufruf haette die Ableitung
    // in genau dem Lauf uebersprungen, der die Datensaetze prueft — ein Gruen ueber einer Nullmenge.
    const lifted = await extractFunctionSources( [
        'isConfirmedAnswer', 'collectAddedAnswers', 'appendAddedAnswers', 'unconfirmedNotice',
        'buildAnswerText', 'answerMarkSuffix', 'isPreselectionAnswer', 'buildQuestionStateRecords',
        'optionIdentityOf', 'optionIdentitiesOf'
    ] )
    // Die ECHTE Deklaration wird mitgehoben, nicht im Test nachgebaut — dieselbe Begruendung wie in
    // LauteKanteVorDemSendenPRD22: eine Kopie bliebe gruen, genau wenn die Produktionsliste waechst.
    const decl = sliceDeclaration( script, 'REFORMULATION_KINDS' )

    const sandbox = { questionNav: { state: state, questions: questions || [] }, console }
    vm.createContext( sandbox )
    vm.runInContext(
        `${ decl }\n${ lifted[ 'source' ] }\n`
        + 'globalThis.__collect = collectAddedAnswers;\n'
        + 'globalThis.__notice = unconfirmedNotice;\n'
        + 'globalThis.__records = buildQuestionStateRecords;',
        sandbox
    )

    return sandbox
}


const question = ( id ) => ( {
    'id': id, 'typ': 'single', 'title': 'Frage ' + id,
    'options': [ { 'kind': 'option', 'key': 'A', 'label': 'Eins' }, { 'kind': 'option', 'key': 'B', 'label': 'Zwei' } ],
    'preselected': []
} )
const block = ( id, text ) => '## Antwort auf ' + id + ' — Frage ' + id + '\n\n' + text + '\n'

// Die drei Lagen aus S2, je als Zustand. `emptyConfirmed` ist der in M082-09-03 AB-4 GEMESSENE
// Zustand: bestaetigt, beruehrt — und der Block traegt nur die Ueberschrift.
const confirmed = ( id, text ) => ( { 'selected': [ 0 ], 'custom': [], 'added': true, 'addedText': block( id, text ), 'rejected': false, 'touched': true } )
const emptyConfirmed = ( id ) => ( { 'selected': [], 'custom': [], 'added': true, 'addedText': block( id, '' ), 'rejected': false, 'touched': true } )
const selectedOnly = () => ( { 'selected': [ 1 ], 'custom': [], 'added': false, 'addedText': null, 'rejected': false, 'touched': true } )
const untouched = () => ( { 'selected': [], 'custom': [], 'added': false, 'addedText': null, 'rejected': false, 'touched': false } )
// Angezeigt, nicht gewaehlt: die KI-Empfehlung steht in `preselected` und sonst nirgends.
const shownOnly = () => ( { 'selected': [], 'preselected': [ 0 ], 'custom': [], 'added': false, 'addedText': null, 'rejected': false, 'touched': false } )


beforeAll( async () => {
    clientScript = await readEmittedScript()
} )


describe( 'M082-09-04 AB-1 — drei Verwerfungs-Lagen, drei unterscheidbare Gruende', () => {
    it( 'Lage 1 "not-confirmed": ausgewaehlt, nie bestaetigt (1 Frage, 1 Zustand)', async () => {
        const sandbox = await loadCollector( [ selectedOnly() ], [ question( 'F26' ) ] )
        const collected = sandbox.__collect()

        expect( collected.compared ).toBe( 1 )
        expect( collected.count ).toBe( 0 )
        expect( collected.skipped.length ).toBe( 1 )
        expect( collected.skipped[ 0 ].reason ).toBe( 'not-confirmed' )
        expect( collected.skipped[ 0 ].id ).toBe( 'F26' )
    } )


    it( 'Lage 2 "empty-content": bestaetigt, aber ohne Antworttext (1 Frage, 1 Zustand)', async () => {
        // Der in M082-09-03 AB-4 gemessene Fall. Vorher: `count 1` — der leere Block wurde als Antwort
        // EXPORTIERT und auf dem Popup-Weg wortlos fallen gelassen. Beides ist jetzt EINE Aussage.
        const sandbox = await loadCollector( [ emptyConfirmed( 'F1' ) ], [ question( 'F1' ) ] )
        const collected = sandbox.__collect()

        expect( collected.compared ).toBe( 1 )
        expect( collected.count ).toBe( 0 )
        expect( collected.content ).toBe( '' )
        expect( collected.skipped.length ).toBe( 1 )
        expect( collected.skipped[ 0 ].reason ).toBe( 'empty-content' )
        expect( collected.skipped[ 0 ].id ).toBe( 'F1' )
    } )


    it( 'Lage 3 "no-question": Absicht ohne Frage dahinter (1 Zustand, 0 Fragen)', async () => {
        const sandbox = await loadCollector( [ selectedOnly() ], [] )
        const collected = sandbox.__collect()

        expect( collected.compared ).toBe( 1 )
        expect( collected.skipped.length ).toBe( 1 )
        expect( collected.skipped[ 0 ].reason ).toBe( 'no-question' )
        // Die Kennung faellt auf die Position zurueck, nie auf eine erfundene.
        expect( collected.skipped[ 0 ].id ).toBe( 'Frage 1' )
    } )


    it( 'AB-1 — die drei Gruende sind paarweise verschieden, in Marke UND Satz (3 Lagen)', async () => {
        // Die eigentliche Bedingung: nicht "es gibt drei Meldungen", sondern "sie sagen Verschiedenes".
        // Eine Sammelmeldung waere hier gruen, wenn nur gezaehlt wuerde.
        const sandbox = await loadCollector(
            [ selectedOnly(), emptyConfirmed( 'F2' ), selectedOnly() ],
            [ question( 'F26' ), question( 'F2' ) ]
        )
        const collected = sandbox.__collect()
        const notice = sandbox.__notice()

        const reasons = collected.skipped.map( ( entry ) => entry.reason )
        expect( reasons.length ).toBe( 3 )
        expect( new Set( reasons ).size ).toBe( 3 )
        expect( reasons.sort() ).toEqual( [ 'empty-content', 'no-question', 'not-confirmed' ] )

        // Drei Zeilen, drei verschiedene Saetze — und jede nennt beide Zahlen.
        const lines = notice.text.split( '\n' ).filter( ( line ) => line.startsWith( 'Nicht übernommen: ' ) )
        expect( lines.length ).toBe( 3 )
        expect( new Set( lines ).size ).toBe( 3 )
        lines.forEach( ( line ) => expect( line ).toContain( ' von 3 ' ) )
    } )


    it( 'AB-1 — die Marken sind englisch, die Saetze deutsch (3 Marken geprueft)', async () => {
        // Sprach-Matrix: Maschinen-Token ausnahmslos englisch, Anzeigetext darf deutsch sein. Die
        // Trennung ist der Grund, warum die Zuordnung Marke -> Satz an EINER Stelle steht.
        const sandbox = await loadCollector(
            [ selectedOnly(), emptyConfirmed( 'F2' ), selectedOnly() ],
            [ question( 'F26' ), question( 'F2' ) ]
        )
        const reasons = sandbox.__collect().skipped.map( ( entry ) => entry.reason )

        reasons.forEach( ( reason ) => expect( reason ).toMatch( /^[a-z-]+$/ ) )
        expect( sandbox.__notice().text ).toContain( 'Nicht übernommen: ' )
    } )
} )


describe( 'M082-09-04 AB-2 — die Meldung nennt ihre Zahl', () => {
    it( 'AB-2 Fall 0 — keine verworfenen Eintraege, keine Meldung (3 Fragen geprueft)', async () => {
        // Die Gegenprobe: ohne sie waere eine Fassung, die IMMER meldet, von der richtigen nicht zu
        // unterscheiden.
        const sandbox = await loadCollector(
            [ confirmed( 'F1', 'A) eins' ), confirmed( 'F2', 'A) zwei' ), untouched() ],
            [ question( 'F1' ), question( 'F2' ), question( 'F3' ) ]
        )
        const notice = sandbox.__notice()

        expect( sandbox.__collect().skipped.length ).toBe( 0 )
        expect( notice.count ).toBe( 0 )
        expect( notice.compared ).toBe( 3 )
        expect( notice.text ).toBe( '' )
    } )


    it( 'AB-2 Fall N>0 — die Zahl stimmt mit der tatsaechlichen Zahl ueberein (5 Fragen, 3 verworfen)', async () => {
        const sandbox = await loadCollector(
            [ confirmed( 'F1', 'A) eins' ), selectedOnly(), emptyConfirmed( 'F3' ), selectedOnly(), untouched() ],
            [ question( 'F1' ), question( 'F26' ), question( 'F3' ), question( 'F27' ), question( 'F5' ) ]
        )
        const collected = sandbox.__collect()
        const notice = sandbox.__notice()

        expect( collected.compared ).toBe( 5 )
        expect( collected.count ).toBe( 1 )
        expect( notice.count ).toBe( 3 )
        expect( notice.count ).toBe( collected.skipped.length )
        // Aufgeschluesselt: 2 nicht bestaetigt + 1 ohne Antworttext. Die Summe steht im Feld `count`,
        // die Aufschluesselung im Text — eine Zahl ohne ihre Vergleichsmenge waere hier wertlos.
        expect( notice.text ).toContain( '2 von 5' )
        expect( notice.text ).toContain( '1 von 5' )
        expect( notice.text ).toContain( 'F26' )
        expect( notice.text ).toContain( 'F27' )
        expect( notice.text ).toContain( 'F3' )
    } )


    it( 'AB-2 — keine Zeile ueber einer Nullmenge: nur vorhandene Gruende werden genannt (5 Fragen, 2 Gruende)', async () => {
        // GEMESSEN als Luecke, nicht vermutet: eine Mutante, die den Gruppen-Filter von "> 0" auf
        // ">= 0" oeffnet, blieb gruen — die uebrigen Faelle pruefen, was DA ist, und keiner prueft,
        // dass nichts DAZU erfunden wird. Eine Zeile "0 von 5 ..." waere genau das Vakuum-Gruen, das
        // diese Meldung nicht produzieren darf: sie nennt einen Grund, den es nicht gibt.
        const sandbox = await loadCollector(
            [ confirmed( 'F1', 'A) eins' ), selectedOnly(), emptyConfirmed( 'F3' ), selectedOnly(), untouched() ],
            [ question( 'F1' ), question( 'F26' ), question( 'F3' ), question( 'F27' ), question( 'F5' ) ]
        )
        const collected = sandbox.__collect()
        const notice = sandbox.__notice()

        const present = new Set( collected.skipped.map( ( entry ) => entry.reason ) )
        const lines = notice.text.split( '\n' ).filter( ( line ) => line.startsWith( 'Nicht übernommen: ' ) )

        // Genau so viele Zeilen, wie es tatsaechlich vorkommende Gruende gibt — nicht mehr.
        expect( present.size ).toBe( 2 )
        expect( lines.length ).toBe( present.size )
        // Und keine Zeile nennt eine Null.
        expect( notice.text ).not.toMatch( /Nicht übernommen: 0 von / )
        lines.forEach( ( line ) => {
            const named = Number( line.replace( 'Nicht übernommen: ', '' ).split( ' ' )[ 0 ] )
            expect( named ).toBeGreaterThan( 0 )
        } )
    } )
} )


describe( 'M082-09-04 AB-5 — der gruene Weg meldet nichts', () => {
    it( 'AB-5 — ein vollstaendig bestaetigter Eintrag wird uebernommen, ohne ein Wort (1 Eintrag)', async () => {
        const sandbox = await loadCollector( [ confirmed( 'F1', 'A) bestätigt' ) ], [ question( 'F1' ) ] )
        const collected = sandbox.__collect()

        expect( collected.count ).toBe( 1 )
        expect( collected.content ).toContain( 'A) bestätigt' )
        expect( collected.skipped.length ).toBe( 0 )
        expect( sandbox.__notice().text ).toBe( '' )
    } )


    it( 'AB-5 — eine unberuehrte Frage ist ein Nullfall, keine Verwerfung (1 Frage)', async () => {
        // Sonst meldete die Kante bei jedem Speichern Rauschen und waere nach drei Tagen unsichtbar.
        const sandbox = await loadCollector( [ untouched() ], [ question( 'F1' ) ] )

        expect( sandbox.__collect().skipped.length ).toBe( 0 )
        expect( sandbox.__notice().text ).toBe( '' )
    } )
} )


describe( 'M082-09-04 AB-6 — die Grenze gegen Cluster A haelt', () => {
    it( 'AB-6 — angezeigte, aber nicht gewaehlte Empfehlung: 0 Optionen gespeichert (1 Frage)', async () => {
        // Der Zaun um das Lockern. Ein Tor, das so weit geoeffnet wird, dass eine reine ANZEIGE wieder
        // gespeichert wird, waere Cluster A auf dem Rueckweg. Gemessen wird das ERGEBNIS am eigenen
        // Speicherweg, nicht die fremde Ableitung (die gehoert M082-09-03).
        const sandbox = await loadCollector( [ shownOnly() ], [ question( 'F1' ) ] )
        const records = sandbox.__records()

        expect( records.seen ).toBe( 1 )
        expect( records.entries[ 'F1' ].intent.selected.length ).toBe( 0 )
        expect( records.entries[ 'F1' ].confirmed ).toBeUndefined()
        // Und sie wird auch nicht exportiert — weder als Block noch als Verwerfung.
        expect( sandbox.__collect().count ).toBe( 0 )
        expect( sandbox.__collect().skipped.length ).toBe( 0 )
    } )


    it( 'AB-6 — eine echte Wahl wird dagegen vollstaendig gespeichert (1 Frage, Positivkontrolle)', async () => {
        // Ohne diese Richtung waere eine Fassung, die NIE speichert, von der richtigen nicht zu
        // unterscheiden.
        const sandbox = await loadCollector( [ confirmed( 'F1', 'A) Eins' ) ], [ question( 'F1' ) ] )
        const records = sandbox.__records()

        expect( records.entries[ 'F1' ].intent.selected ).toEqual( [ 0 ] )
        expect( records.entries[ 'F1' ].confirmed.answerText ).toContain( 'A) Eins' )
    } )
} )


describe( 'M082-09-04 AB-7 — jede der drei Bedingungen ist entschieden und begruendet', () => {
    it( 'AB-7 — alle drei Bedingungen tragen eine Entscheidung im Kommentar (3 Bedingungen)', () => {
        // Vergleichsmenge: die drei Bedingungen des Tores. Eine schweigend entfernte Bedingung waere die
        // naechste unerklaerte Invariante — deshalb wird hier die BEGRUENDUNG geprueft, nicht der Bestand.
        expect( clientScript.length ).toBeGreaterThan( 0 )

        const gateStart = clientScript.indexOf( 'M082-09-04 (Memo 082 Kap 20, Cluster D, S1)' )
        expect( gateStart ).toBeGreaterThan( -1 )
        const gateComment = clientScript.slice( gateStart, clientScript.indexOf( 'var confirmedValue', gateStart ) )

        const decisions = [ '`added`     STAYS', '`addedText` STAYS', '`touched`   STAYS' ]
        const found = decisions.filter( ( marker ) => gateComment.includes( marker ) )

        expect( found.length ).toBe( 3 )
        // Und die Begruendung nennt je einen Fall, keine Gewohnheit.
        expect( gateComment ).toContain( 'Memo 079 PRD-24' )
        expect( gateComment ).toContain( 'stateFromStoredRecord' )
        expect( gateComment ).toContain( 'checkable at the READER' )
    } )


    it( 'AB-7 — das Tor fragt jetzt nach dem ERGEBNIS, nicht nur nach dem Zustand (1 Stelle)', () => {
        // Die Lockerung, die M082-09-03 tatsaechlich ermoeglicht hat: ein bestaetigter Eintrag wird nur
        // dann zum Feldwert, wenn er auch etwas traegt. Vorher endete der Fall in einem leeren Feld und
        // unterdrueckte dabei BEIDE folgenden Zweige.
        expect( clientScript ).toContain( 'if( confirmedValue.trim().length > 0 ) {' )
        expect( ( clientScript.match( /var confirmedValue = /g ) || [] ).length ).toBe( 1 )
    } )
} )


describe( 'M082-09-04 — "Hinzufügen" bestaetigt nichts mehr aus dem Nichts', () => {
    // Die Attrappe bildet die Schachtelung Karte -> Koerper -> Fuss nach; eine Attrappe, in der der Fuss
    // direkt an der Karte haengt, ist gruen, waehrend der Browser NotFoundError wirft (gemessen in
    // M082-09-03, O-6).
    const buildStubDom = () => {
        const tracked = { 'hint': null }
        const inner = {
            'insertBefore': function( node ) { node.parentNode = inner; tracked.hint = node },
            'removeChild': function( node ) { tracked.hint = node === tracked.hint ? null : tracked.hint }
        }
        const footer = { 'className': 'qw-footer', 'parentNode': inner }
        const card = {
            'querySelector': ( selector ) => ( selector === '.qw-footer' ? footer : null ),
            'appendChild': function( node ) { node.parentNode = card; tracked.hint = node },
            'removeChild': function( node ) { tracked.hint = node === tracked.hint ? null : tracked.hint }
        }
        const doc = {
            'createElement': () => ( {
                'className': '', 'id': '', 'textContent': '', 'attributes': {}, 'parentNode': null,
                'setAttribute': function( key, value ) { this.attributes[ key ] = value }
            } ),
            'querySelector': ( selector ) => ( selector.indexOf( '.qw-card' ) !== -1 ? card : null ),
            'getElementById': ( id ) => ( tracked.hint !== null && tracked.hint.id === id ? tracked.hint : null )
        }

        return { doc, tracked }
    }

    const loadButton = async ( state, questions ) => {
        const script = await readEmittedScript()
        const lifted = await extractFunctionSources( [
            'hasUserChoice', 'clearNoSelectionHint', 'showNoSelectionHint', 'submitQuestionAnswer',
            'markQuestionTouched', 'buildAnswerText', 'answerMarkSuffix', 'isPreselectionAnswer'
        ] )
        const decl = sliceDeclaration( script, 'REFORMULATION_KINDS' )
        const dom = buildStubDom()
        const calls = { 'harvested': 0, 'persisted': 0, 'buttonState': [], 'undone': 0 }
        const sandbox = {
            'questionNav': { 'state': state, 'questions': questions },
            'document': dom.doc,
            'harvestReformulationInputs': () => { calls.harvested = calls.harvested + 1 },
            'persistQuestionState': () => { calls.persisted = calls.persisted + 1 },
            'setAddButtonState': ( idx, added ) => { calls.buttonState.push( added ) },
            'updateSaveAnswersOnlyState': () => {},
            'undoQuestionAnswer': () => { calls.undone = calls.undone + 1 },
            console
        }
        vm.createContext( sandbox )
        vm.runInContext( `${ decl }\n${ lifted[ 'source' ] }\nglobalThis.__submit = submitQuestionAnswer;`, sandbox )

        return { 'submit': sandbox.__submit, state, dom, calls }
    }


    it( 'ohne Auswahl entsteht KEIN bestaetigter Eintrag, und der Hinweis ist sichtbar (1 Frage)', async () => {
        // GEMESSEN in M082-09-03 (AB-4): vorher legte dieser Klick `added: true` mit einem Block an, der
        // nur die Ueberschrift trug — und die Oberflaeche quittierte mit "hinzugefügt ✓".
        const { submit, state, dom, calls } = await loadButton( [ untouched() ], [ question( 'F1' ) ] )

        submit( 0 )

        expect( state[ 0 ].added ).toBe( false )
        expect( state[ 0 ].addedText ).toBeNull()
        expect( state[ 0 ].touched ).toBe( false )
        expect( calls.persisted ).toBe( 0 )
        expect( dom.tracked.hint ).not.toBeNull()
        expect( dom.tracked.hint.id ).toBe( 'qw-no-selection-hint' )
        expect( dom.tracked.hint.attributes[ 'data-qw-no-selection' ] ).toBe( '1' )
        expect( dom.tracked.hint.textContent ).toContain( 'Hinzufügen' )
    } )


    it( 'eine blosse Vorauswahl oeffnet den Knopf-Weg NICHT (1 Frage, Schaerfe-Probe)', async () => {
        // Dieselbe Schaerfe-Probe, die M082-09-03 fuer die Tastatur gefahren hat. Ein Tor, das
        // `preselected` mitlesen wuerde, waere hier gruen — und Cluster A waere zurueck.
        const { submit, state } = await loadButton( [ shownOnly() ], [ question( 'F1' ) ] )

        submit( 0 )

        expect( state[ 0 ].added ).toBe( false )
    } )


    it( 'MIT Auswahl bestaetigt der Knopf wie bisher (1 Frage, Positivkontrolle)', async () => {
        // Ohne diese Richtung waere eine Fassung, die NIE bestaetigt, von der richtigen nicht zu
        // unterscheiden.
        const { submit, state, dom, calls } = await loadButton( [ selectedOnly() ], [ question( 'F1' ) ] )

        submit( 0 )

        expect( state[ 0 ].added ).toBe( true )
        expect( state[ 0 ].addedText ).toContain( 'B) Zwei' )
        expect( calls.persisted ).toBe( 1 )
        expect( calls.buttonState ).toEqual( [ true ] )
        expect( dom.tracked.hint ).toBeNull()
    } )


    it( 'ein bereits bestaetigter Eintrag bleibt ruecknehmbar (1 Frage, Rueckgaengig-Pfad)', async () => {
        // Eine Ruecknahme ist keine Bestaetigung. Waere sie mitgesperrt, koennte ein ohne Auswahl
        // bestaetigter Alt-Eintrag ueberhaupt nicht mehr zurueckgenommen werden.
        const { submit, calls } = await loadButton( [ emptyConfirmed( 'F1' ) ], [ question( 'F1' ) ] )

        submit( 0 )

        expect( calls.undone ).toBe( 1 )
    } )
} )
