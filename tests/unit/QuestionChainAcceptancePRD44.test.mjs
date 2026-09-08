import { describe, it, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    openQuestionsFromContent,
    cascadeStageOf,
    judgeLink,
    condition,
    chainBalance,
    consumesCloneOf,
    cloneConsumedNotice,
    normalizeSpace,
    readOnlyFingerprint,
    VERDICT,
    CHAIN_LINKS
} from '../manual/question-chain-acceptance.mjs'


// PRD-44 (Memo 081, Kap 19 / WI-065 + WI-063) — the chain-acceptance fixture gets an acceptance of
// its own.
//
// WHY THIS FILE EXISTS. tests/manual/** does not match jest's testMatch, so the fixture does NOT run
// under `npm test`. It needs playwright (which resolves from OUTSIDE this repository) and a running
// server, so in CI it is BLOCKED by construction — and that is exactly what would leave it with
// NOTHING protecting it from decay. These cases pin its PURE parts: no browser, no server, no port.
//
// The heart of the file is T-A, T-C and T-E: they check the GUARDS themselves. A guard that has never
// been seen to fire is not a guard, and a fixture whose vacuum latches are only asserted in prose is a
// fixture whose latches are untested.
//
// REPO BOUNDARY (M080/PRD-V4). Every path read below lies INSIDE this repository and is latched with
// existsSync before it is read; CI checks this repository out ALONE. Nothing is written, no port is
// bound, and `DocumentRegistry.addDocument` is called ZERO times — so the "shutdown after every
// addDocument" obligation is met by there being no registry to shut down, which T-H measures rather
// than assumes.


const HERE = dirname( fileURLToPath( import.meta.url ) )
const CHAIN_FIXTURE = join( HERE, '..', 'manual', 'question-chain-acceptance.mjs' )
const DEEPLINK_FIXTURE = join( HERE, '..', 'manual', 'deep-link-acceptance.mjs' )

const readSource = ( { file } ) => {
    if( existsSync( file ) !== true ) { return { 'status': false, 'text': '' } }

    return { 'status': true, 'text': readFileSync( file, 'utf-8' ) }
}


// Three questions, none of which carries a `status` field. DocumentRegistry normalises exactly this
// shape to 'open', which is why the count below is 3 and not 0 — the very rule the surface applies.
const THREE_WITHOUT_STATUS = [
    '# Fixture',
    '',
    '```questions-json',
    JSON.stringify( [
        { 'id': 'F1', 'title': 'Erste', 'frage': 'Erste?', 'typ': 'single', 'options': [ { 'kind': 'option', 'key': 'A', 'label': 'Alpha' }, { 'kind': 'option', 'key': 'B', 'label': 'Beta' } ], 'aiRecommendation': 'A — weil Alpha' },
        { 'id': 'F2', 'title': 'Zweite', 'frage': 'Zweite?', 'typ': 'single', 'options': [ { 'kind': 'option', 'key': 'A', 'label': 'Gamma' } ], 'aiRecommendation': '' },
        { 'id': 'F3', 'title': 'Dritte', 'frage': 'Dritte?', 'typ': 'single', 'options': [ { 'kind': 'option', 'key': 'A', 'label': 'Delta' } ], 'preselected': [ 0 ] }
    ], null, 2 ),
    '```',
    ''
].join( '\n' )

const ONE_ANSWERED = THREE_WITHOUT_STATUS
    .replace( '"title": "Zweite"', '"status": "answered",\n      "title": "Zweite"' )


