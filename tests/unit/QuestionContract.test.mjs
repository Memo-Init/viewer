import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { isRenderable, invalidOptionKinds, VALID_OPTION_KINDS } from '../../src/QuestionContract.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// Memo 041 Teil B (Kap 10): the ONE render contract. QuestionContract.isRenderable is the single
// source; the browser gate isQuestionCleanParse (inlined into the page, not importable) is its
// hand-kept MIRROR. This suite is the DRIFT GUARD — it extracts the client function exactly as
// QuestionRenderGate.test.mjs does and asserts the two return identical verdicts over a corpus, so
// the split-brain that Memo 041 fixes can never silently come back. It also pins MEMO-033 (the
// kind-validity gate the validator was missing) and the defensive kind-coercion.

const here = dirname( fileURLToPath( import.meta.url ) )
const clientPath = join( here, '..', '..', 'src', 'public', 'app.client.mjs' )


function extractFunction( script, name ) {
    const start = script.indexOf( 'function ' + name + '(' )
    if( start === -1 ) { return '' }

    const openBrace = script.indexOf( '{', start )
    let depth = 0
    let end = -1

    script
        .slice( openBrace )
        .split( '' )
        .some( ( ch, idx ) => {
            if( ch === '{' ) { depth = depth + 1 }
            if( ch === '}' ) { depth = depth - 1 }
            if( depth === 0 ) { end = openBrace + idx; return true }

            return false
        } )

    return script.slice( start, end + 1 )
}


