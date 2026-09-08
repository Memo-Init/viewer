import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

import { extractFunctionSources, readEmittedScript } from '../helpers/extractFunction.mjs'
import { TranscriptHeader, CONTENT_MARKER } from '../../src/TranscriptHeader.mjs'
import { UserInputCapture } from '../../src/UserInputCapture.mjs'


// PRD-32 (Memo 081, WI-119/WI-123/WI-124) — the guard over the marker split.
//
// The asymmetry WI-123 describes was CLOSED by Memo 080 / PRD-V5 (commit 97863e2): both client
// split sites carry the two trailing newlines today, and one exported server constant feeds both
// sides. This file does not change that — it nails it down, and it closes the hole the existing
// guard still leaves: TranscriptSplitAndDedupePRDV5 counts two KNOWN spellings
// (`var marker = '…'`), so a third split site written inline or under another variable name slips
// through both of its counts while it stays green.
//
// The rule here is different: EVERY occurrence of the marker string in the emitted client is
// classified — comment, display text or split site — and every split site must carry the two
// newlines. An occurrence that cannot be classified is a failure, not a remainder.
//
// It also binds the SECOND marker pair, `## Antwort auf F{N}`. Server and client split that one
// with two independent implementations (a regex in UserInputCapture, a line state machine in the
// client). Measured over the whole recordings stock the two agree today (758 blocks against 758
// over 171 files), so this is a watchman, not a rebuild — and the one place where they provably
// differ is written down rather than left unsaid.
//
// Repo boundary: everything read here lives inside this repository. CI checks it out alone.
//
// Every case states HOW MUCH it compared. A case that compared nothing is a failure, never a pass.
const here = dirname( fileURLToPath( import.meta.url ) )
const fixturePath = resolve( here, '..', 'fixtures', 'transcript-damaged-double-header.md' )

const MARKER_TEXT = '## Transcript-Inhalt'

const sha = ( text ) => createHash( 'sha256' ).update( text ).digest( 'hex' )

const report = ( { label, counts } ) => console.log( `      [PRD-32] ${ label }: ${ counts }` )

let clientScript = ''
let damagedFixture = ''


beforeAll( async () => {
    clientScript = await readEmittedScript()
    damagedFixture = await readFile( fixturePath, 'utf8' )
} )


// Offsets of every occurrence of the marker string, derived from the split parts so no index
// arithmetic has to be trusted twice.
const occurrenceOffsets = ( { script } ) => {
    const parts = script.split( MARKER_TEXT )

    return parts
        .slice( 0, -1 )
        .map( ( _, index ) => {
            const before = parts
                .slice( 0, index + 1 )
                .reduce( ( sum, part ) => sum + part.length, 0 )

            return before + index * MARKER_TEXT.length
        } )
}


