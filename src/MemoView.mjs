import { createServer } from 'node:http'
import { readFile, access, readdir } from 'node:fs/promises'
import { watch, existsSync, readFileSync } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'

import { WebSocketServer } from 'ws'

import { DocumentRegistry } from './DocumentRegistry.mjs'
import { MemoValidator } from './MemoValidator.mjs'
import { PlanRegistry } from './PlanRegistry.mjs'
import { TranscriptRegistry } from './TranscriptRegistry.mjs'
import { RequirementsStore } from './RequirementsStore.mjs'
import { BlockMeta } from './BlockMeta.mjs'
import { RevisionLogic } from './RevisionLogic.mjs'
import { Config } from './data/config.mjs'


const PORT_SCHEMA = [ 3333, 4444, 5555, 6666, 7777, 8888 ]

// PRD-002 (Memo 016 Kap 2, E2): probe and real bind MUST use the same host. Previously the
// probe bound 0.0.0.0 (listen without host) while the server bound 127.0.0.1 — a free probe
// on one interface did not predict the real bind on the other. One constant, used by the
// probe AND every server.listen, closes that interface-mismatch.
const BIND_HOST = '127.0.0.1'

// PRD-010 (Memo 016, F1): the ~3000-line app CSS was extracted from the inline <style> block of
// #buildHtmlPage into src/public/app.css and is served by the /app.css static route. The file is
// read ONCE at module load (resolved relative to this module, not cwd) and cached — every request
// serves this in-memory string, never re-reading from disk.
const APP_CSS_PATH = fileURLToPath( new URL( './public/app.css', import.meta.url ) )
const APP_CSS = readFileSync( APP_CSS_PATH, 'utf8' )

// PRD-011 (Memo 016, F1/F2): the ~5900-line inline client <script> block was extracted from
// #buildHtmlPage into src/public/app.client.mjs and is served by the /app.client.mjs static route
// as a CLASSIC script (not type=module) so its top-level functions stay in global scope for the
// inline on*= handlers. Read ONCE at module load (resolved relative to this module, not cwd) and
// cached — every request serves this in-memory string, never re-reading from disk.
const APP_CLIENT_JS_PATH = fileURLToPath( new URL( './public/app.client.mjs', import.meta.url ) )
const APP_CLIENT_JS = readFileSync( APP_CLIENT_JS_PATH, 'utf8' )

const PORT_COLORS = {
    3333: '4493f8',
    4444: '3fb950',
    5555: 'd29922',
    6666: 'f85149',
    7777: 'a371f7',
    8888: '39d2c0'
}


class MemoView {
    static async start( { filePath, port } ) {
        const { status, messages } = MemoView.validationStart( { filePath, port } )

        if( !status ) {
            const formatted = messages
                .map( ( msg ) => {
                    const result = `  - ${msg}`

                    return result
                } )
                .join( '\n' )

            process.stderr.write( `\nError:\n${formatted}\n\n` )
            process.exit( 1 )
        }

        const absolutePath = resolve( filePath )

        let portNumber

        if( port !== undefined ) {
            portNumber = parseInt( port, 10 )
        } else {
            const { availablePort } = await MemoView.#findAvailablePort()

            if( availablePort === null ) {
                const portList = PORT_SCHEMA
                    .map( ( p ) => {
                        const result = `  - ${p}`

                        return result
                    } )
                    .join( '\n' )

                process.stderr.write( `\nError: All memo-view ports are in use:\n${portList}\n\n  Use --port <number> to specify a custom port.\n\n` )
                process.exit( 1 )
            }

            portNumber = availablePort
        }

        const state = {
            absolutePath,
            watcher: null,
            clients: null
        }

        MemoView.#currentDirectoryState = state

        const { html } = MemoView.#buildHtmlPage( { port: portNumber } )
        const { handler } = MemoView.#createHttpHandler( { html, state } )

        const server = createServer( handler )

        const { startResult } = await new Promise( ( resolvePromise ) => {
            server.on( 'error', ( err ) => {
                if( err.code === 'EADDRINUSE' ) {
                    process.stderr.write( `\nError: Port ${portNumber} is already in use.\n` )
                    process.stderr.write( `  Use --port <number> to specify a different port.\n\n` )
                    process.exit( 1 )
                }

                throw err
            } )

            server.listen( portNumber, BIND_HOST, () => {
                const startResult = true

                resolvePromise( { startResult } )
            } )
        } )

        const url = `http://localhost:${portNumber}`
        const { wss, clients } = MemoView.#setupWebSocket( { server, state } )
        state.clients = clients
        const { watcher } = MemoView.#startFileWatcher( { state } )
        state.watcher = watcher

        MemoView.#registerShutdown( { server, wss, state } )
        MemoView.#openBrowser( { url } )

        process.stdout.write( `\n  Watching: ${absolutePath}\n` )
        process.stdout.write( `  Server:   ${url}\n` )
        process.stdout.write( `  Press Ctrl+C to stop.\n\n` )

        return { startResult }
    }


    static async startDirectory( { dirPath, port } ) {
        const absoluteDir = resolve( dirPath )
        const { latestPath } = await MemoView.#findLatestRevision( { dirPath: absoluteDir } )

        if( !latestPath ) {
            process.stderr.write( `\nError: No revision files (REV-XX.md or vX.X.md) found in: ${absoluteDir}\n\n` )
            process.exit( 1 )
        }

        const { startResult } = await MemoView.start( { filePath: latestPath, port } )

        const dirWatcher = watch( absoluteDir, async ( eventType, filename ) => {
            if( !filename || !filename.endsWith( '.md' ) ) { return }

            const { matched } = MemoView.matchRevisionPattern( { fileName: filename } )

            if( !matched ) { return }

            const { latestPath: newLatest } = await MemoView.#findLatestRevision( { dirPath: absoluteDir } )

            if( newLatest && newLatest !== MemoView.#currentDirectoryPath ) {
                MemoView.#currentDirectoryPath = newLatest

                if( MemoView.#currentDirectoryState ) {
                    const state = MemoView.#currentDirectoryState
                    state.absolutePath = newLatest

                    if( state.watcher ) {
                        state.watcher.close()
                    }

                    const { watcher } = MemoView.#startFileWatcher( { state } )
                    state.watcher = watcher

                    const { content } = await MemoView.#readFileContent( { absolutePath: newLatest } )
                    const fileName = basename( newLatest )
                    await MemoView.#broadcastContent( { clients: state.clients, content, fileName, absolutePath: newLatest } )

                    process.stdout.write( `  New revision: ${fileName}\n` )
                }
            }
        } )

        MemoView.#currentDirectoryPath = latestPath

        return { startResult }
    }


    static #registry = null
    static #transcriptRegistry = null
    static #serverInstance = null
    static #wssInstance = null
    // PRD-004 (Memo 022 Kap 8): config boot result, read ONCE at startup (see startServer).
    static #config = null


    static async startServer( { port } ) {
        let portNumber

        if( port !== undefined ) {
            portNumber = parseInt( port, 10 )
        } else {
            const { availablePort } = await MemoView.#findAvailablePort()

            if( availablePort === null ) {
                process.stderr.write( `\nError: All memo-view ports are in use.\n\n` )
                process.exit( 1 )
            }

            portNumber = availablePort
        }

        // PRD-004 (Memo 022 Kap 8): boot the config ONCE before the server starts. The result is
        // stored as a static field and later injected into the client HTML (#buildHtmlPage).
        const { config } = await Config.boot()
        MemoView.#config = config

        const onChange = ( { documentId, event } ) => {
            if( MemoView.#wssInstance && MemoView.#registry ) {
                const { tree, latest } = MemoView.buildDocumentListPayload()
                const message = JSON.stringify( { 'type': 'documentList', tree, latest } )

                MemoView.#wssInstance.clients
                    .forEach( ( ws ) => {
                        if( ws.readyState === 1 ) {
                            ws.send( message )
                        }
                    } )
            }
        }

        const { registry } = DocumentRegistry.create( { onChange } )
        MemoView.#registry = registry

        const transcriptHost = `http://localhost:${portNumber}`
        const onTranscriptChange = () => {
            if( MemoView.#wssInstance && MemoView.#transcriptRegistry ) {
                const { tree } = MemoView.#transcriptRegistry.getTranscriptTree()
                const message = JSON.stringify( { 'type': 'transcriptList', tree } )

                MemoView.#wssInstance.clients
                    .forEach( ( ws ) => {
                        if( ws.readyState === 1 ) {
                            ws.send( message )
                        }
                    } )

                // BUGFIX (fix/transcript-abschliessen-queue): an Einloggen/Ausloggen change flips a
                // revision's derived revisionStatus, which decides queue membership. Re-broadcast the
                // enriched documentList so the abgeschlossene Revision leaves the queue live, without
                // a manual reload (Soll-Semantik #4).
                if( MemoView.#registry ) {
                    const { tree: docTree, latest } = MemoView.buildDocumentListPayload()
                    const docMessage = JSON.stringify( { 'type': 'documentList', 'tree': docTree, latest } )

                    MemoView.#wssInstance.clients
                        .forEach( ( ws ) => {
                            if( ws.readyState === 1 ) {
                                ws.send( docMessage )
                            }
                        } )
                }
            }
        }

        const { registry: transcriptRegistry } = TranscriptRegistry.create( { 'onChange': onTranscriptChange, 'host': transcriptHost } )
        MemoView.#transcriptRegistry = transcriptRegistry

        // Re-register bootstrapped ("other") transcripts from disk so their URLs survive a
        // server restart. projectId/sequence are recovered from the filename.
        const { registered: otherRegistered } = await transcriptRegistry.scanOther( { 'otherRoot': process.cwd() } )

        if( otherRegistered > 0 ) {
            process.stdout.write( `  Re-registered ${ otherRegistered } other transcript(s) from disk\n` )
        }

        const state = {
            'absolutePath': null,
            'watcher': null,
            'clients': null
        }

        MemoView.#currentDirectoryState = state

        const { html } = MemoView.#buildHtmlPage( { port: portNumber } )
        const { handler } = MemoView.#createHttpHandler( { html, state } )

        const server = createServer( handler )

        await new Promise( ( resolvePromise ) => {
            server.on( 'error', ( err ) => {
                if( err.code === 'EADDRINUSE' ) {
                    process.stderr.write( `\nError: Port ${portNumber} is already in use.\n\n` )
                    process.exit( 1 )
                }

                throw err
            } )

            server.listen( portNumber, BIND_HOST, () => {
                resolvePromise()
            } )
        } )

        MemoView.#serverInstance = server
        const url = `http://localhost:${portNumber}`

        const { wss, clients } = MemoView.#setupWebSocket( { server, state } )
        MemoView.#wssInstance = wss
        state.clients = clients

        MemoView.#registerShutdown( { server, wss, state } )

        const { registry: planRegistry } = PlanRegistry.create()
        MemoView.#planRegistry = planRegistry
        await MemoView.#planRegistry.loadFromDisk()

        const plansRoot = resolve( process.cwd(), '.memo', 'plans' )
        MemoView.#startPlansWatcher( { wss, rootPath: plansRoot } )

        try {
            await access( plansRoot )
            const cwdProjectId = basename( process.cwd() ).replace( /[^a-zA-Z0-9_-]/g, '-' )
            await MemoView.#planRegistry.add( {
                'absolutePath': plansRoot,
                'projectId': cwdProjectId,
                'onChange': () => { MemoView.#broadcastPlanList( { wss } ) }
            } )
        } catch {
            // cwd has no .memo/plans — skip auto-register
        }

        process.stdout.write( `\n  memo-view server started (multi-document mode)\n` )
        process.stdout.write( `  API:      ${url}/api/documents\n` )
        process.stdout.write( `  Editor:   ${url}\n` )
        process.stdout.write( `  Press Ctrl+C to stop.\n\n` )

        MemoView.#openBrowser( { url } )

        const startResult = true

        return { startResult, registry, port: portNumber }
    }


    static getRegistry() {
        return MemoView.#registry
    }


    // PRD-012 (Memo 011 Kap 4, F16=A): resolve the sibling .memo/requirements/ store directory and
    // the eval-set name (memo-<NNN>) for a registered memo. The requirements store lives at
    // <projectRoot>/.memo/requirements/ — the same /.memo/ marker the documents POST handler uses.
    // The eval-set name is derived from the leading number of the memo folder name (e.g.
    // "011-systemverbesserung..." -> "memo-011"). Returns { status, requirementsDir, memoName }.
    static resolveRequirementsLocation( { memoPath, memoName } ) {
        const struct = { 'status': false, 'requirementsDir': null, 'memoName': null }

        if( typeof memoPath !== 'string' ) { return struct }

        const memoMarkerIndex = memoPath.indexOf( '/.memo/' )

        if( memoMarkerIndex === -1 ) { return struct }

        const projectRoot = memoPath.slice( 0, memoMarkerIndex )
        // Dual-scan (Memo 012, Kap 12): the store may be the F16-convention .memo/_requirements/
        // (underscore = shared system folder) or the legacy .memo/requirements/. Underscore wins.
        const underscoredDir = resolve( projectRoot, '.memo', '_requirements' )
        const requirementsDir = existsSync( underscoredDir ) === true ? underscoredDir : resolve( projectRoot, '.memo', 'requirements' )

        const numberMatch = ( typeof memoName === 'string' ? memoName : '' ).match( /^(\d{1,})/ )
        const setName = numberMatch !== null ? `memo-${ numberMatch[ 1 ] }` : null

        struct[ 'status' ] = true
        struct[ 'requirementsDir' ] = requirementsDir
        struct[ 'memoName' ] = setName

        return struct
    }


    static #currentDirectoryPath = null
    static #currentDirectoryState = null


    static async #findLatestRevision( { dirPath } ) {
        const files = await readdir( dirPath )
        const revisionFiles = files
            .filter( ( f ) => {
                if( !f.endsWith( '.md' ) ) { return false }

                const { matched } = MemoView.matchRevisionPattern( { fileName: f } )

                return matched
            } )
            .sort( ( a, b ) => MemoView.#compareRevisionFiles( { a, b } ) )

        if( revisionFiles.length === 0 ) {
            return { latestPath: null }
        }

        const latestPath = resolve( dirPath, revisionFiles[ revisionFiles.length - 1 ] )

        return { latestPath }
    }


    static validationStart( { filePath, port } ) {
        const struct = { 'status': false, 'messages': [] }

        if( filePath === undefined ) {
            struct['messages'].push( 'filePath: Missing value' )
        } else if( typeof filePath !== 'string' ) {
            struct['messages'].push( 'filePath: Must be a string' )
        } else if( filePath.trim().length === 0 ) {
            struct['messages'].push( 'filePath: Must not be empty' )
        } else if( !filePath.endsWith( '.md' ) ) {
            struct['messages'].push( 'filePath: Must be a Markdown file (.md)' )
        }

        if( port !== undefined ) {
            const portNum = parseInt( port, 10 )

            if( isNaN( portNum ) ) {
                struct['messages'].push( 'port: Must be a number' )
            } else if( portNum < 1024 || portNum > 65535 ) {
                struct['messages'].push( 'port: Must be between 1024 and 65535' )
            }
        }

        if( struct['messages'].length > 0 ) {
            return struct
        }

        struct['status'] = true

        return struct
    }


    static async #findAvailablePort() {
        const results = await Promise.all(
            PORT_SCHEMA
                .map( async ( port ) => {
                    const { inUse } = await MemoView.#isPortInUse( { port } )
                    const result = { port, inUse }

                    return result
                } )
        )

        const { availablePort } = MemoView.selectAvailablePort( { 'probeResults': results } )

        return { availablePort }
    }


    static #isPortInUse( { port } ) {
        return new Promise( ( resolvePromise ) => {
            const testServer = createServer()

            testServer.once( 'error', ( err ) => {
                if( err.code === 'EADDRINUSE' ) {
                    resolvePromise( { inUse: true } )
                } else {
                    resolvePromise( { inUse: false } )
                }
            } )

            testServer.once( 'listening', () => {
                testServer.close( () => {
                    resolvePromise( { inUse: false } )
                } )
            } )

            testServer.listen( port, BIND_HOST )
        } )
    }


    // PRD-002 (Memo 016 Kap 2, E2): pure port selection — pick the first not-in-use port from
    // the probe results, else null. Extracted so the selection is unit-testable without sockets
    // (#findAvailablePort delegates here). Probe order is preserved (PORT_SCHEMA order).
    static selectAvailablePort( { probeResults } ) {
        const results = Array.isArray( probeResults ) ? probeResults : []
        const available = results
            .find( ( r ) => r && r['inUse'] === false )
        const availablePort = available ? available['port'] : null

        return { availablePort }
    }


    static #buildHtmlPage( { port } ) {
        const faviconColor = PORT_COLORS[ port ] || '8b949e'

        // PRD-004 (Memo 022 Kap 8): inject the booted config flag into the client HTML. When the
        // config has not been booted (e.g. a unit test that builds HTML without startServer), fall
        // back to the documented default (showOnlyFullRevisions = true).
        let showOnlyFullRevisions = true

        if( MemoView.#config !== null ) {
            const { value } = MemoView.#config.get( { key: 'showOnlyFullRevisions' } )
            showOnlyFullRevisions = value
        }

        const configFlag = showOnlyFullRevisions ? 'true' : 'false'

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>memo-view</title>
    <link rel="icon" id="favicon" href="data:,">
    <link rel="stylesheet" href="/app.css">
