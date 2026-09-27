import { describe, it, expect, beforeAll } from '@jest/globals'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

import { extractFunctions, extractFunctionSources, readEmittedScript } from '../helpers/extractFunction.mjs'
import { MemoView } from '../../src/MemoView.mjs'


// M082-09-FX (Memo 082 Kap 20, Rest-Befund der Abnahme PRD-18) — EINE Defektklasse an neun Stellen.
//
// DIE KLASSE, in einem Satz: eine nicht entscheidbare Lage wird als der harmlose Fall gelesen, und zwar
// STUMM. Das Audit der Abnahme hat 50 Uebergaben des Frage-/Antwort-Pfads geprueft und neun Zeilen
// gefunden, die genau das tun (F-1, F-1b, F-2 zweimal, F-3 bis F-7). Alle neun liegen in
// src/public/app.client.mjs.
//
// WAS SIE GEMEINSAM HABEN, und es ist der Grund, sie zusammen zu pruefen: in sechs von neun Faellen ist
// die Lage irgendwo SCHON GEMESSEN — der Server zaehlt `skipped`, der Rebind zaehlt `legacy`, der
// Speicher nennt die Herabstufung, die Gueltigkeits-Sperre verwirft einen ganzen Eintrag. Es fehlte
// nicht die Feststellung, sondern der ADRESSAT. Deshalb prueft diese Datei nicht "wird etwas
// gerechnet", sondern "erreicht es die Oberflaeche" — eine Zahl, die niemand sieht, ist keine Meldung.
//
// JEDER FALL NENNT IN SEINEM TITEL SEINE VERGLEICHSMENGE, und jeder Fall traegt seine Gegenrichtung:
// ohne sie waere ein Gruen ueber einer Nullmenge nicht von einem Ergebnis zu unterscheiden.
//
// F-7 ist ausdruecklich KEIN Datenverlust (das leere Feld wird beim Speichern uebersprungen). Der
// Speicherpfad ist dort unangetastet, und AB-F7 prueft genau das mit.
const STATE_FUNCTIONS = [
    'refreshQuestionState', 'flushQuestionState', 'persistQuestionState', 'flushPendingQuestionState',
    'buildQuestionStateRecords', 'isConfirmedAnswer', 'optionIdentityOf', 'optionIdentitiesOf',
    'showQuestionStateBox', 'showQuestionStateSaveError', 'showQuestionStateLoadError',
    'showQuestionStateSaveOutcome'
]

const POPUP_FUNCTIONS = [
    'renderPromptQuestions', 'storedAnswerFor', 'scanAnswerBlocks', 'scanCodeFences',
    'normalizeQuestions', 'openQuestionsOf', 'countQuestionsOf', 'questionCountTitle'
]

let clientScript = ''
let serverSource = ''
let stateSource = ''
let popupSource = ''


// Kein Taktgeber: der Ablauf wird an die Warteschlange zurueckgegeben, bis die then-Kette durch ist —
// gewartet wird auf die BEDINGUNG, nie auf eine Dauer (die Bauform aus ClusterB).
const yieldTick = () => new Promise( ( done ) => setImmediate( done ) )


// Eine Attrappe, die permissiver ist als der Browser, ist gruen-blind (M082-09-03, O-6). Zwei Dinge sind
// hier deshalb echt und nicht bequem: ein entfernter Knoten ist ueber getElementById NICHT mehr
// erreichbar (sonst waere "die Meldung wurde weggenommen" trivial wahr), und textContent wird gelesen
// wie gesetzt, ohne Normalisierung.
function makeNode( tag, id ) {
    const node = {
        'tagName': String( tag ).toUpperCase(),
        'id': id === undefined ? '' : id,
        'textContent': '',
        'value': '',
        'placeholder': '',
        'innerHTML': '',
        'children': [],
        'parentNode': null,
        'attributes': {},
        'classes': new Set()
    }

    node.classList = {
        'add': ( name ) => node.classes.add( name ),
        'remove': ( name ) => node.classes.delete( name ),
        'contains': ( name ) => node.classes.has( name )
    }
    // `className = '...'` ist der Weg, den der Produktivkode nimmt. Eine Attrappe, die es als blosses
    // Feld ablegt, waere gruen-blind: jede Klassen-Frage haette dann ueber einer leeren Menge `false`
    // gesagt, und der Test haette einen Knoten nicht gefunden, den der Browser sehr wohl findet.
    Object.defineProperty( node, 'className', {
        'get': () => [ ...node.classes ].join( ' ' ),
        'set': ( value ) => {
            node.classes = new Set( String( value ).split( /\s+/ ).filter( ( name ) => name.length > 0 ) )
        },
        'enumerable': true,
        'configurable': true
    } )
    node.setAttribute = ( name, value ) => { node.attributes[ name ] = String( value ) }
    node.getAttribute = ( name ) => ( Object.hasOwn( node.attributes, name ) ? node.attributes[ name ] : null )
    node.appendChild = ( child ) => {
        child.parentNode = node
        node.children.push( child )

        return child
    }
    node.insertBefore = ( fresh, reference ) => {
        fresh.parentNode = node
        const at = node.children.indexOf( reference )
        node.children.splice( at < 0 ? node.children.length : at, 0, fresh )

        return fresh
    }
    node.removeChild = ( child ) => {
        node.children = node.children.filter( ( c ) => c !== child )
        child.parentNode = null

        return child
    }

    return node
}


function descendants( node ) {
    return node.children.flatMap( ( child ) => [ child ].concat( descendants( child ) ) )
}


function makeDocument( seeded ) {
    const roots = Object.values( seeded )

    return {
        'createElement': ( tag ) => makeNode( tag ),
        'getElementById': ( id ) => {
            const direct = Object.hasOwn( seeded, id ) ? seeded[ id ] : null
            if( direct !== null ) { return direct }
            const found = roots
                .flatMap( ( root ) => descendants( root ) )
                .filter( ( node ) => node.id === id && node.parentNode !== null )

            return found.length > 0 ? found[ 0 ] : null
        },
        'querySelector': () => null,
        'querySelectorAll': () => []
    }
}


