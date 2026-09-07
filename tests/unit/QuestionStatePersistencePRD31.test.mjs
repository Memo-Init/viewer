import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { extractFunctions, readEmittedScript } from '../helpers/extractFunction.mjs'


// PRD-31 (Memo 081 Kap 19, WI-118) — the answer state survives the process.
//
// TWO THINGS ARE MEASURED HERE, AND THEY PULL IN OPPOSITE DIRECTIONS. A confirmed answer must come
// back after a restart (otherwise nothing was gained), and a selection the user never confirmed must
// NOT come back as an answer (otherwise WI-109 is undone and made permanent). A store that satisfies
// only one of the two passes half of this file and fails the other half — deliberately.
//
// THE VACUUM LATCH. Every case that compares values first proves there was something to compare: the
// store reports `seen`, and the restored state is diffed against the freshly seeded default state. A
// store that saved nothing would satisfy "no intent came back as an answer" effortlessly, so a green
// without a stated comparison set is not a result here.
//
// WHY THE STORE IS LOADED DYNAMICALLY. A static import would make the WHOLE file fail to load when the
// module is absent — one collapse, zero assertions evaluated, and no way to tell which claim actually
// holds. Loading it per case keeps the client-side cases running on their own, so "red against the old
// state" is a per-case statement instead of one import error standing in for eleven.
const run = promisify( execFile )
const HERE = dirname( fileURLToPath( import.meta.url ) )
const REPO = resolve( HERE, '..', '..' )
const STORE_PATH = resolve( REPO, 'src', 'QuestionStateStore.mjs' )

const loadStore = async () => {
    const { QuestionStateStore } = await import( STORE_PATH )

    return QuestionStateStore
}


// The default state seedQuestionState builds for an untouched question — the thing a restored state
// has to differ from, or nothing was restored.
const DEFAULT_STATE = { selected: [], custom: [], added: false, addedText: null, rejected: false, touched: false }

const countDifferingFields = ( actual, expected ) => {
    return Object.keys( expected )
        .filter( ( key ) => JSON.stringify( actual[ key ] ) !== JSON.stringify( expected[ key ] ) )
        .length
}


