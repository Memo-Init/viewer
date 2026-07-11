// PRD-022 (Memo 067 WI-6-02): consolidate the historically wandering "other" transcript stores into
// ONE canonical project store, following the .trash principle (Memo 011 Kap 18.6 / TranscriptRegistry
// invariant lines 32-39): NEVER delete a transcript — only copy (dedup by md5) and, for the rogue
// store, move the whole folder to .trash/.
//
// Three historical stores (T014, FAKT):
//   A  {workbenchRoot}/.memo/transcripts/                    (read-only provenance — copied, NOT moved)
//   B  {projectRoot}/.memo/transcripts/                      (CANONICAL target)
//   C  {projectRoot}/.memo/memos/064-*/.memo/transcripts/    (rogue store — copied, then folder -> .trash)
//
// SAFETY: dry-run is the DEFAULT. Nothing is moved or written unless --execute is passed. The bare
// (live) run is a SEPARATE, user-verified step (PRD Risiken & User-Gates). --dry-run is accepted as
// an explicit synonym of the default.
//
// Node rules: 4-space, no semicolons, .mjs, async/await, no for/while (array methods), object returns.

import { readdir, readFile, copyFile, rename, mkdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, sep, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'


const OTHER_FILE_PATTERN = /^(.+?)--other--(\d+)\.md$/


const parseArgs = ( argv ) => {
    const flags = { 'execute': false, 'projectRoot': null }

    argv
        .forEach( ( token ) => {
            if( token === '--execute' || token === '--live' ) {
                flags[ 'execute' ] = true
            } else if( token === '--dry-run' ) {
                flags[ 'execute' ] = false
            } else if( token.startsWith( '--project-root=' ) ) {
                flags[ 'projectRoot' ] = token.slice( '--project-root='.length )
            }
        } )

    return { flags }
}


// Deepest-first list of ancestor directories of startDir (no loops — split + map).
const buildAncestors = ( { startDir } ) => {
    const isAbsolute = startDir.startsWith( sep )
    const parts = startDir
        .split( sep )
        .filter( ( part ) => part.length > 0 )
    const prefix = isAbsolute ? sep : ''

    const ancestors = parts
        .map( ( _, index ) => {
            const slice = parts.slice( 0, parts.length - index )

            return prefix + slice.join( sep )
        } )

    return { ancestors }
}


// A memo-init project root is the nearest ancestor that carries a .memo/memos/ folder.
const resolveProjectRoot = ( { explicit } ) => {
    const struct = { 'status': false, 'projectRoot': null }

    if( typeof explicit === 'string' && explicit.length > 0 ) {
        struct[ 'status' ] = true
        struct[ 'projectRoot' ] = resolve( explicit )

        return struct
    }

    const scriptDir = fileURLToPath( new URL( '.', import.meta.url ) )
    const seeds = [ process.cwd(), scriptDir ]

    const candidates = seeds
        .flatMap( ( seed ) => buildAncestors( { 'startDir': resolve( seed ) } ).ancestors )
        .filter( ( dir ) => existsSync( resolve( dir, '.memo', 'memos' ) ) )

    if( candidates.length === 0 ) {
        return struct
    }

    struct[ 'status' ] = true
    struct[ 'projectRoot' ] = candidates[ 0 ]

    return struct
}


const resolveRogueStore = async ( { projectRoot } ) => {
    const struct = { 'status': false, 'store': null, 'memoFolder': null }
    const memosDir = resolve( projectRoot, '.memo', 'memos' )

    if( !existsSync( memosDir ) ) {
        return struct
    }

    const entries = await readdir( memosDir )
    const match = entries
        .filter( ( name ) => name.startsWith( '064-' ) )
        .map( ( name ) => resolve( memosDir, name ) )
        .find( ( folder ) => existsSync( resolve( folder, '.memo', 'transcripts' ) ) )

    if( match === undefined ) {
        return struct
    }

    struct[ 'status' ] = true
    struct[ 'memoFolder' ] = match
    struct[ 'store' ] = resolve( match, '.memo', 'transcripts' )

    return struct
}


const md5Of = ( { buffer } ) => {
    const digest = createHash( 'md5' )
        .update( buffer )
        .digest( 'hex' )

    return { digest }
}


// Index every *.md in the target: md5 -> present, and the max other-sequence per projectId (for
// collision-free re-numbering of name-but-not-byte collisions).
const indexTarget = async ( { targetDir } ) => {
    const struct = { 'byMd5': new Set(), 'byName': new Map(), 'maxSeqByProject': new Map() }

    if( !existsSync( targetDir ) ) {
        return struct
    }

    const names = ( await readdir( targetDir ) )
        .filter( ( name ) => name.endsWith( '.md' ) )

    await Promise.all(
        names.map( async ( name ) => {
            const buffer = await readFile( resolve( targetDir, name ) )
            const { digest } = md5Of( { buffer } )

            struct[ 'byMd5' ].add( digest )
            struct[ 'byName' ].set( name, digest )

            const otherMatch = name.match( OTHER_FILE_PATTERN )

            if( otherMatch !== null ) {
                const projectId = otherMatch[ 1 ]
                const seq = parseInt( otherMatch[ 2 ], 10 )
                const current = struct[ 'maxSeqByProject' ].get( projectId ) || 0

                struct[ 'maxSeqByProject' ].set( projectId, Math.max( current, seq ) )
            }
        } )
    )

    return { ...struct }
}


// Decide the action for one source file against the target index. Pure planning — no writes.
const planFile = ( { name, digest, index } ) => {
    if( index[ 'byMd5' ].has( digest ) ) {
        return { 'action': 'deduped', 'destName': null }
    }

    const nameCollision = index[ 'byName' ].has( name )

    if( !nameCollision ) {
        return { 'action': 'copied', 'destName': name }
    }

    // Same name, different bytes -> assign a collision-free destination name.
    const otherMatch = name.match( OTHER_FILE_PATTERN )

    if( otherMatch !== null ) {
        const projectId = otherMatch[ 1 ]
        const nextSeq = ( index[ 'maxSeqByProject' ].get( projectId ) || 0 ) + 1
        const destName = `${ projectId }--other--${ String( nextSeq ).padStart( 2, '0' ) }.md`

        index[ 'maxSeqByProject' ].set( projectId, nextSeq )

        return { 'action': 'renamed', 'destName': destName }
    }

    const destName = name.replace( /\.md$/, `--dup-${ digest.slice( 0, 8 ) }.md` )

    return { 'action': 'renamed', 'destName': destName }
}


const processSource = async ( { store, role, targetDir, index, execute } ) => {
    const struct = { 'store': store, 'role': role, 'files': [], 'counts': {} }

    if( !existsSync( store ) ) {
        struct[ 'note' ] = 'store-missing'

        return struct
    }

    const names = ( await readdir( store ) )
        .filter( ( name ) => name.endsWith( '.md' ) )

    // Sequential reduce so re-numbering stays deterministic (index mutates as names are assigned).
    const files = await names.reduce( async ( accPromise, name ) => {
        const acc = await accPromise
        const sourcePath = resolve( store, name )
        const buffer = await readFile( sourcePath )
        const { digest } = md5Of( { buffer } )
        const { action, destName } = planFile( { name, digest, index } )

        if( action === 'copied' || action === 'renamed' ) {
            index[ 'byMd5' ].add( digest )
            index[ 'byName' ].set( destName, digest )

            if( execute === true ) {
                await copyFile( sourcePath, resolve( targetDir, destName ) )
            }
        }

        acc.push( { name, 'md5': digest, action, 'dest': destName } )

        return acc
    }, Promise.resolve( [] ) )

    struct[ 'files' ] = files
    struct[ 'counts' ] = files.reduce( ( acc, file ) => {
        acc[ file[ 'action' ] ] = ( acc[ file[ 'action' ] ] || 0 ) + 1

        return acc
    }, {} )

    return struct
}


const run = async ( { argv } ) => {
    const { flags } = parseArgs( argv )
    const { status: rootStatus, projectRoot } = resolveProjectRoot( { 'explicit': flags[ 'projectRoot' ] } )

    if( !rootStatus ) {
        process.stderr.write( 'CONSOLIDATE-001: could not resolve a memo-init project root (.memo/memos not found). Pass --project-root=PATH.\n' )
        process.exitCode = 1

        return { 'status': false }
    }

    const targetDir = resolve( projectRoot, '.memo', 'transcripts' )
    const workbenchStore = resolve( projectRoot, '..', '..', '.memo', 'transcripts' )
    const { status: rogueStatus, store: rogueStore, memoFolder: rogueMemoFolder } = await resolveRogueStore( { projectRoot } )

    const mode = flags[ 'execute' ] === true ? 'EXECUTE (live)' : 'DRY-RUN (no writes)'
    const timestamp = new Date().toISOString().replace( /[:.]/g, '-' )

    process.stdout.write( `\n=== consolidate-other-stores  [${ mode }] ===\n` )
    process.stdout.write( `projectRoot : ${ projectRoot }\n` )
    process.stdout.write( `target (B)  : ${ targetDir }\n` )
    process.stdout.write( `source A    : ${ workbenchStore } (provenance, copy-only)\n` )
    process.stdout.write( `source C    : ${ rogueStatus ? rogueStore : '(none found)' } (rogue, copy + move-to-trash)\n\n` )

    const index = await indexTarget( { targetDir } )

    const sourceA = await processSource( { 'store': workbenchStore, 'role': 'provenance', targetDir, index, 'execute': flags[ 'execute' ] } )
    const sourceC = rogueStatus === true
        ? await processSource( { 'store': rogueStore, 'role': 'rogue', targetDir, index, 'execute': flags[ 'execute' ] } )
        : { 'store': null, 'role': 'rogue', 'files': [], 'counts': {}, 'note': 'no-rogue-store' }

    // Rogue folder move: only after all its files are safely copied into the target.
    const trashDest = resolve( projectRoot, '.trash', `other-store-rogue-064-${ timestamp }` )
    const rogueMove = rogueStatus === true
        ? { 'from': rogueMemoFolder ? resolve( rogueMemoFolder, '.memo', 'transcripts' ) : rogueStore, 'to': trashDest }
        : null

    if( flags[ 'execute' ] === true && rogueMove !== null ) {
        await mkdir( resolve( projectRoot, '.trash' ), { 'recursive': true } )
        await rename( rogueMove[ 'from' ], rogueMove[ 'to' ] )
    }

    const report = {
        'generatedAt': new Date().toISOString(),
        'mode': flags[ 'execute' ] === true ? 'execute' : 'dry-run',
        'projectRoot': basename( projectRoot ),
        'target': '.memo/transcripts',
        'sources': [ sourceA, sourceC ],
        'rogueMove': rogueMove === null ? null : { 'from': basename( rogueMove[ 'from' ] ), 'to': basename( rogueMove[ 'to' ] ) }
    }

    process.stdout.write( 'PLAN (source -> action, counts):\n' )
    process.stdout.write( `  A provenance : ${ JSON.stringify( sourceA[ 'counts' ] ) } over ${ sourceA[ 'files' ].length } file(s)\n` )
    process.stdout.write( `  C rogue      : ${ JSON.stringify( sourceC[ 'counts' ] ) } over ${ sourceC[ 'files' ].length } file(s)\n` )
    process.stdout.write( `  rogue folder : ${ rogueMove === null ? '(none)' : `${ basename( rogueMove[ 'from' ] ) } -> .trash/${ basename( rogueMove[ 'to' ] ) }` }\n\n` )

    process.stdout.write( 'consolidation-report.json:\n' )
    process.stdout.write( `${ JSON.stringify( report, null, 4 ) }\n` )

    if( flags[ 'execute' ] === true ) {
        const contextDir = resolve( projectRoot, 'context' )
        await mkdir( contextDir, { 'recursive': true } )
        await writeFile( resolve( contextDir, 'consolidation-report.json' ), JSON.stringify( report, null, 4 ), 'utf-8' )
        process.stdout.write( `\nReport written: context/consolidation-report.json\n` )
    } else {
        process.stdout.write( '\nDRY-RUN: no files copied, no folder moved, no report written. Re-run with --execute to apply.\n' )
    }

    return { 'status': true, report }
}


// Only auto-run when invoked directly (not when imported by a unit test).
const invokedDirectly = process.argv[ 1 ] !== undefined
    && import.meta.url === pathToFileURL( process.argv[ 1 ] ).href

if( invokedDirectly ) {
    run( { 'argv': process.argv.slice( 2 ) } )
        .catch( ( error ) => {
            process.stderr.write( `CONSOLIDATE-FATAL: ${ error.message }\n` )
            process.exitCode = 1
        } )
}


export { parseArgs, buildAncestors, resolveProjectRoot, planFile, indexTarget, run }
