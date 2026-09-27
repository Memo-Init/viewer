import { describe, it, expect, beforeAll } from '@jest/globals'

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { readEmittedScript, readMemoViewStyles } from '../helpers/extractFunction.mjs'


// PRD-11 (Memo 082 Kap 33 S1, WI-232) — the Zone-1 button parity gate.
//
// WHY THIS FILE CONTAINS NO BUTTON NAMES. app.css carries a comment describing a fix of exactly this
// class: Zone-1 buttons rendered as raw default-browser boxes and were enrolled into the shared pill
// rules. The test written alongside that fix NAMES the two buttons it checks — so when a further
// Zone-1 button was added years later it stayed green while the new button rendered unstyled. A fix
// closes the CASE; only a derived set closes the CLASS. The set here is therefore read out of the
// Zone-1 builder in app.client.mjs, and the last case asserts that no derived id occurs as a literal
// in this very file — the machine-checked form of "do not turn this back into a list".
//
// WHAT IS COMPARED, AND WHY NOT EVERYTHING. Per state (base, :hover, .active, whatever else the
// stylesheet grows), the widest SHARED rule — the one naming the most Zone-1 buttons, earliest in
// source order on a tie — defines the look of that state. Its property names are the comparison set,
// and every Zone-1 button must resolve them to the same value. Narrower shared rules are deliberate
// refinements (one button legitimately carrying no left margin is not a parity defect), so their
// properties are out of the comparison by construction rather than by an exception list.
//
// Every case states HOW MANY buttons and HOW MANY properties it compared. A case that compared
// nothing is a failure, never a pass.

const ZONE1_OPEN = 'var z1Line1 = \'<div class="z1-line1"'
const ZONE1_CLOSE = 'var titleRow = \'<div class="hdr-zone hdr-zone-1"'
const PROBE_ID = 'zone1-parity-probe'

const report = ( { label, counts } ) => console.log( `      [PRD-11] ${ label }: ${ counts }` )


// The Zone-1 markup region of the client builder, bounded by two markers that name Zone 1 itself.
// A missing, duplicated or inverted marker aborts LOUDLY and says so: a silently empty region would
// hand back an empty set, and an empty set passes every parity assertion there is.
const zone1Region = ( clientSource ) => {
    const open = clientSource.indexOf( ZONE1_OPEN )
    const close = clientSource.indexOf( ZONE1_CLOSE )

    if( open === -1 ) { throw new Error( 'ZONE-1 ANCHOR NOT FOUND: opening marker missing in app.client.mjs' ) }
    if( close === -1 ) { throw new Error( 'ZONE-1 ANCHOR NOT FOUND: closing marker missing in app.client.mjs' ) }
    if( close <= open ) { throw new Error( 'ZONE-1 ANCHOR ORDER: the closing marker precedes the opening marker' ) }
    if( clientSource.indexOf( ZONE1_OPEN, open + 1 ) !== -1 ) { throw new Error( 'ZONE-1 ANCHOR AMBIGUOUS: the opening marker occurs more than once' ) }
    if( clientSource.indexOf( ZONE1_CLOSE, close + 1 ) !== -1 ) { throw new Error( 'ZONE-1 ANCHOR AMBIGUOUS: the closing marker occurs more than once' ) }

    return clientSource.slice( open, close )
}


// Derived, never enumerated: every <button> the Zone-1 builder emits. A button tag without an id is
// reported as its own number instead of being dropped — it would be invisible to every rule below.
const deriveZone1Buttons = ( clientSource ) => {
    const tags = zone1Region( clientSource ).match( /<button\b[^>]*>/g ) || []
    const found = tags
        .map( ( tag ) => ( tag.match( /\sid="([A-Za-z0-9_-]+)"/ ) || [ null, null ] )[ 1 ] )

    return {
        'ids': found.filter( ( id ) => id !== null ),
        'anonymous': found.filter( ( id ) => id === null ).length,
        'tags': tags.length
    }
}


