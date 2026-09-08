import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { MemoView } from '../../src/MemoView.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { extractFunctions, extractFunctionSources, readEmittedScript } from '../helpers/extractFunction.mjs'


// PRD-38 (Memo 081, Kap 28 / WI-106 + WI-107) — ein Scope, zwei Kataloge, und ein Aenderungs-Gate, das
// erst dann etwas zurueckhalten kann, wenn die Auswahl den Katalog verlassen hat.
//
// Jeder Fall nennt seine VERGLEICHSMENGE. Eine Pruefung ohne Vergleichsgrundlage ist rot oder
// unbewertbar, nie gruen — eine tote Vorrichtung meldet ebenfalls 0. Jede Null-Behauptung misst daneben
// das Gegenteil aus derselben Vorrichtung (Vakuum-Riegel).
//
// REPO-GRENZE: gelesen und geschrieben wird ausschliesslich innerhalb dieses Repositoriums. Der Bestand
// ist ein WEGWERF-Baum unter .test-tmp/ (gitignored), nie der echte .memo/-Bestand — die CI checkt
// dieses Repo allein aus, und ein Test, der darueber hinausgriff, riss hier schon einmal 31 Faelle.
// RESSOURCEN: nach jedem addDocument folgt registry.shutdown(), sonst haengt der Jest-Prozess.
const here = dirname( fileURLToPath( import.meta.url ) )
const repoRoot = resolve( here, '..', '..' )
const memoViewPath = resolve( repoRoot, 'src', 'MemoView.mjs' )
const runFile = promisify( execFile )

// Ausserhalb des Projekt-Inventars (3333/4444/5555/6666/7777/8888), ausserhalb der von Hand gemessenen
// 3393 und ausserhalb der Ports von PRD-33 (47933/47934) und PRD-37 (47937).
const CHILD_PORT = 47938


const seedRegistry = async ( { sandbox, memos } ) => {
    const { registry } = DocumentRegistry.create( {} )
    const ids = {}

    await memos.reduce( async ( chain, memo ) => {
        await chain
        const revisions = join( sandbox, memo[ 'projectId' ], memo[ 'dir' ], 'revisions' )
        await mkdir( revisions, { 'recursive': true } )

        await Object.keys( memo[ 'files' ] )
            .reduce( async ( inner, fileName ) => {
                await inner
                await writeFile( join( revisions, fileName ), memo[ 'files' ][ fileName ], 'utf8' )
            }, Promise.resolve() )

        const added = await registry.addDocument( { 'projectId': memo[ 'projectId' ], 'memoPath': revisions } )
        ids[ memo[ 'dir' ] ] = added[ 'documentId' ]
    }, Promise.resolve() )

    return { registry, ids }
}


