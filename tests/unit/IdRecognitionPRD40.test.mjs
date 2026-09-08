// PRD-40 (Memo 081, WI-075, T055/T060) — identifiers are recognised at write time and their
// references are checked for existence.
//
// EVERY CASE THAT ASSERTS A ZERO OR AN ABSENCE MEASURES THE OPPOSITE FROM THE SAME APPARATUS. A test
// that reports "0 unresolved identifiers" without showing that an unresolved one IS recognised has
// not measured, it has stayed silent — the exact defect this whole order was built against.
//
// REPO BOUNDARY: this file reads only inside repos/viewer. The single cross-repo read (the mirror
// parity against repos/core) sits behind an existsSync skip-guard with a named reason, because CI
// checks out this repo ALONE (M080/PRD-V4).

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IdRegister, ID_VOCABULARY, MIRROR_MARKERS } from '../../src/IdRegister.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'


const here = dirname( fileURLToPath( import.meta.url ) )
const repoRoot = resolve( here, '..', '..' )

// A minimal but SCHEMA-VALID full revision. The identifier family must be observable without a pile
// of unrelated MEMO-001 findings drowning it, so the required sections are present.
const revision = ( { body } ) => {
    return [
        '# REV-99',
        '',
        '| Feld | Wert |',
        '|---|---|',
        '| **Memo** | 081 |',
        '| **Memo-Name** | test |',
        '| **Revision** | REV-99 |',
        '| **Datum** | 2026-09-08 |',
        '| **Status** | Entwurf |',
        '',
        '## Kontext',
        body,
        '',
        '## Vorwort',
        'x',
        '',
        '## Offene Fragen',
        'keine',
        '',
        '## Beantwortete Fragen',
        'keine',
        '',
        '## Abhaengigkeiten',
        'keine',
        '',
        '## Abhaengigkeits-Hinweise',
        'keine',
        '',
        '## Finalisierungs-Checkliste',
        'x',
        '',
        '## Ancillary Files',
        'x',
        '',
        '## Rollout-Entry-Points',
        'x',
        '',
        '## Lessons-Learned',
        'x',
        ''
    ].join( '\n' )
}

// THE FIXTURE'S OWN `REV-99` COUNTS, and that is not noise — it is the recogniser reading the whole
// document, header included, exactly as it should. It is therefore always in the stock, and the
// expected numbers below include it rather than pretending the header is invisible.
const stock = ( { ids = [], prefixes = [ 'T', 'WI', 'B', 'REV' ], memos = [ 'M081' ], memo = 'M081' } = {} ) => {
    return { memo, prefixes, memos, ids: [ { id: 'REV-99', memo: 'M081', title: null } ].concat( ids ) }
}

const codesOf = ( { list, prefix } ) => list.filter( ( entry ) => entry.startsWith( prefix ) )


describe( 'PRD-40 / T-A — the recogniser finds the V1 vocabulary in running text', () => {
    test( 'five identifiers of five different prefixes are found with their prefixes', () => {
        const found = IdRegister.scan( { text: 'siehe T055 und WI-041, dazu REV-12, B003 und PRD-039' } )

        expect( found.status ).toBe( true )
        expect( found.tokens.map( ( entry ) => entry.token ) ).toEqual( [ 'T055', 'WI-041', 'REV-12', 'B003', 'PRD-039' ] )
        expect( found.tokens.map( ( entry ) => entry.prefix ) ).toEqual( [ 'T', 'WI', 'REV', 'B', 'PRD' ] )
        // The searched size rides along: 0 hits from an empty search is a different statement.
        expect( found.compared ).toBe( 52 )
    } )
} )


describe( 'PRD-40 / T-B — class 3 is deliberately absent, and the apparatus still works', () => {
    test( 'F7 P1 C01 K1 L9 yield nothing, and T055 in the SAME apparatus yields one', () => {
        const classThree = IdRegister.scan( { text: 'F7 P1 C01 K1 L9 R1 E2 V2' } )
        const control = IdRegister.scan( { text: 'F7 P1 C01 K1 L9 R1 E2 V2 T055' } )

        expect( classThree.tokens ).toEqual( [] )
        // THE VACUUM LATCH: without this line the case above measures a recogniser that never finds
        // anything at all.
        expect( control.tokens.map( ( entry ) => entry.token ) ).toEqual( [ 'T055' ] )
    } )

    test( 'every unrecognised row carries a REASON, so `false` is never the quiet way out', () => {
        const unrecognised = ID_VOCABULARY.filter( ( entry ) => entry.recognized === false )

        expect( unrecognised.length ).toBeGreaterThan( 0 )
        expect( unrecognised.every( ( entry ) => typeof entry.unrecognizedReason === 'string' && entry.unrecognizedReason.length > 0 ) ).toBe( true )
    } )
} )


