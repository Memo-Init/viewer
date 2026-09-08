// RevisionFormScore.mjs — the deterministic FORM score of a revision file (Memo 080, PRD-Q1,
// chapter 25 "Qualitaets-Kennzahlen fuer Memos", WI-157).
//
// WHAT THIS IS. Ten metrics K1..K10 on three axes plus three context figures without a light.
// It measures the FORM of a revision — how evidenced, how readable, how complete it is — and it
// measures it WHILE the revision is being written, not at the end. The calibration behind the
// thresholds rests on 305 revision files from 78 memos (context/research-qualitaets-kennzahlen.md);
// this module takes the thresholds from chapter 25 verbatim and derives none of its own.
//
// THE LOAD-BEARING RULE: a metric states WHAT IT COUNTED OVER. Every metric carries `basis` (the
// comparison set it divided by) and `basisLabel` (what that set is called). A basis of 0 is NOT a
// zero result and not a full one — it is a GAP: `value: null`, `traffic: 'luecke'`, plus a stated
// reason. A green value without a comparison set is an error, not a success.
//
// BOTH SIDES OF THE FRACTION TRAVEL (ADDITIVE, Memo 080 PRD-Q4): `numerator` is the counted side
// the metric divided, `basis` the side it divided BY. It is emitted here — where the counting
// happens — and nowhere else, so a consumer that has to keep the anti-gaming counter-conditions
// readable at its own record (the metric store) never has to recompute a metric to learn them. A
// second derivation of the numerator, from a value that was already rounded for display, would be
// a number nobody measured.
//
// NO OVERALL GRADE. Aggregating the lights is measurably misleading: REV-03 of memo 080 (evidence
// collapse, 5 markers on 28.621 words) reaches 73 % and beats the praised REV-01 (60 %), because
// eight green structural values outvote the collapse (chapter 25, evidence 25.8). The verdict is
// therefore given PER AXIS, and red on the evidence axis is marked `compensable: false`.
//
// NOT MEASURED HERE, ON PURPOSE. The bullet share has an effect size of -0.10 — it does not
// separate quality at all and would have marked the praised REV-01 red (evidence 25.7). It stays
// in the output as a CONTEXT figure with no light and no verdict contribution, together with the
// total word count and the number of diagrams.
//
// PURE. No file I/O, no store, no database, no import of any kind — the module deliberately has no
// import statement, so the "it writes nowhere" assertion is decidable by reading the source. The
// caller reads the file and passes the text in. Same text plus same path -> same result.
//
// SCOPE BOUNDARY. This module CALCULATES. It does not display (PRD-Q3), it does not persist
// (PRD-Q4) and it applies no cut-off zone (PRD-Q5) — `memoNo` travels in the result so PRD-Q5 can
// zone the lights later, but nothing here reads it. `score( { doc, fileName } )` is the one
// interface Q3, Q4 and Q5 consume; it may only ever be extended additively.
//
// House style: static methods with object parameters and object returns, no loops, no silent
// defaults, single quotes, no semicolons, comments in English.


// Memo 081, WI-116: the chapter contract is READ from the one register instead of being typed out a
// fourth time (see CONTRACT_SECTIONS below). BlockSections is pure — no file access, no state — so this
// module stays a pure function of its input.
import { BlockSections } from './BlockSections.mjs'


// The closed German six-set of evidence levels, identical to the set the markdown form lint
// (MarkdownFormLint, PRD-B2) enforces. Counting only [FAKT]/[ANNAHME]/[VERMUTUNG] would close the
// case instead of the class; measured on the three calibration files (080/REV-01, REV-03, REV-04)
// the other three levels occur exactly 0 times, so the calibrated thresholds are unaffected.
const EVIDENCE_LEVELS = [ 'FAKT', 'GEMESSEN', 'ANNAHME', 'ABGELEITET', 'VERMUTUNG', 'UNBEKANNT' ]

const EVIDENCE_MARKER = new RegExp( `\\[(?:${ EVIDENCE_LEVELS.join( '|' ) })\\]`, 'g' )
const EVIDENCE_PRESENT = new RegExp( `\\[(?:${ EVIDENCE_LEVELS.join( '|' ) })\\]` )

// A chapter is a NUMBERED level-2 heading ("## 14. Vollstaendigkeit ..."). The unnumbered level-2
// sections of a revision (Kontext, Vorwort, Offene Fragen, Phasen ...) are apparatus, not chapters
// — measured against the stock this definition reproduces the chapter counts of the calibration
// (080/REV-01 = 19, REV-03 = 24, REV-04 = 24).
const CHAPTER_HEADING = /^##\s+\d+\.\s+\S/
const HEADING = /^(#{1,6})\s+(.*)$/
// A chapter ends at the next heading of level 1 or 2 — the next chapter OR the first apparatus
// section after it. Without this a trailing "## Vorwort" would be counted into the last chapter.
const CHAPTER_END = /^#{1,2}\s+\S/

const FENCE = /^\s*```/
const MERMAID_FENCE = /^\s*```\s*mermaid\b/
const TABLE_ROW = /^\s*\|/
const BULLET = /^\s*[-*+]\s+/
const ORDERED_BULLET = /^\s*\d+[.)]\s+/
const THEMATIC_BREAK = /^\s*([-*_])(\s*\1){2,}\s*$/
const HTML_LINE = /^\s*<\/?[a-zA-Z]/
const BLOCKQUOTE = /^\s*>/