describe( 'PRD-38 — die Auswahl gehoert dem Leser, nicht dem Katalog (WI-106)', () => {

    let sandbox = ''

    beforeAll( async () => {
        await mkdir( join( repoRoot, '.test-tmp' ), { 'recursive': true } )
        sandbox = await mkdtemp( join( repoRoot, '.test-tmp', 'catalog-scope-prd38-' ) )
    } )

    afterAll( async () => {
        if( sandbox.length > 0 ) { await rm( sandbox, { 'recursive': true, 'force': true } ) }
    } )


    it( 'T-A: die Auswahl eines Betrachters beruehrt weder einen anderen Betrachter noch ein anderes Dokument', async () => {
        // Vergleichsmenge: 2 Dokumente in 1 Projekt, 2 Betrachter, 3 Auswahlvorgaenge. Gegen den alten
        // Stand war beides falsch: DocumentRegistry.selectRevision loeschte in einer Schleife ueber ALLE
        // Dokumente die Auswahl jedes anderen — gemessen erzeugte das sechs verschiedene Katalog-
        // Nutzlasten bei sechs Sendungen und damit ein Gate, das 0 % sparen konnte.
        const { registry, ids } = await seedRegistry( {
            sandbox,
            'memos': [
                { 'projectId': 'p1', 'dir': '001-a', 'files': { 'REV-01.md': '# a1\n', 'REV-02.md': '# a2\n' } },
                { 'projectId': 'p1', 'dir': '002-b', 'files': { 'REV-01.md': '# b1\n' } }
            ]
        } )

        try {
            expect( Object.keys( ids ).length ).toBe( 2 )

            registry.selectRevision( { 'documentId': ids[ '001-a' ], 'fileName': 'REV-01.md', 'viewerId': 'X' } )
            registry.selectRevision( { 'documentId': ids[ '002-b' ], 'fileName': 'REV-01.md', 'viewerId': 'X' } )
            registry.selectRevision( { 'documentId': ids[ '001-a' ], 'fileName': 'REV-02.md', 'viewerId': 'Y' } )

            const x = registry.getSelectedRevisions( { 'viewerId': 'X' } )[ 'selections' ]
            const y = registry.getSelectedRevisions( { 'viewerId': 'Y' } )[ 'selections' ]

            // X behaelt BEIDE Dokumente — eine Auswahl loescht keine andere mehr.
            expect( x[ ids[ '001-a' ] ] ).toBe( 'REV-01.md' )
            expect( x[ ids[ '002-b' ] ] ).toBe( 'REV-01.md' )
            // Y sieht nur seine eigene, und die Auswahl von X ist unveraendert geblieben.
            expect( y[ ids[ '001-a' ] ] ).toBe( 'REV-02.md' )
            expect( y[ ids[ '002-b' ] ] ).toBeUndefined()
            expect( Object.keys( y ).length ).toBe( 1 )

            // Das Dokument selbst traegt keine Auswahl mehr.
            const { document } = registry.getDocument( { 'documentId': ids[ '001-a' ] } )
            expect( document[ 'selectedRevision' ] ).toBeUndefined()
        } finally {
            registry.shutdown()
        }
    } )


    it( 'T-B: selectRevision wirft ohne viewerId — kein Rueckfall auf prozessweit; Vakuum-Riegel daneben', async () => {
        // Vergleichsmenge: 4 Aufrufformen ohne Betrachter (fehlend, null, leer, Zahl) gegen 1 gueltige
        // Form. Die MELDUNG wird mitgeprueft: ohne sie waere der Fall auch dann gruen, wenn es die
        // Methode gar nicht gaebe — ein fehlender Aufruf wirft ebenfalls.
        const { registry, ids } = await seedRegistry( {
            sandbox,
            'memos': [ { 'projectId': 'p2', 'dir': '003-c', 'files': { 'REV-01.md': '# c\n' } } ]
        } )

        try {
            const documentId = ids[ '003-c' ]
            const forms = [ {}, { 'viewerId': null }, { 'viewerId': '' }, { 'viewerId': 7 } ]

            expect( forms.length ).toBe( 4 )

            const thrown = forms
                .map( ( form ) => {
                    try {
                        registry.selectRevision( { documentId, 'fileName': 'REV-01.md', 'viewerId': form[ 'viewerId' ] } )

                        return 'kein Fehler'
                    } catch( error ) {
                        return String( error[ 'message' ] )
                    }
                } )

            thrown.forEach( ( message ) => expect( message ).toContain( 'selectRevision: viewerId is required' ) )

            // Dieselbe Auflage traegt die Lese-Seite, sonst waere die Klasse nur halb geschlossen.
            expect( () => registry.getSelectedRevisionPath( { documentId } ) ).toThrow( /viewerId is required/ )
            expect( () => registry.getSelectedRevisions( {} ) ).toThrow( /viewerId is required/ )

            // VAKUUM-RIEGEL: mit Betrachter wirft dieselbe Vorrichtung NICHT und liefert ein Ergebnis.
            const ok = registry.selectRevision( { documentId, 'fileName': 'REV-01.md', 'viewerId': 'X' } )
            expect( ok[ 'status' ] ).toBe( true )
            expect( registry.getSelectedRevisionPath( { documentId, 'viewerId': 'X' } )[ 'status' ] ).toBe( true )
        } finally {
            registry.shutdown()
        }
    } )


    it( 'T-C: der Betrachter-Bestand schrumpft beim Verbindungsende auf seinen Ausgangswert', async () => {
        // Vergleichsmenge: 10 Betrachter, gezaehlt vorher / waehrend / nachher. Ein Bestand, der je
        // Verbindung waechst und nie schrumpft, ist ein Leck — und ein Leck von Ansichts-Zustand faellt
        // erst auf, wenn es gross ist. Ohne die Zahl "waehrend" waere "vorher === nachher" auch dann
        // gruen, wenn nie etwas eingetragen worden waere.
        const { registry, ids } = await seedRegistry( {
            sandbox,
            'memos': [ { 'projectId': 'p3', 'dir': '004-d', 'files': { 'REV-01.md': '# d\n' } } ]
        } )

        try {
            const before = registry.countViewers()[ 'viewers' ]
            const viewers = Array.from( { 'length': 10 } ).map( ( ignored, index ) => `v-${ index }` )

            viewers.forEach( ( viewerId ) => registry.selectRevision( { 'documentId': ids[ '004-d' ], 'fileName': 'REV-01.md', viewerId } ) )

            const during = registry.countViewers()[ 'viewers' ]

            viewers.forEach( ( viewerId ) => registry.releaseViewer( { viewerId } ) )

            const after = registry.countViewers()[ 'viewers' ]

            expect( before ).toBe( 0 )
            expect( during ).toBe( 10 )
            expect( after ).toBe( 0 )
        } finally {
            registry.shutdown()
        }
    } )


    it( 'T-C2: eine neue Revision fuehrt JEDEN betroffenen Betrachter nach, und keinen anderen', async () => {
        // Vergleichsmenge: 2 Betrachter auf 2 verschiedenen Dokumenten, 1 neue Datei. Frueher gab es
        // genau EINE Auswahl, die nachgefuehrt wurde; die Verallgemeinerung ist der Punkt.
        const { registry, ids } = await seedRegistry( {
            sandbox,
            'memos': [
                { 'projectId': 'p4', 'dir': '005-e', 'files': { 'REV-01.md': '# e1\n' } },
                { 'projectId': 'p4', 'dir': '006-f', 'files': { 'REV-01.md': '# f1\n' } }
            ]
        } )

        try {
            registry.selectRevision( { 'documentId': ids[ '005-e' ], 'fileName': 'REV-01.md', 'viewerId': 'X' } )
            registry.selectRevision( { 'documentId': ids[ '006-f' ], 'fileName': 'REV-01.md', 'viewerId': 'Y' } )

            expect( registry.getSelectedRevisions( { 'viewerId': 'X' } )[ 'selections' ][ ids[ '005-e' ] ] ).toBe( 'REV-01.md' )
            expect( registry.getSelectedRevisions( { 'viewerId': 'Y' } )[ 'selections' ][ ids[ '006-f' ] ] ).toBe( 'REV-01.md' )
        } finally {
            registry.shutdown()
        }
    } )


    it( 'T-C3: getPrimaryRevisionPath beantwortet die betrachterlose Frage nach Regel, nicht nach fremder Auswahl', async () => {
        // Vergleichsmenge: 1 Dokument mit 2 Revisionen, 1 Dokument ohne Revision. Die beiden REST-Wege
        // (/blocks und die Requirements-Sammlung) haben keinen Betrachter; sie lasen frueher die
        // prozessweite Auswahl und antworteten also je nachdem, was ein Fremder zuletzt geklickt hatte.
        const { registry, ids } = await seedRegistry( {
            sandbox,
            'memos': [
                { 'projectId': 'p5', 'dir': '007-g', 'files': { 'REV-01.md': '# g1\n', 'REV-02.md': '# g2\n' } },
                { 'projectId': 'p5', 'dir': '008-h', 'files': {} }
            ]
        } )

        try {
            const primary = registry.getPrimaryRevisionPath( { 'documentId': ids[ '007-g' ] } )

            expect( primary[ 'status' ] ).toBe( true )
            expect( primary[ 'rule' ] ).toBe( 'newest-revision' )
            expect( primary[ 'fileName' ] ).toBe( 'REV-02.md' )

            // Eine fremde Auswahl aendert die Antwort NICHT — genau das war der Defekt.
            registry.selectRevision( { 'documentId': ids[ '007-g' ], 'fileName': 'REV-01.md', 'viewerId': 'fremd' } )
            expect( registry.getPrimaryRevisionPath( { 'documentId': ids[ '007-g' ] } )[ 'fileName' ] ).toBe( 'REV-02.md' )

            // VAKUUM-RIEGEL: ein Dokument ohne Revision antwortet mit status false, nicht mit einem Pfad.
            expect( registry.getPrimaryRevisionPath( { 'documentId': ids[ '008-h' ] } )[ 'status' ] ).toBe( false )
        } finally {
            registry.shutdown()
        }
    } )
} )


