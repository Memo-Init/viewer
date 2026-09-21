import { describe, it, expect } from '@jest/globals'

import { extractFunctions } from '../helpers/extractFunction.mjs'


// M082-09-06 (Memo 082 Kap 20a, Cluster C — WI-120): die Blockgrenze respektiert Fliesstext und
// Code-Zaeune.
//
// ZWEI FEHLER, EINE WURZEL. Die Schnittregel leitete die Grenze aus einem Zeilenmuster ab statt aus
// der Struktur, und zahlte dafuer zweimal:
//
//   1. UEBERDEHNUNG — die Spanne endete erst an der naechsten "## "-Ueberschrift, also fiel jeder
//      Absatz, den der Nutzer unter die Antwort geschrieben hatte, mit der Ersetzung weg.
//   2. FALSCHE GRENZE — eine "## "-Zeile INNERHALB eines Markdown-Zauns wurde als Ueberschrift
//      gelesen, obwohl sie Inhalt ist. Die Spanne endete dort, riss die oeffnende Zaun-Zeile mit
//      und liess Innen- und Schlusszeile verwaist stehen.
//
// Beides ist von M082-09-02 im Browser gemessen worden (Fall V2, Verdikt FAKT fuer BEIDE
// Textstuecke): 356 Zeichen vorher, 271 nachher. Die Eingaben hier bauen genau diesen Koerper nach,
// damit die Einheitspruefung und der Klick-Nachweis denselben Text meinen.
//
// Jeder Fall nennt seine Vergleichsmenge mit Zahl. Eine Zaehlung von 0 ist ein Befund, nie ein
// Bestehen.
const load = () => extractFunctions( [ 'mergeAnswerBlocks', 'scanAnswerBlocks', 'scanCodeFences' ] )

const HEADING = '## Antwort auf F1 — Acht Optionen'
const LEAD_TEXT = 'Einleitender Absatz des Nutzers, oberhalb jeder Antwort.'
const OLD_ANSWER = 'A — die alte Antwort auf F1'
const NEW_ANSWER = 'B — die neue Antwort auf F1'
const FREE_TEXT = 'Freitext des Nutzers unter der Antwort — dieser Absatz gehoert dem Nutzer.'
const FENCE_INNER = '## Diese Zeile steht in einem Code-Zaun und ist keine Ueberschrift'
const TAIL_HEADING = '## Abschliessender Abschnitt'
const TAIL_TEXT = 'Letzter Absatz des Nutzers, unterhalb des Zauns.'

const answerBlock = ( text ) => `${ HEADING }\n\n${ text }\n`


// Der Messkoerper, EINMAL deklariert. `open`, `inner` und `close` sind die einzigen Stellschrauben —
// so unterscheiden sich die benannten Eingaben von AB-2 nur in der Zaun-Form und in nichts sonst.
const contentWith = ( { open, inner, close } ) => [
    LEAD_TEXT,
    '',
    HEADING,
    '',
    OLD_ANSWER,
    '',
    FREE_TEXT,
    '',
    open,
    inner,
    close,
    '',
    TAIL_HEADING,
    '',
    TAIL_TEXT,
    ''
].join( '\n' )


// Die vier benannten Eingaben von AB-2 plus eine fuenfte, die der Auftrag nicht verlangt und die
// hier trotzdem steht: die vierte ("die ## -Zeile ist eingerueckt") laeuft auch am ALTEN Stand nicht
// in den Fehler, weil `/^##\s/` eine eingerueckte Zeile ohnehin nicht trifft — sie ist ein redundanter
// Weg und belegt fuer sich genommen nichts. Die fuenfte verschiebt die Einrueckung auf den ZAUN und
// laesst die "## "-Zeile in Spalte 1 stehen; dort ist die Zaun-Erkennung das einzige, was den Fall
// traegt. Beide Lesarten werden gefahren, damit die Bedingung erfuellt und die Schwaeche benannt ist.
const FENCE_FORMS = [
    { 'name': 'drei Backticks', 'open': '```text', 'inner': FENCE_INNER, 'close': '```', 'discriminating': true },
    { 'name': 'drei Tilden', 'open': '~~~text', 'inner': FENCE_INNER, 'close': '~~~', 'discriminating': true },
    { 'name': 'vier Backticks', 'open': '````markdown', 'inner': FENCE_INNER, 'close': '````', 'discriminating': true },
    { 'name': 'eingerueckte ## -Zeile', 'open': '```text', 'inner': `    ${ FENCE_INNER }`, 'close': '```', 'discriminating': false },
    { 'name': 'eingerueckter Zaun, ## -Zeile in Spalte 1', 'open': '  ```text', 'inner': FENCE_INNER, 'close': '  ```', 'discriminating': true }
]


