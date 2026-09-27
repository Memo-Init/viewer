import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'
import { BlockMeta } from '../../src/BlockMeta.mjs'
import { extractFunctions, readMemoViewSource, readEmittedScript } from '../helpers/extractFunction.mjs'
import { makeDocument, makeNode } from '../helpers/domSurrogate.mjs'


// PRD-13 (Memo 082 Kap 33, S1-S4 / WI-234) — der Bloecke-Tab liest den Bestand, den es gibt.
//
// DER BEFUND, AUSFUEHRBAR GEMACHT. Der Tab parste `block-meta`-Zaeune aus dem Markdown. Gemessen am
// Bau-Tag in Memo 082: **0** Zaeune in allen 27 Revisionsdateien, dagegen **35** Block-Datensaetze im
// Store und **35** Zeilen in der Tabelle `block` von `memo-082.db`. Der Bereich war also leer ueber
// einem vollen Traeger. Jeder Fall hier nennt seine Vergleichsmenge mit Zahl; eine Zaehlung von 0 ist
// ein Befund und nie ein Bestehen.
//
// KEIN ZWEITER DATENWEG. Der Zaun-Parser bleibt (MemoValidator, MemoModel und die Requirements-Route
// brauchen ihn, und im Bestand tragen 9 Dateien Zaeune) — er ist nur nicht mehr die Quelle dieses Tabs.
// Seine Zahl erreicht die Leermengen-Meldung als BEGRUENDUNG und nie als gerenderte Zeile.


const here = tmpdir()
let root = ''


// Eine wegwerfbare Memo-Ablage unter $TMPDIR, benannt nach diesem Auftrag (der Scratchpad ist
// sitzungsweit geteilt, generische Namen kollidieren still). Sie spiegelt das echte Layout
// .memo/memos/<id>/{_topics,blocks,revisions} — aber NIE den echten Bestand: ein Test, der ueber die
// Repo-Grenze hinausliest, misst fremden Zustand.
async function writeFixtureMemo( { name, topics, blocks, revision } ) {
    const memoDir = join( root, name )
    await mkdir( join( memoDir, '_topics' ), { recursive: true } )
    await mkdir( join( memoDir, 'revisions' ), { recursive: true } )

    await Promise.all( topics.map( async ( topic ) => {
        await writeFile( join( memoDir, '_topics', topic[ 'id' ] + '.json' ), JSON.stringify( topic, null, 4 ) + '\n', 'utf-8' )
    } ) )

    await Promise.all( blocks.map( async ( block ) => {
        const dir = join( memoDir, 'blocks', block[ 'blockId' ] )
        await mkdir( dir, { recursive: true } )
        await writeFile( join( dir, 'block.json' ), JSON.stringify( block, null, 4 ) + '\n', 'utf-8' )
    } ) )

    if( typeof revision === 'string' ) {
        await writeFile( join( memoDir, 'revisions', 'REV-01.md' ), revision, 'utf-8' )
    }

    return memoDir
}


// Die vier benannten Bloecke decken die DREI Titel-Lagen aus S2 ab, und die dritte ist die, die man
// weglassen moechte: ohne sie ist ein abgeleiteter Titel von einem echten nicht zu unterscheiden.
const FIXTURE_BLOCKS = [
    { 'blockId': 'B001', 'chapter': 3, 'chapterHeading': '3. Erstes Kapitel', 'fields': { 'title': 'Echter Titel aus dem Store' }, 'topicIds': [ 'T001' ], 'tags': [ 'Code' ], 'sections': {} },
    { 'blockId': 'B002', 'chapter': 4, 'chapterHeading': '4. Zweites Kapitel', 'fields': {}, 'topicIds': [ 'T002' ], 'tags': [], 'sections': {} },
    { 'blockId': 'B003', 'chapter': 5, 'chapterHeading': '', 'fields': { 'title': 'B003' }, 'topicIds': [], 'tags': [], 'sections': { 'decision': 'Kapitel 5 gewaehlt, weil der Traeger es so fuehrt.\nZweite Zeile.' } },
    { 'blockId': 'B004', 'chapter': 6, 'chapterHeading': '', 'fields': {}, 'topicIds': [], 'tags': [], 'sections': {} }
]

