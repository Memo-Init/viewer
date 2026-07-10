import { readdir, readFile, access, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'
import { VALID_OPTION_KINDS } from './QuestionContract.mjs'


const LATEST_LIMIT = 5
// PRD-004 (Memo 024 Kap 4, F3=A): the memo status is a full lifecycle now. The ordered
// lifecycle is Entwurf -> In Bearbeitung -> Finalisiert -> Abgeschlossen; 'Bedingt finalisiert'
// is a SONDERFALL that sits next to 'Finalisiert' (conditionally finalized, not a 5th rung on the
// ladder). MEMO_STATUS_VALUES = every value parseStatus accepts (the 4 ordered + the Sonderfall).
// MEMO_STATUS_LIFECYCLE = the ordered ladder only, for sort/display logic in PRD-005/006.
const MEMO_STATUS_LIFECYCLE = [ 'Entwurf', 'In Bearbeitung', 'Finalisiert', 'Abgeschlossen' ]
const MEMO_STATUS_VALUES = [ 'Entwurf', 'In Bearbeitung', 'Finalisiert', 'Abgeschlossen', 'Bedingt finalisiert' ]
const MEMO_STATUS_DEFAULT = 'Entwurf'
// PRD-001 (Memo 018 Kap 4, F2=A): the three revision-level status values. The revision is
// the SINGLE source of truth (F7=A); memo- and namespace-status are DERIVED from it.
const REVISION_STATUS_VALUES = [ 'offen', 'transcript-eingetragen', 'eingeloggt' ]
const REVISION_STATUS_DEFAULT = 'offen'


class DocumentRegistry {
    #documents = new Map()
    #watchers = new Map()
    #onChangeCallback = null


    static create( { onChange } ) {
        const registry = new DocumentRegistry()
        registry.#onChangeCallback = onChange || null

        return { registry }
    }


    async addDocument( { projectId, memoPath } ) {
        const struct = { 'status': false, 'messages': [], 'documentId': null, 'revisionsFound': 0 }

        const { status: validStatus, messages: validMessages } = DocumentRegistry.validateAddDocument( { projectId, memoPath } )

        if( !validStatus ) {
            struct['messages'] = validMessages

            return struct
        }

        const absolutePath = resolve( memoPath )

        try {
            await access( absolutePath )
        } catch {
            struct['messages'].push( `memoPath: Path not found: ${absolutePath}` )

            return struct
        }

        const pathStat = await stat( absolutePath )

        if( !pathStat.isDirectory() ) {
            struct['messages'].push( 'memoPath: Must be a directory' )

            return struct
        }

        const { revisions } = await DocumentRegistry.#scanRevisions( { dirPath: absolutePath } )

        const memoName = DocumentRegistry.#extractMemoName( { dirPath: absolutePath } )
        const documentId = `${projectId}--${memoName}`
        const { documentKind } = DocumentRegistry.#detectDocumentKind( { absolutePath } )

        if( this.#documents.has( documentId ) ) {
            const existing = this.#documents.get( documentId )
            existing['revisions'] = revisions
            existing['documentKind'] = documentKind

            await this.#refreshParsedFields( { documentId } )

            struct['status'] = true
            struct['documentId'] = documentId
            struct['revisionsFound'] = revisions.length

            return struct
        }

        const document = {
            documentId,
            projectId,
            memoName,
            'memoPath': absolutePath,
            documentKind,
            revisions,
            'status': 'open',
            'memoStatus': MEMO_STATUS_DEFAULT,
            'questions': { 'open': 0, 'answered': 0 },
            'selectedRevision': null
        }

        this.#documents.set( documentId, document )

        await this.#refreshParsedFields( { documentId } )

        const { watcher } = this.#startDirectoryWatcher( { documentId, dirPath: absolutePath } )
        this.#watchers.set( documentId, watcher )

        struct['status'] = true
        struct['documentId'] = documentId
        struct['revisionsFound'] = revisions.length

        return struct
    }


    async getLatestRevision( { documentId } ) {
        // Memo 041 Teil B (Kap 11): read the content of the youngest revision of a registered memo so
        // the POST /api/documents door-gate can validate it. #scanRevisions sorts newest-first, so
        // revisions[0] is the latest. Never throws — a missing document or unreadable file returns
        // found:false and the caller simply skips the validation gate (fail-open, never blocks).
        const struct = { 'found': false, 'content': '', 'fileName': '' }

        const document = this.#documents.get( documentId )
        if( document === undefined ) { return struct }

        const revisions = Array.isArray( document[ 'revisions' ] ) ? document[ 'revisions' ] : []
        if( revisions.length === 0 ) { return struct }

        const latest = revisions[ 0 ]

        try {
            const content = await readFile( latest[ 'absolutePath' ], 'utf-8' )
            struct[ 'found' ] = true
            struct[ 'content' ] = content
            struct[ 'fileName' ] = latest[ 'fileName' ]
        } catch {
            return struct
        }

        return struct
    }


    removeDocument( { documentId } ) {
        const struct = { 'status': false, 'messages': [] }

        if( !this.#documents.has( documentId ) ) {
            struct['messages'].push( `documentId: Not found: ${documentId}` )

            return struct
        }

        this.#documents.delete( documentId )

        if( this.#watchers.has( documentId ) ) {
            this.#watchers.get( documentId ).close()
            this.#watchers.delete( documentId )
        }

        struct['status'] = true

        return struct
    }


    getDocuments() {
        const documents = [ ...this.#documents.values() ]
            .map( ( doc ) => {
                const revisions = ( doc['revisions'] || [] )
                    .map( ( r ) => {
                        return {
                            'fileName': r['fileName'],
                            'mtime': r['mtime'] || null,
                            'mtimeMs': r['mtimeMs'] || 0,
                            'sizeKb': r['sizeKb'] || 0,
                            'revisionType': r['revisionType'] || null,
                            // PRD-001 (Memo 018 Kap 4): surface the revision-level status so the
                            // sidebar reads revisionStatus instead of re-deriving from transcripts.
                            'revisionStatus': r['revisionStatus'] || REVISION_STATUS_DEFAULT,
                            // PRD-007 (Memo 018 Kap 10): surface the legacy flag so the sidebar can
                            // render the "alte Version" marker. Without this the field set in
                            // #scanRevisions never reached the frontend.
                            'isLegacy': r['isLegacy'] === true,
                            'parseError': r['parseError'] === true
                        }
                    } )

                const result = {
                    'documentId': doc['documentId'],
                    'projectId': doc['projectId'],
                    'memoName': doc['memoName'],
                    'memoPath': doc['memoPath'],
                    'documentKind': doc['documentKind'] || 'memo',
                    'status': doc['status'],
                    'memoStatus': doc['memoStatus'] || MEMO_STATUS_DEFAULT,
                    'questions': doc['questions'] || { 'open': 0, 'answered': 0 },
                    'revisionCount': revisions.length,
                    'selectedRevision': doc['selectedRevision'],
                    'revisions': revisions
                }

                return result
            } )

        return { documents }
    }


    getDocument( { documentId } ) {
        const struct = { 'status': false, 'messages': [], 'document': null }

        if( !this.#documents.has( documentId ) ) {
            struct['messages'].push( `documentId: Not found: ${documentId}` )

            return struct
        }

        struct['status'] = true
        struct['document'] = this.#documents.get( documentId )

        return struct
    }


    getDocumentTree() {
        const tree = {}

        this.#documents
            .forEach( ( doc ) => {
                const projectId = doc['projectId']

                if( !tree[ projectId ] ) {
                    tree[ projectId ] = { 'memos': [], 'plans': [] }
                }

                const mappedRevisions = doc['revisions']
                    .map( ( r ) => {
                        const result = {
                            'fileName': r['fileName'],
                            'mtime': r['mtime'] || null,
                            // PRD-016/017: epoch-ms timestamp surfaced to the frontend so the
                            // sidebar can FIFO-sort the queue (oldest first) and the memo list
                            // newest-first without re-deriving time from the formatted string.
                            'mtimeMs': r['mtimeMs'] || null,
                            'sizeKb': r['sizeKb'] || null,
                            'revisionType': r['revisionType'] || 'full',
                            // PRD-001 (Memo 018 Kap 4): revision-level status surfaced to the
                            // frontend so all display layers (sidebar, queue, ball) read this
                            // single field instead of running their own transcript/status heuristics.
                            'revisionStatus': r['revisionStatus'] || REVISION_STATUS_DEFAULT,
                            // PRD-007 (Memo 018 Kap 10): surface the legacy flag so renderRevEntry
                            // can show the "alte Version" badge. Field originates in #scanRevisions.
                            'isLegacy': r['isLegacy'] === true,
                            'parseError': r['parseError'] === true
                        }

                        return result
                    } )

                const entry = {
                    'documentId': doc['documentId'],
                    // PRD-007 (Memo 019 Kap 7): the Queue-Item info model needs the namespace
                    // (projectId) ON each memo entry so a flat queue item can render
                    // "folder · Namespace · Datum". Previously only the tree KEY carried it,
                    // leaving doc.projectId undefined in computeQueue/renderQueueEntry.
                    'projectId': doc['projectId'],
                    'memoName': doc['memoName'],
                    // PRD-042 (Memo 016 Kap 3): absolute memo path surfaced to the frontend so the
                    // Plan-Start step can resolve selected documentIds to absolute paths for the
                    // injected memo-plan-init/memo-plan-add prompt (no invented/relative paths).
                    'memoPath': doc['memoPath'],
                    'documentKind': doc['documentKind'] || 'memo',
                    'status': doc['status'],
                    'memoStatus': doc['memoStatus'] || MEMO_STATUS_DEFAULT,
                    'questions': doc['questions'] || { 'open': 0, 'answered': 0 },
                    'revisionCount': doc['revisions'].length,
                    'selectedRevision': doc['selectedRevision'],
                    // PRD-016/017: memo-level activity timestamp = the newest revision mtime.
                    // null when no revision carries an mtime (no Silent-Default on invented time).
                    'latestMtimeMs': DocumentRegistry.#latestMtimeMs( { revisions: mappedRevisions } ),
                    'revisions': mappedRevisions
                }

                const bucket = entry['documentKind'] === 'plan' ? 'plans' : 'memos'
                tree[ projectId ][ bucket ].push( entry )
            } )

        // PRD-017 (Memo 016 Kap 6.2): the Memos list is sorted NEWEST ON TOP (most recent
        // activity first). This is the deliberate counterpart to the Queue's FIFO (oldest
        // on top) order — do not conflate the two. Plans buckets stay untouched.
        Object.keys( tree )
            .forEach( ( projectId ) => {
                const { sorted } = DocumentRegistry.sortMemosByNewest( { memos: tree[ projectId ]['memos'] } )
                tree[ projectId ]['memos'] = sorted
            } )

        const { latest } = this.getLatestRevisions( { limit: LATEST_LIMIT } )

        return { tree, latest }
    }


    // PRD-016/017: newest revision mtime of a memo = its activity timestamp. Returns null
    // when no revision has an mtimeMs (the memo then keeps its stable position, no reorder).
    static #latestMtimeMs( { revisions } ) {
        const stamps = ( Array.isArray( revisions ) ? revisions : [] )
            .map( ( r ) => r['mtimeMs'] )
            .filter( ( ms ) => typeof ms === 'number' )

        if( stamps.length === 0 ) { return null }

        return Math.max( ...stamps )
    }


    // PRD-017 (Memo 016 Kap 6.2): sort a memos bucket NEWEST ON TOP by latestMtimeMs (desc).
    // Entries without a timestamp keep their relative order (stable sort, no invented default).
    static sortMemosByNewest( { memos } ) {
        const list = Array.isArray( memos ) ? [ ...memos ] : []

        const sorted = list
            .sort( ( a, b ) => {
                const aMs = typeof a['latestMtimeMs'] === 'number' ? a['latestMtimeMs'] : null
                const bMs = typeof b['latestMtimeMs'] === 'number' ? b['latestMtimeMs'] : null

                if( aMs === null && bMs === null ) { return 0 }
                if( aMs === null ) { return 1 }
                if( bMs === null ) { return -1 }

                return bMs - aMs
            } )

        return { sorted }
    }


    getOpenFinalizedMemos( { projectId } ) {
        const memos = [ ...this.#documents.values() ]
            .filter( ( doc ) => {
                const isMemo = ( doc[ 'documentKind' ] || 'memo' ) === 'memo'
                const isFinalized = ( doc[ 'memoStatus' ] || MEMO_STATUS_DEFAULT ) === 'Finalisiert'
                const namespaceMatch = projectId === undefined || doc[ 'projectId' ] === projectId

                return isMemo && isFinalized && namespaceMatch
            } )
            .map( ( doc ) => {
                const entry = {
                    'documentId': doc[ 'documentId' ],
                    'projectId': doc[ 'projectId' ],
                    'memoName': doc[ 'memoName' ],
                    'memoStatus': doc[ 'memoStatus' ] || MEMO_STATUS_DEFAULT
                }

                return entry
            } )

        return { memos }
    }


    getLatestRevisions( { limit } ) {
        const all = []

        this.#documents
            .forEach( ( doc ) => {
                doc['revisions']
                    .forEach( ( r ) => {
                        const entry = {
                            'documentId': doc['documentId'],
                            'projectId': doc['projectId'],
                            'memoName': doc['memoName'],
                            'fileName': r['fileName'],
                            'mtime': r['mtime'] || null,
                            'mtimeMs': r['mtimeMs'] || 0,
                            'sizeKb': r['sizeKb'] || null,
                            'revisionType': r['revisionType'] || 'full'
                        }

                        all.push( entry )
                    } )
            } )

        const filtered = all
            .filter( ( r ) => r['revisionType'] === 'full' || r['revisionType'] === 'update' )

        filtered.sort( ( a, b ) => b['mtimeMs'] - a['mtimeMs'] )

        const latest = filtered.slice( 0, limit )

        return { latest }
    }


    selectRevision( { documentId, fileName } ) {
        const struct = { 'status': false, 'messages': [] }

        if( !this.#documents.has( documentId ) ) {
            struct['messages'].push( `documentId: Not found: ${documentId}` )

            return struct
        }

        const doc = this.#documents.get( documentId )
        const revisionExists = doc['revisions']
            .some( ( r ) => r['fileName'] === fileName )

        if( !revisionExists ) {
            struct['messages'].push( `fileName: Revision not found: ${fileName}` )

            return struct
        }

        this.#documents
            .forEach( ( otherDoc, otherDocumentId ) => {
                if( otherDocumentId !== documentId ) {
                    otherDoc['selectedRevision'] = null
                }
            } )

        doc['selectedRevision'] = fileName
        struct['status'] = true

        return struct
    }


    getSelectedRevisionPath( { documentId } ) {
        const struct = { 'status': false, 'absolutePath': null }

        if( !this.#documents.has( documentId ) ) {
            return struct
        }

        const doc = this.#documents.get( documentId )

        if( !doc['selectedRevision'] ) {
            return struct
        }

        struct['status'] = true
        struct['absolutePath'] = resolve( doc['memoPath'], doc['selectedRevision'] )

        return struct
    }


    setDocumentStatus( { documentId, newStatus } ) {
        const struct = { 'status': false, 'messages': [] }
        const allowedStatuses = [ 'open', 'done', 'delete' ]

        if( !this.#documents.has( documentId ) ) {
            struct['messages'].push( `documentId: Not found: ${documentId}` )

            return struct
        }

        if( !allowedStatuses.includes( newStatus ) ) {
            struct['messages'].push( `newStatus: Must be one of: ${allowedStatuses.join( ', ' )}` )

            return struct
        }

        const doc = this.#documents.get( documentId )
        doc['status'] = newStatus
        struct['status'] = true

        return struct
    }


    shutdown() {
        this.#watchers
            .forEach( ( watcher ) => {
                watcher.close()
            } )

        this.#watchers.clear()
        this.#documents.clear()
    }


    static validateAddDocument( { projectId, memoPath } ) {
        const struct = { 'status': false, 'messages': [] }

        if( projectId === undefined ) {
            struct['messages'].push( 'projectId: Missing value' )
        } else if( typeof projectId !== 'string' ) {
            struct['messages'].push( 'projectId: Must be a string' )
        } else if( projectId.trim().length === 0 ) {
            struct['messages'].push( 'projectId: Must not be empty' )
        } else if( !/^[a-zA-Z0-9_-]+$/.test( projectId ) ) {
            struct['messages'].push( 'projectId: Must contain only alphanumeric characters, hyphens, and underscores' )
        }

        if( memoPath === undefined ) {
            struct['messages'].push( 'memoPath: Missing value' )
        } else if( typeof memoPath !== 'string' ) {
            struct['messages'].push( 'memoPath: Must be a string' )
        } else if( memoPath.trim().length === 0 ) {
            struct['messages'].push( 'memoPath: Must not be empty' )
        }

        if( struct['messages'].length > 0 ) {
            return struct
        }

        struct['status'] = true

        return struct
    }


    static parseStatus( { content } ) {
        const struct = { 'memoStatus': MEMO_STATUS_DEFAULT }

        if( typeof content !== 'string' || content.length === 0 ) {
            return struct
        }

        const lines = content.split( '\n' )
        const statusLine = lines
            .find( ( line ) => /^\s*\|\s*\*\*Status\*\*\s*\|/.test( line ) )

        if( statusLine === undefined ) {
            return struct
        }

        const cells = statusLine
            .split( '|' )
            .map( ( cell ) => cell.trim() )
            .filter( ( cell ) => cell.length > 0 )

        const rawValue = cells.length >= 2 ? cells[ 1 ] : ''
        const matched = MEMO_STATUS_VALUES
            .find( ( allowed ) => allowed.toLowerCase() === rawValue.toLowerCase() )

        if( matched !== undefined ) {
            struct[ 'memoStatus' ] = matched
        }

        return struct
    }


    // PRD-004 (Memo 024 Kap 4): expose the memo-status enum, the ordered lifecycle ladder and the
    // default so display/sort layers (PRD-005/006) read the model without reaching into the
    // module-private constants. Returns copies, never the shared array references.
    static getMemoStatusValues() {
        return {
            'values': [ ...MEMO_STATUS_VALUES ],
            'lifecycle': [ ...MEMO_STATUS_LIFECYCLE ],
            'default': MEMO_STATUS_DEFAULT
        }
    }


    // PRD-004 (Memo 024 Kap 4, F3=A): derive the full LIFECYCLE status of a memo. The lifecycle is
    //   Entwurf -> In Bearbeitung -> Finalisiert -> Abgeschlossen   (+ Sonderfall Bedingt finalisiert).
    //
    // Ableitungs-Reihenfolge / Priorität (im Code dokumentiert, AC PRD-004):
    //   1. ABGESCHLOSSEN hat HÖCHSTE Priorität und kommt NICHT aus dem Frontmatter, sondern aus der
    //      externen Plan-/Rollout-Status-Quelle (planCompleted === true). Ein Memo gilt als
    //      abgeschlossen, sobald sein zugehöriger Plan/Rollout abgeschlossen ist — selbst wenn das
    //      Frontmatter noch 'Finalisiert' zeigt. (HINWEIS/ANNAHME: PlanRegistry speichert heute nur
    //      Plan-Pfade, KEINEN Abschluss-Status. planCompleted ist daher ein additiver Hook —
    //      solange keine Quelle planCompleted=true liefert, wird 'Abgeschlossen' nie abgeleitet und
    //      das Verhalten bleibt unverändert rückwärtskompatibel.)
    //   2. Sonst gewinnt der FRONTMATTER-Status für die ersten Stufen + den Sonderfall:
    //      'Finalisiert' / 'Bedingt finalisiert' / 'In Bearbeitung' werden 1:1 übernommen.
    //   3. Sonst HEURISTIK 'In Bearbeitung': ein nicht-finalisiertes Memo mit mehr als einer
    //      Revision (revisionCount > 1) gilt als in Bearbeitung. Das Frontmatter darf diese
    //      Heuristik überschreiben (Schritt 2 läuft vorher).
    //   4. Sonst Default 'Entwurf' (kein erfundener Default).
    static deriveLifecycleStatus( { frontmatterStatus, revisionCount, planCompleted } = {} ) {
        const struct = { 'memoStatus': MEMO_STATUS_DEFAULT }

        // 1. Plan-/Rollout-Quelle gewinnt — höchste Priorität, NICHT frontmatter-basiert.
        if( planCompleted === true ) {
            struct[ 'memoStatus' ] = 'Abgeschlossen'

            return struct
        }

        // 2. Frontmatter-Status für Finalisiert / Bedingt finalisiert / In Bearbeitung.
        const carriedOver = [ 'Finalisiert', 'Bedingt finalisiert', 'In Bearbeitung' ]
            .find( ( allowed ) => allowed === frontmatterStatus )

        if( carriedOver !== undefined ) {
            struct[ 'memoStatus' ] = carriedOver

            return struct
        }

        // 3. Heuristik: nicht-finalisiert + mehr als eine Revision -> In Bearbeitung.
        const count = typeof revisionCount === 'number' && revisionCount > 0 ? revisionCount : 0

        if( count > 1 ) {
            struct[ 'memoStatus' ] = 'In Bearbeitung'

            return struct
        }

        // 4. Default.
        return struct
    }


    // PRD-001 (Memo 018 Kap 4): expose the revision-status enum + default so the model is
    // verifiable without reaching into module-private constants. Returns copies, never the
    // shared array reference.
    static getRevisionStatusValues() {
        return { 'values': [ ...REVISION_STATUS_VALUES ], 'default': REVISION_STATUS_DEFAULT }
    }


    // PRD-001 (Memo 018 Kap 4, F2=A): derive a single revision's status from its transcript
    // facts. No transcript -> 'offen'; transcript present but not logged -> 'transcript-eingetragen';
    // transcript manually logged -> 'eingeloggt'. This is the only place the enum transitions are
    // decided — display layers read the resulting revisionStatus, never re-derive it (AC-17).
    static deriveRevisionStatus( { hasTranscript, isLoggedIn } ) {
        if( isLoggedIn === true ) {
            return { 'revisionStatus': 'eingeloggt' }
        }

        if( hasTranscript === true ) {
            return { 'revisionStatus': 'transcript-eingetragen' }
        }

        return { 'revisionStatus': REVISION_STATUS_DEFAULT }
    }


    // PRD-001 (Memo 018 Kap 4): aggregate the memo status from its revisions (Vererbung nach
    // oben). memoFinalized wins as a special state; otherwise the memo is 'offen' if AT LEAST
    // ONE revision is 'offen', else 'geschlossen'. The revision stays the single source of truth.
    static deriveMemoStatus( { revisions, memoFinalized } ) {
        if( memoFinalized === true ) {
            return { 'memoStatus': 'finalisiert' }
        }

        const list = Array.isArray( revisions ) ? revisions : []
        const hasOpen = list
            .some( ( revision ) => ( revision && revision[ 'revisionStatus' ] ) === 'offen' )

        return { 'memoStatus': hasOpen ? 'offen' : 'geschlossen' }
    }


    // PRD-001 (Memo 018 Kap 4): aggregate the namespace status from its memos. A namespace is
    // 'offen' if AT LEAST ONE memo is 'offen', else 'geschlossen' (Vererbung nach oben).
    static deriveNamespaceStatus( { memos } ) {
        const list = Array.isArray( memos ) ? memos : []
        const hasOpen = list
            .some( ( memo ) => ( memo && memo[ 'memoStatus' ] ) === 'offen' )

        return { 'namespaceStatus': hasOpen ? 'offen' : 'geschlossen' }
    }


    // PRD-001 (Memo 019 Kap 1, geschaerft): the Warteschlangen-Regel = an UNFINISHED, NON-legacy
    // revision. A revision belongs to the queue while its transcript is NOT yet logged in: both
    // 'offen' (no transcript) and 'transcript-eingetragen' (transcript present, not logged) stay
    // in the queue. ONLY 'eingeloggt' (= abgeschlossen) drops out. Legacy/parseError revisions
    // stay visible in the namespace tree but never produce queue noise ("alte Version" entries).
    // Prepare-Revisionen (REV-XX-prepare.md, revisionType 'prepare') sind reine Pre-Revision-
    // Reflexion (Basis-Snapshot) und gehoeren NIE in die Warteschlange — sie sind kein offener
    // Transcript-Job, sondern ein Hilfsartefakt aus memo-revision-generate.
    static isInQueue( { revision } ) {
        if( !revision || typeof revision !== 'object' ) {
            return { 'inQueue': false }
        }

        const status = revision[ 'revisionStatus' ] || null
        const isLegacy = revision[ 'isLegacy' ] === true
        const parseError = revision[ 'parseError' ] === true
        const isPrepare = revision[ 'revisionType' ] === 'prepare'

        return { 'inQueue': status !== 'eingeloggt' && !isLegacy && !parseError && !isPrepare }
    }


    static parseQuestions( { content } ) {
        const struct = { 'openCount': 0, 'answeredCount': 0 }

        if( typeof content !== 'string' || content.length === 0 ) {
            return struct
        }

        // Memo 041 Teil B (Kap 9): json is the source. When a questions-json block is present, count
        // its questions directly (open = answered!==true, answered = answered===true) so a single-source
        // revision without a `### F{N}` markdown mirror shows the correct counts instead of "0 Fragen".
        const { found: jsonFound, questions: jsonQuestions } = DocumentRegistry.parseQuestionJsonBlock( { content } )

        if( jsonFound === true ) {
            const list = Array.isArray( jsonQuestions ) ? jsonQuestions : []
            struct[ 'answeredCount' ] = list
                .filter( ( q ) => q !== null && typeof q === 'object' && q[ 'answered' ] === true )
                .length
            struct[ 'openCount' ] = list.length - struct[ 'answeredCount' ]

            return struct
        }

        const { sectionLines: openLines } = DocumentRegistry.#extractSection( { content, 'heading': 'Offene Fragen' } )
        const { sectionLines: answeredLines } = DocumentRegistry.#extractSection( { content, 'heading': 'Beantwortete Fragen' } )

        struct[ 'openCount' ] = DocumentRegistry.#countEntries( { sectionLines: openLines } )
        struct[ 'answeredCount' ] = DocumentRegistry.#countEntries( { sectionLines: answeredLines } )

        return struct
    }


    static parseQuestionSchema( { content } ) {
        // PRD-012 (Kap 18): additive, machine-readable question schema. Parses every
        // `### F{N} —` block from both "Offene Fragen" and "Beantwortete Fragen" into
        // a structured object. Never throws — missing fields fall back to defaults.
        // PRD-001 (Memo 024 Kap 1): the schema additionally reports the heading count and a
        // countMismatch flag so the renderer can show a VISIBLE warning instead of a silent
        // difference when #countEntries (the sidebar counter) and the parsed question list
        // disagree. Existing callers that only read `questions` are unaffected (additive).
        const struct = { 'questions': [], 'headingCount': 0, 'countMismatch': false }

        if( typeof content !== 'string' || content.length === 0 ) {
            return struct
        }

        const { sectionLines: openLines } = DocumentRegistry.#extractSection( { content, 'heading': 'Offene Fragen' } )
        const { sectionLines: answeredLines } = DocumentRegistry.#extractSection( { content, 'heading': 'Beantwortete Fragen' } )

        const { questions: openQuestions } = DocumentRegistry.#parseQuestionBlocks( { sectionLines: openLines, answered: false } )
        const { questions: answeredQuestions } = DocumentRegistry.#parseQuestionBlocks( { sectionLines: answeredLines, answered: true } )

        struct[ 'questions' ] = [ ...openQuestions, ...answeredQuestions ]

        // Count the raw `### F{N}` headings only (the same case-insensitive rule the sidebar
        // counter uses) and compare against the number of actually parsed questions. A heading
        // that #countEntries sees but #parseQuestionBlocks could not turn into a question is the
        // exact silent-degradation case PRD-001 makes visible. Legacy list/table sections without
        // any F-heading produce headingCount 0 and never trip a false mismatch.
        const openHeadingCount = DocumentRegistry.#countQuestionHeadings( { sectionLines: openLines } )
        const answeredHeadingCount = DocumentRegistry.#countQuestionHeadings( { sectionLines: answeredLines } )
        struct[ 'headingCount' ] = openHeadingCount + answeredHeadingCount
        struct[ 'countMismatch' ] = struct[ 'headingCount' ] !== struct[ 'questions' ].length

        return struct
    }


    static parseVorwort( { content } ) {
        // PRD-014 (Kap 19): additive — capture Claude's "Vorwort" section so it can be
        // persisted and rendered at the top of the interactive area (directly before the
        // open questions). Accepts "## Vorwort" or "## Claude-Vorwort". Returns an empty
        // string when no such section exists. Never throws, never mutates other parsers.
        const struct = { 'vorwort': '' }

        if( typeof content !== 'string' || content.length === 0 ) {
            return struct
        }

        const headings = [ 'Vorwort', 'Claude-Vorwort' ]
        const found = headings
            .map( ( heading ) => DocumentRegistry.#extractSection( { content, heading } ) )
            .find( ( result ) => result[ 'sectionLines' ].length > 0 )

        if( found === undefined ) {
            return struct
        }

        struct[ 'vorwort' ] = found[ 'sectionLines' ]
            .join( '\n' )
            .trim()

        return struct
    }


    static parseQuestionJsonBlock( { content } ) {
        // PRD-039 (Memo 016, Kap 13, F7=C Hybrid): the questions live as a fenced
        // ```questions-json``` codeblock — a deterministic, parse-safe source. When such a
        // block exists it is the authoritative source; the human-readable markdown mirror
        // is generated from it (renderQuestionsMarkdown). Never throws: a malformed block
        // yields { found: false, questions: [], error } so the validator can translate it
        // into a PRD-037 code instead of crashing the server path.
        const struct = { 'questions': [], 'found': false, 'error': null }

        if( typeof content !== 'string' || content.length === 0 ) {
            return struct
        }

        // Memo 067 WI-6-09: the old NON-GLOBAL match read only the first/newest questions-json block.
        // When update revisions each carried only their NEW questions, the union was invisible
        // (15 of 17 open questions dropped). The scan is now GLOBAL: every questions-json block is
        // parsed and the questions are merged into one ordered set (dedup by id, else by frage-text;
        // a later block wins per key, first-seen order is kept). The completeness rule (Skill + Spec
        // 34/07) keeps the newest block already complete; this union is the belt for revisions that
        // predate it. Single-block documents behave exactly as before.
        const blockPattern = /```questions-json\s*\n([\s\S]*?)\n```/g
        const rawBlocks = [ ...content.matchAll( blockPattern ) ]
            .map( ( match ) => match[ 1 ] )

        if( rawBlocks.length === 0 ) {
            return struct
        }

        const parsedBlocks = rawBlocks
            .map( ( raw ) => DocumentRegistry.#parseSingleQuestionBlock( { raw } ) )

        const validBlocks = parsedBlocks
            .filter( ( result ) => result[ 'list' ] !== null )

        if( validBlocks.length === 0 ) {
            // No block parsed — surface the first block's error (preserves single-block semantics).
            const firstError = parsedBlocks
                .find( ( result ) => result[ 'error' ] !== null )
            struct[ 'error' ] = firstError !== undefined ? firstError[ 'error' ] : 'questions-json: Block must contain an array of question objects'

            return struct
        }

        const merged = new Map()

        validBlocks
            .flatMap( ( result ) => result[ 'list' ] )
            .map( ( entry ) => DocumentRegistry.#normalizeJsonQuestion( { entry } ) )
            .map( ( result ) => result[ 'question' ] )
            .forEach( ( question ) => {
                const idKey = typeof question[ 'id' ] === 'string' && question[ 'id' ].length > 0 ? question[ 'id' ] : null
                const key = idKey !== null ? `id:${ idKey }` : `frage:${ question[ 'frage' ] }`

                merged.set( key, question )
            } )

        struct[ 'questions' ] = [ ...merged.values() ]
        struct[ 'found' ] = true

        return struct
    }


    static #parseSingleQuestionBlock( { raw } ) {
        // Memo 067 WI-6-09: parse ONE questions-json block body. Returns { list, error } where a
        // valid block yields a raw entry array and a malformed/non-array block yields list=null plus
        // an error string. Never throws — the caller aggregates across all blocks.
        const struct = { 'list': null, 'error': null }

        try {
            const parsed = JSON.parse( raw )
            const list = Array.isArray( parsed ) ? parsed : ( Array.isArray( parsed[ 'questions' ] ) ? parsed[ 'questions' ] : null )

            if( list === null ) {
                struct[ 'error' ] = 'questions-json: Block must contain an array of question objects'

                return struct
            }

            struct[ 'list' ] = list

            return struct
        } catch( error ) {
            struct[ 'error' ] = `questions-json: Malformed JSON (${ error.message })`

            return struct
        }
    }


    static #normalizeJsonQuestion( { entry } ) {
        const safe = ( entry !== null && typeof entry === 'object' ) ? entry : {}
        const rawOptions = Array.isArray( safe[ 'options' ] ) ? safe[ 'options' ] : []
        const options = rawOptions
            .map( ( option ) => {
                const obj = ( option !== null && typeof option === 'object' ) ? option : {}
                // Memo 041 Teil B (Kap 10): coerce an unknown/invalid kind defensively to 'option'
                // (belt + suspenders) so a payload that slips past MEMO-033 still RENDERS as a card
                // instead of silently vanishing. A missing kind also defaults to 'option'. The valid
                // values (option/custom/topic) pass through unchanged — custom/topic are the injected
                // defaults appended below.
                const kind = VALID_OPTION_KINDS.includes( obj[ 'kind' ] ) ? obj[ 'kind' ] : 'option'

                return {
                    'key': typeof obj[ 'key' ] === 'string' ? obj[ 'key' ] : '',
                    'label': typeof obj[ 'label' ] === 'string' ? obj[ 'label' ] : '',
                    kind
                }
            } )

        // PRD-036-0403 (Memo 036, Frage-Schema, F13=C): the DOCS/spec now use ENGLISH field
        // names while the German fields stay valid for back-compat. The READ side therefore
        // accepts both spellings per field, with the German name taking precedence when both
        // are present (no behaviour change for existing German blocks). The INTERNAL question
        // shape keeps the German keys (frage/hintergrund/typ/aiRecommendation) — downstream
        // rendering depends on them; only the input read gains aliases.
        const { value: hintergrund } = DocumentRegistry.#readAliased( { safe, names: [ 'hintergrund', 'background' ] } )
        const { value: frage } = DocumentRegistry.#readAliased( { safe, names: [ 'frage', 'question' ] } )
        const { value: rawTyp } = DocumentRegistry.#readAliased( { safe, names: [ 'typ', 'type' ] } )
        const { value: aiRecommendation } = DocumentRegistry.#readAliased( { safe, names: [ 'aiRecommendation', 'recommendation', 'ai_recommendation' ] } )

        const typ = rawTyp === 'multi' ? 'multi' : 'single'

        // PRD-004 (Memo 011 Kap 11, Bug A): the JSON path previously never set `preselected`,
        // so the KI-recommendation was never pre-selected or shown. Mirror the markdown path
        // (#parseSingleQuestion Z.926-934): append the custom/topic default options, then derive
        // `preselected` from `aiRecommendation` via #resolvePreselected.
        const optionsWithDefaults = [ ...options ]
        optionsWithDefaults.push( { 'key': 'custom', 'label': 'ablehnen', 'kind': 'custom' } )
        optionsWithDefaults.push( { 'key': 'topic', 'label': 'Über das Topic springen', 'kind': 'topic' } )
        // Memo 059 (Kap 7, F3=A): `reframe` is the third injected sibling default. It signals the
        // question rests on a FALSE PREMISE — the answer is to re-formulate it (a discussion turn),
        // not to pick an option (no decision record). A non-'option' kind, so #resolvePreselected
        // skips it and isRenderable never counts it toward the two-real-option render minimum.
        optionsWithDefaults.push( { 'key': 'reframe', 'label': 'Frage neu formulieren', 'kind': 'reframe' } )

        // An explicit `preselected` array on the JSON entry wins (the author already decided);
        // otherwise derive it from the AI recommendation. Empty recommendation -> [] (no crash).
        const explicitPreselected = Array.isArray( safe[ 'preselected' ] )
            ? safe[ 'preselected' ].filter( ( index ) => Number.isInteger( index ) )
            : null
        const { preselected: derivedPreselected } = DocumentRegistry.#resolvePreselected( { typ, aiRecommendation, options: optionsWithDefaults } )
        const preselected = explicitPreselected !== null ? explicitPreselected : derivedPreselected

        // Memo 038 Kap 7 (P3a, F5=A): question-level answer-provenance, modelled after the
        // memo-level `Initiator`. `answeredBy` records WHO decided the question — the user, or
        // the AI "im Namen des Users". Only the two known values count; anything else (incl. a
        // missing field) defaults to 'user' (the unobtrusive, no-badge case). This is advisory
        // provenance, NOT an auto-answer — the finalize-gate schranke (MemoValidator) makes sure
        // an 'ai-on-behalf' answer never satisfies the all-answered gate on its own.
        const { answeredBy } = DocumentRegistry.#normalizeAnsweredBy( { value: safe[ 'answeredBy' ] } )

        const question = {
            'id': typeof safe[ 'id' ] === 'string' ? safe[ 'id' ] : '',
            'title': typeof safe[ 'title' ] === 'string' ? safe[ 'title' ] : '',
            hintergrund,
            frage,
            aiRecommendation,
            typ,
            'options': optionsWithDefaults,
            preselected,
            'allowCustomEntries': typ === 'multi',
            'answered': safe[ 'answered' ] === true,
            answeredBy
        }

        return { question }
    }


    static #normalizeAnsweredBy( { value } ) {
        // Memo 038 Kap 7 (P3a): accept only the two known provenance values; default to 'user'.
        // A 'user' answer is the silent default (no badge); 'ai-on-behalf' triggers the badge and
        // the finalize-gate schranke.
        const answeredBy = value === 'ai-on-behalf' ? 'ai-on-behalf' : 'user'

        return { answeredBy }
    }


    static #readAliased( { safe, names } ) {
        // PRD-036-0403 (Memo 036, Frage-Schema, F13=C): read a string field from the FIRST of
        // several accepted names. The names are ordered by precedence — the German name leads,
        // the English alias(es) follow — so a block carrying both spellings keeps the German
        // value (back-compat). Only string values count; anything else falls through to the
        // next name and finally to '' (no invented default).
        const source = ( safe !== null && typeof safe === 'object' ) ? safe : {}
        const found = names
            .find( ( name ) => typeof source[ name ] === 'string' )
        const value = found !== undefined ? source[ found ] : ''

        return { value }
    }


    static renderQuestionsMarkdown( { questions } ) {
        // PRD-039: deterministically render the human-readable markdown mirror from the
        // JSON question array. Options are emitted as DISCRETE lines ("A) ...", "B) ...")
        // and NEVER inline "(A)/(B)" (MEMORY feedback_memo_question_option_format) so the
        // existing parseQuestionSchema parses the result back round-trip-consistently.
        const struct = { 'markdown': '' }
        const list = Array.isArray( questions ) ? questions : []

        const blocks = list
            .map( ( question ) => {
                const safe = ( question !== null && typeof question === 'object' ) ? question : {}
                const id = typeof safe[ 'id' ] === 'string' ? safe[ 'id' ] : ''
                const title = typeof safe[ 'title' ] === 'string' ? safe[ 'title' ] : ''
                const heading = title.length > 0 ? `### ${ id } — ${ title }` : `### ${ id }`

                const lines = [ heading, '' ]

                const hintergrund = typeof safe[ 'hintergrund' ] === 'string' ? safe[ 'hintergrund' ] : ''
                const frage = typeof safe[ 'frage' ] === 'string' ? safe[ 'frage' ] : ''
                const aiRecommendation = typeof safe[ 'aiRecommendation' ] === 'string' ? safe[ 'aiRecommendation' ] : ''

                if( hintergrund.length > 0 ) {
                    lines.push( `**Hintergrund:** ${ hintergrund }`, '' )
                }

                if( frage.length > 0 ) {
                    lines.push( `**Frage:** ${ frage }`, '' )
                }

                if( aiRecommendation.length > 0 ) {
                    lines.push( `**AI-Empfehlung:** ${ aiRecommendation }`, '' )
                }

                if( safe[ 'typ' ] === 'multi' ) {
                    lines.push( '**Typ:** multi', '' )
                }

                const rawOptions = Array.isArray( safe[ 'options' ] ) ? safe[ 'options' ] : []
                const optionLines = rawOptions
                    .filter( ( option ) => option !== null && typeof option === 'object' && option[ 'kind' ] === 'option' )
                    .map( ( option ) => `${ option[ 'key' ] }) ${ option[ 'label' ] }` )

                optionLines
                    .forEach( ( optionLine ) => {
                        lines.push( optionLine )
                    } )

                return lines.join( '\n' )
            } )

        struct[ 'markdown' ] = blocks.join( '\n\n' )

        return struct
    }


    static #parseQuestionBlocks( { sectionLines, answered } ) {
        const struct = { 'questions': [] }
        // PRD-001 (Memo 024 Kap 1): heading match is case-insensitive so `### F1`, `### f1`
        // and `### F1 —` all count and parse identically. The id itself is normalised to the
        // canonical "F{N}" form in #parseSingleQuestion so the render-gate (/^F\d+$/) accepts it.
        const headingPattern = /^###\s+(F\d+)\b\s*(?:[—–-]\s*)?(.*)$/i

        const blockStarts = []
        sectionLines
            .forEach( ( rawLine, index ) => {
                if( headingPattern.test( rawLine.trim() ) ) {
                    blockStarts.push( index )
                }
            } )

        // Memo 038 Kap 7 (P1c/P3b): the answered section may be split into two `###` subsections
        // — "Vom User beantwortet" and "Von der AI im Namen des Users beantwortet". These headings
        // are NOT `### F{N}` (so they never count toward MEMO-025), but they carry the per-question
        // provenance: every `### F{N}` block inherits the provenance of the nearest PRECEDING
        // subsection heading. Without a split (no such heading) every block defaults to 'user'.
        const { provenanceAt } = DocumentRegistry.#mapAnsweredProvenance( { sectionLines } )

        const questions = blockStarts
            .map( ( startIndex, position ) => {
                const endIndex = position + 1 < blockStarts.length ? blockStarts[ position + 1 ] : sectionLines.length
                const blockLines = sectionLines.slice( startIndex, endIndex )
                const sectionAnsweredBy = provenanceAt( startIndex )
                const { question } = DocumentRegistry.#parseSingleQuestion( { blockLines, answered, sectionAnsweredBy } )

                return question
            } )

        struct[ 'questions' ] = questions

        return struct
    }


    static #mapAnsweredProvenance( { sectionLines } ) {
        // Memo 038 Kap 7 (P1c): build a lookup from line-index → provenance, derived from the
        // split-subsection headings. The AI subsection heading mentions "AI" (or "KI") "im Namen";
        // the user subsection heading mentions "User". Anything before the first such heading (or
        // when no split is present) is the default 'user'. Pure: no shared mutable cursor.
        const aiHeadingPattern = /^###\s+Von der (?:AI|KI)\b/i
        const userHeadingPattern = /^###\s+Vom User\b/i

        const transitions = sectionLines
            .map( ( rawLine, index ) => {
                const line = rawLine.trim()

                if( aiHeadingPattern.test( line ) ) { return { index, 'answeredBy': 'ai-on-behalf' } }
                if( userHeadingPattern.test( line ) ) { return { index, 'answeredBy': 'user' } }

                return null
            } )
            .filter( ( entry ) => entry !== null )

        const provenanceAt = ( lineIndex ) => {
            const preceding = transitions
                .filter( ( entry ) => entry[ 'index' ] < lineIndex )
            const last = preceding.length > 0 ? preceding[ preceding.length - 1 ] : null

            return last !== null ? last[ 'answeredBy' ] : 'user'
        }

        return { provenanceAt }
    }


    static #parseSingleQuestion( { blockLines, answered, sectionAnsweredBy } ) {
        const struct = { 'question': null }
        const headingPattern = /^###\s+(F\d+)\b\s*(?:[—–-]\s*)?(.*)$/i

        const headingLine = ( blockLines[ 0 ] || '' ).trim()
        const headingMatch = headingLine.match( headingPattern )
        // PRD-001 (Memo 024 Kap 1): normalise the id to the canonical upper-case "F{N}" so a
        // lower-case heading (`### f1`) yields the same id as `### F1` and passes the render-gate.
        const id = headingMatch ? headingMatch[ 1 ].toUpperCase() : ''
        let title = headingMatch ? headingMatch[ 2 ].trim() : ''

        // Answered entries are single-line: `### F{N} — Title — **AI:** X. **User:** Y. ...`.
        // Strip the trailing meta from the title so the bare title remains.
        if( answered ) {
            const metaIndex = title.search( /\s*[—–-]\s*\*\*(?:AI|User|Beantwortet)/ )
            if( metaIndex !== -1 ) {
                title = title.slice( 0, metaIndex ).trim()
            }
        }

        const body = blockLines
            .slice( 1 )
            .join( '\n' )

        const { value: hintergrund } = DocumentRegistry.#extractField( { body, label: 'Hintergrund' } )
        const { value: frage } = DocumentRegistry.#extractField( { body, label: 'Frage' } )
        const { value: aiRecommendation } = DocumentRegistry.#extractField( { body, label: 'AI-Empfehlung' } )

        // Memo 038 Kap 7 (P1c): make the AI/User decision pair machine-readable so the User
        // Mental Model (Kap 6) can compare what the AI recommended against what the user actually
        // decided. Both the REV-05 inline form ("· **User-Entscheidung:** Y") and the older
        // multi-line "- **User-Entscheidung:** Y" form parse. Empty string when absent (back-compat).
        const { value: aiRecommendationWas } = DocumentRegistry.#extractMetaField( { body, labels: [ 'AI-Empfehlung war', 'KI-Empfehlung war' ] } )
        const { value: userDecision } = DocumentRegistry.#extractMetaField( { body, labels: [ 'User-Entscheidung', 'User-Antwort' ] } )

        const { options } = DocumentRegistry.#extractOptions( { frage, body } )
        const { typ } = DocumentRegistry.#detectType( { body, frage } )

        const optionsWithDefaults = [ ...options ]
        // PRD-003 (Memo 022, Kap 4, F9=A): the custom-option label is "ablehnen" (was the
        // misleading "Frage ablösen"). The reject footer button in the widget is a separate,
        // already-correct control — this is only the parser's custom option.
        optionsWithDefaults.push( { 'key': 'custom', 'label': 'ablehnen', 'kind': 'custom' } )
        optionsWithDefaults.push( { 'key': 'topic', 'label': 'Über das Topic springen', 'kind': 'topic' } )
        // Memo 059 (Kap 7, F3=A): mirror the JSON path — inject `reframe` as the third sibling
        // default so the markdown-authored path offers the same false-premise / re-formulate turn.
        optionsWithDefaults.push( { 'key': 'reframe', 'label': 'Frage neu formulieren', 'kind': 'reframe' } )

        const { topicPositions } = DocumentRegistry.#extractTopicPositions( { body } )
        const { preselected } = DocumentRegistry.#resolvePreselected( { typ, aiRecommendation, options: optionsWithDefaults } )

        // Memo 038 Kap 7 (P1c/P3b): provenance from the split subsection (only meaningful for
        // answered entries); the default is 'user'. Normalised through the same helper as the JSON
        // path so the two parsers can never drift on the accepted values.
        const { answeredBy } = DocumentRegistry.#normalizeAnsweredBy( { value: sectionAnsweredBy } )

        const question = {
            id,
            title,
            'hintergrund': hintergrund,
            'frage': frage,
            aiRecommendation,
            typ,
            'options': optionsWithDefaults,
            topicPositions,
            preselected,
            'allowCustomEntries': typ === 'multi',
            answered,
            answeredBy
        }

        // Memo 038 Kap 7 (P1c): only carry the decision pair when actually present, so open
        // questions and legacy answered entries keep the exact previous shape (additive).
        if( aiRecommendationWas.length > 0 ) { question[ 'aiRecommendationWas' ] = aiRecommendationWas }
        if( userDecision.length > 0 ) { question[ 'userDecision' ] = userDecision }

        struct[ 'question' ] = question

        return struct
    }


    static #extractMetaField( { body, labels } ) {
        // Memo 038 Kap 7 (P1c): extract an answered-entry meta field that may appear EITHER on its
        // own line ("- **User-Entscheidung:** Y") OR inline, separated by " · " from sibling fields
        // ("**AI-Empfehlung war:** X · **User-Entscheidung:** Y (note) · **Beantwortet in:** REV-03").
        // The value runs until the next bold "**Label:**" (on the same line after a "·" OR on the
        // next line), a "·" separator, a blank line, or the end. Returns '' when no label matches.
        const struct = { 'value': '' }

        if( typeof body !== 'string' || body.length === 0 ) {
            return struct
        }

        const labelAlternatives = labels.map( ( label ) => DocumentRegistry.#escapeRegExp( { value: label } ) )
        const labelPattern = labelAlternatives.join( '|' )

        // Boundary = next "**" bold label, a "·" mid-line separator, a blank line, or string end.
        const pattern = new RegExp(
            `\\*\\*(?:${ labelPattern })[^:*]*:\\*\\*\\s*([\\s\\S]*?)(?=\\s*·\\s*\\*\\*|\\n\\s*\\n|\\n\\s*(?:[-*]\\s+)?\\*\\*[A-Za-zÀ-ÿ-]+[^:*]*:\\*\\*|$)`,
            'i'
        )
        const matched = body.match( pattern )

        if( matched !== null ) {
            struct[ 'value' ] = matched[ 1 ]
                .replace( /\s+/g, ' ' )
                .trim()
        }

        return struct
    }


    static #extractField( { body, label } ) {
        const struct = { 'value': '' }

        if( typeof body !== 'string' || body.length === 0 ) {
            return struct
        }

        // PRD-001 (Memo 024 Kap 1): the requested label may appear under several spellings.
        // Each entry lists every accepted alias for that logical field (case-insensitive); the
        // regex below tries them all so e.g. "KI-Empfehlung" maps to the same field as
        // "AI-Empfehlung". Unknown labels fall back to the label itself (no behaviour change).
        const aliasGroups = [
            [ 'AI-Empfehlung', 'KI-Empfehlung' ]
        ]
        const { matchedGroup } = DocumentRegistry.#resolveLabelAliases( { aliasGroups, label } )
        const labelAlternatives = matchedGroup.map( ( alias ) => DocumentRegistry.#escapeRegExp( { value: alias } ) )
        const labelPattern = labelAlternatives.join( '|' )

        // Tolerate a trailing qualifier between the label and the colon, since memos
        // write "**Frage (Original):**" and "**AI-Empfehlung war:**" — without this the
        // question text and AI recommendation never parse, leaving the KI-Empfehlung
        // option label (#24) and the green AI-hint line (#25) permanently empty.
        //
        // PRD-006 (Memo 018 Kap 9): Memo-017 REV-03 writes each field as a Markdown
        // list item ("- **Frage (Original):** ..."). The boundary lookahead must
        // therefore tolerate an optional list marker ("- " / "* ") before the next
        // "**Label:**" — otherwise "**Frage:**" greedily swallows the following
        // "- **AI-Empfehlung war:**" and "- **User-Entscheidung:**" lines, which in
        // turn lets the last inline option label run into the AI line (Bug-Bild aus
        // Kap 9: inline-Optionen werden falsch geparst).
        // PRD-001 (Memo 024 Kap 1): the label group is matched case-insensitively (`i` flag)
        // and over all aliases, so `### f1`-style lower-case writing and "KI-Empfehlung" parse.
        // The "[^:*]*" run before the colon already tolerates spaces, so "Label :" / "Label  :"
        // are matched without an extra rule.
        const pattern = new RegExp( `\\*\\*(?:${ labelPattern })[^:*]*:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\n|\\n\\s*(?:[-*]\\s+)?\\*\\*[A-Za-zÀ-ÿ-]+[^:*]*:\\*\\*|$)`, 'i' )
        const matched = body.match( pattern )

        if( matched !== null ) {
            struct[ 'value' ] = matched[ 1 ]
                .replace( /\s+/g, ' ' )
                .trim()
        }

        return struct
    }


    static #resolveLabelAliases( { aliasGroups, label } ) {
        // PRD-001 (Memo 024 Kap 1): find the alias group the requested label belongs to
        // (case-insensitive). If the label is not part of any group it is returned as the only
        // alternative — so non-aliased labels (Frage, Hintergrund) behave exactly as before.
        const wanted = String( label || '' ).toLowerCase()
        const group = aliasGroups
            .find( ( aliases ) => aliases.some( ( alias ) => alias.toLowerCase() === wanted ) )
        const matchedGroup = group !== undefined ? group : [ label ]

        return { matchedGroup }
    }


    static #escapeRegExp( { value } ) {
        // PRD-001 (Memo 024 Kap 1): escape RegExp metacharacters so a label/alias is matched
        // literally inside the dynamically built pattern (the hyphen in "AI-Empfehlung" is safe
        // outside a character class, but escaping keeps the helper reusable for any alias).
        const escaped = String( value || '' ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' )

        return escaped
    }


    static #extractOptions( { frage, body } ) {
        const struct = { 'options': [] }
        const seen = new Set()

        // PRD-006 (Memo 018 Kap 9): Memo-017 REV-03 records the chosen option as a
        // BACK-REFERENCE inside metadata lines, e.g. "**AI-Empfehlung war:** Eigenständig
        // (A)." or "**User-Entscheidung:** A — ...". Those "(A)"/"A —" tokens are NOT option
        // declarations and must not become options (they produced phantom options like
        // A="- **User-Entscheidung:**" for F2/F4). Strip every metadata field line from the
        // body source before scanning; genuine discrete option lines ("A) ...") and inline
        // options inside the Frage text survive untouched.
        const { cleanedBody } = DocumentRegistry.#stripMetaFieldLines( { body: body || '' } )

        const sources = [ frage || '', cleanedBody ]

        sources
            .forEach( ( source ) => {
                // PRD-021 (Memo 016, Kap 11.1): the marker tolerates BOTH the preferred
                // discrete form ("A) ...", "A: ...", "A. ...", "Option A) ...") AND the
                // loose parenthesised form ("(A) ...", "(A): ...", "(A). ...",
                // "Option (A) ..."). The letter is captured in group 1 (bare) or group 2
                // (parenthesised) — parentheses are part of the MARKER syntax only and never
                // reach the key or the label. A parenthesis inside an option text is NOT a
                // marker, because a marker must be anchored at a start boundary (string start
                // or right after the previous marker via the lookahead) — so "(siehe X)"
                // mid-label is never mis-parsed as an option.
                //
                // Marker grammar (start anchor): optional "Option ", then either a bare
                // letter followed by ) : or . — OR — a parenthesised letter "(A)" optionally
                // followed by : or . — in both cases trailing whitespace.
                //
                // PRD-004 (Memo 011 Kap 11, Bug C): the bare-letter branch needs a LEFT
                // boundary too. Without it the engine matched a letter glued to the end of a
                // word — "INCONCLUSIVE:" produced a phantom option "E" (the final E of the word
                // followed by the colon). The non-consuming `(?:^|(?<=[\s(]))` prefix requires
                // the marker to begin at the string start or right after whitespace / an opening
                // paren, so a letter inside a word never starts a marker. (The lookbehind keeps
                // `lastIndex` correct — no character is consumed by the boundary itself.)
                const markerPart = '(?:^|(?<=[\\s(]))(?:Option\\s+)?(?:([A-H])[):.]|\\(([A-H])\\)[:.]?)\\s+'
                const markerLookahead = '(?:Option\\s+)?(?:[A-H][):.]|\\([A-H]\\)[:.]?)\\s+'
                const optionPattern = new RegExp(
                    markerPart + '([^]*?)(?=(?:\\s' + markerLookahead + ')|$)',
                    'g'
                )
                let match = optionPattern.exec( source )

                while( match !== null ) {
                    const rawKey = match[ 1 ] !== undefined ? match[ 1 ] : match[ 2 ]
                    const key = rawKey.toUpperCase()
                    const label = match[ 3 ]
                        .replace( /\s+/g, ' ' )
                        .trim()

                    if( !seen.has( key ) && label.length > 0 ) {
                        seen.add( key )
                        struct[ 'options' ].push( { key, label, 'kind': 'option' } )
                    }

                    match = optionPattern.exec( source )
                }
            } )

        // PRD-003 (Memo 022, Kap 4, F9=A): a checklist-style question carries its options as
        // markdown checkbox items ("- [ ] ..."), NOT as A/B/C letter markers. Without derived
        // options such a question reaches the render gate with zero options and is forced into
        // the markdown fallback. Derive options from the checkbox items, but ONLY when no
        // letter options were found — genuine A/B/C questions stay untouched. Dedupe via `seen`.
        if( struct[ 'options' ].length === 0 ) {
            const { options: checklistOptions } = DocumentRegistry.#extractChecklistOptions( { body: cleanedBody } )
            checklistOptions
                .forEach( ( option ) => {
                    if( seen.has( option[ 'key' ] ) === false ) {
                        seen.add( option[ 'key' ] )
                        struct[ 'options' ].push( option )
                    }
                } )
        }

        return struct
    }


    static #extractChecklistOptions( { body } ) {
        // PRD-003 (Memo 022, Kap 4): turn markdown checkbox items into real `option` entries.
        // Key = a derived letter (A, B, C …) by item index, label = the item text after the
        // checkbox. No for/while — split + filter + map only. Returns the same shape as the
        // letter-option scan so the render gate can treat both uniformly.
        const struct = { 'options': [] }

        if( typeof body !== 'string' || body.length === 0 ) {
            return struct
        }

        const checkboxPattern = /^[ \t]*[-*]\s+\[[ xX]\]\s*(.+)$/

        struct[ 'options' ] = body
            .split( '\n' )
            .map( ( line ) => line.match( checkboxPattern ) )
            .filter( ( matched ) => matched !== null )
            .map( ( matched, index ) => {
                const label = matched[ 1 ]
                    .replace( /\s+/g, ' ' )
                    .trim()

                return { 'key': String.fromCharCode( 65 + index ), label, 'kind': 'option' }
            } )
            .filter( ( option ) => option[ 'label' ].length > 0 )

        return struct
    }


    static #stripMetaFieldLines( { body } ) {
        // PRD-006 (Memo 018 Kap 9): remove answer/metadata field lines from the option
        // scan source. These lines carry back-references to the chosen option (e.g.
        // "(A)" or "A —") that must never be promoted to option declarations. The Frage
        // field itself is kept — it is scanned separately as its own source and may
        // legitimately contain inline "(A) ... (B) ..." options.
        const struct = { 'cleanedBody': '' }

        if( typeof body !== 'string' || body.length === 0 ) {
            return struct
        }

        const metaLabels = [ 'AI-Empfehlung', 'KI-Empfehlung', 'User-Entscheidung',
            'User-Antwort', 'Antwort', 'Entscheidung', 'Beantwortet in', 'Beantwortet',
            'Anmerkung', 'Status', 'Begründung' ]
        const metaPattern = new RegExp(
            `^\\s*(?:[-*]\\s+)?\\*\\*(?:${ metaLabels.join( '|' ) })[^:*]*:\\*\\*`
        )

        struct[ 'cleanedBody' ] = body
            .split( '\n' )
            .filter( ( line ) => metaPattern.test( line ) === false )
            .join( '\n' )

        return struct
    }


    static #detectType( { body, frage } ) {
        const struct = { 'typ': 'single' }

        // Title deliberately NOT included (#64): a keyword in the title caused
        // misclassification ("Finalisierungs-Checkliste" was once single, once multi).
        const haystack = `${ body || '' } ${ frage || '' }`.toLowerCase()

        // 1) Explicit type field wins (#31).
        const explicitMulti = /\*\*typ:\*\*\s*multi/.test( haystack )
            || /\btyp:\s*multi\b/.test( haystack )

        // 2) Structural heuristic: checklist with multiple checkable entries (#31/#65).
        //    This is the "mehrere ankreuzbare Optionen" signal — actual checkbox
        //    items, NOT the count of A/B/C radio options. Single-select questions
        //    routinely carry 3-4 lettered options (#23), so option count must NOT
        //    drive multi-detection.
        const checkboxItems = ( body || '' ).match( /^[ \t]*[-*]\s+\[[ xX]\]/gm ) || []
        const isChecklist = checkboxItems.length >= 2

        // 3) Remaining explicit keywords as fallback (only in body/frage, not title).
        const keywordMulti = /\bmulti\b/.test( haystack )
            || /multiple[-\s]?choice/.test( haystack )
            || /mc-frage/.test( haystack )
            || /mehrfach/.test( haystack )
            || /als mc/.test( haystack )

        if( explicitMulti || isChecklist || keywordMulti ) {
            struct[ 'typ' ] = 'multi'
        }

        return struct
    }


    static #extractTopicPositions( { body } ) {
        const struct = { 'topicPositions': [] }

        if( typeof body !== 'string' || body.length === 0 ) {
            return struct
        }

        const seen = new Set()
        const pattern = /\bKap\.?\s*(\d+(?:\.\d+)?)/g
        let match = pattern.exec( body )

        while( match !== null ) {
            const position = match[ 1 ]

            if( !seen.has( position ) ) {
                seen.add( position )
                struct[ 'topicPositions' ].push( position )
            }

            match = pattern.exec( body )
        }

        return struct
    }


    static #resolvePreselected( { typ, aiRecommendation, options } ) {
        const struct = { 'preselected': [] }

        if( typeof aiRecommendation !== 'string' || aiRecommendation.length === 0 ) {
            return struct
        }

        // The AI recommendation often names option keys, e.g. "Option C", "A+B", "C —".
        //
        // PRD-004 (Memo 011 Kap 11, Bug C): the old key regex `/\b([A-H])\b/g` matched ANY
        // bare A-H letter — including letters that only appear in prose ("Variante A wäre
        // denkbar", "INCONCLUSIVE:"). Those phantom matches pre-selected options that the AI
        // never recommended. Anchor the marker so a letter only counts when it sits at a
        // recommendation boundary: at the string start, after "Option ", or after a separator
        // (space, "+", "/", ",", "—", "-", "("), AND is immediately followed by a recommendation
        // delimiter (")", ":", ".", "—", "-", "+", "/", ",", whitespace, or string end). A
        // letter buried inside a word ("INCONCLUSIVE") never satisfies the leading boundary.
        const recommendation = aiRecommendation.toUpperCase()
        const keyPattern = /(?:^|[\s+/,(—-]|OPTION\s+)([A-H])(?=[):.,+/—\s-]|$)/g
        const keyMatches = ( recommendation.match( keyPattern ) || [] )
            .map( ( token ) => {
                const found = token.match( /([A-H])(?=[):.,+/—\s-]|$)/ )

                return found !== null ? found[ 1 ] : ''
            } )
            .filter( ( key ) => key.length > 0 )

        const matchedIndices = []
        options
            .forEach( ( option, index ) => {
                if( option[ 'kind' ] !== 'option' ) { return }
                if( keyMatches.includes( option[ 'key' ] ) ) {
                    matchedIndices.push( index )
                }
            } )

        if( matchedIndices.length === 0 ) {
            return struct
        }

        if( typ === 'single' ) {
            struct[ 'preselected' ] = [ matchedIndices[ 0 ] ]
        } else {
            struct[ 'preselected' ] = matchedIndices
        }

        return struct
    }


    static #extractSection( { content, heading } ) {
        const lines = content.split( '\n' )
        const headingPattern = new RegExp( `^##\\s+${ heading }\\s*$`, 'i' )
        const startIndex = lines.findIndex( ( line ) => headingPattern.test( line ) )

        if( startIndex === -1 ) {
            return { 'sectionLines': [] }
        }

        const rest = lines.slice( startIndex + 1 )
        const endOffset = rest.findIndex( ( line ) => /^##\s/.test( line ) )
        const sectionLines = endOffset === -1 ? rest : rest.slice( 0, endOffset )

        return { sectionLines }
    }


    static #countQuestionHeadings( { sectionLines } ) {
        // PRD-001 (Memo 024 Kap 1): single source of truth for the `### F{N}` heading count
        // (case-insensitive). Both the sidebar counter (#countEntries) and the count-vs-parse
        // consistency check in parseQuestionSchema use it, so the two paths can never drift.
        const count = sectionLines
            .filter( ( rawLine ) => /^###\s+F\d+\b/i.test( rawLine.trim() ) )
            .length

        return count
    }


    static #countEntries( { sectionLines } ) {
        // PRD-003 (Kap 8): questions in the `### F{N} —` H3 format were not counted,
        // producing the "0 offen" bug. When the section uses that format, count the
        // headings directly (one per question) — this also avoids double-counting any
        // bullet lists inside a question body. Legacy list/table sections fall back.
        const questionHeadingCount = DocumentRegistry.#countQuestionHeadings( { sectionLines } )

        if( questionHeadingCount > 0 ) { return questionHeadingCount }

        const count = sectionLines
            .filter( ( rawLine ) => {
                const line = rawLine.trim()

                if( line.length === 0 ) { return false }

                const isListItem = /^[-*]\s+\S/.test( line )

                if( isListItem ) { return true }

                const isTableRow = line.startsWith( '|' ) && line.endsWith( '|' )

                if( !isTableRow ) { return false }

                const isSeparator = /^\|[\s:|-]+\|$/.test( line )

                if( isSeparator ) { return false }

                const cells = line
                    .split( '|' )
                    .slice( 1, -1 )
                    .map( ( cell ) => cell.trim() )

                const isHeaderRow = cells.some( ( cell ) => /^(F[-\s]?Nr|Frage|Nr|Status|ID|#)\.?$/i.test( cell ) )

                if( isHeaderRow ) { return false }

                const firstCell = cells.length > 0 ? cells[ 0 ] : ''
                const isEntry = /^F?\d+$/i.test( firstCell ) || firstCell.length > 0

                return isEntry
            } )
            .length

        return count
    }


    static #classifyRevisionType( { fileName } ) {
        const updatePattern = /^REV-\d+-update\.md$/i
        const preparePattern = /^REV-\d+-prepare\.md$/i
        const fullPattern = /^REV-\d+\.md$/i

        if( updatePattern.test( fileName ) ) { return { revisionType: 'update' } }
        if( preparePattern.test( fileName ) ) { return { revisionType: 'prepare' } }
        if( fullPattern.test( fileName ) ) { return { revisionType: 'full' } }

        return { revisionType: 'full' }
    }


    // PRD-007 (Memo 018 Kap 10, refined REV-05): legacy criterion for MEMO revisions. A revision
    // is "neu" exactly when it carries a parsable `### F{N} —` question structure; the absence of
    // that structure marks it legacy ("alte Version"). The transcript-only `Schema-Version: 2`
    // marker (TranscriptHeader.detectSchema) is NOT applied to memo .md revisions — those files
    // never carry that header, so applying it flagged every revision. Never throws.
    static detectRevisionLegacy( { content } ) {
        // Memo 041 Teil B (Kap 9): json is the source. A revision is "neu" when it carries a
        // question structure in EITHER form — a parsable `### F{N}` markdown block OR a valid
        // questions-json block. Before Memo 041 only the markdown form counted, so a single-source
        // json-only revision was wrongly flagged legacy ("alte Version") and muted.
        const { questions } = DocumentRegistry.parseQuestionSchema( { content } )
        const { found: jsonFound, questions: jsonQuestions } = DocumentRegistry.parseQuestionJsonBlock( { content } )
        const hasMarkdownStructure = Array.isArray( questions ) && questions.length > 0
        const hasJsonStructure = jsonFound === true && Array.isArray( jsonQuestions ) && jsonQuestions.length > 0
        const hasQuestionStructure = hasMarkdownStructure || hasJsonStructure
        const isLegacy = hasQuestionStructure === false

        return { isLegacy, hasQuestionStructure }
    }


    static async #scanRevisions( { dirPath } ) {
        const files = await readdir( dirPath )
        const filtered = files
            .filter( ( f ) => {
                if( !f.endsWith( '.md' ) ) { return false }

                const revisionPattern = /^REV-(\d+)(?:-(prepare|update))?\.md$/i
                // Legacy: matches v{MAJOR}.{MINOR}.md revision files (pre-REV-NN format,
                // e.g. .memo/memos/004-claude-md-skill-extraction/revisions/v0.1.md).
                // Kept active so legacy memos remain visible in the sidebar.
                const versionPattern = /^v(\d+)\.(\d+)\.md$/i
                const isMatch = revisionPattern.test( f ) || versionPattern.test( f )

                return isMatch
            } )
            .sort()

        const revisions = await Promise.all(
            filtered.map( async ( f ) => {
                const absolutePath = resolve( dirPath, f )
                const fileStat = await stat( absolutePath )
                const mtime = fileStat.mtime
                const day = String( mtime.getDate() ).padStart( 2, '0' )
                const month = String( mtime.getMonth() + 1 ).padStart( 2, '0' )
                const hours = String( mtime.getHours() ).padStart( 2, '0' )
                const minutes = String( mtime.getMinutes() ).padStart( 2, '0' )
                const sizeKb = Math.max( 1, Math.round( fileStat.size / 1024 ) )
                const { revisionType } = DocumentRegistry.#classifyRevisionType( { fileName: f } )
                const result = {
                    'fileName': f,
                    'absolutePath': absolutePath,
                    'mtime': `${day}.${month}. ${hours}:${minutes}`,
                    'mtimeMs': fileStat.mtimeMs,
                    'sizeKb': sizeKb,
                    'revisionType': revisionType,
                    // PRD-001 (Memo 018 Kap 4): every revision carries a revisionStatus from the
                    // REVISION_STATUS_VALUES enum. At scan time a revision is 'offen' until a
                    // transcript is registered/logged; the transcript-driven transitions are
                    // computed via DocumentRegistry.deriveRevisionStatus.
                    'revisionStatus': REVISION_STATUS_DEFAULT
                }

                // PRD-007 (Memo 018 Kap 10, F6=C): read the file content to evaluate the combined
                // legacy criterion. Additive fields only — existing fields stay untouched. A read
                // failure must NOT drop the revision and must NOT throw: it is flagged as legacy
                // with parseError so the UI can still list it ("kein stilles Scheitern").
                try {
                    const revContent = await readFile( absolutePath, 'utf-8' )
                    const { isLegacy } = DocumentRegistry.detectRevisionLegacy( { content: revContent } )
                    result[ 'isLegacy' ] = isLegacy
                } catch {
                    result[ 'isLegacy' ] = true
                    result[ 'parseError' ] = true
                }

                return result
            } )
        )

        revisions.sort( ( a, b ) => {
            const mtimeDiff = b['mtimeMs'] - a['mtimeMs']
            if( mtimeDiff !== 0 ) { return mtimeDiff }
            const aMatch = a['fileName'].match( /^REV-(\d+)/i )
            const bMatch = b['fileName'].match( /^REV-(\d+)/i )
            const aNum = aMatch ? parseInt( aMatch[ 1 ], 10 ) : 0
            const bNum = bMatch ? parseInt( bMatch[ 1 ], 10 ) : 0

            return bNum - aNum
        } )

        return { revisions }
    }


    static #detectDocumentKind( { absolutePath } ) {
        const normalized = absolutePath.replace( /\\/g, '/' )
        let documentKind = 'memo'

        if( normalized.includes( '/.memo/plans/' ) ) {
            documentKind = 'plan'
        } else if( normalized.includes( '/.memo/memos/' ) ) {
            documentKind = 'memo'
        } else {
            documentKind = 'memo'
        }

        return { documentKind }
    }


    static #extractMemoName( { dirPath } ) {
        const dirName = basename( dirPath )

        if( dirName === 'revisions' ) {
            const parentName = basename( dirname( dirPath ) )

            return parentName
        }

        return dirName
    }


    async #refreshParsedFields( { documentId } ) {
        const struct = { 'status': false, 'memoStatus': MEMO_STATUS_DEFAULT, 'questions': { 'open': 0, 'answered': 0 } }

        if( !this.#documents.has( documentId ) ) {
            return struct
        }

        const doc = this.#documents.get( documentId )
        const revisions = doc[ 'revisions' ] || []

        const statusRevision = revisions
            .find( ( r ) => r[ 'revisionType' ] === 'full' || r[ 'revisionType' ] === 'update' )

        const fullRevision = revisions
            .find( ( r ) => r[ 'revisionType' ] === 'full' )

        let memoStatus = MEMO_STATUS_DEFAULT

        if( statusRevision !== undefined ) {
            const statusPath = statusRevision[ 'absolutePath' ] || resolve( doc[ 'memoPath' ], statusRevision[ 'fileName' ] )

            try {
                const content = await readFile( statusPath, 'utf-8' )
                const parsed = DocumentRegistry.parseStatus( { content } )
                memoStatus = parsed[ 'memoStatus' ]
            } catch {
                memoStatus = MEMO_STATUS_DEFAULT
            }
        }

        let questions = { 'open': 0, 'answered': 0 }

        if( fullRevision !== undefined ) {
            const fullPath = fullRevision[ 'absolutePath' ] || resolve( doc[ 'memoPath' ], fullRevision[ 'fileName' ] )

            try {
                const content = await readFile( fullPath, 'utf-8' )
                const parsed = DocumentRegistry.parseQuestions( { content } )
                questions = { 'open': parsed[ 'openCount' ], 'answered': parsed[ 'answeredCount' ] }
            } catch {
                questions = { 'open': 0, 'answered': 0 }
            }
        }

        doc[ 'memoStatus' ] = memoStatus
        doc[ 'questions' ] = questions

        struct[ 'status' ] = true
        struct[ 'memoStatus' ] = memoStatus
        struct[ 'questions' ] = questions

        return struct
    }


    #startDirectoryWatcher( { documentId, dirPath } ) {
        const watcher = watch( dirPath, async ( eventType, filename ) => {
            if( !filename || !filename.endsWith( '.md' ) ) { return }

            const revisionPattern = /^REV-(\d+)(?:-(prepare|update))?\.md$/i
            // Legacy: see #scanRevisions — same v{MAJOR}.{MINOR}.md pattern for pre-REV-NN files.
            const versionPattern = /^v(\d+)\.(\d+)\.md$/i
            const isMatch = revisionPattern.test( filename ) || versionPattern.test( filename )

            if( !isMatch ) { return }

            const { revisions } = await DocumentRegistry.#scanRevisions( { dirPath } )

            if( !this.#documents.has( documentId ) ) { return }

            const doc = this.#documents.get( documentId )
            const previousCount = doc['revisions'].length
            doc['revisions'] = revisions

            if( revisions.length > previousCount && revisions.length > 0 && doc['selectedRevision'] !== null ) {
                doc['selectedRevision'] = revisions[ 0 ]['fileName']
            }

            await this.#refreshParsedFields( { documentId } )

            if( this.#onChangeCallback ) {
                this.#onChangeCallback( { documentId, 'event': 'revisionsUpdated' } )
            }
        } )

        return { watcher }
    }
}


export { DocumentRegistry }