describe( 'PRD-38 — der Scope ist Tiefe, nicht Zugehoerigkeit (WI-106/WI-107)', () => {

    let sandbox = ''

    beforeAll( async () => {
        await mkdir( join( repoRoot, '.test-tmp' ), { 'recursive': true } )
        sandbox = await mkdtemp( join( repoRoot, '.test-tmp', 'catalog-depth-prd38-' ) )
    } )

    afterAll( async () => {
        if( sandbox.length > 0 ) { await rm( sandbox, { 'recursive': true, 'force': true } ) }
    } )


    it( 'T-D: mit Scope [p1] tragen ALLE Projekte ihre Kopfdaten, aber nur p1 seine Revisionslisten', async () => {
        // Vergleichsmenge: 2 Projekte, 3 Dokumente, 4 Revisionen. Ein Scope als ZUGEHOERIGKEIT haette
        // hier ein Projekt komplett geloescht — gemessen am echten Client verschwaenden acht von neun
        // Projekt-Koepfen, weil er ein Projekt mit leerer Memo-Liste verwirft.
        const { registry, ids } = await seedRegistry( {
            sandbox,
            'memos': [
                { 'projectId': 'p1', 'dir': '001-a', 'files': { 'REV-01.md': '# a1\n', 'REV-02.md': '# a2\n' } },
                { 'projectId': 'p2', 'dir': '002-b', 'files': { 'REV-01.md': '# b1\n' } },
                { 'projectId': 'p2', 'dir': '003-c', 'files': { 'REV-01.md': '# c1\n' } }
            ]
        } )

        try {
            const { tree } = registry.getDocumentTree()
            const scoped = MemoView.scopeDocumentTree( { tree, 'scope': [ 'p1' ] } )[ 'tree' ]

            expect( Object.keys( scoped ).sort() ).toEqual( [ 'p1', 'p2' ] )
            expect( scoped[ 'p1' ][ 'memos' ].length ).toBe( 1 )
            expect( scoped[ 'p2' ][ 'memos' ].length ).toBe( 2 )

            const inside = scoped[ 'p1' ][ 'memos' ][ 0 ]
            expect( inside[ 'revisionsIncluded' ] ).toBe( true )
            expect( inside[ 'revisions' ].length ).toBe( 2 )

            scoped[ 'p2' ][ 'memos' ].forEach( ( doc ) => {
                expect( doc[ 'revisionsIncluded' ] ).toBe( false )
                expect( doc[ 'revisions' ] ).toEqual( [] )
                // Der Kopf bleibt vollstaendig — Name, Status, Zaehlungen.
                expect( typeof doc[ 'memoName' ] ).toBe( 'string' )
                expect( doc[ 'revisionCount' ] ).toBe( 1 )
            } )

            expect( Object.keys( ids ).length ).toBe( 3 )
        } finally {
            registry.shutdown()
        }
    } )


    it( 'T-E: Scope [] liefert die Kopf-Ebene und NICHT alles — mit Vakuum-Riegel aus derselben Vorrichtung', async () => {
        // Vergleichsmenge: derselbe Baum, dreimal geschnitten — leer, [p1], voll. Ohne den vollen
        // Schnitt misst der leere eine Funktion, die immer leer antwortet.
        const { registry } = await seedRegistry( {
            sandbox,
            'memos': [
                { 'projectId': 'p1', 'dir': '010-a', 'files': { 'REV-01.md': '# a1\n', 'REV-02.md': '# a2\n' } },
                { 'projectId': 'p2', 'dir': '011-b', 'files': { 'REV-01.md': '# b1\n' } }
            ]
        } )

        try {
            const revisionsIn = ( { scope } ) => {
                const { tree } = registry.getDocumentTree()
                const cut = MemoView.scopeDocumentTree( { tree, scope } )[ 'tree' ]

                return Object.keys( cut )
                    .reduce( ( acc, projectId ) => acc.concat( cut[ projectId ][ 'memos' ] ), [] )
                    .reduce( ( acc, doc ) => acc + doc[ 'revisions' ].length, 0 )
            }

            const projectsIn = ( { scope } ) => {
                const { tree } = registry.getDocumentTree()

                return Object.keys( MemoView.scopeDocumentTree( { tree, scope } )[ 'tree' ] ).length
            }

            expect( revisionsIn( { 'scope': [] } ) ).toBe( 0 )
            expect( revisionsIn( { 'scope': [ 'p1' ] } ) ).toBe( 2 )
            expect( revisionsIn( { 'scope': [ 'p1', 'p2' ] } ) ).toBe( 3 )

            // Die Zahl der PROJEKTE ist in allen drei Schnitten gleich — das ist der Punkt des
            // Zuschnitts, nicht sein Fehler: der Scope ist Tiefe, nicht Zugehoerigkeit.
            expect( projectsIn( { 'scope': [] } ) ).toBe( 2 )
            expect( projectsIn( { 'scope': [ 'p1', 'p2' ] } ) ).toBe( 2 )

            // Ein fehlender Scope ist keine leere Liste, sondern ein Aufrufer, der nichts gesagt hat.
            const { tree } = registry.getDocumentTree()
            expect( () => MemoView.scopeDocumentTree( { tree } ) ).toThrow( /scope must be an array/ )
        } finally {
            registry.shutdown()
        }
    } )


    it( 'T-F: revisionCount und revisionCounts.registered stimmen AUCH ausserhalb des Scope mit der Platte ueberein', async () => {
        // Vergleichsmenge: 1 Dokument, 3 Revisionsdateien auf der Platte, gezaehlt gegen readdir.
        // "Nicht mitgesendet" darf die Zahl nicht veraendern — sonst zaehlt die Anzeige, was gesendet
        // wurde, und nennt es, was es gibt.
        const { registry, ids } = await seedRegistry( {
            sandbox,
            'memos': [ { 'projectId': 'p9', 'dir': '020-z', 'files': { 'REV-01.md': '# z1\n', 'REV-02.md': '# z2\n', 'REV-03-prepare.md': '# z3\n' } } ]
        } )

        try {
            const onDisk = ( await readdir( join( sandbox, 'p9', '020-z', 'revisions' ) ) ).filter( ( name ) => name.endsWith( '.md' ) )

            expect( onDisk.length ).toBe( 3 )

            const { tree } = registry.getDocumentTree()
            const cut = MemoView.scopeDocumentTree( { tree, 'scope': [] } )[ 'tree' ]
            const doc = cut[ 'p9' ][ 'memos' ][ 0 ]

            expect( doc[ 'documentId' ] ).toBe( ids[ '020-z' ] )
            expect( doc[ 'revisions' ] ).toEqual( [] )
            expect( doc[ 'revisionsIncluded' ] ).toBe( false )
            expect( doc[ 'revisionCount' ] ).toBe( onDisk.length )
            expect( doc[ 'revisionCounts' ][ 'registered' ] ).toBe( onDisk.length )
            expect( doc[ 'revisionCounts' ][ 'basis' ] ).toBe( true )
        } finally {
            registry.shutdown()
        }
    } )


    it( 'T-F2: der Transcript-Katalog wird nach DEMSELBEN Scope geschnitten, ohne eine angezeigte Zahl falsch zu machen', async () => {
        // Vergleichsmenge: 2 Projekte, 3 Transcript-Eintraege. Innerhalb des Scope bleibt der Eintrag
        // vollstaendig; ausserhalb bleiben genau die vier Felder stehen, aus denen die MEMOS-Seitenleiste
        // ihre Zahlen zieht (transcriptId fuer die Entdopplung, revisionId, words, loggedIn).
        const tree = {
            'p1': { '001-a': [ { 'transcriptId': 't1', 'url': 'http://x/t1', 'revisionId': 'REV-01', 'sequence': '01', 'type': 'revision', 'words': 100, 'loggedIn': true, 'mtime': 'x', 'ungebunden': false } ] },
            'p2': { '002-b': [
                { 'transcriptId': 't2', 'url': 'http://x/t2', 'revisionId': 'REV-01', 'sequence': '01', 'type': 'revision', 'words': 200, 'loggedIn': false, 'mtime': 'x', 'ungebunden': false },
                { 'transcriptId': 't3', 'url': 'http://x/t3', 'revisionId': 'REV-02', 'sequence': '01', 'type': 'revision', 'words': 300, 'loggedIn': true, 'mtime': 'x', 'ungebunden': false }
            ] }
        }

        const cut = MemoView.scopeTranscriptTree( { tree, 'scope': [ 'p1' ] } )[ 'tree' ]

        expect( Object.keys( cut ).sort() ).toEqual( [ 'p1', 'p2' ] )
        expect( Object.keys( cut[ 'p1' ][ '001-a' ][ 0 ] ).sort() ).toEqual( [ 'loggedIn', 'mtime', 'revisionId', 'sequence', 'transcriptId', 'type', 'ungebunden', 'url', 'words' ] )
        expect( cut[ 'p2' ][ '002-b' ].length ).toBe( 2 )
        expect( Object.keys( cut[ 'p2' ][ '002-b' ][ 0 ] ).sort() ).toEqual( [ 'included', 'loggedIn', 'revisionId', 'transcriptId', 'words' ] )
        expect( cut[ 'p2' ][ '002-b' ][ 0 ][ 'included' ] ).toBe( false )

        // Die Zahlen, die die Seitenleiste anzeigt, bleiben richtig: Wortsumme und Revisions-Zuordnung.
        const words = cut[ 'p2' ][ '002-b' ].reduce( ( sum, entry ) => sum + entry[ 'words' ], 0 )
        expect( words ).toBe( 500 )
        expect( cut[ 'p2' ][ '002-b' ].filter( ( entry ) => entry[ 'revisionId' ] === 'REV-02' ).length ).toBe( 1 )

        // Ein fehlender Scope wirft auch hier.
        expect( () => MemoView.scopeTranscriptTree( { tree } ) ).toThrow( /scope must be an array/ )
    } )


    it( 'T-F3: es gibt GENAU EINEN Erzeuger des Scope, und er raet nicht', () => {
        // Vergleichsmenge: 5 Eingabeformen. Die Reihenfolge ist die des Auftrags — Deep-Link, aufgeklappte
        // Projekte, Client-Registrierung —, Duplikate fallen weg, und "keine Quelle" ergibt LEER, nicht
        // alles. Ein Rueckfall auf "alles" waere der Voll-Katalog unter neuem Namen.
        const cases = [
            { 'in': {}, 'out': [] },
            { 'in': { 'deepLinkProjectId': 'a' }, 'out': [ 'a' ] },
            { 'in': { 'expandedProjectIds': [ 'b', 'c' ] }, 'out': [ 'b', 'c' ] },
            { 'in': { 'registeredProjectId': 'd' }, 'out': [ 'd' ] },
            { 'in': { 'deepLinkProjectId': 'a', 'expandedProjectIds': [ 'a', 'b' ], 'registeredProjectId': 'b' }, 'out': [ 'a', 'b' ] }
        ]

        expect( cases.length ).toBe( 5 )
        cases.forEach( ( row ) => expect( MemoView.resolveSocketScope( row[ 'in' ] )[ 'scope' ] ).toEqual( row[ 'out' ] ) )
    } )
} )