// Der Sandkasten fuer den Lese-/Schreibpfad. `calls` protokolliert JEDEN Netzweg, damit ein "nicht
// gespeichert" als GEMESSENE Null erscheint und nicht als Abwesenheit einer Behauptung.
function buildStateSandbox( { documentId, revisionId, fetchImpl, stored } ) {
    const widgets = makeNode( 'div', 'question-widgets' )
    const nodes = { 'question-widgets': widgets }
    const calls = { 'fetch': [], 'render': 0 }

    const sandbox = {
        'currentDocumentId': documentId === undefined ? 'DOC-1' : documentId,
        'currentRevisionId': () => ( revisionId === undefined ? 'REV-07' : revisionId ),
        'lastQuestionSchema': [],
        'questionNav': { 'questions': [], 'state': [] },
        'questionStateStored': stored === undefined
            ? { 'key': null, 'entries': {}, 'seen': 0, 'skipped': 0, 'messages': [] }
            : stored,
        'questionStateSaveTimer': null,
        'renderQuestionWidgets': () => { calls.render = calls.render + 1 },
        'setTimeout': setTimeout,
        'clearTimeout': clearTimeout,
        'document': makeDocument( nodes ),
        'fetch': ( url, options ) => {
            calls.fetch.push( { url, 'options': options === undefined ? null : options } )

            return fetchImpl( url, options )
        },
        console
    }

    vm.createContext( sandbox )
    vm.runInContext(
        `${ stateSource }\n`
        + 'globalThis.__refresh = refreshQuestionState;\n'
        + 'globalThis.__flush = flushQuestionState;\n'
        + 'globalThis.__persist = persistQuestionState;\n'
        + 'globalThis.__flushPending = flushPendingQuestionState;',
        sandbox
    )

    return { sandbox, nodes, widgets, calls }
}


const boxText = ( widgets, id ) => {
    const hit = descendants( widgets ).filter( ( node ) => node.id === id )

    return hit.length > 0 ? hit[ 0 ].textContent : null
}


beforeAll( async () => {
    clientScript = await readEmittedScript()
    serverSource = await readFile( new URL( '../../src/MemoView.mjs', import.meta.url ), 'utf-8' )
    stateSource = ( await extractFunctionSources( STATE_FUNCTIONS ) ).source
    popupSource = ( await extractFunctionSources( POPUP_FUNCTIONS ) ).source
} )


// =================================================================================================
// F-1 (hoch) — ein gescheiterter Abruf ist KEIN leerer Speicher.
// Vergleichsmenge je Fall: 1 Dokument · 1 Revision · 1 Abruf · 1 gespeicherter Eintrag im Speicher.
// =================================================================================================
describe( 'F-1 — refreshQuestionState liest einen Fehlschlag nicht als leeren Speicher', () => {
    const stored = () => ( {
        'key': null,
        'entries': { 'F1': { 'intent': { 'selected': [ 1 ], 'custom': [], 'rejected': false, 'touched': true } } },
        'seen': 1,
        'skipped': 0,
        'messages': []
    } )


    // ETIKETTEN-REGEL (M082-09-FX, Nachtrag): eine Kennung, eine Bedingung. Die drei Lagen von F-1
    // hiessen AB-F1a/b/c, und `AB-F1b` war damit ZWEIMAL vergeben — hier fuer die Ausnahme und unten fuer
    // die Kennung F-1b. Eine doppelt vergebene Nummer macht jede Deckungs-Tabelle mehrdeutig, also
    // tragen die Lagen von F-1 jetzt ihren Fall im Namen und die Kennung F-1b ihr eigenes Etikett.
    it( 'AB-F1-nichtOK: HTTP 503 ueberschreibt den Bestand NICHT, meldet sichtbar und gibt den Schluessel frei (1 Abruf, 1 Eintrag)', async () => {
        const before = stored()
        const { sandbox, widgets, calls } = buildStateSandbox( {
            'fetchImpl': () => Promise.resolve( { 'ok': false, 'status': 503, 'json': () => Promise.resolve( {} ) } ),
            'stored': before
        } )

        sandbox.__refresh()
        await yieldTick()
        await yieldTick()

        // Die Vergleichsmenge ist gemessen und nicht null: der Abruf hat stattgefunden.
        expect( calls.fetch.length ).toBe( 1 )
        // Der gespeicherte Eintrag steht unveraendert — VORHER war das `{}`.
        expect( Object.keys( sandbox.questionStateStored.entries ) ).toEqual( [ 'F1' ] )
        // Kein Neu-Rendern ueber einer Nullmenge: das leere Widget entsteht gar nicht erst.
        expect( calls.render ).toBe( 0 )
        // Die Lage ist BENANNT, mit dem Status im Text.
        expect( boxText( widgets, 'qw-state-load-warn' ) ).toContain( 'HTTP 503' )
        expect( boxText( widgets, 'qw-state-load-warn' ) ).toContain( 'NICHT geladen' )
        // Und der Schluessel ist frei — ohne das waere der Fehlschlag fuer diese Sitzung endgueltig.
        expect( sandbox.questionStateStored.key ).toBe( null )
    } )


    it( 'AB-F1-Ausnahme: die Ausnahme landet im selben Kanal statt in einem leeren catch (1 Abruf, 1 Ausnahme)', async () => {
        const { sandbox, widgets, calls } = buildStateSandbox( {
            'fetchImpl': () => Promise.reject( new TypeError( 'Failed to fetch' ) ),
            'stored': stored()
        } )

        sandbox.__refresh()
        await yieldTick()
        await yieldTick()

        expect( calls.fetch.length ).toBe( 1 )
        expect( boxText( widgets, 'qw-state-load-warn' ) ).toContain( 'Failed to fetch' )
        expect( sandbox.questionStateStored.key ).toBe( null )
        expect( calls.render ).toBe( 0 )
    } )


    it( 'AB-F1-statusFalse: `status false` wird mit der Begruendung des Servers gemeldet, nicht als leerer Speicher (1 Antwort, 1 Begruendung)', async () => {
        const { sandbox, widgets } = buildStateSandbox( {
            'fetchImpl': () => Promise.resolve( {
                'ok': true,
                'status': 200,
                'json': () => Promise.resolve( { 'status': false, 'entries': {}, 'seen': 0, 'skipped': 0, 'messages': [ 'no memoPath registered for this document' ] } )
            } ),
            'stored': stored()
        } )

        sandbox.__refresh()
        await yieldTick()
        await yieldTick()

        expect( boxText( widgets, 'qw-state-load-warn' ) ).toContain( 'no memoPath registered' )
        expect( Object.keys( sandbox.questionStateStored.entries ) ).toEqual( [ 'F1' ] )
        expect( sandbox.questionStateStored.key ).toBe( null )
    } )


    it( 'AB-F1 Gegenrichtung: ein gelungener Abruf uebernimmt, rendert EINMAL, haelt den Schluessel und nimmt die Meldung weg (2 Abrufe)', async () => {
        const answers = [
            { 'ok': false, 'status': 503, 'json': () => Promise.resolve( {} ) },
            {
                'ok': true,
                'status': 200,
                'json': () => Promise.resolve( {
                    'status': true,
                    'entries': { 'F2': { 'intent': { 'selected': [ 0 ], 'custom': [], 'rejected': false, 'touched': true } } },
                    'seen': 2,
                    'skipped': 1,
                    'messages': [ 'question state unreadable (EISDIR) — the working state starts empty' ]
                } )
            }
        ]
        const { sandbox, widgets, calls } = buildStateSandbox( {
            'fetchImpl': () => Promise.resolve( answers[ calls.fetch.length - 1 ] ),
            'stored': stored()
        } )

        // Erst der Fehlschlag — er stellt die Meldung auf und gibt den Schluessel frei...
        sandbox.__refresh()
        await yieldTick()
        await yieldTick()

        expect( boxText( widgets, 'qw-state-load-warn' ) ).toContain( 'HTTP 503' )

        // ...und genau deshalb ist ein zweiter Versuch ueberhaupt moeglich.
        sandbox.__refresh()
        await yieldTick()
        await yieldTick()

        expect( calls.fetch.length ).toBe( 2 )
        expect( Object.keys( sandbox.questionStateStored.entries ) ).toEqual( [ 'F2' ] )
        expect( sandbox.questionStateStored.skipped ).toBe( 1 )
        // Die Meldung des Servers reist mit, statt am Klienten zu verschwinden (F-1b, Speicher-Seite).
        expect( sandbox.questionStateStored.messages.length ).toBe( 1 )
        expect( calls.render ).toBe( 1 )
        expect( sandbox.questionStateStored.key ).toBe( 'DOC-1::REV-07' )
        // Die alte Meldung ist WEG, nicht nur ueberschrieben: eine Warnung, die ihre Lage ueberlebt,
        // ist eine falsche Aussage.
        expect( boxText( widgets, 'qw-state-load-warn' ) ).toBe( null )
    } )
} )


