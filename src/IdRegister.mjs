// IdRegister.mjs — stage S2 and S3 of the identifier check: does the identifier EXIST, and is it
// UNAMBIGUOUS (Memo 081, WI-075, T055/T060).
//
// WHAT THIS FILE IS NOT. It is not a second identifier vocabulary. The inventory and the ONE
// recognition expression derived from it were built in Memo 081 / PRD-28 (WI-072 "close the
// inventory", WI-073 "one expression") and live in `repos/core/cli/src/IdVocabulary.mjs`. That
// module's own header names this work as its successor: "It does NOT answer S2 'does that
// identifier exist?' and it does NOT answer S3 'is it unambiguous?'. Both need the stores and are
// built in WI-075."
//
// SO WHY IS THE VOCABULARY COPIED IN HERE. Because the viewer is a separate npm package with no
// dependency on core, and the write-time gate (MemoValidator) lives HERE. This is the identical
// situation as BlockSections, and it gets the identical treatment: the vocabulary region below is a
// CHARACTER-IDENTICAL MIRROR of the core module, held by a parity case that prints WHICH two files
// it compared and how many bytes. A mirror with a machine-held equality is one source in two copies;
// a second hand-typed expression would be the parallel path T060 rejects in its own reasoning, and
// the drift the core module was built to end (it measured 15 disagreeing expressions before it).
//
// THE MIRROR REGION IS EVERYTHING BETWEEN THE TWO MARKERS `const SEPARATOR_SOURCE` AND THE
// `const TOKEN_PARTS` LINE, INCLUSIVE. Do not edit it here. A change belongs in
// repos/core/cli/src/IdVocabulary.mjs and is copied over; the parity case turns red otherwise and
// names both paths.
//
// WHAT IS NEW HERE, AND IT IS THE WHOLE POINT OF WI-075:
//   S1  which identifiers does this text contain, and how are they read  -> scan()
//   S2  does the identifier resolve against a handed-in stock            -> resolve()
//   S3  does it resolve to MORE than one entry                           -> resolve()
//
// PURE, NO FILE ACCESS — the same contract `anchorTerms` already keeps. The stock is INJECTED: the
// caller does the IO (repos/core/cli/lib/lint.mjs for `memo lint`, MemoView from the store it
// already reads). An absent stock is NOT a silent default and NOT an empty stock — it is reported as
// `available: false`, and the existence rules then count as NOT CHECKED rather than as clean. This
// project has paid for a gate that reported green because it found nothing to compare.
//
// FOUR VERDICTS, NOT THREE. `no-carrier` is a statement of its own and is deliberately not folded
// into `unresolved`: an identifier whose PREFIX the handed-in stock does not cover at all is not a
// broken reference by the author, it is a kind of thing the machine cannot look up yet. Reporting
// the second as the first would hand the author a defect the machine made.
//
// THE OPT-OUT IS THE CODE MARK (REV-16:3062). Fences and inline spans are BLANKED — overwritten with
// spaces of the same length — before the search, rather than deleted. Same technique
// #validateLintExtensions already uses for MEMO-070, with one deliberate difference: blanking keeps
// every character offset and every line number true to the ORIGINAL text, so a reported index still
// points where the reader is looking.

const SEPARATOR_SOURCE = { required: '-', optional: '-?', none: '' }


