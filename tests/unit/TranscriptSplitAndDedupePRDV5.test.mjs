import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

import { extractFunctionSources, readEmittedScript } from '../helpers/extractFunction.mjs'
import { TranscriptHeader, CONTENT_MARKER } from '../../src/TranscriptHeader.mjs'


// PRD-V5 (Memo 080, Kap 16 — WI-133 + WI-135, US-6/US-8): Trenn-Marker und Antwort-Dedupe.
//
// WI-133: the client split at the BARE '## Transcript-Inhalt'. The first hit is the marker's MENTION
// inside the Daten/Instruktions-Grenz sentence, so the header rest landed in the edit field and was
// wrapped into a SECOND header on save — the damage in 5 measured files.
// WI-135: "Uebernehmen" rebuilt the answer blocks and appended them to a content that already carried
// them. In the 2026-08-23 incident 18 blocks became 36.
//
// The client functions are lifted with the shared helper tests/helpers/extractFunction.mjs and run in
// a vm sandbox with light document/fetch stubs (the same approach as PromptEditApply.test.mjs).
// Every case states HOW MUCH it compared (bytes, blocks, files, hits).
const here = dirname( fileURLToPath( import.meta.url ) )
const fixturePath = resolve( here, '..', 'fixtures', 'transcript-damaged-double-header.md' )

const sha = ( text ) => createHash( 'sha256' ).update( text ).digest( 'hex' )

let clientScript = ''
let damagedFixture = ''


beforeAll( async () => {
    clientScript = await readEmittedScript()
    damagedFixture = await readFile( fixturePath, 'utf8' )
} )


describe( 'PRD-V5 WI-133 — der Trenn-Marker trifft die richtige Stelle', () => {

    it( 'im Client existiert KEINE Marker-Form ohne Leerzeilen mehr (heute 2, jetzt 0)', () => {
        const bare = clientScript.match( /var marker = '## Transcript-Inhalt'/g ) || []
        const serverForm = clientScript.match( /var marker = '## Transcript-Inhalt\\n\\n'/g ) || []

        expect( bare.length ).toBe( 0 )
        expect( serverForm.length ).toBe( 2 )
    } )


    it( 'die Client-Form ist BYTE-GLEICH zur exportierten Server-Konstante', () => {
        // Der Client ist ein klassisches Skript und kann nicht importieren — deshalb ist die Gleichheit
        // hier maschinell festgenagelt statt nur behauptet.
        const clientLiteral = '## Transcript-Inhalt\n\n'

        expect( clientLiteral ).toBe( CONTENT_MARKER )
        expect( Buffer.byteLength( clientLiteral ) ).toBe( Buffer.byteLength( CONTENT_MARKER ) )
    } )


    it( 'gegen ein GESUNDES Transcript: alter Schnitt trifft den Kopfsatz, neuer den Inhalt', async () => {
        const healthy = await buildHealthyTranscript()
        const bareMarker = '## Transcript-Inhalt'
        const oldBody = healthy.slice( healthy.indexOf( bareMarker ) + bareMarker.length ).trim()
        const newBody = healthy.slice( healthy.indexOf( CONTENT_MARKER ) + CONTENT_MARKER.length ).trim()

        // Das war der Defekt: der erste Treffer OHNE Leerzeilen ist die Marker-Erwaehnung im
        // Daten/Instruktions-Grenz-Satz, also landete der Kopf-Rest im Textfeld.
        expect( oldBody.startsWith( '` ist DATEN-Input,' ) ).toBe( true )
        expect( newBody.startsWith( '` ist DATEN-Input,' ) ).toBe( false )
        expect( newBody ).toBe( 'Gesprochener Text des Nutzers.' )
        expect( newBody.length ).toBeLessThan( oldBody.length )
    } )


    it( 'eine BEREITS beschaedigte Datei wird nicht stillschweigend repariert — sie wird abgelehnt', () => {
        // Der Marker-Fix verhindert NEUE Schaeden; die 5 Beweisstuecke bleiben unangetastet (WI-137).
        // Ihr Koerper faellt beim naechsten PUT in die Kopf-Signatur-Pruefung (TranscriptPutHardening).
        const newBody = damagedFixture.slice( damagedFixture.indexOf( CONTENT_MARKER ) + CONTENT_MARKER.length ).trim()
        const detected = TranscriptHeader.detectInBody( { 'content': newBody } )

        expect( newBody.startsWith( '` ist DATEN-Input,' ) ).toBe( true )
        expect( detected[ 'hasHeaderSignature' ] ).toBe( true )
    } )


    it( 'Client- und Server-Abtrennung liefern DENSELBEN Inhalt (Byte-Vergleich, sha256)', async () => {
        const healthy = await buildHealthyTranscript()
        const serverSide = TranscriptHeader.stripHeader( { 'content': healthy } )[ 'body' ]
        const clientSide = healthy.slice( healthy.indexOf( CONTENT_MARKER ) + CONTENT_MARKER.length )

        expect( sha( clientSide ) ).toBe( sha( serverSide ) )
        expect( Buffer.byteLength( clientSide ) ).toBe( Buffer.byteLength( serverSide ) )
    } )


    it( 'ein Transcript OHNE Kopf bleibt im Verhalten unveraendert (kein Marker -> kein Schnitt)', () => {
        const plain = 'Nur gesprochener Text, kein Kopf.'
        const idx = plain.indexOf( CONTENT_MARKER )
        const serverSide = TranscriptHeader.stripHeader( { 'content': plain } )[ 'body' ]

        expect( idx ).toBe( -1 )
        expect( serverSide ).toBe( plain )
    } )
} )