// =================================================================================================
// F-1b + F-2 — was auf dem Weg herein mit dem Zustand passiert ist, wird GESAGT.
// =================================================================================================
describe( 'F-1b / F-2 — die vier Zaehler haben einen Adressaten', () => {
    const question = ( { id, keys } ) => ( {
        'id': id,
        'title': 'Frage ' + id,
        'typ': 'single',
        'status': 'open',
        'preselected': [],
        'options': keys.map( ( key ) => ( { 'kind': 'option', 'key': key, 'label': 'Option ' + key } ) )
    } )
    const carried = ( { selected, custom } ) => ( {
        'selected': selected.slice(),
        'preselected': [],
        'custom': custom === undefined ? [] : custom.slice(),
        'added': false,
        'addedText': null,
        'rejected': false,
        'touched': true
    } )


    it( 'AB-F1b: eine nicht lesbare Form wird gezaehlt UND benannt (3 gespeicherte Datensaetze, 1 unlesbar)', async () => {
        const { fillPrevFromStoredQuestionState } = await extractFunctions(
            [ 'fillPrevFromStoredQuestionState', 'stateFromStoredRecord' ]
        )
        const prevById = {}
        const report = fillPrevFromStoredQuestionState( prevById, {
            'F1': { 'intent': { 'selected': [ 0 ], 'custom': [], 'rejected': false, 'touched': true } },
            'F2': { 'intent': { 'selected': [ 1 ], 'custom': [], 'rejected': false, 'touched': true } },
            'F3': { 'nicht': 'die erwartete Form' }
        } )

        // Die Vergleichsmenge steht in der Antwort, nicht nur im Titel dieses Falls.
        expect( report.compared ).toBe( 3 )
        expect( report.filled ).toBe( 2 )
        expect( report.unreadable ).toEqual( [ 'F3' ] )
        // Und die Karte bleibt, was sie war: uebersprungen, nie halb gefuellt.
        expect( Object.keys( prevById ).sort() ).toEqual( [ 'F1', 'F2' ] )
    } )


    it( 'AB-F1b Gegenrichtung: lesbare Datensaetze melden 0 unlesbar und eigene Arbeit getrennt (2 Datensaetze, 1 eigene Arbeit)', async () => {
        const { fillPrevFromStoredQuestionState } = await extractFunctions(
            [ 'fillPrevFromStoredQuestionState', 'stateFromStoredRecord' ]
        )
        const prevById = { 'F1': carried( { 'selected': [ 0 ] } ) }
        const report = fillPrevFromStoredQuestionState( prevById, {
            'F1': { 'intent': { 'selected': [ 1 ], 'custom': [], 'rejected': false, 'touched': true } },
            'F2': { 'intent': { 'selected': [ 1 ], 'custom': [], 'rejected': false, 'touched': true } }
        } )

        expect( report.compared ).toBe( 2 )
        expect( report.ownWork ).toBe( 1 )
        expect( report.filled ).toBe( 1 )
        expect( report.unreadable ).toEqual( [] )
        // Die Vorrang-Regel ist unveraendert: die eigene Arbeit gewinnt.
        expect( prevById.F1.selected ).toEqual( [ 0 ] )
    } )


    it( 'AB-F2a: die Sperre wird an ihrem EIGENEN Ergebnis gelesen, mit dem, was sie gekostet hat (2 Fragen, 1 verworfen)', async () => {
        const { seedQuestionState, latchedCarriedEntries } = await extractFunctions(
            [ 'seedQuestionState', 'latchedCarriedEntries' ]
        )
        const open = [ question( { 'id': 'F1', 'keys': [ 'A', 'B', 'C' ] } ), question( { 'id': 'F2', 'keys': [ 'A', 'B', 'C' ] } ) ]
        const prevById = {
            'F1': carried( { 'selected': [ 6 ], 'custom': [ 'eigener Eintrag des Nutzers' ] } ),
            'F2': carried( { 'selected': [ 1 ] } )
        }

        const state = seedQuestionState( open, prevById )
        const latched = latchedCarriedEntries( open, prevById, state )

        // Die Sperre hat zugeschlagen — das ist die heutige Regel und sie bleibt.
        expect( state[ 0 ].selected ).toEqual( [] )
        expect( state[ 0 ].custom ).toEqual( [] )
        // ...und sie ist jetzt benannt, mit Auswahl, Menge und dem, was mitging.
        expect( latched.length ).toBe( 1 )
        expect( latched[ 0 ].question ).toBe( 'F1' )
        expect( latched[ 0 ].selected ).toEqual( [ 6 ] )
        expect( latched[ 0 ].options ).toBe( 3 )
        expect( latched[ 0 ].custom ).toBe( 1 )
        // Der passende Eintrag ist NICHT gemeldet: die Meldung haengt am Ergebnis, nicht am Vorkommen
        // eines uebernommenen Eintrags.
        expect( state[ 1 ].selected ).toEqual( [ 1 ] )
        expect( latched.map( ( hit ) => hit.question ) ).not.toContain( 'F2' )
    } )


    it( 'AB-F2a Vakuum: ueber null Fragen und ueber null uebernommenen Eintraegen meldet sie leer, nicht bestanden (0 und 2 Fragen)', async () => {
        const { seedQuestionState, latchedCarriedEntries } = await extractFunctions(
            [ 'seedQuestionState', 'latchedCarriedEntries' ]
        )

        expect( latchedCarriedEntries( [], {}, [] ) ).toEqual( [] )

        const open = [ question( { 'id': 'F1', 'keys': [ 'A', 'B' ] } ), question( { 'id': 'F2', 'keys': [ 'A', 'B' ] } ) ]
        const frisch = seedQuestionState( open, {} )

        // Zwei frisch gesaete Karten ohne jeden uebernommenen Eintrag: nichts wurde verworfen, weil
        // nichts zu verwerfen war — und das ist eine andere Aussage als "nichts ging verloren".
        expect( frisch.length ).toBe( 2 )
        expect( latchedCarriedEntries( open, {}, frisch ) ).toEqual( [] )
    } )


    it( 'AB-F2b: die Meldung traegt `legacy`, die Sperre und die Server-Zahl — je mit beiden Zahlen (1 Meldung, 4 Lagen)', async () => {
        const { renderQuestionStateCarryNotice } = await extractFunctions(
            [ 'renderQuestionStateCarryNotice', 'showQuestionStateBox' ]
        )
        const widgets = makeNode( 'div', 'question-widgets' )
        const sandbox = { 'document': makeDocument( { 'question-widgets': widgets } ), console }
        const lifted = await extractFunctionSources( [ 'renderQuestionStateCarryNotice', 'showQuestionStateBox' ] )

        vm.createContext( sandbox )
        vm.runInContext( `${ lifted.source }\nglobalThis.__carry = renderQuestionStateCarryNotice;`, sandbox )

        sandbox.__carry( widgets, {
            'compared': 3,
            'filled': 1,
            'unreadable': [ 'F3' ],
            'seen': 2,
            'skipped': 1,
            'messages': [ 'question state unreadable (EISDIR) — the working state starts empty' ],
            'legacy': 1,
            'rebindCompared': 2,
            'latched': [ { 'question': 'F1', 'title': 'Frage F1', 'selected': [ 6 ], 'options': 3, 'confirmed': true, 'custom': 1 } ]
        } )

        const text = boxText( widgets, 'qw-state-carry-warn' )

        // Die Sperre: die schwerste Lage steht zuerst und nennt, was mitging.
        expect( text ).toContain( 'GANZ verworfen' )
        expect( text ).toContain( 'F1 (Auswahl 6 bei 3 Möglichkeiten)' )
        expect( text ).toContain( '1 von 3' )
        // Die unlesbare Form.
        expect( text ).toContain( 'F3' )
        // Die Zahl des Servers — gezaehlt war sie vorher schon, sichtbar ist sie erst jetzt.
        expect( text ).toContain( '1 von 3 Datensätzen' )
        // `legacy`: gezaehlt seit M082-09-07, angezeigt nie.
        expect( text ).toContain( '1 von 2' )
        expect( text ).toContain( 'keine Options-Namen' )
        // Und die Meldung des Speichers.
        expect( text ).toContain( 'EISDIR' )

        // Renderaufruf ist auch die Referenz fuer die Funktion, die das Feld traegt.
        expect( renderQuestionStateCarryNotice ).toBeInstanceOf( Function )
    } )


    it( 'AB-F2b Gegenrichtung: der normale Fall zeigt NICHTS — eine Warnung auf jedem Render liest niemand (1 Meldung, 0 Lagen)', async () => {
        const widgets = makeNode( 'div', 'question-widgets' )
        const sandbox = { 'document': makeDocument( { 'question-widgets': widgets } ), console }
        const lifted = await extractFunctionSources( [ 'renderQuestionStateCarryNotice', 'showQuestionStateBox' ] )

        vm.createContext( sandbox )
        vm.runInContext( `${ lifted.source }\nglobalThis.__carry = renderQuestionStateCarryNotice;`, sandbox )

        sandbox.__carry( widgets, {
            'compared': 2, 'filled': 2, 'unreadable': [], 'seen': 2, 'skipped': 0,
            'messages': [], 'legacy': 0, 'rebindCompared': 2, 'latched': []
        } )

        expect( boxText( widgets, 'qw-state-carry-warn' ) ).toBe( null )
    } )


    it( 'AB-F2c: der Renderer liest die Sperre NACH dem Saeen und fuettert die Meldung damit (Quelltext, 3 Naehte)', () => {
        // Die Reihenfolge ist der Pruefgegenstand: vor dem Saeen gaebe es kein Ergebnis zu lesen, und
        // eine Meldung ohne Naht waere eine Funktion ohne Aufrufer.
        const seedIndex = clientScript.indexOf( 'questionNav.state = seedQuestionState( open, prevById )' )
        const latchIndex = clientScript.indexOf( 'var latched = latchedCarriedEntries( open, prevById, questionNav.state )' )
        const noticeIndex = clientScript.indexOf( 'renderQuestionStateCarryNotice( container, {' )

        expect( seedIndex ).toBeGreaterThan( -1 )
        expect( latchIndex ).toBeGreaterThan( seedIndex )
        expect( noticeIndex ).toBeGreaterThan( latchIndex )
        // Und die Meldung der Nachbindung bleibt, was sie war — dieser Befund nimmt keine Zusicherung weg.
        expect( clientScript ).toContain( 'if( dropped.length === 0 && undecidable.length === 0 ) { return }' )
    } )
} )