describe( 'M082-09-06 AB-1/AB-6 — die Ersetzung fasst den Antwort-Block und nichts sonst', () => {

    it( 'AB-1 — der Fliesstext-Absatz unter der Antwort ueberlebt zeichengleich (1 Absatz, L = 73 > 0)', async () => {
        const { mergeAnswerBlocks } = await load()
        const content = contentWith( FENCE_FORMS[ 0 ] )

        // Die Vergleichsmenge zuerst, und mit Zahl: gegen einen leeren Absatz waere die Aussage
        // trivial wahr (GENERATE-KONTEXT § 8).
        expect( FREE_TEXT.length ).toBeGreaterThan( 0 )
        expect( content.split( '\n' ).filter( ( line ) => line === FREE_TEXT ).length ).toBe( 1 )

        const merged = mergeAnswerBlocks( content, [ answerBlock( NEW_ANSWER ) ] )
        const after = merged[ 'content' ].split( '\n' ).filter( ( line ) => line === FREE_TEXT )

        expect( merged[ 'ok' ] ).toBe( true )
        expect( after.length ).toBe( 1 )
        expect( after[ 0 ] ).toBe( FREE_TEXT )
        expect( after[ 0 ].length ).toBe( FREE_TEXT.length )
    } )


    it( 'AB-1 — auch der Code-Zaun ueberlebt vollstaendig (3 Zeilen, in Reihenfolge)', async () => {
        const { mergeAnswerBlocks } = await load()
        const form = FENCE_FORMS[ 0 ]
        const merged = mergeAnswerBlocks( contentWith( form ), [ answerBlock( NEW_ANSWER ) ] )
        const lines = merged[ 'content' ].split( '\n' )
        const openAt = lines.indexOf( form[ 'open' ] )
        const innerAt = lines.indexOf( form[ 'inner' ] )
        const closeAt = lines.indexOf( form[ 'close' ], openAt + 1 )

        // Alle drei Zeilen EINZELN gelesen — ein Gesamtvergleich verdeckte, welche gefallen ist.
        expect( openAt ).toBeGreaterThanOrEqual( 0 )
        expect( innerAt ).toBeGreaterThan( openAt )
        expect( closeAt ).toBeGreaterThan( innerAt )
    } )


    it( 'AB-1 — der gesamte Text UNTER der Antwort ist byte-gleich (1 Schwanz, 10 Zeilen)', async () => {
        const { mergeAnswerBlocks } = await load()
        const content = contentWith( FENCE_FORMS[ 0 ] )
        const tailOf = ( text ) => text.slice( text.indexOf( FREE_TEXT ) )
        const before = tailOf( content )

        expect( before.split( '\n' ).length ).toBe( 10 )

        const merged = mergeAnswerBlocks( content, [ answerBlock( NEW_ANSWER ) ] )

        expect( tailOf( merged[ 'content' ] ) ).toBe( before.trimEnd() )
    } )


    it( 'AB-6 — die Gegenrichtung: der Antwort-Block traegt danach den NEUEN Inhalt (1 Block)', async () => {
        // Ohne diese Richtung waere eine Fassung, die NICHTS ersetzt, von der richtigen nicht zu
        // unterscheiden — sie haette AB-1 ebenso gruen gemeldet.
        const { mergeAnswerBlocks } = await load()
        const merged = mergeAnswerBlocks( contentWith( FENCE_FORMS[ 0 ] ), [ answerBlock( NEW_ANSWER ) ] )

        expect( merged[ 'replaced' ] ).toBe( 1 )
        expect( merged[ 'appended' ] ).toBe( 0 )
        expect( merged[ 'content' ] ).toContain( NEW_ANSWER )
        expect( merged[ 'content' ] ).not.toContain( OLD_ANSWER )
    } )


    it( 'AB-6 — die Reichweite ist gemessen und teilt den Inhalt vollstaendig auf (16 Zeilen)', async () => {
        // Die Quittung meldete gruen, waehrend Nutzertext verschwand (M082-09-02, N3). Sie darf ihre
        // Reichweite deshalb nicht behaupten: die beiden Zahlen ergeben zusammen die Zeilenzahl des
        // Inhalts, also ist die Angabe nachrechenbar.
        const { mergeAnswerBlocks } = await load()
        const content = contentWith( FENCE_FORMS[ 0 ] )
        const merged = mergeAnswerBlocks( content, [ answerBlock( NEW_ANSWER ) ] )
        const total = content.trim().split( '\n' ).length

        expect( total ).toBe( 15 )
        expect( merged[ 'spanLines' ] ).toBe( 3 )
        expect( merged[ 'keptLines' ] ).toBe( total - merged[ 'spanLines' ] )
        expect( merged[ 'fences' ] ).toBe( 1 )
    } )
} )


