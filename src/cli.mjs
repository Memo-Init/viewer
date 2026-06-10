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
  --port, -p <number>   Server port (default: 3333, auto-increment: 4444, 5555...)
  --status              Show running memo-view servers
  --stop                Stop server on port (default: 3333)
  --help, -h            Show this help message

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
                process.stdout.write( `  Document added: ${result['documentId']} (${result['revisionsFound']} revisions)\n` )
            } else {
                process.stderr.write( `  Warning: ${result['messages'].join( '; ' )}\n` )
            }
        } else if( absolutePath.endsWith( '.md' ) ) {
            const dir = dirname( absolutePath )
            const projectId = deriveProjectId( { 'absolutePath': dir } )
            const result = await registry.addDocument( { projectId, 'memoPath': dir } )

            if( result['status'] ) {
                process.stdout.write( `  Document added: ${result['documentId']} (${result['revisionsFound']} revisions)\n` )
            } else {
                process.stderr.write( `  Warning: ${result['messages'].join( '; ' )}\n` )
            }
        } else {
            process.stderr.write( `  Warning: Not a .md file or directory, skipping: ${absolutePath}\n` )
        }
    }
}

run()
