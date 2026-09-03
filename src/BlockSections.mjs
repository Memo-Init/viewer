// BlockSections.mjs — THE MIRROR of repos/core/cli/src/BlockSections.mjs (Memo 080, PRD-B1).
//
// THIS IS A COPY, AND IT SAYS SO. The viewer is its own npm package: package.json lists only
// @dolthub/doltlite and ws, not memo-cli, so an import across the repo boundary is not available. The
// register therefore lives once per repo, and the two copies are held against each other by
// tests/unit/BlockSectionsParityPRDB1.test.mjs (and its counterpart in the core repo).
//
// THIS IS THE EXACT PLACE THE MEASURED DRIFT CAME FROM: the display list in app.client.mjs carried the
// LEGACY alias `problem-beschreibung` while the parser's canonical name had long been `Faktenlage`,
// and nothing compared the two. Everything below the header is character-identical to the core file —
// change it HERE and it is red until it is changed THERE too.
//
// Source of the content below: REV-18 Kap 2 "Form und Aufbau eines Memos", Z. 107-132 for the
// toolkit and Z. 154-173 for the document level.
//
// THE DEFECT IT CLOSES, MEASURED: the toolkit of Kap 2 existed only as prose. Three places kept
// their own, mutually divergent copy of "which heading is a block section":
//   - the parser (BlockMeta BODY_SECTIONS) knew an OLDER set of four whose overlap with the
//     toolkit is exactly ONE heading ("Bewertung");
//   - the display (app.client.mjs BLOCK_BODY_HEADINGS) knew three of those four, and it knew the
//     LEGACY alias "Problem-Beschreibung" instead of the canonical "Faktenlage";
//   - the write path (MemoBlock BODY_SECTIONS) knew the same four as FIELD names and refused
//     everything else, so none of the three MANDATORY headings could be written at all.
// Inside the 25 numbered chapters of REV-18 there are 146 third-level headings and all 146 belong
// to the toolkit (70 verbatim, 26 with a suffix, 50 generated, 0 outside the set). The text keeps
// the form; the machine did not know it. This register is the single place all three read from.
//
// THE LIST IS CLOSED. A value outside it is an error, never a new value. The four GENERATED
// headings are reserved so the write path cannot fill them by hand — they come from the database.
//
// NO SEMANTIC RE-INTERPRETATION OF THE OLD SET: "Faktenlage" is NOT declared to be "Ist-Zustand"
// and "Loesungsansatz" is NOT declared to be "Soll-Zustand". Such an equation is nowhere in the
// memo; it would be an invention of this module. The three old headings stay recognisable as
// `legacy` and keep their established field names. "Offene Punkte" (new) and "Offene Fragen" (old)
// stay SEPARATE entries for the same reason.
//
// NO EVIDENCE LEVELS HERE: this memo does not define them (REV-18, Z. 114). The authority is spec
// `memo/0.3.0` Kap 11. Neither the register nor its tests carry a list of their own.
//
// KEIN `### Diagramm`: a diagram is a CONTENT FORM, not a heading (REV-18, Z. 132). It stands under
// one of the headings below, in any section. The absence of a `Diagramm` entry is deliberate and is
// held by a test.
//
// THIS FILE EXISTS TWICE — here and as repos/viewer/src/BlockSections.mjs. The viewer is a separate
// npm package and does not depend on memo-cli, so a cross-repo import is not available. The two
// copies are held against each other by a parity test in BOTH repos; the divergence measured above
// is exactly what happens when nobody compares them.
//
// Class architecture per node-class-architecture: static-only, object params, object returns,
// private-by-default, NO SILENT DEFAULTS, no for/while loops.

const KINDS = [ 'required', 'optional', 'generated', 'legacy' ]
// The kinds a caller may WRITE by hand. `generated` is reserved: those four sections are rendered
// from the database (REV-18, Z. 130), so a hand-written value would be overwritten without a word.
const WRITABLE_KINDS = [ 'required', 'optional', 'legacy' ]
// The two suffix forms measured in REV-18: ": " occurs 25 times ("Soll-Zustand: der Werkzeugkoffer"),
// " (" once ("Gegenargument (wie erbeten)"). Nothing else is accepted — the list is closed here too.
const SUFFIX_SEPARATORS = [ ': ', ' (' ]
const REQUIRED_FIELDS = [ 'field', 'heading', 'kind' ]


