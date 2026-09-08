// QuestionStateStore.mjs — the per-memo WORKING state of the question widget (Memo 081, WI-118).
//
// WHY THIS IS NOT `user_input_answers`. The per-memo Dolt DB already holds durable answers, and that
// is exactly why the working state may NOT live there. Three measured reasons, each sufficient:
//   1. The viewer must never be a second writer to that DB — every write goes through the core CLI
//      leaf via child_process (UserInputCapture F4=A). One child process per option click.
//   2. A `user_input_answers` row is chained to an input_id that only exists AFTER the transcript was
//      submitted. Before "Uebernehmen" there is nothing to chain to.
//   3. DECISIVE: every row in that table counts as an ANSWERED question — DoltDbAssembler reads
//      `SELECT DISTINCT question_id FROM user_input_answers` with no confirmation filter, and
//      DocumentRegistry folds the result into the open-question counts. An unconfirmed selection
//      stored there would become a durable, project-wide "answered" — which is WI-109 made permanent.
//
// So `user_input_answers` stays the ledger of SUBMITTED DECISIONS and is untouched. This store holds
// what comes before it, and it holds INTENT and CONFIRMED ANSWER in two SEPARATE shapes:
//   intent    — selected / custom / rejected / touched. NO answer text field exists here AT ALL.
//   confirmed — answerText, present or absent. Never an empty string.
// The separation is therefore not a rule that must be obeyed but a statement that cannot be made: a
// restored intent yields addedText:null because its record carries no text to take it from, so it
// fails the very same isConfirmedAnswer predicate it fails today.
//
// THE TOUCHED GATE lives here and only here. A record may carry `confirmed` ONLY when its intent is
// `touched: true`. A machine injection (PRD-026 sets added/addedText without any interaction) is
// therefore stored AS AN INTENT, never as an answer — this store is stricter than the client's
// isConfirmedAnswer and never more generous. Strict in this direction is the safe one: an answer that
// has to be confirmed again after a restart costs one click, an intent that counts as an answer after
// a restart costs the user their opinion.
//
// House style mirrors AnnotationStore (the store this one is modelled on): memo-scoped, viewer-owned,
// one JSON file per revision, static methods, object params/returns, private #helpers, no loops, no
// silent defaults. It differs from AnnotationStore in ONE deliberate point: it OVERWRITES its own file
// instead of archive-then-write. A working state is by definition the latest one, and an archive copy
// per option click would pile up unbounded stamped files in the memo directory.
//
// FAIL-OPEN ON READ (mirror of SessionConfigStore): a missing, unreadable or broken file yields the
// empty shape with a message — a viewer boot must never hang on it. FAIL-LOUD ON WRITE: a failed write
// returns status:false with a named message the client makes visible. A store that fails silently is
// worse than none, because it promises that the restart was harmless.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'


const QUESTION_STATE_DIRNAME = '_question-state'
// The file name IS the revision id, so the pattern is checked BEFORE a path is ever built: a name that
// misses the pattern produces no path and no write attempt. Same shape AnnotationStore already carries
// for resolvedIn.revisionId — a path traversal is not guarded here, it is unconstructible.
const REVISION_ID_PATTERN = /^REV-\d{2,}$/


