import { describe, it, expect, beforeAll } from '@jest/globals'
import vm from 'node:vm'

import { extractFunctionSources, sliceDeclaration, readEmittedScript } from '../helpers/extractFunction.mjs'


// PRD-22 (Memo 081, Kap 19 — WI-130 / WI-109 / WI-110): die laute Kante vor dem Senden.
//
// WI-130: der Export filterte still auf `st.added === true && st.addedText`. Eine ausgewaehlte, aber
// nicht bestaetigte Antwort fiel ohne Hinweis, ohne Zaehl-Diskrepanz und ohne Rueckfrage heraus. Der
// Rueckgabewert nannte `count` — wie viele Bloecke AUFGENOMMEN wurden — aber nirgends, wie viele
// Zustaende GEPRUEFT wurden. Ohne Vergleichsmenge kann kein Aufrufer "nichts war da" von "etwas wurde
// weggelassen" unterscheiden.
// WI-109 (behoben, wird NICHT zurueckgenommen): das Antwort-Feld wird nur aus der bestaetigten
// Antwort vorbelegt. Dieses PRD benennt die unbestaetigte Auswahl — es erntet sie nicht.
// WI-110: der Regressionsbeweis fuer WI-109 lag nur im Scratchpad und schuetzte die naechste
// Aenderung deshalb nicht. Diese Datei ist die Ueberfuehrung in die Testsuite (REV-16 :1752).
//
// Die Client-Funktionen laufen in einer vm-Sandbox mit echtem `questionNav`-Modul-Zustand, nicht
// gegen eine Attrappe. Jeder Fall nennt in seinem Titel, wie viel er geprueft hat.
let clientScript = ''


