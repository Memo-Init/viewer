import { describe, it, expect } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveSiblingFile, siblingFilePath, mainRepoRoot, assertSiblingResolved, siblingOriginLine } from '../helpers/siblingRepo.mjs'
import { DoltDbAssembler } from '../../src/DoltDbAssembler.mjs'


// Memo 082, M082-09-08 (WI-122) — the provenance line of `#answeredEntry`, and the twin it shares with
// RevisionAssembler (core).
//
// WHAT THE LINE IS FOR. A merely CONFIRMED recommendation used to stand in the decision record as an
// independent decision beside the recommendation it agrees with, and the mental-model walk reads exactly
// that pair (`AI-Empfehlung war` vs `User-Entscheidung`) — so the record taught that the user is always
// of one mind with the AI, and every confirmed recommendation made the next one bolder. The fourth state
// is the one that is easy to miss: a block written before the ` [Vorauswahl]` mark carries NO provenance,
// and an absent mark is not a measured "chose it freely". THE ZERO MEANS NOT MEASURED, NOT NOT HAPPENED.
//
// TWO LAYERS, because one of them can be absent:
//   (1) the EXPECTATION TABLE below is repo-local and always runs. The core repo carries the IDENTICAL
//       table in cli/test/AnsweredEntryTwinParity.test.mjs, so a change on either side turns THAT side's
//       own suite red even where the sibling repo is not checked out (CI checks one repo out alone).
//   (2) the cross-repo case here compares the two SOURCES member by member; the core suite compares the
//       two OUTPUTS character for character by importing this renderer. Two different failure modes,
//       one on each side of the boundary — a twin that drifts is red whichever half a reader runs.
//
// The cross-repo case reaches outside this repository. It is SKIPPED only where the boundary does not
// exist at all (a lone checkout — CI checks each repo out alone) and is RED for every path-related
// absence, and every number states the basis it was measured over.
const HERE = dirname( fileURLToPath( import.meta.url ) )
const VIEWER_ROOT = resolve( HERE, '..', '..' )
const TWIN_SEGMENTS = [ 'cli', 'src', 'RevisionAssembler.mjs' ]


// WHICH core this compares against — derived ONCE for the whole boundary in tests/helpers/siblingRepo.mjs
// (one rule, shared with BlockSectionsParityPRDB1 and IdRecognitionPRD40). The former rule read the NAME
// of the directory this suite runs in; when the rollout moved its worktrees and that name lost its
// prefix, the candidate collapsed to a neighbour that did not exist and 22 cases were skipped under a
// green suite. `git rev-parse --git-common-dir` answers with the MAIN repository from every worktree, so
// the name of the tree carries no weight any more.
const TWIN = resolveSiblingFile( { from: VIEWER_ROOT, repo: 'core', segments: TWIN_SEGMENTS } )
const CORE_TWIN = TWIN.path

// `it.skip` stays for exactly ONE absence — the one that breaks no path: a checkout standing outside a
// multi-repo tree, where this boundary does not exist. A derivation that fails, an absent sibling repo
// and an absent twin file are all RED, with the resolved path in the message, so "broken twin" and
// "broken path" never again look the same.
const withCore = TWIN.kind === 'standalone' ? it.skip : it


// ── The shared stock — IDENTICAL to the table in the core suite ─────────────────────────────────────
const QUESTION_OPTIONS = [
    { question_id: 'F1', opt_key: 'A', label: 'Drei Schichten' },
    { question_id: 'F1', opt_key: 'B', label: 'Der eigene Weg' },
    { question_id: 'F2', opt_key: 'A', label: 'Die KI-Empfehlung' },
    { question_id: 'F3', opt_key: 'A', label: 'Die KI-Empfehlung' },
    { question_id: 'F4', opt_key: 'B', label: 'Zweiter Weg' },
    { question_id: 'F6', opt_key: 'A', label: 'Irgendetwas' },
    { question_id: 'F8', opt_key: 'A', label: 'Die KI-Empfehlung' }
]


