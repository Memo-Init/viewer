import { describe, it, expect } from '@jest/globals'
import vm from 'node:vm'

import { extractFunctionSources, sliceDeclaration, readEmittedScript } from '../helpers/extractFunction.mjs'
import { makeNode, makeRoot } from '../helpers/domSurrogate.mjs'


// PRD-14 (Memo 082, Phase 9, Kap 33 — WI-235): S4, der Lade-Indikator am Haupt-Klickpfad.
//
// Der Befund: "Der Viewer laedt total lang, man weiss nie, ob man geklickt hat." Der Haupt-Klickpfad
// war der EINZIGE ohne Rueckmeldung — die Nebenpfade haben sie (requestProjectScope setzt seinen
// Pending-Zustand VOR dem Senden und loescht ihn am BELEG der Antwort, nie auf Hoffnung).
//
// Geprueft wird VERHALTEN, nicht Quelltext-Form: die echten Client-Funktionen laufen in einer
// vm-Sandbox gegen das DOM-Surrogat des Projekts, und die echte Deklaration `revisionPending` wird
// mitgehoben statt nachgebaut — eine Kopie bliebe gruen, genau wenn die Produktionsfassung driftet.
//
// Es gibt hier KEINE Bedingung ueber eine Dauer. Die Zeitgeber der Sandbox sind deterministisch und
// werden von Hand ausgeloest; gemessen wird die REIHENFOLGE und der ZUSTAND, nie eine Millisekunde.
// Jeder Fall nennt in seinem Titel seine Vergleichsmenge.


const LIFTED = [
    'revisionIdFromFileName', 'revisionPendingLabel', 'findRevisionRow', 'revisionPendingNote',
    'clearRevisionPendingMarks', 'clearRevisionPendingTimer', 'forgetRevisionPending',
    'markRevisionPending', 'resolveRevisionPending', 'failRevisionPending',
    'startRevisionPendingTimer', 'requestRevision'
]


// Eine Zeile der Seitenleiste, genau so adressiert wie im Bau: data-doc + data-rev.
function makeRow( documentId, fileName ) {
    const row = makeNode( 'li', '', [ 'rev-mini' ] )
    row.setAttribute( 'data-doc', documentId )
    row.setAttribute( 'data-rev', fileName )

    return row
}


// Die Flaeche: Kopfzeile + Seitenleisten-Koerper unter einer gemeinsamen Wurzel, damit
// `document.querySelectorAll` ueber BEIDE Orte zaehlt und nicht nur ueber einen.
// `removeChild` traegt das geteilte Surrogat nicht — es wird hier ergaenzt statt dort veraendert,
// damit dieser Test keine fremde Testdatei bewegt.
function makeSurface( rows ) {
    const header = makeNode( 'div' )
    header.removeChild = ( child ) => {
        const at = header.children.indexOf( child )
        if( at >= 0 ) { header.children.splice( at, 1 ) }
        child.parentNode = null

        return child
    }
    const sidebarBody = makeNode( 'div' )
    rows.forEach( ( row ) => sidebarBody.appendChild( row ) )
    const root = makeRoot( [ header, sidebarBody ] )
    const byId = { 'main-header': header, 'doc-sidebar-body': sidebarBody }

    return {
        header,
        sidebarBody,
        root,
        document: {
            getElementById: ( id ) => ( Object.hasOwn( byId, id ) ? byId[ id ] : null ),
            querySelectorAll: ( selector ) => root.querySelectorAll( selector ),
            querySelector: ( selector ) => root.querySelector( selector ),
            createElement: ( tag ) => makeNode( tag )
        }
    }
}


// Deterministische Zeitgeber: der Rueckruf wird GESPEICHERT und von Hand ausgeloest. Keine Uhr, kein
// Warten — ein Test, der auf eine Frist wartet, misst die Maschine und nicht den Bau.
function makeTimers() {
    const pending = new Map()
    let seq = 0

    return {
        setTimeout: ( fn ) => { seq += 1; pending.set( seq, fn ); return seq },
        clearTimeout: ( id ) => { pending.delete( id ) },
        count: () => pending.size,
        fireAll: () => {
            const callbacks = [ ...pending.values() ]
            pending.clear()
            callbacks.forEach( ( fn ) => fn() )

            return callbacks.length
        }
    }
}