describe( 'M082-09-06 AB-2/AB-3 — die Zaun-Matrix', () => {

    FENCE_FORMS.forEach( ( form ) => {
        it( `AB-2 — "${ form[ 'name' ] }": die ## -Zeile im Zaun ist KEINE Grenze (1 Eingabe)`, async () => {
            const { scanAnswerBlocks } = await load()
            const content = contentWith( form )
            const scan = scanAnswerBlocks( content )
            const lines = content.split( '\n' )
            const innerAt = lines.indexOf( form[ 'inner' ] )
            const tailAt = lines.indexOf( TAIL_HEADING )

            // Vergleichsmenge: genau EIN Antwort-Block und genau EIN Zaun in dieser Eingabe.
            expect( scan[ 'markers' ] ).toBe( 1 )
            expect( scan[ 'fences' ] ).toBe( 1 )
            expect( innerAt ).toBeGreaterThan( 0 )

            // Die Zeile im Zaun ist weder Grenze (`limit`) noch Teil der Ersetzung (`end`).
            expect( scan[ 'blocks' ][ 0 ][ 'limit' ] ).toBe( tailAt )
            expect( scan[ 'blocks' ][ 0 ][ 'limit' ] ).not.toBe( innerAt )
            expect( scan[ 'blocks' ][ 0 ][ 'end' ] ).toBeLessThan( innerAt )
        } )
    } )


    it( 'AB-3 — die Gegenrichtung: eine echte ## -Zeile AUSSERHALB jedes Zauns IST Grenze (1 Zeile)', async () => {
        // Ohne diese Richtung waere eine Fassung, die NIE eine Grenze findet, von der richtigen
        // nicht zu unterscheiden — sie wuerde jede Ersetzung bis zum Textende ausdehnen.
        const { scanAnswerBlocks, mergeAnswerBlocks } = await load()
        const content = contentWith( FENCE_FORMS[ 0 ] )
        const lines = content.split( '\n' )
        const tailAt = lines.indexOf( TAIL_HEADING )
        const scan = scanAnswerBlocks( content )

        expect( lines.filter( ( line ) => line === TAIL_HEADING ).length ).toBe( 1 )
        expect( scan[ 'blocks' ][ 0 ][ 'limit' ] ).toBe( tailAt )

        // Und die Grenze haelt auch im Ergebnis: der fremde Abschnitt steht unveraendert da.
        const merged = mergeAnswerBlocks( content, [ answerBlock( NEW_ANSWER ) ] )

        expect( merged[ 'content' ] ).toContain( TAIL_HEADING )
        expect( merged[ 'content' ] ).toContain( TAIL_TEXT )
    } )


    it( 'AB-2 — ein Zaun schliesst nur mit gleichem Zeichen und gleicher Laenge (2 Gegenproben)', async () => {
        // Die Vier-Backtick-Form ist nicht Feinschliff: sie ist die Form, in der dieser Korpus
        // Markdown in Markdown zitiert. Drei Backticks duerfen einen Zaun aus vieren nicht schliessen,
        // und eine Tilde keinen Backtick-Zaun.
        const { scanCodeFences } = await load()
        const shortClose = scanCodeFences( [ 'a', '````', '## drin', '```', '## auch drin', '' ].join( '\n' ) )
        const wrongChar = scanCodeFences( [ 'a', '```', '## drin', '~~~', '## auch drin', '' ].join( '\n' ) )

        expect( shortClose[ 'decidable' ] ).toBe( false )
        expect( wrongChar[ 'decidable' ] ).toBe( false )
        expect( shortClose[ 'inFence' ][ 4 ] ).toBe( true )
        expect( wrongChar[ 'inFence' ][ 4 ] ).toBe( true )
    } )
} )