// Der Zustand traegt keine Frage-Kennung (seedQuestionState); die Zuordnung laeuft index-parallel
// ueber questionNav.questions. Deshalb stellt die Sandbox beide Arrays.
async function loadSandbox( state, questions ) {
    const script = await readEmittedScript()
    const lifted = await extractFunctionSources( [
        'isConfirmedAnswer', 'collectAddedAnswers', 'appendAddedAnswers', 'unconfirmedNotice',
        'buildAnswerText', 'answerMarkSuffix', 'isPreselectionAnswer'
    ] )
    // Die ECHTE Deklaration wird mitgehoben, nicht im Test nachgebaut: eine Kopie bliebe gruen,
    // genau wenn die Produktions-Liste waechst und die Funktion sich anders verhaelt.
    const decl = sliceDeclaration( script, 'REFORMULATION_KINDS' )

    const sandbox = { questionNav: { state: state, questions: questions || [] }, console }
    vm.createContext( sandbox )
    vm.runInContext(
        `${ decl }\n${ lifted[ 'source' ] }\n`
        + 'globalThis.__collect = collectAddedAnswers;\n'
        + 'globalThis.__append = appendAddedAnswers;\n'
        + 'globalThis.__notice = unconfirmedNotice;',
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

// Bestaetigt = hinzugefuegt UND beruehrt. Ausgewaehlt = eine Absicht, mehr nicht.
const confirmed = ( id, text ) => ( { 'selected': [ 0 ], 'custom': [], 'added': true, 'addedText': block( id, text ), 'rejected': false, 'touched': true } )
const selectedOnly = () => ( { 'selected': [ 1 ], 'custom': [], 'added': false, 'addedText': null, 'rejected': false, 'touched': true } )
const untouched = () => ( { 'selected': [], 'custom': [], 'added': false, 'addedText': null, 'rejected': false, 'touched': false } )


beforeAll( async () => {
    clientScript = await readEmittedScript()
} )


describe( 'PRD-22 A1/A2 — der Sammler nennt, was er auslaesst', () => {
    it( 'T1 — die bestaetigte Antwort steht im Inhalt und NICHT unter den Ausgelassenen (1 Frage geprueft)', async () => {
        const sandbox = await loadSandbox( [ confirmed( 'F1', 'A) bestätigt' ) ], [ question( 'F1' ) ] )
        const collected = sandbox.__collect()

        expect( collected.compared ).toBe( 1 )
        expect( collected.count ).toBe( 1 )
        expect( collected.content ).toContain( 'A) bestätigt' )
        expect( collected.skipped.length ).toBe( 0 )
    } )


    it( 'T2 — ausgewaehlt, nicht bestaetigt: NICHT geerntet (WI-109) UND benannt (WI-130) (1 Frage geprueft)', async () => {
        // Das Assert-Paar. Faellt eine der beiden Haelften, ist der Fall rot — auch wenn die andere
        // gruen ist: ein `skipped`, das die Frage nennt UND sie exportiert, waere die Ruecknahme von
        // WI-109; ein `content` ohne Nennung waere der unveraenderte Defekt.
        const sandbox = await loadSandbox( [ selectedOnly() ], [ question( 'F26' ) ] )
        const collected = sandbox.__collect()

        // WI-109 gehalten: die Absicht wird nicht geerntet.
        expect( collected.count ).toBe( 0 )
        expect( collected.content ).toBe( '' )
        expect( collected.content ).not.toContain( 'Zwei' )
        // WI-130 erfuellt: sie wird benannt — mit Kennung, Titel und lesbarer Absicht.
        expect( collected.compared ).toBe( 1 )
        expect( collected.skipped.length ).toBe( 1 )
        expect( collected.skipped[ 0 ].id ).toBe( 'F26' )
        expect( collected.skipped[ 0 ].title ).toBe( 'Frage F26' )
        expect( collected.skipped[ 0 ].intent ).toBe( 'B) Zwei' )
    } )


    it( 'T3 — eine unberuehrte Frage ohne Auswahl wird weder geerntet noch gemeldet (1 Frage geprueft)', async () => {
        // Sonst meldete die Kante bei jedem Speichern Rauschen und waere nach drei Tagen unsichtbar.
        const sandbox = await loadSandbox( [ untouched() ], [ question( 'F1' ) ] )
        const collected = sandbox.__collect()

        expect( collected.compared ).toBe( 1 )
        expect( collected.count ).toBe( 0 )
        expect( collected.skipped.length ).toBe( 0 )
    } )


    it( 'T4 — die Zaehl-Diskrepanz: 3 geprueft, 1 aufgenommen, 1 ausgelassen (3 Fragen geprueft)', async () => {
        const sandbox = await loadSandbox(
            [ confirmed( 'F1', 'A) bestätigt' ), selectedOnly(), untouched() ],
            [ question( 'F1' ), question( 'F27' ), question( 'F3' ) ]
        )
        const collected = sandbox.__collect()

        // Genau diese drei Zahlen fehlten: ohne `compared` ist `count: 1` nicht von "es gab nur eine"
        // zu unterscheiden.
        expect( collected.compared ).toBe( 3 )
        expect( collected.count ).toBe( 1 )
        expect( collected.skipped.length ).toBe( 1 )
        expect( collected.skipped[ 0 ].id ).toBe( 'F27' )
    } )


    it( 'ohne passende Frage faellt die Kennung auf die Position zurueck, nie auf eine erfundene (1 Frage geprueft)', async () => {
        const sandbox = await loadSandbox( [ selectedOnly() ], [] )
        const collected = sandbox.__collect()

        expect( collected.skipped.length ).toBe( 1 )
        expect( collected.skipped[ 0 ].id ).toBe( 'Frage 1' )
        expect( collected.skipped[ 0 ].title ).toBe( '' )
    } )
} )


describe( 'PRD-22 A4 — die Meldung nennt BEIDE Zahlen', () => {
    it( 'T5 — der Text nennt Ausgelassene, Vergleichsmenge und jede Kennung (7 Fragen geprueft)', async () => {
        // Sieben Zustaende: 4 bestaetigt, 2 nur ausgewaehlt, 1 unberuehrt.
        const state = [
            confirmed( 'F1', 'A) eins' ), confirmed( 'F2', 'A) zwei' ), confirmed( 'F3', 'A) drei' ),
            confirmed( 'F4', 'A) vier' ), selectedOnly(), selectedOnly(), untouched()
        ]
        const questions = [ 'F1', 'F2', 'F3', 'F4', 'F26', 'F27', 'F7' ].map( question )
        const sandbox = await loadSandbox( state, questions )
        const notice = sandbox.__notice()

        expect( notice.count ).toBe( 2 )
        expect( notice.compared ).toBe( 7 )
        // Beide Zahlen im Text. "2 Fragen nicht uebernommen" ohne die Vergleichsmenge waere genau die
        // Blindheit, die dieses PRD behebt — sie in der Behebung zu wiederholen waere der peinlichste
        // denkbare Ausgang.
        expect( notice.text ).toContain( '2 von 7' )
        expect( notice.text ).toContain( 'F26' )
        expect( notice.text ).toContain( 'F27' )
        // Der Handlungshinweis aus REV-16 :1750, wortgleich zum Platzhalter am Feld.
        expect( notice.text ).toContain( 'Hinzufügen' )
    } )


    it( 'T5 — ohne ausgelassene Absicht bleibt der Text leer (3 Fragen geprueft)', async () => {
        const sandbox = await loadSandbox(
            [ confirmed( 'F1', 'A) eins' ), confirmed( 'F2', 'A) zwei' ), untouched() ],
            [ question( 'F1' ), question( 'F2' ), question( 'F3' ) ]
        )
        const notice = sandbox.__notice()

        expect( notice.compared ).toBe( 3 )
        expect( notice.count ).toBe( 0 )
        expect( notice.text ).toBe( '' )
    } )


    it( 'gar keine Fragen ist ein legitimer Nullfall und bleibt still (0 Fragen geprueft)', async () => {
        const sandbox = await loadSandbox( [], [] )
        const notice = sandbox.__notice()

        expect( notice.compared ).toBe( 0 )
        expect( notice.text ).toBe( '' )
    } )


    it( 'eine leere Vergleichsgrundlage bei vorhandenen Eintraegen ist NICHT still (2 Eintraege, 0 lesbar)', async () => {
        // Positivkontrolle zur roten Regel: "nichts gefunden" ist gruen nur dort, wo nichts sein
        // musste. Zwei Eintraege, von denen keiner lesbar ist, sind eine fehlende Vergleichsgrundlage
        // und werden gemeldet — dieselbe Unterscheidung, die mergeAnswerBlocks zwischen markers und
        // compared trifft.
        const sandbox = await loadSandbox( [ null, null ], [ question( 'F1' ), question( 'F2' ) ] )
        const notice = sandbox.__notice()

        expect( notice.compared ).toBe( 0 )
        expect( notice.text ).toContain( '0 von 2' )
        expect( notice.text ).toContain( 'Vergleichsgrundlage' )
    } )
} )


describe( 'PRD-22 A6 — der Export ist byte-identisch geblieben', () => {
    // Die Erwartungen sind GEMESSEN am unveraenderten Stand (repos/viewer, main, HEAD 0d9ecbb) und
    // nicht frei gewaehlt: dort lieferte collectAddedAnswers die Schluessel ["count","content"] und
    // appendAddedAnswers exakt die Zeichenketten unten.
    const BASELINE_CONTENT = '## Antwort auf F1 — Frage F1\n\nA) bestätigt\n'
    const BASELINE_APPENDED = 'Gesprochener Text.\n\n## Antwort auf F1 — Frage F1\n\nA) bestätigt\n'

    const mixedState = () => [ confirmed( 'F1', 'A) bestätigt' ), selectedOnly(), untouched() ]
    const mixedQuestions = () => [ question( 'F1' ), question( 'F27' ), question( 'F3' ) ]


    it( 'T6 — appendAddedAnswers liefert fuer denselben Zustand denselben String wie vorher (3 Zustaende)', async () => {
        const sandbox = await loadSandbox( mixedState(), mixedQuestions() )

        expect( sandbox.__collect().content ).toBe( BASELINE_CONTENT )
        expect( sandbox.__append( 'Gesprochener Text.' ) ).toBe( BASELINE_APPENDED )
        expect( sandbox.__append( '' ) ).toBe( BASELINE_CONTENT )
    } )


    it( 'T6 — die unbestaetigte Absicht steht NICHT im Export, obwohl sie gemeldet wird (3 Zustaende)', async () => {
        // Der Kern von S2: der Inhalt aendert sich nicht, nur der Bericht darueber.
        const sandbox = await loadSandbox( mixedState(), mixedQuestions() )
        const appended = sandbox.__append( 'Gesprochener Text.' )

        expect( appended ).not.toContain( 'F27' )
        expect( appended ).not.toContain( 'Zwei' )
        expect( sandbox.__notice().text ).toContain( 'F27' )
    } )


    it( 'T6 — zweimal Anhaengen bleibt idempotent (3 Zustaende, 2 Durchlaeufe)', async () => {
        const sandbox = await loadSandbox( mixedState(), mixedQuestions() )
        const once = sandbox.__append( 'Gesprochener Text.' )

        expect( sandbox.__append( once ) ).toBe( BASELINE_APPENDED )
    } )
} )


describe( 'PRD-22 A3 — WI-109 ist nicht zurueckgenommen', () => {
    it( 'T7 — die Wache am Antwort-Feld traegt weiterhin alle drei Glieder (1 Wache geprueft)', () => {
        // Die Bedingung ist seit M080 PRD-F3 VIERGLIEDRIG: added UND addedText UND touched. `added`
        // allein reichte nicht — eine maschinelle Injektion setzt added/addedText ohne jede
        // Interaktion. Wer beim Aufraeumen `st.touched` fuer ueberfluessig haelt, macht diesen Fall rot.
        const guard = clientScript.match( /st\.added === true && st\.addedText && st\.touched === true/g ) || []

        expect( guard.length ).toBe( 1 )
        expect( clientScript ).toContain( 'input.classList.add( \'pp-question-input-unconfirmed\' )' )
    } )


    it( 'T7 — die Erntebedingung steht an GENAU zwei Stellen: Wache und Praedikat (Quelltext geprueft)', () => {
        // Vorher standen es drei (die Wache und ZWEI identische Kopien in collectAddedAnswers /
        // appendAddedAnswers). Die Doppelung ist zu einem benannten Praedikat aufgeloest. Ein
        // Rueckgang auf 1 waere der Verlust der Wache, ein Anstieg eine neue stille Kopie.
        const occurrences = clientScript.match( /st\.added === true/g ) || []
        const predicate = clientScript.match( /function isConfirmedAnswer\( st \)/g ) || []

        expect( occurrences.length ).toBe( 2 )
        expect( predicate.length ).toBe( 1 )
    } )


    it( 'T8 — added ohne touched erzeugt KEINEN Feldwert: die M080-Verschaerfung bleibt (2 Zustaende)', async () => {
        // Die Wache funktional statt nur ihrem Wortlaut nach: derselbe Ausdruck, gegen zwei Zustaende
        // ausgewertet, die sich NUR in `touched` unterscheiden.
        const gate = ( st ) => !!( st && st.added === true && st.addedText && st.touched === true )
        const injected = { ...confirmed( 'F1', 'A) eins' ), 'touched': false }
        const real = confirmed( 'F1', 'A) eins' )

        expect( gate( injected ) ).toBe( false )
        expect( gate( real ) ).toBe( true )

        // Und die Gegenprobe am echten Code: die maschinell injizierte Antwort wird trotzdem
        // EXPORTIERT (das ist PRD-026 und bleibt so) — die Sperre wirkt am Feld, nicht am Export.
        const sandbox = await loadSandbox( [ injected ], [ question( 'F1' ) ] )

        expect( sandbox.__collect().count ).toBe( 1 )
        expect( sandbox.__collect().skipped.length ).toBe( 0 )
    } )
} )


describe( 'PRD-22 A5 — beide Export-Pfade melden', () => {
    it( 'die Meldung hat EINE Definition und ZWEI Aufrufer (2 Export-Pfade im Bestand)', () => {
        // Vergleichsmenge: der Bestand hat zwei Export-Pfade — saveTranscript (normales Speichern)
        // und applyPromptEdit (Popup). Eine Abnahme, die nur einen prueft, ist unbewertbar.
        const definition = clientScript.match( /function unconfirmedNotice\(\)/g ) || []
        const rendered = clientScript.match( /renderUnconfirmedNotice\( '(t|pp)-unconfirmed', unconfirmedNotice\(\) \)/g ) || []

        expect( definition.length ).toBe( 1 )
        expect( rendered.length ).toBe( 2 )
    } )


    it( 'der Aufruf im Popup-Pfad ist typeof-geschuetzt (1 Aufrufstelle geprueft)', () => {
        // Ohne den Schutz bricht die bestehende isolierte vm-Auswertung von applyPromptEdit mit einem
        // ReferenceError, weil dort kein Modul-Scope existiert.
        const guarded = clientScript.match( /typeof unconfirmedNotice === 'function' && typeof renderUnconfirmedNotice === 'function'/g ) || []

        expect( guarded.length ).toBe( 1 )
    } )


    it( 'der Hinweis benutzt ein eigenes Fach, nicht den Fehlerkanal (2 Faecher geprueft)', () => {
        // Ein Hinweis ist kein Fehler — und der Fehlerkanal wird bei jedem Speicheranlauf geleert.
        // 4 Nennungen, aufgeschluesselt: 1 Definition + 2 Aufrufstellen + 1 typeof-Schutz im
        // Popup-Pfad. Die Summe steht hier nur, damit eine fuenfte Nennung auffaellt.
        const notice = clientScript.match( /renderUnconfirmedNotice/g ) || []
        const definition = clientScript.match( /function renderUnconfirmedNotice\( fieldId, notice \)/g ) || []

        expect( definition.length ).toBe( 1 )
        expect( notice.length ).toBe( 4 )
        // Die beiden Faecher sind eigene Knoten, kein Schreibzugriff auf den Fehlerkanal.
        expect( clientScript ).not.toContain( 'ppError.textContent = unconfirmed' )
        expect( clientScript ).not.toContain( 'errorBox.textContent = unconfirmed' )
    } )
} )
