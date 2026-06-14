#!/usr/bin/env node
// PRD-010 (Memo 011 Kap 9) — CLI gate for the per-memo Findings-Store. This is the SECOND feature of
// the Memo-CLI (the first is `memo init`, PRD-001 / bin/memo-init.mjs). The gate is the ONLY writer:
// no other code path opens findings.db with write access for `findings`.
//
// Command shape: `memo findings <init|put|get>` (sub-command dispatcher; leaf = init|put|get).
// Mirrored as the `memo-findings` bin to match the Phase-1 convention (one bin per `memo` feature,
// src/cli.mjs / bin/memo-init.mjs stay untouched). Argument parsing via node:util parseArgs — no
// direct process.argv field access, no for/while.

import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

import { FindingsStore } from '../src/FindingsStore.mjs'


const showHelp = () => {
    const helpText = `
Usage: memo findings <init|put|get> [options]
       (the second Memo-CLI feature — the CLI gate is the only writer)

Commands:
  init   Initialize <memo>/findings.db (WAL, append-only schema). NO-OVERWRITE.
  put    Append exactly one finding with an orchestrator-generated --id (dedup per ID).
  get    Read shared findings (SELECT only), optionally filtered by --thread.

Options:
  --memo <path>      Memo directory holding findings.db (required)
  --id <hash>        Finding Hash-ID (required for put; orchestrator-generated)
  --thread <t>       Thread name (put: tag; get: filter)
  --author <a>       Author (put)
  --payload <json>   Finding payload, JSON string (put)
  --help, -h         Show this help message

Examples:
  memo findings init --memo ./.memo/011-foo
  memo findings put  --memo ./.memo/011-foo --id abc123 --thread research --author scout --payload '{"k":1}'
  memo findings get  --memo ./.memo/011-foo --thread research
`

    process.stdout.write( `${ helpText }\n` )
}


const emit = ( { result } ) => {
    const line = JSON.stringify( result )

    process.stdout.write( `${ line }\n` )
}


const requireMemo = ( { values } ) => {
    const raw = values[ 'memo' ]

    if( typeof raw !== 'string' || raw.trim().length === 0 ) {
        return { ok: false }
    }

    return { ok: true, memoPath: resolve( raw ) }
}


const runInit = async ( { values } ) => {
    const { ok, memoPath } = requireMemo( { values } )

    if( ok === false ) {
        emit( { result: { status: 'error', error: 'MEMO-FND-002 --memo required', fix: 'pass --memo <path>' } } )
        process.exitCode = 1

        return
    }

    const result = await FindingsStore.init( { memoPath } )
    emit( { result } )
}


const runPut = async ( { values } ) => {
    const { ok, memoPath } = requireMemo( { values } )

    if( ok === false ) {
        emit( { result: { status: 'error', error: 'MEMO-FND-002 --memo required', fix: 'pass --memo <path>' } } )
        process.exitCode = 1

        return
    }

    const result = FindingsStore.put( {
        memoPath,
        id: values[ 'id' ],
        thread: values[ 'thread' ],
        author: values[ 'author' ],
        payload: values[ 'payload' ]
    } )
    emit( { result } )

    if( result[ 'status' ] === 'error' ) {
        process.exitCode = 1
    }
}


const runGet = async ( { values } ) => {
    const { ok, memoPath } = requireMemo( { values } )

    if( ok === false ) {
        emit( { result: { status: 'error', error: 'MEMO-FND-002 --memo required', fix: 'pass --memo <path>' } } )
        process.exitCode = 1

        return
    }

    const result = FindingsStore.get( { memoPath, thread: values[ 'thread' ] } )
    emit( { result } )
}


const dispatch = async ( { command, values } ) => {
    const table = {
        'init': runInit,
        'put': runPut,
        'get': runGet
    }
    const handler = table[ command ]

    if( handler === undefined ) {
        process.stderr.write( `Error: unknown findings command "${ String( command ) }"\n` )
        showHelp()
        process.exitCode = 1

        return
    }

    await handler( { values } )
}


const run = async () => {
    const { positionals, values } = parseArgs( {
        args: process.argv.slice( 2 ),
        allowPositionals: true,
        strict: false,
        options: {
            'memo': { type: 'string' },
            'id': { type: 'string' },
            'thread': { type: 'string' },
            'author': { type: 'string' },
            'payload': { type: 'string' },
            'help': { type: 'boolean', short: 'h' }
        }
    } )

    if( values[ 'help' ] === true ) {
        showHelp()

        return
    }

    // Accept both `memo-findings init …` and `memo findings init …` (the latter via the `memo`
    // umbrella): drop a leading literal "findings" positional if present.
    const cleaned = positionals[ 0 ] === 'findings' ? positionals.slice( 1 ) : positionals
    const command = cleaned[ 0 ]

    if( typeof command !== 'string' || command.trim().length === 0 ) {
        process.stderr.write( 'Error: a findings sub-command is required (init|put|get)\n' )
        showHelp()
        process.exitCode = 1

        return
    }

    await dispatch( { command, values } )
}


run()
    .catch( ( error ) => {
        const { message } = error
        process.stderr.write( `Error: ${ message }\n` )
        process.exitCode = 1
    } )
