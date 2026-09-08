import { describe, it, expect } from '@jest/globals'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { BlockSections } from '../../src/BlockSections.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'


// Memo 081, PRD-41 (WI-115 / T077, REV-16:4144-4154).
//
// WHAT THIS SUITE HOLDS. The `### User-Auftrag` section is present in every chapter and arranged in
// no two chapters alike. Measured 2026-09-08 over TWO revisions, because a form check that has only
// seen its own memo knows no spread:
//   REV-16 (memo 081)  41 chapters, 41 with the section, 37 with a quote, 30 with a source reference
//   REV-18 (memo 080)  25 chapters, 25 with the section, 25 with a quote,  0 with a source reference
// So the SECTION is never missing and its FORM is. That is the whole subject: the user's remark
// ("das sieht noch alles sehr manuell aus") is about VARIANCE, not about manual work.
//
// EVERY CASE THAT ASSERTS A ZERO OR AN ABSENCE MEASURES THE OPPOSITE FROM THE SAME APPARATUS. A rule
// that only ever sees the empty side cannot tell "nothing is wrong" from "nothing was looked at".
//
// REPO BOUNDARY: this file reads ONLY inside repos/viewer and builds every document in the test. No
// `../../../../.memo/…` read, so CI checking this repo out alone cannot be torn by it.


// A `full` revision carrying the ten mandatory document sections plus the numbered body chapters the
// case wants, so a verdict can be attributed to the chapter and to nothing else.
function revisionWith( { chapters } ) {
    const head = [
        '| **Memo** | 099 |',
        '| **Memo-Name** | Probe |',
        '| **Revision** | REV-01 |',
        '| **Datum** | 2026-09-08 |',
        '| **Status** | Entwurf |',
        ''
    ]
    const frame = [ 'Kontext', 'Vorwort', 'Offene Fragen', 'Beantwortete Fragen', 'Abhaengigkeiten', 'Abhaengigkeits-Hinweise', 'Finalisierungs-Checkliste', 'Ancillary Files', 'Rollout-Entry-Points', 'Lessons-Learned' ]
        .map( ( heading ) => `## ${ heading }\n\nInhalt.\n` )

    return head.concat( frame ).concat( chapters ).join( '\n' )
}


// ONE numbered chapter. `body` is the raw content of its `### User-Auftrag`; `mandate: null` builds a
// chapter that carries NO such section at all.
function chapter( { number, title, mandate } ) {
    const section = mandate === null ? '' : `### User-Auftrag\n\n${ mandate }\n`

    return `## ${ number }. ${ title }\n\n${ section }\n### Ist-Zustand\n\nInhalt.\n`
}


const QUOTE = '> „Das ist ein woertliches Zitat aus dem Transkript, lang genug um als Zitat zu zaehlen."'
const SOURCE = '*(`transcripts/REV-01--terminal--01.md:128`)*'
const READING = '**Gelesen als:** Die Deutung des Auftrags.'


function mandateBasisOf( { doc } ) {
    const result = MemoValidator.validate( { doc, 'fileName': 'REV-01.md' } )

    return { result, 'basis': result[ 'userMandate' ], 'findings': result[ 'warnings' ].filter( ( entry ) => /^WARN-20\d/.test( entry ) === true ) }
}


describe( 'PRD-41 / T-A + T-D — the arrangement the rule actually wants', () => {
    it( 'reports NO finding for quote, source and reading in order, and states its basis', () => {
        const doc = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Erstes', 'mandate': `${ QUOTE }\n${ SOURCE }\n\n${ READING }` } ) ] } )
        const { basis, findings } = mandateBasisOf( { doc } )

        expect( findings ).toEqual( [] )
        expect( basis ).toEqual( { 'ran': true, 'chapters': 1, 'withSection': 1, 'withQuote': 1, 'withSource': 1, 'withDefault': 0, 'misordered': 0 } )
    } )


    // T-D. The case is MANDATORY, not decorative: a check that enforced the optional element would
    // break the very rule it enforces (REV-16:3418 — the reading is never a criterion).
    it( 'reports NO finding when the OPTIONAL reading is absent', () => {
        const doc = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Ohne Deutung', 'mandate': `${ QUOTE }\n${ SOURCE }` } ) ] } )
        const { basis, findings } = mandateBasisOf( { doc } )

        expect( findings ).toEqual( [] )
        expect( basis[ 'withQuote' ] ).toBe( 1 )
        expect( basis[ 'misordered' ] ).toBe( 0 )
    } )
} )


