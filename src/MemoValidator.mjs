import { DocumentRegistry } from './DocumentRegistry.mjs'
import { BlockMeta } from './BlockMeta.mjs'
import { invalidOptionKinds } from './QuestionContract.mjs'
import { OptionQualityLint } from './OptionQualityLint.mjs'
import { BlockSections } from './BlockSections.mjs'


// PRD-036/037/038 (Memo 016, Kap 13): deterministic, server-side, STRUCTURAL validation of
// a revision before it is delivered to the View/AI. Not a content judgement — it answers:
// "Did question parsing work? Is the structure correct? Are required fields present?".
//
// Error-Code catalogue (PRD-037), PREFIX-NUMBER per node-error-codes SKILL.md:
//   MEMO-NNN  → ERROR   (blocking, goes to `messages`)
//   INFO-NNN  → INFO    (advisory, goes to `info`, never blocks)
// Number blocks have gaps so codes can be inserted later without renumbering; letter
// suffixes (MEMO-020a/b/c) distinguish variants of the same theme.
//
//   Sections      MEMO-001–009   Pflicht-Sections fehlen
//   Header        MEMO-010–019   Header-Felder / Schema-Version-Marker
//   Frage         MEMO-020–029   ### F{N}-Block unvollstaendig (Hintergrund/Frage/AI)
//   Optionen      MEMO-030–033   Optionen nicht parsebar (Klammern statt Zeilen) / kind ungueltig
//   Options-Guete MEMO-034–039   Options-Qualitaetsregeln (Memo 080, PRD-F4, Kap 18)
//   Typ-Badge     MEMO-040–049   Typ single/multi inkonsistent (Checkliste = multi)
//   JSON-Block    MEMO-050–059   Fragen-JSON-Codeblock malformed (PRD-039)
//   Dateiname     MEMO-060–069   Revisions-Dateiname-Suffix malformed (Memo 012, Kap 3)
//   Lifecycle     MEMO-070–079   Restmarker im finalen Dokument (Memo 012, Kap 3)
//   Block-Meta    MEMO-080–089   block-meta Overlay-Feld malformed (Memo 012, Kap 7)
//   Advisory      INFO-001–099   Hinweise ohne Blockierung
//
// Memo 012, Kap 3 (F-Forensik §5): four error classes the validator did NOT catch before
// but memo-revision-evaluate relies on. MEMO-031/032 extend the per-question Optionen checks;
// MEMO-060 needs the file name; MEMO-070 needs the raw doc. All four feed the same `messages`
// channel as the existing ERROR codes, so `memo lint` (the SSOT CLI wrapper) inherits them.
const ERROR_CODE_CATALOG = [
    { 'code': 'MEMO-001', 'severity': 'ERROR', 'theme': 'sections', 'description': 'Required section missing' },
    { 'code': 'MEMO-002', 'severity': 'ERROR', 'theme': 'input', 'description': 'Document is empty or not a string' },
    { 'code': 'MEMO-010', 'severity': 'ERROR', 'theme': 'header', 'description': 'Header field missing' },
    { 'code': 'MEMO-020a', 'severity': 'ERROR', 'theme': 'frage', 'description': 'Missing required field: Hintergrund' },
    { 'code': 'MEMO-020b', 'severity': 'ERROR', 'theme': 'frage', 'description': 'Missing required field: Frage' },
    { 'code': 'MEMO-020c', 'severity': 'ERROR', 'theme': 'frage', 'description': 'Missing required field: AI-Empfehlung' },
    { 'code': 'MEMO-020d', 'severity': 'ERROR', 'theme': 'frage', 'description': 'Malformed: AI-Empfehlung references no existing option' },
    { 'code': 'MEMO-025', 'severity': 'ERROR', 'theme': 'frage-parse', 'description': 'Question parsing incomplete (heading count differs from parsed questions)' },
    { 'code': 'MEMO-030', 'severity': 'ERROR', 'theme': 'optionen', 'description': 'Options not parseable (use discrete lines, not inline parentheses)' },
    { 'code': 'MEMO-040', 'severity': 'ERROR', 'theme': 'typ', 'description': 'Checklist must be typ=multi' },
    { 'code': 'MEMO-050', 'severity': 'ERROR', 'theme': 'json-block', 'description': 'Questions JSON codeblock is malformed' },
    { 'code': 'MEMO-031', 'severity': 'ERROR', 'theme': 'optionen', 'description': 'Option marker is bold-wrapped (e.g. "**A)**" / "**A:**") and does not parse as an option' },
    { 'code': 'MEMO-032', 'severity': 'ERROR', 'theme': 'optionen', 'description': 'Duplicate option within a question (duplicate key, or an authored option duplicates the injected custom/topic default)' },
    { 'code': 'MEMO-033', 'severity': 'ERROR', 'theme': 'optionen', 'description': 'Option kind is not one of {option, custom, topic, reframe, reoption} — the renderer drops such an option (Memo 041 Teil B, the split-brain fix)' },
    { 'code': 'MEMO-060', 'severity': 'ERROR', 'theme': 'filename', 'description': 'Revision filename suffix malformed (expected REV-NN.md, REV-NN-prepare.md or REV-NN-update.md)' },
    { 'code': 'MEMO-070', 'severity': 'ERROR', 'theme': 'lifecycle', 'description': 'Unresolved "[Research offen]" marker present outside code spans' },
    { 'code': 'MEMO-080', 'severity': 'ERROR', 'theme': 'block-meta', 'description': 'block-meta overlay block is malformed (invalid JSON; topic/prd ids not in T001 / PRD-001 shape; or a Parent/Child invariant is violated — child carrying prds, a block mixing singular topic with plural topics, or a grandchild/second level)' },
    { 'code': 'INFO-010', 'severity': 'INFO', 'theme': 'header', 'description': 'Schema-Version marker missing (advisory until writing skills set it)' },
    { 'code': 'WARN-010', 'severity': 'WARNING', 'theme': 'frage-continuity', 'description': 'Open-question set shrank between revisions without a matching new answered entry (Memo 067 WI-6-09: every revision must carry the FULL open-questions set)' },
    // Memo 080, PRD-R1 Vollausbau — the DOCUMENT LEVEL as a check (REV-18 Z. 154-172). Both enter the
    // catalogue as WARNING and are switched on for `full` ONLY (REVISION_SCHEMA below).
    //
    // THE SHARPENING RULE — WARNING -> ERROR — IS A NAMED CONDITION, NOT A JUDGEMENT CALL:
    //   1. measure the corpus AGAIN, grouped by revision type (full / update / prepare), each group
    //      stating HOW MANY files it compared. A group with 0 compared files is RED, never green.
    //   2. sharpen only when the FULL group shows 0 hits of the code being sharpened.
    //   3. otherwise it stays WARNING and the measured stand is recorded as a snag (`memo snag add`) —
    //      no suspended state, no silent exception.
    // The figures of the PRD are NOT a substitute for that measurement: a severity raised against a
    // number nobody re-measured is a claim, not a gate.
    { 'code': 'WARN-020', 'severity': 'WARNING', 'theme': 'dokument-ebene', 'description': 'The document section sequence deviates from the declared document-level order (BlockSections.documentSections, REV-18 Z. 158-172)' },
    { 'code': 'WARN-021', 'severity': 'WARNING', 'theme': 'header', 'description': 'A head field of the document level is missing (Typ, Aenderungen — REV-18 Z. 160; the MEMO-010 duty is a SUBSET of the form requirement, not its replacement)' },
    // Memo 080, Kap 14 / WI-172 — the CROSS-revision counterpart of SR-13. SR-13 sees one file and
    // flags the pointer that replaces content; WARN-011 sees two files and names what LEFT the
    // document. Measured 2026-09-03 over the memo-080 revisions: REV-01 -> REV-02 lost the
    // `User-Auftrag` block in 8 of 9 compared chapters, REV-17 -> REV-18 in 0 of 25.
    { 'code': 'WARN-011', 'severity': 'WARNING', 'theme': 'standalone-continuity', 'description': 'A chapter lost substance against the predecessor revision — a dropped User-Auftrag block, a chapter shrunk below half its non-empty lines, or a fallen evidence-marker balance (Memo 080 Kap 14: a revision carries its whole content itself)' },
    // Memo 080, PRD-F4 (Kap 18) — the eight OPTION-QUALITY rules, moved out of prose into a decidable
    // predicate. The engine is OptionQualityLint (repos/viewer/src); the codes enter THIS catalogue, the
    // only one, so `memo lint` and `POST /api/validate` inherit the check without a second rule copy.
    //
    // NUMBERING — MEASURED, NOT ASSUMED. PRD-F4 assigns the four warnings to WARN-020..023 and calls that
    // range free. Measured against this file on 2026-09-06 it is not: WARN-020 and WARN-021 above were
    // taken by PRD-R1 Vollausbau. The warnings therefore take the next free block, WARN-030..034, per the
    // "number blocks have gaps" convention at the top of this comment. MEMO-034..039 and INFO-020 were
    // measured free (0 catalogue hits) and keep the numbers the PRD assigns.
    //
    // THEME — THE SECOND DEVIATION FROM THE PRD, NAMED HERE SO IT IS NOT FOUND AS A SURPRISE. PRD-F4 / A9
    // prescribes the theme `optionen` (resp. `frage`). These entries carry a NEW theme, `optionen-guete`,
    // and that is load-bearing rather than cosmetic: the transcript reject-gate selects the question-format
    // family BY THEME (see QUESTION_FORMAT_THEMES below), so filing the option-QUALITY codes under
    // `optionen` would have made every one of them a reason to reject a transcript — a door this work never
    // meant to touch. The quality family is a different subject from the parse family, and the theme says so.
    //
    // SCOPE (A10) — the six ERROR codes fire on OPEN questions that carry at least one quality field. Two
    // classes are SKIPPED and COUNTED rather than graded, and the counts ride in `optionQuality`:
    //   answered records  — the decision record, not a draft; grading it would falsify the very record
    //                       memo-mental-model-derive reads (233 in the stock, measured 2026-09-06). A10's
    //                       "degradieren zu INFO" is deliberately REPLACED by this counted skip; the
    //                       reasoning stands at the head of OptionQualityLint.mjs.
    //   legacy-shaped     — an open question carrying none of the nine fields predates the standard, so
    //                       there is nothing on it to decide any rule against (808 of 808 open questions
    //                       in the stock, and every revision RevisionAssembler generates today). The skip
    //                       is stated as WARN-034 naming every ungraded id, and a run that measured
    //                       nothing emits INFO-020 on top of it.
    // The moment a question carries ONE field it is measured in FULL — a half-adopted object is loud.
    //
    // WHY THE SKIP NEEDS ITS OWN CODE AND NOT ONLY A COUNTER. INFO-020 answers "did the run compare
    // anything at all?" and therefore goes quiet as soon as ONE question was measured — which is exactly
    // the MIXED block the transition period consists of. Measured 2026-09-06: a block with one opted-in
    // question next to one legacy-shaped one reported the first and named the second nowhere. WARN-034
    // closes that, and it is a WARNING rather than an INFO because an ungraded OPEN question is
    // actionable (one field opts it in) and because the warnings channel is the one every caller carries.
    { 'code': 'MEMO-034', 'severity': 'ERROR', 'theme': 'optionen-guete', 'description': 'Option set is not balanced — the way forward (continues: true, scope !== "smaller") or the smaller cut (scope: "smaller") is missing; also fires when an option scope sits outside the closed list, which makes the predicate undecidable (A1/C2)' },
    { 'code': 'MEMO-035', 'severity': 'ERROR', 'theme': 'optionen-guete', 'description': 'One decision per question is not established — "dimension" missing, an option "value" missing, or two real options taking the same value (A2)' },
    { 'code': 'MEMO-036', 'severity': 'ERROR', 'theme': 'optionen-guete', 'description': 'Real option without a non-empty "effect" — every option names in half a sentence what follows when it is chosen (A3)' },
    { 'code': 'MEMO-037', 'severity': 'ERROR', 'theme': 'optionen-guete', 'description': 'Time expression in the "label" or "value" of a subject-matter option — the rollout moment is the user\'s own question and is never bundled into a subject option (A4)' },
    { 'code': 'MEMO-038', 'severity': 'ERROR', 'theme': 'optionen-guete', 'description': 'Option names a postponement but carries no "deferCost" — no flat penalty, but no concealed price either (A5)' },
    { 'code': 'MEMO-039', 'severity': 'ERROR', 'theme': 'optionen-guete', 'description': '"sharedPremise" is set but not exactly one real option carries deniesPremise: true (A6 — the CONSISTENCY is checked; whether the author noticed a premise is not machine-decidable and is not claimed)' },
    { 'code': 'WARN-030', 'severity': 'WARNING', 'theme': 'optionen-guete', 'description': 'The question sentence bundles two decisions ("… und mit welchem / wie / ob / welche …") — split it into one question per decision (R1)' },
    { 'code': 'WARN-031', 'severity': 'WARNING', 'theme': 'optionen-guete', 'description': 'An option label couples goal and measure (";", " + ", " und ") — one option row carries one value (R3)' },
    { 'code': 'WARN-032', 'severity': 'WARNING', 'theme': 'optionen-guete', 'description': 'A non-approved word from the anchor register\'s misLabels[] sits in title/question/label/value — use the approved label (A7/R6). Only checked when the register was handed in; otherwise the run reports registerAvailable: false and the rule counts as NOT checked' },
    { 'code': 'WARN-033', 'severity': 'WARNING', 'theme': 'optionen-guete', 'description': '"mentalModelCheck" missing or empty — state "aligned" or name the collision with the known user tendency (A8, advisory: it never answers the question and never removes it)' },
    { 'code': 'WARN-034', 'severity': 'WARNING', 'theme': 'optionen-guete', 'description': 'Open questions were left UNGRADED because they carry none of the option-quality fields — the finding names every id, so a MIXED block cannot report the opted-in question and stay silent about the one next to it (A11). Non-blocking while the writing path adopts the fields; one field opts an object in and it is then measured in full' },
    { 'code': 'INFO-020', 'severity': 'INFO', 'theme': 'optionen-guete', 'description': 'The option-quality lint examined 0 open questions although a questions-json block was present — the run reports that it compared nothing instead of reporting a green zero (A11)' }
]


