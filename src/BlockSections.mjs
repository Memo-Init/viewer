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


// Memo 081, WI-116 (REV-16:4165): `### PRD-Zuordnung` leaves the CHAPTER CONTRACT and
// `### Abhaengigkeiten` takes its place — the consequence of F23=A and F24=A, where PRDs are cut in
// the PLANNING phase from the work-item edge graph. A chapter that claims a PRD assignment while it
// is being written assigns something that does not exist yet.
//
// THIS IS AN ADDITION, NOT A RENAME, AND THE MEASUREMENT SAYS WHY. Across 533 revision files the
// stock carries 411 `### PRD-Zuordnung` headings in 16 files and 242 `### Abhaengigkeiten` headings
// in 6 — and the register recognised the second group ZERO times, so 242 headings the contract has
// prescribed since REV-12 were invisible to the parser, to the collapse pass and to every count.
// Renaming the entry would have touched 24 files in the core repo, among them the live CLI domain
// `memo prd ingest|render|verify` whose subject really IS the PRD assignment. Demoting it to
// `legacy` would have been worse still: `legacy` is WRITABLE, so the entry would enter sortOrder()
// and shift the persisted `block_section.sort` ordinal of every section behind it — the exact
// regression the ESTABLISHED_SORT comment below describes, and one assertSortOrder does NOT catch
// because it only holds the four established head positions.
//
// NO SEMANTIC EQUATION, same restraint as Faktenlage/Ist-Zustand above: `Abhaengigkeiten` is NOT
// declared an alias of `PRD-Zuordnung`. One assigns PRDs, the other names work-item edges. Both stay
// RECOGNISED; only one is in the contract (CHAPTER_CONTRACT below).
//
// NO UMLAUT FOLDING, AND THAT IS A MEASUREMENT TOO. `### Abhängigkeiten` is NOT recognised: over the
// same 533 files the umlaut spelling occurs 0 times at this level (242 use `ae`, and `Lösungsansatz`
// likewise stands 0 times against 1 for `Loesungsansatz`). Folding umlauts inside #probe would change
// recognition for all 19 labels at once — for three readers that share it — against a measured need
// of zero. The DOCUMENT level does carry both spellings, because there the alias list is explicit and
// per-heading (MemoValidator REVISION_SCHEMA.sectionAliases, WI-120); that is a different mechanism
// in a different place, not a second opinion about the same one.
//
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
    { field: 'dependencies', heading: 'Abhaengigkeiten', kind: 'generated', aliases: [] },  // Memo 081, WI-116 — rationale above
    { field: 'prdAssignment', heading: 'PRD-Zuordnung', kind: 'generated', aliases: [] },
    { field: 'evidence', heading: 'Belege', kind: 'generated', aliases: [] },
    { field: 'factualAccount', heading: 'Faktenlage', kind: 'legacy', aliases: [ 'Problem-Beschreibung' ] },
    { field: 'solution', heading: 'Loesungsansatz', kind: 'legacy', aliases: [] },
    { field: 'openQuestions', heading: 'Offene Fragen', kind: 'legacy', aliases: [] }
]


// The PERSISTED ordinal of a writable section — the value `block_section.sort` carries. It is
// DELIBERATELY NOT the register index and must never become one again.
//
// THE REGRESSION THIS CLOSES, MEASURED: `sort` was derived as `BODY_SECTIONS.indexOf( name )`. The
// moment this register widened that list from four names to fourteen, every ordinal moved. On a fresh
// database the sections came out as currentState 1, assessment 3, factualAccount 11, solution 12,
// openQuestions 13 — where the same four names had carried 0, 1, 2, 3 before. Two things broke at once:
//   - the documented reading order "facts kept apart from judgment, facts first" (Memo 053 Kap 8, quoted
//     at the `block_section` carrier in DoltSchema) was REVERSED, because Bewertung (3) now sorted ahead
//     of Faktenlage (11);
//   - a database written before the widening kept the old ordinals, so the order of one and the same
//     memo depended on whether it had been re-projected since.
//
// THE ORDER BELOW IS ADDITIVE, exactly as the parser return is: the four established names keep the
// ordinals they are ALREADY persisted with, the ten new writable ones follow behind them. That restores
// the documented order and makes an old row and a freshly written row of the same section carry the
// identical value — a database that mixes both is consistent by construction, with no migration and
// without rewriting a single stored row.
//
// IT IS A READ ORDER, NEVER THE RENDER ORDER. The render iterates the register itself (BLOCK_SECTION_ORDER
// in RevisionAssembler and its viewer mirror), which is grouped by kind. Those are two different questions
// and one list had been answering both.
const ESTABLISHED_SORT = [ 'factualAccount', 'assessment', 'solution', 'openQuestions' ]


