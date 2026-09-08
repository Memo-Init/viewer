import { DocumentRegistry } from './DocumentRegistry.mjs'
import { BlockMeta } from './BlockMeta.mjs'
import { invalidOptionKinds } from './QuestionContract.mjs'
import { OptionQualityLint } from './OptionQualityLint.mjs'
import { BlockSections } from './BlockSections.mjs'
import { IdRegister } from './IdRegister.mjs'


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
    // Memo 081, WI-116 / T061 (REV-16:3431): "the contract is COUNTED, not judged: the check is a set
    // difference (chapters x mandatory blocks against the headings found) and belongs in the invariant
    // script, not in an agent's verdict. A check that finds nothing to compare reports RED, not green."
    //
    // WARNING, NOT ERROR, AND THE NUMBER SAYS WHY. Measured 2026-09-08 over 533 revision files: 6 carry
    // `### Abhaengigkeiten` at all, 16 carry `### PRD-Zuordnung`, and the contract's eight headings
    // appear in full in a single-digit number of documents. An ERROR would refuse practically every
    // revision in the workbench on day one. The sharpening rule is the one written at the head of this
    // catalogue: measure the corpus AGAIN grouped by revision type, sharpen only when the `full` group
    // shows zero hits, otherwise record the measured stand as a snag. A severity raised against a number
    // nobody re-measured is a claim, not a gate.
    //
    // The code number is MEASURED, not assumed: WARN-010/011/020/021/030-034 were occupied on
    // 2026-09-08, so this takes the next free block.
    { 'code': 'WARN-040', 'severity': 'WARNING', 'theme': 'kapitel-vertrag', 'description': 'A numbered chapter does not carry every mandatory building block of the chapter contract (BlockSections.chapterContract, REV-16:3393-3402) — reported as a set difference with its comparison basis, never as a judgement' },
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
    { 'code': 'INFO-020', 'severity': 'INFO', 'theme': 'optionen-guete', 'description': 'The option-quality lint examined 0 open questions although a questions-json block was present — the run reports that it compared nothing instead of reporting a green zero (A11)' },
    // Memo 081, WI-075 / T055+T060 (REV-16:3033-3046, 3061-3063) — IDENTIFIERS IN RUNNING TEXT.
    //
    // THE ANCHOR IS THIS VALIDATOR, REACHED THROUGH `memo lint`, AND DELIBERATELY NOT THE TRANSCRIPT
    // GATE. The transcript gate judges the USER's input; punishing him for dictating "schau dir T55
    // an" would be enforcement in the wrong place (REV-16:3033). Which is why these codes carry a NEW
    // theme, `kennung`: the reject-gate selects its family BY THEME (QUESTION_FORMAT_THEMES below),
    // and filing an identifier finding under an existing theme would have made every one of them a
    // reason to reject a transcript — the same accident `03\d` once caused for the option-quality
    // codes, a second time, through the one door this work was told not to touch.
    //
    // THREE STAGES, GRADED HARDNESS, AND ONLY S1 IS SHARP. S1 states the READING and never blocks.
    // S2 (well-formed, resolves nowhere) and S3 (well-formed, resolves ambiguously) enter as
    // WARNINGS. The memo argues warn-first from 21.7 % dead references in REV-08; measured 2026-09-08
    // against REV-16 the figure is 3.2 % (9 of 284 checkable identifiers). BOTH numbers are recorded
    // and NEITHER is why the stage stays soft. The reason is that SIX of those nine are cross-memo
    // references written without the qualification F20=A requires — which makes S2 a finding about a
    // CONVENTION BEING ADOPTED, not about a document being broken. A gate that hard-enforces a
    // convention at the moment of its introduction blocks the introduction, and the author of the
    // rule would be its first convict, in the very document that writes it down.
    //
    // THE SHARPENING RULE IS THE ONE AT THE HEAD OF THIS CATALOGUE: measure the corpus AGAIN, grouped
    // by revision type, each group stating how many files it compared; sharpen only when the `full`
    // group shows zero hits. A severity raised against a number nobody re-measured is a claim, not a
    // gate.
    //
    // The code numbers are MEASURED, not assumed: INFO-010/020 and WARN-010/011/020/021/030-034/040
    // were occupied on 2026-09-08 and the whole 1xx block was free, so the block the memo names is
    // the block that is taken.
    { 'code': 'INFO-100', 'severity': 'INFO', 'theme': 'kennung', 'description': 'Identifiers were recognised in the running text and are reported with their READING — "T055 -> topic \'…\'" — because the interpretation is what the author asked for; naming the identifier back at him is not (S1, never blocking)' },
    { 'code': 'INFO-101', 'severity': 'INFO', 'theme': 'kennung', 'description': 'Identifiers were recognised but NO stock was handed in, so the existence rules did not run — the finding states that it compared nothing instead of reporting a green zero (the counterpart of INFO-020 for the identifier family)' },
    { 'code': 'WARN-100', 'severity': 'WARNING', 'theme': 'kennung', 'description': 'A well-formed identifier resolves against NO entry of the handed-in stock (S2). Warn-first while the qualification convention of F20=A is being adopted; a prefix the stock does not cover at all is reported as noCarrier instead and is NOT this code' },
    { 'code': 'WARN-101', 'severity': 'WARNING', 'theme': 'kennung', 'description': 'A well-formed identifier resolves to MORE THAN ONE entry of the handed-in stock (S3) — the more dangerous class, because an ambiguous reference reads as a working one' },
    // Memo 081, WI-115 / T077 (REV-16:4152): "the form is lintable BECAUSE it is deterministic … the
    // anchor is the SAME one as for the identifier check of chapter 31 (MemoValidator via `memo lint`)
    // — no second lint script." This family is therefore not a new gate; it is a new family inside the
    // one gate, and the form it checks is the one the REGISTER carries (BlockSections.userMandateForm).
    //
    // WHAT IS CHECKED IS THE ARRANGEMENT, NEVER THE CONTENT. Whether a quote is well chosen is not a
    // machine judgement and does not become one; whether the READING fits the quote is explicitly
    // forbidden ground (REV-16:3418 — the reading is a reading aid, the quote wins). "Der Inhalt
    // bleibt frei, die Anordnung nicht" (REV-16:4154).
    //
    // WARNING, AND THE NUMBERS SAY WHY. Measured 2026-09-08 over TWO revisions rather than one, because
    // a form check that has only seen its own memo knows no spread:
    //   REV-16 (memo 081)  41 chapters, 41 with the section, 37 with a quote, 30 with a source →  9 findings
    //   REV-18 (memo 080)  25 chapters, 25 with the section, 25 with a quote,  0 with a source → 25 findings
    // An ERROR would refuse the finalised revision of the very memo that introduces the rule, and it
    // would refuse memo 080 — the memo this PRD cites as the MODEL for the default sentence — in all
    // 25 of its chapters. The sharpening rule is the one at the head of this catalogue and it is not
    // waived here: measure again, grouped by revision type, sharpen only when the `full` group is zero.
    //
    // A NEW THEME, DELIBERATELY. QUESTION_FORMAT_THEMES selects the codes that REJECT a transcript, by
    // theme rather than by number range (the trap MEMO-034..039 sprang once, and `kennung` avoided a
    // second time). A form remark about a chapter heading must never be able to reject a user's
    // transcript. The theme is written in English because that is the rule for machine tokens without
    // exception (core scripts/check-enum-language.mjs); the German themes above are frozen legacy
    // vocabulary, documented rather than endorsed, and are not a precedent to copy.
    //
    // The code numbers are MEASURED, not assumed: INFO-010/020, WARN-010/011/020/021/030-034/040 and
    // the whole 1xx block (taken by `kennung` on 2026-09-08) were occupied, so this takes the 2xx block.
    { 'code': 'WARN-200', 'severity': 'WARNING', 'theme': 'mandate-form', 'description': 'A numbered chapter delivers no verifiable mandate — it carries no `### User-Auftrag` section at all, or the section carries neither a block quote nor one of the closed default sentences (BlockSections.userMandateForm). The two cases carry different wording, because "there is no section" and "the section says nothing checkable" are different defects' },
    { 'code': 'WARN-201', 'severity': 'WARNING', 'theme': 'mandate-form', 'description': 'A block quote in `### User-Auftrag` carries no source reference in the prescribed shape — parentheses with file and line, directly below the quote (REV-16:4148). Reported with the chapter and the line of the quote, never as a collective count' },
    { 'code': 'WARN-202', 'severity': 'WARNING', 'theme': 'mandate-form', 'description': 'The optional `**Gelesen als:**` line stands BEFORE a quote or before its source reference. Only the POSITION is checked and the line stays optional — requiring it would make the AI reading a criterion, which REV-16:3418 forbids' },
    { 'code': 'WARN-203', 'severity': 'WARNING', 'theme': 'mandate-form', 'description': 'A default sentence and a block quote stand in the same `### User-Auftrag` — the default sentence REPLACES quote and source reference, so carrying both says the chapter has and has not a mandate at once' }
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
        // Memo 081, WI-120 (REV-16:5322-5327): after F24=A the document section is called
        // `## Abhaengigkeiten` and its neighbour `## Abhaengigkeits-Hinweise`. The memo states the
        // reason it could not simply be renamed IN the revision: "the schema change would break every
        // existing memo". Measured 2026-09-08 over 533 revision files, `## Phasen` stands in 356 of them
        // and `## Abhaengigkeiten` in 0 — a straight swap would hand MEMO-001 (an ERROR, status:false,
        // the hard post-write gate) to 356 files at once.
        // So the old headings stay ACCEPTED, through the alias mechanism that already carries
        // `## Claude-Vorwort`. The alias has NO expiry: the stock is not migrated (F19), so the old
        // spelling is not a transitional state, it is the majority. Positions 5 and 6 stay positions 5
        // and 6 — #validateDocumentOrder reads the sequence, and moving them would be a second,
        // unasked-for change.
        // Both umlaut spellings are accepted HERE, where the alias list is explicit and per-heading. The
        // block-level register deliberately does not fold umlauts (BlockSections, WI-116): there the
        // comparison is shared by three readers and the measured need is zero.
        'sections': [ 'Kontext', 'Vorwort', 'Offene Fragen', 'Beantwortete Fragen', 'Abhaengigkeiten', 'Abhaengigkeits-Hinweise', 'Finalisierungs-Checkliste', 'Ancillary Files', 'Rollout-Entry-Points', 'Lessons-Learned' ],
        'sectionAliases': {
            'Vorwort': [ 'Vorwort', 'Claude-Vorwort' ],
            'Abhaengigkeiten': [ 'Abhaengigkeiten', 'Abhängigkeiten', 'Phasen' ],
            'Abhaengigkeits-Hinweise': [ 'Abhaengigkeits-Hinweise', 'Abhängigkeits-Hinweise', 'Phase-Hints' ]
        },
        'headerFields': [ 'Memo', 'Memo-Name', 'Revision', 'Datum', 'Status' ],
        'headerAliases': {},
        'schemaVersion': true,
        'questionFamilies': true,
        'lifecycleMarker': true,
        'documentOrder': true,
        'documentHeader': true,
        // Memo 081, WI-116: the CHAPTER contract is counted for `full` only. A prepare or an update
        // artefact carries no numbered body chapters, so measuring it against a per-chapter duty would
        // hold it to a form it does not have — the lesson of PRD-V13 below.
        'chapterContract': true,
        // Memo 081, WI-075: the identifier family (INFO-100/101, WARN-100/101). It is entered HERE and
        // not as a bare `revisionType !== 'prepare'` inside the check, because the comment at the head
        // of this table states the invariant plainly: there is exactly ONE place where a per-type duty
        // lives. A second, private spelling of the same duty is the drift this table exists against.
        'idReferences': true,
        // Memo 081, WI-115: the USER-MANDATE FORM family (WARN-200..203), `full` only — a prepare or an
        // update artefact carries no numbered body chapters, so measuring it against a per-chapter
        // arrangement would hold it to a form it does not have. Entered HERE for the reason the head of
        // this table states: there is exactly ONE place where a per-type duty lives.
        'userMandate': true
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
        'documentHeader': false,
        'chapterContract': false,
        // An update revision is delivered prose like a full one and its references are meant to
        // resolve, so the identifier family is ON here and only `prepare` switches it off.
        'idReferences': true,
        // OFF: an update revision replaces or extends chapters, but the numbered body chapters and
        // their mandate sections live in the `full` revision it updates. Written out rather than
        // omitted — an absent flag and a false one must not be the same statement.
        'userMandate': false
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
        'documentHeader': false,
        'chapterContract': false,
        // OFF for `prepare`, and for the same reason the lifecycle marker is off: the artefact sits
        // BEFORE the revision it plans and legitimately points at work that does not exist yet. A
        // loose reference there is the intended state, not a defect.
        'idReferences': false,
        // OFF: a prepare artefact carries no numbered body chapters at all, so a per-chapter
        // arrangement rule would measure it against a form it never had.
        'userMandate': false
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
    // `knownIds` (Memo 081, WI-075) is the SECOND optional payload key of exactly the same kind, and it
    // is deliberately built the same way: the validator stays pure, the caller does the IO
    // (repos/core/cli/lib/lint.mjs reads the memo's store, MemoView derives it from the store it
    // already reads). Its absence is NOT a silent default and NOT an empty stock — it is reported as
    // `idResolution.available: false` with a named reason, and the existence rules S2/S3 then count as
    // NOT CHECKED rather than as clean. An empty stock, against which every identifier "fails to
    // resolve", would be the vacuum-green gate with its sign flipped: it colours everything red and
    // claims to have measured.
    static validate( { doc, fileName, anchorTerms, knownIds } ) {
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
        // Memo 081, WI-075: `idResolution` is the comparison basis of the IDENTIFIER family and it rides
        // in EVERY result, including the refusal below — for the same reason `optionQuality` does. A
        // basis that is missing from a refusal leaves the reader guessing whether nothing was checked
        // or nothing was found, and those are different statements.
        //   ran            did the family run at all (off for `prepare`)
        //   available      was a stock handed in — without it S2/S3 count as NOT CHECKED
        //   checked        how many DISTINCT references were held against the stock
        //   resolved / unresolved / ambiguous / noCarrier   the four verdicts, and they sum to `checked`
        //   distinct / occurrences   TWO statements, not one (measured on REV-16: 304 against 2252)
        //   comparedCharacters / comparedStockEntries / comparedStockPrefixes   how much was compared
        // Memo 081, WI-115: `userMandate` is the comparison basis of the MANDATE-FORM family and rides
        // in EVERY result for the same reason as the two above. It states BOTH numbers the finding needs
        // to be readable — how many chapters carry the section at all, and how many of those carry
        // something checkable — because "the section is present" and "the section is in form" are the
        // two statements this whole family exists to tell apart.
        //   ran          did the family run at all (off for `prepare` and `update`)
        //   chapters     how many numbered chapters were examined — 0 is RED, never a green zero
        //   withSection  how many carry a `### User-Auftrag` at all
        //   withQuote / withSource / withDefault   how many carry each element
        //   misordered   how many put the optional reading before a quote or its source reference
        const struct = { 'status': false, 'messages': [], 'info': [], 'warnings': [], 'checked': { 'sections': 0, 'headerFields': 0, 'comparedSections': 0, 'comparedHeaderFields': 0 }, 'optionQuality': { 'ran': false, 'checked': 0, 'skippedAnswered': 0, 'skippedLegacy': 0, 'registerAvailable': false }, 'idResolution': MemoValidator.#emptyIdResolution(), 'userMandate': MemoValidator.#emptyUserMandate(), revisionType }

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
        const chapterContract = MemoValidator.#validateChapterContract( { doc, revisionType } )
        const idReferences = MemoValidator.#validateIdReferences( { doc, revisionType, knownIds } )
        const userMandate = MemoValidator.#validateUserMandate( { doc, revisionType } )

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
            .concat( idReferences[ 'info' ] )

        struct[ 'messages' ] = messages
        struct[ 'info' ] = info
        struct[ 'warnings' ] = documentOrder[ 'warnings' ]
            .concat( documentHeader[ 'warnings' ] )
            .concat( chapterContract[ 'warnings' ] )
            .concat( optionQuality[ 'warnings' ] )
            .concat( idReferences[ 'warnings' ] )
            .concat( userMandate[ 'warnings' ] )
        struct[ 'optionQuality' ] = optionQuality[ 'basis' ]
        struct[ 'idResolution' ] = idReferences[ 'basis' ]
        struct[ 'userMandate' ] = userMandate[ 'basis' ]
        struct[ 'status' ] = messages.length === 0
        // Memo 080, PRD-R1: a verdict without its comparison basis is not readable. `checked` states HOW
        // MUCH was compared — how many mandatory sections and how many mandatory header fields the run
        // examined — so a `status: true` can be told apart from a run that simply had nothing to check.
        // `comparedSections` / `comparedHeaderFields` are the SAME statement for the two document-level
        // checks (Vollausbau): how many declared positions and how many declared head fields they held
        // the document against. Both are 0 when the check did not RUN for this revision type — which is a
        // different statement from "ran and found nothing to compare", and that second case emits its own
        // warning instead of reporting a green zero.
        // Memo 081, WI-116: the chapter contract states its comparison basis IN ITS MESSAGE
        // (`chapters=<n> blocks=<b> expected=<n*b> found=<k> missing=<d>`) and deliberately does NOT add
        // a fifth key here. `checked` is pinned by eight `toEqual` assertions across three suites that
        // this PRD is not authorised to open; widening it would have been a change in two files outside
        // its declared budget. The basis is stated, only in a different channel — and that difference is
        // reported as a restschuld rather than smuggled in.
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

            // Memo 081, WI-116: the third-level headings of this chapter, code fences already excluded by
            // the flags above. They are the comparison basis of the chapter-contract count (WARN-040) and
            // are collected HERE because the chapter split and the fence exclusion already happen here —
            // a second walk over the same lines would be a second answer to the same question.
            const headings = body
                .filter( ( line, offset ) => flags[ start[ 'index' ] + offset ] !== true && /^###\s+/.test( line ) === true )
                .map( ( line ) => line.replace( /^###\s+/, '' ).trim() )

            // Memo 081, WI-115: the chapter's own lines, each with its ABSOLUTE line number and whether
            // it sits inside a code fence. Collected HERE for the same reason `headings` is: the split
            // and the fence mask already exist at this point, and a second walk over the same lines
            // would be a second answer to the same question. The absolute number is what lets a finding
            // name the line instead of a collective count.
            const numbered = body
                .map( ( line, offset ) => ( { line, 'number': start[ 'index' ] + offset + 1, 'fenced': flags[ start[ 'index' ] + offset ] === true } ) )

            return {
                key,
                headings,
                numbered,
                'title': start[ 'title' ],
                // `hasAuftrag` answers "does the TERM occur anywhere in the chapter" and is read by the
                // cross-revision continuity check (WARN-011). It is deliberately NOT the basis of the
                // mandate-form family, which asks a different question — "is there a SECTION, and is it
                // arranged correctly" — and cuts the section itself through the register.
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


    // WARN-040 — the CHAPTER CONTRACT, COUNTED (Memo 081, WI-116 / T061, REV-16:3431): "the contract is
    // counted, not judged: the check is a set difference (chapters x mandatory blocks against the
    // headings found) and belongs in the invariant script, not in an agent's verdict."
    //
    // IT STATES ITS COMPARISON BASIS IN EVERY MESSAGE — `chapters=<n> blocks=<b> expected=<n*b>
    // found=<k> missing=<d>` — and 0 chapters is RED with its own finding, never a silent pass. That is
    // the whole point of the rule it implements: a check that found nothing to compare has checked
    // nothing, and the honest answer says so instead of reporting a green zero.
    //
    // THE RECOGNISER IS BlockSections.matchContract, NOT A SECOND ONE HERE. It carries the same prefix
    // semantics the register uses everywhere else, so `### Soll-Zustand: der Werkzeugkoffer` counts as
    // `Soll-Zustand` while `### Soll-Zustandsbericht` does not. A `repeatable` block may stand more than
    // once; presence, not multiplicity, is what the set difference asks about.
    static #validateChapterContract( { doc, revisionType } ) {
        const struct = { 'messages': [], 'info': [], 'warnings': [], 'checked': 0 }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )
        if( schema[ 'chapterContract' ] !== true ) { return struct }

        const { contract } = BlockSections.chapterContract()
        const mandatory = contract
            .filter( ( entry ) => entry[ 'required' ] === true )
        const chapters = MemoValidator.#numberedChapters( { doc } )

        if( chapters.length === 0 ) {
            MemoValidator.#route( {
                'code': 'WARN-040',
                'feldPfad': 'chapter.contract',
                'description': `chapters=0 blocks=${ mandatory.length } expected=0 found=0 missing=0 — no numbered chapter was found, so the chapter contract had nothing to compare; a check without a comparison basis reports red, not green`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ],
                'warnings': struct[ 'warnings' ]
            } )

            return struct
        }

        const rows = chapters
            .map( ( chapter ) => {
                const present = chapter[ 'headings' ]
                    .map( ( text ) => BlockSections.matchContract( { text } ).heading )
                const missing = mandatory
                    .filter( ( entry ) => present.includes( entry[ 'heading' ] ) !== true )
                    .map( ( entry ) => entry[ 'heading' ] )

                return { 'title': chapter[ 'title' ], missing }
            } )

        const expected = chapters.length * mandatory.length
        const missingCount = rows
            .reduce( ( acc, row ) => acc + row[ 'missing' ].length, 0 )
        struct[ 'checked' ] = expected

        if( missingCount > 0 ) {
            const offenders = rows
                .filter( ( row ) => row[ 'missing' ].length > 0 )
            MemoValidator.#route( {
                'code': 'WARN-040',
                'feldPfad': 'chapter.contract',
                'description': `chapters=${ chapters.length } blocks=${ mandatory.length } expected=${ expected } found=${ expected - missingCount } missing=${ missingCount } — ${ offenders.map( ( row ) => `"${ row[ 'title' ] }" lacks ${ row[ 'missing' ].join( ', ' ) }` ).join( '; ' ) }`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ],
                'warnings': struct[ 'warnings' ]
            } )
        }

        return struct
    }


    // The empty basis of the mandate-form family (Memo 081, WI-115). It rides in EVERY result, the
    // refusal of an empty document included, for the reason `optionQuality` and `idResolution` do: a
    // basis missing from a refusal leaves the reader guessing whether nothing was checked or nothing
    // was found, and those are different statements.
    static #emptyUserMandate() {
        return { 'ran': false, 'chapters': 0, 'withSection': 0, 'withQuote': 0, 'withSource': 0, 'withDefault': 0, 'misordered': 0 }
    }


    // Cut the `### User-Auftrag` section out of ONE chapter and read its three elements.
    //
    // The section is recognised through BlockSections.match — the SAME recogniser the display side and
    // the contract counter use, never a second one here. That is what makes `### User-Auftrag: {Aspekt}`
    // count as the section while `### User-Auftragslage` does not: the register decides, not a regex in
    // this file.
    //
    // Consecutive quote lines are JOINED before the quote pattern is applied, because a block quote may
    // span several `>` lines (measured: REV-16:3323-3327). Testing line by line would have counted a
    // four-line quotation as no quotation at all.
    static #mandateSectionOf( { chapter } ) {
        const visible = chapter[ 'numbered' ]
            .filter( ( entry ) => entry[ 'fenced' ] !== true )
        const headAt = visible
            .findIndex( ( entry ) => /^###\s+/.test( entry[ 'line' ] ) === true && BlockSections.match( { 'text': entry[ 'line' ].replace( /^###\s+/, '' ).trim() } ).field === 'userMandate' )
        if( headAt === -1 ) {
            return { 'found': false, 'body': [] }
        }

        const rest = visible
            .slice( headAt + 1 )
        const stopAt = rest
            .findIndex( ( entry ) => /^#{2,3}\s+/.test( entry[ 'line' ] ) === true )
        const body = stopAt === -1 ? rest : rest.slice( 0, stopAt )

        return { 'found': true, body, 'headLine': visible[ headAt ][ 'number' ] }
    }


    // WARN-200..203 — the ARRANGEMENT of `### User-Auftrag` (Memo 081, WI-115 / T077).
    //
    // WHAT THIS CHECKS AND WHAT IT DELIBERATELY DOES NOT. It checks that a quote is there, that a
    // source reference sits with it, and that the optional reading comes LAST. It does NOT check
    // whether the quote is well chosen, whether the reading fits the quote (REV-16:3418 forbids it),
    // and — the one worth stating loudly —
    //
    //   IT DOES NOT CHECK THAT THE SOURCE REFERENCE POINTS ANYWHERE REAL.
    //
    // Only its SHAPE is checked: parentheses carrying `file.ext:line`. Whether that file exists, and
    // whether the quoted words stand at that line, is NOT established here and must not be read into a
    // green result. The validator opens no file — that is its construction rule, which is why it runs
    // identically in eight call sites and two repos, and the honest consequence is that a reference of
    // the right shape pointing into the void passes. That is the same class this project has already
    // paid for twice ("an identifier that resolves is not yet a correct identifier"), one level lower:
    // here it does not even resolve, it merely looks as if it could. The way to the real resolution is
    // open and named — lint.mjs already does the file IO and hands `anchorTerms` and `knownIds` in, so
    // the same channel can later carry transcript lines — and it belongs to WI-117 / T079, not here.
    // A test holds this boundary (a source reference on a non-existent file produces NO finding, on
    // purpose), because a boundary that lives only in a comment disappears at the next rewrite.
    static #validateUserMandate( { doc, revisionType } ) {
        const struct = { 'messages': [], 'info': [], 'warnings': [], 'basis': MemoValidator.#emptyUserMandate() }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )
        if( schema[ 'userMandate' ] !== true ) { return struct }

        const { elements, defaults } = BlockSections.userMandateForm()
        const quoteRule = elements.find( ( entry ) => entry[ 'element' ] === 'quote' )
        const sourceRule = elements.find( ( entry ) => entry[ 'element' ] === 'source' )
        const readingRule = elements.find( ( entry ) => entry[ 'element' ] === 'reading' )
        const chapters = MemoValidator.#numberedChapters( { doc } )

        if( chapters.length === 0 ) {
            // A form check that found no chapter has checked NOTHING. It reports red rather than a green
            // zero — the same sentence the chapter-contract check makes, and for the same reason.
            MemoValidator.#route( {
                'code': 'WARN-200',
                'feldPfad': 'chapter.userMandate',
                'description': `chapters=0 elements=${ elements.length } defaults=${ defaults.length } — no numbered chapter was found, so the user-mandate form had nothing to compare; a check without a comparison basis reports red, not green`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ],
                'warnings': struct[ 'warnings' ]
            } )

            return struct
        }

        const rows = chapters
            .map( ( chapter ) => {
                const { found, body, headLine } = MemoValidator.#mandateSectionOf( { chapter } )
                if( found !== true ) {
                    return { 'title': chapter[ 'title' ], 'section': false, 'quotes': [], 'sources': [], 'defaults': [], 'reading': null }
                }

                const quotes = MemoValidator.#quoteBlocks( { body } )
                    .filter( ( block ) => quoteRule[ 'pattern' ].test( block[ 'text' ] ) === true )
                const sources = body
                    .filter( ( entry ) => sourceRule[ 'pattern' ].test( entry[ 'line' ] ) === true )
                const defaultsFound = body
                    .filter( ( entry ) => defaults.some( ( variant ) => variant[ 'pattern' ].test( entry[ 'line' ] ) === true ) )
                const reading = body
                    .find( ( entry ) => readingRule[ 'pattern' ].test( entry[ 'line' ] ) === true )

                return { 'title': chapter[ 'title' ], 'section': true, headLine, quotes, sources, 'defaults': defaultsFound, 'reading': reading === undefined ? null : reading }
            } )

        MemoValidator.#routeMandateFindings( { rows, struct } )
        struct[ 'basis' ] = {
            'ran': true,
            'chapters': rows.length,
            'withSection': rows.filter( ( row ) => row[ 'section' ] === true ).length,
            'withQuote': rows.filter( ( row ) => row[ 'quotes' ].length > 0 ).length,
            'withSource': rows.filter( ( row ) => row[ 'sources' ].length > 0 ).length,
            'withDefault': rows.filter( ( row ) => row[ 'defaults' ].length > 0 ).length,
            'misordered': rows.filter( ( row ) => MemoValidator.#mandateMisordered( { row } ) === true ).length
        }

        return struct
    }


    // Consecutive `>` lines as ONE block, carrying the line number of the block's FIRST line so a
    // finding can name where the quote starts.
    static #quoteBlocks( { body } ) {
        return body
            .reduce( ( acc, entry ) => {
                if( /^\s*>/.test( entry[ 'line' ] ) !== true ) { return { 'open': false, 'blocks': acc[ 'blocks' ] } }
                const text = entry[ 'line' ].replace( /^\s*>\s?/, '' )
                if( acc[ 'open' ] !== true ) {
                    return { 'open': true, 'blocks': acc[ 'blocks' ].concat( [ { text, 'number': entry[ 'number' ], 'endNumber': entry[ 'number' ] } ] ) }
                }

                const head = acc[ 'blocks' ].slice( 0, -1 )
                const last = acc[ 'blocks' ][ acc[ 'blocks' ].length - 1 ]

                return { 'open': true, 'blocks': head.concat( [ { 'text': `${ last[ 'text' ] } ${ text }`, 'number': last[ 'number' ], 'endNumber': entry[ 'number' ] } ] ) }
            }, { 'open': false, 'blocks': [] } )[ 'blocks' ]
    }


    // Does the optional reading stand BEFORE a quote or before a source reference? The reading is
    // element 3, so everything it must follow is element 1 and 2 — position is the only thing judged.
    static #mandateMisordered( { row } ) {
        if( row[ 'reading' ] === null || row[ 'section' ] !== true ) { return false }
        const later = row[ 'quotes' ].map( ( block ) => block[ 'number' ] )
            .concat( row[ 'sources' ].map( ( entry ) => entry[ 'number' ] ) )

        return later.some( ( number ) => number > row[ 'reading' ][ 'number' ] )
    }


    // One finding per offending chapter and per class, each naming its chapter and its line. A
    // collective "5 chapters violate the form" is not a finding — the author has to know WHICH.
    static #routeMandateFindings( { rows, struct } ) {
        const emit = ( { code, description } ) => MemoValidator.#route( {
            code,
            'feldPfad': 'chapter.userMandate',
            description,
            'messages': struct[ 'messages' ],
            'info': struct[ 'info' ],
            'warnings': struct[ 'warnings' ]
        } )

        const missingSection = rows
            .filter( ( row ) => row[ 'section' ] !== true )
        const emptySection = rows
            .filter( ( row ) => row[ 'section' ] === true && row[ 'quotes' ].length === 0 && row[ 'defaults' ].length === 0 )
        const quoteWithoutSource = rows
            .filter( ( row ) => row[ 'section' ] === true && row[ 'quotes' ].length > row[ 'sources' ].length )
        const misordered = rows
            .filter( ( row ) => MemoValidator.#mandateMisordered( { row } ) === true )
        const both = rows
            .filter( ( row ) => row[ 'defaults' ].length > 0 && row[ 'quotes' ].length > 0 )

        if( missingSection.length > 0 ) {
            emit( { 'code': 'WARN-200', 'description': `chapters=${ rows.length } without a section=${ missingSection.length } — ${ missingSection.map( ( row ) => `"${ row[ 'title' ] }" carries no \`### User-Auftrag\` section` ).join( '; ' ) }` } )
        }
        if( emptySection.length > 0 ) {
            emit( { 'code': 'WARN-200', 'description': `chapters=${ rows.length } with an unusable section=${ emptySection.length } — ${ emptySection.map( ( row ) => `"${ row[ 'title' ] }" (line ${ row[ 'headLine' ] }) carries neither a block quote nor a default sentence` ).join( '; ' ) }` } )
        }
        if( quoteWithoutSource.length > 0 ) {
            emit( { 'code': 'WARN-201', 'description': `chapters=${ rows.length } with a quote lacking a source reference=${ quoteWithoutSource.length } — ${ quoteWithoutSource.map( ( row ) => `"${ row[ 'title' ] }" quote at line ${ row[ 'quotes' ][ row[ 'sources' ].length ][ 'number' ] } (quotes=${ row[ 'quotes' ].length } sources=${ row[ 'sources' ].length })` ).join( '; ' ) }` } )
        }
        if( misordered.length > 0 ) {
            emit( { 'code': 'WARN-202', 'description': `chapters=${ rows.length } with the reading out of position=${ misordered.length } — ${ misordered.map( ( row ) => `"${ row[ 'title' ] }" \`**Gelesen als:**\` at line ${ row[ 'reading' ][ 'number' ] } stands before quote or source reference` ).join( '; ' ) }` } )
        }
        if( both.length > 0 ) {
            emit( { 'code': 'WARN-203', 'description': `chapters=${ rows.length } carrying default sentence and quote at once=${ both.length } — ${ both.map( ( row ) => `"${ row[ 'title' ] }" default sentence at line ${ row[ 'defaults' ][ 0 ][ 'number' ] }, quote at line ${ row[ 'quotes' ][ 0 ][ 'number' ] }` ).join( '; ' ) }` } )
        }
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


    // THE IDENTIFIER FAMILY — INFO-100/101 (S1), WARN-100 (S2), WARN-101 (S3). Memo 081, WI-075,
    // T055/T060.
    //
    // The recognition itself is NOT here and is not a second expression: it is IdRegister, whose
    // vocabulary region is a character-identical mirror of repos/core/cli/src/IdVocabulary.mjs
    // (PRD-28, WI-072/WI-073). This method is the WIRING — which channel each stage speaks through,
    // and what is reported when there is nothing to compare against.
    //
    // WHY S1 IS AN INFO AND NOT A SILENT SUCCESS. "schau dir T55 an" is the input the memo names as
    // the case the machine must UNDERSTAND rather than punish (REV-16:3033). What the author gets back
    // is therefore the READING — "T055 -> topic '…'" — and the reading is the finding. `IdRegister`
    // builds that sentence; this method only routes it.
    static #validateIdReferences( { doc, revisionType, knownIds } ) {
        const struct = { 'messages': [], 'info': [], 'warnings': [], 'basis': MemoValidator.#emptyIdResolution() }
        const { schema } = MemoValidator.#schemaOf( { revisionType } )
        if( schema[ 'idReferences' ] !== true ) { return struct }

        const { status, findings, basis } = IdRegister.resolve( { text: doc, knownIds } )
        if( status !== true ) { return struct }

        struct[ 'basis' ] = basis

        if( findings.length === 0 ) { return struct }

        // S1 — the reading of every recognised identifier, occurrences and distinct references stated
        // separately because they are two different numbers.
        MemoValidator.#route( {
            'code': 'INFO-100',
            'feldPfad': 'id.reading',
            'description': `occurrences=${ basis[ 'occurrences' ] } distinct=${ basis[ 'distinct' ] } resolved=${ basis[ 'resolved' ] } unresolved=${ basis[ 'unresolved' ] } ambiguous=${ basis[ 'ambiguous' ] } noCarrier=${ basis[ 'noCarrier' ] } — ${ findings.map( ( item ) => item[ 'reading' ] ).join( '; ' ) }`,
            'messages': struct[ 'messages' ],
            'info': struct[ 'info' ],
            'warnings': struct[ 'warnings' ]
        } )

        // No stock: S2 and S3 did NOT run. Said out loud, with the reason, instead of a green zero —
        // the identifier counterpart of INFO-020.
        if( basis[ 'available' ] !== true ) {
            MemoValidator.#route( {
                'code': 'INFO-101',
                'feldPfad': 'id.stock',
                'description': `${ basis[ 'distinct' ] } distinct identifiers were recognised but NOT checked for existence: ${ basis[ 'unavailableReason' ] }`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ],
                'warnings': struct[ 'warnings' ]
            } )

            return struct
        }

        const named = ( verdict ) => findings
            .filter( ( item ) => item[ 'verdict' ] === verdict )
            .map( ( item ) => item[ 'token' ] )

        const unresolved = named( 'unresolved' )
        const ambiguous = named( 'ambiguous' )

        if( unresolved.length > 0 ) {
            MemoValidator.#route( {
                'code': 'WARN-100',
                'feldPfad': 'id.unresolved',
                'description': `checked=${ basis[ 'checked' ] } against ${ basis[ 'comparedStockEntries' ] } stock entries over ${ basis[ 'comparedStockPrefixes' ] } covered prefixes — ${ unresolved.length } resolve nowhere: ${ unresolved.join( ', ' ) }`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ],
                'warnings': struct[ 'warnings' ]
            } )
        }

        if( ambiguous.length > 0 ) {
            MemoValidator.#route( {
                'code': 'WARN-101',
                'feldPfad': 'id.ambiguous',
                'description': `checked=${ basis[ 'checked' ] } against ${ basis[ 'comparedStockEntries' ] } stock entries — ${ ambiguous.length } resolve to more than one entry: ${ ambiguous.join( ', ' ) }`,
                'messages': struct[ 'messages' ],
                'info': struct[ 'info' ],
                'warnings': struct[ 'warnings' ]
            } )
        }

        return struct
    }


    // The basis shape in its "did not run" state. One spelling, so a refusal and a switched-off type
    // cannot drift apart from the real thing.
    static #emptyIdResolution() {
        return { 'ran': false, 'available': false, 'unavailableReason': null, 'checked': 0, 'resolved': 0, 'unresolved': 0, 'ambiguous': 0, 'noCarrier': 0, 'distinct': 0, 'occurrences': 0, 'comparedCharacters': 0, 'comparedStockEntries': 0, 'comparedStockPrefixes': 0, 'comparedStockMemos': 0 }
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
