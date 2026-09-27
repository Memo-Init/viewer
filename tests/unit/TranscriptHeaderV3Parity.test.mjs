import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { TranscriptHeader, TYPE_TEMPLATES, REVISION_TEMPLATE, SCHEMA_VERSION, TYPE_VALUES } from '../../src/TranscriptHeader.mjs'


// Memo 079 PRD-30 (F19=A / WI-047) — Header-V3 parity gate + round-trips.
//
// The transcript-header templates live in TWO places on purpose: the runtime constants in the viewer
// (TranscriptHeader.mjs) and the authoring source in repos/core
// (templates/transcript-header-prompt.config.mjs), which `memo prompt compose` renders to the
// deterministic <id>.md artifacts checked in under tests/fixtures/transcript-header-v3/. Since the two
// repos cannot import across their boundary, the Single-Source is enforced by THIS test: it FAILS the
// moment TranscriptHeader.mjs diverges from the composed artifacts, so the two can never silently drift.
//
// Regenerate the fixtures after any header-body change:
//   (repos/core)  node cli/bin/memo.mjs prompt compose \
//                     --config templates/transcript-header-prompt.config.mjs --out <tmp>
//   then copy <tmp>/{memo-init,revision,frei,rollout}.md into this fixture dir and refresh
//   manifest.json's promptHash/promptLength (relative configPath, no timestamp).
//
// Memo 082 PRD-16 (WI-186, Kap 30a/30b) — rollout joins the gate. It was the ONE of the four types
// hanging in no parity gate at all, so the most consequential flow was the only one able to drift
// unnoticed (30a, E5). The coverage is therefore asserted against TYPE_VALUES, not against a literal
// count: when the type set grows, the assertion stays right instead of silently staying green.

const here = dirname( fileURLToPath( import.meta.url ) )
const fixtureDir = resolve( here, '../fixtures/transcript-header-v3' )

const readFixture = ( { name } ) => readFileSync( resolve( fixtureDir, name ), 'utf-8' )
const sha256 = ( { text } ) => createHash( 'sha256' ).update( text, 'utf8' ).digest( 'hex' )

const manifest = JSON.parse( readFixture( { name: 'manifest.json' } ) )

// The governed transcript types, in the config's own order (plan-start was removed end to end in
// Memo 079 M1 because REV-03 Kap 1 abolished the memo-plan concept).
const COMPOSED_TYPES = [ 'memo-init', 'revision', 'frei', 'rollout' ]


describe( 'Header-V3 parity gate — TranscriptHeader.mjs vs composed artifacts (WI-047)', () => {
    it( 'composes exactly the governed types (no missing/extra, plan-start excluded)', () => {
        const manifestIds = manifest.units.map( ( unit ) => unit.id )

        expect( manifestIds ).toEqual( COMPOSED_TYPES )
    } )


    it( 'every type in TYPE_VALUES is parity-covered (WI-186: the set, never the number 4)', () => {
        // The comparison set is TYPE_VALUES itself — a coverage claim measured against a literal
        // count goes silently stale the moment a fifth type is added.
        const uncovered = TYPE_VALUES.filter( ( type ) => !COMPOSED_TYPES.includes( type ) )

        expect( TYPE_VALUES.length ).toBeGreaterThan( 0 )
        expect( uncovered ).toEqual( [] )
        expect( [ ...COMPOSED_TYPES ].sort() ).toEqual( [ ...TYPE_VALUES ].sort() )
    } )


    COMPOSED_TYPES.forEach( ( type ) => {
        it( `TYPE_TEMPLATES['${ type }'] is byte-identical to the composed ${ type }.md artifact`, () => {
            const composed = readFixture( { name: `${ type }.md` } )

            // The core anti-drift assertion: the runtime template equals the composed artifact.
            expect( TYPE_TEMPLATES[ type ] ).toBe( composed )
        } )


        it( `the ${ type }.md fixture is a genuine compose output (sha256 matches manifest promptHash)`, () => {
            const composed = readFixture( { name: `${ type }.md` } )
            const record = manifest.units.find( ( unit ) => unit.id === type )

            // Guards against a hand-edited fixture that would silently satisfy the parity assertion:
            // the checked-in .md must hash to the prompt hash the compositor recorded.
            expect( record ).toBeDefined()
            expect( sha256( { text: composed } ) ).toBe( record.promptHash )
            expect( composed.length ).toBe( record.promptLength )
        } )
    } )


    it( 'REVISION_TEMPLATE (the raw constant with runtime placeholders) equals the composed revision.md', () => {
        // The composed revision artifact carries the single-brace runtime placeholders verbatim
        // ({NNN}, {REV-DISCUSSED}, ## Antwort auf F{N}); TranscriptHeader substitutes them at write time.
        expect( REVISION_TEMPLATE ).toBe( readFixture( { name: 'revision.md' } ) )
        expect( REVISION_TEMPLATE ).toContain( '{NNN}' )
        expect( REVISION_TEMPLATE ).toContain( '`## Antwort auf F{N}`' )
    } )
} )