describe( 'PRD-41 / T-B — a quote without its source reference', () => {
    it( 'reports exactly ONE finding and names the chapter AND the line', () => {
        const doc = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Ohne Fundstelle', 'mandate': QUOTE } ) ] } )
        const { basis, findings } = mandateBasisOf( { doc } )

        expect( findings.length ).toBe( 1 )
        expect( findings[ 0 ] ).toContain( 'WARN-201' )
        expect( findings[ 0 ] ).toContain( '"Ohne Fundstelle"' )
        // the LINE, not merely the fact — a collective count is not a finding
        expect( findings[ 0 ] ).toMatch( /quote at line \d+/ )
        expect( findings[ 0 ] ).toContain( 'quotes=1 sources=0' )
        expect( basis[ 'withSource' ] ).toBe( 0 )
    } )
} )


describe( 'PRD-41 / T-C — the reading is judged on POSITION only', () => {
    it( 'reports the order finding when the reading stands BEFORE the quote, and NONE when it stands after', () => {
        const before = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Deutung vorn', 'mandate': `${ READING }\n\n${ QUOTE }\n${ SOURCE }` } ) ] } )
        const after = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Deutung hinten', 'mandate': `${ QUOTE }\n${ SOURCE }\n\n${ READING }` } ) ] } )

        const wrong = mandateBasisOf( { 'doc': before } )
        const right = mandateBasisOf( { 'doc': after } )

        expect( wrong[ 'findings' ].length ).toBe( 1 )
        expect( wrong[ 'findings' ][ 0 ] ).toContain( 'WARN-202' )
        expect( wrong[ 'findings' ][ 0 ] ).toContain( '"Deutung vorn"' )
        expect( wrong[ 'basis' ][ 'misordered' ] ).toBe( 1 )

        // POSITIVE CONTROL in the same case: the identical reading, moved, produces nothing.
        expect( right[ 'findings' ] ).toEqual( [] )
        expect( right[ 'basis' ][ 'misordered' ] ).toBe( 0 )
    } )
} )


describe( 'PRD-41 / T-E + T-F + A5 — the default sentence, and that the list is CLOSED', () => {
    // All four accepted wordings in ONE case: both variants and both umlaut spellings. A form rule
    // that trips over a keyboard layout has moved the defect onto the author.
    it( 'accepts all four measured default wordings without a finding', () => {
        const wordings = [
            'Kein woertlicher Auftrag; dieses Kapitel folgt aus Kapitel 7.',
            'Kein wörtlicher Auftrag; dieses Kapitel folgt aus Frage F3.',
            '**Kein User-Auftrag** — dieses Kapitel entstand aus einer Messung.',
            '**Kein woertlicher Auftrag** — dieses Kapitel folgt aus einer Messung.'
        ]
        const verdicts = wordings.map( ( wording, index ) => {
            const doc = revisionWith( { 'chapters': [ chapter( { 'number': index + 1, 'title': `Standard ${ index }`, 'mandate': wording } ) ] } )

            return mandateBasisOf( { doc } )
        } )

        verdicts.forEach( ( verdict ) => expect( verdict[ 'findings' ] ).toEqual( [] ) )
        verdicts.forEach( ( verdict ) => expect( verdict[ 'basis' ][ 'withDefault' ] ).toBe( 1 ) )
    } )


    // THE COUNTER-PROBE, and without it the list is not a closed list but a pattern that lets
    // everything through.
    it( 'reports a finding for a SIMILAR but unlisted sentence', () => {
        const doc = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Fast richtig', 'mandate': 'Dieses Kapitel hat keinen Auftrag und folgt aus einer Messung.' } ) ] } )
        const { basis, findings } = mandateBasisOf( { doc } )

        expect( findings.length ).toBe( 1 )
        expect( findings[ 0 ] ).toContain( 'WARN-200' )
        expect( findings[ 0 ] ).toContain( 'neither a block quote nor a default sentence' )
        expect( basis[ 'withDefault' ] ).toBe( 0 )
    } )


    // T-F. The default sentence REPLACES quote and source; carrying both says the chapter has and has
    // not a mandate at once.
    it( 'reports WARN-203 when a default sentence and a quote stand in the same section', () => {
        const doc = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Beides', 'mandate': `**Kein User-Auftrag** — dieses Kapitel entstand aus einer Messung.\n\n${ QUOTE }\n${ SOURCE }` } ) ] } )
        const { basis, findings } = mandateBasisOf( { doc } )

        expect( findings.length ).toBe( 1 )
        expect( findings[ 0 ] ).toContain( 'WARN-203' )
        expect( findings[ 0 ] ).toContain( '"Beides"' )
        expect( basis[ 'withDefault' ] ).toBe( 1 )
        expect( basis[ 'withQuote' ] ).toBe( 1 )
    } )
} )