describe( 'M082-09-06 AB-4 — eine nicht bestimmbare Grenze fuehrt zur sichtbaren Verweigerung', () => {

    const withOpenFence = [
        LEAD_TEXT,
        '',
        HEADING,
        '',
        OLD_ANSWER,
        '',
        FREE_TEXT,
        '',
        '```text',
        FENCE_INNER,
        ''
    ].join( '\n' )


    it( 'AB-4 — ein bis zum Textende offener Zaun wird NICHT ersetzt und nennt den Grund (1 Eingabe)', async () => {
        const { mergeAnswerBlocks, scanCodeFences } = await load()
        const fences = scanCodeFences( withOpenFence )

        // Vergleichsmenge zuerst: ein Zaun, der offen bleibt, und ein Antwort-Abschnitt, der auf
        // dem Spiel steht.
        expect( fences[ 'fences' ] ).toBe( 1 )
        expect( fences[ 'decidable' ] ).toBe( false )
        expect( fences[ 'openFenceLine' ] ).toBe( 8 )

        const merged = mergeAnswerBlocks( withOpenFence, [ answerBlock( NEW_ANSWER ) ] )

        expect( merged[ 'ok' ] ).toBe( false )
        expect( merged[ 'code' ] ).toBe( 'unclosed-fence' )
        expect( merged[ 'rawMarkers' ] ).toBe( 1 )
        expect( merged[ 'reason' ] ).toContain( 'Zeile 9' )
        expect( merged[ 'reason' ] ).toContain( 'nicht sicher bestimmbar' )

        // Verweigerung heisst: nichts ersetzt, nichts angehaengt, Inhalt unveraendert.
        expect( merged[ 'content' ] ).toBe( withOpenFence.trim() )
        expect( merged[ 'replaced' ] ).toBe( 0 )
        expect( merged[ 'appended' ] ).toBe( 0 )
        expect( merged[ 'content' ] ).not.toContain( NEW_ANSWER )
    } )


    it( 'AB-4 — die Gegenrichtung: ohne Antwort-Abschnitt verweigert sie NICHT (1 Eingabe)', async () => {
        // Eine Fassung, die jeden offenen Zaun ablehnt, waere von der richtigen nicht zu
        // unterscheiden und machte das Werkzeug unbenutzbar. Steht keine Ueberschrift im Text, gibt
        // es keine Spanne zu bestimmen und nichts zu verlieren — das Anhaengen bleibt erlaubt.
        const { mergeAnswerBlocks } = await load()
        const noHeadings = [ LEAD_TEXT, '', '```text', 'nur Inhalt, nie geschlossen', '' ].join( '\n' )
        const merged = mergeAnswerBlocks( noHeadings, [ answerBlock( NEW_ANSWER ) ] )

        expect( merged[ 'rawMarkers' ] ).toBe( 0 )
        expect( merged[ 'ok' ] ).toBe( true )
        expect( merged[ 'appended' ] ).toBe( 1 )
    } )


    it( 'AB-4 — "nicht entscheidbar" ist nicht "keine Grenze gefunden" (2 Eingaben)', async () => {
        // Dieselbe Unterscheidung, die checkTranscriptShrink zwischen unbekannter und leerer
        // Ausgangslaenge zieht. Ein geschlossener Zaun liefert ein Ergebnis, ein offener eine Lage.
        const { scanCodeFences } = await load()
        const closed = scanCodeFences( [ 'a', '```', 'b', '```', '' ].join( '\n' ) )
        const open = scanCodeFences( [ 'a', '```', 'b', '' ].join( '\n' ) )

        expect( closed[ 'decidable' ] ).toBe( true )
        expect( closed[ 'openFenceLine' ] ).toBe( null )
        expect( open[ 'decidable' ] ).toBe( false )
        expect( open[ 'openFenceLine' ] ).toBe( 1 )
    } )
} )


describe( 'M082-09-06 Vakuum-Probe — die Grenzbestimmung nennt ihre Vergleichsmenge', () => {

    it( 'ueber einem leeren Text ist die Vergleichsmenge 0 — das ist ein Befund, kein Bestehen', async () => {
        const { scanCodeFences, scanAnswerBlocks } = await load()
        const empty = scanCodeFences( '' )
        const control = scanCodeFences( contentWith( FENCE_FORMS[ 0 ] ) )

        // Die Zahl selbst: 0 Zeilen verglichen, 0 Zaeune gesehen.
        expect( empty[ 'comparedLines' ] ).toBe( 0 )
        expect( empty[ 'fences' ] ).toBe( 0 )
        expect( scanAnswerBlocks( '' )[ 'comparedLines' ] ).toBe( 0 )
        expect( scanAnswerBlocks( '' )[ 'markers' ] ).toBe( 0 )

        // Und die Gegenkontrolle, ohne die die 0 nichts belegte: dieselbe Zahl ist ueber einem
        // echten Text groesser als 0. Eine Zaehlung, die immer 0 meldet, misst nichts.
        expect( control[ 'comparedLines' ] ).toBe( 16 )
        expect( control[ 'fences' ] ).toBe( 1 )
    } )
} )
