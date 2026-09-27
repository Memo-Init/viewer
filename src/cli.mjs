#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { access, stat } from 'node:fs/promises'
import { resolve, basename, dirname } from 'node:path'
import { execSync } from 'node:child_process'

import { MemoView } from './MemoView.mjs'


const args = parseArgs( {
    args: process.argv.slice( 2 ),
    allowPositionals: true,
    strict: false,
    options: {
        'port': { type: 'string', short: 'p' },
        'status': { type: 'boolean' },
        'stop': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' }
    }
} )

const { positionals, values } = args
const filePath = positionals[ 0 ]


const showHelp = () => {
    const helpText = `

                                        _
   ____ ___  ___  ____ ___  ____       | |  __(_) ___ _      __
  / __ \`__ \\/ _ \\/ __ \`__ \\/ __ \\ _____| | / / / / _ \\ | /| / /
 / / / / / /  __/ / / / / / /_/ /______| |/ / / /  __/ |/ |/ /
/_/ /_/ /_/\\___/_/ /_/ /_/\\____/       |___/_/_/\\___/|__/|__/

Usage: memo-view [options] [path ...]

  Multi-document Markdown live-preview server.
  Mermaid diagrams are rendered as SVG.

  Pass files or directories as arguments — they are auto-added
  as documents. Directories are scanned for REV-XX.md or vX.X.md
  revision files. Without arguments, starts with an empty sidebar.

  Add more documents at runtime via POST /api/documents with JSON:
    { "projectId": "myproject", "memoPath": "/path/to/revisions/" }

Options:
  --port, -p <number>   Server port (default: 3333)
  --status              Show running memo-view servers
  --stop                Stop server on port (default: 3333)
  --help, -h            Show this help message

  Before binding, the port is checked for an owner (M082-09-01). A held port
  is NAMED (pid, originRepo, originBranch, startedAt, bootHash) and the start
  is refused — never moved to another port and never terminated for you.

Examples:
  memo-view
  memo-view .memo/004-feature/revisions/
  memo-view .memo/*/revisions/
  memo-view README.md
  memo-view --port 4444
  memo-view --status
  memo-view --stop
`

    process.stdout.write( helpText )
}


const getPortInfo = ( { port } ) => {
    try {
        const output = execSync( `lsof -iTCP:${port} -sTCP:LISTEN -P -n 2>/dev/null`, { 'encoding': 'utf-8' } )
        const lines = output.trim().split( '\n' ).slice( 1 )
        const results = lines
            .map( ( line ) => {
                const parts = line.split( /\s+/ )
                const result = { 'command': parts[0], 'pid': parts[1], 'port': port }

                return result
            } )

        return { results }
    } catch {
        const results = []

        return { results }
    }
}


const showStatus = () => {
    const port = values[ 'port' ] || '3333'
    const portNumber = parseInt( port, 10 )

    process.stdout.write( '\n' )

    const portsToCheck = values[ 'port' ]
        ? [ portNumber ]
        : [ 3333, 4444, 5555, 6666, 7777, 8888 ]

    let found = false

    portsToCheck
        .forEach( ( p ) => {
            const { results } = getPortInfo( { 'port': p } )

            results
                .filter( ( r ) => r['command'] === 'node' )
                .forEach( ( r ) => {
                    process.stdout.write( `  Port ${r['port']}  PID ${r['pid']}  (${r['command']})\n` )
                    found = true
                } )
        } )

    if( !found ) {
        process.stdout.write( `  No memo-view servers found.\n` )
    }

    process.stdout.write( '\n' )
}


const stopServer = () => {
    const port = values[ 'port' ] || '3333'
    const { results } = getPortInfo( { port } )
    const nodeProcesses = results
        .filter( ( r ) => r['command'] === 'node' )

    process.stdout.write( '\n' )

    if( nodeProcesses.length === 0 ) {
        process.stdout.write( `  No server running on port ${port}.\n` )
    } else {
        nodeProcesses
            .forEach( ( r ) => {
                try {
                    process.kill( parseInt( r['pid'], 10 ), 'SIGTERM' )
                    process.stdout.write( `  Stopped PID ${r['pid']} on port ${r['port']}.\n` )
                } catch {
                    process.stdout.write( `  Could not stop PID ${r['pid']}.\n` )
                }
            } )
    }

    process.stdout.write( '\n' )
}