describe( 'PRD-44 — die Frage-Kette wird in EINEM Durchgang abgenommen (WI-065 / WI-063)', () => {

    describe( 'T-A — das Orakel zaehlt die offenen Fragen, und es zaehlt in BEIDE Richtungen', () => {

        it( 'liest 3 offene Fragen aus einem Text, dessen Fragen KEIN status-Feld tragen', () => {
            const result = openQuestionsFromContent( { 'content': THREE_WITHOUT_STATUS } )

            expect( result[ 'found' ] ).toBe( true )
            expect( result[ 'status' ] ).toBe( true )
            expect( result[ 'total' ] ).toBe( 3 )
            expect( result[ 'open' ] ).toBe( 3 )
        } )

        it( 'liest 2 offene Fragen, sobald eine auf answered steht — die Rueckrichtung ist der Vakuum-Riegel', () => {
            const result = openQuestionsFromContent( { 'content': ONE_ANSWERED } )

            expect( result[ 'found' ] ).toBe( true )
            expect( result[ 'total' ] ).toBe( 3 )
            expect( result[ 'open' ] ).toBe( 2 )
        } )

        it( 'beide Zahlen sind groesser als 0 — ein Zaehler, der nur 0 liefert, hat nichts bewiesen', () => {
            const before = openQuestionsFromContent( { 'content': THREE_WITHOUT_STATUS } )[ 'open' ]
            const after = openQuestionsFromContent( { 'content': ONE_ANSWERED } )[ 'open' ]

            expect( before ).toBeGreaterThan( 0 )
            expect( after ).toBeGreaterThan( 0 )
            expect( before ).not.toBe( after )
        } )

        it( 'unterscheidet "kein Block gefunden" von "Block gefunden, 0 offen" — die duerfen nie eine Zahl werden', () => {
            const noBlock = openQuestionsFromContent( { 'content': '# nur Prosa, kein Block' } )

            expect( noBlock[ 'found' ] ).toBe( false )
            expect( noBlock[ 'status' ] ).toBe( false )
            expect( noBlock[ 'open' ] ).toBe( 0 )
            expect( noBlock[ 'reason' ] ).not.toBeNull()
        } )

        // MEASURED, not assumed: the parser itself DERIVES aiRecommended from the recommendation text
        // ("A — weil Alpha" -> [ 0 ]). So a question that carries only the prose already leaves
        // DocumentRegistry as a server-field case, and the client's regex fallback is reached far less
        // often than reading app.client.mjs alone suggests. That is reported here and in the report, and
        // it is expressly NOT graded (§ N3) — the cascade weakness is its own subject.
        it( 'zaehlt Empfehlungstext und Vorauswahl getrennt — die Kaskaden-Stufe wird berichtet, nicht bewertet', () => {
            const result = openQuestionsFromContent( { 'content': THREE_WITHOUT_STATUS } )

            expect( result[ 'withRecommendation' ] ).toBe( 1 )
            expect( result[ 'withPreselection' ] ).toBe( 1 )
            expect( cascadeStageOf( { 'question': result[ 'questions' ][ 0 ] } )[ 'stage' ] ).toBe( 'server-field' )
            expect( cascadeStageOf( { 'question': result[ 'questions' ][ 2 ] } )[ 'stage' ] ).toBe( 'preselected-fallback' )
        } )

        it( 'die Kaskaden-Stufe kennt den Regex-Rueckfall und die Nicht-Markierung — beide Zweige sind erreichbar', () => {
            expect( cascadeStageOf( { 'question': { 'aiRecommendation': 'B — weil Beta' } } )[ 'stage' ] ).toBe( 'regex-fallback' )
            expect( cascadeStageOf( { 'question': { 'aiRecommendation': 'weil es passt' } } )[ 'stage' ] ).toBe( 'none' )
            expect( cascadeStageOf( { 'question': null } )[ 'stage' ] ).toBe( 'none' )
        } )

        it( 'ein fehlender Text ist ein benannter Ausfall, kein stilles 0', () => {
            const result = openQuestionsFromContent( { 'content': null } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'reason' ] ).toContain( 'comparison set' )
        } )
    } )


    describe( 'T-B — das Orakel benutzt den Parser des Repos, nicht einen getippten Ausdruck', () => {

        it( 'ruft DocumentRegistry.parseQuestionJsonBlock im Quelltext der Vorrichtung auf', () => {
            const source = readSource( { 'file': CHAIN_FIXTURE } )

            expect( source[ 'status' ] ).toBe( true )
            expect( source[ 'text' ].includes( 'DocumentRegistry.parseQuestionJsonBlock' ) ).toBe( true )
        } )

        it( 'baut KEINEN eigenen questions-json-Ausdruck nach — sonst haette das Repo zwei Parser', () => {
            const source = readSource( { 'file': CHAIN_FIXTURE } )
            const ownBlockPattern = source[ 'text' ].match( /\/```questions-json/g )

            expect( ownBlockPattern ).toBeNull()
        } )

        it( 'filtert auf status === open — dieselbe Regel, die openQuestionsOf im Client anwendet', () => {
            const source = readSource( { 'file': CHAIN_FIXTURE } )

            expect( source[ 'text' ].includes( "[ 'status' ] === 'open'" ) ).toBe( true )
        } )
    } )


    describe( 'T-C — das Urteil ist DREIWERTIG, und eine leere Vergleichsmenge ist nie gruen', () => {

        it( 'liefert UNBEWERTBAR bei compared === 0, niemals PASS', () => {
            const result = judgeLink( {
                'id': 'K1',
                'compared': 0,
                'total': 12,
                'conditions': [ condition( { 'name': 'irgendetwas', 'passed': true, 'detail': 'haelt' } ) ]
            } )

            expect( result[ 'verdict' ] ).toBe( VERDICT[ 'inconclusive' ] )
            expect( result[ 'verdict' ] ).not.toBe( VERDICT[ 'pass' ] )
            expect( result[ 'reason' ] ).not.toBeNull()
        } )

        it( 'liefert UNBEWERTBAR, wenn ueberhaupt keine Bedingung behauptet wurde', () => {
            const result = judgeLink( { 'id': 'K2', 'compared': 3, 'total': 3, 'conditions': [] } )

            expect( result[ 'verdict' ] ).toBe( VERDICT[ 'inconclusive' ] )
            expect( result[ 'reason' ] ).toContain( 'asserts nothing' )
        } )

        it( 'liefert PASS nur, wenn jede Bedingung haelt', () => {
            const result = judgeLink( {
                'id': 'K2',
                'compared': 3,
                'total': 3,
                'conditions': [
                    condition( { 'name': 'a', 'passed': true, 'detail': '3 / 3' } ),
                    condition( { 'name': 'b', 'passed': true, 'detail': '3 / 3' } )
                ]
            } )

            expect( result[ 'verdict' ] ).toBe( VERDICT[ 'pass' ] )
            expect( result[ 'errorText' ] ).toBeNull()
        } )

        it( 'liefert FAIL, sobald eine einzige Bedingung faellt', () => {
            const result = judgeLink( {
                'id': 'K3',
                'compared': 2,
                'total': 12,
                'conditions': [
                    condition( { 'name': 'a', 'passed': true, 'detail': 'haelt' } ),
                    condition( { 'name': 'b', 'passed': false, 'detail': 'faellt' } )
                ]
            } )

            expect( result[ 'verdict' ] ).toBe( VERDICT[ 'fail' ] )
        } )

        it( 'kennt genau drei Urteilswerte und keinen vierten', () => {
            expect( Object.values( VERDICT ).sort() ).toEqual( [ 'FAIL', 'INCONCLUSIVE', 'PASS' ] )
        } )
    } )


    describe( 'T-D — die Bilanz-Zeile nennt BEIDE Zahlen und ist bei 0 Zielen rot', () => {

        it( 'nennt geprueft und gesamt', () => {
            expect( chainBalance( { 'checked': 11, 'total': 12 } )[ 'line' ] ).toBe( '11 / 12' )
        } )

        it( 'ist rot, sobald es nichts zu vergleichen gab', () => {
            const empty = chainBalance( { 'checked': 0, 'total': 0 } )

            expect( empty[ 'line' ] ).toBe( '0 / 0' )
            expect( empty[ 'red' ] ).toBe( true )
        } )

        it( 'ist nicht rot, wenn eine Vergleichsmenge existiert — auch wenn nichts bestand', () => {
            const nothingPassed = chainBalance( { 'checked': 0, 'total': 12 } )

            expect( nothingPassed[ 'red' ] ).toBe( false )
        } )

        it( 'jedes Urteil traegt seine Bilanz-Zeile mit sich — ein Verdikt ohne Vergleichszahl ist nicht moeglich', () => {
            const result = judgeLink( { 'id': 'K4', 'compared': 2, 'total': 12, 'conditions': [ condition( { 'name': 'a', 'passed': true, 'detail': 'x' } ) ] } )

            expect( result[ 'balance' ] ).toBe( '2 / 12' )
        } )
    } )


    describe( 'T-E — die Adressform kommt aus deep-link-acceptance.mjs, sie wird nicht nachgebaut', () => {

        it( 'importiert deepLinkPathFor aus der bestehenden Vorrichtung', () => {
            const source = readSource( { 'file': CHAIN_FIXTURE } )

            expect( source[ 'text' ].includes( 'deepLinkPathFor' ) ).toBe( true )
            expect( source[ 'text' ].includes( "from './deep-link-acceptance.mjs'" ) ).toBe( true )
        } )

        it( 'schreibt die Adressform NULL mal selbst hin', () => {
            const source = readSource( { 'file': CHAIN_FIXTURE } )
            const hits = source[ 'text' ].split( [ '/d', 'oc/' ].join( '' ) ).length - 1

            expect( hits ).toBe( 0 )
        } )

        it( 'POSITIV-KONTROLLE: derselbe Zaehler findet die Adressform in deep-link-acceptance.mjs', () => {
            const source = readSource( { 'file': DEEPLINK_FIXTURE } )
            const hits = source[ 'text' ].split( [ '/d', 'oc/' ].join( '' ) ).length - 1

            expect( source[ 'status' ] ).toBe( true )
            expect( hits ).toBeGreaterThan( 0 )
        } )

        it( 'importiert auch resolvePlaywright, formatBalance und compareRuns statt sie zu kopieren', () => {
            const source = readSource( { 'file': CHAIN_FIXTURE } )

            expect( source[ 'text' ].includes( 'resolvePlaywright' ) ).toBe( true )
            expect( source[ 'text' ].includes( 'formatBalance' ) ).toBe( true )
            expect( source[ 'text' ].includes( 'compareRuns' ) ).toBe( true )
        } )
    } )


    describe( 'T-F — der Fehlertext ueberlebt; eine Bilanz allein ist kein Befund', () => {

        it( 'traegt den VOLLEN Text jeder gefallenen Bedingung im Ergebnis-Objekt', () => {
            const detail = 'data-qw-rendered=0 erwartet 12 — die Karten fehlen vollstaendig'
            const result = judgeLink( {
                'id': 'K2',
                'compared': 3,
                'total': 3,
                'conditions': [ condition( { 'name': 'Karten zaehlen das Orakel', 'passed': false, detail } ) ]
            } )

            expect( result[ 'verdict' ] ).toBe( VERDICT[ 'fail' ] )
            expect( result[ 'errorText' ] ).toContain( detail )
            expect( result[ 'reason' ] ).toContain( detail )
        } )

        it( 'haengt einen uebergebenen Fehlertext an, statt ihn zu ersetzen', () => {
            const result = judgeLink( {
                'id': 'K5',
                'compared': 2,
                'total': 12,
                'conditions': [ condition( { 'name': 'b', 'passed': false, 'detail': 'zweiter Grund' } ) ],
                'errorText': 'erster Grund'
            } )

            expect( result[ 'errorText' ] ).toContain( 'erster Grund' )
            expect( result[ 'errorText' ] ).toContain( 'zweiter Grund' )
        } )

        it( 'behaelt den Grund auch im UNBEWERTBAR-Fall, statt nur ein Etikett zu setzen', () => {
            const result = judgeLink( {
                'id': 'K5',
                'compared': 0,
                'total': 12,
                'conditions': [],
                'errorText': 'kein echter Prozesswechsel durchfuehrbar: Port belegt'
            } )

            expect( result[ 'verdict' ] ).toBe( VERDICT[ 'inconclusive' ] )
            expect( result[ 'reason' ] ).toContain( 'Port belegt' )
        } )
    } )


    describe( 'T-G — die Einweg-Regel ist im Ergebnis-Objekt sichtbar', () => {

        it( 'K1 und K2 verbrauchen den Klon nicht', () => {
            expect( consumesCloneOf( { 'id': 'K1' } )[ 'consumesClone' ] ).toBe( false )
            expect( consumesCloneOf( { 'id': 'K2' } )[ 'consumesClone' ] ).toBe( false )
        } )

        it( 'K3, K4 und K5 verbrauchen ihn', () => {
            expect( consumesCloneOf( { 'id': 'K3' } )[ 'consumesClone' ] ).toBe( true )
            expect( consumesCloneOf( { 'id': 'K4' } )[ 'consumesClone' ] ).toBe( true )
            expect( consumesCloneOf( { 'id': 'K5' } )[ 'consumesClone' ] ).toBe( true )
        } )

        it( 'jedes Urteil traegt die Kennzeichnung mit sich, nicht nur die Tabelle', () => {
            const reading = judgeLink( { 'id': 'K2', 'compared': 3, 'total': 3, 'conditions': [ condition( { 'name': 'a', 'passed': true, 'detail': 'x' } ) ] } )
            const writing = judgeLink( { 'id': 'K4', 'compared': 2, 'total': 12, 'conditions': [ condition( { 'name': 'a', 'passed': true, 'detail': 'x' } ) ] } )

            expect( reading[ 'consumesClone' ] ).toBe( false )
            expect( writing[ 'consumesClone' ] ).toBe( true )
        } )

        it( 'eine unbekannte Kennung ist ein benannter Ausfall, kein stilles false', () => {
            const unknown = consumesCloneOf( { 'id': 'K9' } )

            expect( unknown[ 'status' ] ).toBe( false )
            expect( unknown[ 'consumesClone' ] ).toBeNull()
            expect( unknown[ 'reason' ] ).toContain( 'K9' )
        } )

        it( 'der Lauf erklaert seinen Klon nach einem schreibenden Glied ausdruecklich fuer verbraucht', () => {
            const reached = cloneConsumedNotice( { 'reached': true } )
            const untouched = cloneConsumedNotice( { 'reached': false } )

            expect( reached[ 'consumed' ] ).toBe( true )
            expect( reached[ 'text' ] ).toContain( 'consumed its clone' )
            expect( untouched[ 'consumed' ] ).toBe( false )
        } )

        it( 'die Kette hat genau fuenf Glieder, in der Reihenfolge, in der ein Mensch sie durchlaeuft', () => {
            expect( CHAIN_LINKS.map( ( link ) => link[ 'id' ] ) ).toEqual( [ 'K1', 'K2', 'K3', 'K4', 'K5' ] )
        } )
    } )


    describe( 'T-H — Hilfsteile und Repo-Grenze', () => {

        it( 'normalisiert Leerraum, damit ein Vergleich nicht an einem Zeilenumbruch scheitert', () => {
            expect( normalizeSpace( { 'text': ' A  —\n  weil   Alpha ' } )[ 'text' ] ).toBe( 'A — weil Alpha' )
            expect( normalizeSpace( { 'text': null } )[ 'text' ] ).toBe( '' )
        } )

        it( 'der Fingerabdruck eines lesenden Durchgangs traegt JEDE Bedingung, nicht nur ihre Anzahl', () => {
            const k1 = judgeLink( { 'id': 'K1', 'compared': 12, 'total': 12, 'conditions': [ condition( { 'name': 'a', 'passed': true, 'detail': 'x' } ) ] } )
            const k2 = judgeLink( { 'id': 'K2', 'compared': 3, 'total': 3, 'conditions': [ condition( { 'name': 'b', 'passed': false, 'detail': 'y' } ) ] } )
            const print = readOnlyFingerprint( { k1, k2 } )

            expect( print ).toHaveLength( 2 )
            expect( print[ 0 ][ 'conditions' ] ).toEqual( [ { 'name': 'a', 'passed': true } ] )
            expect( print[ 1 ][ 'verdict' ] ).toBe( VERDICT[ 'fail' ] )
        } )

        // The needle is assembled at runtime so this case does not count ITSELF — the same trick T-E
        // uses. A self-counting probe would report 1 forever and the obligation would look violated
        // exactly when it is met.
        it( 'ruft addDocument NULL mal — es gibt daher keine Registry, die offen bleiben koennte', () => {
            const needle = [ 'add', 'Document(' ].join( '' )
            const own = readSource( { 'file': new URL( import.meta.url ).pathname } )
            const fixture = readSource( { 'file': CHAIN_FIXTURE } )

            expect( own[ 'status' ] ).toBe( true )
            expect( own[ 'text' ].split( needle ).length - 1 ).toBe( 0 )
            expect( fixture[ 'text' ].split( needle ).length - 1 ).toBe( 0 )
        } )

        it( 'liest ausschliesslich Dateien INNERHALB dieses Repos, jede mit existsSync-Riegel', () => {
            expect( existsSync( CHAIN_FIXTURE ) ).toBe( true )
            expect( existsSync( DEEPLINK_FIXTURE ) ).toBe( true )
            expect( readSource( { 'file': join( HERE, 'gibt-es-nicht.mjs' ) } ) ).toEqual( { 'status': false, 'text': '' } )
        } )
    } )
} )
