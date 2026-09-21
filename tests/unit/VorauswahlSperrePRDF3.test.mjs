import { describe, it, expect, beforeAll } from '@jest/globals'
import vm from 'node:vm'

import { extractFunctions, extractFunctionSources, readEmittedScript } from '../helpers/extractFunction.mjs'


// PRD-F3 (Memo 080, Kap 18 — WI-078 / WI-135 / WI-138): Vorauswahl-Sperre und Dubletten-Pruefung.
//
// WI-138: die aus der KI-Empfehlung abgeleitete Vorauswahl seedete den Widget-Zustand direkt als
// AUSWAHL. Es gab kein Feld, das "vom User beruehrt" von "vorgeschlagen" unterschied — die Treffer auf
// "untouched" im Quelltext waren Prosa in Kommentaren, kein Zustand.
// WI-135: der Antwort-Zweig deduplizierte ueber den BLOCKTEXT. Zwei verschiedene Antworten auf dieselbe
// Frage sind zwei verschiedene Strings und kamen beide durch — gemessen im Bestand dieses Memos:
// REV-01--review--01.md traegt 36 Bloecke fuer 18 verschiedene Fragen, F12 einmal als A und einmal als B.
//
// Die Client-Funktionen werden mit dem gemeinsamen Helfer aus dem ausgelieferten Skript gehoben. Jeder
// Fall nennt, wie viel er verglichen hat.
let clientScript = ''


beforeAll( async () => {
    clientScript = await readEmittedScript()
} )