class QuestionStateStore {
    // Read the stored working state of one revision.
    // Returns { status, entries, seen, skipped, messages } — `entries` keyed by question id, `seen` the
    // number of records the file carried, `skipped` the number discarded as malformed. A missing file is
    // NOT an error: status true, entries {}, seen 0, and no message (there is nothing to report). A
    // broken file is also status true — but WITH a message, because "empty" and "unreadable" must never
    // look alike to the caller.
    static async read( { memoDir, revisionId } ) {
        const scope = QuestionStateStore.#requireScope( { memoDir, revisionId } )

        if( scope[ 'status' ] !== true ) {
            return { status: false, messages: scope[ 'messages' ], entries: {}, seen: 0, skipped: 0 }
        }

        const path = QuestionStateStore.#filePath( { memoDir, revisionId } )
        const read = await readFile( path, 'utf-8' )
            .then( ( text ) => ( { ok: true, text } ) )
            .catch( ( error ) => ( { ok: false, code: error.code } ) )

        if( read[ 'ok' ] !== true ) {
            if( read[ 'code' ] === 'ENOENT' ) {
                return { status: true, messages: [], entries: {}, seen: 0, skipped: 0 }
            }

            return QuestionStateStore.#failOpen( { message: `question state unreadable (${ read[ 'code' ] }) — the working state starts empty` } )
        }

        const parsed = QuestionStateStore.#parse( { text: read[ 'text' ] } )

        if( parsed[ 'status' ] !== true ) {
            return QuestionStateStore.#failOpen( { message: parsed[ 'message' ] } )
        }

        const records = Object.entries( parsed[ 'entries' ] )
            .map( ( [ id, record ] ) => {
                return { id, ...QuestionStateStore.#normalizeEntry( { id, record } ) }
            } )
        const kept = records.filter( ( entry ) => entry[ 'status' ] === true )
        const dropped = records.filter( ( entry ) => entry[ 'status' ] !== true )

        return {
            status: true,
            messages: dropped.map( ( entry ) => `${ entry[ 'id' ] }: ${ entry[ 'reason' ] }` ),
            entries: QuestionStateStore.#byId( { records: kept } ),
            seen: records.length,
            skipped: dropped.length
        }
    }


    // Write the working state of one revision, replacing the previous file.
    // Returns { status, written, skipped, messages } — `written` the number of records that reached the
    // file, `skipped` the number rejected. Every rejection carries a named message; nothing is dropped
    // in silence, because a silently halved store looks exactly like an empty one.
    static async write( { memoDir, revisionId, entries } ) {
        const scope = QuestionStateStore.#requireScope( { memoDir, revisionId } )

        if( scope[ 'status' ] !== true ) {
            return { status: false, messages: scope[ 'messages' ], written: 0, skipped: 0 }
        }

        if( entries === null || typeof entries !== 'object' || Array.isArray( entries ) === true ) {
            return { status: false, messages: [ 'entries: required object keyed by question id' ], written: 0, skipped: 0 }
        }

        const records = Object.entries( entries )
            .map( ( [ id, record ] ) => {
                return { id, ...QuestionStateStore.#normalizeEntry( { id, record } ) }
            } )
        const kept = records.filter( ( entry ) => entry[ 'status' ] === true )
        const dropped = records.filter( ( entry ) => entry[ 'status' ] !== true )
        const demoted = kept.filter( ( entry ) => entry[ 'demoted' ] === true )

        const payload = {
            revisionId,
            savedAt: new Date().toISOString(),
            entries: QuestionStateStore.#byId( { records: kept } )
        }

        const dir = QuestionStateStore.#itemsDir( { memoDir } )
        const done = await mkdir( dir, { recursive: true } )
            .then( () => writeFile( QuestionStateStore.#filePath( { memoDir, revisionId } ), `${ JSON.stringify( payload, null, 4 ) }\n`, 'utf-8' ) )
            .then( () => ( { ok: true } ) )
            .catch( ( error ) => ( { ok: false, message: `${ error.code }: ${ error.message }` } ) )

        if( done[ 'ok' ] !== true ) {
            return { status: false, messages: [ `question state not written (${ done[ 'message' ] })` ], written: 0, skipped: dropped.length }
        }

        const messages = dropped
            .map( ( entry ) => `${ entry[ 'id' ] }: ${ entry[ 'reason' ] }` )
            .concat( demoted.map( ( entry ) => `${ entry[ 'id' ] }: ${ entry[ 'reason' ] }` ) )

        return { status: true, messages, written: kept.length, skipped: dropped.length }
    }


    // ---- private ----

    // The scope of this store: a memo directory and a revision id that MATCHES the pattern. Both are
    // checked before any path is built, so an id such as "../../etc/passwd" never reaches resolve().
    static #requireScope( { memoDir, revisionId } ) {
        const messages = []

        if( typeof memoDir !== 'string' || memoDir.length === 0 ) {
            messages.push( 'memoDir: required non-empty memo context (the question state is memo-scoped)' )
        }
        if( typeof revisionId !== 'string' || REVISION_ID_PATTERN.test( revisionId ) !== true ) {
            messages.push( `revisionId "${ revisionId }" is not a valid REV-NN id — no path is built and nothing is written` )
        }

        return { status: messages.length === 0, messages }
    }


    static #itemsDir( { memoDir } ) {
        return resolve( memoDir, QUESTION_STATE_DIRNAME )
    }


    static #filePath( { memoDir, revisionId } ) {
        return resolve( QuestionStateStore.#itemsDir( { memoDir } ), `${ revisionId }.json` )
    }


    static #failOpen( { message } ) {
        process.stderr.write( `[QuestionStateStore] ${ message }\n` )

        return { status: true, messages: [ message ], entries: {}, seen: 0, skipped: 0 }
    }


    static #parse( { text } ) {
        try {
            const payload = JSON.parse( text )

            if( payload === null || typeof payload !== 'object' || Array.isArray( payload ) === true ) {
                return { status: false, message: 'question state file is not an object — the working state starts empty' }
            }

            const entries = payload[ 'entries' ]

            if( entries === null || typeof entries !== 'object' || Array.isArray( entries ) === true ) {
                return { status: false, message: 'question state file carries no entries object — the working state starts empty' }
            }

            return { status: true, entries }
        } catch {
            return { status: false, message: 'question state file is not valid JSON — the working state starts empty' }
        }
    }


