import { describe, it, expect, beforeAll } from '@jest/globals'
import vm from 'node:vm'

import { extractFunctionSources, readEmittedScript } from '../helpers/extractFunction.mjs'


// M082-09-05 (Memo 082 Kap 20a, Cluster B — WI-119): kein bedingungsloses Ueberschreiben.
//
// Der Befund hat drei Teile, die einzeln ertraeglich waeren und zusammen Datenverlust auf Knopfdruck
// ergeben. M082-09-02 hat den ersten im Browser gemessen (Fall V1, Verdikt FAKT): beim Oeffnen des
// Popups ist #pp-content leer, der Fokus steht sofort darin, der Nutzer tippt — und das spaeter
// eintreffende Nachladen setzt `ppContent.value = body` ohne jede Bedingung. Der getippte Text war
// danach ersatzlos weg, ohne Nachfrage und ohne Hinweis.
//
// Der zweite Teil ist der stillere: dasselbe `body` konnte aus VIER Lagen stammen — Marker nicht
// gefunden, Abruf nicht ok, Ausnahme, echt leeres Transcript — und lautete in allen vieren ''. Solange
// "echt leer" von einem Fehlschlag nicht unterscheidbar ist, kann keine Pruefung der Welt das Richtige
// tun; deshalb steht die vierte Lage hier als eigener Fall und nicht als Nebensache.
//
// Der dritte Teil ist die Voll-Ersetzung beim PUT, die nur "nicht leer" verlangte. Sie ist die Stelle,
// an der aus einem leeren Feld ein geloeschtes Transcript wird.
//
// Jeder Fall nennt in seinem Titel seine Vergleichsmenge.
const PRD05_FUNCTIONS = [
    'transcriptPrefillOutcome', 'promptFieldChangedByUser', 'renderPrefillNotice',
    'applyTranscriptPrefill', 'adoptOfferedPrefill', 'bindPrefillOffer',
    'checkTranscriptShrink', 'focusPromptContent', 'openPromptModal'
]

// Der Transcript-Koerper, gegen den gemessen wird — einmal deklariert, nirgends nachgetippt.
const BODY = 'Einleitender Absatz des Nutzers, oberhalb jeder Antwort.'
const RAW_OK = [ '# Transcript', '', 'Schema-Version: 3', '', '## Transcript-Inhalt', '', BODY, '' ].join( '\n' )
const RAW_NO_MARKER = [ '# Transcript', '', 'Schema-Version: 3', '', 'Kein Abschnitt dieses Namens.', '' ].join( '\n' )
const RAW_EMPTY_BODY = [ '# Transcript', '', '## Transcript-Inhalt', '', '   ', '' ].join( '\n' )
const TYPED = 'GETIPPTER TEXT DES NUTZERS'

let clientScript = ''
let liftedSource = ''


// Eine Attrappe, die permissiver ist als der Browser, ist gruen-blind (M082-09-03, O-6). Deshalb
// protokolliert dieser Knoten JEDE Zuweisung an `value` und jeden Fokus in EINE gemeinsame Liste: die
// Reihenfolge ist in AB-8 der Pruefgegenstand und darf nicht aus einer Zeilennummer abgeleitet werden.
function makeNode( id, log ) {
    const node = { 'id': id, 'textContent': '', 'dataset': {}, 'classes': new Set(), 'handlers': {}, 'focusCount': 0 }
    let stored = ''

    Object.defineProperty( node, 'value', {
        'get': () => stored,
        'set': ( next ) => {
            stored = next
            if( log ) { log.push( `value:${ String( next ).length }` ) }
        },
        'enumerable': true,
        'configurable': true
    } )

    node.classList = {
        'add': ( c ) => node.classes.add( c ),
        'remove': ( c ) => node.classes.delete( c ),
        'contains': ( c ) => node.classes.has( c )
    }
    node.focus = () => {
        node.focusCount = node.focusCount + 1
        if( log ) { log.push( 'focus' ) }
    }
    node.addEventListener = ( ev, fn ) => { node.handlers[ ev ] = fn }

    return node
}


