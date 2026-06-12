import { createServer } from 'node:http'
import { readFile, access, readdir } from 'node:fs/promises'
import { watch } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'
import { exec } from 'node:child_process'

import { WebSocketServer } from 'ws'

import { DocumentRegistry } from './DocumentRegistry.mjs'
import { MemoValidator } from './MemoValidator.mjs'
import { PlanRegistry } from './PlanRegistry.mjs'
import { TranscriptRegistry } from './TranscriptRegistry.mjs'
import { Config } from './data/config.mjs'


const PORT_SCHEMA = [ 3333, 4444, 5555, 6666, 7777, 8888 ]

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

            server.listen( portNumber, () => {
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

            server.listen( portNumber, '127.0.0.1', () => {
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

        const available = results
            .find( ( r ) => !r['inUse'] )

        const availablePort = available ? available['port'] : null

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

            testServer.listen( port )
        } )
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
    <style>
        :root {
            --bg-0: #010409;
            --bg-1: #0d1117;
            --bg-2: #161b22;
            --bg-3: #1c2128;
            --bg-4: #21262d;
            /* PRD-018 (Memo 016 Kap 7.2): single shared subtle-gray hover token for ALL
               sidebar rows (memo-head, rev-entry, queue-entry). Kept distinctly lighter than
               the row background yet softer than the selected-state accent. */
            --hover-bg: #2b313b;
            --border: #30363d;
            --border-subtle: rgba(110, 118, 129, 0.4);
            --text-1: #e6edf3;
            --text-2: #c9d1d9;
            --text-muted: #8b949e;
            --text-muted-2: #6e7681;
            --text-on-accent: #f6f8fa;
            --accent: #2ea043;
            --accent-bright: #3fb950;
            --danger: #f85149;
            --warning: #d29922;
            --type-impl: #db6d28;
            --link: #4493f8;
            --link-bright: #58a6ff;
            --diff-add-bg: rgba(63, 185, 80, 0.12);
            --diff-del-bg: rgba(248, 81, 73, 0.1);
            --warn-bg: rgba(210, 153, 34, 0.12);
            --overlay: rgba(1, 4, 9, 0.92);
            --shadow: rgba(0, 0, 0, 0.7);
            --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
            --font-mono: 'SF Mono', 'Monaco', 'Consolas', 'Liberation Mono', monospace;
            --sp-1: 4px;
            --sp-2: 8px;
            --sp-3: 12px;
            --sp-4: 16px;
            --sp-5: 24px;
            --sp-6: 32px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            background: var(--bg-1);
            color: var(--text-1);
            font-family: var(--font-sans);
            font-size: 16px;
            line-height: 1.5;
            word-wrap: break-word;
        }

        #nav-bar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 52px;
            background: var(--bg-2);
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            padding: 0 16px 0 20px;
            z-index: 1000;
            gap: 12px;
        }

        /* NavBar brand — only place the deco emoji is allowed besides popups/status */
        #nav-brand {
            color: var(--text-1);
            font-size: 16px;
            font-weight: 700;
            white-space: nowrap;
            flex-shrink: 0;
        }

        /* Toggle pill group (Memos / Plans) */
        #mode-toggle {
            display: inline-flex;
            background: var(--bg-4);
            border-radius: 8px;
            padding: 3px;
            gap: 2px;
            flex-shrink: 0;
        }

        .mode-toggle {
            background: transparent;
            border: 1px solid transparent;
            color: var(--text-muted);
            cursor: pointer;
            padding: 4px 12px;
            border-radius: 6px;
            font-size: 13px;
            font-family: inherit;
            font-weight: 500;
        }

        .mode-toggle:hover { color: var(--text-1); }

        .mode-toggle.active {
            background: var(--bg-3);
            border-color: var(--border);
            color: var(--text-1);
            font-weight: 700;
        }

        #nav-spacer { flex: 1 1 auto; min-width: 0; }

        /* Primary green button (+ Neues Memo / + Neuer Plan) */
        .nav-btn-primary {
            background: var(--accent);
            border: 1px solid var(--accent);
            color: var(--text-1);
            cursor: pointer;
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            font-family: inherit;
            flex-shrink: 0;
        }

        .nav-btn-primary:hover { background: var(--accent); }

        /* Secondary button (+ Transcript) */
        .nav-btn-secondary {
            background: var(--bg-2);
            border: 1px solid var(--border);
            color: var(--text-1);
            cursor: pointer;
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 500;
            font-family: inherit;
            flex-shrink: 0;
        }

        .nav-btn-secondary:hover { border-color: var(--text-muted); }

        #nav-back {
            background: none;
            border: 1px solid var(--border);
            color: var(--text-muted);
            cursor: pointer;
            padding: 2px 8px;
            border-radius: 6px;
            font-size: 13px;
            font-family: inherit;
            flex-shrink: 0;
        }

        #nav-back:hover { color: var(--text-1); border-color: var(--text-muted); }
        #nav-back:disabled { opacity: 0.3; cursor: default; }
        #nav-back:disabled:hover { color: var(--text-muted); border-color: var(--border); }

        #nav-file {
            color: var(--text-muted);
            font-size: 13px;
            font-family: var(--font-mono);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex-shrink: 1;
        }

        #status {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--danger);
            opacity: 0.6;
            transition: background 0.3s;
            flex-shrink: 0;
        }

        #status.connected { background: var(--accent-bright); }

        /* PRD-008: two-line content-sticky-header.
           Line 1: Titel + Memo-Typ-Badge + Status-Pill + Diff-Toggle.
           Line 2: Transcript kopieren + URL + Woerter/Minuten. */
        /* PRD-006 (Memo 019 Kap 6): the sticky header is a 3-zone model. #main-header is the
           sticky frame holding Zone 1 (Info, gelockt) + Zone 2 (Interaktion, Platzhalter).
           Zone 3 (Content) lives in #content and scrolls — it is NOT inside this sticky frame.
           Both zones stay fixed at the top while the content scrolls (AC-1). */
        #main-header {
            position: sticky;
            top: 52px;
            z-index: 4;
            display: flex;
            flex-direction: column;
            gap: 0;
            background: var(--bg-1);
            border-bottom: 1px solid var(--border);
            padding: 0;
            font-size: 13px;
        }

        #main-header:empty { display: none; }

        /* Zone wrappers. Zone 1 sits on the page background; Zone 2 is set apart by its own
           subtle fill + a top divider (Soll o0zun: fill #F4F4F5, top stroke). */
        #main-header .hdr-zone { display: flex; flex-direction: column; min-width: 0; }
        #main-header .hdr-zone-1 { background: var(--bg-1); }
        #main-header .hdr-zone-2 {
            background: var(--bg-2);
            border-top: 1px solid var(--border);
            padding: 10px 20px;
        }

        /* ---- Zone 2 — Prompt-Statuszeile (PRD-008, Frame o0zun). ----
           STRICTLY two rows (Kap 9.3): .ps-row--transcript + .ps-row--fragen. Vertical
           container (o0zun: layout vertical, gap 9). Each row is horizontal (gap 8). */
        #main-header .prompt-statuszeile {
            display: flex;
            flex-direction: column;
            gap: 9px;
            min-width: 0;
        }
        #main-header .ps-row {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }
        /* Icon + Label (he2EW/EQVXw, sHp3P/vfGXX): 11px / 700, label dark. */
        #main-header .ps-ico { font-size: 12px; line-height: 1; color: var(--text-2); flex-shrink: 0; }
        #main-header .ps-label { font-size: 11px; font-weight: 700; color: var(--text-1); flex-shrink: 0; }
        #main-header .ps-sep { font-size: 11px; color: var(--text-muted-2); flex-shrink: 0; }
        /* Minuten-Leitkennzahl (C7weW): dark chip #18181B, white text, PROMINENT (Kap 9.4). */
        #main-header .ps-minutes {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 11px;
            font-weight: 700;
            color: #FFFFFF;
            background: #18181B;
            border-radius: 6px;
            padding: 2px 9px;
            white-space: nowrap;
            flex-shrink: 0;
        }
        #main-header .ps-minutes .ps-mic { font-size: 11px; line-height: 1; }
        /* Wörter (N7f0I): secondary, muted #71717A, AFTER the minutes. */
        #main-header .ps-words {
            font-size: 11px;
            font-weight: 400;
            color: var(--text-muted);
            white-space: nowrap;
            flex-shrink: 0;
        }
        #main-header .ps-empty {
            font-size: 11px;
            font-style: italic;
            color: var(--text-muted);
            white-space: nowrap;
        }
        #main-header .ps-spacer { flex: 1 1 auto; }
        /* "Prompt bearbeiten" (bHsKm): white button, dark 1.5px border, pencil icon. */
        #main-header .ps-edit {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-family: inherit;
            font-size: 11px;
            font-weight: 700;
            color: var(--text-1);
            background: var(--bg-1);
            border: 1.5px solid var(--text-1);
            border-radius: 7px;
            padding: 4px 11px;
            cursor: pointer;
            white-space: nowrap;
            flex-shrink: 0;
        }
        #main-header .ps-edit:hover { background: var(--bg-4); }
        /* Copy-Icon (iZM8G): square icon button. */
        #main-header .ps-copy {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 30px;
            height: 26px;
            font-size: 13px;
            color: var(--text-2);
            background: var(--bg-1);
            border: 1px solid var(--border);
            border-radius: 7px;
            cursor: pointer;
            flex-shrink: 0;
        }
        #main-header .ps-copy:hover:not(:disabled) { color: var(--text-1); border-color: var(--text-muted); }
        #main-header .ps-copy:disabled { opacity: 0.5; cursor: default; }
        /* beantwortet/offen (fMlP3): 11px / 600. */
        #main-header .ps-answered { font-size: 11px; font-weight: 600; color: var(--text-2); white-space: nowrap; flex-shrink: 0; }
        /* Fragezeichen-Indikator (Vvpcy): chip "? N offen", white, 1px border. */
        #main-header .ps-qmark {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            font-size: 10px;
            font-weight: 700;
            color: var(--text-2);
            background: var(--bg-1);
            border: 1px solid var(--border);
            border-radius: 7px;
            padding: 2px 9px;
            white-space: nowrap;
            flex-shrink: 0;
        }
        #main-header .ps-qmark .ps-qmark-sign { font-size: 13px; line-height: 1; }
        /* "Abschliessen" (ImDqp): dark button #18181B, white text, right. */
        #main-header .ps-finish {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-family: inherit;
            font-size: 11px;
            font-weight: 700;
            color: #FFFFFF;
            background: #18181B;
            border: none;
            border-radius: 7px;
            padding: 5px 12px;
            cursor: pointer;
            white-space: nowrap;
            flex-shrink: 0;
        }
        #main-header .ps-finish:hover { background: #000000; }

        /* ---- Zone 1 — Informationsebene (gelockt, Frame JaA9o). ---- */
        /* Zeile 1 (YtFVI): horizontal, alignItems center, gap 12, padding [14,20,6,20]. */
        #main-header .z1-line1 {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 14px 20px 6px 20px;
            min-width: 0;
        }
        /* Titel (BKYwK): 17px / weight 700. */
        #main-header .z1-title {
            font-size: 17px;
            font-weight: 700;
            color: var(--text-1);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 0 1 auto;
            min-width: 0;
        }
        /* Status-Pill (NUj56): radius 7, stroke 1.5, padding [3,10]; Text 10px / 700. */
        #main-header .z1-pill {
            font-size: 10px;
            font-weight: 700;
            line-height: 1;
            border-radius: 7px;
            padding: 3px 10px;
            border: 1.5px solid var(--text-1);
            color: var(--text-1);
            background: transparent;
            white-space: nowrap;
            flex-shrink: 0;
        }
        #main-header .z1-pill.z1pill-final {
            color: var(--accent-bright);
            border-color: var(--accent);
            background: var(--diff-add-bg);
        }
        #main-header .z1-pill.z1pill-draft {
            color: var(--text-2);
            border-color: var(--text-muted);
        }
        /* Zeile 2 (9I8kz): horizontal, alignItems center, gap 8, padding [0,20,12,20]. */
        #main-header .z1-line2 {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 0 20px 12px 20px;
            min-width: 0;
        }
        /* Doc-Pfad (ebWea): 11px / 600 / #52525B. */
        #main-header .z1-doc {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-2);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 0 1 auto;
            min-width: 0;
        }
        #main-header .z1-cal { font-size: 11px; line-height: 1; flex-shrink: 0; opacity: 0.7; }
        /* Datum (RSzhu) / Typ (vT8Px) / KB (LQtCr): 11px / #71717A. */
        #main-header .z1-date,
        #main-header .z1-type,
        #main-header .z1-kb {
            font-size: 11px;
            color: var(--text-muted);
            white-space: nowrap;
            flex-shrink: 0;
        }
        /* Separator "·" (8LBFt/QktG5): 11px / #D4D4D8. */
        #main-header .z1-sep {
            font-size: 11px;
            color: var(--text-muted-2);
            flex-shrink: 0;
        }

        #main-header .mh-line1,
        #main-header .mh-line2,
        #main-header .mh-title-row,
        #main-header .mh-status-row {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }

        /* PRD-004 (Memo 018 Kap 7 / 014 Kap 10): the title line is its own first row,
           informational only (no action buttons). */
        #main-header .mh-title-row { font-weight: 700; }

        /* PRD-004 (Kap 7 R4): unified badge base — every header badge shares mh-badge,
           the modifier mh-badge--{typ} (or the legacy mh-type-badge/mh-pill state classes)
           supplies the variant colour. */
        #main-header .mh-badge {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            border-radius: 10px;
            padding: 1px 8px;
            border: 1px solid var(--border);
            color: var(--text-muted);
            background: var(--bg-4);
            white-space: nowrap;
            flex-shrink: 0;
        }

        #main-header .mh-badge.mh-badge--impl {
            color: var(--type-impl);
            border-color: var(--type-impl);
            background: rgba( 219, 109, 40, 0.12 );
        }

        /* PRD-004 (Kap 7): Transcript-Statuszeile status badges. */
        #main-header .mh-badge.mh-badge--offen {
            color: var(--accent-bright);
            border-color: var(--accent);
            background: var(--diff-add-bg);
        }

        #main-header .mh-badge.mh-badge--transcript {
            color: var(--link-bright);
            border-color: var(--link);
            background: transparent;
        }

        #main-header .mh-badge.mh-badge--eingeloggt {
            color: var(--accent-bright);
            border-color: var(--accent);
            background: var(--diff-add-bg);
        }

        /* BUGFIX (fix/transcript-abschliessen-queue): the "abgeschlossen" status badge on a
           logged-in revision lives in the sidebar tree (rev-mini), not #main-header. Mirror the
           header badge look at a quieter sidebar scale so an abgeschlossene Revision is visible. */
        .rev-mini .mh-badge {
            font-size: 9px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            border-radius: 8px;
            padding: 0 6px;
            border: 1px solid var(--border);
            color: var(--text-muted);
            background: var(--bg-4);
            white-space: nowrap;
            flex-shrink: 0;
        }

        .rev-mini .mh-badge.mh-badge--eingeloggt {
            color: var(--accent-bright);
            border-color: var(--accent);
            background: var(--diff-add-bg);
        }

        #main-header .mh-title {
            color: var(--text-1);
            font-weight: 700;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        #main-header .mh-spacer { flex: 1 1 auto; }

        #main-header .mh-type-badge {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            border-radius: 10px;
            padding: 1px 8px;
            border: 1px solid var(--border);
            color: var(--text-2);
            background: var(--bg-4);
            white-space: nowrap;
            flex-shrink: 0;
        }

        #main-header .mh-type-badge.type-impl {
            color: var(--type-impl);
            border-color: var(--type-impl);
            background: rgba( 219, 109, 40, 0.12 );
        }

        #main-header .mh-pill {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            border-radius: 10px;
            padding: 1px 8px;
            border: 1px solid var(--border);
            color: var(--text-muted);
            white-space: nowrap;
            flex-shrink: 0;
        }

        #main-header .mh-pill.pill-final {
            color: var(--accent-bright);
            border-color: var(--accent);
            background: var(--diff-add-bg);
        }

        #main-header .mh-pill.pill-transcript {
            color: var(--link-bright);
            border-color: var(--link);
            background: transparent;
        }

        #main-header .mh-pill.pill-feedback {
            color: var(--accent-bright);
            border-color: var(--accent);
            background: var(--diff-add-bg);
        }

        #main-header .mh-copy-btn {
            background: none;
            border: 1px solid var(--border);
            color: var(--text-2);
            cursor: pointer;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-family: inherit;
            white-space: nowrap;
            flex-shrink: 0;
        }

        #main-header .mh-copy-btn:hover:not(:disabled) {
            color: var(--text-1);
            border-color: var(--text-muted);
        }

        #main-header .mh-copy-btn:disabled {
            opacity: 0.5;
            cursor: default;
        }

        #main-header .mh-url {
            color: var(--text-muted);
            font-family: var(--font-mono);
            font-size: 11px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        #main-header .mh-url.mh-url-empty {
            font-family: inherit;
            font-style: italic;
        }

        #main-header .mh-words {
            color: var(--text-muted);
            font-size: 11px;
            white-space: nowrap;
            flex-shrink: 0;
        }

        #main-header .mh-status {
            color: var(--text-muted);
            font-size: 11px;
            white-space: nowrap;
        }

        #main {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
        }

        #content {
            padding: 24px;
            min-width: 0;
            max-width: 980px;
        }

        /* PRD-001 (#16-18): raw question markdown bodies hidden once widgets render. */
        #content .raw-question-hidden { display: none; }

        /* PRD-002 (#12/#15): caps section labels (style analog .sb-group-header). */
        #content .section-caps-label,
        #content .section-caps-host::before {
            color: var(--text-muted);
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.4px;
        }
        #content .section-caps-host::before { content: attr(data-caps); display: block; }

        /* PRD-002 (#13): TOPICS chip strip (style analog .qw-topics / .qw-topic-link). */
        #content .topic-chips {
            display: flex;
            flex-wrap: wrap;
            gap: var(--sp-1);
            margin: var(--sp-2) 0;
        }
        #content .topic-chip {
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--link);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 1px 8px;
        }

        /* PRD-002 (#14): Metatags chip strip. */
        #content .meta-chips {
            display: flex;
            flex-wrap: wrap;
            gap: var(--sp-1);
            margin: var(--sp-2) 0;
        }
        #content .meta-chip {
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--text-muted);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 1px 8px;
        }

        h1, h2, h3, h4, h5, h6 {
            color: var(--text-1);
            margin-top: 24px;
            margin-bottom: 16px;
            font-weight: 600;
            line-height: 1.25;
        }

        h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
        h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
        h3 { font-size: 1.25em; }
        h4 { font-size: 1em; }

        h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }

        p { margin-top: 0; margin-bottom: 16px; }

        a { color: var(--link); text-decoration: none; }
        a:hover { text-decoration: underline; }

        strong { color: var(--text-1); font-weight: 600; }

        code {
            background: var(--border-subtle);
            padding: 0.2em 0.4em;
            border-radius: 6px;
            font-family: var(--font-mono);
            font-size: 85%;
        }

        pre {
            background: var(--bg-2);
            padding: 16px;
            border-radius: 6px;
            overflow-x: auto;
            margin-top: 0;
            margin-bottom: 16px;
            border: 1px solid var(--border);
            line-height: 1.45;
        }

        pre code {
            background: transparent;
            padding: 0;
            border-radius: 0;
            font-size: 85%;
            line-height: inherit;
            word-wrap: normal;
        }

        blockquote {
            border-left: 0.25em solid var(--border);
            padding: 0 1em;
            margin: 0 0 16px 0;
            color: var(--text-muted);
        }

        blockquote > :first-child { margin-top: 0; }
        blockquote > :last-child { margin-bottom: 0; }

        blockquote p {
            margin-bottom: 4px;
        }

        blockquote p:last-child {
            margin-bottom: 0;
        }

        .diff-banner {
            background: var(--bg-2);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 12px 16px;
            margin-bottom: 16px;
            font-size: 13px;
            color: var(--text-muted);
        }

        .diff-banner a {
            color: var(--link);
            cursor: pointer;
        }

        .diff-banner a:hover {
            text-decoration: underline;
        }

        .diff-added {
            background-color: var(--diff-add-bg);
            border-left: 3px solid var(--accent-bright);
            padding-left: 8px;
        }

        .diff-removed {
            background-color: var(--diff-del-bg);
            border-left: 3px solid var(--danger);
            padding-left: 8px;
            text-decoration: line-through;
            opacity: 0.6;
        }

        /* PRD-002 (#11): clear button look — background + stronger border/text
           (--surface-2/--surface-3 are not defined; existing bg-3/bg-4 tokens used). */
        /* PRD-007 (Memo 022 Kap 5): kleiner Diff-Button neben der Zone-1-Pill. Kein margin-left
           mehr — .z1-line1 setzt bereits gap: 12px. Optisch an die Pill angeglichen (klein,
           kompakt, nicht voll-breit). Toggle-Optik (hover/active) bleibt erhalten. */
        #diff-toggle {
            background: var(--bg-3);
            border: 1px solid var(--text-muted);
            color: var(--text-1);
            cursor: pointer;
            padding: 3px 10px;
            border-radius: 7px;
            font-size: 10px;
            font-weight: 700;
            line-height: 1;
            font-family: inherit;
            flex-shrink: 0;
        }

        #diff-toggle:hover { color: var(--text-1); border-color: var(--accent); background: var(--bg-4); }
        #diff-toggle.active { color: var(--accent-bright); border-color: var(--accent-bright); background: var(--diff-add-bg); }

        /* Memo 016 P3 (PRD-013): same compact button look as #diff-toggle; nowrap +
           flex-shrink:0 so the label is never squeezed into a tall narrow box. */
        #sticky-add-transcript {
            background: var(--bg-3);
            border: 1px solid var(--text-muted);
            color: var(--text-1);
            cursor: pointer;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-family: inherit;
            margin-left: 8px;
            white-space: nowrap;
            flex-shrink: 0;
        }
        #sticky-add-transcript:hover { color: var(--text-1); border-color: var(--accent); background: var(--bg-4); }
        #sticky-add-transcript[data-exists="1"] { opacity: 0.65; }

        #layout {
            display: flex;
            margin: 52px 0 0;
        }

        #doc-sidebar {
            position: sticky;
            top: 52px;
            width: 320px;
            min-width: 320px;
            height: calc( 100vh - 52px );
            overflow-y: auto;
            padding: 0;
            background: var(--bg-2);   /* PRD-003 (#54): #161b22 statt #010409 (zu dunkel) */
            border-right: 1px solid var(--border);
            font-size: 13px;
        }

        /* Plans-View narrows the sidebar to 280px */
        #doc-sidebar.plans-mode {
            width: 280px;
            min-width: 280px;
        }

        #doc-sidebar-body {
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        /* Namespace / section group headers */
        .sb-group-header {
            color: var(--text-muted);
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            padding: 6px 4px 2px;
        }

        /* PRD-003 (Memo 018 Kap 6): content placeholder — replaces inline color:#888 with the
           shared muted token so the "Dokument auswaehlen..." text follows the design language. */
        .content-placeholder {
            color: var(--text-muted);
            font-size: 13px;
            padding: 16px;
        }

        /* PRD-006 (#36): namespace-style group header with vertical bar glyph. */
        .sb-ns-bar {
            color: var(--accent);
            font-weight: 700;
        }

        .sb-divider {
            height: 1px;
            background: var(--border);
            margin: 8px 0;
        }

        /* PRD-003 (Memo 018 Kap 6 / 014 Kap 7): spacing between the last revision of a memo
           and the next memo header. The memo-group wraps the memo head + its revision list. */
        .memo-group {
            margin-bottom: 6px;
        }

        /* Memo-Header-Zeile (status icon + name + transcript count) */
        .memo-head {
            display: flex;
            align-items: center;
            gap: 6px;
            /* Fix (#81): the header wraps — the memo name keeps line 1 to itself (always fully
               readable), the status cluster (badge + minutes + finalisiert) drops to line 2 via
               .mh-break. row-gap keeps the two lines tight. */
            flex-wrap: wrap;
            row-gap: 4px;
            min-height: 30px;
            /* PRD-006 (#37/#61/#62): memo-header as a card — radius 8, own BG #2B313B. */
            border-radius: 8px;
            background: #2B313B;
            padding: 6px 8px;
            /* REV-05 R3: the whole header toggles its revisions — make it feel clickable. */
            cursor: pointer;
            /* PRD-003 (#63): transparent base border so .selected only swaps the color
               (no 1px layout shift). */
            border: 1px solid transparent;
            transition: background 0.12s ease, border-color 0.12s ease;
        }

        /* PRD-018 (Memo 016 Kap 7.2): unified subtle-gray hover across ALL sidebar rows
           (memo-head, rev-entry, queue-entry). The shared token is --hover-bg; the
           selected-state stays clearly stronger (accent border + inset shadow) so hover and
           selected never become indistinguishable. */
        .memo-head:hover {
            background: var(--hover-bg);
            border-color: #3a424e;
        }

        .memo-head.selected {
            background: var(--bg-4);
            /* PRD-003 (#63): ruhiger Border statt grellweiss (#e6edf3 / --text-1). */
            border: 1px solid #3a424e;
        }

        .memo-head.selected:hover {
            border-color: var(--accent);
        }

        /* PRD-003 (#63): neutralise any focus outline appearing as a white frame. */
        .memo-head.selected:focus,
        .memo-head.selected:focus-visible {
            outline: 1px solid #3a424e;
            outline-offset: 0;
        }

        .memo-head .mh-caret {
            font-size: 10px;
            color: var(--text-muted);
            cursor: pointer;
            user-select: none;
            flex-shrink: 0;
            width: 12px;
            text-align: center;
        }

        .memo-head .mh-caret:hover { color: var(--text-1); }

        .memo-head .mh-icon {
            font-size: 12px;
            flex-shrink: 0;
        }

        .memo-head .mh-name {
            color: var(--text-1);
            font-size: 12px;
            font-weight: 700;
            /* Fix (#81): the memo name stays on a SINGLE line and truncates with an ellipsis
               when too long (user preference). flex-basis 0 keeps caret + icon + name together
               on line 1; the name grows to fill the rest of the row. The status cluster drops
               to its own line via .mh-break. */
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 1 1 0;
            min-width: 0;
        }

        /* Fix (#81): full-width zero-height break that forces the status cluster onto a
           second line inside the wrapping memo-head. */
        .memo-head .mh-break { flex: 0 0 100%; height: 0; margin: 0; padding: 0; }

        /* Fix (#81): on line 2 the status items pack left so badge + minutes + finalisiert
           fit on a single line (a growing spacer pushed them past the edge and wrapped). */
        .memo-head .mh-spacer { flex: 0 0 0; }

        /* Fix (#83): right-align the minutes chip (and any trailing finalisiert badge) on
           line 2 — auto margin absorbs the free space without the wrap quirk of a flex-grow
           spacer, so the status badge stays left and the minutes sit at the right edge. */
        .memo-head .mh-minutes { margin-left: auto; }

        #doc-sidebar ul {
            list-style: none;
            padding: 0;
            margin: 0;
        }

        #doc-sidebar li {
            padding: 2px 6px;
            color: var(--text-muted);
        }

        #doc-sidebar li[data-doc] {
            cursor: pointer;
            border-radius: 4px;
        }

        #doc-sidebar li[data-doc]:hover {
            background: var(--bg-2);
            color: var(--text-1);
        }

        #doc-sidebar strong {
            color: var(--text-1);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        /* Two-line revision entries (indented under memo head, uniform height) */
        .rev-entry {
            display: flex;
            flex-direction: column;
            justify-content: center;
            min-height: 38px;
            box-sizing: border-box;
            border-radius: 4px;
            padding: 5px 8px 5px 28px;
            cursor: pointer;
            line-height: 1.3;
        }

        /* PRD-018: same subtle-gray hover as .memo-head (was var(--bg-2), too dark to read). */
        .rev-entry:hover {
            background: var(--hover-bg);
        }

        .rev-entry.rev-selected {
            background: var(--bg-4);
            border-left: 2px solid var(--accent);
            box-shadow: inset 0 0 0 1px var(--accent);
        }

        .rev-line1 {
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--text-2);
            font-size: 12px;
        }

        .rev-entry.rev-selected .rev-line1 {
            color: var(--text-1);
            font-weight: 700;
        }

        .rev-entry.rev-muted .rev-line1 {
            color: var(--text-muted-2);
        }

        .rev-line1 .rev-spacer { flex: 1 1 auto; }

        /* Revision type badges */
        .rev-type {
            font-size: 9px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            border-radius: 10px;
            padding: 1px 7px;
            flex-shrink: 0;
        }

        /* Full: high contrast, NO green (green is exclusive to ball-status, PRD-007 #6) */
        .rev-type.rt-full {
            background: var(--diff-add-bg);
            color: var(--accent-bright);
            border: 1px solid var(--accent);
        }

        .rev-type.rt-update {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-muted);
        }

        .rev-type.rt-prepare {
            background: var(--bg-4);
            color: var(--text-muted);
        }

        .rev-chat {
            color: var(--link-bright);
            font-size: 11px;
            flex-shrink: 0;
        }

        .rev-line2 {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            color: var(--text-muted);
            font-size: 10px;
            margin-top: 2px;
        }

        .rev-line2 .rev-meta-right {
            flex-shrink: 0;
            text-align: right;
        }

        .rev-entry.rev-muted .rev-line2 {
            color: var(--text-muted-2);
        }

        .rev-entry.rev-muted {
            opacity: 0.7;
        }

        /* PRD-001 (Memo 019 Kap 1): legacy/parseError revisions stay visible in the namespace
           tree but are clearly dimmed ("ausgegraut") and set apart from new revisions. They never
           appear in the queue (see computeQueue / DocumentRegistry.isInQueue). */
        .rev-entry.rev-legacy-muted {
            opacity: 0.45;
        }
        .rev-entry.rev-legacy-muted .rev-line1,
        .rev-entry.rev-legacy-muted .rev-line2 {
            color: var(--text-muted-2);
            font-style: italic;
        }

        /* PRD-001 (Memo 019 Kap 1): the finalized-memo minutes chip — microphone icon +
           aggregated spoken minutes + "Min", shown INSTEAD of a date for finalized memos. */
        .mh-minutes {
            display: inline-flex;
            align-items: center;
            white-space: nowrap;
            flex-shrink: 0;
            font-size: 10px;
            font-weight: 600;
            color: var(--text-muted);
            margin-left: 6px;
        }

        /* PRD-001 (Memo 019 Kap 1): Queue-item info model. The namespace is a LABEL on the item
           (flat list, no grouping); name + REV-ID + status share line1, date + open-count line2. */
        .qe-entry .qe-ns {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--text-muted);
            margin-right: 6px;
        }
        .qe-entry .qe-name {
            font-weight: 600;
            margin-right: 6px;
        }
        .qe-entry .qe-status {
            font-size: 10px;
            color: var(--text-muted);
        }

        .rev-questions {
            color: var(--text-muted);
        }

        /* PRD-016: read-only memo status badge.
           PRD-019 (Memo 016 Kap 7.1): the badge must NOT wrap to a 2nd line ("Bedingt
           finalisiert" was breaking while "Finalisiert" stayed 1-line, making the row height
           jump). nowrap + a fixed line-height/min-height keep every status one line and the
           badge position stable. flex-shrink:0 prevents the flex row from squeezing it. */
        .memo-badge {
            display: inline-flex;
            align-items: center;
            white-space: nowrap;
            line-height: 14px;
            min-height: 16px;
            flex-shrink: 0;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            border-radius: 10px;
            padding: 0 8px;
            margin-left: 6px;
            vertical-align: middle;
            border: 1px solid var(--border);
            color: var(--text-muted);
        }

        .memo-badge.badge-final {
            color: var(--accent-bright);
            border-color: var(--accent);
            background: var(--diff-add-bg);
        }

        .memo-badge.badge-conditional {
            color: var(--warning);
            border-color: #9e6a03;
            background: var(--warn-bg);
        }

        .memo-badge.badge-draft {
            color: var(--text-muted);
            border-color: var(--border);
            background: transparent;
        }

        /* PRD-019: deep-link open-questions marker — quiet text count ("N ?") instead of an
           emoji. Kept in the warning colour so the open-questions state stays glanceable. */
        /* PRD-006 (Memo 019 Kap 6.4 / AC-10): "Fragezeichen + Nummer"-Indikator als ruhiger,
           linksbuendiger Chip. Box-Abstand zum Fragezeichen vergroessert (eleganter) — der "?"
           und die Zahl bekommen Luft (gap) und der Chip eine eigene Box (padding + border). */
        .questions-link {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            margin-left: 8px;
            padding: 1px 7px;
            border-radius: 7px;
            border: 1px solid var(--border);
            cursor: pointer;
            font-size: 10px;
            font-weight: 700;
            color: var(--warning);
            flex-shrink: 0;
        }

        .questions-link:hover {
            color: #f0c674;
        }

        /* PRD-019: per-revision transcript marker — quiet uppercase text tag (was a 🗒 emoji). */
        .rev-transcript-indicator {
            font-size: 9px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            color: var(--text-muted);
            flex-shrink: 0;
        }

        /* PRD-007 (Memo 018 Kap 10): legacy/inkompatible Revisionen — "alte Version".
           Reuses the .rev-type badge geometry, quiet muted styling, never green. */
        .rev-type.rt-legacy {
            background: transparent;
            border: 1px dashed var(--border);
            color: var(--text-muted);
        }

        .questions-link:empty {
            display: none;
        }

        /* Plans-View sidebar — plan pills + open memos */
        .plan-pill {
            display: block;
            border-radius: 4px;
            padding: 6px 8px;
            cursor: pointer;
            color: var(--text-2);
            font-size: 12px;
        }

        .plan-pill:hover { background: var(--bg-2); }

        .plan-pill.selected {
            background: var(--bg-4);
            color: var(--text-1);
            font-weight: 700;
        }

        .plan-pill.invalid { color: var(--warning); }

        .open-memo {
            border-radius: 4px;
            padding: 5px 8px;
        }

        .open-memo .om-name {
            display: block;
            color: var(--text-2);
            font-size: 12px;
            font-weight: 600;
        }

        .open-memo .om-status {
            display: block;
            color: var(--text-muted);
            font-size: 10px;
            margin-top: 1px;
        }

        .open-memo.not-final {
            opacity: 0.45;
        }

        /* PRD-016: sidebar Queue (Warteschlange) — FIFO list above the namespace groups. */
        .sb-queue {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .sb-queue-empty {
            color: var(--text-muted);
            font-size: 11px;
            padding: 4px 8px;
        }

        /* ============================================================================
           PRD-006 / PRD-007 (Memo 019 Kap 6+7): Pencil v4 Sidebar — Namespace-Box,
           Revisions-Mini-Widget, Queue-Item-Container. Light-mode Soll-Werte (Geometrie:
           Masse/Abstaende/Hierarchie) sind frame-treu uebernommen; die Farben sind auf das
           bestehende Dark-Theme gemappt (gleiche prominenz-relationen wie im Mockup).
           ============================================================================ */

        /* ---- Namespace-Box (Soll npwAk: radius 10, stroke 1.5, clip). ---- */
        .ns-box {
            border-radius: 10px;
            border: 1.5px solid var(--border);
            background: var(--bg-1);
            overflow: hidden;
            margin-bottom: 6px;
        }
        /* NS-Header (Soll Q2uZD: height 42, padding [0,12], gap 8, fill #E4E4E7). */
        .ns-header {
            display: flex;
            align-items: center;
            gap: 8px;
            height: 42px;
            padding: 0 12px;
            background: var(--bg-4);
            cursor: pointer;
            user-select: none;
        }
        .ns-header:hover { background: #2b313b; }
        .ns-chevron {
            font-size: 10px;
            color: var(--text-2);
            flex-shrink: 0;
            width: 12px;
            text-align: center;
        }
        .ns-folder { font-size: 13px; line-height: 1; flex-shrink: 0; }
        /* Name (aDMo1): 13px / 700. */
        .ns-name {
            font-size: 13px;
            font-weight: 700;
            color: var(--text-1);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 0 1 auto;
            min-width: 0;
        }
        .ns-spacer { flex: 1 1 auto; }
        /* Memo-Count-Chip (xQI4m/bQZG5: radius 8, padding [1,8], 9px/600). */
        .ns-count {
            font-size: 9px;
            font-weight: 600;
            color: var(--text-muted);
            background: var(--bg-2);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1px 8px;
            white-space: nowrap;
            flex-shrink: 0;
        }
        /* NS-Body (Soll ZUXs3: padding [6,8,8,8], gap 6). */
        .ns-body {
            padding: 6px 8px 8px 8px;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        /* ---- Revisions-Mini-Widget (Soll 7RCLz active / yesxz inactive). ---- */
        /* One ROW: height 38, radius 7, gap 8, padding [0,10]; 1-zeilig vertikal zentriert.
           Scoped under #doc-sidebar li to beat the generic li[data-doc] radius:4px (ID-Spez.). */
        #doc-sidebar li.rev-mini {
            position: relative;
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 38px;
            box-sizing: border-box;
            border-radius: 7px;
            padding: 0 10px;
            cursor: pointer;
            background: var(--bg-1);
            border: 1px solid var(--border);
        }
        /* Hover-Highlight (Soll wa1Qa: fill #ECECF0, stroke #52525B/1.5). */
        #doc-sidebar li.rev-mini:hover {
            background: var(--hover-bg);
            border-color: var(--text-muted);
        }
        /* Aktive Revision (Soll 7RCLz: fill #EAEAEC, stroke #18181B/1.5). */
        #doc-sidebar li.rev-mini.rev-mini-active {
            background: var(--bg-4);
            border: 1.5px solid var(--text-2);
        }
        /* PRD-005 (Memo 022 Kap 9): REV-NN PROMINENT + vorne — der primaere Identifikator.
           Visuelle Tokens aus Pencil v4 (REV-NN ~12-13px/600 #18181B). Transcript-Kopplung
           ueber Akzentfarbe (kein separates Doc-Icon mehr). */
        .rev-mini-num {
            font-size: 12px;
            font-weight: 600;
            color: var(--text-1);
            white-space: nowrap;
            flex-shrink: 0;
        }
        .rev-mini.rev-mini-active .rev-mini-num { font-weight: 700; }
        /* Eigene Transcript-Revision -> Akzent-Ton auf der prominenten REV-NN. */
        .rev-mini-num-transcript { color: var(--link-bright); }
        /* PRD-005: Datum sekundaer (lesbar, gedaempft) — Pencil v4 ~10-11px #71717A. */
        .rev-mini-date {
            font-size: 10px;
            font-weight: 500;
            color: var(--text-muted);
            white-space: nowrap;
            flex-shrink: 0;
        }
        .rev-mini-spacer { flex: 1 1 auto; }
        /* PRD-005: Minuten-Chip — die Leitkennzahl (mic-Symbol + "N Min"). Pencil v4 Tokens:
           radius 5, padding [1,6], fontSize 9-11/700, heller Chip #EFEFF1 / Text #3F3F46. */
        .rev-mini-minutes {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 10px;
            font-weight: 700;
            color: var(--text-2);
            background: var(--bg-3);
            border-radius: 5px;
            padding: 1px 6px;
            white-space: nowrap;
            flex-shrink: 0;
        }
        .rev-mini-mic { font-size: 9px; line-height: 1; }
        .rev-mini.rev-mini-active .rev-mini-minutes { color: var(--text-1); background: var(--bg-4); }
        /* PRD-005: dezentes Status-Symbol (offen = offener Punkt, abgeschlossen = gefuellt). */
        .rev-mini-status {
            font-size: 9px;
            line-height: 1;
            color: var(--text-muted);
            flex-shrink: 0;
        }
        .rev-mini-status.rev-mini-status-done { color: var(--accent-bright); }
        .rev-mini-note { font-size: 9px; color: var(--text-muted-2); flex-shrink: 0; }
        /* Fragen-Chip (Soll 0DuFe: radius 5, padding [1,6], stroke). Box-Abstand zum "?"
           vergroessert (PRD-006 Kap 6.4 / AC-10): gap 5px zwischen "?" und Zahl. */
        .rev-mini-chip {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 9px;
            font-weight: 600;
            color: var(--text-2);
            background: var(--bg-1);
            border: 1px solid var(--border);
            border-radius: 5px;
            padding: 1px 6px;
            flex-shrink: 0;
        }
        .rev-mini-chip-q { font-weight: 700; color: var(--text-muted); }
        /* PRD-006 (Memo 022 Kap 7): die funktionslosen Hover-Action-Icons (copy/open/trash) und
           die zugehoerige Chip-Hide-Regel wurden entfernt — der Fragen-Chip bleibt bei Hover
           sichtbar (kein Verstecken mehr fuer Platz, der nicht mehr gebraucht wird). */
        /* Legacy-Revision (PRD-007 AC-4): im Baum gegrayt, nie in der Queue. */
        .rev-mini.rev-legacy-muted { opacity: 0.45; }
        .rev-mini.rev-legacy-muted .rev-mini-date,
        .rev-mini.rev-legacy-muted .rev-mini-num { color: var(--text-muted-2); font-style: italic; }

        /* ---- finalisiert-Badge auf dem collapsed Memo-Header (Soll BVf3c). ---- */
        .mh-final-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            white-space: nowrap;
            flex-shrink: 0;
            font-size: 9px;
            font-weight: 700;
            border-radius: 6px;
            padding: 2px 8px;
            margin-left: 6px;
            color: var(--bg-1);
            background: var(--accent-bright);
        }

        /* ---- Queue-Item-Container (Soll RdoSV/EHlQV: height 62, radius 8, linker Balken 4px). ---- */
        #doc-sidebar li.queue-card {
            position: relative;
            display: flex;
            align-items: stretch;
            min-height: 62px;
            box-sizing: border-box;
            border-radius: 8px;
            border: 1px solid var(--border);
            background: var(--bg-1);
            overflow: hidden;
            cursor: pointer;
            padding: 0;
        }
        #doc-sidebar li.queue-card:hover { background: var(--hover-bg); }
        .queue-card-bar { width: 4px; flex-shrink: 0; background: var(--accent); }
        /* Info-Spalte (EHlQV: justifyContent center, gap 2, padding [8,10]). */
        .queue-card-info {
            display: flex;
            flex-direction: column;
            justify-content: center;
            gap: 2px;
            padding: 8px 10px;
            min-width: 0;
            flex: 1 1 auto;
        }
        .queue-card-row1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .queue-card-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--text-1);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 0 1 auto;
            min-width: 0;
        }
        .queue-card-spacer { flex: 1 1 auto; }
        /* Fragen-Chip (U6VCv: radius 5, padding [0,5], stroke). Box-Abstand zum "?" vergroessert. */
        .queue-card-chip {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 9px;
            font-weight: 600;
            color: var(--text-2);
            background: var(--bg-1);
            border: 1px solid var(--border);
            border-radius: 5px;
            padding: 0 5px;
            flex-shrink: 0;
        }
        .queue-card-chip-q { font-weight: 700; color: var(--text-muted); }
        /* PRD-006 (Memo 024 Kap 5): Minuten-Chip der Queue-Card (gleiche Formsprache wie .mh-minutes
           in der Sidebar). Sitzt zwischen Spacer und Fragen-Chip in Zeile 1. */
        .queue-card-minutes {
            display: inline-flex;
            align-items: center;
            white-space: nowrap;
            flex-shrink: 0;
            font-size: 9px;
            font-weight: 600;
            color: var(--text-muted);
            margin-right: 6px;
        }
        /* Zeile 2 (8qi4f: "REV-NN · offen" 10px). */
        .queue-card-row2 { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
        /* PRD-006 (Memo 024 Kap 5): Lifecycle-Status-Label (PRD-004 Modell) hinter der REV-Zeile. */
        .queue-card-lifecycle { margin-left: 6px; font-weight: 600; color: var(--text-2); }
        /* Zeile 3 (Z36pN: folder + Namespace + · Datum, 9px). */
        .queue-card-row3 { display: flex; align-items: center; gap: 6px; font-size: 9px; color: var(--text-muted-2); }
        .queue-card-folder { font-size: 10px; line-height: 1; flex-shrink: 0; }
        .queue-card-ns { font-weight: 600; flex-shrink: 0; }
        .queue-card-date { flex-shrink: 0; }

        /* PRD-002 (Memo 018 Kap 5): queue entries reuse the namespace revision-line markup
           (.rev-entry, rendered by renderRevEntry). The former .queue-entry/.qe-name/.qe-ns
           styles were removed — the queue now shares the .rev-entry styling. */

        /* Plans-View content */
        .plan-block {
            display: flex;
            flex-direction: column;
            gap: 14px;
            margin-bottom: 32px;
        }

        .plan-title {
            color: var(--text-1);
            font-size: 20px;
            font-weight: 700;
            border: 0;
            padding: 0;
            margin: 0;
        }

        /* Plan-URL row */
        .plan-url-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .plan-url-box {
            flex: 1 1 auto;
            background: var(--bg-4);
            border-radius: 6px;
            padding: 6px 10px;
            font-size: 12px;
            color: var(--text-2);
            font-family: var(--font-mono);
            word-break: break-all;
        }

        .plan-copy-btn {
            background: var(--bg-2);
            border: 1px solid var(--border);
            color: var(--text-1);
            cursor: pointer;
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 13px;
            font-family: inherit;
            white-space: nowrap;
            flex-shrink: 0;
        }

        .plan-copy-btn:hover { border-color: var(--text-muted); }

        .plan-section-label {
            color: var(--text-muted);
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.4px;
        }

        .memo-tiles {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .memo-tile {
            background: var(--bg-2);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 14px;
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 12px;
        }

        .memo-tile .tile-left {
            display: flex;
            flex-direction: column;
            gap: 3px;
            flex: 1 1 auto;
            min-width: 0;
        }

        .memo-tile .tile-name {
            color: var(--text-1);
            font-weight: 700;
            font-size: 13px;
        }

        .memo-tile .tile-subtitle {
            color: var(--text-muted);
            font-size: 11px;
        }

        .memo-tile .tile-right {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 5px;
            flex-shrink: 0;
        }

        .memo-tile .tile-ns-badge {
            color: var(--text-2);
            background: var(--bg-4);
            border-radius: 10px;
            padding: 2px 8px;
            font-size: 10px;
            font-weight: 600;
            white-space: nowrap;
        }

        .memo-tile .tile-status {
            color: var(--text-muted);
            font-size: 10px;
            white-space: nowrap;
        }

        table.trace-table {
            display: table;
            width: 100%;
            border-collapse: collapse;
            border: 1px solid var(--border);
            border-radius: 8px;
            overflow: hidden;
            margin: 0;
        }

        table.trace-table th,
        table.trace-table td {
            border: 0;
            border-bottom: 1px solid var(--bg-4);
        }

        table.trace-table thead th {
            background: var(--bg-4);
            color: var(--text-muted);
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            text-align: left;
            padding: 8px 12px;
        }

        table.trace-table thead th.tcol-fix {
            text-align: center;
            width: 50px;
        }

        table.trace-table thead th.tcol-commit {
            text-align: center;
            width: 84px;
        }

        table.trace-table tbody td {
            padding: 7px 12px;
            font-size: 11px;
            vertical-align: middle;
            text-align: center;
        }

        table.trace-table tbody td.tcell-strang {
            text-align: left;
            color: var(--text-2);
        }

        table.trace-table tbody tr.row-future {
            opacity: 0.55;
        }

        .trace-sym-done { color: var(--text-1); }
        .trace-sym-progress { color: var(--link); }
        .trace-sym-pending { color: var(--text-muted-2); }

        .trace-commit {
            color: var(--text-muted);
            font-family: var(--font-mono);
            font-size: 10px;
        }

        .trace-commit-empty {
            color: var(--text-muted-2);
        }

        /* Plan-Popup — memo checkbox rows */
        .plan-memo-list {
            max-height: 260px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .plan-ns-group {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .plan-ns-group > .plan-ns-title {
            color: var(--text-muted);
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            padding: 2px 0;
        }

        .plan-memo-option {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            border-radius: 6px;
            border: 1px solid var(--border);
            background: var(--bg-2);
            cursor: pointer;
            font-size: 13px;
            color: var(--text-1);
        }

        .plan-memo-option:hover {
            border-color: var(--text-muted);
        }

        .plan-memo-option .pm-box {
            font-size: 14px;
            flex-shrink: 0;
            color: var(--text-muted);
        }

        .plan-memo-option.selected {
            border-color: var(--link-bright);
        }

        .plan-memo-option.selected .pm-box {
            color: var(--link-bright);
        }

        .plan-memo-option .pm-status {
            color: var(--text-muted);
            font-size: 11px;
        }

        /* Non-finalized: greyed out, not selectable */
        .plan-memo-option.not-final {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .plan-memo-option.not-final:hover {
            border-color: var(--border);
        }

        .plan-empty {
            color: var(--text-muted);
            font-size: 12px;
            padding: 8px;
        }

        /* Transcript indicator: dezentes Wort/Icon, KEIN farbiger Punkt (PRD-007 F14=A) */
        .transcript-indicator {
            margin-left: 6px;
            cursor: pointer;
            opacity: 0.85;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.3px;
            color: var(--text-muted-2);
            flex-shrink: 0;
        }

        .transcript-indicator:hover {
            opacity: 1;
            color: var(--text-2);
        }

        .transcript-indicator:empty {
            display: none;
        }


        .t-modal {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: var(--shadow);
            z-index: 2000;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .t-hidden { display: none !important; }

        .t-modal-content {
            background: var(--bg-2);
            color: var(--text-1);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 0;
            width: 720px;
            max-width: 90vw;
            max-height: 90vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        /* Popup header bar (bg var(--bg-4), emoji title allowed here) */
        .t-modal-header {
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--bg-4);
            border-bottom: 1px solid var(--border);
            padding: 14px 18px;
            flex-shrink: 0;
        }

        .t-modal-header .t-title {
            color: var(--text-1);
            font-size: 15px;
            font-weight: 700;
        }

        .t-modal-header .t-header-spacer { flex: 1 1 auto; }

        .t-modal-header .t-close {
            background: none;
            border: none;
            color: var(--text-muted);
            font-size: 16px;
            cursor: pointer;
            padding: 0 4px;
            line-height: 1;
        }

        .t-modal-header .t-close:hover { color: var(--text-1); }

        .t-modal-body {
            padding: 18px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            overflow-y: auto;
        }

        .t-hint {
            font-size: 10px;
            color: var(--text-muted-2);
        }

        /* Tab bar inside transcript modal (Tab 1 / Tab 2) */
        .t-tabs {
            display: flex;
            gap: 4px;
            border-bottom: 1px solid var(--border);
            margin-bottom: 4px;
        }

        .t-tab {
            background: none;
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--text-muted);
            cursor: pointer;
            padding: 8px 12px;
            font-size: 13px;
            font-family: inherit;
            font-weight: 600;
        }

        .t-tab:hover { color: var(--text-1); }

        .t-tab.active {
            color: var(--text-1);
            border-bottom-color: var(--accent);
        }

        .t-tab-panel.t-hidden { display: none !important; }

        #t2-name {
            background: var(--bg-2);
            color: var(--text-1);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 10px;
            font-family: inherit;
            font-size: 13px;
            width: 100%;
        }

        /* PRD-008 (Memo 022 Kap 6): gemeinsame Transcript-Textarea-Klasse fuer BEIDE Tabs
           ("neues Memo" #t2-content + "hinzufuegen" #ta-content). Frueher hatte nur #t2-content
           eine eigene 170px-Regel; #ta-content fiel auf den kleinen textarea-Default zurueck
           (winzig/verschoben). Jetzt tragen beide IDs dieselbe Optik/Hoehe. */
        #t2-content,
        #ta-content {
            width: 100%;
            height: 170px;
            background: var(--bg-2);
            color: var(--text-1);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 10px;
            font-family: monospace;
            font-size: 13px;
            resize: vertical;
            box-sizing: border-box;
        }

        /* PRD-008 (Memo 022 Kap 6): Dark-Theme-Styling fuer alle <select> im Transcript-Modal
           (#t2-namespace, #ta-namespace, #ta-memo). Ohne diese Regel erschienen die Dropdowns im
           hellen Browser-Default. appearance:none + eigenes Caret. Konsistent zu den Inputs. */
        .t-modal-body select {
            width: 100%;
            background: var(--bg-2);
            color: var(--text-1);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 28px 8px 10px;
            font-family: inherit;
            font-size: 13px;
            box-sizing: border-box;
            cursor: pointer;
            -webkit-appearance: none;
            -moz-appearance: none;
            appearance: none;
            background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%238b949e' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
            background-repeat: no-repeat;
            background-position: right 10px center;
        }

        .t-modal-body select:focus {
            outline: none;
            border-color: var(--accent);
        }

        /* Field row — three fields side by side */
        .t-field-row {
            display: flex;
            gap: 8px;
        }

        .t-field {
            display: flex;
            flex-direction: column;
            gap: 3px;
            flex: 1 1 0;
            min-width: 0;
        }

        .t-field-label {
            font-size: 10px;
            color: var(--text-muted-2);
        }

        .t-meta input,
        .t-field input {
            background: var(--bg-2);
            color: var(--text-1);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 10px;
            font-family: inherit;
            font-size: 13px;
            width: 100%;
        }

        .t-field-label-strong {
            font-size: 11px;
            font-weight: 700;
            color: var(--text-1);
        }

        #t-content {
            width: 100%;
            height: 240px;
            background: var(--bg-2);
            color: var(--text-1);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 10px;
            font-family: monospace;
            font-size: 13px;
            resize: vertical;
        }

        .t-info {
            font-size: 12px;
            color: var(--text-muted);
        }

        .t-error {
            background: #3a1f1f;
            color: var(--danger);
            border: 1px solid var(--danger);
            border-radius: 6px;
            padding: 6px 8px;
            font-size: 12px;
        }

        /* PRD-002 (Memo 022, Kap 3): success quittance with the saved transcript URL. */
        .pp-success {
            background: #1f3a23;
            color: var(--success, #3ddc84);
            border: 1px solid var(--success, #3ddc84);
            border-radius: 6px;
            padding: 6px 8px;
            font-size: 12px;
            word-break: break-all;
        }
        .pp-success a { color: inherit; text-decoration: underline; }

        /* URL box inside popup */
        .t-url-box {
            background: var(--bg-4);
            border-radius: 6px;
            padding: 8px 10px;
            font-size: 12px;
            color: var(--text-muted);
            word-break: break-all;
        }

        .t-url-box.has-url { color: var(--text-2); }

        /* Footer actions (justify end) */
        .t-actions {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
        }

        /* PRD-007 (#44): word/minute counter pinned left of the save button. */
        .t-wordcount {
            margin-right: auto;
            font-size: 12px;
            color: var(--text-muted);
        }

        .t-btn-secondary {
            background: var(--bg-2);
            color: var(--text-1);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 16px;
            font-size: 13px;
            font-family: inherit;
            cursor: pointer;
        }

        .t-btn-secondary:hover { border-color: var(--text-muted); }

        .t-btn-primary {
            background: var(--accent);
            color: var(--text-1);
            border: 1px solid var(--accent);
            border-radius: 6px;
            padding: 8px 16px;
            font-size: 13px;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
        }

        .t-btn-primary:hover { background: var(--accent); }

        .t-btn-primary:disabled {
            background: var(--bg-4);
            border-color: var(--border);
            color: var(--text-muted-2);
            cursor: not-allowed;
        }

        .t-btn-primary:disabled:hover { background: var(--bg-4); }

        .t-footnote {
            font-size: 9px;
            color: var(--text-muted-2);
        }

        /* PRD-008 (Kap 9.5): "Prompt bearbeiten"-Popup — combined sections + footer (Frame iFrSa). */
        #t-panel-prompt { display: flex; flex-direction: column; gap: 12px; }
        .pp-section { display: flex; flex-direction: column; gap: 8px; }
        .pp-section-label {
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.4px;
            color: var(--text-muted);
            text-transform: uppercase;
        }
        .pp-field-row { display: flex; gap: 8px; }
        .pp-field-row .t-field { flex: 1 1 auto; min-width: 0; }
        #pp-content {
            width: 100%;
            min-height: 90px;
            resize: vertical;
            font-family: inherit;
            font-size: 13px;
            padding: 10px;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: var(--bg-2);
            color: var(--text-1);
            box-sizing: border-box;
        }
        .pp-tcount { font-size: 10px; font-weight: 700; color: var(--text-2); }
        .pp-questions-list { display: flex; flex-direction: column; gap: 8px; }
        .pp-question {
            display: flex;
            flex-direction: column;
            gap: 6px;
            background: var(--bg-2);
            border-radius: 8px;
            padding: 10px;
        }
        .pp-question-title { font-size: 11px; font-weight: 700; color: var(--text-1); }
        .pp-question-input {
            width: 100%;
            font-family: inherit;
            font-size: 12px;
            padding: 6px 8px;
            border: 1px solid var(--border);
            border-radius: 6px;
            background: var(--bg-1);
            color: var(--text-1);
            box-sizing: border-box;
        }
        .pp-questions-empty { font-size: 11px; color: var(--text-muted); font-style: italic; }
        .pp-footer {
            display: flex;
            align-items: center;
            gap: 10px;
            padding-top: 6px;
        }
        .pp-footer-note { flex: 1 1 auto; font-size: 10px; font-style: italic; color: var(--text-muted); }

        .t-attach-row {
            color: var(--text-muted);
            font-size: 13px;
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 10px;
            background: var(--bg-2);
        }

        .t-saved-state {
            margin-top: 4px;
        }

        .t-url {
            display: block;
            background: var(--bg-4);
            padding: 8px 10px;
            border-radius: 6px;
            word-break: break-all;
            font-size: 12px;
            margin: 8px 0;
            color: var(--text-2);
        }

        /* PRD-032: inline copy icon sits next to the URL, the <code> keeps its box. */
        .t-url-row {
            display: flex;
            align-items: flex-start;
            gap: 6px;
        }

        .t-url-row .t-url {
            flex: 1;
        }

        .t-copy-inline {
            flex: 0 0 auto;
            margin-top: 8px;
            padding: 4px 6px;
            background: transparent;
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--text-muted);
            font-size: 12px;
            line-height: 1;
            cursor: pointer;
        }

        .t-copy-inline:hover {
            color: var(--text-1);
        }

        /* PRD-031: unobtrusive hint that the URL was auto-copied on save. */
        .t-autocopy-hint {
            font-size: 11px;
            color: var(--text-muted);
            margin: 2px 0 0;
        }

        #toc-sidebar {
            position: sticky;
            top: 52px;
            width: 240px;
            min-width: 240px;
            height: calc( 100vh - 52px );
            overflow-y: auto;
            padding: 16px;
            background: var(--bg-0);
            border-left: 1px solid var(--border);
            font-size: 13px;
        }

        /* TOC label "Auf dieser Seite" */
        #toc-label {
            color: var(--text-muted-2);
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            padding: 0 8px 10px;
            margin-bottom: 4px;
        }

        #toc-sidebar ul {
            list-style: none;
            padding: 0;
            margin: 0;
        }

        /* PRD-009 #3: list ALL topics, no truncation / no "…" — long titles wrap. */
        #toc-sidebar li {
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            color: var(--text-muted);
            font-size: 12px;
            white-space: normal;
            overflow-wrap: anywhere;
            line-height: 1.35;
        }

        #toc-sidebar li:hover {
            color: var(--text-1);
        }

        #toc-sidebar li.toc-active {
            color: var(--text-1);
            font-weight: 700;
        }

        .toc-dot {
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--accent-bright);
            margin-right: 6px;
            flex-shrink: 0;
        }

        /* PRD-009 (F11): prominent, scannable "Offene Fragen" anchor in the content. */
        #content .offene-fragen-anchor {
            scroll-margin-top: 120px;
            border-left: 4px solid var(--warning);
            padding-left: 10px;
            color: var(--warning);
        }

        /* PRD-009 (Kap 19, Phase 6): Vorwort placeholder section, hidden while empty. */
        #content .vorwort-section {
            scroll-margin-top: 120px;
        }

        #content .vorwort-section.vorwort-empty:empty {
            display: none;
        }

        /* PRD-014 (Kap 19): persisted Claude-Vorwort, shown above the open questions. */
        #content .vorwort-section .vorwort-body {
            border-left: 4px solid var(--accent);
            background: var(--bg-2);
            padding: var(--sp-3) var(--sp-4);
            margin: var(--sp-4) 0;
            border-radius: 6px;
            color: var(--text-2);
        }

        #content .vorwort-section .vorwort-body > :first-child {
            margin-top: 0;
        }

        #content .vorwort-section .vorwort-body > :last-child {
            margin-bottom: 0;
        }

        /* PRD-013 (Kap 15): interactive question widgets (single + multi). */
        #question-widgets {
            margin: var(--sp-5) 0;
            display: flex;
            flex-direction: column;
            gap: var(--sp-4);
        }

        #question-widgets:empty { display: none; }

        .qw-card {
            border: 1px solid var(--border);
            border-radius: 10px;
            background: var(--bg-2);
            padding: 16px 18px;
            scroll-margin-top: 120px;
        }

        /* PRD-001 (Memo 024 Kap 1): visible parse warnings — the count-vs-render banner and the
           per-question fallback notice. Both use the shared warning colour so they read as a
           deliberate alert, never a silent gap. */
        .qw-parse-warn,
        .qw-fallback-warn {
            color: var(--warning);
            background: var(--warn-bg);
            border: 1px solid var(--warning);
            border-radius: 8px;
            padding: 8px 12px;
            font-size: 13px;
            margin-bottom: 12px;
        }

        .qw-fallback {
            border: 1px dashed var(--warning);
            border-radius: 10px;
            background: var(--bg-2);
            padding: 16px 18px;
            scroll-margin-top: 120px;
        }

        .qw-card.qw-active {
            border-color: var(--accent);
            box-shadow: 0 0 0 1px var(--accent);
        }

        .qw-card.qw-collapsed .qw-body { display: none; }

        .qw-head {
            display: flex;
            align-items: center;
            gap: var(--sp-2);
            cursor: pointer;
        }

        .qw-id {
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--text-muted);
            flex-shrink: 0;
        }

        .qw-title {
            font-weight: 600;
            color: var(--text-1);
            flex: 1 1 auto;
        }

        .qw-badge {
            font-family: var(--font-mono);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            padding: 2px 8px;
            border-radius: 10px;
            border: 1px solid var(--border);
            background: var(--bg-3);
            color: var(--text-muted);
            flex-shrink: 0;
        }

        .qw-toggle {
            font-family: var(--font-mono);
            font-size: 16px;
            font-weight: 700;
            line-height: 1;
            color: var(--text-2);
            flex-shrink: 0;
        }

        .qw-body { margin-top: var(--sp-3); }

        /* PRD-023 (Kap 11.4): Hintergrund / Frage / KI-Empfehlung are three labelled,
           visually separated blocks. Each block carries an uppercase label and a clear
           gap + subtle separator so they never read as one continuous paragraph. */
        .qw-hintergrund {
            font-size: 13px;
            color: var(--text-muted);
            margin-bottom: var(--sp-3);
            padding-bottom: var(--sp-2);
            border-bottom: 1px solid var(--border-subtle);
        }

        .qw-hintergrund-label,
        .qw-frage-label,
        .qw-ai-label {
            display: block;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.4px;
            text-transform: uppercase;
            margin-bottom: var(--sp-1);
        }

        .qw-hintergrund-label {
            color: var(--text-muted-2);
        }

        .qw-frage {
            color: var(--text-2);
            margin-bottom: var(--sp-3);
            padding-bottom: var(--sp-2);
            border-bottom: 1px solid var(--border-subtle);
        }

        .qw-frage-label {
            color: var(--text-muted-2);
        }

        .qw-frage-text {
            display: block;
            color: var(--text-1);
        }

        .qw-options {
            display: flex;
            flex-direction: column;
            gap: var(--sp-1);
            max-height: 260px;
            overflow-y: auto;
            padding-right: var(--sp-1);
        }

        .qw-option {
            display: flex;
            align-items: flex-start;
            gap: var(--sp-2);
            padding: var(--sp-2);
            border: 1px solid transparent;
            border-radius: 6px;
            cursor: pointer;
            color: var(--text-2);
        }

        .qw-option:hover { background: var(--bg-3); }

        .qw-option.qw-focus {
            border-color: var(--accent);
            background: var(--bg-3);
        }

        .qw-option.qw-ai {
            color: var(--text-muted);
        }

        .qw-option.qw-selected {
            color: var(--text-1);
            border-color: var(--border-subtle);
            background: var(--bg-3);
        }

        .qw-marker {
            font-family: var(--font-mono);
            flex-shrink: 0;
            width: 1.4em;
            text-align: center;
            color: var(--text-muted);
        }

        .qw-option.qw-selected .qw-marker { color: var(--accent); }

        .qw-option-key {
            font-family: var(--font-mono);
            color: var(--text-muted);
            flex-shrink: 0;
        }

        .qw-ai-hint {
            font-size: 12px;
            color: var(--text-muted);
            font-style: italic;
        }

        .qw-ai-line {
            margin-top: var(--sp-3);
            padding-top: var(--sp-2);
            border-top: 1px solid var(--border-subtle);
            color: var(--accent-bright);
            font-size: 12px;
        }

        .qw-ai-label {
            color: var(--accent);
        }

        .qw-ai-text {
            display: block;
            color: var(--accent-bright);
        }

        .qw-custom-row {
            display: flex;
            gap: var(--sp-2);
            margin-top: var(--sp-2);
        }

        .qw-custom-input {
            flex: 1 1 auto;
            background: var(--bg-1);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text-1);
            padding: var(--sp-2);
            font-family: var(--font-sans);
            font-size: 13px;
        }

        .qw-custom-input:focus {
            outline: none;
            border-color: var(--accent);
        }

        .qw-footer {
            display: flex;
            align-items: center;
            gap: var(--sp-3);
            margin-top: var(--sp-3);
        }

        .qw-add-btn {
            background: var(--accent);
            color: var(--text-on-accent);
            border: none;
            border-radius: 6px;
            padding: 10px 20px;
            font-family: var(--font-sans);
            font-size: 14px;
            font-weight: 700;
            cursor: pointer;
        }

        .qw-add-btn:hover { background: var(--accent-bright); }

        /* PRD-026 (Kap 12.1): visible "hinzugefügt" quittance after machine injection.
           Distinct from the active state so the user sees the answer was accepted. */
        .qw-add-btn--done {
            background: var(--ok, #2e7d32);
            cursor: default;
        }

        .qw-add-btn--done:hover { background: var(--ok, #2e7d32); }

        .qw-secondary-btn {
            background: transparent;
            color: var(--text-muted);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: var(--sp-2) var(--sp-3);
            font-family: var(--font-sans);
            font-size: 13px;
            cursor: pointer;
        }

        .qw-secondary-btn:hover {
            color: var(--text-1);
            border-color: var(--border-subtle);
        }

        .qw-note {
            font-size: 12px;
            color: var(--text-muted);
        }

        /* PRD-008 (Memo 024 Kap 7): the answers-only bar lives in Sticky-Header Zone 2. It is a
           horizontal action row consistent with the Zone-2 prompt-statuszeile spacing. The bar
           sits below the existing two Zone-2 rows, separated by a thin divider so the actions read
           as a distinct interaction block. The Zone-2 fill (var(--bg-2)) + top-divider already come
           from .hdr-zone-2; the bar only adds its own internal layout. */
        .qw-answers-only-bar {
            display: flex;
            align-items: center;
            gap: var(--sp-3);
            flex-wrap: wrap;
        }

        .qw-answers-only-bar.qw-answers-only-bar--header {
            margin-top: 9px;
            padding-top: 9px;
            border-top: 1px solid var(--border);
        }

        /* PRD-008 (AC-05): primary action = "Fertig" (accent), secondary = "ohne Transcript
           speichern" (outline). Both stay legible against the Zone-2 fill. */
        .qw-primary-btn {
            background: var(--accent);
            color: var(--text-on-accent);
            border: 1px solid var(--accent);
            border-radius: 6px;
            padding: var(--sp-2) var(--sp-3);
            font-family: var(--font-sans);
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
        }

        .qw-primary-btn:hover { background: var(--accent-bright); border-color: var(--accent-bright); }

        /* PRD-006 (Kap 9, AC-05): the reversible "Fertig ✓" done-state reads visibly different. */
        .qw-answers-only-bar.qw-fertig-done .qw-primary-btn {
            background: var(--ok, #2e7d32);
            border-color: var(--ok, #2e7d32);
        }

        .qw-answers-only-bar .qw-secondary-btn:disabled {
            opacity: 0.5;
            cursor: default;
        }

        .qw-answers-only-status {
            font-size: 12px;
            color: var(--text-2);
            white-space: nowrap;
        }

        .qw-topics {
            display: flex;
            flex-wrap: wrap;
            gap: var(--sp-1);
            margin-top: var(--sp-2);
        }

        .qw-topic-link {
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--link);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 1px 8px;
            cursor: pointer;
        }

        .qw-topic-link.qw-focus {
            border-color: var(--accent);
            color: var(--link-bright);
        }

        /* PRD-025 (Kap 11.6): a topic chip with no jump target shows no link cursor and
           reads as inert — cursor must match actual jumpability. */
        .qw-topic-link.qw-topic-dead {
            cursor: default;
            color: var(--text-muted);
        }

        @media ( max-width: 1100px ) {
            #toc-sidebar { display: none; }
        }

        @media ( max-width: 900px ) {
            #doc-sidebar { display: none; }
            #layout { display: block; }
        }

        .mermaid-error {
            color: var(--danger);
            border: 1px solid var(--danger);
            border-radius: 6px;
            padding: 12px;
            font-family: var(--font-mono);
            font-size: 13px;
            white-space: pre-wrap;
            text-align: left;
            background: #1a0d0d;
        }

        /* PRD-010: original mermaid source shown below the error when render fails. */
        .mermaid-error-source {
            border: 1px solid var(--border, #333);
            border-top: none;
            border-radius: 0 0 6px 6px;
            margin: -6px 0 0;
            padding: 12px;
            font-family: var(--font-mono);
            font-size: 12px;
            white-space: pre-wrap;
            text-align: left;
            overflow-x: auto;
            background: #0d0d12;
            color: var(--text, #ddd);
        }

        table {
            border-spacing: 0;
            border-collapse: collapse;
            margin-top: 0;
            margin-bottom: 16px;
            display: block;
            width: max-content;
            max-width: 100%;
            overflow: auto;
        }

        th, td {
            border: 1px solid var(--border);
            padding: 6px 13px;
        }

        th {
            font-weight: 600;
            background: transparent;
        }

        tr { background: var(--bg-1); border-top: 1px solid var(--bg-4); }
        tr:nth-child(2n) { background: var(--bg-2); }

        ul, ol {
            margin-top: 0;
            margin-bottom: 16px;
            padding-left: 2em;
        }

        li { margin-top: 0.25em; }

        li + li { margin-top: 0.25em; }

        ul ul, ul ol, ol ul, ol ol {
            margin-top: 0;
            margin-bottom: 0;
        }

        hr {
            height: 0.25em;
            padding: 0;
            margin: 24px 0;
            background-color: var(--border);
            border: 0;
        }

        img { max-width: 100%; border-radius: 6px; }

        .mermaid {
            background: var(--text-on-accent);
            border-radius: 6px;
            padding: 16px;
            margin: 0 0 16px 0;
            text-align: center;
            cursor: zoom-in;
            transition: opacity 0.15s;
        }

        .mermaid:hover { opacity: 0.85; }

        #mermaid-modal {
            display: none;
            position: fixed;
            inset: 0;
            z-index: 9999;
            background: var(--overlay);
            align-items: center;
            justify-content: center;
            cursor: zoom-out;
        }

        #mermaid-modal.open { display: flex; }

        #mermaid-modal-inner {
            background: var(--text-on-accent);
            border-radius: 10px;
            padding: 40px 32px 32px;
            width: 92vw;
            height: 88vh;
            overflow: auto;
            cursor: default;
            position: relative;
            box-shadow: 0 24px 64px var(--shadow);
            display: flex;
            align-items: center;
            justify-content: center;
        }

        #mermaid-modal-svg {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        #mermaid-modal-inner svg {
            width: 100%;
            height: 100%;
            display: block;
        }

        #mermaid-modal-close {
            position: absolute;
            top: 10px;
            right: 12px;
            background: none;
            border: none;
            font-size: 22px;
            line-height: 1;
            color: var(--text-muted-2);
            cursor: pointer;
            padding: 2px 6px;
            border-radius: 4px;
        }

        #mermaid-modal-close:hover { background: #d0d7de; color: #24292f; }

        input[type="checkbox"] {
            margin: 0 0.35em 0.25em -1.4em;
            vertical-align: middle;
        }

        .task-list-item { list-style-type: none; }
    </style>
</head>
<body>
    <div id="mermaid-modal" onclick="closeMermaidModal()">
        <div id="mermaid-modal-inner" onclick="event.stopPropagation()">
            <button id="mermaid-modal-close" onclick="closeMermaidModal()" title="Schliessen (Esc)">&times;</button>
            <div id="mermaid-modal-svg"></div>
        </div>
    </div>
    <div id="nav-bar">
        <span id="nav-brand">Memo SOP</span>
        <div id="mode-toggle">
            <button id="mode-transcripts" class="mode-toggle">Transcripts</button>
            <button id="mode-memos" class="mode-toggle active">Memos</button>
            <button id="mode-plans" class="mode-toggle">Plans</button>
        </div>
        <span id="nav-spacer"></span>
        <button id="transcript-new" class="nav-btn-secondary" title="Transcript hinzufügen oder neues Memo bootstrappen">Transcript</button>
        <button id="nav-unlink" class="nav-btn-secondary" title="Memo entkoppeln">Unlink</button>
        <div id="status" title="Server-Verbindung"></div>
    </div>
    <div id="transcript-modal" class="t-modal t-hidden">
        <div class="t-modal-content">
            <div class="t-modal-header">
                <span class="t-title">Transcript hinzufügen</span>
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
    <div id="plan-modal" class="t-modal t-hidden">
        <div class="t-modal-content">
            <div class="t-modal-header">
                <span class="t-title">🗂 Neuer Plan</span>
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
    <div id="layout">
        <nav id="doc-sidebar">
            <div id="doc-sidebar-body"></div>
        </nav>
        <div id="main">
            <div id="main-header"></div>
            <div id="content"><p style="color:#888">Waiting for content...</p></div>
        </div>
        <nav id="toc-sidebar">
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
    <script>
        mermaid.initialize({
            startOnLoad: false,
            theme: 'default',
            securityLevel: 'loose'
        })

        const renderer = new marked.Renderer()
        const originalCodeRenderer = renderer.code.bind( renderer )
        const slugCounts = new Map()

        function slugify( text ) {
            return text
                .toLowerCase()
                .replace( /ä/g, 'ae' )
                .replace( /ö/g, 'oe' )
                .replace( /ü/g, 'ue' )
                .replace( /ß/g, 'ss' )
                .replace( /[^a-z0-9\\s-]/g, '' )
                .trim()
                .replace( /\\s+/g, '-' )
                .replace( /-+/g, '-' )
                .replace( /^-+|-+$/g, '' )
        }

        renderer.code = function( token ) {
            if( token.lang === 'mermaid' ) {
                return '<div class="mermaid">' + token.text + '</div>'
            }

            return originalCodeRenderer( token )
        }

        renderer.heading = function( token ) {
            var text = token.text
            var level = token.depth
            var inner
            try {
                inner = this.parser && this.parser.parseInline ? this.parser.parseInline( token.tokens ) : marked.parseInline( text )
            } catch( e ) {
                inner = text
            }
            if( level === 2 || level === 3 ) {
                var slug = slugify( text )
                var count = slugCounts.get( slug ) || 0
                slugCounts.set( slug, count + 1 )
                var finalSlug = count === 0 ? slug : slug + '-' + count
                return '<h' + level + ' id="' + finalSlug + '">' + inner + '</h' + level + '>\\n'
            }
            return '<h' + level + '>' + inner + '</h' + level + '>\\n'
        }

        marked.setOptions( { renderer } )

        const contentEl = document.getElementById( 'content' )
        const statusEl = document.getElementById( 'status' )

        let reconnectTimer = null
        let currentWs = null
        const history = []
        let currentDiff = null
        let showDiff = true
        let lastContent = ''
        let lastQuestionSchema = []
        let lastVorwort = ''
        let isFirstLoad = true
        // PRD-009 (Memo 024 Kap 7, F5=A): the last seen queue-key snapshot drives the Audio-Notify
        // diff. null = no snapshot yet (initial load) — the first renderSidebar only seeds it and
        // never plays a ton (no-spam-on-startup, AC-04). Keys are documentId::fileName strings.
        let lastQueueKeys = null
        // PRD-009: a single shared AudioContext, lazily created and only after the first user
        // gesture so a blocked context never throws (autoplay policy, AC-06).
        let notifyAudioCtx = null
        let currentFileName = ''
        let currentMemoName = ''
        let reconnectAttempts = 0
        const collapsedProjects = new Set()
        const collapsedMemos = new Set()
        // PRD-016 (Memo 016 Kap 6.1): namespaces default to COLLAPSED. We track which
        // namespaces have already been seeded into collapsedProjects so a later re-render
        // never re-collapses a group the user has manually expanded.
        const seededCollapseProjects = new Set()
        // PRD-006 (Memo 019 Kap 6.6): memos ALSO default to COLLAPSED on first open. Mirror the
        // namespace seed-once guard so a memo a user manually expanded is never re-collapsed.
        const seededCollapseMemos = new Set()
        let currentMode = 'memos'
        let lastTree = {}
        let lastLatest = []
        let lastPlans = []
        let lastOpenMemos = []
        let lastTranscriptTree = {}
        let pendingQuestionsScroll = false

        function updateConnectionStatus( state ) {
            if( state === 'connected' ) {
                statusEl.classList.add( 'connected' )
                statusEl.title = 'Server verbunden'
                reconnectAttempts = 0
            } else {
                statusEl.classList.remove( 'connected' )
                statusEl.title = 'Offline — Server nicht erreichbar'
            }
        }

        window.selectRevision = function( documentId, fileName ) {
            if( currentWs && currentWs.readyState === 1 ) {
                currentWs.send( JSON.stringify( { 'type': 'selectRevision', 'documentId': documentId, 'fileName': fileName } ) )
            }
        }

        window.selectPlanPhase = function( planFolder, phaseId ) {
            if( currentWs && currentWs.readyState === 1 ) {
                currentWs.send( JSON.stringify( { 'type': 'selectPlanPhase', 'planFolder': planFolder, 'phaseId': phaseId } ) )
            }
        }

        function badgeClassFor( memoStatus ) {
            if( memoStatus === 'Finalisiert' ) { return 'badge-final' }
            if( memoStatus === 'Bedingt finalisiert' ) { return 'badge-conditional' }
            return 'badge-draft'
        }

        function escapeAttr( value ) {
            return String( value == null ? '' : value )
                .replace( /&/g, '&amp;' )
                .replace( /"/g, '&quot;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
        }

        function revTypeLabel( revisionType ) {
            if( revisionType === 'update' ) { return 'Update' }
            if( revisionType === 'prepare' ) { return 'Prepare' }
            return 'Full'
        }

        // PRD-003: single normalization path for question counts (sidebar + sticky read
        // the same numbers, no divergent "0 offen" fallback on differing data).
        function normalizeQuestions( questions ) {
            var q = questions || { open: 0, answered: 0 }
            return { open: q.open || 0, answered: q.answered || 0 }
        }

        function questionsLabel( questions ) {
            var q = normalizeQuestions( questions )
            return q.answered + ' beantwortet · ' + q.open + ' offen'
        }

        // PRD-015 + PRD-016: sticky header showing memo name + current revision + read-only status badge.
        function lookupMemoStatus( memoName ) {
            var found = null
            Object.keys( lastTree || {} ).forEach( function( projectId ) {
                var node = lastTree[ projectId ]
                var memos = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                memos.forEach( function( m ) {
                    if( !found && m.memoName === memoName ) { found = m.memoStatus || 'Entwurf' }
                } )
            } )
            return found
        }

        // PRD-013: look up { projectId, doc } for a memoName from the memos tree. Needed for
        // the sticky-header button to read doc.revisions (Soll-Nummern-Logik) + projectId.
        function lookupMemoEntry( memoName ) {
            var found = null
            Object.keys( lastTree || {} ).forEach( function( projectId ) {
                var node = lastTree[ projectId ]
                var memos = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                memos.forEach( function( m ) {
                    if( !found && m.memoName === memoName ) { found = { projectId: projectId, doc: m } }
                } )
            } )
            return found
        }

        // PRD-013 (Memo 016 Kap 3) Soll-Nummern-Logik: next = (highest existing REV)+1,
        // previous = highest existing REV. NEVER derived from the viewed revision suffix
        // (that is the reproduced "Revision 2 betrachtet -> 'fuer Revision 3'" bug). Mirrors
        // the testable MemoView.nextRevisionNumbers static method.
        function nextRevisionNumbers( revisions ) {
            var numbers = ( revisions || [] )
                .map( function( rev ) {
                    var m = ( rev && rev.fileName ) ? String( rev.fileName ).match( /REV-(\\d+)/ ) : null
                    return m ? parseInt( m[ 1 ], 10 ) : null
                } )
                .filter( function( n ) { return n !== null } )
            var previous = numbers.length === 0 ? 0 : Math.max.apply( null, numbers )
            var next = previous + 1
            function pad( n ) { return String( n ).padStart( 2, '0' ) }
            return { previous: previous, next: next, previousId: 'REV-' + pad( previous ), nextId: 'REV-' + pad( next ) }
        }

        // PRD-010 (Memo 024 Kap 8): inline 1:1 mirror of MemoView.buildMermaidErrorHtml.
        // On a mermaid render failure the viewer shows the error message PLUS the
        // unchanged original source as an HTML-escaped <pre> block, so a broken
        // diagram degrades to readable text instead of a bare error / empty bomb.
        function buildMermaidErrorHtml( err, originalText ) {
            var message = ( err && err.message ) ? err.message : String( err == null ? '' : err )
            var safeMessage = String( message )
                .replace( /&/g, '&amp;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
            var safeOriginal = String( originalText == null ? '' : originalText )
                .replace( /&/g, '&amp;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
            return '<div class="mermaid-error">Mermaid Error: ' + safeMessage
                + '</div><pre class="mermaid-error-source">' + safeOriginal + '</pre>'
        }

        // PRD-001 (Memo 018 Kap 4, F7=A): the 3-state ball status is now DERIVED from the
        // revision-level revisionStatus (the single source of truth) plus memoFinalized.
        // Mapping: offen -> Wartet auf User-Feedback; transcript-eingetragen -> Transcript
        // hinterlegt; eingeloggt (+ finalisiert) -> Finalisiert (Locked). Mirrors the testable
        // MemoView.deriveBallStatus static method.
        function deriveBallStatus( revisionStatus, memoFinalized ) {
            if( revisionStatus === 'eingeloggt' && memoFinalized === true ) {
                return 'Finalisiert (Locked)'
            }
            if( revisionStatus === 'transcript-eingetragen' ) { return 'Transcript hinterlegt' }
            return 'Wartet auf User-Feedback'
        }

        // PRD-010 #2: each of the 3 states maps to a unique ball position/class.
        function ballPositionFor( ballStatus ) {
            if( ballStatus === 'Finalisiert (Locked)' ) { return 'ball-locked' }
            if( ballStatus === 'Transcript hinterlegt' ) { return 'ball-transcript' }
            return 'ball-feedback'
        }

        // PRD-011 (Memo 016 Kap 5): lose vs. explizit-Revision Zuordnung.
        // These mirror the testable MemoView.transcriptsForMemo / transcriptsForRevision
        // static methods. transcriptsForMemo = lose (memo-weit, aggregate); the per-revision
        // variant filters on entry.revisionId. The frontend transcript tree carries a
        // revisionId per entry (TranscriptRegistry.getTranscriptTree), so the per-revision
        // resolution needs no data-model change.
        function transcriptsForMemo( memoName ) {
            var tree = lastTranscriptTree || {}
            var collected = []
            Object.keys( tree ).forEach( function( projectId ) {
                var memos = tree[ projectId ] || {}
                var list = memos[ memoName ] || []
                list.forEach( function( entry ) { collected.push( entry ) } )
            } )
            return collected
        }

        function transcriptsForRevision( memoName, revisionId ) {
            return transcriptsForMemo( memoName ).filter( function( entry ) {
                return entry && entry.revisionId === revisionId
            } )
        }

        // Aggregate (lose) presence — the memo as a whole has at least one transcript.
        // Used ONLY for memo-weite aggregate displays, never to decide a single revision's pill.
        function hasTranscriptForMemo( memoName ) {
            return transcriptsForMemo( memoName ).length > 0
        }

        // Per-revision presence — the FIX for the REV-03 badge bug. A revision without its
        // own transcript must not show the "Transcript hinterlegt" badge.
        function hasTranscriptForRevision( memoName, revisionId ) {
            if( !revisionId ) { return false }
            return transcriptsForRevision( memoName, revisionId ).length > 0
        }

        // PRD-001 (Memo 019 Kap 1): aggregate the spoken minutes of ALL transcripts of a memo.
        // Mirrors MemoView.aggregateMemoMinutes / TranscriptRegistry.aggregateMemoMinutes — sums
        // the per-transcript word counts (the 'words' field in the transcript tree) and converts
        // at ~200 Woerter/Min. 0 transcripts -> 0 Min (no invented default, no date fallback).
        function aggregateMemoMinutes( memoName ) {
            var words = transcriptsForMemo( memoName )
                .map( function( entry ) { return ( entry && typeof entry.words === 'number' && entry.words > 0 ) ? entry.words : 0 } )
                .reduce( function( sum, value ) { return sum + value }, 0 )
            return words === 0 ? 0 : Math.ceil( words / 200 )
        }

        // PRD-005 (Memo 022 Kap 9): per-revision spoken minutes — the rev-mini Leitkennzahl.
        // Sums the word counts of the transcripts that belong to THIS revision (own transcript
        // first, deterministic). No own transcript -> 0 Min (kein erfundener Default, das
        // Memo-Aggregat wird NICHT als Revisions-Wert vorgetaeuscht). ~200 Woerter/Min.
        function aggregateRevisionMinutes( memoName, revisionId ) {
            if( !revisionId ) { return 0 }
            var words = transcriptsForRevision( memoName, revisionId )
                .map( function( entry ) { return ( entry && typeof entry.words === 'number' && entry.words > 0 ) ? entry.words : 0 } )
                .reduce( function( sum, value ) { return sum + value }, 0 )
            return words === 0 ? 0 : Math.ceil( words / 200 )
        }

        // Extracts the viewed revision (REV-NN) from a sticky-header fileName ("REV-03.md").
        function revisionIdFromFileName( fileName ) {
            var m = String( fileName || '' ).match( /(REV-\\d{2,})/ )
            return m ? m[ 1 ] : null
        }

        // PRD-001 (Memo 018 Kap 4): icon for the derived 3-state ball status (sidebar + sticky).
        // Now driven by revisionStatus + memoFinalized (the single source of truth).
        function statusIconFor( revisionStatus, memoFinalized ) {
            var ballStatus = deriveBallStatus( revisionStatus, memoFinalized )
            if( ballStatus === 'Finalisiert (Locked)' ) { return '✓' }
            if( ballStatus === 'Transcript hinterlegt' ) { return '◑' }
            return '◐'
        }

        // PRD-001 (Memo 018 Kap 4): human-readable label for the derived 3-state ball status.
        function statusTextFor( revisionStatus, memoFinalized ) {
            return deriveBallStatus( revisionStatus, memoFinalized )
        }

        // PRD-001 (Memo 018 Kap 4): map the legacy memo-status string to the memoFinalized flag
        // that the new deriveBallStatus expects. 'Finalisiert'/'Bedingt finalisiert' -> true.
        function memoFinalizedFrom( memoStatus ) {
            return memoStatus === 'Finalisiert' || memoStatus === 'Bedingt finalisiert'
        }

        // PRD-004/006 (Memo 024 Kap 4): inline mirror of DocumentRegistry.deriveLifecycleStatus.
        // Same Ableitungs-Reihenfolge: planCompleted (Plan-/Rollout-Quelle) -> Frontmatter
        // (Finalisiert / Bedingt finalisiert / In Bearbeitung) -> Heuristik (>1 Revision ->
        // In Bearbeitung) -> Default 'Entwurf'. The browser has no plan-completion source today,
        // so planCompleted stays undefined here (additiver Hook, kein 'Abgeschlossen' im Frontend).
        function deriveLifecycleStatusFor( frontmatterStatus, revisionCount, planCompleted ) {
            if( planCompleted === true ) { return 'Abgeschlossen' }
            if( frontmatterStatus === 'Finalisiert' ) { return 'Finalisiert' }
            if( frontmatterStatus === 'Bedingt finalisiert' ) { return 'Bedingt finalisiert' }
            if( frontmatterStatus === 'In Bearbeitung' ) { return 'In Bearbeitung' }
            var count = ( typeof revisionCount === 'number' && revisionCount > 0 ) ? revisionCount : 0
            if( count > 1 ) { return 'In Bearbeitung' }
            return 'Entwurf'
        }

        // PRD-001 (Memo 018 Kap 4): derive the viewed revision's revisionStatus from transcript
        // presence. No transcript -> 'offen'; transcript present -> 'transcript-eingetragen'.
        // When the memo is finalisiert the logged state 'eingeloggt' is reached. This is the one
        // place the inline display computes revisionStatus (mirrors DocumentRegistry.deriveRevisionStatus).
        function revisionStatusFrom( hasTranscript, memoFinalized ) {
            if( memoFinalized === true && hasTranscript === true ) { return 'eingeloggt' }
            if( hasTranscript === true ) { return 'transcript-eingetragen' }
            return 'offen'
        }

        // PRD-008: pill class for the derived 3-state ball status.
        function pillClassFor( ballStatus ) {
            if( ballStatus === 'Finalisiert (Locked)' ) { return 'pill-final' }
            if( ballStatus === 'Transcript hinterlegt' ) { return 'pill-transcript' }
            return 'pill-feedback'
        }

        // PRD-008 (F12): optional Memo-Typ from the rendered content header table
        // ("Memo-Typ" / "Typ" row). Returns null when not available (badge then omitted).
        function lookupMemoType() {
            var match = ( lastContent || '' ).match( /\\|\\s*\\*{0,2}(?:Memo-)?Typ\\*{0,2}\\s*\\|\\s*([^|\\n]+?)\\s*\\|/i )
            if( !match ) { return null }
            var value = ( match[ 1 ] || '' ).trim()
            if( !value || value === '---' || value === '-' ) { return null }
            return value
        }

        // PRD-008: latest transcript URL for the current memo (for "Transcript kopieren").
        function latestTranscriptUrlFor( memoName ) {
            var tree = lastTranscriptTree || {}
            var url = ''
            Object.keys( tree ).forEach( function( projectId ) {
                var memos = tree[ projectId ] || {}
                var list = memos[ memoName ] || []
                if( list.length > 0 ) { url = list[ list.length - 1 ].url || '' }
            } )
            return url
        }

        // PRD-011: latest transcript URL for the VIEWED revision; falls back to the memo's
        // latest only when the viewed revision has no own transcript (keeps line-2 useful).
        function latestTranscriptUrlForRevision( memoName, revisionId ) {
            if( revisionId ) {
                var list = transcriptsForRevision( memoName, revisionId )
                if( list.length > 0 ) { return list[ list.length - 1 ].url || '' }
                return ''
            }
            return latestTranscriptUrlFor( memoName )
        }

        // PRD-005 (Memo 018 Kap 8): the transcriptId for the VIEWED revision — needed so the
        // "bereit / einloggen" button can target POST /api/transcripts/{id}/login. Picks the
        // latest entry for the revision (same selection as latestTranscriptUrlForRevision).
        function latestTranscriptForRevision( memoName, revisionId ) {
            if( !revisionId ) { return null }
            var list = transcriptsForRevision( memoName, revisionId )
            if( list.length > 0 ) { return list[ list.length - 1 ] }
            return null
        }

        // PRD-005 (Kap 8): is the viewed revision currently logged in? Derived from the
        // transcript tree (loggedIn flag, propagated by TranscriptRegistry.getTranscriptTree).
        function isRevisionLoggedIn( memoName, revisionId ) {
            return transcriptsForRevision( memoName, revisionId )
                .some( function( entry ) { return entry && entry.loggedIn === true } )
        }

        // PRD-004 (Memo 018 Kap 7): the revision-level revisionStatus driving the Transcript-
        // Statuszeile. Reuses the Phase-1 status model (offen / transcript-eingetragen /
        // eingeloggt); the eingeloggt state is now sourced from the per-revision loggedIn flag.
        function revisionStatusForRow( hasTranscript, isLoggedIn ) {
            if( isLoggedIn === true ) { return 'eingeloggt' }
            if( hasTranscript === true ) { return 'transcript-eingetragen' }
            return 'offen'
        }

        // PRD-004 (Kap 7): unified status pill class for the Transcript-Statuszeile, following
        // the mh-badge--{typ} naming scheme shared by all header badges.
        function statusBadgeClassFor( revisionStatus ) {
            if( revisionStatus === 'eingeloggt' ) { return 'mh-badge--eingeloggt' }
            if( revisionStatus === 'transcript-eingetragen' ) { return 'mh-badge--transcript' }
            return 'mh-badge--offen'
        }

        // PRD-004 (Kap 7): readable label for the revision transcript status.
        function statusRowLabel( revisionStatus ) {
            if( revisionStatus === 'eingeloggt' ) { return 'eingeloggt' }
            if( revisionStatus === 'transcript-eingetragen' ) { return 'transcript-eingetragen' }
            return 'offen'
        }

        // PRD-008 (Memo 019 Kap 9): inline browser mirror of MemoView.promptStatusLine. The
        // static class method (unit-tested) is server-side only; this 1:1 copy runs in the page.
        // Minutes are the Leitkennzahl (BEFORE words, Kap 9.4): a measured spoken duration shows
        // "N Min gesprochen", otherwise the derived ~200-words/min estimate shows "N Min geschätzt"
        // (never fakes "gesprochen", AC-11). "Kein Wegklicken" (Kap 9.2): transcriptInPrompt is
        // derived from a present transcript and can never be toggled off.
        function promptStatusLineInline( opts ) {
            opts = opts || {}
            var hasTranscript = typeof opts.transcriptUrl === 'string' && opts.transcriptUrl.length > 0
            var wordCount = ( typeof opts.words === 'number' && opts.words > 0 ) ? opts.words : 0
            var measured = typeof opts.spokenMinutes === 'number' && opts.spokenMinutes > 0
            var estimated = wordCount === 0 ? 0 : Math.ceil( wordCount / 200 )
            var minutes = measured ? opts.spokenMinutes : estimated
            var minutesEstimated = !measured
            var answered = ( typeof opts.questionsAnswered === 'number' && opts.questionsAnswered > 0 ) ? opts.questionsAnswered : 0
            var total = ( typeof opts.questionsTotal === 'number' && opts.questionsTotal > 0 ) ? opts.questionsTotal : 0
            var open = total > answered ? total - answered : 0
            var minutesLabel = minutesEstimated ? ( minutes + ' Min geschätzt' ) : ( minutes + ' Min gesprochen' )

            return {
                transcriptInPrompt: hasTranscript,
                hasTranscript: hasTranscript,
                words: wordCount,
                minutes: minutes,
                minutesEstimated: minutesEstimated,
                minutesLabel: minutesLabel,
                wordsLabel: wordCount.toLocaleString( 'de-DE' ) + ' Wörter',
                answered: answered,
                total: total,
                open: open,
                answeredLabel: answered + ' von ' + total + ' beantwortet',
                openLabel: open + ' offen'
            }
        }

        // PRD-008: two-line content-sticky-header.
        //   Line 1: Titel + Memo-Typ-Badge (F12) + Status-Pill (derived 3-state) + Diff-Toggle.
        //   Line 2: "Transcript kopieren" + URL + Woerter/Minuten.
        // No 📍/📌 emoji (Phase 1). Diff-Toggle (#diff-toggle) lives here (moved out of Nav-Bar).
        function updateSidebarSticky( memoName, fileName ) {
            var headerEl = document.getElementById( 'main-header' )
            if( !headerEl ) { return }
            if( !memoName && !fileName ) {
                headerEl.innerHTML = ''
                return
            }

            // PRD-002 (#9): the pill reflects the CONVERSATION state, not the raw memo-status
            // of the draft revision. deriveBallStatus derives one of three conversation states
            // ("Wartet auf User-Feedback" / "Transcript hinterlegt" / "Finalisiert (Locked)");
            // the raw 'Entwurf' memo-status is never shown as the pill text. memoStatus only
            // gates the Locked state.
            // PRD-011 (Memo 016 Kap 5): the "Transcript hinterlegt" presence is now resolved
            // PER REVISION (the one currently viewed, derived from fileName), not memo-weit.
            // A revision without its OWN transcript must not inherit the badge from a sibling
            // revision (REV-03 badge bug). Data source: lastTranscriptTree entries carry a
            // revisionId, so no data-model rebuild is needed.
            var memoStatus = lookupMemoStatus( memoName )
            var viewedRevision = revisionIdFromFileName( fileName )
            var hasTranscript = viewedRevision
                ? hasTranscriptForRevision( memoName, viewedRevision )
                : hasTranscriptForMemo( memoName )
            // PRD-001 (Memo 018 Kap 4): the ball state is now derived from the revision-level
            // revisionStatus + memoFinalized, not directly from (memoStatus, hasTranscript).
            var memoFinalized = memoFinalizedFrom( memoStatus )
            var revisionStatus = revisionStatusFrom( hasTranscript, memoFinalized )
            var ballStatus = deriveBallStatus( revisionStatus, memoFinalized )
            // Line-2 copy URL: prefer the transcript of the VIEWED revision; fall back to the
            // memo's latest only when the viewed revision has no own transcript.
            var transcriptUrl = latestTranscriptUrlForRevision( memoName, viewedRevision )

            // PRD-002 (#8): strip the .md extension from the file name in the sticky title.
            var cleanFile = String( fileName || '' ).replace( /\\.md$/i, '' )

            // PRD-004 (Memo 018 Kap 7 / 014 Kap 10): the title line is its own first row.
            // It carries the Memo-number + name + the viewed revision as informational context
            // ("worum es geht") and holds NO action buttons. Memo names already start with the
            // number ("018 · ..."), so the name is the heading; the revision is appended as context.
            var titleHeading = ( memoName || cleanFile )
            if( memoName && cleanFile ) { titleHeading = memoName + ' · ' + cleanFile }

            // PRD-005 (Kap 8): per-revision logged-in state drives the status row + button gate.
            var loggedIn = isRevisionLoggedIn( memoName, viewedRevision )
            var rowStatus = revisionStatusForRow( hasTranscript, loggedIn )
            var viewedTranscript = latestTranscriptForRevision( memoName, viewedRevision )

            // Word/minute estimate derived from the current rendered content (PRD-008 #5 fallback).
            var plainText = ( lastContent || '' ).replace( /[^A-Za-zÀ-ÿ0-9]+/g, ' ' )
            var trimmed = plainText.trim()
            var words = trimmed.length === 0 ? 0 : trimmed.split( /\\s+/ ).filter( function( t ) { return t.length > 0 } ).length
            var minutes = words === 0 ? 0 : Math.ceil( words / 200 )

            // ============================================================================
            // PRD-006 (Memo 019 Kap 6): 3-Zonen-Sticky-Header. Zone 1 = Informationsebene
            // (GELOCKT, v4 Frame JaA9o). Zone 2 = Interaktionsebene/Prompt-Statuszeile (Phase 5,
            // hier nur als Layout-Platzhalter mit dem bestehenden Inhalt). Zone 3 = Content
            // (scrollbar, NICHT sticky — lebt ausserhalb #main-header).
            // ============================================================================

            // ---- ZONE 1 — Informationsebene (gelockt, Frame JaA9o).
            // Zeile 1 (YtFVI): nur der MEMO-Titel (memoName) + Status-Pill. Die Pill zeigt
            // GELOCKT NUR "Entwurf" / "Finalisiert" (Frame NUj56) — NICHT die 3-State-Ball-
            // Status (PRD-006 AC-2/AC-4). Kein Typ-Badge, kein "Prepare" in Zone 1.
            var pillText = memoFinalized ? 'Finalisiert' : 'Entwurf'
            var pillStateClass = memoFinalized ? 'z1pill-final' : 'z1pill-draft'

            var z1Line1 = '<div class="z1-line1" data-zone1-line1>'
            z1Line1 += '<span class="z1-title" data-zone1-title>' + escapeAttr( memoName || cleanFile ) + '</span>'
            z1Line1 += '<span class="z1-pill ' + pillStateClass + '" data-zone1-pill data-pill="' + escapeAttr( pillText ) + '">' + escapeAttr( pillText ) + '</span>'
            // PRD-007 (Memo 022 Kap 5): the Diff-Toggle lives in Zone 1, Zeile 1, klein NEBEN der
            // Status-Pill (rechts davon) — nicht mehr als Balken am unteren Rand der Zone-2-
            // Statuszeile. Gleiche ID #diff-toggle -> bindDiffToggle findet ihn weiterhin per ID.
            // Startzustand display:none; bindDiffToggle blendet ihn ein, wenn ein Diff vorliegt.
            z1Line1 += '<button id="diff-toggle" style="display:none" title="Diff anzeigen/ausblenden">Diff</button>'
            z1Line1 += '</div>'

            // Zeile 2 (9I8kz): aktuelles Dokument — "ressources · 019 · REV-NN" + Kalender-Icon
            // + Datum + "Implementierung" + KB. Datum ist Pflicht (Kap 6.2); KB ist Pflicht und
            // korrekt (Kap 6.5). Werte werden aus der angezeigten Revision aufgeloest.
            var memoEntryZ1 = memoName ? lookupMemoEntry( memoName ) : null
            var z1Project = memoEntryZ1 ? memoEntryZ1.projectId : ''
            var memoNumberMatch = String( memoName || '' ).match( /(\\d{3})/ )
            var z1Number = memoNumberMatch ? memoNumberMatch[ 1 ] : ''
            var viewedRev = null
            if( memoEntryZ1 && memoEntryZ1.doc && Array.isArray( memoEntryZ1.doc.revisions ) ) {
                viewedRev = memoEntryZ1.doc.revisions.filter( function( r ) { return r.fileName === fileName } )[ 0 ] || null
            }
            var z1Date = viewedRev && viewedRev.mtime ? viewedRev.mtime : ''
            var z1Kb = viewedRev && viewedRev.sizeKb ? ( viewedRev.sizeKb + ' KB' ) : ''
            // Doc-Pfad "Namespace · Nr · REV-NN" — leere Teile werden weggelassen (kein Default).
            var docPathParts = []
            if( z1Project ) { docPathParts.push( z1Project ) }
            if( z1Number ) { docPathParts.push( z1Number ) }
            if( viewedRevision ) { docPathParts.push( viewedRevision ) }
            var docPath = docPathParts.join( ' \\u00b7 ' )

            var z1Line2 = '<div class="z1-line2" data-zone1-line2>'
            z1Line2 += '<span class="z1-doc" data-zone1-doc>' + escapeAttr( docPath ) + '</span>'
            if( z1Date ) {
                z1Line2 += '<span class="z1-cal" aria-hidden="true">\\uD83D\\uDCC5</span>'
                z1Line2 += '<span class="z1-date" data-zone1-date>' + escapeAttr( z1Date ) + '</span>'
            }
            z1Line2 += '<span class="z1-sep">\\u00b7</span>'
            // PRD-008 (F12): show the memo's ACTUAL type from the header table ("Memo-Typ" /
            // "Typ" row) instead of a hardcoded constant. lookupMemoType() reads the raw
            // markdown (lastContent) and returns null when no row is present — fall back to
            // "Implementierung" (the documented default) so the line-2 type is never empty.
            var z1Type = lookupMemoType() || 'Implementierung'
            z1Line2 += '<span class="z1-type" data-zone1-type>' + escapeAttr( z1Type ) + '</span>'
            if( z1Kb ) {
                z1Line2 += '<span class="z1-sep">\\u00b7</span>'
                z1Line2 += '<span class="z1-kb" data-zone1-kb>' + escapeAttr( z1Kb ) + '</span>'
            }
            z1Line2 += '</div>'

            var titleRow = '<div class="hdr-zone hdr-zone-1" data-zone="1">' + z1Line1 + z1Line2 + '</div>'

            // ---- ZONE 2 — Prompt-Statuszeile (PRD-008 / Kap 9, Frame o0zun).
            // STRIKT zwei Zeilen (Kap 9.3): Transcript-Zeile + Fragen-Zeile. Reine Statusuebersicht,
            // KEIN Eingabeort (Kap 9.5/AC-09). Die alte Single-Row-Mischung (Status-Badge +
            // "Transcript"-Button + "bereit / einloggen"-Opt-out + "Transcript kopieren" + URL +
            // Woerter + Diff) ist ENTFALLEN. "Kein Wegklicken" (Kap 9.2/AC-05): es gibt keine
            // "mitloggen"-Checkbox und keinen Opt-out-Schalter mehr in Zone 2 — ein vorhandener
            // Transcript ist immer Teil des Prompts. Einziger Eintrittspunkt: "Prompt bearbeiten".
            var memoEntry = memoName ? lookupMemoEntry( memoName ) : null

            // Fragen-Counts: gleiche Quelle wie die Sidebar (doc.questions {open, answered}),
            // damit Zone 2 und Sidebar nie auseinanderlaufen.
            var qMeta = normalizeQuestions( memoEntry ? memoEntry.doc.questions : null )
            var psAnswered = qMeta.answered
            var psTotal = qMeta.answered + qMeta.open

            // Minuten-Leitkennzahl (Kap 9.4): gemessene Sprech-Dauer aus dem Transcript-Record
            // (viewedTranscript.spokenMinutes), sonst Fallback auf die wordCount-Schaetzung.
            var psSpoken = ( viewedTranscript && typeof viewedTranscript.spokenMinutes === 'number' )
                ? viewedTranscript.spokenMinutes
                : 0
            // Inline mirror of MemoView.promptStatusLine (the static class is server-side only and
            // not available in the browser; promptStatusLineInline replicates it 1:1).
            var ps = promptStatusLineInline( {
                words: words,
                spokenMinutes: psSpoken,
                questionsAnswered: psAnswered,
                questionsTotal: psTotal,
                transcriptUrl: transcriptUrl
            } )

            var statusRow = '<div class="hdr-zone hdr-zone-2" data-zone="2"><div class="prompt-statuszeile" id="prompt-statuszeile">'

            // ---- Zeile 1 — Transcript (reHrF): Icon+Label · Minuten-Chip · Woerter · Spacer ·
            //      "Prompt bearbeiten" · Copy-Icon. Minuten VOR Woertern (Kap 9.4).
            statusRow += '<div class="ps-row ps-row--transcript" data-zone2-line1>'
            statusRow += '<span class="ps-ico" aria-hidden="true">\\uD83D\\uDCC4</span>'
            statusRow += '<span class="ps-label">Transcript</span>'
            if( ps.hasTranscript ) {
                statusRow += '<span class="ps-sep">\\u00b7</span>'
                statusRow += '<span class="ps-minutes" data-zone2-minutes data-estimated="' + ( ps.minutesEstimated ? '1' : '0' ) + '">'
                    + '<span class="ps-mic" aria-hidden="true">\\uD83C\\uDFA4</span>'
                    + '<span>' + escapeAttr( ps.minutesLabel ) + '</span>'
                    + '</span>'
                statusRow += '<span class="ps-sep">\\u00b7</span>'
                statusRow += '<span class="ps-words" data-zone2-words>' + escapeAttr( ps.wordsLabel ) + '</span>'
            } else {
                // Ohne Transcript: keine Minuten/Woerter vortaeuschen (Kap 9.5).
                statusRow += '<span class="ps-empty" data-zone2-empty>Kein Transcript hinterlegt</span>'
            }
            // Revisions-Kontext (data-project/-memo/-next) sitzt am einzigen Eintrittspunkt, damit
            // der bestehende "ohne Transcript speichern"-Pfad (PRD-028) seinen Bezug findet, ohne
            // dass es noch einen separaten #sticky-add-transcript-Button gibt.
            var psNums = memoEntry ? nextRevisionNumbers( memoEntry.doc.revisions ) : { nextId: 'REV-01', previousId: 'REV-01' }
            statusRow += '<span class="ps-spacer"></span>'
            statusRow += '<button class="ps-edit" id="ps-edit-prompt" data-prompt-edit'
                + ' data-memo="' + escapeAttr( memoName || '' ) + '"'
                + ' data-project="' + escapeAttr( memoEntry ? memoEntry.projectId : '' ) + '"'
                + ' data-next="' + escapeAttr( psNums.nextId ) + '"'
                + ' data-prev="' + escapeAttr( psNums.previousId ) + '"'
                // PRD-001 (Memo 022): data-rev = the DISCUSSED (viewed) revision. The "ohne
                // Transcript speichern"-Pfad (saveAnswersOnly) binds feedback ZU REV-N to REV-N,
                // not to REV-(N+1). Fallback to data-next only when no revision is viewed.
                + ' data-rev="' + escapeAttr( viewedRevision || psNums.nextId ) + '"'
                + ' title="Prompt bearbeiten — Transcript + Fragen in einem Popup">'
                + '<span aria-hidden="true">\\u270E</span><span>Prompt bearbeiten</span>'
                + '</button>'
            statusRow += '<button class="ps-copy" id="ps-copy"' + ( transcriptUrl ? '' : ' disabled' )
                + ' data-url="' + escapeAttr( transcriptUrl ) + '" title="Prompt/Transcript-URL kopieren" aria-label="Kopieren">\\u29C9</button>'
            statusRow += '</div>'

            // ---- Zeile 2 — Fragen (CmWEX): Icon+Label · "N von M beantwortet" ·
            //      Fragezeichen-Indikator · Spacer · "Abschliessen" (F7=A, Kap 9.6).
            statusRow += '<div class="ps-row ps-row--fragen" data-zone2-line2>'
            statusRow += '<span class="ps-ico" aria-hidden="true">\\u2611</span>'
            statusRow += '<span class="ps-label">Fragen</span>'
            statusRow += '<span class="ps-sep">\\u00b7</span>'
            statusRow += '<span class="ps-answered" data-zone2-answered>' + escapeAttr( ps.answeredLabel ) + '</span>'
            statusRow += '<span class="ps-qmark" data-zone2-qmark>'
                + '<span class="ps-qmark-sign" aria-hidden="true">?</span>'
                + '<span>' + escapeAttr( ps.openLabel ) + '</span>'
                + '</span>'
            statusRow += '<span class="ps-spacer"></span>'
            statusRow += '<button class="ps-finish" id="ps-finish" data-abschliessen title="Prompt abschliessen (F7) — manueller Trigger, kein Auto-Versand">'
                + '<span aria-hidden="true">\\u27A4</span><span>Abschließen</span>'
                + '</button>'
            statusRow += '</div>'

            // PRD-007 (Memo 022 Kap 5): der Diff-Toggle wurde aus der Zone-2-Statuszeile entfernt
            // und lebt jetzt in Zone 1, Zeile 1, neben der Status-Pill (siehe z1Line1). Kein
            // Button mehr am unteren Rand der Statuszeile ("Balken weg").

            statusRow += '</div></div>'

            headerEl.innerHTML = titleRow + statusRow

            // Rebind the diff-toggle (re-created on each render) to the existing diff logic.
            bindDiffToggle()

            // PRD-008 (Kap 9.5): the single entrypoint — "Prompt bearbeiten" opens the combined
            // popup (Transcript-Abschnitt + Fragen-Abschnitt). Bound per render (header rebuilt).
            bindPromptEdit( { memoEntry: memoEntry, memoName: memoName } )

            // PRD-008 (Kap 9.6): manual "Abschliessen" trigger. Bound per render.
            bindPromptFinish( { transcriptId: viewedTranscript ? viewedTranscript.transcriptId : '', revisionId: viewedRevision, memoName: memoName } )

            var copyBtn = document.getElementById( 'ps-copy' )
            if( copyBtn && transcriptUrl ) {
                copyBtn.addEventListener( 'click', function() {
                    navigator.clipboard.writeText( transcriptUrl ).then( function() {
                        var orig = copyBtn.textContent
                        copyBtn.textContent = '\\u2713'
                        setTimeout( function() { copyBtn.textContent = orig }, 2000 )
                    } ).catch( function() {} )
                } )
            }

            // PRD-008 (Memo 024 Kap 7) — REMOVED: the answers-only bar is gone (redundant with
            // the popup's "Übernehmen"). mountAnswersOnlyBarInHeader() now only strips any stray
            // bar so neither the Sticky-Header nor the popup show it again.
            mountAnswersOnlyBarInHeader()
        }

        // PRD-005 (Memo 022 Kap 9): the per-revision Typ-Badge (Full/Update/Prepare) was REMOVED
        // from the rev-mini widget — bei nur-Full-Ansicht (PRD-004) ist er redundant, die
        // prominente Revisionsnummer traegt jetzt die Identifikation. Das frühere revTypeBadge()
        // ist damit entfallen. Legacy wird weiterhin ueber revLegacyBadge gesetzt.

        // PRD-007 (Memo 018 Kap 10): legacy revisions stay readable but are explicitly marked
        // "alte Version" — clear old/new separation. parseError surfaces an unreadable file
        // without dropping it from the listing ("kein stilles Scheitern").
        function revLegacyBadge( rev ) {
            if( !rev || rev.isLegacy !== true ) { return '' }
            var title = rev.parseError === true ? 'Revision nicht lesbar/parsebar' : 'Nicht kompatibel mit dem Fragen-System'
            return '<span class="rev-type rt-legacy" title="' + escapeAttr( title ) + '">alte Version</span>'
        }

        function revQuestionsMeta( doc ) {
            var q = normalizeQuestions( doc.questions )
            if( q.open > 0 ) { return q.open + ' offen' }
            if( q.answered > 0 ) { return q.answered + ' beantw.' }
            return '0 offen'
        }

        // PRD-016 (Memo 016 Kap 6): flatten the memos tree into a single list of memo entries.
        // Used by the queue computation below; mirrors the namespace-aware tree shape used
        // throughout renderSidebarMemos (node.memos OR a bare array for legacy nodes).
        function flattenTreeMemos() {
            var tree = lastTree || {}
            var collected = []
            Object.keys( tree ).forEach( function( projectId ) {
                var node = tree[ projectId ]
                var memos = []
                if( Array.isArray( node ) ) {
                    memos = node
                } else if( node && typeof node === 'object' ) {
                    memos = node.memos || []
                }
                memos.forEach( function( m ) { collected.push( m ) } )
            } )
            return collected
        }

        // PRD-002 (Memo 018 Kap 5): the sidebar Queue. Mirrors MemoView.computeOpenRevisionQueue.
        // BUGFIX (fix/transcript-abschliessen-queue): Queue = UNFINISHED revisions (revisionStatus
        // !== 'eingeloggt', the geschaerfte Warteschlangen-Regel from DocumentRegistry.isInQueue)
        // across ALL namespaces. 'offen' + 'transcript-eingetragen' stay; only 'eingeloggt' drops.
        // The result is a FLAT list of
        // { doc, rev } pairs — one entry per open revision, NO grouping by memo or namespace (F3=A).
        // Sorted FIFO = OLDEST ON TOP (ascending mtimeMs). Entries without a timestamp sink to the
        // bottom. Replaces the old memo-level filter (memoStatus 'Finalisiert' && no transcript).
        function computeQueue() {
            var pairs = []
            flattenTreeMemos().forEach( function( doc ) {
                if( !doc || typeof doc !== 'object' ) { return }
                // PRD-001 (Memo 019 Kap 1): a finalized memo is done — none of its revisions
                // enter the queue, even when a single revision still reads 'offen'.
                if( memoFinalizedFrom( doc.memoStatus ) ) { return }
                ;( doc.revisions || [] ).forEach( function( rev ) {
                    // BUGFIX (fix/transcript-abschliessen-queue): mirror DocumentRegistry.isInQueue —
                    // a revision stays in the queue while NOT logged in. Both 'offen' and
                    // 'transcript-eingetragen' belong to the queue; ONLY 'eingeloggt' (= abgeschlossen)
                    // drops out. The revisionStatus is the transcript-derived status joined server-side
                    // (MemoView.enrichRevisionStatus). Legacy/parseError revisions never queue.
                    // Prepare-Revisionen (revisionType 'prepare') sind Basis-Snapshots (memo-revision-
                    // generate) und nie Queue-Material — sie spiegeln keinen offenen Transcript-Job.
                    if( rev && rev.revisionStatus !== 'eingeloggt' && rev.isLegacy !== true && rev.parseError !== true && rev.revisionType !== 'prepare' ) {
                        pairs.push( { doc: doc, rev: rev } )
                    }
                } )
            } )
            return pairs.slice().sort( function( a, b ) {
                var aMs = typeof a.rev.mtimeMs === 'number' ? a.rev.mtimeMs : null
                var bMs = typeof b.rev.mtimeMs === 'number' ? b.rev.mtimeMs : null
                if( aMs === null && bMs === null ) { return 0 }
                if( aMs === null ) { return 1 }
                if( bMs === null ) { return -1 }
                return aMs - bMs
            } )
        }

        // PRD-009 (Memo 024 Kap 7, F5=A): derive the stable per-entry keys of a queue (the same
        // { doc, rev } shape computeQueue() produces). A key is documentId::fileName — stable
        // across re-renders, so a plain re-render yields the identical key set and never triggers.
        function queueKeysOf( queue ) {
            return ( queue || [] )
                .filter( function( pair ) { return pair && pair.doc && pair.rev } )
                .map( function( pair ) { return String( pair.doc.documentId || '' ) + '::' + String( pair.rev.fileName || '' ) } )
        }

        // PRD-009: diff the current queue against the last snapshot and play a short ton on a real
        // new entry. The decision logic is the pure, unit-tested MemoView.detectQueueGrowth — this
        // wrapper only owns the snapshot state + the audio side effect. The baseline is always
        // updated to nextKeys so the next render compares against the freshest state.
        function maybeNotifyQueueGrowth( queue ) {
            var currentKeys = queueKeysOf( queue )
            // Inline of the (server-side, unit-tested) MemoView.detectQueueGrowth — the browser
            // bundle cannot reference the server class. No prior snapshot = initial load: seed the
            // baseline and never trigger. Otherwise a real new key plays the ton.
            if( lastQueueKeys === null || lastQueueKeys === undefined ) {
                lastQueueKeys = currentKeys
                return
            }
            var previousMap = {}
            lastQueueKeys.forEach( function( key ) { previousMap[ key ] = true } )
            var addedKeys = currentKeys.filter( function( key ) { return !previousMap[ key ] } )
            lastQueueKeys = currentKeys
            if( addedKeys.length > 0 ) { playQueueNotifyTone() }
        }

        // PRD-009 (AC-03/AC-06): a short Web-Audio oscillator ton — no external asset. The
        // AudioContext is created lazily and resumed; a context blocked by the autoplay policy
        // (no user gesture yet) degrades silently instead of throwing. Any failure is swallowed
        // so a missing/blocked audio backend never breaks the sidebar render.
        function playQueueNotifyTone() {
            try {
                var Ctx = window.AudioContext || window.webkitAudioContext
                if( !Ctx ) { return }
                if( !notifyAudioCtx ) { notifyAudioCtx = new Ctx() }
                if( notifyAudioCtx.state === 'suspended' && notifyAudioCtx.resume ) { notifyAudioCtx.resume() }

                var osc = notifyAudioCtx.createOscillator()
                var gain = notifyAudioCtx.createGain()
                var now = notifyAudioCtx.currentTime

                osc.type = 'sine'
                osc.frequency.setValueAtTime( 880, now )
                gain.gain.setValueAtTime( 0.0001, now )
                gain.gain.exponentialRampToValueAtTime( 0.12, now + 0.02 )
                gain.gain.exponentialRampToValueAtTime( 0.0001, now + 0.22 )

                osc.connect( gain )
                gain.connect( notifyAudioCtx.destination )
                osc.start( now )
                osc.stop( now + 0.24 )
            } catch( err ) {
                // Autoplay-blocked or no audio backend — degrade silently (AC-06).
            }
        }

        function renderSidebarMemos() {
            var navEl = document.getElementById( 'doc-sidebar-body' )
            if( !navEl ) { return }
            var tree = lastTree || {}

            // PRD-016 (Memo 016 Kap 6.1): seed every namespace into collapsedProjects ONCE so
            // groups render collapsed by default. A namespace already toggled open by the user
            // is left untouched on re-render (seededCollapseProjects guard).
            Object.keys( tree ).forEach( function( projectId ) {
                if( !seededCollapseProjects.has( projectId ) ) {
                    seededCollapseProjects.add( projectId )
                    collapsedProjects.add( projectId )
                }
                // PRD-006 (Memo 019 Kap 6.6): seed every memo of the namespace into
                // collapsedMemos ONCE so memos also render collapsed by default. Same seed-once
                // guard as the namespace level — a user-expanded memo stays expanded on re-render.
                var node = tree[ projectId ]
                var memosForSeed = Array.isArray( node ) ? node : ( node && typeof node === 'object' ? ( node.memos || [] ) : [] )
                memosForSeed.forEach( function( m ) {
                    if( m && m.documentId && !seededCollapseMemos.has( m.documentId ) ) {
                        seededCollapseMemos.add( m.documentId )
                        collapsedMemos.add( m.documentId )
                    }
                } )
            } )

            // PRD-005 (Memo 022 Kap 9): rev-mini Fokus-Redesign. Die Informationshierarchie wird
            // geschaerft — Memo Kap 9 ist hier die hoechste Autoritaet (das Pencil-Mockup v4 zeigt
            // noch Doc-Icon + Typ-Badge + prominentes Datum; uebernommen werden NUR die visuellen
            // Tokens, nicht die Hierarchie). Neue Reihenfolge pro Zeile:
            //   1. REV-NN PROMINENT + vorne (erster textlicher Identifikator)
            //   2. Datum sekundaer (lesbar, aber gedaempft)
            //   3. Minuten-Chip (mic-Symbol + "N Min") als Leitkennzahl
            //   4. Spacer
            //   5. dezentes Status-Symbol (offen/abgeschlossen) statt grossem "ABGESCHLOSSEN"-Badge
            //   6. Fragen-Chip (offene Revisionen)
            // ENTFERNT: Doc-Icon (file-text), Typ-/FULL-Badge (redundant bei nur-Full, PRD-004).
            // Beibehalten: revLegacyBadge (Legacy bleibt sichtbar gedimmt).
            // Konstante Zeilenhoehe (min-height 38px) ueber alle Zustaende. Visuelle Tokens aus
            // Pencil v4 (7RCLz aktiv / yesxz inaktiv): height 38, radius 7, gap 8, padding 0/10.
            // PRD-006 (Memo 022 Kap 7): die drei funktionslosen Hover-Action-Icons (copy/open/
            // trash) sind ENTFERNT — kein Click-Handler war je verdrahtet (falsche Affordanz).
            // PRD-004 (Memo 022 Kap 8): sidebar revision filter. When showOnlyFullRevisions is ON
            // (Default), only Full-Revisionen pass; Prepare/Update are hidden (visual only). A
            // missing/unknown revisionType is treated as 'full' (Fallback konsistent zum
            // data-state in renderRevEntry). Flag OFF -> every revision passes.
            function revisionPassesConfigFilter( rev ) {
                var cfg = window.__MEMO_CONFIG__ || {}
                if( cfg.showOnlyFullRevisions !== true ) { return true }
                var revType = ( rev && rev.revisionType ) ? rev.revisionType : 'full'
                return revType === 'full'
            }

            function renderRevEntry( doc, rev ) {
                var isSelected = rev.fileName === doc.selectedRevision
                var cls = 'rev-mini'
                if( isSelected ) { cls += ' rev-mini-active' }
                // PRD-001 (Memo 019 Kap 1): legacy/parseError revisions stay listed in the
                // namespace tree but are visually dimmed (greyed out) and never enter the queue.
                var isLegacy = rev.isLegacy === true || rev.parseError === true
                if( isLegacy ) { cls += ' rev-legacy-muted' }

                var revLabel = rev.fileName.replace( /\\.md$/, '' )
                var hasOwnTranscript = hasTranscriptForRevision( doc.memoName, revLabel )

                // 1. REV-NN PROMINENT + vorne (Memo Kap 9: primaerer Identifikator). Die
                // Transcript-Kopplung (eigenes Transcript der Revision) wird ueber data-rev-transcript
                // + Akzent-Farbe getragen, NICHT mehr ueber ein separates Doc-Icon (entfernt).
                var numCls = hasOwnTranscript ? 'rev-mini-num rev-mini-num-transcript' : 'rev-mini-num'
                var inner = '<span class="' + numCls + '" data-rev-num data-rev-transcript="' + ( hasOwnTranscript ? '1' : '0' ) + '">' + escapeAttr( revLabel ) + '</span>'
                // PRD-007 (Memo 018 Kap 10): Legacy/inkompatible Revisionen bleiben markiert.
                inner += revLegacyBadge( rev )
                // 2. Datum sekundaer (lesbar, gedaempft).
                var dateText = rev.mtime ? rev.mtime : ''
                inner += '<span class="rev-mini-date" data-rev-date>' + escapeAttr( dateText ) + '</span>'
                // 3. Minuten-Chip (Leitkennzahl): mic-Symbol + "N Min". Wert deterministisch aus
                // dem eigenen Revisions-Transcript, sonst 0 (kein erfundener Default, kein
                // Memo-Aggregat als Revisions-Wert). Visuelle Tokens aus Pencil v4.
                var revMinutes = aggregateRevisionMinutes( doc.memoName, revLabel )
                inner += '<span class="rev-mini-minutes" data-rev-minutes="' + revMinutes + '" title="Eingesprochene Minuten dieser Revision"><span class="rev-mini-mic" aria-hidden="true">\\uD83C\\uDF99</span>' + revMinutes + ' Min</span>'
                inner += '<span class="rev-mini-spacer"></span>'
                // 5. Dezentes Status-Symbol (offen vs. abgeschlossen) statt grossem Text-Badge.
                // Gefuellter Punkt = abgeschlossen (eingeloggt), offener Punkt = offen.
                var revDone = rev.revisionStatus === 'eingeloggt'
                var statusSym = revDone ? '\\u25CF' : '\\u25CB'
                var statusTitle = revDone ? 'Abgeschlossen (Transcript eingeloggt)' : 'Offen'
                inner += '<span class="rev-mini-status' + ( revDone ? ' rev-mini-status-done' : '' ) + '" data-rev-status="' + ( revDone ? 'eingeloggt' : 'offen' ) + '" title="' + escapeAttr( statusTitle ) + '">' + statusSym + '</span>'
                // 6. Fragen-Chip rechts (offene Revisionen). Prepare zeigt stattdessen die Note.
                if( rev.revisionType === 'prepare' ) {
                    inner += '<span class="rev-mini-note">Basis-Snapshot</span>'
                } else {
                    var revOpen = isSelected ? ( ( doc.questions || {} ).open || 0 ) : 0
                    inner += '<span class="rev-mini-chip" data-rev-chip><span class="rev-mini-chip-q">?</span>' + revOpen + '</span>'
                }

                var entryHtml = '<li class="' + cls + '" data-doc="' + escapeAttr( doc.documentId ) + '" data-rev="' + escapeAttr( rev.fileName ) + '" data-state="' + escapeAttr( rev.revisionType || 'full' ) + '" onclick="selectRevision(this.dataset.doc,this.dataset.rev)">'
                entryHtml += inner
                entryHtml += '</li>'
                return entryHtml
            }

            // PRD-001 (Memo 019 Kap 1): a Queue item carries the FULL information model so the
            // user sees at a glance where an entry comes from and what to do:
            //   line1: Namespace/Projekt-Label + Memo-Nr + Name + REV-ID + Status der Revision
            //   line2: Datum + Anzahl offener Fragen
            // Missing single values stay EMPTY (no invented default, AC-12) — the item never
            // crashes. The list stays FLAT and FIFO-sorted; the namespace is a label, not a group.
            // PRD-007 (Memo 019 Kap 7.4): the Queue-Item is its OWN, reicher Container (Soll
            // RdoSV/EHlQV, height 62, radius 8, linker Akzent-Balken 4px) — NICHT die 1:1-
            // Wiederverwendung der Baum-Revisionszeile. Drei Info-Zeilen:
            //   Zeile 1 (C0JZD): Memo-Titel + Fragen-Chip "❓N"
            //   Zeile 2 (8qi4f): "REV-NN · offen"
            //   Zeile 3 (Z36pN): folder-Icon + Namespace + · Datum
            // Pro Item klar erkennbar: Namespace · Datum · Anzahl offener Fragen (AC-5).
            // Fehlende Einzelwerte bleiben LEER (kein erfundener Default, AC-12 Phase 1).
            function renderQueueEntry( pair ) {
                var doc = pair.doc
                var rev = pair.rev
                var revLabel = String( rev.fileName || '' ).replace( /\\.md$/, '' )
                var openCount = ( doc.questions || {} ).open
                var openNum = ( typeof openCount === 'number' && openCount > 0 ) ? openCount : 0
                // BUGFIX (fix/transcript-abschliessen-queue): the queue now holds 'offen' AND
                // 'transcript-eingetragen' revisions (only 'eingeloggt' drops out). Map the raw enum
                // to a readable status word so the card line reads "REV-NN · offen" or
                // "REV-NN · transcript hinterlegt" (kein roher Enum, ruhige Formsprache Memo 019).
                var statusLabel = rev.revisionStatus === 'transcript-eingetragen' ? 'transcript hinterlegt' : ( rev.revisionStatus === 'eingeloggt' ? 'abgeschlossen' : ( rev.revisionStatus || '' ) )
                var revStatusLine = revLabel ? ( revLabel + ( statusLabel ? ( ' \\u00b7 ' + statusLabel ) : '' ) ) : statusLabel
                // PRD-006 (Memo 024 Kap 5): the Queue-Card now carries the same Minuten-Chip as the
                // Sidebar (PRD-005) — same data source aggregateMemoMinutes( doc.memoName ). 0
                // transcripts -> "🎙 0 Min" (kein erfundener Default).
                var queueMemoMinutes = aggregateMemoMinutes( doc.memoName || '' )
                // PRD-006 (Memo 024 Kap 5): the Lifecycle-Status (PRD-004 model) of the memo — NOT
                // the raw revision enum. deriveLifecycleStatusFor mirrors DocumentRegistry.
                // deriveLifecycleStatus (planCompleted has no frontend source yet, additiver Hook).
                var queueLifecycle = deriveLifecycleStatusFor( doc.memoStatus, ( doc.revisions || [] ).length )

                var html = '<li class="queue-card" data-doc="' + escapeAttr( doc.documentId ) + '" data-rev="' + escapeAttr( rev.fileName ) + '" onclick="selectRevision(this.dataset.doc,this.dataset.rev)">'
                html += '<span class="queue-card-bar" aria-hidden="true"></span>'
                html += '<span class="queue-card-info" data-queue-info>'
                // Zeile 1: Memo-Titel + Minuten-Chip + Fragen-Chip.
                html += '<span class="queue-card-row1">'
                html += '<span class="queue-card-title" data-queue-title>' + escapeAttr( doc.memoName || '' ) + '</span>'
                html += '<span class="queue-card-spacer"></span>'
                html += '<span class="queue-card-minutes" data-queue-minutes="' + queueMemoMinutes + '" title="Gesamte gesprochene Transcript-Dauer">\\uD83C\\uDF99 ' + queueMemoMinutes + ' Min</span>'
                html += '<span class="queue-card-chip" data-queue-chip><span class="queue-card-chip-q">?</span>' + openNum + '</span>'
                html += '</span>'
                // Zeile 2: REV-NN · offen + Lifecycle-Status des Memos (PRD-004-Modell).
                html += '<span class="queue-card-row2" data-queue-status data-queue-lifecycle="' + escapeAttr( queueLifecycle ) + '">' + escapeAttr( revStatusLine ) + '<span class="queue-card-lifecycle" data-queue-lifecycle-label>' + escapeAttr( queueLifecycle ) + '</span></span>'
                // Zeile 3: folder + Namespace + · Datum.
                html += '<span class="queue-card-row3">'
                html += '<span class="queue-card-folder" aria-hidden="true">\\uD83D\\uDCC1</span>'
                html += '<span class="queue-card-ns" data-queue-ns>' + escapeAttr( doc.projectId || '' ) + '</span>'
                if( rev.mtime ) { html += '<span class="queue-card-date" data-queue-date>\\u00b7 ' + escapeAttr( rev.mtime ) + '</span>' }
                html += '</span>'
                html += '</span></li>'
                return html
            }

            // Memo-header row (caret + status icon + name + transcript count) + indented revisions.
            function renderMemo( doc ) {
                var isActive = !!doc.selectedRevision
                var isMemoCollapsed = collapsedMemos.has( doc.documentId )
                var memoCaret = isMemoCollapsed ? '&#9656;' : '&#9662;'
                var revDisplay = isMemoCollapsed ? 'none' : 'block'
                var memoHtml = '<div class="memo-group" data-memo="' + escapeAttr( doc.documentId ) + '">'
                memoHtml += '<div class="memo-head' + ( isActive ? ' selected' : '' ) + '" data-memo-toggle="' + escapeAttr( doc.documentId ) + '" title="Revisionen ein-/ausklappen">'
                memoHtml += '<span class="mh-caret">' + memoCaret + '</span>'
                // PRD-011 (#4): the memo-head icon shows the pure MEMO status only — it must
                // NOT mix in transcript presence (that suggested "Transcript hinterlegt" for the
                // whole memo even when only single revisions had transcripts). Per-revision
                // transcript presence is now shown on each revision entry (renderRevEntry).
                // PRD-001 (Memo 018 Kap 4): the icon is driven by (revisionStatus, memoFinalized).
                // For the memo-head we keep a clean memo-status indicator (◐ Wartet / ✓ Finalisiert):
                // finalisiert -> 'eingeloggt' + true -> ✓, otherwise 'offen' -> ◐. Aggregate
                // transcript presence stays on the transcript-indicator pill, not this icon.
                var memoHeadFinalized = memoFinalizedFrom( doc.memoStatus )
                var memoHeadRevStatus = memoHeadFinalized ? 'eingeloggt' : 'offen'
                memoHtml += '<span class="mh-icon">' + statusIconFor( memoHeadRevStatus, memoHeadFinalized ) + '</span>'
                memoHtml += '<span class="mh-name">' + escapeAttr( doc.memoName ) + '</span>'
                // Fix (#81): the full-width break keeps the memo name on line 1 to itself so the
                // status cluster wraps to line 2 — a long name stays fully readable.
                // PRD-005 (Memo 024 Kap 4, F4=A): the break is now UNCONDITIONAL — every memo
                // renders a fixed 2-line structure (Zeile 1 = Name, Zeile 2 = Status-Cluster),
                // even a plain "Entwurf" memo (the minutes chip below always provides a cluster).
                memoHtml += '<span class="mh-break"></span>'
                if( doc.memoStatus && doc.memoStatus !== 'Entwurf' ) {
                    memoHtml += '<span class="memo-badge ' + badgeClassFor( doc.memoStatus ) + '">' + escapeAttr( doc.memoStatus ) + '</span>'
                }
                memoHtml += '<span class="mh-spacer"></span>'
                // PRD-001 (Memo 019 Kap 1): a finalized memo shows NO date — instead a chip with
                // a microphone icon + the aggregated spoken minutes + "Min" (kurz, ohne "gesprochen").
                // Source = sum of all memo-transcript minutes (~200 Woerter/Min). 0 transcripts ->
                // "🎙 0 Min" (no invented default, no date fallback). Open memos keep "Entwurf"
                // + revisions unchanged (the chip is finalized-only).
                // PRD-007 (Memo 019 Kap 7.5): a finalized COLLAPSED memo shows a Minuten-Chip
                // (mic-Icon + "N Min", Soll bylkP) plus a "finalisiert" Status-Badge (check-Icon
                // + "finalisiert", Soll BVf3c). The minutes data source is Phase 1; here the
                // LAYOUT-Soll is verbindlich. Open memos keep "Entwurf" + revisions unchanged.
                // PRD-005 (Memo 024 Kap 4, F4=A): the Minuten-Chip is now rendered for EVERY memo,
                // unconditionally — independent of status (Entwurf, In Bearbeitung, Finalisiert,
                // Abgeschlossen, Bedingt finalisiert). 0 transcripts -> "🎙 0 Min" (kein erfundener
                // Default, kein Datums-Fallback). The data-memo-minutes attribute carries the raw
                // integer so the global sum (Sidebar-Kopf) can aggregate the displayed chips.
                var memoMinutes = aggregateMemoMinutes( doc.memoName )
                memoHtml += '<span class="mh-minutes" data-memo-minutes="' + memoMinutes + '" title="Gesamte gesprochene Transcript-Dauer">\\uD83C\\uDF99 ' + memoMinutes + ' Min</span>'
                // PRD-019 (Memo 016 Kap 7.3): emoji reduction. The ❓ emoji is replaced by a
                // quiet textual count badge ("N ?") — same information (open questions exist +
                // how many), no colourful emoji. Hidden when there are no open questions.
                var openCount = ( doc.questions || {} ).open || 0
                // PRD-006 (Kap 6.4 / AC-10): "?" und Zahl in eigene Spans, damit der Chip-gap
                // den Box-Abstand zum Fragezeichen vergroessert. Leer bei 0 -> :empty blendet aus.
                var qlContent = openCount > 0 ? ( '<span class="ql-q">\\u003f</span><span class="ql-n">' + openCount + '</span>' ) : ''
                memoHtml += '<span class="questions-link" data-document-id="' + escapeAttr( doc.documentId ) + '" data-selected-rev="' + escapeAttr( doc.selectedRevision || '' ) + '" data-open="' + openCount + '" title="Offene Fragen anzeigen">' + qlContent + '</span>'
                memoHtml += '</div>'
                memoHtml += '<ul data-memo-list="' + escapeAttr( doc.documentId ) + '" style="list-style:none;padding:0;margin:2px 0 0;display:' + revDisplay + '">'
                // PRD-004 (Memo 022 Kap 8): when showOnlyFullRevisions is ON (Default), Prepare-
                // and Update-Revisionen werden in der Sidebar AUSGEBLENDET (rein visuell — Registry
                // und Tree-Payload bleiben unveraendert). Fehlender/unbekannter Typ -> als 'full'
                // behandelt (Fallback konsistent zum data-state in renderRevEntry).
                ;( doc.revisions || [] ).filter( revisionPassesConfigFilter ).forEach( function( rev ) {
                    memoHtml += renderRevEntry( doc, rev )
                } )
                memoHtml += '</ul></div>'
                return memoHtml
            }

            var html = ''

            // PRD-002 (Memo 018 Kap 5): the Queue (Warteschlange) renders ABOVE the namespace
            // groups. Contents = open revisions (computeQueue, FIFO oldest on top), flat one entry
            // per open revision. Each entry uses the SAME markup as the namespace revision lines
            // (renderRevEntry) — no separate queue-entry style. Empty -> a quiet placeholder.
            // PRD-005 (Memo 024 Kap 4): the global sidebar-head minutes total was removed on user
            // feedback (not needed). Per-memo minute chips (aggregateMemoMinutes) stay.

            var queue = computeQueue()
            // PRD-009 (Memo 024 Kap 7, F5=A): Audio-Notify on a NEW queue entry. The diff runs on
            // stable documentId::fileName keys (not counts) so a swap still counts. The very first
            // pass only seeds the baseline (lastQueueKeys === null) and stays silent (AC-04).
            maybeNotifyQueueGrowth( queue )
            html += '<div class="sb-group-header">Warteschlange</div>'
            if( queue.length === 0 ) {
                html += '<div class="sb-queue-empty">Nichts in der Warteschlange.</div>'
            } else {
                html += '<div class="sb-queue"><ul style="list-style:none;padding:0;margin:0">'
                queue.forEach( function( pair ) {
                    html += renderQueueEntry( pair )
                } )
                html += '</ul></div>'
            }
            html += '<div class="sb-divider"></div>'

            // PRD-003 (Memo 018 Kap 6): "Namespaces" section header above the namespace groups,
            // mirroring the "Warteschlange" header. Only rendered when at least one namespace exists.
            if( Object.keys( tree ).length > 0 ) {
                html += '<div class="sb-group-header">Namespaces</div>'
            }

            // PRD-006 (Memo 019 Kap 6.7): each namespace (= project) is an OUTER BOX (Soll npwAk:
            // radius 10, stroke #D4D4D8/1.5, clip). The box wraps the NS-Header (Soll Q2uZD:
            // chevron + folder + Name 13px/700 + spacer + Memo-Count-Chip "N Memos", height 42)
            // and the NS-Body (Soll ZUXs3: padding [6,8,8,8]) holding all memos. Hierarchie genau
            // Namespace -> Memo -> Revision (drei Stufen, keine vierte — AC-6 / F5).
            // The folder icon flips open/closed, the count-chip mirrors the collapsed/expanded fill.
            function nsHeaderInner( projectId, memoCount, collapsed ) {
                var chevron = collapsed ? '&#9656;' : '&#9662;'
                var folder = collapsed ? '\\uD83D\\uDCC1' : '\\uD83D\\uDCC2'
                var inner = '<span class="ns-chevron" data-ns-chevron>' + chevron + '</span>'
                inner += '<span class="ns-folder" aria-hidden="true">' + folder + '</span>'
                inner += '<span class="ns-name" data-ns-name>' + escapeAttr( projectId ) + '</span>'
                inner += '<span class="ns-spacer"></span>'
                inner += '<span class="ns-count" data-ns-count>' + memoCount + ' Memos</span>'
                return inner
            }

            Object.keys( tree ).forEach( function( projectId ) {
                var projectNode = tree[ projectId ]
                var memos = []

                if( Array.isArray( projectNode ) ) {
                    memos = projectNode
                } else if( projectNode && typeof projectNode === 'object' ) {
                    memos = projectNode.memos || []
                }

                if( memos.length === 0 ) { return }

                var isCollapsed = collapsedProjects.has( projectId )
                var bodyDisplay = isCollapsed ? 'none' : 'block'
                var boxCls = 'ns-box' + ( isCollapsed ? ' ns-box-collapsed' : '' )

                html += '<div class="' + boxCls + '" data-namespace="' + escapeAttr( projectId ) + '">'
                html += '<div class="ns-header" data-project="' + escapeAttr( projectId ) + '" title="Namespace ein-/ausklappen">'
                html += nsHeaderInner( projectId, memos.length, isCollapsed )
                html += '</div>'
                html += '<div class="ns-body" data-project-list="' + escapeAttr( projectId ) + '" style="display:' + bodyDisplay + '">'
                memos.forEach( function( doc ) {
                    html += renderMemo( doc )
                } )
                html += '</div></div>'
            } )

            // PRD-003 (Memo 018 / 015 REV-05 F6): the "Neue Memos" section was removed. The
            // sidebar now contains exactly two sections — Warteschlange (top) and Namespaces.

            navEl.innerHTML = html

            // PRD-002 (Memo 018 Kap 5): queue entries are now rendered via renderRevEntry, which
            // carries its own inline onclick=selectRevision(doc,rev). No separate .queue-entry
            // click handler is needed — the shared revision-line markup handles selection.

            // PRD-006 (Memo 019 Kap 6.9): namespace box toggle. Clicking the NS-Header collapses/
            // expands the box body (the memos). Navigation must be reliable — the WHOLE header is
            // the hit target and the chevron/folder/count-chip rebuild consistently on toggle.
            navEl.querySelectorAll( '.ns-header[data-project]' ).forEach( function( el ) {
                el.addEventListener( 'click', function() {
                    var projectId = el.getAttribute( 'data-project' )
                    if( collapsedProjects.has( projectId ) ) {
                        collapsedProjects.delete( projectId )
                    } else {
                        collapsedProjects.add( projectId )
                    }
                    var nowCollapsed = collapsedProjects.has( projectId )
                    var bodyEl = navEl.querySelector( '.ns-body[data-project-list="' + projectId + '"]' )
                    var boxEl = navEl.querySelector( '.ns-box[data-namespace="' + projectId + '"]' )
                    var memoCount = bodyEl ? bodyEl.querySelectorAll( '.memo-group' ).length : 0
                    if( bodyEl ) { bodyEl.style.display = nowCollapsed ? 'none' : 'block' }
                    if( boxEl ) { boxEl.classList.toggle( 'ns-box-collapsed', nowCollapsed ) }
                    el.innerHTML = nsHeaderInner( projectId, memoCount, nowCollapsed )
                } )
            } )

            // REV-05 R3: the WHOLE memo-head toggles its revisions (not just the caret).
            // Inner interactive children (questions-link, transcript-indicator) call
            // stopPropagation, so clicking those does not collapse the memo.
            navEl.querySelectorAll( '.memo-head[data-memo-toggle]' ).forEach( function( el ) {
                el.addEventListener( 'click', function() {
                    var memoId = el.getAttribute( 'data-memo-toggle' )
                    if( collapsedMemos.has( memoId ) ) {
                        collapsedMemos.delete( memoId )
                    } else {
                        collapsedMemos.add( memoId )
                    }
                    var listEl = navEl.querySelector( '[data-memo-list="' + memoId + '"]' )
                    var caretEl = el.querySelector( '.mh-caret' )
                    var nowCollapsed = collapsedMemos.has( memoId )
                    if( listEl ) {
                        listEl.style.display = nowCollapsed ? 'none' : 'block'
                    }
                    if( caretEl ) {
                        caretEl.innerHTML = nowCollapsed ? '&#9656;' : '&#9662;'
                    }
                } )
            } )

            // Deep-link from questions icon -> open content + scroll to "Offene Fragen"
            navEl.querySelectorAll( '.questions-link' ).forEach( function( el ) {
                el.addEventListener( 'click', function( ev ) {
                    ev.stopPropagation()
                    var docId = el.getAttribute( 'data-document-id' )
                    var selectedRev = el.getAttribute( 'data-selected-rev' )
                    if( docId && selectedRev ) {
                        pendingQuestionsScroll = true
                        selectRevision( docId, selectedRev )
                    }
                } )
            } )

            if( !lastContent ) {
                contentEl.innerHTML = '<p class="content-placeholder">Dokument auswaehlen...</p>'
            }
        }

        function planStatusIcon( s ) {
            if( s === 'done' ) { return '<span style="color:#3fb950">&#10003;</span>' }
            if( s === 'in-progress' ) { return '<span style="color:#4493f8">&#9696;</span>' }
            if( s === 'blocked' ) { return '<span style="color:#f85149">&bull;</span>' }
            return '<span style="color:#666">&bull;</span>'
        }

        var selectedPlanFolder = null

        // Plans-View sidebar: AKTIVE PLÄNE pills + OFFENE MEMOS · {NS}.
        function planCompoundId( plan ) {
            var folder = plan.folder || plan.planId
            return plan.projectId ? plan.projectId + '--' + folder : folder
        }

        function renderSidebarPlans() {
            var navEl = document.getElementById( 'doc-sidebar-body' )
            if( !navEl ) { return }
            var plans = lastPlans || []
            var validPlans = plans.filter( function( p ) { return !p.isInvalid } )

            if( selectedPlanFolder === null && validPlans.length > 0 ) {
                selectedPlanFolder = planCompoundId( validPlans[ 0 ] )
            }

            // Group plans by projectId (fallback bucket 'workbench' for legacy plans without projectId)
            var buckets = {}
            var bucketOrder = []
            plans.forEach( function( plan ) {
                var key = plan.projectId || 'workbench'
                if( !buckets[ key ] ) {
                    buckets[ key ] = []
                    bucketOrder.push( key )
                }
                buckets[ key ].push( plan )
            } )

            var html = ''

            if( plans.length === 0 ) {
                html += '<div class="sb-group-header">AKTIVE PLÄNE</div>'
                html += '<div style="color:#6e7681;font-size:11px;padding:4px 8px">Keine Plans gefunden.</div>'
            }

            bucketOrder.forEach( function( projectKey ) {
                var label = bucketOrder.length === 1 && projectKey === 'workbench'
                    ? 'AKTIVE PLÄNE'
                    : 'AKTIVE PLÄNE · ' + projectKey.toUpperCase()
                html += '<div class="sb-group-header">' + escapeAttr( label ) + '</div>'

                buckets[ projectKey ].forEach( function( plan ) {
                    if( plan.isInvalid ) {
                        html += '<div class="plan-pill invalid">&#9888; ' + escapeAttr( plan.planId || plan.folder ) + '</div>'
                        return
                    }
                    var compound = planCompoundId( plan )
                    var sel = compound === selectedPlanFolder ? ' selected' : ''
                    var namePart = plan.planId.replace( /^(PLAN-\\d{3})-/, '$1 ' )
                    html += '<div class="plan-pill' + sel + '" data-plan="' + escapeAttr( compound ) + '">' + escapeAttr( namePart ) + '</div>'
                } )
            } )

            html += '<div class="sb-divider"></div>'

            // OFFENE MEMOS · {NS} — finalized memos not yet worked off (server provides openMemos).
            var openMemos = lastOpenMemos || []
            var nsLabel = openMemos.length > 0 && openMemos[ 0 ].projectId ? openMemos[ 0 ].projectId.toUpperCase() : 'WORKBENCH'
            html += '<div class="sb-group-header">OFFENE MEMOS · ' + escapeAttr( nsLabel ) + '</div>'

            if( openMemos.length === 0 ) {
                html += '<div style="color:#6e7681;font-size:11px;padding:4px 8px">Keine offenen Memos.</div>'
            }

            openMemos.forEach( function( m ) {
                var isFinal = m.memoStatus === 'Finalisiert'
                html += '<div class="open-memo' + ( isFinal ? '' : ' not-final' ) + '">'
                html += '<span class="om-name">' + escapeAttr( m.memoName ) + '</span>'
                html += '<span class="om-status">' + ( isFinal ? 'finalisiert' : 'nicht final' ) + '</span>'
                html += '</div>'
            } )

            navEl.innerHTML = html

            navEl.querySelectorAll( '.plan-pill[data-plan]' ).forEach( function( el ) {
                el.addEventListener( 'click', function() {
                    selectedPlanFolder = el.getAttribute( 'data-plan' )
                    renderSidebarPlans()
                    renderPlanTraceView()
                } )
            } )
        }

        // Plan-Trace-View — title + plan-URL row + tiles + trace table (Gen/Exec/Eval/Commit).
        function phaseProgress( phases ) {
            var list = phases || []
            var total = list.length
            var done = list.filter( function( p ) { return p.status === 'done' } ).length
            var percent = total > 0 ? Math.round( ( done / total ) * 100 ) : 0
            return { done: done, total: total, percent: percent }
        }

        // ✓ done · ◐ in-progress · ○ pending
        function traceStep( status ) {
            if( status === 'done' ) { return '<span class="trace-sym-done">&#10003;</span>' }
            if( status === 'in-progress' ) { return '<span class="trace-sym-progress">&#9680;</span>' }
            return '<span class="trace-sym-pending">&#9675;</span>'
        }

        function phaseRowFromPhase( phase, namespace, memoId ) {
            var headCommit = phase.headCommit || ''
            var isDone = phase.status === 'done'
            // PRD-017 US-1: surface the HEAD-Commit for in-progress rows too, not only on
            // completion — a commit pointer that appears only at the end arrives too late.
            // Falls back to the empty cell when plan-status.json carries no headCommit.
            var isInProgress = phase.status === 'in-progress'
            var prds = Array.isArray( phase.prds ) ? phase.prds : []
            var out = []

            if( prds.length === 0 ) {
                out.push( {
                    namespace: namespace,
                    strang: ( memoId ? memoId + ' · ' : '' ) + phase.id + ( phase.name ? ' ' + phase.name : '' ),
                    generate: isDone ? 'done' : phase.status,
                    execute: isDone ? 'done' : ( phase.status === 'in-progress' ? 'in-progress' : 'pending' ),
                    evaluate: isDone ? 'done' : 'pending',
                    headCommit: ( isDone || isInProgress ) ? headCommit : '',
                    future: ( phase.status !== 'done' && phase.status !== 'in-progress' )
                } )
            } else {
                prds.forEach( function( prd ) {
                    var prdId = prd.id || prd.prdId || ''
                    var prdName = prd.name || ''
                    var prdDone = prd.execute === 'done' && prd.evaluate === 'done'
                    var prdInProgress = prd.generate === 'in-progress' || prd.execute === 'in-progress' || prd.evaluate === 'in-progress'
                    var prdCommit = prd.headCommit || headCommit
                    out.push( {
                        namespace: namespace,
                        strang: ( memoId ? memoId + ' · ' : '' ) + phase.id + ' · ' + prdId + ( prdName ? ' ' + prdName : '' ),
                        generate: prd.generate || 'pending',
                        execute: prd.execute || 'pending',
                        evaluate: prd.evaluate || 'pending',
                        headCommit: ( prdDone || prdInProgress ) ? prdCommit : '',
                        future: ( prd.generate !== 'done' && prd.generate !== 'in-progress' && prd.execute !== 'in-progress' )
                    } )
                } )
            }

            return out
        }

        // PRD-017 US-2: a phaseRef string identifies a row's phase on the plan-wide
        // execution axis. Built from namespace/memo/phase so it can be matched against the
        // entries in plan.executionOrder (which may be plain strings or objects).
        function rowPhaseRef( namespace, memoId, phaseId ) {
            return [ namespace || '', memoId || '', phaseId || '' ]
                .filter( function( part ) { return part !== '' } )
                .join( ' · ' )
        }

        // PRD-017 US-2: normalise one executionOrder entry (string OR object with phaseRef/
        // namespace/memoId/phaseId) into a comparable ref-key, matching rowPhaseRef's shape.
        function executionOrderKey( entry ) {
            if( typeof entry === 'string' ) { return entry }
            if( entry && typeof entry === 'object' ) {
                if( entry.phaseRef ) { return entry.phaseRef }
                return rowPhaseRef( entry.namespace, entry.memoId, entry.phaseId || entry.phase || entry.id )
            }
            return ''
        }

        // PRD-017 US-2: stable, purely presentational sort of trace rows by plan.executionOrder.
        // Rows whose phaseRef matches an order entry come first in that order; unmatched rows
        // keep their original array order at the end. Without executionOrder it is the identity.
        function orderRows( rows, executionOrder ) {
            var list = Array.isArray( rows ) ? rows : []
            var order = Array.isArray( executionOrder ) ? executionOrder : []
            if( order.length === 0 ) { return list.slice() }

            var rank = {}
            order.forEach( function( entry, idx ) {
                var key = executionOrderKey( entry )
                if( key !== '' && !( key in rank ) ) { rank[ key ] = idx }
            } )

            var ranked = []
            var unranked = []
            list.forEach( function( row, idx ) {
                var hit = ( row && row.phaseRef && ( row.phaseRef in rank ) )
                if( hit ) {
                    ranked.push( { row: row, sort: rank[ row.phaseRef ], idx: idx } )
                } else {
                    unranked.push( { row: row, idx: idx } )
                }
            } )

            ranked.sort( function( a, b ) {
                if( a.sort !== b.sort ) { return a.sort - b.sort }
                return a.idx - b.idx
            } )

            return ranked
                .map( function( e ) { return e.row } )
                .concat( unranked.map( function( e ) { return e.row } ) )
        }

        function collectTraceRows( plan ) {
            var rows = []
            var memos = Array.isArray( plan.memos ) ? plan.memos : []

            if( memos.length > 0 ) {
                // namespace/memo-aware schema: phases nested per memo
                memos.forEach( function( m ) {
                    var ns = m.namespace || ''
                    var memoId = m.memoId || ''
                    var phases = Array.isArray( m.phases ) ? m.phases : []
                    phases.forEach( function( phase ) {
                        var ref = rowPhaseRef( ns, memoId, phase.id )
                        phaseRowFromPhase( phase, ns, memoId )
                            .forEach( function( r ) {
                                r.phaseRef = ref
                                rows.push( r )
                            } )
                    } )
                } )
            } else {
                // legacy schema: top-level phases
                var legacyPhases = Array.isArray( plan.phases ) ? plan.phases : []
                legacyPhases.forEach( function( phase ) {
                    var ns = phase.namespace || phase.projectId || ''
                    var memoId = phase.memoId || ''
                    var ref = rowPhaseRef( ns, memoId, phase.id )
                    phaseRowFromPhase( phase, ns, memoId )
                        .forEach( function( r ) {
                            r.phaseRef = ref
                            rows.push( r )
                        } )
                } )
            }

            // PRD-017 US-2: presentational-only ordering by the plan's executionOrder; without
            // it (single-memo / legacy plans) this is the identity and array order is kept.
            return orderRows( rows, plan.executionOrder )
        }

        function collectMemoTiles( plan ) {
            var tiles = []
            var memos = Array.isArray( plan.memos ) ? plan.memos : []

            if( memos.length > 0 ) {
                memos.forEach( function( m ) {
                    tiles.push( {
                        memoName: m.name || m.memoId || '(unbenannt)',
                        memoId: m.memoId || '',
                        namespace: m.namespace || '',
                        progress: phaseProgress( m.phases ),
                        status: m.status || plan.status
                    } )
                } )
            } else {
                tiles.push( {
                    memoName: plan.planId || plan.folder,
                    memoId: '',
                    namespace: '',
                    progress: phaseProgress( plan.phases ),
                    status: plan.status
                } )
            }

            return tiles
        }

        function planStatusText( status ) {
            if( status === 'done' || status === 'archived' ) { return 'finalisiert' }
            if( status === 'in-progress' ) { return 'in Bearbeitung' }
            return status || ''
        }

        function renderPlanTraceView() {
            if( currentMode !== 'plans' ) { return }
            var plans = ( lastPlans || [] ).filter( function( p ) { return !p.isInvalid } )

            if( plans.length === 0 ) {
                contentEl.innerHTML = '<p style="color:#888">Keine Plans gefunden.</p>'
                return
            }

            var plan = plans.find( function( p ) {
                return planCompoundId( p ) === selectedPlanFolder
            } ) || plans[ 0 ]

            var planFolder = plan.folder || plan.planId
            var compound = planCompoundId( plan )
            var planTitle = plan.planId.replace( /^(PLAN-\\d{3})-/, '$1 · ' )
            var planUrl = window.location.origin + '/plans/' + compound

            var html = '<div class="plan-block">'
            html += '<h1 class="plan-title" id="plan-' + escapeAttr( planFolder ) + '">' + escapeAttr( planTitle ) + '</h1>'

            // Plan-URL row (URL box + copy button)
            html += '<div class="plan-url-row">'
            html += '<span class="plan-url-box" id="plan-url-text">' + escapeAttr( planUrl ) + '</span>'
            html += '<button class="plan-copy-btn" id="plan-copy-btn">Kopieren</button>'
            html += '</div>'

            // ENTHALTENE MEMOS + tiles
            html += '<div class="plan-section-label">ENTHALTENE MEMOS</div>'
            var tiles = collectMemoTiles( plan )
            html += '<div class="memo-tiles">'
            tiles.forEach( function( tile ) {
                var subtitle = ( tile.memoId ? tile.memoId + ' · ' : '' ) + tile.progress.done + '/' + tile.progress.total + ' Phasen · ' + tile.progress.percent + '%'
                var statusText = planStatusText( tile.status )
                html += '<div class="memo-tile">'
                html += '<div class="tile-left">'
                html += '<span class="tile-name">' + escapeAttr( tile.memoName ) + '</span>'
                html += '<span class="tile-subtitle">' + escapeAttr( subtitle ) + '</span>'
                html += '</div>'
                html += '<div class="tile-right">'
                if( tile.namespace ) {
                    html += '<span class="tile-ns-badge">' + escapeAttr( tile.namespace ) + '</span>'
                }
                html += '<span class="tile-status">' + escapeAttr( statusText ) + '</span>'
                html += '</div>'
                html += '</div>'
            } )
            html += '</div>'

            // ABLAUF-TRACE + trace table
            html += '<div class="plan-section-label">ABLAUF-TRACE · Phasen memo-übergreifend swappbar</div>'
            var rows = collectTraceRows( plan )
            html += '<table class="trace-table"><thead><tr>'
            html += '<th>Namespace › Memo · Ph · PRD</th>'
            html += '<th class="tcol-fix">Gen</th><th class="tcol-fix">Exec</th><th class="tcol-fix">Eval</th><th class="tcol-commit">Commit</th>'
            html += '</tr></thead><tbody>'
            rows.forEach( function( row ) {
                var rowCls = row.future ? ' class="row-future"' : ''
                var strang = ( row.namespace ? row.namespace + ' · ' : '' ) + row.strang
                html += '<tr' + rowCls + '>'
                html += '<td class="tcell-strang">' + escapeAttr( strang ) + '</td>'
                html += '<td>' + traceStep( row.generate ) + '</td>'
                html += '<td>' + traceStep( row.execute ) + '</td>'
                html += '<td>' + traceStep( row.evaluate ) + '</td>'
                if( row.headCommit ) {
                    html += '<td><span class="trace-commit">' + escapeAttr( String( row.headCommit ).slice( 0, 7 ) ) + '</span></td>'
                } else {
                    html += '<td class="trace-commit-empty">&mdash;</td>'
                }
                html += '</tr>'
            } )
            html += '</tbody></table>'
            html += '</div>'

            contentEl.innerHTML = html
            updateSidebarSticky( '', '' )

            var copyBtnEl = document.getElementById( 'plan-copy-btn' )
            if( copyBtnEl ) {
                copyBtnEl.addEventListener( 'click', function() {
                    var txt = document.getElementById( 'plan-url-text' )
                    if( !txt ) { return }
                    navigator.clipboard.writeText( txt.textContent ).then( function() {
                        var orig = copyBtnEl.textContent
                        copyBtnEl.textContent = 'Kopiert!'
                        setTimeout( function() { copyBtnEl.textContent = orig }, 2000 )
                    } ).catch( function() {} )
                } )
            }
        }

        function renderSidebar() {
            if( currentMode === 'transcripts' ) {
                // PRD-008: transcripts view — sidebar lists the latest transcripts of all
                // storage locations; content shows a placeholder until one is selected.
                renderSidebarTranscripts()
            } else if( currentMode === 'plans' ) {
                renderSidebarPlans()
                renderPlanTraceView()
            } else {
                renderSidebarMemos()
                updateTranscriptIndicators()
            }
        }

        // PRD-008: human-readable label + context-mode per transcript type (Phase-1
        // 4-Typen-Modell). Used to tag sidebar entries and label the injection block.
        var transcriptTypeMeta = {
            'frei': { label: 'Frei', context: 'im Thread' },
            'memo-init': { label: 'Memo-Init', context: 'leerer Kontext' },
            'revision': { label: 'Revision', context: 'im Thread' },
            'plan-start': { label: 'Plan-Start', context: 'leerer Kontext' }
        }

        function transcriptTypeLabel( type ) {
            var meta = transcriptTypeMeta[ type ]
            return meta ? meta.label : ( type || 'Unbekannt' )
        }

        // PRD-018 US-2: the only primary type is the one the user actually uses ("Memo
        // erstellen" -> memo-init); frei/revision/plan-start are the nachrangige history.
        function isPrimaryTranscriptType( type ) {
            return type === 'memo-init'
        }

        // PRD-018 US-2: sort transcript sidebar entries by recency (mtime desc, then sequence
        // desc) so the long history list is ordered instead of arbitrary. Pure — no DOM, copies
        // the input. Entries without an mtime/sequence sort stably after dated ones.
        function sortTranscriptEntries( entries ) {
            var list = Array.isArray( entries ) ? entries.slice() : []
            list.sort( function( a, b ) {
                var ma = a && a.mtime ? Date.parse( a.mtime ) : NaN
                var mb = b && b.mtime ? Date.parse( b.mtime ) : NaN
                var va = isNaN( ma ) ? -Infinity : ma
                var vb = isNaN( mb ) ? -Infinity : mb
                if( va !== vb ) { return vb - va }
                var sa = Number( a && a.sequence )
                var sb = Number( b && b.sequence )
                var na = isNaN( sa ) ? -Infinity : sa
                var nb = isNaN( sb ) ? -Infinity : sb
                if( na !== nb ) { return nb - na }

                return 0
            } )

            return list
        }

        // PRD-008: Transcript-View sidebar — lists the latest transcripts of ALL storage
        // locations (free transcripts from .memo/transcripts/ via /api/other/transcripts,
        // memo-bound ones via /api/transcripts). Each entry shows type + origin so storage
        // discrepancies surface immediately (Memo 016 Kap 4).
        async function renderSidebarTranscripts() {
            var navEl = document.getElementById( 'doc-sidebar-body' )
            if( !navEl ) { return }

            // PRD-018 US-2: the actually-used entry point ("Memo erstellen") is hoisted to the
            // top as the dominant affordance; the long, rarely-used history list is secondary
            // below it. No transcript is removed — only re-ordered and de-emphasised.
            navEl.innerHTML = '<div class="sb-group-header">&#9662; Transcripts</div>'
                + '<button id="transcript-sb-new" class="transcript-sb-new" title="Neues Memo aus einem Transcript erstellen (Namespace waehlen)" style="display:block;width:calc(100% - 8px);margin:4px;padding:7px 8px;cursor:pointer;font-size:12px;font-weight:600;text-align:left;border:1px solid #4493f8;border-radius:6px;background:rgba(68,147,248,0.10);color:var(--text-1)">&#43; Memo erstellen</button>'
                + '<div class="sb-group-subheader" style="padding:6px 6px 2px;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)">Verlauf</div>'
                + '<div id="transcript-sb-list" style="padding:2px 4px;color:var(--text-muted);font-size:11px">Lade Transcripts...</div>'

            var newBtn = document.getElementById( 'transcript-sb-new' )
            if( newBtn ) {
                newBtn.addEventListener( 'click', function() {
                    if( typeof openTranscriptModal === 'function' ) { openTranscriptModal( {} ) }
                } )
            }

            if( !lastContent && contentEl ) {
                contentEl.innerHTML = '<p style="color:#888">Transcript auswaehlen...</p>'
            }

            var freeList = []
            var memoList = []

            try {
                var freeResp = await fetch( '/api/other/transcripts' )
                var freeData = await freeResp.json()
                freeList = ( freeData && freeData.transcripts ) || []
            } catch {
                freeList = []
            }

            try {
                var memoResp = await fetch( '/api/transcripts' )
                var memoData = await memoResp.json()
                memoList = ( memoData && memoData.transcripts ) || []
            } catch {
                memoList = []
            }

            var entries = []
            freeList.forEach( function( t ) {
                var freeType = t.type || 'frei'
                entries.push( {
                    transcriptId: t.transcriptId,
                    type: freeType,
                    origin: '.memo/transcripts/',
                    label: t.projectId || t.transcriptId,
                    sequence: t.sequence || '',
                    mtime: t.mtime || '',
                    // PRD-012: a free ("frei") transcript can be transformed into a memo-init
                    // transcript (Re-Injection). Already-memo-init ones are not offered again.
                    canTransform: freeType === 'frei'
                } )
            } )
            memoList.forEach( function( t ) {
                entries.push( {
                    transcriptId: t.transcriptId,
                    type: t.type || 'revision',
                    origin: ( t.memoId || '' ) + '/transcripts/',
                    label: ( t.memoId || t.projectId || t.transcriptId ) + ' · ' + ( t.revisionId || '' ),
                    sequence: t.sequence || '',
                    mtime: t.mtime || '',
                    canTransform: false
                } )
            } )

            var listEl = document.getElementById( 'transcript-sb-list' )
            if( !listEl ) { return }

            if( entries.length === 0 ) {
                listEl.innerHTML = 'Keine Transcripts.'
                return
            }

            // PRD-018 US-2: order the history newest-first so "sehr viele Transcripts" no longer
            // appear in arbitrary order. Purely presentational — no entry is dropped.
            var sortedEntries = sortTranscriptEntries( entries )

            var html = ''
            sortedEntries.forEach( function( e ) {
                var seq = e.sequence ? ' · #' + escapeAttr( String( e.sequence ) ) : ''
                // PRD-018 US-2: lift the primary type (memo-init) above the nachrangige rest.
                var primary = isPrimaryTranscriptType( e.type )
                var entryCls = primary ? 'transcript-entry transcript-entry-primary' : 'transcript-entry'
                var badgeCls = primary ? 'transcript-type-badge transcript-type-badge-primary' : 'transcript-type-badge'
                html += '<div class="' + entryCls + '" data-transcript-id="' + escapeAttr( e.transcriptId ) + '" data-type="' + escapeAttr( e.type ) + '" title="' + escapeAttr( e.origin ) + '" style="padding:4px 4px;cursor:pointer;border-bottom:1px solid var(--border,#222)' + ( primary ? ';border-left:2px solid #4493f8' : '' ) + '">'
                html += '<div style="font-size:12px">' + escapeAttr( e.label ) + seq + '</div>'
                html += '<div style="font-size:10px;color:var(--text-muted)"><span class="' + badgeCls + '">' + escapeAttr( transcriptTypeLabel( e.type ) ) + '</span> · ' + escapeAttr( e.origin ) + '</div>'
                // PRD-012: transform action only for free transcripts (frei -> memo-init).
                if( e.canTransform ) {
                    html += '<button class="transcript-transform-btn" data-transcript-id="' + escapeAttr( e.transcriptId ) + '" title="Freies Transcript als Quelle fuer ein neues Memo verwenden (Re-Injection)" style="margin-top:4px;font-size:10px;padding:2px 6px;cursor:pointer">Als Memo-Init verwenden</button>'
                }
                html += '</div>'
            } )
            listEl.innerHTML = html

            listEl.querySelectorAll( '.transcript-entry' ).forEach( function( el ) {
                el.addEventListener( 'click', function() {
                    var transcriptId = el.getAttribute( 'data-transcript-id' )
                    if( transcriptId ) { loadTranscriptIntoContent( transcriptId ) }
                } )
            } )

            // PRD-012: trigger the frei -> memo-init transformation. stopPropagation so the
            // entry-click (load into content) does not also fire.
            listEl.querySelectorAll( '.transcript-transform-btn' ).forEach( function( btn ) {
                btn.addEventListener( 'click', function( ev ) {
                    ev.stopPropagation()
                    var transcriptId = btn.getAttribute( 'data-transcript-id' )
                    if( transcriptId ) { transformTranscriptToMemoInit( transcriptId, btn ) }
                } )
            } )
        }

        // PRD-008: fetch a single transcript (the server-side header carries the
        // type-specific injection text) and render it in the middle content area.
        async function loadTranscriptIntoContent( transcriptId ) {
            if( !contentEl ) { return }
            try {
                var resp = await fetch( '/api/transcripts/' + transcriptId )
                if( !resp.ok ) {
                    contentEl.innerHTML = '<p style="color:#f85149">Transcript konnte nicht geladen werden.</p>'
                    return
                }
                var raw = await resp.text()
                renderTranscriptContent( { transcriptId: transcriptId, raw: raw } )
            } catch {
                contentEl.innerHTML = '<p style="color:#f85149">Transcript konnte nicht geladen werden.</p>'
            }
        }

        // PRD-008: split the fetched markdown at the "## Transcript-Inhalt" marker. The part
        // BEFORE the marker is the server-injected type-specific header (the prompt-injection,
        // Phase-1 templates); the part AFTER is the transcript content. Both are rendered
        // clearly separated (injection labelled, content below) — Soll (injection) vs Ist.
        function renderTranscriptContent( opts ) {
            opts = opts || {}
            var raw = opts.raw || ''
            var marker = '## Transcript-Inhalt'
            var markerIdx = raw.indexOf( marker )
            var injectionMd = markerIdx === -1 ? raw : raw.slice( 0, markerIdx )
            var bodyMd = markerIdx === -1 ? '' : raw.slice( markerIdx + marker.length )

            // Derive the type from the injected header's first line (matches the server
            // TYPE_TEMPLATES). Falls back to "frei" when no known header line is present.
            var firstLine = raw.split( '\\n' )[ 0 ] || ''
            var type = 'frei'
            if( /^# Transcript zu Memo /.test( firstLine ) ) { type = 'revision' }
            else if( /^# Transcript fuer neues Memo /.test( firstLine ) ) { type = 'memo-init' }
            else if( /^# Transcript fuer Plan-Start /.test( firstLine ) ) { type = 'plan-start' }
            else if( /^# Transcript \\(frei/.test( firstLine ) ) { type = 'frei' }

            var meta = transcriptTypeMeta[ type ] || { label: type, context: '' }

            // PRD-006 (Kap 9, AC-03/AC-04): for a "Memo" transcript the confirmed answers
            // were persisted as "## Antwort auf F{N} — ..." blocks inside the content. On
            // reopen they must reappear as a dedicated, immutable section at the END of the
            // view (not silently buried in the body). splitAnswerBlocks separates them.
            var split = splitAnswerBlocks( bodyMd.trim() )

            var html = '<div class="transcript-view">'
            html += '<div class="transcript-injection" style="border:1px solid var(--border,#30363d);border-left:3px solid #4493f8;border-radius:6px;padding:10px 12px;margin-bottom:16px;background:rgba(68,147,248,0.06)">'
            html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#4493f8;margin-bottom:6px">Injizierter Prompt · Typ: ' + escapeAttr( meta.label ) + ( meta.context ? ' · ' + escapeAttr( meta.context ) : '' ) + '</div>'
            html += '<div class="transcript-injection-body">' + marked.parse( injectionMd ) + '</div>'
            html += '</div>'
            html += '<div class="transcript-body">'
            html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:6px">Transcript-Inhalt</div>'
            html += marked.parse( split.bodyWithoutAnswers )
            html += '</div>'

            // AC-04: the re-attached answered-questions section. Rendered read-only at the
            // bottom — type "Memo" only, and only when answers actually exist.
            if( type === 'memo-init' && split.answersMd.trim().length > 0 ) {
                html += '<div class="transcript-answers" id="transcript-answers" style="border:1px solid var(--border,#30363d);border-left:3px solid #3fb950;border-radius:6px;padding:10px 12px;margin-top:16px;background:rgba(63,185,80,0.06)">'
                html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#3fb950;margin-bottom:6px">Beantwortete Fragen (angehängt · unveränderlich)</div>'
                html += '<div class="transcript-answers-body">' + marked.parse( split.answersMd.trim() ) + '</div>'
                html += '</div>'
            }

            html += '</div>'

            contentEl.innerHTML = html
        }

        // PRD-006 (Kap 9, AC-04): split persisted "## Antwort auf F{N} ..." answer blocks out
        // of the transcript body so they can be re-attached as a dedicated section. Returns
        // the body with those blocks removed plus the answer markdown collected separately.
        function splitAnswerBlocks( bodyMd ) {
            var text = String( bodyMd || '' )
            var lines = text.split( '\\n' )
            var bodyLines = []
            var answerLines = []
            var inAnswer = false

            lines.forEach( function( line ) {
                var isAnswerHeading = /^##\\s+Antwort auf\\s+F\\d+/.test( line )
                if( isAnswerHeading ) { inAnswer = true }
                else if( /^##\\s/.test( line ) ) { inAnswer = false }

                if( inAnswer ) { answerLines.push( line ) }
                else { bodyLines.push( line ) }
            } )

            return {
                bodyWithoutAnswers: bodyLines.join( '\\n' ).trim(),
                answersMd: answerLines.join( '\\n' )
            }
        }

        // PRD-012: transform a free transcript into a memo-init transcript (Re-Injection).
        // Calls POST /api/other/transcripts/{id}/transform, then refreshes the view so the
        // type badge + injection header reflect the new memo-init type.
        async function transformTranscriptToMemoInit( transcriptId, btn ) {
            if( btn ) { btn.disabled = true }
            try {
                var resp = await fetch( '/api/other/transcripts/' + transcriptId + '/transform', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( { targetType: 'memo-init' } )
                } )
                var data = await resp.json()
                if( !resp.ok ) {
                    if( btn ) {
                        btn.disabled = false
                        btn.textContent = 'Fehler — erneut versuchen'
                    }

                    return
                }
                // Refresh the sidebar lists + indicators, then load the transformed content.
                renderSidebarTranscripts()
                loadTranscriptIntoContent( transcriptId )
            } catch {
                if( btn ) {
                    btn.disabled = false
                    btn.textContent = 'Fehler — erneut versuchen'
                }
            }
        }

        // PRD-011 (#4): the memo-head .transcript-indicator is the AGGREGATE (lose) display —
        // it shows the memo-weite count + the memo's latest transcript. This is deliberately
        // distinct from the per-revision indicators rendered inline on each revision entry
        // (renderRevEntry via hasTranscriptForRevision). Aggregate here, per-revision there.
        function updateTranscriptIndicators() {
            var tree = lastTranscriptTree || {}
            var allIndicators = document.querySelectorAll( '.transcript-indicator' )

            allIndicators.forEach( function( el ) {
                el.textContent = ''
                el.setAttribute( 'data-count', '0' )
                el.setAttribute( 'data-latest-url', '' )
                el.setAttribute( 'title', '' )
            } )

            Object.keys( tree ).forEach( function( projectId ) {
                var memos = tree[ projectId ] || {}
                Object.keys( memos ).forEach( function( memoId ) {
                    var transcripts = memos[ memoId ] || []
                    if( transcripts.length === 0 ) { return }
                    var docId = projectId + '--' + memoId
                    // Must be scoped to .transcript-indicator — the memo-head no longer renders
                    // that pill, and other elements (questions-link) share data-document-id.
                    var indicator = document.querySelector( '.transcript-indicator[data-document-id="' + docId + '"]' )
                    if( !indicator ) { return }
                    var count = transcripts.length
                    var latest = transcripts[ transcripts.length - 1 ]
                    // PRD-006 (#38): dezentes Wort/Icon statt "T·N" — Count bleibt im title.
                    indicator.textContent = '🗒 Transcript'
                    indicator.setAttribute( 'data-count', String( count ) )
                    indicator.setAttribute( 'data-latest-url', latest ? latest.url : '' )
                    indicator.setAttribute( 'title', latest ? count + ' Transcript(s) · Letztes: ' + latest.revisionId : '' )
                } )
            } )

            document.querySelectorAll( '.transcript-indicator' ).forEach( function( el ) {
                if( el.dataset.bound === '1' ) { return }
                el.dataset.bound = '1'
                el.addEventListener( 'click', function( ev ) {
                    ev.stopPropagation()
                    var url = el.getAttribute( 'data-latest-url' )
                    if( url ) { window.open( url, '_blank' ) }
                } )
                el.addEventListener( 'contextmenu', function( ev ) {
                    ev.preventDefault()
                    ev.stopPropagation()
                    var docId = el.getAttribute( 'data-document-id' )
                    if( !docId ) { return }
                    var url = el.getAttribute( 'data-latest-url' )
                    if( !url ) { return }
                    var tIdMatch = url.match( /\\/transcripts\\/(.+)$/ )
                    if( !tIdMatch ) { return }
                    var transcriptId = tIdMatch[ 1 ]
                    fetch( '/api/transcripts/' + transcriptId )
                        .then( function( r ) { return r.text() } )
                        .then( function( text ) {
                            var body = text.split( /## Transcript-Inhalt\\s*\\n+/ )[ 1 ] || ''
                            var parsed = transcriptId.split( '--' )
                            var lastPart = parsed[ parsed.length - 1 ]
                            var hasSeq = /^\\d+$/.test( lastPart )
                            var revisionId = hasSeq ? parsed[ parsed.length - 2 ] : parsed[ parsed.length - 1 ]
                            var memoEndIdx = hasSeq ? parsed.length - 2 : parsed.length - 1
                            var projectId = parsed[ 0 ]
                            var memoId = parsed.slice( 1, memoEndIdx ).join( '--' )
                            openTranscriptModal( {
                                transcriptId: transcriptId,
                                projectId: projectId,
                                memoId: memoId,
                                revisionId: revisionId,
                                content: body.trim()
                            } )
                        } )
                } )
            } )
        }

        var modeTranscriptsBtn = document.getElementById( 'mode-transcripts' )
        var modeMemosBtn = document.getElementById( 'mode-memos' )
        var modePlansBtn = document.getElementById( 'mode-plans' )
        var transcriptNavBtn = document.getElementById( 'transcript-new' )
        var docSidebarEl = document.getElementById( 'doc-sidebar' )

        // NavBar chrome per active view (REV-05 R4/F6): the redundant "+ Neues Memo" /
        // "+ Neuer Plan" primary button was removed — "Transcript" bootstraps new memos,
        // plan creation is Memo-013 territory. Only the Transcript visibility + sidebar
        // mode class depend on the view now.
        function applyModeChrome() {
            if( currentMode === 'transcripts' ) {
                // Transcripts view: hide the "+ Transcript" bootstrap button (it belongs to
                // the memos view) and tag the sidebar so it can be styled per view.
                if( transcriptNavBtn ) { transcriptNavBtn.style.display = 'none' }
                if( docSidebarEl ) {
                    docSidebarEl.classList.remove( 'plans-mode' )
                    docSidebarEl.classList.add( 'transcripts-mode' )
                }
            } else if( currentMode === 'plans' ) {
                if( transcriptNavBtn ) { transcriptNavBtn.style.display = 'none' }
                if( docSidebarEl ) {
                    docSidebarEl.classList.remove( 'transcripts-mode' )
                    docSidebarEl.classList.add( 'plans-mode' )
                }
            } else {
                if( transcriptNavBtn ) { transcriptNavBtn.style.display = '' }
                if( docSidebarEl ) {
                    docSidebarEl.classList.remove( 'plans-mode' )
                    docSidebarEl.classList.remove( 'transcripts-mode' )
                }
            }
        }

        // PRD-006/011: apply a view mode (transcripts | memos | plans) without touching the
        // URL. setMode() couples it to the History-API route.
        function applyMode( mode ) {
            if( mode === 'transcripts' ) {
                currentMode = 'transcripts'
                if( modeTranscriptsBtn ) { modeTranscriptsBtn.classList.add( 'active' ) }
                if( modeMemosBtn ) { modeMemosBtn.classList.remove( 'active' ) }
                if( modePlansBtn ) { modePlansBtn.classList.remove( 'active' ) }
                applyModeChrome()
                renderSidebar()
            } else if( mode === 'plans' ) {
                currentMode = 'plans'
                if( modePlansBtn ) { modePlansBtn.classList.add( 'active' ) }
                if( modeMemosBtn ) { modeMemosBtn.classList.remove( 'active' ) }
                if( modeTranscriptsBtn ) { modeTranscriptsBtn.classList.remove( 'active' ) }
                applyModeChrome()
                renderSidebar()
            } else {
                currentMode = 'memos'
                if( modeMemosBtn ) { modeMemosBtn.classList.add( 'active' ) }
                if( modePlansBtn ) { modePlansBtn.classList.remove( 'active' ) }
                if( modeTranscriptsBtn ) { modeTranscriptsBtn.classList.remove( 'active' ) }
                applyModeChrome()
                renderSidebar()
                // Restore memo content when leaving the plan-trace view.
                if( lastContent ) {
                    slugCounts.clear()
                    contentEl.innerHTML = marked.parse( lastContent )
                    interceptLinks()
                    applyContentStructure()
                    renderVorwort( lastVorwort )
                    renderQuestionWidgets( lastQuestionSchema )
                    buildTOC( currentDiff )
                    updateSidebarSticky( currentMemoName, currentFileName )
                }
            }
        }

        // PRD-006/011: route <-> mode are kept consistent. /transcripts -> transcripts,
        // /plans -> plans, /memos (and default) -> memos (default lands on the current memo).
        // pushState updates the URL on user toggle; popstate restores the mode on back/forward.
        function modeForPath( pathname ) {
            if( pathname === '/transcripts' || pathname.indexOf( '/transcripts/' ) === 0 ) { return 'transcripts' }
            if( pathname === '/plans' || pathname.indexOf( '/plans/' ) === 0 ) { return 'plans' }
            return 'memos'
        }

        function pathForMode( mode ) {
            if( mode === 'transcripts' ) { return '/transcripts' }
            if( mode === 'plans' ) { return '/plans' }
            return '/memos'
        }

        function setMode( mode, options ) {
            var push = !options || options.push !== false
            applyMode( mode )
            if( push ) {
                var targetPath = pathForMode( mode )
                if( window.location.pathname !== targetPath ) {
                    window.history.pushState( { mode: mode }, '', targetPath )
                }
            }
        }

        if( modeMemosBtn && modePlansBtn ) {
            modeMemosBtn.addEventListener( 'click', function() { setMode( 'memos', { push: true } ) } )
            modePlansBtn.addEventListener( 'click', function() { setMode( 'plans', { push: true } ) } )
        }

        if( modeTranscriptsBtn ) {
            modeTranscriptsBtn.addEventListener( 'click', function() { setMode( 'transcripts', { push: true } ) } )
        }

        window.addEventListener( 'popstate', function( ev ) {
            var mode = ( ev.state && ev.state.mode ) ? ev.state.mode : modeForPath( window.location.pathname )
            applyMode( mode )
        } )

        // Initial route: derive the mode from the current path (default -> memos / current memo).
        ;( function initRoute() {
            var initialMode = modeForPath( window.location.pathname )
            window.history.replaceState( { mode: initialMode }, '', window.location.pathname )
            applyMode( initialMode )
        } )()

        applyModeChrome()

        var transcriptMode = { active: false, transcriptId: null, originalContent: null, tab: 'revision' }

        // PRD-002/003 (Memo 019 Kap 2+3): the Transcript-Button modal offers exactly two tabs —
        // 'new' (Memo erstellen) and 'add' (zum Memo hinzufügen). 'revision' is NOT a
        // Transcript-Button tab anymore (REV-03: ein Revisionsprompt entsteht nur aus der
        // Revision selbst); it is driven programmatically by the sticky-header / edit callers,
        // which hide the tab-bar and show the hidden #t-panel-revision panel.
        // PRD-008 (Memo 022 Kap 6): clear the field values of a specific transcript tab so its
        // state can never leak into the other tab's save path (onTranscriptSave branches on
        // transcriptMode.tab and reads #t2-* for 'new', #ta-* for 'add'). Pure value reset; the
        // DOM nodes / dropdown options stay intact.
        function clearTranscriptTabFields( tab ) {
            var ids = []
            if( tab === 'new' ) { ids = [ 't2-content' ] }
            if( tab === 'add' ) { ids = [ 'ta-content' ] }
            ids.forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.value = '' }
            } )
        }

        function switchTranscriptTab( tab ) {
            // PRD-008: isolate the now-inactive tab. Switching away from 'new'/'add' clears the
            // OTHER tab's free-text field so the save path only ever reads the active tab's input.
            var previousTab = transcriptMode.tab
            if( previousTab === 'new' && tab !== 'new' ) { clearTranscriptTabFields( 'new' ) }
            if( previousTab === 'add' && tab !== 'add' ) { clearTranscriptTabFields( 'add' ) }
            transcriptMode.tab = tab
            var tabsBar = document.getElementById( 't-tabs' )
            var tabNew = document.getElementById( 't-tab-new' )
            var tabAdd = document.getElementById( 't-tab-add' )
            var panelRevision = document.getElementById( 't-panel-revision' )
            var panelNew = document.getElementById( 't-panel-new' )
            var panelAdd = document.getElementById( 't-panel-add' )
            var isRevision = tab === 'revision'
            var isNew = tab === 'new'
            var isAdd = tab === 'add'
            // Tab-bar is only shown for the two Transcript-Button actions.
            if( tabsBar ) { tabsBar.classList.toggle( 't-hidden', isRevision ) }
            if( tabNew ) { tabNew.classList.toggle( 'active', isNew ) }
            if( tabAdd ) { tabAdd.classList.toggle( 'active', isAdd ) }
            if( panelRevision ) { panelRevision.classList.toggle( 't-hidden', !isRevision ) }
            if( panelNew ) { panelNew.classList.toggle( 't-hidden', !isNew ) }
            if( panelAdd ) { panelAdd.classList.toggle( 't-hidden', !isAdd ) }
            updateTranscriptSaveState()
            // PRD-003 (Memo 024 Kap 3): the word counter is tab-aware — on every tab switch it
            // re-reads the now-active textarea so it shows the active tab's numbers, not a stale tab.
            updateTranscriptWordCount()
        }

        // PRD-002/003: fill a <select> with the namespace keys from lastTree. Returns the
        // number of namespaces so callers can fall back when none exist.
        function fillNamespaceSelect( selectEl ) {
            if( !selectEl ) { return { count: 0 } }
            var groups = allMemosByNamespace()
            var keys = Object.keys( groups )
            selectEl.innerHTML = ''
            keys.forEach( function( ns ) {
                var opt = document.createElement( 'option' )
                opt.value = ns
                opt.textContent = ns
                selectEl.appendChild( opt )
            } )

            return { count: keys.length }
        }

        // PRD-003: memos of a namespace, sorted newest first (highest revision number, then
        // mtime). Drives the #ta-memo dropdown after a namespace is chosen.
        function memosForNamespaceNewestFirst( namespace ) {
            var groups = allMemosByNamespace()
            var memos = ( groups[ namespace ] || [] ).slice()
            memos.sort( function( a, b ) {
                var ra = highestRevisionNumber( a )
                var rb = highestRevisionNumber( b )
                if( ra !== rb ) { return rb - ra }
                var ma = a.mtime ? Date.parse( a.mtime ) : 0
                var mb = b.mtime ? Date.parse( b.mtime ) : 0

                return mb - ma
            } )

            return memos
        }

        function highestRevisionNumber( memo ) {
            var revs = ( memo && memo.revisions ) ? memo.revisions : []
            var highest = 0
            revs.forEach( function( r ) {
                var m = ( r.fileName || '' ).match( /REV-(\\d+)/ )
                if( m ) {
                    var n = parseInt( m[ 1 ], 10 )
                    if( n > highest ) { highest = n }
                }
            } )

            return highest
        }

        // PRD-003: (re)fill the #ta-memo dropdown for the currently selected namespace, newest
        // first. Each option carries the memoName, memoPath and documentId so the save call can
        // resolve the target folder without a re-lookup.
        function fillAddMemoSelect() {
            var nsSelect = document.getElementById( 'ta-namespace' )
            var memoSelect = document.getElementById( 'ta-memo' )
            if( !nsSelect || !memoSelect ) { return }
            var namespace = nsSelect.value || ''
            var memos = memosForNamespaceNewestFirst( namespace )
            memoSelect.innerHTML = ''
            memos.forEach( function( m ) {
                var opt = document.createElement( 'option' )
                opt.value = m.memoName || ''
                opt.textContent = m.memoName || ''
                if( typeof m.memoPath === 'string' ) { opt.setAttribute( 'data-memo-path', m.memoPath ) }
                memoSelect.appendChild( opt )
            } )
            updateTranscriptSaveState()
        }

        // PRD-007 (#44): footer word/minute counter for the transcript textarea.
        // Mirrors the estimate used in updateSidebarSticky (~200 Wörter/Min).
        // PRD-003 (Memo 024 Kap 3): resolve the textarea of the currently active Transcript tab.
        // The shared #t-wordcount footer must reflect the tab the user is actually typing in:
        // 'new' -> #t2-content, 'add' -> #ta-content, otherwise the revision field #t-content.
        function activeTranscriptContentEl() {
            var tab = transcriptMode.tab
            var id = tab === 'new' ? 't2-content' : ( tab === 'add' ? 'ta-content' : 't-content' )

            return document.getElementById( id )
        }

        function updateTranscriptWordCount() {
            var contentArea = activeTranscriptContentEl()
            var el = document.getElementById( 't-wordcount' )
            if( !contentArea || !el ) { return }
            var plain = ( contentArea.value || '' ).replace( /[^A-Za-zÀ-ÿ0-9]+/g, ' ' ).trim()
            var words = plain.length === 0
                ? 0
                : plain.split( /\\s+/ ).filter( function( t ) { return t.length > 0 } ).length
            var minutes = words === 0 ? 0 : Math.ceil( words / 200 )
            // PRD-019 (Memo 016 Kap 7.4): label as the transcript length, consistent with the
            // sticky-header read-out, so the count is never mistaken for a user-typed value.
            el.textContent = 'Transcript: ' + words.toLocaleString( 'de-DE' ) + ' Wörter · ' + minutes + ' Min'
        }

        function openTranscriptModal( opts ) {
            opts = opts || {}
            transcriptMode.active = true
            transcriptMode.transcriptId = opts.transcriptId || null
            var modal = document.getElementById( 'transcript-modal' )
            var title = document.querySelector( '#transcript-modal .t-title' )
            var projectInput = document.getElementById( 't-project' )
            var memoInput = document.getElementById( 't-memo' )
            var revisionInput = document.getElementById( 't-revision' )
            var contentArea = document.getElementById( 't-content' )
            var savedState = document.getElementById( 't-saved-state' )
            var errorBox = document.getElementById( 't-error' )
            var urlBox = document.getElementById( 't-url-box' )

            errorBox.classList.add( 't-hidden' )
            savedState.classList.add( 't-hidden' )
            if( urlBox ) {
                urlBox.textContent = '🔗 URL erscheint erst nach dem Speichern'
                urlBox.classList.remove( 'has-url' )
            }

            // PRD-008: a plain Transcript-Button open must never show leftover "Prompt bearbeiten"
            // UI. Hide the combined prompt panel/footer and restore the default transcript footer.
            ;[ 't-panel-prompt', 'pp-footer' ].forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.classList.add( 't-hidden' ) }
            } )
            ;[ 't-url-box', 't-actions-default', 't-footnote-default' ].forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.classList.remove( 't-hidden' ) }
            } )

            var projectId = ''
            var memoId = ''
            var nextRevision = 'REV-01'

            if( opts.transcriptId ) {
                if( title ) { title.textContent = 'Transcript bearbeiten' }
                projectInput.readOnly = true
                memoInput.readOnly = true
                revisionInput.readOnly = true
            } else {
                if( title ) { title.textContent = 'Transcript hinzufügen' }
                projectInput.readOnly = true
                memoInput.readOnly = true
                revisionInput.readOnly = false

                var docs = []
                Object.keys( lastTree ).forEach( function( pId ) {
                    var node = lastTree[ pId ]
                    var memos = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                    memos.forEach( function( m ) {
                        docs.push( { projectId: pId, doc: m } )
                    } )
                } )

                var current = null
                docs.forEach( function( entry ) {
                    if( !current && entry.doc.selectedRevision ) {
                        current = entry
                    }
                } )

                if( !current && docs.length > 0 ) {
                    current = docs[ 0 ]
                }

                if( current ) {
                    projectId = current.projectId
                    memoId = current.doc.memoName
                    var revs = current.doc.revisions || []
                    var highest = 0
                    revs.forEach( function( r ) {
                        var m = r.fileName.match( /REV-(\\d+)/ )
                        if( m ) {
                            var n = parseInt( m[ 1 ], 10 )
                            if( n > highest ) { highest = n }
                        }
                    } )
                    nextRevision = 'REV-' + String( highest + 1 ).padStart( 2, '0' )
                }
            }

            projectInput.value = opts.projectId || projectId
            memoInput.value = opts.memoId || memoId
            revisionInput.value = opts.revisionId || nextRevision
            contentArea.value = opts.content || ''
            // PRD-007 (#44): seed the footer word/minute counter from the opened content.
            updateTranscriptWordCount()

            // PRD-002 (Memo 019 Kap 2): reset + fill the "Memo erstellen" namespace dropdown.
            var t2Namespace = document.getElementById( 't2-namespace' )
            var t2Content = document.getElementById( 't2-content' )
            fillNamespaceSelect( t2Namespace )
            if( t2Content ) { t2Content.value = '' }

            // PRD-003 (Memo 019 Kap 3): reset + fill the "zum Memo hinzufügen" dropdowns.
            var taNamespace = document.getElementById( 'ta-namespace' )
            var taContent = document.getElementById( 'ta-content' )
            fillNamespaceSelect( taNamespace )
            fillAddMemoSelect()
            if( taContent ) { taContent.value = '' }

            // PRD-018: dedupe baseline — the content present at open time is the "unchanged" state.
            transcriptMode.originalContent = opts.content || ''

            // PRD-002/003: callers that pass a transcriptId, an explicit revisionId, or seed
            // content (sidebar-edit / sticky-header / "+Frage") drive the programmatic
            // revision mode. The Transcript-Button (empty opts) defaults to the "Memo
            // erstellen" tab — it never opens a revision-anlegen action (REV-03).
            var revisionMode = !!( opts.transcriptId || opts.revisionId || ( opts.content && opts.content.length > 0 ) )
            switchTranscriptTab( revisionMode ? 'revision' : 'new' )

            modal.classList.remove( 't-hidden' )
            if( revisionMode ) {
                contentArea.focus()
            } else {
                if( t2Content ) { t2Content.focus() }
            }
        }

        function updateTranscriptSaveState() {
            var saveBtn = document.getElementById( 't-save' )
            if( !saveBtn ) { return }

            if( transcriptMode.tab === 'new' ) {
                // PRD-002 (Memo 019 Kap 2): require a chosen Namespace (dropdown) + Bootstrap-Text.
                var nsInput = document.getElementById( 't2-namespace' )
                var t2Content = document.getElementById( 't2-content' )
                var hasNamespace = !!( nsInput && nsInput.value && nsInput.value.trim().length > 0 )
                var newContent = t2Content ? t2Content.value : ''
                var newEmpty = newContent.trim().length === 0
                saveBtn.disabled = !hasNamespace || newEmpty
                if( saveBtn.disabled ) {
                    saveBtn.title = !hasNamespace ? 'Namespace erforderlich' : 'Bootstrap-Text erforderlich'
                } else {
                    saveBtn.title = ''
                }

                return
            }

            if( transcriptMode.tab === 'add' ) {
                // PRD-003 (Memo 019 Kap 3): require Namespace + Memo (dropdowns) + non-empty content.
                var aNs = document.getElementById( 'ta-namespace' )
                var aMemo = document.getElementById( 'ta-memo' )
                var aContent = document.getElementById( 'ta-content' )
                var hasNs = !!( aNs && aNs.value && aNs.value.trim().length > 0 )
                var hasMemoSel = !!( aMemo && aMemo.value && aMemo.value.trim().length > 0 )
                var addContent = aContent ? aContent.value : ''
                var addEmpty = addContent.trim().length === 0
                saveBtn.disabled = !hasNs || !hasMemoSel || addEmpty
                if( saveBtn.disabled ) {
                    saveBtn.title = !hasNs ? 'Namespace erforderlich' : ( !hasMemoSel ? 'Memo erforderlich' : 'Inhalt erforderlich' )
                } else {
                    saveBtn.title = ''
                }

                return
            }

            var memoInput = document.getElementById( 't-memo' )
            var contentArea = document.getElementById( 't-content' )
            var hasMemo = !!( memoInput && memoInput.value && memoInput.value.trim().length > 0 )
            var content = contentArea ? contentArea.value : ''
            // Dedupe: unchanged content vs. baseline disables save (PRD-018 #5).
            var unchanged = transcriptMode.originalContent !== null
                && content.trim() === ( transcriptMode.originalContent || '' ).trim()
            var empty = content.trim().length === 0

            saveBtn.disabled = !hasMemo || unchanged || empty
            if( saveBtn.disabled ) {
                saveBtn.title = !hasMemo ? 'Memo-Bezug erforderlich' : ( empty ? 'Inhalt erforderlich' : 'Inhalt unveraendert' )
            } else {
                saveBtn.title = ''
            }
        }

        function closeTranscriptModal() {
            transcriptMode.active = false
            transcriptMode.transcriptId = null
            document.getElementById( 'transcript-modal' ).classList.add( 't-hidden' )

            // PRD-008 (Memo 022 Kap 6): on close, reset ALL transcript tab fields so a re-open
            // never shows stale content from a previous session. Textareas -> empty value;
            // selects -> first option (selectedIndex 0). DOM nodes / option lists stay intact.
            ;[ 't2-content', 'ta-content' ].forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.value = '' }
            } )
            ;[ 't2-namespace', 'ta-namespace', 'ta-memo' ].forEach( function( id ) {
                var sel = document.getElementById( id )
                if( sel && sel.options && sel.options.length > 0 ) { sel.selectedIndex = 0 }
            } )

            // PRD-008: when the popup was in "Prompt bearbeiten" mode, restore the default
            // transcript layout so the next plain Transcript-Button open is unaffected.
            if( transcriptMode.tab === 'prompt' ) {
                var ppFooter = document.getElementById( 'pp-footer' )
                var ppPanel = document.getElementById( 't-panel-prompt' )
                if( ppFooter ) { ppFooter.classList.add( 't-hidden' ) }
                if( ppPanel ) { ppPanel.classList.add( 't-hidden' ) }
                ;[ 't-url-box', 't-actions-default', 't-footnote-default' ].forEach( function( id ) {
                    var el = document.getElementById( id )
                    if( el ) { el.classList.remove( 't-hidden' ) }
                } )
                transcriptMode.tab = 'revision'
            }
        }

        // PRD-031: surface the saved URL AND auto-copy it to the clipboard right away,
        // so the link can never be lost in the in-between step. Clipboard write is
        // best-effort: a failure must never hide the saved state or throw.
        async function showTranscriptSavedUrl( finalUrl ) {
            var savedState = document.getElementById( 't-saved-state' )
            var savedUrlEl = document.getElementById( 't-saved-url' )
            savedUrlEl.textContent = finalUrl
            savedState.classList.remove( 't-hidden' )

            var urlBox = document.getElementById( 't-url-box' )
            if( urlBox ) {
                urlBox.textContent = '🔗 ' + finalUrl
                urlBox.classList.add( 'has-url' )
            }

            // Auto-copy: the saved-state stays visible regardless of clipboard outcome.
            var hint = document.getElementById( 't-autocopy-hint' )
            try {
                await navigator.clipboard.writeText( finalUrl )
                if( hint ) {
                    hint.textContent = '✓ URL bereits in die Zwischenablage kopiert'
                    hint.classList.remove( 't-hidden' )
                }
            } catch {
                if( hint ) {
                    hint.textContent = 'Bitte URL manuell kopieren'
                    hint.classList.remove( 't-hidden' )
                }
            }
        }

        async function saveTranscript() {
            // Tab-Weiche: 'new' -> Memo erstellen (memo-init), 'add' -> zum Memo hinzufügen (frei),
            // sonst (programmatic revision mode) -> /api/transcripts.
            if( transcriptMode.tab === 'new' ) {
                await saveNewMemoTranscript()

                return
            }

            if( transcriptMode.tab === 'add' ) {
                await saveFreeMemoTranscript()

                return
            }

            var errorBox = document.getElementById( 't-error' )

            errorBox.classList.add( 't-hidden' )

            var projectId = document.getElementById( 't-project' ).value
            var memoId = document.getElementById( 't-memo' ).value
            var revisionId = document.getElementById( 't-revision' ).value
            var content = document.getElementById( 't-content' ).value

            // PRD-006 (Kap 9, AC-03): the confirmed question answers (st.addedText) must be
            // saved together with the transcript on the NORMAL save path too — not only via
            // "ohne Transcript speichern". Append them so a reopened "Memo" transcript can
            // re-attach the answered-questions section (AC-04).
            content = appendAddedAnswers( content )

            if( !/^REV-\\d{2,}$/.test( revisionId ) ) {
                errorBox.textContent = 'Revision-Format: REV-XX (mind. 2 Ziffern)'
                errorBox.classList.remove( 't-hidden' )

                return
            }

            try {
                var isUpdate = !!transcriptMode.transcriptId
                var url = isUpdate
                    ? '/api/transcripts/' + transcriptMode.transcriptId
                    : '/api/transcripts'
                var method = isUpdate ? 'PUT' : 'POST'
                var body = isUpdate
                    ? JSON.stringify( { content: content } )
                    : JSON.stringify( { projectId: projectId, memoId: memoId, revisionId: revisionId, content: content } )

                var resp = await fetch( url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: body
                } )
                var data = await resp.json()

                if( !resp.ok ) {
                    errorBox.textContent = data.error || 'Server-Fehler'
                    errorBox.classList.remove( 't-hidden' )

                    return
                }

                var finalUrl = isUpdate
                    ? window.location.origin + '/transcripts/' + transcriptMode.transcriptId
                    : data.url

                await showTranscriptSavedUrl( finalUrl )

                // After save the current content becomes the new baseline -> dedupe greys save again.
                transcriptMode.originalContent = content
                updateTranscriptSaveState()
            } catch( err ) {
                errorBox.textContent = 'Netzwerkfehler: ' + err.message
                errorBox.classList.remove( 't-hidden' )
            }
        }

        // PRD-002 (Memo 019 Kap 2): "Memo erstellen" — the user only picks the Namespace
        // (dropdown); the memo number / Ablageort is decided later by the AI (next = max+1).
        // The transcript is saved with type 'memo-init' so it carries the memo-init default
        // header (no number, no path) — a single atomic write via /api/other/transcripts.
        async function saveNewMemoTranscript() {
            var errorBox = document.getElementById( 't-error' )
            var nsInput = document.getElementById( 't2-namespace' )
            var contentInput = document.getElementById( 't2-content' )

            errorBox.classList.add( 't-hidden' )

            var projectId = nsInput ? nsInput.value.trim() : ''
            var content = contentInput ? contentInput.value : ''

            if( projectId.length === 0 ) {
                errorBox.textContent = 'Namespace ist ein Pflichtfeld'
                errorBox.classList.remove( 't-hidden' )

                return
            }

            try {
                var resp = await fetch( '/api/other/transcripts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( { projectId: projectId, content: content, type: 'memo-init' } )
                } )
                var data = await resp.json()

                if( !resp.ok ) {
                    errorBox.textContent = data.error || 'Server-Fehler'
                    errorBox.classList.remove( 't-hidden' )

                    return
                }

                var finalUrl = data.url || ( window.location.origin + '/transcripts/' + data.transcriptId )
                await showTranscriptSavedUrl( finalUrl )
            } catch( err ) {
                errorBox.textContent = 'Netzwerkfehler: ' + err.message
                errorBox.classList.remove( 't-hidden' )
            }
        }

        // PRD-003 (Memo 019 Kap 3): "zum Memo hinzufügen" — append a FREE transcript to an
        // existing memo. Namespace + Memo come from the two dropdowns; the memoPath is taken
        // from the selected option (sourced from lastTree). POST /api/memo/transcripts stores
        // a frei-typed, fortlaufend nummerierte Datei im transcripts/-Ordner des Memos.
        async function saveFreeMemoTranscript() {
            var errorBox = document.getElementById( 't-error' )
            var nsInput = document.getElementById( 'ta-namespace' )
            var memoInput = document.getElementById( 'ta-memo' )
            var contentInput = document.getElementById( 'ta-content' )

            errorBox.classList.add( 't-hidden' )

            var projectId = nsInput ? nsInput.value.trim() : ''
            var memoId = memoInput ? memoInput.value.trim() : ''
            var content = contentInput ? contentInput.value : ''
            var selectedOption = ( memoInput && memoInput.selectedIndex >= 0 ) ? memoInput.options[ memoInput.selectedIndex ] : null
            var memoPath = selectedOption ? selectedOption.getAttribute( 'data-memo-path' ) : null

            if( projectId.length === 0 ) {
                errorBox.textContent = 'Namespace ist ein Pflichtfeld'
                errorBox.classList.remove( 't-hidden' )

                return
            }

            if( memoId.length === 0 ) {
                errorBox.textContent = 'Memo ist ein Pflichtfeld'
                errorBox.classList.remove( 't-hidden' )

                return
            }

            try {
                var payload = { projectId: projectId, memoId: memoId, content: content }
                if( memoPath ) { payload.memoPath = memoPath }

                var resp = await fetch( '/api/memo/transcripts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( payload )
                } )
                var data = await resp.json()

                if( !resp.ok ) {
                    errorBox.textContent = data.error || 'Server-Fehler'
                    errorBox.classList.remove( 't-hidden' )

                    return
                }

                var finalUrl = data.url || ( window.location.origin + '/transcripts/' + data.transcriptId )
                await showTranscriptSavedUrl( finalUrl )
            } catch( err ) {
                errorBox.textContent = 'Netzwerkfehler: ' + err.message
                errorBox.classList.remove( 't-hidden' )
            }
        }

        // PRD-032: single source of truth for writing the saved URL to the clipboard.
        // Both the prominent button (#t-copy) and the inline icon (#t-copy-inline)
        // call this — no duplicated writeText logic.
        async function writeSavedTranscriptUrlToClipboard() {
            var savedUrlEl = document.getElementById( 't-saved-url' )
            var urlText = savedUrlEl.textContent
            await navigator.clipboard.writeText( urlText )

            return { url: urlText }
        }

        async function copyTranscriptUrl() {
            var copyBtn = document.getElementById( 't-copy' )
            try {
                await writeSavedTranscriptUrlToClipboard()
                var original = copyBtn.textContent
                copyBtn.textContent = 'Kopiert!'
                setTimeout( function() {
                    copyBtn.textContent = original
                }, 2000 )
            } catch {
                copyBtn.textContent = 'Fehler — bitte manuell kopieren'
            }
        }

        // PRD-032: inline-icon copy — same clipboard logic, icon-bound feedback.
        async function copyTranscriptUrlInline() {
            var inlineBtn = document.getElementById( 't-copy-inline' )
            try {
                await writeSavedTranscriptUrlToClipboard()
                var originalTitle = inlineBtn.title
                inlineBtn.textContent = '✓'
                inlineBtn.title = 'Kopiert!'
                setTimeout( function() {
                    inlineBtn.textContent = '⧉'
                    inlineBtn.title = originalTitle
                }, 2000 )
            } catch {
                inlineBtn.title = 'Fehler — bitte manuell kopieren'
            }
        }

        var newTranscriptBtn = document.getElementById( 'transcript-new' )
        if( newTranscriptBtn ) {
            newTranscriptBtn.addEventListener( 'click', function() {
                openTranscriptModal( {} )
            } )
        }

        var saveBtn = document.getElementById( 't-save' )
        if( saveBtn ) { saveBtn.addEventListener( 'click', saveTranscript ) }

        // PRD-018: re-evaluate dedupe/required state on every edit.
        var tContentEl = document.getElementById( 't-content' )
        if( tContentEl ) {
            tContentEl.addEventListener( 'input', updateTranscriptSaveState )
            // PRD-007 (#44): live word/minute counter while typing.
            tContentEl.addEventListener( 'input', updateTranscriptWordCount )
            // PRD-028: once a real transcript text is entered, "ohne Transcript speichern"
            // must disable itself (the normal Speichern path takes over).
            tContentEl.addEventListener( 'input', updateSaveAnswersOnlyState )
        }
        var tMemoEl = document.getElementById( 't-memo' )
        if( tMemoEl ) { tMemoEl.addEventListener( 'input', updateTranscriptSaveState ) }

        // PRD-002/003: tab switching — the Transcript-Button modal offers exactly two tabs:
        // 'new' (Memo erstellen) and 'add' (zum Memo hinzufügen). "Revision anlegen" was
        // removed as a Transcript-Button action (REV-03).
        var tTabNewEl = document.getElementById( 't-tab-new' )
        if( tTabNewEl ) { tTabNewEl.addEventListener( 'click', function() { switchTranscriptTab( 'new' ) } ) }
        var tTabAddEl = document.getElementById( 't-tab-add' )
        if( tTabAddEl ) { tTabAddEl.addEventListener( 'click', function() { switchTranscriptTab( 'add' ) } ) }

        // PRD-002: "Memo erstellen" required-state listeners (Namespace-Dropdown + Bootstrap-Text).
        var t2NamespaceEl = document.getElementById( 't2-namespace' )
        if( t2NamespaceEl ) { t2NamespaceEl.addEventListener( 'change', updateTranscriptSaveState ) }
        var t2ContentEl = document.getElementById( 't2-content' )
        if( t2ContentEl ) {
            t2ContentEl.addEventListener( 'input', updateTranscriptSaveState )
            // PRD-003 (Memo 024 Kap 3): the "neues Memo"-Tab must also drive the live word counter.
            t2ContentEl.addEventListener( 'input', updateTranscriptWordCount )
        }

        // PRD-003: "zum Memo hinzufügen" listeners — namespace change refills the memo dropdown
        // (newest first); memo + content changes re-evaluate the save state.
        var taNamespaceEl = document.getElementById( 'ta-namespace' )
        if( taNamespaceEl ) { taNamespaceEl.addEventListener( 'change', fillAddMemoSelect ) }
        var taMemoEl = document.getElementById( 'ta-memo' )
        if( taMemoEl ) { taMemoEl.addEventListener( 'change', updateTranscriptSaveState ) }
        var taContentEl = document.getElementById( 'ta-content' )
        if( taContentEl ) {
            taContentEl.addEventListener( 'input', updateTranscriptSaveState )
            // PRD-003 (Memo 024 Kap 3): the "hinzufügen"-Tab must also drive the live word counter.
            taContentEl.addEventListener( 'input', updateTranscriptWordCount )
        }

        // PRD-007 (#43): the "Abbrechen" button was removed — closing happens via the X
        // (#t-cancel-x) and the saved-state "Schliessen" button (#t-close).
        var cancelXBtn = document.getElementById( 't-cancel-x' )
        if( cancelXBtn ) { cancelXBtn.addEventListener( 'click', closeTranscriptModal ) }

        var copyBtn = document.getElementById( 't-copy' )
        if( copyBtn ) { copyBtn.addEventListener( 'click', copyTranscriptUrl ) }

        // PRD-032: inline copy icon next to the saved URL reuses the shared copy logic.
        var copyInlineBtn = document.getElementById( 't-copy-inline' )
        if( copyInlineBtn ) { copyInlineBtn.addEventListener( 'click', copyTranscriptUrlInline ) }

        var closeBtn = document.getElementById( 't-close' )
        if( closeBtn ) { closeBtn.addEventListener( 'click', closeTranscriptModal ) }

        // PRD-008 (Kap 9.5): the combined "Prompt bearbeiten" popup — Übernehmen writes back,
        // the live Min/Wörter counter updates while typing the transcript text.
        var ppApplyBtn = document.getElementById( 'pp-apply' )
        if( ppApplyBtn ) { ppApplyBtn.addEventListener( 'click', applyPromptEdit ) }
        var ppContentEl = document.getElementById( 'pp-content' )
        if( ppContentEl ) { ppContentEl.addEventListener( 'input', updatePromptTranscriptCount ) }

        // PRD-018: Plan-Popup — Memo-Auswahl required (nur finalisierte), Transcript optional, Plan-URL kopierbar.
        // PRD-041 (Memo 016 Kap 3): Mehrfachauswahl — selectedDocumentIds haelt mehrere finalisierte
        // Memos in Selektions-Reihenfolge (deterministisch). Klick togglet, deselektiert nichts anderes.
        var planMode = { selectedDocumentIds: [] }

        function openPlanModal() {
            planMode.selectedDocumentIds = []
            var modal = document.getElementById( 'plan-modal' )
            var errorBox = document.getElementById( 'p-error' )
            var savedState = document.getElementById( 'p-saved-state' )
            var searchInput = document.getElementById( 'p-search' )
            var transcriptInput = document.getElementById( 'p-transcript' )

            if( errorBox ) { errorBox.classList.add( 't-hidden' ) }
            if( savedState ) { savedState.classList.add( 't-hidden' ) }
            if( searchInput ) { searchInput.value = '' }
            if( transcriptInput ) { transcriptInput.value = '' }

            renderPlanMemoList( '' )
            updatePlanCreateState()
            modal.classList.remove( 't-hidden' )
            if( searchInput ) { searchInput.focus() }
        }

        function closePlanModal() {
            document.getElementById( 'plan-modal' ).classList.add( 't-hidden' )
        }

        function allMemosByNamespace() {
            // All memos grouped by namespace; finalized = selectable, others = greyed/not selectable.
            var groups = {}
            Object.keys( lastTree || {} ).forEach( function( projectId ) {
                var node = lastTree[ projectId ]
                var memos = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                memos.forEach( function( m ) {
                    if( !groups[ projectId ] ) { groups[ projectId ] = [] }
                    groups[ projectId ].push( m )
                } )
            } )
            return groups
        }

        function renderPlanMemoList( filter ) {
            var listEl = document.getElementById( 'p-memo-list' )
            if( !listEl ) { return }
            var groups = allMemosByNamespace()
            var needle = ( filter || '' ).toLowerCase()
            var html = ''
            var anyShown = false

            Object.keys( groups ).forEach( function( projectId ) {
                var memos = groups[ projectId ].filter( function( m ) {
                    return ( m.memoName || '' ).toLowerCase().indexOf( needle ) !== -1
                        || projectId.toLowerCase().indexOf( needle ) !== -1
                } )
                if( memos.length === 0 ) { return }
                anyShown = true
                html += '<div class="plan-ns-group">'
                html += '<div class="plan-ns-title">' + escapeAttr( projectId ) + '</div>'
                memos.forEach( function( m ) {
                    var isFinal = m.memoStatus === 'Finalisiert'
                    var isSel = isFinal && planMode.selectedDocumentIds.indexOf( m.documentId ) !== -1
                    var cls = 'plan-memo-option'
                    if( isSel ) { cls += ' selected' }
                    if( !isFinal ) { cls += ' not-final' }
                    var box = isSel ? '☑' : '☐'
                    var statusText = isFinal ? '✓ finalisiert' : 'nicht finalisiert'
                    html += '<div class="' + cls + '" data-document-id="' + escapeAttr( m.documentId ) + '" data-final="' + ( isFinal ? '1' : '0' ) + '">'
                    html += '<span class="pm-box">' + box + '</span>'
                    html += '<span>' + escapeAttr( m.memoName ) + '</span>'
                    html += '<span class="pm-status"> · ' + statusText + '</span>'
                    html += '</div>'
                } )
                html += '</div>'
            } )

            if( !anyShown ) {
                html = '<div class="plan-empty">Keine Memos verfuegbar.</div>'
            }

            listEl.innerHTML = html

            listEl.querySelectorAll( '.plan-memo-option' ).forEach( function( el ) {
                if( el.getAttribute( 'data-final' ) !== '1' ) { return }
                el.addEventListener( 'click', function() {
                    // PRD-041: toggle this option only — never deselect the others.
                    var docId = el.getAttribute( 'data-document-id' )
                    var idx = planMode.selectedDocumentIds.indexOf( docId )
                    if( idx === -1 ) {
                        planMode.selectedDocumentIds.push( docId )
                        el.classList.add( 'selected' )
                        var boxOn = el.querySelector( '.pm-box' )
                        if( boxOn ) { boxOn.textContent = '☑' }
                    } else {
                        planMode.selectedDocumentIds.splice( idx, 1 )
                        el.classList.remove( 'selected' )
                        var boxOff = el.querySelector( '.pm-box' )
                        if( boxOff ) { boxOff.textContent = '☐' }
                    }
                    updatePlanCreateState()
                } )
            } )
        }

        function updatePlanCreateState() {
            var createBtn = document.getElementById( 'p-create' )
            if( !createBtn ) { return }
            // PRD-041: active as soon as at least one finalized memo is selected.
            createBtn.disabled = planMode.selectedDocumentIds.length === 0
            createBtn.title = createBtn.disabled ? 'Memo-Auswahl erforderlich' : ''
        }

        function buildPlanUrlFor( documentId ) {
            // Plan-URL convention (Backend-Quelle PRD-014 / buildPlanUrl); shown + copyable after create.
            return window.location.origin + '/plans/' + encodeURIComponent( documentId )
        }

        function resolvePlanMemoPaths( documentIds ) {
            // PRD-042: map selected documentIds to their absolute memoPath from lastTree.
            // No invented/relative paths — only paths the registry actually surfaced.
            var byId = {}
            Object.keys( lastTree || {} ).forEach( function( projectId ) {
                var node = lastTree[ projectId ]
                var memos = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                memos.forEach( function( m ) {
                    if( m && m.documentId && typeof m.memoPath === 'string' ) {
                        byId[ m.documentId ] = m.memoPath
                    }
                } )
            } )
            return documentIds
                .map( function( id ) { return byId[ id ] } )
                .filter( function( p ) { return typeof p === 'string' && p.length > 0 } )
        }

        function buildPlanStartPrompt( memoPaths ) {
            // PRD-042 (Memo 016 Kap 3): mirror of TranscriptHeader.buildPlanStartPrompt (Node-side,
            // Jest-getestet). Ortfreier plan-start-Prompt — KEINE Plan-Nummer, KEIN Plan-Ziel,
            // KEIN Revisions-Feld; nur Skill-Bindung + absolute Pfade der ausgewaehlten Memos.
            // Newlines are written as escaped backslash-n so the outer HTML template literal collapses them correctly.
            var pathLines = memoPaths
                .map( function( p ) { return '- ' + p } )
                .join( '\\n' )
            return '# Transcript fuer Plan-Start (plan-start)\\n\\n'
                + 'Plan-Erstellung + Memo-Auswahl.\\n\\n'
                + 'Skill-Bindung:\\n'
                + '- Neuer Plan: memo-plan-init {slug} (legt einen neuen Plan an; die Plan-Nummer wird vom Skill selbst vergeben — KEINE Nummer und KEIN Ablageort hier vordefinieren).\\n'
                + '- Bestehender Plan: memo-plan-add {plan-id} {memo-path} (fuegt je Memo eines zu einem bestehenden Plan hinzu).\\n\\n'
                + 'Ausgewaehlte finalisierte Memos (absolute Pfade):\\n'
                + pathLines + '\\n'
        }

        function createPlan() {
            var errorBox = document.getElementById( 'p-error' )
            var savedState = document.getElementById( 'p-saved-state' )
            var savedUrlEl = document.getElementById( 'p-saved-url' )
            var savedPromptEl = document.getElementById( 'p-saved-prompt' )

            if( errorBox ) { errorBox.classList.add( 't-hidden' ) }

            if( planMode.selectedDocumentIds.length === 0 ) {
                if( errorBox ) {
                    errorBox.textContent = 'Memo-Auswahl erforderlich'
                    errorBox.classList.remove( 't-hidden' )
                }
                return
            }

            var memoPaths = resolvePlanMemoPaths( planMode.selectedDocumentIds )

            if( memoPaths.length === 0 ) {
                if( errorBox ) {
                    errorBox.textContent = 'Memo-Pfade konnten nicht aufgeloest werden'
                    errorBox.classList.remove( 't-hidden' )
                }
                return
            }

            var url = buildPlanUrlFor( planMode.selectedDocumentIds[ 0 ] )
            savedUrlEl.textContent = url
            if( savedPromptEl ) { savedPromptEl.textContent = buildPlanStartPrompt( memoPaths ) }
            savedState.classList.remove( 't-hidden' )
        }

        async function copyPlanUrl() {
            var savedUrlEl = document.getElementById( 'p-saved-url' )
            var copyBtn = document.getElementById( 'p-copy' )
            try {
                await navigator.clipboard.writeText( savedUrlEl.textContent )
                var original = copyBtn.textContent
                copyBtn.textContent = 'Kopiert!'
                setTimeout( function() { copyBtn.textContent = original }, 2000 )
            } catch {
                copyBtn.textContent = 'Fehler — bitte manuell kopieren'
            }
        }

        async function copyPlanPrompt() {
            var savedPromptEl = document.getElementById( 'p-saved-prompt' )
            var copyBtn = document.getElementById( 'p-copy-prompt' )
            try {
                await navigator.clipboard.writeText( savedPromptEl.textContent )
                var original = copyBtn.textContent
                copyBtn.textContent = 'Kopiert!'
                setTimeout( function() { copyBtn.textContent = original }, 2000 )
            } catch {
                copyBtn.textContent = 'Fehler — bitte manuell kopieren'
            }
        }

        var planNewBtn = document.getElementById( 'plan-new' )
        if( planNewBtn ) { planNewBtn.addEventListener( 'click', openPlanModal ) }

        var pSearchEl = document.getElementById( 'p-search' )
        if( pSearchEl ) { pSearchEl.addEventListener( 'input', function() { renderPlanMemoList( pSearchEl.value ) } ) }

        var pCreateBtn = document.getElementById( 'p-create' )
        if( pCreateBtn ) { pCreateBtn.addEventListener( 'click', createPlan ) }

        var pCancelBtn = document.getElementById( 'p-cancel' )
        if( pCancelBtn ) { pCancelBtn.addEventListener( 'click', closePlanModal ) }

        var pCancelXBtn = document.getElementById( 'p-cancel-x' )
        if( pCancelXBtn ) { pCancelXBtn.addEventListener( 'click', closePlanModal ) }

        var pCopyBtn = document.getElementById( 'p-copy' )
        if( pCopyBtn ) { pCopyBtn.addEventListener( 'click', copyPlanUrl ) }

        var pCopyPromptBtn = document.getElementById( 'p-copy-prompt' )
        if( pCopyPromptBtn ) { pCopyPromptBtn.addEventListener( 'click', copyPlanPrompt ) }

        var pCloseBtn = document.getElementById( 'p-close' )
        if( pCloseBtn ) { pCloseBtn.addEventListener( 'click', closePlanModal ) }

        function playNotification() {
            try {
                var ctx = new ( window.AudioContext || window.webkitAudioContext )()
                var osc = ctx.createOscillator()
                var gain = ctx.createGain()
                osc.connect( gain )
                gain.connect( ctx.destination )
                osc.frequency.value = 880
                osc.type = 'sine'
                gain.gain.value = 0.08
                gain.gain.exponentialRampToValueAtTime( 0.001, ctx.currentTime + 0.15 )
                osc.start( ctx.currentTime )
                osc.stop( ctx.currentTime + 0.15 )
            } catch( e ) {}
        }

        // PRD-008: the diff-toggle now lives in the content-sticky-header and is re-created on
        // each updateSidebarSticky render. bindDiffToggle wires the (current) #diff-toggle node
        // to the diff logic and restores its show/hide + active state from currentDiff/showDiff.
        function bindDiffToggle() {
            var diffToggleEl = document.getElementById( 'diff-toggle' )
            if( !diffToggleEl ) { return }

            if( currentDiff && currentDiff.hasDiff ) {
                diffToggleEl.style.display = ''
                diffToggleEl.classList.toggle( 'active', showDiff )
            } else {
                diffToggleEl.style.display = 'none'
                diffToggleEl.classList.remove( 'active' )
            }

            if( diffToggleEl.dataset.bound === '1' ) { return }
            diffToggleEl.dataset.bound = '1'

            diffToggleEl.addEventListener( 'click', function() {
                showDiff = !showDiff
                diffToggleEl.classList.toggle( 'active', showDiff )

                if( showDiff && currentDiff ) {
                    renderDiffView( lastContent, currentDiff )
                } else {
                    slugCounts.clear()
                    contentEl.innerHTML = marked.parse( lastContent )
                    interceptLinks()
                    document.querySelectorAll( '.mermaid' ).forEach( function( el ) {
                        var originalText = el.textContent
                        mermaid.render( 'mermaid-' + Math.random().toString( 36 ).slice( 2 ), originalText )
                            .then( function( result ) { el.innerHTML = result.svg } )
                            .catch( function( err ) { el.innerHTML = buildMermaidErrorHtml( err, originalText ) } )
                    } )
                }
            } )
        }

        // PRD-008 (Memo 019 Kap 9.2/9.5): the old Zone-2 entrypoints — the separate
        // "Transcript fuer diese Revision einfuegen"-Button (#sticky-add-transcript, PRD-013) and
        // the Opt-out-/"bereit / einloggen"-Button (#btn-einloggen, PRD-005) — were REMOVED with
        // the Prompt-Statuszeile-Umbau. Zone 2 has exactly ONE entrypoint now ("Prompt
        // bearbeiten", bindPromptEdit) and NO Opt-out-Schalter ("kein Wegklicken"). The
        // einloggen/Abschluss semantics live on the manual "Abschliessen"-Button (bindPromptFinish).

        // PRD-008 (Memo 019 Kap 9.5): the SINGLE entrypoint of Zone 2. "Prompt bearbeiten" opens
        // ONE combined popup with BOTH prompt parts (Transcript-Abschnitt + Fragen-Abschnitt).
        // Re-bound on each updateSidebarSticky render (header is rebuilt), mirroring the other
        // sticky binders. Zone 2 itself stays a pure status overview — every input lives here.
        var promptEditState = { memoName: null, projectId: null, memoId: null, revisionId: null, transcriptId: null, questions: [] }

        function bindPromptEdit( opts ) {
            opts = opts || {}
            var btn = document.getElementById( 'ps-edit-prompt' )
            if( !btn ) { return }
            if( btn.dataset.bound === '1' ) { return }
            btn.dataset.bound = '1'

            btn.addEventListener( 'click', function() {
                openPromptModal( { memoEntry: opts.memoEntry, memoName: opts.memoName } )
            } )
        }

        // Open #transcript-modal in the combined "Prompt bearbeiten" mode (Kap 9.5). Shows the
        // dedicated #t-panel-prompt (Transcript-Abschnitt + Fragen-Abschnitt), hides the tab-bar
        // + the default Transcript-save footer, and shows the prompt footer ("nichts wegklickbar"
        // + Übernehmen). Prefills the transcript field from the viewed revision's transcript and
        // builds an answer-field per open question.
        function openPromptModal( opts ) {
            opts = opts || {}
            var memoEntry = opts.memoEntry || ( opts.memoName ? lookupMemoEntry( opts.memoName ) : null )
            var modal = document.getElementById( 'transcript-modal' )
            var title = document.querySelector( '#transcript-modal .t-title' )
            if( !modal ) { return }

            transcriptMode.active = true
            transcriptMode.tab = 'prompt'

            if( title ) { title.textContent = 'Prompt bearbeiten' }

            // Toggle the panels: show the combined prompt panel, hide the three transcript panels.
            ;[ 't-tabs', 't-panel-revision', 't-panel-new', 't-panel-add', 't-url-box', 't-actions-default', 't-footnote-default', 't-saved-state' ]
                .forEach( function( id ) {
                    var el = document.getElementById( id )
                    if( el ) { el.classList.add( 't-hidden' ) }
                } )
            ;[ 't-panel-prompt', 'pp-footer' ].forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.classList.remove( 't-hidden' ) }
            } )

            var ppError = document.getElementById( 'pp-error' )
            if( ppError ) { ppError.classList.add( 't-hidden' ) }
            var ppSuccess = document.getElementById( 'pp-success' )
            if( ppSuccess ) { ppSuccess.classList.add( 't-hidden' ); ppSuccess.textContent = '' }

            // ---- Abschnitt 1: Transcript. Prefill from the viewed revision (next = max REV + 1
            // when none exists yet, matching the sticky add-transcript semantics).
            var projectId = memoEntry ? memoEntry.projectId : ''
            var memoId = memoEntry ? memoEntry.doc.memoName : ''
            var nums = memoEntry ? nextRevisionNumbers( memoEntry.doc.revisions ) : { nextId: 'REV-01' }
            var viewedRev = revisionIdFromFileName( currentFileName )
            var existing = memoEntry ? latestTranscriptForRevision( memoEntry.doc.memoName, viewedRev ) : null

            promptEditState.memoName = opts.memoName || ''
            promptEditState.projectId = projectId
            promptEditState.memoId = memoId
            promptEditState.transcriptId = existing ? existing.transcriptId : null
            // PRD-001 (Memo 022): bind to the DISCUSSED (viewed) revision, not nums.nextId. Feedback
            // ZU REV-N is bound to REV-N. Editing an existing transcript keeps its revision; otherwise
            // bind the viewed revision. nums.nextId is only the fallback when no revision is viewed
            // (e.g. a brand-new memo without any REV file yet).
            promptEditState.revisionId = existing && existing.revisionId ? existing.revisionId : ( viewedRev || nums.nextId )

            var ppProject = document.getElementById( 'pp-project' )
            var ppMemo = document.getElementById( 'pp-memo' )
            var ppRevision = document.getElementById( 'pp-revision' )
            var ppContent = document.getElementById( 'pp-content' )
            if( ppProject ) { ppProject.value = projectId }
            if( ppMemo ) { ppMemo.value = memoId }
            if( ppRevision ) { ppRevision.value = promptEditState.revisionId }
            if( ppContent ) { ppContent.value = '' }
            updatePromptTranscriptCount()

            // Load the existing transcript body into the field (no header — body only).
            if( promptEditState.transcriptId ) {
                fetch( '/api/transcripts/' + promptEditState.transcriptId )
                    .then( function( resp ) { return resp.ok ? resp.text() : '' } )
                    .then( function( raw ) {
                        var marker = '## Transcript-Inhalt'
                        var idx = raw.indexOf( marker )
                        var body = idx === -1 ? '' : raw.slice( idx + marker.length ).trim()
                        if( ppContent ) { ppContent.value = body }
                        updatePromptTranscriptCount()
                    } )
                    .catch( function() {} )
            }

            // ---- Abschnitt 2: Fragen. Open questions of the viewed memo, each with an answer
            // field. Source = doc.questions count for the label; the live questionNav.questions
            // (open, parsed) supply the per-question titles/answer fields.
            renderPromptQuestions( memoEntry )

            modal.classList.remove( 't-hidden' )
            if( ppContent ) { ppContent.focus() }
        }

        function updatePromptTranscriptCount() {
            var ppContent = document.getElementById( 'pp-content' )
            var el = document.getElementById( 'pp-tcount' )
            if( !ppContent || !el ) { return }
            var plain = ( ppContent.value || '' ).replace( /[^A-Za-zÀ-ÿ0-9]+/g, ' ' ).trim()
            var w = plain.length === 0 ? 0 : plain.split( /\\s+/ ).filter( function( t ) { return t.length > 0 } ).length
            var m = w === 0 ? 0 : Math.ceil( w / 200 )
            el.textContent = m + ' Min · ' + w.toLocaleString( 'de-DE' ) + ' Wörter'
        }

        // PRD-008 (Kap 9.5): build the Fragen-Abschnitt — one answer field per open question.
        // Reuses the live questionNav.questions (already parsed from the rendered revision). The
        // label "2 · FRAGEN BEANTWORTEN (n / m)" reflects doc.questions (same source as Zone 2).
        function renderPromptQuestions( memoEntry ) {
            var list = document.getElementById( 'pp-questions-list' )
            var label = document.getElementById( 'pp-questions-label' )
            if( !list ) { return }
            list.innerHTML = ''

            var qMeta = normalizeQuestions( memoEntry ? memoEntry.doc.questions : null )
            var total = qMeta.answered + qMeta.open
            if( label ) { label.textContent = '2 · FRAGEN BEANTWORTEN (' + qMeta.answered + ' / ' + total + ')' }

            var open = Array.isArray( questionNav.questions ) ? questionNav.questions : []
            promptEditState.questions = open

            if( open.length === 0 ) {
                var empty = document.createElement( 'span' )
                empty.className = 'pp-questions-empty'
                empty.textContent = 'Keine offenen Fragen.'
                list.appendChild( empty )

                return
            }

            open.forEach( function( q, qIdx ) {
                var row = document.createElement( 'div' )
                row.className = 'pp-question'
                row.setAttribute( 'data-pp-qidx', String( qIdx ) )

                var t = document.createElement( 'span' )
                t.className = 'pp-question-title'
                t.textContent = ( q.id ? q.id + ' — ' : '' ) + ( q.title || '' )
                row.appendChild( t )

                var input = document.createElement( 'input' )
                input.className = 'pp-question-input'
                input.setAttribute( 'data-pp-answer', String( qIdx ) )
                input.placeholder = 'Antwort...'
                // Prefill from a previously confirmed answer if present.
                var st = questionNav.state[ qIdx ]
                if( st && st.added && st.addedText ) {
                    var lines = st.addedText.split( '\\n' ).filter( function( s ) { return s.trim().length > 0 } )
                    input.value = lines.length > 0 ? lines[ lines.length - 1 ] : ''
                }
                row.appendChild( input )

                list.appendChild( row )
            } )
        }

        // PRD-008 (Kap 9.5): "Übernehmen" writes BOTH prompt parts back through the existing
        // transcript persistence path, then closes the popup. The transcriptList WS broadcast
        // re-renders Zone 2, so it mirrors the new state (Minuten/Wörter/"N von M beantwortet").
        async function applyPromptEdit() {
            var ppError = document.getElementById( 'pp-error' )
            var ppSuccess = document.getElementById( 'pp-success' )
            var ppContent = document.getElementById( 'pp-content' )
            var ppRevision = document.getElementById( 'pp-revision' )
            if( ppError ) { ppError.classList.add( 't-hidden' ) }
            if( ppSuccess ) { ppSuccess.classList.add( 't-hidden' ); ppSuccess.textContent = '' }

            var transcript = ppContent ? ppContent.value : ''
            var revisionId = ppRevision ? ppRevision.value.trim() : promptEditState.revisionId

            // Assemble the answers from the popup answer fields (Fragen-Abschnitt).
            var answerBlocks = []
            var inputs = document.querySelectorAll( '#pp-questions-list .pp-question-input' )
            inputs.forEach( function( input ) {
                var qIdx = parseInt( input.getAttribute( 'data-pp-answer' ), 10 )
                var q = promptEditState.questions[ qIdx ]
                var val = ( input.value || '' ).trim()
                if( !q || val.length === 0 ) { return }
                answerBlocks.push( '## Antwort auf ' + q.id + ' — ' + q.title + '\\n\\n' + val + '\\n' )
            } )

            // "Kein Wegklicken" (Kap 9.2): both parts always go into the prompt — never optional.
            var sep = transcript.trim().length > 0 && answerBlocks.length > 0 ? '\\n\\n' : ''
            var content = transcript.trim() + sep + answerBlocks.join( '\\n' )

            if( content.trim().length === 0 ) {
                if( ppError ) {
                    ppError.textContent = 'Mindestens ein Transcript-Text oder eine Antwort ist erforderlich.'
                    ppError.classList.remove( 't-hidden' )
                }

                return
            }

            if( !/^REV-\\d{2,}$/.test( revisionId ) ) {
                if( ppError ) {
                    ppError.textContent = 'Revision-Format: REV-XX (mind. 2 Ziffern)'
                    ppError.classList.remove( 't-hidden' )
                }

                return
            }

            try {
                var isUpdate = !!promptEditState.transcriptId
                var url = isUpdate ? '/api/transcripts/' + promptEditState.transcriptId : '/api/transcripts'
                var method = isUpdate ? 'PUT' : 'POST'
                var body = isUpdate
                    ? JSON.stringify( { content: content } )
                    : JSON.stringify( { projectId: promptEditState.projectId, memoId: promptEditState.memoId, revisionId: revisionId, content: content } )

                var resp = await fetch( url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body } )
                var data = await resp.json()

                if( !resp.ok ) {
                    if( ppError ) {
                        ppError.textContent = data.error || 'Server-Fehler'
                        ppError.classList.remove( 't-hidden' )
                    }

                    return
                }

                // PRD-002 (Memo 022, Kap 3): the save succeeded — now make the result visible
                // and reusable instead of closing silently.
                // a) Idempotenz: remember the server-assigned transcriptId so a SECOND
                //    "Übernehmen" without a re-render goes through PUT (Update) instead of
                //    POST (Anlage) — no Karteileichen-Stapel for the same viewed revision.
                if( data && data.transcriptId ) { promptEditState.transcriptId = data.transcriptId }

                // b) URL + Clipboard: copy the fresh transcript URL. The clipboard write is a
                //    Promise; reject (denied permission) must not crash the flow.
                var savedUrl = data && data.url ? data.url : ''
                if( savedUrl && navigator.clipboard && navigator.clipboard.writeText ) {
                    navigator.clipboard.writeText( savedUrl ).catch( function() {} )
                }

                // c) Sichtbare Erfolgs-Quittung mit der URL statt stumm zu schliessen.
                if( ppSuccess ) {
                    ppSuccess.textContent = savedUrl
                        ? 'Gespeichert · in Zwischenablage kopiert: ' + savedUrl
                        : 'Gespeichert.'
                    ppSuccess.classList.remove( 't-hidden' )
                }

                // d) ps-copy sofort aktiv schalten — ohne auf den WS-Render-Roundtrip zu warten.
                //    Zone 2 (Minuten/Wörter, "N von M beantwortet") spiegelt den neuen Stand
                //    weiterhin über den bestehenden transcriptList-Broadcast → updateSidebarSticky.
                activatePsCopy( savedUrl )
            } catch( err ) {
                if( ppError ) {
                    ppError.textContent = 'Netzwerkfehler: ' + err.message
                    ppError.classList.remove( 't-hidden' )
                }
            }
        }

        // PRD-002 (Memo 022, Kap 3): make the Zone-2 copy button (#ps-copy) usable right after a
        // save, BEFORE the WS broadcast re-renders the header. Removes the disabled state, sets the
        // fresh URL on data-url, and binds a copy-handler once (mirrors updateSidebarSticky's
        // handler at the ps-copy bind site: copies + shows a short ✓). No-op without a URL.
        function activatePsCopy( url ) {
            if( !url ) { return }
            var copyBtn = document.getElementById( 'ps-copy' )
            if( !copyBtn ) { return }

            copyBtn.removeAttribute( 'disabled' )
            copyBtn.disabled = false
            copyBtn.setAttribute( 'data-url', url )

            if( copyBtn.dataset.ppCopyBound !== '1' ) {
                copyBtn.dataset.ppCopyBound = '1'
                copyBtn.addEventListener( 'click', function() {
                    var current = copyBtn.getAttribute( 'data-url' ) || ''
                    if( !current ) { return }
                    navigator.clipboard.writeText( current ).then( function() {
                        var orig = copyBtn.textContent
                        copyBtn.textContent = '\\u2713'
                        setTimeout( function() { copyBtn.textContent = orig }, 2000 )
                    } ).catch( function() {} )
                } )
            }
        }

        // PRD-008 (Memo 019 Kap 9.6): manual "Abschliessen" trigger (F7 = A). User-only — there
        // is NO auto-trigger and NO Transcript-opt-out beside it (a present transcript is always
        // part of the prompt). The future auto-send to the agent docks onto the existing
        // TranscriptRegistry #onChangeCallback / transcriptLoggedIn event-hook; PRD-008 only
        // wires the manual login trigger here, it does NOT activate the automatic send.
        function bindPromptFinish( opts ) {
            opts = opts || {}
            var btn = document.getElementById( 'ps-finish' )
            if( !btn ) { return }
            if( btn.dataset.bound === '1' ) { return }
            btn.dataset.bound = '1'

            btn.addEventListener( 'click', function() {
                var transcriptId = opts.transcriptId || ''
                if( !transcriptId ) {
                    window.alert( 'Kein Transcript zum Abschliessen — bitte zuerst "Prompt bearbeiten" und Übernehmen.' )

                    return
                }

                // Manual finish = log in the revision (event-hook for the future auto-send).
                fetch( '/api/transcripts/' + transcriptId + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } )
                    .then( function( resp ) {
                        if( !resp.ok ) { return }
                        // The transcriptLoggedIn WS broadcast re-renders Zone 2; no reload.
                    } )
                    .catch( function() {} )
            } )
        }

        var tocListEl = document.getElementById( 'toc-list' )

        // PRD-009: enforce the interactive-area structure inside the rendered content.
        // Order: Metatags -> Kontext -> Topics -> interaktiver Bereich (Vorwort OBEN, dann Fragen).
        // - "Offene Fragen" heading becomes a prominent, linkable anchor (id="offene-fragen", F11).
        // - A Vorwort placeholder section (id="vorwort") is inserted directly before it
        //   (Befuellung Phase 6 / Kap 19); it stays hidden while empty.
        function applyContentStructure() {
            var headings = contentEl.querySelectorAll( 'h1, h2, h3, h4' )
            var fragenHeading = null
            headings.forEach( function( h ) {
                if( fragenHeading ) { return }
                if( /offene\\s+fragen/i.test( h.textContent || '' ) ) { fragenHeading = h }
            } )

            if( !fragenHeading ) { return }

            // Prominent, linkable anchor (F11).
            fragenHeading.id = 'offene-fragen'
            fragenHeading.classList.add( 'offene-fragen-anchor' )

            // PRD-007 (#49): set an anchor on the "Finalisierungs-Frage" heading so the
            // On-this-page list can link to it. Detected by regex over all headings.
            var finalHeading = null
            headings.forEach( function( h ) {
                if( finalHeading ) { return }
                if( /finalisierung/i.test( h.textContent || '' ) ) { finalHeading = h }
            } )
            if( finalHeading ) { finalHeading.id = 'finalisierungs-frage' }

            // Neutralise the raw markdown "## Vorwort" / "## Claude-Vorwort" heading from the
            // main flow: marked renders it as <h2 id="vorwort">, which (a) collides with the
            // placeholder id below — so the placeholder was never created and renderVorwort
            // filled the H2 itself, rendering the whole Vorwort at h2 size ("komplett in h1") —
            // and (b) duplicates the prose. Strip its id (frees "vorwort" for the placeholder)
            // and hide the heading + its body siblings (reusing the raw-question hide class).
            var rawVorwortHeading = null
            headings.forEach( function( h ) {
                if( rawVorwortHeading ) { return }
                if( /^(?:claude-)?vorwort$/i.test( ( h.textContent || '' ).trim() ) ) { rawVorwortHeading = h }
            } )
            if( rawVorwortHeading ) {
                rawVorwortHeading.removeAttribute( 'id' )
                rawVorwortHeading.classList.add( 'raw-question-hidden' )
                hiddenSiblingsAfter( rawVorwortHeading ).forEach( function( node ) {
                    node.classList.add( 'raw-question-hidden' )
                } )
            }

            // Vorwort placeholder section at the very TOP of the content (right after the title
            // H1), so Claude's intro is read first. Stays hidden while empty (CSS .vorwort-empty).
            if( !document.getElementById( 'vorwort' ) ) {
                var vorwort = document.createElement( 'section' )
                vorwort.id = 'vorwort'
                vorwort.className = 'vorwort-section vorwort-empty'
                vorwort.setAttribute( 'aria-label', 'Vorwort' )
                var titleH1 = contentEl.querySelector( 'h1' )
                if( titleH1 ) {
                    titleH1.parentNode.insertBefore( vorwort, titleH1.nextSibling )
                } else {
                    contentEl.insertBefore( vorwort, contentEl.firstChild )
                }
            }

            // PRD-002 (#12/#15): Caps-Section-Labels + INTERAKTIVER BEREICH.
            applySectionLabels()
            // PRD-002 (#13): TOPICS-Sektion als nummerierte Chip-Leiste.
            applyTopicChips()
            // PRD-002 (#14): Metatags-Tabelle als Chip-Leiste.
            applyMetatagChips()
            // PRD-001 (#16-18): Roh-Markdown der Frage-Sektionen ausblenden, Anchor behalten.
            hideRawQuestionBodies()
        }

        // PRD-001 (#16-18): collect all sibling nodes after a heading up to the next H2.
        // No while-loop (Memo-Standard) — sibling chain walked via recursion.
        function hiddenSiblingsAfter( heading ) {
            var collected = []
            var step = function( node ) {
                if( !node || node.tagName === 'H2' ) { return }
                collected.push( node )
                step( node.nextElementSibling )
            }
            step( heading.nextElementSibling )
            return collected
        }

        // PRD-001 (#16-18): hide the raw "Offene Fragen" / "Beantwortete Fragen" markdown
        // bodies once the interactive widgets render — heading stays as anchor.
        function hideRawQuestionBodies() {
            var headings = contentEl.querySelectorAll( 'h2' )
            headings.forEach( function( h ) {
                var label = ( h.textContent || '' ).toLowerCase()
                var isQuestionSection = /offene\\s+fragen/.test( label )
                    || /beantwortete\\s+fragen/.test( label )
                if( !isQuestionSection ) { return }

                hiddenSiblingsAfter( h ).forEach( function( node ) {
                    node.classList.add( 'raw-question-hidden' )
                } )
            } )
        }

        // PRD-002 (#12/#15): Caps-Section-Labels for the main content sections.
        function applySectionLabels() {
            // Order per comment above: Metatags -> Kontext -> Topics -> interaktiver Bereich.
            var labelMap = [
                { match: /metatags/i, label: 'METATAGS' },
                { match: /kontext/i, label: 'KONTEXT' },
                { match: /topics?/i, label: 'TOPICS' }
            ]

            var headings = contentEl.querySelectorAll( 'h2' )
            headings.forEach( function( h ) {
                var text = h.textContent || ''
                var hit = labelMap.find( function( entry ) { return entry.match.test( text ) } )
                if( hit && !h.hasAttribute( 'data-caps' ) ) {
                    h.classList.add( 'section-caps-host' )
                    h.setAttribute( 'data-caps', hit.label )
                }
            } )

            // INTERAKTIVER BEREICH label (#15) — above Vorwort / Offene-Fragen anchor.
            var fragen = document.getElementById( 'offene-fragen' )
            if( fragen && !document.getElementById( 'interaktiv-label' ) ) {
                var lbl = document.createElement( 'div' )
                lbl.id = 'interaktiv-label'
                lbl.className = 'section-caps-label'
                lbl.textContent = 'INTERAKTIVER BEREICH'
                // Vorwort now lives at the TOP of the document, so the INTERAKTIVER BEREICH
                // label anchors on the Offene-Fragen heading only (was: vorwort || fragen).
                var anchorNode = fragen
                anchorNode.parentNode.insertBefore( lbl, anchorNode )
            }
        }

        // PRD-002 (#13): render TOPICS list as a numbered chip strip.
        function applyTopicChips() {
            var headings = contentEl.querySelectorAll( 'h2, h3' )
            var topicsHeading = null
            headings.forEach( function( h ) {
                if( topicsHeading ) { return }
                if( /topics?/i.test( h.textContent || '' ) ) { topicsHeading = h }
            } )
            if( !topicsHeading ) { return }

            var list = topicsHeading.nextElementSibling
            if( !list || ( list.tagName !== 'UL' && list.tagName !== 'OL' ) ) { return }

            var chips = document.createElement( 'div' )
            chips.className = 'topic-chips'
            var items = Array.from( list.querySelectorAll( ':scope > li' ) )
            items.forEach( function( li, idx ) {
                var chip = document.createElement( 'span' )
                chip.className = 'topic-chip'
                chip.textContent = ( idx + 1 ) + ' ' + li.textContent.trim()
                chips.appendChild( chip )
            } )
            list.parentNode.replaceChild( chips, list )
        }

        // PRD-002 (#14): render the Metatags table as a chip strip.
        function applyMetatagChips() {
            var headings = contentEl.querySelectorAll( 'h2, h3' )
            var metaHeading = null
            headings.forEach( function( h ) {
                if( metaHeading ) { return }
                if( /metatags/i.test( h.textContent || '' ) ) { metaHeading = h }
            } )
            if( !metaHeading ) { return }

            var table = metaHeading.nextElementSibling
            if( !table || table.tagName !== 'TABLE' ) { return }

            var chips = document.createElement( 'div' )
            chips.className = 'meta-chips'
            var rows = Array.from( table.querySelectorAll( 'tbody tr' ) )
            rows.forEach( function( row ) {
                var cells = Array.from( row.querySelectorAll( 'td' ) )
                if( cells.length === 0 ) { return }
                var label = cells
                    .map( function( c ) { return c.textContent.trim() } )
                    .join( ': ' )
                var chip = document.createElement( 'span' )
                chip.className = 'meta-chip'
                chip.textContent = label
                chips.appendChild( chip )
            } )
            table.parentNode.replaceChild( chips, table )
        }

        // PRD-014 (Kap 19): fill the persisted Vorwort into the section that
        // applyContentStructure() inserts directly above the "Offene Fragen" anchor.
        // Single-Channel: the Vorwort lives here (not only in the terminal). It may raise
        // new decision questions, but those become F-Eintraege in the memo, not terminal-only.
        function renderVorwort( vorwort ) {
            var section = document.getElementById( 'vorwort' )
            if( !section ) { return }

            var text = String( vorwort || '' ).trim()

            if( text.length === 0 ) {
                section.innerHTML = ''
                section.classList.add( 'vorwort-empty' )
                return
            }

            section.classList.remove( 'vorwort-empty' )
            section.innerHTML = '<div class="vorwort-body">' + marked.parse( text ) + '</div>'
        }

        // PRD-013 (Kap 15): interactive question-widget state.
        // questionNav drives the Claude-Code-style carousel keyboard navigation.
        // PRD-006 (Kap 9): fertig carries the explicit "abgeschlossen"-state (AC-05);
        // footerFocus tracks Tab-cycling through the footer buttons (AC-06).
        // PRD-001 (Memo 024 Kap 1): engaged distinguishes the freshly rendered state (active=0
        // but the user has not navigated yet) from an active carousel. The FIRST Shift+Down must
        // land on the FIRST question (data-qidx=0), not the second — so it only engages without
        // applying the delta. Every later Shift+Up/Down then steps normally.
        var questionNav = { active: -1, optionFocus: -1, lane: 'option', questions: [], state: [], fertig: false, footerFocus: -1, engaged: false }

        function escHtml( str ) {
            return String( str || '' )
                .replace( /&/g, '&amp;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
                .replace( /"/g, '&quot;' )
        }

        // PRD-013 #8: consume the schema from PRD-012 directly — no client-side parsing.
        function renderQuestionWidgets( schema ) {
            var container = document.getElementById( 'question-widgets' )
            if( !container ) {
                container = document.createElement( 'div' )
                container.id = 'question-widgets'
            }
            container.innerHTML = ''

            // Only OPEN questions get an interactive widget.
            var open = ( schema || [] ).filter( function( q ) { return q && q.answered === false } )

            // Anchor the widgets directly under the "Offene Fragen" section (Phase 4),
            // or at the end of the content if that anchor is missing.
            var anchor = document.getElementById( 'offene-fragen' )
            if( anchor && anchor.parentNode ) {
                anchor.parentNode.insertBefore( container, anchor.nextSibling )
            } else {
                contentEl.appendChild( container )
            }

            questionNav.questions = open
            questionNav.state = open.map( function( q ) {
                // single = first preselected index; multi = full preselected set.
                var pre = Array.isArray( q.preselected ) ? q.preselected.slice() : []
                var selected = q.typ === 'single' ? ( pre.length > 0 ? [ pre[ 0 ] ] : [] ) : pre
                // PRD-026 (Kap 12.1): added/addedText hold the machine-injected, confirmed
                // answer for this question (no popup, no extra storage). The button state is
                // bound to st.added so the visible "hinzugefügt" quittance stays consistent.
                // PRD-006 (Kap 9): rejected flag drives the reversible "Ablehnen" toggle.
                // It is purely a UI state — the question data + selection always survive.
                return { selected: selected, custom: [], added: false, addedText: null, rejected: false }
            } )
            questionNav.active = open.length > 0 ? 0 : -1
            questionNav.optionFocus = -1
            questionNav.lane = 'option'
            // PRD-001 (Memo 024 Kap 1): a freshly rendered widget set is not engaged yet — the
            // first Shift+Down/Up engages the already-active first question instead of skipping it.
            questionNav.engaged = false
            // PRD-006 (Kap 9): a freshly rendered widget is always in the open editing state.
            questionNav.fertig = false
            questionNav.footerFocus = -1

            // PRD-004 (Memo 019, Kap 4) — the 100%-Regel render gate. A question becomes an
            // interactive widget ONLY when it parsed 100% cleanly (isQuestionCleanParse). A
            // question that is not clean falls back to a readable markdown/text rendering at
            // the same anchor position — NEVER a half-filled qw-card. The decision is taken
            // per question, so mixed cases (some clean, some not) render correctly side by side.
            var fallbackCount = 0
            open.forEach( function( q, qIdx ) {
                if( isQuestionCleanParse( q ) ) {
                    container.appendChild( buildQuestionCard( q, qIdx ) )
                } else {
                    fallbackCount = fallbackCount + 1
                    container.appendChild( buildQuestionFallback( q ) )
                }
            } )

            // PRD-001 (Memo 024 Kap 1): Count == Parse. When the counter promises N questions but
            // some of them could not be rendered as interactive widgets, show a single VISIBLE
            // banner at the top of the widget area — never a silent difference between counter and
            // rendered widgets. Each affected question additionally carries its own inline warning.
            if( fallbackCount > 0 ) {
                var banner = document.createElement( 'div' )
                banner.className = 'qw-parse-warn'
                banner.id = 'qw-parse-warn'
                banner.textContent = '⚠ ' + fallbackCount + ' von ' + open.length
                    + ' Fragen konnten nicht als Widget geparst werden — sie werden als Rohtext angezeigt.'
                container.insertBefore( banner, container.firstChild )
            }

            // PRD-008 (Memo 024 Kap 7): the answers-only bar ("ohne Transcript speichern" + "Fertig")
            // no longer lives in the scrolling content flow. It is rendered into the Sticky-Header
            // Zone 2 (.hdr-zone-2) by updateSidebarSticky so the central actions stay visible while
            // scrolling. mountAnswersOnlyBarInHeader() places it; this render only refreshes it so a
            // content update (e.g. fresh schema) keeps the header bar in sync.
            mountAnswersOnlyBarInHeader()

            updateSaveAnswersOnlyState()
            renderQuestionFocus()
        }

        // PRD-028 (Kap 12.3): assemble the injected, confirmed answers (state.addedText) into
        // a single answers-only content block. Returns empty when nothing was added.
        function collectAddedAnswers() {
            var blocks = questionNav.state
                .filter( function( st ) { return st && st.added === true && st.addedText } )
                .map( function( st ) { return st.addedText } )

            return { count: blocks.length, content: blocks.join( '\\n' ) }
        }

        // PRD-006 (Kap 9, AC-03): append the collected answer blocks to a transcript content
        // string, avoiding duplicates if the user re-saves (a block already present is not
        // appended again). Idempotent so re-saving never multiplies the answers section.
        function appendAddedAnswers( content ) {
            var base = String( content || '' )
            var collected = collectAddedAnswers()
            if( collected.count === 0 ) { return base }

            var missing = questionNav.state
                .filter( function( st ) { return st && st.added === true && st.addedText } )
                .map( function( st ) { return st.addedText } )
                .filter( function( block ) { return base.indexOf( block.trim() ) === -1 } )

            if( missing.length === 0 ) { return base }

            var sep = base.trim().length > 0 ? '\\n\\n' : ''

            return base + sep + missing.join( '\\n' )
        }

        function buildAnswersOnlyBar() {
            var bar = document.createElement( 'div' )
            bar.className = 'qw-answers-only-bar'
            bar.id = 'qw-answers-only-bar'

            var saveBtn = document.createElement( 'button' )
            saveBtn.className = 'qw-secondary-btn qw-save-answers-only'
            saveBtn.id = 'qw-save-answers-only'
            saveBtn.textContent = 'ohne Transcript speichern'
            saveBtn.disabled = true
            saveBtn.addEventListener( 'click', function() { saveAnswersOnly() } )
            bar.appendChild( saveBtn )

            var status = document.createElement( 'span' )
            status.className = 'qw-answers-only-status t-hidden'
            status.id = 'qw-answers-only-status'
            bar.appendChild( status )

            // PRD-006 (Kap 9, AC-05): the "Fertig"-Button explicitly closes the workflow.
            // Until it is clicked the widget is in the active editing state (no open thread to
            // chase). Clicking marks every non-rejected question as done and locks the widget.
            var fertigBtn = document.createElement( 'button' )
            fertigBtn.className = 'qw-primary-btn qw-fertig-btn'
            fertigBtn.id = 'qw-fertig-btn'
            fertigBtn.textContent = 'Fertig'
            fertigBtn.title = 'Bearbeitung der Fragen bewusst abschließen'
            fertigBtn.addEventListener( 'click', function() { markQuestionsFertig() } )
            bar.appendChild( fertigBtn )

            var note = document.createElement( 'span' )
            note.className = 'qw-note'
            note.textContent = 'Speichert nur die Antworten — kein vollständiger Transcript.'
            bar.appendChild( note )

            return bar
        }

        // PRD-008 (Memo 024 Kap 7): mount the answers-only bar into Sticky-Header Zone 2
        // (.hdr-zone-2). The bar is built exactly once (buildAnswersOnlyBar) and re-parented into
        // the freshly rendered header so the action buttons stay visible while the content scrolls
        // (AC-01/AC-02). It is shown ONLY while there are open questions (AC-06: no empty header
        // block); when none exist any stray bar is removed so #main-header:empty can hide itself.
        // The bar carries a single ID per button (AC-03: no duplicate in the content flow — the
        // content append was removed in renderQuestionWidgets).
        function mountAnswersOnlyBarInHeader() {
            // PRD-008 (Memo 024 Kap 7) — REMOVED: the answers-only bar ("ohne Transcript
            // speichern" + "Fertig" + note) is gone entirely. It cluttered first the
            // Sticky-Header, then the popup, and is redundant: the "Prompt bearbeiten" popup's
            // "Übernehmen" (applyPromptEdit) already persists BOTH the transcript and the
            // answers from the popup's own answer fields. This function now only strips any
            // stray bar left over from an earlier render so nothing re-appears.
            var existing = document.getElementById( 'qw-answers-only-bar' )
            if( existing && existing.parentNode ) { existing.parentNode.removeChild( existing ) }
        }

        // PRD-006 (Kap 9, AC-05): the workflow is "offen" until the user clicks "Fertig".
        // questionNav.fertig is the single source of truth for the done-state; it stays
        // reversible (clicking again re-opens) so nothing is irrevocably committed.
        function markQuestionsFertig() {
            questionNav.fertig = questionNav.fertig !== true
            var bar = document.getElementById( 'qw-answers-only-bar' )
            var btn = document.getElementById( 'qw-fertig-btn' )

            if( questionNav.fertig ) {
                if( bar ) { bar.classList.add( 'qw-fertig-done' ) }
                if( btn ) {
                    btn.textContent = 'Fertig ✓ (wieder öffnen)'
                    btn.title = 'Erneut klicken, um die Bearbeitung wieder zu öffnen'
                }
            } else {
                if( bar ) { bar.classList.remove( 'qw-fertig-done' ) }
                if( btn ) {
                    btn.textContent = 'Fertig'
                    btn.title = 'Bearbeitung der Fragen bewusst abschließen'
                }
            }
        }

        // PRD-028: the button only makes sense when at least one answer was injected and the
        // user has NOT entered real transcript text (then the normal "Speichern" is the path).
        function updateSaveAnswersOnlyState() {
            var btn = document.getElementById( 'qw-save-answers-only' )
            if( !btn ) { return }

            var collected = collectAddedAnswers()
            var contentArea = document.getElementById( 't-content' )
            var hasRealTranscript = !!( contentArea && contentArea.value && contentArea.value.trim().length > 0 )

            btn.disabled = collected.count === 0 || hasRealTranscript
            if( btn.disabled ) {
                btn.title = collected.count === 0
                    ? 'Erst mindestens eine Antwort hinzufügen'
                    : 'Es liegt bereits ein echter Transcript-Text vor — normal speichern'
            } else {
                btn.title = ''
            }
        }

        // PRD-028 (Kap 12.3): persist the collected answers via the existing save mechanism,
        // marked as "nur Antworten" (complete: false). No real transcript text. No popup
        // (Kap 12.1) — only an inline success quittance.
        async function saveAnswersOnly() {
            var btn = document.getElementById( 'qw-save-answers-only' )
            var statusEl = document.getElementById( 'qw-answers-only-status' )
            var collected = collectAddedAnswers()
            if( collected.count === 0 ) { return }

            // PRD-001 (Memo 022): Revisions-Bezug = die BESPROCHENE (betrachtete) Revision. Feedback
            // ZU REV-N wird an REV-N gebunden, nicht an REV-(N+1). Der Sticky-Header-Button traegt
            // den Kontext (data-project/-memo/-rev) — die Modal-Hidden-Felder werden im No-Popup-Flow
            // nicht mehr befuellt. data-rev ist die betrachtete Revision; data-next bleibt nur als
            // Workflow-Info am Button (Header-Hinweis), ist aber NICHT mehr der Bindungsschluessel.
            // PRD-008: the single Zone-2 entrypoint (#ps-edit-prompt) carries the Revisions-Kontext;
            // the old #sticky-add-transcript button was removed with the Prompt-Statuszeile-Umbau.
            var ctxBtn = document.getElementById( 'ps-edit-prompt' )
            var projectId = ctxBtn ? ( ctxBtn.getAttribute( 'data-project' ) || '' ) : ''
            var memoId = ctxBtn ? ( ctxBtn.getAttribute( 'data-memo' ) || '' ) : ''
            var revisionId = ctxBtn ? ( ctxBtn.getAttribute( 'data-rev' ) || '' ) : ''

            if( projectId.length === 0 ) {
                var projectEl = document.getElementById( 't-project' )
                var memoEl = document.getElementById( 't-memo' )
                var revisionEl = document.getElementById( 't-revision' )
                projectId = projectEl ? projectEl.value : ''
                memoId = memoEl ? memoEl.value : ''
                revisionId = revisionEl ? revisionEl.value : ''
            }

            if( !/^REV-\\d{2,}$/.test( revisionId ) || projectId.length === 0 || memoId.length === 0 ) {
                if( statusEl ) {
                    statusEl.textContent = 'Kein gültiger Revisions-Bezug (Projekt/Memo/REV-XX) gefunden.'
                    statusEl.classList.remove( 't-hidden' )
                }

                return
            }

            try {
                var resp = await fetch( '/api/transcripts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // complete: false -> "nur Antworten" / nicht vollstaendig (PRD-027 model).
                    body: JSON.stringify( {
                        projectId: projectId,
                        memoId: memoId,
                        revisionId: revisionId,
                        content: collected.content,
                        complete: false
                    } )
                } )
                var data = await resp.json()

                if( !resp.ok ) {
                    if( statusEl ) {
                        statusEl.textContent = data.error || 'Server-Fehler'
                        statusEl.classList.remove( 't-hidden' )
                    }

                    return
                }

                if( statusEl ) {
                    statusEl.textContent = 'Gespeichert (nur Antworten): ' + ( data.url || data.transcriptId || '' )
                    statusEl.classList.remove( 't-hidden' )
                    statusEl.classList.add( 'qw-answers-only-ok' )
                }
                if( btn ) { btn.disabled = true }
            } catch( err ) {
                if( statusEl ) {
                    statusEl.textContent = 'Netzwerkfehler: ' + err.message
                    statusEl.classList.remove( 't-hidden' )
                }
            }
        }

        // PRD-004 (Memo 019, Kap 4) — the clean-parse criterion (100%-Regel). A question is
        // Widget-faehig ONLY when ALL of these hold. The criterion is deliberately identical
        // to the validator's question checks (MemoValidator MEMO-020a/b/c/d, MEMO-030) so the
        // render-gate (View) and the reject-gate (PRD-005) share one truth:
        //   - id present + non-empty (form F{N}),
        //   - frage present + non-empty,
        //   - aiRecommendation present + non-empty,
        //   - >= 2 real options (kind 'option') with distinct, non-empty key AND non-empty label,
        //   - the aiRecommendation references an existing option key (single: exactly one such key).
        function isQuestionCleanParse( q ) {
            if( !q || typeof q !== 'object' ) { return false }

            var id = typeof q.id === 'string' ? q.id.trim() : ''
            if( !/^F\\d+$/.test( id ) ) { return false }

            var frage = typeof q.frage === 'string' ? q.frage.trim() : ''
            if( frage.length === 0 ) { return false }

            var aiRecommendation = typeof q.aiRecommendation === 'string' ? q.aiRecommendation.trim() : ''
            // PRD-003 (Memo 022, Kap 4, F9=A): a checklist / multi-select question derives its
            // options from "- [ ] ..." items and has no A/B/C letter recommendation. For the
            // multi case the AI-Empfehlung is therefore NOT mandatory — only single-select keeps
            // the strict "non-empty recommendation that references exactly one key" contract.
            var isMulti = q.typ === 'multi'
            if( !isMulti && aiRecommendation.length === 0 ) { return false }

            var realOptions = ( Array.isArray( q.options ) ? q.options : [] )
                .filter( function( o ) { return o && typeof o === 'object' && o.kind === 'option' } )
                .filter( function( o ) {
                    return typeof o.key === 'string' && o.key.trim().length > 0
                        && typeof o.label === 'string' && o.label.trim().length > 0
                } )

            var optionKeys = realOptions.map( function( o ) { return o.key.trim() } )
            var distinctKeys = optionKeys.filter( function( key, idx ) { return optionKeys.indexOf( key ) === idx } )
            if( distinctKeys.length < 2 ) { return false }

            // Single-select: the recommendation must reference EXACTLY one existing option key.
            // PRD-003: the AI-Empfehlung-references-key check is RELAXED for the multi/checklist
            // case — a checklist has >= 2 real options but no letter-based AI reference, so the
            // >= 2-options rule above is the sufficient cleanliness signal for it.
            if( !isMulti ) {
                var recommendedKeys = ( aiRecommendation.toUpperCase().match( /\\b([A-H])\\b/g ) || [] )
                var referencesExisting = recommendedKeys.some( function( key ) { return distinctKeys.indexOf( key ) !== -1 } )
                if( !referencesExisting ) { return false }

                var distinctRec = recommendedKeys.filter( function( key, idx ) { return recommendedKeys.indexOf( key ) === idx } )
                var existingRec = distinctRec.filter( function( key ) { return distinctKeys.indexOf( key ) !== -1 } )
                if( existingRec.length !== 1 ) { return false }
            }

            return true
        }

        // PRD-004: the runtime safety net. A question that fails the clean-parse gate is shown
        // as a plain, readable markdown/text block (title + question text + raw option text) at
        // the same anchor — never an empty or half-filled widget. No interactive state is wired.
        function buildQuestionFallback( q ) {
            var safe = ( q && typeof q === 'object' ) ? q : {}
            var wrap = document.createElement( 'div' )
            wrap.className = 'qw-fallback'
            wrap.setAttribute( 'data-qfallback', '1' )

            // PRD-001 (Memo 024 Kap 1): a question that does not parse cleanly must NOT vanish
            // silently. Prepend a VISIBLE warning so the gap is obvious, then keep the question
            // text as raw markdown below it (so the user can still read and answer it manually).
            var warn = document.createElement( 'div' )
            warn.className = 'qw-fallback-warn'
            warn.setAttribute( 'data-qfallback-warn', '1' )
            var warnId = typeof safe.id === 'string' && safe.id.trim().length > 0 ? safe.id.trim() : 'Frage'
            warn.textContent = '⚠ ' + warnId + ' konnte nicht vollständig geparst werden — als Rohtext angezeigt.'
            wrap.appendChild( warn )

            var lines = []
            var id = typeof safe.id === 'string' ? safe.id.trim() : ''
            var title = typeof safe.title === 'string' ? safe.title.trim() : ''
            var heading = [ id, title ].filter( function( s ) { return s.length > 0 } ).join( ' — ' )
            if( heading.length > 0 ) { lines.push( '### ' + heading ) }

            var hintergrund = typeof safe.hintergrund === 'string' ? safe.hintergrund.trim() : ''
            if( hintergrund.length > 0 ) { lines.push( '**Hintergrund:** ' + hintergrund ) }

            var frage = typeof safe.frage === 'string' ? safe.frage.trim() : ''
            if( frage.length > 0 ) { lines.push( '**Frage:** ' + frage ) }

            var aiRecommendation = typeof safe.aiRecommendation === 'string' ? safe.aiRecommendation.trim() : ''
            if( aiRecommendation.length > 0 ) { lines.push( '**AI-Empfehlung:** ' + aiRecommendation ) }

            var optionLines = ( Array.isArray( safe.options ) ? safe.options : [] )
                .filter( function( o ) { return o && typeof o === 'object' && o.kind === 'option' } )
                .map( function( o ) {
                    var key = typeof o.key === 'string' ? o.key : ''
                    var label = typeof o.label === 'string' ? o.label : ''
                    return ( key.length > 0 ? key + ') ' : '' ) + label
                } )
                .filter( function( s ) { return s.trim().length > 0 } )

            optionLines.forEach( function( optionLine ) { lines.push( optionLine ) } )

            // PRD-001 (Memo 024 Kap 1): append the raw-text body AFTER the warning banner — using
            // a child container instead of overwriting wrap.innerHTML keeps the warning visible.
            var bodyEl = document.createElement( 'div' )
            bodyEl.className = 'qw-fallback-body'
            bodyEl.innerHTML = marked.parse( lines.join( '\\n\\n' ) )
            wrap.appendChild( bodyEl )

            return wrap
        }

        function buildQuestionCard( q, qIdx ) {
            var card = document.createElement( 'div' )
            card.className = 'qw-card'
            // F7 = C: first/primary question prominent, the rest collapsed/expandable.
            if( qIdx > 0 ) { card.classList.add( 'qw-collapsed' ) }
            card.setAttribute( 'data-qidx', String( qIdx ) )

            var badge = q.typ === 'multi' ? 'Multi-Select' : 'Single-Select'

            var head = document.createElement( 'div' )
            head.className = 'qw-head'
            head.innerHTML = '<span class="qw-id">' + escHtml( q.id ) + '</span>'
                + '<span class="qw-title">' + escHtml( q.title ) + '</span>'
                + '<span class="qw-badge">' + badge + '</span>'
                + '<span class="qw-toggle">' + ( qIdx > 0 ? '+' : '−' ) + '</span>'
            head.addEventListener( 'click', function() {
                card.classList.toggle( 'qw-collapsed' )
                var tog = head.querySelector( '.qw-toggle' )
                if( tog ) { tog.textContent = card.classList.contains( 'qw-collapsed' ) ? '+' : '−' }
            } )
            card.appendChild( head )

            var body = document.createElement( 'div' )
            body.className = 'qw-body'

            if( q.hintergrund ) {
                var hg = document.createElement( 'div' )
                hg.className = 'qw-hintergrund'
                hg.innerHTML = '<span class="qw-hintergrund-label">HINTERGRUND</span> '
                    + escHtml( q.hintergrund )
                body.appendChild( hg )
            }

            if( q.frage ) {
                // PRD-023 (Kap 11.4): the question block carries its own "FRAGE" label so it
                // is visually a distinct, labelled block — not a continuation of the
                // Hintergrund prose. The label span mirrors qw-hintergrund-label.
                var fr = document.createElement( 'div' )
                fr.className = 'qw-frage'
                var frLabel = document.createElement( 'span' )
                frLabel.className = 'qw-frage-label'
                frLabel.textContent = 'FRAGE'
                var frText = document.createElement( 'span' )
                frText.className = 'qw-frage-text'
                frText.textContent = q.frage
                fr.appendChild( frLabel )
                fr.appendChild( document.createTextNode( ' ' ) )
                fr.appendChild( frText )
                body.appendChild( fr )
            }

            // Options (may be only the two defaults custom/topic if no A/B/C were found).
            var optsWrap = document.createElement( 'div' )
            optsWrap.className = 'qw-options'
            var pre = questionNav.state[ qIdx ].selected
            var optionList = q.options || []

            optionList.forEach( function( opt, optIdx ) {
                var row = document.createElement( 'div' )
                row.className = 'qw-option'
                row.setAttribute( 'data-oidx', String( optIdx ) )
                var isSel = pre.indexOf( optIdx ) !== -1
                // AI recommendation grey-preselected (opt-in, optional) — single only.
                var isAi = q.typ === 'single' && Array.isArray( q.preselected ) && q.preselected.indexOf( optIdx ) !== -1
                if( isSel ) { row.classList.add( 'qw-selected' ) }
                if( isAi ) { row.classList.add( 'qw-ai' ) }

                var marker = q.typ === 'single' ? ( isSel ? '◉' : '○' ) : ( isSel ? '☑' : '☐' )
                var keyLabel = ( opt.kind === 'option' ) ? ( '<span class="qw-option-key">' + escHtml( opt.key ) + ')</span> ' ) : ''
                row.innerHTML = '<span class="qw-marker">' + marker + '</span>' + keyLabel
                    + '<span class="qw-option-label">' + escHtml( opt.label ) + ( isAi ? ' <span class="qw-ai-hint">(KI-Empfehlung)</span>' : '' ) + '</span>'

                row.addEventListener( 'click', function() {
                    questionNav.active = qIdx
                    questionNav.lane = 'option'
                    questionNav.optionFocus = optIdx
                    toggleOption( qIdx, optIdx )
                } )
                optsWrap.appendChild( row )
            } )
            body.appendChild( optsWrap )

            // PRD-005 (#25): green AI recommendation line fed from the preselected single option.
            if( q.typ === 'single' && Array.isArray( q.preselected ) && q.preselected.length > 0 ) {
                var aiIdx = q.preselected[ 0 ]
                var aiOpt = ( q.options || [] )[ aiIdx ]
                if( aiOpt ) {
                    // PRD-023 (Kap 11.4): the AI recommendation is its own clearly labelled,
                    // visually separated block (own label span + qw-ai-line styling), not a
                    // run-on sentence after the options.
                    var aiLine = document.createElement( 'div' )
                    aiLine.className = 'qw-ai-line'
                    var aiLabel = document.createElement( 'span' )
                    aiLabel.className = 'qw-ai-label'
                    aiLabel.textContent = 'KI-EMPFEHLUNG'
                    var aiText = document.createElement( 'span' )
                    aiText.className = 'qw-ai-text'
                    aiText.textContent = ( aiOpt.kind === 'option' ? aiOpt.key + ') ' : '' ) + aiOpt.label
                    aiLine.appendChild( aiLabel )
                    aiLine.appendChild( document.createTextNode( ' ' ) )
                    aiLine.appendChild( aiText )
                    body.appendChild( aiLine )
                }
            }

            // Custom-entry input (multi only — F: eigene Eintraege moeglich).
            if( q.allowCustomEntries ) {
                var customRow = document.createElement( 'div' )
                customRow.className = 'qw-custom-row'
                var input = document.createElement( 'input' )
                input.type = 'text'
                input.className = 'qw-custom-input'
                input.placeholder = '+ eigener Eintrag'
                input.addEventListener( 'keydown', function( ev ) {
                    // Let text input flow normally — never hijack typing here.
                    ev.stopPropagation()
                    if( ev.key === 'Enter' && input.value.trim().length > 0 ) {
                        questionNav.state[ qIdx ].custom.push( input.value.trim() )
                        input.value = ''
                        // PRD-026: a new custom entry changes the answer -> reset added state.
                        var cst = questionNav.state[ qIdx ]
                        if( cst.added ) {
                            cst.added = false
                            cst.addedText = null
                            setAddButtonState( qIdx, false )
                            updateSaveAnswersOnlyState()
                        }
                    }
                } )
                customRow.appendChild( input )
                body.appendChild( customRow )
            }

            // Topic chips for carousel left/right navigation (F15).
            if( Array.isArray( q.topicPositions ) && q.topicPositions.length > 0 ) {
                var topics = document.createElement( 'div' )
                topics.className = 'qw-topics'
                q.topicPositions.forEach( function( pos, tIdx ) {
                    var chip = document.createElement( 'span' )
                    chip.className = 'qw-topic-link'
                    chip.setAttribute( 'data-tidx', String( tIdx ) )
                    chip.textContent = 'Topic ' + pos
                    // PRD-025 (Kap 11.6): cursor and jumpability must be consistent — only a
                    // chip with an actual target heading gets the link cursor + click handler.
                    // A dead chip (no matching "Kap. {pos}" heading) stays neutral (qw-dead),
                    // so no pointer-cursor falsely suggests it is clickable.
                    if( findTopicTarget( pos ) ) {
                        chip.addEventListener( 'click', function() {
                            scrollToTopic( pos )
                        } )
                    } else {
                        chip.classList.add( 'qw-topic-dead' )
                    }
                    topics.appendChild( chip )
                } )
                body.appendChild( topics )
            }

            // Footer: unified "Hinzufuegen" (F13 = B) + Leitplanke note.
            var footer = document.createElement( 'div' )
            footer.className = 'qw-footer'
            var addBtn = document.createElement( 'button' )
            addBtn.className = 'qw-add-btn'
            addBtn.textContent = 'Hinzufügen'
            addBtn.addEventListener( 'click', function() { submitQuestionAnswer( qIdx ) } )
            footer.appendChild( addBtn )

            // PRD-005 (#22): secondary footer actions per card — "+ Frage" / "Ablehnen".
            var addQBtn = document.createElement( 'button' )
            addQBtn.className = 'qw-secondary-btn'
            addQBtn.textContent = '+ Frage'
            addQBtn.addEventListener( 'click', function() { addCustomQuestionRow( qIdx ) } )
            footer.appendChild( addQBtn )

            // PRD-006 (Kap 9, Bug 2 / AC-08): "Ablehnen" is reversible. The SAME button
            // toggles between "Ablehnen" and "Ablehnen rückgängig" — rejecting never clears
            // the selection or deletes any data, it only visually collapses + marks the card.
            var rejectBtn = document.createElement( 'button' )
            rejectBtn.className = 'qw-secondary-btn qw-reject-btn'
            rejectBtn.textContent = 'Ablehnen'
            rejectBtn.addEventListener( 'click', function() { toggleRejectQuestion( qIdx ) } )
            footer.appendChild( rejectBtn )

            var note = document.createElement( 'span' )
            note.className = 'qw-note'
            note.textContent = 'Optional — der Standardweg bleibt das Transcript.'
            footer.appendChild( note )
            body.appendChild( footer )

            card.appendChild( body )

            return card
        }

        function toggleOption( qIdx, optIdx ) {
            var q = questionNav.questions[ qIdx ]
            var st = questionNav.state[ qIdx ]
            if( !q || !st ) { return }

            var pos = st.selected.indexOf( optIdx )
            if( q.typ === 'single' ) {
                // Single-select: exactly one (or none — never forced).
                st.selected = pos !== -1 ? [] : [ optIdx ]
            } else {
                if( pos !== -1 ) { st.selected.splice( pos, 1 ) }
                else { st.selected.push( optIdx ) }
            }
            // PRD-026 (Kap 12.1, Scope 3): if the selection changes after "Hinzufügen", the
            // confirmed state and the live selection must never drift apart. Reset the added
            // status (button back to "Hinzufügen") so re-adding is possible.
            if( st.added ) {
                st.added = false
                st.addedText = null
                setAddButtonState( qIdx, false )
                updateSaveAnswersOnlyState()
            }
            refreshOptionMarkers( qIdx )
        }

        function refreshOptionMarkers( qIdx ) {
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( !card ) { return }
            var q = questionNav.questions[ qIdx ]
            var st = questionNav.state[ qIdx ]
            var rows = card.querySelectorAll( '.qw-option' )
            rows.forEach( function( row, optIdx ) {
                var isSel = st.selected.indexOf( optIdx ) !== -1
                row.classList.toggle( 'qw-selected', isSel )
                var marker = row.querySelector( '.qw-marker' )
                if( marker ) {
                    marker.textContent = q.typ === 'single'
                        ? ( isSel ? '◉' : '○' )
                        : ( isSel ? '☑' : '☐' )
                }
            } )
        }

        function renderQuestionFocus() {
            // PRD-004: with the render gate, non-clean questions render as a markdown fallback
            // (not a .qw-card) and may sit BETWEEN interactive cards. The NodeList position is
            // therefore no longer the question index — read the explicit data-qidx the card was
            // built with so focus/selection always map to the correct questionNav state.
            var cards = document.querySelectorAll( '#question-widgets .qw-card' )
            cards.forEach( function( card ) {
                var qIdx = parseInt( card.getAttribute( 'data-qidx' ), 10 )
                if( isNaN( qIdx ) ) { return }
                card.classList.toggle( 'qw-active', qIdx === questionNav.active )
                card.querySelectorAll( '.qw-option' ).forEach( function( row, optIdx ) {
                    var focused = qIdx === questionNav.active && questionNav.lane === 'option' && optIdx === questionNav.optionFocus
                    row.classList.toggle( 'qw-focus', focused )
                } )
                card.querySelectorAll( '.qw-topic-link' ).forEach( function( chip, tIdx ) {
                    var focused = qIdx === questionNav.active && questionNav.lane === 'topic' && tIdx === questionNav.optionFocus
                    chip.classList.toggle( 'qw-focus', focused )
                } )
            } )
        }

        function findTopicTarget( pos ) {
            // PRD-025 (Kap 11.6): build a RegExp that is VALID once this template-literal
            // script reaches the browser. Two backslashes in source => the emitted browser
            // string carries a single backslash => the runtime RegExp escapes the dot
            // (literal "."), \\s the optional space, \\b the closing boundary. The previous
            // four-backslash form produced "\\." in the browser (backslash + any char) and
            // never matched a real "Kapitel 11.7" heading. Returns null when no heading
            // matches — callers use that for cursor + scroll decisions.
            var headings = contentEl.querySelectorAll( 'h1, h2, h3, h4' )
            var target = null
            var re = new RegExp( 'kap(itel)?\\.?\\s*' + String( pos ).replace( '.', '\\.' ) + '\\b', 'i' )
            headings.forEach( function( h ) {
                if( target ) { return }
                if( re.test( h.textContent || '' ) ) { target = h }
            } )

            return target
        }

        function scrollToTopic( pos ) {
            var target = findTopicTarget( pos )
            if( target ) {
                var top = target.getBoundingClientRect().top + window.scrollY - 52
                window.scrollTo( { top: top, behavior: 'smooth' } )
            }
        }

        // PRD-026 (Kap 12.1): "Hinzufügen" injects the answer machine-side into the widget
        // state and flips the button to "hinzugefügt" — NO popup. The previous flow opened
        // the transcript modal; Kap 12.1 explicitly abolishes that. Where/how the answer is
        // held is irrelevant — only deterministic + visibly confirmed matters.
        function buildAnswerText( q, st ) {
            var parts = st.selected.map( function( optIdx ) {
                var opt = q.options[ optIdx ]
                if( !opt ) { return '' }
                if( opt.kind === 'option' ) { return opt.key + ') ' + opt.label }
                return opt.label
            } ).filter( function( s ) { return s.length > 0 } )

            st.custom.forEach( function( c ) { parts.push( c ) } )

            var answerLine = q.typ === 'multi' ? parts.join( '; ' ) : ( parts[ 0 ] || '' )
            // Markdown form unchanged from the previous modal flow: "## Antwort auf {id} — {title}"
            // + answer line, multi joined by "; ".
            var text = '## Antwort auf ' + q.id + ' — ' + q.title + '\\n\\n' + answerLine + '\\n'

            return { answerLine: answerLine, text: text }
        }

        function setAddButtonState( qIdx, added ) {
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( !card ) { return }
            var addBtn = card.querySelector( '.qw-add-btn' )
            if( !addBtn ) { return }
            if( added ) {
                // PRD-006 (AC-07): the button stays CLICKABLE in the done-state and its
                // title advertises the undo path — the "hinzugefügt" quittance is no longer
                // a dead end. A second click runs undoQuestionAnswer.
                addBtn.textContent = 'hinzugefügt ✓ (rückgängig)'
                addBtn.classList.add( 'qw-add-btn--done' )
                addBtn.title = 'Erneut klicken, um das Hinzufügen rückgängig zu machen'
                addBtn.disabled = false
            } else {
                addBtn.textContent = 'Hinzufügen'
                addBtn.classList.remove( 'qw-add-btn--done' )
                addBtn.title = ''
                addBtn.disabled = false
            }
        }

        function submitQuestionAnswer( qIdx ) {
            var q = questionNav.questions[ qIdx ]
            var st = questionNav.state[ qIdx ]
            if( !q || !st ) { return }

            // PRD-006 (Kap 9, Bug 1 / AC-07): "Hinzufügen" is reversible. A second click on
            // an already-added question is an UNDO: it resets st.added + st.addedText and
            // flips the button back to "Hinzufügen". This is the explicit Rückgängig-Pfad the
            // memo demands ("NICHTS wird gelöscht, alles rückgängig machbar").
            if( st.added ) {
                undoQuestionAnswer( qIdx )

                return
            }

            // PRD-006 (AC-09): re-adding after the selection changed simply overwrites
            // st.addedText with the freshly built answer — answers stay changeable.
            var built = buildAnswerText( q, st )

            // Machine injection: store the confirmed answer in the widget state.
            // No transcript-modal is opened (Kap 12.1) — the only feedback is the button.
            st.added = true
            st.addedText = built.text
            setAddButtonState( qIdx, true )
            // PRD-028: a collected answer enables the "ohne Transcript speichern" path.
            updateSaveAnswersOnlyState()
        }

        // PRD-006 (Kap 9, AC-07): explicit undo of a confirmed answer. Resets the added
        // state and the injected text, then restores the button — no data is destroyed,
        // the selection stays exactly as the user left it so re-adding is one click away.
        function undoQuestionAnswer( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st ) { return }

            st.added = false
            st.addedText = null
            setAddButtonState( qIdx, false )
            updateSaveAnswersOnlyState()
        }

        // PRD-005 (#22): "+ Frage" — open the transcript modal pre-filled with a
        // follow-up-question template that references the originating question.
        function addCustomQuestionRow( qIdx ) {
            var q = questionNav.questions[ qIdx ]
            if( !q ) { return }
            var text = '## Rueckfrage zu ' + q.id + ' — ' + q.title + '\\n\\n- '
            if( typeof openTranscriptModal === 'function' ) {
                openTranscriptModal( { content: text } )
            }
        }

        // PRD-006 (Kap 9, Bug 2 / AC-08): "Ablehnen" REVERSIBLE. Rejecting only collapses
        // and visually marks the card — it NEVER clears st.selected and NEVER deletes the
        // question. A second click ("Ablehnen rückgängig") expands the card and removes the
        // rejected mark. All options + custom entries are preserved across the toggle.
        function rejectQuestion( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st || st.rejected === true ) { return }

            st.rejected = true
            // Deliberately do NOT touch st.selected (Bug 2 fix) — the data stays intact.
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( card ) {
                card.classList.add( 'qw-collapsed', 'qw-rejected' )
                var tog = card.querySelector( '.qw-toggle' )
                if( tog ) { tog.textContent = '+' }
                setRejectButtonState( qIdx, true )
            }
        }

        // PRD-006 (AC-08): "Ablehnen rückgängig" — restore a rejected card to normal.
        function undoRejectQuestion( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st || st.rejected !== true ) { return }

            st.rejected = false
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( card ) {
                card.classList.remove( 'qw-collapsed', 'qw-rejected' )
                var tog = card.querySelector( '.qw-toggle' )
                if( tog ) { tog.textContent = '−' }
                setRejectButtonState( qIdx, false )
            }
            // The selection survived the reject, so the markers just need a redraw.
            refreshOptionMarkers( qIdx )
        }

        function toggleRejectQuestion( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st ) { return }
            if( st.rejected === true ) { undoRejectQuestion( qIdx ) }
            else { rejectQuestion( qIdx ) }
        }

        function setRejectButtonState( qIdx, rejected ) {
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( !card ) { return }
            var btn = card.querySelector( '.qw-reject-btn' )
            if( !btn ) { return }
            btn.textContent = rejected ? 'Ablehnen rückgängig' : 'Ablehnen'
            // A rejected card is collapsed, so its footer button is hidden; the toggle lives
            // on the card head (qw-rejected). Keep the head clickable so the user can expand
            // and reach the "Ablehnen rückgängig" button again.
            if( rejected ) { card.setAttribute( 'data-rejected', '1' ) }
            else { card.removeAttribute( 'data-rejected' ) }
        }

        // Carousel keyboard navigation (F15 = A, "wie Claude Code").
        // Active only when a widget is present and the user is not typing in a field.
        document.addEventListener( 'keydown', function( ev ) {
            if( questionNav.active < 0 || questionNav.questions.length === 0 ) { return }

            // Never interfere with text inputs, the transcript modal, or other typing.
            var tag = ( ev.target && ev.target.tagName ) ? ev.target.tagName.toLowerCase() : ''
            if( tag === 'input' || tag === 'textarea' || ( ev.target && ev.target.isContentEditable ) ) { return }
            var modal = document.getElementById( 'transcript-modal' )
            if( modal && !modal.classList.contains( 't-hidden' ) ) { return }

            var widgets = document.getElementById( 'question-widgets' )
            if( !widgets || widgets.children.length === 0 ) { return }

            var q = questionNav.questions[ questionNav.active ]
            var optionCount = ( q.options || [] ).length
            var topicCount = ( q.topicPositions || [] ).length

            if( ev.shiftKey && ( ev.key === 'ArrowUp' || ev.key === 'ArrowDown' ) ) {
                // Shift+Up/Down: switch the active question.
                // PRD-024 (Kap 11.5): circular wrap instead of edge clamping — last + down
                // wraps to first, first + up wraps to last, via ( i + delta + n ) % n.
                // The n === 0 case is already guarded by the early return at the top of
                // this handler (questionNav.questions.length === 0), so modulo is never by 0.
                ev.preventDefault()
                var delta = ev.key === 'ArrowDown' ? 1 : -1
                var n = questionNav.questions.length
                // PRD-001 (Memo 024 Kap 1): the FIRST directional press only engages the already
                // active question (data-qidx=0) — it does not skip ahead. Subsequent presses step.
                var next = questionNav.engaged
                    ? ( ( questionNav.active + delta ) % n + n ) % n
                    : questionNav.active
                questionNav.engaged = true
                questionNav.active = next
                questionNav.lane = 'option'
                questionNav.optionFocus = -1
                // PRD-001 (Memo 024 Kap 1): expand the now-active card by its EXPLICIT data-qidx,
                // never by NodeList position. In the collapsed state non-card fallbacks sit between
                // the cards, so the n-th .qw-card no longer equals data-qidx=n — cards[next] drifted.
                var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + next + '"]' )
                if( card ) {
                    card.classList.remove( 'qw-collapsed' )
                    var tog = card.querySelector( '.qw-toggle' )
                    if( tog ) { tog.textContent = '−' }
                    card.scrollIntoView( { block: 'center', behavior: 'smooth' } )
                }
                renderQuestionFocus()

                return
            }

            if( ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' ) {
                // Left/Right: carousel between the option lane and the topic lane.
                if( topicCount === 0 ) { return }
                ev.preventDefault()
                questionNav.lane = ev.key === 'ArrowRight' ? 'topic' : 'option'
                questionNav.optionFocus = 0
                renderQuestionFocus()

                return
            }

            if( ev.key === 'ArrowUp' || ev.key === 'ArrowDown' ) {
                ev.preventDefault()
                var count = questionNav.lane === 'topic' ? topicCount : optionCount
                if( count === 0 ) { return }
                var step = ev.key === 'ArrowDown' ? 1 : -1
                var cur = questionNav.optionFocus
                cur = cur + step
                if( cur < 0 ) { cur = count - 1 }
                if( cur > count - 1 ) { cur = 0 }
                questionNav.optionFocus = cur
                renderQuestionFocus()

                return
            }

            if( ev.key === ' ' || ev.key === 'Spacebar' ) {
                // Space: toggle/confirm the focused option (or activate the focused topic).
                ev.preventDefault()
                if( questionNav.lane === 'topic' ) {
                    var pos = q.topicPositions[ questionNav.optionFocus ]
                    if( pos !== undefined ) { scrollToTopic( pos ) }
                } else if( questionNav.optionFocus >= 0 ) {
                    toggleOption( questionNav.active, questionNav.optionFocus )
                }

                return
            }

            // PRD-006 (Kap 9, AC-06): Enter on the focused question triggers "Hinzufügen"
            // (identical to the button click, incl. its reversible undo on a second Enter).
            if( ev.key === 'Enter' ) {
                ev.preventDefault()
                submitQuestionAnswer( questionNav.active )

                return
            }

            // PRD-006 (Kap 9, AC-06): a keyboard shortcut to "log in" (confirm) the focused
            // option without the mouse. Ctrl/Cmd+Enter selects the focused option AND adds
            // the answer in one keystroke — the "einloggen per Tastatur"-Aktion.
            if( ev.key === 'l' && ( ev.ctrlKey || ev.metaKey ) ) {
                ev.preventDefault()
                if( questionNav.lane === 'option' && questionNav.optionFocus >= 0 ) {
                    toggleOption( questionNav.active, questionNav.optionFocus )
                }
                submitQuestionAnswer( questionNav.active )

                return
            }

            // PRD-006 (Kap 9, AC-06): Tab cycles the focus WITHIN the active card across the
            // three footer actions (Hinzufügen -> + Frage -> Ablehnen) and back to the option
            // lane. Shift+Tab steps backwards. Keeping the cycle inside the card means the
            // whole interaction is reachable without the mouse.
            if( ev.key === 'Tab' ) {
                ev.preventDefault()
                cycleFooterFocus( ev.shiftKey ? -1 : 1 )

                return
            }

            // PageUp/PageDown: scroll (default browser behaviour is fine — no preventDefault).
        } )

        // PRD-006 (Kap 9, AC-06): focus-cycle helper for the active card's footer buttons.
        // footerFocus -1 means "no footer button focused" (focus is back on the option lane).
        function cycleFooterFocus( step ) {
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + questionNav.active + '"]' )
            if( !card ) { return }
            var buttons = Array.prototype.slice.call( card.querySelectorAll( '.qw-footer button' ) )
            if( buttons.length === 0 ) { return }

            var next = questionNav.footerFocus + step
            // -1 .. buttons.length-1, wrapping so the cycle returns to the option lane.
            if( next < -1 ) { next = buttons.length - 1 }
            if( next > buttons.length - 1 ) { next = -1 }
            questionNav.footerFocus = next

            if( next === -1 ) {
                questionNav.lane = 'option'
                if( questionNav.optionFocus < 0 ) { questionNav.optionFocus = 0 }
                // Move focus off any button back into the document so the global keydown
                // handler (option/topic navigation) regains control. The visual focus marker
                // is the qw-focus class, not native focus (the option rows are plain divs).
                if( document.activeElement && document.activeElement.blur ) { document.activeElement.blur() }
                renderQuestionFocus()

                return
            }

            questionNav.lane = 'footer'
            renderQuestionFocus()
            buttons[ next ].focus()
        }

        function buildTOC( diffData ) {
            var headings = contentEl.querySelectorAll( 'h2' )
            var changedSet = new Set()

            if( diffData && diffData.changedSections ) {
                diffData.changedSections.forEach( function( s ) { changedSet.add( s ) } )
            }

            tocListEl.innerHTML = ''

            headings.forEach( function( heading, idx ) {
                var li = document.createElement( 'li' )
                var text = heading.textContent
                var hasChange = changedSet.has( text )

                li.textContent = text
                li.title = text

                if( hasChange ) {
                    var dot = document.createElement( 'span' )
                    dot.className = 'toc-dot'
                    li.prepend( dot )
                }

                var headingId = heading.id || ( 'toc-heading-' + idx )
                if( !heading.id ) { heading.id = headingId }
                li.setAttribute( 'data-target', headingId )

                li.addEventListener( 'click', function() {
                    var target = document.getElementById( this.getAttribute( 'data-target' ) )
                    if( target ) {
                        var top = target.getBoundingClientRect().top + window.scrollY - 52
                        window.scrollTo( { top: top, behavior: 'smooth' } )
                    }
                } )

                tocListEl.appendChild( li )
            } )

            // PRD-007 (#49): finer granularity — append "Offene Fragen" and
            // "Finalisierungs-Frage" entries when their anchors exist and are not
            // already represented by an h2 entry above.
            ;[ { id: 'offene-fragen', label: 'Offene Fragen' },
                { id: 'finalisierungs-frage', label: 'Finalisierungs-Frage' } ].forEach( function( extra ) {
                var target = document.getElementById( extra.id )
                if( !target ) { return }
                var already = tocListEl.querySelector( 'li[data-target="' + extra.id + '"]' )
                if( already ) { return }
                var li = document.createElement( 'li' )
                li.textContent = extra.label
                li.title = extra.label
                li.setAttribute( 'data-target', extra.id )
                li.addEventListener( 'click', function() {
                    var t = document.getElementById( this.getAttribute( 'data-target' ) )
                    if( t ) {
                        var top = t.getBoundingClientRect().top + window.scrollY - 52
                        window.scrollTo( { top: top, behavior: 'smooth' } )
                    }
                } )
                tocListEl.appendChild( li )
            } )

            updateActiveTOC()
        }

        function updateActiveTOC() {
            var items = tocListEl.querySelectorAll( 'li' )
            if( items.length === 0 ) { return }

            var scrollTop = window.scrollY + 52
            var activeItem = null

            // PRD-019: guarantee exactly one highlight — clear all first.
            items.forEach( function( li ) {
                li.classList.remove( 'toc-active' )
                var targetId = li.getAttribute( 'data-target' )
                var target = document.getElementById( targetId )

                if( target && target.offsetTop <= scrollTop ) {
                    activeItem = li
                }
            } )

            // Fallback: if nothing is above the fold, the first entry stays active (never zero).
            if( !activeItem ) {
                activeItem = items[ 0 ]
            }

            activeItem.classList.add( 'toc-active' )
            activeItem.scrollIntoView( { block: 'nearest', behavior: 'smooth' } )
        }

        window.addEventListener( 'scroll', function() {
            if( tocScrollTimer ) { clearTimeout( tocScrollTimer ) }
            tocScrollTimer = setTimeout( updateActiveTOC, 50 )
        } )

        var tocScrollTimer = null

        // PRD-019: find + scroll to the "Offene Fragen" heading in the rendered content.
        function scrollToOpenQuestions() {
            var headings = contentEl.querySelectorAll( 'h1, h2, h3, h4' )
            var target = null
            headings.forEach( function( h ) {
                if( target ) { return }
                if( /offene\\s+fragen/i.test( h.textContent || '' ) ) {
                    target = h
                }
            } )
            if( target ) {
                var top = target.getBoundingClientRect().top + window.scrollY - 52
                window.scrollTo( { top: top, behavior: 'smooth' } )
            } else {
                window.scrollTo( { top: 0, behavior: 'smooth' } )
            }
        }

        function stripMarkdown( line ) {
            var result = line
            result = result.replace( /^#{1,6}\\s+/, '' )
            result = result.replace( /^[-*+]\\s+/, '' )
            result = result.replace( /^>\\s+/, '' )
            result = result.replace( /^\\d+\\.\\s+/, '' )
            result = result.replace( /\\*\\*/g, '' )
            result = result.replace( /\\*/g, '' )
            result = result.replace( /~~([^~]+)~~/g, '$1' )
            result = result.replace( /\\[([^\\]]+)\\]\\([^)]+\\)/g, '$1' )
            return result.trim()
        }

        function renderDiffView( content, diff ) {
            var banner = '<div class="diff-banner">'
            if( diff.currentFullFile && diff.previousFile ) {
                banner += 'Vergleich Full &harr; Full: <strong>' + diff.currentFullFile + '</strong> vs <strong>' + diff.previousFile + '</strong>'
            } else {
                banner += 'Vergleich mit: <strong>' + diff.previousFile + '</strong>'
            }

            if( diff.skippedUpdates && diff.skippedUpdates.length > 0 ) {
                banner += '<br><span style="color:#8b949e;font-size:0.85em">' + diff.skippedUpdates.length + ' Update(s) uebersprungen: ' + diff.skippedUpdates.join( ', ' ) + '</span>'
            }

            if( diff.changedSections && diff.changedSections.length > 0 ) {
                banner += '<br>Geaenderte Kapitel: '
                banner += diff.changedSections.map( function( s ) {
                    var id = s.toLowerCase().replace( /[^a-z0-9]+/g, '-' )
                    return '<a onclick="document.getElementById(\\'' + id + '\\').scrollIntoView({behavior:\\'smooth\\'})">' + s + '</a>'
                } ).join( ', ' )
            }

            banner += '</div>'

            slugCounts.clear()
            var html = marked.parse( content )

            // PRD-018 (Kap 13): rendered-vs-rendered. The previous side must run through the
            // SAME render pipeline (marked.parse) and use the SAME block selector as the
            // current side, otherwise rendered-block-text is compared against raw stripped
            // lines and almost everything is flagged green (systematic false positives).
            // Selector includes td, th so unchanged table cells are not marked added either.
            var diffBlockSelector = 'p, li, h1, h2, h3, h4, h5, h6, blockquote > p, td, th'

            function collectBlockTexts( rootEl ) {
                var set = new Set()
                rootEl.querySelectorAll( diffBlockSelector ).forEach( function( el ) {
                    if( el.closest( '.diff-banner' ) ) { return }
                    if( el.closest( '.mermaid' ) ) { return }
                    if( el.closest( 'pre' ) ) { return }

                    var text = el.textContent.trim()
                    if( text.length <= 2 ) { return }
                    set.add( text )
                } )
                return set
            }

            var previousTextSet = new Set()
            if( diff.previousContent ) {
                var prevContainer = document.createElement( 'div' )
                prevContainer.innerHTML = marked.parse( diff.previousContent )
                previousTextSet = collectBlockTexts( prevContainer )
            }

            // PRD-018: changedSections is the server-side, reliable chapter granularity.
            // When present, only blocks living under a changed H2 are eligible for the
            // .diff-added marker — this further suppresses false positives in unchanged
            // chapters. When absent, fall back to plain rendered-vs-rendered text equality.
            var changedSectionSet = new Set()
            if( diff.changedSections ) {
                diff.changedSections.forEach( function( s ) { changedSectionSet.add( String( s ).trim() ) } )
            }

            contentEl.innerHTML = banner + html
            interceptLinks()

            document.querySelectorAll( '.mermaid' ).forEach( function( el ) {
                var originalText = el.textContent
                mermaid.render( 'mermaid-' + Math.random().toString( 36 ).slice( 2 ), originalText )
                    .then( function( result ) { el.innerHTML = result.svg } )
                    .catch( function( err ) { el.innerHTML = buildMermaidErrorHtml( err, originalText ) } )
            } )

            if( previousTextSet.size > 0 ) {
                // Track the nearest preceding H2 chapter so changedSections can gate marking.
                var currentChapter = ''
                contentEl.querySelectorAll( diffBlockSelector + ', h2' ).forEach( function( el ) {
                    if( el.closest( '.diff-banner' ) ) { return }
                    if( el.closest( '.mermaid' ) ) { return }
                    if( el.closest( 'pre' ) ) { return }

                    if( el.tagName === 'H2' ) {
                        currentChapter = el.textContent.trim()
                        return
                    }

                    var text = el.textContent.trim()
                    if( text.length <= 2 ) { return }

                    // rendered-vs-rendered: already present on the previous side -> unchanged.
                    if( previousTextSet.has( text ) ) { return }

                    // When changedSections is available, only mark blocks inside a changed
                    // chapter — server-side granularity beats fuzzy text equality.
                    if( changedSectionSet.size > 0 && !changedSectionSet.has( currentChapter ) ) { return }

                    el.classList.add( 'diff-added' )
                } )
            }
        }

        function interceptLinks() {
            contentEl.querySelectorAll( 'a' ).forEach( function( link ) {
                const href = link.getAttribute( 'href' )

                if( !href ) { return }
                if( href.startsWith( 'http://' ) || href.startsWith( 'https://' ) ) { return }
                if( !href.endsWith( '.md' ) ) { return }

                link.addEventListener( 'click', function( e ) {
                    e.preventDefault()

                    if( !currentWs ) { return }
                    currentWs.send( JSON.stringify( { type: 'navigate', path: href } ) )
                    window.scrollTo( 0, 0 )
                } )
            } )
        }

        function connect() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
            const ws = new WebSocket( protocol + '//' + location.host )
            currentWs = ws

            ws.onopen = function() {
                updateConnectionStatus( 'connected' )

                if( reconnectTimer ) {
                    clearInterval( reconnectTimer )
                    reconnectTimer = null
                }
            }

            ws.onmessage = function( event ) {
                const data = JSON.parse( event.data )

                if( data.type === 'pushHistory' ) {
                    history.push( data.path )
                }

                if( data.type === 'documentList' ) {
                    lastTree = data.tree || {}
                    lastLatest = data.latest || []
                    if( currentMode === 'memos' ) {
                        renderSidebar()
                    }
                }

                if( data.type === 'planList' ) {
                    lastPlans = data.plans || []
                    lastOpenMemos = data.openMemos || []
                    if( currentMode === 'plans' ) {
                        renderSidebar()
                    }
                }

                if( data.type === 'transcriptList' ) {
                    lastTranscriptTree = data.tree || {}
                    // PRD-016 (Memo 016 Kap 6.3) Auto-Move: a fresh transcript can push a memo
                    // out of the queue, so the memos sidebar (which renders the queue) must
                    // re-render here — not only the transcript indicators.
                    if( currentMode === 'memos' ) {
                        renderSidebar()
                    } else {
                        updateTranscriptIndicators()
                    }
                    // PRD-005 (Kap 8): an einloggen/ausloggen change updates the per-revision
                    // loggedIn flag in the tree — refresh the sticky-header status row so the
                    // status pill + button label reflect the new state without a page reload.
                    updateSidebarSticky( currentMemoName, currentFileName )
                }

                // PRD-005 (Memo 018 Kap 8 AC-7): dedicated login/logout broadcast. The status
                // refresh itself rides on the transcriptList message above; this branch keeps the
                // event observable for the integration/UI tests and future client-side hooks.
                if( data.type === 'transcriptLoggedIn' || data.type === 'transcriptLoggedOut' ) {
                    // EVENT-HOOK (client): future — surface a toast / drive an agent loop here.
                    updateSidebarSticky( currentMemoName, currentFileName )
                }

                if( data.type === 'content' ) {
                    // notification sound disabled in server mode
                    isFirstLoad = false
                    const scrollY = data.preserveScroll ? window.scrollY : 0
                    lastContent = data.content
                    lastQuestionSchema = data.questionSchema || []
                    lastVorwort = data.vorwort || ''
                    currentDiff = data.diff || null

                    if( currentDiff && currentDiff.hasDiff ) {
                        showDiff = true
                    } else {
                        showDiff = false
                    }
                    // The diff-toggle now lives in the sticky header and is (re)bound there
                    // via updateSidebarSticky -> bindDiffToggle (called later in this handler).

                    if( showDiff && currentDiff ) {
                        renderDiffView( data.content, currentDiff )
                    } else {
                        slugCounts.clear()
                        contentEl.innerHTML = marked.parse( data.content )
                        interceptLinks()

                        document.querySelectorAll( '.mermaid' ).forEach( function( el ) {
                            var originalText = el.textContent
                            mermaid.render( 'mermaid-' + Math.random().toString( 36 ).slice( 2 ), originalText )
                                .then( function( result ) {
                                    el.innerHTML = result.svg
                                } )
                                .catch( function( err ) {
                                    el.innerHTML = buildMermaidErrorHtml( err, originalText )
                                } )
                        } )
                    }

                    applyContentStructure()
                    renderVorwort( lastVorwort )
                    renderQuestionWidgets( lastQuestionSchema )
                    buildTOC( currentDiff )

                    // PRD-019: deep-link from questions icon -> scroll to "Offene Fragen" section.
                    if( pendingQuestionsScroll ) {
                        pendingQuestionsScroll = false
                        scrollToOpenQuestions()
                    } else {
                        window.scrollTo( 0, scrollY )
                    }

                    if( data.fileName ) {
                        currentFileName = data.fileName
                        currentMemoName = data.memoName || ''
                        updateSidebarSticky( data.memoName, data.fileName )
                        var h1 = contentEl.querySelector( 'h1' )
                        var heading = h1 ? h1.textContent.trim() : data.fileName
                        var portEmojis = { '3333': '🔵', '4444': '🟢', '5555': '🟠', '6666': '🔴', '7777': '🟣', '8888': '🩵' }
                        var portEmoji = portEmojis[ window.location.port ] || '⚪'
                        var port = window.location.port || '3333'
                        var versionMatch = data.fileName ? data.fileName.match( /v(\\d+\\.\\d+)/ ) : null
                        var revSuffix = versionMatch ? ' #v' + versionMatch[1] : ''
                        document.title = portEmoji + ' ' + port + ' · ' + heading + revSuffix
                    }
                }
            }

            ws.onclose = function() {
                currentWs = null
                reconnectAttempts++

                if( reconnectAttempts >= 2 ) {
                    updateConnectionStatus( 'offline' )
                }

                if( !reconnectTimer ) {
                    reconnectTimer = setInterval( function() {
                        connect()
                    }, 2000 )
                }
            }

            ws.onerror = function() {
                ws.close()
            }
        }

        (function setFavicon() {
            var colors = { '3333': '#4493f8', '4444': '#3fb950', '5555': '#d29922', '6666': '#f85149', '7777': '#a371f7', '8888': '#39d2c0' }
            var color = colors[ window.location.port ] || '#8b949e'
            var canvas = document.createElement( 'canvas' )
            canvas.width = 64
            canvas.height = 64
            var ctx = canvas.getContext( '2d' )
            ctx.fillStyle = '#0d1117'
            ctx.beginPath()
            ctx.roundRect( 0, 0, 64, 64, 12 )
            ctx.fill()
            ctx.fillStyle = color
            ctx.font = 'bold 40px -apple-system, sans-serif'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText( 'M', 32, 35 )
            var link = document.getElementById( 'favicon' )
            link.href = canvas.toDataURL( 'image/png' )
        })()

        connect()

        var mermaidModal = document.getElementById( 'mermaid-modal' )
        var mermaidModalSvg = document.getElementById( 'mermaid-modal-svg' )

        window.openMermaidModal = function( svgContent ) {
            mermaidModalSvg.innerHTML = svgContent
            var svg = mermaidModalSvg.querySelector( 'svg' )
            if( svg ) {
                var vb = svg.getAttribute( 'viewBox' )
                if( !vb ) {
                    var w = svg.getAttribute( 'width' ) || '800'
                    var h = svg.getAttribute( 'height' ) || '600'
                    svg.setAttribute( 'viewBox', '0 0 ' + parseFloat(w) + ' ' + parseFloat(h) )
                }
                svg.removeAttribute( 'width' )
                svg.removeAttribute( 'height' )
                svg.style.width = '100%'
                svg.style.height = '100%'
            }
            mermaidModal.classList.add( 'open' )
            document.body.style.overflow = 'hidden'
        }

        window.closeMermaidModal = function() {
            mermaidModal.classList.remove( 'open' )
            document.body.style.overflow = ''
        }

        document.addEventListener( 'keydown', function( e ) {
            if( e.key === 'Escape' ) { closeMermaidModal() }
        } )

        document.addEventListener( 'click', function( e ) {
            var mermaidEl = e.target.closest( '.mermaid' )
            if( mermaidEl && !mermaidEl.closest( '#mermaid-modal' ) ) {
                var svg = mermaidEl.querySelector( 'svg' )
                if( svg ) { openMermaidModal( svg.outerHTML ) }
            }
        } )
    </script>
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

        wss.on( 'connection', ( ws ) => {
            clients.add( ws )

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

                                    ws.send( JSON.stringify( { 'type': 'content', 'content': content, 'fileName': revFileName, 'memoName': memoName, 'diff': diff, questionSchema, vorwort, validation } ) )

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
    static deriveBallStatus( { revisionStatus, memoFinalized } ) {
        if( revisionStatus === 'eingeloggt' && memoFinalized === true ) {
            return { 'ballStatus': 'Finalisiert (Locked)' }
        }

        if( revisionStatus === 'transcript-eingetragen' ) {
            return { 'ballStatus': 'Transcript hinterlegt' }
        }

        return { 'ballStatus': 'Wartet auf User-Feedback' }
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
        const message = ( err && err.message ) ? err.message : String( err == null ? '' : err )
        const safeMessage = String( message )
            .replace( /&/g, '&amp;' )
            .replace( /</g, '&lt;' )
            .replace( />/g, '&gt;' )
        const safeOriginal = String( originalText == null ? '' : originalText )
            .replace( /&/g, '&amp;' )
            .replace( /</g, '&lt;' )
            .replace( />/g, '&gt;' )
        const html = '<div class="mermaid-error">Mermaid Error: ' + safeMessage
            + '</div><pre class="mermaid-error-source">' + safeOriginal + '</pre>'

        return { 'html': html }
    }


    // Extracts a revisionId (REV-NN) from a sticky-header fileName like "REV-03.md".
    // Returns null when the fileName does not encode a revision (e.g. plan phases).
    static revisionIdFromFileName( { fileName } ) {
        if( typeof fileName !== 'string' ) { return { 'revisionId': null } }

        const match = fileName.match( /(REV-\d{2,})/ )

        return { 'revisionId': match === null ? null : match[ 1 ] }
    }


    // PRD-013 (Memo 016 Kap 3): Soll-Nummern-Logik for the sticky-header button.
    // next = (highest existing REV number) + 1, previous = highest existing REV number.
    // The number is NEVER derived from the viewed revision suffix (that is the reproduced bug
    // "Revision 2 betrachtet -> 'fuer Revision 3'"). Source is the memo's revisions bestand
    // (rev.fileName), mirrored by the inline browser helper of the same name.
    static nextRevisionNumbers( { revisions } ) {
        const safeRevisions = Array.isArray( revisions ) ? revisions : []

        const numbers = safeRevisions
            .map( ( rev ) => {
                const fileName = rev && typeof rev[ 'fileName' ] === 'string' ? rev[ 'fileName' ] : ''
                const match = fileName.match( /REV-(\d+)/ )

                return match === null ? null : parseInt( match[ 1 ], 10 )
            } )
            .filter( ( n ) => n !== null )

        const previous = numbers.length === 0 ? 0 : Math.max( ...numbers )
        const next = previous + 1

        const struct = {
            previous,
            next,
            'previousId': `REV-${ String( previous ).padStart( 2, '0' ) }`,
            'nextId': `REV-${ String( next ).padStart( 2, '0' ) }`
        }

        return struct
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