// Comments are stripped first and not by convenience: this stylesheet has comment bodies containing
// braces, and a brace scanner that reads them counts a block that does not exist.
const stripComments = ( css ) => css.replace( /\/\*[\s\S]*?\*\//g, '' )


// Declaration blocks only — a nesting-aware scan, so an @media wrapper contributes its inner rules
// and not itself. No loop statement: the character walk is a reduce.
const parseRules = ( css ) => {
    const seed = { 'mark': 0, 'open': [], 'rules': [] }
    const walked = css
        .split( '' )
        .reduce( ( acc, ch, idx ) => {
            if( ch === '{' ) {
                acc[ 'open' ].push( { 'selector': css.slice( acc[ 'mark' ], idx ).trim(), 'bodyStart': idx + 1, 'nested': false } )
                acc[ 'mark' ] = idx + 1

                return acc
            }
            if( ch === '}' ) {
                const frame = acc[ 'open' ].pop()
                const parent = acc[ 'open' ][ acc[ 'open' ].length - 1 ]

                if( parent !== undefined ) { parent[ 'nested' ] = true }
                if( frame !== undefined && frame[ 'nested' ] === false ) {
                    acc[ 'rules' ].push( { 'selector': frame[ 'selector' ], 'body': css.slice( frame[ 'bodyStart' ], idx ) } )
                }
                acc[ 'mark' ] = idx + 1

                return acc
            }

            return acc
        }, seed )

    return walked[ 'rules' ]
}


const parseDeclarations = ( body ) => body
    .split( ';' )
    .map( ( part ) => part.trim() )
    .filter( ( part ) => part.indexOf( ':' ) !== -1 )
    .reduce( ( acc, part ) => {
        const colon = part.indexOf( ':' )
        const property = part.slice( 0, colon ).trim()

        if( property.length > 0 ) { acc[ property ] = part.slice( colon + 1 ).trim() }

        return acc
    }, {} )


// The state a selector part addresses for a given id: '' for the bare id, ':hover' / '.active' /
// whatever else follows it. null when the part does not address the id at all — '#a-toggle-wide'
// must not read as '#a-toggle' with the suffix '-wide'.
const suffixOf = ( part, id ) => {
    const compound = part
        .split( /[\s>+~]+/ )
        .filter( ( piece ) => piece.length > 0 )
        .pop() || ''
    const head = `#${ id }`

    if( compound.startsWith( head ) !== true ) { return null }

    const rest = compound.slice( head.length )

    if( rest.length > 0 && /^[A-Za-z0-9_-]/.test( rest ) === true ) { return null }

    return rest
}


// One row per (rule, button, state) contact point — the flat form every later step groups over.
const contactPoints = ( { rules, ids } ) => rules
    .map( ( rule, ruleIndex ) => ( { rule, ruleIndex } ) )
    .flatMap( ( { rule, ruleIndex } ) => {
        const parts = rule[ 'selector' ]
            .split( ',' )
            .map( ( part ) => part.trim() )
            .filter( ( part ) => part.length > 0 )

        return ids.flatMap( ( id ) => {
            const suffixes = parts
                .map( ( part ) => suffixOf( part, id ) )
                .filter( ( suffix ) => suffix !== null )

            return suffixes
                .filter( ( suffix, at ) => suffixes.indexOf( suffix ) === at )
                .map( ( suffix ) => ( { ruleIndex, id, suffix } ) )
        } )
    } )


// Per state: the widest shared rule. Most members wins; earliest in source order breaks a tie — the
// base look is declared before any refinement of it, so source order is the meaningful tiebreak and
// not a coin toss.
const parityGroups = ( { rules, points } ) => {
    const states = points
        .map( ( point ) => point[ 'suffix' ] )
        .filter( ( suffix, at, all ) => all.indexOf( suffix ) === at )

    return states.map( ( suffix ) => {
        const here = points.filter( ( point ) => point[ 'suffix' ] === suffix )
        const candidates = here
            .map( ( point ) => point[ 'ruleIndex' ] )
            .filter( ( ruleIndex, at, all ) => all.indexOf( ruleIndex ) === at )
            .map( ( ruleIndex ) => ( {
                ruleIndex,
                'members': here.filter( ( point ) => point[ 'ruleIndex' ] === ruleIndex ).map( ( point ) => point[ 'id' ] )
            } ) )
            .sort( ( a, b ) => ( b[ 'members' ].length - a[ 'members' ].length ) || ( a[ 'ruleIndex' ] - b[ 'ruleIndex' ] ) )
        const widest = candidates[ 0 ]

        return {
            suffix,
            'ruleIndex': widest[ 'ruleIndex' ],
            'selector': rules[ widest[ 'ruleIndex' ] ][ 'selector' ],
            'members': widest[ 'members' ],
            'properties': Object.keys( parseDeclarations( rules[ widest[ 'ruleIndex' ] ][ 'body' ] ) )
        }
    } )
}


// What a button actually resolves to for one state: every rule that addresses it, in source order,
// last declaration wins. A button enrolled in the shared rule but overridden afterwards fails here —
// membership alone would not have caught that.
const effectiveFor = ( { rules, points, id, suffix } ) => points
    .filter( ( point ) => point[ 'id' ] === id && point[ 'suffix' ] === suffix )
    .map( ( point ) => point[ 'ruleIndex' ] )
    .sort( ( a, b ) => a - b )
    .reduce( ( acc, ruleIndex ) => ( { ...acc, ...parseDeclarations( rules[ ruleIndex ][ 'body' ] ) } ), {} )


const compareState = ( { rules, points, ids, group } ) => {
    const reference = group[ 'members' ][ 0 ]
    const referenceValues = effectiveFor( { rules, points, 'id': reference, 'suffix': group[ 'suffix' ] } )

    return {
        reference,
        'comparedButtons': ids.length,
        'comparedProperties': group[ 'properties' ].length,
        'offenders': ids
            .filter( ( id ) => id !== reference )
            .map( ( id ) => {
                const values = effectiveFor( { rules, points, id, 'suffix': group[ 'suffix' ] } )
                const differing = group[ 'properties' ]
                    .filter( ( property ) => values[ property ] !== referenceValues[ property ] )

                return { id, 'differs': differing }
            } )
            .filter( ( entry ) => entry[ 'differs' ].length > 0 )
    }
}


let clientScript = ''
let styles = ''
let zone1 = { 'ids': [], 'anonymous': 0, 'tags': 0 }
let rules = []
let points = []
let groups = []


beforeAll( async () => {
    clientScript = await readEmittedScript()
    styles = await readMemoViewStyles()

    zone1 = deriveZone1Buttons( clientScript )
    rules = parseRules( stripComments( styles ) )
    points = contactPoints( { rules, 'ids': zone1[ 'ids' ] } )
    groups = parityGroups( { rules, points } )
} )


describe( 'Zone-1 buttons all carry the shared toggle look (PRD-11, WI-232)', () => {
    it( 'derives the Zone-1 button set from the surface builder and states its size', () => {
        report( { 'label': 'zone-1 set', 'counts': `${ zone1[ 'ids' ].length } buttons derived from ${ zone1[ 'tags' ] } <button> tags — ${ zone1[ 'ids' ].join( ', ' ) }` } )

        // > 1 and not merely > 0: a parity test over a single button compares nothing.
        expect( zone1[ 'ids' ].length ).toBeGreaterThan( 1 )
        expect( zone1[ 'anonymous' ] ).toBe( 0 )
        expect( zone1[ 'ids' ].length ).toBe( zone1[ 'tags' ] )
    } )


    it( 'finds at least one shared styling group and states how many buttons it names', () => {
        const shared = groups.filter( ( group ) => group[ 'members' ].length > 1 )

        report( { 'label': 'styling groups', 'counts': shared
            .map( ( group ) => `state "${ group[ 'suffix' ] || 'base' }" names ${ group[ 'members' ].length }/${ zone1[ 'ids' ].length } buttons over ${ group[ 'properties' ].length } properties` )
            .join( ' · ' ) } )

        expect( rules.length ).toBeGreaterThan( 0 )
        expect( shared.length ).toBeGreaterThan( 0 )
        expect( shared.filter( ( group ) => group[ 'properties' ].length === 0 ) ).toEqual( [] )
    } )


    it( 'resolves every Zone-1 button to the same values as the reference button, per state', () => {
        const shared = groups.filter( ( group ) => group[ 'members' ].length > 1 )
        const results = shared.map( ( group ) => ( { 'state': group[ 'suffix' ] || 'base', 'outcome': compareState( { rules, points, 'ids': zone1[ 'ids' ], group } ) } ) )
        const compared = results.reduce( ( sum, entry ) => sum + ( entry[ 'outcome' ][ 'comparedButtons' ] * entry[ 'outcome' ][ 'comparedProperties' ] ), 0 )

        report( { 'label': 'parity', 'counts': `${ zone1[ 'ids' ].length } buttons × ${ results.length } states = ${ compared } property comparisons, reference ${ results.map( ( entry ) => entry[ 'outcome' ][ 'reference' ] ).join( '/' ) }` } )

        expect( compared ).toBeGreaterThan( 0 )

        // The failure message carries the offending button BY NAME together with the properties it
        // differs in — a bare red would not say which button broke ranks.
        expect( results.map( ( entry ) => ( { 'state': entry[ 'state' ], 'offenders': entry[ 'outcome' ][ 'offenders' ] } ) ) )
            .toEqual( results.map( ( entry ) => ( { 'state': entry[ 'state' ], 'offenders': [] } ) ) )
    } )


    it( 'grows its comparison set when a further button is added to Zone 1', () => {
        const before = zone1[ 'ids' ].length
        const marker = zone1[ 'ids' ][ before - 1 ]
        const anchor = clientScript.indexOf( `id="${ marker }"` )

        if( anchor === -1 ) { throw new Error( 'ZONE-1 PROBE ANCHOR NOT FOUND: the last derived button id is not in the client source' ) }

        const lineEnd = clientScript.indexOf( '\n', anchor )
        const probed = `${ clientScript.slice( 0, lineEnd ) }\n            z1Line1 += '<button id="${ PROBE_ID }" title="probe">Probe</button>'${ clientScript.slice( lineEnd ) }`
        const after = deriveZone1Buttons( probed )

        report( { 'label': 'growth probe', 'counts': `${ before } before · ${ after[ 'ids' ].length } after · added "${ PROBE_ID }"` } )

        expect( after[ 'ids' ].length ).toBe( before + 1 )
        expect( after[ 'ids' ].indexOf( PROBE_ID ) ).not.toBe( -1 )
    } )


    it( 'names no Zone-1 button in its own source — the set stays derived', async () => {
        const own = await readFile( fileURLToPath( import.meta.url ), 'utf8' )
        const leaked = zone1[ 'ids' ].filter( ( id ) => own.indexOf( id ) !== -1 )

        report( { 'label': 'self check', 'counts': `${ zone1[ 'ids' ].length } ids searched in ${ own.split( '\n' ).length } own lines, ${ leaked.length } found` } )

        expect( zone1[ 'ids' ].length ).toBeGreaterThan( 1 )
        expect( leaked ).toEqual( [] )
    } )
} )