describe( 'PRD-F3 A1/A3 — der Merker "vom User beruehrt" im Widget-Zustand', () => {
    const load = () => extractFunctions( [ 'seedQuestionState', 'markQuestionTouched', 'isPreselectionAnswer', 'answerMarkSuffix' ] )

    const questionWithPreselection = {
        'id': 'F1', 'typ': 'single', 'title': 'Erste Frage',
        'options': [ { 'kind': 'option', 'key': 'A', 'label': 'Eins' }, { 'kind': 'option', 'key': 'B', 'label': 'Zwei' } ],
        'preselected': [ 0 ]
    }


    it( 'A1 — ein Zustand aus einer Frage MIT Vorauswahl traegt KEINE Auswahl (1 Frage geprueft)', async () => {
        const { seedQuestionState } = await load()
        const state = seedQuestionState( [ questionWithPreselection ], {} )

        expect( state.length ).toBe( 1 )
        // M082-09-03 (Memo 082 Kap 20, Frage F15 = A) — DIESER FALL IST UMGEKEHRT WORDEN, und der
        // Name dieser Datei wird damit zum ersten Mal wahr. Bis hierher stand an dieser Stelle
        // `toEqual( [ 0 ] )` mit dem Kommentar "das ist ihre Aufgabe": die Vorauswahl seedete den
        // AUSWAHL-Zustand. Wer dann nur bestaetigte, unterschrieb die Empfehlung, und die so
        // entstandene Zeile landete in `## Beantwortete Fragen` als eigenstaendige Entscheidung.
        //
        // Ab F15=A gilt: eine Vorauswahl seedet die ANZEIGE und ist nie eine Auswahl.
        expect( state[ 0 ].selected ).toEqual( [] )
        // Die Vorauswahl ist nicht verschwunden, sie ist UMGEZOGEN — in ein eigenes Anzeige-Feld,
        // das niemand erntet. Ohne diese Zusicherung waere eine Fassung, die die Vorauswahl einfach
        // wegwirft, von der richtigen nicht zu unterscheiden.
        expect( state[ 0 ].preselected ).toEqual( [ 0 ] )
        // … und sie ist weiterhin keine getroffene Wahl.
        expect( state[ 0 ].touched ).toBe( false )
    } )


    it( 'A1 — auch der Mehrfach-Zweig uebernimmt die Vorauswahl nicht (2 von 2 Typen geprueft)', async () => {
        // Der single-Zweig nahm `pre[ 0 ]`, der multi-Zweig die VOLLE Menge — zwei Zweige, zwei
        // Gelegenheiten. Ein Bau, der nur `single` nachzieht, laesst den anderen stehen; deshalb
        // nennt AB-1 ausdruecklich 2 Faelle und nicht 1.
        const { seedQuestionState } = await load()
        const multi = {
            ...questionWithPreselection,
            'id': 'F2', 'typ': 'multi', 'preselected': [ 0, 1 ]
        }
        const state = seedQuestionState( [ questionWithPreselection, multi ], {} )

        expect( state.length ).toBe( 2 )
        expect( state[ 0 ].selected ).toEqual( [] )
        expect( state[ 1 ].selected ).toEqual( [] )
        expect( state[ 1 ].preselected ).toEqual( [ 0, 1 ] )
        expect( state[ 1 ].touched ).toBe( false )
    } )


    it( 'A1 — das Anzeige-Feld ist von der Auswahl unterscheidbar, nicht ihr Zwilling (1 Frage)', async () => {
        // Positivkontrolle gegen die Nullmenge: das Feld traegt genau dann etwas, wenn die Frage
        // etwas vorauswaehlt. Ohne diesen Gegenfall koennte `preselected` eine Konstante sein.
        const { seedQuestionState } = await load()
        const bare = { ...questionWithPreselection, 'preselected': [] }
        const [ withPre, withoutPre ] = seedQuestionState( [ questionWithPreselection, { ...bare, 'id': 'F3' } ], {} )

        expect( withPre.preselected ).toEqual( [ 0 ] )
        expect( withPre.selected ).toEqual( [] )
        expect( withoutPre.preselected ).toEqual( [] )
        expect( withoutPre.selected ).toEqual( [] )
        expect( withPre.selected ).not.toBe( withPre.preselected )
    } )


    it( 'A1 — auch OHNE Vorauswahl ist der frische Zustand unberuehrt (Gegenprobe, 1 Frage)', async () => {
        const { seedQuestionState } = await load()
        const bare = { ...questionWithPreselection, 'preselected': [] }
        const state = seedQuestionState( [ bare ], {} )

        expect( state[ 0 ].selected ).toEqual( [] )
        expect( state[ 0 ].touched ).toBe( false )
    } )


    it( 'A3 — der Merker ueberlebt ein Neu-Rendering durch Broadcast (1 uebertragener Zustand)', async () => {
        // markQuestionTouched schreibt in den Modul-Zustand questionNav, laeuft also in einer Sandbox
        // mit genau diesem Zustand — nicht gegen eine Attrappe, sondern gegen den echten Setzer.
        const lifted = await extractFunctionSources( [ 'seedQuestionState', 'markQuestionTouched' ] )
        const sandbox = { 'questionNav': { 'state': [] }, console }
        vm.createContext( sandbox )
        vm.runInContext( `${ lifted[ 'source' ] }\nglobalThis.__seed = seedQuestionState;\nglobalThis.__touch = markQuestionTouched;`, sandbox )

        const first = sandbox.__seed( [ questionWithPreselection ], {} )
        expect( first[ 0 ].touched ).toBe( false )

        // Der User arbeitet an der Frage — durch den ECHTEN Setzer, nicht durch eine Zuweisung im Test.
        sandbox.questionNav.state = first
        sandbox.__touch( 0 )
        expect( first[ 0 ].touched ).toBe( true )

        // Der Broadcast rendert neu: derselbe Zustand wird uebertragen, der Merker bleibt.
        const carried = sandbox.__seed( [ questionWithPreselection ], { 'F1': first[ 0 ] } )

        expect( carried[ 0 ].touched ).toBe( true )
        expect( carried[ 0 ] ).toBe( first[ 0 ] )
    } )


    it( 'A3 — ein Zustand OHNE das Feld wird auf falsch normalisiert, nie auf wahr geraten', async () => {
        const { seedQuestionState } = await load()
        const legacy = { 'selected': [ 0 ], 'custom': [], 'added': false, 'addedText': null, 'rejected': false }
        const carried = seedQuestionState( [ questionWithPreselection ], { 'F1': legacy } )

        expect( carried[ 0 ].touched ).toBe( false )
    } )


    it( 'AB-3 — ein ECHTER, beruehrter Zustand ueberlebt die Rundmeldung unveraendert (1 Zustand)', async () => {
        // M082-09-03: die Gegenprobe zu A1. Ohne sie waere eine Fassung, die JEDE Auswahl leert, von
        // der richtigen nicht zu unterscheiden — dieser Auftrag entfernt eine erfundene Auswahl, nie
        // eine gewachsene. Die Indizes liegen gueltig in der heutigen Optionsliste (2 Optionen).
        const { seedQuestionState } = await load()
        const real = { 'selected': [ 1 ], 'custom': [ 'eigener Eintrag' ], 'added': false, 'addedText': null, 'rejected': false, 'touched': true }
        const carried = seedQuestionState( [ questionWithPreselection ], { 'F1': real } )

        expect( carried[ 0 ].selected ).toEqual( [ 1 ] )
        expect( carried[ 0 ].custom ).toEqual( [ 'eigener Eintrag' ] )
        expect( carried[ 0 ].touched ).toBe( true )
        // Der Anzeige-Hinweis gehoert zur FRAGE, nicht zum uebertragenen Zustand: er wird am
        // uebertragenen Objekt nachgefuehrt, damit die Karte nicht die Vorauswahl einer Nutzlast
        // zeigt, die es nicht mehr gibt.
        expect( carried[ 0 ].preselected ).toEqual( [ 0 ] )
    } )


    it( 'markQuestionTouched ist der EINZIGE Setzer — der Quelltext kennt keine zweite Zuweisung', () => {
        // Ein zweiter Setzer waere genau die Stelle, an der die Sperre spaeter still wieder aufgeht.
        const assignments = clientScript.match( /\.touched = /g ) || []
        const normalisation = clientScript.match( /prev\.touched = prev\.touched === true/g ) || []
        const setter = clientScript.match( /st\.touched = true/g ) || []

        // 2 Vorkommen: die Normalisierung beim Uebertrag und der eine Setzer in markQuestionTouched.
        expect( assignments.length ).toBe( 2 )
        expect( normalisation.length ).toBe( 1 )
        expect( setter.length ).toBe( 1 )
    } )
} )


