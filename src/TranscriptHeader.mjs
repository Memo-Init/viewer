// Memo 016 Phase 1 — 4-Typen-Datenmodell, Nummern-Fix, Versions-Marker.
// The four transcript types, their context mode, and per-type injection templates.

const SCHEMA_VERSION = 2

const TRANSCRIPT_TYPES = {
    'FREI': 'frei',
    'MEMO_INIT': 'memo-init',
    'REVISION': 'revision',
    'PLAN_START': 'plan-start'
}

const TYPE_VALUES = [ 'frei', 'memo-init', 'revision', 'plan-start' ]

const CONTEXT_MODES = {
    'frei': 'im-thread',
    'memo-init': 'leerer-kontext',
    'revision': 'im-thread',
    'plan-start': 'leerer-kontext'
}

const SCHEMA_LINE = `Schema-Version: ${ SCHEMA_VERSION }`
const SCHEMA_DETECT_REGEX = /^Schema-Version:\s*(\d+)\s*$/m

// Type "revision" — the only template carrying a memo number and revision fields.
//
// PRD-009 (Memo 022 Kap 10) — Bindungsmodell:
// Die Header-Ueberschrift nennt die BESPROCHENE Revision ({REV-DISCUSSED}). Das ist der
// Leit-/Bindungsschluessel (Dateiname = besprochene Revision, Phase 1). Die
// "Feedback zu … → erzeugt …"-Zeile bleibt erhalten, ist aber nur noch ABGELEITETE
// Workflow-Info (welche Revision aus dem Feedback entsteht) und KEIN Bindungsschluessel.
// Numbers come from PRD-002 (next = max+1), never from the transcript suffix.
//
// Das alte "erzeugt-die-naechste"-Schema (Ueberschrift nennt {REV-NEXT}) ist LEGACY und wird
// von detectLegacyBinding() weiter gelesen, aber NICHT mehr neu erzeugt (keine Auto-Migration,
// Memo 016 Kap 2.1).
const REVISION_TEMPLATE = `# Transcript zu Memo {NNN} {Memo-Name} — Revision {REV-DISCUSSED}

${ SCHEMA_LINE }

**ACHTUNG:** Diese Datei ist ein Audio-Transcript. Transcripts koennen Fehler enthalten
(falsche Aussprache, Hintergrund-Geraeusche, Verwechslungen wie PRD↔PAD). Die Pipeline
\`memo-input-processing\` erkennt und korrigiert diese Fehler.

**Dieser Transcript darf NICHT direkt in eine Revision uebernommen werden.**

Besprochene Revision (Bindung): \`{REV-DISCUSSED}\`

Abgeleitete Workflow-Info (KEIN Bindungsschluessel): Feedback zu {REV-DISCUSSED} → erzeugt {REV-NEXT}

**Voraussetzung:** \`memo-sop\` gelesen/geladen (Skill-Kontext aktuell).

Pflicht-Workflow (Skill-Aufrufe):

1. \`memo-input-processing\` mit diesem Pfad
2. \`memo-revision-generate\` (erstellt PREPARE-{REV-NEXT}.md)
3. \`memo-revision-execute\` (schreibt {REV-NEXT}.md)
4. \`memo-revision-evaluate\` (Auto-Check)

Memo-Pfad: \`.memo/memos/{NNN}-{slug}/revisions/\`
Vorherige Revision: \`{REV-PREV}.md\`
Naechste Revision (zu erstellen): \`{REV-NEXT}.md\`

---

## Transcript-Inhalt

`

// Type "memo-init" — leerer Kontext. No memo number, no revision fields, no path:
// the storage location is unknown at this point (Memo 016 Kap 3 Real-World-Constraint).
// PRD-013 (Memo 054 Kap 7): precondition line injected before step 1 so every written
// init-transcript carries the memo-sop requirement explicitly.
const MEMO_INIT_TEMPLATE = `# Transcript fuer neues Memo (memo-init)

${ SCHEMA_LINE }

**ACHTUNG:** Diese Datei ist ein Audio-Transcript. Transcripts koennen Fehler enthalten
(falsche Aussprache, Hintergrund-Geraeusche, Verwechslungen wie PRD↔PAD). Die Pipeline
\`memo-input-processing\` erkennt und korrigiert diese Fehler.

Kontext-Modus: leerer Kontext. Es ist KEINE Memo-Nummer, KEIN Ablageort und KEIN
Revisions-Feld vordefiniert — der Ort wird erst bei \`memo-init\` bestimmt.

**Voraussetzung:** \`memo-sop\` gelesen/geladen (Skill-Kontext aktuell).

Pflicht-Workflow (Skill-Aufrufe):

1. \`memo-input-processing\` mit diesem Pfad
2. \`memo-init\` (neues Memo anlegen)

---

## Transcript-Inhalt

`

