import { describe, it, expect } from '@jest/globals'

import { extractFunctions } from '../helpers/extractFunction.mjs'
import { UserInputCapture } from '../../src/UserInputCapture.mjs'


// M082-09-FX1 (Memo 082 Kap 20a, Cluster C — WI-120, Nachtrag zu M082-09-06 O-1): dieselbe
// Schnittregel, BEIDE Seiten.
//
// WAS M082-09-06 STEHEN LIESS: der schreibende Pfad (`scanAnswerBlocks` / `mergeAnswerBlocks`) fuehrt
// seit M082-09-06 einen Zaun-Zustand. Die Schnittregel stand aber ein ZWEITES Mal im selben Bestand,
// und zwar zweimal zaun-blind:
//
//   1. `splitAnswerBlocks` im Klienten — der ANZEIGE-Pfad. Eine "## "-Zeile in einem Code-Zaun
//      beendete dort einen Antwort-Abschnitt, also wurde ein Zaun zwischen Koerper und
//      Antwort-Bereich ZERRISSEN. Kein Datenverlust, aber eine falsche Zuordnung.
//   2. `UserInputCapture.parseAnswerBlocks` auf dem Server — dieselbe Regel als Regex. Derselbe Zaun
//      schnitt dort den Antwort-Koerper ab.
//
// WARUM BEIDE ZUSAMMEN: die zwei stehen unter der Paritaets-Wache HeaderSplitParityPRD32, die Klient
// und Server gegeneinander bindet. Nur eine Seite zu reparieren zerrisse genau diese gemessene
// Paritaet. Deshalb ist die Reparatur hier EIN Gegenstand mit zwei Seiten.
//
// UND WARUM DIESE DATEI MEHR MISST ALS DIE WACHE: bei S-B irren beide Seiten in dieselbe Richtung
// (1 gegen 1). Ein reiner Zahl-gegen-Zahl-Vergleich bliebe dort gruen. Die Faelle hier messen
// deshalb den INHALT der beiden Teile, nicht nur ihre Anzahl — die Wache ist notwendig, nicht
// hinreichend.
//
// Jeder Fall nennt seine Vergleichsmenge mit Zahl. Eine Zaehlung von 0 ist ein Befund, nie ein
// Bestehen.
const load = () => extractFunctions( [ 'scanCodeFences', 'splitAnswerBlocks' ] )

const report = ( { label, counts } ) => console.log( `      [FX-1] ${ label }: ${ counts }` )

const BODY_TEXT = 'Gesprochener Text des Nutzers.'
const TAIL_TEXT = 'Noch ein Absatz des Nutzers, unterhalb des Zauns.'
const ANSWER_HEADING = '## Antwort auf F1 — Acht Optionen'
const ANSWER_TEXT = 'A — die Antwort auf F1'
const REMARK_HEADING = '## Anmerkungen'
const REMARK_TEXT = 'Eine Anmerkung des Nutzers.'
const FENCE_INNER = '## Diese Zeile steht in einem Code-Zaun und ist keine Ueberschrift'


// Die Zaun-Formen, die der Korpus wirklich fuehrt. Sie unterscheiden sich NUR in der Zaun-Form, damit
// ein roter Fall die Form benennt und nicht den Text.
const FENCE_FORMS = [
    { 'name': 'drei Backticks', 'open': '```text', 'close': '```' },
    { 'name': 'drei Tilden', 'open': '~~~text', 'close': '~~~' },
    { 'name': 'vier Backticks', 'open': '````markdown', 'close': '````' },
    { 'name': 'eingerueckter Zaun', 'open': '  ```text', 'close': '  ```' }
]


// S-A — der Zaun steht INNERHALB des Antwort-Abschnitts. Die Zeile im Zaun ist der Pruefgegenstand.
const sampleA = ( { open, close } ) => [
    BODY_TEXT,
    '',
    ANSWER_HEADING,
    '',
    ANSWER_TEXT,
    '',
    open,
    FENCE_INNER,
    close,
    ''
].join( '\n' )


// S-B — die Antwort-UEBERSCHRIFT selbst steht in einem Zaun. Es gibt also gar keinen Antwort-Abschnitt;
// der Text ist Koerper, vom ersten bis zum letzten Zeichen.
const sampleB = ( { open, close } ) => [
    BODY_TEXT,
    '',
    open,
    ANSWER_HEADING,
    '',
    ANSWER_TEXT,
    close,
    '',
    TAIL_TEXT,
    ''
].join( '\n' )