    static #byId( { records } ) {
        return records.reduce( ( acc, entry ) => {
            acc[ entry[ 'id' ] ] = entry[ 'entry' ]

            return acc
        }, {} )
    }


    // The shape is VALIDATED, never assumed — on the way in and on the way out alike. A store that
    // passes a foreign shape through is the entry point for exactly the confusion the two-part record
    // exists to rule out. Returns { status, entry, reason, demoted }; a rejected record is dropped
    // WHOLE, never half-applied, and the caller counts it.
    static #normalizeEntry( { id, record } ) {
        if( typeof id !== 'string' || id.trim().length === 0 ) {
            return { status: false, entry: null, reason: 'question id: required non-empty string' }
        }
        if( record === null || typeof record !== 'object' || Array.isArray( record ) === true ) {
            return { status: false, entry: null, reason: 'record: required object { intent, confirmed? }' }
        }

        const intent = record[ 'intent' ]

        if( intent === null || typeof intent !== 'object' || Array.isArray( intent ) === true ) {
            return { status: false, entry: null, reason: 'intent: required object { selected, custom, rejected, touched }' }
        }

        const selected = intent[ 'selected' ]

        if( Array.isArray( selected ) !== true || selected.every( ( index ) => Number.isInteger( index ) && index >= 0 ) !== true ) {
            return { status: false, entry: null, reason: 'intent.selected: required array of non-negative integers' }
        }

        const custom = intent[ 'custom' ]

        if( Array.isArray( custom ) !== true || custom.every( ( text ) => typeof text === 'string' ) !== true ) {
            return { status: false, entry: null, reason: 'intent.custom: required array of strings' }
        }

        const normalized = {
            selected: selected.slice(),
            custom: custom.slice(),
            rejected: intent[ 'rejected' ] === true,
            touched: intent[ 'touched' ] === true
        }
        const confirmed = record[ 'confirmed' ]

        if( confirmed === undefined || confirmed === null ) {
            return { status: true, entry: { intent: normalized }, reason: null, demoted: false }
        }
        if( typeof confirmed !== 'object' || Array.isArray( confirmed ) === true ) {
            return { status: false, entry: null, reason: 'confirmed: present but not an object { answerText }' }
        }

        const answerText = confirmed[ 'answerText' ]

        if( typeof answerText !== 'string' || answerText.length === 0 ) {
            return { status: false, entry: null, reason: 'confirmed.answerText: required non-empty string (an empty string is not a value)' }
        }

        // THE TOUCHED GATE. A confirmed part without a touched intent is a machine injection, and it is
        // demoted to an intent rather than rejected — the selection is still the user's display state,
        // only the "this is an answer" claim is dropped. Named in the messages, never silent.
        if( normalized[ 'touched' ] !== true ) {
            return { status: true, entry: { intent: normalized }, demoted: true, reason: 'confirmed dropped: intent.touched is not true — stored as an intent, not as an answer' }
        }

        return { status: true, entry: { intent: normalized, confirmed: { answerText } }, reason: null, demoted: false }
    }
}


export {
    QuestionStateStore,
    QUESTION_STATE_DIRNAME,
    REVISION_ID_PATTERN
}