describe( 'PRD-40 / T-C — the opt-out is the code mark, measured in both directions', () => {
    test( 'T055 inside a span and inside a fence is not found, beside them it is', () => {
        const hidden = IdRegister.scan( { text: 'inline `T055` und\n```\nT055\n```\n' } )
        const both = IdRegister.scan( { text: 'inline `T055` und\n```\nT055\n```\nT055 im Fliesstext' } )

        expect( hidden.tokens ).toEqual( [] )
        expect( both.tokens.map( ( entry ) => entry.token ) ).toEqual( [ 'T055' ] )
        // Blanking, not deleting: the surviving index still points into the ORIGINAL text.
        expect( both.tokens[ 0 ].index ).toBe( both.compared - 'T055 im Fliesstext'.length )
        expect( hidden.blanked ).toBeGreaterThan( 0 )
    } )
} )


describe( 'PRD-40 / T-D — the memo qualification is part of the syntax (F20 = A)', () => {
    test( 'M080-WI-221 yields identifier AND foreign memo, WI-221 yields identifier only', () => {
        const qualified = IdRegister.scan( { text: 'M080-WI-221' } ).tokens[ 0 ]
        const bare = IdRegister.scan( { text: 'WI-221' } ).tokens[ 0 ]

        expect( qualified.qualified ).toBe( true )
        expect( qualified.scope ).toBe( 'M080' )
        expect( qualified.id ).toBe( 'WI-221' )
        expect( bare.qualified ).toBe( false )
        expect( bare.scope ).toBe( null )
        expect( bare.id ).toBe( 'WI-221' )
    } )

    test( 'a memo is NOT scoped inside another memo — M080/M081 reads as M080, not as a reference', () => {
        const pair = IdRegister.scan( { text: 'M080/M081' } ).tokens[ 0 ]

        expect( pair.qualified ).toBe( false )
        expect( pair.id ).toBe( 'M080' )
        // Control from the same apparatus: with a NON-memo target the slash IS a qualification.
        const real = IdRegister.scan( { text: 'M080/WI-221' } ).tokens[ 0 ]
        expect( real.qualified ).toBe( true )
        expect( real.scope ).toBe( 'M080' )
    } )
} )


describe( 'PRD-40 / T-E — the prefix list is closed', () => {
    test( 'XY-001 and ZZZ042 are not identifiers, T055 in the same text is', () => {
        const foreign = IdRegister.scan( { text: 'XY-001 ZZZ042 QQ-9' } )
        const control = IdRegister.scan( { text: 'XY-001 ZZZ042 QQ-9 T055' } )

        expect( foreign.tokens ).toEqual( [] )
        expect( control.tokens.map( ( entry ) => entry.token ) ).toEqual( [ 'T055' ] )
    } )
} )


describe( 'PRD-40 / T-F — occurrences and distinct references are two statements', () => {
    test( 'three times T055 reports occurrences 3, distinct 1', () => {
        const found = IdRegister.scan( { text: 'T055 dann T055 und nochmal T055' } )

        expect( found.occurrences ).toBe( 3 )
        expect( found.distinct ).toBe( 1 )
    } )
} )


describe( 'PRD-40 / T-G — S1 states the READING, in the info channel, and never blocks', () => {
    test( 'resolving identifiers produce INFO-100, no message, and status stays true', () => {
        const doc = revision( { body: 'Der Auftrag betrifft T055 und WI-041.' } )
        const result = MemoValidator.validate( {
            doc,
            fileName: 'REV-99.md',
            knownIds: stock( { ids: [ { id: 'T055', memo: 'M081', title: 'ID-Erkennung und -Schutz' }, { id: 'WI-041', memo: 'M081', title: null } ] } )
        } )

        expect( result.status ).toBe( true )
        expect( result.messages ).toEqual( [] )
        expect( codesOf( { list: result.warnings, prefix: 'WARN-10' } ) ).toEqual( [] )

        const reading = codesOf( { list: result.info, prefix: 'INFO-100' } )
        expect( reading.length ).toBe( 1 )
        // The READING, not merely the identifier — that is what the author asked for.
        expect( reading[ 0 ] ).toContain( 'T055 -> topic "ID-Erkennung und -Schutz"' )
        expect( reading[ 0 ] ).toContain( 'occurrences=4 distinct=3 resolved=3' )
    } )
} )