</head>
<body>
    <div id="mermaid-modal" role="dialog" aria-modal="true" aria-label="Diagramm-Vollansicht">
        <div id="mermaid-modal-inner">
            <button id="mermaid-modal-close" title="Schliessen (Esc)">&times;</button>
            <div id="mermaid-modal-svg"></div>
        </div>
    </div>
    <div id="nav-bar" role="navigation" aria-label="Hauptnavigation">
        <span id="nav-brand">Memo SOP</span>
        <div id="mode-toggle">
            <button id="mode-transcripts" class="mode-toggle">Transcripts</button>
            <button id="mode-memos" class="mode-toggle active">Memos</button>
            <button id="mode-plans" class="mode-toggle">Plans</button>
        </div>
        <span id="nav-spacer"></span>
        <button id="transcript-new" class="nav-btn-secondary" title="Transcript hinzufügen oder neues Memo bootstrappen">Transcript</button>
        <button id="nav-unlink" class="nav-btn-secondary" title="Memo entkoppeln">Unlink</button>
        <div id="status" title="Server-Verbindung" role="status" aria-live="polite" aria-label="Server-Verbindung"></div>
    </div>
    <!-- PRD-016 (Memo 016, E9): visible offline banner. The 6px #status dot only became
         faintly visible after 2 failed attempts; this banner is shown from the FIRST failed
         attempt so a disconnected server is immediately obvious. Hidden while connected. -->
    <div id="offline-banner" class="offline-banner offline-banner-hidden" role="alert" aria-live="assertive" aria-hidden="true">Offline — Server nicht erreichbar. Verbindung wird wiederhergestellt…</div>
    <div id="transcript-modal" class="t-modal t-hidden" role="dialog" aria-modal="true" aria-labelledby="t-modal-title">
        <div class="t-modal-content">
            <div class="t-modal-header">
                <span class="t-title" id="t-modal-title">Transcript hinzufügen</span>
                <span class="t-header-spacer"></span>
                <button class="t-close" id="t-cancel-x" title="Schliessen">&times;</button>
            </div>
            <div class="t-modal-body">
                <div class="t-tabs" id="t-tabs">
                    <button class="t-tab active" id="t-tab-new" data-tab="new">Memo erstellen</button>
                    <button class="t-tab" id="t-tab-add" data-tab="add">zum Memo hinzufügen</button>
                </div>
                <div class="t-tab-panel t-hidden" id="t-panel-revision">
                    <div class="t-hint">Autofill: aktuelle Position vorausgewählt</div>
                    <div class="t-field-row">
                        <div class="t-field">
                            <span class="t-field-label">Projekt</span>
                            <input id="t-project" readonly />
                        </div>
                        <div class="t-field">
                            <span class="t-field-label">Memo</span>
                            <input id="t-memo" readonly />
                        </div>
                        <div class="t-field">
                            <span class="t-field-label">Revision</span>
                            <input id="t-revision" />
                        </div>
                    </div>
                    <span class="t-field-label-strong">Transcript</span>
                    <textarea id="t-content" placeholder="Transcript hier einfuegen oder eintippen..."></textarea>
                </div>
                <div class="t-tab-panel t-hidden" id="t-panel-prompt">
                    <div class="pp-section pp-transcript" data-pp-transcript>
                        <span class="pp-section-label">1 · TRANSCRIPT (optional)</span>
                        <div class="pp-field-row">
                            <div class="t-field">
                                <span class="t-field-label">Projekt</span>
                                <input id="pp-project" readonly />
                            </div>
                            <div class="t-field">
                                <span class="t-field-label">Memo</span>
                                <input id="pp-memo" readonly />
                            </div>
                            <div class="t-field">
                                <span class="t-field-label">Revision</span>
                                <input id="pp-revision" />
                            </div>
                        </div>
                        <textarea id="pp-content" placeholder="Aufnehmen oder Text einfügen..."></textarea>
                        <span class="pp-tcount" id="pp-tcount" data-pp-tcount></span>
                    </div>
                    <div class="pp-section pp-questions" data-pp-questions>
                        <span class="pp-section-label" id="pp-questions-label" data-pp-questions-label>2 · FRAGEN BEANTWORTEN (0 / 0)</span>
                        <div id="pp-questions-list" class="pp-questions-list"></div>
                    </div>
                    <div id="pp-error" class="t-error t-hidden"></div>
                    <div id="pp-success" class="pp-success t-hidden"></div>
                </div>
                <div class="t-tab-panel" id="t-panel-new">
                    <div class="t-hint">Neues Memo per Transcript bootstrappen — Nummer/Ablageort bestimmt später die AI</div>
                    <span class="t-field-label-strong">Namespace (Pflicht)</span>
                    <select id="t2-namespace"></select>
                    <span class="t-field-label-strong">Bootstrap-Text</span>
                    <textarea id="t2-content" placeholder="Transcript-Inhalt zum Bootstrappen eines neuen Memos..."></textarea>
                </div>
                <div class="t-tab-panel t-hidden" id="t-panel-add">
                    <div class="t-hint">Freies Transcript an ein bestehendes Memo anhängen (ohne Revisions-Bindung)</div>
                    <div class="t-field-row">
                        <div class="t-field">
                            <span class="t-field-label">Namespace</span>
                            <select id="ta-namespace"></select>
                        </div>
                        <div class="t-field">
                            <span class="t-field-label">Memo (neuestes zuerst)</span>
                            <select id="ta-memo"></select>
                        </div>
                    </div>
                    <span class="t-field-label-strong">Transcript</span>
                    <textarea id="ta-content" placeholder="Transcript hier einfuegen oder eintippen..."></textarea>
                </div>
                <div class="t-url-box" id="t-url-box">🔗 URL erscheint erst nach dem Speichern</div>
                <div id="t-error" class="t-error t-hidden"></div>
                <div class="t-actions" id="t-actions-default">
                    <span class="t-wordcount" id="t-wordcount"></span>
                    <button id="t-save" class="t-btn-primary">Transcript speichern</button>
                </div>
                <div class="t-footnote" id="t-footnote-default">Speichern wird ausgegraut, wenn Inhalt unverändert (Dedupe).</div>
                <div class="pp-footer t-hidden" id="pp-footer">
                    <span class="pp-footer-note" data-pp-note>Alles bleibt im Prompt — nichts wegklickbar</span>
                    <button id="pp-apply" class="t-btn-primary" data-pp-apply>Übernehmen</button>
                </div>
                <div id="t-saved-state" class="t-saved-state t-hidden">
                    <p>Transcript gespeichert:</p>
                    <div class="t-url-row">
                        <code class="t-url" id="t-saved-url"></code>
                        <button id="t-copy-inline" class="t-copy-inline" title="URL kopieren" aria-label="URL kopieren">⧉</button>
                    </div>
                    <p id="t-autocopy-hint" class="t-autocopy-hint t-hidden"></p>
                    <div class="t-actions">
                        <button id="t-close" class="t-btn-secondary">Schliessen</button>
                        <button id="t-copy" class="t-btn-primary">URL kopieren</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <div id="plan-modal" class="t-modal t-hidden" role="dialog" aria-modal="true" aria-labelledby="p-modal-title">
        <div class="t-modal-content">
            <div class="t-modal-header">
                <span class="t-title" id="p-modal-title">🗂 Neuer Plan</span>
                <span class="t-header-spacer"></span>
                <button class="t-close" id="p-cancel-x" title="Schliessen">&times;</button>
            </div>
            <div class="t-modal-body">
                <div class="t-hint">= Prompt-Generierung · absolute Pfade zu den Memos · memo-plan-init / memo-plan-add</div>
                <span class="t-field-label-strong">Memos auswählen (required · nur finalisierte · mehrere möglich)</span>
                <input id="p-search" placeholder="Memo suchen..." />
                <div id="p-memo-list" class="plan-memo-list"></div>
                <span class="t-field-label-strong">Transcript (optional)</span>
                <label class="t-attach-row">＋ Transcript anhängen (optional) <input id="p-transcript" placeholder="Transcript-URL oder leer lassen" style="margin-top:6px" /></label>
                <div id="p-error" class="t-error t-hidden"></div>
                <div class="t-actions">
                    <button id="p-cancel" class="t-btn-secondary">Abbrechen</button>
                    <button id="p-create" class="t-btn-primary">Plan erstellen &rarr;</button>
                </div>
                <div id="p-saved-state" class="t-saved-state t-hidden">
                    <p>Plan-URL:</p>
                    <code class="t-url" id="p-saved-url"></code>
                    <p>Injizierter Prompt (memo-plan-init / memo-plan-add):</p>
                    <pre class="t-url" id="p-saved-prompt"></pre>
                    <div class="t-actions">
                        <button id="p-close" class="t-btn-secondary">Schliessen</button>
                        <button id="p-copy-prompt" class="t-btn-secondary">Prompt kopieren</button>
                        <button id="p-copy" class="t-btn-primary">URL kopieren</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <!-- PRD-012 (Memo 011 Kap 4, F16=A): requirement detail popup. REUSES the existing
         .t-modal / .t-modal-content / .t-modal-header / .t-modal-body classes (centered via
         .t-modal { display:flex; align-items:center; justify-content:center }). NO new overlay CSS. -->
    <div id="requirement-modal" class="t-modal t-hidden" role="dialog" aria-modal="true" aria-labelledby="req-modal-title">
        <div class="t-modal-content">
            <div class="t-modal-header">
                <span class="t-title" id="req-modal-title">Requirement</span>
                <span class="t-header-spacer"></span>
                <button class="t-close" id="req-modal-close" title="Schliessen">&times;</button>
            </div>
            <div class="t-modal-body" id="req-modal-body"></div>
        </div>
    </div>
    <!-- PRD-010 (Memo 014 Kap 2): block detail popup. REUSES the existing .t-modal / .t-modal-content
         / .t-modal-header / .t-modal-body classes (centered via .t-modal { display:flex; ... }), exactly
         like the requirement popup above. NO new overlay/position:fixed CSS for the block modal. -->
    <div id="block-modal" class="t-modal t-hidden" role="dialog" aria-modal="true" aria-labelledby="block-modal-title">
        <div class="t-modal-content">
            <div class="t-modal-header">
                <span class="t-title" id="block-modal-title">Block</span>
                <span class="t-header-spacer"></span>
                <button class="t-close" id="block-modal-close" title="Schliessen">&times;</button>
            </div>
            <div class="t-modal-body" id="block-modal-body"></div>
        </div>
    </div>
    <div id="layout">
        <nav id="doc-sidebar" aria-label="Dokumente">
            <div id="doc-sidebar-body"></div>
        </nav>
        <div id="main" role="main" aria-label="Memo-Inhalt">
            <div id="main-header"></div>
            <div id="content"><p style="color:#888">Waiting for content...</p></div>
        </div>
        <nav id="toc-sidebar" aria-label="Auf dieser Seite">
            <div id="toc-label">Auf dieser Seite</div>
            <ul id="toc-list"></ul>
        </nav>
    </div>

    <!-- PRD-004 (Memo 022 Kap 8): server-injected client config in a DEDICATED early script block.
         Kept separate from the main inline script so the latter stays free of template
         interpolation (source-slice unit tests assert no '\${' in the main script). -->
    <script>
        window.__MEMO_CONFIG__ = { showOnlyFullRevisions: ${configFlag} }
    </script>
    <script src="https://cdn.jsdelivr.net/npm/marked@15.0.0/marked.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
    <script src="/app.client.mjs"></script>
