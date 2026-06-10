import { describe, it, expect } from '@jest/globals'

import { TranscriptHeader, TYPE_VALUES, CONTEXT_MODES, SCHEMA_VERSION } from '../../src/TranscriptHeader.mjs'


describe( 'TranscriptHeader — 4-Typen-Datenmodell (PRD-001)', () => {
    it( 'exposes exactly the four type values', () => {
        expect( TYPE_VALUES ).toEqual( [ 'frei', 'memo-init', 'revision', 'plan-start' ] )
    } )


    it( 'frei: header carries the Input-Processing notice and no number/revision', () => {
        const { status, header } = TranscriptHeader.build( { type: 'frei' } )

        expect( status ).toBe( true )
        expect( header ).toContain( 'Input-Processing — aber KEINE Revision/Memo' )
        expect( header ).not.toContain( '# Transcript zu Memo' )
        expect( header ).not.toMatch( /Revision REV-\d+/ )
        expect( header ).not.toContain( 'Vorherige Revision' )
    } )


    it( 'memo-init: no memo number, no revision fields, no storage path', () => {
        const { status, header } = TranscriptHeader.build( { type: 'memo-init', memoId: '016-feature', revisionId: 'REV-05' } )

        expect( status ).toBe( true )
        expect( header ).toContain( '# Transcript fuer neues Memo (memo-init)' )
        expect( header ).not.toMatch( /REV-\d+/ )
        expect( header ).not.toContain( 'Memo-Pfad:' )
        expect( header ).not.toContain( 'Vorherige Revision' )
    } )


    it( 'plan-start: no number/revision/path, plan-creation workflow', () => {
        const { status, header } = TranscriptHeader.build( { type: 'plan-start' } )

        expect( status ).toBe( true )
        expect( header ).toContain( '# Transcript fuer Plan-Start (plan-start)' )
        expect( header ).toContain( 'memo-plan-init' )
        expect( header ).not.toMatch( /REV-\d+/ )
        expect( header ).not.toContain( 'Memo-Pfad:' )
    } )


    it( 'revision: headline names the DISCUSSED revision (PRD-009), not the created one', () => {
        const { status, header } = TranscriptHeader.build( { type: 'revision', memoId: '016-feature', maxRevNumber: 2 } )

        expect( status ).toBe( true )
        // PRD-009: headline = besprochene Revision (== max existing = REV-02), not REV-03.
        expect( header ).toContain( '# Transcript zu Memo 016 feature — Revision REV-02' )
        expect( header ).not.toContain( '— Revision REV-03' )
        expect( header ).toContain( 'Memo-Pfad:' )
    } )


    it( 'unknown type returns status false', () => {
        const { status, messages, header } = TranscriptHeader.build( { type: 'bogus' } )

        expect( status ).toBe( false )
        expect( header ).toBe( null )
        expect( messages[ 0 ] ).toContain( 'TRANSCRIPT-HEADER-001' )
    } )


    it( 'default type (none given) is frei, never an invented memo number', () => {
        const { status, header } = TranscriptHeader.build( {} )

        expect( status ).toBe( true )
        expect( header ).toContain( '# Transcript (frei / undefiniert)' )
        expect( header ).not.toContain( '000' )
    } )
} )


describe( 'TranscriptHeader — Kontext-Modus pro Typ (PRD-001)', () => {
    it( 'frei and revision are im-thread', () => {
        expect( CONTEXT_MODES[ 'frei' ] ).toBe( 'im-thread' )
        expect( CONTEXT_MODES[ 'revision' ] ).toBe( 'im-thread' )

        const frei = TranscriptHeader.build( { type: 'frei' } )
        const revision = TranscriptHeader.build( { type: 'revision', memoId: '016-x', maxRevNumber: 1 } )

        expect( frei[ 'contextMode' ] ).toBe( 'im-thread' )
        expect( revision[ 'contextMode' ] ).toBe( 'im-thread' )
    } )


    it( 'memo-init and plan-start are leerer-kontext', () => {
        expect( CONTEXT_MODES[ 'memo-init' ] ).toBe( 'leerer-kontext' )
        expect( CONTEXT_MODES[ 'plan-start' ] ).toBe( 'leerer-kontext' )

        const memoInit = TranscriptHeader.build( { type: 'memo-init' } )
        const planStart = TranscriptHeader.build( { type: 'plan-start' } )

        expect( memoInit[ 'contextMode' ] ).toBe( 'leerer-kontext' )
        expect( planStart[ 'contextMode' ] ).toBe( 'leerer-kontext' )
    } )
} )