// The full inventory — EVERY identifier kind the project mints or writes, including the ones that
// are deliberately NOT recognized. A row that is not recognized carries its reason, so `false` can
// never be the quiet way to drop an identifier.
//
// FIELDS. prefix: the literal prefix. entity: what it names. tier: 1 = a store entity with a mint
// point, 2 = a document-local counter. separator: 'required' | 'optional' | 'none'. digits: the OWN
// width span. mintedAt: the generator, as a path RELATIVE TO THE cli/ DIRECTORY (so the cross-repo
// annotation store reads `../../viewer/src/...`), or null when nothing mints it. carrier: where the
// stock lives. recognized: part of the recognition expression. unrecognizedReason: mandatory when
// recognized is false. vocabulary: 'v1' | 'v2'.
//
// The digit spans were measured against the real stock on 2026-09-07; the command per prefix is in
// the report (BERICHT-PRD-28.md, § Inventar). Rows that deviate from the 3–4 default say why.
const ID_VOCABULARY = [
    // ---- v1, recognized: the identifiers that are highlighted, linked and treated as canonical ----
    { prefix: 'M', entity: 'memo', tier: 1, separator: 'none', digits: { min: 3, max: 4 }, mintedAt: 'src/ChronicleReader.mjs:77', carrier: 'folder', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    // MNT: the code half moved to MNT-{NNN} with PRD-21 (MaintenanceStore.mjs:42), the DATA half is
    // still M001.json … M006.json. The expression survives BOTH states — `M004` matches through the
    // M row, `MNT-004` through this one. Renaming the cards belongs behind the merge to main.
    { prefix: 'MNT', entity: 'maintenance-card', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: 'src/MaintenanceStore.mjs:325', carrier: 'json-record', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    { prefix: 'T', entity: 'topic', tier: 1, separator: 'none', digits: { min: 3, max: 4 }, mintedAt: 'src/TopicStore.mjs:485', carrier: 'json-record', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    { prefix: 'B', entity: 'block', tier: 1, separator: 'none', digits: { min: 3, max: 4 }, mintedAt: 'src/MemoBlock.mjs:269', carrier: 'json-record', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    { prefix: 'G', entity: 'goal', tier: 1, separator: 'none', digits: { min: 3, max: 4 }, mintedAt: 'src/GoalStore.mjs:347', carrier: 'json-record', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    { prefix: 'WI', entity: 'work-item', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: 'src/WorkItemStore.mjs:1078', carrier: 'json-record', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    { prefix: 'RES', entity: 'research', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: 'src/ResearchStore.mjs:287', carrier: 'json-record', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    // PRD: 1–4, not 3–4. Nothing mints a PRD id — the carrier is the file name, and the real stock
    // runs PRD-1 … PRD-514 unpadded: 3 one-digit, 59 two-digit, 514 three-digit files. A 3-digit
    // floor would fail to recognize 62 real PRDs, this very one (PRD-28) among them.
    { prefix: 'PRD', entity: 'prd', tier: 1, separator: 'required', digits: { min: 1, max: 4 }, mintedAt: null, carrier: 'filename', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    { prefix: 'REQ', entity: 'requirement', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: '../lib/requirements/allocate.mjs:20', carrier: 'json-record', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    { prefix: 'PLAN', entity: 'plan', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    { prefix: 'ANM', entity: 'annotation', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: '../../viewer/src/AnnotationStore.mjs:309', carrier: 'json-record', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    { prefix: 'LL', entity: 'lesson-learned', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: 'src/LessonStore.mjs:201', carrier: 'db-row', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    // REV: 2–4. The whole stock is two-digit (891 REV-NN.md files); the head-room to four keeps a
    // memo past REV-99 readable. A global three-digit width could not match a single real revision.
    { prefix: 'REV', entity: 'revision', tier: 2, separator: 'required', digits: { min: 2, max: 4 }, mintedAt: null, carrier: 'filename', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },
    // SR: 2–3. The twelve controlled-language rules are SR-01 … SR-13 in the spec prose.
    { prefix: 'SR', entity: 'controlled-language-rule', tier: 2, separator: 'required', digits: { min: 2, max: 3 }, mintedAt: null, carrier: 'prose', recognized: true, unrecognizedReason: null, vocabulary: 'v1' },

    // ---- v1, NOT recognized: in the inventory because they exist, out of the expression with a
    // measured reason. Hit counts are `\b<prefix>\d{1,4}\b` over the five corpora, 2026-09-07. ----
    { prefix: 'F', entity: 'question', tier: 2, separator: 'none', digits: { min: 1, max: 2 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: '6694 hits across the five corpora — not separable in running text from formula symbols, figure numbers and the F-keys of a keyboard', vocabulary: 'v1' },
    { prefix: 'P', entity: 'phase', tier: 2, separator: 'none', digits: { min: 1, max: 2 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: '3966 hits — collides with paragraph numbers, pin numbers and the P-variants of the analysis markers; SR-04 flags a bare P2 as ad-hoc on purpose', vocabulary: 'v1' },
    { prefix: 'C', entity: 'invariant-check', tier: 2, separator: 'none', digits: { min: 1, max: 2 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: '1327 hits — collides with cluster ids (C1, C2), column numbers and C-language references', vocabulary: 'v1' },
    { prefix: 'K', entity: 'analysis-marker', tier: 2, separator: 'none', digits: { min: 1, max: 2 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: '910 hits — collides with the corpus labels K1 … K5 used in this very measurement, and with chapter numbering', vocabulary: 'v1' },
    { prefix: 'L', entity: 'analysis-marker', tier: 2, separator: 'none', digits: { min: 1, max: 4 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: '35223 hits — by far the worst, because L100 and #L42 are the GitHub line-anchor notation and appear in every generated view', vocabulary: 'v1' },
    { prefix: 'R', entity: 'analysis-marker', tier: 2, separator: 'none', digits: { min: 1, max: 2 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: '775 hits — R1 is exactly the ad-hoc abbreviation SR-04 asks to be replaced by REV-01; recognizing it would legitimize it', vocabulary: 'v1' },
    { prefix: 'E', entity: 'analysis-marker', tier: 2, separator: 'none', digits: { min: 1, max: 2 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: '256 hits — collides with exponent notation (1E5) and error numbering', vocabulary: 'v1' },
    { prefix: 'V', entity: 'analysis-marker', tier: 2, separator: 'none', digits: { min: 1, max: 2 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: '1502 hits — collides with version notation (V2 is used as a vocabulary name in this module) and with volt units', vocabulary: 'v1' },
    { prefix: 'AR', entity: 'analysis-marker', tier: 2, separator: 'none', digits: { min: 1, max: 2 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: '0 hits across the five corpora — nothing carries it today; it is listed so its absence is a measurement rather than an oversight', vocabulary: 'v1' },

    // ---- v2: the list-free successor vocabulary. Nothing mints these yet (measured: zero mint
    // points), so recognizing them could only produce false positives. See S4 / A6. ----
    { prefix: 'TOP', entity: 'topic', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet; the V2 branch stays off until the existence check of WI-075 sits in front of it', vocabulary: 'v2' },
    { prefix: 'WIT', entity: 'work-item', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' },
    { prefix: 'BLK', entity: 'block', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' },
    { prefix: 'GOA', entity: 'goal', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' },
    { prefix: 'PLN', entity: 'plan', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' },
    { prefix: 'DOC', entity: 'document-evidence', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet; the evidence layer is WI-117, not this cluster', vocabulary: 'v2' },
    { prefix: 'AGT', entity: 'agent-evidence', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet; the evidence layer is WI-117, not this cluster', vocabulary: 'v2' },
    { prefix: 'SNG', entity: 'snag', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' },
    { prefix: 'QST', entity: 'question', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' },
    { prefix: 'PHS', entity: 'phase', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' },
    { prefix: 'CHK', entity: 'check', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' },
    { prefix: 'FND', entity: 'finding', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'json-record', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' },
    { prefix: 'SRU', entity: 'controlled-language-rule', tier: 1, separator: 'required', digits: { min: 3, max: 4 }, mintedAt: null, carrier: 'prose', recognized: false, unrecognizedReason: 'v2 vocabulary — no mint point exists yet', vocabulary: 'v2' }
]


// #digitSource — `\d{3}` when min equals max, `\d{3,4}` otherwise. Kept separate so the two callers
// (v1 branch, anchored form) cannot drift apart.
const digitSource = ( { digits } ) => {
    return digits.min === digits.max ? `\\d{${ digits.min }}` : `\\d{${ digits.min },${ digits.max }}`
}


// #groupSource — one alternation group per (separator, digit span). Prefixes inside a group are
// sorted by LENGTH DESCENDING (then alphabetically), so a newly added prefix can never flip the
// order and shadow a longer one; groups themselves are sorted by their longest prefix, descending.
// Both orders are computed, never hand-kept.
const buildSource = ( { entries } ) => {
    const usable = entries
        .filter( ( entry ) => entry.recognized === true )
        .filter( ( entry ) => entry.vocabulary === 'v1' )

    const groups = usable.reduce( ( acc, entry ) => {
        const key = `${ entry.separator }|${ entry.digits.min }|${ entry.digits.max }`
        const bucket = acc[ key ] === undefined ? [] : acc[ key ]

        return { ...acc, [ key ]: bucket.concat( [ entry ] ) }
    }, {} )

    const rendered = Object.values( groups )
        .map( ( members ) => {
            const prefixes = members
                .map( ( entry ) => entry.prefix )
                .sort( ( a, b ) => b.length - a.length || a.localeCompare( b ) )
            const separator = SEPARATOR_SOURCE[ members[ 0 ].separator ]
            const digits = digitSource( { digits: members[ 0 ].digits } )

            return { longest: prefixes[ 0 ].length, source: `(?:${ prefixes.join( '|' ) })${ separator }${ digits }` }
        } )
        .sort( ( a, b ) => b.longest - a.longest || a.source.localeCompare( b.source ) )
        .map( ( group ) => group.source )

    return { source: rendered.join( '|' ), compared: usable.length }
}


// The bare alternation, without boundaries or anchors — the single string every other form is built
// from. Exported so a consumer can compose it (for example with SCOPE_PREFIX) instead of retyping it.
const ID_TOKEN_SOURCE = buildSource( { entries: ID_VOCABULARY } ).source

// The SCANNING expression: finds identifiers inside running text. `g` on purpose — every consumer
// uses matchAll. Word boundaries on both sides, so `XT001` and `MNT-00041` are not hits.
const ID_TOKEN_PATTERN = new RegExp( `\\b(?:${ ID_TOKEN_SOURCE })\\b`, 'g' )

// The WHOLE-TOKEN form of the very same derivation. This is what replaced the hand-typed
// CANONICAL_TOKEN in ControlledLanguageLint.
const ID_TOKEN_ANCHORED = new RegExp( `^(?:${ ID_TOKEN_SOURCE })$` )

// The list-free V2 branch — DELIBERATELY NOT part of ID_TOKEN_PATTERN, and switched off (S4).
//
// MEASURED 2026-09-07 over the five corpora (741 files, 17 672 741 characters): 2178 hits, of which
// 252 carry a prefix that belongs to NO project vocabulary — 11.6 %. In the adversarial corpus the
// rate is 23 of 23 = 100 %. The foreign prefixes are led by URL (54), ISO (51), DIN (50), VAL (30)
// and SHA (28); URL-005 is the phantom identifier the branch invents inside MEMO-INPUT-URL-005.
// Reproduce with the § V2 command in BERICHT-PRD-28.md.
//
// It may only be armed once the EXISTENCE check (stage S2, WI-075 / PRD-40) sits in front of it;
// until then it would quietly link DIN-476 and ISO-9001 instead of handing them out as a warning.
// It is additionally without effect today: there is not one mint point for the v2 vocabulary (A6.4).
const ID_TOKEN_PATTERN_V2 = /\b[A-Z]{3}-\d{3,4}\b/g

// V2 is off by default. A consumer that wants it must say so, and must own the false-positive rate.
const V2_ENABLED = false

// The optional scope prefix for a QUALIFIED, memo-foreign reference — `M080-T096`, `M080/WI-221`
// (Memo 081, F20 = A). Exported as its own constant so a consumer can switch it on or off without
// rewriting the expression.
const SCOPE_PREFIX_SOURCE = '(?:M\\d{3,4}[-/])?'
const SCOPE_PREFIX = new RegExp( SCOPE_PREFIX_SOURCE )

// A qualified reference as a whole: scope prefix plus identifier. Composed, never retyped.
const ID_TOKEN_QUALIFIED = new RegExp( `\\b${ SCOPE_PREFIX_SOURCE }(?:${ ID_TOKEN_SOURCE })\\b`, 'g' )

// Splits a matched token into its prefix and its digits. The membership of a hit is decided by the
// INVENTORY LOOKUP below, never by which named group happened to fire — `MNT-004` also fits the
// shape of the V2 branch, and only the table says which vocabulary it belongs to.
const TOKEN_PARTS = /^(?<prefix>[A-Z]+)-?(?<digits>\d+)$/


// ---- end of the mirror region. Everything below is stage S2/S3 and exists only here. ----


// The two markers that bound the mirror region, exported so the parity case does not carry a second
// hand-typed copy of where the region starts and ends.
const MIRROR_MARKERS = { start: 'const SEPARATOR_SOURCE', end: 'const TOKEN_PARTS' }

// A QUALIFIED reference splits into the memo it points into and the identifier itself — `M080-WI-221`
// (Memo 081, F20 = A: memo-foreign is qualified DUTY, and the qualification is part of the syntax
// rather than an extra field). The scope is only accepted when what follows it is itself a canonical
// token, so `M081` on its own stays the memo identifier it is.
const SCOPED_TOKEN = /^M(?<scopeDigits>\d{3,4})[-/](?<rest>.+)$/

// blankOut — overwrite a match with spaces of the same length, newlines kept. This is what makes the
// opt-out offset-true: deleting the fence would shift every later index and line number.
const blankOut = ( match ) => {
    return match.replace( /[^\n]/g, ' ' )
}


class IdRegister {
    // vocabulary — the mirrored inventory, as defensive copies. `compared` is the number of rows, so
    // a caller can never read an empty inventory as a green one.
    static vocabulary( {} = {} ) {
        return { entries: ID_VOCABULARY.map( ( entry ) => ( { ...entry } ) ), compared: ID_VOCABULARY.length }
    }


    // prefixes — filtered by recognition state. `recognized` is REQUIRED: "all prefixes" and "the
    // recognized prefixes" are different questions and guessing which one was meant is how a
    // whitelist check turns vacuous.
    static prefixes( { recognized } ) {
        if( typeof recognized !== 'boolean' ) {
            return { status: false, messages: [ 'recognized: required boolean' ], prefixes: [], compared: 0 }
        }

        const matching = ID_VOCABULARY.filter( ( entry ) => entry.recognized === recognized )

        return { status: true, messages: [], prefixes: matching.map( ( entry ) => entry.prefix ), compared: ID_VOCABULARY.length }
    }


    // mirrorRegion — cut the mirrored region out of a module's SOURCE TEXT. Used by the parity case
    // on both files, so neither side carries its own idea of where the region begins.
    static mirrorRegion( { source } ) {
        if( typeof source !== 'string' ) {
            return { status: false, messages: [ 'source: required string' ], region: '', lines: 0 }
        }

        const lines = source.split( '\n' )
        const from = lines.findIndex( ( line ) => line.startsWith( MIRROR_MARKERS.start ) )
        const to = lines.findIndex( ( line ) => line.startsWith( MIRROR_MARKERS.end ) )

        if( from === -1 || to === -1 || to < from ) {
            return { status: false, messages: [ `mirror markers not found (start ${ from }, end ${ to })` ], region: '', lines: 0 }
        }

        const region = lines.slice( from, to + 1 )

        return { status: true, messages: [], region: region.join( '\n' ), lines: region.length }
    }


    // scan — stage S1. Every identifier-shaped token in `text`, with the code mark honoured. PURELY
    // LEXICAL: it says the token has the agreed FORM and says nothing about whether the thing exists.
    //
    // `compared` is the character count actually searched and `blanked` the count the opt-out removed
    // from consideration — a caller that gets 0 tokens can tell "nothing there" from "nothing
    // searched" and from "everything was inside code".
    static scan( { text } ) {
        if( typeof text !== 'string' ) {
            return { status: false, messages: [ 'text: required string' ], tokens: [], occurrences: 0, distinct: 0, byPrefix: {}, compared: 0, blanked: 0 }
        }

        const withoutFences = text.replace( /```[\s\S]*?```/g, blankOut )
        const searchable = withoutFences.replace( /`[^`]*`/g, blankOut )
        // `blanked` is counted over the MATCHED REGIONS ONLY, never by comparing the two whole strings.
        // Measured on REV-16 (535 257 characters): two `match( /\S/g )` passes over the full text cost
        // 54.9 ms of a 70.4 ms scan — an allocation of half a million single-character strings, twice,
        // to produce one integer. Over the matched regions (48 293 characters here) the same number
        // costs a fraction of that, and this runs at seven content-send sites.
        const blanked = ( text.match( /```[\s\S]*?```/g ) || [] )
            .concat( withoutFences.match( /`[^`]*`/g ) || [] )
            .reduce( ( acc, region ) => acc + ( region.match( /\S/g ) || [] ).length, 0 )

        const hits = [ ...searchable.matchAll( ID_TOKEN_QUALIFIED ) ]
        const tokens = hits
            .map( ( hit ) => IdRegister.#splitToken( { token: hit[ 0 ], index: hit.index } ) )
            .filter( ( entry ) => entry !== null )

        const distinctKeys = [ ...new Set( tokens.map( ( entry ) => entry.key ) ) ]
        const byPrefix = tokens.reduce( ( acc, entry ) => {
            const seen = acc[ entry.prefix ] === undefined ? 0 : acc[ entry.prefix ]

            return { ...acc, [ entry.prefix ]: seen + 1 }
        }, {} )

        return { status: true, messages: [], tokens, occurrences: tokens.length, distinct: distinctKeys.length, byPrefix, compared: searchable.length, blanked }
    }


    // resolve — stages S2 and S3 on top of S1. `knownIds` is the INJECTED stock and carries four
    // members, none of them optional and none of them defaulted:
    //   memo      the memo this document belongs to (`M081`), or null when it cannot be determined
    //   prefixes  the prefixes this stock actually COVERS — the basis of the no-carrier verdict
    //   memos     the memo SCOPES this stock covers — the second half of the same idea
    //   ids       the entries themselves, `{ id, memo, title }`; `memo` null means unscoped
    //
    // WHY COVERAGE IS TWO LISTS AND NOT ONE. `M080-WI-221` is a CORRECT reference under F20 = A. A
    // stock that holds only the local memo would find no entry for it and report the author's correct,
    // rule-following reference as broken — the gate would punish the very convention it enforces.
    // Naming the covered SCOPES separately makes that case `no-carrier`: not "this reference is
    // broken", but "this stock does not reach into that memo". Measured on REV-16, six of the nine
    // non-resolving references are cross-memo, so this is the majority case, not an edge.
    //
    // An absent or malformed stock is answered with `available: false` AND A NAMED REASON, never with
    // an empty stock: an empty stock would report every identifier as broken and claim to have
    // measured, which is the vacuum-green gate with its sign flipped.
    static resolve( { text, knownIds } ) {
        const scanned = IdRegister.scan( { text } )

        if( scanned.status !== true ) {
            return { status: false, messages: scanned.messages, findings: [], basis: IdRegister.#emptyBasis( { reason: 'text could not be scanned' } ) }
        }

        const stock = IdRegister.#stockOf( { knownIds } )
        const distinct = IdRegister.#distinctOf( { tokens: scanned.tokens } )

        const findings = distinct
            .map( ( entry ) => {
                const row = ID_VOCABULARY.find( ( item ) => item.prefix === entry.prefix )
                const entity = row === undefined ? null : row.entity

                if( stock.available !== true ) {
                    return { ...entry, entity, verdict: 'not-checked', matches: 0, title: null, reading: `${ entry.token } -> ${ entity === null ? 'unknown kind' : entity }, existence NOT checked (no stock)` }
                }

                return IdRegister.#verdictOf( { entry, entity, stock } )
            } )

        const counted = ( verdict ) => findings.filter( ( item ) => item.verdict === verdict ).length

        const basis = {
            ran: true,
            available: stock.available,
            unavailableReason: stock.reason,
            checked: stock.available === true ? findings.length : 0,
            resolved: counted( 'resolved' ),
            unresolved: counted( 'unresolved' ),
            ambiguous: counted( 'ambiguous' ),
            noCarrier: counted( 'no-carrier' ),
            distinct: findings.length,
            occurrences: scanned.occurrences,
            comparedCharacters: scanned.compared,
            comparedStockEntries: stock.ids.length,
            comparedStockPrefixes: stock.prefixes.length,
            comparedStockMemos: stock.memos.length
        }

        return { status: true, messages: [], findings, basis }
    }


    // ---- private ----


    // #splitToken — a matched token into scope, identifier, prefix and digits. Returns null when the
    // token does not decompose, so a shape the expression matched but the table cannot name is
    // dropped rather than reported under a guessed prefix.
    static #splitToken( { token, index } ) {
        const scoped = SCOPED_TOKEN.exec( token )
        // A MEMO CANNOT BE SCOPED INSIDE ANOTHER MEMO. The scope separator is `-` OR `/` (the mirrored
        // SCOPE_PREFIX_SOURCE), and `M080/M081` in prose means "M080 and M081", not "M081 within
        // M080" — it has the exact shape of a qualified reference and none of its meaning. Measured in
        // REV-16: 2 occurrences, both of which were read as a qualified reference into a foreign memo
        // and reported as unresolved, i.e. as the author's broken reference. The rule is stated at the
        // level where it belongs — the RESOLVER, which knows what a memo is — and not by editing the
        // mirrored expression, which knows only shapes.
        //
        // NAMED LIMIT: the token is then read as the scope memo alone, and the identifier after the
        // slash is not separately counted, because the expression has already consumed it. That is a
        // known undercount of 2 in this corpus and it is reported rather than papered over.
        const targetsMemo = scoped !== null && /^M\d{3,4}$/.test( scoped.groups.rest ) === true
        const qualified = scoped !== null && targetsMemo !== true && ID_TOKEN_ANCHORED.test( scoped.groups.rest ) === true
        const scope = qualified === true ? `M${ scoped.groups.scopeDigits }` : null
        const id = qualified === true ? scoped.groups.rest : ( targetsMemo === true ? `M${ scoped.groups.scopeDigits }` : token )
        const parts = TOKEN_PARTS.exec( id )

        if( parts === null ) { return null }

        return { token, id, scope, qualified, prefix: parts.groups.prefix, digits: parts.groups.digits, index, key: `${ scope === null ? '' : `${ scope }-` }${ id }` }
    }


    // #distinctOf — occurrences collapsed to distinct references. Occurrences and distinct references
    // are TWO statements (measured on REV-16: 2252 against 304) and an answer that gives only one of
    // them is ambiguous, so both are carried.
    //
    // INDEXED, NOT SCANNED, AND THE REASON IS MEASURED. The first version used `acc.find` plus
    // `acc.map` inside a reduce, which rebuilds the whole accumulator on every repeated occurrence —
    // quadratic in the number of occurrences. On REV-16 (2245 occurrences, 312 distinct) that turned
    // one MemoValidator.validate call from 34.8 ms into 107.0 ms, and this runs at seven content-send
    // sites. The Map keeps the same result and the same order of first appearance.
    static #distinctOf( { tokens } ) {
        const index = new Map()

        tokens.forEach( ( entry ) => {
            const seen = index.get( entry.key )

            if( seen === undefined ) {
                index.set( entry.key, { token: entry.token, id: entry.id, scope: entry.scope, qualified: entry.qualified, prefix: entry.prefix, key: entry.key, index: entry.index, occurrences: 1 } )

                return
            }

            seen.occurrences = seen.occurrences + 1
        } )

        return [ ...index.values() ]
    }


    // #stockOf — validate the injected stock. Every rejection carries its reason in words; that
    // reason is what the caller prints instead of a green zero.
    static #stockOf( { knownIds } ) {
        const empty = { memo: null, prefixes: [], memos: [], ids: [] }

        if( knownIds === undefined || knownIds === null ) {
            return { ...empty, available: false, reason: 'no stock was handed in — the existence rules did not run' }
        }

        if( typeof knownIds !== 'object' || Array.isArray( knownIds ) === true ) {
            return { ...empty, available: false, reason: 'stock must be an object { memo, prefixes, memos, ids } — an array cannot say what it covers' }
        }

        if( Array.isArray( knownIds.prefixes ) !== true || Array.isArray( knownIds.ids ) !== true ) {
            return { ...empty, available: false, reason: 'stock needs both prefixes[] and ids[] — the covered prefixes are what tells a missing entry apart from an unsupported kind' }
        }

        const memo = typeof knownIds.memo === 'string' && knownIds.memo.length > 0 ? knownIds.memo : null
        // `memos` defaults to the local memo alone, and that default is NOT silent: it is the smallest
        // truthful claim a stock can make about its scope coverage, and a caller that reaches further
        // says so. The alternative — treating an absent list as "covers everything" — would turn an
        // uncovered scope back into a false "broken reference".
        const memos = Array.isArray( knownIds.memos ) ? knownIds.memos : ( memo === null ? [] : [ memo ] )

        return { available: true, reason: null, memo, prefixes: knownIds.prefixes, memos, ids: knownIds.ids }
    }


    // #verdictOf — the four-way answer for ONE distinct reference.
    //   no-carrier  the stock does not cover this PREFIX at all — not the author's defect
    //   unresolved  covered prefix, no entry           (stage S2)
    //   ambiguous   covered prefix, more than one entry (stage S3, the more dangerous class)
    //   resolved    exactly one entry
    static #verdictOf( { entry, entity, stock } ) {
        const kind = entity === null ? 'unknown kind' : entity

        if( stock.prefixes.includes( entry.prefix ) !== true ) {
            return { ...entry, entity, verdict: 'no-carrier', matches: 0, title: null, reading: `${ entry.token } -> ${ kind }, no carrier for this kind in the handed-in stock` }
        }

        if( entry.qualified === true && stock.memos.includes( entry.scope ) !== true ) {
            return { ...entry, entity, verdict: 'no-carrier', matches: 0, title: null, reading: `${ entry.token } -> ${ kind }, the stock does not reach into ${ entry.scope }` }
        }

        const matching = stock.ids
            .filter( ( item ) => item !== null && typeof item === 'object' && item.id === entry.id )
            .filter( ( item ) => {
                const scope = typeof item.memo === 'string' && item.memo.length > 0 ? item.memo : null

                return entry.qualified === true ? scope === entry.scope : ( scope === null || scope === stock.memo )
            } )

        const title = matching.length === 1 && typeof matching[ 0 ].title === 'string' ? matching[ 0 ].title : null
        const verdict = matching.length === 0 ? 'unresolved' : ( matching.length === 1 ? 'resolved' : 'ambiguous' )
        const reading = verdict === 'resolved'
            ? `${ entry.token } -> ${ kind }${ title === null ? '' : ` "${ title }"` }`
            : ( verdict === 'ambiguous'
                ? `${ entry.token } -> ${ kind }, ${ matching.length } entries carry this id`
                : `${ entry.token } -> ${ kind }, no entry carries this id` )

        return { ...entry, entity, verdict, matches: matching.length, title, reading }
    }


    static #emptyBasis( { reason } ) {
        return { ran: false, available: false, unavailableReason: reason, checked: 0, resolved: 0, unresolved: 0, ambiguous: 0, noCarrier: 0, distinct: 0, occurrences: 0, comparedCharacters: 0, comparedStockEntries: 0, comparedStockPrefixes: 0, comparedStockMemos: 0 }
    }
}


export {
    IdRegister,
    ID_VOCABULARY,
    ID_TOKEN_SOURCE,
    ID_TOKEN_PATTERN,
    ID_TOKEN_ANCHORED,
    ID_TOKEN_PATTERN_V2,
    ID_TOKEN_QUALIFIED,
    SCOPE_PREFIX,
    SCOPE_PREFIX_SOURCE,
    SEPARATOR_SOURCE,
    V2_ENABLED,
    MIRROR_MARKERS
}