// Die Datei-Form des Stores (`fields.title`) und die Lese-Form der Route (`title`) sind zwei Formen.
// GENAU EINE Stelle kennt die Datei-Form — die Projektion in #readBlockFiles; alles danach rechnet auf
// der Lese-Form. Dieser Helfer stellt sie in den reinen Faellen her, damit kein Test eine dritte Form
// erfindet. (Beim ersten Lauf hat genau das zwei Faelle rot gemacht: die Roh-Form ging in einen Leser
// der Lese-Form, und der Titel fiel auf die Ableitung zurueck — der Fehler lag im Test, nicht im Code.)
function projectBlock( block ) {
    const fields = ( block[ 'fields' ] != null && typeof block[ 'fields' ] === 'object' ) ? block[ 'fields' ] : {}

    return {
        'blockId': block[ 'blockId' ],
        'topicIds': block[ 'topicIds' ],
        'tags': block[ 'tags' ],
        'title': typeof fields[ 'title' ] === 'string' ? fields[ 'title' ] : '',
        'chapter': block[ 'chapter' ] == null ? null : block[ 'chapter' ],
        'chapterHeading': typeof block[ 'chapterHeading' ] === 'string' ? block[ 'chapterHeading' ] : '',
        'sections': block[ 'sections' ]
    }
}

const FIXTURE_TOPICS = [
    { 'id': 'T001', 'title': 'Erstes Topic', 'blockId': 'B001', 'chapter': '3. Erstes Kapitel', 'workItemIds': [], 'status': 'registered' },
    { 'id': 'T002', 'title': 'Zweites Topic', 'blockId': 'B002', 'chapter': '4. Zweites Kapitel', 'workItemIds': [], 'status': 'registered' }
]

// Ein Dokument OHNE einen einzigen block-meta-Zaun — die eine Haelfte der AB-2-Kombination.
const REVISION_WITHOUT_FENCES = [
    '# Memo 999 — Fixture',
    '',
    '## 3. Erstes Kapitel',
    '',
    'Fliesstext ohne jeden Zaun.',
    '',
    '```json',
    '{ "kein": "block-meta" }',
    '```',
    ''
].join( '\n' )


beforeAll( async () => {
    root = await mkdtemp( join( here, 'p9-prd13-blocks-tab-' ) )
} )

afterAll( async () => {
    if( root.length > 0 ) { await rm( root, { recursive: true, force: true } ) }
} )