// A cited piece of evidence: the "*(25.11)*" form the memo convention uses at the end of a bullet.
const CITATION = /\*\((\d+\.\d+)\)\*/g
// A declared piece of evidence: the row head "| 25.11 |" of a Belege table.
const DECLARATION = /^\s*\|\s*(\d+\.\d+)\s*\|/

// A source anchor that makes a chapter evidenced even without an evidence level: a footnote
// reference, a citation, or the chapter's own Belege section.
const FOOTNOTE_REF = /\[\^[^\]]+\]/
const BELEGE_HEADING = /^###\s+Belege\b/

// The mandatory section headings of the chapter contract. The naming follows the canonical spelling the
// form lint enforces (FR-06): the bare name, optionally qualified after a colon.
//
// Memo 081, WI-116: this list WAS the contract's fourth copy — five of the memo's building blocks, with
// `### PRD-Zuordnung` as the fifth, while the memo's contract has named `### Abhaengigkeiten` since
// REV-15. It is now DERIVED from BlockSections.chapterContract(), the one register, so a contract change
// lands here by construction instead of by somebody remembering this file. The list grows from 5 to 8
// blocks, so K8 (the contracted share) measures a STRICTER duty than before: a value that drops is a
// more correct answer, not a regression, and both numbers are reported rather than one frozen.
const CONTRACT_SECTIONS = BlockSections.chapterContract().contract
    .filter( ( entry ) => entry[ 'required' ] === true )
    .map( ( entry ) => new RegExp( `^###\\s+${ entry[ 'heading' ] }\\b` ) )

// A verbatim user quote: the German OPENING quotation mark, real content, then a closing mark.
// Both closing forms are accepted — measured over the stock the revisions open with „ (U+201E) and
// close with the plain " (U+0022) far more often than with " (U+201D), so accepting only the
// typographic pair would close the case instead of the class and report 0 % on every real file.
// Twenty characters is the floor that keeps a quoted single term from passing as a quoted assignment.
const VERBATIM_QUOTE = /„[^„“”"]{20,}[“”"]/

const WORK_ITEM_ID = /\bWI-\d+\b/

// A reference to an earlier revision, and the closed list of German cues that turn such a
// reference into a CONTENT-REPLACING one ("unveraendert aus REV-01"). A bare mention of a revision
// is provenance and is fine; only the combination replaces substance with a pointer (chapter 14).
const REVISION_REF = /\bREV-\d{2}\b/
const REPLACEMENT_CUES = [
    'unveraendert', 'unverändert', 'wie in rev', 'wie rev', 'siehe rev', 'vgl. rev',
    'gilt weiterhin', 'bleibt gueltig', 'bleibt gültig', 'gueltig aus', 'gültig aus',
    'gueltig (rev', 'gültig (rev', 'uebernommen aus', 'übernommen aus', 'wie oben', 'wie bisher'
]

// A prose paragraph counts as SUBSTANCE from this length on (chapter 25 / research 3.K5).
const SUBSTANCE_PARAGRAPH = 400

// The three axes. `compensable: false` on the evidence axis is the construction decision of
// chapter 25: red there is never outweighed by green elsewhere.
const AXES = {
    belegtheit: { label: 'Belegtheit', compensable: false, metrics: [ 'K1', 'K2', 'K3' ] },
    lesbarkeit: { label: 'Lesbarkeit', compensable: true, metrics: [ 'K4', 'K5', 'K6' ] },
    vollstaendigkeit: { label: 'Vollstaendigkeit', compensable: true, metrics: [ 'K7', 'K8', 'K9', 'K10' ] }
}

