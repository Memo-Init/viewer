import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { resolve, join, basename, dirname } from 'node:path'


// StaleQueueSweep.mjs — the F18 Altbestand-Sweep (Memo 079 Phase 6b, PRD-22, WI-045/046).
//
// The forensics (context/research/2026-08-20--w3-viewer-deep.md, Offene Punkte #1) leaves ONE honest
// gap the data-side answer records (Phase 3) could not close for the OLD stock: of the 107 queue
// "Karteileichen", which are truly done vs. genuinely still open? This sweep answers that DETERMINISTIC-
// ally from disk facts alone — never guessing, never inventing a "done":
//
//   * SUPERSEDED  — a newer non-prepare revision (REV-M, M > N) exists in the same revisions/ folder.
//                   "Folge-REV existiert = erledigt" (mirror of DocumentRegistry.isInQueue's isSuperseded
//                   / MemoView.#markSupersededRevisions, but computed straight off the filenames).
//   * LOGGED-IN   — a `<REV-N>.loggedin` sidecar exists under the memo's transcripts/ folder (the exact
//                   disk fact the Widget "Abschliessen" flow writes; TranscriptRegistry.logInTranscript).
//   * FINALIZED   — the memo carries a `Finalisiert` / `Bedingt finalisiert` status in its newest full
//                   revision (the whole memo is done, so none of its revisions is an open job).
//   * OPEN        — none of the above holds. The rest is left HONESTLY open (no disposition invented).
//
// This is a CLI-LESS pure function: it reads the filesystem READ-ONLY and returns a classification. It
// mutates nothing, writes nothing, and (per the memo's honesty rule) never marks a revision done without
// a concrete on-disk fact backing it.
//
// House style: static methods, object params/returns, private #helpers, no loops (array methods), no
// silent defaults, single quotes, no semicolons.
const REV_ANY = /^REV-(\d+)(?:-(prepare|update))?\.md$/i
const REV_FULL = /^REV-(\d+)\.md$/i
const FINALIZED_STATUSES = [ 'Finalisiert', 'Bedingt finalisiert' ]


class StaleQueueSweep {
    // Sweep ONE memo directory (the folder that holds revisions/). Returns a per-revision classification.
    // `memoDir` may be the memo dir itself or its revisions/ subfolder — both resolve to the same place.
    static sweepMemo( { memoDir, readStatus } = {} ) {
        const struct = { 'status': false, 'messages': [], 'memoDir': null, 'entries': [], 'summary': {} }

        if( typeof memoDir !== 'string' || memoDir.trim().length === 0 ) {
            struct[ 'messages' ].push( 'memoDir: required non-empty string' )

            return struct
        }

        const resolvedMemoDir = basename( resolve( memoDir ) ) === 'revisions' ? dirname( resolve( memoDir ) ) : resolve( memoDir )
        const revisionsDir = join( resolvedMemoDir, 'revisions' )

        if( existsSync( revisionsDir ) !== true ) {
            struct[ 'messages' ].push( `revisions/ not found under ${ resolvedMemoDir }` )

            return struct
        }

        struct[ 'memoDir' ] = resolvedMemoDir

        const revisionFiles = StaleQueueSweep.#listRevisionFiles( { revisionsDir } )
        const maxFull = StaleQueueSweep.#maxNonPrepareNumber( { revisionFiles } )
        const finalized = StaleQueueSweep.#isMemoFinalized( { revisionsDir, revisionFiles, readStatus } )
        const transcriptsDir = join( resolvedMemoDir, 'transcripts' )

        const entries = revisionFiles
            .filter( ( file ) => file[ 'revisionType' ] !== 'prepare' )
            .map( ( file ) => {
                const loggedIn = StaleQueueSweep.#hasLoginSidecar( { transcriptsDir, 'revisionId': file[ 'revisionId' ] } )
                const superseded = maxFull !== null && file[ 'number' ] < maxFull

                const { disposition, evidence } = StaleQueueSweep.#classify( { superseded, loggedIn, finalized, 'number': file[ 'number' ], maxFull } )

                return {
                    'revisionId': file[ 'revisionId' ],
                    'fileName': file[ 'fileName' ],
                    'disposition': disposition,
                    'evidence': evidence,
                    'resolved': disposition !== 'open'
                }
            } )

        struct[ 'status' ] = true
        struct[ 'entries' ] = entries
        struct[ 'summary' ] = StaleQueueSweep.#summarize( { entries } )

        return struct
    }


    // ---- private ----

    static #classify( { superseded, loggedIn, finalized, number, maxFull } ) {
        if( loggedIn === true ) {
            return { 'disposition': 'logged-in', 'evidence': `${ number }.loggedin sidecar present on disk` }
        }

