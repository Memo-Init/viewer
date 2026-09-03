import { describe, it, expect, beforeAll } from '@jest/globals'
import vm from 'node:vm'

import { extractFunctionSources, readEmittedScript, readMemoViewStyles } from '../helpers/extractFunction.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'


// PRD-Q3 (Memo 080, Kap 25 — A11/A12/A13): das nicht-blockierende Hinweis-Band im memo-view.
//
// Ausgangslage (nachgemessen vor der Aenderung): der Server haengt `validation` an JEDE
// content-Nachricht (vier Sendestellen), der Client hat das Feld an KEINER Stelle gelesen — der
// Kanal lieferte, der Empfaenger fehlte. Dieses File prueft den neuen Empfaenger.
//
// Die tragende Auflage: die drei Zustaende duerfen nie gleich aussehen —
//   info: [ ... ]        -> sichtbares Band mit der ANZAHL der Hinweise
//   info: []             -> unsichtbares Band (Muster vorwort-empty), NICHT "alles gut"
//   validation === null  -> ausgewiesene Luecke, NICHT ein leeres Band
//
// Dieses Projekt hat kein jsdom (siehe A11yAndLabelsPRD013): die Client-Funktion wird mit dem
// gemeinsamen Helfer aus dem ausgelieferten Skript gehoben und in einer vm-Sandbox mit einem
// document-Stub ausgefuehrt — derselbe Weg wie PromptEditApply/TranscriptSplitAndDedupe.

const makeSection = () => {
    const node = { innerHTML: '', classes: new Set(), attrs: {} }
    node.classList = {
        add: ( token ) => node.classes.add( token ),
        remove: ( token ) => node.classes.delete( token ),
        contains: ( token ) => node.classes.has( token )
    }
    node.setAttribute = ( key, value ) => { node.attrs[ key ] = value }

    return node
}


// Ein Knoten, dessen innerHTML-Setter wirft — die provozierte Stoerung fuer A13.
const makeExplodingSection = () => {
    const node = makeSection()
    Object.defineProperty( node, 'innerHTML', {
        get: () => '',
        set: () => { throw new Error( 'DOM exploded' ) }
    } )

    return node
}


let clientScript = ''
let styles = ''
let liftedSource = ''


beforeAll( async () => {
    clientScript = await readEmittedScript()
    styles = await readMemoViewStyles()
    const lifted = await extractFunctionSources( [ 'renderFormHints', 'escHtml' ] )
    liftedSource = lifted[ 'source' ]
} )


const runRender = ( { validation, section } ) => {
    const host = section === undefined ? makeSection() : section
    const sandbox = {
        document: { getElementById: ( id ) => ( id === 'form-hints' ? host : null ) },
        console
    }
    const marker = { ran: false }
    sandbox.afterRender = () => { marker.ran = true }

    vm.createContext( sandbox )
    vm.runInContext( `${ liftedSource }\nrenderFormHints( __validation );\nafterRender();`, Object.assign( sandbox, { __validation: validation } ) )

    return { host, marker }
}


describe( 'PRD-Q3/A11 — das Band rendert validation.info und bleibt bei [] unsichtbar', () => {

    it( 'zwei INFO-Hinweise erscheinen einzeln und mit ihrer Anzahl (2 verglichen)', () => {
        const info = [ 'INFO-010 header.Schema-Version: Schema-Version marker missing', 'INFO-020 form.K3: Beleg-Bindungsgrad 60 %' ]
        const { host } = runRender( { validation: { status: true, messages: [], info } } )

        expect( host.classes.has( 'form-hints-empty' ) ).toBe( false )
        expect( host.innerHTML ).toContain( 'form-hints-band' )
        expect( host.innerHTML ).toContain( 'Form-Hinweise: 2' )
        expect( host.innerHTML ).toContain( 'INFO-010' )
        expect( host.innerHTML ).toContain( 'INFO-020' )
        expect( ( host.innerHTML.match( /form-hints-item/g ) || [] ).length ).toBe( 2 )
    } )


    it( 'info: [] rendert ein UNSICHTBARES Band (Klasse form-hints-empty) — nicht "alles gut"', () => {
        const { host } = runRender( { validation: { status: true, messages: [], info: [] } } )

        expect( host.innerHTML ).toBe( '' )
        expect( host.classes.has( 'form-hints-empty' ) ).toBe( true )
        expect( host.innerHTML ).not.toContain( 'ok' )
        expect( host.innerHTML ).not.toContain( 'bestanden' )
    } )


    it( 'die Klasse form-hints-empty blendet nur ein LEERES Band aus, und die Luecken-Klasse sieht anders aus als ein Hinweis-Band (3 Regeln verglichen)', () => {
        expect( styles ).toContain( '.form-hints-section.form-hints-empty:empty' )
        expect( styles ).toContain( '.form-hints-band' )
        expect( styles ).toContain( '.form-hints-band.form-hints-luecke' )

        const gapRule = styles.split( '.form-hints-band.form-hints-luecke' )[ 1 ].split( '}' )[ 0 ]
        expect( gapRule ).toContain( 'dashed' )
        expect( gapRule ).toContain( 'background: transparent' )
    } )


    it( 'der Inhalt wird escaped — ein Hinweis kann kein Markup in die Seite tragen', () => {
        const { host } = runRender( { validation: { info: [ '<img src=x onerror=1>' ] } } )

        expect( host.innerHTML ).toContain( '&lt;img' )
        expect( host.innerHTML ).not.toContain( '<img' )
    } )
} )