describe( 'PRD-40 / T-H — S2 is a WARNING and does not block', () => {
    test( 'an identifier with no stock entry lands in warnings, not in messages, status stays true', () => {
        const doc = revision( { body: 'Der Auftrag betrifft WI-999.' } )
        const result = MemoValidator.validate( { doc, fileName: 'REV-99.md', knownIds: stock( { ids: [ { id: 'T055', memo: 'M081', title: null } ] } ) } )

        const warned = codesOf( { list: result.warnings, prefix: 'WARN-100' } )
        expect( warned.length ).toBe( 1 )
        expect( warned[ 0 ] ).toContain( 'WI-999' )
        expect( codesOf( { list: result.messages, prefix: 'WARN-100' } ) ).toEqual( [] )
        // The channel decision IS the assertion: a WARNING in `messages` sets status:false and blocks.
        expect( result.status ).toBe( true )
    } )
} )


describe( 'PRD-40 / T-I — S3, the more dangerous class, has its own finding', () => {
    test( 'an identifier carried by two entries produces WARN-101, distinguishable from WARN-100', () => {
        const doc = revision( { body: 'Der Auftrag betrifft T055 und WI-999.' } )
        const result = MemoValidator.validate( {
            doc,
            fileName: 'REV-99.md',
            knownIds: stock( { ids: [ { id: 'T055', memo: 'M081', title: 'a' }, { id: 'T055', memo: 'M081', title: 'b' } ] } )
        } )

        const ambiguous = codesOf( { list: result.warnings, prefix: 'WARN-101' } )
        const unresolved = codesOf( { list: result.warnings, prefix: 'WARN-100' } )

        expect( ambiguous.length ).toBe( 1 )
        expect( ambiguous[ 0 ] ).toContain( 'T055' )
        expect( ambiguous[ 0 ] ).toContain( 'more than one entry' )
        expect( unresolved.length ).toBe( 1 )
        expect( unresolved[ 0 ] ).toContain( 'WI-999' )
        expect( ambiguous[ 0 ] ).not.toBe( unresolved[ 0 ] )
        expect( result.idResolution.ambiguous ).toBe( 1 )
        expect( result.idResolution.unresolved ).toBe( 1 )
    } )
} )


describe( 'PRD-40 / T-J — no stock is not a green zero', () => {
    test( 'without knownIds the run says available:false with a reason — and the SAME text with a stock finds something', () => {
        const doc = revision( { body: 'Der Auftrag betrifft T055.' } )
        const without = MemoValidator.validate( { doc, fileName: 'REV-99.md' } )
        const with_ = MemoValidator.validate( { doc, fileName: 'REV-99.md', knownIds: stock( { ids: [ { id: 'T055', memo: 'M081', title: null } ] } ) } )

        expect( without.idResolution.available ).toBe( false )
        expect( without.idResolution.distinct ).toBe( 2 )
        expect( without.idResolution.checked ).toBe( 0 )
        expect( without.idResolution.unresolved ).toBe( 0 )
        expect( typeof without.idResolution.unavailableReason ).toBe( 'string' )
        // Said out loud rather than left as a zero.
        expect( codesOf( { list: without.info, prefix: 'INFO-101' } ).length ).toBe( 1 )
        expect( codesOf( { list: without.warnings, prefix: 'WARN-10' } ) ).toEqual( [] )

        // THE POSITIVE CONTROL. Without it, "nothing reported" cannot be told from "nothing checked".
        expect( with_.idResolution.available ).toBe( true )
        expect( with_.idResolution.resolved ).toBe( 2 )
        expect( codesOf( { list: with_.info, prefix: 'INFO-101' } ).length ).toBe( 0 )
    } )
} )