function buildSandbox( { promptEditState, fetchImpl, log } ) {
    const nodes = {
        'pp-content': makeNode( 'pp-content', log ),
        'pp-prefill-notice': makeNode( 'pp-prefill-notice' ),
        'pp-prefill-text': makeNode( 'pp-prefill-text' ),
        'pp-prefill-apply': makeNode( 'pp-prefill-apply' ),
        'pp-error': makeNode( 'pp-error' ),
        'pp-success': makeNode( 'pp-success' ),
        'pp-project': makeNode( 'pp-project' ),
        'pp-memo': makeNode( 'pp-memo' ),
        'pp-revision': makeNode( 'pp-revision' ),
        'transcript-modal': makeNode( 'transcript-modal' )
    }
    nodes[ 'transcript-modal' ].classes.add( 't-hidden' )
    nodes[ 'pp-prefill-notice' ].classes.add( 't-hidden' )
    nodes[ 'pp-prefill-apply' ].classes.add( 't-hidden' )

    const sandbox = {
        'promptEditState': promptEditState,
        'transcriptMode': { 'active': false, 'tab': '' },
        'currentFileName': 'REV-01.md',
        'lookupMemoEntry': () => null,
        'nextRevisionNumbers': () => ( { 'nextId': 'REV-01' } ),
        'revisionIdFromFileName': () => 'REV-01',
        'latestTranscriptForRevision': () => ( promptEditState[ 'transcriptId' ]
            ? { 'transcriptId': promptEditState[ 'transcriptId' ], 'revisionId': 'REV-01' }
            : null ),
        'updatePromptQualityLabel': () => {},
        'updatePromptTranscriptCount': () => {},
        'renderPromptQuestions': () => {},
        'document': {
            'getElementById': ( id ) => ( id in nodes ? nodes[ id ] : null ),
            'querySelector': () => null,
            'querySelectorAll': () => []
        },
        'fetch': fetchImpl,
        console
    }

    vm.createContext( sandbox )
    vm.runInContext(
        `${ liftedSource }\n`
        + 'globalThis.__outcome = transcriptPrefillOutcome;\n'
        + 'globalThis.__applyPrefill = applyTranscriptPrefill;\n'
        + 'globalThis.__adopt = adoptOfferedPrefill;\n'
        + 'globalThis.__changed = promptFieldChangedByUser;\n'
        + 'globalThis.__shrink = checkTranscriptShrink;\n'
        + 'globalThis.__open = openPromptModal;\n'
        + 'globalThis.__bindOffer = bindPrefillOffer;',
        sandbox
    )

    return { sandbox, nodes }
}


// Kein Taktgeber: der Ablauf wird an die Warteschlange zurueckgegeben, bis die then-Kette durch ist.
// Das wartet auf die BEDINGUNG (die Kette ist abgearbeitet), nie auf eine Dauer.
const yieldTick = () => new Promise( ( done ) => setImmediate( done ) )


const freshState = ( transcriptId ) => ( {
    'memoName': null, 'projectId': null, 'memoId': null, 'revisionId': null,
    'transcriptId': transcriptId, 'questions': [],
    'pristineValue': null, 'baselineLength': null, 'prefillStatus': null, 'offeredBody': null
} )


beforeAll( async () => {
    clientScript = await readEmittedScript()
    const lifted = await extractFunctionSources( PRD05_FUNCTIONS )
    liftedSource = lifted[ 'source' ]

    expect( lifted[ 'names' ].length ).toBe( 9 )
} )