// ============================================================================================
// 1. S1/AB-2 — die Quelle ist der Store, nicht der Markdown-Zaun
// ============================================================================================
describe( 'PRD-13 S1/AB-2 — die Quelle ist der Store', () => {

    // DIESER FALL TRAEGT BEIDE HAELFTEN, und das ist Absicht. Die erste Haelfte rechnet ueber die
    // reinen Funktionen (0 Zaeune gegen 4 Datensaetze); die zweite haelt die ROUTE daran fest. Ohne die
    // zweite bliebe der Fall gruen, wenn jemand den Tab wieder auf den Zaun-Parser legte — die Helfer
    // wuerden ja weiter richtig rechnen, nur niemand riefe sie. Gemessen in der Gegenprobe zu AB-7:
    // genau diese Mutante liess die erste Haelfte unberuehrt.
    it( 'AB-2: 1 Dokument mit 0 Zaeunen und B=4 Bloecken im Traeger ⇒ der Tab zeigt 4, die Alt-Quelle 0', async () => {
        const memoDir = await writeFixtureMemo( {
            'name': '999-ab2',
            'topics': FIXTURE_TOPICS,
            'blocks': FIXTURE_BLOCKS,
            'revision': REVISION_WITHOUT_FENCES
        } )

        // Vergleichsmenge, beide Haelften beziffert: 1 Dokument, 0 Zaeune, 4 Datensaetze.
        const parsed = BlockMeta.parse( { 'doc': REVISION_WITHOUT_FENCES } )
        expect( parsed[ 'blocks' ] ).toHaveLength( 0 )
        expect( parsed[ 'errors' ] ).toHaveLength( 0 )

        const store = await MemoView.readTopicStore( { memoDir } )
        expect( store[ 'blocks' ] ).toHaveLength( 4 )

        const tab = MemoView.blockStoreTabView( { 'blocks': store[ 'blocks' ], 'topics': store[ 'topics' ] } )

        // Das ist die ausfuehrbare Form des Befunds: unter der alten Quelle 0, unter der neuen 4.
        expect( tab[ 'blocks' ] ).toHaveLength( 4 )
        expect( tab[ 'counts' ][ 'blocks' ] ).toBe( 4 )
        expect( tab[ 'blocks' ].map( ( block ) => block[ 'id' ] ) ).toEqual( [ 'B001', 'B002', 'B003', 'B004' ] )

        // Zweite Haelfte: die ROUTE haengt an dieser Quelle. Vergleichsmenge sind die Bytes des
        // /blocks-Zweiges und nichts sonst — der naechste Zweig (/topics) liest denselben Store, ein
        // breiteres Fenster waere umsonst gruen.
        const source = await readMemoViewSource()
        const blocksIdx = source.indexOf( "url.endsWith( '/blocks' )" )
        const nextIdx = source.indexOf( "url.endsWith( '/topics' )", blocksIdx )
        expect( blocksIdx ).toBeGreaterThan( -1 )
        expect( nextIdx ).toBeGreaterThan( blocksIdx )

        const route = source.slice( blocksIdx, nextIdx )
        expect( route ).toContain( 'MemoView.readTopicStore(' )
        expect( route ).toContain( 'MemoView.blockStoreTabView(' )
        expect( route ).not.toContain( 'BlockMeta.parse( { doc: content } )' )
    } )


    it( 'S1: readTopicStore traegt Titel, Kapitel und Kapitel-Ueberschrift — vorher fielen sie in der Projektion weg', async () => {
        const memoDir = await writeFixtureMemo( {
            'name': '999-projection',
            'topics': FIXTURE_TOPICS,
            'blocks': FIXTURE_BLOCKS,
            'revision': REVISION_WITHOUT_FENCES
        } )
        const store = await MemoView.readTopicStore( { memoDir } )
        const first = store[ 'blocks' ][ 0 ]

        // Die drei alten Schluessel stehen unveraendert — die Erweiterung ist additiv.
        expect( first[ 'blockId' ] ).toBe( 'B001' )
        expect( first[ 'topicIds' ] ).toEqual( [ 'T001' ] )
        expect( first[ 'tags' ] ).toEqual( [ 'Code' ] )
        // Und die vier neuen tragen, was der Tab braucht.
        expect( first[ 'title' ] ).toBe( 'Echter Titel aus dem Store' )
        expect( first[ 'chapter' ] ).toBe( 3 )
        expect( first[ 'chapterHeading' ] ).toBe( '3. Erstes Kapitel' )
        expect( typeof first[ 'sections' ] ).toBe( 'object' )
    } )


    it( 'S1: die /blocks-Route nennt ihre Quelle im Nutzdatensatz (kind store)', async () => {
        const source = await readMemoViewSource()
        const blocksIdx = source.indexOf( "url.endsWith( '/blocks' )" )
        const nextIdx = source.indexOf( "url.endsWith( '/topics' )", blocksIdx )
        expect( nextIdx ).toBeGreaterThan( blocksIdx )

        const route = source.slice( blocksIdx, nextIdx )
        expect( route ).toContain( "'kind': 'store'" )
        expect( route ).toContain( "'available': store[ 'blocks' ].length" )
        expect( route ).not.toContain( 'BlockMeta.parse( { doc: content } )' )
    } )
} )