describe( 'PRD-40 / T-K — an EMPTY stock is not a MISSING stock', () => {
    test( 'covered prefixes with zero entries: available true, everything unresolved', () => {
        const doc = revision( { body: 'Der Auftrag betrifft T055.' } )
        const empty = MemoValidator.validate( { doc, fileName: 'REV-99.md', knownIds: stock( { ids: [] } ) } )
        const missing = MemoValidator.validate( { doc, fileName: 'REV-99.md' } )

        expect( empty.idResolution.available ).toBe( true )
        expect( empty.idResolution.checked ).toBe( 2 )
        // T055 has no entry; the fixture's own REV-99 does. Both numbers stated.
        expect( empty.idResolution.unresolved ).toBe( 1 )
        expect( empty.idResolution.resolved ).toBe( 1 )

        // The two states side by side — they look alike and they are not the same statement.
        expect( missing.idResolution.available ).toBe( false )
        expect( missing.idResolution.unresolved ).toBe( 0 )
        expect( empty.idResolution.available ).not.toBe( missing.idResolution.available )
    } )

    test( 'a stock that covers NO prefix reports no-carrier, which is again a third state', () => {
        const doc = revision( { body: 'Der Auftrag betrifft T055.' } )
        const uncovered = MemoValidator.validate( { doc, fileName: 'REV-99.md', knownIds: stock( { ids: [], prefixes: [] } ) } )

        expect( uncovered.idResolution.available ).toBe( true )
        expect( uncovered.idResolution.noCarrier ).toBe( 2 )
        expect( uncovered.idResolution.unresolved ).toBe( 0 )
        expect( uncovered.idResolution.resolved ).toBe( 0 )
    } )
} )


describe( 'PRD-40 / T-L — noCarrier is a statement of its own, not an unresolved', () => {
    test( 'a kind the stock does not cover, and a memo scope it does not reach, are both no-carrier', () => {
        const doc = revision( { body: 'Der Auftrag betrifft RES-017 und M042-WI-001 und WI-999.' } )
        const result = MemoValidator.validate( { doc, fileName: 'REV-99.md', knownIds: stock( { ids: [] } ) } )

        expect( result.idResolution.noCarrier ).toBe( 2 )
        expect( result.idResolution.unresolved ).toBe( 1 )
        expect( result.idResolution.resolved ).toBe( 1 )
        // A reference into a memo the stock does not reach is NOT the author's broken reference.
        expect( codesOf( { list: result.warnings, prefix: 'WARN-100' } )[ 0 ] ).not.toContain( 'M042-WI-001' )
        expect( codesOf( { list: result.warnings, prefix: 'WARN-100' } )[ 0 ] ).toContain( 'WI-999' )
    } )

    test( 'a qualified reference DOES resolve when the stock reaches into that memo', () => {
        const doc = revision( { body: 'Der Auftrag betrifft M080-WI-221.' } )
        const result = MemoValidator.validate( {
            doc,
            fileName: 'REV-99.md',
            knownIds: stock( { ids: [ { id: 'WI-221', memo: 'M080', title: null } ], memos: [ 'M081', 'M080' ] } )
        } )

        expect( result.idResolution.resolved ).toBe( 2 )
        expect( result.idResolution.noCarrier ).toBe( 0 )
        expect( result.idResolution.unresolved ).toBe( 0 )
    } )
} )


describe( 'PRD-40 / T-M — the basis rides in every result, including the refusal', () => {
    test( 'an empty document is refused AND still carries idResolution', () => {
        const result = MemoValidator.validate( { doc: '', fileName: 'REV-99.md' } )

        expect( result.status ).toBe( false )
        expect( result.idResolution ).not.toBe( undefined )
        expect( result.idResolution.ran ).toBe( false )
        expect( result.idResolution.checked ).toBe( 0 )
    } )
} )


describe( 'PRD-40 / T-N — the family is off for `prepare`', () => {
    test( 'the same document produces ran:false and no identifier finding as a prepare artefact', () => {
        const body = 'Der Auftrag betrifft T055 und WI-999.'
        const asPrepare = MemoValidator.validate( { doc: revision( { body } ), fileName: 'REV-99-prepare.md', knownIds: stock( { ids: [] } ) } )
        const asFull = MemoValidator.validate( { doc: revision( { body } ), fileName: 'REV-99.md', knownIds: stock( { ids: [] } ) } )

        expect( asPrepare.revisionType ).toBe( 'prepare' )
        expect( asPrepare.idResolution.ran ).toBe( false )
        expect( codesOf( { list: asPrepare.info, prefix: 'INFO-100' } ) ).toEqual( [] )
        expect( codesOf( { list: asPrepare.warnings, prefix: 'WARN-10' } ) ).toEqual( [] )

        // The control: the identical body DOES produce findings under the full schema, so the case
        // above measures a switch and not an inert check.
        expect( asFull.idResolution.ran ).toBe( true )
        expect( codesOf( { list: asFull.info, prefix: 'INFO-100' } ).length ).toBe( 1 )
    } )
} )