// =================================================================================================
// F-3 — ein fehlendes Feld laesst eine Frage nicht verschwinden.
// =================================================================================================
describe( 'F-3 — openQuestionsOf liest den undeklarierten Fall als undeklariert', () => {
    // Die ALTE Bedingung, hier einmal getippt, damit die Differenz GEMESSEN ist und nicht behauptet.
    const alterFilter = ( schema ) => ( schema || [] ).filter( ( q ) => q && q.status === 'open' )


    it( 'AB-F3: eine Frage ohne `status` bleibt im Satz, die entschiedenen bleiben draussen (5 Elemente, 1 undeklariert)', async () => {
        const { openQuestionsOf, undeclaredStatusQuestionsOf, countQuestionsOf } = await extractFunctions(
            [ 'openQuestionsOf', 'undeclaredStatusQuestionsOf', 'countQuestionsOf' ]
        )
        const schema = [
            { 'id': 'F1', 'status': 'open' },
            { 'id': 'F2', 'status': 'answered' },
            { 'id': 'F3', 'status': 'irrelevant' },
            { 'id': 'F4' },
            { 'id': 'F5', 'status': '   ' },
            null
        ]

        // Der alte Filter verliert BEIDE undeklarierten — das ist der Befund, gemessen.
        expect( alterFilter( schema ).map( ( q ) => q.id ) ).toEqual( [ 'F1' ] )
        // Der heutige haelt sie.
        expect( openQuestionsOf( schema ).map( ( q ) => q.id ) ).toEqual( [ 'F1', 'F4', 'F5' ] )
        // Entschieden bleibt entschieden: `answered` und die Retired-Werte wandern weiter aus der Spalte.
        expect( openQuestionsOf( schema ).map( ( q ) => q.id ) ).not.toContain( 'F2' )
        expect( openQuestionsOf( schema ).map( ( q ) => q.id ) ).not.toContain( 'F3' )
        // Und die undeklarierte Haelfte ist als eigene Menge benennbar.
        expect( undeclaredStatusQuestionsOf( schema ).map( ( q ) => q.id ) ).toEqual( [ 'F4', 'F5' ] )
        expect( countQuestionsOf( schema ).open ).toBe( 3 )
        expect( countQuestionsOf( schema ).answered ).toBe( 1 )
    } )


    it( 'AB-F3 Gegenrichtung: ein vollstaendig deklariertes Schema meldet 0 undeklarierte (5 Elemente, 0 undeklariert)', async () => {
        const { openQuestionsOf, undeclaredStatusQuestionsOf } = await extractFunctions(
            [ 'openQuestionsOf', 'undeclaredStatusQuestionsOf' ]
        )
        const schema = [
            { 'id': 'F1', 'status': 'open' },
            { 'id': 'F2', 'status': 'open' },
            { 'id': 'F3', 'status': 'answered' },
            { 'id': 'F4', 'status': 'replaced' },
            { 'id': 'F5', 'status': 'open' }
        ]

        expect( undeclaredStatusQuestionsOf( schema ) ).toEqual( [] )
        // Hier sind alter und heutiger Filter deckungsgleich — die Aenderung kostet den Bestand nichts.
        expect( openQuestionsOf( schema ).map( ( q ) => q.id ) ).toEqual( alterFilter( schema ).map( ( q ) => q.id ) )
    } )


    it( 'AB-F3 Anzeige: die undeklarierte Menge wird benannt, ueber einer leeren Menge schweigt sie (4 Fragen, 1 benannt)', async () => {
        const widgets = makeNode( 'div', 'question-widgets' )
        const sandbox = { 'document': makeDocument( { 'question-widgets': widgets } ), console }
        const lifted = await extractFunctionSources( [ 'renderQuestionStatusNotice', 'showQuestionStateBox' ] )

        vm.createContext( sandbox )
        vm.runInContext( `${ lifted.source }\nglobalThis.__status = renderQuestionStatusNotice;`, sandbox )

        sandbox.__status( widgets, [ { 'id': 'F4' } ], 4 )
        const text = boxText( widgets, 'qw-status-warn' )

        expect( text ).toContain( '1 von 4' )
        expect( text ).toContain( 'F4' )
        expect( text ).toContain( 'undeclared-status' )

        sandbox.__status( widgets, [], 4 )
        expect( boxText( widgets, 'qw-status-warn' ) ).toBe( null )
    } )
} )


