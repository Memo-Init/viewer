import { readdir, readFile, writeFile, rename, unlink, mkdir, access, stat } from 'node:fs/promises'
import { resolve, basename, dirname } from 'node:path'

import { TranscriptHeader } from './TranscriptHeader.mjs'


// REV_FILE_PATTERN is used ONLY for the revisions/ folder scan (#scanRevNumbers / #maxRevNumber):
// real revision files are REV-NN.md. It must stay as-is — transcripts/ no longer uses it.
const REV_FILE_PATTERN = /^REV-(\d+)(?:--(\d+))?\.md$/
// PRD-001 (Memo 022): the transcripts/ binding key. A revision transcript = feedback ZU REV-N is
// bound to REV-N. The filename encodes the DISCUSSED revision, not the produced one. Group 1 = the
// discussed revision number, group 2 = the running, collision-free sequence (01, 02, ...).
const REVIEW_FILE_PATTERN = /^REV-(\d+)--review--(\d+)\.md$/
// PRD-001 (Memo 022): the init transcript (memo-erstellen -> REV-01). NOT feedback to an existing
// revision, so it is stored separately and NEVER bound to a REV (no revisionId).
const INIT_FILE_PATTERN = /^init\.md$/
const REVISION_ID_PATTERN = /^REV-\d+$/
const PLAN_ID_PATTERN = /^PLAN-\d{3}-[a-z0-9-]+$/
// Slug is encoded in the filename so other transcripts survive a server restart:
// {projectId}--other--{seq}.md  (== transcriptId + ".md"). Group 1 = projectId, group 2 = seq.
const OTHER_FILE_PATTERN = /^(.+?)--other--(\d+)\.md$/
// PRD-003 (Memo 019 Kap 3): a FREE transcript stored inside an existing memo's transcripts/
// folder. Must NOT start with "REV-" so scanMemo never mistakes it for a revision. Group 1 = seq.
const FREE_MEMO_FILE_PATTERN = /^frei--(\d+)\.md$/


/**
 * Transcripts are persistent. There is no automatic deletion.
 * User must invoke DELETE via UI confirmation.
 * Self-Analytics is the intended long-term use-case (Memo 011 Kap 18.6).
 *
 * NEVER delete files under .memo/memos/* /transcripts/ automatically.
 * Cleanup-Routines MUST skip the transcripts/ directory.
 */
class TranscriptRegistry {
    #transcripts = new Map()
    #otherTranscripts = new Map()
    #onChangeCallback = null
    #defaultHost = 'http://localhost:3333'


    static create( { onChange, host } ) {
        const registry = new TranscriptRegistry()
        registry.#onChangeCallback = onChange || null

        if( host !== undefined && typeof host === 'string' && host.length > 0 ) {
            registry.#defaultHost = host
        }

        return { registry }
    }


    async addTranscript( { projectId, memoId, revisionId, content, sequence, memoPath, complete } ) {
        const struct = { 'status': false, 'messages': [], 'transcriptId': null, 'url': null, 'absolutePath': null }

        // PRD-027 (Memo 016 Kap 12.2): Vollstaendigkeits-Flag. Default = vollstaendig
        // (echter Transcript). Das Memo gibt diesen Default explizit vor (Kap 12.2/12.3),
        // daher ist der bewusste Default hier erlaubt — kein stiller ||-Default.
        // "nur Antworten" (PRD-028) setzt complete === false explizit.
        const isComplete = complete === false ? false : true

        const { status: validStatus, messages: validMessages } = TranscriptRegistry.validateAddTranscript( { projectId, memoId, revisionId, content } )

        if( !validStatus ) {
            struct[ 'messages' ] = validMessages

            return struct
        }

        const { transcriptsDir, status: dirStatus, messages: dirMessages } = await this.#resolveTranscriptsDir( { memoId, memoPath } )

        if( !dirStatus ) {
            struct[ 'messages' ] = dirMessages

            return struct
        }

        try {
            await mkdir( transcriptsDir, { recursive: true } )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Failed to create transcripts directory: ${ err.message }` )

            return struct
        }

        const { sequence: finalSequence, messages: seqMessages } = await TranscriptRegistry.#resolveSequence( { transcriptsDir, revisionId, requested: sequence } )

        if( seqMessages.length > 0 ) {
            struct[ 'messages' ] = seqMessages

            return struct
        }

        // PRD-001 (Memo 022): review-Schema REV-<N>--review--<NN>.md. The revisionId here is the
        // DISCUSSED revision (passed in by the corrected frontend binding); addTranscript makes no
        // "next vs discussed"-Annahme — it binds exactly the passed revisionId. A sequence is always
        // present in the review schema (otherwise the filename is not collision-free); '01' is the
        // documented first sequence, mirrored from #resolveSequence — kein stiller Default.
        const seqPart = finalSequence ? finalSequence : '01'
        const fileName = `${ revisionId }--review--${ seqPart }.md`
        const finalPath = resolve( transcriptsDir, fileName )
        const tmpPath = `${ finalPath }.tmp`

        try {
            await access( finalPath )
            struct[ 'messages' ].push( `TRANSCRIPT-SEQ-001: Target file already exists after sequence resolution: ${ fileName }` )

            return struct
        } catch {
            // not existing — proceed
        }

        // next = max(existing REV)+1 (PRD-002): derive the highest existing revision from the
        // memo's revisions/ bestand, never from the passed-in suffix.
        const { maxRevNumber } = await TranscriptRegistry.#maxRevNumber( { transcriptsDir, revisionId } )
        const { status: wrapStatus, messages: wrapMessages, wrappedContent } = TranscriptHeader.wrap( { content, 'type': 'revision', memoId, revisionId, maxRevNumber } )

        if( !wrapStatus ) {
            struct[ 'messages' ] = wrapMessages

            return struct
        }

        try {
            await writeFile( tmpPath, wrappedContent, 'utf-8' )
            await rename( tmpPath, finalPath )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Atomic write failed: ${ err.message }` )

            return struct
        }