// ============================================================================================
// 2. S2/AB-3 — drei Titel-Lagen, drei unterscheidbare Ergebnisse
// ============================================================================================
describe( 'PRD-13 S2/AB-3 — die drei Titel-Lagen', () => {

    it( 'Lage 1 — Titel vorhanden und verschieden von der Kennung ⇒ uebernommen', () => {
        const out = MemoView.blockTitleResolution( { 'block': projectBlock( FIXTURE_BLOCKS[ 0 ] ) } )

        expect( out[ 'title' ] ).toBe( 'Echter Titel aus dem Store' )
        expect( out[ 'titleSource' ] ).toBe( 'store' )
        expect( out[ 'titleMissing' ] ).toBe( false )
        expect( out[ 'derivedFrom' ] ).toBe( null )
    } )


    it( 'Lage 2a — Titel fehlt ⇒ aus der Kapitel-Ueberschrift abgeleitet UND als abgeleitet kenntlich', () => {
        const out = MemoView.blockTitleResolution( { 'block': projectBlock( FIXTURE_BLOCKS[ 1 ] ) } )

        expect( out[ 'title' ] ).toBe( '4. Zweites Kapitel' )
        expect( out[ 'titleSource' ] ).toBe( 'derived' )
        expect( out[ 'derivedFrom' ] ).toBe( 'chapterHeading' )
    } )


    it( 'Lage 2b — Titel gleicht der Kennung ⇒ aus dem Inhalt abgeleitet, Herkunft benannt', () => {
        const out = MemoView.blockTitleResolution( { 'block': projectBlock( FIXTURE_BLOCKS[ 2 ] ) } )

        // Nur die erste Zeile, nicht der ganze Abschnitt — ein Titel ist eine Zeile.
        expect( out[ 'title' ] ).toBe( 'Kapitel 5 gewaehlt, weil der Traeger es so fuehrt.' )
        expect( out[ 'titleSource' ] ).toBe( 'derived' )
        expect( out[ 'derivedFrom' ] ).toBe( 'sections.decision' )
    } )


    it( 'Lage 3 — nichts ableitbar ⇒ Kennung PLUS Hinweis auf den fehlenden Titel (die Pflicht-Lage)', () => {
        const out = MemoView.blockTitleResolution( { 'block': projectBlock( FIXTURE_BLOCKS[ 3 ] ) } )

        expect( out[ 'title' ] ).toBe( 'B004' )
        expect( out[ 'titleSource' ] ).toBe( 'missing' )
        expect( out[ 'titleMissing' ] ).toBe( true )
    } )


    it( 'AB-3: die drei Lagen sind UNTERSCHEIDBAR — 3 verschiedene Herkunfts-Werte ueber 4 Bloecke', () => {
        const sources = FIXTURE_BLOCKS
            .map( ( block ) => MemoView.blockTitleResolution( { 'block': projectBlock( block ) } )[ 'titleSource' ] )
        const distinct = sources.filter( ( value, index ) => sources.indexOf( value ) === index ).sort()

        // Vergleichsmenge: 4 Bloecke, 3 Lagen. Ohne diese Zusicherung koennte eine Fassung alle drei
        // Lagen auf denselben Wert legen und jeden Einzelfall trotzdem bestehen.
        expect( sources ).toHaveLength( 4 )
        expect( distinct ).toEqual( [ 'derived', 'missing', 'store' ] )
    } )


    it( 'ein sehr langer Ableitungs-Text wird gekuerzt und als gekuerzt erkennbar', () => {
        const long = 'x'.repeat( 200 )
        const out = MemoView.blockTitleResolution( { 'block': { 'blockId': 'B900', 'fields': {}, 'sections': { 'decision': long } } } )

        expect( out[ 'titleSource' ] ).toBe( 'derived' )
        expect( out[ 'title' ].length ).toBe( 78 )
        expect( out[ 'title' ].endsWith( '…' ) ).toBe( true )
    } )
} )


