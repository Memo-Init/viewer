// RevisionFormScore.test.mjs — unit tests for the revision FORM score (Memo 080, PRD-Q1, WI-157).
//
// The suite is built around the two things the PRD calls load-bearing:
//   1. EVERY metric states what it counted over (`basis` + `basisLabel`), and a basis of 0 is a GAP
//      (value null, traffic "luecke", stated reason) — never 0 %, never 100 %, never green.
//   2. The four anti-gaming cases of evidence 25.11 really bite: stamping markers, invented
//      identifiers, chopping prose into bullets, and decorative diagrams.
//
// Pure engine, so every case is a literal document string — no fixtures, no file I/O, no order
// dependence between tests.

import { describe, test, expect } from '@jest/globals'

import { RevisionFormScore } from './RevisionFormScore.mjs'


const METRIC_IDS = [ 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9', 'K10' ]
const AXIS_IDS = [ 'belegtheit', 'lesbarkeit', 'vollstaendigkeit' ]

const PATH = '.memo/memos/099-probe/revisions/REV-07.md'

// A prose paragraph over the 400-character substance floor, used wherever a chapter has to carry
// real prose. Deterministic length, no randomness.
const substanceParagraph = ( { seed } ) => `Dieser Absatz traegt echte Substanz und erklaert den Sachverhalt ${ seed } zusammenhaengend statt in Stichpunkten. Er ist bewusst laenger als vierhundert Zeichen, damit er als Substanz-Absatz zaehlt und die Kennzahl K4 nicht kuenstlich klein haelt. Er beschreibt den Gegenstand, benennt die Grenze der Aussage und sagt, was daraus folgt, ohne die Erklaerung in eine Aufzaehlung zu zerlegen, die nur Behauptungen aneinanderreiht und den Zusammenhang verliert.`

// A well-formed chapter: all five contract sections, a verbatim user quote, an evidence level with
// a citation, a Belege table that declares that citation, a work-item id and a table.
const chapter = ( { number, title, citation } ) => [
    `## ${ number }. ${ title } [Code]`,
    '',
    '### User-Auftrag',
    '',
    `> „Bitte bau mir das ${ title } so, dass ich es waehrend des Schreibens sehen kann."`,
    '',
    '### Ist-Zustand',
    '',
    `- **[FAKT]** Der Bestand ist gemessen und liegt vor *(${ citation })*.`,
    '',
    substanceParagraph( { seed: title } ),
    '',
    '### Soll-Zustand',
    '',
    '| Feld | Wert |',
    '|---|---|',
    '| Ziel | erreichbar |',
    '',
    '### Belege',
    '',
    '| # | Aussage | Quelle | Work-Item |',
    '|---|---|---|---|',
    `| ${ citation } | Der Bestand ist gemessen | \`src/Probe.mjs:12\` | WI-157 |`,
    '',
    '### PRD-Zuordnung',
    '',
    '| PRD | Topics | Work-Items |',
    '|---|---|---|',
    '| PRD-Q1 | T102 | WI-157 |',
    ''
].join( '\n' )

const healthyDoc = [ '# Probe', '' ]
    .concat( chapter( { number: 1, title: 'Erstes Kapitel', citation: '1.1' } ) )
    .concat( chapter( { number: 2, title: 'Zweites Kapitel', citation: '2.1' } ) )
    .join( '\n' )

const scoreOf = ( { doc, fileName } ) => RevisionFormScore.score( { doc, fileName: fileName === undefined ? PATH : fileName } )


describe( 'the interface itself', () => {
    test( 'a healthy document scores with all ten metrics, three axes and three context figures', () => {
        const result = scoreOf( { doc: healthyDoc } )

        expect( result.status ).toBe( true )
        expect( Object.keys( result.metrics ).sort() ).toEqual( [ ...METRIC_IDS ].sort() )
        expect( Object.keys( result.axes ).sort() ).toEqual( [ ...AXIS_IDS ].sort() )
        expect( Object.keys( result.context ).sort() ).toEqual( [ 'aufzaehlungsAnteil', 'diagramme', 'umfang' ] )
    } )

    test( 'a non-string doc and a non-string fileName are the two loud error cases', () => {
        expect( RevisionFormScore.score( { doc: null, fileName: PATH } ) )
            .toEqual( { status: false, messages: [ 'doc: required string' ] } )
        expect( RevisionFormScore.score( { doc: 'x', fileName: 12 } ) )
            .toEqual( { status: false, messages: [ 'fileName: required string' ] } )
    } )
} )


describe( 'A3 — every metric carries its comparison set', () => {
    test.each( METRIC_IDS )( '%s states basis and basisLabel', ( id ) => {
        const metric = scoreOf( { doc: healthyDoc } ).metrics[ id ]

        expect( typeof metric.basis ).toBe( 'number' )
        expect( Number.isFinite( metric.basis ) ).toBe( true )
        expect( typeof metric.basisLabel ).toBe( 'string' )
        expect( metric.basisLabel.length ).toBeGreaterThan( 0 )
    } )

    test( 'the basis is the real count, not a placeholder — two chapters are reported as two', () => {
        const result = scoreOf( { doc: healthyDoc } )

        expect( result.metrics.K2.basis ).toBe( 2 )
        expect( result.metrics.K3.basis ).toBe( 2 )
        expect( result.metrics.K1.basis ).toBeGreaterThan( 100 )
    } )
} )


describe( 'A4 — basis 0 is a gap, never a number', () => {
    // One document per metric whose comparison set is empty. K1 needs an empty file, K3 a file
    // without a single evidence level, everything else a file without a numbered chapter.
    const emptyBasisDocs = {
        K1: '',
        K2: 'nur Fliesstext ohne jede Kapitel-Ueberschrift.',
        K3: [ '## 1. Kapitel ohne Marker', '', 'Fliesstext ohne Evidenz-Stufe.' ].join( '\n' ),
        K4: 'nur Fliesstext ohne jede Kapitel-Ueberschrift.',
        K5: '## 1. Kapitel nur mit Ueberschrift',
        K6: 'nur Fliesstext ohne jede Kapitel-Ueberschrift.',
        K7: 'nur Fliesstext ohne jede Kapitel-Ueberschrift.',
        K8: 'nur Fliesstext ohne jede Kapitel-Ueberschrift.',
        K9: 'nur Fliesstext ohne jede Kapitel-Ueberschrift.',
        K10: 'nur Fliesstext ohne jede Kapitel-Ueberschrift.'
    }

    test.each( METRIC_IDS )( '%s with an empty comparison set reports luecke with a reason', ( id ) => {
        const metric = scoreOf( { doc: emptyBasisDocs[ id ] } ).metrics[ id ]

        expect( metric.basis ).toBe( 0 )
        expect( metric.value ).toBeNull()
        expect( metric.traffic ).toBe( 'luecke' )
        expect( typeof metric.reason ).toBe( 'string' )
        expect( metric.reason.length ).toBeGreaterThan( 0 )
    } )

    test( 'K5 keeps its own comparison set — a chapterless file still measures paragraph length', () => {
        const result = scoreOf( { doc: 'Ein einzelner Absatz ohne Kapitel, der trotzdem eine Laenge hat.' } )

        expect( result.metrics.K5.basis ).toBe( 1 )
        expect( result.metrics.K5.traffic ).not.toBe( 'luecke' )
    } )
} )


describe( 'A5 — a marker-free document reports a gap on K3, not 0 and not 100', () => {
    test( 'no evidence level at all means nothing was compared', () => {
        const doc = [
            '## 1. Ohne jede Evidenz',
            '',
            'Hier steht Prosa, aber keine einzige Evidenz-Stufe und keine Beleg-Kennung.'
        ].join( '\n' )
        const metric = scoreOf( { doc } ).metrics.K3

        expect( metric.value ).toBeNull()
        expect( metric.value ).not.toBe( 0 )
        expect( metric.value ).not.toBe( 100 )
        expect( metric.traffic ).toBe( 'luecke' )
        expect( metric.reason ).toMatch( /kein Evidenz-Marker/ )
    } )
} )


describe( 'A6 — a document without chapters is a gap on every chapter-normalized metric', () => {
    const chapterless = [
        'Drei Zeilen ohne Kapitel.',
        '',
        'Kein einziges nummeriertes Kapitel, kein Marker, keine Tabelle.'
    ].join( '\n' )

    test.each( [ 'K2', 'K4', 'K6', 'K7', 'K8', 'K10' ] )( '%s is luecke, never green', ( id ) => {
        const metric = scoreOf( { doc: chapterless } ).metrics[ id ]

        expect( metric.traffic ).toBe( 'luecke' )
        expect( metric.traffic ).not.toBe( 'gruen' )
    } )

    test( 'the three-line probe reports no percentage at all and no green axis', () => {
        // The five percentage metrics all lose their comparison set here, so not one of them may
        // report 0 % or 100 %. K1 is deliberately NOT in this list: its comparison set is the word
        // count, which this file HAS — 0 markers in 12 words is a real measurement over a real
        // basis (exactly the evidence collapse 080/REV-03 showed), not a vacuum value.
        const result = scoreOf( { doc: chapterless } )
        const percentages = [ 'K2', 'K3', 'K7', 'K8', 'K10' ].map( ( id ) => result.metrics[ id ].value )

        expect( percentages.filter( ( value ) => value === 0 ) ).toEqual( [] )
        expect( percentages.filter( ( value ) => value === 100 ) ).toEqual( [] )
        expect( result.metrics.K1.basis ).toBeGreaterThan( 0 )
        expect( AXIS_IDS.map( ( id ) => result.axes[ id ].verdict ) ).toEqual( [ 'luecke', 'luecke', 'luecke' ] )
    } )
} )


describe( 'A7 — an axis with a gap can never be green', () => {
    test( 'one gap in an otherwise green axis pulls the axis verdict to luecke', () => {
        // Healthy chapters, but every citation removed: K3 loses its comparison set only if there is
        // no marker at all, so this variant keeps the markers and drops the chapters instead.
        const result = scoreOf( { doc: healthyDoc } )
        expect( result.axes.vollstaendigkeit.verdict ).toBe( 'gruen' )

        const withoutChapters = healthyDoc.replace( /^## \d+\. /gm, '### ' )
        const gapped = scoreOf( { doc: withoutChapters } )

        expect( gapped.metrics.K7.traffic ).toBe( 'luecke' )
        expect( gapped.axes.vollstaendigkeit.verdict ).toBe( 'luecke' )
        expect( gapped.axes.vollstaendigkeit.verdict ).not.toBe( 'gruen' )
    } )

    test( 'a gap outranks a red in the same axis — an axis that could not compare is not judged', () => {
        const doc = [
            '## 1. Kapitel ohne Marker und ohne Substanz',
            '',
            '- kurze Behauptung',
            '- noch eine'
        ].join( '\n' )
        const result = scoreOf( { doc } )

        expect( result.metrics.K1.traffic ).toBe( 'rot' )
        expect( result.metrics.K3.traffic ).toBe( 'luecke' )
        expect( result.axes.belegtheit.verdict ).toBe( 'luecke' )
    } )

    test( 'red on the Belegtheit axis is marked as not compensable', () => {
        const result = scoreOf( { doc: healthyDoc } )

        expect( result.axes.belegtheit.compensable ).toBe( false )
        expect( result.axes.lesbarkeit.compensable ).toBe( true )
        expect( result.axes.vollstaendigkeit.compensable ).toBe( true )
    } )
} )


describe( 'A8 — there is no overall grade', () => {
    test( 'the result carries no overall, total or grade field on any level', () => {
        const result = scoreOf( { doc: healthyDoc } )
        const forbidden = [ 'overall', 'total', 'totals', 'grade', 'score', 'percent' ]

        expect( Object.keys( result ).filter( ( key ) => forbidden.includes( key ) ) ).toEqual( [] )
        expect( Object.keys( result.axes ).filter( ( key ) => forbidden.includes( key ) ) ).toEqual( [] )
        METRIC_IDS.forEach( ( id ) => {
            expect( Object.keys( result.metrics[ id ] ).filter( ( key ) => forbidden.includes( key ) ) ).toEqual( [] )
        } )
    } )
} )


describe( 'A9 — the context figures carry no light', () => {
    test( 'bullet share, word count and diagram count are unlit and enter no axis', () => {
        const result = scoreOf( { doc: healthyDoc } );

        [ 'aufzaehlungsAnteil', 'umfang', 'diagramme' ].forEach( ( id ) => {
            expect( result.context[ id ].traffic ).toBeNull()
            expect( typeof result.context[ id ].basis ).toBe( 'number' )
            expect( result.context[ id ].basisLabel.length ).toBeGreaterThan( 0 )
        } )

        const axisMetrics = AXIS_IDS.flatMap( ( id ) => result.axes[ id ].metrics )
        expect( axisMetrics.sort() ).toEqual( [ ...METRIC_IDS ].sort() )
        expect( axisMetrics ).not.toContain( 'aufzaehlungsAnteil' )
    } )

    test( 'a decorative diagram changes no light at all (anti-gaming G4)', () => {
        const plain = scoreOf( { doc: healthyDoc } )
        const decorated = scoreOf( { doc: `${ healthyDoc }\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n` } )

        expect( decorated.context.diagramme.value ).toBe( plain.context.diagramme.value + 1 )
        expect( decorated.context.diagramme.traffic ).toBeNull()
        AXIS_IDS.forEach( ( id ) => {
            expect( decorated.axes[ id ].verdict ).toBe( plain.axes[ id ].verdict )
        } )
    } )
} )


describe( 'A12/A13 — the evidence apparatus cannot be faked', () => {
    // Anti-gaming G1 (evidence 25.11): 31 bullets stamped with an evidence level, no citation
    // anywhere. The marker count rises, the binding degree falls to 0 — and 0 is a REAL zero here,
    // because 31 markers ARE a comparison set.
    const stamped = [ '## 1. Gestempelt', '' ]
        .concat( Array.from( { length: 31 }, ( _, index ) => `- **[FAKT]** Behauptung Nummer ${ index + 1 }.` ) )
        .join( '\n' )

    test( 'A12: 31 stamped markers without a resolvable source drive K3 to 0 percent', () => {
        const metric = scoreOf( { doc: stamped } ).metrics.K3

        expect( metric.basis ).toBe( 31 )
        expect( metric.value ).toBe( 0 )
        expect( metric.traffic ).toBe( 'rot' )
        expect( metric.reason ).toBeNull()
    } )

    test( 'A13: invented identifiers are reported one by one with their line, not summed away', () => {
        const doc = [
            '## 1. Erfundene Kennungen',
            '',
            '- **[FAKT]** Erste Behauptung *(9.1)*.',
            '- **[FAKT]** Zweite Behauptung *(9.2)*.',
            '- **[FAKT]** Dritte Behauptung *(9.1)*.'
        ].join( '\n' )
        const result = scoreOf( { doc } )

        expect( result.unresolvedRefs ).toEqual( [
            { id: '9.1', line: 3 },
            { id: '9.2', line: 4 },
            { id: '9.1', line: 5 }
        ] )
        expect( result.metrics.K3.value ).toBe( 0 )
    } )

    test( 'a citation that resolves in a Belege table binds its marker', () => {
        const doc = [
            '## 1. Sauber belegt',
            '',
            '- **[FAKT]** Der Bestand ist gemessen *(1.1)*.',
            '',
            '### Belege',
            '',
            '| # | Aussage | Quelle |',
            '|---|---|---|',
            '| 1.1 | Der Bestand ist gemessen | `src/Probe.mjs:12` |'
        ].join( '\n' )
        const result = scoreOf( { doc } )

        expect( result.unresolvedRefs ).toEqual( [] )
        expect( result.metrics.K3.value ).toBe( 100 )
        expect( result.metrics.K3.traffic ).toBe( 'gruen' )
    } )
} )


describe( 'A14 — chopping prose into bullets is visible: K4 and the bullet share are opposed', () => {
    const prose = [
        '## 1. Zusammenhaengend erklaert',
        '',
        substanceParagraph( { seed: 'A' } ),
        '',
        substanceParagraph( { seed: 'B' } )
    ].join( '\n' )

    // The SAME content, only chopped: every sentence becomes its own bullet.
    const chopped = [
        '## 1. Zusammenhaengend erklaert',
        '',
        ...substanceParagraph( { seed: 'A' } ).split( '. ' ).map( ( part ) => `- ${ part }` ),
        ...substanceParagraph( { seed: 'B' } ).split( '. ' ).map( ( part ) => `- ${ part }` )
    ].join( '\n' )

    test( 'the substance metric collapses while the unlit bullet share rises', () => {
        const before = scoreOf( { doc: prose } )
        const after = scoreOf( { doc: chopped } )

        expect( before.metrics.K4.value ).toBeGreaterThanOrEqual( 0.8 )
        expect( before.metrics.K4.traffic ).toBe( 'gruen' )
        expect( after.metrics.K4.value ).toBe( 0 )
        expect( after.metrics.K4.traffic ).toBe( 'rot' )
        expect( after.context.aufzaehlungsAnteil.value ).toBeGreaterThan( before.context.aufzaehlungsAnteil.value )
        expect( after.context.aufzaehlungsAnteil.traffic ).toBeNull()
    } )
} )


describe( 'A15 — memoNo travels, no zone is applied', () => {
    test( 'the same document scores identically under memo 012 and memo 099', () => {
        const low = scoreOf( { doc: healthyDoc, fileName: '.memo/memos/012-alt/revisions/REV-03.md' } )
        const high = scoreOf( { doc: healthyDoc, fileName: '.memo/memos/099-neu/revisions/REV-03.md' } )

        expect( low.memoNo ).toBe( 12 )
        expect( high.memoNo ).toBe( 99 )
        expect( low.metrics ).toEqual( high.metrics )
        expect( low.axes ).toEqual( high.axes )
    } )

    test( 'the flat legacy layout resolves too, and a path without a memo folder yields null', () => {
        expect( scoreOf( { doc: healthyDoc, fileName: '.memo/080-slug/REV-01.md' } ).memoNo ).toBe( 80 )
        expect( scoreOf( { doc: healthyDoc, fileName: 'REV-01.md' } ).memoNo ).toBeNull()
    } )

    test( 'a three-digit FILE name is not read as a memo number — only directories are', () => {
        expect( scoreOf( { doc: healthyDoc, fileName: '081-notiz.md' } ).memoNo ).toBeNull()
    } )
} )


describe( 'A16 — the rendering states value, light, threshold AND comparison set', () => {
    test( 'the head line, the ten rows and the context line are present', () => {
        const render = scoreOf( { doc: healthyDoc } ).render

        expect( render.startsWith( '[EVAL] Revisions-Qualitaet REV-07 — ' ) ).toBe( true )
        expect( render ).toContain( 'Belegtheit' )
        expect( render ).toContain( 'Kennzahl' )
        expect( render ).toContain( 'Grundlage' )
        METRIC_IDS.forEach( ( id ) => {
            expect( render ).toMatch( new RegExp( `^  ${ id } .*Kapitel|^  ${ id } .*Woerter|^  ${ id } .*Absaetze|^  ${ id } .*Evidenz-Marker`, 'm' ) )
        } )
        expect( render ).toContain( 'Kontext (ohne Ampel): Aufzaehlungs-Anteil' )
        expect( render ).toContain( 'Gesamt-Umfang' )
        expect( render ).toContain( 'Anzahl Diagramme' )
    } )

    test( 'a red axis produces exactly one [WARNING] line, a gap axis says what was missing', () => {
        const red = scoreOf( { doc: [
            '## 1. Rot auf der Belegtheit',
            '',
            '- **[FAKT]** Behauptung ohne Quelle.',
            '',
            substanceParagraph( { seed: 'R' } ),
            '',
            '| a | b |',
            '|---|---|',
            '| 1 | 2 |'
        ].join( '\n' ) } )

        expect( red.axes.belegtheit.verdict ).toBe( 'rot' )
        expect( red.render.split( '\n' ).filter( ( line ) => line.startsWith( '[WARNING] Belegtheit rot' ) ) ).toHaveLength( 1 )
        expect( red.render ).toContain( 'Nicht kompensierbar.' )
        expect( red.render ).toContain( 'Hinweis, kein Verbot.' )

        const gap = scoreOf( { doc: 'Drei Zeilen ohne Kapitel und ohne Marker.' } )
        expect( gap.render ).toContain( '[WARNING] Lesbarkeit luecke' )
        expect( gap.render ).toContain( 'Ein gruener Wert ohne Vergleichsmenge waere ein Fehler' )
    } )

    test( 'unresolved identifiers appear individually in the rendering', () => {
        const render = scoreOf( { doc: [
            '## 1. Erfunden',
            '',
            '- **[FAKT]** Behauptung *(7.3)*.'
        ].join( '\n' ) } ).render

        expect( render ).toContain( 'Beleg-Kennungen ohne Aufloesung: 7.3 (Zeile 3)' )
    } )
} )


describe( 'the metrics behave as chapter 25 calibrated them', () => {
    test( 'K1 lights green at 4.6, yellow at 1.8 and red below', () => {
        const words = ( { count } ) => Array.from( { length: count }, ( _, index ) => `wort${ index }` ).join( ' ' )
        const withMarkers = ( { markers, count } ) => [
            '## 1. Dichte',
            '',
            ...Array.from( { length: markers }, ( _, index ) => `- **[FAKT]** Aussage ${ index }.` ),
            '',
            words( { count } )
        ].join( '\n' )

        expect( scoreOf( { doc: withMarkers( { markers: 10, count: 1000 } ) } ).metrics.K1.traffic ).toBe( 'gruen' )
        expect( scoreOf( { doc: withMarkers( { markers: 10, count: 4000 } ) } ).metrics.K1.traffic ).toBe( 'gelb' )
        expect( scoreOf( { doc: withMarkers( { markers: 1, count: 4000 } ) } ).metrics.K1.traffic ).toBe( 'rot' )
    } )

    test( 'K5 is a band, not a "more is better" metric — a text wall is red like a telegram', () => {
        const telegram = 'Kurz.'
        const wall = 'Wort '.repeat( 120 ).trim()

        expect( scoreOf( { doc: telegram } ).metrics.K5.traffic ).toBe( 'rot' )
        expect( scoreOf( { doc: wall } ).metrics.K5.traffic ).toBe( 'rot' )
        expect( scoreOf( { doc: 'Wort '.repeat( 50 ).trim() } ).metrics.K5.traffic ).toBe( 'gruen' )
    } )

    test( 'K9 counts content-replacing back-references and ignores plain provenance', () => {
        const replacing = [
            '## 1. Zeiger statt Inhalt',
            '',
            '*(unveraendert aus REV-01 — Ist-Zustand und Grenzen)*',
            '',
            'Der Rest steht wie in REV-02 beschrieben.',
            '',
            'Ebenfalls unveraendert aus REV-03.'
        ].join( '\n' )
        const provenance = [
            '## 1. Herkunft benannt',
            '',
            'Die Entscheidung F23=A fiel in REV-04 und wird hier vollstaendig ausgeschrieben.'
        ].join( '\n' )

        expect( scoreOf( { doc: replacing } ).metrics.K9.value ).toBe( 3 )
        expect( scoreOf( { doc: replacing } ).metrics.K9.traffic ).toBe( 'rot' )
        expect( scoreOf( { doc: provenance } ).metrics.K9.value ).toBe( 0 )
        expect( scoreOf( { doc: provenance } ).metrics.K9.traffic ).toBe( 'gruen' )
    } )

    test( 'K9 does not read a table row as a content-replacing reference', () => {
        const doc = [
            '## 1. Datenzeile',
            '',
            '| WI | Text |',
            '|---|---|',
            '| WI-097 | Schwellen unveraendert aus REV-02 uebernommen |'
        ].join( '\n' )

        expect( scoreOf( { doc } ).metrics.K9.value ).toBe( 0 )
    } )

    test( 'K8 needs all five contract sections — four of five is not fulfilled', () => {
        const four = healthyDoc.replace( /^### PRD-Zuordnung$/m, '### Anhang' )

        expect( scoreOf( { doc: healthyDoc } ).metrics.K8.value ).toBe( 100 )
        expect( scoreOf( { doc: four } ).metrics.K8.value ).toBe( 50 )
    } )

    test( 'K7 needs a verbatim quote with substance, not a quoted single term', () => {
        const short = healthyDoc.replace( /„[^“”"]+["“”]/g, '„kurz"' )

        expect( scoreOf( { doc: healthyDoc } ).metrics.K7.value ).toBe( 100 )
        expect( scoreOf( { doc: short } ).metrics.K7.value ).toBe( 0 )
    } )

    test( 'K10 counts chapters that bind a work item', () => {
        const half = healthyDoc.replace( /WI-157/g, ( () => {
            let seen = 0

            return ( match ) => {
                seen = seen + 1

                return seen <= 2 ? match : 'ohne Bindung'
            }
        } )() )

        expect( scoreOf( { doc: healthyDoc } ).metrics.K10.value ).toBe( 100 )
        expect( scoreOf( { doc: half } ).metrics.K10.value ).toBe( 50 )
    } )

    test( 'a CRLF document measures the same as an LF document — no vacuum gaps', () => {
        const lf = scoreOf( { doc: healthyDoc } )
        const crlf = scoreOf( { doc: healthyDoc.split( '\n' ).join( '\r\n' ) } )

        expect( crlf.metrics.K2.basis ).toBe( lf.metrics.K2.basis )
        expect( crlf.metrics.K8.value ).toBe( lf.metrics.K8.value )
    } )
} )