// =================================================================================================
// F-4 / F-6 — der Speicherpfad sagt, wenn nicht (oder nicht unveraendert) gespeichert wurde.
// =================================================================================================
describe( 'F-4 / F-6 — kein stummer Ruecksprung und kein ungelesenes `messages`', () => {
    const okAnswer = ( payload ) => () => Promise.resolve( {
        'ok': true,
        'status': 200,
        'json': () => Promise.resolve( payload )
    } )


    it( 'AB-F4a: ohne Dokument wird NICHT gespeichert, und genau das steht da (1 Klick, 0 Netzwege)', async () => {
        const { sandbox, widgets, calls } = buildStateSandbox( {
            'documentId': '',
            'fetchImpl': okAnswer( { 'status': true, 'written': 0, 'skipped': 0, 'messages': [] } )
        } )

        sandbox.__flush()
        await yieldTick()

        expect( calls.fetch.length ).toBe( 0 )
        expect( boxText( widgets, 'qw-state-save-warn' ) ).toContain( 'no-document' )
        expect( boxText( widgets, 'qw-state-save-warn' ) ).toContain( 'konnte nicht gespeichert werden' )
    } )


    it( 'AB-F4b: ohne Revisions-Kennung dasselbe, mit eigenem Namen (1 Klick, 0 Netzwege)', async () => {
        const { sandbox, widgets, calls } = buildStateSandbox( {
            'revisionId': '',
            'fetchImpl': okAnswer( { 'status': true, 'written': 0, 'skipped': 0, 'messages': [] } )
        } )

        sandbox.__flush()
        await yieldTick()

        expect( calls.fetch.length ).toBe( 0 )
        expect( boxText( widgets, 'qw-state-save-warn' ) ).toContain( 'no-revision' )
        // Zwei Lagen, zwei Namen — eine Sammelmeldung waere derselbe Fehler eine Nummer kleiner.
        expect( boxText( widgets, 'qw-state-save-warn' ) ).not.toContain( 'no-document' )
    } )


    it( 'AB-F4 Gegenrichtung: mit beiden Angaben geht genau EIN Schreibvorgang hinaus, ohne Meldung (1 Klick, 1 Netzweg)', async () => {
        const { sandbox, widgets, calls } = buildStateSandbox( {
            'fetchImpl': okAnswer( { 'status': true, 'written': 0, 'skipped': 0, 'messages': [] } )
        } )

        sandbox.__flush()
        await yieldTick()
        await yieldTick()

        expect( calls.fetch.length ).toBe( 1 )
        expect( calls.fetch[ 0 ].options.method ).toBe( 'PUT' )
        expect( boxText( widgets, 'qw-state-save-warn' ) ).toBe( null )
        expect( boxText( widgets, 'qw-state-partial-warn' ) ).toBe( null )
    } )


    it( 'AB-F6: `status true` MIT Meldung erreicht die Oberflaeche, mit beiden Zahlen (1 Antwort, 2 Datensaetze)', async () => {
        const { sandbox, widgets } = buildStateSandbox( {
            'fetchImpl': okAnswer( {
                'status': true,
                'written': 1,
                'skipped': 1,
                'messages': [ 'F1: confirmed dropped: intent.touched is not true — stored as an intent, not as an answer' ]
            } )
        } )

        sandbox.__flush()
        await yieldTick()
        await yieldTick()

        const text = boxText( widgets, 'qw-state-partial-warn' )

        expect( text ).toContain( 'NICHT unverändert' )
        expect( text ).toContain( 'übernommen 1 von 2 Einträgen' )
        expect( text ).toContain( 'confirmed dropped' )
        // Es ist NICHT der Fehlerkanal: der Schreibvorgang ist gelungen, nur nicht unveraendert.
        expect( boxText( widgets, 'qw-state-save-warn' ) ).toBe( null )
    } )


    it( 'AB-F6 Gegenrichtung: eine saubere Quittung nimmt eine frueher gezeigte Meldung wieder weg (2 Antworten)', async () => {
        const answers = [
            { 'status': true, 'written': 1, 'skipped': 1, 'messages': [ 'F1: confirmed dropped' ] },
            { 'status': true, 'written': 2, 'skipped': 0, 'messages': [] }
        ]
        const { sandbox, widgets, calls } = buildStateSandbox( {
            'fetchImpl': () => Promise.resolve( {
                'ok': true,
                'status': 200,
                'json': () => Promise.resolve( answers[ calls.fetch.length - 1 ] )
            } )
        } )

        sandbox.__flush()
        await yieldTick()
        await yieldTick()

        expect( boxText( widgets, 'qw-state-partial-warn' ) ).toContain( 'confirmed dropped' )

        sandbox.__flush()
        await yieldTick()
        await yieldTick()

        expect( calls.fetch.length ).toBe( 2 )
        expect( boxText( widgets, 'qw-state-partial-warn' ) ).toBe( null )
    } )


    it( 'AB-F4/F6 Fehlerkanal unveraendert: eine nicht-OK Antwort bleibt der Fehlerkanal (1 Antwort, Status 500)', async () => {
        const { sandbox, widgets } = buildStateSandbox( {
            'fetchImpl': () => Promise.resolve( { 'ok': false, 'status': 500, 'json': () => Promise.resolve( {} ) } )
        } )

        sandbox.__flush()
        await yieldTick()
        await yieldTick()

        expect( boxText( widgets, 'qw-state-save-warn' ) ).toContain( 'HTTP 500' )
    } )
} )