// ============================================================================================
// 3. S3/AB-4/AB-5 — die Kapitel-Bindung, und der Zaun um sie
// ============================================================================================
describe( 'PRD-13 S3/AB-4/AB-5 — Kapitel-Bindung mit Nenner, und keine geratene Bindung', () => {

    it( 'AB-4: die Quote wird mit NENNER ausgegeben — Zaehler und Nenner stehen beide im Modell', () => {
        const tab = MemoView.blockStoreTabView( { 'blocks': FIXTURE_BLOCKS.map( projectBlock ), 'topics': FIXTURE_TOPICS } )

        expect( tab[ 'counts' ][ 'chapterBound' ] ).toBe( 4 )
        expect( tab[ 'counts' ][ 'blocks' ] ).toBe( 4 )
        expect( tab[ 'counts' ][ 'chapterUnbound' ] ).toBe( 0 )
        // Zaehler + Gegen-Zaehler ergeben den Nenner — die Ausgabe ist nachrechenbar, nicht behauptet.
        expect( tab[ 'counts' ][ 'chapterBound' ] + tab[ 'counts' ][ 'chapterUnbound' ] ).toBe( tab[ 'counts' ][ 'blocks' ] )
        expect( tab[ 'counts' ][ 'titleFromStore' ] + tab[ 'counts' ][ 'titleDerived' ] + tab[ 'counts' ][ 'titleMissing' ] ).toBe( tab[ 'counts' ][ 'blocks' ] )
    } )


    it( 'eine im Block hinterlegte Bindung wird uebernommen und als store ausgewiesen', () => {
        const out = MemoView.blockChapterBinding( {
            'block': { 'blockId': 'B001', 'chapter': 3, 'chapterHeading': '3. Erstes Kapitel', 'topicIds': [ 'T001' ] },
            'topics': FIXTURE_TOPICS
        } )

        expect( out[ 'chapter' ] ).toBe( 3 )
        expect( out[ 'chapterSource' ] ).toBe( 'store' )
    } )


    it( 'ohne eigene Bindung, aber mit GENAU EINEM Kapitel in den gebundenen Topics ⇒ abgeleitet', () => {
        const out = MemoView.blockChapterBinding( {
            'block': { 'blockId': 'B010', 'chapter': null, 'topicIds': [ 'T001' ] },
            'topics': FIXTURE_TOPICS
        } )

        expect( out[ 'chapter' ] ).toBe( '3. Erstes Kapitel' )
        expect( out[ 'chapterSource' ] ).toBe( 'derived-from-topics' )
    } )


    it( 'AB-5: zwei verschiedene Kapitel in den gebundenen Topics ⇒ die Bindung bleibt NULL', () => {
        const out = MemoView.blockChapterBinding( {
            'block': { 'blockId': 'B011', 'chapter': null, 'topicIds': [ 'T001', 'T002' ] },
            'topics': FIXTURE_TOPICS
        } )

        // Vergleichsmenge: 1 Block, 2 Kandidaten. Ueber diese Bindung wird der Schnitt ganzer Phasen
        // gezogen — eine geratene waere schlimmer als eine fehlende.
        expect( out[ 'chapter' ] ).toBe( null )
        expect( out[ 'chapterSource' ] ).toBe( null )
        expect( out[ 'chapterReason' ] ).toContain( '2 verschiedene Kapitel' )
    } )


    it( 'AB-5: gar keine gebundene Topic mit Kapitel ⇒ NULL mit benanntem Grund, nicht mit Rateschluss', () => {
        const out = MemoView.blockChapterBinding( {
            'block': { 'blockId': 'B012', 'chapter': null, 'topicIds': [] },
            'topics': FIXTURE_TOPICS
        } )

        expect( out[ 'chapter' ] ).toBe( null )
        expect( out[ 'chapterSource' ] ).toBe( null )
        expect( out[ 'chapterReason' ] ).toContain( 'keine gebundene Topic' )
    } )


    it( 'die Rueckkante topic.blockId zaehlt mit — ein einseitig gepflegter Store sieht nicht unbunden aus', () => {
        const out = MemoView.blockChapterBinding( {
            'block': { 'blockId': 'B002', 'chapter': null, 'topicIds': [] },
            'topics': FIXTURE_TOPICS
        } )

        expect( out[ 'chapterSource' ] ).toBe( 'derived-from-topics' )
        expect( out[ 'chapter' ] ).toBe( '4. Zweites Kapitel' )
    } )
} )