const AXIS_IDS = [ 'belegtheit', 'lesbarkeit', 'vollstaendigkeit' ]
const METRIC_IDS = [ 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9', 'K10' ]

// The metric catalogue — the ONE place that says which metrics exist, what they are called, which
// axis they belong to, how they are rounded, and where their light changes. Every threshold is
// taken verbatim from chapter 25 of memo 080. The only addition is the LOWER half of K5's band
// (< 150 red, 150-200 yellow): chapter 25 abbreviates the row to the green window and the upper
// half, the full band stands in research 3.K6 that the chapter condenses.
const METRICS = {
    K1: {
        label: 'Evidenz-Dichte', axis: 'belegtheit', digits: 1, unit: 'je 1000 Woerter',
        threshold: '>= 4.6 je 1000 Woerter', basisLabel: 'Woerter',
        gap: 'kein Wort im Dokument — es gibt nichts, worauf sich eine Dichte beziehen koennte',
        hint: 'Die Aussagen sind nicht als Fakt oder Annahme klassifiziert — beim Lesen ist nicht unterscheidbar, was gemessen und was vermutet ist.',
        traffic: ( value ) => value >= 4.6 ? 'gruen' : ( value >= 1.8 ? 'gelb' : 'rot' )
    },
    K2: {
        label: 'Belegfreie Kapitel', axis: 'belegtheit', digits: 1, unit: '%',
        threshold: '<= 10 %', basisLabel: 'Kapitel',
        gap: 'kein nummeriertes Kapitel im Dokument — es gibt keine Kapitel, die belegfrei sein koennten',
        hint: 'Die Recherche ist ungleich verteilt — einzelne Kapitel sind reine Behauptung.',
        traffic: ( value ) => value <= 10 ? 'gruen' : ( value <= 35 ? 'gelb' : 'rot' )
    },
    K3: {
        label: 'Beleg-Bindungsgrad', axis: 'belegtheit', digits: 1, unit: '%',
        threshold: '>= 80 %', basisLabel: 'Aussagen mit Evidenz-Marker',
        gap: 'kein Evidenz-Marker im Dokument — es gibt keine Aussage, deren Bindung gepruefft werden koennte',
        hint: 'Fakten stehen ohne pruefbare Quelle da — eine Aussage ohne aufloesende Beleg-Kennung ist nicht nachpruefbar.',
        traffic: ( value ) => value >= 80 ? 'gruen' : ( value >= 50 ? 'gelb' : 'rot' )
    },
    K4: {
        label: 'Substanz-Absaetze je Kapitel', axis: 'lesbarkeit', digits: 2, unit: '',
        threshold: '>= 0.8 je Kapitel', basisLabel: 'Kapitel',
        gap: 'kein nummeriertes Kapitel im Dokument — es gibt nichts, worauf sich ein Wert je Kapitel beziehen koennte',
        hint: 'Die Kapitel behaupten in Stichpunkten, ohne irgendwo zusammenhaengend zu erklaeren.',
        traffic: ( value ) => value >= 0.8 ? 'gruen' : ( value >= 0.3 ? 'gelb' : 'rot' )
    },
    K5: {
        label: 'Durchschnittliche Absatzlaenge', axis: 'lesbarkeit', digits: 0, unit: 'Zeichen',
        threshold: '200-350 Zeichen', basisLabel: 'Absaetze',
        gap: 'kein Prosa-Absatz im Dokument — es gibt keinen Absatz, dessen Laenge gemittelt werden koennte',
        hint: 'Unter 150 Zeichen Telegrammstil ohne Erklaerung, ueber 450 Zeichen Textwand.',
        traffic: ( value ) => {
            if( value >= 200 && value <= 350 ) { return 'gruen' }
            if( value >= 150 && value <= 450 ) { return 'gelb' }

            return 'rot'
        }
    },
    K6: {
        label: 'Tabellen je Kapitel', axis: 'lesbarkeit', digits: 2, unit: '',
        threshold: '>= 0.8 je Kapitel', basisLabel: 'Kapitel',
        gap: 'kein nummeriertes Kapitel im Dokument — es gibt nichts, worauf sich ein Wert je Kapitel beziehen koennte',
        hint: 'Die Kapitel zeigen ihre Daten als Fliesstext statt als Tabelle.',
        traffic: ( value ) => value >= 0.8 ? 'gruen' : ( value >= 0.4 ? 'gelb' : 'rot' )
    },
    K7: {
        label: 'Kapitel mit woertlichem User-Auftrag', axis: 'vollstaendigkeit', digits: 1, unit: '%',
        threshold: '>= 90 %', basisLabel: 'Kapitel',
        gap: 'kein nummeriertes Kapitel im Dokument — es gibt keine Kapitel, die einen User-Auftrag tragen koennten',
        hint: 'Es ist nicht nachvollziehbar, welche Kapitel auf eine echte User-Aussage zurueckgehen und welche hinzuerfunden sind.',
        traffic: ( value ) => value >= 90 ? 'gruen' : ( value >= 60 ? 'gelb' : 'rot' )
    },
    K8: {
        label: 'Kapitel-Vertrag erfuellt', axis: 'vollstaendigkeit', digits: 1, unit: '%',
        threshold: '>= 90 %', basisLabel: 'Kapitel',
        gap: 'kein nummeriertes Kapitel im Dokument — es gibt keine Kapitel, deren Vertrag gepruefft werden koennte',
        hint: 'Die Kapitel sind formal uneinheitlich und maschinell nicht auswertbar.',
        traffic: ( value ) => value >= 90 ? 'gruen' : ( value >= 60 ? 'gelb' : 'rot' )
    },
    K9: {
        label: 'Inhalts-ersetzende Rueckverweise', axis: 'vollstaendigkeit', digits: 0, unit: '',
        threshold: '0 Verweise', basisLabel: 'gepruefte Kapitel',
        gap: 'kein nummeriertes Kapitel im Dokument — es wurde kein Kapitel auf Rueckverweise geprueft',
        hint: 'Ein Kapitel ersetzt seinen Inhalt durch einen Zeiger auf eine fruehere Revision; die Revision ist nicht mehr eigenstaendig.',
        traffic: ( value ) => value === 0 ? 'gruen' : ( value <= 2 ? 'gelb' : 'rot' )
    },
    K10: {
        label: 'Work-Item-Bindung', axis: 'vollstaendigkeit', digits: 1, unit: '%',
        threshold: '>= 90 %', basisLabel: 'Kapitel',
        gap: 'kein nummeriertes Kapitel im Dokument — es gibt keine Kapitel, die ein Work-Item binden koennten',
        hint: 'Die Kapitel haengen nicht am Datenmodell — sie lassen sich weder in PRDs noch in Work-Items ueberfuehren.',
        traffic: ( value ) => value >= 90 ? 'gruen' : ( value >= 60 ? 'gelb' : 'rot' )
    }
}

// The context figures — calculated, shown, never lit. Their `traffic` is null by construction.
const CONTEXT_FIGURES = {
    aufzaehlungsAnteil: { label: 'Aufzaehlungs-Anteil', digits: 1, unit: '%', basisLabel: 'Inhaltszeilen' },
    umfang: { label: 'Gesamt-Umfang', digits: 0, unit: 'Woerter', basisLabel: 'Woerter' },
    diagramme: { label: 'Anzahl Diagramme', digits: 0, unit: '', basisLabel: 'Diagramme' }
}

const CONTEXT_IDS = [ 'aufzaehlungsAnteil', 'umfang', 'diagramme' ]

// Verdict precedence per axis. `luecke` sits ABOVE red on purpose: an axis whose comparison set is
// missing cannot be certified at all, and it can never be green.
const VERDICT_ORDER = [ 'gruen', 'gelb', 'rot', 'luecke' ]


class RevisionFormScore {
    static score( { doc, fileName } ) {
        // No silent defaults: both arguments are required. An empty document is a legal input that
        // reports gaps everywhere, not a failure.
        if( typeof doc !== 'string' ) {
            return { status: false, messages: [ 'doc: required string' ] }
        }
        if( typeof fileName !== 'string' ) {
            return { status: false, messages: [ 'fileName: required string' ] }
        }

        // Split on EVERY line ending. A CRLF file would otherwise keep a trailing "\r" on each line,
        // and "\r" terminates a JavaScript regex line, so "$"-anchored patterns stop matching and
        // every heading-anchored metric silently reports basis 0 — a vacuum gap instead of a result.
        const lines = doc.split( /\r\n|\r|\n/ )
        const fenced = RevisionFormScore.#fenceMap( { lines } )
        const chapters = RevisionFormScore.#chapters( { lines, fenced } )
        const paragraphs = RevisionFormScore.#paragraphs( { lines, fenced } )
        const evidence = RevisionFormScore.#evidence( { lines, fenced } )
        const counts = RevisionFormScore.#counts( { doc, lines, fenced } )

        const metrics = RevisionFormScore.#metrics( { chapters, paragraphs, evidence, counts } )
        const axes = RevisionFormScore.#axes( { metrics } )
        const context = RevisionFormScore.#context( { counts } )

        const render = RevisionFormScore.#render( {
            fileName, axes, metrics, context, unresolvedRefs: evidence.unresolved
        } )

        return {
            status: true,
            memoNo: RevisionFormScore.#memoNo( { fileName } ),
            axes,
            metrics,
            context,
            unresolvedRefs: evidence.unresolved,
            render
        }
    }


    // ---- structure -----------------------------------------------------------------

    // #fenceMap — per line: does it sit inside a fenced code block? The fence line itself counts as
    // fenced, so a "```" is never read as content.
    static #fenceMap( { lines } ) {
        return lines.reduce( ( acc, line ) => {
            const isFence = FENCE.test( line )
            acc.rows.push( acc.open === true || isFence === true )
            acc.open = isFence === true ? acc.open === false : acc.open

            return acc
        }, { open: false, rows: [] } ).rows
    }


    // #chapters — the numbered level-2 sections with their body lines. A chapter runs until the next
    // heading of level 1 or 2, so an apparatus section ("## Vorwort") ends the last chapter instead
    // of being swallowed by it.
    static #chapters( { lines, fenced } ) {
        const starts = lines
            .map( ( line, index ) => ( { line, index } ) )
            .filter( ( entry ) => fenced[ entry.index ] === false )
            .filter( ( entry ) => CHAPTER_HEADING.test( entry.line ) === true )

        return starts.map( ( entry ) => {
            const following = lines
                .map( ( line, index ) => ( { line, index } ) )
                .filter( ( candidate ) => candidate.index > entry.index )
                .filter( ( candidate ) => fenced[ candidate.index ] === false )
                .filter( ( candidate ) => CHAPTER_END.test( candidate.line ) === true )
            const end = following.length === 0 ? lines.length : following[ 0 ].index

            return {
                start: entry.index,
                end,
                heading: entry.line.trim(),
                lines: lines.slice( entry.index, end ),
                fencedRows: fenced.slice( entry.index, end ),
                text: lines.slice( entry.index, end ).join( '\n' )
            }
        } )
    }


    // #paragraphs — the prose paragraphs of the WHOLE document. Headings, tables, bullets, block
    // quotes, thematic breaks, html and fenced code are not prose and end a run. Document-scoped on
    // purpose: K5 (average paragraph length) must stay measurable in a file without any chapter.
    static #paragraphs( { lines, fenced } ) {
        const grouped = lines.reduce( ( acc, line, index ) => {
            if( RevisionFormScore.#isProseLine( { line, fenced: fenced[ index ] } ) === true ) {
                acc.current.push( { text: line.trim(), index } )

                return acc
            }

            if( acc.current.length > 0 ) { acc.blocks.push( acc.current ) }
            acc.current = []

            return acc
        }, { blocks: [], current: [] } )

        const blocks = grouped.current.length > 0 ? [ ...grouped.blocks, grouped.current ] : grouped.blocks

        return blocks.map( ( block ) => ( {
            index: block[ 0 ].index,
            text: block.map( ( entry ) => entry.text ).join( ' ' )
        } ) )
    }


    static #isProseLine( { line, fenced } ) {
        if( fenced === true ) { return false }

        const trimmed = line.trim()
        if( trimmed.length === 0 ) { return false }
        if( HEADING.test( trimmed ) === true ) { return false }
        if( TABLE_ROW.test( trimmed ) === true ) { return false }
        if( BLOCKQUOTE.test( trimmed ) === true ) { return false }
        if( THEMATIC_BREAK.test( trimmed ) === true ) { return false }
        if( BULLET.test( trimmed ) === true ) { return false }
        if( ORDERED_BULLET.test( trimmed ) === true ) { return false }
        if( HTML_LINE.test( trimmed ) === true ) { return false }

        return true
    }


    // ---- evidence apparatus --------------------------------------------------------

    // #evidence — the marker/citation/declaration triple K1, K2 and K3 rest on.
    //
    // A marker is BOUND when its own line carries at least one citation that RESOLVES as the row
    // head of a Belege table. That is the anti-gaming condition of evidence 25.11: stamping bullets
    // with [FAKT] raises the marker count and drives the binding degree to 0 %, and invented
    // identifiers are reported one by one instead of only being counted.
    static #evidence( { lines, fenced } ) {
        const declared = lines
            .filter( ( line, index ) => fenced[ index ] === false )
            .map( ( line ) => line.match( DECLARATION ) )
            .filter( ( match ) => match !== null )
            .map( ( match ) => match[ 1 ] )
        const declaredSet = new Set( declared )

        const markerLines = lines
            .map( ( line, index ) => ( { line, index } ) )
            .filter( ( entry ) => fenced[ entry.index ] === false )
            .map( ( entry ) => ( {
                index: entry.index,
                markers: ( entry.line.match( EVIDENCE_MARKER ) || [] ).length,
                citations: [ ...entry.line.matchAll( CITATION ) ].map( ( hit ) => hit[ 1 ] )
            } ) )
            .filter( ( entry ) => entry.markers > 0 )

        const markers = markerLines.reduce( ( sum, entry ) => sum + entry.markers, 0 )
        const bound = markerLines
            .filter( ( entry ) => entry.citations.some( ( id ) => declaredSet.has( id ) === true ) )
            .reduce( ( sum, entry ) => sum + entry.markers, 0 )

        // Every citation in the document is held against the declarations — not only the ones that
        // sit on a marker line, because an invented identifier is a defect wherever it stands.
        const unresolved = lines
            .map( ( line, index ) => ( { line, index } ) )
            .filter( ( entry ) => fenced[ entry.index ] === false )
            .flatMap( ( entry ) => [ ...entry.line.matchAll( CITATION ) ]
                .map( ( hit ) => ( { id: hit[ 1 ], line: entry.index + 1 } ) ) )
            .filter( ( citation ) => declaredSet.has( citation.id ) === false )

        return { markers, bound, declared: declaredSet.size, unresolved }
    }


    // ---- raw counts ----------------------------------------------------------------

    static #counts( { doc, lines, fenced } ) {
        const words = doc.split( /\s+/ ).filter( ( token ) => token.length > 0 ).length

        const contentLines = lines
            .filter( ( line, index ) => fenced[ index ] === false )
            .filter( ( line ) => line.trim().length > 0 )
            .filter( ( line ) => HEADING.test( line.trim() ) === false )
            .filter( ( line ) => THEMATIC_BREAK.test( line.trim() ) === false )
            .length

        const bulletLines = lines
            .filter( ( line, index ) => fenced[ index ] === false )
            .filter( ( line ) => BULLET.test( line ) === true || ORDERED_BULLET.test( line ) === true )
            .length

        const diagrams = lines
            .filter( ( line ) => MERMAID_FENCE.test( line ) === true )
            .length

        return { words, contentLines, bulletLines, diagrams }
    }


    // #tablesIn — the number of tables inside one chapter. A table STARTS where a table row follows
    // something that is not a table row, so two tables separated by a blank line are two tables.
    // Chapter-scoped on purpose: the three apparatus tables every revision head carries (Feld/Wert,
    // Kontaminations-Metadaten, Kontext) are boilerplate and say nothing about the chapters.
    static #tablesIn( { lines, fenced } ) {
        return lines
            .map( ( line, index ) => ( { line, index } ) )
            .filter( ( entry ) => fenced[ entry.index ] === false )
            .filter( ( entry ) => TABLE_ROW.test( entry.line ) === true )
            .filter( ( entry ) => entry.index === 0 || TABLE_ROW.test( lines[ entry.index - 1 ] ) === false )
            .length
    }


    // ---- the ten metrics -----------------------------------------------------------

    static #metrics( { chapters, paragraphs, evidence, counts } ) {
        const chapterCount = chapters.length

        const evidenceFree = chapters
            .filter( ( chapter ) => RevisionFormScore.#isEvidenced( { chapter } ) === false )
            .length
        const substance = paragraphs
            .filter( ( paragraph ) => paragraph.text.length > SUBSTANCE_PARAGRAPH )
            .length
        const paragraphChars = paragraphs
            .reduce( ( sum, paragraph ) => sum + paragraph.text.length, 0 )
        const tables = chapters
            .reduce( ( sum, chapter ) => sum + RevisionFormScore.#tablesIn( {
                lines: chapter.lines, fenced: chapter.fencedRows
            } ), 0 )
        const quoted = chapters
            .filter( ( chapter ) => VERBATIM_QUOTE.test( chapter.text ) === true )
            .length
        const contracted = chapters
            .filter( ( chapter ) => CONTRACT_SECTIONS
                .every( ( section ) => chapter.lines.some( ( line ) => section.test( line ) === true ) === true ) )
            .length
        const replacing = chapters
            .reduce( ( sum, chapter ) => sum + RevisionFormScore.#replacingRefs( { chapter } ), 0 )
        const bound = chapters
            .filter( ( chapter ) => WORK_ITEM_ID.test( chapter.text ) === true )
            .length

        return {
            K1: RevisionFormScore.#gauge( { id: 'K1', numerator: evidence.markers, basis: counts.words, value: counts.words === 0 ? 0 : evidence.markers / counts.words * 1000 } ),
            K2: RevisionFormScore.#gauge( { id: 'K2', numerator: evidenceFree, basis: chapterCount, value: chapterCount === 0 ? 0 : evidenceFree / chapterCount * 100 } ),
            K3: RevisionFormScore.#gauge( { id: 'K3', numerator: evidence.bound, basis: evidence.markers, value: evidence.markers === 0 ? 0 : evidence.bound / evidence.markers * 100 } ),
            K4: RevisionFormScore.#gauge( { id: 'K4', numerator: substance, basis: chapterCount, value: chapterCount === 0 ? 0 : substance / chapterCount } ),
            K5: RevisionFormScore.#gauge( { id: 'K5', numerator: paragraphChars, basis: paragraphs.length, value: paragraphs.length === 0 ? 0 : paragraphChars / paragraphs.length } ),
            K6: RevisionFormScore.#gauge( { id: 'K6', numerator: tables, basis: chapterCount, value: chapterCount === 0 ? 0 : tables / chapterCount } ),
            K7: RevisionFormScore.#gauge( { id: 'K7', numerator: quoted, basis: chapterCount, value: chapterCount === 0 ? 0 : quoted / chapterCount * 100 } ),
            K8: RevisionFormScore.#gauge( { id: 'K8', numerator: contracted, basis: chapterCount, value: chapterCount === 0 ? 0 : contracted / chapterCount * 100 } ),
            K9: RevisionFormScore.#gauge( { id: 'K9', numerator: replacing, basis: chapterCount, value: replacing } ),
            K10: RevisionFormScore.#gauge( { id: 'K10', numerator: bound, basis: chapterCount, value: chapterCount === 0 ? 0 : bound / chapterCount * 100 } )
        }
    }


    // #isEvidenced — a chapter counts as evidenced when it carries an evidence level OR a source
    // anchor (a footnote reference, a citation, or its own Belege section).
    static #isEvidenced( { chapter } ) {
        if( EVIDENCE_PRESENT.test( chapter.text ) === true ) { return true }
        if( FOOTNOTE_REF.test( chapter.text ) === true ) { return true }
        if( chapter.lines.some( ( line ) => BELEGE_HEADING.test( line ) === true ) === true ) { return true }

        return new RegExp( CITATION.source ).test( chapter.text )
    }


    // #replacingRefs — content-replacing back-references inside one chapter. Table rows are DATA and
    // are excluded: a work-item row that mentions an earlier revision states provenance, it does not
    // replace the chapter's substance. Measured against the stock this reproduces the documented
    // direction — 080/REV-02 (the delta-written revision) reports them, 080/REV-01, REV-03 and
    // REV-04 report none (memo 080, evidence 14.4 and 14.7).
    static #replacingRefs( { chapter } ) {
        return chapter.lines
            .filter( ( line ) => TABLE_ROW.test( line ) === false )
            .filter( ( line ) => REVISION_REF.test( line ) === true )
            .filter( ( line ) => REPLACEMENT_CUES.some( ( cue ) => line.toLowerCase().includes( cue ) === true ) )
            .length
    }


    // #gauge — the ONE place the gap rule lives. A basis of 0 never produces a number: it produces
    // `value: null`, `traffic: 'luecke'` and a stated reason. Everything else is rounded FIRST and
    // then lit, so the displayed value and its light can never disagree.
    static #gauge( { id, numerator, basis, value } ) {
        const spec = METRICS[ id ]
        // `unit` travels with the metric (ADDITIVE, Memo 080 PRD-Q3): the display contract must be
        // able to write "60.2 %" instead of a bare "60.2" WITHOUT holding a second catalogue — a
        // renderer that guessed the unit would print a unit nobody measured.
        // `numerator` travels for the same reason one level down (ADDITIVE, Memo 080 PRD-Q4): the
        // counted side of the fraction, so a stored record keeps the counter-conditions of evidence
        // 25.11 readable without a second calculation. It is emitted EVEN ON A GAP — a gap of the
        // "denominator is zero" kind has a numerator, and hiding it would remove the proof that the
        // denominator really was the empty side.
        const shared = {
            label: spec.label,
            axis: spec.axis,
            threshold: spec.threshold,
            unit: spec.unit,
            numerator,
            basis,
            basisLabel: spec.basisLabel
        }

        if( basis === 0 ) {
            return { ...shared, value: null, traffic: 'luecke', reason: spec.gap }
        }

        const rounded = Number( value.toFixed( spec.digits ) )

        return { ...shared, value: rounded, traffic: spec.traffic( rounded ), reason: null }
    }


    // ---- axes ----------------------------------------------------------------------

    // #axes — one verdict per axis, never a note across axes. The worst light of the axis wins, and
    // `luecke` outranks red: an axis that could not compare is not a judged axis.
    static #axes( { metrics } ) {
        const entries = AXIS_IDS.map( ( axisId ) => {
            const axis = AXES[ axisId ]
            const verdict = axis.metrics
                .map( ( metricId ) => metrics[ metricId ].traffic )
                .reduce( ( worst, traffic ) => VERDICT_ORDER.indexOf( traffic ) > VERDICT_ORDER.indexOf( worst ) ? traffic : worst, 'gruen' )

            return [ axisId, { label: axis.label, verdict, compensable: axis.compensable, metrics: axis.metrics } ]
        } )

        return Object.fromEntries( entries )
    }


    // ---- context figures -----------------------------------------------------------

    // #context — calculated, shown, never lit. `traffic: null` is structural, not a convention: the
    // bullet share separates quality with an effect size of -0.10 and would have marked the praised
    // 080/REV-01 red (evidence 25.7).
    static #context( { counts } ) {
        const values = {
            aufzaehlungsAnteil: counts.contentLines === 0 ? null : Number( ( counts.bulletLines / counts.contentLines * 100 ).toFixed( 1 ) ),
            umfang: counts.words,
            diagramme: counts.diagrams
        }

        // An absolute figure is its own comparison set: it states the count it consists of. The
        // share divides and therefore names the set it divided by.
        const bases = {
            aufzaehlungsAnteil: counts.contentLines,
            umfang: counts.words,
            diagramme: counts.diagrams
        }

        const entries = CONTEXT_IDS.map( ( id ) => {
            const spec = CONTEXT_FIGURES[ id ]

            return [ id, {
                label: spec.label,
                value: values[ id ],
                traffic: null,
                unit: spec.unit,
                basis: bases[ id ],
                basisLabel: spec.basisLabel
            } ]
        } )

        return Object.fromEntries( entries )
    }


    // ---- memo number ---------------------------------------------------------------

    // #memoNo — the memo number as it stands in the PATH (".memo/memos/080-slug/revisions/REV-18.md"
    // and the flat legacy ".memo/080-slug/REV-01.md" both resolve). Carried for PRD-Q5, which will
    // zone the lights along the cut-off; NOTHING in this module reads it, so two identical documents
    // under memo 012 and memo 099 produce identical lights. The file name itself is never read as a
    // memo number — only directory segments are.
    static #memoNo( { fileName } ) {
        const directories = fileName.split( '/' ).slice( 0, -1 )
        const matches = directories
            .map( ( segment ) => segment.match( /^(\d{3})(?:-|$)/ ) )
            .filter( ( match ) => match !== null )

        if( matches.length === 0 ) { return null }

        return Number( matches[ matches.length - 1 ][ 1 ] )
    }


    // ---- rendering -----------------------------------------------------------------

    // #render — the terminal text of research 6.4, with the mandatory "Grundlage" column: a metric
    // that cannot say what it counted over is not readable. Prefix tags follow
    // skills/_shared/terminal-output-spec.md ([EVAL] for the verdict, [WARNING] per bad axis).
    static #render( { fileName, axes, metrics, context, unresolvedRefs } ) {
        const name = fileName.split( '/' ).slice( -1 )[ 0 ].replace( /\.md$/, '' )
        const head = `[EVAL] Revisions-Qualitaet ${ name } — ${ AXIS_IDS.map( ( id ) => `${ axes[ id ].label } ${ axes[ id ].verdict }` ).join( ' · ' ) }`

        const rows = METRIC_IDS.map( ( id ) => ( {
            name: `${ id } ${ metrics[ id ].label }`,
            value: RevisionFormScore.#formatValue( { id, metric: metrics[ id ] } ),
            traffic: metrics[ id ].traffic,
            threshold: metrics[ id ].threshold,
            basis: `${ metrics[ id ].basis } ${ metrics[ id ].basisLabel }`
        } ) )

        const header = { name: 'Kennzahl', value: 'Wert', traffic: 'Ampel', threshold: 'Schwelle', basis: 'Grundlage' }
        const widths = RevisionFormScore.#widths( { rows: [ header, ...rows ] } )
        const table = [ header, ...rows ]
            .map( ( row ) => `  ${ row.name.padEnd( widths.name ) }  ${ row.value.padStart( widths.value ) }  ${ row.traffic.padEnd( widths.traffic ) }  ${ row.threshold.padEnd( widths.threshold ) }  ${ row.basis }` )
            .join( '\n' )

        const contextLine = `  Kontext (ohne Ampel): ${ CONTEXT_IDS
            .map( ( id ) => {
                // A gap says "luecke" and NOTHING else — appending the unit to a missing value
                // ("luecke %") would dress a gap up as a measurement.
                if( context[ id ].value === null ) { return `${ context[ id ].label } luecke` }

                const unit = CONTEXT_FIGURES[ id ].unit

                return `${ context[ id ].label } ${ context[ id ].value }${ unit === '' ? '' : ` ${ unit }` }`
            } )
            .join( ' · ' ) }`

        const refsLine = `  Beleg-Kennungen ohne Aufloesung: ${ unresolvedRefs.length === 0
            ? 'keine'
            : unresolvedRefs.map( ( ref ) => `${ ref.id } (Zeile ${ ref.line })` ).join( ', ' ) }`

        const warnings = AXIS_IDS
            .filter( ( id ) => axes[ id ].verdict === 'rot' || axes[ id ].verdict === 'luecke' )
            .map( ( id ) => RevisionFormScore.#warning( { axisId: id, axes, metrics } ) )

        return [ head, '', table, '', contextLine, refsLine, ...( warnings.length === 0 ? [] : [ '', ...warnings ] ) ].join( '\n' )
    }


    static #warning( { axisId, axes, metrics } ) {
        const axis = axes[ axisId ]
        const affected = axis.metrics
            .filter( ( id ) => metrics[ id ].traffic === axis.verdict )
            .map( ( id ) => `${ id } ${ metrics[ id ].label }` )
            .join( ', ' )

        if( axis.verdict === 'luecke' ) {
            return `[WARNING] ${ axis.label } luecke — ${ affected }: keine Vergleichsmenge. Ein gruener Wert ohne Vergleichsmenge waere ein Fehler, kein Erfolg.`
        }

        const compensation = axis.compensable === false ? ' Nicht kompensierbar.' : ''

        return `[WARNING] ${ axis.label } rot — ${ affected }.${ compensation } Hinweis, kein Verbot.`
    }


    static #formatValue( { id, metric } ) {
        if( metric.value === null ) { return 'luecke' }

        const spec = METRICS[ id ]
        const shown = metric.value.toFixed( spec.digits )

        return spec.unit === '%' ? `${ shown } %` : shown
    }


    static #widths( { rows } ) {
        return [ 'name', 'value', 'traffic', 'threshold' ]
            .reduce( ( acc, key ) => ( {
                ...acc,
                [ key ]: rows.reduce( ( widest, row ) => Math.max( widest, row[ key ].length ), 0 )
            } ), {} )
    }
}


export { RevisionFormScore }