describe( 'PRD-40 / T-O — the identifier family can never reject a transcript', () => {
    test( 'the four new codes are outside the question-format family, MEMO-030 is inside it', () => {
        const newCodes = [ 'INFO-100', 'INFO-101', 'WARN-100', 'WARN-101' ]

        newCodes.forEach( ( code ) => {
            expect( MemoValidator.isQuestionFormatCode( { code } ).questionFormat ).toBe( false )
        } )
        // Vacuum latch: the predicate answers TRUE for something, so the four falses above are a
        // verdict and not a function that always says no.
        expect( MemoValidator.isQuestionFormatCode( { code: 'MEMO-030' } ).questionFormat ).toBe( true )
    } )

    test( 'all four codes are in the catalogue and carry the new `kennung` theme', () => {
        const { catalog } = MemoValidator.getCatalog()
        const family = catalog.filter( ( entry ) => entry.theme === 'kennung' )

        expect( family.map( ( entry ) => entry.code ).sort() ).toEqual( [ 'INFO-100', 'INFO-101', 'WARN-100', 'WARN-101' ] )
        expect( family.filter( ( entry ) => entry.severity === 'WARNING' ).length ).toBe( 2 )
        expect( family.filter( ( entry ) => entry.severity === 'INFO' ).length ).toBe( 2 )
    } )
} )


describe( 'PRD-40 / T-P — the funnel is one funnel: every validator call site reaches the stock', () => {
    const source = readFileSync( resolve( repoRoot, 'src', 'MemoView.mjs' ), 'utf8' )

    test( 'the number of #computeValidation call sites equals the number that hand in knownIds', () => {
        const callSites = source.split( '\n' ).filter( ( line ) => line.includes( 'MemoView.#computeValidation( {' ) )
        const withStock = callSites.filter( ( line ) => line.includes( 'knownIds' ) )

        expect( callSites.length ).toBeGreaterThan( 0 )
        // BOTH numbers are asserted and they are equal — a site without the stock is a failure.
        expect( withStock.length ).toBe( callSites.length )
    } )

    test( 'no site calls MemoValidator.validate around the funnel', () => {
        const direct = source.split( '\n' ).filter( ( line ) => line.includes( 'MemoValidator.validate( {' ) )

        // Exactly one: the call INSIDE #computeValidation. Any second one is a bypass.
        expect( direct.length ).toBe( 1 )
        expect( direct[ 0 ] ).toContain( 'knownIds' )
    } )
} )