describe( 'Header-V3 — the four contract blocks are present where REV-03 Kap 11 puts them', () => {
    it( 'memo-init carries Voll-Read + Daten/Instruktions-Grenze + Fertig-Kriterien (Block 1/2/4)', () => {
        const { status, header } = TranscriptHeader.build( { type: 'memo-init' } )

        expect( status ).toBe( true )
        expect( header ).toContain( '**Voll-Read-Pflicht:**' )
        expect( header ).toContain( '**Daten/Instruktions-Grenze:**' )
        expect( header ).toContain( 'Fertig-Kriterien (alle Pflicht' )
        // memo-init predates the memo — no revision-binding fields, no Antwort-Bindung.
        expect( header ).not.toContain( '**Antwort-Bindung' )
        expect( header ).not.toContain( 'Memo-Pfad:' )
    } )


    it( 'revision carries Voll-Read + Daten/Instruktions-Grenze + Antwort-Bindung incl. Terminal (Block 1/2/3)', () => {
        const { status, header } = TranscriptHeader.build( { type: 'revision', memoId: '079-x', maxRevNumber: 2 } )

        expect( status ).toBe( true )
        expect( header ).toContain( '**Voll-Read-Pflicht:**' )
        expect( header ).toContain( 'INKLUSIVE der\n`## Antwort auf F{N}`-Bloecke' )
        expect( header ).toContain( '**Daten/Instruktions-Grenze:**' )
        expect( header ).toContain( '**Antwort-Bindung (Pflicht):**' )
        expect( header ).toContain( 'Auch TERMINAL-Antworten binden' )
        expect( header ).toContain( 'Karteileichen-Verbot' )
    } )


    it( 'the Antwort-Bindung block binds against the discussed/next revision after substitution', () => {
        const { header } = TranscriptHeader.build( { type: 'revision', memoId: '079-x', maxRevNumber: 2 } )

        // {REV-DISCUSSED}/{REV-NEXT} are substituted; no unsubstituted brace token survives in the block.
        expect( header ).toContain( 'beantwortet eine offene Frage aus REV-02' )
        expect( header ).toContain( 'In REV-03 wird jede beantwortete Frage' )
        expect( header ).not.toContain( '{REV-DISCUSSED}' )
        expect( header ).not.toContain( '{REV-NEXT}' )
    } )
} )


describe( 'Memo 082 PRD-16 (WI-186) — the type-specific transfer onto memo-init, rollout and frei', () => {
    it( 'memo-init names BOTH mandatory precondition edges (E1: memo-init-project-sop was silent)', () => {
        const { header } = TranscriptHeader.build( { type: 'memo-init' } )
        const edges = [ 'memo-sop', 'memo-init-project-sop' ]
        const missing = edges.filter( ( edge ) => !header.includes( `\`${ edge }\`` ) )

        expect( edges.length ).toBe( 2 )
        expect( missing ).toEqual( [] )
        expect( header ).toContain( '**Voraussetzungs-Kette:**' )
    } )


    it( 'memo-init carries the author role line, before the first obligation', () => {
        const { header } = TranscriptHeader.build( { type: 'memo-init' } )

        expect( header ).toContain( '**Deine Rolle in diesem Auftrag: Autor** (`author`)' )
        // Position, not mere presence: the role must precede the first duty of the header.
        expect( header.indexOf( 'Deine Rolle in diesem Auftrag' ) ).toBeLessThan( header.indexOf( '**Voll-Read-Pflicht:**' ) )
    } )


    it( 'rollout carries the orchestrator role line and the data/instruction boundary (E5)', () => {
        const { header } = TranscriptHeader.build( { type: 'rollout' } )

        expect( header ).toContain( '**Deine Rolle in diesem Auftrag: Orchestrator** (`orchestrator`)' )
        expect( header ).toContain( '**Daten/Instruktions-Grenze:**' )
        // The Abgrenzung is the useful half — the line must also say what the role is NOT.
        expect( header ).toContain( 'Du schreibst kein Memo (Autor) und du planst keine Phasen' )
    } )


    it( 'frei carries the boundary (E4) but deliberately NO role line — it starts no workflow', () => {
        const { header } = TranscriptHeader.build( { type: 'frei' } )

        expect( header ).toContain( '**Daten/Instruktions-Grenze:**' )
        // 30b: a role on `frei` would be a claim, so its absence is a decision, not an omission.
        expect( header ).not.toContain( 'Deine Rolle in diesem Auftrag' )
    } )


    it( 'both boundary-carrying types are covered, and the role line is on exactly the right ones', () => {
        const withBoundary = [ 'frei', 'rollout' ]
            .filter( ( type ) => TranscriptHeader.build( { type } ).header.includes( '**Daten/Instruktions-Grenze:**' ) )
        const withRole = TYPE_VALUES
            .filter( ( type ) => {
                const built = type === 'revision'
                    ? TranscriptHeader.build( { type, memoId: '082-x', maxRevNumber: 1 } )
                    : TranscriptHeader.build( { type } )

                return built.header.includes( 'Deine Rolle in diesem Auftrag' )
            } )

        expect( withBoundary ).toEqual( [ 'frei', 'rollout' ] )
        expect( withRole.sort() ).toEqual( [ 'memo-init', 'revision', 'rollout' ] )
    } )
} )