        if( superseded === true ) {
            return { 'disposition': 'superseded', 'evidence': `newer non-prepare revision REV-${ maxFull } exists` }
        }

        if( finalized === true ) {
            return { 'disposition': 'finalized', 'evidence': 'memo status is Finalisiert / Bedingt finalisiert' }
        }

        return { 'disposition': 'open', 'evidence': 'no completion fact on disk — honestly still open' }
    }


    static #summarize( { entries } ) {
        const dispositions = entries
            .map( ( entry ) => entry[ 'disposition' ] )

        return {
            'total': entries.length,
            'resolved': entries.filter( ( entry ) => entry[ 'resolved' ] === true ).length,
            'open': dispositions.filter( ( disposition ) => disposition === 'open' ).length,
            'superseded': dispositions.filter( ( disposition ) => disposition === 'superseded' ).length,
            'loggedIn': dispositions.filter( ( disposition ) => disposition === 'logged-in' ).length,
            'finalized': dispositions.filter( ( disposition ) => disposition === 'finalized' ).length
        }
    }


    static #listRevisionFiles( { revisionsDir } ) {
        const entries = StaleQueueSweep.#safeReaddir( { 'dir': revisionsDir } )

        return entries
            .map( ( name ) => {
                const match = String( name ).match( REV_ANY )

                if( match === null ) { return null }

                const revisionType = match[ 2 ] ? match[ 2 ].toLowerCase() : 'full'

                return {
                    'fileName': name,
                    // revisionId keeps the RAW filename token (e.g. `REV-01`, leading zero preserved) so
                    // it matches the transcript-side revisionId + `.loggedin` sidecar naming exactly (the
                    // rest of the viewer derives revisionId from the filename `REV-\d+` match). `number`
                    // is the parsed integer for the supersede comparison only.
                    'revisionId': `REV-${ match[ 1 ] }`,
                    'number': Number( match[ 1 ] ),
                    'revisionType': revisionType
                }
            } )
            .filter( ( file ) => file !== null )
            .sort( ( a, b ) => a[ 'number' ] - b[ 'number' ] )
    }


    static #maxNonPrepareNumber( { revisionFiles } ) {
        const numbers = revisionFiles
            .filter( ( file ) => file[ 'revisionType' ] !== 'prepare' )
            .map( ( file ) => file[ 'number' ] )

        return numbers.length > 0 ? Math.max( ...numbers ) : null
    }


    static #hasLoginSidecar( { transcriptsDir, revisionId } ) {
        if( existsSync( transcriptsDir ) !== true ) { return false }

        const entries = StaleQueueSweep.#safeReaddir( { 'dir': transcriptsDir } )
        // The Widget "Abschliessen" flow writes `<revisionId>.loggedin` next to the transcript file
        // (TranscriptRegistry.logInTranscript). Match on the revisionId prefix so both
        // `REV-3.loggedin` and `<memo>-REV-3.loggedin` sidecar naming variants count.
        return entries
            .some( ( name ) => name.endsWith( '.loggedin' ) && name.includes( revisionId ) )
    }


    static #isMemoFinalized( { revisionsDir, revisionFiles, readStatus } ) {
        // readStatus is an injectable reader ({ content } -> { memoStatus }) so a caller can reuse the
        // DocumentRegistry.parseStatus authority without a hard import cycle. Absent -> a lightweight
        // inline status-row scan of the newest full revision (deterministic, no invented default).
        const fullFiles = revisionFiles
            .filter( ( file ) => file[ 'revisionType' ] === 'full' )
            .sort( ( a, b ) => b[ 'number' ] - a[ 'number' ] )

        if( fullFiles.length === 0 ) { return false }

        const newest = fullFiles[ 0 ]
        const content = StaleQueueSweep.#safeRead( { 'path': join( revisionsDir, newest[ 'fileName' ] ) } )

        if( content === null ) { return false }

        if( typeof readStatus === 'function' ) {
            const { memoStatus } = readStatus( { content } )

            return FINALIZED_STATUSES.includes( memoStatus )
        }

        const statusLine = content
            .split( '\n' )
            .map( ( line ) => line.trim() )
            .find( ( line ) => /^\|\s*\*\*status\*\*\s*\|/i.test( line ) )

        return statusLine !== undefined && FINALIZED_STATUSES.some( ( value ) => statusLine.includes( value ) )
    }


    static #safeReaddir( { dir } ) {
        try {
            return readdirSync( dir )
        } catch {
            return []
        }
    }


    static #safeRead( { path } ) {
        try {
            if( statSync( path ).isFile() !== true ) { return null }

            return readFileSync( path, 'utf8' )
        } catch {
            return null
        }
    }
}


export { StaleQueueSweep }