        const { url, transcriptId } = TranscriptRegistry.buildUrl( { projectId, memoId, revisionId, sequence: finalSequence, host: this.#defaultHost } )

        const fileStat = await stat( finalPath )

        const transcript = {
            transcriptId,
            projectId,
            memoId,
            revisionId,
            'sequence': finalSequence,
            url,
            'absolutePath': finalPath,
            'mtime': fileStat.mtime.toISOString(),
            'mtimeMs': fileStat.mtimeMs,
            // PRD-001 (Memo 019 Kap 1): persist the spoken word count so the finalized-memo
            // minutes chip can aggregate it without re-reading the file. ~200 Woerter/Min.
            'words': TranscriptRegistry.wordCount( { content } ).words,
            // PRD-027: true = echter Transcript (vollstaendig), false = nur Antworten.
            'complete': isComplete,
            // PRD-005 (Memo 018 Kap 8): explizites, rueckgaengig-machbares Einloggen.
            // Neue Transcripts sind nie eingeloggt; das Einloggen ist ein separater Akt.
            'loggedIn': false
        }

        this.#transcripts.set( transcriptId, transcript )

        if( this.#onChangeCallback ) {
            this.#onChangeCallback( { transcriptId, 'event': 'transcriptAdded' } )
        }

        struct[ 'status' ] = true
        struct[ 'transcriptId' ] = transcriptId
        struct[ 'url' ] = url
        struct[ 'absolutePath' ] = finalPath

        return struct
    }


    async getTranscript( { transcriptId } ) {
        const struct = { 'status': false, 'messages': [], 'content': null, 'meta': null }

        // Other transcripts (bootstrapped memos without a number) live in a separate map.
        // Resolve from either map so their /transcripts/{id} URL is fetchable too.
        const transcript = this.#transcripts.get( transcriptId ) || this.#otherTranscripts.get( transcriptId )

        if( transcript === undefined ) {
            struct[ 'messages' ].push( `TRANSCRIPT-NOTFOUND-001: Transcript not found: ${ transcriptId }` )

            return struct
        }

        // Other transcripts carry no memoId/revisionId yet — use the documented
        // placeholder header values (matches addOtherTranscript).
        const memoId = transcript[ 'memoId' ] || 'other'
        const revisionId = transcript[ 'revisionId' ] || 'REV-01'

        try {
            const raw = await readFile( transcript[ 'absolutePath' ], 'utf-8' )
            const { hasHeader } = TranscriptHeader.detect( { content: raw } )

            // Type for a re-wrap: a transcript bound to a numbered memo is a revision,
            // an "other" transcript (no memoId) is a free transcript.
            const wrapType = transcript[ 'memoId' ] ? 'revision' : 'frei'

            let content = raw

            if( !hasHeader ) {
                const wrapped = TranscriptHeader.wrap( { content: raw, 'type': wrapType, memoId, revisionId } )

                if( wrapped[ 'status' ] ) {
                    content = wrapped[ 'wrappedContent' ]
                }
            }

            const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: raw } )

            // PRD-007/008: expose the transcript type so the Transcript-View can pick the
            // matching injection template. Prefer the stored record type; fall back to
            // header detection, then to the structural default (memo-bound = revision).
            const detected = TranscriptHeader.detectType( { content: raw } )
            const fallbackType = transcript[ 'memoId' ] ? 'revision' : 'frei'
            const type = transcript[ 'type' ] || detected[ 'type' ] || fallbackType

            struct[ 'status' ] = true
            struct[ 'content' ] = content
            struct[ 'meta' ] = {
                'transcriptId': transcript[ 'transcriptId' ],
                'projectId': transcript[ 'projectId' ],
                'memoId': memoId,
                'revisionId': revisionId,
                'sequence': transcript[ 'sequence' ],
                'url': transcript[ 'url' ],
                type,
                schemaVersion,
                isLegacy
            }
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-READ-001: Failed to read transcript file: ${ err.message }` )
        }

        return struct
    }


    async updateTranscript( { transcriptId, content } ) {
        const struct = { 'status': false, 'messages': [], 'unchanged': false }

        const { status: validStatus, messages: validMessages } = TranscriptRegistry.validateUpdateTranscript( { transcriptId, content } )

        if( !validStatus ) {
            struct[ 'messages' ] = validMessages

            return struct
        }

        if( !this.#transcripts.has( transcriptId ) ) {
            struct[ 'messages' ].push( `TRANSCRIPT-NOTFOUND-001: Transcript not found: ${ transcriptId }` )

            return struct
        }

        const { hasHeader } = TranscriptHeader.detect( { content } )

        if( hasHeader ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-PUT-001: Body must contain only the transcript content, not the header. Header is added server-side.' )

            return struct
        }

        const { status: dupStatus, isDuplicate } = await this.isContentDuplicate( { transcriptId, content } )

        if( dupStatus && isDuplicate ) {
            struct[ 'status' ] = true
            struct[ 'unchanged' ] = true

            return struct
        }

        const transcript = this.#transcripts.get( transcriptId )
        const transcriptsDir = dirname( transcript[ 'absolutePath' ] )
        const { maxRevNumber } = await TranscriptRegistry.#maxRevNumber( { transcriptsDir, 'revisionId': transcript[ 'revisionId' ] } )
        const { status: wrapStatus, messages: wrapMessages, wrappedContent } = TranscriptHeader.wrap( { content, 'type': 'revision', 'memoId': transcript[ 'memoId' ], 'revisionId': transcript[ 'revisionId' ], maxRevNumber } )

        if( !wrapStatus ) {
            struct[ 'messages' ] = wrapMessages

            return struct
        }

        const finalPath = transcript[ 'absolutePath' ]
        const tmpPath = `${ finalPath }.tmp`

        try {
            await writeFile( tmpPath, wrappedContent, 'utf-8' )
            await rename( tmpPath, finalPath )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Atomic write failed: ${ err.message }` )