// The fixed section order of a revision DOCUMENT (REV-18, Z. 158-172). Kap 2 calls this table "the
// checklist for the generation" — which database table feeds which section. The parenthetical detail
// of the memo table is kept in this comment rather than in the section name, so the name stays a
// stable handle: Kopf (Memo, Revision, Datum, Typ, Aenderungen), Kontext (Projekt, Repos, Bereiche,
// Material), Bloecke (Kapitel).
//
// SINCE Memo 080 / PRD-R1 THIS ORDER IS APPLIED, NOT ONLY PROVIDED. Three readers bind to it and none
// of them keeps a list of its own: the core generator (RevisionAssembler DOCUMENT_SECTIONS render
// plan), its viewer mirror (DoltDbAssembler) and the document-level lint (MemoValidator WARN-020 /
// WARN-021). Both generators gate their render plan against this array at LOAD time, so a divergence
// breaks the import instead of producing a differently ordered revision.
//
// TWO KEYS SERVE THOSE READERS AND ARE PART OF THE REGISTER, NOT OF A RENDERER:
//   headings  the level-2 headings a document carries for this position. It is a LIST because one
//             position may legitimately be written as two headings ("Phasen und Phasen-Hinweise" is
//             `## Phasen` plus `## Phase-Hints`) and because a position may accept an established
//             alias (`## Claude-Vorwort`). `Kopf` carries NO heading — it is a table, not a section.
//   fields    the head fields this position declares (Z. 160). Only `Kopf` carries any; every other
//             position keeps an empty list rather than an absent key, so a reader never has to guess.
const DOCUMENT_SECTIONS = [
    { section: 'Kopf', required: true, source: 'Memo-Tabelle plus Revisions-Tabelle', headings: [], fields: [ 'Memo', 'Revision', 'Datum', 'Typ', 'Aenderungen' ] },
    { section: 'Kontaminations-Metadaten', required: true, source: 'Sitzungs-Tabelle', headings: [ 'Kontaminations-Metadaten' ], fields: [] },
    { section: 'Kontext', required: true, source: 'Memo-Tabelle plus Referenz-Tabelle', headings: [ 'Kontext' ], fields: [] },
    { section: 'Bloecke', required: true, source: 'Block-, Abschnitts-, Topic-, Work-Item-Tabelle', headings: [ 'Blocks' ], fields: [] },
    { section: 'Vorwort', required: true, source: 'hand-geschrieben, in der Prosa-Tabelle', headings: [ 'Vorwort', 'Claude-Vorwort' ], fields: [] },
    { section: 'Offene Fragen', required: true, source: 'Fragen-Tabelle mit Status offen', headings: [ 'Offene Fragen' ], fields: [] },
    { section: 'Beantwortete Fragen', required: true, source: 'Fragen-Tabelle mit Status beantwortet, getrennt nach Herkunft', headings: [ 'Beantwortete Fragen' ], fields: [] },
    // Memo 081, WI-120 (REV-16:5322-5327, :5521-5522): after F24=A the two document positions are called
    // `## Abhaengigkeiten` and `## Abhaengigkeits-Hinweise`. The old spellings stay ACCEPTED and are not
    // a transitional state — measured over 533 revision files, `## Phasen` stands in 356 of them and
    // `## Abhaengigkeiten` in 0, so the old spelling is the MAJORITY and the alias gets no expiry (F19:
    // convention from V2 on, no migration of the stock). `headings` was always a LIST for exactly this
    // (see the key description above); the form is used, not extended. The SECTION NAME stays
    // `Phasen und Phasen-Hinweise` — it is a stable handle, not display text, and renaming it would run
    // WARN-020 against a different key.
    // THE ORDER INSIDE `headings` IS NOT COSMETIC: `headings[0]` is what a reader takes as the heading
    // this position is WRITTEN as, and both assemblers still emit `## Phasen` from a hardcoded string
    // (DoltDbAssembler / RevisionAssembler). Putting the new name first would make the register claim
    // something the code does not do. Switching the RENDER to the new heading belongs with the render
    // half of WI-116/WI-120 (WI-091, Memo 082); until then the register accepts four spellings and names
    // the emitted one first.
    { section: 'Phasen und Phasen-Hinweise', required: true, source: 'Phasen-Tabelle', headings: [ 'Phasen', 'Phase-Hints', 'Abhaengigkeiten', 'Abhaengigkeits-Hinweise' ], fields: [] },
    { section: 'Finalisierungs-Checkliste', required: true, source: 'fester Satz plus Ergebnis-Tabelle', headings: [ 'Finalisierungs-Checkliste' ], fields: [] },
    { section: 'Anhaenge', required: true, source: 'Referenz-Tabelle', headings: [ 'Ancillary Files' ], fields: [] },
    { section: 'Einstiegspunkte', required: true, source: 'hand-geschrieben, in der Prosa-Tabelle', headings: [ 'Rollout-Entry-Points' ], fields: [] },
    { section: 'Lessons-Learned', required: true, source: 'Lessons-Tabelle (waechst auch nach der Finalisierung)', headings: [ 'Lessons-Learned' ], fields: [] }
]