async function loadSandbox( { rows, readyState } ) {
    const script = await readEmittedScript()
    const lifted = await extractFunctionSources( LIFTED )
    const declaration = sliceDeclaration( script, 'revisionPending' )

    const surface = makeSurface( rows )
    const timers = makeTimers()
    // Was die Steckdose beim SENDEN sieht. Der Zustand wird IM Aufruf abgelesen, nicht danach —
    // nur so belegt der Fall die Reihenfolge statt des Endergebnisses.
    const sentAt = []
    const currentWs = {
        readyState,
        send: ( payload ) => {
            sentAt.push( {
                payload,
                markedRows: surface.root.querySelectorAll( '.rev-pending' ).length,
                noteText: noteTextOf( surface )
            } )
        }
    }

    const sandbox = {
        document: surface.document,
        // Der Einweg-Kanal der Klick-Bindung. `null` ist der Normalfall (programmatische Auswahl);
        // ein Fall, der ihn setzt, setzt ihn ausdruecklich.
        revisionPendingOrigin: null,
        currentWs,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        console
    }
    vm.createContext( sandbox )
    vm.runInContext( `${ declaration }\n${ lifted[ 'source' ] }\n`, sandbox )

    return { sandbox, surface, timers, sentAt }
}


function markedRowsOf( surface ) {
    return surface.root.querySelectorAll( '.rev-pending' )
}


function noteOf( surface ) {
    return surface.header.querySelector( '.rev-loading-note' )
}


function noteTextOf( surface ) {
    const note = noteOf( surface )

    return note === null ? null : note.textContent
}


// "Die Kopfzeile ist markiert" ist EINE Frage mit einer Antwort: das Notiz-Element traegt die
// aktive Klasse. Ein Element mit Fehlertext ist ausdruecklich NICHT markiert — es meldet, dass
// gerade nichts mehr laeuft.
function headerIsPending( surface ) {
    const note = noteOf( surface )

    return note !== null && note.classList.contains( 'rev-loading-active' )
}


const ROWS = () => [ makeRow( 'proj--082-alpha', 'REV-01.md' ), makeRow( 'proj--082-alpha', 'REV-02.md' ) ]


describe( 'PRD-14 AB-3 — der Zustand steht VOR dem Senden', () => {
    it( 'T1 — beim Senden ist die Zeile bereits markiert und die Kopfzeile benannt (1 Klick, 2 beobachtete Ereignisse)', async () => {
        const { sandbox, surface, sentAt } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        // Vorzustand, ausdruecklich gemessen: die Vergleichsmenge ist 2 Zeilen, 0 davon markiert.
        expect( surface.sidebarBody.querySelectorAll( 'li' ).length ).toBe( 2 )
        expect( markedRowsOf( surface ).length ).toBe( 0 )
        expect( sentAt.length ).toBe( 0 )

        const result = sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )

        // Genau EIN Sendevorgang, und er hat den Zustand schon vorgefunden.
        expect( sentAt.length ).toBe( 1 )
        expect( result.sent ).toBe( true )
        expect( sentAt[ 0 ].markedRows ).toBe( 1 )
        expect( sentAt[ 0 ].noteText ).toBe( 'Lade REV-02 …' )
        expect( JSON.parse( sentAt[ 0 ].payload ).type ).toBe( 'selectRevision' )
    } )
} )


describe( 'PRD-14 AB-2 — beide Orte tragen den Zustand', () => {
    it( 'T2 — waehrend des Ladens sind BEIDE markiert, und die Kopfzeile nennt die Kennung (2 Orte geprueft)', async () => {
        const { sandbox, surface } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )

        const marked = markedRowsOf( surface )
        expect( marked.length ).toBe( 1 )
        expect( marked[ 0 ].getAttribute( 'data-rev' ) ).toBe( 'REV-02.md' )
        expect( headerIsPending( surface ) ).toBe( true )
        // Die Kennung, nicht nur "laedt": die zweite Frage des Users lautete "und worauf?".
        expect( noteTextOf( surface ) ).toContain( 'REV-02' )
    } )


    it( 'T2b — ohne REV-NN im Namen faellt die Kopfzeile auf den Dateinamen zurueck, nie auf Schweigen (2 Namensformen)', async () => {
        const { sandbox } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        expect( sandbox.revisionPendingLabel( 'REV-07.md' ) ).toBe( 'REV-07' )
        expect( sandbox.revisionPendingLabel( 'vorwort.md' ) ).toBe( 'vorwort' )
    } )
} )