// The shared corpus: each entry exercises a different branch of the contract so a divergence
// between the server module and the client mirror would surface as a failing parity assertion.
const CORPUS = [
    { 'name': 'clean single', 'q': { 'id': 'F1', 'frage': 'Q', 'aiRecommendation': 'A', 'typ': 'single',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] } },
    { 'name': 'clean multi (no AI ref)', 'q': { 'id': 'F2', 'frage': 'Q', 'aiRecommendation': '', 'typ': 'multi',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] } },
    { 'name': 'missing frage', 'q': { 'id': 'F3', 'frage': '', 'aiRecommendation': 'A', 'typ': 'single',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] } },
    { 'name': 'single missing aiRec', 'q': { 'id': 'F4', 'frage': 'Q', 'aiRecommendation': '', 'typ': 'single',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] } },
    { 'name': 'fewer than two options', 'q': { 'id': 'F5', 'frage': 'Q', 'aiRecommendation': 'A', 'typ': 'single',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' } ] } },
    { 'name': 'aiRec references missing option', 'q': { 'id': 'F6', 'frage': 'Q', 'aiRecommendation': 'Z', 'typ': 'single',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] } },
    { 'name': 'empty-label option', 'q': { 'id': 'F7', 'frage': 'Q', 'aiRecommendation': 'A', 'typ': 'single',
        'options': [ { 'key': 'A', 'label': '', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] } },
    { 'name': 'malformed id', 'q': { 'id': 'X1', 'frage': 'Q', 'aiRecommendation': 'A', 'typ': 'single',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] } },
    { 'name': 'invalid kind drops an option below two', 'q': { 'id': 'F8', 'frage': 'Q', 'aiRecommendation': 'A', 'typ': 'single',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'normal' } ] } },
    { 'name': 'multi with one option', 'q': { 'id': 'F9', 'frage': 'Q', 'aiRecommendation': '', 'typ': 'multi',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' } ] } },
    { 'name': 'single aiRec references two keys', 'q': { 'id': 'F10', 'frage': 'Q', 'aiRecommendation': 'A B', 'typ': 'single',
        'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] } },
    { 'name': 'not an object', 'q': null }
]


function buildQuestionsJsonDoc( { questions } ) {
    return '# Test\n\n## Offene Fragen\n\n```questions-json\n' + JSON.stringify( questions ) + '\n```\n'
}


describe( 'Memo 041 Teil B — QuestionContract is the one render contract', () => {
    let cleanParse = null

    beforeAll( async () => {
        const emittedScript = await readFile( clientPath, 'utf8' )
        const cleanSrc = extractFunction( emittedScript, 'isQuestionCleanParse' )
        expect( cleanSrc.length ).toBeGreaterThan( 0 )

        const sandbox = {}
        vm.createContext( sandbox )
        vm.runInContext( cleanSrc + '\nglobalThis.__clean = isQuestionCleanParse;', sandbox )
        cleanParse = sandbox.__clean
    } )


    it( 'server isRenderable and client isQuestionCleanParse agree on the whole corpus (drift guard)', () => {
        CORPUS.forEach( ( entry ) => {
            const server = isRenderable( { question: entry[ 'q' ] } )
            const client = cleanParse( entry[ 'q' ] )
            expect( { 'case': entry[ 'name' ], 'verdict': server } ).toEqual( { 'case': entry[ 'name' ], 'verdict': client } )
        } )
    } )


    it( 'exposes the three valid option kinds', () => {
        expect( VALID_OPTION_KINDS ).toEqual( [ 'option', 'custom', 'topic' ] )
    } )


    it( 'invalidOptionKinds flags only present, invalid string kinds (missing kind is allowed)', () => {
        const options = [
            { 'key': 'A', 'label': 'X', 'kind': 'option' },
            { 'key': 'B', 'label': 'Y', 'kind': 'normal' },
            { 'key': 'C', 'label': 'Z' },
            { 'key': 'D', 'label': 'W', 'kind': 'weird' }
        ]
        const invalid = invalidOptionKinds( { options } )

        expect( invalid.map( ( o ) => o[ 'key' ] ) ).toEqual( [ 'B', 'D' ] )
        expect( invalid.map( ( o ) => o[ 'kind' ] ) ).toEqual( [ 'normal', 'weird' ] )
    } )
} )


// Memo 045 (Kap 16): the single-select gate must NOT re-scrape recommendation prose for A-H letters.
// Two real-world false negatives this pins: (1) a prose-only recommendation that names no letter
// (e.g. the auto Finalisierungs-Checkliste question); (2) a recommendation containing the German
// abbreviation "z. B." whose standalone "B" was mis-read as a phantom second option key. Both are
// structurally valid single-selects and MUST render as clickable cards. Structural rejections stay.
describe( 'Memo 045 — single-select renderable on structure, not on prose-scraped letters', () => {
    const twoOpts = [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ]

    it( 'renders a single-select whose recommendation names NO option letter (prose-only)', () => {
        const q = { 'id': 'F1', 'frage': 'Q', 'aiRecommendation': 'Checkliste prüfen und ggf. ergänzen — kein Blocker.', 'typ': 'single', 'options': twoOpts }
        expect( isRenderable( { question: q } ) ).toBe( true )
    } )

    it( 'renders a single-select whose recommendation contains "z. B." (no phantom-B rejection)', () => {
        const q = { 'id': 'F8', 'frage': 'Q', 'aiRecommendation': 'A — registry.json wird Discovery-Quelle, z. B. .workbench/registry.json.', 'typ': 'single', 'options': twoOpts }
        expect( isRenderable( { question: q } ) ).toBe( true )
    } )

    it( 'still rejects structurally broken questions (frage, <2 options, id, empty single rec)', () => {
        expect( isRenderable( { question: { 'id': 'F2', 'frage': '', 'aiRecommendation': 'A', 'typ': 'single', 'options': twoOpts } } ) ).toBe( false )
        expect( isRenderable( { question: { 'id': 'F3', 'frage': 'Q', 'aiRecommendation': 'A', 'typ': 'single', 'options': [ twoOpts[ 0 ] ] } } ) ).toBe( false )
        expect( isRenderable( { question: { 'id': 'X1', 'frage': 'Q', 'aiRecommendation': 'A', 'typ': 'single', 'options': twoOpts } } ) ).toBe( false )
        expect( isRenderable( { question: { 'id': 'F4', 'frage': 'Q', 'aiRecommendation': '', 'typ': 'single', 'options': twoOpts } } ) ).toBe( false )
    } )
} )


describe( 'Memo 041 Teil B — MEMO-033 fail-loud at the door', () => {
    it( 'reports MEMO-033 for an invalid option.kind and fails the validator', () => {
        const doc = buildQuestionsJsonDoc( { questions: [
            { 'id': 'F1', 'title': 'T', 'typ': 'single', 'hintergrund': 'h', 'frage': 'f', 'aiRecommendation': 'A',
              'options': [ { 'key': 'A', 'label': 'X', 'kind': 'normal' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] }
        ] } )

        const result = MemoValidator.validate( { doc } )
        const memo033 = result[ 'messages' ].filter( ( m ) => /^MEMO-033\b/.test( m ) )

        expect( memo033.length ).toBe( 1 )
        expect( memo033[ 0 ] ).toContain( 'normal' )
        expect( result[ 'status' ] ).toBe( false )
    } )


    it( 'does NOT report MEMO-033 when all kinds are valid', () => {
        const doc = buildQuestionsJsonDoc( { questions: [
            { 'id': 'F1', 'title': 'T', 'typ': 'single', 'hintergrund': 'h', 'frage': 'f', 'aiRecommendation': 'A',
              'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] }
        ] } )

        const result = MemoValidator.validate( { doc } )
        const memo033 = result[ 'messages' ].filter( ( m ) => /^MEMO-033\b/.test( m ) )

        expect( memo033.length ).toBe( 0 )
    } )


    it( 'does NOT report MEMO-033 when kind is simply omitted (defaults to option)', () => {
        const doc = buildQuestionsJsonDoc( { questions: [
            { 'id': 'F1', 'title': 'T', 'typ': 'single', 'hintergrund': 'h', 'frage': 'f', 'aiRecommendation': 'A',
              'options': [ { 'key': 'A', 'label': 'X' }, { 'key': 'B', 'label': 'Y' } ] }
        ] } )

        const result = MemoValidator.validate( { doc } )
        const memo033 = result[ 'messages' ].filter( ( m ) => /^MEMO-033\b/.test( m ) )

        expect( memo033.length ).toBe( 0 )
    } )
} )


describe( 'Memo 041 Teil B — defensive kind coercion (suspenders)', () => {
    it( 'coerces an unknown option.kind to option so a slipped-through payload still renders', () => {
        const doc = buildQuestionsJsonDoc( { questions: [
            { 'id': 'F1', 'title': 'T', 'typ': 'single', 'hintergrund': 'h', 'frage': 'f', 'aiRecommendation': 'A',
              'options': [ { 'key': 'A', 'label': 'X', 'kind': 'normal' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] }
        ] } )

        const { questions, found } = DocumentRegistry.parseQuestionJsonBlock( { content: doc } )
        expect( found ).toBe( true )

        const optionA = questions[ 0 ][ 'options' ].find( ( o ) => o[ 'key' ] === 'A' )
        expect( optionA[ 'kind' ] ).toBe( 'option' )
    } )


    it( 'leaves the injected custom/topic defaults intact', () => {
        const doc = buildQuestionsJsonDoc( { questions: [
            { 'id': 'F1', 'title': 'T', 'typ': 'single', 'hintergrund': 'h', 'frage': 'f', 'aiRecommendation': 'A',
              'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ] }
        ] } )

        const { questions } = DocumentRegistry.parseQuestionJsonBlock( { content: doc } )
        const kinds = questions[ 0 ][ 'options' ].map( ( o ) => o[ 'kind' ] )

        expect( kinds ).toContain( 'custom' )
        expect( kinds ).toContain( 'topic' )
    } )
} )
