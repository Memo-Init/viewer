import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'


// DismissStore.mjs — the PERSISTENT dismiss ledger for the memo-viewer queue (Memo 079 Phase 6b,
// PRD-22, WI-045/046).
//
// The gap (context/research/2026-08-20--w3-viewer-deep.md, Befund b4): a DELETE /api/documents only
// removed the document from the In-Memory map — the next server boot re-registered every memo of every
// projects[] project via ProjectAutoRegister, so the dismissed "Karteileiche" came straight back. There
// was no persistent dismiss surface at all (`setDocumentStatus('delete')` was a tote API, 0 call sites).
//
// This store is the missing persistence: an APPEND-ONLY json ledger of dismissed documentIds. The DELETE
// route records the dismissal here; the boot path reads it back and prunes the dismissed documents from
// the freshly-registered set, so a dismissed memo stays gone across restarts.
//
// LOCATION (hard rule, CLAUDE.md § Test-Isolation + git-security): the ledger lives in the SAME project-
// local `.sessions/` directory as the shared session config — resolved by the identical ancestor walk —
// NEVER in the user home (~/.flowmcp, ~/.claude). A test always passes an explicit storePath so it writes
// inside the repo, never into $HOME.
//
// House style (mirrors SessionConfigStore): static methods, object params/returns, private #helpers, no
// loops (array methods + recursion), no silent defaults, single quotes, no semicolons.
class DismissStore {
    static #STORE_FILENAME = 'memo-view-dismissed.json'


    // Resolve the ledger path deterministically → { storePath } (absolute, may be null-safe cwd fallback).
    // An explicit MEMOVIEW_DISMISS_STORE env override wins; otherwise the first ancestor dir that already
    // carries `.sessions/` gets the ledger next to config.json; else `<cwd>/.sessions/<file>` (logged use).
    static resolveStorePath( { cwd, env } = {} ) {
        const environment = env !== undefined && env !== null && typeof env === 'object' ? env : process.env
        const override = environment[ 'MEMOVIEW_DISMISS_STORE' ]

        if( typeof override === 'string' && override.trim().length > 0 ) {
            return { 'storePath': resolve( override ) }
        }

        const startDir = typeof cwd === 'string' && cwd.trim().length > 0 ? resolve( cwd ) : process.cwd()
        const { sessionsDir } = DismissStore.#ascendForSessions( { 'dir': startDir } )
        const baseDir = sessionsDir !== null ? sessionsDir : join( startDir, '.sessions' )

        return { 'storePath': join( baseDir, DismissStore.#STORE_FILENAME ) }
    }


    // Record a dismissal. APPEND-ONLY: the entry is pushed onto the ledger array and the file is written
    // back. Idempotent at read time (readDismissed dedupes by documentId), so a double DELETE never breaks
    // rehydration. Never throws — an unwritable path returns status:false with a message (fail-loud caller).
    static record( { storePath, documentId, reason } ) {
        const struct = { 'status': false, 'messages': [] }

        if( typeof storePath !== 'string' || storePath.length === 0 ) {
            struct[ 'messages' ].push( 'storePath: required non-empty string' )

            return struct
        }

        if( typeof documentId !== 'string' || documentId.trim().length === 0 ) {
            struct[ 'messages' ].push( 'documentId: required non-empty string' )

            return struct
        }

        const { entries } = DismissStore.#readEntries( { storePath } )
        const entry = {
            'documentId': documentId,
            'dismissedAt': new Date().toISOString(),
            'reason': typeof reason === 'string' && reason.length > 0 ? reason : 'delete'
        }

        const next = { 'dismissed': entries.concat( [ entry ] ) }

        try {
            mkdirSync( dirname( storePath ), { 'recursive': true } )
            writeFileSync( storePath, JSON.stringify( next, null, 4 ) + '\n', 'utf8' )
        } catch( error ) {
            struct[ 'messages' ].push( `dismiss store unwritable (${ storePath }): ${ error.message }` )

            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    // Read the unique set of dismissed documentIds → { dismissed: [ ...ids ] }. Fail-open: a missing,
    // unreadable or broken ledger yields an empty list (a viewer boot must never depend on it).
    static readDismissed( { storePath } = {} ) {
        const { entries } = DismissStore.#readEntries( { storePath } )
        const ids = entries
            .map( ( entry ) => ( entry !== null && typeof entry === 'object' ? entry[ 'documentId' ] : null ) )
            .filter( ( id ) => typeof id === 'string' && id.length > 0 )

        return { 'dismissed': [ ...new Set( ids ) ] }
    }


    static isDismissed( { storePath, documentId } = {} ) {
        const { dismissed } = DismissStore.readDismissed( { storePath } )

        return { 'dismissed': dismissed.includes( documentId ) }
    }


    // ---- private ----

    static #readEntries( { storePath } ) {
        if( typeof storePath !== 'string' || storePath.length === 0 || existsSync( storePath ) !== true ) {
            return { 'entries': [] }
        }

        let raw = null

        try {
            raw = readFileSync( storePath, 'utf8' )
        } catch {
            return { 'entries': [] }
        }

        let parsed = null

        try {
            parsed = JSON.parse( raw )
        } catch {
            return { 'entries': [] }
        }

        if( parsed === null || typeof parsed !== 'object' || Array.isArray( parsed ) ) {
            return { 'entries': [] }
        }

        const entries = Array.isArray( parsed[ 'dismissed' ] )
            ? parsed[ 'dismissed' ].filter( ( entry ) => entry !== null && typeof entry === 'object' )
            : []

        return { 'entries': entries }
    }


    // Recursive ancestor walk for the first dir holding a `.sessions/` directory (mirrors
    // SessionConfigStore.#ascendForConfig). Reaching the filesystem root ends the walk with null.
    static #ascendForSessions( { dir } ) {
        const candidate = join( dir, '.sessions' )

        if( existsSync( candidate ) === true ) {
            return { 'sessionsDir': candidate }
        }

        const parent = dirname( dir )

        if( parent === dir ) {
            return { 'sessionsDir': null }
        }

        return DismissStore.#ascendForSessions( { 'dir': parent } )
    }
}


export { DismissStore }