describe( 'TranscriptHeader — Nummern-Logik next=max+1 (PRD-002)', () => {
    it( 'computes next = max+1 and previous = max from the bestand', () => {
        const { header } = TranscriptHeader.build( { type: 'revision', memoId: '016-feature', maxRevNumber: 4 } )

        expect( header ).toContain( 'Feedback zu REV-04 → erzeugt REV-05' )
        expect( header ).toContain( 'Vorherige Revision: `REV-04.md`' )
        expect( header ).toContain( 'Naechste Revision (zu erstellen): `REV-05.md`' )
    } )


    it( 'off-by-one regression: highest existing REV-05 → next REV-06 (not REV-07)', () => {
        const { header } = TranscriptHeader.build( { type: 'revision', memoId: '016-feature', maxRevNumber: 5 } )

        expect( header ).toContain( 'Feedback zu REV-05 → erzeugt REV-06' )
        expect( header ).not.toContain( 'REV-07' )
    } )


    it( 'does NOT derive the number blindly from the suffix when a bestand is present', () => {
        // Suffix says REV-02, but the real bestand max is 5 → next must follow the bestand.
        const { header } = TranscriptHeader.build( { type: 'revision', memoId: '016-feature', revisionId: 'REV-02', maxRevNumber: 5 } )

        expect( header ).toContain( 'erzeugt REV-06' )
        expect( header ).not.toContain( 'REV-03' )
    } )


    it( 'no 000 fallback: a memoId without numeric prefix errors instead of rendering 000', () => {
        const { status, messages, header } = TranscriptHeader.build( { type: 'revision', memoId: 'feature-without-number', maxRevNumber: 1 } )

        expect( status ).toBe( false )
        expect( header ).toBe( null )
        expect( messages[ 0 ] ).toContain( 'TRANSCRIPT-HEADER-002' )
    } )
} )


describe( 'TranscriptHeader — Versions-Marker + Legacy-Detection (PRD-003)', () => {
    it( 'SCHEMA_VERSION is 2', () => {
        expect( SCHEMA_VERSION ).toBe( 2 )
    } )


    it( 'every type-header carries the Schema-Version marker', () => {
        const types = [
            TranscriptHeader.build( { type: 'frei' } ),
            TranscriptHeader.build( { type: 'memo-init' } ),
            TranscriptHeader.build( { type: 'plan-start' } ),
            TranscriptHeader.build( { type: 'revision', memoId: '016-x', maxRevNumber: 1 } )
        ]

        types.forEach( ( result ) => {
            expect( result[ 'header' ] ).toContain( 'Schema-Version: 2' )
        } )
    } )


    it( 'detectSchema: marker 2 → isLegacy false', () => {
        const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: '# X\n\nSchema-Version: 2\n\nbody' } )

        expect( schemaVersion ).toBe( 2 )
        expect( isLegacy ).toBe( false )
    } )


    it( 'detectSchema: missing marker → isLegacy true', () => {
        const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: '# Old transcript\n\nbody without marker' } )

        expect( schemaVersion ).toBe( null )
        expect( isLegacy ).toBe( true )
    } )


    it( 'detectSchema: deviating marker (1) → isLegacy true', () => {
        const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: 'Schema-Version: 1\n\nbody' } )

        expect( schemaVersion ).toBe( 1 )
        expect( isLegacy ).toBe( true )
    } )
} )


describe( 'TranscriptHeader — wrap (Objekt-Return + Header-Vertrag)', () => {
    it( 'wrap returns wrappedContent with header prepended for a revision', () => {
        const { status, wrappedContent } = TranscriptHeader.wrap( { content: 'my body', type: 'revision', memoId: '016-feature', maxRevNumber: 1 } )

        expect( status ).toBe( true )
        expect( wrappedContent ).toContain( '# Transcript zu Memo 016 feature' )
        expect( wrappedContent ).toContain( 'my body' )
    } )


    it( 'wrap passes through content that already has a header', () => {
        const existing = '# Transcript zu Memo 016 feature — Revision REV-02\n\nbody'
        const { status, wrappedContent } = TranscriptHeader.wrap( { content: existing, type: 'revision', memoId: '016-feature', maxRevNumber: 1 } )

        expect( status ).toBe( true )
        expect( wrappedContent ).toBe( existing )
    } )


    it( 'wrap propagates a build error for an invalid revision request', () => {
        const { status, messages, wrappedContent } = TranscriptHeader.wrap( { content: 'body', type: 'revision', memoId: 'no-number', maxRevNumber: 1 } )

        expect( status ).toBe( false )
        expect( wrappedContent ).toBe( null )
        expect( messages[ 0 ] ).toContain( 'TRANSCRIPT-HEADER-002' )
    } )
} )