describe( 'PRD-F3 A7-Vorstufe — die Provenienz-Marke am Antwort-Kopf', () => {
    const load = () => extractFunctions( [ 'isPreselectionAnswer', 'answerMarkSuffix', 'buildAnswerText' ], [ 'REFORMULATION_KINDS' ] )

    const question = {
        'id': 'F1', 'typ': 'single', 'title': 'Erste Frage',
        'options': [ { 'kind': 'option', 'key': 'A', 'label': 'Eins' }, { 'kind': 'option', 'key': 'B', 'label': 'Zwei' } ],
        'preselected': [ 0 ]
    }
    const stateWith = ( selected, custom ) => ( { 'selected': selected, 'custom': custom || [], 'added': false, 'addedText': null, 'rejected': false, 'touched': true } )


    it( 'die bestaetigte Antwort AUF der Vorauswahl traegt die Marke (1 von 2 Faellen)', async () => {
        const { answerMarkSuffix, buildAnswerText } = await load()

        expect( answerMarkSuffix( question, stateWith( [ 0 ] ) ) ).toBe( ' [Vorauswahl]' )
        expect( buildAnswerText( question, stateWith( [ 0 ] ) ).text ).toContain( '## Antwort auf F1 — Erste Frage [Vorauswahl]' )
    } )


    it( 'eine ABWEICHENDE Antwort traegt sie nicht — sonst waere die Spalte wieder nichtssagend', async () => {
        const { answerMarkSuffix, buildAnswerText } = await load()

        expect( answerMarkSuffix( question, stateWith( [ 1 ] ) ) ).toBe( '' )
        expect( buildAnswerText( question, stateWith( [ 1 ] ) ).text ).not.toContain( '[Vorauswahl]' )
    } )


    it( 'ohne Vorauswahl und ohne Auswahl gibt es keine Marke (2 Gegenproben)', async () => {
        const { answerMarkSuffix } = await load()

        expect( answerMarkSuffix( { ...question, 'preselected': [] }, stateWith( [ 0 ] ) ) ).toBe( '' )
        expect( answerMarkSuffix( question, stateWith( [] ) ) ).toBe( '' )
    } )


    it( 'ein eigener Eintrag neben der Vorauswahl ist keine Vorauswahl mehr', async () => {
        const { answerMarkSuffix } = await load()

        expect( answerMarkSuffix( question, stateWith( [ 0 ], [ 'etwas eigenes' ] ) ) ).toBe( '' )
    } )
} )