describe( 'M082-09-05 AB-1 — vier Lagen, vier unterscheidbare Rueckgaben', () => {
    const lanes = () => {
        const { sandbox } = buildSandbox( { 'promptEditState': freshState( 'T-1' ), 'fetchImpl': () => Promise.resolve(), 'log': null } )

        return {
            'markerMissing': sandbox.__outcome( { 'ok': true, 'status': 200, 'raw': RAW_NO_MARKER } ),
            'fetchFailed': sandbox.__outcome( { 'ok': false, 'status': 503 } ),
            'exception': sandbox.__outcome( { 'error': new TypeError( 'Failed to fetch' ) } ),
            'emptyTranscript': sandbox.__outcome( { 'ok': true, 'status': 200, 'raw': RAW_EMPTY_BODY } ),
            'loaded': sandbox.__outcome( { 'ok': true, 'status': 200, 'raw': RAW_OK } )
        }
    }

    it( 'Lage 1 "marker-missing": der Marker fehlt, und das heisst NICHT leer (1 Antwort ohne Marker)', () => {
        const out = lanes()[ 'markerMissing' ]

        expect( out[ 'status' ] ).toBe( 'marker-missing' )
        expect( out[ 'body' ] ).toBe( null )
        expect( out[ 'baselineLength' ] ).toBe( null )
        expect( out[ 'message' ] ).toContain( 'Markierung nicht gefunden' )
    } )

    it( 'Lage 2 "fetch-failed": der Abruf ist nicht ok, und die Meldung nennt den Status (1 Antwort, Status 503)', () => {
        const out = lanes()[ 'fetchFailed' ]

        expect( out[ 'status' ] ).toBe( 'fetch-failed' )
        expect( out[ 'body' ] ).toBe( null )
        expect( out[ 'message' ] ).toContain( '503' )
    } )

    it( 'Lage 3 "exception": die Ausnahme wird benannt statt verschluckt (1 geworfener Fehler)', () => {
        const out = lanes()[ 'exception' ]

        expect( out[ 'status' ] ).toBe( 'exception' )
        expect( out[ 'body' ] ).toBe( null )
        expect( out[ 'message' ] ).toContain( 'TypeError' )
    } )

    it( 'Lage 4 "empty-transcript": echt leer ist eine GUELTIGE Lage mit eigener Meldung (1 leerer Koerper)', () => {
        const out = lanes()[ 'emptyTranscript' ]

        // Der Kern des Auftrags: hier — und NUR hier — ist der leere Zeichenkettenwert ein Ergebnis.
        expect( out[ 'status' ] ).toBe( 'empty-transcript' )
        expect( out[ 'body' ] ).toBe( '' )
        expect( out[ 'baselineLength' ] ).toBe( 0 )
        expect( out[ 'message' ] ).toBe( 'Transcript ist leer.' )
    } )

    it( 'die VIER Rueckgaben sind paarweise verschieden (4 Lagen, 6 Paare)', () => {
        const all = lanes()
        const four = [ all[ 'markerMissing' ], all[ 'fetchFailed' ], all[ 'exception' ], all[ 'emptyTranscript' ] ]
        const pairs = four
            .flatMap( ( left, i ) => four.slice( i + 1 ).map( ( right ) => [ left, right ] ) )

        expect( four.length ).toBe( 4 )
        expect( pairs.length ).toBe( 6 )

        const differing = pairs
            .filter( ( [ left, right ] ) => JSON.stringify( left ) !== JSON.stringify( right ) )

        expect( differing.length ).toBe( 6 )
        expect( new Set( four.map( ( o ) => o[ 'status' ] ) ).size ).toBe( 4 )
        expect( new Set( four.map( ( o ) => o[ 'message' ] ) ).size ).toBe( 4 )
    } )

    it( 'keine zwei Lagen enden im selben leeren Zustand (3 Fehler gegen 1 echt leeres Transcript)', () => {
        const all = lanes()
        const errors = [ all[ 'markerMissing' ], all[ 'fetchFailed' ], all[ 'exception' ] ]

        // "nicht entscheidbar" (null) gegen "entschieden leer" (''). Genau diese Gleichsetzung war
        // der Befund; sie darf an keiner der drei Fehlerlagen wieder entstehen.
        expect( errors.filter( ( o ) => o[ 'body' ] === null ).length ).toBe( 3 )
        expect( errors.filter( ( o ) => o[ 'body' ] === '' ).length ).toBe( 0 )
        expect( all[ 'emptyTranscript' ][ 'body' ] ).toBe( '' )
    } )

    it( 'der gruene Weg bleibt der gruene Weg: geladener Koerper, keine Meldung (1 vollstaendige Antwort)', () => {
        const out = lanes()[ 'loaded' ]

        expect( out[ 'status' ] ).toBe( 'loaded' )
        expect( out[ 'body' ] ).toBe( BODY )
        expect( out[ 'baselineLength' ] ).toBe( BODY.length )
        expect( out[ 'message' ] ).toBe( '' )
    } )
} )