</body>
</html>`

        return { html }
    }


    static #createHttpHandler( { html, state } ) {
        const mimeTypes = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.webp': 'image/webp',
            '.ico': 'image/x-icon',
            '.bmp': 'image/bmp'
        }

        const localPrefix = '/__local__'

        const sendJson = ( res, statusCode, data ) => {
            const body = JSON.stringify( data )

            res.writeHead( statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength( body )
            } )
            res.end( body )
        }

        const readBody = ( req ) => {
            return new Promise( ( resolvePromise ) => {
                const chunks = []

                req.on( 'data', ( chunk ) => {
                    chunks.push( chunk )
                } )

                req.on( 'end', () => {
                    const body = Buffer.concat( chunks ).toString( 'utf-8' )

                    resolvePromise( { body } )
                } )
            } )
        }

        const handler = async ( req, res ) => {
            const url = decodeURIComponent( req.url.split( '?' )[0] )

            if( url === '/api/documents' && req.method === 'POST' ) {

                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = JSON.parse( body )
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                const { projectId, memoPath } = parsed
                const result = await MemoView.#registry.addDocument( { projectId, memoPath } )

                if( !result['status'] ) {
                    sendJson( res, 400, { 'error': result['messages'].join( '; ' ) } )

                    return
                }

                // PRD-004 Auto-Register-Hook: when a memo is registered, auto-register the
                // sibling .memo/plans/ root for the same projectId (no-op if already registered).
                // Handles both layouts: <root>/.memo/memos/<slug>/ (ressources) and <root>/.memo/<slug>/ (flowmcp).
                if( MemoView.#planRegistry && typeof memoPath === 'string' ) {
                    const memoMarkerIndex = memoPath.indexOf( '/.memo/' )

                    if( memoMarkerIndex !== -1 ) {
                        const projectRoot = memoPath.slice( 0, memoMarkerIndex )
                        const candidatePlansRoot = resolve( projectRoot, '.memo', 'plans' )
                        const existing = await MemoView.#planRegistry.resolveByProjectId( { projectId } )

                        if( !existing[ 'status' ] ) {
                            try {
                                await access( candidatePlansRoot )
                                await MemoView.#planRegistry.add( {
                                    'absolutePath': candidatePlansRoot,
                                    projectId,
                                    'onChange': () => { MemoView.#broadcastPlanList( { 'wss': MemoView.#wssInstance } ) }
                                } )
                                process.stdout.write( `  Plans-Root auto-registered: ${projectId} -> ${candidatePlansRoot}\n` )

                                if( MemoView.#wssInstance ) {
                                    MemoView.#broadcastPlanList( { 'wss': MemoView.#wssInstance } )
                                }
                            } catch {
                                // no sibling .memo/plans/ for this project — skip silently
                            }
                        }
                    }
                }

                if( MemoView.#transcriptRegistry ) {
                    const documentId = result[ 'documentId' ]
                    const docDetail = MemoView.#registry.getDocument( { documentId } )

                    if( docDetail[ 'status' ] ) {
                        const memoName = docDetail[ 'document' ][ 'memoName' ]
                        const absMemoPath = docDetail[ 'document' ][ 'memoPath' ]
                        const memoDir = basename( absMemoPath ) === 'revisions' ? dirname( absMemoPath ) : absMemoPath

                        await MemoView.#transcriptRegistry.scanMemo( {
                            'memoPath': memoDir,
                            projectId,
                            'memoId': memoName
                        } )
                    }
                }

                if( MemoView.#wssInstance ) {
                    const { tree, latest } = MemoView.buildDocumentListPayload()
                    const message = JSON.stringify( { 'type': 'documentList', tree, latest } )

                    MemoView.#wssInstance.clients
                        .forEach( ( ws ) => {
                            if( ws.readyState === 1 ) {
                                ws.send( message )
                            }
                        } )

                    if( MemoView.#transcriptRegistry ) {
                        const { tree: tTree } = MemoView.#transcriptRegistry.getTranscriptTree()
                        const tMessage = JSON.stringify( { 'type': 'transcriptList', 'tree': tTree } )

                        MemoView.#wssInstance.clients
                            .forEach( ( ws ) => {
                                if( ws.readyState === 1 ) {
                                    ws.send( tMessage )
                                }
                            } )
                    }
                }

                sendJson( res, 200, {
                    'status': 'ok',
                    'documentId': result['documentId'],
                    'revisionsFound': result['revisionsFound']
                } )

                process.stdout.write( `  Document added: ${result['documentId']} (${result['revisionsFound']} revisions)\n` )

                return
            }

            if( url === '/api/documents' && req.method === 'GET' ) {

                const { documents } = MemoView.#registry.getDocuments()

                if( MemoView.#transcriptRegistry ) {
                    const { tree: transcriptTree } = MemoView.#transcriptRegistry.getTranscriptTree()
                    MemoView.enrichDocumentsList( { documents, transcriptTree } )
                }

                sendJson( res, 200, { documents } )

                return
            }

            // PRD-012 (Memo 011 Kap 4, F16=A): read-only requirements view model for one memo —
            // PRD-level groups + memo aggregate, resolved from the sibling .memo/requirements/ store.
            // MUST be matched BEFORE the generic /api/documents/<id> GET below (the suffix is more
            // specific; otherwise the generic route would swallow "<id>/requirements" as the id).
            if( url.startsWith( '/api/documents/' ) && url.endsWith( '/requirements' ) && req.method === 'GET' ) {

                const documentId = url.slice( '/api/documents/'.length, url.length - '/requirements'.length )
                const result = MemoView.#registry.getDocument( { documentId } )

                if( !result[ 'status' ] ) {
                    sendJson( res, 404, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                const doc = result[ 'document' ]
                const location = MemoView.resolveRequirementsLocation( {
                    'memoPath': doc[ 'memoPath' ],
                    'memoName': doc[ 'memoName' ]
                } )

                if( !location[ 'status' ] || location[ 'memoName' ] === null ) {
                    sendJson( res, 200, {
                        'status': 'ok',
                        'documentId': documentId,
                        'memoName': null,
                        'groups': [],
                        'aggregate': [],
                        'count': 0,
                        'missingIds': [],
                        'setPresent': false,
                        'blockRequirementNames': [],
                        'unresolvedBlockRequirements': [],
                        'consistency': MemoView.requirementsConsistency( { 'expectedFromBlocks': 0, 'resolvedCount': 0 } )
                    } )

                    return
                }

                const view = await RequirementsStore.aggregate( {
                    'requirementsDir': location[ 'requirementsDir' ],
                    'memoName': location[ 'memoName' ]
                } )

                // PRD-005 (Memo 016 Kap 4, B3/B5): resolve the SELECTED revision's block requirements
                // (the `req-*` namespace) against the store id index (`REQ-NNN`). Block names come from
                // BlockMeta.parse of the active revision; the namespace lint surfaces every block name
                // that does not map onto a known store id as `unresolvedBlockRequirements` so the view
                // can WARN instead of silently dropping it. Read-only — no writes, mirrors /blocks.
                const blockRequirementNames = await MemoView.#collectBlockRequirementNames( { documentId } )
                const lint = MemoView.resolveBlockRequirements( {
                    'blockRequirementNames': blockRequirementNames,
                    'knownIds': view[ 'knownIds' ]
                } )

                // PRD-014 (Memo 016 Kap 9, B8): the `count` alone could not be checked against the
                // BLOCK reality. Surface a consistency verdict comparing the number of distinct
                // requirement names the blocks EXPECT against the number actually resolved.
                const consistency = MemoView.requirementsConsistency( {
                    'expectedFromBlocks': blockRequirementNames.length,
                    'resolvedCount': view[ 'count' ]
                } )

                sendJson( res, 200, {
                    'status': 'ok',
                    'documentId': documentId,
                    'memoName': view[ 'memoName' ],
                    'groups': view[ 'groups' ],
                    'aggregate': view[ 'aggregate' ],
                    'count': view[ 'count' ],
                    'missingIds': view[ 'missingIds' ],
                    'setPresent': view[ 'setPresent' ],
                    'blockRequirementNames': blockRequirementNames,
                    'unresolvedBlockRequirements': lint[ 'unresolved' ],
                    'consistency': consistency
                } )

                return
            }

            // PRD-010 (Memo 014 Kap 2): read-only block overlay model for one memo — the structured
            // blocks parsed by BlockMeta.parse from the selected revision's markdown. MUST be matched
            // BEFORE the generic /api/documents/<id> GET below (the suffix is more specific; otherwise
            // the generic route would swallow "<id>/blocks" as the id). Mirror of the /requirements route.
            if( url.startsWith( '/api/documents/' ) && url.endsWith( '/blocks' ) && req.method === 'GET' ) {

                const documentId = url.slice( '/api/documents/'.length, url.length - '/blocks'.length )
                const result = MemoView.#registry.getDocument( { documentId } )

                if( !result[ 'status' ] ) {
                    sendJson( res, 404, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                const { absolutePath } = MemoView.#registry.getSelectedRevisionPath( { documentId } )

                if( !absolutePath ) {
                    sendJson( res, 200, { 'status': 'ok', 'documentId': documentId, 'blocks': [], 'errors': [] } )

                    return
                }

                const { content } = await MemoView.#readFileContent( { absolutePath } )
                // PRD-014 (Memo 016 Kap 9, A10): keep the parse `errors` (unparseable block-meta
                // fences) — they used to be destructured away and silently discarded, so a memo with
                // ONLY broken fences looked identical to one with no blocks at all.
                const { blocks, errors } = BlockMeta.parse( { doc: content } )

                // PRD-004 (Memo 016 Kap 3, A7): enrich every child block with its effective
                // requirements (parent default ∪ child additive) by INVOKING the partition helper,
                // which calls BlockMeta.effectiveRequirements — no longer dead code. Children arrive
                // pre-computed so the client renders real requirement chips even without re-deriving.
                const { groups, orphans } = MemoView.partitionBlocks( { blocks } )
                const enrichedChildren = groups
                    .map( ( group ) => group.parents.map( ( parent ) => parent.children ) )
                    .flat( 2 )
                    .concat( orphans )
                const childByKey = new Map( enrichedChildren.map( ( child ) => [ `${ child.topic }|${ child.id }`, child ] ) )
                const enrichedBlocks = blocks.map( ( block ) => {
                    if( block.role !== 'child' ) { return block }
                    const match = childByKey.get( `${ block.topic }|${ block.id }` )

                    return match ? match : block
                } )

                // PRD-014 (Memo 016 Kap 9, A10): `errors` is surfaced so the view can show the parse
                // failures instead of a blank panel (reuses the same empty-/error-state component).
                sendJson( res, 200, { 'status': 'ok', 'documentId': documentId, 'blocks': enrichedBlocks, 'errors': errors } )

                return
            }

            if( url.startsWith( '/api/documents/' ) && req.method === 'GET' ) {

                const documentId = url.slice( '/api/documents/'.length )
                const result = MemoView.#registry.getDocument( { documentId } )

                if( !result['status'] ) {
                    sendJson( res, 404, { 'error': result['messages'].join( '; ' ) } )

                    return
                }

                const doc = result['document']
                const revisions = ( doc['revisions'] || [] )
                    .map( ( r ) => {
                        return {
                            'fileName': r['fileName'],
                            'mtime': r['mtime'] || null,
                            'mtimeMs': r['mtimeMs'] || 0,
                            'sizeKb': r['sizeKb'] || 0,
                            'revisionType': r['revisionType'] || null
                        }
                    } )

                sendJson( res, 200, {
                    'documentId': doc['documentId'],
                    'projectId': doc['projectId'],
                    'memoName': doc['memoName'],
                    'memoPath': doc['memoPath'],
                    'documentKind': doc['documentKind'] || 'memo',
                    'status': doc['status'],
                    'memoStatus': doc['memoStatus'] || 'Entwurf',
                    'questions': doc['questions'] || { 'open': 0, 'answered': 0 },
                    'selectedRevision': doc['selectedRevision'],
                    'revisionCount': revisions.length,
                    'revisions': revisions
                } )

                return
            }

            if( url.startsWith( '/api/documents/' ) && req.method === 'DELETE' ) {

                const documentId = url.slice( '/api/documents/'.length )
                const result = MemoView.#registry.removeDocument( { documentId } )

                if( !result['status'] ) {
                    sendJson( res, 404, { 'error': result['messages'].join( '; ' ) } )

                    return
                }

                if( MemoView.#wssInstance ) {
                    const { tree, latest } = MemoView.buildDocumentListPayload()
                    const message = JSON.stringify( { 'type': 'documentList', tree, latest } )

                    MemoView.#wssInstance.clients
                        .forEach( ( ws ) => {
                            if( ws.readyState === 1 ) {
                                ws.send( message )
                            }
                        } )
                }

                sendJson( res, 200, { 'status': 'ok' } )

                process.stdout.write( `  Document removed: ${documentId}\n` )

                return
            }

            if( url === '/api/transcripts' && req.method === 'POST' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = JSON.parse( body )
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                const { projectId, memoId, revisionId, content, sequence, memoPath, complete } = parsed

                // PRD-005 (Memo 019, Kap 5): reject-gate BEFORE addTranscript. The deterministic
                // validator enforces the strict question-format from PRD-004 (Kopplung Kap 4<->5).
                // On a question-format violation (MEMO-020*/025/030/040/050) the write is REFUSED
                // with HTTP 422 and the Error-Codes in the response — addTranscript is NOT called.
                // Bodies without questions (incl. the "nur Antworten" exception path) pass through.
                const { reject, messages: rejectMessages } = MemoView.#computeQuestionReject( { content } )

                if( reject ) {
                    sendJson( res, 422, { 'error': rejectMessages.join( '; ' ), 'messages': rejectMessages } )

                    return
                }

                let resolvedMemoPath = memoPath

                if( !resolvedMemoPath && MemoView.#registry ) {
                    const documentId = `${ projectId }--${ memoId }`
                    const docDetail = MemoView.#registry.getDocument( { documentId } )

                    if( docDetail[ 'status' ] ) {
                        resolvedMemoPath = docDetail[ 'document' ][ 'memoPath' ]
                    }
                }

                const result = await MemoView.#transcriptRegistry.addTranscript( {
                    projectId,
                    memoId,
                    revisionId,
                    content,
                    sequence,
                    'memoPath': resolvedMemoPath,
                    // PRD-027/028: pass the completeness flag through. Undefined -> default
                    // vollstaendig in addTranscript; "ohne Transcript speichern" sends false.
                    complete
                } )

                if( !result[ 'status' ] ) {
                    sendJson( res, 400, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, {
                    'status': 'ok',
                    'transcriptId': result[ 'transcriptId' ],
                    'url': result[ 'url' ]
                } )

                process.stdout.write( `  Transcript added: ${ result[ 'transcriptId' ] }\n` )

                return
            }

            if( url === '/api/transcripts' && req.method === 'GET' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const queryString = req.url.split( '?' )[ 1 ] || ''
                const params = new URLSearchParams( queryString )
                const memoIdParam = params.get( 'memoId' )

                const { transcripts } = MemoView.#transcriptRegistry.listTranscripts( { 'memoId': memoIdParam || undefined } )

                sendJson( res, 200, { transcripts } )

                return
            }

            if( url.startsWith( '/api/transcripts/' ) && req.method === 'GET' ) {

                if( !MemoView.#transcriptRegistry ) {
                    res.writeHead( 503, { 'Content-Type': 'text/plain' } )
                    res.end( 'Transcript registry not initialized' )

                    return
                }

                const transcriptId = url.slice( '/api/transcripts/'.length )
                const result = await MemoView.#transcriptRegistry.getTranscript( { transcriptId } )

                if( !result[ 'status' ] ) {
                    res.writeHead( 404, { 'Content-Type': 'text/plain' } )
                    res.end( result[ 'messages' ].join( '; ' ) )

                    return
                }

                res.writeHead( 200, {
                    'Content-Type': 'text/markdown; charset=utf-8',
                    'Cache-Control': 'no-cache'
                } )
                res.end( result[ 'content' ] )

                return
            }

            if( url.startsWith( '/api/transcripts/' ) && req.method === 'PUT' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const transcriptId = url.slice( '/api/transcripts/'.length )
                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = JSON.parse( body )
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                const { content } = parsed
                const result = await MemoView.#transcriptRegistry.updateTranscript( { transcriptId, content } )

                if( !result[ 'status' ] ) {
                    const statusCode = result[ 'messages' ].some( ( m ) => m.includes( 'NOTFOUND' ) ) ? 404 : 400
                    sendJson( res, statusCode, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, { 'status': 'ok' } )

                process.stdout.write( `  Transcript updated: ${ transcriptId }\n` )

                return
            }

            if( url.startsWith( '/api/transcripts/' ) && url.endsWith( '/login' ) && req.method === 'POST' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const transcriptId = url.slice( '/api/transcripts/'.length, -'/login'.length )
                const result = await MemoView.#handleTranscriptLoginToggle( { transcriptId, 'mode': 'login' } )

                if( !result[ 'status' ] ) {
                    sendJson( res, result[ 'httpStatus' ], { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, { 'status': 'ok', 'revisionId': result[ 'revisionId' ] } )

                process.stdout.write( `  Transcript logged in: ${ transcriptId }\n` )

                return
            }

            if( url.startsWith( '/api/transcripts/' ) && url.endsWith( '/logout' ) && req.method === 'POST' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const transcriptId = url.slice( '/api/transcripts/'.length, -'/logout'.length )
                const result = await MemoView.#handleTranscriptLoginToggle( { transcriptId, 'mode': 'logout' } )

                if( !result[ 'status' ] ) {
                    sendJson( res, result[ 'httpStatus' ], { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, { 'status': 'ok', 'revisionId': result[ 'revisionId' ] } )

                process.stdout.write( `  Transcript logged out: ${ transcriptId }\n` )

                return
            }

            if( url.startsWith( '/api/transcripts/' ) && req.method === 'DELETE' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const transcriptId = url.slice( '/api/transcripts/'.length )
                const { body } = await readBody( req )
                let parsed = {}

                if( body.length > 0 ) {
                    try {
                        parsed = JSON.parse( body )
                    } catch {
                        sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                        return
                    }
                }

                if( parsed[ 'confirm' ] !== true ) {
                    sendJson( res, 400, { 'error': 'DELETE requires {"confirm": true}' } )

                    return
                }

                const result = await MemoView.#transcriptRegistry.deleteTranscript( { transcriptId } )

                if( !result[ 'status' ] ) {
                    sendJson( res, 404, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, { 'status': 'ok' } )

                process.stdout.write( `  Transcript deleted: ${ transcriptId }\n` )

                return
            }

            if( url === '/api/plans/open-memos' && req.method === 'GET' ) {

                const queryString = req.url.split( '?' )[ 1 ] || ''
                const params = new URLSearchParams( queryString )
                const projectIdParam = params.get( 'projectId' )

                const { plans } = await MemoView.#aggregatePlansFromRegistry()
                const { documents } = MemoView.#registry.getDocuments()
                const { openMemos } = MemoView.computeOpenFinalizedMemos( {
                    'projectId': projectIdParam || undefined,
                    plans,
                    documents
                } )

                sendJson( res, 200, { openMemos } )

                return
            }

            if( url === '/api/plans' && req.method === 'GET' ) {

                if( !MemoView.#planRegistry ) {
                    sendJson( res, 200, { 'roots': [] } )

                    return
                }

                const { plans: entries } = await MemoView.#planRegistry.list()

                const roots = await Promise.all(
                    entries
                        .map( async ( entry ) => {
                            const { plans: rootPlans } = await MemoView.#scanPlans( { 'rootPath': entry['absolutePath'] } )

                            return {
                                'projectId': entry['projectId'],
                                'absolutePath': entry['absolutePath'],
                                'planCount': rootPlans.length
                            }
                        } )
                )

                sendJson( res, 200, { roots } )

                return
            }

            if( url === '/api/plans' && req.method === 'POST' ) {

                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = JSON.parse( body )
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                const { projectId, planPath } = parsed

                if( !planPath || typeof planPath !== 'string' || planPath.trim() === '' ) {
                    sendJson( res, 400, { 'error': 'planPath: Missing or invalid — must be a non-empty string' } )

                    return
                }

                if( !projectId || typeof projectId !== 'string' || projectId.trim() === '' ) {
                    sendJson( res, 400, { 'error': 'projectId: Missing or invalid — must be a non-empty string' } )

                    return
                }

                const wssRef = MemoView.#wssInstance

                const addResult = await MemoView.#planRegistry.add( {
                    'absolutePath': planPath.trim(),
                    'projectId': projectId.trim(),
                    'onChange': () => { MemoView.#broadcastPlanList( { 'wss': wssRef } ) }
                } )

                if( !addResult['status'] ) {
                    sendJson( res, 400, { 'error': addResult['messages'].join( '; ' ) } )

                    return
                }

                const { plans: rootPlans } = await MemoView.#scanPlans( { 'rootPath': planPath.trim() } )

                sendJson( res, 200, {
                    'status': 'ok',
                    'registeredCount': rootPlans.length,
                    'projectId': projectId.trim(),
                    'rootPath': planPath.trim()
                } )

                return
            }

            // DELETE /api/plans/:projectId — planRootKey is the projectId of the registered root.
            // Design choice: projectId is used as the key because it is already validated as
            // alphanumeric/hyphen/underscore-only, is unique per POST call, and matches how
            // GET /api/plans lists roots. planId (the per-folder compound key) is NOT used here
            // because a root registration groups multiple plan folders.
            if( url.startsWith( '/api/plans/' ) && req.method === 'DELETE' ) {

                const planRootKey = url.slice( '/api/plans/'.length )

                if( !planRootKey || !MemoView.#planRegistry ) {
                    sendJson( res, 404, { 'error': 'Not Found' } )

                    return
                }

                const { plans: entries } = await MemoView.#planRegistry.list()
                const matchingEntry = entries.find( ( e ) => e['projectId'] === planRootKey )

                if( !matchingEntry ) {
                    sendJson( res, 404, { 'error': `No registered root found for projectId: ${planRootKey}` } )

                    return
                }

                // Remove all plans under this projectId
                const toRemove = entries.filter( ( e ) => e['projectId'] === planRootKey )

                await Promise.all(
                    toRemove
                        .map( ( e ) => MemoView.#planRegistry.remove( { 'planId': e['planId'] } ) )
                )

                sendJson( res, 200, { 'status': 'ok' } )

                return
            }

            if( url === '/api/other/transcripts' && req.method === 'POST' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = JSON.parse( body )
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                const { projectId, content } = parsed
                const otherRoot = parsed[ 'otherRoot' ] || process.cwd()
                // PRD-002 (Memo 019 Kap 2): the "Neues Memo erstellen"-Flow passes type:'memo-init'
                // so the saved transcript carries the memo-init header. Undefined -> 'frei' default
                // in addOtherTranscript (kein stiller Default — bewusst vom Memo vorgegeben).
                const type = parsed[ 'type' ]

                const result = await MemoView.#transcriptRegistry.addOtherTranscript( { projectId, content, otherRoot, type } )

                if( !result[ 'status' ] ) {
                    sendJson( res, 400, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, {
                    'status': 'ok',
                    'transcriptId': result[ 'transcriptId' ],
                    'url': result[ 'url' ]
                } )

                process.stdout.write( `  Transcript added (other): ${ result[ 'transcriptId' ] }\n` )

                return
            }

            // PRD-003 (Memo 019 Kap 3): "zum Memo hinzufuegen" — store a FREE transcript inside an
            // existing memo's transcripts/ folder (no revision binding). Resolves the memoPath from
            // the DocumentRegistry (same as POST /api/transcripts) when not passed explicitly.
            if( url === '/api/memo/transcripts' && req.method === 'POST' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = JSON.parse( body )
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                const { projectId, memoId, content, memoPath } = parsed

                let resolvedMemoPath = memoPath

                if( !resolvedMemoPath && MemoView.#registry ) {
                    const documentId = `${ projectId }--${ memoId }`
                    const docDetail = MemoView.#registry.getDocument( { documentId } )

                    if( docDetail[ 'status' ] ) {
                        resolvedMemoPath = docDetail[ 'document' ][ 'memoPath' ]
                    }
                }

                const result = await MemoView.#transcriptRegistry.addFreeMemoTranscript( { projectId, memoId, content, 'memoPath': resolvedMemoPath } )

                if( !result[ 'status' ] ) {
                    sendJson( res, 400, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, {
                    'status': 'ok',
                    'transcriptId': result[ 'transcriptId' ],
                    'url': result[ 'url' ]
                } )

                process.stdout.write( `  Transcript added (free memo): ${ result[ 'transcriptId' ] }\n` )

                return
            }

            // PRD-002 (Memo 024 Kap 2): bind an Initial-Transcript to a memo as transcripts/init.md.
            // The previously unreachable addInitTranscript() gets its HTTP route here so the
            // "Neues Memo"-Flow can promote the bootstrap transcript into the memo (instead of
            // leaving it as a loose global "other" transcript). memoPath is resolved from the
            // DocumentRegistry exactly like POST /api/memo/transcripts. addInitTranscript enforces
            // the NO-OVERWRITE rule: an existing init.md is reported back, never silently replaced.
            if( url === '/api/memo/init-transcript' && req.method === 'POST' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = JSON.parse( body )
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                const { projectId, memoId, content, memoPath } = parsed

                let resolvedMemoPath = memoPath

                if( !resolvedMemoPath && MemoView.#registry ) {
                    const documentId = `${ projectId }--${ memoId }`
                    const docDetail = MemoView.#registry.getDocument( { documentId } )

                    if( docDetail[ 'status' ] ) {
                        resolvedMemoPath = docDetail[ 'document' ][ 'memoPath' ]
                    }
                }

                const result = await MemoView.#transcriptRegistry.addInitTranscript( { projectId, memoId, content, 'memoPath': resolvedMemoPath } )

                if( !result[ 'status' ] ) {
                    const statusCode = result[ 'messages' ].some( ( m ) => m.includes( 'SEQ-001' ) ) ? 409 : 400
                    sendJson( res, statusCode, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, {
                    'status': 'ok',
                    'transcriptId': result[ 'transcriptId' ],
                    'url': result[ 'url' ]
                } )

                process.stdout.write( `  Transcript added (init): ${ result[ 'transcriptId' ] }\n` )

                return
            }

            if( url === '/api/other/transcripts' && req.method === 'GET' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const queryString = req.url.split( '?' )[ 1 ] || ''
                const params = new URLSearchParams( queryString )
                const otherRootParam = params.get( 'otherRoot' )

                const { transcripts } = MemoView.#transcriptRegistry.listOtherTranscripts( { 'otherRoot': otherRootParam || undefined } )

                sendJson( res, 200, { transcripts } )

                return
            }

            if( url.startsWith( '/api/other/transcripts/' ) && url.endsWith( '/promote' ) && req.method === 'POST' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const middle = url.slice( '/api/other/transcripts/'.length, -'/promote'.length )
                const transcriptId = middle
                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = JSON.parse( body )
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                const { targetMemoPath, memoId, revisionId } = parsed
                const result = await MemoView.#transcriptRegistry.promoteOtherTranscript( { transcriptId, targetMemoPath, memoId, revisionId } )

                if( !result[ 'status' ] ) {
                    const statusCode = result[ 'messages' ].some( ( m ) => m.includes( 'NOTFOUND' ) ) ? 404 : 400
                    sendJson( res, statusCode, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, {
                    'status': 'ok',
                    'transcriptId': result[ 'transcriptId' ],
                    'url': result[ 'url' ]
                } )

                process.stdout.write( `  Transcript promoted: ${ result[ 'transcriptId' ] }\n` )

                return
            }

            if( url.startsWith( '/api/other/transcripts/' ) && url.endsWith( '/transform' ) && req.method === 'POST' ) {

                if( !MemoView.#transcriptRegistry ) {
                    sendJson( res, 503, { 'error': 'Transcript registry not initialized' } )

                    return
                }

                const transcriptId = url.slice( '/api/other/transcripts/'.length, -'/transform'.length )
                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = body && body.length > 0 ? JSON.parse( body ) : {}
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                // PRD-012: only frei -> memo-init. targetType defaults to 'memo-init'.
                const targetType = parsed[ 'targetType' ] || 'memo-init'
                const result = await MemoView.#transcriptRegistry.transformOtherTranscript( { transcriptId, targetType } )

                if( !result[ 'status' ] ) {
                    const statusCode = result[ 'messages' ].some( ( m ) => m.includes( 'NOTFOUND' ) ) ? 404 : 400
                    sendJson( res, statusCode, { 'error': result[ 'messages' ].join( '; ' ) } )

                    return
                }

                sendJson( res, 200, {
                    'status': 'ok',
                    'transcriptId': result[ 'transcriptId' ],
                    'type': result[ 'type' ]
                } )

                process.stdout.write( `  Transcript transformed: ${ result[ 'transcriptId' ] } -> ${ result[ 'type' ] }\n` )

                return
            }

            if( url.startsWith( '/transcripts/' ) && req.method === 'GET' ) {

                if( !MemoView.#transcriptRegistry ) {
                    res.writeHead( 503, { 'Content-Type': 'text/plain' } )
                    res.end( 'Transcript registry not initialized' )

                    return
                }

                const transcriptId = url.slice( '/transcripts/'.length )
                const result = await MemoView.#transcriptRegistry.getTranscript( { transcriptId } )

                if( !result[ 'status' ] ) {
                    res.writeHead( 404, { 'Content-Type': 'text/plain' } )
                    res.end( result[ 'messages' ].join( '; ' ) )

                    return
                }

                res.writeHead( 200, {
                    'Content-Type': 'text/markdown; charset=utf-8',
                    'Cache-Control': 'no-cache'
                } )
                res.end( result[ 'content' ] )

                return
            }

            if( url.startsWith( '/plans/' ) && req.method === 'GET' ) {

                const planId = url.slice( '/plans/'.length )

                // New compound format: {projectId}--{planFolderName}
                if( planId.includes( '--' ) && MemoView.#planRegistry ) {
                    const separatorIndex = planId.indexOf( '--' )
                    const projectIdFromUrl = planId.slice( 0, separatorIndex )
                    const planFolderName = planId.slice( separatorIndex + 2 )
                    const resolveResult = await MemoView.#planRegistry.resolveByProjectId( { 'projectId': projectIdFromUrl } )

                    if( resolveResult['status'] ) {
                        const planMdPath = resolve( resolveResult['root']['absolutePath'], planFolderName, 'plan.md' )

                        try {
                            const content = await readFile( planMdPath, 'utf-8' )

                            res.writeHead( 200, {
                                'Content-Type': 'text/markdown; charset=utf-8',
                                'Cache-Control': 'no-cache'
                            } )
                            res.end( content )
                        } catch {
                            res.writeHead( 404, { 'Content-Type': 'text/plain; charset=utf-8' } )
                            res.end( `Not Found: plan.md for ${ planId }` )
                        }

                        return
                    }
                }

                // Legacy format: plain PLAN-NNN-name (no projectId prefix) — use cwd-root
                if( !/^PLAN-\d{3}-[a-z0-9-]+$/.test( planId ) ) {
                    res.writeHead( 400, { 'Content-Type': 'text/plain; charset=utf-8' } )
                    res.end( 'Invalid planId pattern' )

                    return
                }

                const plansRoot = MemoView.#plansRootPath || resolve( process.cwd(), '.memo', 'plans' )
                const planMdPath = resolve( plansRoot, planId, 'plan.md' )

                try {
                    const content = await readFile( planMdPath, 'utf-8' )

                    res.writeHead( 200, {
                        'Content-Type': 'text/markdown; charset=utf-8',
                        'Cache-Control': 'no-cache'
                    } )
                    res.end( content )
                } catch {
                    res.writeHead( 404, { 'Content-Type': 'text/plain; charset=utf-8' } )
                    res.end( `Not Found: plan.md for ${ planId }` )
                }

                return
            }

            // PRD-010 (Memo 016, F1): static stylesheet route. The app CSS lives in
            // src/public/app.css (extracted from the formerly inline <style> block) and is
            // served from the module-load cache (APP_CSS) — never re-read per request.
            if( url === '/app.css' && req.method === 'GET' ) {
                res.writeHead( 200, {
                    'Content-Type': 'text/css; charset=utf-8',
                    'Content-Length': Buffer.byteLength( APP_CSS ),
                    'Cache-Control': 'no-cache'
                } )
                res.end( APP_CSS )

                return
            }

            // PRD-011 (Memo 016, F1/F2): static client-JS route. The app client code lives in
            // src/public/app.client.mjs (extracted from the formerly inline <script> block) and is
            // served from the module-load cache (APP_CLIENT_JS) — never re-read per request. Served
            // as a classic script (text/javascript) so its top-level functions stay global.
            if( url === '/app.client.mjs' && req.method === 'GET' ) {
                res.writeHead( 200, {
                    'Content-Type': 'text/javascript; charset=utf-8',
                    'Content-Length': Buffer.byteLength( APP_CLIENT_JS ),
                    'Cache-Control': 'no-cache'
                } )
                res.end( APP_CLIENT_JS )

                return
            }

            if( url.startsWith( localPrefix ) ) {
                const filePath = url.slice( localPrefix.length )
                const ext = filePath.substring( filePath.lastIndexOf( '.' ) ).toLowerCase()
                const mime = mimeTypes[ext]

                if( !mime ) {
                    res.writeHead( 400, { 'Content-Type': 'text/plain' } )
                    res.end( 'Unsupported file type' )

                    return
                }

                try {
                    const fileContent = await readFile( filePath )

                    res.writeHead( 200, {
                        'Content-Type': mime,
                        'Content-Length': fileContent.length,
                        'Cache-Control': 'no-cache'
                    } )
                    res.end( fileContent )
                } catch {
                    res.writeHead( 404, { 'Content-Type': 'text/plain' } )
                    res.end( 'Not found' )
                }

                return
            }

            // PRD-005 (Memo 019, Kap 5, Scope 1): separate read-only /validate route for the
            // AI-Vorab-Self-Check. The AI can validate a full revision BEFORE submitting, with
            // NO write. Body { content } (raw revision markdown). HTTP 200 on status:true, HTTP
            // 422 on status:false — the Error-Codes (messages) live in the body in both cases.
            if( url === '/api/validate' && req.method === 'POST' ) {

                const { body } = await readBody( req )
                let parsed

                try {
                    parsed = JSON.parse( body )
                } catch {
                    sendJson( res, 400, { 'error': 'Invalid JSON body' } )

                    return
                }

                const { content } = parsed
                const { validation } = MemoView.#computeValidation( { content } )
                const safe = ( validation !== null && typeof validation === 'object' )
                    ? validation
                    : { 'status': false, 'messages': [ 'MEMO-002 doc: Document is empty or not a string' ], 'info': [] }
                const statusCode = safe[ 'status' ] === true ? 200 : 422

                sendJson( res, statusCode, safe )

                return
            }

            if( url === '/api/mission-control' && req.method === 'GET' ) {

                const { plans } = await MemoView.#aggregatePlansFromRegistry()
                const { projects, totals } = MemoView.computeMissionControl( { plans } )

                sendJson( res, 200, { projects, totals } )

                return
            }

            if( url.startsWith( '/api/' ) ) {
                sendJson( res, 404, { 'error': 'Not Found', 'path': url } )

                return
            }

            // PRD-011: SPA routes. /memos and /plans (without a plan-id) must serve the same
            // HTML page so direct navigation / reload does not 404. The client reads
            // location.pathname and restores the matching view mode.
            const isSpaRoute = url === '/' || url === '/memos' || url === '/plans'

            if( !isSpaRoute ) {
                res.writeHead( 404, { 'Content-Type': 'text/plain; charset=utf-8' } )
                res.end( `Not Found: ${ url }` )

                return
            }

            res.writeHead( 200, { 'Content-Type': 'text/html; charset=utf-8' } )
            res.end( html )
        }

        return { handler }
    }


    static #setupWebSocket( { server, state } ) {
        const clients = new Set()
        const wss = new WebSocketServer( { server } )

        // PRD-016 (Memo 016, E3): WS heartbeat. Without a ping/pong a half-open connection
        // ("server up, wrong path" / TCP black-hole) is indistinguishable from a clean close —
        // the browser keeps a dead socket and never re-arms reconnect. The server pings every
        // HEARTBEAT_INTERVAL_MS; a client that has not ponged since the previous ping is treated
        // as stale and terminated, which drives the client onclose -> reconnect/offline path. The
        // ws library answers a client-sent ping with an automatic pong, so the client can also
        // detect a stale link from its own side.
        const HEARTBEAT_INTERVAL_MS = 30000

        const heartbeat = setInterval( () => {
            wss.clients.forEach( ( ws ) => {
                if( ws.isAlive === false ) {
                    clients.delete( ws )
                    ws.terminate()

                    return
                }

                ws.isAlive = false
                if( ws.readyState === 1 ) {
                    ws.ping()
                }
            } )
        }, HEARTBEAT_INTERVAL_MS )

        wss.on( 'close', () => {
            clearInterval( heartbeat )
        } )

        wss.on( 'connection', ( ws ) => {
            clients.add( ws )

            // PRD-016 (Memo 016, E3): mark the socket alive on connect and on every pong; the
            // heartbeat sweep above flips isAlive to false before each ping and terminates any
            // client that did not answer the previous one.
            ws.isAlive = true
            ws.on( 'pong', () => { ws.isAlive = true } )

            MemoView.#aggregatePlansFromRegistry()
                .then( ( { plans } ) => {
                    const { documents } = MemoView.#registry ? MemoView.#registry.getDocuments() : { 'documents': [] }
                    const { openMemos } = MemoView.computeOpenFinalizedMemos( { 'projectId': undefined, plans, documents } )

                    if( ws.readyState === 1 ) {
                        ws.send( JSON.stringify( { 'type': 'planList', plans, openMemos } ) )
                    }
                } )
                .catch( () => {
                    if( ws.readyState === 1 ) {
                        ws.send( JSON.stringify( { 'type': 'planList', 'plans': [], 'openMemos': [] } ) )
                    }
                } )

            if( MemoView.#transcriptRegistry ) {
                const { tree: tTree } = MemoView.#transcriptRegistry.getTranscriptTree()

                if( ws.readyState === 1 ) {
                    ws.send( JSON.stringify( { 'type': 'transcriptList', 'tree': tTree } ) )
                }
            }

            if( MemoView.#registry ) {
                const { tree, latest } = MemoView.buildDocumentListPayload()
                ws.send( JSON.stringify( { 'type': 'documentList', tree, latest } ) )

                const { documents } = MemoView.#registry.getDocuments()

                if( documents.length > 0 && !state.absolutePath ) {
                    const firstDoc = documents[ 0 ]
                    const docDetail = MemoView.#registry.getDocument( { documentId: firstDoc['documentId'] } )

                    if( docDetail['status'] && docDetail['document']['revisions'].length > 0 ) {
                        const newestRevision = docDetail['document']['revisions'][ 0 ]['fileName']
                        MemoView.#registry.selectRevision( { documentId: firstDoc['documentId'], fileName: newestRevision } )

                        const { absolutePath: revPath } = MemoView.#registry.getSelectedRevisionPath( { documentId: firstDoc['documentId'] } )

                        if( revPath ) {
                            state.absolutePath = revPath

                            const { tree: updatedTree, latest: updatedLatest } = MemoView.buildDocumentListPayload()
                            ws.send( JSON.stringify( { 'type': 'documentList', tree: updatedTree, latest: updatedLatest } ) )

                            MemoView.#readFileContent( { absolutePath: revPath } )
                                .then( async ( { content } ) => {
                                    const revFileName = basename( revPath )
                                    const { previousPath, currentFullPath, skippedUpdates } = await MemoView.#findPreviousFullRevision( { absolutePath: revPath } )
                                    let diff = null

                                    if( previousPath && currentFullPath ) {
                                        try {
                                            const previousRaw = await readFile( previousPath, 'utf-8' )
                                            const currentRaw = await readFile( currentFullPath, 'utf-8' )
                                            const { diffResult } = MemoView.#computeDiff( { currentContent: currentRaw, previousContent: previousRaw } )
                                            diffResult['previousFile'] = basename( previousPath )
                                            diffResult['currentFullFile'] = basename( currentFullPath )
                                            diffResult['previousContent'] = previousRaw
                                            diffResult['skippedUpdates'] = skippedUpdates
                                            diff = diffResult
                                        } catch {
                                            // skip
                                        }
                                    }

                                    const { memoName } = MemoView.#resolveMemoName( { absolutePath: revPath } )

                                    if( ws.readyState === 1 ) {
                                        const { questionSchema } = MemoView.#computeQuestionSchema( { content } )
                                        const { vorwort } = DocumentRegistry.parseVorwort( { content } )
                                        const { validation } = MemoView.#computeValidation( { content } )
                                        ws.send( JSON.stringify( { 'type': 'content', 'content': content, 'fileName': revFileName, 'memoName': memoName, 'diff': diff, questionSchema, vorwort, validation } ) )
                                    }
                                } )
                        }
                    }
                }

                ws.on( 'message', async ( raw ) => {
                    try {
                        const msg = JSON.parse( raw.toString() )

                        if( msg.type === 'selectRevision' && MemoView.#registry ) {
                            const { status } = MemoView.#registry.selectRevision( { documentId: msg.documentId, fileName: msg.fileName } )

                            if( status ) {
                                const { absolutePath: revPath } = MemoView.#registry.getSelectedRevisionPath( { documentId: msg.documentId } )

                                if( revPath ) {
                                    state.absolutePath = revPath
                                    const { content } = await MemoView.#readFileContent( { absolutePath: revPath } )
                                    const revFileName = basename( revPath )
                                    const { previousPath, currentFullPath, skippedUpdates } = await MemoView.#findPreviousFullRevision( { absolutePath: revPath } )
                                    let diff = null

                                    if( previousPath && currentFullPath ) {
                                        try {
                                            const previousRaw = await readFile( previousPath, 'utf-8' )
                                            const currentRaw = await readFile( currentFullPath, 'utf-8' )
                                            const { diffResult } = MemoView.#computeDiff( { currentContent: currentRaw, previousContent: previousRaw } )
                                            diffResult['previousFile'] = basename( previousPath )
                                            diffResult['currentFullFile'] = basename( currentFullPath )
                                            diffResult['previousContent'] = previousRaw
                                            diffResult['skippedUpdates'] = skippedUpdates
                                            diff = diffResult
                                        } catch {
                                            // skip
                                        }
                                    }

                                    const { memoName } = MemoView.#resolveMemoName( { absolutePath: revPath } )
                                    const { questionSchema } = MemoView.#computeQuestionSchema( { content } )
                                    const { vorwort } = DocumentRegistry.parseVorwort( { content } )
                                    const { validation } = MemoView.#computeValidation( { content } )

                                    ws.send( JSON.stringify( { 'type': 'content', 'content': content, 'fileName': revFileName, 'memoName': memoName, 'documentId': msg.documentId, 'diff': diff, questionSchema, vorwort, validation } ) )

                                    const { tree, latest } = MemoView.buildDocumentListPayload()
                                    clients.forEach( ( c ) => {
                                        if( c.readyState === 1 ) {
                                            c.send( JSON.stringify( { 'type': 'documentList', tree, latest } ) )
                                        }
                                    } )
                                }
                            }
                        }

                        if( msg.type === 'selectPlanPhase' ) {
                            const planFolder = msg.planFolder

                            if( typeof planFolder === 'string' ) {
                                // Compound format: {projectId}--{planFolderName}
                                if( planFolder.includes( '--' ) && MemoView.#planRegistry ) {
                                    const separatorIndex = planFolder.indexOf( '--' )
                                    const projectIdFromMsg = planFolder.slice( 0, separatorIndex )
                                    const folderName = planFolder.slice( separatorIndex + 2 )
                                    const resolveResult = await MemoView.#planRegistry.resolveByProjectId( { 'projectId': projectIdFromMsg } )

                                    if( resolveResult['status'] ) {
                                        const planMdPath = resolve( resolveResult['root']['absolutePath'], folderName, 'plan.md' )

                                        try {
                                            const planContent = await readFile( planMdPath, 'utf-8' )

                                            ws.send( JSON.stringify( { 'type': 'content', 'content': planContent, 'fileName': 'plan.md', 'memoName': folderName, 'diff': null } ) )
                                        } catch {
                                            // plan.md not readable
                                        }
                                    }
                                } else if( /^PLAN-\d{3}-[a-z0-9-]+$/.test( planFolder ) && MemoView.#plansRootPath ) {
                                    // Legacy format: plain folder name — use cwd-root
                                    const planMdPath = resolve( MemoView.#plansRootPath, planFolder, 'plan.md' )

                                    try {
                                        const planContent = await readFile( planMdPath, 'utf-8' )

                                        ws.send( JSON.stringify( { 'type': 'content', 'content': planContent, 'fileName': 'plan.md', 'memoName': planFolder, 'diff': null } ) )
                                    } catch {
                                        // plan.md not readable
                                    }
                                }
                            }
                        }
                    } catch {
                        // ignore malformed messages
                    }
                } )

                ws.on( 'close', () => { clients.delete( ws ) } )
            }

            if( !state.absolutePath ) {
                return
            }

            MemoView.#readFileContent( { absolutePath: state.absolutePath } )
                .then( async ( { content } ) => {
                    const fileName = basename( state.absolutePath )
                    const { previousPath, currentFullPath, skippedUpdates } = await MemoView.#findPreviousFullRevision( { absolutePath: state.absolutePath } )
                    let diff = null

                    if( previousPath && currentFullPath ) {
                        try {
                            const previousRaw = await readFile( previousPath, 'utf-8' )
                            const currentRaw = await readFile( currentFullPath, 'utf-8' )
                            const { diffResult } = MemoView.#computeDiff( { currentContent: currentRaw, previousContent: previousRaw } )
                            diffResult['previousFile'] = basename( previousPath )
                            diffResult['currentFullFile'] = basename( currentFullPath )
                            diffResult['previousContent'] = previousRaw
                            diffResult['skippedUpdates'] = skippedUpdates
                            diff = diffResult
                        } catch {
                            // skip
                        }
                    }

                    const { memoName } = MemoView.#resolveMemoName( { absolutePath: state.absolutePath } )
                    const { questionSchema } = MemoView.#computeQuestionSchema( { content } )
                    const { vorwort } = DocumentRegistry.parseVorwort( { content } )
                    const { validation } = MemoView.#computeValidation( { content } )
                    const message = JSON.stringify( { 'type': 'content', content, fileName, memoName, diff, questionSchema, vorwort, validation } )

                    if( ws.readyState === 1 ) {
                        ws.send( message )
                    }
                } )

            ws.on( 'message', async ( raw ) => {
                const data = JSON.parse( raw.toString() )

                if( data.type === 'navigate' ) {
                    const targetPath = resolve( dirname( state.absolutePath ), data.path )

                    if( !targetPath.endsWith( '.md' ) ) { return }

                    try {
                        await access( targetPath )
                    } catch {
                        return
                    }

                    if( !data.isBack ) {
                        const previousFile = state.absolutePath
                        ws.send( JSON.stringify( { 'type': 'pushHistory', path: previousFile } ) )
                    }

                    state.absolutePath = targetPath

                    if( state.watcher ) {
                        state.watcher.close()
                    }

                    const { watcher } = MemoView.#startFileWatcher( { state } )
                    state.watcher = watcher

                    const { content } = await MemoView.#readFileContent( { absolutePath: state.absolutePath } )
                    const fileName = basename( state.absolutePath )
                    await MemoView.#broadcastContent( { clients: state.clients, content, fileName, absolutePath: state.absolutePath } )

                    process.stdout.write( `  Navigated: ${targetPath}\n` )
                }
            } )

            ws.on( 'close', () => {
                clients.delete( ws )
            } )
        } )

        return { wss, clients }
    }


    static #startFileWatcher( { state } ) {
        let debounceTimer = null

        const watcher = watch( state.absolutePath, () => {
            if( debounceTimer ) {
                clearTimeout( debounceTimer )
            }

            debounceTimer = setTimeout( async () => {
                const { content } = await MemoView.#readFileContent( { absolutePath: state.absolutePath } )
                const fileName = basename( state.absolutePath )
                await MemoView.#broadcastContent( { clients: state.clients, content, fileName, preserveScroll: true, absolutePath: state.absolutePath } )
            }, 100 )
        } )

        return { watcher }
    }


    // PRD-005 (Memo 018 Kap 8): shared handler for the /login and /logout endpoints. Resolves the
    // transcript's revisionId/memoId from the transcriptId, verifies the transcript exists (404
    // otherwise), invokes the matching registry method and broadcasts a dedicated WebSocket event
    // (transcriptLoggedIn / transcriptLoggedOut) to all connected clients — mirroring the existing
    // transcriptAdded broadcast pattern.
    static async #handleTranscriptLoginToggle( { transcriptId, mode } ) {
        const struct = { 'status': false, 'messages': [], 'httpStatus': 400, 'revisionId': null }

        const { transcripts } = MemoView.#transcriptRegistry.listTranscripts( {} )
        const match = transcripts.find( ( entry ) => entry[ 'transcriptId' ] === transcriptId )

        if( match === undefined ) {
            struct[ 'messages' ].push( `TRANSCRIPT-NOTFOUND-001: Transcript not found: ${ transcriptId }` )
            struct[ 'httpStatus' ] = 404

            return struct
        }

        const revisionId = match[ 'revisionId' ]
        const memoId = match[ 'memoId' ]

        const result = mode === 'login'
            ? await MemoView.#transcriptRegistry.logInTranscript( { revisionId, memoId } )
            : await MemoView.#transcriptRegistry.logOutTranscript( { revisionId, memoId } )

        if( !result[ 'status' ] ) {
            struct[ 'messages' ] = result[ 'messages' ]
            struct[ 'httpStatus' ] = result[ 'messages' ].some( ( m ) => m.includes( 'NOTFOUND' ) ) ? 404 : 400

            return struct
        }

        const eventName = mode === 'login' ? 'transcriptLoggedIn' : 'transcriptLoggedOut'

        if( MemoView.#wssInstance ) {
            const message = JSON.stringify( { 'type': eventName, transcriptId, revisionId, memoId } )

            MemoView.#wssInstance.clients
                .forEach( ( ws ) => {
                    if( ws.readyState === 1 ) {
                        ws.send( message )
                    }
                } )
        }

        struct[ 'status' ] = true
        struct[ 'revisionId' ] = revisionId

        return struct
    }


    static async #broadcastContent( { clients, content, fileName, preserveScroll = false, absolutePath } ) {
        let diff = null

        if( absolutePath ) {
            const { previousPath, currentFullPath, skippedUpdates } = await MemoView.#findPreviousFullRevision( { absolutePath } )

            if( previousPath && currentFullPath ) {
                try {
                    const previousRaw = await readFile( previousPath, 'utf-8' )
                    const currentRaw = await readFile( currentFullPath, 'utf-8' )
                    const { diffResult } = MemoView.#computeDiff( { currentContent: currentRaw, previousContent: previousRaw } )
                    diffResult['previousFile'] = basename( previousPath )
                    diffResult['currentFullFile'] = basename( currentFullPath )
                    diffResult['previousContent'] = previousRaw
                    diffResult['skippedUpdates'] = skippedUpdates
                    diff = diffResult
                } catch {
                    // Previous file not readable, skip diff
                }
            }
        }

        let memoName = null

        if( absolutePath ) {
            const resolved = MemoView.#resolveMemoName( { absolutePath } )
            memoName = resolved['memoName']
        }

        const { questionSchema } = MemoView.#computeQuestionSchema( { content } )
        const { vorwort } = DocumentRegistry.parseVorwort( { content } )
        const { validation } = MemoView.#computeValidation( { content } )
        const message = JSON.stringify( { 'type': 'content', content, fileName, preserveScroll, memoName, diff, questionSchema, vorwort, validation } )

        clients.forEach( ( ws ) => {
            if( ws.readyState === 1 ) {
                ws.send( message )
            }
        } )
    }


    static #computeValidation( { content } ) {
        // PRD-040 (Memo 016, Kap 13): the deterministic MemoValidator runs as a GATE in the
        // server before delivering `content` to the View/AI. The result `{ status, messages,
        // info }` is attached as a `validation` field to every content WebSocket message.
        // The four content-send sites differ in their field sets (preserveScroll, key
        // ordering), so instead of one #buildContentMessage we centralise only the validator
        // call here and add the `validation` field additively at each site (PRD-040 fallback,
        // decision documented). MemoValidator.validate never throws (PRD-036); the try/catch
        // is defensive so an unexpected error never blocks content delivery — `validation`
        // becomes null and the server keeps running.
        try {
            const validation = MemoValidator.validate( { doc: content } )

            return { validation }
        } catch {
            return { 'validation': null }
        }
    }


    static #computeQuestionSchema( { content } ) {
        // PRD-004 (Memo 019, Kap 4): the `questions-json` codeblock is the AUTHORITATIVE
        // source ("Wahrheit"). When a valid block is present its question array is sent to
        // the View; otherwise the markdown mirror (parseQuestionSchema) is the Fallback.
        // This central helper makes all four content-send sites decide IDENTICALLY and with
        // exactly the same rule as MemoValidator.validate (MemoValidator.mjs:53-55), so the
        // render-gate (View) and the validator share one truth. Defensive: a malformed JSON
        // block falls back to the markdown mirror instead of crashing the send path.
        try {
            const { questions: jsonQuestions, found: jsonFound } = DocumentRegistry.parseQuestionJsonBlock( { content } )

            if( jsonFound === true ) {
                return { 'questionSchema': jsonQuestions }
            }

            const { questions: markdownQuestions } = DocumentRegistry.parseQuestionSchema( { content } )

            return { 'questionSchema': markdownQuestions }
        } catch {
            const { questions: markdownQuestions } = DocumentRegistry.parseQuestionSchema( { content } )

            return { 'questionSchema': markdownQuestions }
        }
    }


    static #computeQuestionReject( { content } ) {
        // PRD-005 (Memo 019, Kap 5, Scope 2): the reject-gate for POST /api/transcripts. The
        // submitted body is RAW transcript text (the AI input), not a full memo revision — it
        // usually has no Kontext/Header sections. Running the full validator would therefore
        // falsely reject every transcript on section/header codes. Per Scope 2 the gate guards
        // the FRAGEN-FORMAT of the submitted content only: it rejects ONLY on the question /
        // option / typ / JSON-block codes (MEMO-020*, MEMO-025, MEMO-030, MEMO-040, MEMO-050),
        // which mirror the PRD-004 clean-parse truth. A body without questions produces no such
        // code (keine Fragen -> keine Frage-Fehler) and passes — that keeps the "nur Antworten"
        // exception path intact. Defensive: a validator crash NEVER blocks (reject:false).
        try {
            const validation = MemoValidator.validate( { doc: content } )

            if( validation === null || typeof validation !== 'object' || validation[ 'status' ] !== false ) {
                return { 'reject': false, 'messages': [] }
            }

            const questionMessages = ( Array.isArray( validation[ 'messages' ] ) ? validation[ 'messages' ] : [] )
                .filter( ( message ) => /^MEMO-(02\d?[a-d]?|03\d|04\d|05\d)\b/.test( String( message ) ) )

            return { 'reject': questionMessages.length > 0, 'messages': questionMessages }
        } catch {
            return { 'reject': false, 'messages': [] }
        }
    }


    static async #readFileContent( { absolutePath } ) {
        const raw = await readFile( absolutePath, 'utf-8' )
        const dir = dirname( absolutePath )

        const content = raw.replace(
            /!\[([^\]]*)\]\(([^)]+)\)/g,
            ( match, alt, src ) => {
                if( src.startsWith( 'http://' ) || src.startsWith( 'https://' ) ) {
                    return match
                }

                const absImgPath = resolve( dir, src )
                const result = `![${alt}](/__local__${absImgPath})`

                return result
            }
        )

        return { content }
    }


    // PRD-005 (Memo 016 Kap 4, B3): collect every requirement NAME declared by the blocks of a
    // document's selected revision — the union of each parent block's default `requirements` and each
    // child block's additive `requirementsPlus` (the `req-*` namespace). Read-only: parses the
    // revision markdown via BlockMeta.parse, never writes. Returns a deduped, order-stable list so the
    // route can lint these names against the store id index (B5). An absent revision yields [].
    static async #collectBlockRequirementNames( { documentId } ) {
        const { absolutePath } = MemoView.#registry.getSelectedRevisionPath( { documentId } )

        if( !absolutePath ) { return [] }

        const { content } = await MemoView.#readFileContent( { absolutePath } )
        const { blocks } = BlockMeta.parse( { doc: content } )
        const safeBlocks = Array.isArray( blocks ) ? blocks : []

        const names = safeBlocks
            .map( ( block ) => {
                const parentReqs = Array.isArray( block.requirements ) ? block.requirements : []
                const childReqs = Array.isArray( block.requirementsPlus ) ? block.requirementsPlus : []

                return parentReqs.concat( childReqs )
            } )
            .flat()
            .map( ( name ) => String( name == null ? '' : name ).trim() )
            .filter( ( name ) => name.length > 0 )

        return [ ...new Set( names ) ]
    }


    static #resolveMemoName( { absolutePath } ) {
        if( !MemoView.#registry ) { return { memoName: null } }

        const { documents } = MemoView.#registry.getDocuments()
        const fileName = basename( absolutePath )
        const match = documents.find( ( d ) => d['selectedRevision'] === fileName )
        const memoName = match ? match['memoName'] : null

        return { memoName }
    }


    static matchRevisionPattern( { fileName } ) {
        const revisionPattern = /^REV-(\d+)(?:-(prepare|update))?/i
        const versionPattern = /v(\d+)\.(\d+)/
        const revisionMatch = fileName.match( revisionPattern )
        const isVersion = versionPattern.test( fileName )

        if( !revisionMatch && !isVersion ) {
            return { matched: false, pattern: null, revisionNumber: null, suffix: null }
        }

        if( revisionMatch ) {
            const [ , number, suffix ] = revisionMatch
            const revisionNumber = parseInt( number, 10 )
            const normalizedSuffix = suffix ? suffix.toLowerCase() : null

            return { matched: true, pattern: revisionPattern, revisionNumber, suffix: normalizedSuffix }
        }

        return { matched: true, pattern: versionPattern, revisionNumber: null, suffix: null }
    }


    static #suffixOrder( { suffix } ) {
        if( suffix === 'prepare' ) { return 0 }
        if( suffix === 'update' ) { return 1 }

        return 2
    }


    static #compareRevisionFiles( { a, b } ) {
        const matchA = MemoView.matchRevisionPattern( { fileName: a } )
        const matchB = MemoView.matchRevisionPattern( { fileName: b } )

        if( matchA.revisionNumber !== null && matchB.revisionNumber !== null ) {
            if( matchA.revisionNumber !== matchB.revisionNumber ) {
                return matchA.revisionNumber - matchB.revisionNumber
            }

            const orderA = MemoView.#suffixOrder( { suffix: matchA.suffix } )
            const orderB = MemoView.#suffixOrder( { suffix: matchB.suffix } )

            return orderA - orderB
        }

        return a.localeCompare( b )
    }


    static async #findPreviousRevision( { absolutePath } ) {
        const dir = dirname( absolutePath )
        const parentDir = basename( dir )

        if( parentDir !== 'revisions' ) {
            return { previousPath: null }
        }

        const currentFile = basename( absolutePath )
        const currentMatch = MemoView.matchRevisionPattern( { 'fileName': currentFile } )

        if( !currentMatch.matched ) {
            return { previousPath: null }
        }

        const files = await readdir( dir )
        const versionedFiles = files
            .filter( ( f ) => {
                if( !f.endsWith( '.md' ) ) { return false }

                const fileMatch = MemoView.matchRevisionPattern( { fileName: f } )

                if( !fileMatch.matched ) { return false }

                // Diff between Full↔Full only — filter Full revisions when current is Full (PRD-008)
                if( currentMatch.suffix === null ) {
                    return fileMatch.suffix === null
                }

                // For prepare/update: stay within same suffix family
                return fileMatch.suffix === currentMatch.suffix
            } )
            .sort( ( a, b ) => MemoView.#compareRevisionFiles( { a, b } ) )

        const currentIndex = versionedFiles.indexOf( currentFile )

        if( currentIndex <= 0 ) {
            return { previousPath: null }
        }

        const previousPath = resolve( dir, versionedFiles[ currentIndex - 1 ] )

        return { previousPath }
    }


    static async #findPreviousFullRevision( { absolutePath } ) {
        const dir = dirname( absolutePath )
        const parentDir = basename( dir )

        if( parentDir !== 'revisions' ) {
            return { previousPath: null, currentFullPath: null, skippedUpdates: [] }
        }

        const currentFile = basename( absolutePath )
        const currentMatch = MemoView.matchRevisionPattern( { 'fileName': currentFile } )

        if( !currentMatch.matched ) {
            return { previousPath: null, currentFullPath: null, skippedUpdates: [] }
        }

        const files = await readdir( dir )
        const allRevs = files
            .filter( ( f ) => {
                if( !f.endsWith( '.md' ) ) { return false }
                const fileMatch = MemoView.matchRevisionPattern( { fileName: f } )

                return fileMatch.matched
            } )

        const fullFiles = allRevs
            .filter( ( f ) => {
                const fileMatch = MemoView.matchRevisionPattern( { fileName: f } )

                return fileMatch.suffix === null
            } )
            .sort( ( a, b ) => MemoView.#compareRevisionFiles( { a, b } ) )

        if( fullFiles.length < 2 ) {
            return { previousPath: null, currentFullPath: null, skippedUpdates: [] }
        }

        let currentFullFile

        if( currentMatch.suffix === null ) {
            currentFullFile = currentFile
        } else {
            const currentRevNumber = currentMatch.revisionNumber

            const candidate = fullFiles
                .find( ( f ) => {
                    const m = MemoView.matchRevisionPattern( { fileName: f } )

                    return m.revisionNumber !== null && m.revisionNumber >= currentRevNumber
                } )

            currentFullFile = candidate || null
        }

        if( !currentFullFile ) {
            return { previousPath: null, currentFullPath: null, skippedUpdates: [] }
        }

        const currentFullIndex = fullFiles.indexOf( currentFullFile )

        if( currentFullIndex <= 0 ) {
            return { previousPath: null, currentFullPath: resolve( dir, currentFullFile ), skippedUpdates: [] }
        }

        const previousFullFile = fullFiles[ currentFullIndex - 1 ]
        const previousPath = resolve( dir, previousFullFile )
        const currentFullPath = resolve( dir, currentFullFile )

        const currentMatchFull = MemoView.matchRevisionPattern( { fileName: currentFullFile } )
        const previousMatchFull = MemoView.matchRevisionPattern( { fileName: previousFullFile } )
        const lowBound = previousMatchFull.revisionNumber
        const highBound = currentMatchFull.revisionNumber

        const skippedUpdates = allRevs
            .filter( ( f ) => {
                const m = MemoView.matchRevisionPattern( { fileName: f } )

                if( m.suffix === null ) { return false }
                if( m.revisionNumber === null ) { return false }
                if( lowBound !== null && m.revisionNumber <= lowBound ) { return false }
                if( highBound !== null && m.revisionNumber > highBound ) { return false }

                return true
            } )
            .sort( ( a, b ) => MemoView.#compareRevisionFiles( { a, b } ) )

        return { previousPath, currentFullPath, skippedUpdates }
    }


    static #computeDiff( { currentContent, previousContent } ) {
        const currentLines = currentContent.split( '\n' )
        const previousLines = previousContent.split( '\n' )
        const diffLines = []
        const previousSet = new Set( previousLines )
        const currentSet = new Set( currentLines )

        const maxLen = Math.max( currentLines.length, previousLines.length )
        let ci = 0
        let pi = 0

        const result = []

        currentLines
            .forEach( ( line ) => {
                if( !previousSet.has( line ) ) {
                    result.push( { 'type': 'added', line } )
                } else {
                    result.push( { 'type': 'unchanged', line } )
                }
            } )

        const removedLines = previousLines
            .filter( ( line ) => !currentSet.has( line ) )

        const changedSections = []
        let lastH2 = null

        const stripMarkdown = ( text ) => text
            .replace( /`([^`]*)`/g, '$1' )
            .replace( /\*\*([^*]*)\*\*/g, '$1' )
            .replace( /\*([^*]*)\*/g, '$1' )
            .trim()

        result
            .forEach( ( entry ) => {
                const h2Match = entry['line'].match( /^#{2}\s+(.+)/ )

                if( h2Match ) {
                    lastH2 = stripMarkdown( h2Match[1] )
                    return
                }

                const h3Match = entry['line'].match( /^#{3}\s+(.+)/ )

                if( h3Match ) { return }

                if( entry['type'] === 'added' && lastH2 && !changedSections.includes( lastH2 ) ) {
                    changedSections.push( lastH2 )
                }
            } )

        const diffResult = {
            'hasDiff': true,
            'previousFile': '',
            changedSections,
            'lines': result,
            'removedLines': removedLines
        }

        return { diffResult }
    }


    static #planWatcher = null
    static #plansRootPath = null
    static #planRegistry = null


    static computeMissionControl( { plans } ) {
        // Mission-Control start (Memo 005 Kap 9, U4 — minimal read-only increment).
        // Pure + deterministic: reduces the already-aggregated plans (each with
        // projectId, planId, status, phases[]) to a flat phase overview. No file/
        // net access here — the route does the I/O, this method only counts.
        // Phase status follows the canonical kebab vocabulary (PRD-022); unknown
        // values go to "other" (no loss, no crash); a missing phases[] counts 0.
        const safePlans = Array.isArray( plans ) ? plans : []

        const projects = safePlans
            .map( ( plan ) => {
                const phases = Array.isArray( plan && plan[ 'phases' ] ) ? plan[ 'phases' ] : []
                const counts = phases
                    .reduce( ( acc, phase ) => {
                        const key = [ 'pending', 'in-progress', 'done', 'blocked' ].includes( phase && phase[ 'status' ] )
                            ? phase[ 'status' ]
                            : 'other'
                        acc[ key ] = ( acc[ key ] || 0 ) + 1

                        return acc
                    }, {} )

                return {
                    'projectId': plan[ 'projectId' ] || 'unknown',
                    'planId': plan[ 'planId' ] || plan[ 'folder' ] || 'unknown',
                    'planStatus': plan[ 'status' ] || 'unknown',
                    'phaseCounts': counts,
                    'phaseTotal': phases.length
                }
            } )

        const totals = projects
            .reduce( ( acc, p ) => {
                return { 'projects': acc[ 'projects' ] + 1, 'phases': acc[ 'phases' ] + p[ 'phaseTotal' ] }
            }, { 'projects': 0, 'phases': 0 } )

        return { 'projects': projects, 'totals': totals }
    }


    static computeOpenFinalizedMemos( { projectId, plans, documents } ) {
        // "Open" = finalized memo not yet worked off by any plan (Memo 013 Kap 7).
        // A memo is "worked off" when a scanned plan references it via namespace + memoId
        // (namespace/memo-aware schema, Phase 1/2). Plans lacking that field never mark a
        // memo as worked off (safe default: rather show it).
        const planRefs = new Set()
        const safePlans = Array.isArray( plans ) ? plans : []

        safePlans
            .forEach( ( plan ) => {
                const planMemos = Array.isArray( plan && plan[ 'memos' ] ) ? plan[ 'memos' ] : []

                planMemos
                    .forEach( ( memoRef ) => {
                        if( !memoRef || typeof memoRef !== 'object' ) { return }

                        const namespace = memoRef[ 'namespace' ]
                        const memoId = memoRef[ 'memoId' ]

                        if( typeof namespace === 'string' && typeof memoId === 'string' ) {
                            planRefs.add( `${ namespace }--${ memoId }` )
                        }
                    } )
            } )

        const safeDocuments = Array.isArray( documents ) ? documents : []
        const openMemos = safeDocuments
            .filter( ( doc ) => {
                const isMemo = ( doc[ 'documentKind' ] || 'memo' ) === 'memo'
                const isFinalized = doc[ 'memoStatus' ] === 'Finalisiert'
                const namespaceMatch = projectId === undefined || doc[ 'projectId' ] === projectId

                return isMemo && isFinalized && namespaceMatch
            } )
            .filter( ( doc ) => {
                const memoIdMatch = ( doc[ 'memoName' ] || '' ).match( /^(\d{3})/ )

                if( memoIdMatch === null ) { return true }

                const key = `${ doc[ 'projectId' ] }--${ memoIdMatch[ 1 ] }`

                return !planRefs.has( key )
            } )
            .map( ( doc ) => {
                const entry = {
                    'documentId': doc[ 'documentId' ],
                    'projectId': doc[ 'projectId' ],
                    'memoName': doc[ 'memoName' ],
                    'memoStatus': doc[ 'memoStatus' ]
                }

                return entry
            } )

        return { openMemos }
    }


    // BUGFIX (fix/transcript-abschliessen-queue): the JOIN-Punkt. The DocumentRegistry tree carries
    // a stub revisionStatus (always REVISION_STATUS_DEFAULT) because it has no knowledge of the
    // transcript registry. Here both trees are available, so we derive the authoritative
    // revisionStatus per revision from the transcript facts (hasTranscript / loggedIn) via
    // DocumentRegistry.deriveRevisionStatus — the single source of truth (AC-17). After this the
    // queue (server computeOpenRevisionQueue + browser computeQueue) and every display layer read
    // the correct status. Legacy/parseError revisions keep their stub status (they never queue
    // anyway and carry their own "alte Version" marker). Mutates the tree in place and returns it.
    static enrichRevisionStatus( { tree, transcriptTree } ) {
        const docNode = ( tree && typeof tree === 'object' ) ? tree : {}
        const tNode = ( transcriptTree && typeof transcriptTree === 'object' ) ? transcriptTree : {}

        Object.keys( docNode )
            .forEach( ( projectId ) => {
                const projectNode = docNode[ projectId ]
                const memos = Array.isArray( projectNode )
                    ? projectNode
                    : ( ( projectNode && typeof projectNode === 'object' ) ? ( projectNode[ 'memos' ] || [] ) : [] )

                const transcriptsForProject = ( tNode[ projectId ] && typeof tNode[ projectId ] === 'object' ) ? tNode[ projectId ] : {}

                memos
                    .filter( ( doc ) => doc && typeof doc === 'object' )
                    .forEach( ( doc ) => {
                        const memoTranscripts = transcriptsForProject[ doc[ 'memoName' ] ] || []

                        ;( doc[ 'revisions' ] || [] )
                            .filter( ( rev ) => rev && typeof rev === 'object' )
                            .forEach( ( rev ) => {
                                if( rev[ 'isLegacy' ] === true || rev[ 'parseError' ] === true ) { return }

                                const match = String( rev[ 'fileName' ] || '' ).match( /(REV-\d+)/ )
                                const revisionId = match ? match[ 1 ] : null
                                const matched = memoTranscripts
                                    .filter( ( entry ) => entry && entry[ 'revisionId' ] === revisionId )
                                const hasTranscript = matched.length > 0
                                const isLoggedIn = matched
                                    .some( ( entry ) => entry && entry[ 'loggedIn' ] === true )

                                const { revisionStatus } = DocumentRegistry.deriveRevisionStatus( { hasTranscript, isLoggedIn } )
                                rev[ 'revisionStatus' ] = revisionStatus
                            } )
                    } )
            } )

        return { tree: docNode }
    }


    // BUGFIX (fix/transcript-abschliessen-queue): flat-list counterpart of enrichRevisionStatus.
    // The REST GET /api/documents serves getDocuments() (a flat array, not the tree) — enrich it
    // from the same transcript facts so external consumers see the identical revisionStatus as the
    // WS documentList tree. Mutates each document's revisions in place and returns them.
    static enrichDocumentsList( { documents, transcriptTree } ) {
        const docs = Array.isArray( documents ) ? documents : []
        const tNode = ( transcriptTree && typeof transcriptTree === 'object' ) ? transcriptTree : {}

        docs
            .filter( ( doc ) => doc && typeof doc === 'object' )
            .forEach( ( doc ) => {
                const transcriptsForProject = ( tNode[ doc[ 'projectId' ] ] && typeof tNode[ doc[ 'projectId' ] ] === 'object' ) ? tNode[ doc[ 'projectId' ] ] : {}
                const memoTranscripts = transcriptsForProject[ doc[ 'memoName' ] ] || []

                ;( doc[ 'revisions' ] || [] )
                    .filter( ( rev ) => rev && typeof rev === 'object' )
                    .forEach( ( rev ) => {
                        if( rev[ 'isLegacy' ] === true || rev[ 'parseError' ] === true ) { return }

                        const match = String( rev[ 'fileName' ] || '' ).match( /(REV-\d+)/ )
                        const revisionId = match ? match[ 1 ] : null
                        const matched = memoTranscripts
                            .filter( ( entry ) => entry && entry[ 'revisionId' ] === revisionId )
                        const hasTranscript = matched.length > 0
                        const isLoggedIn = matched
                            .some( ( entry ) => entry && entry[ 'loggedIn' ] === true )

                        const { revisionStatus } = DocumentRegistry.deriveRevisionStatus( { hasTranscript, isLoggedIn } )
                        rev[ 'revisionStatus' ] = revisionStatus
                    } )
            } )

        return { documents: docs }
    }


    // BUGFIX (fix/transcript-abschliessen-queue): single source for a transcript-enriched
    // documentList payload. Every documentList broadcast/response goes through here so the queue
    // and badges reflect the loggedIn state without per-call-site duplication. Returns the same
    // shape as DocumentRegistry.getDocumentTree() with revisionStatus joined from the transcripts.
    static buildDocumentListPayload() {
        const empty = { 'tree': {}, 'latest': [] }

        if( !MemoView.#registry ) { return empty }

        const { tree, latest } = MemoView.#registry.getDocumentTree()

        if( MemoView.#transcriptRegistry ) {
            const { tree: transcriptTree } = MemoView.#transcriptRegistry.getTranscriptTree()
            MemoView.enrichRevisionStatus( { tree, transcriptTree } )
        }

        return { tree, latest }
    }


    // PRD-002 (Memo 018 Kap 5): the NEW sidebar Queue (Warteschlange). Data source changed from
    // "unfinished finalized memos" to "open revisions across ALL namespaces". A revision belongs
    // to the queue exactly when DocumentRegistry.isInQueue says so.
    // BUGFIX (fix/transcript-abschliessen-queue): isInQueue keeps every UNFINISHED revision
    // (revisionStatus !== 'eingeloggt') — 'offen' + 'transcript-eingetragen' stay, only the
    // logged-in (= abgeschlossene) revision drops. The status itself is joined from the transcript
    // facts (MemoView.enrichRevisionStatus) before the tree reaches this method.
    // The result is a FLAT list of { doc, rev } pairs — one entry per revision, no grouping
    // by memo or namespace (F3=A). The doc context is carried so the display can reuse renderRevEntry.
    //
    // PRD-001 (Memo 019 Kap 1): a finalized memo ('Finalisiert' / 'Bedingt finalisiert') is done —
    // its revisions never enter the queue. Combined with isInQueue (unfinished + non-legacy), the
    // queue shows only real, open, compatible work.
    //
    // Sort order = FIFO, OLDEST ON TOP (ascending mtimeMs). Entries without a timestamp sink to
    // the bottom but never crash (no invented default). Mirrors the inline browser computeQueue.
    static computeOpenRevisionQueue( { tree } ) {
        const node = ( tree && typeof tree === 'object' ) ? tree : {}

        const pairs = Object.keys( node )
            .reduce( ( acc, projectId ) => {
                const projectNode = node[ projectId ]
                const memos = Array.isArray( projectNode )
                    ? projectNode
                    : ( ( projectNode && typeof projectNode === 'object' ) ? ( projectNode[ 'memos' ] || [] ) : [] )

                const fromNamespace = memos
                    .filter( ( doc ) => doc && typeof doc === 'object' )
                    .filter( ( doc ) => !MemoView.#isFinalizedMemoStatus( { memoStatus: doc[ 'memoStatus' ] } ) )
                    .reduce( ( memoAcc, doc ) => {
                        const openRevs = ( doc[ 'revisions' ] || [] )
                            .filter( ( rev ) => DocumentRegistry.isInQueue( { revision: rev } ).inQueue )
                            .map( ( rev ) => ( { doc, rev } ) )

                        return memoAcc.concat( openRevs )
                    }, [] )

                return acc.concat( fromNamespace )
            }, [] )

        const queue = [ ...pairs ]
            .sort( ( a, b ) => {
                const aMs = typeof a[ 'rev' ][ 'mtimeMs' ] === 'number' ? a[ 'rev' ][ 'mtimeMs' ] : null
                const bMs = typeof b[ 'rev' ][ 'mtimeMs' ] === 'number' ? b[ 'rev' ][ 'mtimeMs' ] : null

                if( aMs === null && bMs === null ) { return 0 }
                if( aMs === null ) { return 1 }
                if( bMs === null ) { return -1 }

                return aMs - bMs
            } )

        return { queue }
    }


    // PRD-009 (Memo 024 Kap 7, F5=A): pure, testable queue-growth detector. The Audio-Notify
    // ton must fire ONLY on a real new queue entry — never on a plain re-render and never on
    // the initial load. The decision is taken on stable keys (documentId::fileName), not on
    // counts, so a swap (one entry leaves, one different entry arrives, count unchanged) still
    // counts as a new entry. `previous === null` marks the initial state (no prior snapshot) and
    // never triggers — that is the no-spam-on-startup rule. Returns the new key set so the caller
    // can store it as the next baseline regardless of the trigger outcome.
    static detectQueueGrowth( { previous, current } ) {
        const currentKeys = Array.isArray( current ) ? current.filter( ( key ) => typeof key === 'string' ) : []

        // No prior snapshot = initial load. Seed the baseline, never trigger (AC-04).
        if( previous === null || previous === undefined ) {
            return { trigger: false, addedKeys: [], nextKeys: currentKeys }
        }

        const previousKeys = Array.isArray( previous ) ? previous.filter( ( key ) => typeof key === 'string' ) : []
        const previousSet = new Set( previousKeys )

        const addedKeys = currentKeys
            .filter( ( key ) => !previousSet.has( key ) )

        return { trigger: addedKeys.length > 0, addedKeys, nextKeys: currentKeys }
    }


    // PRD-001 (Memo 019 Kap 1): a memo counts as finalized exactly when its memoStatus is
    // 'Finalisiert' or 'Bedingt finalisiert'. Mirrors the inline browser memoFinalizedFrom().
    // The term is always "finalisiert" — never "geschlossen".
    static #isFinalizedMemoStatus( { memoStatus } ) {
        return memoStatus === 'Finalisiert' || memoStatus === 'Bedingt finalisiert'
    }


    // PRD-001 (Memo 019 Kap 1): aggregate the spoken minutes of ALL transcripts of a memo. Pure,
    // testable. Sums the per-transcript word counts and converts at ~200 words/minute (same
    // estimate as TranscriptRegistry.wordCount and the sticky-header read-out). 0 transcripts ->
    // 0 Min (no invented default, no date fallback). Used for the finalized-memo minutes chip.
    static aggregateMemoMinutes( { transcripts } ) {
        const list = Array.isArray( transcripts ) ? transcripts : []

        const words = list
            .map( ( entry ) => ( entry && typeof entry[ 'words' ] === 'number' && entry[ 'words' ] > 0 ) ? entry[ 'words' ] : 0 )
            .reduce( ( sum, value ) => sum + value, 0 )

        const minutes = words === 0 ? 0 : Math.ceil( words / 200 )

        return { words, minutes }
    }




    // PRD-006 (Memo 024 Kap 5): pure model for a Queue-Card. Mirrors the inline renderQueueEntry —
    // the card carries the memo's Minuten-Chip (aggregateMemoMinutes, same source as the sidebar)
    // and the memo's LIFECYCLE status (PRD-004 model), NOT the raw revision enum. Missing single
    // values stay empty/0 (kein erfundener Default, konsistent mit dem bisherigen Verhalten).
    static queueEntryModel( { memoName, frontmatterStatus, revisionCount, transcripts, planCompleted } = {} ) {
        const safeTranscripts = Array.isArray( transcripts ) ? transcripts : []
        const { minutes } = MemoView.aggregateMemoMinutes( { transcripts: safeTranscripts } )

        const { memoStatus: lifecycleStatus } = DocumentRegistry.deriveLifecycleStatus( { frontmatterStatus, revisionCount, planCompleted } )

        return {
            'memoName': typeof memoName === 'string' ? memoName : '',
            minutes,
            lifecycleStatus
        }
    }


    // PRD-008 (Memo 019 Kap 9): pure model for the Prompt-Statuszeile (Zone 2). The Zone is
    // STRICTLY two lines (Kap 9.3) — this method computes the display values for both:
    //
    //  Zeile 1 (Transcript, Kap 9.4): minutes are the Leitkennzahl (BEFORE words). A measured
    //    spoken duration (spokenMinutes > 0) shows as "N Min gesprochen"; without it the derived
    //    wordCount-estimate is used and is flagged geschaetzt (minutesEstimated) so no "gesprochen"
    //    is faked (Kap 9.4 / AC-11). Words stay secondary. Without a transcript: no minutes/words.
    //
    //  Zeile 2 (Fragen, Kap 9.3): "N von M beantwortet" + Fragezeichen-Indikator "? N offen".
    //
    // "Kein Wegklicken" (Kap 9.2): there is NO opt-out flag in this model — a present transcript
    // is ALWAYS part of the prompt. transcriptInPrompt mirrors hasTranscript exactly; it can never
    // be toggled off from Zone 2. Mirrored by the inline browser-script builder.
    static promptStatusLine( { words, spokenMinutes, questionsAnswered, questionsTotal, transcriptUrl } ) {
        const hasTranscript = typeof transcriptUrl === 'string' && transcriptUrl.length > 0

        const wordCount = ( typeof words === 'number' && words > 0 ) ? words : 0
        const measured = typeof spokenMinutes === 'number' && spokenMinutes > 0
        const estimated = wordCount === 0 ? 0 : Math.ceil( wordCount / 200 )
        const minutes = measured ? spokenMinutes : estimated
        // geschaetzt whenever there is no measured spoken duration — never fake "gesprochen".
        const minutesEstimated = !measured

        const answered = ( typeof questionsAnswered === 'number' && questionsAnswered > 0 ) ? questionsAnswered : 0
        const total = ( typeof questionsTotal === 'number' && questionsTotal > 0 ) ? questionsTotal : 0
        const open = total > answered ? total - answered : 0

        const minutesLabel = minutesEstimated
            ? minutes + ' Min geschätzt'
            : minutes + ' Min gesprochen'

        return {
            // "kein Wegklicken" invariant: a present transcript is always in the prompt.
            'transcriptInPrompt': hasTranscript,
            hasTranscript,
            'words': wordCount,
            minutes,
            minutesEstimated,
            // Minuten-Leitkennzahl text — minutes BEFORE words (Kap 9.4).
            minutesLabel,
            'wordsLabel': wordCount.toLocaleString( 'de-DE' ) + ' Wörter',
            // Fragen-Zeile (Kap 9.3): "N von M beantwortet" + "? N offen".
            answered,
            'total': total,
            open,
            'answeredLabel': answered + ' von ' + total + ' beantwortet',
            'openLabel': open + ' offen'
        }
    }


    // PRD-011 (Memo 016 Kap 5): pro-revision badge resolution. Data source is the frontend
    // transcript tree (lastTranscriptTree[ projectId ][ memoId ] = list of entries, each with
    // a revisionId). These pure helpers are mirrored by the inline browser-script functions
    // of the same name; they are extracted here so the resolution logic is unit-testable.
    //
    // "explizit fuer eine Revision": entries whose revisionId === the viewed revisionId.
    // "lose / memo-weit": all entries for the memo (aggregate), independent of a single rev.

    static transcriptsForMemo( { transcriptTree, memoName } ) {
        const tree = ( transcriptTree && typeof transcriptTree === 'object' ) ? transcriptTree : {}
        const collected = []

        Object.keys( tree )
            .forEach( ( projectId ) => {
                const memos = tree[ projectId ] || {}
                const list = Array.isArray( memos[ memoName ] ) ? memos[ memoName ] : []

                list.forEach( ( entry ) => collected.push( entry ) )
            } )

        return { 'transcripts': collected }
    }


    static transcriptsForRevision( { transcriptTree, memoName, revisionId } ) {
        const { transcripts } = MemoView.transcriptsForMemo( { transcriptTree, memoName } )

        const matched = transcripts
            .filter( ( entry ) => entry && entry[ 'revisionId' ] === revisionId )

        return { 'transcripts': matched }
    }


    // True when the GIVEN revision (not the memo as a whole) has at least one transcript.
    // This is the fix for the REV-03 badge bug: a revision without its own transcript must
    // not inherit a "Transcript hinterlegt" badge from a sibling revision.
    static hasTranscriptForRevision( { transcriptTree, memoName, revisionId } ) {
        const { transcripts } = MemoView.transcriptsForRevision( { transcriptTree, memoName, revisionId } )

        return { 'hasTranscript': transcripts.length > 0 }
    }


    // Aggregate presence for the memo head (lose Zuordnung). Kept distinct from the
    // per-revision check so the memo-head icon does not mix the two meanings.
    static hasTranscriptForMemo( { transcriptTree, memoName } ) {
        const { transcripts } = MemoView.transcriptsForMemo( { transcriptTree, memoName } )

        return { 'hasTranscript': transcripts.length > 0 }
    }


    // PRD-001 (Memo 018 Kap 4, F7=A): the 3-state ball status DERIVED from the revision-level
    // revisionStatus (single source of truth) plus memoFinalized. Mirrors the inline browser
    // deriveBallStatus helper of the same name; extracted here so the mapping is unit-testable.
    //   offen                    -> 'Wartet auf User-Feedback'
    //   transcript-eingetragen   -> 'Transcript hinterlegt'
    //   eingeloggt (+ finalized) -> 'Finalisiert (Locked)'
    // PRD-012 (Memo 016, F3): single-sourced in RevisionLogic — this stays a thin wrapper so the
    // public MemoView.deriveBallStatus name (callers + tests) keeps working. The client inline copy
    // is drift-guarded against RevisionLogic in tests/unit/IsomorphicDedupPRD012.test.mjs.
    static deriveBallStatus( { revisionStatus, memoFinalized } ) {
        return RevisionLogic.deriveBallStatus( { revisionStatus, memoFinalized } )
    }


    // PRD-005 (Memo 016 Kap 4, B1/B2): the explanatory empty-state decision for the requirements
    // view. The old view rendered two bare titles with a "(0)" and nothing else, so the user could
    // not tell WHY it was empty — and a MISSING eval set looked identical to a set that resolved to
    // zero requirements. This pure function turns ( count, setPresent, missingCount ) into a ternary
    // verdict + a German reason line so the client can render distinct copy:
    //   - empty === false           -> resolved requirements exist, no empty-state.
    //   - setPresent === false      -> kind 'no-set'  : the memo has no recorded eval set on disk.
    //   - setPresent && count === 0 -> kind 'empty-set': the set exists but resolves to 0.
    // `missingCount` (unresolved set ids) is woven into the reason so a present-but-broken set reads
    // differently from a genuinely empty one. Mirrored 1:1 by the inline browser helper of the same
    // name (client renders the reason; this static method is the single source of the copy + verdict).
    static requirementsEmptyState( { count, setPresent, missingCount } ) {
        return RevisionLogic.requirementsEmptyState( { count, setPresent, missingCount } )
    }


    // PRD-005 (Memo 016 Kap 4, B3/B5): resolve a block's requirement names (the `req-*` namespace
    // used inside BlockMeta blocks) against the requirements store id index (the `REQ-NNN` namespace).
    // This makes the namespace mismatch VISIBLE instead of silently swallowed: a block name resolves
    // only when its normalized form (uppercased, '_' -> '-') equals a known store id, otherwise it is
    // reported as `unresolved` so the view can WARN. The route runs this at resolve time, viewer-side,
    // so no other repo needs to change. Mirrored 1:1 by the inline browser helper of the same name.
    static resolveBlockRequirements( { blockRequirementNames, knownIds } ) {
        return RevisionLogic.resolveBlockRequirements( { blockRequirementNames, knownIds } )
    }


    // PRD-010 (Memo 024 Kap 8): Builds the mermaid render-fallback HTML.
    // When a diagram fails to render, the viewer must NOT degrade to a bare error
    // ("Bombe") — it shows the error message PLUS the unchanged original mermaid
    // source as an HTML-escaped <pre> block, so the user sees which diagram broke
    // and can copy/inspect it. The original text is HTML-escaped (&, <, >, ")
    // so special characters like <, >, &, {, ( render as text, never as markup.
    // Mirrored 1:1 by the inline browser helper buildMermaidErrorHtml inside the
    // client template (the static class method is server-side only).
    static buildMermaidErrorHtml( { err, originalText } ) {
        return RevisionLogic.buildMermaidErrorHtml( { err, originalText } )
    }


    // PRD-001 (Memo 016 Kap 2, E1/E10): capped exponential backoff for WS reconnect.
    // Mirrors the inline browser ws.onclose handler so the curve is unit-testable. The
    // `attempts` argument is the POST-increment counter (1 = first close). delay grows
    // 2s, 4s, 8s, 16s, 30s (capped) and shouldStop flips once attempts exceeds the cap —
    // the browser then stops hammering until a page reload re-arms connect() (E1). onerror
    // never increments (E10): onclose owns the counter, so each close advances the curve once.
    static reconnectDelay( { attempts } ) {
        const MAX_RECONNECT_ATTEMPTS = 8
        const RECONNECT_BASE_MS = 2000
        const RECONNECT_MAX_MS = 30000
        const safeAttempts = ( typeof attempts === 'number' && attempts > 0 ) ? attempts : 1
        const shouldStop = safeAttempts > MAX_RECONNECT_ATTEMPTS
        const delay = Math.min( RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow( 2, safeAttempts - 1 ) )

        return { 'delay': delay, 'shouldStop': shouldStop }
    }


    // PRD-016 (Memo 016, E3): the per-tick heartbeat decision, mirrored by the server sweep in
    // #setupWebSocket. `isAlive` is the flag the previous ping set to false; a pong since then
    // flips it back to true. terminate=true means the client never answered the last ping and is
    // stale -> the server drops it (driving the client's onclose -> reconnect/offline path).
    // terminate=false means it is healthy and gets pinged again (isAlive reset to false). This is
    // what makes "server up, wrong path / black-hole" distinguishable from a healthy link (E3).
    static heartbeatDecision( { isAlive } ) {
        if( isAlive === false ) {
            return { 'terminate': true, 'nextIsAlive': false, 'ping': false }
        }

        return { 'terminate': false, 'nextIsAlive': false, 'ping': true }
    }


    // PRD-016 (Memo 016, E9): the offline-indicator visibility decision, mirrored by the inline
    // updateConnectionStatus. A connected socket hides the banner. The OFFLINE banner must be
    // visible from the FIRST failed attempt (attempts >= 1), not only after the second — the old
    // 6px dot that appeared at attempts >= 2 was effectively invisible. The backoff/cap (E1) is a
    // SEPARATE concern (reconnectDelay) and stays intact: showing the banner earlier does not
    // change when reconnect stops.
    static offlineBannerVisible( { state, attempts } ) {
        if( state === 'connected' ) { return { 'visible': false } }
        const safeAttempts = ( typeof attempts === 'number' && attempts > 0 ) ? attempts : 0

        return { 'visible': safeAttempts >= 1 }
    }


    // PRD-016 (Memo 016, E8): the sidebar no-op-skip decision, mirrored by the inline
    // renderSidebar guard. The WS broadcast fires a full innerHTML rebuild on every message; when
    // the incoming tree/latest is byte-identical to the last rendered signature the rebuild is a
    // pure waste (flicker + CPU). `changed` is false when the signatures match -> the caller
    // returns early and keeps the existing DOM. A first render (prev null/undefined) always
    // changes. Signatures are cheap JSON strings of the data that drives the sidebar markup.
    static sidebarSignatureChanged( { prev, next } ) {
        if( prev === null || prev === undefined ) { return { 'changed': true } }

        return { 'changed': prev !== next }
    }


    // PRD-003 (Memo 016 Kap 2, E4): the gesture-gate decision for the notify AudioContext,
    // mirrored by the inline acquireNotifyAudioCtx. Before any user gesture no context may be
    // used or created (autoplay policy). After a gesture exactly one context exists: create it
    // when none is held yet, otherwise reuse the existing one (no per-call leak).
    static audioContextGate( { gestureSeen, hasContext } ) {
        if( gestureSeen !== true ) { return { 'mayUse': false, 'create': false } }
        const create = hasContext !== true

        return { 'mayUse': true, 'create': create }
    }


    // PRD-009 (Memo 016 Kap 7, F4/E6): the view-mode state machine for the #content area.
    // Prose is the home view; 'requirements' and 'blocks' are non-destructive panels reached
    // from prose. Requesting the view that is already active toggles BACK to prose (E6 toggle-off,
    // a way back home — F4). Requesting a different non-prose view switches to it. Requesting
    // prose explicitly always returns home. `render` is false only when the requested view equals
    // the current view AND that view is prose (a no-op click on an already-home toggle). Mirrored
    // 1:1 by the inline browser toggles, which read `render` to decide whether to fetch+rebuild.
    static nextViewState( { current, requested } ) {
        return RevisionLogic.nextViewState( { current, requested } )
    }


    // PRD-009 (Memo 016 Kap 7, E7/F10): the broadcast guard. A WS `content` broadcast must only
    // re-render the prose content when the prose/memo view is the one on screen. When a
    // requirements or blocks panel is open the broadcast must NOT blow it away (E7) — the view
    // state survives a re-render instead of being reset (F10). Returns true ONLY for the prose/memo
    // home view; any non-prose panel returns false. Mirrored 1:1 by the inline WS content handler.
    // PRD-012 (Memo 016, F3): single-sourced in RevisionLogic. RevisionLogic returns the house-style
    // { rerender } object; this public method keeps its long-standing bare-boolean contract (callers +
    // ViewStatePanelsPRD009.test) by unwrapping it.
    static shouldRerenderOnBroadcast( { currentView } ) {
        const { rerender } = RevisionLogic.shouldRerenderOnBroadcast( { currentView } )

        return rerender
    }


    // PRD-004 (Memo 016 Kap 3, A1-A8): partition the flat BlockMeta.parse list into a nested
    // parent/child view model. A1: split by `role` (parent vs child) so children render NESTED
    // under their parent, not as a flat list. Children bind to a parent via the singular `topic`
    // matching one of the parent's plural `topics`; an unmatched child becomes an "orphan" group
    // so it is still visible. A6: parents are grouped by `chapter` (one header per chapter, not
    // repeated per child). A7: each child's `effectiveRequirements` is computed by INVOKING
    // BlockMeta.effectiveRequirements( { parent, child } ) — the parent default ∪ child additive
    // union — so that method is no longer dead code. Mirrored by the inline browser partitionBlocks.
    static partitionBlocks( { blocks } ) {
        const safeBlocks = Array.isArray( blocks ) ? blocks : []
        const parents = safeBlocks.filter( ( block ) => block && block.role !== 'child' )
        const children = safeBlocks.filter( ( block ) => block && block.role === 'child' )

        const findParent = ( child ) => parents.find( ( parent ) => {
            const topics = Array.isArray( parent.topics ) ? parent.topics : []

            return typeof child.topic === 'string' && topics.indexOf( child.topic ) !== -1
        } )

        const withChildren = parents.map( ( parent ) => {
            const own = children.filter( ( child ) => findParent( child ) === parent )
            const enriched = own.map( ( child ) => {
                const { requirements } = BlockMeta.effectiveRequirements( { parent, child } )

                return Object.assign( {}, child, { 'effectiveRequirements': requirements } )
            } )

            return Object.assign( {}, parent, { 'children': enriched } )
        } )

        const orphans = children
            .filter( ( child ) => findParent( child ) === undefined )
            .map( ( child ) => {
                const { requirements } = BlockMeta.effectiveRequirements( { parent: null, child } )

                return Object.assign( {}, child, { 'effectiveRequirements': requirements } )
            } )

        const chapterOrder = []
        withChildren.forEach( ( parent ) => {
            const chapter = parent.chapter || ''
            if( chapterOrder.indexOf( chapter ) === -1 ) { chapterOrder.push( chapter ) }
        } )

        const groups = chapterOrder.map( ( chapter ) => {
            const groupParents = withChildren.filter( ( parent ) => ( parent.chapter || '' ) === chapter )

            return { 'chapter': chapter, 'parents': groupParents }
        } )

        return { groups, orphans }
    }


    // PRD-014 (Memo 016 Kap 9, F9/A10): the blocks-view empty-state decision. Mirrors
    // requirementsEmptyState so the blocks view gets a REAL "Keine Blöcke" empty-state component
    // instead of a blank panel, and a non-empty parse-error count is surfaced (A10: errors used to
    // be discarded by the route). Pure ternary verdict + German reason copy. `errorCount` is the
    // number of unparseable block-meta fences from BlockMeta.parse — woven into the reason so a memo
    // whose fences ALL failed to parse reads differently from one that simply has no blocks. Mirrored
    // 1:1 by the inline browser helper blocksEmptyState (client renders the reason; this is the
    // single source of the copy + verdict).
    static blocksEmptyState( { count, errorCount } ) {
        const safeCount = ( typeof count === 'number' && count > 0 ) ? count : 0
        const safeErrors = ( typeof errorCount === 'number' && errorCount > 0 ) ? errorCount : 0
        if( safeCount > 0 ) {
            return { 'empty': false, 'kind': 'present', 'reason': '' }
        }
        if( safeErrors > 0 ) {
            return {
                'empty': true,
                'kind': 'parse-error',
                'reason': `Keine Blöcke aufgeloest — ${ safeErrors } block-meta-Fence(s) konnten nicht geparst werden.`
            }
        }

        return {
            'empty': true,
            'kind': 'no-blocks',
            'reason': 'Keine Blöcke — dieses Memo enthaelt keinen block-meta-Fence.'
        }
    }


    // PRD-014 (Memo 016 Kap 9, B8): the requirements consistency check. The bare `count` told the user
    // how many requirements RESOLVED but never whether that matched the BLOCK reality, so a count of 0
    // looked the same whether the blocks declared 0 requirements or 8. This compares the number of
    // distinct requirement names the blocks EXPECT (`expectedFromBlocks`) against the number actually
    // RESOLVED from the store, returning a ternary verdict the view can render as a consistency badge.
    // Mirrored 1:1 by the inline browser helper of the same name.
    static requirementsConsistency( { expectedFromBlocks, resolvedCount } ) {
        const expected = ( typeof expectedFromBlocks === 'number' && expectedFromBlocks > 0 ) ? expectedFromBlocks : 0
        const resolved = ( typeof resolvedCount === 'number' && resolvedCount > 0 ) ? resolvedCount : 0
        if( expected === resolved ) {
            return {
                'consistent': true,
                'expected': expected,
                'resolved': resolved,
                'reason': `${ resolved } von ${ expected } Block-Requirement(s) aufgeloest.`
            }
        }

        return {
            'consistent': false,
            'expected': expected,
            'resolved': resolved,
            'reason': `Inkonsistenz: Blöcke erwarten ${ expected } Requirement(s), aufgeloest sind ${ resolved }.`
        }
    }


    // PRD-014 (Memo 016 Kap 9, B9): map a requirement severity to a stable CSS class suffix so chips
    // get a SEVERITY COLOR instead of all looking identical. The store severity vocabulary is
    // blocker/major/minor/warning/info; any unknown/empty value maps to the neutral 'info' class.
    // Pure + data-derived (never hardcoded per requirement). Mirrored 1:1 by the inline browser helper.
    static requirementSeverityClass( { severity } ) {
        const known = [ 'blocker', 'major', 'minor', 'warning', 'info' ]
        const value = String( severity == null ? '' : severity ).trim().toLowerCase()
        const safe = known.indexOf( value ) !== -1 ? value : 'info'

        return { 'severityClass': `req-sev-${ safe }`, 'severity': safe }
    }


    // PRD-014 (Memo 016 Kap 9, B9): derive the short KIND badge text from a requirement's
    // check.kind (tool/skill/command/...). Chips previously showed no kind at all, so a tool
    // requirement was visually indistinguishable from a skill one. Returns the uppercased kind or
    // an empty string when no kind is present (the view then omits the badge). Mirrored 1:1 by the
    // inline browser helper of the same name.
    static requirementKindLabel( { requirement } ) {
        const req = requirement && typeof requirement === 'object' ? requirement : {}
        const check = req[ 'check' ] && typeof req[ 'check' ] === 'object' ? req[ 'check' ] : {}
        const kind = typeof check[ 'kind' ] === 'string' ? check[ 'kind' ].trim() : ''

        return { 'kind': kind, 'kindLabel': kind.length > 0 ? kind.toUpperCase() : '' }
    }


    // PRD-014 (Memo 016 Kap 9, A11): build a NON-EMPTY, stable automation hook for a block. A parent
    // carries a B-id; a CHILD carries no id (id stayed ''), so automation/tests went blind on
    // children. This composes a child hook from its binding `topic` (e.g. 'child-T012') and falls
    // back to the block id for a parent — guaranteeing a non-empty data-block-id everywhere. Mirrored
    // 1:1 by the inline browser helper of the same name.
    static blockChildHook( { block } ) {
        const safe = block && typeof block === 'object' ? block : {}
        const id = typeof safe[ 'id' ] === 'string' ? safe[ 'id' ].trim() : ''
        if( id.length > 0 ) { return { 'hook': id } }
        const topic = typeof safe[ 'topic' ] === 'string' ? safe[ 'topic' ].trim() : ''
        if( topic.length > 0 ) { return { 'hook': `child-${ topic }` } }

        return { 'hook': 'block-unknown' }
    }


    // PRD-007 (Memo 016, D3/D7): the ONE slug algorithm used everywhere — heading ids AND the
    // diff-banner "Geaenderte Kapitel" anchors. Two divergent algorithms (heading slugify vs the
    // banner's /[^a-z0-9]+/g replace) produced mismatched anchors on Umlaut/Em-dash/punctuation,
    // so a banner link scrolled nowhere (D3). D7: punctuation becomes a SEPARATOR (not stripped),
    // so distinct headings that differ only in punctuation produce distinct slugs and never collide
    // into a renumber. Mirrored 1:1 by the inline browser slugify inside the client template.
    static slugify( { text } ) {
        return RevisionLogic.slugify( { text } )
    }


    // PRD-007 (Memo 016, D1): the render-branch decision for a fenced code block in prose. A
    // `block-meta` fence must NOT fall through to the raw code renderer (it rendered as an ugly
    // JSON code block, D1) — it is rendered INLINE as a Block-Card instead (Memo decision F2).
    // `mermaid` keeps its own diagram branch; everything else stays a normal code block. Mirrored
    // by the inline browser renderer.code so the branch is identical client-side.
    static blockMetaRenderDecision( { lang } ) {
        if( lang === 'mermaid' ) { return { decision: 'mermaid' } }
        if( lang === 'block-meta' ) { return { decision: 'block-card' } }

        return { decision: 'code' }
    }


    // PRD-006 (Memo 016 Kap 5, C1-C9): ONE level-aware section helper. The DOM layer and
    // DocumentRegistry.#extractSection (H2-exact, H2-stop) disagreed about what "Offene Fragen"
    // is — the anchor scan took the first h1-h4 match (a chapter-5 `### Offene Fragen` H3, C2),
    // hiding was h2-only (the chapter's own H3 copy survived, C1/C9), and the sibling collapse
    // stopped only at H2 instead of at the next heading of level <= start level (C4). This pure
    // helper mirrors #extractSection for the DOM: it picks the canonical question section by an
    // EXACT H2 text match (never an H3/H4), and computes the level-aware collapse range (the run
    // of following headings/bodies up to the next heading whose level <= the start level). The
    // inline browser helpers isExactSectionH2 + hiddenSiblingsAfter mirror these two rules 1:1.
    // `headings` is an ordered list of { level, text }; indices are into that same list.
    static questionsSection( { headings } ) {
        const list = Array.isArray( headings ) ? headings : []
        const isQuestionText = ( text ) => {
            const label = String( text == null ? '' : text ).toLowerCase()

            return /offene\s+fragen/.test( label ) || /beantwortete\s+fragen/.test( label )
        }
        // C2/C3/C8: the canonical anchor is the FIRST EXACT H2 (level === 2) whose text is the
        // open-questions section — NOT the first h1-h4 match. An H3 "### Offene Fragen" inside a
        // chapter never wins the anchor.
        const anchorIndex = list.findIndex( ( heading ) => {
            return heading && heading.level === 2 && /offene\s+fragen/.test( String( heading.text || '' ).toLowerCase() )
        } )

        // C1/C4/C9: level-aware collapse. From a start heading, the section body runs until the
        // next heading whose level is <= the start level (an H2 start stops at the next H2 — the
        // exact #extractSection rule; an H3 start stops at the next H2 or H3). Returns the [start+1,
        // end) index span of headings that belong to the collapsed body.
        const collapseRangeFrom = ( startIndex ) => {
            const start = list[ startIndex ]
            if( !start ) { return { 'startIndex': startIndex, 'endIndex': startIndex } }
            const startLevel = start.level
            const rest = list.slice( startIndex + 1 )
            const stopOffset = rest.findIndex( ( heading ) => heading && heading.level <= startLevel )
            const endIndex = stopOffset === -1 ? list.length : startIndex + 1 + stopOffset

            return { 'startIndex': startIndex + 1, 'endIndex': endIndex }
        }

        // C1/C9: every heading (any level) that opens a raw question section gets its body
        // collapsed level-aware — so a chapter's own H3 "### Offene Fragen" copy disappears too,
        // while freetext like "(F9)" that is NOT a heading stays prose.
        const hiddenSections = list
            .map( ( heading, index ) => ( { heading, index } ) )
            .filter( ( entry ) => entry.heading && isQuestionText( entry.heading.text ) )
            .map( ( entry ) => collapseRangeFrom( entry.index ) )

        return { anchorIndex, hiddenSections, collapseRangeFrom }
    }


    // PRD-015 (Memo 016 Kap 9, D5): the diff layer compares server-side `changedSections` (RAW
    // memo strings) against RENDERED heading text — in the TOC dot AND the per-block .diff-added
    // gate. Comparing raw vs rendered drifts on Umlaut/Em-dash/punctuation. This pure mirror of the
    // inline rule normalises BOTH sides through slugify, so a changed chapter matches its rendered
    // heading regardless of how marked rewrote the inline text. Returns whether the heading is in
    // the changed set after normalisation.
    static changedSectionMatch( { changedSections, headingText } ) {
        const list = Array.isArray( changedSections ) ? changedSections : []
        const set = new Set( list.map( ( s ) => RevisionLogic.slugify( { text: s } ).slug ) )
        const key = RevisionLogic.slugify( { text: headingText } ).slug

        return { matched: set.has( key ) }
    }


    // PRD-015 (Memo 016 Kap 9, D6): a block's three structured body headings (### Problem-Beschreibung
    // / Loesungsansatz / Offene Fragen below a block-meta fence — BlockMeta BODY_SECTIONS) are H3s
    // that pollute the prose and claim heading anchors. This pure mirror of the inline isBlockBodyHeading
    // decides whether a heading at a given level + text is such a body heading (level 3 + exact label).
    static isBlockBodyHeading( { level, text } ) {
        const labels = [ 'problem-beschreibung', 'loesungsansatz', 'offene fragen' ]
        const label = String( text == null ? '' : text ).trim().toLowerCase()

        return { isBlockBody: level === 3 && labels.indexOf( label ) !== -1 }
    }


    // PRD-015 (Memo 016 Kap 9, D11): the On-this-page TOC indexes BOTH h2 AND h3 (was h2-only), but
    // skips headings the structure pass collapsed (block-body H3s and raw-question/vorwort bodies),
    // so a hidden heading never pollutes the TOC. This pure mirror takes an ordered list of
    // { level, text, hidden } headings and returns the entries that become TOC rows, each tagged
    // with its level class (toc-h2 / toc-h3). Mirrors the inline buildTOC selection 1:1.
    static tocEntries( { headings } ) {
        const list = Array.isArray( headings ) ? headings : []
        const entries = list
            .filter( ( heading ) => heading && ( heading.level === 2 || heading.level === 3 ) )
            .filter( ( heading ) => heading.hidden !== true )
            .map( ( heading ) => ( {
                text: heading.text,
                levelClass: heading.level === 3 ? 'toc-h3' : 'toc-h2'
            } ) )

        return { entries }
    }


    // Extracts a revisionId (REV-NN) from a sticky-header fileName like "REV-03.md".
    // Returns null when the fileName does not encode a revision (e.g. plan phases).
    static revisionIdFromFileName( { fileName } ) {
        return RevisionLogic.revisionIdFromFileName( { fileName } )
    }


    // PRD-013 (Memo 016 Kap 3): Soll-Nummern-Logik for the sticky-header button.
    // next = (highest existing REV number) + 1, previous = highest existing REV number.
    // The number is NEVER derived from the viewed revision suffix (that is the reproduced bug
    // "Revision 2 betrachtet -> 'fuer Revision 3'"). Source is the memo's revisions bestand
    // (rev.fileName), mirrored by the inline browser helper of the same name.
    static nextRevisionNumbers( { revisions } ) {
        return RevisionLogic.nextRevisionNumbers( { revisions } )
    }


    // PRD-004 (Memo 018 Kap 7): pure model for the Transcript-Statuszeile in the sticky header.
    // Mirrors the inline browser-script logic so the gates are unit-testable:
    //   - revisionStatus: offen / transcript-eingetragen / eingeloggt (reuses the Phase-1 model).
    //   - wordsVisible (015 REV-05 R1): Woerter/Minuten render ONLY when a transcriptUrl is present.
    //   - einloggenEnabled (AC-3): the "bereit / einloggen" button is enabled only when a transcript
    //     exists (status transcript-eingetragen -> login, eingeloggt -> logout/undo); offen -> disabled.
    //   - einloggenMode: 'login' while not logged in, 'logout' once logged in (reversible toggle).
    //   - statusBadgeClass: unified mh-badge--{typ} naming (AC-6).
    static stickyHeaderRow( { hasTranscript, isLoggedIn, transcriptUrl } ) {
        const revisionStatus = isLoggedIn === true
            ? 'eingeloggt'
            : ( hasTranscript === true ? 'transcript-eingetragen' : 'offen' )

        const wordsVisible = typeof transcriptUrl === 'string' && transcriptUrl.length > 0

        const einloggenEnabled = revisionStatus === 'transcript-eingetragen' || revisionStatus === 'eingeloggt'
        const einloggenMode = isLoggedIn === true ? 'logout' : 'login'

        const statusBadgeClass = revisionStatus === 'eingeloggt'
            ? 'mh-badge--eingeloggt'
            : ( revisionStatus === 'transcript-eingetragen' ? 'mh-badge--transcript' : 'mh-badge--offen' )

        return { revisionStatus, wordsVisible, einloggenEnabled, einloggenMode, statusBadgeClass }
    }


    static #validatePlanStatus( { obj } ) {
        const errors = []

        if( !obj || typeof obj !== 'object' ) {
            errors.push( 'plan-status.json must be an object' )

            return { isValid: false, errors }
        }

        if( typeof obj['planId'] !== 'string' ) {
            errors.push( 'planId: missing or not a string' )
        } else if( !/^PLAN-\d{3}-[a-z0-9-]+$/.test( obj['planId'] ) ) {
            errors.push( 'planId: pattern mismatch' )
        }

        const validatePhaseList = ( { phases, label } ) => {
            const seenIds = new Set()
            phases
                .forEach( ( phase, idx ) => {
                    if( !phase || typeof phase !== 'object' ) {
                        errors.push( `${label}[${idx}]: not an object` )

                        return
                    }

                    if( typeof phase['id'] !== 'string' || !/^P\d+$/.test( phase['id'] ) ) {
                        errors.push( `${label}[${idx}].id: missing or pattern mismatch` )
                    } else if( seenIds.has( phase['id'] ) ) {
                        errors.push( `${label}[${idx}].id: duplicate (${phase['id']})` )
                    } else {
                        seenIds.add( phase['id'] )
                    }
                } )
        }

        const hasMemos = Array.isArray( obj['memos'] ) && obj['memos'].length > 0
        const hasLegacyPhases = Array.isArray( obj['phases'] ) && obj['phases'].length > 0

        if( hasMemos ) {
            // namespace/memo-aware schema: phases are nested per memo
            obj['memos']
                .forEach( ( memo, mIdx ) => {
                    if( !memo || typeof memo !== 'object' ) {
                        errors.push( `memos[${mIdx}]: not an object` )

                        return
                    }

                    if( typeof memo['namespace'] !== 'string' || memo['namespace'].length === 0 ) {
                        errors.push( `memos[${mIdx}].namespace: missing` )
                    }

                    if( typeof memo['memoId'] !== 'string' || memo['memoId'].length === 0 ) {
                        errors.push( `memos[${mIdx}].memoId: missing` )
                    }

                    if( !Array.isArray( memo['phases'] ) || memo['phases'].length === 0 ) {
                        errors.push( `memos[${mIdx}].phases: must be a non-empty array` )
                    } else {
                        validatePhaseList( { phases: memo['phases'], label: `memos[${mIdx}].phases` } )
                    }
                } )
        } else if( hasLegacyPhases ) {
            // legacy schema: top-level phases array
            validatePhaseList( { phases: obj['phases'], label: 'phases' } )
        } else {
            errors.push( 'memos or phases: must be a non-empty array' )
        }

        const isValid = errors.length === 0

        return { isValid, errors }
    }


    static async #scanPlans( { rootPath } ) {
        const plans = []

        try {
            await access( rootPath )
        } catch {
            return { plans }
        }

        let entries

        try {
            entries = await readdir( rootPath, { withFileTypes: true } )
        } catch {
            return { plans }
        }

        const planFolders = entries
            .filter( ( e ) => e.isDirectory() && /^PLAN-\d{3}-[a-z0-9-]+$/.test( e.name ) )
            .map( ( e ) => e.name )

        const results = await Promise.all(
            planFolders
                .map( async ( folder ) => {
                    const folderPath = resolve( rootPath, folder )
                    const statusPath = resolve( folderPath, 'plan-status.json' )

                    let raw

                    try {
                        raw = await readFile( statusPath, 'utf-8' )
                    } catch {
                        const result = {
                            'folder': folder,
                            'planId': folder,
                            'status': 'unknown',
                            'phases': [],
                            'isInvalid': true,
                            'validationErrors': [ 'plan-status.json missing' ]
                        }

                        return result
                    }

                    let parsed

                    try {
                        parsed = JSON.parse( raw )
                    } catch( err ) {
                        const result = {
                            'folder': folder,
                            'planId': folder,
                            'status': 'unknown',
                            'phases': [],
                            'isInvalid': true,
                            'validationErrors': [ `plan-status.json invalid JSON: ${err.message}` ]
                        }

                        return result
                    }

                    const { isValid, errors } = MemoView.#validatePlanStatus( { obj: parsed } )

                    const result = {
                        'folder': folder,
                        'planId': parsed['planId'] || folder,
                        'status': parsed['status'] || 'unknown',
                        'memos': Array.isArray( parsed['memos'] ) ? parsed['memos'] : [],
                        'phases': Array.isArray( parsed['phases'] ) ? parsed['phases'] : [],
                        'isInvalid': !isValid,
                        'validationErrors': errors
                    }

                    return result
                } )
        )

        return { plans: results }
    }


    static async #broadcastPlanList( { wss } ) {
        if( !wss ) { return }

        const { plans: allPlans } = await MemoView.#aggregatePlansFromRegistry()
        const { documents } = MemoView.#registry ? MemoView.#registry.getDocuments() : { 'documents': [] }
        const { openMemos } = MemoView.computeOpenFinalizedMemos( { 'projectId': undefined, 'plans': allPlans, documents } )
        const message = JSON.stringify( { 'type': 'planList', 'plans': allPlans, openMemos } )

        wss.clients
            .forEach( ( ws ) => {
                if( ws.readyState === 1 ) {
                    ws.send( message )
                }
            } )
    }


    static async #aggregatePlansFromRegistry() {
        if( MemoView.#planRegistry ) {
            const { plans: registryEntries } = await MemoView.#planRegistry.list()

            if( registryEntries.length > 0 ) {
                const perRootResults = await Promise.all(
                    registryEntries
                        .map( async ( entry ) => {
                            const { plans: rootPlans } = await MemoView.#scanPlans( { 'rootPath': entry['absolutePath'] } )

                            return rootPlans
                                .map( ( plan ) => {
                                    return { ...plan, 'projectId': entry['projectId'] }
                                } )
                        } )
                )

                const allPlans = perRootResults
                    .reduce( ( acc, rootPlans ) => {
                        return [ ...acc, ...rootPlans ]
                    }, [] )

                return { 'plans': allPlans }
            }
        }

        // Fallback: legacy single-root scan
        const fallbackRoot = MemoView.#plansRootPath || resolve( process.cwd(), '.memo', 'plans' )
        const { plans } = await MemoView.#scanPlans( { 'rootPath': fallbackRoot } )

        return { plans }
    }


    static #startPlansWatcher( { wss, rootPath } ) {
        MemoView.#plansRootPath = rootPath

        try {
            const watcher = watch( rootPath, { recursive: false }, () => {
                MemoView.#broadcastPlanList( { wss } )
            } )

            MemoView.#planWatcher = watcher

            return { watcher }
        } catch {
            return { watcher: null }
        }
    }


    static #openBrowser( { url } ) {
        exec( `open "${url}"` )
    }


    static #registerShutdown( { server, wss, state } ) {
        const shutdown = () => {
            process.stdout.write( '\n  Shutting down...\n\n' )

            if( state.watcher ) {
                state.watcher.close()
            }

            if( MemoView.#planWatcher ) {
                MemoView.#planWatcher.close()
                MemoView.#planWatcher = null
            }

            if( MemoView.#transcriptRegistry ) {
                MemoView.#transcriptRegistry.shutdown()
            }

            wss.clients.forEach( ( ws ) => {
                ws.close()
            } )

            wss.close()

            server.close( () => {
                process.exit( 0 )
            } )
        }

        process.on( 'SIGINT', shutdown )
        process.on( 'SIGTERM', shutdown )
    }
}


export { MemoView }