describe( 'PRD-14 AB-6 — der Normalfall bleibt unmarkiert', () => {
    it( 'T3 — ohne laufendes Laden traegt keine Zeile und keine Kopfzeile eine Markierung (2 Zeilen, 1 Kopfzeile)', async () => {
        const { surface } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        // Ohne diese Richtung waere eine Fassung, die IMMER "laedt" zeigt, von der richtigen nicht
        // zu unterscheiden — sie bestuende T1 und T2 genauso.
        expect( surface.sidebarBody.querySelectorAll( 'li' ).length ).toBe( 2 )
        expect( markedRowsOf( surface ).length ).toBe( 0 )
        expect( noteOf( surface ) ).toBe( null )
    } )


    it( 'T3b — nach dem Eintreffen des Inhalts ist die Flaeche wieder unmarkiert (2 Zeilen, 1 Kopfzeile)', async () => {
        const { sandbox, surface } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )
        expect( markedRowsOf( surface ).length ).toBe( 1 )

        expect( sandbox.resolveRevisionPending( 'proj--082-alpha', 'REV-02.md' ) ).toBe( true )
        expect( markedRowsOf( surface ).length ).toBe( 0 )
        expect( headerIsPending( surface ) ).toBe( false )
        // Das Notiz-Element wird ENTFERNT, nicht leer geparkt: #main-header:empty blendet die
        // Kopfzeile aus, und ein geparkter Knoten liesse einen leeren Balken stehen.
        expect( noteOf( surface ) ).toBe( null )
    } )
} )


describe( 'PRD-14 — geloescht wird am BELEG, nicht auf Hoffnung', () => {
    it( 'T4 — eine Rundmeldung fuer eine FREMDE Revision loest den Zustand nicht (1 fremde, 1 eigene Meldung)', async () => {
        const { sandbox, surface } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )

        expect( sandbox.resolveRevisionPending( 'proj--082-alpha', 'REV-01.md' ) ).toBe( false )
        expect( markedRowsOf( surface ).length ).toBe( 1 )
        expect( headerIsPending( surface ) ).toBe( true )

        expect( sandbox.resolveRevisionPending( 'proj--082-alpha', 'REV-02.md' ) ).toBe( true )
        expect( markedRowsOf( surface ).length ).toBe( 0 )
    } )
} )


describe( 'PRD-14 AB-4 — ein Fehler loest den Zustand UND meldet sich', () => {
    it( 'T5 — nach einem Fehler ist nichts mehr markiert und eine sichtbare Meldung steht da (1 Fehlerfall)', async () => {
        const { sandbox, surface } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )
        expect( markedRowsOf( surface ).length ).toBe( 1 )

        expect( sandbox.failRevisionPending( 'die Verbindung wurde unterbrochen' ) ).toBe( true )

        // Das Paar ist die Bedingung: faellt eine der beiden Haelften, ist der Fall rot. Ein
        // haengender Indikator behauptet Arbeit, die nicht stattfindet; eine stille Aufloesung
        // laesst den Leser mit der Frage zurueck, mit der er angefangen hat.
        expect( markedRowsOf( surface ).length ).toBe( 0 )
        expect( headerIsPending( surface ) ).toBe( false )
        const note = noteOf( surface )
        expect( note ).not.toBe( null )
        expect( note.classList.contains( 'rev-loading-error' ) ).toBe( true )
        expect( note.textContent ).toContain( 'REV-02' )
        expect( note.textContent ).toContain( 'die Verbindung wurde unterbrochen' )
    } )


    it( 'T5b — ohne offene Steckdose wird NICHT gesendet, und die Flaeche sagt es (1 Klick, 0 Sendevorgaenge)', async () => {
        const { sandbox, surface, sentAt } = await loadSandbox( { rows: ROWS(), readyState: 3 } )

        const result = sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )

        expect( result.sent ).toBe( false )
        expect( sentAt.length ).toBe( 0 )
        expect( markedRowsOf( surface ).length ).toBe( 0 )
        expect( noteOf( surface ).classList.contains( 'rev-loading-error' ) ).toBe( true )
        expect( noteTextOf( surface ) ).toContain( 'keine Verbindung zum Server' )
    } )


    it( 'T5c — laeuft die Frist ab, faellt die Markierung und die Meldung steht (1 Zeitgeber, von Hand ausgeloest)', async () => {
        const { sandbox, surface, timers } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )
        expect( timers.count() ).toBe( 1 )

        expect( timers.fireAll() ).toBe( 1 )

        expect( markedRowsOf( surface ).length ).toBe( 0 )
        expect( noteOf( surface ).classList.contains( 'rev-loading-error' ) ).toBe( true )
        expect( noteTextOf( surface ) ).toContain( 'keine Antwort vom Server' )
    } )


    it( 'T5d — ein eingetroffener Inhalt nimmt den Zeitgeber mit; er kann danach nichts mehr melden (1 Zeitgeber)', async () => {
        const { sandbox, surface, timers } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )
        sandbox.resolveRevisionPending( 'proj--082-alpha', 'REV-02.md' )

        expect( timers.count() ).toBe( 0 )
        expect( timers.fireAll() ).toBe( 0 )
        expect( noteOf( surface ) ).toBe( null )
    } )
} )