// Type "plan-start" — leerer Kontext. Plan creation + memo selection, no number/revision/path.
const PLAN_START_TEMPLATE = `# Transcript fuer Plan-Start (plan-start)

${ SCHEMA_LINE }

**ACHTUNG:** Diese Datei ist ein Audio-Transcript. Transcripts koennen Fehler enthalten
(falsche Aussprache, Hintergrund-Geraeusche, Verwechslungen wie PRD↔PAD). Die Pipeline
\`memo-input-processing\` erkennt und korrigiert diese Fehler.

Kontext-Modus: leerer Kontext. KEINE Memo-Nummer, KEIN Ablageort, KEIN Revisions-Feld.
Zweck: einen Plan erstellen und mehrere Memos auswaehlen.

Pflicht-Workflow (Skill-Aufrufe):

1. \`memo-input-processing\` mit diesem Pfad
2. \`memo-plan-init\` / \`memo-plan-add\` (Plan erstellen, Memos auswaehlen)

---

## Transcript-Inhalt

`

// Type "frei" — im Thread. Always stored (analytics), no number/revision.
const FREI_TEMPLATE = `# Transcript (frei / undefiniert)

${ SCHEMA_LINE }

**ACHTUNG:** Diese Datei ist ein Audio-Transcript. Transcripts koennen Fehler enthalten
(falsche Aussprache, Hintergrund-Geraeusche, Verwechslungen wie PRD↔PAD). Die Pipeline
\`memo-input-processing\` erkennt und korrigiert diese Fehler.

Achtung Transcript. Input-Processing — aber KEINE Revision/Memo.

Pflicht-Workflow (Skill-Aufrufe):

1. \`memo-input-processing\` mit diesem Pfad

---

## Transcript-Inhalt

`

const TYPE_TEMPLATES = {
    'frei': FREI_TEMPLATE,
    'memo-init': MEMO_INIT_TEMPLATE,
    'revision': REVISION_TEMPLATE,
    'plan-start': PLAN_START_TEMPLATE
}

// Matches the first line of every type-template above.
const HEADER_DETECT_REGEX = /^# Transcript (zu Memo |fuer neues Memo|fuer Plan-Start|\(frei)/

// PRD-007: reconstruct the transcript type from the first header line. The first line
// of each TYPE_TEMPLATE is unique per type, so the type is recoverable on scan.
const TYPE_FIRST_LINE_REGEX = {
    'revision': /^# Transcript zu Memo /,
    'memo-init': /^# Transcript fuer neues Memo /,
    'plan-start': /^# Transcript fuer Plan-Start /,
    'frei': /^# Transcript \(frei/
}


class TranscriptHeader {
    // PRD-042 (Memo 016 Kap 3): build the injected Plan-Start prompt. Starts from the
    // ortfreie plan-start template (no plan number, no .memo/plans/ target, no revision field)
    // and appends an explicit skill-binding block plus the absolute paths of the selected
    // finalized memos. The editor only produces this prompt — creating/mutating .memo/plans/
    // is left to the bound skills (memo-plan-init / memo-plan-add).
    static buildPlanStartPrompt( { memoPaths } ) {
        const base = TranscriptHeader.build( { 'type': TRANSCRIPT_TYPES[ 'PLAN_START' ] } )

        if( !base[ 'status' ] ) {
            return base
        }

        const paths = Array.isArray( memoPaths ) ? memoPaths.filter( ( p ) => typeof p === 'string' && p.length > 0 ) : []

        if( paths.length === 0 ) {
            return { 'status': false, 'messages': [ 'TRANSCRIPT-HEADER-004: plan-start prompt requires at least one absolute memo path' ], 'prompt': null }
        }

        const pathLines = paths
            .map( ( p ) => `- ${ p }` )
            .join( '\n' )

        const promptBody = `${ base[ 'header' ] }Plan-Erstellung + Memo-Auswahl.

Skill-Bindung:
- Neuer Plan: memo-plan-init {slug} (legt einen neuen Plan an; die Plan-Nummer wird vom Skill selbst vergeben — KEINE Nummer und KEIN Ablageort hier vordefinieren).
- Bestehender Plan: memo-plan-add {plan-id} {memo-path} (fuegt je Memo eines zu einem bestehenden Plan hinzu).

Ausgewaehlte finalisierte Memos (absolute Pfade):
${ pathLines }
`

        return { 'status': true, 'messages': [], 'prompt': promptBody, 'contextMode': CONTEXT_MODES[ TRANSCRIPT_TYPES[ 'PLAN_START' ] ], 'memoPaths': paths }
    }