const INPUTS = [
    {
        name: 'chosen-diverging — actively chosen and NOT the recommendation',
        row: { id: 'F1', text: 'Wie viele Schichten?', title: 'Schichten', ai_recommendation: 'A — drei Schichten' },
        answers: [ { question_id: 'F1', input_id: 10, option_key: 'B', answer_verbatim: null, preselected: 0 } ],
        expected: '- **Entscheidungsweg:** eigenstaendige Entscheidung — weicht von der AI-Empfehlung ab'
    },
    {
        name: 'chosen-matching — actively chosen and the SAME as the recommendation',
        row: { id: 'F2', text: 'Uebernehmen?', title: 'Uebernahme', ai_recommendation: 'A' },
        answers: [ { question_id: 'F2', input_id: 11, option_key: 'A', answer_verbatim: null, preselected: 0 } ],
        expected: '- **Entscheidungsweg:** eigenstaendige Entscheidung — stimmt mit der AI-Empfehlung ueberein'
    },
    {
        name: 'preselection-confirmed — the recommendation was CONFIRMED, not chosen',
        row: { id: 'F3', text: 'Bestaetigen?', title: 'Bestaetigung', ai_recommendation: 'A' },
        answers: [ { question_id: 'F3', input_id: 12, option_key: 'A', answer_verbatim: null, preselected: 1 } ],
        expected: '- **Entscheidungsweg:** bestaetigte Vorauswahl — die AI-Empfehlung wurde bestaetigt, nicht gewaehlt'
    },
    {
        name: 'not-recorded — the record predates the column, so the provenance was never taken',
        row: { id: 'F4', text: 'Alt-Bestand?', title: 'Altbestand', ai_recommendation: 'B' },
        answers: [ { question_id: 'F4', input_id: 13, option_key: 'B', answer_verbatim: null } ],
        expected: '- **Entscheidungsweg:** nicht erhoben — die Herkunft dieser Entscheidung ist nicht aufgezeichnet'
    },
    {
        name: 'not-recorded — no answer record at all',
        row: { id: 'F5', text: 'Gar nichts?', title: 'Ohne Datensatz', ai_recommendation: 'C' },
        answers: [],
        expected: '- **Entscheidungsweg:** nicht erhoben — die Herkunft dieser Entscheidung ist nicht aufgezeichnet'
    },
    {
        name: 'chosen-diverging — an ABSENT recommendation cannot be repeated',
        row: { id: 'F6', text: 'Ohne Empfehlung?', title: 'Keine Empfehlung' },
        answers: [ { question_id: 'F6', input_id: 14, option_key: 'A', answer_verbatim: null, preselected: 0 } ],
        expected: '- **Entscheidungsweg:** eigenstaendige Entscheidung — weicht von der AI-Empfehlung ab'
    },
    {
        name: 'chosen-matching — free text held against the whole recommendation',
        row: { id: 'F7', text: 'Frei formuliert?', title: 'Freitext', ai_recommendation: 'Uebernehmen' },
        answers: [ { question_id: 'F7', input_id: 15, option_key: null, answer_verbatim: 'Uebernehmen', preselected: 0 } ],
        expected: '- **Entscheidungsweg:** eigenstaendige Entscheidung — stimmt mit der AI-Empfehlung ueberein'
    },
    {
        name: 'preselection-confirmed — full block with Wortlaut, Beantwortet in and Anmerkung',
        row: { id: 'F8', text: 'Voll belegt?', title: 'Voll belegt', ai_recommendation: 'A', answered_in_rev: 'REV-02', note: 'Muendliche Aussage uebersteuert Widget-A' },
        answers: [ { question_id: 'F8', input_id: 16, option_key: 'A', answer_verbatim: 'A — so und nicht anders', preselected: 1 } ],
        expected: '- **Entscheidungsweg:** bestaetigte Vorauswahl — die AI-Empfehlung wurde bestaetigt, nicht gewaehlt'
    }
]