// Memo 081, WI-116 / T061 (REV-16:3393-3402): the CHAPTER contract — which `### ` headings a numbered
// chapter `## N. Titel [Kategorie]` must carry, in this order. It sits HERE and only here because the
// contract was measured to exist THREE times and to be right ONCE: the memo lists it with
// `### Abhaengigkeiten`, RevisionFormScore.CONTRACT_SECTIONS listed five of them with
// `### PRD-Zuordnung`, and BlockSections knew the toolkit but not which part of it is DUTY.
//
// THE REGISTER IS A SUPERSET OF THE CONTRACT, AND THAT IS THE POINT. SECTIONS says what is RECOGNISED
// (19 entries, the 411 `PRD-Zuordnung` headings of the stock included); CHAPTER_CONTRACT says what is
// REQUIRED. WI-116 removes a heading from the second list, never from the first — dropping it from the
// first would make 411 existing headings unparseable overnight.
//
// `**Gelesen als:**` is deliberately ABSENT. The memo counts it as building block 3 of nine, but it is a
// BOLD LEAD-IN inside `### User-Auftrag` (REV-16:3396), not a level-three heading, so a list of headings
// cannot carry it. Its form is checked where it lives — PRD-41, WI-115. Eight headings against nine
// building blocks is therefore a definition, not a gap.
//
// `registered` IS A MEASURED EXCEPTION AND IT IS CAPPED AT ONE. Seven of the eight contract headings are
// block sections in SECTIONS above. `### Kontext` is NOT, and this was found by the load-time gate below
// on its first run, not argued into existence. It cannot be repaired here, and both ways out were
// measured before this datum was written:
//   - as a WRITABLE entry (`required`/`optional`) it enters sortOrder() and shifts the persisted
//     `block_section.sort` ordinal of the ten writable sections behind it — the exact database
//     regression the ESTABLISHED_SORT comment describes and assertSortOrder does not catch;
//   - as `generated` it becomes non-writable, so MemoBlock (BODY_SECTIONS = writableFields) would REFUSE
//     to write a section the contract makes MANDATORY and the memo calls "the only place for prose".
// So it stands in the CONTRACT (the memo requires it, REV-16:3393, and the stock carries 279 such
// headings) and not in the REGISTER, and the gate holds the exception to exactly this one heading: a
// second unregistered contract heading breaks the import. Closing it properly is a write-path change
// (the same defect class as the 242 unrecognised `### Abhaengigkeiten` this PRD closes), not a contract
// change — it is reported as a restschuld rather than half-done here.
// Memo 081, WI-113 (REV-16:4110-4111): `overview` says whether a section belongs to the OVERVIEW LEVEL
// and therefore stays OPEN. `### Kontext` and `### User-Auftrag` do — they ARE that level: someone
// scrolling a document to see "what is going on" reads exactly those two and nothing else, and the user
// confirmed the per-chapter context line explicitly. The other six fold into a <details> whose <summary>
// is a computed figure line.
//
// IT IS A PROPERTY OF THE SECTION, NOT OF THE RENDERER, which is why it stands here beside the heading
// rather than in a list the browser keeps. The renderer READS it.
//
// AND IT IS DELIBERATELY NOT `BLOCK_BODY_HEADINGS`. That literal is the derived copy of the whole
// VOCABULARY — 20 labels — and it currently collapses `user-auftrag`, which the memo explicitly wants
// open. Using the vocabulary as the fold list would fold twelve sections nobody asked to fold and one
// the memo asks to leave alone. A list that answers two questions answers at least one of them wrongly;
// that is the defect this register already took apart once for the headings themselves.
const CHAPTER_CONTRACT = [
    { heading: 'Kontext', required: true, repeatable: false, registered: false, overview: true },
    { heading: 'User-Auftrag', required: true, repeatable: false, registered: true, overview: true },
    { heading: 'Ist-Zustand', required: true, repeatable: false, registered: true, overview: false },
    { heading: 'Soll-Zustand', required: true, repeatable: true, registered: true, overview: false },
    { heading: 'Belege', required: true, repeatable: false, registered: true, overview: false },
    { heading: 'Topics', required: true, repeatable: false, registered: true, overview: false },
    { heading: 'Work-Items', required: true, repeatable: false, registered: true, overview: false },
    { heading: 'Abhaengigkeiten', required: true, repeatable: false, registered: true, overview: false }
]