describe( 'TranscriptHeader — detectType (PRD-007)', () => {
    it( 'detects the frei type from its header first line', () => {
        const { header } = TranscriptHeader.build( { type: 'frei' } )
        const { type } = TranscriptHeader.detectType( { content: header } )

        expect( type ).toBe( 'frei' )
    } )


    it( 'detects the memo-init type from its header first line', () => {
        const { header } = TranscriptHeader.build( { type: 'memo-init' } )
        const { type } = TranscriptHeader.detectType( { content: header } )

        expect( type ).toBe( 'memo-init' )
    } )


    it( 'detects the plan-start type from its header first line', () => {
        const { header } = TranscriptHeader.build( { type: 'plan-start' } )
        const { type } = TranscriptHeader.detectType( { content: header } )

        expect( type ).toBe( 'plan-start' )
    } )


    it( 'detects the revision type from its header first line', () => {
        const { header } = TranscriptHeader.build( { type: 'revision', memoId: '016-feature', maxRevNumber: 1 } )
        const { type } = TranscriptHeader.detectType( { content: header } )

        expect( type ).toBe( 'revision' )
    } )


    it( 'returns null type for content without a known header line', () => {
        const { type } = TranscriptHeader.detectType( { content: 'just some text\nno header' } )

        expect( type ).toBe( null )
    } )


    it( 'returns null type for empty content', () => {
        const { type } = TranscriptHeader.detectType( { content: '' } )

        expect( type ).toBe( null )
    } )
} )


describe( 'TranscriptHeader.buildPlanStartPrompt — Plan-Start Anbindung (PRD-042)', () => {
    it( 'names both skills memo-plan-init and memo-plan-add', () => {
        const { status, prompt } = TranscriptHeader.buildPlanStartPrompt( { memoPaths: [ '/abs/.memo/memos/016-x/revisions' ] } )

        expect( status ).toBe( true )
        expect( prompt ).toContain( 'memo-plan-init' )
        expect( prompt ).toContain( 'memo-plan-add' )
    } )


    it( 'includes every selected absolute memo path (multi-select)', () => {
        const a = '/Users/x/WORKBENCH/ressources/.memo/memos/016-x/revisions'
        const b = '/Users/x/WORKBENCH/ressources/.memo/memos/017-y/revisions'
        const { status, prompt, memoPaths } = TranscriptHeader.buildPlanStartPrompt( { memoPaths: [ a, b ] } )

        expect( status ).toBe( true )
        expect( prompt ).toContain( a )
        expect( prompt ).toContain( b )
        expect( memoPaths ).toEqual( [ a, b ] )
    } )


    it( 'distinguishes new plan vs existing plan triggers', () => {
        const { prompt } = TranscriptHeader.buildPlanStartPrompt( { memoPaths: [ '/abs/m' ] } )

        expect( prompt ).toContain( 'memo-plan-init {slug}' )
        expect( prompt ).toContain( 'memo-plan-add {plan-id} {memo-path}' )
    } )


    it( 'contains no plan number, no .memo/plans/ target, no revision field', () => {
        const { prompt } = TranscriptHeader.buildPlanStartPrompt( { memoPaths: [ '/abs/.memo/memos/016-x/revisions' ] } )

        expect( prompt ).not.toMatch( /PLAN-\d+/ )
        expect( prompt ).not.toContain( '.memo/plans/' )
        expect( prompt ).not.toMatch( /REV-\d+/ )
        expect( prompt ).not.toContain( 'Memo-Pfad:' )
    } )


    it( 'keeps the leerer-kontext context mode', () => {
        const { contextMode } = TranscriptHeader.buildPlanStartPrompt( { memoPaths: [ '/abs/m' ] } )

        expect( contextMode ).toBe( 'leerer-kontext' )
    } )


    it( 'returns status false with error code when no path is given', () => {
        const { status, messages, prompt } = TranscriptHeader.buildPlanStartPrompt( { memoPaths: [] } )

        expect( status ).toBe( false )
        expect( prompt ).toBe( null )
        expect( messages[ 0 ] ).toContain( 'TRANSCRIPT-HEADER-004' )
    } )


    it( 'filters out empty/non-string path entries', () => {
        const { status, memoPaths } = TranscriptHeader.buildPlanStartPrompt( { memoPaths: [ '/abs/a', '', null, '/abs/b' ] } )

        expect( status ).toBe( true )
        expect( memoPaths ).toEqual( [ '/abs/a', '/abs/b' ] )
    } )
} )


