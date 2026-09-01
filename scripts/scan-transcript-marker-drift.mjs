#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, relative } from 'node:path'


// PRD-V5 (Memo 080 Kap 16, WI-137) — der wiederholbare Bestands-Scan.
//
// What it measures: how many lines of a transcript file mention the content marker
// "## Transcript-Inhalt". A HEALTHY transcript has exactly TWO — the marker's mention inside the
// Daten/Instruktions-Grenz sentence of the header, and the heading itself. THREE or more means the
// client split at the wrong occurrence, dragged the header rest into the edit field, and the server
// wrapped a SECOND header around it on save (the 2026-08-23 incident).
//
// Read-only by construction: this script opens files, never writes, never renames, never deletes.
// The findings are evidence of the incident (WI-137) and stay untouched — the fix lives in the
// processing, not in a rewrite of the store.
//
// Vacuum-green guard (lesson deterministic-gates-can-be-vacuum-green): a run that inspected ZERO
// files is a FAILURE, not a green run. Every run states HOW MANY files it compared.
//
// Usage:  node scripts/scan-transcript-marker-drift.mjs [--root <dir>] [--json]
// Exit:   0 = ran with a comparison base · 1 = no comparison base (0 files) · 2 = unusable root

const CONTENT_MARKER = '## Transcript-Inhalt'
const HEALTHY_MARKER_LINES = 2


// Argument reading without process.argv gymnastics in the callers: the flags are read once,
// positionally-free, and returned as a struct.
const parseArgs = ( { argv } ) => {
    const rootIndex = argv.indexOf( '--root' )
    const root = rootIndex !== -1 && argv[ rootIndex + 1 ] !== undefined ? argv[ rootIndex + 1 ] : '.memo'
    const asJson = argv.includes( '--json' )

    return { 'root': resolve( root ), asJson }
}


// Recursive directory walk (no for/while per the Node baseline). Collects every `transcripts`
// directory under the root — the memo-bound ones AND the memo-less pools.
const collectTranscriptDirs = async ( { dir } ) => {
    let entries = []

    try {
        entries = await readdir( dir, { 'withFileTypes': true } )
    } catch {
        return { 'dirs': [] }
    }

    const subDirs = entries.filter( ( entry ) => entry.isDirectory() === true )
    const here = subDirs
        .filter( ( entry ) => entry.name === 'transcripts' )
        .map( ( entry ) => join( dir, entry.name ) )

    const nested = await Promise.all(
        subDirs.map( async ( entry ) => {
            const { dirs } = await collectTranscriptDirs( { 'dir': join( dir, entry.name ) } )

            return dirs
        } )
    )

    return { 'dirs': here.concat( nested.flat() ) }
}


// Every *.md below a transcripts dir, including staging pools such as `_incoming/`. Dot-directories
// are skipped on purpose: `.trash/` holds retired copies, they are not part of the live stand.
const collectMarkdownFiles = async ( { dirs } ) => {
    const perDir = await Promise.all( dirs.map( ( dir ) => collectMarkdownFilesIn( { dir } ) ) )

    return { 'files': perDir.flat() }
}


const collectMarkdownFilesIn = async ( { dir } ) => {
    let entries = []

    try {
        entries = await readdir( dir, { 'withFileTypes': true } )
    } catch {
        return []
    }

    const here = entries
        .filter( ( entry ) => entry.isFile() === true && entry.name.endsWith( '.md' ) === true )
        .map( ( entry ) => join( dir, entry.name ) )

    const nested = await Promise.all(
        entries
            .filter( ( entry ) => entry.isDirectory() === true && entry.name.startsWith( '.' ) === false )
            .map( ( entry ) => collectMarkdownFilesIn( { 'dir': join( dir, entry.name ) } ) )
    )

    return here.concat( nested.flat() )
}


// One file -> its marker-line count plus a checksum, so a later run can prove the evidence was
// NOT touched (Assertion 10: "Pruefsumme vor/nach gleich").
const inspectFile = async ( { file } ) => {
    const content = await readFile( file, 'utf-8' )
    const markerLines = content
        .split( '\n' )
        .filter( ( line ) => line.includes( CONTENT_MARKER ) === true )
        .length
    const sha256 = createHash( 'sha256' ).update( content ).digest( 'hex' )
    const { size } = await stat( file )

    return { file, markerLines, sha256, size }
}


const scan = async ( { root } ) => {
    const { dirs } = await collectTranscriptDirs( { 'dir': root } )
    const { files } = await collectMarkdownFiles( { dirs } )
    const inspected = await Promise.all( files.map( ( file ) => inspectFile( { file } ) ) )
    const findings = inspected
        .filter( ( entry ) => entry[ 'markerLines' ] > HEALTHY_MARKER_LINES )
        .sort( ( a, b ) => a[ 'file' ].localeCompare( b[ 'file' ] ) )

    return { 'dirsScanned': dirs.length, 'filesScanned': files.length, findings }
}


const render = ( { root, dirsScanned, filesScanned, findings } ) => {
    const rows = findings
        .map( ( entry ) => `  ${ String( entry[ 'markerLines' ] ).padStart( 2, ' ' ) }  ${ relative( root, entry[ 'file' ] ) }  ${ entry[ 'sha256' ].slice( 0, 12 ) }` )
        .join( '\n' )

    const header = [
        '',
        '  Transcript-Marker-Drift-Scan (PRD-V5 / WI-137)',
        `  Wurzel:            ${ root }`,
        `  transcripts-Ordner:${ String( dirsScanned ).padStart( 5, ' ' ) }`,
        `  Dateien geprueft:  ${ String( filesScanned ).padStart( 5, ' ' ) }`,
        `  Gesunder Stand:    ${ HEALTHY_MARKER_LINES } Marker-Zeilen je Datei`,
        `  Fundstellen:       ${ String( findings.length ).padStart( 5, ' ' ) }`,
        ''
    ].join( '\n' )

    const body = findings.length === 0
        ? '  (keine Datei mit drei oder mehr Marker-Zeilen)\n'
        : `  Anz  Datei  sha256\n${ rows }\n`

    return { 'text': `${ header }${ body }` }
}


const main = async () => {
    const { root, asJson } = parseArgs( { 'argv': process.argv.slice( 2 ) } )
    const { dirsScanned, filesScanned, findings } = await scan( { root } )

    if( asJson === true ) {
        process.stdout.write( `${ JSON.stringify( { root, dirsScanned, filesScanned, 'findingCount': findings.length, findings }, null, 4 ) }\n` )
    } else {
        const { text } = render( { root, dirsScanned, filesScanned, findings } )
        process.stdout.write( text )
    }

    // No comparison base -> RED. A scan that inspected nothing has proven nothing.
    if( filesScanned === 0 ) {
        process.stderr.write( `\n  FEHLSCHLAG: 0 Dateien geprueft unter ${ root } — kein Vergleichsgrund, kein gruener Lauf.\n\n` )
        process.exitCode = filesScanned === 0 && dirsScanned === 0 ? 2 : 1

        return
    }

    process.exitCode = 0
}


// Only run when invoked directly; importing the module (tests) must not execute the scan.
if( process.argv[ 1 ] !== undefined && process.argv[ 1 ].endsWith( 'scan-transcript-marker-drift.mjs' ) === true ) {
    await main()
}


export { scan, inspectFile, collectTranscriptDirs, collectMarkdownFiles, render, CONTENT_MARKER, HEALTHY_MARKER_LINES }