describe( 'PRD-14 AB-5 — zwei Klicks, eine Markierung', () => {
    it( 'T6 — nach zwei Klicks auf verschiedene Zeilen ist GENAU EINE markiert, die zuletzt geklickte (2 Klicks, 1 Zaehlung)', async () => {
        const { sandbox, surface } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-01.md' )
        const afterFirst = markedRowsOf( surface )
        expect( afterFirst.length ).toBe( 1 )
        expect( afterFirst[ 0 ].getAttribute( 'data-rev' ) ).toBe( 'REV-01.md' )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )
        const afterSecond = markedRowsOf( surface )

        // Die Zahl wird ausgezaehlt, nicht angenommen: zwei gleichzeitig markierte Zeilen waeren
        // eine neue Unklarheit an genau der Stelle, die Klarheit schaffen soll.
        expect( afterSecond.length ).toBe( 1 )
        expect( afterSecond[ 0 ].getAttribute( 'data-rev' ) ).toBe( 'REV-02.md' )
        expect( noteTextOf( surface ) ).toBe( 'Lade REV-02 …' )
    } )


    it( 'T6b — der zweite Klick nimmt auch den Zeitgeber des ersten mit (2 Klicks, 1 Zeitgeber)', async () => {
        const { sandbox, timers } = await loadSandbox( { rows: ROWS(), readyState: 1 } )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-01.md' )
        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )

        // Zwei offene Fristen waeren zwei Meldungen fuer einen Ladevorgang.
        expect( timers.count() ).toBe( 1 )
    } )
} )


// Die Warteschlange oben in der Seitenleiste rendert ihre Karten in DENSELBEN Behaelter und traegt
// DASSELBE Paar data-doc/data-rev — und sie steht davor. Ein blosses "erster Treffer gewinnt" wuerde
// die Karte markieren statt der Zeile, auf die geklickt wurde. Beide Faelle unten zaehlen 1
// markierte Zeile; geprueft wird, WELCHE es ist.
describe( 'PRD-14 — markiert wird die Zeile, auf die geklickt wurde', () => {
    const QUEUE_AND_LINE = () => {
        const card = makeNode( 'li', '', [ 'queue-card' ] )
        card.setAttribute( 'data-doc', 'proj--082-alpha' )
        card.setAttribute( 'data-rev', 'REV-02.md' )
        const line = makeRow( 'proj--082-alpha', 'REV-02.md' )

        return [ card, line ]
    }


    it( 'T7 — ohne genannten Ursprung gewinnt die Revisionszeile vor der Warteschlangen-Karte (2 Treffer, 1 Markierung)', async () => {
        const { sandbox, surface } = await loadSandbox( { rows: QUEUE_AND_LINE(), readyState: 1 } )

        // Die Vergleichsmenge ist ausdruecklich 2: beide tragen das Paar, sonst pruefte der Fall nichts.
        expect( surface.sidebarBody.querySelectorAll( 'li' ).length ).toBe( 2 )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )

        const marked = markedRowsOf( surface )
        expect( marked.length ).toBe( 1 )
        expect( marked[ 0 ].classList.contains( 'rev-mini' ) ).toBe( true )
    } )


    it( 'T7b — ein genannter Ursprung gewinnt vor der Zeile und wird danach vergessen (1 Klick, 1 Markierung)', async () => {
        const rows = QUEUE_AND_LINE()
        const { sandbox, surface } = await loadSandbox( { rows, readyState: 1 } )

        sandbox.revisionPendingOrigin = rows[ 0 ]
        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )

        const marked = markedRowsOf( surface )
        expect( marked.length ).toBe( 1 )
        expect( marked[ 0 ].classList.contains( 'queue-card' ) ).toBe( true )
        // Einweg: der Kanal ist nach dem Lesen leer, sonst erbte die naechste programmatische
        // Auswahl eine Zeile, die jemand vor Minuten angeklickt hat.
        expect( sandbox.revisionPendingOrigin ).toBe( null )

        sandbox.requestRevision( 'proj--082-alpha', 'REV-02.md' )
        const again = markedRowsOf( surface )
        expect( again.length ).toBe( 1 )
        expect( again[ 0 ].classList.contains( 'rev-mini' ) ).toBe( true )
    } )
} )