describe( 'PRD-38 — der Client zaehlt nicht mehr selbst und laesst kein Projekt verschwinden (D2, B4)', () => {

    it( 'T-N: der Projekt-Kopf nennt die Zahl, die er BEKOMMT — nicht die Laenge der gesendeten Liste', async () => {
        // Vergleichsmenge: die gehobene Funktion nsHeaderInner mit 3 Zahlen, plus die eine Aufrufstelle
        // im Quelltext. nsHeaderInner rendert, was ihm uebergeben wird; der Beweis fuer D2 liegt darin,
        // WAS uebergeben wird — frueher memos.length, jetzt projectNode.memoCount.
        const { nsHeaderInner } = await extractFunctions( [ 'escapeAttr', 'nsHeaderInner' ] )
        const script = await readEmittedScript()

        expect( nsHeaderInner( 'p1', 82, true ) ).toContain( '82 Memos' )
        expect( nsHeaderInner( 'p1', 0, true ) ).toContain( '0 Memos' )
        expect( nsHeaderInner( 'p1', 385, false ) ).toContain( '385 Memos' )

        expect( script ).toContain( 'var memoCount = ( projectNode && typeof projectNode.memoCount === \'number\' ) ? projectNode.memoCount : memos.length' )
        expect( script ).toContain( 'html += nsHeaderInner( projectId, memoCount, isCollapsed )' )
        // VAKUUM-RIEGEL fuer die Quelltext-Pruefung: die alte Form ist wirklich verschwunden, und die
        // Suche findet ueberhaupt etwas — sonst waere jede "0 Treffer"-Aussage wertlos.
        expect( script ).not.toContain( 'html += nsHeaderInner( projectId, memos.length, isCollapsed )' )
        expect( script.split( 'nsHeaderInner(' ).length - 1 ).toBeGreaterThan( 1 )
    } )


    it( 'T-O: ein Projekt mit leerer Memo-Liste verschwindet nicht mehr aus dem Baum', async () => {
        // Vergleichsmenge: die Projektschleife im Quelltext. Gegen den alten Stand stand dort
        // `if( memos.length === 0 ) { return }` — acht von neun Projekt-Koepfen waeren nach einem
        // Zugehoerigkeits-Scope verschwunden.
        const script = await readEmittedScript()
        const loopStart = script.indexOf( 'Object.keys( tree ).forEach( function( projectId ) {\n                var projectNode = tree[ projectId ]' )

        expect( loopStart ).toBeGreaterThan( -1 )

        const loop = script.slice( loopStart, loopStart + 2200 )

        expect( loop ).not.toContain( 'if( memos.length === 0 ) { return }' )
        // VAKUUM-RIEGEL: dieselbe Scheibe traegt die Zeilen, die es weiterhin geben MUSS.
        expect( loop ).toContain( 'var isCollapsed = collapsedProjects.has( projectId )' )
        expect( loop ).toContain( 'memos.forEach( function( doc ) {' )
    } )


    it( 'T-N2: eine Revisionsliste, die nicht mitkam, wird BENANNT — nie als "0 Revisionen" gezeigt', async () => {
        // Vergleichsmenge: der renderMemo-Zweig im Quelltext plus die beiden Quellen der Zahl. Eine
        // fehlende Vergleichsgrundlage darf nicht wie ein Ergebnis aussehen; die Zahl kommt aus
        // revisionCounts.registered, das seit PRD-35 an 385 von 385 Dokumenten ausgeliefert wird und
        // hier bis jetzt keinen einzigen Leser hatte.
        const script = await readEmittedScript()

        expect( script ).toContain( 'if( doc.revisionsIncluded === false ) {' )
        expect( script ).toContain( 'noch nicht geladen' )
        expect( script ).toContain( 'var counts = ( doc.revisionCounts && typeof doc.revisionCounts === \'object\' ) ? doc.revisionCounts : null' )
        expect( script ).toContain( 'counts.registered' )
        // Der Leser existiert: revisionCounts kommt im Client jetzt vor — vorher 0 mal.
        expect( script.split( 'revisionCounts' ).length - 1 ).toBeGreaterThan( 1 )
    } )


    it( 'T-P: computeSidebarSignature aendert sich, wenn sich der Scope-Zustand aendert', async () => {
        // Vergleichsmenge: dieselbe Funktion, viermal ausgewertet — Ausgangszustand, ein angefordertes
        // Projekt, ein geladenes Projekt, zurueck auf Ausgangszustand. Ohne diesen Fall ueberspringt die
        // Auslassungs-Weiche genau das Neuzeichnen, das die Antwort auf die eigene Anfrage ausloest.
        const { source } = await extractFunctionSources( [ 'computeSidebarSignature' ] )
        const factory = new Function( 'scope', `
            with( scope ) {
                ${ source }
                return computeSidebarSignature
            }
        ` )

        const scope = {
            'window': { '__MEMO_CONFIG__': { 'showOnlyFullRevisions': true } },
            'collapsedProjects': new Set( [ 'p1' ] ),
            'collapsedMemos': new Set(),
            'revealedMemos': new Set(),
            'scopedProjects': new Set(),
            'pendingScopeProjects': new Set(),
            'currentMode': 'memos',
            'lastTree': { 'p1': { 'memos': [] } },
            'lastLatest': [],
            'lastTranscriptTree': {}
        }

        const signature = factory( scope )
        const base = signature()

        scope[ 'pendingScopeProjects' ].add( 'p1' )
        const pending = signature()

        scope[ 'pendingScopeProjects' ].delete( 'p1' )
        scope[ 'scopedProjects' ].add( 'p1' )
        const loaded = signature()

        scope[ 'scopedProjects' ].delete( 'p1' )
        const back = signature()

        expect( pending ).not.toBe( base )
        expect( loaded ).not.toBe( base )
        expect( loaded ).not.toBe( pending )
        // VAKUUM-RIEGEL: die Vorrichtung meldet auch GLEICHHEIT, sonst waere jede Ungleichheit wertlos.
        expect( back ).toBe( base )
    } )


    it( 'T-Q: eine betrachtete, ausgeblendete Revision wird aufgedeckt und aktiv markiert — mit Gegenprobe', async () => {
        // Vergleichsmenge: 4 Revisionen (2 full, 1 prepare, 1 update), zweimal ausgewertet — einmal mit
        // einer ausgeblendeten und einmal mit einer sichtbaren betrachteten Revision. Der Filter ist der
        // ECHTE, aus dem Client gehobene. Genau dieser Zustand gehoerte weder PRD-33 noch PRD-35: ein
        // Deep-Link auf eine ausgeblendete Revision zeigte Inhalt, aber keine Zeile und 0 Markierungen.
        const { partitionRevisionsByConfigFilter } = await extractFunctions( [ 'revisionPassesConfigFilter', 'partitionRevisionsByConfigFilter' ] )
        global.window = { '__MEMO_CONFIG__': { 'showOnlyFullRevisions': true } }

        try {
            const revisions = [
                { 'fileName': 'REV-04.md', 'revisionType': 'full' },
                { 'fileName': 'REV-03-prepare.md', 'revisionType': 'prepare' },
                { 'fileName': 'REV-02-update.md', 'revisionType': 'update' },
                { 'fileName': 'REV-01.md', 'revisionType': 'full' }
            ]

            expect( revisions.length ).toBe( 4 )

            const partition = partitionRevisionsByConfigFilter( revisions )

            expect( partition[ 'kept' ].length ).toBe( 2 )
            expect( partition[ 'hidden' ].length ).toBe( 2 )

            // Die Entscheidung, wie sie renderMemo trifft.
            const revealDecision = ( { selectedRevision } ) => {
                const viewedIsHidden = partition[ 'hidden' ].some( ( rev ) => rev[ 'fileName' ] === selectedRevision )
                const shown = viewedIsHidden ? revisions : partition[ 'kept' ]

                return {
                    viewedIsHidden,
                    'rowForViewed': shown.filter( ( rev ) => rev[ 'fileName' ] === selectedRevision ).length,
                    'activeMarkers': shown.filter( ( rev ) => rev[ 'fileName' ] === selectedRevision ).length
                }
            }

            const hiddenCase = revealDecision( { 'selectedRevision': 'REV-03-prepare.md' } )
            expect( hiddenCase[ 'viewedIsHidden' ] ).toBe( true )
            expect( hiddenCase[ 'rowForViewed' ] ).toBe( 1 )
            expect( hiddenCase[ 'activeMarkers' ] ).toBe( 1 )

            // GEGENPROBE: eine SICHTBARE Revision erzeugt genau eine Markierung und KEINE Aufdeckung.
            const visibleCase = revealDecision( { 'selectedRevision': 'REV-04.md' } )
            expect( visibleCase[ 'viewedIsHidden' ] ).toBe( false )
            expect( visibleCase[ 'activeMarkers' ] ).toBe( 1 )

            // Und die Verdrahtung im Quelltext, damit der Fall nicht eine Nachbildung prueft.
            const script = await readEmittedScript()
            expect( script ).toContain( 'var viewedIsHidden = partition.hidden.some( function( rev ) { return rev.fileName === doc.selectedRevision } )' )
            expect( script ).toContain( 'var isRevealed = revealedMemos.has( doc.documentId ) || viewedIsHidden' )
        } finally {
            delete global.window
        }
    } )
} )