// =================================================================================================
// F-5 — das Buendel-Fenster ist auch ein Haltbarkeits-Fenster.
// =================================================================================================
describe( 'F-5 — die Aenderung im Buendel-Fenster wird beim Verlassen entladen', () => {
    it( 'AB-F5: die Entladung schreibt SOFORT und der ausstehende Taktgeber schreibt nicht doppelt (1 Klick, 1 Netzweg)', async () => {
        const { sandbox, calls } = buildStateSandbox( {
            'fetchImpl': () => Promise.resolve( {
                'ok': true, 'status': 200, 'json': () => Promise.resolve( { 'status': true, 'written': 1, 'skipped': 0, 'messages': [] } )
            } )
        } )

        sandbox.__persist()

        // Im Fenster ist noch NICHTS hinausgegangen — das ist die Buendelung, und sie bleibt.
        expect( calls.fetch.length ).toBe( 0 )
        expect( sandbox.__flushPending() ).toBe( true )
        expect( calls.fetch.length ).toBe( 1 )

        // Und der abgebrochene Taktgeber kann nicht nachtraeglich ein zweites Mal schreiben.
        await new Promise( ( done ) => setTimeout( done, 300 ) )
        expect( calls.fetch.length ).toBe( 1 )
    } )


    it( 'AB-F5 Gegenrichtung: ohne ausstehende Aenderung entlaedt sie nichts und schreibt nichts (0 Klicks)', () => {
        const { sandbox, calls } = buildStateSandbox( {
            'fetchImpl': () => Promise.resolve( { 'ok': true, 'status': 200, 'json': () => Promise.resolve( {} ) } )
        } )

        expect( sandbox.__flushPending() ).toBe( false )
        expect( calls.fetch.length ).toBe( 0 )
    } )


    it( 'AB-F5 Naht: beide Verlassen-Ereignisse sind gebunden und der Schreibvorgang ueberlebt das Dokument (Quelltext, 3 Naehte)', () => {
        // Die Bindung ist eine Anweisung auf Modul-Ebene und laesst sich nicht herausheben — sie wird
        // deshalb am Quelltext geprueft und hier als Quelltext-Pruefung DEKLARIERT.
        expect( clientScript ).toContain( "window.addEventListener( 'pagehide', function() { flushPendingQuestionState() } )" )
        expect( clientScript ).toContain( "document.addEventListener( 'visibilitychange', function() {" )
        expect( clientScript ).toContain( "if( document.visibilityState === 'hidden' ) { flushPendingQuestionState() }" )
        // Ohne `keepalive` bricht der Browser genau den Schreibvorgang ab, den die Entladung startet.
        expect( clientScript ).toContain( 'keepalive: true' )
        // Die Buendelung selbst ist unveraendert — 250 ms bleiben 250 ms.
        expect( clientScript ).toContain( '}, 250 )' )
    } )
} )


// =================================================================================================
// F-7 — die mehrzeilige gespeicherte Antwort wird benannt, nicht flachgeschrieben.
// =================================================================================================
describe( 'F-7 — die verweigerte Vorbefuellung sagt, dass sie verweigert', () => {
    const CONTENT = [
        '## Antwort auf F1 — Erste Frage',
        '',
        'Eine Zeile, und sie wird angeboten.',
        '',
        '## Antwort auf F2 — Zweite Frage',
        '',
        'Erste Zeile der mehrzeiligen Antwort',
        'zweite Zeile derselben Antwort',
        ''
    ].join( '\n' )

    const buildPopupSandbox = ( { content, questions } ) => {
        const nodes = {
            'pp-content': makeNode( 'textarea', 'pp-content' ),
            'pp-questions-list': makeNode( 'div', 'pp-questions-list' ),
            'pp-questions-label': makeNode( 'span', 'pp-questions-label' )
        }
        nodes[ 'pp-content' ].value = content
        const calls = { 'answerText': 0 }

        const sandbox = {
            'questionNav': { 'questions': questions, 'state': [] },
            'promptEditState': { 'questions': [] },
            'lastQuestionSchema': questions,
            'lookupMemoEntryById': () => null,
            'buildAnswerText': () => {
                calls.answerText = calls.answerText + 1

                return { 'answerLine': 'darf hier nicht gebraucht werden' }
            },
            'document': makeDocument( nodes ),
            console
        }

        vm.createContext( sandbox )
        vm.runInContext(
            `${ popupSource }\n`
            + 'globalThis.__render = renderPromptQuestions;\n'
            + 'globalThis.__stored = storedAnswerFor;',
            sandbox
        )

        return { sandbox, nodes, calls }
    }


    it( 'AB-F7a: die mehrzeilige Antwort wird gezaehlt und die einzeilige weiter angeboten (2 Bloecke, 1 mehrzeilig)', () => {
        const { sandbox } = buildPopupSandbox( { 'content': CONTENT, 'questions': [] } )

        const einzeilig = sandbox.__stored( { 'id': 'F1' } )
        const mehrzeilig = sandbox.__stored( { 'id': 'F2' } )

        // Die Verweigerung ist unveraendert — das ist Absicht und kein Nebeneffekt.
        expect( mehrzeilig.found ).toBe( false )
        expect( mehrzeilig.answer ).toBe( '' )
        // ...und sie ist jetzt eine Angabe, mit ihrer Vergleichsmenge.
        expect( mehrzeilig.multiline ).toBe( 1 )
        expect( mehrzeilig.compared ).toBe( 1 )
        // Gegenrichtung im selben Inhalt: die einzeilige Antwort wird weiterhin angeboten.
        expect( einzeilig.found ).toBe( true )
        expect( einzeilig.answer ).toBe( 'Eine Zeile, und sie wird angeboten.' )
        expect( einzeilig.multiline ).toBe( 0 )
    } )


    it( 'AB-F7b: das Feld bleibt leer UND traegt einen Hinweis mit beiden Zahlen (1 Frage, 1 mehrzeiliger Block)', () => {
        const { sandbox, nodes } = buildPopupSandbox( {
            'content': CONTENT,
            'questions': [ { 'id': 'F2', 'title': 'Zweite Frage', 'typ': 'single', 'status': 'open', 'options': [] } ]
        } )

        sandbox.__render( null )

        const row = nodes[ 'pp-questions-list' ].children[ 0 ]
        const input = row.children.filter( ( node ) => node.classes.has( 'pp-question-input' ) )[ 0 ]
        const hint = row.children.filter( ( node ) => node.classes.has( 'pp-question-hint' ) )[ 0 ]

        // KEIN Flachschreiben: der Wert bleibt leer, der Speicherpfad ist unangetastet.
        expect( input.value ).toBe( '' )
        // Aber die Leere ist erklaert.
        expect( hint ).not.toBe( undefined )
        expect( hint.getAttribute( 'data-pp-multiline' ) ).toBe( '1' )
        expect( hint.textContent ).toContain( '1 von 1' )
        expect( hint.textContent ).toContain( 'MEHRZEILIG' )
    } )


    it( 'AB-F7 Gegenrichtung: ohne mehrzeiligen Block gibt es keinen Hinweis, und die einzeilige Antwort steht im Feld (2 Fragen)', () => {
        const { sandbox, nodes } = buildPopupSandbox( {
            'content': CONTENT,
            'questions': [ { 'id': 'F1', 'title': 'Erste Frage', 'typ': 'single', 'status': 'open', 'options': [] } ]
        } )

        sandbox.__render( null )

        const row = nodes[ 'pp-questions-list' ].children[ 0 ]
        const input = row.children.filter( ( node ) => node.classes.has( 'pp-question-input' ) )[ 0 ]
        const hint = row.children.filter( ( node ) => node.classes.has( 'pp-question-hint' ) )

        expect( input.value ).toBe( 'Eine Zeile, und sie wird angeboten.' )
        expect( hint.length ).toBe( 0 )
    } )
} )