// THE QUESTION-FORMAT FAMILY — the codes that say a submitted body's question block does not PARSE
// cleanly. It is a THEME list, not a number range, and that is the whole point (Memo 080, PRD-F4).
//
// The reject-gate of POST /api/transcripts (MemoView.#computeQuestionReject) used to select these
// codes with /^MEMO-(02\d?[a-d]?|03\d|04\d|05\d)\b/. A numeric range silently ADOPTS every code later
// added inside it: the moment MEMO-034..039 entered the catalogue, `03\d` matched them too and a
// transcript could be rejected on option-QUALITY grounds — a door the option-quality work never
// meant to touch. Narrowing the range to `03[0-3]` would have closed that one case and left the same
// trap armed for the next code in any of the four blocks.
//
// So the selection reads the catalogue instead. A code belongs to the family when ITS OWN entry
// carries one of these themes; a code with a new theme (`optionen-guete`) is not in the family and
// cannot creep in by number. The set is exactly what the gate's contract names: the question fields
// (MEMO-020a-d), the question parse (MEMO-025), the option parse (MEMO-030..033), the type badge
// (MEMO-040) and the JSON block (MEMO-050) — the PRD-004 clean-parse truth.
//
// A code that is NOT in the catalogue is not in the family: the catalogue is the ONE catalogue, so an
// unknown code is a defect of the emitter, and treating it as a reject reason would let an unnamed
// code block a write.
const QUESTION_FORMAT_THEMES = [ 'frage', 'frage-parse', 'optionen', 'typ', 'json-block' ]