// The register itself. Every entry is mandatory in all four keys; `aliases` is always a list, never
// null. Declaration order is the canonical order: required, optional, generated, legacy.
const SECTIONS = [
    { field: 'userMandate', heading: 'User-Auftrag', kind: 'required', aliases: [] },
    { field: 'currentState', heading: 'Ist-Zustand', kind: 'required', aliases: [] },
    { field: 'targetState', heading: 'Soll-Zustand', kind: 'required', aliases: [] },
    { field: 'assessment', heading: 'Bewertung', kind: 'optional', aliases: [] },
    { field: 'delimitation', heading: 'Abgrenzung', kind: 'optional', aliases: [] },
    { field: 'decision', heading: 'Entscheidung', kind: 'optional', aliases: [] },
    { field: 'measurement', heading: 'Messung', kind: 'optional', aliases: [] },
    { field: 'example', heading: 'Beispiel', kind: 'optional', aliases: [] },
    { field: 'risk', heading: 'Risiko', kind: 'optional', aliases: [] },
    { field: 'counterArgument', heading: 'Gegenargument', kind: 'optional', aliases: [] },
    { field: 'openItems', heading: 'Offene Punkte', kind: 'optional', aliases: [] },
    { field: 'topics', heading: 'Topics', kind: 'generated', aliases: [] },
    { field: 'workItems', heading: 'Work-Items', kind: 'generated', aliases: [] },
    { field: 'prdAssignment', heading: 'PRD-Zuordnung', kind: 'generated', aliases: [] },
    { field: 'evidence', heading: 'Belege', kind: 'generated', aliases: [] },
    { field: 'factualAccount', heading: 'Faktenlage', kind: 'legacy', aliases: [ 'Problem-Beschreibung' ] },
    { field: 'solution', heading: 'Loesungsansatz', kind: 'legacy', aliases: [] },
    { field: 'openQuestions', heading: 'Offene Fragen', kind: 'legacy', aliases: [] }
]


// The fixed section order of a revision DOCUMENT (REV-18, Z. 158-172). Kap 2 calls this table "the
// checklist for the generation" — which database table feeds which section. This module PROVIDES the
// checklist; applying it belongs to the generator path (PRD-R1 / PRD-R2), which is why nothing here
// calls it. The parenthetical detail of the memo table is kept in this comment rather than in the
// section name, so the name stays a stable handle: Kopf (Memo, Revision, Datum, Typ, Aenderungen),
// Kontext (Projekt, Repos, Bereiche, Material), Bloecke (Kapitel).
const DOCUMENT_SECTIONS = [
    { section: 'Kopf', required: true, source: 'Memo-Tabelle plus Revisions-Tabelle' },
    { section: 'Kontaminations-Metadaten', required: true, source: 'Sitzungs-Tabelle' },
    { section: 'Kontext', required: true, source: 'Memo-Tabelle plus Referenz-Tabelle' },
    { section: 'Bloecke', required: true, source: 'Block-, Abschnitts-, Topic-, Work-Item-Tabelle' },
    { section: 'Vorwort', required: true, source: 'hand-geschrieben, in der Prosa-Tabelle' },
    { section: 'Offene Fragen', required: true, source: 'Fragen-Tabelle mit Status offen' },
    { section: 'Beantwortete Fragen', required: true, source: 'Fragen-Tabelle mit Status beantwortet, getrennt nach Herkunft' },
    { section: 'Phasen und Phasen-Hinweise', required: true, source: 'Phasen-Tabelle' },
    { section: 'Finalisierungs-Checkliste', required: true, source: 'fester Satz plus Ergebnis-Tabelle' },
    { section: 'Anhaenge', required: true, source: 'Referenz-Tabelle' },
    { section: 'Einstiegspunkte', required: true, source: 'hand-geschrieben, in der Prosa-Tabelle' },
    { section: 'Lessons-Learned', required: true, source: 'Lessons-Tabelle (waechst auch nach der Finalisierung)' }
]


// The verdict of a text that is not in the register. It is built fresh on every return (never a
// shared object handed out twice), so a caller cannot mutate the miss of the next caller.
const miss = () => ( { matched: false, field: null, heading: null, kind: null, suffix: null } )


class BlockSections {
    // Every declared section, in declaration order, as a defensive copy — a caller can never mutate
    // the register it is reading.
    static all() {
        const sections = SECTIONS
            .map( ( entry ) => BlockSections.assertComplete( { entry } ).entry )

        return { sections }
    }


    static byField( { field } ) {
        if( typeof field !== 'string' || field.length === 0 ) {
            throw new Error( 'BlockSections.byField: "field" is required (non-empty string)' )
        }

        const found = SECTIONS
            .find( ( entry ) => entry[ 'field' ] === field )
        const section = found === undefined ? null : BlockSections.assertComplete( { entry: found } ).entry

        return { found: section !== null, section }
    }


    // The field names a caller may WRITE, in register order (required, optional, legacy). The four
    // `generated` fields are deliberately absent: they are rendered from the database.
    static writableFields() {
        const fields = SECTIONS
            .filter( ( entry ) => WRITABLE_KINDS.includes( entry[ 'kind' ] ) === true )
            .map( ( entry ) => entry[ 'field' ] )

        return { fields }
    }


    // Every heading AND alias, lower-cased, in register order — the label list the display sides
    // (MemoView.isBlockBodyHeading and the client's BLOCK_BODY_HEADINGS literal) are derived from and
    // held against. It is the ONE place that decides what those two compare a DOM heading with.
    static labels() {
        const labels = SECTIONS
            .flatMap( ( entry ) => [ entry[ 'heading' ] ].concat( entry[ 'aliases' ] ) )
            .map( ( label ) => label.toLowerCase() )

        return { labels }
    }


