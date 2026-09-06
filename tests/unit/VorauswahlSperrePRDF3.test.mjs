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


    it( 'A1 — ein Zustand aus einer Frage MIT Vorauswahl ist beruehrt=falsch (1 Frage geprueft)', async () => {
        const { seedQuestionState } = await load()
        const state = seedQuestionState( [ questionWithPreselection ], {} )

        expect( state.length ).toBe( 1 )
        // Die Vorauswahl seedet weiterhin die ANZEIGE — das ist ihre Aufgabe …
        expect( state[ 0 ].selected ).toEqual( [ 0 ] )
        // … sie ist aber keine getroffene Wahl.
        expect( state[ 0 ].touched ).toBe( false )
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