describe( 'PRD-40 / P-1 — the five content-send sites carry one key set', () => {
    const source = readFileSync( resolve( repoRoot, 'src', 'MemoView.mjs' ), 'utf8' )

    // The keys of a `'type': 'content'` send, read back out of the source line. The object body is cut
    // out first and then split on commas — both spellings occur in these five lines (quoted
    // `'fileName': x` and shorthand `fileName`), and a regex that scans the whole line silently drops
    // adjacent shorthand keys because its matches overlap. That mistake made four of five sites look
    // three keys short, which is exactly the kind of measurement error this case exists to catch.
    const keysOf = ( { line } ) => {
        const body = line.slice( line.indexOf( 'JSON.stringify( {' ) + 'JSON.stringify( {'.length, line.lastIndexOf( '} )' ) )

        return body
            .split( ',' )
            .map( ( part ) => part.includes( ':' ) ? part.slice( 0, part.indexOf( ':' ) ) : part )
            .map( ( part ) => part.replace( /['\s]/g, '' ) )
            .filter( ( key ) => /^[a-zA-Z]+$/.test( key ) === true )
            .filter( ( key ) => key !== 'type' && key !== 'content' )
            .sort()
    }

    const sendLines = source.split( '\n' ).filter( ( line ) => line.includes( "'type': 'content'" ) )

    test( 'there are five of them and the count is stated, not assumed', () => {
        expect( sendLines.length ).toBe( 5 )
    } )

    test( 'no content send carries the dead `diff` field any more', () => {
        expect( sendLines.filter( ( line ) => line.includes( "'diff': null" ) ) ).toEqual( [] )
        // Vacuum latch: the two REMAINING `'diff': null` occurrences live in #buildDiff, which is not
        // a send site — so the search above is running over a file that still contains the string.
        expect( source.split( '\n' ).filter( ( line ) => line.includes( "'diff': null" ) ).length ).toBe( 2 )
    } )

    test( 'all five carry the same key set apart from the ONE named, deliberate difference', () => {
        // `preserveScroll` is carried by #broadcastContent alone and on purpose — #computeValidation's
        // own comment names it. It is excluded BY NAME rather than by weakening the comparison, so a
        // second, unnamed divergence still fails this case.
        const sets = sendLines.map( ( line ) => keysOf( { line } ).filter( ( key ) => key !== 'preserveScroll' ) )

        expect( sets.length ).toBe( 5 )
        sets.forEach( ( set ) => expect( set ).toEqual( sets[ 0 ] ) )
        expect( sets[ 0 ] ).toContain( 'diffAvailable' )
        expect( sets[ 0 ] ).toContain( 'diffInfo' )
        expect( sets[ 0 ] ).toContain( 'validation' )
        expect( sets[ 0 ] ).not.toContain( 'diff' )

        // Vacuum latch: an artificially deviating send site must FAIL this comparison.
        const injected = sets.concat( [ sets[ 0 ].concat( [ 'diff' ] ) ] )
        expect( injected.every( ( set ) => set.join( ',' ) === sets[ 0 ].join( ',' ) ) ).toBe( false )
    } )
} )


describe( 'PRD-40 — the vocabulary is a MIRROR, not a second expression', () => {
    // The core sibling is derived from THIS repo's own directory name (the class repair PRD-39 made),
    // with the plain name as the fallback.
    const siblingCandidates = ( () => {
        const reposDir = dirname( repoRoot )
        const own = basename( repoRoot )
        const suffix = own.startsWith( 'viewer' ) ? own.slice( 'viewer'.length ) : ''

        return [
            resolve( reposDir, `core${ suffix }`, 'cli', 'src', 'IdVocabulary.mjs' ),
            resolve( reposDir, 'core', 'cli', 'src', 'IdVocabulary.mjs' )
        ]
    } )()

    const corePath = siblingCandidates.find( ( path ) => existsSync( path ) )

    test( 'the mirror region is character-identical to repos/core/cli/src/IdVocabulary.mjs', () => {
        if( corePath === undefined ) {
            // SKIP-GUARD with a named reason: CI checks out this repo alone, and the sibling is then
            // genuinely absent. The candidates are printed so a miss is diagnosable rather than silent.
            console.log( `[mirror] core sibling absent, case skipped (candidates: ${ siblingCandidates.join( ', ' ) })` )
            expect( siblingCandidates.length ).toBe( 2 )

            return
        }

        const mine = IdRegister.mirrorRegion( { source: readFileSync( resolve( repoRoot, 'src', 'IdRegister.mjs' ), 'utf8' ) } )
        const theirs = IdRegister.mirrorRegion( { source: readFileSync( corePath, 'utf8' ) } )

        // The case SAYS which two files it compared and how much — a parity check that cannot name its
        // comparison basis is the vacuum-green gate again.
        console.log( `[mirror] viewer=${ resolve( repoRoot, 'src', 'IdRegister.mjs' ) }\n         core=${ corePath }\n         lines=${ mine.lines }/${ theirs.lines } bytes=${ mine.region.length }/${ theirs.region.length }` )

        expect( mine.status ).toBe( true )
        expect( theirs.status ).toBe( true )
        expect( mine.lines ).toBeGreaterThan( 100 )
        expect( mine.region ).toBe( theirs.region )
    } )

    test( 'the markers themselves are found in both directions, so equality is not the equality of two empty strings', () => {
        const missing = IdRegister.mirrorRegion( { source: 'nothing here' } )

        expect( missing.status ).toBe( false )
        expect( missing.region ).toBe( '' )
        expect( MIRROR_MARKERS.start ).toBe( 'const SEPARATOR_SOURCE' )
        expect( MIRROR_MARKERS.end ).toBe( 'const TOKEN_PARTS' )
    } )

    test( 'exactly one module in src/ describes the vocabulary', () => {
        const mine = readFileSync( resolve( repoRoot, 'src', 'IdRegister.mjs' ), 'utf8' )
        const validator = readFileSync( resolve( repoRoot, 'src', 'MemoValidator.mjs' ), 'utf8' )
        const view = readFileSync( resolve( repoRoot, 'src', 'MemoView.mjs' ), 'utf8' )

        expect( mine.includes( 'const ID_VOCABULARY' ) ).toBe( true )
        // No second recognition expression beside it — that is the parallel path T060 forbids.
        expect( validator.includes( 'ID_VOCABULARY' ) ).toBe( false )
        expect( view.includes( 'ID_VOCABULARY' ) ).toBe( false )
        expect( /\\b\(\?:M/.test( validator ) ).toBe( false )
    } )
} )