describe( 'Header-V3 — SCHEMA_VERSION 3 round-trips (parse → 3, isLegacy false)', () => {
    it( 'SCHEMA_VERSION is 3', () => {
        expect( SCHEMA_VERSION ).toBe( 3 )
    } )


    it( 'every governed type-header carries the Schema-Version: 3 marker', () => {
        const headers = [
            TranscriptHeader.build( { type: 'memo-init' } ),
            TranscriptHeader.build( { type: 'frei' } ),
            TranscriptHeader.build( { type: 'rollout' } ),
            TranscriptHeader.build( { type: 'revision', memoId: '079-x', maxRevNumber: 1 } )
        ]

        headers.forEach( ( result ) => {
            expect( result.header ).toContain( 'Schema-Version: 3' )
        } )
    } )


    it( 'a V3 revision header round-trips through detectSchema → { schemaVersion: 3, isLegacy: false }', () => {
        const { header } = TranscriptHeader.build( { type: 'revision', memoId: '079-x', maxRevNumber: 4 } )
        const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: header } )

        expect( schemaVersion ).toBe( 3 )
        expect( isLegacy ).toBe( false )
    } )


    it( 'a V3 memo-init header round-trips → { schemaVersion: 3, isLegacy: false } and detectType memo-init', () => {
        const { header } = TranscriptHeader.build( { type: 'memo-init' } )
        const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: header } )
        const { type } = TranscriptHeader.detectType( { content: header } )

        expect( schemaVersion ).toBe( 3 )
        expect( isLegacy ).toBe( false )
        expect( type ).toBe( 'memo-init' )
    } )
} )


describe( 'Header-V3 — V2 stays legacy-but-readable (no crash, not rejected)', () => {
    // A real V2 revision transcript from the bestand (Schema-Version: 2, pre-079 body).
    const v2Header = [
        '# Transcript zu Memo 021 viewer-feinschliff-config — Revision REV-02',
        '',
        'Schema-Version: 2',
        '',
        '**Dieser Transcript darf NICHT direkt in eine Revision uebernommen werden.**',
        '',
        'Feedback zu REV-01 → erzeugt REV-02',
        '',
        '---',
        '',
        '## Transcript-Inhalt',
        '',
        'body'
    ].join( '\n' )


    it( 'detectSchema: a V2 marker under V3 → { schemaVersion: 2, isLegacy: true } (legacy, not rejected)', () => {
        const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: v2Header } )

        expect( schemaVersion ).toBe( 2 )
        expect( isLegacy ).toBe( true )
    } )


    it( 'a V2 header still parses without throwing (detect + detectType + stripHeader work)', () => {
        expect( () => TranscriptHeader.detectSchema( { content: v2Header } ) ).not.toThrow()

        const { hasHeader } = TranscriptHeader.detect( { content: v2Header } )
        const { type } = TranscriptHeader.detectType( { content: v2Header } )
        const { body } = TranscriptHeader.stripHeader( { content: v2Header } )

        expect( hasHeader ).toBe( true )
        expect( type ).toBe( 'revision' )
        expect( body ).toBe( 'body' )
    } )


    it( 'a V2 legacy binding is still detectable (bestand stays readable)', () => {
        const { legacyBinding, detectable } = TranscriptHeader.detectLegacyBinding( { content: v2Header } )

        expect( detectable ).toBe( true )
        expect( legacyBinding ).toBe( true )
    } )
} )