describe( 'PRD-F3 A4/A5/A6 — die Dubletten-Pruefung ueber die Frage-Kennung', () => {
    const load = () => extractFunctions( [ 'mergeAnswerBlocks', 'scanAnswerBlocks' ] )
    const block = ( id, text ) => `## Antwort auf ${ id } — Frage ${ id }\n\n${ text }\n`
    const count = ( content, id ) => ( content.match( new RegExp( `## Antwort auf ${ id }`, 'g' ) ) || [] ).length


    it( 'A4 — zweimal dasselbe zusammensetzen ergibt je Kennung GENAU einen Block', async () => {
        const { mergeAnswerBlocks } = await load()
        const blocks = [ block( 'F1', 'Antwort eins' ), block( 'F2', 'Antwort zwei' ) ]

        const first = mergeAnswerBlocks( 'Gesprochener Text.', blocks )
        const second = mergeAnswerBlocks( first.content, blocks )

        expect( first.appended ).toBe( 2 )
        expect( second.appended ).toBe( 0 )
        expect( second.unchanged ).toBe( 2 )
        expect( second.compared ).toBe( 2 )
        expect( count( second.content, 'F1' ) ).toBe( 1 )
        expect( count( second.content, 'F2' ) ).toBe( 1 )
        expect( second.content ).toBe( first.content )
    } )


    it( 'A5 — eine geaenderte Antwort ERSETZT den Block, statt einen zweiten anzulegen', async () => {
        const { mergeAnswerBlocks } = await load()
        const first = mergeAnswerBlocks( 'Text.', [ block( 'F1', 'alte Antwort' ) ] )
        const second = mergeAnswerBlocks( first.content, [ block( 'F1', 'neue Antwort' ) ] )

        expect( second.replaced ).toBe( 1 )
        expect( second.appended ).toBe( 0 )
        expect( count( second.content, 'F1' ) ).toBe( 1 )
        expect( second.content ).toContain( 'neue Antwort' )
        expect( second.content ).not.toContain( 'alte Antwort' )
    } )


    it( 'A5 — die BEKANNTE Doppelung (Beleg 18.4) faellt: 2 Bloecke fuer F12 werden 1', async () => {
        // Nachgebaut aus dem gemessenen Bestand: F12 steht in derselben Aufzeichnung einmal mit
        // Option A und einmal mit Option B. Eine Textgleichheits-Pruefung laesst beide durch.
        const { mergeAnswerBlocks } = await load()
        const damaged = [ 'Text.', '', block( 'F12', 'A) erste Antwort' ).trim(), '', block( 'F12', 'B) zweite Antwort' ).trim() ].join( '\n' )
        const merged = mergeAnswerBlocks( damaged, [ block( 'F12', 'B) zweite Antwort' ) ] )

        expect( count( damaged, 'F12' ) ).toBe( 2 )
        expect( merged.compared ).toBe( 2 )
        expect( merged.dropped ).toBe( 1 )
        expect( count( merged.content, 'F12' ) ).toBe( 1 )
        expect( merged.content ).not.toContain( 'erste Antwort' )
    } )


    it( 'eine Textgleichheits-Pruefung haette den Fall NICHT gefangen (Schaerfe-Gegenprobe)', async () => {
        const { mergeAnswerBlocks } = await load()
        const existing = mergeAnswerBlocks( 'Text.', [ block( 'F1', 'A) eins' ) ] ).content
        const changed = block( 'F1', 'B) zwei' )

        // Genau das war die Luecke: der neue Block steht nicht im Inhalt, also haette der alte
        // Filter ihn ANGEHAENGT — der Merge ueber die Kennung ersetzt stattdessen.
        expect( existing.indexOf( changed.trim() ) ).toBe( -1 )
        expect( count( mergeAnswerBlocks( existing, [ changed ] ).content, 'F1' ) ).toBe( 1 )
    } )


    it( 'A6 — die Pruefung gibt die Zahl der verglichenen Bloecke zurueck', async () => {
        const { mergeAnswerBlocks } = await load()
        const content = mergeAnswerBlocks( 'Text.', [ block( 'F1', 'a' ), block( 'F2', 'b' ), block( 'F3', 'c' ) ] ).content
        const again = mergeAnswerBlocks( content, [ block( 'F2', 'b neu' ) ] )

        expect( again.markers ).toBe( 3 )
        expect( again.compared ).toBe( 3 )
        expect( again.replaced ).toBe( 1 )
    } )


    it( 'A6 — ohne vollstaendige Vergleichsmenge meldet sie ROT und aendert nichts', async () => {
        const { mergeAnswerBlocks } = await load()
        const unreadable = [ 'Text.', '', '## Antwort auf (ohne Kennung)', '', 'irgendwas' ].join( '\n' )
        const merged = mergeAnswerBlocks( unreadable, [ block( 'F1', 'eins' ) ] )

        expect( merged.ok ).toBe( false )
        expect( merged.markers ).toBe( 1 )
        expect( merged.compared ).toBe( 0 )
        expect( merged.reason ).toContain( '1 von 1' )
        expect( merged.content ).toBe( unreadable.trim() )
    } )


    it( 'eine leere Vergleichsmenge OHNE Antwort-Ueberschriften ist gruen — dort gibt es nichts zu vergleichen', async () => {
        // Positivkontrolle zur roten Regel: "nichts gefunden" ist nur dann rot, wenn Bloecke da sein
        // MUESSTEN. Ein reiner Text ohne Antwort-Ueberschrift ist ein legitimer Nullfall.
        const { mergeAnswerBlocks } = await load()
        const merged = mergeAnswerBlocks( 'Nur gesprochener Text.', [ block( 'F1', 'eins' ) ] )

        expect( merged.ok ).toBe( true )
        expect( merged.markers ).toBe( 0 )
        expect( merged.compared ).toBe( 0 )
        expect( merged.appended ).toBe( 1 )
    } )


    it( 'fremde "## "-Abschnitte bleiben unangetastet (Anmerkungen, Quality-Checks)', async () => {
        const { mergeAnswerBlocks } = await load()
        const content = [ 'Text.', '', block( 'F1', 'eins' ).trim(), '', '## Anmerkungen', '', '### ANM-001 — Anmerkung 1' ].join( '\n' )
        const merged = mergeAnswerBlocks( content, [ block( 'F1', 'zwei' ) ] )

        expect( merged.content ).toContain( '## Anmerkungen' )
        expect( merged.content ).toContain( '### ANM-001 — Anmerkung 1' )
        expect( merged.content ).toContain( 'zwei' )
        expect( count( merged.content, 'F1' ) ).toBe( 1 )
    } )
} )