// M082-09-01 (Memo 082 Kap 20c, WI-115): ask the held port who it is. A plain probe only proves that
// SOMETHING listens — the question chapter 20c left open was WHICH build. The timeout is a deadline on
// a socket, not a pause: a foreign listener that never speaks HTTP would otherwise hold this forever.
const readPortOwner = async ( { port } ) => {
    try {
        const response = await fetch( `http://localhost:${port}/api/health`, { 'signal': AbortSignal.timeout( 2000 ) } )

        if( response.ok !== true ) {
            return { 'health': null }
        }

        const health = await response.json()

        return { health }
    } catch {
        return { 'health': null }
    }
}


// M082-09-01 (WI-115): STEP 0 of the start — run BEFORE the bind, never after. The old order let the
// port selection quietly move a second start to 4444 while the reviewer kept clicking the foreign
// 3333; that is the 20c defect spelled one port further, and it is exactly what this refuses to do.
const guardPort = async ( { port } ) => {
    const { inUse } = await MemoView.probePortInUse( { port } )
    const { health } = inUse === true ? await readPortOwner( { port } ) : { 'health': null }
    const { report } = MemoView.buildPortOwnerReport( { port, inUse, health } )

    return { report }
}


const deriveProjectId = ( { absolutePath } ) => {
    const parts = absolutePath.split( '/' )
    const memoIndex = parts.lastIndexOf( '.memo' )

    if( memoIndex > 0 ) {
        return parts[ memoIndex - 1 ]
    }

    return basename( dirname( absolutePath ) )
}


const run = async () => {
    if( values[ 'status' ] ) {
        showStatus()

        return
    }

    if( values[ 'stop' ] ) {
        stopServer()

        return
    }

    if( values[ 'help' ] ) {
        showHelp()

        return
    }

    const port = values[ 'port' ] || undefined
    const { port: fallbackPort } = MemoView.defaultPort()
    const guardedPort = port === undefined ? fallbackPort : parseInt( port, 10 )
    const { report } = await guardPort( { 'port': guardedPort } )

    if( report[ 'blocked' ] === true ) {
        process.stderr.write( `\n${report[ 'lines' ].join( '\n' )}\n\n` )
        process.exit( 1 )
    }

    const { startResult, registry, port: serverPort } = await MemoView.startServer( { port } )

    if( positionals.length === 0 ) {
        return
    }

    for( const inputPath of positionals ) {
        const absolutePath = resolve( inputPath )

        try {
            await access( absolutePath )
        } catch {
            process.stderr.write( `  Warning: Path not found, skipping: ${absolutePath}\n` )

            continue
        }

        const pathStat = await stat( absolutePath )

        if( pathStat.isDirectory() ) {
            const projectId = deriveProjectId( { absolutePath } )
            const result = await registry.addDocument( { projectId, 'memoPath': absolutePath } )

            if( result['status'] ) {
                // Memo 081, WI-067: the line that HOLDS the documentId now also hands out its address.
                // The port is `serverPort` — the port this process is actually listening on — never the
                // constant 3333: an acceptance fixture measures on another port, and a hard-wired 3333
                // would be a lie in exactly the environment that measures it.
                process.stdout.write( `  Document added: ${result['documentId']} (${result['revisionsFound']} revisions)\n  http://localhost:${serverPort}/doc/${encodeURIComponent( result['documentId'] )}\n` )
            } else {
                process.stderr.write( `  Warning: ${result['messages'].join( '; ' )}\n` )
            }
        } else if( absolutePath.endsWith( '.md' ) ) {
            const dir = dirname( absolutePath )
            const projectId = deriveProjectId( { 'absolutePath': dir } )
            const result = await registry.addDocument( { projectId, 'memoPath': dir } )

            if( result['status'] ) {
                // Memo 081, WI-067: same line, same reasoning as the directory branch above. Both are
                // changed together on purpose — leaving one of two identical lines behind would close
                // the case and leave the class open.
                process.stdout.write( `  Document added: ${result['documentId']} (${result['revisionsFound']} revisions)\n  http://localhost:${serverPort}/doc/${encodeURIComponent( result['documentId'] )}\n` )
            } else {
                process.stderr.write( `  Warning: ${result['messages'].join( '; ' )}\n` )
            }
        } else {
            process.stderr.write( `  Warning: Not a .md file or directory, skipping: ${absolutePath}\n` )
        }
    }
}

run()