    static build( { type, memoId, revisionId, maxRevNumber } ) {
        const resolvedType = ( type === undefined || type === null ) ? TRANSCRIPT_TYPES[ 'FREI' ] : type

        if( !TYPE_VALUES.includes( resolvedType ) ) {
            return { 'status': false, 'messages': [ `TRANSCRIPT-HEADER-001: Unknown transcript type: ${ resolvedType }` ], 'header': null }
        }

        if( resolvedType !== TRANSCRIPT_TYPES[ 'REVISION' ] ) {
            const header = TYPE_TEMPLATES[ resolvedType ]

            return { 'status': true, 'messages': [], header, 'contextMode': CONTEXT_MODES[ resolvedType ] }
        }

        const nnnMatch = typeof memoId === 'string' ? memoId.match( /^(\d+)-/ ) : null

        if( nnnMatch === null ) {
            return { 'status': false, 'messages': [ 'TRANSCRIPT-HEADER-002: revision type requires a memoId with a numeric prefix (NNN-slug)' ], 'header': null }
        }

        const nnn = nnnMatch[ 1 ]
        const memoName = memoId.replace( /^\d+-/, '' )

        // Soll-Logik (Memo 016 Kap 3): next = max(existing REV) + 1, previous = max(existing REV).
        // The number is NOT derived from the passed-in suffix anymore. maxRevNumber comes from
        // the actual revisions/ bestand (resolved by the caller, see TranscriptRegistry.#maxRevNumber).
        const resolvedMax = TranscriptHeader.#resolveMaxRev( { maxRevNumber, revisionId } )

        if( resolvedMax === null ) {
            return { 'status': false, 'messages': [ 'TRANSCRIPT-HEADER-003: revision type requires a valid maxRevNumber or revisionId' ], 'header': null }
        }

        const prevNum = String( resolvedMax ).padStart( 2, '0' )
        const nextNum = String( resolvedMax + 1 ).padStart( 2, '0' )

        // PRD-009 (Memo 022): die BESPROCHENE Revision ist die hoechste bestehende Revision
        // (== REV-PREV im alten Wording). Sie ist der Leitwert der Ueberschrift und die Bindung
        // (Dateiname = besprochene Revision). REV-NEXT bleibt nur abgeleitete Workflow-Info.
        const header = REVISION_TEMPLATE
            .replaceAll( '{NNN}', nnn )
            .replaceAll( '{Memo-Name}', memoName )
            .replaceAll( '{REV-DISCUSSED}', `REV-${ prevNum }` )
            .replaceAll( '{REV-PREV}', `REV-${ prevNum }` )
            .replaceAll( '{REV-NEXT}', `REV-${ nextNum }` )
            .replaceAll( '{slug}', memoName )

        return { 'status': true, 'messages': [], header, 'contextMode': CONTEXT_MODES[ resolvedType ] }
    }


    // Resolves the highest existing REV number. Prefers the scanned bestand (maxRevNumber);
    // falls back to the suffix ONLY when no bestand was provided, so existing callers keep working.
    static #resolveMaxRev( { maxRevNumber, revisionId } ) {
        if( typeof maxRevNumber === 'number' && Number.isFinite( maxRevNumber ) && maxRevNumber >= 0 ) {
            return maxRevNumber
        }

        if( typeof revisionId === 'string' ) {
            const revMatch = revisionId.match( /^REV-(\d+)$/ )

            if( revMatch !== null ) {
                return parseInt( revMatch[ 1 ], 10 )
            }
        }