// Memo 080, Kap 16 / WI-218 (T106): a revision file is not one shape but three. `full`
// (REV-NN.md), `update` (REV-NN-update.md) and `prepare` (REV-NN-prepare.md) carry DIFFERENT
// obligations by definition, yet every file was checked against the full-revision schema — which
// made the gate worthless exactly there (measured 2026-08-31 over 514 revision files: 157 of 157
// prepare files red, none of the findings a duty a prepare file is ever meant to carry).
// This table binds the check families to the revision type. It is the ONE place the per-type
// duties live; no rule is copied further down and no new error code is introduced — MEMO-001 and
// MEMO-010 keep their number, severity and theme, only their required set becomes type-dependent.
//
//   sections        the MEMO-001 required-section list of this type
//   sectionAliases  accepted alternative headings per section (both spellings occur in the corpus)
//   headerFields    the MEMO-010 required header-field list of this type
//   headerAliases   accepted alternative field names per header field
//   schemaVersion   INFO-010 advisory Schema-Version hint on/off
//   questionFamilies  MEMO-020a/b/c/d, MEMO-025, MEMO-030..033, MEMO-040, MEMO-050 on/off
//   lifecycleMarker   MEMO-070 "[Research offen]" on/off
//   documentOrder     WARN-020 document-level section sequence on/off (Memo 080, PRD-R1 Vollausbau)
//   documentHeader    WARN-021 document-level head fields on/off (Memo 080, PRD-R1 Vollausbau)
//
// The two document-level checks are `full`-ONLY, and that is the whole reason they can exist at all: an
// order/head duty applied to every file would have hit all 157 prepare artefacts on the first run, for a
// form none of them was ever meant to carry. They are entered in THIS table rather than in a second one
// — there is exactly one place where a per-type duty lives.
//
// A prepare artefact is written BEFORE the revision it plans; its question list is an informal
// planning note ("keine / Liste der offenen Fragen die IN die Revision einfliessen",
// memo-revision-generate/SKILL.md) and it legitimately plans open research — so the question
// families and the lifecycle marker are off for `prepare` and on everywhere else. MEMO-060
// (filename suffix) and MEMO-080 (block-meta) apply to every type.
const REVISION_SCHEMA = {
    'full': {
        'sections': [ 'Kontext', 'Vorwort', 'Offene Fragen', 'Beantwortete Fragen', 'Phasen', 'Phase-Hints', 'Finalisierungs-Checkliste', 'Ancillary Files', 'Rollout-Entry-Points', 'Lessons-Learned' ],
        'sectionAliases': { 'Vorwort': [ 'Vorwort', 'Claude-Vorwort' ] },
        'headerFields': [ 'Memo', 'Memo-Name', 'Revision', 'Datum', 'Status' ],
        'headerAliases': {},
        'schemaVersion': true,
        'questionFamilies': true,
        'lifecycleMarker': true,
        'documentOrder': true,
        'documentHeader': true
    },
    'update': {
        // An update revision replaces or extends chapters but must still carry the FULL set of
        // open questions (spec 07-revisions-and-questions, "Full-Revision vs. Update-Revision
        // Modes") — the two question sections are its structural duty, the four delivery sections
        // (Finalisierungs-Checkliste, Ancillary Files, Rollout-Entry-Points, Lessons-Learned) are
        // not. All 24 update files in the corpus carry the five full header fields, so the header
        // duty stays identical to `full`.
        'sections': [ 'Offene Fragen', 'Beantwortete Fragen' ],
        'sectionAliases': {},
        'headerFields': [ 'Memo', 'Memo-Name', 'Revision', 'Datum', 'Status' ],
        'headerAliases': {},
        'schemaVersion': true,
        'questionFamilies': true,
        'lifecycleMarker': true,
        'documentOrder': false,
        'documentHeader': false
    },
    'prepare': {
        // The three duties of the prepare artefact per memo-revision-generate/SKILL.md
        // ("REV-{XX}-prepare.md Format"). Both spellings of the change heading and both header
        // field names are evidenced in the corpus, hence the alias lists.
        'sections': [ 'Interpretation des Feedbacks', 'Geplante Änderungen pro Kapitel', 'Revisions-Blocker' ],
        'sectionAliases': { 'Geplante Änderungen pro Kapitel': [ 'Geplante Änderungen pro Kapitel', 'Geplante Aenderungen pro Kapitel' ] },
        'headerFields': [ 'Memo', 'Geplante Revision' ],
        'headerAliases': { 'Geplante Revision': [ 'Geplante Revision', 'Revision' ] },
        'schemaVersion': false,
        'questionFamilies': false,
        'lifecycleMarker': false,
        'documentOrder': false,
        'documentHeader': false
    }
}


// Memo 038 Kap 7 (F8=A): the start confidence threshold for an AI "im Namen des Users"
// pre-decision. The AI may only pre-decide a question at VERY high confidence (>= 95 %) and the
// threshold is lowered over time as the User Mental Model proves itself. This is advisory
// provenance metadata only — it never auto-answers a question. The hard rule (F5=A) is enforced by
// #finalizeAnsweredCount below: an 'ai-on-behalf' answer NEVER satisfies the finalize gate on its
// own; it always still needs a user look.
const AI_ON_BEHALF_START_THRESHOLD = 0.95


class MemoValidator {
    // `anchorTerms` (Memo 080, PRD-F4 / A12) is an OPTIONAL payload key and the module stays pure: the
    // validator reads no file, the caller hands the parsed register in (repos/core/cli/lib/lint.mjs does
    // the IO). Its absence is NOT a silent default — it is reported as `optionQuality.registerAvailable:
    // false`, and WARN-032 then counts as not checked rather than as clean.
    static validate( { doc, fileName, anchorTerms } ) {
        // Memo 080, Kap 16 / WI-218: derive the revision type ONCE, then hand it to every check
        // family. Derived before the empty-document guard so even a refusal reports which schema
        // it would have applied.
        const { revisionType } = MemoValidator.#revisionTypeOf( { doc, fileName } )
        // Memo 080, PRD-R1 Vollausbau: `warnings` is a channel of its OWN, deliberately not folded into
        // `messages`. A WARNING that lands in `messages` sets status:false and blocks — which would turn
        // every existing full revision red on the day the check is introduced, before anybody has
        // measured anything. The channel is what makes "enter as WARNING, sharpen later" a real state
        // rather than a promise.
        // Memo 080, PRD-F4: `optionQuality` is the comparison basis of the option-quality family and it
        // rides in EVERY result, including the refusal below. It is a key of its own rather than a member
        // of `checked` on purpose — `checked` is the section/header basis and several suites pin its exact
        // shape; a basis that is bolted onto a foreign one is the drift the whole family exists against.
        //   ran                 did the family run at all (off for `prepare`, off without a json block)
        //   checked             how many OPEN questions in the NEW shape were examined
        //   skippedAnswered     how many answered records were passed over untouched (A10's substitution)
        //   skippedLegacy       how many OPEN questions carried none of the quality fields and could
        //                       therefore not be decided — a named skip, never a green zero
        //   registerAvailable   was an anchor register handed in — WARN-032 counts as checked only then
        const struct = { 'status': false, 'messages': [], 'info': [], 'warnings': [], 'checked': { 'sections': 0, 'headerFields': 0, 'comparedSections': 0, 'comparedHeaderFields': 0 }, 'optionQuality': { 'ran': false, 'checked': 0, 'skippedAnswered': 0, 'skippedLegacy': 0, 'registerAvailable': false }, revisionType }

        if( typeof doc !== 'string' || doc.length === 0 ) {
            const { message } = MemoValidator.#buildMessage( {
                'code': 'MEMO-002',
                'feldPfad': 'doc',
                'description': 'Document is empty or not a string'
            } )
            struct[ 'messages' ] = [ message ]
            struct[ 'status' ] = false