// ============================================================================================
// 4. S4/AB-6 — die Leermengen-Meldung, und die Vakuum-Probe
// ============================================================================================
describe( 'PRD-13 S4/AB-6 — ein leerer Tab sagt, warum er leer ist', () => {

    it( 'AB-6: 0 Bloecke ⇒ "0 von N aus <Quelle>", mit N und benannter Quelle', () => {
        const out = MemoView.blockSourceEmptyState( {
            'count': 0,
            'available': 0,
            'sourceLabel': 'Block-Store /x/999-leer/blocks/B###/block.json',
            'legacyFenceCount': 0
        } )

        expect( out[ 'empty' ] ).toBe( true )
        expect( out[ 'kind' ] ).toBe( 'no-blocks' )
        expect( out[ 'reason' ] ).toContain( '0 von 0 aus ' )
        expect( out[ 'reason' ] ).toContain( 'Block-Store /x/999-leer/blocks/B###/block.json' )
    } )


    it( 'die Alt-Quelle wird als BEGRUENDUNG genannt, wenn das Markdown noch Zaeune traegt', () => {
        const out = MemoView.blockSourceEmptyState( {
            'count': 0,
            'available': 0,
            'sourceLabel': 'Block-Store /x/015/blocks/B###/block.json',
            'legacyFenceCount': 15
        } )

        expect( out[ 'reason' ] ).toContain( '15 block-meta-Fence(s)' )
        expect( out[ 'reason' ] ).toContain( 'Alt-Quelle' )
    } )


    it( 'eine unbenannte Quelle wird als unbenannt ausgewiesen, nicht stillschweigend weggelassen', () => {
        const out = MemoView.blockSourceEmptyState( { 'count': 0, 'available': 0, 'sourceLabel': '', 'legacyFenceCount': 0 } )

        expect( out[ 'reason' ] ).toContain( 'unbenannte Quelle' )
    } )


    it( 'mit Bloecken ist der Zustand NICHT leer', () => {
        const out = MemoView.blockSourceEmptyState( { 'count': 4, 'available': 4, 'sourceLabel': 'Block-Store', 'legacyFenceCount': 0 } )

        expect( out[ 'empty' ] ).toBe( false )
        expect( out[ 'kind' ] ).toBe( 'present' )
        expect( out[ 'reason' ] ).toBe( '' )
    } )


    it( 'VAKUUM-PROBE: ein Memo ohne Block-Store liefert 0 Zeilen UND die Leermengen-Meldung, kein gruenes Nichts', async () => {
        const memoDir = await writeFixtureMemo( {
            'name': '999-ohne-store',
            'topics': [],
            'blocks': [],
            'revision': REVISION_WITHOUT_FENCES
        } )
        const store = await MemoView.readTopicStore( { memoDir } )
        const tab = MemoView.blockStoreTabView( { 'blocks': store[ 'blocks' ], 'topics': store[ 'topics' ] } )
        const empty = MemoView.blockSourceEmptyState( {
            'count': tab[ 'blocks' ].length,
            'available': store[ 'blocks' ].length,
            'sourceLabel': 'Block-Store ' + memoDir + '/blocks/B###/block.json',
            'legacyFenceCount': 0
        } )

        expect( store[ 'blocks' ] ).toHaveLength( 0 )
        expect( tab[ 'counts' ][ 'blocks' ] ).toBe( 0 )
        // Die Vergleichsmenge ist 0 — und genau deshalb MUSS hier eine Meldung stehen. Eine Null ohne
        // Meldung waere der Ausgangszustand dieses Auftrags.
        expect( empty[ 'empty' ] ).toBe( true )
        expect( empty[ 'reason' ].length ).toBeGreaterThan( 0 )
        expect( empty[ 'reason' ] ).toContain( '0 von 0 aus ' )
    } )
} )