    // Recognise ONE heading text. Pure: no file access, no state, same input => same output.
    //
    // Matched is the verbatim heading (and its aliases) as well as the two suffix forms measured in
    // REV-18 — "Soll-Zustand: der Werkzeugkoffer" and "Gegenargument (wie erbeten)". The suffix is
    // returned instead of being dropped, so a caller can render it. Comparison is done after trim()
    // and case-insensitively, exactly as the display side already did.
    //
    // A text outside the register returns matched:false and NEVER throws — null/undefined included.
    // The longest matching label wins, so a heading that is the prefix of another cannot shadow it.
    static match( { text } ) {
        const raw = typeof text === 'string' ? text.trim() : ''
        if( raw.length === 0 ) {
            return miss()
        }

        const hits = SECTIONS
            .flatMap( ( entry ) => [ entry[ 'heading' ] ].concat( entry[ 'aliases' ] )
                .map( ( label ) => ( { entry, label, probe: BlockSections.#probe( { raw, label } ) } ) ) )
            .filter( ( candidate ) => candidate[ 'probe' ].hit === true )
            .sort( ( a, b ) => b[ 'label' ].length - a[ 'label' ].length )
        if( hits.length === 0 ) {
            return miss()
        }

        const best = hits[ 0 ]

        return {
            matched: true,
            field: best[ 'entry' ][ 'field' ],
            heading: best[ 'entry' ][ 'heading' ],
            kind: best[ 'entry' ][ 'kind' ],
            suffix: best[ 'probe' ].suffix
        }
    }


    // The document-level section order (REV-18, Z. 158-172), as a defensive copy. Pure, and PROVIDED
    // only: no generator in this repo calls it — applying the checklist is PRD-R1 / PRD-R2 scope.
    static documentSections() {
        const sections = DOCUMENT_SECTIONS
            .map( ( entry ) => ( { section: entry[ 'section' ], required: entry[ 'required' ], source: entry[ 'source' ] } ) )

        return { sections }
    }


    // The completeness gate. `field`, `heading` and `kind` must be non-empty strings, `kind` one of
    // KINDS and `aliases` a list. There is no fallback: an incomplete entry is a defect in the
    // register, and a silently defaulted kind would let the write path fill a generated section.
    static assertComplete( { entry } ) {
        if( entry === undefined || entry === null || typeof entry !== 'object' ) {
            throw new Error( 'BlockSections.assertComplete: "entry" is required (object)' )
        }

        const missing = REQUIRED_FIELDS
            .filter( ( key ) => typeof entry[ key ] !== 'string' || entry[ key ].length === 0 )
        if( missing.length > 0 ) {
            throw new Error( `BlockSections.assertComplete: section "${ entry[ 'field' ] }" is missing required field(s) ${ missing.join( ', ' ) } — every field is mandatory, none is defaulted` )
        }
        if( KINDS.includes( entry[ 'kind' ] ) !== true ) {
            throw new Error( `BlockSections.assertComplete: section "${ entry[ 'field' ] }" has kind "${ entry[ 'kind' ] }" — expected one of ${ KINDS.join( ', ' ) }` )
        }
        if( Array.isArray( entry[ 'aliases' ] ) !== true ) {
            throw new Error( `BlockSections.assertComplete: section "${ entry[ 'field' ] }" must carry an aliases list — an absent list is not an empty list` )
        }

        const copy = {
            field: entry[ 'field' ],
            heading: entry[ 'heading' ],
            kind: entry[ 'kind' ],
            aliases: entry[ 'aliases' ].slice()
        }

        return { entry: copy }
    }


    // ---- private ----

    // Hold ONE label against ONE heading text. Returns whether it hit and what the suffix was. The
    // comparison runs lower-cased, the suffix is cut from the ORIGINAL text so its spelling survives.
    static #probe( { raw, label } ) {
        const lowerRaw = raw.toLowerCase()
        const lowerLabel = label.toLowerCase()
        if( lowerRaw === lowerLabel ) {
            return { hit: true, suffix: null }
        }

        const separator = SUFFIX_SEPARATORS
            .find( ( candidate ) => lowerRaw.startsWith( lowerLabel + candidate ) === true )
        if( separator === undefined ) {
            return { hit: false, suffix: null }
        }

        const rest = raw.slice( label.length + separator.length ).trim()
        const inner = separator === ' (' && rest.endsWith( ')' ) === true ? rest.slice( 0, -1 ).trim() : rest

        return { hit: true, suffix: inner.length === 0 ? null : inner }
    }
}


// LOAD-TIME GATE: an entry without a kind or without an aliases list breaks the import of this
// module, not some later read. A half-declared section must never reach the parser or the write path.
BlockSections.all()


export { BlockSections, KINDS, WRITABLE_KINDS, SUFFIX_SEPARATORS }