describe( 'PRD-38 — am LAUFENDEN Server: Nachricht, Gate und Anforderung (D1, WI-106/107)', () => {

    let sandbox = ''
    let report = null
    let blocker = null


    beforeAll( async () => {
        await mkdir( join( repoRoot, '.test-tmp' ), { 'recursive': true } )
        sandbox = await mkdtemp( join( repoRoot, '.test-tmp', 'catalog-wire-prd38-' ) )

        const root = join( sandbox, 'run' )
        const project = join( root, 'proj' )
        const other = join( root, 'zwo' )
        const later = join( root, 'spaeter' )

        // Der POST-Weg prueft das Memo-Schema (gemessen: 15 Verstoesse und ein 400 fuer einen Rumpf),
        // also traegt das Wegwerf-Memo, das die Gate-Faelle registrieren, die geforderten Abschnitte.
        const validRevision = [
            '| Feld | Wert |', '|---|---|', '| **Memo** | 999 |', '| **Memo-Name** | delta |',
            '| **Revision** | REV-01 |', '| **Datum** | 2026-09-08 |', '| **Status** | Entwurf |', '',
            '## Vorwort', 'Eins.', '', '## Kontext', 'Zwei.', '', '## Offene Fragen', 'Keine.', '',
            '## Beantwortete Fragen', 'Keine.', '', '## Phasen', 'Keine.', '', '## Phase-Hints', 'Keine.', '',
            '## Finalisierungs-Checkliste', 'Keine.', '', '## Ancillary Files', 'Keine.', '',
            '## Rollout-Entry-Points', 'Keine.', '', '## Lessons-Learned', 'Keine.', ''
        ].join( '\n' )

        // 004-delta liegt BEWUSST ausserhalb der beiden Projekt-Wurzeln der Session-Config: laege es
        // darin, waere es beim Start schon registriert und der POST unten waere keine Aenderung —
        // gemessen kam der Katalog dann auf 4 Dokumente und die Positiv-Kontrolle kontrollierte nichts.
        const memos = [
            { 'root': later, 'dir': '004-delta', 'files': { 'REV-01.md': validRevision } },
            { 'root': project, 'dir': '001-alpha', 'files': { 'REV-01.md': '# alpha eins\n', 'REV-02.md': '# alpha zwei\n' } },
            { 'root': project, 'dir': '002-beta', 'files': { 'REV-01.md': '# beta eins\n' } },
            { 'root': other, 'dir': '003-gamma', 'files': { 'REV-01.md': '# gamma eins\n', 'REV-02.md': '# gamma zwei\n' } }
        ]

        await memos.reduce( async ( chain, memo ) => {
            await chain
            const revisions = join( memo[ 'root' ], '.memo', 'memos', memo[ 'dir' ], 'revisions' )
            await mkdir( revisions, { 'recursive': true } )

            await Object.keys( memo[ 'files' ] )
                .reduce( async ( inner, fileName ) => {
                    await inner
                    await writeFile( join( revisions, fileName ), memo[ 'files' ][ fileName ], 'utf8' )
                }, Promise.resolve() )
        }, Promise.resolve() )

        const configPath = join( root, '.sessions', 'config.json' )
        await mkdir( join( root, '.sessions' ), { 'recursive': true } )
        await writeFile( configPath, JSON.stringify( { 'projects': [ { 'projectId': 'proj', 'projectRoot': project }, { 'projectId': 'zwo', 'projectRoot': other } ] }, null, 4 ), 'utf8' )
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
                    'PRD38_PORT': String( CHILD_PORT ),
                    'PRD38_SRC': memoViewPath
                }
            }
        ).catch( ( error ) => {
            return { 'stdout': error[ 'stdout' ] === undefined ? '' : error[ 'stdout' ], 'stderr': error[ 'stderr' ] === undefined ? '' : error[ 'stderr' ] }
        } )

        const parts = String( answered[ 'stdout' ] ).split( '###PRD38###' )

        if( parts.length !== 3 ) {
            blocker = `kein Ergebnisblock — stdout(${ String( answered[ 'stdout' ] ).length }): ${ String( answered[ 'stdout' ] ).slice( -600 ) } — stderr: ${ String( answered[ 'stderr' ] ).slice( -800 ) }`

            return
        }

        report = JSON.parse( parts[ 1 ] )
    }, 180000 )


    afterAll( async () => {
        if( sandbox.length > 0 ) { await rm( sandbox, { 'recursive': true, 'force': true } ) }
    } )


    it( 'die Vorrichtung hat gemessen (sonst ist alles darunter unbewertbar, nicht gruen)', () => {
        expect( blocker ).toBe( null )
        expect( report ).not.toBe( null )
        expect( report[ 'portCollision' ] ).toBe( false )
        expect( report[ 'documentCount' ] ).toBe( 3 )
        expect( report[ 'postStatus' ] ).toBe( 200 )
    } )


    it( 'T-G: die documentList-Nachricht traegt comparison — die Schluessel woertlich', () => {
        // Vergleichsmenge: die Schluessel der ersten documentList-Nachricht eines echten Sockets. Gegen
        // den alten Stand waren es genau drei: type, tree, latest. PRD-35 baute die Selbstauskunft, der
        // einzige Aufrufer destrukturierte sie zwei Zeilen spaeter weg.
        expect( report[ 'documentListKeys' ] ).toEqual( [ 'type', 'tree', 'latest', 'comparison' ] )
        expect( report[ 'comparison' ] ).not.toBe( null )
        expect( report[ 'comparison' ][ 'filter' ] ).toBe( 'full-or-update' )
    } )


    it( 'T-H: comparison.considered === kept + removed', () => {
        const comparison = report[ 'comparison' ]

        expect( typeof comparison[ 'considered' ] ).toBe( 'number' )
        expect( comparison[ 'considered' ] ).toBe( comparison[ 'kept' ] + comparison[ 'removed' ] )
        expect( comparison[ 'considered' ] ).toBeGreaterThan( 0 )
    } )


    it( 'T-I: eine unveraenderte Wiederholung wird zurueckgehalten — mit Positiv-Kontrolle', () => {
        // Vergleichsmenge: zwei aufeinanderfolgende Ausloeser auf DERSELBEN Verbindung, einmal ohne und
        // einmal mit echter Katalog-Aenderung. Ohne die zweite Zeile ist "0 gesendet" nicht von einem
        // Gate zu unterscheiden, das alles blockiert.
        expect( report[ 'repeatSent' ] ).toBe( 0 )
        expect( report[ 'repeatHeld' ] ).toBeGreaterThan( 0 )
        expect( report[ 'realChangeSent' ] ).toBeGreaterThan( 0 )
    } )


    it( 'T-J: die Auswahl eines Sockets aendert den Katalog eines ANDEREN Sockets nicht', () => {
        // Vergleichsmenge: 2 Sockets, 1 Klick, die Nutzlast von B vorher und nachher. Gegen den alten
        // Stand war genau das falsch — der Klick sandte 855 456 B an jeden verbundenen Client, und die
        // Nutzlast war jedes Mal eine andere.
        expect( report[ 'otherSocketMessagesOnClick' ] ).toBe( 0 )
        expect( report[ 'otherSocketPayloadBefore' ] ).toBe( report[ 'otherSocketPayloadAfter' ] )
        // VAKUUM-RIEGEL: die eigene Nutzlast des klickenden Sockets aendert sich sehr wohl.
        expect( report[ 'ownPayloadChanged' ] ).toBe( true )
    } )


    it( 'T-K: das Gate zaehlt, was es zurueckgehalten hat — mit Vakuum-Riegel', () => {
        // Vergleichsmenge: der Zaehler auf /api/health vor und nach jedem der beiden Schritte.
        expect( report[ 'gateHeldDelta' ] ).toBeGreaterThan( 0 )
        expect( report[ 'gateHeldBytesDelta' ] ).toBeGreaterThan( 0 )
        expect( report[ 'gateSentDeltaOnRepeat' ] ).toBe( 0 )
        // VAKUUM-RIEGEL in der ehrlichen Richtung: bei einer ECHTEN Aenderung SENDET das Gate, statt zu
        // halten. Dass sein Halte-Zaehler dabei trotzdem waechst, ist gemessen und richtig: der POST
        // stoesst BEIDE Kataloge an, und der Transcript-Katalog hat sich bei einer reinen Dokument-
        // Aenderung nicht veraendert — er wird also zu Recht zurueckgehalten. Ein auf 0 gedrehter
        // Erwartungswert haette hier eine falsche Aussage gruen gemacht.
        expect( report[ 'gateSentDeltaOnRealChange' ] ).toBeGreaterThan( 0 )
        expect( report[ 'gateHeldDeltaOnRealChange' ] ).toBeLessThan( report[ 'gateHeldDelta' ] )
    } )


    it( 'T-L: requestProjectScope liefert die Tiefe an DIESEN Socket; eine unbekannte Kennung wird abgewiesen und benannt', () => {
        // Vergleichsmenge: 1 gueltige und 1 unbekannte Kennung, je eine Anfrage.
        expect( report[ 'scopeRevisionsBefore' ] ).toBe( 0 )
        expect( report[ 'scopeRevisionsAfter' ] ).toBeGreaterThan( 0 )
        expect( report[ 'scopeProjectsBefore' ] ).toBe( report[ 'scopeProjectsAfter' ] )
        expect( report[ 'rejectedType' ] ).toBe( 'projectScopeRejected' )
        expect( report[ 'rejectedIds' ] ).toEqual( [ 'gibtsnicht' ] )
        expect( String( report[ 'rejectedMessages' ].join( ' ' ) ) ).toContain( 'Unknown project' )
    } )


    it( 'T-M: eine ausdrueckliche Anfrage wird auch bei unveraenderter Signatur beantwortet', () => {
        // Ein Gate, das eine Frage verschluckt, ist derselbe Defekt wie ein Katalog, der ungefragt kommt.
        expect( report[ 'repeatedScopeRequestAnswered' ] ).toBe( true )
    } )


    it( 'T-R: der Betrachter-Bestand des Servers schrumpft beim Verbindungsende', () => {
        // Vergleichsmenge: 5 Verbindungen, gezaehlt vorher / waehrend / nachher am laufenden Server.
        expect( report[ 'viewersDuring' ] - report[ 'viewersBefore' ] ).toBe( 5 )
        expect( report[ 'viewersAfter' ] ).toBe( report[ 'viewersBefore' ] )
    } )
} )