// The ONE block written out in FULL bytes. A `toContain`-style check would pass over a line that drifted
// to the end of the block, and the POSITION is half of what this PRD is about.
const EXPECTED_FULL_BLOCK = [
    '### F8 — Voll belegt',
    '',
    '- **Frage (Original):** Voll belegt?',
    '- **AI-Empfehlung war:** A',
    '- **User-Entscheidung:** A — Die KI-Empfehlung',
    '- **Entscheidungsweg:** bestaetigte Vorauswahl — die AI-Empfehlung wurde bestaetigt, nicht gewaehlt',
    '- **Wortlaut:** A — so und nicht anders',
    '- **Beantwortet in:** REV-02',
    '- **Anmerkung:** Muendliche Aussage uebersteuert Widget-A',
    ''
]


const LEGACY_LABELS = [ 'Frage (Original)', 'AI-Empfehlung war', 'User-Entscheidung', 'Wortlaut', 'Beantwortet in', 'Anmerkung' ]

const PROVENANCE_LABEL = 'Entscheidungsweg'

// The members of the answered family that MUST read identically on both sides, plus the two registers
// the line is built from. Named one by one so a drift reports WHICH member drifted.
const TWIN_MEMBERS = [
    '#renderAnsweredQuestions', '#answeredByOf', 'answeredEntryLines', '#answeredEntry', '#answeredProvenance',
    '#provenanceKindOf', '#preselectionState', '#decisionRepeatsAi', '#answeredContext', '#answeredTitle',
    '#answeredAi', '#latestAnswer', '#answerWins', '#isPreselected', '#answeredDecision', '#answeredWortlaut'
]

const TWIN_CONSTANTS = [ 'ANSWERED_PROVENANCE_KINDS', 'ANSWERED_PROVENANCE_LABEL' ]


const render = ( { input } ) => DoltDbAssembler.answeredEntryLines( {
    row: input.row,
    questionOptions: QUESTION_OPTIONS,
    answers: input.answers
} ).lines


const labelsOf = ( { lines } ) => lines
    .map( ( line ) => ( line.match( /^- \*\*([^*]+):\*\*/ ) ?? [ null, null ] )[ 1 ] )
    .filter( ( label ) => label !== null )


const provenanceLinesOf = ( { lines } ) => lines
    .filter( ( line ) => line.startsWith( `- **${ PROVENANCE_LABEL }:**` ) === true )


// Slice one `static name( … )` member from its declaration to the line that closes it at the same
// indent. The ONE legitimate difference between the twins — the class name the statics qualify with — is
// normalised away; everything else is held character for character.
const memberSource = ( { lines, name } ) => {
    const startIndex = lines.findIndex( ( line ) => line.includes( `static ${ name }(` ) === true )
    if( startIndex === -1 ) {
        return null
    }

    const indent = lines[ startIndex ].length - lines[ startIndex ].trimStart().length
    const closing = ' '.repeat( indent ) + '}'
    const rest = lines.slice( startIndex )
    const offset = rest.findIndex( ( line, index ) => index > 0 && line === closing )

    return lines.slice( startIndex, offset === -1 ? lines.length : startIndex + offset + 1 ).join( '\n' )
}


const constantSource = ( { lines, name } ) => {
    const startIndex = lines.findIndex( ( line ) => line.startsWith( `const ${ name } ` ) === true )
    if( startIndex === -1 ) {
        return null
    }
    if( lines[ startIndex ].trimEnd().endsWith( '[' ) !== true ) {
        return lines[ startIndex ]
    }

    const rest = lines.slice( startIndex )
    const offset = rest.findIndex( ( line, index ) => index > 0 && line === ']' )

    return lines.slice( startIndex, offset === -1 ? lines.length : startIndex + offset + 1 ).join( '\n' )
}


const normalise = ( { text } ) => text
    .split( 'DoltDbAssembler' ).join( '<TWIN>' )
    .split( 'RevisionAssembler' ).join( '<TWIN>' )