describe( 'M082-09-05 AB-2 / AB-3 — das Rennen, in beiden Richtungen', () => {
    it( 'AB-2: ein VERAENDERTES Feld wird nicht ueberschrieben, der Text wird angeboten (1 Inhalt vorher, 1 nachher)', () => {
        const state = freshState( 'T-1' )
        const { sandbox, nodes } = buildSandbox( { 'promptEditState': state, 'fetchImpl': () => Promise.resolve(), 'log': null } )

        // Der Ausgangspunkt ist der gemessene: openPromptModal leert das Feld und merkt sich diesen
        // Stand; danach tippt der Nutzer.
        state[ 'pristineValue' ] = ''
        nodes[ 'pp-content' ].value = TYPED
        const before = nodes[ 'pp-content' ].value

        const outcome = sandbox.__outcome( { 'ok': true, 'status': 200, 'raw': RAW_OK } )
        const result = sandbox.__applyPrefill( { 'outcome': outcome } )
        const after = nodes[ 'pp-content' ].value

        expect( before ).toBe( TYPED )
        expect( after ).toBe( TYPED )
        expect( result[ 'applied' ] ).toBe( false )
        expect( result[ 'reason' ] ).toBe( 'field-changed' )
        // Angeboten, nicht angewendet — und nicht verschmolzen (S4).
        expect( state[ 'offeredBody' ] ).toBe( BODY )
        expect( after.indexOf( BODY ) ).toBe( -1 )
        expect( nodes[ 'pp-prefill-apply' ].classes.has( 't-hidden' ) ).toBe( false )
        expect( nodes[ 'pp-prefill-text' ].textContent ).toContain( 'NICHT übernommen' )
        expect( nodes[ 'pp-prefill-text' ].textContent ).toContain( String( TYPED.length ) )
        expect( nodes[ 'pp-prefill-text' ].textContent ).toContain( String( BODY.length ) )
    } )

    it( 'AB-3 Gegenrichtung: ein UNVERAENDERTES Feld wird gefuellt (1 unveraendertes Feld, 1 Nachladen)', () => {
        const state = freshState( 'T-1' )
        const { sandbox, nodes } = buildSandbox( { 'promptEditState': state, 'fetchImpl': () => Promise.resolve(), 'log': null } )

        state[ 'pristineValue' ] = ''
        const before = nodes[ 'pp-content' ].value

        const outcome = sandbox.__outcome( { 'ok': true, 'status': 200, 'raw': RAW_OK } )
        const result = sandbox.__applyPrefill( { 'outcome': outcome } )

        expect( before ).toBe( '' )
        expect( result[ 'applied' ] ).toBe( true )
        expect( result[ 'reason' ] ).toBe( 'loaded' )
        expect( nodes[ 'pp-content' ].value ).toBe( BODY )
        expect( state[ 'baselineLength' ] ).toBe( BODY.length )
        // Ohne diese Richtung waere eine Fassung, die NIE fuellt, von der richtigen nicht zu
        // unterscheiden — und das Werkzeug waere schlicht kaputt statt sicher.
        expect( nodes[ 'pp-prefill-notice' ].classes.has( 't-hidden' ) ).toBe( true )
    } )

    it( 'das Angebot wird auf Nutzer-Handlung uebernommen, nicht verschmolzen (1 Angebot, 1 Klick)', () => {
        const state = freshState( 'T-1' )
        const { sandbox, nodes } = buildSandbox( { 'promptEditState': state, 'fetchImpl': () => Promise.resolve(), 'log': null } )

        state[ 'pristineValue' ] = ''
        nodes[ 'pp-content' ].value = TYPED
        sandbox.__applyPrefill( { 'outcome': sandbox.__outcome( { 'ok': true, 'status': 200, 'raw': RAW_OK } ) } )

        sandbox.__bindOffer()
        nodes[ 'pp-prefill-apply' ].handlers[ 'click' ]()

        // Uebernehmen heisst ERSETZEN, nicht zusammenfuehren: der getippte Text ist nicht mehr da,
        // weil der Nutzer selbst entschieden hat — das ist der Unterschied zum Befund.
        expect( nodes[ 'pp-content' ].value ).toBe( BODY )
        expect( state[ 'offeredBody' ] ).toBe( null )
        expect( state[ 'pristineValue' ] ).toBe( BODY )
        expect( state[ 'baselineLength' ] ).toBe( BODY.length )
        expect( nodes[ 'pp-prefill-notice' ].classes.has( 't-hidden' ) ).toBe( true )
    } )

    it( 'eine nicht entscheidbare Lage laesst das Feld stehen und wird BENANNT (1 Ausnahme, 1 Feldinhalt)', () => {
        const state = freshState( 'T-1' )
        const { sandbox, nodes } = buildSandbox( { 'promptEditState': state, 'fetchImpl': () => Promise.resolve(), 'log': null } )

        state[ 'pristineValue' ] = ''
        nodes[ 'pp-content' ].value = TYPED

        const result = sandbox.__applyPrefill( { 'outcome': sandbox.__outcome( { 'ok': false, 'status': 503 } ) } )

        expect( result[ 'applied' ] ).toBe( false )
        expect( result[ 'reason' ] ).toBe( 'fetch-failed' )
        expect( nodes[ 'pp-content' ].value ).toBe( TYPED )
        expect( state[ 'baselineLength' ] ).toBe( null )
        expect( state[ 'offeredBody' ] ).toBe( null )
        expect( nodes[ 'pp-prefill-notice' ].classes.has( 't-hidden' ) ).toBe( false )
        expect( nodes[ 'pp-prefill-apply' ].classes.has( 't-hidden' ) ).toBe( true )
    } )
} )