describe( 'PRD-31 (WI-118) — the answer state survives the process', () => {
    let memoDir = null

    beforeEach( async () => {
        await mkdir( join( REPO, '.test-tmp' ), { recursive: true } )
        memoDir = await mkdtemp( join( REPO, '.test-tmp', 'qstate-' ) )
    } )

    afterEach( async () => {
        await rm( memoDir, { recursive: true, force: true } )
    } )


    // T-A — the real process change. Written by ONE node process, read by ANOTHER: not two calls in
    // one process, which would only prove that a variable still holds its value.
    it( 'T-A: a confirmed answer survives a real process change (two node PIDs)', async () => {
        const store = STORE_PATH
        const writer = `
            import { QuestionStateStore } from ${ JSON.stringify( store ) }
            const result = await QuestionStateStore.write( {
                memoDir: ${ JSON.stringify( memoDir ) },
                revisionId: 'REV-07',
                entries: {
                    F1: { intent: { selected: [ 1 ], custom: [], rejected: false, touched: true }, confirmed: { answerText: 'B) Beta' } },
                    F2: { intent: { selected: [ 0 ], custom: [ 'own entry' ], rejected: false, touched: true } }
                }
            } )
            process.stdout.write( JSON.stringify( { pid: process.pid, written: result.written, status: result.status } ) )
        `
        const reader = `
            import { QuestionStateStore } from ${ JSON.stringify( store ) }
            const result = await QuestionStateStore.read( { memoDir: ${ JSON.stringify( memoDir ) }, revisionId: 'REV-07' } )
            process.stdout.write( JSON.stringify( { pid: process.pid, seen: result.seen, skipped: result.skipped, entries: result.entries } ) )
        `

        const written = JSON.parse( ( await run( process.execPath, [ '--input-type=module', '-e', writer ] ) ).stdout )
        const read = JSON.parse( ( await run( process.execPath, [ '--input-type=module', '-e', reader ] ) ).stdout )

        // The process change is PROVEN, not assumed: two different pids, neither of them this one.
        expect( written.pid ).not.toBe( read.pid )
        expect( written.pid ).not.toBe( process.pid )
        expect( read.pid ).not.toBe( process.pid )

        // Vacuum latch: something was there to read.
        expect( written.status ).toBe( true )
        expect( written.written ).toBe( 2 )
        expect( read.seen ).toBe( 2 )

        expect( read.entries.F1.confirmed.answerText ).toBe( 'B) Beta' )
        expect( read.entries.F1.intent.selected ).toEqual( [ 1 ] )
        expect( read.entries.F2.intent.custom ).toEqual( [ 'own entry' ] )
    } )


    // T-B — the WI-109 check, both directions. The predicate is the one LIFTED OUT OF THE CLIENT, not a
    // condition re-typed here: a test that rebuilds the condition only ever tests its own copy.
    it( 'T-B: a restored intent fails the client\'s own isConfirmedAnswer, a restored answer passes it', async () => {
        const QuestionStateStore = await loadStore()
        const { isConfirmedAnswer, stateFromStoredRecord } = await extractFunctions( [ 'isConfirmedAnswer', 'stateFromStoredRecord' ] )

        const saved = await QuestionStateStore.write( {
            memoDir,
            revisionId: 'REV-07',
            entries: {
                F1: { intent: { selected: [ 1 ], custom: [], rejected: false, touched: true }, confirmed: { answerText: 'B) Beta' } },
                F2: { intent: { selected: [ 0 ], custom: [], rejected: false, touched: true } }
            }
        } )
        const read = await QuestionStateStore.read( { memoDir, revisionId: 'REV-07' } )

        expect( saved.written ).toBe( 2 )
        expect( read.seen ).toBe( 2 )

        const restoredIntent = stateFromStoredRecord( read.entries.F2 )
        const restoredAnswer = stateFromStoredRecord( read.entries.F1 )

        // Vacuum latch: the restored intent is NOT the default state — something really came back.
        expect( countDifferingFields( restoredIntent, DEFAULT_STATE ) ).toBeGreaterThan( 0 )

        // Direction 1 — preserve.
        expect( isConfirmedAnswer( restoredAnswer ) ).toBe( true )
        expect( restoredAnswer.addedText ).toBe( 'B) Beta' )

        // Direction 2 — never promote.
        expect( isConfirmedAnswer( restoredIntent ) ).toBe( false )
        expect( restoredIntent.addedText ).toBeNull()

        // Direction 3 — never lose. An intent that is simply thrown away would pass direction 2
        // effortlessly and would still leave PRD-22's expectation unmet.
        expect( restoredIntent.selected ).toEqual( [ 0 ] )
    } )


    // T-C — the guarantee as a measurement. The intent record has no field that COULD carry an answer text,
    // so the neighbour's answer text cannot appear in its serialised form.
    it( 'T-C: the serialised intent record contains no answer text at all', async () => {
        const QuestionStateStore = await loadStore()
        const answerText = 'B) Beta — a very distinctive answer text'

        await QuestionStateStore.write( {
            memoDir,
            revisionId: 'REV-07',
            entries: {
                F1: { intent: { selected: [ 1 ], custom: [], rejected: false, touched: true }, confirmed: { answerText } },
                F2: { intent: { selected: [ 0 ], custom: [], rejected: false, touched: true } }
            }
        } )
        const read = await QuestionStateStore.read( { memoDir, revisionId: 'REV-07' } )

        expect( read.seen ).toBe( 2 )
        expect( JSON.stringify( read.entries.F1 ) ).toContain( answerText )
        expect( JSON.stringify( read.entries.F2 ) ).not.toContain( answerText )
        expect( Object.keys( read.entries.F2 ) ).toEqual( [ 'intent' ] )
        expect( Object.keys( read.entries.F2.intent ).includes( 'answerText' ) ).toBe( false )
        expect( Object.keys( read.entries.F2.intent ).includes( 'addedText' ) ).toBe( false )
    } )


    // T-D — the machine injection. PRD-026 can set added/addedText without any interaction; such a
    // record is stored AS AN INTENT. The store is stricter than isConfirmedAnswer and never looser.
    it( 'T-D: confirmed without touched is stored as an intent, and it is named, not dropped in silence', async () => {
        const QuestionStateStore = await loadStore()
        const { isConfirmedAnswer, stateFromStoredRecord } = await extractFunctions( [ 'isConfirmedAnswer', 'stateFromStoredRecord' ] )

        const saved = await QuestionStateStore.write( {
            memoDir,
            revisionId: 'REV-07',
            entries: {
                F1: { intent: { selected: [ 1 ], custom: [], rejected: false, touched: false }, confirmed: { answerText: 'B) Beta' } }
            }
        } )
        const read = await QuestionStateStore.read( { memoDir, revisionId: 'REV-07' } )

        expect( saved.status ).toBe( true )
        expect( saved.written ).toBe( 1 )
        expect( saved.messages.length ).toBe( 1 )
        expect( saved.messages[ 0 ] ).toContain( 'touched' )

        expect( read.seen ).toBe( 1 )
        expect( read.entries.F1.confirmed ).toBeUndefined()
        expect( JSON.stringify( read.entries.F1 ) ).not.toContain( 'B) Beta' )
        expect( isConfirmedAnswer( stateFromStoredRecord( read.entries.F1 ) ) ).toBe( false )
        // The selection itself survives — only the "this is an answer" claim was dropped.
        expect( stateFromStoredRecord( read.entries.F1 ).selected ).toEqual( [ 1 ] )
    } )


    // T-E — the validity latch. A stored selection whose index outruns today's option list is
    // dropped WHOLE by seedQuestionState, never half-applied.
    it( 'T-E: a stored state whose selected index outruns the option list is discarded, not half-applied', async () => {
        const { seedQuestionState, stateFromStoredRecord, fillPrevFromStoredQuestionState } = await extractFunctions(
            [ 'seedQuestionState', 'stateFromStoredRecord', 'fillPrevFromStoredQuestionState' ]
        )
        const question = { id: 'F1', typ: 'single', preselected: [], options: [ { kind: 'option', key: 'A', label: 'Alpha' }, { kind: 'option', key: 'B', label: 'Beta' } ] }

        const outOfRange = { F1: { intent: { selected: [ 7 ], custom: [], rejected: false, touched: true } } }
        const inRange = { F1: { intent: { selected: [ 1 ], custom: [], rejected: false, touched: true } } }

        // Vacuum latch: the in-range case proves the path is wired at all, so the out-of-range case
        // failing to restore is the LATCH and not an inert function.
        const goodMap = {}
        fillPrevFromStoredQuestionState( goodMap, inRange )
        expect( stateFromStoredRecord( inRange.F1 ) ).not.toBeNull()
        expect( seedQuestionState( [ question ], goodMap )[ 0 ].selected ).toEqual( [ 1 ] )

        const badMap = {}
        fillPrevFromStoredQuestionState( badMap, outOfRange )
        const seeded = seedQuestionState( [ question ], badMap )[ 0 ]

        expect( seeded.selected ).toEqual( [] )
        expect( seeded.touched ).toBe( false )
        expect( countDifferingFields( seeded, DEFAULT_STATE ) ).toBe( 0 )
    } )


    // T-F — precedence. A live entry the user WORKED ON beats the stored one. An untouched live entry
    // is the AI preselection the seed just built, and it yields — see the caller comment in
    // renderQuestionWidgets for why the rule has to read this way to hold at all.
    it( 'T-F: a touched live entry beats the stored one, an untouched live entry yields to it', async () => {
        const { fillPrevFromStoredQuestionState } = await extractFunctions( [ 'fillPrevFromStoredQuestionState', 'stateFromStoredRecord' ] )
        const stored = { F1: { intent: { selected: [ 1 ], custom: [], rejected: false, touched: true } } }

        const touchedLive = { F1: { selected: [ 0 ], custom: [], added: false, addedText: null, rejected: false, touched: true } }
        fillPrevFromStoredQuestionState( touchedLive, stored )
        expect( touchedLive.F1.selected ).toEqual( [ 0 ] )

        const untouchedLive = { F1: { selected: [ 0 ], custom: [], added: false, addedText: null, rejected: false, touched: false } }
        fillPrevFromStoredQuestionState( untouchedLive, stored )
        expect( untouchedLive.F1.selected ).toEqual( [ 1 ] )

        const confirmedLive = { F1: { selected: [ 0 ], custom: [], added: true, addedText: 'A) Alpha', rejected: false, touched: false } }
        fillPrevFromStoredQuestionState( confirmedLive, stored )
        expect( confirmedLive.F1.addedText ).toBe( 'A) Alpha' )
    } )


    // T-G — every return states its comparison set. A question without an id is neither stored nor
    // silently swallowed: it raises `skipped`, because a half-filled store looks like an empty one.
    it( 'T-G: read and write report seen / skipped / written, and a malformed record is counted', async () => {
        const QuestionStateStore = await loadStore()

        const saved = await QuestionStateStore.write( {
            memoDir,
            revisionId: 'REV-07',
            entries: {
                F1: { intent: { selected: [ 0 ], custom: [], rejected: false, touched: true } },
                F2: { intent: { selected: [ 'not-a-number' ], custom: [], rejected: false, touched: true } },
                '': { intent: { selected: [ 0 ], custom: [], rejected: false, touched: true } }
            }
        } )

        expect( saved.status ).toBe( true )
        expect( saved.written ).toBe( 1 )
        expect( saved.skipped ).toBe( 2 )
        expect( saved.messages.length ).toBe( 2 )

        const read = await QuestionStateStore.read( { memoDir, revisionId: 'REV-07' } )

        expect( read.seen ).toBe( 1 )
        expect( read.skipped ).toBe( 0 )
        expect( Object.keys( read.entries ) ).toEqual( [ 'F1' ] )
    } )


    // T-H — the path latch. The revision id is checked BEFORE a path is built, so the traversal is not
    // guarded, it is unconstructible. Measured by listing the target directory before and after.
    it( 'T-H: an invalid revisionId writes nothing and creates no file', async () => {
        const QuestionStateStore = await loadStore()
        const entries = { F1: { intent: { selected: [ 0 ], custom: [], rejected: false, touched: true } } }
        const invalid = [ '../../etc/passwd', 'REV-', '', null ]

        const listing = async () => {
            return readdir( join( memoDir, '_question-state' ) ).catch( () => [] )
        }

        const before = await listing()
        expect( before.length ).toBe( 0 )

        const rejected = await Promise.all( invalid.map( async ( revisionId ) => {
            const result = await QuestionStateStore.write( { memoDir, revisionId, entries } )
            const after = await listing()

            return { revisionId, status: result.status, written: result.written, files: after.length }
        } ) )

        expect( rejected.length ).toBe( 4 )
        expect( rejected.every( ( entry ) => entry.status === false ) ).toBe( true )
        expect( rejected.every( ( entry ) => entry.written === 0 ) ).toBe( true )
        expect( rejected.every( ( entry ) => entry.files === 0 ) ).toBe( true )

        // Vacuum latch: the VALID id does create exactly one file, so the four zeros above are the
        // latch working and not a store that never writes anything.
        const accepted = await QuestionStateStore.write( { memoDir, revisionId: 'REV-07', entries } )
        const after = await listing()

        expect( accepted.status ).toBe( true )
        expect( after ).toEqual( [ 'REV-07.json' ] )
    } )


    // T-I — fail-open on read, but never silent. A broken file yields the empty shape WITH a message:
    // "empty" and "unreadable" must never look the same to the caller.
    it( 'T-I: a broken JSON file yields the empty shape with a message, not a throw and not a silent empty', async () => {
        const QuestionStateStore = await loadStore()

        await mkdir( join( memoDir, '_question-state' ), { recursive: true } )
        await writeFile( join( memoDir, '_question-state', 'REV-07.json' ), '{ this is not JSON', 'utf-8' )

        const read = await QuestionStateStore.read( { memoDir, revisionId: 'REV-07' } )

        expect( read.status ).toBe( true )
        expect( read.entries ).toEqual( {} )
        expect( read.seen ).toBe( 0 )
        expect( read.messages.length ).toBeGreaterThan( 0 )

        // A MISSING file is the other case and must stay quiet — there is nothing to report.
        const absent = await QuestionStateStore.read( { memoDir, revisionId: 'REV-08' } )

        expect( absent.status ).toBe( true )
        expect( absent.seen ).toBe( 0 )
        expect( absent.messages ).toEqual( [] )
    } )


    // T-J — the card count. This PRD's only promise about the second half of the work-item title: it
    // does not make the doubling go away, it guarantees not to cause it. The rendered set comes from
    // the schema alone, so the restore cannot add a card.
    it( 'T-J: the card count is independent of the restored state', async () => {
        const { openQuestionsOf, seedQuestionState, fillPrevFromStoredQuestionState } = await extractFunctions(
            [ 'openQuestionsOf', 'seedQuestionState', 'fillPrevFromStoredQuestionState', 'stateFromStoredRecord' ]
        )
        const schema = [
            { id: 'F1', typ: 'single', status: 'open', preselected: [], options: [ { kind: 'option', key: 'A', label: 'Alpha' }, { kind: 'option', key: 'B', label: 'Beta' } ] },
            { id: 'F2', typ: 'single', status: 'open', preselected: [], options: [ { kind: 'option', key: 'A', label: 'Alpha' } ] },
            { id: 'F3', typ: 'single', status: 'answered', preselected: [], options: [] }
        ]
        const stored = {
            F1: { intent: { selected: [ 1 ], custom: [], rejected: false, touched: true }, confirmed: { answerText: 'B) Beta' } },
            F2: { intent: { selected: [ 0 ], custom: [], rejected: false, touched: true } },
            F9: { intent: { selected: [ 0 ], custom: [], rejected: false, touched: true } }
        }

        const open = openQuestionsOf( schema )
        const withoutStored = seedQuestionState( open, {} )

        const map = {}
        fillPrevFromStoredQuestionState( map, stored )
        const withStored = seedQuestionState( open, map )

        expect( open.length ).toBe( 2 )
        expect( withoutStored.length ).toBe( 2 )
        expect( withStored.length ).toBe( 2 )
        // F9 has no card in this schema; a stored record for it must not conjure one.
        expect( Object.keys( map ).length ).toBe( 3 )

        // Vacuum latch: the restore really did something, so the equal counts are a result and not an
        // inert path that changed nothing at all.
        expect( withStored[ 0 ].addedText ).toBe( 'B) Beta' )
        expect( countDifferingFields( withStored[ 0 ], DEFAULT_STATE ) ).toBeGreaterThan( 0 )
        expect( countDifferingFields( withoutStored[ 0 ], DEFAULT_STATE ) ).toBe( 0 )
    } )


    // T-K — the seven joiners, COUNTED. The number of save calls is held against the number of mutating
    // functions, not against the presence of a string: a seam that six of seven paths join would lose
    // every rejection and still satisfy a "does it appear" check.
    it( 'T-K: every mutating path joins the persistence seam — counted, not asserted', async () => {
        const src = await readEmittedScript()

        const mutators = [
            'function toggleOption(',
            'function harvestReformulationInputs(',
            'function submitQuestionAnswer(',
            'function undoQuestionAnswer(',
            'function rejectQuestion(',
            'function undoRejectQuestion('
        ]
        const declaredMutators = mutators.filter( ( marker ) => src.includes( marker ) ).length

        // Six named functions plus the inline free-text Enter handler = the seven paths of § I3.
        expect( declaredMutators ).toBe( 6 )

        const calls = src.split( 'persistQuestionState(' ).length - 1
        const declaration = src.split( 'function persistQuestionState(' ).length - 1

        expect( declaration ).toBe( 1 )
        expect( calls - declaration ).toBe( declaredMutators + 1 )

        // The seam is the counterpart of markQuestionTouched, and the two are NOT merged.
        expect( src ).toContain( 'function markQuestionTouched(' )
        expect( src.split( 'markQuestionTouched(' ).length - 1 ).toBeGreaterThan( 1 )

        // The confirmed half is derived from THE predicate, not from a second copy of its condition.
        expect( src ).toContain( 'if( isConfirmedAnswer( st ) ) { record.confirmed = { answerText: st.addedText } }' )
        expect( src.split( 'st.added === true && st.addedText' ).length - 1 ).toBe( 2 )
    } )


    // The four source assertions of QuestionWidgetAnswerPersistence.test.mjs sit bit-for-bit on the code
    // this PRD changes. They are re-stated here as an explicit boundary: the read-back FILLS prevById,
    // it does not rebuild it. If a later change has to move one of them, it should fail twice and be
    // decided once, rather than be adjusted in passing.
    it( 'the existing merge path is filled, not replaced', async () => {
        const src = await readEmittedScript()

        expect( src ).toContain( 'var prevById = {}' )
        expect( src ).toContain( 'seedQuestionState( open, prevById )' )
        expect( src ).toContain( 'var prev = q.id ? previous[ q.id ] : null' )
        expect( src ).toContain( 'fillPrevFromStoredQuestionState( prevById, questionStateStored.entries )' )

        const fillIndex = src.indexOf( 'fillPrevFromStoredQuestionState( prevById, questionStateStored.entries )' )
        const seedIndex = src.indexOf( 'questionNav.state = seedQuestionState( open, prevById )' )

        // The fill runs BEFORE the map is read. Reversed, it would be a store that writes into a map
        // nobody looks at again — green on every string check, useless in the browser.
        expect( fillIndex ).toBeGreaterThan( -1 )
        expect( seedIndex ).toBeGreaterThan( fillIndex )
    } )


    // The store must never become a second writer to the decision ledger. Measured against the module,
    // with the head comment (which names the table as the thing it is NOT) excluded.
    it( 'the store never touches the user_input_answers path', async () => {
        const source = await readFile( STORE_PATH, 'utf-8' )
        const code = source
            .split( '\n' )
            .filter( ( line ) => line.trim().startsWith( '//' ) === false )

        const hits = code.filter( ( line ) => /user_input_answers|UserInputCapture|user-input|child_process/.test( line ) )

        expect( code.length ).toBeGreaterThan( 100 )
        expect( hits ).toEqual( [] )
    } )
} )