// =================================================================================================
// F-8 — die Spiegelung in die Memo-Datenbank hat einen Adressaten.
// Dieselbe Regel eine Schicht tiefer: die Spiegelung laeuft best-effort NACH der Antwort, ein
// Fehlschlag ging auf die Standard-Fehlerausgabe des SERVERS, die Antwort blieb 200 und der Nutzer las
// „Gespeichert.". Die Quittung darf dabei nicht falsch werden — Datei geschrieben und
// Datenbank-Zeile fehlt ist nicht „gescheitert", sondern UNVOLLSTAENDIG, und die beiden Lagen
// tragen deshalb zwei Saetze.
// =================================================================================================
describe( 'F-8 — eine unvollstaendige Spiegelung erreicht die Oberflaeche', () => {
    const buildBandSandbox = () => {
        const band = makeNode( 'div', 'mirror-banner' )
        band.classList.add( 'mirror-banner-hidden' )
        const sandbox = { 'document': makeDocument( { 'mirror-banner': band } ), console }

        vm.createContext( sandbox )

        return { sandbox, band }
    }


    it( 'AB-F8-Form: die Drahtform wird an EINER Stelle gebaut und traegt alle sieben Felder (1 Bauplatz)', () => {
        const message = MemoView.buildUserInputMirrorMessage( {
            'memoId': '082-orchestrator',
            'transcriptType': 'revision',
            'outcome': { 'status': false, 'inputId': null, 'kind': 'revision', 'answersRecorded': 0, 'messages': [ 'USERINPUT-EXEC-002: record exited non-zero' ] }
        } )

        expect( Object.keys( message ).sort() ).toEqual(
            [ 'answersRecorded', 'inputId', 'kind', 'memoId', 'messages', 'status', 'transcriptType', 'type' ].sort()
        )
        expect( message.type ).toBe( 'userInputMirror' )
        expect( message.status ).toBe( false )
        expect( message.messages.length ).toBe( 1 )
        // EIN Bauplatz: eine zweite Stelle koennte ein Feld weglassen, und niemand saehe es.
        expect( serverSource.split( 'static buildUserInputMirrorMessage(' ).length - 1 ).toBe( 1 )
        // Ein Ergebnis ohne Felder wird nicht zu einer halben Nachricht — `status` ist dann false, nicht
        // „unbekannt als harmlos gelesen".
        expect( MemoView.buildUserInputMirrorMessage( { 'memoId': null, 'transcriptType': null, 'outcome': null } ).status ).toBe( false )
    } )


    it( 'AB-F8-Schweigen: ueber einer sauberen Spiegelung geht NICHTS hinaus, ueber einer gemeldeten schon (2 Lagen)', () => {
        const sauber = MemoView.broadcastUserInputMirror( {
            'memoId': '082', 'transcriptType': 'revision',
            'outcome': { 'status': true, 'inputId': 'UI-7', 'kind': 'revision', 'answersRecorded': 3, 'messages': [] }
        } )
        const gemeldet = MemoView.broadcastUserInputMirror( {
            'memoId': '082', 'transcriptType': 'revision',
            'outcome': { 'status': false, 'messages': [ 'USERINPUT-MEMO-001: empty memo id' ] }
        } )

        // Eine Meldung auf jedem Speichervorgang liest niemand — die Stille ist eine BEDINGUNG, kein Zufall.
        expect( sauber ).toEqual( { 'sent': false, 'reason': 'nothing-to-report' } )
        // Und die gemeldete Lage kommt bis an die Sendestelle: hier ohne Sockel, also mit benanntem Grund
        // statt mit einem stillen Nichts. Das ist die Vergleichsmenge, die die Stille oben erst zu einer
        // Aussage macht.
        expect( gemeldet ).toEqual( { 'sent': false, 'reason': 'no-clients' } )
    } )


    it( 'AB-F8-Naht: BEIDE Ausgaenge melden, die stderr-Zeilen bleiben, und alle Aufrufstellen gehen durch EINE Funktion (Quelltext, 5 Stellen)', () => {
        // Zwei Sendestellen: der Ausnahme-Zweig und der normale Ausgang.
        expect( serverSource.split( 'MemoView.broadcastUserInputMirror( {' ).length - 1 ).toBe( 2 )
        // Die bestehende Server-Protokollierung ist NICHT ersetzt — der Operator behaelt seinen Kanal.
        expect( serverSource ).toContain( 'WARN USERINPUT-CAPTURE-001: user_inputs capture threw (transcript MD unaffected)' )
        expect( serverSource ).toContain( "outcome[ 'messages' ].forEach( ( message ) => process.stderr.write( `  WARN ${ message }\\n` ) )" )
        // Und die Spiegelung bleibt HINTER der Antwort: waere sie davor, haette jeder Speichervorgang
        // einen Kindprozess im Weg.
        const antwort = serverSource.indexOf( "sendJson( res, 200, { 'status': 'ok' } )" )
        const spiegel = serverSource.indexOf( "await MemoView.#captureUserInput( { 'memoId': result[ 'memoId' ]" )

        expect( antwort ).toBeGreaterThan( -1 )
        expect( spiegel ).toBeGreaterThan( antwort )
        // Fuenf Aufrufstellen, EINE Funktion — die Meldung haengt an der Funktion, nicht an der Stelle.
        expect( serverSource.split( 'MemoView.#captureUserInput( {' ).length - 1 ).toBe( 5 )
        expect( serverSource.split( 'static async #captureUserInput(' ).length - 1 ).toBe( 1 )
    } )


    it( 'AB-F8-Band-Fehlschlag: Datei da, Datenbank-Zeile fehlt — der Satz sagt BEIDES (1 Meldung)', async () => {
        const lifted = await extractFunctionSources( [ 'renderUserInputMirror' ] )
        const { sandbox, band } = buildBandSandbox()

        vm.runInContext( `${ lifted.source }\nglobalThis.__mirror = renderUserInputMirror;`, sandbox )
        sandbox.__mirror( {
            'type': 'userInputMirror', 'memoId': '082-orchestrator', 'transcriptType': 'revision',
            'status': false, 'inputId': null, 'kind': 'revision', 'answersRecorded': 0,
            'messages': [ 'USERINPUT-EXEC-002: record exited non-zero' ]
        } )

        expect( band.classList.contains( 'mirror-banner-hidden' ) ).toBe( false )
        expect( band.getAttribute( 'aria-hidden' ) ).toBe( 'false' )
        // Das Memo ist benannt — die Rundmeldung erreicht auch Ansichten, die es nicht zeigen.
        expect( band.textContent ).toContain( '082-orchestrator' )
        // Was fehlt...
        expect( band.textContent ).toContain( 'die Zeile in der Memo-Datenbank fehlt' )
        expect( band.textContent ).toContain( 'USERINPUT-EXEC-002' )
        // ...und was da ist. Die Quittung wird nicht falsch.
        expect( band.textContent ).toContain( 'NUR als Datei' )
        expect( band.textContent ).toContain( 'vollständig auf der Platte' )
    } )


    it( 'AB-F8-Band-Unvollstaendig: gespiegelt, aber nicht vollstaendig ist ein EIGENER Satz (1 Meldung, 2 Antworten)', async () => {
        const lifted = await extractFunctionSources( [ 'renderUserInputMirror' ] )
        const { sandbox, band } = buildBandSandbox()

        vm.runInContext( `${ lifted.source }\nglobalThis.__mirror = renderUserInputMirror;`, sandbox )
        sandbox.__mirror( {
            'type': 'userInputMirror', 'memoId': '082', 'transcriptType': 'revision',
            'status': true, 'inputId': 'UI-7', 'kind': 'revision', 'answersRecorded': 2,
            'messages': [ 'USERINPUT-EXEC-003: record succeeded but no input_id on stdout' ]
        } )

        // Zwei Lagen, zwei Saetze: eingeebnet waere genau die Klasse, die dieses Buendel schliesst.
        expect( band.textContent ).toContain( 'gespiegelt, aber NICHT vollständig' )
        expect( band.textContent ).toContain( '2 Antworten' )
        expect( band.textContent ).not.toContain( 'NUR als Datei' )
        expect( band.classList.contains( 'mirror-banner-hidden' ) ).toBe( false )
    } )


    it( 'AB-F8-Band Gegenrichtung: eine saubere Spiegelung zeigt KEIN Band und nimmt ein altes weg (2 Meldungen)', async () => {
        const lifted = await extractFunctionSources( [ 'renderUserInputMirror' ] )
        const { sandbox, band } = buildBandSandbox()

        vm.runInContext( `${ lifted.source }\nglobalThis.__mirror = renderUserInputMirror;`, sandbox )
        sandbox.__mirror( {
            'status': false, 'memoId': '082', 'answersRecorded': 0,
            'messages': [ 'USERINPUT-MEMO-001: empty memo id' ]
        } )

        expect( band.classList.contains( 'mirror-banner-hidden' ) ).toBe( false )

        sandbox.__mirror( { 'status': true, 'memoId': '082', 'answersRecorded': 3, 'messages': [] } )

        expect( band.classList.contains( 'mirror-banner-hidden' ) ).toBe( true )
        expect( band.textContent ).toBe( '' )
        expect( band.getAttribute( 'aria-hidden' ) ).toBe( 'true' )
    } )


    it( 'AB-F8-Empfaenger: der Klient hoert auf die Nachricht und das Band steht im Geruest (Quelltext, 2 Naehte)', () => {
        expect( clientScript ).toContain( "if( data.type === 'userInputMirror' ) {" )
        expect( clientScript ).toContain( 'renderUserInputMirror( data )' )
        expect( clientScript.split( 'function renderUserInputMirror(' ).length - 1 ).toBe( 1 )
        // Das Band ist ein EIGENES Feld und nicht die Laufzeit-Status-Zeile: zwei Aussagen in einem Feld
        // heisst, dass eine von beiden verloren geht.
        expect( serverSource ).toContain( 'id="mirror-banner"' )
        expect( clientScript ).not.toContain( "getElementById( 'runtime-status' )\n            if( !band )" )
    } )
} )