// ============================================================================================
// 5. Die Oberflaeche — was der Tab wirklich rendert
// ============================================================================================
describe( 'PRD-13 — der gerenderte Tab', () => {
    let fns = null
    let savedDocument = null

    beforeAll( async () => {
        fns = await extractFunctions( [
            'partitionBlocks',
            'blockChildHook',
            'blocksEmptyState',
            'buildEmptyState',
            'buildBlockItem',
            'renderBlockView'
        ] )
        savedDocument = globalThis.document
        globalThis.document = makeDocument( {} )
    } )

    afterAll( () => {
        globalThis.document = savedDocument
    } )


    const collectByAttr = ( node, attr ) => {
        const hits = []
        const walk = ( current ) => {
            if( current.getAttribute && current.getAttribute( attr ) !== null ) { hits.push( current ) }
            ;( current.children || [] ).forEach( walk )
        }
        walk( node )

        return hits
    }


    const payloadOf = () => {
        const tab = MemoView.blockStoreTabView( { 'blocks': FIXTURE_BLOCKS.map( projectBlock ), 'topics': FIXTURE_TOPICS } )

        return { 'status': 'ok', 'blocks': tab[ 'blocks' ], 'errors': [], 'counts': tab[ 'counts' ] }
    }


    it( 'AB-1-Analogon ohne Browser: 4 Datensaetze im Traeger ⇒ 4 gerenderte Karten', () => {
        const container = makeNode( 'DIV' )
        const root = fns.renderBlockView( payloadOf(), container )
        const cards = collectByAttr( root, 'data-block-id' )

        expect( cards ).toHaveLength( 4 )
        expect( cards.map( ( card ) => card.getAttribute( 'data-block-id' ) ).sort() ).toEqual( [ 'B001', 'B002', 'B003', 'B004' ] )
    } )


    it( 'AB-3 an der Oberflaeche: jede Karte traegt ihre Titel-Herkunft, und die fehlende sagt es in Worten', () => {
        const container = makeNode( 'DIV' )
        const root = fns.renderBlockView( payloadOf(), container )
        const titles = collectByAttr( root, 'data-block-title-source' )

        expect( titles ).toHaveLength( 4 )

        const bySource = titles
            .map( ( node ) => ( { 'source': node.getAttribute( 'data-block-title-source' ), 'text': node.textContent } ) )
        const missing = bySource.find( ( entry ) => entry[ 'source' ] === 'missing' )
        const derived = bySource.filter( ( entry ) => entry[ 'source' ] === 'derived' )
        const stored = bySource.filter( ( entry ) => entry[ 'source' ] === 'store' )

        expect( stored ).toHaveLength( 1 )
        expect( derived ).toHaveLength( 2 )
        expect( missing ).not.toBe( undefined )
        expect( missing[ 'text' ] ).toContain( 'kein Titel hinterlegt' )
        derived.forEach( ( entry ) => { expect( entry[ 'text' ] ).toContain( '(abgeleitet)' ) } )
    } )


    it( 'AB-4 an der Oberflaeche: die Quote steht MIT Nenner in der Flaeche', () => {
        const container = makeNode( 'DIV' )
        const root = fns.renderBlockView( payloadOf(), container )
        const counts = collectByAttr( root, 'data-block-chapter-bound' )

        expect( counts ).toHaveLength( 1 )
        expect( counts[ 0 ].getAttribute( 'data-block-chapter-bound' ) ).toBe( '4/4' )
        expect( counts[ 0 ].getAttribute( 'data-block-title-missing' ) ).toBe( '1/4' )
        expect( counts[ 0 ].textContent ).toContain( 'Kapitel-Bindung 4 von 4' )
    } )


    it( 'AB-5 an der Oberflaeche: eine fehlende Bindung ist als `none` sichtbar, nicht als leerer Text', () => {
        const unbound = [ { 'blockId': 'B011', 'topicIds': [ 'T001', 'T002' ], 'tags': [], 'title': 'Zwei Kapitel', 'chapter': null, 'chapterHeading': '', 'sections': {} } ]
        const tab = MemoView.blockStoreTabView( { 'blocks': unbound, 'topics': FIXTURE_TOPICS } )
        const container = makeNode( 'DIV' )
        const root = fns.renderBlockView( { 'blocks': tab[ 'blocks' ], 'errors': [], 'counts': tab[ 'counts' ] }, container )
        const marked = collectByAttr( root, 'data-block-chapter-binding' )

        expect( marked ).toHaveLength( 1 )
        expect( marked[ 0 ].getAttribute( 'data-block-chapter-binding' ) ).toBe( 'none' )
        expect( marked[ 0 ].getAttribute( 'data-block-chapter-source' ) ).toBe( 'none' )
    } )


    it( 'AB-6 an der Oberflaeche: die Leermengen-Meldung der Route erreicht die Flaeche im Wortlaut', () => {
        const emptyState = MemoView.blockSourceEmptyState( {
            'count': 0,
            'available': 0,
            'sourceLabel': 'Block-Store /x/999/blocks/B###/block.json',
            'legacyFenceCount': 7
        } )
        const container = makeNode( 'DIV' )
        const root = fns.renderBlockView( { 'blocks': [], 'errors': [], 'emptyState': emptyState }, container )
        const boxes = collectByAttr( root, 'data-empty-state' )

        expect( boxes ).toHaveLength( 1 )
        expect( boxes[ 0 ].textContent ).toContain( '0 von 0 aus ' )
        expect( boxes[ 0 ].textContent ).toContain( 'Block-Store /x/999/blocks/B###/block.json' )
        expect( boxes[ 0 ].textContent ).toContain( '7 block-meta-Fence(s)' )
    } )


    it( 'Rueckwaerts-Vertraeglichkeit: ein Nutzdatensatz OHNE emptyState faellt auf die alte Meldung zurueck', () => {
        const container = makeNode( 'DIV' )
        const root = fns.renderBlockView( { 'blocks': [], 'errors': [] }, container )
        const boxes = collectByAttr( root, 'data-empty-state' )

        expect( boxes ).toHaveLength( 1 )
        expect( boxes[ 0 ].textContent ).toContain( 'block-meta-Fence' )
    } )


    it( 'Rueckwaerts-Vertraeglichkeit: eine FENCE-Karte ohne titleSource bekommt keinen Titel-Knoten', () => {
        const container = makeNode( 'DIV' )
        const fence = [ { 'id': 'B500', 'chapter': '9. Zaun-Kapitel', 'topics': [ 'T900' ], 'tags': [], 'repos': [] } ]
        const root = fns.renderBlockView( { 'blocks': fence, 'errors': [] }, container )

        expect( collectByAttr( root, 'data-block-id' ) ).toHaveLength( 1 )
        expect( collectByAttr( root, 'data-block-title-source' ) ).toHaveLength( 0 )
        // und sie gruppiert weiterhin nach `chapter`, weil sie kein groupLabel traegt
        const headers = collectByAttr( root, 'data-block-chapter' )
        expect( headers.map( ( node ) => node.getAttribute( 'data-block-chapter' ) ) ).toEqual( [ '9. Zaun-Kapitel' ] )
    } )


    it( 'STORE-Karten gruppieren nach der lesbaren Kapitel-Ueberschrift, nicht nach der blossen Zahl', () => {
        const container = makeNode( 'DIV' )
        const root = fns.renderBlockView( payloadOf(), container )
        const headers = collectByAttr( root, 'data-block-chapter' )
            .map( ( node ) => node.getAttribute( 'data-block-chapter' ) )

        // 4 Bloecke, 4 verschiedene Kapitel: B001/B002 mit Ueberschrift, B003/B004 nur mit Zahl.
        expect( headers ).toEqual( [ '3. Erstes Kapitel', '4. Zweites Kapitel', '5', '6' ] )
    } )
} )