describe( 'PRD-41 / T-G — a chapter without the section at all', () => {
    it( 'reports a finding whose WORDING differs from the one for an unusable section', () => {
        const missing = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Gar keine Sektion', 'mandate': null } ) ] } )
        const empty = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Leere Sektion', 'mandate': 'Nur Fliesstext ohne Zitat.' } ) ] } )

        const withoutSection = mandateBasisOf( { 'doc': missing } )
        const withSection = mandateBasisOf( { 'doc': empty } )

        expect( withoutSection[ 'findings' ].length ).toBe( 1 )
        expect( withoutSection[ 'findings' ][ 0 ] ).toContain( 'carries no `### User-Auftrag` section' )
        expect( withoutSection[ 'basis' ][ 'withSection' ] ).toBe( 0 )

        expect( withSection[ 'findings' ].length ).toBe( 1 )
        expect( withSection[ 'findings' ][ 0 ] ).toContain( 'neither a block quote nor a default sentence' )
        expect( withSection[ 'basis' ][ 'withSection' ] ).toBe( 1 )

        // The two are DISTINGUISHABLE — "there is no section" and "the section says nothing checkable"
        // are different defects and must not read alike.
        expect( withoutSection[ 'findings' ][ 0 ] ).not.toEqual( withSection[ 'findings' ][ 0 ] )
    } )
} )