            return struct
        }

        const fileStat = await stat( finalPath )
        transcript[ 'mtime' ] = fileStat.mtime.toISOString()
        transcript[ 'mtimeMs' ] = fileStat.mtimeMs

        if( this.#onChangeCallback ) {
            this.#onChangeCallback( { transcriptId, 'event': 'transcriptUpdated' } )
        }

        struct[ 'status' ] = true

        return struct
    }


    // PRD-005 (Memo 018 Kap 8): manuelles, rueckgaengig-machbares Einloggen. Das Einloggen
    // bezieht sich auf die REVISION (nicht auf eine einzelne Sequence-Datei): alle Transcripts
    // der Revision werden auf loggedIn: true gesetzt und eine Sidecar-Marke {revisionId}.loggedin
    // wird neben den Transcript-Dateien geschrieben. Idempotent — mehrfaches Einloggen aendert
    // nichts. Unbekannte Revision -> status: false.
    async logInTranscript( { revisionId, memoId } ) {
        const struct = { 'status': false, 'messages': [], 'revisionId': revisionId }

        const { status: validStatus, messages: validMessages, matches, transcriptsDir } = this.#resolveRevisionTranscripts( { revisionId, memoId } )

        if( !validStatus ) {
            struct[ 'messages' ] = validMessages

            return struct
        }

        try {
            const markerPath = resolve( transcriptsDir, `${ revisionId }.loggedin` )
            await writeFile( markerPath, '', 'utf-8' )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Failed to write loggedin marker: ${ err.message }` )

            return struct
        }

        matches.forEach( ( transcript ) => { transcript[ 'loggedIn' ] = true } )

        if( this.#onChangeCallback ) {
            // EVENT-HOOK: transcriptLoggedIn — future: notify agent loop / send notification.
            // Heute wird das Event nur weitergeleitet (WebSocket-Broadcast). Der kuenftige
            // Ausbau (Agent-Aufruf, Notification-Versand) haengt hier an — ohne Architektur-Aenderung.
            this.#onChangeCallback( { revisionId, memoId, 'event': 'transcriptLoggedIn' } )
        }

        struct[ 'status' ] = true

        return struct
    }


    // PRD-005 (Memo 018 Kap 8): Rueckgaengig — setzt loggedIn: false fuer alle Transcripts der
    // Revision und entfernt die Sidecar-Marke. Idempotent: bereits ausgeloggte Revisionen bleiben
    // erfolgreich (status: true), das Entfernen einer fehlenden Marke ist kein Fehler.
    async logOutTranscript( { revisionId, memoId } ) {
        const struct = { 'status': false, 'messages': [], 'revisionId': revisionId }

        const { status: validStatus, messages: validMessages, matches, transcriptsDir } = this.#resolveRevisionTranscripts( { revisionId, memoId } )

        if( !validStatus ) {
            struct[ 'messages' ] = validMessages

            return struct
        }

        const markerPath = resolve( transcriptsDir, `${ revisionId }.loggedin` )

        try {
            await unlink( markerPath )
        } catch ( err ) {
            // Idempotent: a missing marker (already logged out) is not an error.
            if( err.code !== 'ENOENT' ) {
                struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Failed to remove loggedin marker: ${ err.message }` )

                return struct
            }
        }

        matches.forEach( ( transcript ) => { transcript[ 'loggedIn' ] = false } )

        if( this.#onChangeCallback ) {
            // EVENT-HOOK: transcriptLoggedOut — future: notify agent loop / send notification.
            this.#onChangeCallback( { revisionId, memoId, 'event': 'transcriptLoggedOut' } )
        }

        struct[ 'status' ] = true

        return struct
    }


    // PRD-005 (Kap 8): collect all in-memory transcripts belonging to a revision (optionally
    // scoped to a memoId) and resolve the shared transcripts/ directory for the Sidecar-Marke.
    // Returns status: false when revisionId is invalid or no transcript matches.
    #resolveRevisionTranscripts( { revisionId, memoId } ) {
        const struct = { 'status': false, 'messages': [], 'matches': [], 'transcriptsDir': null }

        if( typeof revisionId !== 'string' || revisionId.length === 0 ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: revisionId: Must be a non-empty string' )

            return struct
        }

        const matches = [ ...this.#transcripts.values() ]
            .filter( ( transcript ) => {
                const revMatch = transcript[ 'revisionId' ] === revisionId
                const memoMatch = memoId === undefined || memoId === null || transcript[ 'memoId' ] === memoId

                return revMatch && memoMatch
            } )

        if( matches.length === 0 ) {
            struct[ 'messages' ].push( `TRANSCRIPT-NOTFOUND-001: No transcript found for revision: ${ revisionId }` )

            return struct
        }

        struct[ 'status' ] = true
        struct[ 'matches' ] = matches
        struct[ 'transcriptsDir' ] = dirname( matches[ 0 ][ 'absolutePath' ] )

        return struct
    }


    async isContentDuplicate( { transcriptId, content } ) {
        const struct = { 'status': false, 'messages': [], 'isDuplicate': false }

        if( typeof transcriptId !== 'string' || transcriptId.length === 0 ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: transcriptId: Must be a non-empty string' )

            return struct
        }

        if( typeof content !== 'string' ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: content: Must be a string' )

            return struct
        }

        if( !this.#transcripts.has( transcriptId ) ) {
            struct[ 'messages' ].push( `TRANSCRIPT-NOTFOUND-001: Transcript not found: ${ transcriptId }` )

            return struct
        }

        const transcript = this.#transcripts.get( transcriptId )

        let storedRaw

        try {
            storedRaw = await readFile( transcript[ 'absolutePath' ], 'utf-8' )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-READ-001: Failed to read transcript file: ${ err.message }` )

            return struct
        }

        const { body: storedBody } = TranscriptHeader.stripHeader( { 'content': storedRaw } )
        const { body: incomingBody } = TranscriptHeader.stripHeader( { content } )

        struct[ 'status' ] = true
        struct[ 'isDuplicate' ] = storedBody === incomingBody

        return struct
    }


    async deleteTranscript( { transcriptId } ) {
        const struct = { 'status': false, 'messages': [] }

        if( !this.#transcripts.has( transcriptId ) ) {
            struct[ 'messages' ].push( `TRANSCRIPT-NOTFOUND-001: Transcript not found: ${ transcriptId }` )

            return struct
        }

        const transcript = this.#transcripts.get( transcriptId )

        try {
            await unlink( transcript[ 'absolutePath' ] )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Failed to delete transcript file: ${ err.message }` )

            return struct
        }

        this.#transcripts.delete( transcriptId )

        if( this.#onChangeCallback ) {
            this.#onChangeCallback( { transcriptId, 'event': 'transcriptDeleted' } )
        }

        struct[ 'status' ] = true

        return struct
    }


    listTranscripts( { memoId } ) {
        const list = [ ...this.#transcripts.values() ]
            .filter( ( t ) => {
                const matches = memoId === undefined || t[ 'memoId' ] === memoId

                return matches
            } )
            .map( ( t ) => {
                const entry = {
                    'transcriptId': t[ 'transcriptId' ],
                    'projectId': t[ 'projectId' ],
                    'memoId': t[ 'memoId' ],
                    'revisionId': t[ 'revisionId' ],
                    'sequence': t[ 'sequence' ],
                    'url': t[ 'url' ],
                    // PRD-007/008: memo-bound transcripts are revision-type by construction.
                    'type': t[ 'type' ] || 'revision',
                    // PRD-027 (Kap 12.2): Vollstaendigkeits-Flag pro Eintrag. Default vollstaendig
                    // (echter Transcript). Beim Re-Scan (scanMemo) fehlt das Feld -> als
                    // vollstaendig behandeln, da bestehende Dateien echte Transcripts sind.
                    'complete': t[ 'complete' ] === false ? false : true,
                    // PRD-005 (Kap 8): Einloggen-Zustand pro Eintrag. Fehlt das Feld (Legacy/Re-Scan),
                    // gilt false — bestehende Dateien sind ohne Sidecar nicht eingeloggt.
                    'loggedIn': t[ 'loggedIn' ] === true,
                    'mtime': t[ 'mtime' ]
                }

                return entry
            } )

        list.sort( ( a, b ) => {
            if( a[ 'revisionId' ] !== b[ 'revisionId' ] ) {
                return a[ 'revisionId' ].localeCompare( b[ 'revisionId' ] )
            }

            const seqA = a[ 'sequence' ] ? parseInt( a[ 'sequence' ], 10 ) : 0
            const seqB = b[ 'sequence' ] ? parseInt( b[ 'sequence' ], 10 ) : 0

            return seqA - seqB
        } )

        return { 'transcripts': list }
    }


    async scanMemo( { memoPath, projectId, memoId } ) {
        const struct = { 'status': false, 'messages': [], 'registered': 0 }

        const transcriptsDir = resolve( memoPath, 'transcripts' )

        try {
            await access( transcriptsDir )
        } catch {
            struct[ 'status' ] = true

            return struct
        }

        const files = await readdir( transcriptsDir )
        // PRD-001 (Memo 022): the transcripts/ binding key is the review schema
        // REV-<N>--review--<NN>.md. Group 1 = the DISCUSSED revision, group 2 = the sequence.
        // The old REV_FILE_PATTERN is no longer used here (it stays bound to the revisions/ scan).
        const matches = files
            .map( ( f ) => {
                const match = f.match( REVIEW_FILE_PATTERN )

                if( !match ) { return null }

                const entry = {
                    'fileName': f,
                    'revisionId': `REV-${ match[ 1 ] }`,
                    'sequence': match[ 2 ]
                }

                return entry
            } )
            .filter( ( e ) => e !== null )

        const registrations = await Promise.all(
            matches.map( async ( entry ) => {
                const filePath = resolve( transcriptsDir, entry[ 'fileName' ] )
                const fileStat = await stat( filePath )
                const { url, transcriptId } = TranscriptRegistry.buildUrl( { projectId, memoId, 'revisionId': entry[ 'revisionId' ], 'sequence': entry[ 'sequence' ], 'host': this.#defaultHost } )

                // Legacy-Detection (PRD-003): no auto-migration — only mark the status.
                const fileContent = await readFile( filePath, 'utf-8' )
                const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: fileContent } )

                // PRD-005 (Memo 018 Kap 8): Boot-Rekonstruktion des Einloggen-Zustands. Eine
                // Sidecar-Marke {revisionId}.loggedin neben der Transcript-Datei signalisiert
                // 'eingeloggt'. Fehlt sie, gilt loggedIn === false (Default ohne persistierten Zustand).
                const { loggedIn } = await TranscriptRegistry.#readLoggedInMarker( { transcriptsDir, 'revisionId': entry[ 'revisionId' ] } )

                const transcript = {
                    transcriptId,
                    projectId,
                    memoId,
                    'revisionId': entry[ 'revisionId' ],
                    'sequence': entry[ 'sequence' ],
                    url,
                    'absolutePath': filePath,
                    'mtime': fileStat.mtime.toISOString(),
                    'mtimeMs': fileStat.mtimeMs,
                    // PRD-001 (Memo 019 Kap 1): persist the spoken word count on re-scan too, so
                    // the finalized-memo minutes chip aggregates consistently. ~200 Woerter/Min.
                    'words': TranscriptRegistry.wordCount( { content: fileContent } ).words,
                    schemaVersion,
                    isLegacy,
                    // PRD-027 (Kap 12.2): Re-Scan rekonstruiert das Vollstaendigkeits-Flag als
                    // vollstaendig — bestehende Dateien auf der Platte sind echte Transcripts.
                    // Konsistent mit dem Default "echter Transcript = vollstaendig".
                    'complete': true,
                    loggedIn
                }

                this.#transcripts.set( transcriptId, transcript )

                return { transcriptId }
            } )
        )

        // PRD-003 (Memo 019 Kap 3): re-register FREE memo transcripts (frei--{seq}.md) so they
        // survive a server restart. Kept separate from the REV_FILE_PATTERN scan above — the
        // REV-Erfassung bleibt unveraendert. Free memo transcripts go into the #otherTranscripts
        // map (no revisionId), tagged type 'frei', with a documentId-style transcriptId.
        const freeMatches = files
            .map( ( f ) => {
                const match = f.match( FREE_MEMO_FILE_PATTERN )

                if( !match ) { return null }

                return { 'fileName': f, 'sequence': match[ 1 ] }
            } )
            .filter( ( e ) => e !== null )

        const freeRegistrations = await Promise.all(
            freeMatches.map( async ( entry ) => {
                const filePath = resolve( transcriptsDir, entry[ 'fileName' ] )
                const fileStat = await stat( filePath )
                const transcriptId = `${ projectId }--${ memoId }--frei--${ entry[ 'sequence' ] }`
                const url = `${ this.#defaultHost }/transcripts/${ transcriptId }`

                const fileContent = await readFile( filePath, 'utf-8' )
                const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: fileContent } )
                const { type } = TranscriptHeader.detectType( { content: fileContent } )

                const transcript = {
                    transcriptId,
                    projectId,
                    memoId,
                    'sequence': entry[ 'sequence' ],
                    url,
                    'absolutePath': filePath,
                    'fileName': entry[ 'fileName' ],
                    'type': type || 'frei',
                    'mtime': fileStat.mtime.toISOString(),
                    'mtimeMs': fileStat.mtimeMs,
                    schemaVersion,
                    isLegacy
                }

                this.#otherTranscripts.set( transcriptId, transcript )

                return { transcriptId }
            } )
        )

        // PRD-001 (Memo 022): the Init-Transcript init.md is the very first transcript a memo grew
        // out of. It is NOT feedback to an existing revision, so it is registered SEPARATELY in
        // #otherTranscripts (analog freeMemoTranscript) — type 'memo-init', NO revisionId, NO REV
        // binding. This way init.md never appears as a revision transcript and never skews any
        // revisionStatus (AC-6).
        const initFiles = files
            .map( ( f ) => {
                const match = f.match( INIT_FILE_PATTERN )

                if( !match ) { return null }

                return { 'fileName': f }
            } )
            .filter( ( e ) => e !== null )

        const initRegistrations = await Promise.all(
            initFiles.map( async ( entry ) => {
                const filePath = resolve( transcriptsDir, entry[ 'fileName' ] )
                const fileStat = await stat( filePath )
                const transcriptId = `${ projectId }--${ memoId }--init`
                const url = `${ this.#defaultHost }/transcripts/${ transcriptId }`

                const fileContent = await readFile( filePath, 'utf-8' )
                const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: fileContent } )
                const { type } = TranscriptHeader.detectType( { content: fileContent } )

                const transcript = {
                    transcriptId,
                    projectId,
                    memoId,
                    url,
                    'absolutePath': filePath,
                    'fileName': entry[ 'fileName' ],
                    'type': type || 'memo-init',
                    'mtime': fileStat.mtime.toISOString(),
                    'mtimeMs': fileStat.mtimeMs,
                    schemaVersion,
                    isLegacy
                }

                this.#otherTranscripts.set( transcriptId, transcript )

                return { transcriptId }
            } )
        )

        struct[ 'status' ] = true
        struct[ 'registered' ] = registrations.length + freeRegistrations.length + initRegistrations.length

        return struct
    }


    // "Transcripts" area for transcripts without a memo number (F20: never called "Staging").
    // PRD-007 (Memo 016 Kap 2): files live in {otherRoot}/.memo/transcripts/ next to memos/
    // and plans/. They carry the "frei" type (Phase-1 4-Typen-Modell) in the header.
    // Promote moves them into a real memo on memo-init. Never auto-deleted (Memo 011 Kap 18.6).
    // PRD-002 (Memo 019 Kap 2): optional `type` selects the injected default header. The
    // "Neues Memo erstellen"-Flow passes type: 'memo-init' so the saved transcript carries the
    // memo-init header (KEINE Nummer/kein Ablageort) statt des FREI-Headers — ein einziger,
    // atomarer Schreibvorgang. Default bleibt 'frei' (bewusster, dokumentierter Default).
    async addOtherTranscript( { projectId, content, otherRoot, type } ) {
        const struct = { 'status': false, 'messages': [], 'transcriptId': null, 'url': null, 'absolutePath': null }

        const fields = [
            [ 'projectId', projectId ],
            [ 'content', content ],
            [ 'otherRoot', otherRoot ]
        ]

        fields.forEach( ( [ key, value ] ) => {
            if( value === undefined || value === null ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Missing value` )
            } else if( typeof value !== 'string' ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must be a string` )
            } else if( value.length === 0 ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must not be empty` )
            }
        } )

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        if( !/^[a-zA-Z0-9_-]+$/.test( projectId ) ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: projectId: Must contain only alphanumeric characters, hyphens, and underscores' )

            return struct
        }

        // PRD-002: only the two header types reachable from this area are allowed. Default
        // 'frei' is the bewusster Default vom Memo (Kap 2) — kein stiller ||-Default.
        const transcriptType = ( type === undefined || type === null ) ? 'frei' : type

        if( transcriptType !== 'frei' && transcriptType !== 'memo-init' ) {
            struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: type: Must be one of frei, memo-init (got: ${ transcriptType })` )

            return struct
        }

        const { transcriptsDir } = TranscriptRegistry.#resolveOtherDir( { otherRoot } )

        try {
            await mkdir( transcriptsDir, { recursive: true } )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Failed to create transcripts directory: ${ err.message }` )

            return struct
        }

        const { sequence } = await TranscriptRegistry.#resolveOtherSequence( { transcriptsDir, projectId } )
        const fileName = `${ projectId }--other--${ sequence }.md`
        const finalPath = resolve( transcriptsDir, fileName )
        const tmpPath = `${ finalPath }.tmp`

        // PRD-007: free transcripts without a memo number carry the "frei" type
        // (im-thread, always stored, no memo number / revision / path). The type is
        // written into the header by TranscriptHeader and recovered on scan.
        // PRD-002: the memo-init-Flow injects the memo-init header instead (still no number/path).
        const { status: wrapStatus, messages: wrapMessages, wrappedContent } = TranscriptHeader.wrap( { content, 'type': transcriptType } )

        if( !wrapStatus ) {
            struct[ 'messages' ] = wrapMessages

            return struct
        }

        try {
            await writeFile( tmpPath, wrappedContent, 'utf-8' )
            await rename( tmpPath, finalPath )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Atomic write failed: ${ err.message }` )

            return struct
        }

        const transcriptId = `${ projectId }--other--${ sequence }`
        const url = `${ this.#defaultHost }/transcripts/${ transcriptId }`
        const fileStat = await stat( finalPath )

        const transcript = {
            transcriptId,
            projectId,
            'sequence': sequence,
            url,
            'absolutePath': finalPath,
            'fileName': fileName,
            // PRD-002: persist the actual type ('frei' or 'memo-init') so the registry record
            // matches the injected header.
            'type': transcriptType,
            'mtime': fileStat.mtime.toISOString(),
            'mtimeMs': fileStat.mtimeMs
        }

        this.#otherTranscripts.set( transcriptId, transcript )

        if( this.#onChangeCallback ) {
            this.#onChangeCallback( { transcriptId, 'event': 'otherTranscriptAdded' } )
        }

        struct[ 'status' ] = true
        struct[ 'transcriptId' ] = transcriptId
        struct[ 'url' ] = url
        struct[ 'absolutePath' ] = finalPath

        return struct
    }


    // PRD-003 (Memo 019 Kap 3): "zum Memo hinzufuegen" — write a FREE transcript (type 'frei',
    // FREI-header, NO revision binding, NO memo number) into the transcripts/ folder of an
    // existing memo. Distinct from promoteOtherTranscript (which requires a revisionId and
    // produces a revision-bound REV-XX file). The filename uses the dedicated frei--{seq}
    // pattern so scanMemo (which only registers REV-… files) never misreads it as a revision.
    // Fortlaufend, kollisionsfrei, atomar (tmp -> rename). Mehrfach-Ablagen am selben Memo
    // erhalten eindeutige URLs (Anti-Pattern "gleiche Datei-Namen", memo-toolkit CLAUDE.md).
    async addFreeMemoTranscript( { projectId, memoId, content, memoPath } ) {
        const struct = { 'status': false, 'messages': [], 'transcriptId': null, 'url': null, 'absolutePath': null }

        const fields = [
            [ 'projectId', projectId ],
            [ 'memoId', memoId ],
            [ 'content', content ]
        ]

        fields.forEach( ( [ key, value ] ) => {
            if( value === undefined || value === null ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Missing value` )
            } else if( typeof value !== 'string' ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must be a string` )
            } else if( value.length === 0 ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must not be empty` )
            }
        } )

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        if( !/^[a-zA-Z0-9_-]+$/.test( projectId ) ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: projectId: Must contain only alphanumeric characters, hyphens, and underscores' )

            return struct
        }

        const { transcriptsDir, status: dirStatus, messages: dirMessages } = await this.#resolveTranscriptsDir( { memoId, memoPath } )

        if( !dirStatus ) {
            struct[ 'messages' ] = dirMessages

            return struct
        }

        try {
            await mkdir( transcriptsDir, { recursive: true } )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Failed to create transcripts directory: ${ err.message }` )

            return struct
        }

        const { sequence } = await TranscriptRegistry.#resolveFreeMemoSequence( { transcriptsDir } )
        const fileName = `frei--${ sequence }.md`
        const finalPath = resolve( transcriptsDir, fileName )
        const tmpPath = `${ finalPath }.tmp`

        try {
            await access( finalPath )
            struct[ 'messages' ].push( `TRANSCRIPT-SEQ-001: Target file already exists after sequence resolution: ${ fileName }` )

            return struct
        } catch {
            // not existing — proceed
        }

        // PRD-003 US-2: FREE header (only memo-input-processing, NO revision, NO memo number).
        const { status: wrapStatus, messages: wrapMessages, wrappedContent } = TranscriptHeader.wrap( { content, 'type': 'frei' } )

        if( !wrapStatus ) {
            struct[ 'messages' ] = wrapMessages

            return struct
        }

        try {
            await writeFile( tmpPath, wrappedContent, 'utf-8' )
            await rename( tmpPath, finalPath )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Atomic write failed: ${ err.message }` )

            return struct
        }

        const transcriptId = `${ projectId }--${ memoId }--frei--${ sequence }`
        const url = `${ this.#defaultHost }/transcripts/${ transcriptId }`
        const fileStat = await stat( finalPath )

        const transcript = {
            transcriptId,
            projectId,
            memoId,
            'sequence': sequence,
            url,
            'absolutePath': finalPath,
            'fileName': fileName,
            'type': 'frei',
            'mtime': fileStat.mtime.toISOString(),
            'mtimeMs': fileStat.mtimeMs
        }

        this.#otherTranscripts.set( transcriptId, transcript )

        if( this.#onChangeCallback ) {
            this.#onChangeCallback( { transcriptId, 'event': 'freeMemoTranscriptAdded' } )
        }

        struct[ 'status' ] = true
        struct[ 'transcriptId' ] = transcriptId
        struct[ 'url' ] = url
        struct[ 'absolutePath' ] = finalPath

        return struct
    }


    // PRD-001 (Memo 022): write the Init-Transcript transcripts/init.md — the very first transcript
    // a memo grew out of (memo-erstellen -> REV-01). It is NOT feedback to an existing revision, so
    // it carries the memo-init header (no number, no path, no revision fields) and is NEVER bound to
    // a REV. Fixed filename 'init.md' (one per memo). NO-OVERWRITE: an existing init.md is never
    // overwritten — a status message is returned instead (gleiches Muster wie der access-Check in
    // addTranscript / addFreeMemoTranscript). Goes into #otherTranscripts (no revisionId).
    async addInitTranscript( { projectId, memoId, content, memoPath } ) {
        const struct = { 'status': false, 'messages': [], 'transcriptId': null, 'url': null, 'absolutePath': null }

        const fields = [
            [ 'projectId', projectId ],
            [ 'memoId', memoId ],
            [ 'content', content ]
        ]

        fields.forEach( ( [ key, value ] ) => {
            if( value === undefined || value === null ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Missing value` )
            } else if( typeof value !== 'string' ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must be a string` )
            } else if( value.length === 0 ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must not be empty` )
            }
        } )

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        if( !/^[a-zA-Z0-9_-]+$/.test( projectId ) ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: projectId: Must contain only alphanumeric characters, hyphens, and underscores' )

            return struct
        }

        const { transcriptsDir, status: dirStatus, messages: dirMessages } = await this.#resolveTranscriptsDir( { memoId, memoPath } )

        if( !dirStatus ) {
            struct[ 'messages' ] = dirMessages

            return struct
        }

        try {
            await mkdir( transcriptsDir, { recursive: true } )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Failed to create transcripts directory: ${ err.message }` )

            return struct
        }

        const fileName = 'init.md'
        const finalPath = resolve( transcriptsDir, fileName )
        const tmpPath = `${ finalPath }.tmp`

        // NO-OVERWRITE: never replace an existing init.md (one Init-Transcript per memo).
        try {
            await access( finalPath )
            struct[ 'messages' ].push( `TRANSCRIPT-SEQ-001: Init transcript already exists: ${ fileName }` )

            return struct
        } catch {
            // not existing — proceed
        }

        const { status: wrapStatus, messages: wrapMessages, wrappedContent } = TranscriptHeader.wrap( { content, 'type': 'memo-init' } )

        if( !wrapStatus ) {
            struct[ 'messages' ] = wrapMessages

            return struct
        }

        try {
            await writeFile( tmpPath, wrappedContent, 'utf-8' )
            await rename( tmpPath, finalPath )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Atomic write failed: ${ err.message }` )

            return struct
        }

        const transcriptId = `${ projectId }--${ memoId }--init`
        const url = `${ this.#defaultHost }/transcripts/${ transcriptId }`
        const fileStat = await stat( finalPath )

        const transcript = {
            transcriptId,
            projectId,
            memoId,
            url,
            'absolutePath': finalPath,
            'fileName': fileName,
            'type': 'memo-init',
            'mtime': fileStat.mtime.toISOString(),
            'mtimeMs': fileStat.mtimeMs
        }

        this.#otherTranscripts.set( transcriptId, transcript )

        if( this.#onChangeCallback ) {
            this.#onChangeCallback( { transcriptId, 'event': 'initTranscriptAdded' } )
        }

        struct[ 'status' ] = true
        struct[ 'transcriptId' ] = transcriptId
        struct[ 'url' ] = url
        struct[ 'absolutePath' ] = finalPath

        return struct
    }


    listOtherTranscripts( { otherRoot } ) {
        const list = [ ...this.#otherTranscripts.values() ]
            .filter( ( t ) => {
                if( otherRoot === undefined ) { return true }

                const { transcriptsDir } = TranscriptRegistry.#resolveOtherDir( { otherRoot } )

                return t[ 'absolutePath' ].startsWith( transcriptsDir )
            } )
            .map( ( t ) => {
                const entry = {
                    'transcriptId': t[ 'transcriptId' ],
                    'projectId': t[ 'projectId' ],
                    'sequence': t[ 'sequence' ],
                    'url': t[ 'url' ],
                    'type': t[ 'type' ] || null,
                    'mtime': t[ 'mtime' ]
                }

                return entry
            } )

        list.sort( ( a, b ) => {
            const seqA = a[ 'sequence' ] ? parseInt( a[ 'sequence' ], 10 ) : 0
            const seqB = b[ 'sequence' ] ? parseInt( b[ 'sequence' ], 10 ) : 0

            return seqA - seqB
        } )

        return { 'transcripts': list }
    }


    async scanOther( { otherRoot } ) {
        const struct = { 'status': false, 'messages': [], 'registered': 0 }

        const { transcriptsDir } = TranscriptRegistry.#resolveOtherDir( { otherRoot } )

        try {
            await access( transcriptsDir )
        } catch {
            struct[ 'status' ] = true

            return struct
        }

        const files = await readdir( transcriptsDir )

        // projectId + sequence are recovered from the filename ({projectId}--other--{seq}.md),
        // so the original URL is reconstructable without any external state.
        const matches = files
            .map( ( f ) => {
                const match = f.match( OTHER_FILE_PATTERN )

                if( !match ) { return null }

                return { 'fileName': f, 'projectId': match[ 1 ], 'sequence': match[ 2 ] }
            } )
            .filter( ( e ) => e !== null )

        const registrations = await Promise.all(
            matches.map( async ( entry ) => {
                const filePath = resolve( transcriptsDir, entry[ 'fileName' ] )
                const fileStat = await stat( filePath )
                const projectId = entry[ 'projectId' ]
                const transcriptId = `${ projectId }--other--${ entry[ 'sequence' ] }`
                const url = `${ this.#defaultHost }/transcripts/${ transcriptId }`

                // Legacy-Detection (PRD-003): no auto-migration — only mark the status.
                const fileContent = await readFile( filePath, 'utf-8' )
                const { schemaVersion, isLegacy } = TranscriptHeader.detectSchema( { content: fileContent } )

                // PRD-007: recover the transcript type from the header. Free transcripts
                // carry the "frei" type; a legacy file without a known header yields null.
                const { type } = TranscriptHeader.detectType( { content: fileContent } )

                const transcript = {
                    transcriptId,
                    projectId,
                    'sequence': entry[ 'sequence' ],
                    url,
                    'absolutePath': filePath,
                    'fileName': entry[ 'fileName' ],
                    type,
                    'mtime': fileStat.mtime.toISOString(),
                    'mtimeMs': fileStat.mtimeMs,
                    schemaVersion,
                    isLegacy
                }

                this.#otherTranscripts.set( transcriptId, transcript )

                return { transcriptId }
            } )
        )

        struct[ 'status' ] = true
        struct[ 'registered' ] = registrations.length

        return struct
    }


    async promoteOtherTranscript( { transcriptId, targetMemoPath, memoId, revisionId } ) {
        const struct = { 'status': false, 'messages': [], 'transcriptId': null, 'url': null, 'absolutePath': null }

        const fields = [
            [ 'transcriptId', transcriptId ],
            [ 'targetMemoPath', targetMemoPath ],
            [ 'memoId', memoId ],
            [ 'revisionId', revisionId ]
        ]

        fields.forEach( ( [ key, value ] ) => {
            if( value === undefined || value === null ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Missing value` )
            } else if( typeof value !== 'string' ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must be a string` )
            } else if( value.length === 0 ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must not be empty` )
            }
        } )

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        if( !REVISION_ID_PATTERN.test( revisionId ) ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: revisionId: Must match REV-XX pattern' )

            return struct
        }

        if( !this.#otherTranscripts.has( transcriptId ) ) {
            struct[ 'messages' ].push( `TRANSCRIPT-NOTFOUND-001: Other transcript not found: ${ transcriptId }` )

            return struct
        }

        const other = this.#otherTranscripts.get( transcriptId )
        const projectId = other[ 'projectId' ]

        const absoluteMemo = resolve( targetMemoPath )
        const memoDir = basename( absoluteMemo ) === 'revisions' ? dirname( absoluteMemo ) : absoluteMemo
        const targetDir = resolve( memoDir, 'transcripts' )

        try {
            await mkdir( targetDir, { recursive: true } )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Failed to create transcripts directory: ${ err.message }` )

            return struct
        }

        const { sequence: finalSequence, messages: seqMessages } = await TranscriptRegistry.#resolveSequence( { 'transcriptsDir': targetDir, revisionId, 'requested': undefined } )

        if( seqMessages.length > 0 ) {
            struct[ 'messages' ] = seqMessages

            return struct
        }

        // PRD-001 (Memo 022): same review-Schema as addTranscript. The revisionId is the DISCUSSED
        // revision (Aufrufer-Verantwortung). A sequence is always present; '01' is the documented
        // first sequence (mirrored from #resolveSequence) — kein stiller Default.
        const seqPart = finalSequence ? finalSequence : '01'
        const targetFileName = `${ revisionId }--review--${ seqPart }.md`
        const targetPath = resolve( targetDir, targetFileName )

        try {
            await access( targetPath )
            struct[ 'messages' ].push( `TRANSCRIPT-SEQ-001: Target file already exists after sequence resolution: ${ targetFileName }` )

            return struct
        } catch {
            // not existing — proceed
        }

        // Move (rename), never delete: the file is preserved at the new location.
        try {
            await rename( other[ 'absolutePath' ], targetPath )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Promote move failed: ${ err.message }` )

            return struct
        }

        this.#otherTranscripts.delete( transcriptId )

        const { url, transcriptId: newTranscriptId } = TranscriptRegistry.buildUrl( { projectId, memoId, revisionId, 'sequence': finalSequence, 'host': this.#defaultHost } )
        const fileStat = await stat( targetPath )

        const transcript = {
            'transcriptId': newTranscriptId,
            projectId,
            memoId,
            revisionId,
            'sequence': finalSequence,
            url,
            'absolutePath': targetPath,
            'mtime': fileStat.mtime.toISOString(),
            'mtimeMs': fileStat.mtimeMs
        }

        this.#transcripts.set( newTranscriptId, transcript )

        if( this.#onChangeCallback ) {
            this.#onChangeCallback( { 'transcriptId': newTranscriptId, 'event': 'transcriptPromoted' } )
        }

        struct[ 'status' ] = true
        struct[ 'transcriptId' ] = newTranscriptId
        struct[ 'url' ] = url
        struct[ 'absolutePath' ] = targetPath

        return struct
    }


    // PRD-012 (Memo 016 Kap 5): transform a free ("other") transcript into a memo-init
    // transcript via Re-Injection. The stored type is set to 'memo-init' and the injected
    // header is re-built from the Phase-1 memo-init template (NO memo number, NO storage
    // path, NO revision fields — the location is unknown until memo-init runs, Kap 3).
    // Only frei -> memo-init is supported here. The pure transcript body (after stripHeader)
    // is preserved verbatim. Idempotent: an already memo-init transcript is left unchanged.
    async transformOtherTranscript( { transcriptId, targetType } ) {
        const struct = { 'status': false, 'messages': [], 'transcriptId': null, 'type': null }

        if( typeof transcriptId !== 'string' || transcriptId.length === 0 ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: transcriptId: Must be a non-empty string' )

            return struct
        }

        const resolvedTarget = ( targetType === undefined || targetType === null ) ? 'memo-init' : targetType

        if( resolvedTarget !== 'memo-init' ) {
            struct[ 'messages' ].push( `TRANSCRIPT-TRANSFORM-001: Unsupported target type: ${ resolvedTarget } (only "memo-init" is supported)` )

            return struct
        }

        if( !this.#otherTranscripts.has( transcriptId ) ) {
            struct[ 'messages' ].push( `TRANSCRIPT-NOTFOUND-001: Other transcript not found: ${ transcriptId }` )

            return struct
        }

        const other = this.#otherTranscripts.get( transcriptId )

        let raw

        try {
            raw = await readFile( other[ 'absolutePath' ], 'utf-8' )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-READ-001: Failed to read transcript file: ${ err.message }` )

            return struct
        }

        // Idempotency: if the file already carries the memo-init header, do not re-wrap.
        const { type: currentType } = TranscriptHeader.detectType( { 'content': raw } )

        if( currentType === 'memo-init' ) {
            other[ 'type' ] = 'memo-init'
            struct[ 'status' ] = true
            struct[ 'transcriptId' ] = transcriptId
            struct[ 'type' ] = 'memo-init'

            return struct
        }

        // Re-Injection: strip the current (frei) header, then wrap with the memo-init
        // template. wrap() only injects when no header is present, so stripHeader first.
        const { body } = TranscriptHeader.stripHeader( { 'content': raw } )
        const { status: wrapStatus, messages: wrapMessages, wrappedContent } = TranscriptHeader.wrap( { 'content': body, 'type': 'memo-init' } )

        if( !wrapStatus ) {
            struct[ 'messages' ] = wrapMessages

            return struct
        }

        const finalPath = other[ 'absolutePath' ]
        const tmpPath = `${ finalPath }.tmp`

        try {
            await writeFile( tmpPath, wrappedContent, 'utf-8' )
            await rename( tmpPath, finalPath )
        } catch ( err ) {
            struct[ 'messages' ].push( `TRANSCRIPT-WRITE-001: Atomic write failed: ${ err.message }` )

            return struct
        }

        const fileStat = await stat( finalPath )
        other[ 'type' ] = 'memo-init'
        other[ 'mtime' ] = fileStat.mtime.toISOString()
        other[ 'mtimeMs' ] = fileStat.mtimeMs

        if( this.#onChangeCallback ) {
            this.#onChangeCallback( { transcriptId, 'event': 'transcriptTransformed' } )
        }

        struct[ 'status' ] = true
        struct[ 'transcriptId' ] = transcriptId
        struct[ 'type' ] = 'memo-init'

        return struct
    }


    getTranscriptTree() {
        const tree = {}

        this.#transcripts
            .forEach( ( transcript ) => {
                const projectId = transcript[ 'projectId' ]
                const memoId = transcript[ 'memoId' ]

                if( !tree[ projectId ] ) { tree[ projectId ] = {} }
                if( !tree[ projectId ][ memoId ] ) { tree[ projectId ][ memoId ] = [] }

                tree[ projectId ][ memoId ].push( {
                    'transcriptId': transcript[ 'transcriptId' ],
                    'url': transcript[ 'url' ],
                    'revisionId': transcript[ 'revisionId' ],
                    'sequence': transcript[ 'sequence' ],
                    // PRD-005 (Kap 8): expose the per-revision Einloggen-Zustand to the frontend
                    // tree so the sticky-header status row + Einloggen-button can reflect it.
                    'loggedIn': transcript[ 'loggedIn' ] === true,
                    // PRD-001 (Memo 019 Kap 1): expose the spoken word count so the frontend can
                    // aggregate the finalized-memo minutes chip (~200 Woerter/Min). 0 when unknown.
                    'words': typeof transcript[ 'words' ] === 'number' ? transcript[ 'words' ] : 0,
                    'mtime': transcript[ 'mtime' ] || null
                } )
            } )

        Object.values( tree )
            .forEach( ( memos ) => {
                Object.values( memos )
                    .forEach( ( transcripts ) => {
                        transcripts.sort( ( a, b ) => {
                            if( a[ 'revisionId' ] !== b[ 'revisionId' ] ) {
                                return a[ 'revisionId' ].localeCompare( b[ 'revisionId' ] )
                            }

                            const seqA = a[ 'sequence' ] ? parseInt( a[ 'sequence' ], 10 ) : 0
                            const seqB = b[ 'sequence' ] ? parseInt( b[ 'sequence' ], 10 ) : 0

                            return seqA - seqB
                        } )
                    } )
            } )

        return { tree }
    }


    shutdown() {
        this.#transcripts.clear()
        this.#otherTranscripts.clear()
    }


    // PRD-005 (Memo 018 Kap 8): Boot-Rekonstruktion. Reads the Sidecar-Marke
    // {revisionId}.loggedin. Present -> loggedIn: true. Absent / unreadable -> false
    // (Default ohne persistierten Zustand).
    static async #readLoggedInMarker( { transcriptsDir, revisionId } ) {
        const struct = { 'loggedIn': false }

        try {
            await access( resolve( transcriptsDir, `${ revisionId }.loggedin` ) )
            struct[ 'loggedIn' ] = true
        } catch {
            // no marker -> not logged in
        }

        return struct
    }


    // PRD-007 (Memo 016 Kap 2): free transcripts live directly under .memo/transcripts/
    // — one level flatter, no "other" sub-folder. Breaking change (Kap 2.1, F5): there is
    // NO auto-migration. Existing files under the old .memo/other/transcripts/ are neither
    // moved nor deleted; they simply stop being scanned from the new location.
    static #resolveOtherDir( { otherRoot } ) {
        const base = ( typeof otherRoot === 'string' && otherRoot.length > 0 ) ? resolve( otherRoot ) : resolve( process.cwd() )
        const transcriptsDir = resolve( base, '.memo', 'transcripts' )

        return { transcriptsDir }
    }


    static async #resolveOtherSequence( { transcriptsDir, projectId } ) {
        const struct = { 'sequence': '01' }

        let files = []

        try {
            files = await readdir( transcriptsDir )
        } catch {
            return struct
        }

        // Sequence is per projectId/slug — each named memo gets its own 01, 02, ...
        const matches = files
            .map( ( f ) => f.match( OTHER_FILE_PATTERN ) )
            .filter( ( m ) => m !== null && m[ 1 ] === projectId )
            .map( ( m ) => parseInt( m[ 2 ], 10 ) )

        if( matches.length === 0 ) {
            return struct
        }

        const nextSeq = Math.max( ...matches ) + 1
        struct[ 'sequence' ] = String( nextSeq ).padStart( 2, '0' )

        return struct
    }


    // PRD-003 (Memo 019 Kap 3): resolve the next fortlaufende Sequenz fuer freie Memo-Transcripts
    // im transcripts/-Ordner eines Memos (Muster frei--{seq}.md). Erste Ablage -> 01. Erfasst nur
    // das frei-Muster, sodass REV-…-Dateien die Sequenz nicht beeinflussen.
    static async #resolveFreeMemoSequence( { transcriptsDir } ) {
        const struct = { 'sequence': '01' }

        let files = []

        try {
            files = await readdir( transcriptsDir )
        } catch {
            return struct
        }

        const matches = files
            .map( ( f ) => f.match( FREE_MEMO_FILE_PATTERN ) )
            .filter( ( m ) => m !== null )
            .map( ( m ) => parseInt( m[ 1 ], 10 ) )

        if( matches.length === 0 ) {
            return struct
        }

        const nextSeq = Math.max( ...matches ) + 1
        struct[ 'sequence' ] = String( nextSeq ).padStart( 2, '0' )

        return struct
    }


    // PRD-008: word count for the content-sticky-header (Words/Minutes line 2).
    // Minutes are a derived reading estimate at ~200 words per minute.
    static wordCount( { content } ) {
        const struct = { 'words': 0, 'minutes': 0 }

        if( typeof content !== 'string' || content.length === 0 ) {
            return struct
        }

        const matches = content
            .trim()
            .split( /\s+/ )
            .filter( ( token ) => token.length > 0 )

        struct[ 'words' ] = matches.length
        struct[ 'minutes' ] = matches.length === 0 ? 0 : Math.ceil( matches.length / 200 )

        return struct
    }


    // PRD-001 (Memo 019 Kap 1): aggregate the spoken minutes of ALL transcripts of a memo. Pure,
    // additive, testable. Sums the per-transcript word counts (the 'words' field surfaced in the
    // transcript tree) and converts at ~200 words/minute, reusing the wordCount estimate. With
    // 0 transcripts -> 0 Min (no invented default). Does not read or mutate any transcript file.
    static aggregateMemoMinutes( { transcripts } ) {
        const list = Array.isArray( transcripts ) ? transcripts : []

        const words = list
            .map( ( entry ) => ( entry && typeof entry[ 'words' ] === 'number' && entry[ 'words' ] > 0 ) ? entry[ 'words' ] : 0 )
            .reduce( ( sum, value ) => sum + value, 0 )

        const minutes = words === 0 ? 0 : Math.ceil( words / 200 )

        return { words, minutes }
    }


    static buildUrl( { projectId, memoId, revisionId, sequence, host } ) {
        const hostPart = host || 'http://localhost:3333'
        const seqPart = sequence ? `--${ String( sequence ).padStart( 2, '0' ) }` : ''
        const transcriptId = `${ projectId }--${ memoId }--${ revisionId }${ seqPart }`
        const url = `${ hostPart }/transcripts/${ transcriptId }`

        return { url, transcriptId }
    }


    static buildPlanUrl( { planId, host } ) {
        const struct = { 'status': false, 'messages': [], 'url': null }

        if( typeof planId !== 'string' || planId.length === 0 ) {
            struct[ 'messages' ].push( 'PLAN-URL-001: planId: Must be a non-empty string' )

            return struct
        }

        if( !PLAN_ID_PATTERN.test( planId ) ) {
            struct[ 'messages' ].push( 'PLAN-URL-001: planId: Must match PLAN-\\d{3}-[a-z0-9-]+ pattern' )

            return struct
        }

        const hostPart = ( typeof host === 'string' && host.length > 0 ) ? host : 'http://localhost:3333'

        struct[ 'status' ] = true
        struct[ 'url' ] = `${ hostPart }/plans/${ planId }`

        return struct
    }


    static parseTranscriptId( { transcriptId } ) {
        const struct = { 'status': false, 'messages': [], 'projectId': null, 'memoId': null, 'revisionId': null, 'sequence': null }

        if( typeof transcriptId !== 'string' || transcriptId.length === 0 ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-ID-001: transcriptId must be a non-empty string' )

            return struct
        }

        const parts = transcriptId.split( '--' )

        if( parts.length < 3 ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-ID-001: Invalid transcriptId format (expected projectId--memoId--REV-XX[--NN])' )

            return struct
        }

        const lastPart = parts[ parts.length - 1 ]
        const secondLastPart = parts[ parts.length - 2 ]
        let revisionId = null
        let sequence = null
        let memoEndIndex = parts.length - 1

        if( /^\d+$/.test( lastPart ) && /^REV-\d+$/.test( secondLastPart ) ) {
            revisionId = secondLastPart
            sequence = lastPart
            memoEndIndex = parts.length - 2
        } else if( /^REV-\d+$/.test( lastPart ) ) {
            revisionId = lastPart
            memoEndIndex = parts.length - 1
        } else {
            struct[ 'messages' ].push( 'TRANSCRIPT-ID-001: Invalid transcriptId format (revisionId missing or malformed)' )

            return struct
        }

        const projectId = parts[ 0 ]
        const memoId = parts.slice( 1, memoEndIndex ).join( '--' )

        if( projectId.length === 0 || memoId.length === 0 ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-ID-001: Invalid transcriptId format (projectId or memoId empty)' )

            return struct
        }

        struct[ 'status' ] = true
        struct[ 'projectId' ] = projectId
        struct[ 'memoId' ] = memoId
        struct[ 'revisionId' ] = revisionId
        struct[ 'sequence' ] = sequence

        return struct
    }


    static validateAddTranscript( { projectId, memoId, revisionId, content } ) {
        const struct = { 'status': false, 'messages': [] }

        const fields = [
            [ 'projectId', projectId, 'string', null ],
            [ 'memoId', memoId, 'string', null ],
            [ 'revisionId', revisionId, 'string', null ],
            [ 'content', content, 'string', null ]
        ]

        fields.forEach( ( [ key, value, type ] ) => {
            if( value === undefined || value === null ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Missing value` )
            } else if( typeof value !== type ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must be a ${ type }` )
            } else if( type === 'string' && value.length === 0 ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must not be empty` )
            }
        } )

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        if( !REVISION_ID_PATTERN.test( revisionId ) ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: revisionId: Must match REV-XX pattern' )

            return struct
        }

        if( !/^[a-zA-Z0-9_-]+$/.test( projectId ) ) {
            struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: projectId: Must contain only alphanumeric characters, hyphens, and underscores' )

            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validateUpdateTranscript( { transcriptId, content } ) {
        const struct = { 'status': false, 'messages': [] }

        const fields = [
            [ 'transcriptId', transcriptId, 'string' ],
            [ 'content', content, 'string' ]
        ]

        fields.forEach( ( [ key, value, type ] ) => {
            if( value === undefined || value === null ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Missing value` )
            } else if( typeof value !== type ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must be a ${ type }` )
            } else if( type === 'string' && value.length === 0 ) {
                struct[ 'messages' ].push( `TRANSCRIPT-VAL-001: ${ key }: Must not be empty` )
            }
        } )

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    async #resolveTranscriptsDir( { memoId, memoPath } ) {
        const struct = { 'status': false, 'messages': [], 'transcriptsDir': null }

        if( memoPath && typeof memoPath === 'string' && memoPath.length > 0 ) {
            const absoluteMemo = resolve( memoPath )
            const memoDir = basename( absoluteMemo ) === 'revisions'
                ? dirname( absoluteMemo )
                : absoluteMemo
            struct[ 'transcriptsDir' ] = resolve( memoDir, 'transcripts' )
            struct[ 'status' ] = true

            return struct
        }

        const cwdBase = resolve( process.cwd(), '.memo', 'memos', memoId )
        struct[ 'transcriptsDir' ] = resolve( cwdBase, 'transcripts' )
        struct[ 'status' ] = true

        return struct
    }


    // Determines the highest existing REV number for next=max+1 (PRD-002).
    // Authoritative source is the memo's revisions/ bestand (sibling of transcripts/);
    // the transcripts/ dir is scanned as a fallback. The passed revisionId is the last
    // resort so legacy callers without any bestand still get a sensible number.
    static async #maxRevNumber( { transcriptsDir, revisionId } ) {
        const struct = { 'maxRevNumber': null }

        const revisionsDir = resolve( dirname( transcriptsDir ), 'revisions' )

        const dirNumbers = await Promise.all(
            [ revisionsDir, transcriptsDir ].map( ( dir ) => TranscriptRegistry.#scanRevNumbers( { dir } ) )
        )

        const numbers = dirNumbers
            .flatMap( ( result ) => result[ 'numbers' ] )

        if( numbers.length > 0 ) {
            struct[ 'maxRevNumber' ] = Math.max( ...numbers )

            return struct
        }

        if( typeof revisionId === 'string' ) {
            const revMatch = revisionId.match( /^REV-(\d+)$/ )

            if( revMatch !== null ) {
                struct[ 'maxRevNumber' ] = parseInt( revMatch[ 1 ], 10 )
            }
        }

        return struct
    }


    static async #scanRevNumbers( { dir } ) {
        const struct = { 'numbers': [] }

        let files = []

        try {
            files = await readdir( dir )
        } catch {
            return struct
        }

        struct[ 'numbers' ] = files
            .map( ( f ) => f.match( REV_FILE_PATTERN ) )
            .filter( ( m ) => m !== null )
            .map( ( m ) => parseInt( m[ 1 ], 10 ) )

        return struct
    }


    static async #resolveSequence( { transcriptsDir, revisionId, requested } ) {
        const struct = { 'sequence': null, 'messages': [] }

        if( requested !== undefined && requested !== null ) {
            const num = parseInt( requested, 10 )

            if( isNaN( num ) || num < 1 ) {
                struct[ 'messages' ].push( 'TRANSCRIPT-VAL-001: sequence: Must be a positive number' )

                return struct
            }

            struct[ 'sequence' ] = String( num ).padStart( 2, '0' )

            return struct
        }

        let files = []

        try {
            files = await readdir( transcriptsDir )
        } catch {
            // PRD-001 (Memo 022): no transcripts/ dir yet -> first review of this revision -> '01'
            // (analog #resolveFreeMemoSequence). The review schema always carries a sequence.
            struct[ 'sequence' ] = '01'

            return struct
        }

        // PRD-001 (Memo 022): review-Schema REV-<N>--review--<NN>.md. Match only THIS revision's
        // reviews; group 1 is always present. First review of the revision -> '01'.
        const pattern = new RegExp( `^${ revisionId }--review--(\\d+)\\.md$` )
        const matches = files
            .map( ( f ) => f.match( pattern ) )
            .filter( ( m ) => m !== null )
            .map( ( m ) => parseInt( m[ 1 ], 10 ) )

        if( matches.length === 0 ) {
            struct[ 'sequence' ] = '01'

            return struct
        }

        const nextSeq = Math.max( ...matches ) + 1
        struct[ 'sequence' ] = String( nextSeq ).padStart( 2, '0' )

        return struct
    }
}


export { TranscriptRegistry }