describe( 'PRD-Q3/A12 — validation === null wird als Luecke ausgewiesen', () => {

    it( 'null rendert die benannte Luecke, nicht ein leeres Band', () => {
        const { host } = runRender( { validation: null } )

        expect( host.classes.has( 'form-hints-empty' ) ).toBe( false )
        expect( host.innerHTML ).toContain( 'form-hints-luecke' )
        expect( host.innerHTML ).toContain( 'Pruefung nicht verfuegbar' )
        expect( host.innerHTML ).toContain( 'keine Freigabe' )
        expect( host.innerHTML ).not.toBe( '' )
    } )


    it( '(Klasse) auch ein KAPUTTES validation-Feld (String/Zahl) faellt auf die Luecke, nicht auf ein leeres Band — 3 Formen verglichen', () => {
        const probes = [ 'kaputt', 42, true ]
        const results = probes.map( ( validation ) => runRender( { validation } ).host )

        results.forEach( ( host ) => {
            expect( host.innerHTML ).toContain( 'form-hints-luecke' )
            expect( host.classes.has( 'form-hints-empty' ) ).toBe( false )
        } )
        expect( results.length ).toBe( 3 )
    } )


    it( '(Klasse) VOR der ersten Nachricht (undefined) bleibt das Band leer — "noch nichts" ist keine Luecke', () => {
        const { host } = runRender( { validation: undefined } )

        expect( host.innerHTML ).toBe( '' )
        expect( host.classes.has( 'form-hints-empty' ) ).toBe( true )
    } )
} )


describe( 'PRD-Q3/A13 — ein Fehler im Hinweis-Rendering unterbricht den Dokument-Render nicht', () => {

    it( 'ein werfender innerHTML-Setter wird still abgefangen; der Aufrufer laeuft weiter', () => {
        const exploding = makeExplodingSection()
        const { marker } = runRender( { validation: { info: [ 'INFO-010 irgendwas' ] }, section: exploding } )

        expect( marker.ran ).toBe( true )
    } )


    it( '(Klasse) auch ohne Platzhalter-Section im DOM wirft nichts', () => {
        const sandbox = { document: { getElementById: () => null }, console, __validation: { info: [ 'INFO-010' ] } }
        const marker = { ran: false }
        sandbox.afterRender = () => { marker.ran = true }

        vm.createContext( sandbox )
        vm.runInContext( `${ liftedSource }\nrenderFormHints( __validation );\nafterRender();`, sandbox )

        expect( marker.ran ).toBe( true )
    } )


    it( 'die Funktion traegt einen try/catch — der stille Abbau steht im Quelltext, nicht nur im Testfall', () => {
        const body = clientScript.split( 'function renderFormHints(' )[ 1 ].split( '\n        function ' )[ 0 ]

        expect( body ).toContain( 'try {' )
        expect( body ).toContain( '} catch(' )
    } )
} )


describe( 'PRD-Q3 — die Verdrahtung: der Empfaenger wird auf allen Render-Pfaden aufgerufen', () => {

    it( 'der content-Handler uebernimmt data.validation OHNE stillen Fallback (1 Zuweisung)', () => {
        const assignments = clientScript.match( /lastValidation = data\.validation === undefined \? null : data\.validation/g ) || []

        expect( assignments.length ).toBe( 1 )
        expect( clientScript ).not.toContain( 'data.validation || {}' )
    } )


    it( 'renderFormHints haengt an DENSELBEN drei Pfaden wie renderVorwort (Broadcast, Prosa-Restore, Diff-Toggle)', () => {
        const hintCalls = clientScript.match( /renderFormHints\( lastValidation \)/g ) || []
        const vorwortCalls = clientScript.match( /renderVorwort\( lastVorwort \)/g ) || []

        expect( hintCalls.length ).toBe( 3 )
        expect( vorwortCalls.length ).toBe( 3 )
        expect( hintCalls.length ).toBe( vorwortCalls.length )
    } )


    it( 'die Platzhalter-Section entsteht VOR dem Offene-Fragen-Guard — ein Memo ohne offene Fragen zeigt seine Hinweise trotzdem', () => {
        const body = clientScript.split( 'function applyContentStructure()' )[ 1 ]
        const placeholderAt = body.indexOf( 'ensureFormHintsSection()' )
        const guardAt = body.indexOf( 'if( !fragenHeading ) { return }' )

        expect( placeholderAt ).toBeGreaterThan( -1 )
        expect( guardAt ).toBeGreaterThan( -1 )
        expect( placeholderAt ).toBeLessThan( guardAt )
        expect( clientScript ).toContain( "formHints.id = 'form-hints'" )
    } )
} )


describe( 'PRD-Q3/A16 — die Anzeige aendert den Validator nicht', () => {

    it( 'INFO landet in info und NIE in messages — der Status bleibt unberuehrt (2 Dokumente verglichen)', () => {
        const withHint = [
            '# Memo 999 — Probe',
            '',
            '| Feld | Wert |',
            '|------|------|',
            '| Memo | 999 |',
            '| Memo-Name | Probe |',
            '| Revision | REV-01 |',
            '| Datum | 2026-09-03 |',
            '| Status | Draft |',
            '',
            '## Offene Fragen',
            '',
            '## Beantwortete Fragen',
            '',
            '## Phasen',
            ''
        ].join( '\n' )

        const result = MemoValidator.validate( { doc: withHint } )
        const infoInMessages = ( result[ 'messages' ] || [] ).filter( ( entry ) => entry.includes( 'INFO-' ) === true )

        expect( infoInMessages ).toEqual( [] )
        expect( Array.isArray( result[ 'info' ] ) ).toBe( true )
        expect( result[ 'status' ] ).toBe( result[ 'messages' ].length === 0 )
    } )
} )
