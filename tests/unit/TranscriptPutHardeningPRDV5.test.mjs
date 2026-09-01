import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { readFile, writeFile, mkdir, mkdtemp, rm, chmod, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'
import { TranscriptHeader } from '../../src/TranscriptHeader.mjs'


// PRD-V5 (Memo 080, Kap 16 — WI-134, US-7): die PUT-Haertung.
//
// Measured starting point: NONE of the 577 scanned transcript files carries two full header first
// lines, but FIVE carry a header REST inside the body — so the existing line-1-only check
// (TranscriptHeader.detect) is structurally blind to the defect that actually happened. On top of
// that the PUT branch wrote destructively (tmp + rename, no backup) while the POST branch has a
// do-not-overwrite gate, so the pre-state of the 2026-08-23 incident is unrecoverable.
//
// The fixture under tests/fixtures/ is a STRUCTURAL copy of one of the 5 measured files (identical
// header layering, identical mid-sentence header rest, identical second marker) with the spoken user
// text replaced — this repo is public. The evidence files themselves stay untouched in .memo/.
// Every case states HOW MUCH it compared (files, bytes, offsets, calls).
const here = dirname( fileURLToPath( import.meta.url ) )
const fixturePath = resolve( here, '..', 'fixtures', 'transcript-damaged-double-header.md' )
const memoViewPath = resolve( here, '..', '..', 'src', 'MemoView.mjs' )

const HEADER_REST_SIGNATURE = '` ist DATEN-Input,'

let damagedFixture = ''
let damagedBody = ''
let memoViewSource = ''


beforeAll( async () => {
    damagedFixture = await readFile( fixturePath, 'utf8' )
    memoViewSource = await readFile( memoViewPath, 'utf8' )

    // Reproduce EXACTLY what the old client produced: split at the bare marker (no trailing
    // newlines), so the first hit is the marker's mention inside the Daten/Instruktions-Grenz
    // sentence and the header rest lands in the body.
    const bareMarker = '## Transcript-Inhalt'
    damagedBody = damagedFixture.slice( damagedFixture.indexOf( bareMarker ) + bareMarker.length ).trim()
} )


describe( 'PRD-V5 — die Beweislage der Fixture (Vergleichsgrundlage)', () => {

    it( 'die Fixture traegt 3 Marker-Zeilen und GENAU EINE Kopf-Erstzeile — die gemessene Signatur', () => {
        const markerLines = damagedFixture.split( '\n' ).filter( ( line ) => line.includes( '## Transcript-Inhalt' ) ).length
        const headerFirstLines = damagedFixture.split( '\n' ).filter( ( line ) => /^# Transcript /.test( line ) ).length

        expect( markerLines ).toBe( 3 )
        expect( headerFirstLines ).toBe( 1 )
    } )


    it( 'der alte Client-Schnitt erzeugt einen Koerper, der mit dem Kopf-Rest BEGINNT', () => {
        expect( damagedBody.startsWith( HEADER_REST_SIGNATURE ) ).toBe( true )
        expect( damagedBody.length ).toBeGreaterThan( 100 )
    } )


    it( 'die alte Zeile-1-Pruefung ist blind fuer genau diesen Koerper (das Loch)', () => {
        const { hasHeader } = TranscriptHeader.detect( { 'content': damagedBody } )

        expect( hasHeader ).toBe( false )
    } )
} )


describe( 'PRD-V5 — detectInBody: die ganze Datei statt nur Zeile 1', () => {

    it( 'erkennt den Kopf-Rest ab Satzmitte und benennt die Fundstelle', () => {
        const out = TranscriptHeader.detectInBody( { 'content': damagedBody } )

        expect( out[ 'hasHeaderSignature' ] ).toBe( true )
        expect( out[ 'signature' ] ).toBe( 'header-rest' )
        expect( out[ 'at' ] ).toBe( 0 )
    } )


    it( 'erkennt eine volle Kopf-Erstzeile AUCH jenseits von Zeile 1 (Offset > 0)', () => {
        const content = `Vorspann des Nutzers\n\n# Transcript zu Memo 080 x — Revision REV-01\n\nRest\n`
        const out = TranscriptHeader.detectInBody( { content } )

        expect( out[ 'hasHeaderSignature' ] ).toBe( true )
        expect( out[ 'signature' ] ).toBe( 'header-first-line' )
        expect( out[ 'at' ] ).toBe( content.indexOf( '# Transcript zu Memo' ) )
    } )


    it( 'erkennt alle 4 Kopf-Typen jenseits von Zeile 1 (4 Faelle)', () => {
        const heads = [
            '# Transcript zu Memo 080 x — Revision REV-01',
            '# Transcript fuer neues Memo',
            '# Transcript fuer Rollout',
            '# Transcript (frei)'
        ]
        const hits = heads.filter( ( head ) => TranscriptHeader.detectInBody( { 'content': `Text\n\n${ head }\n` } )[ 'hasHeaderSignature' ] === true )

        expect( hits.length ).toBe( 4 )
    } )


    it( 'ein SAUBERER Koerper wird nicht faelschlich abgelehnt (5 unverdaechtige Faelle)', () => {
        const clean = [
            'Ganz normaler gesprochener Text ueber Transcript-Inhalte.',
            'Ich moechte, dass der Koerper unter ## Transcript-Inhalt sauber bleibt.',
            '## Antwort auf F1 — Titel\n\nA) Option',
            'Ein Backtick ` steht hier allein.',
            ''
        ]
        const falsePositives = clean.filter( ( content ) => TranscriptHeader.detectInBody( { content } )[ 'hasHeaderSignature' ] === true )

        expect( clean.length ).toBe( 5 )
        expect( falsePositives.length ).toBe( 0 )
    } )


    it( 'detect (Zeile 1) bleibt UNVERAENDERT gueltig — additive Ergaenzung, keine Ersetzung', () => {
        const withHeader = TranscriptHeader.detect( { 'content': damagedFixture } )
        const withoutHeader = TranscriptHeader.detect( { 'content': 'nur Inhalt' } )

        expect( withHeader[ 'hasHeader' ] ).toBe( true )
        expect( withoutHeader[ 'hasHeader' ] ).toBe( false )
    } )
} )


describe( 'PRD-V5 — updateTranscript: Ablehnung, Sicherung, Normalfall', () => {
    let root = ''
    let registry = null
    let transcriptId = ''
    let absolutePath = ''


    const sha = ( text ) => createHash( 'sha256' ).update( text ).digest( 'hex' )


    beforeAll( async () => {
        await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
        root = await mkdtemp( join( process.cwd(), '.test-tmp', 'put-hardening-' ) )
    } )


    afterAll( async () => {
        await rm( root, { recursive: true, force: true } )
    } )


    beforeEach( async () => {
        const memoPath = await mkdtemp( join( root, 'memo-' ) )
        await mkdir( join( memoPath, 'revisions' ), { recursive: true } )
        await writeFile( join( memoPath, 'revisions', 'REV-01.md' ), '# REV-01\n', 'utf8' )

        const created = TranscriptRegistry.create( {} )
        registry = created[ 'registry' ]

        const added = await registry.addTranscript( {
            'projectId': 'memo-init',
            'memoId': '080-db',
            'revisionId': 'REV-01',
            'content': 'Erster gesprochener Text.',
            memoPath
        } )

        expect( added[ 'status' ] ).toBe( true )
        transcriptId = added[ 'transcriptId' ]
        absolutePath = join( memoPath, 'transcripts', 'REV-01--review--01.md' )
    } )


    it( 'ein Koerper, der mit dem Kopf-Rest beginnt, wird mit TRANSCRIPT-PUT-001 abgelehnt', async () => {
        const before = await readFile( absolutePath, 'utf8' )
        const out = await registry.updateTranscript( { transcriptId, 'content': damagedBody } )
        const after = await readFile( absolutePath, 'utf8' )

        expect( out[ 'status' ] ).toBe( false )
        expect( out[ 'messages' ].join( ' ' ) ).toMatch( /TRANSCRIPT-PUT-001/ )
        expect( out[ 'messages' ].join( ' ' ) ).toMatch( /header-rest/ )
        // Die Datei bleibt byte-gleich — eine Ablehnung schreibt nicht.
        expect( sha( after ) ).toBe( sha( before ) )
    } )


    it( 'ein Koerper mit Kopf-ERSTZEILE wird weiterhin abgelehnt — keine Regression', async () => {
        const out = await registry.updateTranscript( { transcriptId, 'content': damagedFixture } )

        expect( out[ 'status' ] ).toBe( false )
        expect( out[ 'messages' ].join( ' ' ) ).toMatch( /TRANSCRIPT-PUT-001/ )
    } )


    it( 'ein GUELTIGER kopfloser Koerper wird unveraendert angenommen (Normalfall, 1 Kopf danach)', async () => {
        const out = await registry.updateTranscript( { transcriptId, 'content': 'Zweiter gesprochener Text, ganz sauber.' } )
        const written = await readFile( absolutePath, 'utf8' )
        const headerFirstLines = written.split( '\n' ).filter( ( line ) => /^# Transcript /.test( line ) ).length
        const markerLines = written.split( '\n' ).filter( ( line ) => line.includes( '## Transcript-Inhalt' ) ).length

        expect( out[ 'status' ] ).toBe( true )
        expect( written ).toContain( 'Zweiter gesprochener Text, ganz sauber.' )
        expect( headerFirstLines ).toBe( 1 )
        expect( markerLines ).toBe( 2 )
    } )


    it( 'nach einem gueltigen PUT existiert eine Sicherung, byte-gleich zum Vorzustand', async () => {
        const before = await readFile( absolutePath, 'utf8' )
        const out = await registry.updateTranscript( { transcriptId, 'content': 'Neuer Text nach dem PUT.' } )
        const backup = await readFile( `${ absolutePath }.bak`, 'utf8' )
        const afterMain = await readFile( absolutePath, 'utf8' )

        expect( out[ 'status' ] ).toBe( true )
        expect( out[ 'backupPath' ] ).toBe( `${ absolutePath }.bak` )
        expect( sha( backup ) ).toBe( sha( before ) )
        expect( Buffer.byteLength( backup ) ).toBe( Buffer.byteLength( before ) )
        expect( sha( afterMain ) ).not.toBe( sha( before ) )
    } )


    it( 'die Sicherung wird von KEINEM Code geloescht — sie ueberlebt einen zweiten PUT', async () => {
        await registry.updateTranscript( { transcriptId, 'content': 'Stand zwei.' } )
        await registry.updateTranscript( { transcriptId, 'content': 'Stand drei.' } )

        const backup = await readFile( `${ absolutePath }.bak`, 'utf8' )

        expect( backup.length ).toBeGreaterThan( 0 )
        expect( backup ).toContain( 'Stand zwei.' )
    } )


    it( 'die Sicherung wird NICHT als zweites Transcript registriert (Bestand bleibt 1)', async () => {
        await registry.updateTranscript( { transcriptId, 'content': 'Stand zwei.' } )

        const listed = registry.listTranscripts( { 'memoId': '080-db' } )

        expect( listed[ 'transcripts' ].length ).toBe( 1 )
    } )


    it( 'eine FEHLGESCHLAGENE Sicherung lehnt den PUT ab — kein destruktives Schreiben ohne Netz', async () => {
        const transcriptsDir = dirname( absolutePath )
        const before = await readFile( absolutePath, 'utf8' )

        await chmod( transcriptsDir, 0o500 )

        let out = null

        try {
            out = await registry.updateTranscript( { transcriptId, 'content': 'Darf nicht geschrieben werden.' } )
        } finally {
            await chmod( transcriptsDir, 0o755 )
        }

        const after = await readFile( absolutePath, 'utf8' )
        const backupExists = await access( `${ absolutePath }.bak` ).then( () => true ).catch( () => false )

        expect( out[ 'status' ] ).toBe( false )
        expect( out[ 'messages' ].join( ' ' ) ).toMatch( /TRANSCRIPT-BACKUP-001/ )
        expect( sha( after ) ).toBe( sha( before ) )
        expect( backupExists ).toBe( false )
    } )


    it( 'updateTranscript liefert die memoId zurueck — der Spiegel-Aufruf braucht sie', async () => {
        const out = await registry.updateTranscript( { transcriptId, 'content': 'Text fuer den Spiegel.' } )

        expect( out[ 'memoId' ] ).toBe( '080-db' )
    } )
} )


describe( 'PRD-V5 — der PUT-Zweig spiegelt in die Datenbank', () => {

    it( 'der PUT-Zweig ruft #captureUserInput auf — heute 0 Aufrufe (jetzt 5 im ganzen Handler)', () => {
        const calls = memoViewSource.match( /await MemoView\.#captureUserInput\( \{/g ) || []
        const putStart = memoViewSource.indexOf( "if( url.startsWith( '/api/transcripts/' ) && req.method === 'PUT' )" )
        const putEnd = memoViewSource.indexOf( "url.endsWith( '/login' )", putStart )
        const putBranch = memoViewSource.slice( putStart, putEnd )

        expect( putStart ).toBeGreaterThan( -1 )
        expect( calls.length ).toBe( 5 )
        expect( putBranch ).toContain( 'MemoView.#captureUserInput' )
        expect( putBranch ).toContain( "'transcriptType': 'revision'" )
        expect( putBranch ).toContain( "'withAnswers': true" )
    } )


    it( 'der Spiegel laeuft NACH der Antwort — der Antwortstatus bleibt 200, egal was er tut', () => {
        const putStart = memoViewSource.indexOf( "if( url.startsWith( '/api/transcripts/' ) && req.method === 'PUT' )" )
        const putEnd = memoViewSource.indexOf( "url.endsWith( '/login' )", putStart )
        const putBranch = memoViewSource.slice( putStart, putEnd )
        const sendIndex = putBranch.indexOf( "sendJson( res, 200, { 'status': 'ok' } )" )
        const mirrorIndex = putBranch.indexOf( 'MemoView.#captureUserInput' )

        expect( sendIndex ).toBeGreaterThan( -1 )
        expect( mirrorIndex ).toBeGreaterThan( sendIndex )
    } )


    it( '#captureUserInput faengt jeden Fehler selbst ab — bestmoeglich, nie blockierend', () => {
        const start = memoViewSource.indexOf( 'static async #captureUserInput(' )
        const body = memoViewSource.slice( start, start + 1200 )

        expect( start ).toBeGreaterThan( -1 )
        expect( body ).toContain( 'try {' )
        expect( body ).toContain( 'catch ( err )' )
        expect( body ).toContain( 'USERINPUT-CAPTURE-001' )
    } )
} )