// =================================================================================================
// Die Klasse als Ganzes — die neun Zeilen der Abnahme, an ihrem Ort nachgemessen.
// =================================================================================================
describe( 'die Klasse — neun Stellen, eine Regel', () => {
    it( 'kein leerer catch mehr auf dem Frage-Zustands-Pfad (Quelltext, 2 Kanaele)', () => {
        // Der leere Auffang-Zweig war der erste Satz des Musters. Er ist weg, und die beiden Kanaele,
        // die ihn ersetzen, sind benannt.
        expect( clientScript ).not.toContain( '.catch( function() {} )\n        }\n\n        // PRD-F3' )
        expect( clientScript.split( 'function showQuestionStateLoadError(' ).length - 1 ).toBe( 1 )
        expect( clientScript.split( 'function showQuestionStateSaveOutcome(' ).length - 1 ).toBe( 1 )
    } )


    it( 'jede der vier neuen Meldungen hat genau EIN Feld und EINEN Bauplatz (4 Kennungen, 1 Bauer)', () => {
        const ids = [ 'qw-state-load-warn', 'qw-state-partial-warn', 'qw-state-carry-warn', 'qw-status-warn' ]
        const counts = ids.map( ( id ) => clientScript.split( `'${ id }'` ).length - 1 )

        // GEMESSEN, nicht geschaetzt: die beiden Zweier sind je EIN Aufstellen und EIN Wegnehmen
        // derselben Kennung (Laden: Fehler und gelungener Nachlauf · Quittung: Meldung und saubere
        // Quittung), die beiden Einser je eine Stelle, die das Feld selbst leert. Keine Kennung steht
        // an zwei Bauplaetzen — das waeren zwei Meldungen, die dasselbe behaupten.
        expect( counts ).toEqual( [ 2, 2, 1, 1 ] )
        // EIN Bauer fuer alle Felder: der create-or-update-Block stand vorher viermal.
        expect( clientScript.split( 'function showQuestionStateBox(' ).length - 1 ).toBe( 1 )
        // Und die bestehende Fehlermeldung ist unveraendert in Kennung und Satz.
        expect( clientScript ).toContain( "'qw-state-save-warn'" )
        expect( clientScript ).toContain( '⚠ Der Antwort-Zustand konnte nicht gespeichert werden' )
    } )
} )