// Content-based classification, never line-number based. A split site is an occurrence whose
// literal is fed to indexOf / slice / split — either on its own line or through a variable that is
// used that way a few lines further down. Display text is an occurrence inside markup.
const classifyLine = ( { lines, lineIndex } ) => {
    const line = lines[ lineIndex ]
    const trimmed = line.trim()

    if( trimmed.startsWith( '//' ) === true || trimmed.startsWith( '*' ) === true ) {
        return 'comment'
    }

    const bound = line.match( /(?:var|let|const)\s+(\w+)\s*=/ )
    const window = lines.slice( lineIndex, lineIndex + 8 ).join( '\n' )
    const boundIsSplit = bound !== null
        && new RegExp( `\\b${ bound[ 1 ] }\\b` ).test( window.slice( line.length ) ) === true
        && /\.indexOf\(|\.lastIndexOf\(|\.split\(|\.slice\(/.test( window ) === true

    if( boundIsSplit === true || /\.indexOf\(|\.lastIndexOf\(|\.split\(/.test( line ) === true ) {
        return 'split'
    }

    if( /innerHTML|html \+=|'<|"</.test( line ) === true ) {
        return 'display'
    }

    return 'unclassified'
}


const markerOccurrences = ( { script } ) => {
    const lines = script.split( '\n' )

    return occurrenceOffsets( { script } )
        .map( ( offset ) => {
            const lineIndex = script.slice( 0, offset ).split( '\n' ).length - 1

            return { offset, lineIndex, 'line': lines[ lineIndex ], 'kind': classifyLine( { lines, lineIndex } ) }
        } )
}


// The literal AS WRITTEN in the client, decoded. Read from the source, never typed here — that is
// exactly the hole in the older guard, which compared a hand-typed string against the constant and
// therefore never touched the client file at all.
const literalOfLine = ( { line } ) => {
    const matched = line.match( /'((?:[^'\\]|\\.)*## Transcript-Inhalt(?:[^'\\]|\\.)*)'/ )

    if( matched === null ) {
        return null
    }

    return matched[ 1 ].replaceAll( '\\n', '\n' ).replaceAll( '\\t', '\t' )
}


async function buildHealthyTranscript() {
    const { status, header } = TranscriptHeader.build( { 'type': 'revision', 'memoId': '081-memo-maschine', 'revisionId': 'REV-01', 'maxRevNumber': 1 } )

    if( status !== true ) { throw new Error( 'fixture build failed' ) }

    return `${ header }Spoken text of the user.\n`
}


describe( 'PRD-32 pair 1 — every marker occurrence in the client is classified and every split carries the newlines', () => {

    it( 'T-A: classifies EVERY occurrence and no split site drops the two newlines', () => {
        const occurrences = markerOccurrences( { 'script': clientScript } )
        const byKind = occurrences.reduce( ( acc, entry ) => ( { ...acc, [ entry[ 'kind' ] ]: ( acc[ entry[ 'kind' ] ] || 0 ) + 1 } ), {} )
        const splits = occurrences.filter( ( entry ) => entry[ 'kind' ] === 'split' )
        const unclassified = occurrences.filter( ( entry ) => entry[ 'kind' ] === 'unclassified' )
        const bareSplits = splits.filter( ( entry ) => literalOfLine( { 'line': entry[ 'line' ] } ) !== CONTENT_MARKER )

        report( { 'label': 'T-A occurrences', 'counts': `${ occurrences.length } total, by kind ${ JSON.stringify( byKind ) }` } )

        // Vacuum guard: a run that found no occurrence and no split site has checked nothing.
        expect( occurrences.length ).toBeGreaterThan( 0 )
        expect( splits.length ).toBeGreaterThan( 0 )

        // Nothing may fall between the classes — an occurrence nobody can name is the very shape
        // through which a third split site would enter unseen.
        expect( unclassified.map( ( entry ) => entry[ 'line' ].trim() ) ).toEqual( [] )

        // The invariant itself: every split site splits on the SERVER form.
        expect( bareSplits.map( ( entry ) => entry[ 'line' ].trim() ) ).toEqual( [] )
    } )


    it( 'T-B: the split literal READ FROM the client is byte-equal to the exported server constant', () => {
        const splits = markerOccurrences( { 'script': clientScript } ).filter( ( entry ) => entry[ 'kind' ] === 'split' )
        const literals = splits.map( ( entry ) => literalOfLine( { 'line': entry[ 'line' ] } ) )

        report( { 'label': 'T-B split literals read from client', 'counts': `${ literals.length } compared against CONTENT_MARKER (${ Buffer.byteLength( CONTENT_MARKER ) } bytes)` } )

        expect( literals.length ).toBeGreaterThan( 0 )
        expect( literals.filter( ( literal ) => literal === null ) ).toEqual( [] )
        expect( literals.map( ( literal ) => Buffer.byteLength( literal ) ) ).toEqual( literals.map( () => Buffer.byteLength( CONTENT_MARKER ) ) )
        expect( literals.map( ( literal ) => sha( literal ) ) ).toEqual( literals.map( () => sha( CONTENT_MARKER ) ) )
    } )


    it( 'T-C: on a HEALTHY transcript the server strip and the client split yield the same body', async () => {
        const healthy = await buildHealthyTranscript()
        const serverSide = TranscriptHeader.stripHeader( { 'content': healthy } )[ 'body' ]
        const clientSide = healthy.slice( healthy.indexOf( CONTENT_MARKER ) + CONTENT_MARKER.length )

        report( { 'label': 'T-C body comparison', 'counts': `${ Buffer.byteLength( serverSide ) } bytes server vs ${ Buffer.byteLength( clientSide ) } bytes client, transcript ${ Buffer.byteLength( healthy ) } bytes` } )

        // Vacuum guard: an empty body would make any equality trivially true.
        expect( Buffer.byteLength( serverSide ) ).toBeGreaterThan( 0 )
        expect( sha( clientSide ) ).toBe( sha( serverSide ) )
    } )


    it( 'T-D: the bare split lands INSIDE the header, the server form lands on the content', async () => {
        const healthy = await buildHealthyTranscript()
        const bareAt = damagedFixture.indexOf( MARKER_TEXT )
        const markerAt = damagedFixture.indexOf( CONTENT_MARKER )

        // Vacuum guard FIRST: if both splits landed on the same offset this case would prove
        // nothing at all, however green it looked.
        report( { 'label': 'T-D split offsets in the damaged fixture', 'counts': `bare at ${ bareAt }, server form at ${ markerAt }, distance ${ markerAt - bareAt } bytes over ${ Buffer.byteLength( damagedFixture ) } bytes` } )
        expect( bareAt ).toBeGreaterThanOrEqual( 0 )
        expect( markerAt ).toBeGreaterThan( bareAt )

        // The old defect, demonstrated on a HEALTHY file: the bare split drags the header rest in,
        // the server form does not. Both directions, so neither can be green by absence.
        const bareBody = healthy.slice( healthy.indexOf( MARKER_TEXT ) + MARKER_TEXT.length )
        const properBody = healthy.slice( healthy.indexOf( CONTENT_MARKER ) + CONTENT_MARKER.length )

        expect( TranscriptHeader.detectInBody( { 'content': bareBody } )[ 'hasHeaderSignature' ] ).toBe( true )
        expect( TranscriptHeader.detectInBody( { 'content': properBody } )[ 'hasHeaderSignature' ] ).toBe( false )

        // And the damage the incident left behind is still detectable as such — the guard that
        // rejects it on PUT has something to see.
        const damagedBody = damagedFixture.slice( markerAt + CONTENT_MARKER.length )

        expect( TranscriptHeader.detectInBody( { 'content': damagedBody } )[ 'hasHeaderSignature' ] ).toBe( true )
    } )
} )


describe( 'PRD-32 pair 2 — the answer-block split is implemented twice and the two are held together', () => {

    // The lift happens INSIDE the cases, not in a beforeAll: a lift that throws in setup kills the
    // whole file before a single assertion runs, and a red file with zero evaluated assertions
    // proves as little as a green one over an empty set.
    const loadClientSplitter = async () => {
        const lifted = await extractFunctionSources( [ 'splitAnswerBlocks' ] )
        const sandbox = { console }

        vm.createContext( sandbox )
        vm.runInContext( `${ lifted[ 'source' ] }\nglobalThis.__split = splitAnswerBlocks;`, sandbox )

        return sandbox.__split
    }

    const countServerBlocks = ( { text } ) => UserInputCapture.parseAnswerBlocks( { 'content': text } )[ 'answers' ].length

    const countClientBlocks = ( { splitter, text } ) => {
        const { answersMd } = splitter( text )

        return ( answersMd.match( /^##\s+Antwort auf\s+F\d+/gm ) || [] ).length
    }

    // The headings are the product's own tokens and stay verbatim — they ARE the thing under test.
    // Everything around them is free text and is written in the code language of this file.
    const samples = [
        'Spoken text only, no blocks.',
        [ 'Text.', '', '## Antwort auf F1 — First question', '', 'A) one answer' ].join( '\n' ),
        [ 'Text.', '', '## Antwort auf F1 — First', '', 'A) one', '', '## Antwort auf F2 — Second', '', 'B) two' ].join( '\n' ),
        [ 'Text.', '', '## Antwort auf F3 — Third', '', 'C) three', '', '## Anmerkungen', '', 'A remark.' ].join( '\n' ),
        [ 'Text.', '', '## Antwort auf F1 — First', '', 'A) one', '', '## Quality-Checks angefragt', '', '- evidence' ].join( '\n' ),
        [ '## Antwort auf F9 — Ninth', '', 'Z) nine' ].join( '\n' )
    ]


    it( 'T-E: server regex and client state machine count the SAME number of blocks', async () => {
        const splitter = await loadClientSplitter()
        const pairs = samples.map( ( text ) => ( { 'server': countServerBlocks( { text } ), 'client': countClientBlocks( { splitter, text } ) } ) )
        const blocksSeen = pairs.reduce( ( sum, pair ) => sum + pair[ 'server' ], 0 )

        report( { 'label': 'T-E answer blocks', 'counts': `${ samples.length } samples, ${ blocksSeen } blocks, pairs ${ pairs.map( ( pair ) => `${ pair[ 'server' ] }/${ pair[ 'client' ] }` ).join( ' ' ) }` } )

        // Vacuum guard: samples that carry no block at all would make the equality meaningless.
        expect( samples.length ).toBeGreaterThan( 0 )
        expect( blocksSeen ).toBeGreaterThan( 0 )
        expect( pairs.map( ( pair ) => pair[ 'client' ] ) ).toEqual( pairs.map( ( pair ) => pair[ 'server' ] ) )
    } )


    it( 'T-F: for an EMPTY answer the two provably differ — the server drops it, the client keeps it', async () => {
        const splitter = await loadClientSplitter()
        const empty = [ 'Text.', '', '## Antwort auf F1 — First question', '', '' ].join( '\n' )
        const server = countServerBlocks( { 'text': empty } )
        const client = countClientBlocks( { splitter, 'text': empty } )

        report( { 'label': 'T-F known divergence', 'counts': `1 sample, server ${ server } vs client ${ client }` } )

        // This is NOT a defect being asserted as correct — it is the one measured point where the
        // two implementations disagree, written down so the day it starts to matter is visible.
        // Unifying them touches behaviour and two files PRD-32 does not own; it stays named debt.
        expect( server ).toBe( 0 )
        expect( client ).toBe( 1 )
    } )
} )