        return null
    }


    static detect( { content } ) {
        if( typeof content !== 'string' || content.length === 0 ) {
            return { 'hasHeader': false }
        }

        const firstLine = content.split( '\n' )[ 0 ] || ''
        const hasHeader = HEADER_DETECT_REGEX.test( firstLine )

        return { hasHeader }
    }


    // PRD-007: reconstruct the transcript type from the header's first line on scan.
    // Returns the type value (frei/memo-init/revision/plan-start) or null when no known
    // header line is present (legacy files without a type-specific header).
    static detectType( { content } ) {
        if( typeof content !== 'string' || content.length === 0 ) {
            return { 'type': null }
        }

        const firstLine = content.split( '\n' )[ 0 ] || ''
        const matched = TYPE_VALUES.find( ( value ) => TYPE_FIRST_LINE_REGEX[ value ].test( firstLine ) )

        return { 'type': matched === undefined ? null : matched }
    }


    // Reads the Schema-Version marker. Missing or deviating marker → isLegacy = true (PRD-003).
    static detectSchema( { content } ) {
        if( typeof content !== 'string' || content.length === 0 ) {
            return { 'schemaVersion': null, 'isLegacy': true }
        }

        const match = content.match( SCHEMA_DETECT_REGEX )

        if( match === null ) {
            return { 'schemaVersion': null, 'isLegacy': true }
        }

        const schemaVersion = parseInt( match[ 1 ], 10 )
        const isLegacy = schemaVersion !== SCHEMA_VERSION

        return { schemaVersion, isLegacy }
    }


    // PRD-009 (Memo 022 Kap 10): erkennt das alte "erzeugt-die-naechste"-Bindungsschema.
    // Neues Modell: die Header-Ueberschrift nennt die BESPROCHENE Revision (== "Feedback zu X").
    // Altes Modell: die Ueberschrift nennt die ERZEUGTE Revision (== "→ erzeugt Y").
    // Vergleicht die Ueberschriften-Revision gegen die "Feedback zu X → erzeugt Y"-Zeile:
    //   Ueberschrift == X (besprochen) → legacyBinding false (neu)
    //   Ueberschrift == Y (erzeugt)    → legacyBinding true  (Alt-Schema)
    // KEIN Werfen — der Alt-Bestand (Memo 021/070) bleibt lesbar. Fehlt die Feedback-Zeile oder
    // die Ueberschrift, kann keine Bindung abgeleitet werden → legacyBinding false (kein Alt-Schema
    // nachweisbar), aber detectable false, damit der Aufrufer den Unterschied sieht.
    static detectLegacyBinding( { content } ) {
        if( typeof content !== 'string' || content.length === 0 ) {
            return { 'legacyBinding': false, 'detectable': false, 'headingRevision': null, 'discussedRevision': null, 'createdRevision': null }
        }

        const headingMatch = content.match( /^# Transcript zu Memo \d+ .+? — Revision (REV-\d+)\s*$/m )
        const feedbackMatch = content.match( /Feedback zu (REV-\d+) → erzeugt (REV-\d+)/ )

        if( headingMatch === null || feedbackMatch === null ) {
            return {
                'legacyBinding': false,
                'detectable': false,
                'headingRevision': headingMatch === null ? null : headingMatch[ 1 ],
                'discussedRevision': feedbackMatch === null ? null : feedbackMatch[ 1 ],
                'createdRevision': feedbackMatch === null ? null : feedbackMatch[ 2 ]
            }
        }

        const headingRevision = headingMatch[ 1 ]
        const discussedRevision = feedbackMatch[ 1 ]
        const createdRevision = feedbackMatch[ 2 ]
        const legacyBinding = headingRevision === createdRevision && headingRevision !== discussedRevision

        return { legacyBinding, 'detectable': true, headingRevision, discussedRevision, createdRevision }
    }


    static stripHeader( { content } ) {
        const safeContent = typeof content === 'string' ? content : ''
        const { hasHeader } = TranscriptHeader.detect( { 'content': safeContent } )

        if( !hasHeader ) {
            return { 'body': safeContent }
        }

        const marker = '## Transcript-Inhalt\n\n'
        const markerIndex = safeContent.indexOf( marker )

        if( markerIndex === -1 ) {
            return { 'body': safeContent }
        }

        const body = safeContent.slice( markerIndex + marker.length )

        return { body }
    }


    static wrap( { content, type, memoId, revisionId, maxRevNumber } ) {
        const safeContent = typeof content === 'string' ? content : ''
        const { hasHeader } = TranscriptHeader.detect( { 'content': safeContent } )

        if( hasHeader ) {
            return { 'status': true, 'messages': [], 'wrappedContent': safeContent }
        }

        const { status, messages, header } = TranscriptHeader.build( { type, memoId, revisionId, maxRevNumber } )

        if( !status ) {
            return { status, messages, 'wrappedContent': null }
        }

        const wrappedContent = `${ header }${ safeContent }`

        return { 'status': true, 'messages': [], wrappedContent }
    }
}


export { TranscriptHeader, TYPE_TEMPLATES, REVISION_TEMPLATE, HEADER_DETECT_REGEX, SCHEMA_VERSION, TRANSCRIPT_TYPES, TYPE_VALUES, CONTEXT_MODES }