describe( 'M082-09-05 AB-8 — der Fokus kommt nach dem Inhalt', () => {
    it( 'mit Nachladen: kein Fokus, solange der Inhalt unterwegs ist (1 Oeffnungsvorgang, beobachtete Reihenfolge)', async () => {
        const log = []
        const state = freshState( 'T-1' )
        let release = null
        const pending = new Promise( ( done ) => { release = done } )
        const fetchImpl = () => pending.then( () => ( {
            'ok': true,
            'status': 200,
            'text': () => Promise.resolve( RAW_OK )
        } ) )
        const { sandbox, nodes } = buildSandbox( { 'promptEditState': state, fetchImpl, log } )

        sandbox.__open( { 'memoEntry': { 'projectId': 'p9', 'doc': { 'memoName': '900-fixture', 'revisions': [] } }, 'memoName': '900-fixture' } )

        // Der synchrone Teil ist durch: das Feld ist geleert, das Fenster steht offen — und der Fokus
        // ist NICHT gesetzt, weil der Inhalt noch unterwegs ist.
        const logAfterOpen = log.slice()
        expect( logAfterOpen ).toContain( 'value:0' )
        expect( logAfterOpen ).not.toContain( 'focus' )
        expect( nodes[ 'pp-content' ].focusCount ).toBe( 0 )
        expect( nodes[ 'transcript-modal' ].classes.has( 't-hidden' ) ).toBe( false )

        release()
        await yieldTick()
        await yieldTick()

        expect( nodes[ 'pp-content' ].value ).toBe( BODY )
        expect( nodes[ 'pp-content' ].focusCount ).toBe( 1 )
        // Die Reihenfolge selbst, nicht eine Zeilennummer (G1): die letzte Zuweisung an das Feld
        // steht VOR dem Fokus.
        expect( log.indexOf( 'focus' ) ).toBeGreaterThan( log.lastIndexOf( `value:${ BODY.length }` ) )
    } )

    it( 'ohne Nachladen steht der Inhalt sofort fest und der Fokus faellt sofort (1 Oeffnungsvorgang ohne Transcript)', () => {
        const log = []
        const state = freshState( null )
        const { sandbox, nodes } = buildSandbox( { 'promptEditState': state, 'fetchImpl': () => Promise.reject( new Error( 'darf nicht gerufen werden' ) ), log } )

        sandbox.__open( { 'memoEntry': { 'projectId': 'p9', 'doc': { 'memoName': '900-fixture', 'revisions': [] } }, 'memoName': '900-fixture' } )

        expect( nodes[ 'pp-content' ].focusCount ).toBe( 1 )
        expect( log.indexOf( 'focus' ) ).toBeGreaterThan( log.indexOf( 'value:0' ) )
    } )
} )