// S-C — die Gegenrichtung: eine echte Ueberschrift AUSSERHALB jedes Zauns bleibt eine Grenze. Ohne
// diesen Fall waere eine Fassung, die gar nicht mehr schneidet, von der richtigen nicht zu trennen.
const sampleC = () => [
    BODY_TEXT,
    '',
    ANSWER_HEADING,
    '',
    ANSWER_TEXT,
    '',
    REMARK_HEADING,
    '',
    REMARK_TEXT,
    ''
].join( '\n' )


// S-D — der Zaun wird bis zum Textende nicht geschlossen. "Nicht entscheidbar" ist nicht dasselbe wie
// "keine Grenze": beide Seiten schneiden hier nicht, und sie muessen darin uebereinstimmen.
const sampleD = ( { open } ) => [
    BODY_TEXT,
    '',
    open,
    ANSWER_HEADING,
    '',
    ANSWER_TEXT,
    ''
].join( '\n' )


const countServerBlocks = ( { text } ) => UserInputCapture.parseAnswerBlocks( { 'content': text } )[ 'answers' ].length

const countClientBlocks = ( { splitter, text } ) => {
    const { answersMd } = splitter( text )

    return ( answersMd.match( /^##\s+Antwort auf\s+F\d+/gm ) || [] ).length
}

const linesOf = ( { text } ) => text
    .split( '\n' )
    .filter( ( line ) => line.trim().length > 0 )


describe( 'M082-09-FX1 — der Anzeige-Pfad respektiert den Code-Zaun', () => {

    it( 'S-A: der Zaun im Antwort-Abschnitt bleibt GANZ im Antwort-Teil (3 Zeilen, in Reihenfolge, 4 Formen)', async () => {
        const { splitAnswerBlocks } = await load()
        const results = FENCE_FORMS.map( ( form ) => {
            const split = splitAnswerBlocks( sampleA( form ) )
            const answerLines = split[ 'answersMd' ].split( '\n' )
            const bodyLines = split[ 'bodyWithoutAnswers' ].split( '\n' )

            return {
                'name': form[ 'name' ],
                'openAt': answerLines.indexOf( form[ 'open' ] ),
                'innerAt': answerLines.indexOf( FENCE_INNER ),
                'closeAt': answerLines.indexOf( form[ 'close' ], answerLines.indexOf( form[ 'open' ] ) + 1 ),
                'strayInBody': bodyLines.filter( ( line ) => line === form[ 'open' ] || line === FENCE_INNER || line === form[ 'close' ] ).length
            }
        } )

        report( { 'label': 'S-A Zaun im Antwort-Teil', 'counts': `${ FENCE_FORMS.length } Formen, Positionen ${ results.map( ( entry ) => `${ entry[ 'openAt' ] }/${ entry[ 'innerAt' ] }/${ entry[ 'closeAt' ] }` ).join( ' ' ) }` } )

        // Vergleichsmenge zuerst: ohne Formen waere jede Aussage darunter trivial wahr.
        expect( FENCE_FORMS.length ).toBe( 4 )

        // Alle drei Zeilen EINZELN gelesen — ein Gesamtvergleich verdeckte, welche gefallen ist.
        results.forEach( ( entry ) => {
            expect( entry[ 'openAt' ] ).toBeGreaterThanOrEqual( 0 )
            expect( entry[ 'innerAt' ] ).toBeGreaterThan( entry[ 'openAt' ] )
            expect( entry[ 'closeAt' ] ).toBeGreaterThan( entry[ 'innerAt' ] )
            expect( entry[ 'strayInBody' ] ).toBe( 0 )
        } )
    } )


    it( 'S-B: die Antwort-Ueberschrift IM Zaun oeffnet keinen Antwort-Abschnitt (4 Formen, Koerper vollstaendig)', async () => {
        const { splitAnswerBlocks } = await load()
        const results = FENCE_FORMS.map( ( form ) => {
            const text = sampleB( form )
            const split = splitAnswerBlocks( text )

            return {
                'name': form[ 'name' ],
                'answersLength': split[ 'answersMd' ].trim().length,
                'tailInBody': split[ 'bodyWithoutAnswers' ].includes( TAIL_TEXT ),
                'fenceInBody': split[ 'bodyWithoutAnswers' ].includes( form[ 'close' ] ),
                'inputLines': linesOf( { text } ).length,
                'bodyLines': linesOf( { 'text': split[ 'bodyWithoutAnswers' ] } ).length
            }
        } )

        report( { 'label': 'S-B Ueberschrift im Zaun', 'counts': `${ FENCE_FORMS.length } Formen, Antwort-Teil ${ results.map( ( entry ) => entry[ 'answersLength' ] ).join( '/' ) } Zeichen, Koerper ${ results.map( ( entry ) => `${ entry[ 'bodyLines' ] }/${ entry[ 'inputLines' ] }` ).join( ' ' ) } Zeilen` } )

        expect( FENCE_FORMS.length ).toBe( 4 )

        results.forEach( ( entry ) => {
            expect( entry[ 'inputLines' ] ).toBeGreaterThan( 0 )
            expect( entry[ 'answersLength' ] ).toBe( 0 )
            expect( entry[ 'tailInBody' ] ).toBe( true )
            expect( entry[ 'fenceInBody' ] ).toBe( true )
            // Nachrechenbar: der Koerper traegt JEDE nicht-leere Zeile der Eingabe, keine fehlt.
            expect( entry[ 'bodyLines' ] ).toBe( entry[ 'inputLines' ] )
        } )
    } )


    it( 'S-C Gegenrichtung: eine echte Ueberschrift ausserhalb jedes Zauns IST weiterhin die Grenze', async () => {
        const { splitAnswerBlocks } = await load()
        const split = splitAnswerBlocks( sampleC() )

        report( { 'label': 'S-C echte Grenze', 'counts': `1 Eingabe, Antwort-Teil ${ split[ 'answersMd' ].trim().split( '\n' ).length } Zeilen, Koerper ${ linesOf( { 'text': split[ 'bodyWithoutAnswers' ] } ).length } Zeilen` } )

        expect( split[ 'answersMd' ].includes( ANSWER_TEXT ) ).toBe( true )
        expect( split[ 'answersMd' ].includes( REMARK_TEXT ) ).toBe( false )
        expect( split[ 'bodyWithoutAnswers' ].includes( REMARK_TEXT ) ).toBe( true )
        expect( split[ 'bodyWithoutAnswers' ].includes( ANSWER_TEXT ) ).toBe( false )
    } )


    it( 'S-D offener Zaun: der Anzeige-Pfad schneidet nicht und verliert nichts (4 Formen)', async () => {
        const { splitAnswerBlocks, scanCodeFences } = await load()
        const results = FENCE_FORMS.map( ( form ) => {
            const text = sampleD( form )
            const split = splitAnswerBlocks( text )

            return {
                'name': form[ 'name' ],
                'decidable': scanCodeFences( text )[ 'decidable' ],
                'answersLength': split[ 'answersMd' ].trim().length,
                'inputLines': linesOf( { text } ).length,
                'bodyLines': linesOf( { 'text': split[ 'bodyWithoutAnswers' ] } ).length
            }
        } )

        report( { 'label': 'S-D offener Zaun', 'counts': `${ FENCE_FORMS.length } Formen, entscheidbar ${ results.map( ( entry ) => entry[ 'decidable' ] ).join( '/' ) }, Koerper ${ results.map( ( entry ) => `${ entry[ 'bodyLines' ] }/${ entry[ 'inputLines' ] }` ).join( ' ' ) } Zeilen` } )

        results.forEach( ( entry ) => {
            expect( entry[ 'decidable' ] ).toBe( false )
            expect( entry[ 'answersLength' ] ).toBe( 0 )
            expect( entry[ 'bodyLines' ] ).toBe( entry[ 'inputLines' ] )
        } )
    } )
} )


describe( 'M082-09-FX1 — der Server liest dieselbe Grenze', () => {

    it( 'S-A: der Antwort-Koerper laeuft ueber den ganzen Zaun (3 Zaun-Zeilen, 4 Formen)', () => {
        const results = FENCE_FORMS.map( ( form ) => {
            const answers = UserInputCapture.parseAnswerBlocks( { 'content': sampleA( form ) } )[ 'answers' ]

            return {
                'name': form[ 'name' ],
                'count': answers.length,
                'hasOpen': answers.length > 0 && answers[ 0 ][ 'answer' ].includes( form[ 'open' ] ),
                'hasInner': answers.length > 0 && answers[ 0 ][ 'answer' ].includes( FENCE_INNER ),
                'hasClose': answers.length > 0 && answers[ 0 ][ 'answer' ].trim().endsWith( form[ 'close' ].trim() )
            }
        } )

        report( { 'label': 'S-A Server-Koerper', 'counts': `${ FENCE_FORMS.length } Formen, Abschnitte ${ results.map( ( entry ) => entry[ 'count' ] ).join( '/' ) }, Zaun ganz ${ results.filter( ( entry ) => entry[ 'hasOpen' ] === true && entry[ 'hasInner' ] === true && entry[ 'hasClose' ] === true ).length }` } )

        results.forEach( ( entry ) => {
            expect( entry[ 'count' ] ).toBe( 1 )
            expect( entry[ 'hasOpen' ] ).toBe( true )
            expect( entry[ 'hasInner' ] ).toBe( true )
            expect( entry[ 'hasClose' ] ).toBe( true )
        } )
    } )


    it( 'S-B: eine Ueberschrift im Zaun ist kein Antwort-Abschnitt (4 Formen, 0 Abschnitte)', () => {
        const counts = FENCE_FORMS.map( ( form ) => countServerBlocks( { 'text': sampleB( form ) } ) )

        report( { 'label': 'S-B Server-Abschnitte', 'counts': `${ FENCE_FORMS.length } Formen, Abschnitte ${ counts.join( '/' ) }` } )

        expect( counts.length ).toBe( 4 )
        expect( counts ).toEqual( [ 0, 0, 0, 0 ] )
    } )


    it( 'S-C Gegenrichtung: der Server schneidet an der echten Ueberschrift weiterhin ab', () => {
        const answers = UserInputCapture.parseAnswerBlocks( { 'content': sampleC() } )[ 'answers' ]

        report( { 'label': 'S-C Server-Grenze', 'counts': `1 Eingabe, ${ answers.length } Abschnitt(e), Koerper ${ answers.length > 0 ? answers[ 0 ][ 'answer' ].length : 0 } Zeichen` } )

        expect( answers.length ).toBe( 1 )
        expect( answers[ 0 ][ 'question' ] ).toBe( 'F1' )
        expect( answers[ 0 ][ 'answer' ] ).toBe( ANSWER_TEXT )
    } )
} )


describe( 'M082-09-FX1 — eine Regel, zwei Seiten: die beiden Zaun-Erkennungen sind gleich', () => {

    const ALL_SAMPLES = () => FENCE_FORMS
        .map( ( form ) => [ sampleA( form ), sampleB( form ), sampleD( form ) ] )
        .reduce( ( acc, group ) => acc.concat( group ), [ sampleC(), '', 'Nur Text, kein Zaun.' ] )


    it( 'Zaun-Erkennung: Klient und Server liefern ueber alle Eingaben dieselbe Lesung', async () => {
        const { scanCodeFences } = await load()
        const samples = ALL_SAMPLES()
        const pairs = samples.map( ( text ) => {
            const client = scanCodeFences( text )
            const server = UserInputCapture.scanCodeFences( { 'content': text } )

            return { client, server }
        } )
        const fencesSeen = pairs.reduce( ( sum, pair ) => sum + pair[ 'client' ][ 'fences' ], 0 )

        report( { 'label': 'Zaun-Erkennung Klient gegen Server', 'counts': `${ samples.length } Eingaben, ${ fencesSeen } Zaeune, Zeilen ${ pairs.reduce( ( sum, pair ) => sum + pair[ 'client' ][ 'comparedLines' ], 0 ) }` } )

        // Vakuum-Wache: ohne Zaun im Bestand verglichen beide nichts.
        expect( samples.length ).toBeGreaterThan( 0 )
        expect( fencesSeen ).toBeGreaterThan( 0 )

        pairs.forEach( ( pair ) => {
            expect( pair[ 'server' ][ 'inFence' ] ).toEqual( pair[ 'client' ][ 'inFence' ] )
            expect( pair[ 'server' ][ 'fences' ] ).toBe( pair[ 'client' ][ 'fences' ] )
            expect( pair[ 'server' ][ 'decidable' ] ).toBe( pair[ 'client' ][ 'decidable' ] )
            expect( pair[ 'server' ][ 'openFenceLine' ] ).toBe( pair[ 'client' ][ 'openFenceLine' ] )
            expect( pair[ 'server' ][ 'comparedLines' ] ).toBe( pair[ 'client' ][ 'comparedLines' ] )
        } )
    } )


    it( 'Abschnitts-Zahl: Klient und Server zaehlen ueber alle Zaun-Eingaben gleich', async () => {
        const { splitAnswerBlocks } = await load()
        const samples = ALL_SAMPLES().filter( ( text ) => text.length > 0 )
        const pairs = samples.map( ( text ) => ( {
            'server': countServerBlocks( { text } ),
            'client': countClientBlocks( { 'splitter': splitAnswerBlocks, text } )
        } ) )
        const blocksSeen = pairs.reduce( ( sum, pair ) => sum + pair[ 'server' ], 0 )

        report( { 'label': 'Abschnitts-Zahl Klient gegen Server', 'counts': `${ samples.length } Eingaben, ${ blocksSeen } Abschnitte, Paare ${ pairs.map( ( pair ) => `${ pair[ 'server' ] }/${ pair[ 'client' ] }` ).join( ' ' ) }` } )

        // Vakuum-Wache: ohne einen einzigen Abschnitt waere die Gleichheit bedeutungslos.
        expect( samples.length ).toBeGreaterThan( 0 )
        expect( blocksSeen ).toBeGreaterThan( 0 )
        expect( pairs.map( ( pair ) => pair[ 'client' ] ) ).toEqual( pairs.map( ( pair ) => pair[ 'server' ] ) )
    } )
} )