describe( 'TranscriptHeader — neues Bindungsmodell im REVISION_TEMPLATE (PRD-009)', () => {
    it( 'headline names the discussed revision, "erzeugt" stays as derived workflow info', () => {
        const { header } = TranscriptHeader.build( { type: 'revision', memoId: '022-binding', maxRevNumber: 4 } )

        // Ueberschrift = besprochene Revision (REV-04), nicht die erzeugte (REV-05).
        expect( header ).toContain( '# Transcript zu Memo 022 binding — Revision REV-04' )
        // "erzeugt"-Zeile bleibt, ist aber als abgeleitete Info markiert (kein Bindungsschluessel).
        expect( header ).toContain( 'Abgeleitete Workflow-Info (KEIN Bindungsschluessel): Feedback zu REV-04 → erzeugt REV-05' )
        expect( header ).toContain( 'Besprochene Revision (Bindung): `REV-04`' )
    } )
} )


describe( 'TranscriptHeader.detectLegacyBinding (PRD-009)', () => {
    const legacy021 = [
        '# Transcript zu Memo 021 viewer-feinschliff-config — Revision REV-02',
        '',
        'Schema-Version: 2',
        '',
        'Feedback zu REV-01 → erzeugt REV-02',
        ''
    ].join( '\n' )

    const legacy070 = [
        '# Transcript zu Memo 070 production-readiness-eval-system — Revision REV-02',
        '',
        'Schema-Version: 2',
        '',
        'Feedback zu REV-01 → erzeugt REV-02',
        ''
    ].join( '\n' )


    it( 'old schema (021): headline names the CREATED revision → legacyBinding true, no throw', () => {
        const { legacyBinding, detectable, headingRevision, discussedRevision, createdRevision } = TranscriptHeader.detectLegacyBinding( { content: legacy021 } )

        expect( legacyBinding ).toBe( true )
        expect( detectable ).toBe( true )
        expect( headingRevision ).toBe( 'REV-02' )
        expect( discussedRevision ).toBe( 'REV-01' )
        expect( createdRevision ).toBe( 'REV-02' )
    } )


    it( 'mixed state (070): filename new, header old → legacyBinding true', () => {
        const { legacyBinding } = TranscriptHeader.detectLegacyBinding( { content: legacy070 } )

        expect( legacyBinding ).toBe( true )
    } )


    it( 'new schema header (build output) → legacyBinding false', () => {
        const { header } = TranscriptHeader.build( { type: 'revision', memoId: '022-binding', maxRevNumber: 3 } )
        const { legacyBinding, detectable, headingRevision, discussedRevision } = TranscriptHeader.detectLegacyBinding( { content: header } )

        expect( legacyBinding ).toBe( false )
        expect( detectable ).toBe( true )
        // Ueberschrift == besprochene Revision == Feedback-Gruppe-1.
        expect( headingRevision ).toBe( 'REV-03' )
        expect( discussedRevision ).toBe( 'REV-03' )
    } )


    it( 'no feedback line → not detectable, legacyBinding false, no throw', () => {
        const { legacyBinding, detectable } = TranscriptHeader.detectLegacyBinding( { content: '# Transcript zu Memo 099 x — Revision REV-01\n\nbody' } )

        expect( legacyBinding ).toBe( false )
        expect( detectable ).toBe( false )
    } )


    it( 'empty content → legacyBinding false, no throw', () => {
        const result = TranscriptHeader.detectLegacyBinding( { content: '' } )

        expect( result[ 'legacyBinding' ] ).toBe( false )
        expect( result[ 'detectable' ] ).toBe( false )
    } )
} )


describe( 'TranscriptHeader — Header-Vertrag-Sync Round-Trip (PRD-009)', () => {
    // Mirrors the memo-input-processing parser regex (SKILL.md Abschnitt 2). A build() output
    // must parse back to the same discussed revision the headline names.
    const TYPE_REVISION_REGEX = /^# Transcript zu Memo (\d+) (.+?) — Revision (REV-\d+)$/
    const FEEDBACK_REGEX = /Feedback zu (REV-\d+) → erzeugt (REV-\d+)/


    it( 'build → parse yields the correct discussed revision (new model)', () => {
        const { header } = TranscriptHeader.build( { type: 'revision', memoId: '022-binding', maxRevNumber: 4 } )

        const firstLine = header.split( '\n' )[ 0 ]
        const headMatch = firstLine.match( TYPE_REVISION_REGEX )
        const feedbackMatch = header.match( FEEDBACK_REGEX )

        expect( headMatch ).not.toBe( null )
        expect( feedbackMatch ).not.toBe( null )

        const headingRevision = headMatch[ 3 ]
        const legacyBinding = headingRevision === feedbackMatch[ 2 ] && headingRevision !== feedbackMatch[ 1 ]
        const discussedRevision = legacyBinding ? feedbackMatch[ 1 ] : headingRevision

        expect( legacyBinding ).toBe( false )
        expect( discussedRevision ).toBe( 'REV-04' )
        expect( headMatch[ 1 ] ).toBe( '022' )
        expect( headMatch[ 2 ] ).toBe( 'binding' )
    } )
} )