describe( 'M082-09-05 AB-5 / AB-6 / AB-7 — die Schrumpf-Pruefung beim PUT', () => {
    const check = ( args ) => {
        const { sandbox } = buildSandbox( { 'promptEditState': freshState( 'T-1' ), 'fetchImpl': () => Promise.resolve(), 'log': null } )

        return sandbox.__shrink( args )
    }

    it( 'AB-5: eine UNERKLAERTE Kuerzung wird abgelehnt und nennt beide Laengen (Ausgangslaenge 120 > 0)', () => {
        const out = check( { 'isUpdate': true, 'baselineLength': 120, 'nextLength': 41, 'explained': [] } )

        expect( out[ 'verdict' ] ).toBe( 'reject-unexplained-shrink' )
        expect( out[ 'allowed' ] ).toBe( false )
        expect( out[ 'baselineLength' ] ).toBe( 120 )
        expect( out[ 'nextLength' ] ).toBe( 41 )
        expect( out[ 'delta' ] ).toBe( -79 )
        expect( out[ 'message' ] ).toContain( '120' )
        expect( out[ 'message' ] ).toContain( '41' )
        expect( out[ 'message' ] ).toContain( '-79' )
    } )

    it( 'AB-6 Gegenrichtung: eine ERKLAERTE Kuerzung geht durch und wird protokolliert (1 erklaerte Kuerzung)', () => {
        const out = check( { 'isUpdate': true, 'baselineLength': 120, 'nextLength': 41, 'explained': [ 'user-edit' ] } )

        expect( out[ 'verdict' ] ).toBe( 'pass-explained' )
        expect( out[ 'allowed' ] ).toBe( true )
        expect( out[ 'message' ] ).toContain( 'user-edit' )
        expect( out[ 'message' ] ).toContain( '120' )
        expect( out[ 'message' ] ).toContain( '41' )
    } )

    it( 'AB-6: eine Pruefung, die JEDE Kuerzung ablehnt, waere von der richtigen nicht zu unterscheiden (3 Gruende einzeln)', () => {
        const reasons = [ 'answer-replaced', 'duplicate-removed', 'user-edit' ]
        const passing = reasons
            .map( ( reason ) => check( { 'isUpdate': true, 'baselineLength': 200, 'nextLength': 100, 'explained': [ reason ] } ) )
            .filter( ( out ) => out[ 'allowed' ] === true && out[ 'verdict' ] === 'pass-explained' )

        expect( reasons.length ).toBe( 3 )
        expect( passing.length ).toBe( 3 )
    } )

    it( 'AB-7: gleich lang und laenger gehen OHNE zusaetzliche Meldung durch (2 Faelle)', () => {
        const same = check( { 'isUpdate': true, 'baselineLength': 120, 'nextLength': 120, 'explained': [] } )
        const longer = check( { 'isUpdate': true, 'baselineLength': 120, 'nextLength': 300, 'explained': [] } )

        expect( same[ 'verdict' ] ).toBe( 'pass-not-shorter' )
        expect( same[ 'allowed' ] ).toBe( true )
        expect( same[ 'message' ] ).toBe( '' )
        expect( longer[ 'verdict' ] ).toBe( 'pass-not-shorter' )
        expect( longer[ 'allowed' ] ).toBe( true )
        expect( longer[ 'message' ] ).toBe( '' )
    } )

    it( 'Vakuum-Probe: ueber einer Ausgangslaenge 0 meldet die Pruefung die LEERE Vergleichsmenge, kein Bestehen (1 leerer Ausgangstext)', () => {
        const out = check( { 'isUpdate': true, 'baselineLength': 0, 'nextLength': 300, 'explained': [] } )

        // Gegen einen leeren Ausgangstext ist jede Schrumpf-Aussage trivial. Ein "pass" waere hier ein
        // Gruen ueber einer Nullmenge — die Pruefung sagt stattdessen, dass sie nichts verglichen hat.
        expect( out[ 'verdict' ] ).toBe( 'no-baseline' )
        expect( out[ 'verdict' ] ).not.toBe( 'pass-not-shorter' )
        expect( out[ 'message' ] ).toContain( 'keine Vergleichsmenge' )
        expect( out[ 'message' ] ).toContain( '0 Zeichen' )
    } )

    it( 'eine UNBEKANNTE Ausgangslaenge ist nicht 0 und wird nicht als 0 gelesen (1 gescheitertes Nachladen)', () => {
        const unknown = check( { 'isUpdate': true, 'baselineLength': null, 'nextLength': 300, 'explained': [] } )
        const zero = check( { 'isUpdate': true, 'baselineLength': 0, 'nextLength': 300, 'explained': [] } )

        expect( unknown[ 'verdict' ] ).toBe( 'unknown-baseline' )
        expect( unknown[ 'allowed' ] ).toBe( false )
        expect( unknown[ 'verdict' ] ).not.toBe( zero[ 'verdict' ] )
        expect( unknown[ 'message' ] ).toContain( 'nicht entscheidbar' )
    } )

    it( 'ohne bestehendes Transcript greift die Pruefung nicht — ein POST ersetzt nichts (1 Neuanlage)', () => {
        const out = check( { 'isUpdate': false, 'baselineLength': null, 'nextLength': 41, 'explained': [] } )

        expect( out[ 'verdict' ] ).toBe( 'not-applicable' )
        expect( out[ 'allowed' ] ).toBe( true )
        expect( out[ 'message' ] ).toBe( '' )
    } )
} )