            return struct
        }

        const { questions: markdownQuestions } = DocumentRegistry.parseQuestionSchema( { content: doc } )
        const { questions: jsonQuestions, found: jsonFound, error: jsonError } = DocumentRegistry.parseQuestionJsonBlock( { content: doc } )
        const questionSchema = jsonFound ? { 'questions': jsonQuestions } : { 'questions': markdownQuestions }

        const sections = MemoValidator.#validateRequiredSections( { doc, revisionType } )
        const header = MemoValidator.#validateHeaderFields( { doc, revisionType } )
        const json = MemoValidator.#validateJsonBlock( { doc, jsonFound, jsonError, revisionType } )
        const questions = MemoValidator.#validateQuestions( { doc, questionSchema, jsonFound, revisionType } )
        const optionKinds = MemoValidator.#validateOptionKinds( { doc, jsonFound, revisionType } )
        const optionQuality = MemoValidator.#validateOptionQuality( { doc, jsonFound, revisionType, anchorTerms } )
        const lintExt = MemoValidator.#validateLintExtensions( { doc, fileName, revisionType } )
        const documentOrder = MemoValidator.#validateDocumentOrder( { doc, revisionType } )
        const documentHeader = MemoValidator.#validateDocumentHeader( { doc, revisionType } )

        const messages = []
            .concat( sections[ 'messages' ] )
            .concat( header[ 'messages' ] )
            .concat( json[ 'messages' ] )
            .concat( questions[ 'messages' ] )
            .concat( optionKinds[ 'messages' ] )
            .concat( optionQuality[ 'messages' ] )
            .concat( lintExt[ 'messages' ] )

        const info = []
            .concat( sections[ 'info' ] )
            .concat( header[ 'info' ] )
            .concat( json[ 'info' ] )
            .concat( questions[ 'info' ] )
            .concat( optionKinds[ 'info' ] )
            .concat( optionQuality[ 'info' ] )
            .concat( lintExt[ 'info' ] )

        struct[ 'messages' ] = messages
        struct[ 'info' ] = info
        struct[ 'warnings' ] = documentOrder[ 'warnings' ]
            .concat( documentHeader[ 'warnings' ] )
            .concat( optionQuality[ 'warnings' ] )
        struct[ 'optionQuality' ] = optionQuality[ 'basis' ]
        struct[ 'status' ] = messages.length === 0
        // Memo 080, PRD-R1: a verdict without its comparison basis is not readable. `checked` states HOW
        // MUCH was compared — how many mandatory sections and how many mandatory header fields the run
        // examined — so a `status: true` can be told apart from a run that simply had nothing to check.
        // `comparedSections` / `comparedHeaderFields` are the SAME statement for the two document-level
        // checks (Vollausbau): how many declared positions and how many declared head fields they held
        // the document against. Both are 0 when the check did not RUN for this revision type — which is a
        // different statement from "ran and found nothing to compare", and that second case emits its own
        // warning instead of reporting a green zero.
        struct[ 'checked' ] = {
            'sections': sections[ 'checked' ],
            'headerFields': header[ 'checked' ],
            'comparedSections': documentOrder[ 'checked' ],
            'comparedHeaderFields': documentHeader[ 'checked' ]
        }

        return struct
    }


    static classify( { code } ) {
        const prefix = typeof code === 'string' ? code.split( '-' )[ 0 ] : ''
        // Memo 067 WI-6-09: WARN-NNN is a non-blocking WARNING channel (viewer-lint), distinct from
        // the blocking MEMO-NNN ERROR channel and the advisory INFO-NNN channel.
        const severity = prefix === 'INFO' ? 'INFO' : ( prefix === 'WARN' ? 'WARNING' : 'ERROR' )

        return { severity }
    }


    // isQuestionFormatCode — does this code belong to the QUESTION-FORMAT family (see
    // QUESTION_FORMAT_THEMES)? Public because the reject-gate of POST /api/transcripts lives in
    // MemoView and its test drives the SAME predicate: a hand-kept regex copy in either place is how
    // the two came to disagree in the first place. `code` may be a bare code or the first token of a
    // message; anything else answers false rather than throwing.
    static isQuestionFormatCode( { code } ) {
        const token = typeof code === 'string' ? code.trim().split( ' ' )[ 0 ] : ''
        const entry = ERROR_CODE_CATALOG.find( ( item ) => item[ 'code' ] === token )
        if( entry === undefined ) { return { 'questionFormat': false } }

        return { 'questionFormat': QUESTION_FORMAT_THEMES.includes( entry[ 'theme' ] ) }
    }


    static checkQuestionContinuity( { current, previous } ) {
        // Memo 067 WI-6-09 (F6=A) — non-blocking viewer-lint (WARN-010). Every revision must carry
        // the FULL open-questions set; a question may only LEAVE the open set by being answered
        // (moving to `## Beantwortete Fragen`). This compares a revision against its predecessor: if
        // the OPEN set shrank but the shrink is NOT covered by a matching gain in answered questions,
        // questions vanished silently -> emit WARN-010. Never blocks, never throws.
        const struct = { 'warnings': [] }

        if( typeof current !== 'string' || typeof previous !== 'string' ) {
            return struct
        }

        const prev = DocumentRegistry.parseQuestions( { content: previous } )
        const curr = DocumentRegistry.parseQuestions( { content: current } )

        const openShrink = prev[ 'openCount' ] - curr[ 'openCount' ]
        const answeredGain = Math.max( curr[ 'answeredCount' ] - prev[ 'answeredCount' ], 0 )

        if( openShrink > answeredGain && openShrink > 0 ) {
            const vanished = openShrink - answeredGain
            const { message } = MemoValidator.#buildMessage( {
                'code': 'WARN-010',
                'feldPfad': 'Offene Fragen',
                'description': `Open-question set shrank by ${ openShrink }, only ${ answeredGain } moved to Beantwortete Fragen — ${ vanished } question(s) vanished without an answer`
            } )
            struct[ 'warnings' ].push( message )
        }

        return struct
    }


    static checkStandaloneContinuity( { current, previous } ) {
        // Memo 080, Kap 14 / WI-172 (F23=A) — non-blocking viewer-lint (WARN-011), built like
        // checkQuestionContinuity above. A revision carries its whole content itself; when a chapter
        // survives into the next revision but its substance does not, the diff shows green while the
        // document lost information. This compares a revision against its predecessor over the
        // chapters BOTH carry and reports three findings:
        //   1. chapters that lost their `User-Auftrag` block — the hard indicator, because that block
        //      is the verbatim user wording every later fidelity audit compares against,
        //   2. chapters below HALF their previous non-empty line count,
        //   3. the evidence-marker balance ([FAKT]/[ANNAHME]/[VERMUTUNG]) over the same chapters.
        //
        // `comparedChapters` rides in EVERY result. A verdict without a comparison basis is not a
        // pass: when nothing (or less than half of the predecessor's chapters) could be matched, the
        // only finding is exactly that — measured on REV-02 -> REV-03, where all headings were
        // renamed and a naive check would have reported "0 losses, all green" over 0 chapters.
        // Never blocks, never throws.
        const struct = { 'warnings': [], 'comparedChapters': 0 }

        if( typeof current !== 'string' || typeof previous !== 'string' ) {
            const { message } = MemoValidator.#buildMessage( {
                'code': 'WARN-011',
                'feldPfad': 'Kapitel',
                'description': 'no comparison basis: no predecessor revision was handed in (compared 0 chapters)'
            } )
            struct[ 'warnings' ].push( message )

            return struct
        }

        const previousChapters = MemoValidator.#numberedChapters( { doc: previous } )
        const currentChapters = MemoValidator.#numberedChapters( { doc: current } )
        const currentByKey = new Map( currentChapters.map( ( chapter ) => [ chapter[ 'key' ], chapter ] ) )
        const shared = previousChapters.filter( ( chapter ) => currentByKey.has( chapter[ 'key' ] ) === true )

        struct[ 'comparedChapters' ] = shared.length

        // The basis gate runs FIRST. Below half of the predecessor's chapters it is its OWN finding
        // and rides ALONGSIDE the substantive ones — the losses that WERE found stay reported, they
        // just carry the note that they rest on a thin basis (REV-01 -> REV-02: 8 losses over 9 of 19
        // chapters). At ZERO matched chapters it is the ONLY finding, because there is nothing else
        // to compute and an empty warning list would read as a pass (REV-02 -> REV-03).
        const required = Math.ceil( previousChapters.length / 2 )
        if( shared.length < required || shared.length === 0 ) {
            const { message } = MemoValidator.#buildMessage( {
                'code': 'WARN-011',
                'feldPfad': 'Kapitel',
                'description': `no sufficient comparison basis: ${ shared.length } of ${ previousChapters.length } predecessor chapters matched (${ currentChapters.length } chapters in this revision) — headings were renamed or renumbered, so a "no losses" verdict would rest on nothing`
            } )
            struct[ 'warnings' ].push( message )
        }

        if( shared.length === 0 ) { return struct }

        const lostAuftrag = shared.filter( ( chapter ) => {
            return chapter[ 'hasAuftrag' ] === true && currentByKey.get( chapter[ 'key' ] )[ 'hasAuftrag' ] === false
        } )
        const shrunk = shared.filter( ( chapter ) => {
            const before = chapter[ 'nonEmptyLines' ]
            const after = currentByKey.get( chapter[ 'key' ] )[ 'nonEmptyLines' ]

            return before > 0 && after * 2 < before
        } )
        const evidenceBefore = shared.reduce( ( acc, chapter ) => acc + chapter[ 'evidenceMarks' ], 0 )
        const evidenceAfter = shared.reduce( ( acc, chapter ) => acc + currentByKey.get( chapter[ 'key' ] )[ 'evidenceMarks' ], 0 )

        if( lostAuftrag.length > 0 ) {
            const { message } = MemoValidator.#buildMessage( {
                'code': 'WARN-011',
                'feldPfad': 'User-Auftrag',
                'description': `${ lostAuftrag.length } of ${ shared.length } compared chapters lost their User-Auftrag block: ${ lostAuftrag.map( ( chapter ) => chapter[ 'title' ] ).join( ' | ' ) }`
            } )
            struct[ 'warnings' ].push( message )
        }

        if( shrunk.length > 0 ) {
            const { message } = MemoValidator.#buildMessage( {
                'code': 'WARN-011',
                'feldPfad': 'Kapitel',
                'description': `${ shrunk.length } of ${ shared.length } compared chapters shrank below half their non-empty lines: ${ shrunk.map( ( chapter ) => `${ chapter[ 'title' ] } (${ chapter[ 'nonEmptyLines' ] } -> ${ currentByKey.get( chapter[ 'key' ] )[ 'nonEmptyLines' ] })` ).join( ' | ' ) }`
            } )
            struct[ 'warnings' ].push( message )
        }

        if( evidenceAfter < evidenceBefore ) {
            const { message } = MemoValidator.#buildMessage( {
                'code': 'WARN-011',
                'feldPfad': 'Evidenz',
                'description': `evidence markers over the ${ shared.length } compared chapters fell from ${ evidenceBefore } to ${ evidenceAfter }`
            } )
            struct[ 'warnings' ].push( message )
        }

        return struct
    }


    static getCatalog() {
        return { 'catalog': ERROR_CODE_CATALOG }
    }


    // Memo 038 Kap 7 (P3c, F5=A): the finalize-gate schranke. The "all questions answered" gate
    // for finalize-readiness must NOT count an 'ai-on-behalf' answer as satisfying it on its own —
    // such an answer is an advisory AI pre-decision that ALWAYS still needs a user look. This helper
    // is the single, well-commented guard: given the parsed question list it returns the counts the
    // finalize gate must use. `total` is every question; `answeredByUser` counts only questions that
    // are answered AND were decided by the user (the gate-satisfying answers); `answeredByAi` counts
    // answered questions whose provenance is 'ai-on-behalf' (these need confirmation); `needsUser` is
    // every still-open OR ai-on-behalf question; `gateSatisfied` is true only when EVERY question is
    // user-answered. The advisory start threshold (>= 95 %) is exported separately for callers that
    // surface it — it is provenance, not an auto-answer.
    static finalizeGate( { questions } ) {
        const list = Array.isArray( questions ) ? questions : []

        const total = list.length
        const answeredByUser = list
            .filter( ( question ) => question !== null && typeof question === 'object'
                && question[ 'answered' ] === true
                && MemoValidator.#answeredByOf( { question } ) === 'user' )
            .length
        const answeredByAi = list
            .filter( ( question ) => question !== null && typeof question === 'object'
                && question[ 'answered' ] === true
                && MemoValidator.#answeredByOf( { question } ) === 'ai-on-behalf' )
            .length

        // A question still needs a user look when it is open OR was only AI-pre-decided. The gate
        // is satisfied only when nothing needs a user look anymore (and at least one question exists).
        const needsUser = total - answeredByUser

        return {
            total,
            answeredByUser,
            answeredByAi,
            needsUser,
            'gateSatisfied': total > 0 && needsUser === 0,
            'startThreshold': AI_ON_BEHALF_START_THRESHOLD
        }
    }


    static #answeredByOf( { question } ) {
        // Memo 038 Kap 7: accept only the two known provenance values; default to 'user' so a
        // legacy answered entry (no answeredBy field) counts as a user answer (back-compat).
        return question[ 'answeredBy' ] === 'ai-on-behalf' ? 'ai-on-behalf' : 'user'
    }


    // #numberedChapters — split a revision into its NUMBERED body chapters (`## 3. Fehleranalyse …`).
    // The `key` is the heading normalised the way the corpus demands it: the leading number and every
    // `[Tag]` suffix are stripped, whitespace collapsed, case folded — so `## 3. X [Docs]` in one
    // revision matches `## 4. X [Code]` in the next. Everything else (a renamed heading, an added
    // "— vertieft" tail) is deliberately NOT matched: a renamed chapter is a different chapter, and
    // pretending otherwise is what would silently shrink the comparison basis.
    // Headings inside a fenced code block are ignored — a fenced example is not a chapter.
    static #numberedChapters( { doc } ) {
        const lines = doc.split( '\n' )
        const { flags } = lines.reduce( ( acc, line ) => {
            const isFence = /^\s*```/.test( line )

            return { 'open': isFence === true ? ( acc[ 'open' ] !== true ) : acc[ 'open' ], 'flags': acc[ 'flags' ].concat( [ acc[ 'open' ] === true || isFence === true ] ) }
        }, { 'open': false, 'flags': [] } )

        const starts = lines.reduce( ( acc, line, index ) => {
            if( flags[ index ] === true ) { return acc }
            const heading = line.match( /^##\s+\d+\.\s*(.*)$/ )

            return heading === null ? acc : acc.concat( [ { index, 'title': heading[ 1 ].trim() } ] )
        }, [] )

        return starts.map( ( start, position ) => {
            const end = position + 1 < starts.length ? starts[ position + 1 ][ 'index' ] : lines.length
            const body = lines.slice( start[ 'index' ], end )
            const key = start[ 'title' ]
                .replace( /\[[^\]]*\]/g, ' ' )
                .replace( /\s+/g, ' ' )
                .trim()
                .toLowerCase()

            return {
                key,
                'title': start[ 'title' ],
                'hasAuftrag': body.some( ( line ) => /User-Auftrag/i.test( line ) === true ),
                'nonEmptyLines': body.filter( ( line ) => line.trim().length > 0 ).length,
                'evidenceMarks': body.reduce( ( acc, line ) => acc + ( line.match( /\[(?:FAKT|ANNAHME|VERMUTUNG)\]/g ) || [] ).length, 0 )
            }
        } )
    }


    static #revisionTypeOf( { doc, fileName } ) {
        // Memo 080, Kap 16 / WI-218 — two-stage detection, both stages measured over the corpus.
        //
        // Stage 1: the file name suffix, the SAME form MEMO-060 accepts. This is authoritative
        // whenever a name is supplied (memo lint, the post-revision gate).
        // Stage 2: the document itself, because MemoView.#computeValidation calls validate()
        // WITHOUT a file name. Measured signals: the `# REV-NN-prepare` title or a
        // `| **Geplante Revision** |` header field hits 122 of 157 prepare files with 0 false
        // positives on the 357 non-prepare files; a `| **Typ** | Update …` header field hits
        // 24 of 24 update files with 0 false positives on the 333 full files.
        //
        // Without a signal the type stays `full` — today's behaviour, which keeps every existing
        // call site and every existing test stable.
        const base = typeof fileName === 'string' && fileName.length > 0
            ? fileName.split( '/' ).pop()
            : ''
        const suffixMatch = base.match( /^REV-\d{2}(-prepare|-update)?\.md$/ )

        if( suffixMatch !== null && suffixMatch[ 1 ] === '-prepare' ) { return { 'revisionType': 'prepare' } }
        if( suffixMatch !== null && suffixMatch[ 1 ] === '-update' ) { return { 'revisionType': 'update' } }
        if( suffixMatch !== null ) { return { 'revisionType': 'full' } }

        if( typeof doc !== 'string' || doc.length === 0 ) { return { 'revisionType': 'full' } }

        const prepareTitle = /^#\s+REV-\d+-prepare\b/im.test( doc )
        const prepareHeader = /\|\s*\*\*Geplante Revision\*\*\s*\|/i.test( doc )
        if( prepareTitle === true || prepareHeader === true ) { return { 'revisionType': 'prepare' } }

        const updateHeader = /\|\s*\*\*Typ\*\*\s*\|\s*Update/i.test( doc )
        if( updateHeader === true ) { return { 'revisionType': 'update' } }

        return { 'revisionType': 'full' }
    }


    static #schemaOf( { revisionType } ) {
        const schema = REVISION_SCHEMA[ revisionType ]

        return { 'schema': schema === undefined ? REVISION_SCHEMA[ 'full' ] : schema }
    }


    static #buildMessage( { code, feldPfad, description } ) {
        // node-error-codes Abschnitt 1: `{PREFIX}-{NUMBER} {location}: {description}`.
        const message = `${ code } ${ feldPfad }: ${ description }`

        return { message }
    }


    // Route ONE finding into the channel its severity belongs to. WARNING is its own channel since Memo
    // 080 / PRD-R1 Vollausbau; a caller that can emit a WARN code MUST hand the array in. Falling back to
    // `messages` would make a non-blocking code block — the defect this guard closes for the WHOLE class,
    // not only for the two codes that exist today.
    static #route( { code, feldPfad, description, messages, info, warnings } ) {
        const { severity } = MemoValidator.classify( { code } )
        const { message } = MemoValidator.#buildMessage( { code, feldPfad, description } )

        if( severity === 'WARNING' ) {
            if( Array.isArray( warnings ) !== true ) {
                throw new Error( `MemoValidator.#route: "${ code }" is a WARNING and needs the non-blocking "warnings" channel — routing it into "messages" would make an advisory code block` )
            }
            warnings.push( message )

            return { messages, info, warnings }
        }

        if( severity === 'INFO' ) {
            info.push( message )
        } else {
            messages.push( message )
        }

        return { messages, info, warnings }
    }


    // WARN-020 — the DOCUMENT ORDER (Memo 080, PRD-R1 Vollausbau / WI-027). The sequence of the level-2
    // headings a document carries is held against the ONE declared document-level order
    // (BlockSections.documentSections, REV-18 Z. 158-172). Only positions that are PRESENT are compared:
    // a missing section is MEMO-001's subject, not this check's, and reporting it twice would say the same
    // thing in two channels.
    //
    // `Kopf` carries no level-2 heading (it is a table) and is therefore not part of the compared
    // sequence. A position may be written under more than one heading — "Phasen und Phasen-Hinweise" is
    // `## Phasen` plus `## Phase-Hints`, `Vorwort` also as `## Claude-Vorwort` — so the FIRST heading of a
    // position that appears decides its place.
    //
    // A RUN THAT COMPARED NOTHING IS RED: zero recognised positions has no comparison basis, and the
    // honest answer is a warning that says so, never a silent green.
    static #validateDocumentOrder( { doc, revisionType } ) {
        const struct = { 'messages': [], 'info': [], 'warnings': [], 'checked': 0 }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )
        if( schema[ 'documentOrder' ] !== true ) { return struct }

        const lines = typeof doc === 'string' ? doc.split( '\n' ) : []
        const positions = BlockSections.documentSections().sections
            .filter( ( entry ) => entry[ 'headings' ].length > 0 )
        const declared = positions
            .map( ( entry ) => ( { 'section': entry[ 'section' ], 'index': MemoValidator.#firstHeadingIndex( { lines, headings: entry[ 'headings' ] } ) } ) )
            .filter( ( entry ) => entry[ 'index' ] !== -1 )

        struct[ 'checked' ] = declared.length

        if( declared.length === 0 ) {
            MemoValidator.#route( {
                'code': 'WARN-020',
                'feldPfad': 'document.order',
                'description': `No declared document-level section was found, so 0 of ${ positions.length } positions could be compared — a check without a comparison basis reports red, not green`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ],
                'warnings': struct[ 'warnings' ]
            } )

            return struct
        }

        const actual = declared
            .slice()
            .sort( ( a, b ) => a[ 'index' ] - b[ 'index' ] )
        const mismatches = declared
            .map( ( entry, position ) => ( { 'position': position + 1, 'expected': entry[ 'section' ], 'found': actual[ position ][ 'section' ] } ) )
            .filter( ( entry ) => entry[ 'expected' ] !== entry[ 'found' ] )

        if( mismatches.length > 0 ) {
            const first = mismatches[ 0 ]
            MemoValidator.#route( {
                'code': 'WARN-020',
                'feldPfad': 'document.order',
                'description': `Document section sequence deviates from the declared order: at position ${ first[ 'position' ] } expected "${ first[ 'expected' ] }" but found "${ first[ 'found' ] }" (${ mismatches.length } of ${ declared.length } compared positions out of order)`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ],
                'warnings': struct[ 'warnings' ]
            } )
        }

        return struct
    }


    // The line index of the FIRST `## <heading>` line matching any accepted heading of a position, or -1.
    static #firstHeadingIndex( { lines, headings } ) {
        const patterns = headings
            .map( ( heading ) => new RegExp( `^##\\s+${ heading.replace( /[.*+?^${}()|[\]\\-]/g, '\\$&' ) }\\s*$` ) )

        return lines
            .findIndex( ( line ) => patterns.some( ( pattern ) => pattern.test( line ) === true ) )
    }


    // WARN-021 — the DOCUMENT-LEVEL HEAD FIELDS (Memo 080, PRD-R1 Vollausbau). The form requirement names
    // the head as `Memo, Revision, Datum, Typ, Aenderungen` (REV-18 Z. 160); the MEMO-010 duty of this
    // revision type covers part of that set. What is compared here is exactly the REMAINDER, so a field is
    // never reported twice under two codes. On today's `full` schema the remainder is `Typ` and
    // `Aenderungen` — derived, not typed out, so widening either list keeps the two in step.
    static #validateDocumentHeader( { doc, revisionType } ) {
        const struct = { 'messages': [], 'info': [], 'warnings': [], 'checked': 0 }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )
        if( schema[ 'documentHeader' ] !== true ) { return struct }

        const kopf = BlockSections.documentSections().sections
            .find( ( entry ) => entry[ 'fields' ].length > 0 )
        const covered = schema[ 'headerFields' ]
        const remainder = kopf === undefined
            ? []
            : kopf[ 'fields' ].filter( ( field ) => covered.includes( field ) !== true )

        struct[ 'checked' ] = remainder.length

        if( remainder.length === 0 ) {
            MemoValidator.#route( {
                'code': 'WARN-021',
                'feldPfad': 'document.header',
                'description': 'The document level declares no head field beyond the MEMO-010 set, so 0 fields could be compared — a check without a comparison basis reports red, not green',
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ],
                'warnings': struct[ 'warnings' ]
            } )

            return struct
        }

        remainder
            .forEach( ( field ) => {
                const pattern = new RegExp( `\\|\\s*\\*\\*${ field }\\*\\*\\s*\\|\\s*([^|]*?)\\s*\\|`, 'i' )
                const matched = typeof doc === 'string' ? doc.match( pattern ) : null
                const value = matched === null ? '' : matched[ 1 ].trim()

                if( matched === null || value.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'WARN-021',
                        'feldPfad': `header.${ field.replace( /\s+/g, '' ) }`,
                        'description': `Head field of the document level ${ matched === null ? 'missing' : 'empty' } (expected "| **${ field }** | ... |"; ${ remainder.length } document-level head field(s) compared)`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ],
                        'warnings': struct[ 'warnings' ]
                    } )
                }
            } )

        return struct
    }


    static #validateRequiredSections( { doc, revisionType } ) {
        const struct = { 'messages': [], 'info': [], 'checked': 0 }
        // PRD-002 (Memo 011, Kap 10) defined the 10 mandatory sections of a FULL revision = the 9
        // canonical Pflicht-Sections from memo-init/SKILL.md ("Pflicht-Sections (PRD-029)" table)
        // PLUS `Beantwortete Fragen`. `Beantwortete Fragen` is kept (validation finding REV-05)
        // because the REV format uses it throughout (F1–F18) — the validator must not stop
        // checking a section the REV format actually uses (silent regression drift).
        // Memo 080 / WI-218: the list is no longer fixed — it comes from the schema of the
        // revision type, so a prepare or update file is measured against its own duties.
        const { schema } = MemoValidator.#schemaOf( { revisionType } )
        const required = schema[ 'sections' ]

        // Some sections allow alternative headings (SKILL.md Z.413): `## Vorwort` may also
        // appear as `## Claude-Vorwort`, `## Geplante Änderungen pro Kapitel` also as the
        // transliterated `## Geplante Aenderungen pro Kapitel`. A section counts as present if
        // ANY of its accepted headings is found. Sections without an alias map to a
        // single-element list.
        const aliases = schema[ 'sectionAliases' ]

        required
            .forEach( ( heading ) => {
                const accepted = Array.isArray( aliases[ heading ] ) ? aliases[ heading ] : [ heading ]
                const present = accepted
                    .some( ( candidate ) => {
                        const pattern = new RegExp( `^##\\s+${ candidate }\\s*$`, 'im' )

                        return pattern.test( doc )
                    } )

                if( !present ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-001',
                        'feldPfad': `section.${ heading.replace( /\s+/g, '' ) }`,
                        'description': `Required section missing for revision type "${ revisionType }" (expected heading "## ${ heading }")`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }
            } )

        struct[ 'checked' ] = required.length

        return struct
    }


    static #validateHeaderFields( { doc, revisionType } ) {
        const struct = { 'messages': [], 'info': [], 'checked': 0 }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )
        const requiredHeaderFields = schema[ 'headerFields' ]
        const headerAliases = schema[ 'headerAliases' ]

        requiredHeaderFields
            .forEach( ( field ) => {
                const accepted = Array.isArray( headerAliases[ field ] ) ? headerAliases[ field ] : [ field ]
                const hits = accepted
                    .map( ( candidate ) => {
                        const pattern = new RegExp( `\\|\\s*\\*\\*${ candidate }\\*\\*\\s*\\|\\s*([^|]*?)\\s*\\|`, 'i' )

                        return doc.match( pattern )
                    } )
                    .filter( ( matched ) => matched !== null )
                const value = hits.length > 0 ? hits[ 0 ][ 1 ].trim() : ''

                if( hits.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-010',
                        'feldPfad': `header.${ field.replace( /\s+/g, '' ) }`,
                        'description': `Header field missing for revision type "${ revisionType }" (expected "| **${ field }** | ... |")`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                } else if( value.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-010',
                        'feldPfad': `header.${ field.replace( /\s+/g, '' ) }`,
                        'description': `Header field empty for revision type "${ revisionType }" (expected a value for "${ field }")`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }
            } )

        struct[ 'checked' ] = requiredHeaderFields.length

        // H3-decision (Memo Kap 13 validation): the Schema-Version marker check is advisory
        // (INFO) for now, NOT blocking — writing skills do not yet set the marker in memo files.
        // Memo 080 / WI-218: off for `prepare` — a planning artefact carries no schema version.
        const hasSchemaVersion = /Schema-Version\s*[:|]/i.test( doc )

        if( !hasSchemaVersion && schema[ 'schemaVersion' ] === true ) {
            MemoValidator.#route( {
                'code': 'INFO-010',
                'feldPfad': 'header.Schema-Version',
                'description': 'Schema-Version marker missing (advisory; expected e.g. "Schema-Version: 2")',
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        }

        return struct
    }


    static #validateJsonBlock( { doc, jsonFound, jsonError, revisionType } ) {
        const struct = { 'messages': [], 'info': [] }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )

        // Memo 080 / WI-218: the question families are off for `prepare` — the binding question
        // surface is the revision itself, where they keep applying unchanged.
        if( schema[ 'questionFamilies' ] !== true ) { return struct }

        // PRD-039: only flag the JSON block when a marker is present but parsing failed.
        const markerPresent = /```questions-json/.test( doc )

        if( markerPresent && !jsonFound ) {
            const detail = typeof jsonError === 'string' && jsonError.length > 0
                ? jsonError
                : 'Questions JSON codeblock is malformed'

            MemoValidator.#route( {
                'code': 'MEMO-050',
                'feldPfad': 'questionsJson',
                'description': detail,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        }

        return struct
    }


    static #validateQuestions( { doc, questionSchema, jsonFound, revisionType } ) {
        const struct = { 'messages': [], 'info': [] }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )

        // Memo 080 / WI-218: off for `prepare` (see #validateJsonBlock for the reasoning).
        if( schema[ 'questionFamilies' ] !== true ) { return struct }

        const questions = ( questionSchema !== null && typeof questionSchema === 'object' && Array.isArray( questionSchema[ 'questions' ] ) )
            ? questionSchema[ 'questions' ]
            : []

        // PRD-038 Re-Check: "Did question parsing work?" — compare ### F{N} headings in the
        // raw markdown with the number of parsed questions. A mismatch means a heading exists
        // that the parser did not capture as a question.
        const { messages: parseMessages, info: parseInfo } = MemoValidator.#validateQuestionParse( { doc, questionSchema, jsonFound } )
        struct[ 'messages' ] = struct[ 'messages' ].concat( parseMessages )
        struct[ 'info' ] = struct[ 'info' ].concat( parseInfo )

        const { blocks: rawBlocks } = MemoValidator.#extractQuestionBlocks( { doc } )

        questions
            .forEach( ( question ) => {
                const safe = ( question !== null && typeof question === 'object' ) ? question : {}
                const id = typeof safe[ 'id' ] === 'string' && safe[ 'id' ].length > 0 ? safe[ 'id' ] : 'F?'

                // Answered questions are HISTORICAL records (## Beantwortete Fragen). They use a
                // different shape (single-line meta: "**AI:** X. **User:** Y.") and carry no
                // Hintergrund/Frage/AI-Empfehlung fields by design — the required-field and
                // typ checks apply only to OPEN questions being delivered to the AI. Skip them.
                if( safe[ 'answered' ] === true ) { return }

                const hintergrund = typeof safe[ 'hintergrund' ] === 'string' ? safe[ 'hintergrund' ].trim() : ''
                const frage = typeof safe[ 'frage' ] === 'string' ? safe[ 'frage' ].trim() : ''
                const aiRecommendation = typeof safe[ 'aiRecommendation' ] === 'string' ? safe[ 'aiRecommendation' ].trim() : ''
                const typ = safe[ 'typ' ] === 'multi' ? 'multi' : 'single'
                const realOptions = ( Array.isArray( safe[ 'options' ] ) ? safe[ 'options' ] : [] )
                    .filter( ( option ) => option !== null && typeof option === 'object' && option[ 'kind' ] === 'option' )

                // Hintergrund — single message per field via else-if cascade (existence only here).
                if( hintergrund.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-020a',
                        'feldPfad': `${ id }.hintergrund`,
                        'description': 'Missing required field: Hintergrund',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // Frage.
                if( frage.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-020b',
                        'feldPfad': `${ id }.frage`,
                        'description': 'Missing required field: Frage',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // AI-Empfehlung is REQUIRED and enforced. Cascade existence → malformed.
                const recommendedKeys = aiRecommendation.toUpperCase().match( /\b([A-H])\b/g ) || []
                const optionKeys = realOptions.map( ( option ) => option[ 'key' ] )
                const referencesExistingOption = recommendedKeys.some( ( key ) => optionKeys.includes( key ) )

                if( aiRecommendation.length === 0 ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-020c',
                        'feldPfad': `${ id }.aiEmpfehlung`,
                        'description': 'Missing required field: AI-Empfehlung',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                } else if( typ === 'single' && realOptions.length > 0 && recommendedKeys.length > 0 && !referencesExistingOption ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-020d',
                        'feldPfad': `${ id }.aiEmpfehlung`,
                        'description': `Malformed: AI-Empfehlung references no existing option (expected one of ${ optionKeys.join( ', ' ) })`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // Options-parseable check — only meaningful for the markdown source. The raw
                // block for this question is matched by id; if it shows option markers but the
                // parser produced 0 real options, the options are not parseable. The Phase-5
                // parser is paren-tolerant ("(A)" / "A)" both parse), so the residual failure
                // mode is a marker form the parser cannot read — e.g. bracket markers "[A]" or
                // bare-letter lists. We require >= 2 DISTINCT letters so a stray single letter
                // never triggers a false positive.
                const rawBlock = typeof rawBlocks[ id ] === 'string' ? rawBlocks[ id ] : ''
                const markerLetters = ( rawBlock.match( /(?:^|\s|\[|\()([A-H])(?:\]|\))?[):.\]]\s+\S/gm ) || [] )
                    .map( ( hit ) => ( hit.match( /[A-H]/ ) || [ '' ] )[ 0 ] )
                const distinctMarkers = new Set( markerLetters )
                const hasMarkers = distinctMarkers.size >= 2

                if( realOptions.length === 0 && hasMarkers && !safe[ 'answered' ] ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-030',
                        'feldPfad': `${ id }.options`,
                        'description': 'Options not parseable (use discrete lines "A) ...", not inline "(A)/(B)")',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // MEMO-031 (Memo 012 Kap 3): bold-wrapped option markers like "**A)**" or
                // "**A:**" never parse as options (the marker regex requires start/space/[/(
                // before the letter, not "*"). The author intent is clearly options, so a
                // bold marker with zero parsed real options is a defect — not a false positive
                // on prose, because this only inspects the question's own raw block.
                const boldMarkers = rawBlock.match( /\*\*[A-H][):]\*\*/g ) || []
                if( boldMarkers.length > 0 && realOptions.length === 0 && !safe[ 'answered' ] ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-031',
                        'feldPfad': `${ id }.options`,
                        'description': `Option marker is bold-wrapped (${ boldMarkers[ 0 ] }) and does not parse — use plain "A) ..." lines`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // MEMO-032 (Memo 012 Kap 3): duplicate options. Two failure modes — a duplicate
                // key among the real options, or an authored option whose label duplicates a
                // parser-injected default ("ablehnen" / "Über das Topic springen" / legacy
                // "Frage ablösen"), which yields 7-instead-of-5 options that still pass today.
                const optionKeyList = realOptions.map( ( option ) => option[ 'key' ] )
                const duplicateKey = optionKeyList
                    .find( ( key, index ) => optionKeyList.indexOf( key ) !== index )
                const injectedLabels = [ 'ablehnen', 'über das topic springen', 'frage ablösen' ]
                const duplicatesInjected = realOptions
                    .some( ( option ) => injectedLabels.includes( String( option[ 'label' ] ).trim().toLowerCase() ) )

                if( ( duplicateKey !== undefined || duplicatesInjected === true ) && !safe[ 'answered' ] ) {
                    const detail = duplicateKey !== undefined
                        ? `duplicate option key "${ duplicateKey }"`
                        : 'an authored option duplicates the injected custom/topic default'
                    MemoValidator.#route( {
                        'code': 'MEMO-032',
                        'feldPfad': `${ id }.options`,
                        'description': `Duplicate option within the question (${ detail })`,
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }

                // Typ consistency — checklist (>= 2 checkbox items) must be typ=multi.
                const checkboxItems = rawBlock.match( /^[ \t]*[-*]\s+\[[ xX]\]/gm ) || []

                if( checkboxItems.length >= 2 && typ !== 'multi' ) {
                    MemoValidator.#route( {
                        'code': 'MEMO-040',
                        'feldPfad': `${ id }.typ`,
                        'description': 'Checklist must be typ=multi (>= 2 checkbox items found)',
                        'messages': struct[ 'messages' ],
                        'info': struct[ 'info' ]
                    } )
                }
            } )

        return struct
    }


    static #validateLintExtensions( { doc, fileName, revisionType } ) {
        const struct = { 'messages': [], 'info': [] }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )

        // MEMO-060 (Memo 012 Kap 3): the revision filename suffix. Only checked when a file
        // name is supplied (the server write-gate validates raw doc strings without one). The
        // accepted forms are REV-NN.md (Full), REV-NN-prepare.md and REV-NN-update.md.
        if( typeof fileName === 'string' && fileName.length > 0 ) {
            const base = fileName.split( '/' ).pop()
            const wellFormed = /^REV-\d{2}(-prepare|-update)?\.md$/.test( base )

            if( wellFormed !== true ) {
                MemoValidator.#route( {
                    'code': 'MEMO-060',
                    'feldPfad': `file.${ base }`,
                    'description': 'Revision filename suffix malformed (expected REV-NN.md, REV-NN-prepare.md or REV-NN-update.md)',
                    'messages': struct[ 'messages' ],
                    'info': struct[ 'info' ]
                } )
            }
        }

        // MEMO-070 (Memo 012 Kap 3): an unresolved "[Research offen]" lifecycle marker must not
        // survive into a delivered revision. Markers inside inline code spans (`[Research offen]`)
        // or fenced code blocks are documentation about the marker, not an active marker — strip
        // those first, then look for a residual occurrence.
        // Memo 080 / WI-218: off for `prepare` — that artefact sits BEFORE delivery and plans the
        // research, so an open marker there is the intended state, not a defect.
        const withoutFences = doc.replace( /```[\s\S]*?```/g, '' )
        const withoutInlineCode = withoutFences.replace( /`[^`]*`/g, '' )
        if( /\[Research offen\]/i.test( withoutInlineCode ) === true && schema[ 'lifecycleMarker' ] === true ) {
            MemoValidator.#route( {
                'code': 'MEMO-070',
                'feldPfad': 'lifecycle.research',
                'description': 'Unresolved "[Research offen]" marker present — resolve the open research before delivering',
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        }

        // MEMO-080 (Memo 012 Kap 7): the Block overlay's machine-readable block-meta field.
        // Additive — a memo with no block-meta fence parses to an empty list and never trips this.
        // A block-meta fence must be valid JSON AND its topic/prd ids must be in T001 / PRD-001 shape.
        const { blocks, errors } = BlockMeta.parse( { doc } )

        errors.forEach( ( entry ) => {
            MemoValidator.#route( {
                'code': 'MEMO-080',
                'feldPfad': `block-meta.${ entry.chapter === null ? '(top)' : entry.chapter.replace( /\s+/g, '' ) }`,
                'description': entry.reason,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        } )

        blocks.forEach( ( block ) => {
            const { messages } = BlockMeta.validateShape( { block } )
            messages.forEach( ( message ) => {
                MemoValidator.#route( {
                    'code': 'MEMO-080',
                    'feldPfad': `block-meta.${ block.chapter === null ? '(top)' : block.chapter.replace( /\s+/g, '' ) }`,
                    'description': message,
                    'messages': struct[ 'messages' ],
                    'info': struct[ 'info' ]
                } )
            } )
        } )

        return struct
    }


    static #validateQuestionParse( { doc, questionSchema, jsonFound } ) {
        const struct = { 'messages': [], 'info': [] }
        const questions = ( questionSchema !== null && typeof questionSchema === 'object' && Array.isArray( questionSchema[ 'questions' ] ) )
            ? questionSchema[ 'questions' ]
            : []

        const headingMatches = doc.match( /^###\s+F\d+\b/gm ) || []
        const headingCount = headingMatches.length

        // Memo 041 Teil B (Kap 9, 12): json is the source. When a questions-json block is present it is
        // FULLY authoritative — the `### F{N}` markdown is no longer a required render mirror. Open
        // questions live json-only (the split-brain fix), while answered questions keep their
        // `## Beantwortete Fragen` decision records (the AI-Empfehlung-war / User-Entscheidung pairs that
        // memo-mental-model-derive reads). Because those two artefacts legitimately differ in count, the
        // heading-vs-question cross-check does NOT apply to a json-source revision — and old hybrid memos
        // (every question mirrored) keep passing on re-registration. Only the MARKDOWN-ONLY path keeps the
        // original rule: a `### F{N}` heading that did not parse into a question is still a defect.
        if( jsonFound !== true && headingCount !== questions.length ) {
            MemoValidator.#route( {
                'code': 'MEMO-025',
                'feldPfad': 'questions',
                'description': `Question parsing incomplete (found ${ headingCount } "### F{N}" headings but parsed ${ questions.length } questions)`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ]
            } )
        }

        return struct
    }


    static #validateOptionKinds( { doc, jsonFound, revisionType } ) {
        // MEMO-033 (Memo 041 Teil B, Kap 10): the kind-validity check the renderer needs but the
        // validator was missing. Inspect the RAW questions-json options (before #normalizeJsonQuestion
        // coerces unknown kinds to 'option') so a bad authored kind — e.g. kind:"normal" — fails LOUD
        // at the door instead of silently dropping the option into the browser fallback. Only meaningful
        // when a questions-json block exists; the markdown mirror never carries an explicit kind.
        const struct = { 'messages': [], 'info': [] }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )

        // Memo 080 / WI-218: off for `prepare` (see #validateJsonBlock for the reasoning).
        if( schema[ 'questionFamilies' ] !== true ) { return struct }

        if( jsonFound !== true ) { return struct }

        const blockPattern = /```questions-json\s*\n([\s\S]*?)\n```/
        const matched = doc.match( blockPattern )
        if( matched === null ) { return struct }

        let parsed
        try {
            parsed = JSON.parse( matched[ 1 ] )
        } catch {
            // A malformed block is already reported as MEMO-050 by #validateJsonBlock — do not double-report.
            return struct
        }

        const list = Array.isArray( parsed )
            ? parsed
            : ( parsed !== null && typeof parsed === 'object' && Array.isArray( parsed[ 'questions' ] ) ? parsed[ 'questions' ] : [] )

        list
            .forEach( ( entry ) => {
                const safe = ( entry !== null && typeof entry === 'object' ) ? entry : {}
                const id = typeof safe[ 'id' ] === 'string' && safe[ 'id' ].length > 0 ? safe[ 'id' ] : 'F?'
                const invalid = invalidOptionKinds( { options: safe[ 'options' ] } )

                invalid
                    .forEach( ( option ) => {
                        const keyLabel = option[ 'key' ].length > 0 ? option[ 'key' ] : '?'
                        MemoValidator.#route( {
                            'code': 'MEMO-033',
                            'feldPfad': `${ id }.options.${ keyLabel }.kind`,
                            'description': `Option kind "${ option[ 'kind' ] }" is not one of {option, custom, topic, reframe, reoption} — the renderer drops it`,
                            'messages': struct[ 'messages' ],
                            'info': struct[ 'info' ]
                        } )
                    } )
            } )

        return struct
    }


    // MEMO-034..039 / WARN-030..033 / INFO-020 (Memo 080, PRD-F4, Kap 18): the OPTION-QUALITY family.
    // Hung in right next to #validateOptionKinds because both read the SAME raw source for the same
    // reason — the normaliser knows neither the authored `kind` nor the quality fields, so a check run
    // against the normalised list would measure fields that were already thrown away.
    //
    // The rules themselves live in OptionQualityLint; this method is the bridge only: it parses, calls,
    // and routes each finding into the channel its severity belongs to. No rule is copied here.
    static #validateOptionQuality( { doc, jsonFound, revisionType, anchorTerms } ) {
        const struct = { 'messages': [], 'info': [], 'warnings': [], 'basis': { 'ran': false, 'checked': 0, 'skippedAnswered': 0, 'skippedLegacy': 0, 'registerAvailable': false } }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )

        // Off for `prepare` for the same reason as every other question family: a planning artefact's
        // question list is an informal note, not the binding question surface.
        if( schema[ 'questionFamilies' ] !== true ) { return struct }

        if( jsonFound !== true ) { return struct }

        const blockPattern = /```questions-json\s*\n([\s\S]*?)\n```/
        const matched = doc.match( blockPattern )
        if( matched === null ) { return struct }

        let parsed
        try {
            parsed = JSON.parse( matched[ 1 ] )
        } catch {
            // A malformed block is already MEMO-050's subject — do not double-report.
            return struct
        }

        const list = Array.isArray( parsed )
            ? parsed
            : ( parsed !== null && typeof parsed === 'object' && Array.isArray( parsed[ 'questions' ] ) ? parsed[ 'questions' ] : [] )

        const result = OptionQualityLint.check( { questions: list, anchorTerms } )
        if( result[ 'status' ] !== true ) { return struct }

        struct[ 'basis' ] = {
            'ran': true,
            'checked': result[ 'checked' ],
            'skippedAnswered': result[ 'skippedAnswered' ],
            'skippedLegacy': result[ 'skippedLegacy' ],
            'registerAvailable': result[ 'registerAvailable' ]
        }

        result[ 'findings' ]
            .forEach( ( finding ) => {
                MemoValidator.#route( {
                    'code': finding[ 'code' ],
                    'feldPfad': `${ finding[ 'questionId' ] }.${ finding[ 'field' ] }`,
                    'description': finding[ 'description' ],
                    'messages': struct[ 'messages' ],
                    'info': struct[ 'info' ],
                    'warnings': struct[ 'warnings' ]
                } )
            } )

        return struct
    }


    static #extractQuestionBlocks( { doc } ) {
        const struct = { 'blocks': {} }
        const lines = doc.split( '\n' )
        const headingPattern = /^###\s+(F\d+)\b/
        const sectionPattern = /^##\s+/

        // A question block ends at the next "### F{N}" heading OR the next "## " section
        // heading (whichever comes first), so a question never bleeds across a section
        // boundary into the following section's content (e.g. the "## Phasen" checkboxes).
        const starts = []
        const boundaries = []
        lines
            .forEach( ( line, index ) => {
                const matched = line.match( headingPattern )

                if( matched !== null ) {
                    starts.push( { 'id': matched[ 1 ], index } )
                    boundaries.push( index )
                } else if( sectionPattern.test( line ) === true ) {
                    boundaries.push( index )
                }
            } )

        starts
            .forEach( ( entry ) => {
                const laterBoundaries = boundaries
                    .filter( ( boundaryIndex ) => boundaryIndex > entry[ 'index' ] )
                const endIndex = laterBoundaries.length > 0
                    ? Math.min( ...laterBoundaries )
                    : lines.length
                const block = lines
                    .slice( entry[ 'index' ], endIndex )
                    .join( '\n' )

                struct[ 'blocks' ][ entry[ 'id' ] ] = block
            } )

        return struct
    }
}


export { MemoValidator }