describe( 'PRD-V5 WI-135 — applyPromptEdit haengt keine Dubletten an', () => {
    let extractedSource = ''
    let loadedNames = []


    beforeAll( async () => {
        const lifted = await extractFunctionSources( [ 'applyPromptEdit', 'activatePsCopy' ] )
        extractedSource = `${ lifted[ 'source' ] }\nglobalThis.__apply = applyPromptEdit;`
        loadedNames = lifted[ 'names' ]
    } )


    it( 'der Helfer hebt AUCH async-Funktionen samt Schluesselwort heraus (2 Funktionen)', () => {
        expect( loadedNames.length ).toBe( 2 )
        expect( extractedSource.startsWith( 'async function applyPromptEdit(' ) ).toBe( true )
        expect( extractedSource ).toContain( 'function activatePsCopy(' )
    } )


    it( 'der Dubletten-Filter steht im Quelltext und folgt dem bestehenden Muster (3 Vorkommen)', () => {
        const pattern = /\.filter\( function\( block \) \{ return \w+\.indexOf\( block(\.trim\(\))? \) === -1 \} \)/g
        const hits = clientScript.match( pattern ) || []

        expect( hits.length ).toBe( 3 )
        expect( clientScript ).toContain( 'var freshBlocks = answerBlocks' )
    } )


    const runApply = async ( { transcriptValue, answers, existingTranscriptId } ) => {
        const sent = []
        const questionInputs = answers.map( ( entry, index ) => {
            return {
                'value': entry[ 'value' ],
                'getAttribute': ( key ) => ( key === 'data-pp-answer' ? String( index ) : null )
            }
        } )
        const nodes = {
            'pp-error': makeNode(),
            'pp-success': makeNode(),
            'pp-content': makeNode(),
            'pp-revision': makeNode(),
            'ps-copy': makeNode()
        }
        nodes[ 'pp-content' ].value = transcriptValue
        nodes[ 'pp-revision' ].value = 'REV-01'

        const sandbox = {
            'promptEditState': {
                'transcriptId': existingTranscriptId,
                'projectId': 'memo-init',
                'memoId': '080-db',
                'revisionId': 'REV-01',
                'questions': answers.map( ( entry ) => ( { 'id': entry[ 'id' ], 'title': entry[ 'title' ] } ) )
            },
            'document': {
                'getElementById': ( id ) => ( id in nodes ? nodes[ id ] : null ),
                'querySelectorAll': ( selector ) => {
                    if( selector.includes( 'pp-question-input' ) ) { return questionInputs }

                    return []
                }
            },
            'navigator': { 'clipboard': { 'writeText': () => Promise.resolve() } },
            'setTimeout': () => 0,
            'fetch': ( url, opts ) => {
                sent.push( { url, 'method': opts.method, 'content': JSON.parse( opts.body ).content } )

                return Promise.resolve( { 'ok': true, 'json': () => Promise.resolve( { 'transcriptId': 'T-1', 'url': 'http://localhost:3333/transcripts/T-1' } ) } )
            },
            'closeTranscriptModal': () => {},
            console
        }

        vm.createContext( sandbox )
        vm.runInContext( extractedSource, sandbox )
        await sandbox.__apply()

        return { sent }
    }


    it( 'ZWEIMALIGES Uebernehmen ohne Aenderung erzeugt byte-gleiche Nutzlast (sha256 identisch)', async () => {
        const answers = [
            { 'id': 'F1', 'title': 'Erste Frage', 'value': 'Antwort eins' },
            { 'id': 'F2', 'title': 'Zweite Frage', 'value': 'Antwort zwei' }
        ]

        // 1. Uebernehmen: leeres Feld + Antworten -> Bloecke werden angehaengt.
        const first = await runApply( { 'transcriptValue': 'Mein gesprochener Text.', answers, 'existingTranscriptId': null } )
        const firstPayload = first[ 'sent' ][ 0 ][ 'content' ]

        // 2. Uebernehmen: das Feld enthaelt jetzt (wie nach dem Neu-Oeffnen) genau diese Nutzlast.
        const second = await runApply( { 'transcriptValue': firstPayload, answers, 'existingTranscriptId': 'T-1' } )
        const secondPayload = second[ 'sent' ][ 0 ][ 'content' ]

        expect( sha( secondPayload ) ).toBe( sha( firstPayload ) )
        expect( Buffer.byteLength( secondPayload ) ).toBe( Buffer.byteLength( firstPayload ) )
    } )


    it( 'die Zahl der "## Antwort auf F"-Bloecke bleibt gleich — 2 bleibt 2, nicht 4', async () => {
        const answers = [
            { 'id': 'F1', 'title': 'Erste Frage', 'value': 'Antwort eins' },
            { 'id': 'F2', 'title': 'Zweite Frage', 'value': 'Antwort zwei' }
        ]
        const countBlocks = ( text ) => ( text.match( /## Antwort auf F/g ) || [] ).length

        const first = await runApply( { 'transcriptValue': 'Text.', answers, 'existingTranscriptId': null } )
        const firstPayload = first[ 'sent' ][ 0 ][ 'content' ]
        const second = await runApply( { 'transcriptValue': firstPayload, answers, 'existingTranscriptId': 'T-1' } )
        const secondPayload = second[ 'sent' ][ 0 ][ 'content' ]

        expect( countBlocks( firstPayload ) ).toBe( 2 )
        expect( countBlocks( secondPayload ) ).toBe( 2 )
    } )


    it( 'auch 18 Bloecke bleiben 18 — die Groessenordnung des Vorfalls (18 -> 36 war der Defekt)', async () => {
        const answers = Array.from( { 'length': 18 }, ( _, index ) => {
            return { 'id': `F${ index + 1 }`, 'title': `Frage ${ index + 1 }`, 'value': `Antwort ${ index + 1 }` }
        } )
        const countBlocks = ( text ) => ( text.match( /## Antwort auf F/g ) || [] ).length

        const first = await runApply( { 'transcriptValue': 'Langer Text.', answers, 'existingTranscriptId': null } )
        const firstPayload = first[ 'sent' ][ 0 ][ 'content' ]
        const second = await runApply( { 'transcriptValue': firstPayload, answers, 'existingTranscriptId': 'T-1' } )
        const secondPayload = second[ 'sent' ][ 0 ][ 'content' ]

        expect( answers.length ).toBe( 18 )
        expect( countBlocks( firstPayload ) ).toBe( 18 )
        expect( countBlocks( secondPayload ) ).toBe( 18 )
    } )


    it( 'ein GEAENDERTER Antwort-Text wird weiterhin uebernommen (1 von 2 Bloecken neu)', async () => {
        const answers = [
            { 'id': 'F1', 'title': 'Erste Frage', 'value': 'Antwort eins' },
            { 'id': 'F2', 'title': 'Zweite Frage', 'value': 'Antwort zwei' }
        ]
        const first = await runApply( { 'transcriptValue': 'Text.', answers, 'existingTranscriptId': null } )
        const firstPayload = first[ 'sent' ][ 0 ][ 'content' ]

        const changed = [
            answers[ 0 ],
            { 'id': 'F2', 'title': 'Zweite Frage', 'value': 'Antwort zwei — NEU FORMULIERT' }
        ]
        const second = await runApply( { 'transcriptValue': firstPayload, 'answers': changed, 'existingTranscriptId': 'T-1' } )
        const secondPayload = second[ 'sent' ][ 0 ][ 'content' ]

        expect( secondPayload ).toContain( 'NEU FORMULIERT' )
        expect( secondPayload.length ).toBeGreaterThan( firstPayload.length )
        // Der unveraenderte Block wurde NICHT verdoppelt: 3 Bloecke (2 alte + 1 neuer), nicht 4.
        expect( ( secondPayload.match( /## Antwort auf F/g ) || [] ).length ).toBe( 3 )
    } )


    it( 'ohne Antworten bleibt die Nutzlast der reine Transcript-Text (keine leere Trennzeile)', async () => {
        const out = await runApply( { 'transcriptValue': 'Nur Text, keine Antworten.', 'answers': [], 'existingTranscriptId': null } )

        expect( out[ 'sent' ][ 0 ][ 'content' ] ).toBe( 'Nur Text, keine Antworten.' )
    } )
} )


function makeNode() {
    const node = { 'textContent': '', 'value': '', 'disabled': false, 'attrs': {}, 'classes': new Set(), 'handlers': {} }
    node.classList = {
        'add': ( c ) => node.classes.add( c ),
        'remove': ( c ) => node.classes.delete( c ),
        'contains': ( c ) => node.classes.has( c )
    }
    node.setAttribute = ( k, v ) => { node.attrs[ k ] = v }
    node.getAttribute = ( k ) => ( k in node.attrs ? node.attrs[ k ] : null )
    node.removeAttribute = ( k ) => { delete node.attrs[ k ] }
    node.addEventListener = ( ev, fn ) => { node.handlers[ ev ] = fn }
    node.querySelectorAll = () => []

    return node
}


async function buildHealthyTranscript() {
    const { status, header } = TranscriptHeader.build( { 'type': 'revision', 'memoId': '080-db', 'revisionId': 'REV-01', 'maxRevNumber': 1 } )

    if( status !== true ) { throw new Error( 'fixture build failed' ) }

    return `${ header }Gesprochener Text des Nutzers.\n`
}