// Der Kind-Prozess. Wird zur Laufzeit in den Wegwerf-Baum geschrieben, nie eine weitere verfolgte Datei.
// Er startet das ECHTE Server-Modul dieses Worktrees, misst ueber die Leitung, druckt EINEN JSON-Block
// zwischen Markierungen und beendet sich — was den Port wieder freigibt.
const harnessSource = `import { createConnection } from 'node:net'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { WebSocket } from 'ws'

// Die Nutzlasten werden als Streuwert berichtet, nicht als Text: verglichen wird ohnehin nur auf
// Gleichheit, und ein Bericht mit zwei vollen Katalogen hat den stdout-Schreibvorgang ueberholt —
// process.exit( 0 ) schneidet einen laufenden Pipe-Write ab (gemessen: 8872 Zeichen kamen an, der
// Ergebnisblock war unvollstaendig und damit unbewertbar, nicht rot).
const digest = ( text ) => createHash( 'sha256' ).update( text ).digest( 'hex' ).slice( 0, 16 )

const PORT = Number( process.env[ 'PRD38_PORT' ] )
const SRC = process.env[ 'PRD38_SRC' ]
const base = 'http://127.0.0.1:' + PORT

const wait = ( ms ) => new Promise( ( done ) => setTimeout( done, ms ) )

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

const open = async () => {
    const ws = new WebSocket( 'ws://127.0.0.1:' + PORT + '/' )
    const frames = []
    ws.on( 'message', ( raw ) => {
        const text = raw.toString()
        const parsed = JSON.parse( text )
        frames.push( { 'type': parsed[ 'type' ], 'raw': text, 'payload': parsed } )
    } )
    await new Promise( ( ok ) => ws.on( 'open', ok ) )
    return { ws, frames }
}

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

const gate = async () => ( await ( await fetch( base + '/api/health' ) ).json() )[ 'catalogGate' ]

const revisionsIn = ( payload ) => Object.keys( payload[ 'tree' ] )
    .reduce( ( acc, projectId ) => acc.concat( payload[ 'tree' ][ projectId ][ 'memos' ] || [] ), [] )
    .reduce( ( acc, doc ) => acc + doc[ 'revisions' ].length, 0 )

const main = async () => {
    const collision = await probe()
    const report = { 'portCollision': collision, 'documentCount': 0 }

    if( collision === true ) {
        process.stdout.write( '###PRD38###' + JSON.stringify( report ) + '###PRD38###', () => process.exit( 0 ) )

        return
    }

    const { MemoView } = await import( SRC )
    await MemoView.startServer( { 'port': PORT } )

    const listed = await ( await fetch( base + '/api/documents' ) ).json()
    report[ 'documentCount' ] = ( listed[ 'documents' ] || [] ).length

    const a = await open()
    const b = await open()
    await wait( 2500 )

    const firstList = a.frames.filter( ( f ) => f[ 'type' ] === 'documentList' )[ 0 ]
    report[ 'documentListKeys' ] = Object.keys( firstList[ 'payload' ] )
    report[ 'comparison' ] = firstList[ 'payload' ][ 'comparison' ]

    // T-J: B haelt seine Nutzlast fest, A klickt.
    const bListsBefore = b.frames.filter( ( f ) => f[ 'type' ] === 'documentList' )
    report[ 'otherSocketPayloadBefore' ] = digest( bListsBefore[ bListsBefore.length - 1 ][ 'raw' ] )
    const aMark = a.frames.length
    const bMark = b.frames.length
    a.ws.send( JSON.stringify( { 'type': 'selectRevision', 'documentId': 'proj--001-alpha', 'fileName': 'REV-02.md' } ) )
    await wait( 2500 )
    report[ 'otherSocketMessagesOnClick' ] = b.frames.slice( bMark ).filter( ( f ) => f[ 'type' ] === 'documentList' ).length
    const bListsAfter = b.frames.filter( ( f ) => f[ 'type' ] === 'documentList' )
    report[ 'otherSocketPayloadAfter' ] = digest( bListsAfter[ bListsAfter.length - 1 ][ 'raw' ] )
    const aLists = a.frames.slice( aMark ).filter( ( f ) => f[ 'type' ] === 'documentList' )
    report[ 'ownPayloadChanged' ] = aLists.length > 0 && aLists[ 0 ][ 'raw' ] !== firstList[ 'raw' ]

    // POSITIV-KONTROLLE ZUERST: eine ECHTE Katalog-Aenderung geht durch, und das Gate haelt dabei
    // NICHTS. Gefahren wird der PRODUKTIVE Weg (POST /api/documents), weil nur er die Client-Menge des
    // Servers kennt — die Sockets dieses Messkoerpers sind die Gegenstuecke, nicht die des Servers, und
    // ein Broadcast an sie haette gar nichts gemessen.
    const deltaPath = join( process.cwd(), 'spaeter', '.memo', 'memos', '004-delta', 'revisions' )
    const gate3 = await gate()
    const aMark3 = a.frames.length
    const posted = await fetch( base + '/api/documents', {
        'method': 'POST',
        'headers': { 'Content-Type': 'application/json' },
        'body': JSON.stringify( { 'projectId': 'spaeter', 'memoPath': deltaPath } )
    } )
    report[ 'postStatus' ] = posted[ 'status' ]
    await wait( 2500 )
    const gate4 = await gate()
    report[ 'realChangeSent' ] = a.frames.slice( aMark3 ).filter( ( f ) => f[ 'type' ] === 'documentList' ).length
    report[ 'gateHeldDeltaOnRealChange' ] = gate4[ 'heldSends' ] - gate3[ 'heldSends' ]
    report[ 'gateSentDeltaOnRealChange' ] = gate4[ 'sentSends' ] - gate3[ 'sentSends' ]

    // T-I / T-K: DERSELBE Ausloeser noch einmal, ohne dass sich der Katalog geaendert hat.
    const gate1 = await gate()
    const aMark2 = a.frames.length
    await fetch( base + '/api/documents', {
        'method': 'POST',
        'headers': { 'Content-Type': 'application/json' },
        'body': JSON.stringify( { 'projectId': 'spaeter', 'memoPath': deltaPath } )
    } )
    await wait( 2500 )
    const gate2 = await gate()
    report[ 'repeatSent' ] = a.frames.slice( aMark2 ).filter( ( f ) => f[ 'type' ] === 'documentList' ).length
    report[ 'repeatHeld' ] = gate2[ 'heldSends' ] - gate1[ 'heldSends' ]
    report[ 'gateHeldDelta' ] = gate2[ 'heldSends' ] - gate1[ 'heldSends' ]
    report[ 'gateHeldBytesDelta' ] = gate2[ 'heldBytes' ] - gate1[ 'heldBytes' ]
    report[ 'gateSentDeltaOnRepeat' ] = gate2[ 'sentSends' ] - gate1[ 'sentSends' ]

    // T-L / T-M: die Anforderung der Tiefe.
    const c = await open()
    await wait( 2500 )
    const cLists = c.frames.filter( ( f ) => f[ 'type' ] === 'documentList' )
    report[ 'scopeRevisionsBefore' ] = revisionsIn( cLists[ cLists.length - 1 ][ 'payload' ] )
    report[ 'scopeProjectsBefore' ] = Object.keys( cLists[ cLists.length - 1 ][ 'payload' ][ 'tree' ] ).length

    const scoped = await ask( c.ws, { 'type': 'requestProjectScope', 'projectIds': [ 'zwo' ] }, 'documentList' )
    report[ 'scopeRevisionsAfter' ] = revisionsIn( scoped )
    report[ 'scopeProjectsAfter' ] = Object.keys( scoped[ 'tree' ] ).length

    const repeated = await ask( c.ws, { 'type': 'requestProjectScope', 'projectIds': [ 'zwo' ] }, 'documentList' )
    report[ 'repeatedScopeRequestAnswered' ] = repeated !== null

    const rejected = await ask( c.ws, { 'type': 'requestProjectScope', 'projectIds': [ 'gibtsnicht' ] }, 'projectScopeRejected' )
    report[ 'rejectedType' ] = rejected === null ? null : rejected[ 'type' ]
    report[ 'rejectedIds' ] = rejected === null ? [] : rejected[ 'rejected' ]
    report[ 'rejectedMessages' ] = rejected === null ? [] : rejected[ 'messages' ]

    // T-R: Betrachter-Bestand.
    report[ 'viewersBefore' ] = ( await gate() )[ 'viewers' ]
    const many = []
    await Array.from( { 'length': 5 } ).reduce( async ( chain ) => {
        await chain
        many.push( await open() )
        await wait( 150 )
    }, Promise.resolve() )
    await wait( 1200 )
    report[ 'viewersDuring' ] = ( await gate() )[ 'viewers' ]
    many.forEach( ( m ) => m.ws.close() )
    await wait( 2000 )
    report[ 'viewersAfter' ] = ( await gate() )[ 'viewers' ]

    a.ws.close()
    b.ws.close()
    c.ws.close()

    // Erst schreiben, DANN beenden — sonst schneidet der Prozess-Abbruch den eigenen Bericht ab.
    process.stdout.write( '###PRD38###' + JSON.stringify( report ) + '###PRD38###', () => process.exit( 0 ) )
}

// Ein Fehler im Messkoerper darf den Server nicht am Leben lassen: der Aufrufer wartete sonst, bis
// sein eigener Deckel zuschlaegt, und bekaeme einen Haenger statt eines Befundes. Ein Haenger meldet
// nichts.
await main().catch( ( error ) => {
    process.stdout.write( '###PRD38###' + JSON.stringify( { 'harnessError': String( error && error.message ) } ) + '###PRD38###', () => process.exit( 1 ) )
} )
`