// ============================================================================================
// 6. Die inline-Spiegel und die Form
// ============================================================================================
describe( 'PRD-13 — Form und Spiegel', () => {

    it( 'die neuen Client-Zweige fahren ohne for/while — Array-Methoden, wie der Standard verlangt', async () => {
        const script = await readEmittedScript()
        const start = script.indexOf( 'function renderBlockView(' )
        expect( start ).toBeGreaterThan( -1 )

        const slice = script.slice( start, start + 4200 )
        expect( /\bfor\s*\(/.test( slice ) ).toBe( false )
        expect( /\bwhile\s*\(/.test( slice ) ).toBe( false )
    } )


    it( 'die vier neuen Statics sind oeffentlich und rein — kein Dateizugriff im Koerper', async () => {
        const source = await readMemoViewSource()
        const names = [ 'blockTitleResolution', 'blockChapterBinding', 'blockGroupLabel', 'blockStoreTabView', 'blockSourceEmptyState' ]

        // Vergleichsmenge: 5 Statics. Jede einzeln geprueft, damit sichtbar bleibt, WAS geprueft wurde.
        expect( names ).toHaveLength( 5 )
        names.forEach( ( name ) => {
            const at = source.indexOf( 'static ' + name + '(' )
            expect( at ).toBeGreaterThan( -1 )

            const body = source.slice( at, at + 2600 )
            expect( body.includes( 'readFile(' ) ).toBe( false )
            expect( body.includes( 'readdir(' ) ).toBe( false )
        } )
    } )
} )