describe( 'PRD-41 / T-H — several quotes are allowed, each carrying its own source', () => {
    it( 'reports nothing for three quotes with three sources and ONE finding for three quotes with two', () => {
        const complete = [ `${ QUOTE }\n${ SOURCE }`, `${ QUOTE }\n${ SOURCE }`, `${ QUOTE }\n${ SOURCE }` ].join( '\n\n' )
        const short = [ `${ QUOTE }\n${ SOURCE }`, `${ QUOTE }\n${ SOURCE }`, QUOTE ].join( '\n\n' )

        const full = mandateBasisOf( { 'doc': revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Drei zu drei', 'mandate': complete } ) ] } ) } )
        const lacking = mandateBasisOf( { 'doc': revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Drei zu zwei', 'mandate': short } ) ] } ) } )

        expect( full[ 'findings' ] ).toEqual( [] )
        expect( lacking[ 'findings' ].length ).toBe( 1 )
        expect( lacking[ 'findings' ][ 0 ] ).toContain( 'quotes=3 sources=2' )
    } )
} )


describe( 'PRD-41 / T-I — a quote inside a code fence is example text, not a mandate', () => {
    it( 'ignores the fenced quote and counts the very same quote outside the fence', () => {
        const fenced = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Im Zaun', 'mandate': `\`\`\`\n${ QUOTE }\n${ SOURCE }\n\`\`\`` } ) ] } )
        const plain = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Ohne Zaun', 'mandate': `${ QUOTE }\n${ SOURCE }` } ) ] } )

        const inside = mandateBasisOf( { 'doc': fenced } )
        const outside = mandateBasisOf( { 'doc': plain } )

        expect( inside[ 'basis' ][ 'withQuote' ] ).toBe( 0 )
        expect( inside[ 'findings' ].length ).toBe( 1 )

        // VACUUM BOLT: the identical text outside the fence DOES count, so the zero above is a verdict
        // and not a broken cut.
        expect( outside[ 'basis' ][ 'withQuote' ] ).toBe( 1 )
        expect( outside[ 'findings' ] ).toEqual( [] )
    } )
} )


describe( 'PRD-41 / T-J — the register decides what the section is, in BOTH directions', () => {
    it( 'accepts `### User-Auftrag: {Aspekt}` as the section and rejects `### User-Auftragslage`', () => {
        const suffixed = revisionWith( { 'chapters': [ `## 1. Mit Aspekt\n\n### User-Auftrag: der Zuschnitt\n\n${ QUOTE }\n${ SOURCE }\n\n### Ist-Zustand\n\nInhalt.\n` ] } )
        const lookalike = revisionWith( { 'chapters': [ `## 1. Aehnlich\n\n### User-Auftragslage\n\n${ QUOTE }\n${ SOURCE }\n\n### Ist-Zustand\n\nInhalt.\n` ] } )

        const recognised = mandateBasisOf( { 'doc': suffixed } )
        const notRecognised = mandateBasisOf( { 'doc': lookalike } )

        expect( recognised[ 'basis' ][ 'withSection' ] ).toBe( 1 )
        expect( recognised[ 'findings' ] ).toEqual( [] )

        expect( notRecognised[ 'basis' ][ 'withSection' ] ).toBe( 0 )
        expect( notRecognised[ 'findings' ][ 0 ] ).toContain( 'carries no `### User-Auftrag` section' )
    } )
} )


describe( 'PRD-41 / T-K — warn-first: the channel, and that nothing blocks', () => {
    it( 'puts every finding in `warnings`, leaves `messages` untouched and keeps status true', () => {
        const doc = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Ohne Fundstelle', 'mandate': QUOTE } ) ] } )
        const { result, findings } = mandateBasisOf( { doc } )

        expect( findings.length ).toBe( 1 )
        expect( result[ 'messages' ].filter( ( entry ) => /WARN-20\d/.test( entry ) === true ) ).toEqual( [] )
        expect( result[ 'info' ].filter( ( entry ) => /WARN-20\d/.test( entry ) === true ) ).toEqual( [] )
        expect( result[ 'status' ] ).toBe( true )
    } )


    // The new basis stands BESIDE the two existing ones, never in their place.
    it( 'carries userMandate next to optionQuality and idResolution', () => {
        const doc = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Erstes', 'mandate': `${ QUOTE }\n${ SOURCE }` } ) ] } )
        const result = MemoValidator.validate( { doc, 'fileName': 'REV-01.md' } )

        expect( Object.keys( result ) ).toEqual( expect.arrayContaining( [ 'optionQuality', 'idResolution', 'userMandate' ] ) )
    } )
} )


describe( 'PRD-41 / T-L — a run that compared nothing reports RED, not a green zero', () => {
    it( 'reports chapters:0 as a finding for a document without numbered chapters, and NOT for one with', () => {
        const none = mandateBasisOf( { 'doc': revisionWith( { 'chapters': [] } ) } )
        const one = mandateBasisOf( { 'doc': revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Erstes', 'mandate': `${ QUOTE }\n${ SOURCE }` } ) ] } ) } )

        expect( none[ 'basis' ][ 'chapters' ] ).toBe( 0 )
        expect( none[ 'findings' ].length ).toBe( 1 )
        expect( none[ 'findings' ][ 0 ] ).toContain( 'a check without a comparison basis reports red, not green' )

        // VACUUM BOLT: the same apparatus with ONE chapter is silent, so the red above is a verdict.
        expect( one[ 'basis' ][ 'chapters' ] ).toBe( 1 )
        expect( one[ 'findings' ] ).toEqual( [] )
    } )
} )


describe( 'PRD-41 / T-M + T-N — the family runs where it has a subject, and the basis rides everywhere', () => {
    it( 'reports ran:false for prepare and for update', () => {
        const doc = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Erstes', 'mandate': QUOTE } ) ] } )
        const prepare = MemoValidator.validate( { doc, 'fileName': 'REV-01-prepare.md' } )
        const update = MemoValidator.validate( { doc, 'fileName': 'REV-01-update.md' } )

        expect( prepare[ 'userMandate' ][ 'ran' ] ).toBe( false )
        expect( update[ 'userMandate' ][ 'ran' ] ).toBe( false )
        expect( prepare[ 'userMandate' ][ 'chapters' ] ).toBe( 0 )

        // VACUUM BOLT: the same document as `full` DOES run, so ran:false is a decision and not a
        // silent failure of the whole family.
        const full = MemoValidator.validate( { doc, 'fileName': 'REV-01.md' } )
        expect( full[ 'userMandate' ][ 'ran' ] ).toBe( true )
    } )


    it( 'carries userMandate in the REFUSAL of an empty document', () => {
        const refusal = MemoValidator.validate( { 'doc': '', 'fileName': 'REV-01.md' } )

        expect( refusal[ 'status' ] ).toBe( false )
        expect( refusal[ 'userMandate' ] ).toEqual( { 'ran': false, 'chapters': 0, 'withSection': 0, 'withQuote': 0, 'withSource': 0, 'withDefault': 0, 'misordered': 0 } )
    } )
} )


describe( 'PRD-41 / T-O — a form remark can never reject a transcript', () => {
    it( 'keeps all four codes out of the question-format family', () => {
        const mine = [ 'WARN-200', 'WARN-201', 'WARN-202', 'WARN-203' ]
        const verdicts = mine.map( ( code ) => MemoValidator.isQuestionFormatCode( { code } ).questionFormat )

        expect( verdicts ).toEqual( [ false, false, false, false ] )

        // VACUUM BOLT: the probe DOES answer true for a real member of the family, so the four falses
        // above are a verdict and not a broken predicate.
        expect( MemoValidator.isQuestionFormatCode( { 'code': 'MEMO-030' } ).questionFormat ).toBe( true )
    } )


    it( 'enters the four codes as WARNING under one new theme', () => {
        const { catalog } = MemoValidator.getCatalog()
        const mine = catalog.filter( ( entry ) => [ 'WARN-200', 'WARN-201', 'WARN-202', 'WARN-203' ].includes( entry[ 'code' ] ) === true )

        expect( mine.length ).toBe( 4 )
        expect( mine.map( ( entry ) => entry[ 'severity' ] ) ).toEqual( [ 'WARNING', 'WARNING', 'WARNING', 'WARNING' ] )
        expect( [ ...new Set( mine.map( ( entry ) => entry[ 'theme' ] ) ) ] ).toEqual( [ 'mandate-form' ] )
    } )
} )


describe( 'PRD-41 / A6 — the boundary of the source check, held by a test and not only by a comment', () => {
    // THE POINT OF THIS CASE IS THAT IT PASSES. Only the SHAPE of the source reference is checked, not
    // that the file exists or that the quoted words stand at that line. A reference of the right shape
    // pointing into the void produces NO finding, ON PURPOSE — and a boundary that lives only in a
    // comment disappears at the next rewrite, which is why it is nailed down here.
    it( 'accepts a well-shaped source reference pointing at a file that does not exist (the WANTED limit)', () => {
        const doc = revisionWith( { 'chapters': [ chapter( { 'number': 1, 'title': 'Ins Leere', 'mandate': `${ QUOTE }\n*(\`transcripts/gibt-es-nicht-99999.md:4711\`)*` } ) ] } )
        const { basis, findings } = mandateBasisOf( { doc } )

        expect( findings ).toEqual( [] )
        expect( basis[ 'withSource' ] ).toBe( 1 )
    } )
} )


describe( 'PRD-41 / T-P — the form is ONE source, ordered and closed', () => {
    it( 'hands out the elements in position order, with a fresh pattern object each call', () => {
        const { elements, defaults } = BlockSections.userMandateForm()

        expect( elements.map( ( entry ) => entry[ 'element' ] ) ).toEqual( [ 'quote', 'source', 'reading' ] )
        expect( elements.map( ( entry ) => entry[ 'position' ] ) ).toEqual( [ 1, 2, 3 ] )
        expect( elements.map( ( entry ) => entry[ 'required' ] ) ).toEqual( [ true, true, false ] )
        expect( defaults.map( ( entry ) => entry[ 'variant' ] ) ).toEqual( [ 'follows-from', 'from-measurement' ] )

        // A RegExp is mutable (`lastIndex`); handing out the register's own object would let one
        // caller move the next caller's cursor.
        expect( BlockSections.userMandateForm().elements[ 0 ][ 'pattern' ] ).not.toBe( elements[ 0 ][ 'pattern' ] )
    } )


    it( 'states how much its load-time gate compared', () => {
        expect( BlockSections.assertUserMandateForm() ).toEqual( { 'ok': true, 'checked': 3, 'required': 2, 'defaults': 2 } )
    } )


    // The gate must break the IMPORT, not some later read. Measured against a real copy of the module
    // with ONE entry broken, because asserting that a gate would throw is not the same as watching it.
    it( 'breaks the import when an element loses its position', async() => {
        const dir = await mkdtemp( join( tmpdir(), 'prd41-gate-' ) )
        try {
            const source = await readFile( new URL( '../../src/BlockSections.mjs', import.meta.url ), 'utf8' )
            const broken = source.replace( "{ element: 'reading', position: 3, required: false,", "{ element: 'reading', required: false," )
            expect( broken ).not.toBe( source )

            const target = join( dir, 'BlockSectionsBroken.mjs' )
            await writeFile( target, broken, 'utf8' )

            await expect( import( pathToFileURL( target ).href ) ).rejects.toThrow( /assertUserMandateForm/ )
        } finally {
            await rm( dir, { 'recursive': true, 'force': true } )
        }
    } )
} )