// M082-09-03 (Memo 082 Kap 20, Frage F15 = A) — die Tastatur-Wege und der Beleg-Fehler.
//
// Die beiden Wege sind EIGENE Faelle, weil sie verschieden lose gebaut waren: das blanke `Enter`
// bestaetigte die AKTIVE Frage (nach dem Rendern die erste), `Strg/Cmd+L` bestaetigte AUSSERHALB
// seiner eigenen Auswahl-Bedingung, also auch ohne fokussierte Option. Ein Bau, der nur einen der
// beiden nachzieht, laesst den anderen fallen.
//
// GEWAEHLTE FORM: wirkungslos MIT sichtbarem Hinweis. Die dritte Form — stilles Nichts — ist
// ausdruecklich nicht gebaut: sie ist von einer geglueckten Bestaetigung an der Tastatur nicht zu
// unterscheiden, und genau das hat den Fehler so lange getragen.
describe( 'M082-09-03 (F15=A) — die Tastatur-Wege verlangen eine tatsaechliche Auswahl', () => {
    // Eine Attrappe des Dokuments, weil die Hinweis-Funktionen echte DOM-Aufrufe machen. Sie hat
    // genau die vier Methoden, die der gehobene Quelltext benutzt — keine Nachbildung eines Browsers,
    // sondern die Nennung dessen, was die Funktion anfasst.
    const buildStubDom = () => {
        const tracked = { 'hint': null, 'removed': 0, 'insertedInto': null }
        // GEMESSEN, und es hat einen roten Playwright-Lauf gekostet: `.qw-footer` ist ein NACHFAHRE
        // der Karte, kein Kind von ihr. Eine Attrappe, in der der Fuss direkt an der Karte haengt,
        // ist gruen, waehrend der Browser `NotFoundError` wirft — der Hinweis erscheint dann nie,
        // also genau das stille Nichts, gegen das dieses Tor gebaut ist. Die Attrappe bildet die
        // Schachtelung deshalb nach: Karte -> Koerper -> Fuss.
        const inner = {
            'nodes': [],
            'insertBefore': function( node ) {
                node.parentNode = inner
                inner.nodes.push( node )
                tracked.hint = node
                tracked.insertedInto = 'qw-footer-parent'
            },
            'removeChild': function( node ) {
                inner.nodes = inner.nodes.filter( ( entry ) => entry !== node )
                tracked.hint = null
                tracked.removed = tracked.removed + 1
            }
        }
        const footer = { 'className': 'qw-footer', 'parentNode': inner }
        const card = {
            'nodes': [],
            'querySelector': ( selector ) => ( selector === '.qw-footer' ? footer : null ),
            'appendChild': function( node ) {
                node.parentNode = card
                card.nodes.push( node )
                tracked.hint = node
                tracked.insertedInto = 'card'
            },
            'removeChild': function( node ) {
                card.nodes = card.nodes.filter( ( entry ) => entry !== node )
                tracked.hint = null
                tracked.removed = tracked.removed + 1
            }
        }
        const doc = {
            'createElement': () => ( {
                'className': '', 'id': '', 'textContent': '', 'attributes': {}, 'parentNode': null,
                'setAttribute': function( key, value ) { this.attributes[ key ] = value }
            } ),
            'querySelector': ( selector ) => ( selector.indexOf( '.qw-card' ) !== -1 ? card : null ),
            'getElementById': ( id ) => ( tracked.hint !== null && tracked.hint.id === id ? tracked.hint : null )
        }

        return { doc, card, tracked }
    }

    const loadGate = async ( state ) => {
        const lifted = await extractFunctionSources( [ 'hasUserChoice', 'clearNoSelectionHint', 'showNoSelectionHint', 'confirmQuestionByKeyboard' ] )
        const dom = buildStubDom()
        const submitted = []
        const sandbox = {
            'questionNav': { 'state': state },
            'document': dom.doc,
            'submitQuestionAnswer': ( idx ) => { submitted.push( idx ) },
            console
        }
        vm.createContext( sandbox )
        vm.runInContext( `${ lifted[ 'source' ] }\nglobalThis.__confirm = confirmQuestionByKeyboard;`, sandbox )

        return { 'confirm': sandbox.__confirm, submitted, dom }
    }

    const seeded = ( extra ) => ( { 'selected': [], 'preselected': [ 0 ], 'custom': [], 'added': false, 'addedText': null, 'rejected': false, 'touched': false, ...( extra || {} ) } )


    it( 'AB-6 — `Enter` ohne Auswahl bestaetigt nichts und zeigt einen Hinweis (1 Frage, 1 Druck)', async () => {
        const { confirm, submitted, dom } = await loadGate( [ seeded() ] )

        const verdict = confirm( 0, 'Enter' )

        expect( verdict ).toBe( false )
        // Nichts bestaetigt …
        expect( submitted ).toEqual( [] )
        // … und nicht still: der Hinweis steht in der Karte und nennt den Weg, der nichts bewirkt hat.
        expect( dom.tracked.hint ).not.toBeNull()
        expect( dom.tracked.hint.id ).toBe( 'qw-no-selection-hint' )
        expect( dom.tracked.hint.attributes[ 'data-qw-no-selection' ] ).toBe( '1' )
        expect( dom.tracked.hint.textContent ).toContain( 'Enter' )
        expect( dom.tracked.hint.textContent ).toContain( 'keine Auswahl' )
        // Er haengt am Elternknoten des Fusses — nicht an der Karte. Der Unterschied ist im Browser
        // ein `NotFoundError` und damit ein unsichtbarer Hinweis.
        expect( dom.tracked.insertedInto ).toBe( 'qw-footer-parent' )
    } )


    it( 'AB-7 — `Strg/Cmd+L` ohne fokussierte Option bestaetigt nichts und zeigt einen Hinweis', async () => {
        const { confirm, submitted, dom } = await loadGate( [ seeded() ] )

        const verdict = confirm( 0, 'Strg/Cmd+L' )

        expect( verdict ).toBe( false )
        expect( submitted ).toEqual( [] )
        expect( dom.tracked.hint ).not.toBeNull()
        expect( dom.tracked.hint.textContent ).toContain( 'Strg/Cmd+L' )
    } )


    it( 'Positivkontrolle: MIT Auswahl bestaetigen beide Wege, und der Hinweis verschwindet (2 Wege)', async () => {
        // Ohne diese Richtung waere eine Fassung, die NIE bestaetigt, von der richtigen nicht zu
        // unterscheiden — dieselbe Klasse wie AB-5 zu AB-4.
        const enter = await loadGate( [ seeded( { 'selected': [ 1 ] } ) ] )
        expect( enter.confirm( 0, 'Enter' ) ).toBe( true )
        expect( enter.submitted ).toEqual( [ 0 ] )

        const shortcut = await loadGate( [ seeded( { 'selected': [ 1 ] } ) ] )
        expect( shortcut.confirm( 0, 'Strg/Cmd+L' ) ).toBe( true )
        expect( shortcut.submitted ).toEqual( [ 0 ] )

        // Ein eigener Eintrag ohne angeklickte Option ist ebenfalls eine tatsaechliche Aeusserung.
        const custom = await loadGate( [ seeded( { 'custom': [ 'etwas eigenes' ] } ) ] )
        expect( custom.confirm( 0, 'Enter' ) ).toBe( true )
        expect( custom.submitted ).toEqual( [ 0 ] )
    } )


    it( 'die Vorauswahl allein oeffnet das Tor NICHT — sie ist kein Auswahl-Ersatz (1 Frage)', async () => {
        // Die Schaerfe-Probe: der Zustand traegt eine nicht leere Vorauswahl und sonst nichts. Ein
        // Tor, das `preselected` mitlesen wuerde, waere hier gruen — und der Befund waere zurueck.
        const { confirm, submitted } = await loadGate( [ seeded( { 'preselected': [ 0, 1 ] } ) ] )

        expect( confirm( 0, 'Enter' ) ).toBe( false )
        expect( submitted ).toEqual( [] )
    } )


    it( 'ein bereits bestaetigter Eintrag bleibt per Tastatur ruecknehmbar (Rueckgaengig-Pfad)', async () => {
        // Eine Ruecknahme ist keine Bestaetigung. Waere sie mitgesperrt, koennte eine ohne Auswahl
        // bestaetigte Antwort per Tastatur nicht mehr zurueckgenommen werden.
        const { confirm, submitted } = await loadGate( [ seeded( { 'added': true, 'addedText': '## Antwort auf F1 — Erste Frage\n\n\n' } ) ] )

        expect( confirm( 0, 'Enter' ) ).toBe( true )
        expect( submitted ).toEqual( [ 0 ] )
    } )


    it( 'beide Tastatur-Wege gehen durch DAS EINE Tor — kein zweiter Weg an ihm vorbei', async () => {
        // Gehaertet nach demselben Muster wie "markQuestionTouched ist der EINZIGE Setzer": ein
        // zweiter direkter Aufruf aus dem Tastatur-Handler waere genau die Stelle, an der die
        // Bindung spaeter still wieder aufgeht. Vergleichsmenge: der ganze ausgelieferte Quelltext.
        const gateCalls = clientScript.match( /confirmQuestionByKeyboard\( questionNav\.active, /g ) || []
        const gateDefinition = clientScript.match( /function confirmQuestionByKeyboard\(/g ) || []
        const predicate = clientScript.match( /function hasUserChoice\(/g ) || []

        expect( clientScript.length ).toBeGreaterThan( 0 )
        // 2 Aufrufe: `Enter` und `Strg/Cmd+L`. Eine Definition, ein Praedikat.
        expect( gateCalls.length ).toBe( 2 )
        expect( gateDefinition.length ).toBe( 1 )
        expect( predicate.length ).toBe( 1 )
    } )
} )


describe( 'M082-09-03 (F15=A) — der Kommentar behauptet keine Sperre mehr', () => {
    it( 'AB-8 — der ausgelieferte Quelltext behauptet keine "Vorauswahl-Sperre" als Systemeigenschaft', () => {
        // Der Beleg-Fehler war langlebiger als der Logik-Fehler: eine von Hand in EIN Memo
        // geschriebene Uebergangsmassnahme stand im Kommentar als Systemeigenschaft. Vergleichsmenge:
        // der ganze ausgelieferte Quelltext, und dass er nicht leer ist, wird zuerst gezeigt.
        expect( clientScript.length ).toBeGreaterThan( 0 )
        expect( clientScript ).not.toContain( 'Vorauswahl-Sperre' )
        // Die Regel steht dafuer als Satz da, und sie ist jetzt auch das, was der Kode tut.
        expect( clientScript ).toContain( 'THE PRESELECTION SEEDS THE DISPLAY AND IS NOT A DECISION' )
        // Und die Hand-Mitigation ist ausdruecklich als abgelaufen benannt.
        expect( clientScript ).toContain( 'THE HAND MITIGATION HAS EXPIRED' )
    } )
} )