describe( 'M082-09-05 — die Veraenderungs-Erkennung steht an EINER Stelle', () => {
    it( 'sie vergleicht gegen den zuletzt vom Kode geschriebenen Wert (3 Feldzustaende)', () => {
        const state = freshState( 'T-1' )
        const { sandbox, nodes } = buildSandbox( { 'promptEditState': state, 'fetchImpl': () => Promise.resolve(), 'log': null } )

        state[ 'pristineValue' ] = ''
        const untouched = sandbox.__changed()

        nodes[ 'pp-content' ].value = TYPED
        const typed = sandbox.__changed()

        state[ 'pristineValue' ] = TYPED
        const adopted = sandbox.__changed()

        expect( untouched ).toBe( false )
        expect( typed ).toBe( true )
        expect( adopted ).toBe( false )
    } )

    it( 'ohne Bezugspunkt ist die Frage nicht entscheidbar und faellt auf die STRENGERE Seite (1 Feld ohne Bezugspunkt)', () => {
        const state = freshState( 'T-1' )
        const { sandbox, nodes } = buildSandbox( { 'promptEditState': state, 'fetchImpl': () => Promise.resolve(), 'log': null } )

        nodes[ 'pp-content' ].value = TYPED

        // `false` heisst hier "nicht als Nutzer-Eingabe belegt", nicht "unveraendert": in der
        // Schrumpf-Pruefung wird daraus "nicht erklaert", also eine Ablehnung — nie ein Durchlassen.
        expect( state[ 'pristineValue' ] ).toBe( null )
        expect( sandbox.__changed() ).toBe( false )
    } )
} )


describe( 'M082-09-05 — der gemeinsame leere Rueckgabewert ist aus dem Quelltext verschwunden', () => {
    it( 'der Nachlade-Zweig entscheidet nicht mehr selbst, sondern reicht an die benannten Stellen weiter (2 Zweige)', () => {
        // Die frueheren Schreibweisen werden hier zitiert, um ihr VERSCHWINDEN zu messen — im
        // Produktivkode sind sie deshalb bewusst nicht mehr als Kommentartext vorhanden
        // (M082-09-03, O-5: Prosa ueber ein gezaehltes Muster ist selbst ein Treffer).
        expect( clientScript ).not.toContain( "resp.ok ? resp.text() : ''" )
        expect( clientScript ).not.toContain( "idx === -1 ? '' : raw.slice(" )

        // then-Zweig und catch-Zweig gehen beide durch dieselbe Einordnung.
        const calls = clientScript.split( 'applyTranscriptPrefill( { outcome: transcriptPrefillOutcome(' ).length - 1
        expect( calls ).toBe( 2 )
    } )
} )
