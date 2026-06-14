#!/usr/bin/env node
// PRD-001 (Memo 011 Kap 10) — CLI entry-point for `memo init`. A NEW, separate entry from the
// memo-view server (src/cli.mjs stays untouched). Command name is `memo-init`; the help text
// mirrors the `memo init` sub-command wording. Argument parsing via node:util parseArgs.

import { parseArgs } from 'node:util'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoInit } from '../src/MemoInit.mjs'
import { MemoConfig } from '../src/MemoConfig.mjs'


const here = dirname( fileURLToPath( import.meta.url ) )
const defaultTemplatePath = resolve( here, '..', 'templates', 'REV.md.template' )


const showHelp = () => {
    const helpText = `
Usage: memo-init [options] "<Topic>"
       (mirrors the "memo init" sub-command)

  Initialize a new memo: scans .memo/ for the highest NNN number,
  assigns the next zero-padded 3-digit number, derives the slug, and
  creates .memo/{NNN}-{slug}/revisions/REV-01.md from the REV template.

  NO-OVERWRITE: an existing memo folder or REV-01.md is never clobbered.

Options:
  --memo-dir <path>   Memo directory (default: ./.memo)
  --template <path>   Template file (default: templates/REV.md.template)
  --date <string>     Datum placeholder value (default: today's date)
  --help, -h          Show this help message

Examples:
  memo-init "OAuth Integration"
  memo-init --memo-dir ./.memo "OAuth Integration"
`

    process.stdout.write( `${ helpText }\n` )
}


const todayDate = () => {
    const iso = new Date().toISOString()
    const date = iso.slice( 0, 10 )

    return { date }
}


const run = async () => {
    const { positionals, values } = parseArgs( {
        args: process.argv.slice( 2 ),
        allowPositionals: true,
        strict: false,
        options: {
            'memo-dir': { type: 'string' },
            'template': { type: 'string' },
            'date': { type: 'string' },
            'help': { type: 'boolean', short: 'h' }
        }
    } )

    if( values[ 'help' ] === true ) {
        showHelp()

        return
    }

    const topic = positionals[ 0 ]

    if( typeof topic !== 'string' || topic.trim().length === 0 ) {
        process.stderr.write( 'Error: a topic argument is required, e.g. memo-init "OAuth Integration"\n' )
        showHelp()
        process.exitCode = 1

        return
    }

    const memoDir = typeof values[ 'memo-dir' ] === 'string' ? resolve( values[ 'memo-dir' ] ) : resolve( '.memo' )
    const templatePath = typeof values[ 'template' ] === 'string' ? resolve( values[ 'template' ] ) : defaultTemplatePath
    const date = typeof values[ 'date' ] === 'string' ? values[ 'date' ] : todayDate().date

    const created = await MemoInit.createMemoStructure( { memoDir, topic, templatePath, date } )
    const { number, slug, revPath } = created

    // Optional projectPrefix display — docks onto the PRD-003 config reader. Soft: if config.json
    // is absent the CLI still works (no hard block).
    const { projectPrefix, found } = await MemoConfig.read( { memoDir } )
    const prefixLine = found === true && typeof projectPrefix === 'string'
        ? `\n       Prefix: ${ projectPrefix }`
        : ''

    const relRevisions = join( '.memo', `${ number }-${ slug }`, 'revisions' )
    const relRev = join( relRevisions, 'REV-01.md' )

    const output = `
[DONE] Memo ${ number } — ${ topic }${ prefixLine }
       REV-01 erstellt: ${ relRev }
       memo-view: memo-view ${ relRevisions }/
`

    process.stdout.write( `${ output }\n` )
    void revPath
}


run()
    .catch( ( error ) => {
        const { message } = error
        process.stderr.write( `Error: ${ message }\n` )
        process.exitCode = 1
    } )