// `overview` rides in this list so the load-time gate below demands it as a BOOLEAN on every entry. A
// contract entry that simply omitted it would otherwise read as "not an overview section" by accident —
// a default nobody wrote down, on the datum that decides whether a section is visible.
const CONTRACT_FIELDS = [ 'required', 'repeatable', 'registered', 'overview' ]

// The closed list of contract headings the register deliberately does NOT carry. It is a list so the
// gate can compare against it, and it is written out so that widening it is a visible edit.
const UNREGISTERED_CONTRACT = [ 'Kontext' ]


// Memo 081, WI-115 / T077 (REV-16:4144-4154): the ORDER of the `### User-Auftrag` section. It sits
// beside CHAPTER_CONTRACT because they answer two halves of one question — the contract says WHICH
// sections a chapter carries, this says HOW ONE of them is built. Two sources for one contract is
// exactly what WI-116 has just finished taking apart, and the comment above CHAPTER_CONTRACT already
// names this file as the place: "Its form is checked where it lives — PRD-41, WI-115."
//
// WHAT THE MEASUREMENT SAYS, AND WHY IT IS AN ORDER RATHER THAN A TEMPLATE. Over the 41 numbered
// chapters of REV-16 (measured 2026-09-08): 41 carry the heading, 37 carry a block quote, 30 carry a
// source reference, 29 carry the reading, 3 carry a default sentence. So the SECTION is never
// missing — its FORM is. The user's complaint ("das sieht noch alles sehr manuell aus") is about
// VARIANCE, not about manual work: the content is meant to be written by hand. Fixing the order
// fixes the impression without touching the freedom.
//
// THE PATTERNS LIVE HERE, NOT IN THE VALIDATOR. A recogniser typed a second time in the caller is the
// drift this register exists against — the same rule that put match() and matchContract() here.
//
// `reading` IS OPTIONAL AND STAYS OPTIONAL. Only its POSITION is checked. Requiring it would make the
// AI's reading a criterion, and REV-16:3418 says the opposite: the reading is a reading aid, and where
// reading and quote disagree the QUOTE wins (the Memo-064 error class).
const USER_MANDATE_ELEMENTS = [
    // A verbatim quote in German quotation marks. The 20-character floor separates a quotation from a
    // quoted WORD ("die »Form«"); it is a floor, not a quality judgement. The quote may SPAN several
    // `>` lines — measured, REV-16:3323-3327 does — so the caller joins a run of quote lines before
    // testing, and this pattern must not be anchored to a line.
    { element: 'quote', position: 1, required: true, pattern: /„[^„]{20,}?[“”"]/ },
    // The source reference in the form the memo prescribes (REV-16:4148): PARENTHESES carrying
    // `file.ext:line`. The extension is not pinned to `.md` — measured, the corpus also cites
    // `…jsonl:463` — but the PARENTHESES and the LINE NUMBER are, because they are what the memo
    // writes down and what makes the reference machine-readable.
    //
    // A MEASURED SHAPE IS DELIBERATELY NOT ACCEPTED, and that is the point of the rule rather than a
    // gap in it: `— transcripts/X.md, Zeile 26` (REV-16:3328) carries the same information in prose.
    // Accepting it would enshrine the variance the section exists to end. It is reported, not blessed.
    //
    // The path separator is written with a backslash escape although a slash needs no escape inside a
    // character class. That is not decoration: the enum-language gate in core slices an array body by
    // stepping over regex literals, and an UNESCAPED slash inside a class ends that step early.
    // Measured 2026-09-08, the unescaped form made the gate read this array as `quote, source` and
    // silently miss `reading` — it under-reported instead of reporting a parse problem. The escape
    // keeps this register out of that trap; the weakness of the gate itself is reported separately
    // rather than papered over here.
    //
    // NO APOSTROPHE STANDS IN THIS ARRAY BODY, deliberately. The same gate reads a single quote as a
    // string delimiter without skipping comments, so an English possessive inside these braces makes
    // it extract half a sentence as a machine token. Measured here on the first attempt.
    { element: 'source', position: 2, required: true, pattern: /\([^()]*[\w.\/+-]+\.[a-z0-9]+:\d+[^()]*\)/ },
    { element: 'reading', position: 3, required: false, pattern: /^\s*\*\*Gelesen als:\*\*/ }
]

// THE DEFAULT SENTENCE IS FIXED HERE, NOT IN THE MEMO — and this list is the one place in this PRD
// where the work goes BEYOND the memo, so it says so. REV-16:4151 gives an EXAMPLE ("zum Beispiel
// «Kein woertlicher Auftrag; dieses Kapitel folgt aus {Kapitel/Frage}.»") and chapter 33
// (:3420-3423) names a second, narrower variant for chapters born from a MEASUREMENT. An example
// cannot be linted against.
//
// BOTH WORDINGS ARE MEASURED, NOT INVENTED. Over 901 revision files in the stock (2026-09-08):
// `Kein User-Auftrag` stands in 7 files and is the wording the corpus ACTUALLY uses; the wording the
// memo offers as an example stands in 6 files and in every one of them it is the memo quoting its own
// example, never a chapter using it. A list carrying only the invented wording would have flagged
// every chapter that already declares its lack of a mandate correctly — a form rule losing to the
// corpus it was measured on.
//
// The list is CLOSED: a similar but unlisted sentence is a finding. Both umlaut spellings are
// accepted — a form rule that trips over a keyboard layout has moved the defect onto the author.
const USER_MANDATE_DEFAULTS = [
    { variant: 'follows-from', pattern: /^\s*\*{0,2}Kein\s+w(?:oe|ö)rtlicher\s+Auftrag\*{0,2}\s*[;:.,—–-]/i },
    { variant: 'from-measurement', pattern: /^\s*\*{0,2}Kein\s+User-Auftrag\*{0,2}\s*[;:.,—–-]/i }
]

const MANDATE_ELEMENT_FIELDS = [ 'element', 'position' ]


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


    // The order the writable sections are PERSISTED in (`block_section.sort`): the four established names
    // first, in the documented reading order, then the remaining writable ones in register order. Pure,
    // and a fresh list on every call so a caller can never reorder the order everyone else reads.
    static sortOrder() {
        const later = BlockSections.writableFields().fields
            .filter( ( field ) => ESTABLISHED_SORT.includes( field ) !== true )
        const fields = ESTABLISHED_SORT.concat( later )

        return { fields }
    }


    // The ordinal ONE writable section is persisted with. An unknown or a `generated` field is a defect
    // here, never ordinal -1: that is precisely what `indexOf` used to hand into the database without a
    // word, and a negative position would sort ahead of every real section.
    static sortOf( { field } ) {
        if( typeof field !== 'string' || field.length === 0 ) {
            throw new Error( 'BlockSections.sortOf: "field" is required (non-empty string)' )
        }

        const { fields } = BlockSections.sortOrder()
        const sort = fields
            .indexOf( field )
        if( sort === -1 ) {
            throw new Error( `BlockSections.sortOf: "${ field }" is not a writable block section — permitted: ${ fields.join( ', ' ) }` )
        }

        return { sort }
    }


    // The permutation gate over the persisted order. It states HOW MANY fields it compared, because a
    // check that found nothing to compare has checked nothing. Every writable field must appear exactly
    // once: a field that lost its ordinal would be written with a silent -1, a duplicated one would give
    // two sections the same position, and an ESTABLISHED name that left the head would move an ordinal
    // that is already stored in existing databases.
    static assertSortOrder() {
        const writable = BlockSections.writableFields().fields
        const { fields } = BlockSections.sortOrder()

        const missing = writable
            .filter( ( field ) => fields.includes( field ) !== true )
        const unknown = fields
            .filter( ( field ) => writable.includes( field ) !== true )
        const duplicated = fields
            .filter( ( field, index ) => fields.indexOf( field ) !== index )
        if( missing.length > 0 || unknown.length > 0 || duplicated.length > 0 ) {
            throw new Error( `BlockSections.assertSortOrder: the persisted order is not a permutation of the ${ writable.length } writable fields — missing: ${ missing.join( ', ' ) || 'none' }; unknown: ${ unknown.join( ', ' ) || 'none' }; duplicated: ${ duplicated.join( ', ' ) || 'none' }` )
        }

        const moved = ESTABLISHED_SORT
            .filter( ( field, index ) => fields[ index ] !== field )
        if( moved.length > 0 ) {
            throw new Error( `BlockSections.assertSortOrder: the established sections ${ moved.join( ', ' ) } left their stored ordinals — ${ ESTABLISHED_SORT.join( ', ' ) } are persisted as 0..${ ESTABLISHED_SORT.length - 1 } and moving them would reorder rows that are already in databases` )
        }

        return { ok: true, checked: fields.length, established: ESTABLISHED_SORT.length }
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


    // The document-level section order (REV-18, Z. 158-172), as a defensive copy — the lists are copied
    // too, so a caller can never mutate the register it reads. Pure: no file access, no state. Since
    // Memo 080 / PRD-R1 this is the source BOTH generators and the document-level lint bind to.
    static documentSections() {
        const sections = DOCUMENT_SECTIONS
            .map( ( entry ) => ( {
                section: entry[ 'section' ],
                required: entry[ 'required' ],
                source: entry[ 'source' ],
                headings: entry[ 'headings' ].slice(),
                fields: entry[ 'fields' ].slice()
            } ) )

        return { sections }
    }


    // The CHAPTER contract (Memo 081, WI-116), as a defensive copy — same form as documentSections():
    // pure, no file access, a fresh list on every call. `repeatable` is a DATUM of the list rather than a
    // special case in the counter: `### Soll-Zustand` may stand 1..n times, every other block once.
    static chapterContract() {
        const contract = CHAPTER_CONTRACT
            .map( ( entry ) => ( {
                heading: entry[ 'heading' ],
                required: entry[ 'required' ],
                repeatable: entry[ 'repeatable' ],
                registered: entry[ 'registered' ],
                overview: entry[ 'overview' ]
            } ) )

        return { contract }
    }


    // The FORM of the `### User-Auftrag` section (Memo 081, WI-115), as a defensive copy — same shape
    // as chapterContract(): pure, no file access, a fresh list on every call. The patterns are rebuilt
    // as NEW RegExp objects rather than handed out: a RegExp is mutable (`lastIndex`), so passing the
    // register's own object would let one caller move the next caller's cursor.
    //
    // `elements` is ordered by `position` and that order IS the rule — the caller checks the sequence
    // against it instead of typing 1, 2, 3 a second time.
    static userMandateForm() {
        const elements = USER_MANDATE_ELEMENTS
            .map( ( entry ) => ( {
                element: entry[ 'element' ],
                position: entry[ 'position' ],
                required: entry[ 'required' ],
                pattern: new RegExp( entry[ 'pattern' ].source, entry[ 'pattern' ].flags )
            } ) )
            .sort( ( a, b ) => a[ 'position' ] - b[ 'position' ] )
        const defaults = USER_MANDATE_DEFAULTS
            .map( ( entry ) => ( {
                variant: entry[ 'variant' ],
                pattern: new RegExp( entry[ 'pattern' ].source, entry[ 'pattern' ].flags )
            } ) )

        return { elements, defaults }
    }


    // LOAD-TIME GATE over the mandate form. Same duty as assertChapterContract: a half-declared form
    // must break the IMPORT, not some later read, and the gate states how much it compared.
    //
    // It also binds the form to the REGISTER: the form describes `### User-Auftrag`, so that heading
    // must be a section this register recognises. Without that bind the form could quietly describe a
    // section nobody parses — a rule about nothing, reporting green.
    static assertUserMandateForm() {
        const incomplete = USER_MANDATE_ELEMENTS
            .filter( ( entry ) => MANDATE_ELEMENT_FIELDS.some( ( key ) => entry[ key ] === undefined || entry[ key ] === null ) || typeof entry[ 'element' ] !== 'string' || entry[ 'element' ].length === 0 || Number.isInteger( entry[ 'position' ] ) !== true || typeof entry[ 'required' ] !== 'boolean' || ( entry[ 'pattern' ] instanceof RegExp ) !== true )
        if( incomplete.length > 0 ) {
            throw new Error( `BlockSections.assertUserMandateForm: ${ incomplete.length } element(s) lack a non-empty element name, an integer position, a boolean required or a RegExp pattern — every key is mandatory, none is defaulted` )
        }

        const positions = USER_MANDATE_ELEMENTS
            .map( ( entry ) => entry[ 'position' ] )
            .sort( ( a, b ) => a - b )
        const expected = USER_MANDATE_ELEMENTS
            .map( ( entry, index ) => index + 1 )
        const misnumbered = positions
            .filter( ( position, index ) => position !== expected[ index ] )
        if( misnumbered.length > 0 || positions.length === 0 ) {
            throw new Error( `BlockSections.assertUserMandateForm: the positions are ${ positions.join( ', ' ) || 'none' } but must be exactly 1..${ USER_MANDATE_ELEMENTS.length } without a gap or a duplicate — the order IS the rule, so a hole in it is a defect, never a default` )
        }

        // The optional element must be the LAST one. An optional element in the middle would make the
        // sequence undecidable: a missing middle element and a shifted one look the same.
        const optional = USER_MANDATE_ELEMENTS
            .filter( ( entry ) => entry[ 'required' ] !== true )
        const misplaced = optional
            .filter( ( entry ) => entry[ 'position' ] !== USER_MANDATE_ELEMENTS.length )
        if( misplaced.length > 0 ) {
            throw new Error( `BlockSections.assertUserMandateForm: the optional element(s) ${ misplaced.map( ( entry ) => entry[ 'element' ] ).join( ', ' ) } do not sit last — an optional element in the middle makes "missing" and "out of order" indistinguishable` )
        }

        const brokenDefaults = USER_MANDATE_DEFAULTS
            .filter( ( entry ) => typeof entry[ 'variant' ] !== 'string' || entry[ 'variant' ].length === 0 || ( entry[ 'pattern' ] instanceof RegExp ) !== true )
        if( brokenDefaults.length > 0 || USER_MANDATE_DEFAULTS.length === 0 ) {
            throw new Error( `BlockSections.assertUserMandateForm: ${ brokenDefaults.length } default sentence(s) lack a non-empty variant or a RegExp pattern, and the list must not be empty — an empty list would accept nothing and report it as a clean run` )
        }

        const { matched } = BlockSections.match( { text: 'User-Auftrag' } )
        if( matched !== true ) {
            throw new Error( 'BlockSections.assertUserMandateForm: the form describes "User-Auftrag" but the register does not recognise that heading — a form describing a section nobody parses is a rule about nothing' )
        }

        return { ok: true, checked: USER_MANDATE_ELEMENTS.length, required: USER_MANDATE_ELEMENTS.length - optional.length, defaults: USER_MANDATE_DEFAULTS.length }
    }


    // Recognise ONE heading text as a CONTRACT building block. It exists because the contract is NOT a
    // pure subset of the register: `### Kontext` is mandatory and unregistered (see CHAPTER_CONTRACT), so
    // a counter that asked match() alone would silently stop checking a mandatory block and report a
    // smaller basis as a green one. Same #probe, same suffix separators, same case folding as match() —
    // ONE recogniser living in the register, never a second one in the caller. The longest label wins, so
    // `### Ist-Zustand` cannot be shadowed by a shorter contract heading.
    static matchContract( { text } ) {
        const raw = typeof text === 'string' ? text.trim() : ''
        if( raw.length === 0 ) {
            return { matched: false, heading: null, suffix: null }
        }

        const hits = CHAPTER_CONTRACT
            .map( ( entry ) => ( { entry, probe: BlockSections.#probe( { raw, label: entry[ 'heading' ] } ) } ) )
            .filter( ( candidate ) => candidate[ 'probe' ].hit === true )
            .sort( ( a, b ) => b[ 'entry' ][ 'heading' ].length - a[ 'entry' ][ 'heading' ].length )
        if( hits.length === 0 ) {
            return { matched: false, heading: null, suffix: null }
        }

        const best = hits[ 0 ]

        return { matched: true, heading: best[ 'entry' ][ 'heading' ], suffix: best[ 'probe' ].suffix }
    }


    // LOAD-TIME GATE over the contract, and the reason it exists: without it the contract would be the
    // FOURTH diverging copy instead of the first shared one. A contract entry naming a heading the
    // register does not know breaks the IMPORT, not some later read — and it states how many entries it
    // held against how many register entries, because a gate that found nothing to compare has compared
    // nothing.
    static assertChapterContract() {
        const incomplete = CHAPTER_CONTRACT
            .filter( ( entry ) => typeof entry[ 'heading' ] !== 'string' || entry[ 'heading' ].length === 0 || CONTRACT_FIELDS.some( ( key ) => typeof entry[ key ] !== 'boolean' ) )
        if( incomplete.length > 0 ) {
            throw new Error( `BlockSections.assertChapterContract: ${ incomplete.length } contract entry/entries lack a heading or a boolean ${ CONTRACT_FIELDS.join( '/' ) } — every key is mandatory, none is defaulted` )
        }

        const misdeclared = CHAPTER_CONTRACT
            .filter( ( entry ) => ( BlockSections.match( { text: entry[ 'heading' ] } ).matched === true ) !== entry[ 'registered' ] )
        if( misdeclared.length > 0 ) {
            throw new Error( `BlockSections.assertChapterContract: the contract heading(s) ${ misdeclared.map( ( entry ) => entry[ 'heading' ] ).join( ', ' ) } declare "registered" against what the register actually answers — the contract is a SUBSET of the ${ SECTIONS.length } recognised sections plus the named exceptions, never a list beside them` )
        }

        const exceptions = CHAPTER_CONTRACT
            .filter( ( entry ) => entry[ 'registered' ] !== true )
            .map( ( entry ) => entry[ 'heading' ] )
        const unexpected = exceptions
            .filter( ( heading ) => UNREGISTERED_CONTRACT.includes( heading ) !== true )
        if( unexpected.length > 0 || exceptions.length !== UNREGISTERED_CONTRACT.length ) {
            throw new Error( `BlockSections.assertChapterContract: the unregistered contract headings are ${ exceptions.join( ', ' ) || 'none' } but exactly ${ UNREGISTERED_CONTRACT.join( ', ' ) } is declared — a heading that leaves the register must be a visible edit, never a quiet one` )
        }

        return { ok: true, checked: CHAPTER_CONTRACT.length, registered: CHAPTER_CONTRACT.length - exceptions.length, exceptions: exceptions.length, register: SECTIONS.length }
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
// LOAD-TIME GATE, second half: the persisted ordinal order must stay a permutation of the writable
// fields with the four established names on their stored positions. Widening the register again must
// break the import here, not silently move an ordinal that databases already carry.
BlockSections.assertSortOrder()
// LOAD-TIME GATE, third half (Memo 081, WI-116): every heading of the chapter contract must resolve in
// the register. A contract that names a heading nobody recognises would be a fourth divergent copy of
// the very list this register exists to unify.
BlockSections.assertChapterContract()
// LOAD-TIME GATE, fourth half (Memo 081, WI-115): the form of `### User-Auftrag` must be complete, its
// positions must be 1..n without a hole, its optional element must sit last, and the heading it
// describes must resolve in the register. A form that describes a section nobody parses would report
// green over nothing.
BlockSections.assertUserMandateForm()


export { BlockSections, KINDS, WRITABLE_KINDS, SUFFIX_SEPARATORS, ESTABLISHED_SORT }