describe( 'M082-09-08 — the provenance line, and the twin it is shared with', () => {

    describe( 'AB-1 — four states, four distinguishable lines', () => {

        it( 'renders EXACTLY ONE provenance line per block, in every state', () => {
            const counts = INPUTS
                .map( ( input ) => provenanceLinesOf( { lines: render( { input } ) } ).length )
            expect( counts.length ).toBeGreaterThanOrEqual( 4 )
            expect( counts ).toEqual( INPUTS.map( () => 1 ) )
        } )

        it( `the four states produce four PAIRWISE DIFFERENT lines over ${ INPUTS.length } inputs`, () => {
            const distinct = [ ...new Set( INPUTS.map( ( input ) => provenanceLinesOf( { lines: render( { input } ) } )[ 0 ] ) ) ]
            expect( distinct.length ).toBe( 4 )
        } )

        it( 'each named input renders the line its own state calls for', () => {
            const wrong = INPUTS
                .map( ( input ) => ( { input, actual: provenanceLinesOf( { lines: render( { input } ) } )[ 0 ] } ) )
                .filter( ( entry ) => entry.actual !== entry.input.expected )
                .map( ( entry ) => `${ entry.input.name }: ${ entry.actual }` )
            expect( wrong ).toEqual( [] )
        } )

        it( 'an ABSENT recommendation counts as diverging — the rule is named, not silent', () => {
            const absent = INPUTS
                .filter( ( input ) => input.row.ai_recommendation === undefined )
            expect( absent.length ).toBeGreaterThanOrEqual( 1 )
            expect( provenanceLinesOf( { lines: render( { input: absent[ 0 ] } ) } )[ 0 ] ).toBe( absent[ 0 ].expected )
        } )
    } )


    describe( 'AB-2 — "nicht erhoben" never becomes "eigenstaendig"', () => {

        it( 'an unrecorded provenance says "nicht erhoben", is not empty and never claims independence', () => {
            const unrecorded = INPUTS
                .filter( ( input ) => input.expected.includes( 'nicht erhoben' ) === true )
            expect( unrecorded.length ).toBeGreaterThanOrEqual( 1 )

            const offenders = unrecorded
                .map( ( input ) => provenanceLinesOf( { lines: render( { input } ) } )[ 0 ] )
                .filter( ( line ) => line === undefined || line.includes( 'nicht erhoben' ) !== true || line.includes( 'eigenstaendige Entscheidung' ) === true || line.endsWith( ':**' ) === true )
            expect( offenders ).toEqual( [] )
        } )

        it( 'a STATED zero and an ABSENT column are told apart — only the absent one is "nicht erhoben"', () => {
            const statedZero = INPUTS.find( ( input ) => input.row.id === 'F1' )
            const absentColumn = INPUTS.find( ( input ) => input.row.id === 'F4' )
            expect( provenanceLinesOf( { lines: render( { input: statedZero } ) } )[ 0 ].includes( 'nicht erhoben' ) ).toBe( false )
            expect( provenanceLinesOf( { lines: render( { input: absentColumn } ) } )[ 0 ].includes( 'nicht erhoben' ) ).toBe( true )
        } )
    } )


    describe( 'AB-4 / AB-5 — the field order and the fixed position', () => {

        it( `the line stands directly below User-Entscheidung in all ${ INPUTS.length } inputs`, () => {
            const offenders = INPUTS
                .map( ( input ) => {
                    const labels = labelsOf( { lines: render( { input } ) } )

                    return { name: input.name, decision: labels.indexOf( 'User-Entscheidung' ), provenance: labels.indexOf( PROVENANCE_LABEL ) }
                } )
                .filter( ( entry ) => entry.decision === -1 || entry.provenance !== entry.decision + 1 )
                .map( ( entry ) => `${ entry.name }: decision ${ entry.decision }, provenance ${ entry.provenance }` )
            expect( offenders ).toEqual( [] )
        } )

        it( `the ${ LEGACY_LABELS.length } legacy labels are unchanged, unrenamed and in their legacy order`, () => {
            const labels = labelsOf( { lines: render( { input: INPUTS[ INPUTS.length - 1 ] } ) } )
            expect( LEGACY_LABELS.length ).toBeGreaterThan( 0 )
            expect( labels.filter( ( label ) => label !== PROVENANCE_LABEL ) ).toEqual( LEGACY_LABELS )
        } )

        it( 'the full block matches byte for byte', () => {
            expect( render( { input: INPUTS[ INPUTS.length - 1 ] } ) ).toEqual( EXPECTED_FULL_BLOCK )
        } )
    } )


    describe( 'the public door of the twin', () => {

        it( 'fails loud on every missing argument — no silent default', () => {
            expect( () => DoltDbAssembler.answeredEntryLines( { questionOptions: [], answers: [] } ) ).toThrow( /"row" is required/ )
            expect( () => DoltDbAssembler.answeredEntryLines( { row: INPUTS[ 0 ].row, answers: [] } ) ).toThrow( /"questionOptions" is required/ )
            expect( () => DoltDbAssembler.answeredEntryLines( { row: INPUTS[ 0 ].row, questionOptions: [] } ) ).toThrow( /"answers" is required/ )
        } )
    } )


    describe( 'AB-3 — the twin, held against the core copy', () => {

        // WHAT IS COMPARED IS THE CODE, not the comment above it: the two comment blocks name each
        // other ("byte-identical to <the other class>") and are therefore DIFFERENT by design. Holding
        // them equal would be a condition that can only be satisfied by making the documentation wrong.
        withCore( `every member of the answered family reads identically on both sides — code, not comments (${ TWIN_MEMBERS.length } members + ${ TWIN_CONSTANTS.length } registers)`, async () => {
            assertSiblingResolved( { twin: TWIN } )
            console.log( siblingOriginLine( { label: 'twin', twin: TWIN } ) )

            const mine = ( await readFile( resolve( VIEWER_ROOT, 'src', 'DoltDbAssembler.mjs' ), 'utf8' ) ).split( '\n' )
            const theirs = ( await readFile( CORE_TWIN, 'utf8' ) ).split( '\n' )

            const rows = TWIN_MEMBERS
                .map( ( name ) => ( { name, mine: memberSource( { lines: mine, name } ), theirs: memberSource( { lines: theirs, name } ) } ) )
                .concat( TWIN_CONSTANTS.map( ( name ) => ( { name, mine: constantSource( { lines: mine, name } ), theirs: constantSource( { lines: theirs, name } ) } ) ) )

            // ANTI-VACUUM: a member that is absent on either side is a FINDING, not a skipped comparison.
            const missing = rows
                .filter( ( row ) => row.mine === null || row.theirs === null )
                .map( ( row ) => `${ row.name } (viewer ${ row.mine === null ? 'ABSENT' : 'present' } / core ${ row.theirs === null ? 'ABSENT' : 'present' })` )
            expect( missing ).toEqual( [] )

            const compared = rows
                .reduce( ( acc, row ) => acc + ( row.mine === null ? 0 : row.mine.split( '\n' ).length ), 0 )
            expect( compared ).toBeGreaterThan( 100 )

            const drifted = rows
                .filter( ( row ) => normalise( { text: row.mine ?? '' } ) !== normalise( { text: row.theirs ?? '' } ) )
                .map( ( row ) => row.name )
            expect( drifted ).toEqual( [] )
        } )

        withCore( 'counter-probe — ONE changed character in the compared source shows up as a drift', async () => {
            assertSiblingResolved( { twin: TWIN } )

            const mine = ( await readFile( resolve( VIEWER_ROOT, 'src', 'DoltDbAssembler.mjs' ), 'utf8' ) ).split( '\n' )
            const theirs = ( await readFile( CORE_TWIN, 'utf8' ) ).split( '\n' )
            const tampered = mine
                .map( ( line ) => line.includes( '- **${ ANSWERED_PROVENANCE_LABEL }:** ' ) === true ? line.replace( ':** ', ':**  ' ) : line )

            expect( tampered.join( '\n' ) ).not.toBe( mine.join( '\n' ) )
            const drifted = TWIN_MEMBERS
                .filter( ( name ) => normalise( { text: memberSource( { lines: tampered, name } ) ?? '' } ) !== normalise( { text: memberSource( { lines: theirs, name } ) ?? '' } ) )
            expect( drifted ).toEqual( [ '#answeredProvenance' ] )
        } )

        // The derivation rule itself, over NAMED inputs. Asserting that the resolved path ends in the
        // file name would be true by construction and would measure nothing. What has to hold is the
        // property the defect broke: the DIRECTORY NAME must not reach the derivation. The old rule
        // turned the name into the sibling ('viewer-p9-prd17' -> 'core-p9-prd17') and therefore answered
        // differently after every rename; the new rule answers with the neighbour of the MAIN repository,
        // so all three inputs below — whose names differ — land on the same sibling name.
        it( 'derives the core twin from the MAIN repository, never from the name of the tree it runs in', async () => {
            const cases = [
                { mainRepo: '/w/repos/viewer', twin: '/w/repos/core/cli/src/RevisionAssembler.mjs' },
                { mainRepo: '/w/repos/viewer-p9-prd08', twin: '/w/repos/core/cli/src/RevisionAssembler.mjs' },
                { mainRepo: '/elsewhere/repos/p9-prd17', twin: '/elsewhere/repos/core/cli/src/RevisionAssembler.mjs' }
            ]
            expect( cases.length ).toBeGreaterThanOrEqual( 3 )

            const wrong = cases
                .map( ( entry ) => ( { entry, resolved: siblingFilePath( { mainRepo: entry.mainRepo, repo: 'core', segments: TWIN_SEGMENTS } ) } ) )
                .filter( ( row ) => row.resolved !== row.entry.twin )
                .map( ( row ) => `${ row.entry.mainRepo } -> ${ row.resolved }` )
            expect( wrong ).toEqual( [] )

            // ANTI-REGRESSION on the CLASS, not on this case: the shared helper must not compute a
            // directory name at all. These two expressions are the ones the defect lived in, and a
            // suite that only checked its own resolved path would let them come back.
            const helper = await readFile( resolve( HERE, '..', 'helpers', 'siblingRepo.mjs' ), 'utf8' )
            expect( helper.length ).toBeGreaterThan( 500 )
            expect( helper.includes( 'startsWith( \'viewer\'' ) ).toBe( false )
            expect( helper.includes( 'slice( \'viewer\'' ) ).toBe( false )
            expect( helper.includes( 'rev-parse' ) ).toBe( true )

            // The answer from git is VERIFIED, not trusted — a counter-probe found this the hard way:
            // `git rev-parse` ECHOES an argument it does not recognise instead of failing, and the echoed
            // flag then resolved to a plausible-looking directory that was never a git directory. A
            // derivation that cannot name an EXISTING git directory must fail with a reason.
            const broken = mainRepoRoot( { from: resolve( VIEWER_ROOT, 'no-such-directory-zzz' ) } )
            expect( broken.status ).toBe( false )
            expect( broken.root ).toBe( null )
            expect( String( broken.reason ).length ).toBeGreaterThan( 10 )
            expect( helper.includes( 'no such git directory' ) ).toBe( true )

            // ... and the tree this suite really runs in names what it derived and WHICH of the two twins it
            // took. The twin must lie inside the root that was chosen — the own-branch worktree when the
            // preference fired, the sibling repository otherwise — never somewhere a reader has to guess at.
            expect( TWIN.mainRepo === null ).toBe( false )
            expect( CORE_TWIN.endsWith( 'cli/src/RevisionAssembler.mjs' ) ).toBe( true )
            expect( [ 'own-branch', 'main' ] ).toContain( TWIN.origin )
            expect( CORE_TWIN.startsWith( TWIN.origin === 'own-branch' ? TWIN.worktree : TWIN.repoRoot ) ).toBe( true )
            expect( [ 'resolved', 'standalone', 'missing-repo', 'missing-file', 'derivation' ] ).toContain( TWIN.kind )
        } )
    } )
} )
