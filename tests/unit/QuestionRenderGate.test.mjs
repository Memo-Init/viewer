import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'


// PRD-004 (Memo 019, Kap 4) — the Fragen-Render-Gate (100%-Regel). The gate lives inside the
// single inline <script> the server emits. Booting the full server would open a browser, so
// — like QuestionWidgetRender.test.mjs — we read the source, reproduce the template-literal
// escape processing to obtain the EXACT browser string, then isolate the two pure-ish gate
// functions (isQuestionCleanParse + buildQuestionFallback) and exercise them with light
// document/marked stubs. That proves the gate decision (Widget XOR Markdown-Fallback) per
// AC 3-6 without a DOM.

const here = dirname( fileURLToPath( import.meta.url ) )
const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )


function extractFunction( script, name ) {
    // Slice from "function {name}(" to the matching closing brace via brace counting.
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


describe( 'PRD-004 render gate — emitted browser string', () => {
    let emittedScript = ''
    let cleanParse = null
    let buildFallback = null


    beforeAll( async () => {
        const source = await readFile( sourcePath, 'utf8' )
        const open = source.lastIndexOf( '<script>' )
        const close = source.indexOf( '</script>', open )
        const rawSlice = source.slice( open + '<script>'.length, close )

        expect( rawSlice.includes( '${' ) ).toBe( false )

        const toRuntime = new Function( 'return `' + rawSlice.replace( /`/g, '\\`' ) + '`' )
        emittedScript = toRuntime()

        // Isolate the two gate functions and evaluate them standalone with minimal stubs.
        const cleanSrc = extractFunction( emittedScript, 'isQuestionCleanParse' )
        const fallbackSrc = extractFunction( emittedScript, 'buildQuestionFallback' )

        expect( cleanSrc.length ).toBeGreaterThan( 0 )
        expect( fallbackSrc.length ).toBeGreaterThan( 0 )

        const sandbox = {
            document: {
                createElement: () => {
                    // PRD-001 (Memo 024 Kap 1): the fallback now composes a warning child + a body
                    // child via appendChild (instead of overwriting wrap.innerHTML), so the stub
                    // models appendChild + children. textContent is captured for the warning node.
                    const node = { className: '', innerHTML: '', textContent: '', attrs: {}, children: [] }
                    node.setAttribute = ( k, v ) => { node.attrs[ k ] = v }
                    node.appendChild = ( child ) => { node.children.push( child ); return child }
                    return node
                }
            },
            marked: { parse: ( md ) => md }
        }
        vm.createContext( sandbox )
        vm.runInContext(
            cleanSrc + '\n' + fallbackSrc
                + '\nglobalThis.__clean = isQuestionCleanParse;'
                + '\nglobalThis.__fallback = buildQuestionFallback;',
            sandbox
        )
        cleanParse = sandbox.__clean
        buildFallback = sandbox.__fallback
    } )


    it( 'emits a syntactically valid inline browser script (gate added)', () => {
        let message = ''
        try {
            new vm.Script( emittedScript )
        } catch( err ) {
            message = err.message
        }
        expect( message ).toBe( '' )
    } )


    it( 'wires the gate into renderQuestionWidgets (Widget XOR Fallback)', () => {
        expect( emittedScript.includes( 'isQuestionCleanParse( q )' ) ).toBe( true )
        expect( emittedScript.includes( 'buildQuestionFallback( q )' ) ).toBe( true )
        expect( emittedScript.includes( 'buildQuestionCard( q, qIdx )' ) ).toBe( true )
    } )


    // AC-3: a 100%-clean question is widget-faehig.
    it( 'accepts a fully clean single-select question (AC-3)', () => {
        const q = {
            'id': 'F1',
            'title': 'T',
            'frage': 'Was tun?',
            'aiRecommendation': 'A',
            'typ': 'single',
            'options': [
                { 'key': 'A', 'label': 'Erste', 'kind': 'option' },
                { 'key': 'B', 'label': 'Zweite', 'kind': 'option' }
            ]
        }

        expect( cleanParse( q ) ).toBe( true )
    } )


    // AC-4: missing AI recommendation -> not clean -> fallback.
    it( 'rejects a question without aiRecommendation (AC-4)', () => {
        const q = {
            'id': 'F1', 'frage': 'Was tun?', 'aiRecommendation': '', 'typ': 'single',
            'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ]
        }

        expect( cleanParse( q ) ).toBe( false )
    } )


    // AC-4: only one valid option -> not clean.
    it( 'rejects a question with fewer than two valid options (AC-4)', () => {
        const q = {
            'id': 'F1', 'frage': 'Was tun?', 'aiRecommendation': 'A', 'typ': 'single',
            'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' } ]
        }

        expect( cleanParse( q ) ).toBe( false )
    } )


    // AC-4: recommendation references a non-existing option -> not clean.
    it( 'rejects when aiRecommendation references no existing option (AC-4)', () => {
        const q = {
            'id': 'F1', 'frage': 'Was tun?', 'aiRecommendation': 'Z', 'typ': 'single',
            'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ]
        }

        expect( cleanParse( q ) ).toBe( false )
    } )


    it( 'rejects an empty-label option (no half-parsed option counts)', () => {
        const q = {
            'id': 'F1', 'frage': 'Was tun?', 'aiRecommendation': 'A', 'typ': 'single',
            'options': [ { 'key': 'A', 'label': '', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ]
        }

        expect( cleanParse( q ) ).toBe( false )
    } )


    it( 'rejects a malformed id (not F{N})', () => {
        const q = {
            'id': 'X1', 'frage': 'Was tun?', 'aiRecommendation': 'A', 'typ': 'single',
            'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ]
        }

        expect( cleanParse( q ) ).toBe( false )
    } )


    // AC-5 (mixed): the criterion is per-question — clean and non-clean coexist correctly.
    it( 'decides per question for a mixed set (AC-5)', () => {
        const clean = {
            'id': 'F1', 'frage': 'Q', 'aiRecommendation': 'A', 'typ': 'single',
            'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ]
        }
        const broken = {
            'id': 'F2', 'frage': 'Q', 'aiRecommendation': '', 'typ': 'single',
            'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ]
        }

        expect( cleanParse( clean ) ).toBe( true )
        expect( cleanParse( broken ) ).toBe( false )
    } )


    // AC-6 / AC-7: the fallback renders readable markdown — never an empty/half widget node.
    it( 'builds a non-widget markdown fallback node (AC-6/AC-7)', () => {
        const node = buildFallback( {
            'id': 'F1', 'title': 'Titel', 'hintergrund': 'HG', 'frage': 'Was tun?',
            'aiRecommendation': '', 'options': [ { 'key': 'A', 'label': 'Erste', 'kind': 'option' } ]
        } )

        expect( node.className ).toBe( 'qw-fallback' )
        expect( node.attrs[ 'data-qfallback' ] ).toBe( '1' )

        // PRD-001 (Memo 024 Kap 1): a VISIBLE warning child precedes the raw-text body child —
        // the non-clean question is never silently swallowed.
        const warnChild = node.children.find( ( child ) => child.className === 'qw-fallback-warn' )
        expect( warnChild ).toBeDefined()
        expect( warnChild.textContent.includes( 'F1' ) ).toBe( true )

        const bodyChild = node.children.find( ( child ) => child.className === 'qw-fallback-body' )
        expect( bodyChild ).toBeDefined()
        expect( bodyChild.innerHTML.includes( 'Was tun?' ) ).toBe( true )
        expect( bodyChild.innerHTML.includes( 'F1' ) ).toBe( true )
        expect( bodyChild.innerHTML.includes( 'qw-card' ) ).toBe( false )
    } )


    // PRD-003 (Memo 022, Kap 4, F9=A): a checklist / multi question carries >= 2 derived
    // options but NO A/B/C-letter AI recommendation. It must now pass the gate as a Widget,
    // not be forced into the markdown fallback.
    it( 'accepts a multi/checklist question with >= 2 options and NO AI reference (PRD-003 AC-2)', () => {
        const q = {
            'id': 'F1',
            'title': 'Finalisierungs-Checkliste',
            'frage': 'Welche Punkte sind erfüllt?',
            'aiRecommendation': '',
            'typ': 'multi',
            'options': [
                { 'key': 'A', 'label': 'Tests sind grün', 'kind': 'option' },
                { 'key': 'B', 'label': 'Doku aktuell', 'kind': 'option' }
            ]
        }

        expect( cleanParse( q ) ).toBe( true )
    } )


    it( 'still rejects a multi question with fewer than two options (PRD-003 keeps >= 2 rule)', () => {
        const q = {
            'id': 'F1', 'frage': 'Q', 'aiRecommendation': '', 'typ': 'multi',
            'options': [ { 'key': 'A', 'label': 'Nur eine', 'kind': 'option' } ]
        }

        expect( cleanParse( q ) ).toBe( false )
    } )


    it( 'keeps single-select strict — empty AI recommendation still fails (PRD-003 no regression)', () => {
        const q = {
            'id': 'F1', 'frage': 'Q', 'aiRecommendation': '', 'typ': 'single',
            'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ]
        }

        expect( cleanParse( q ) ).toBe( false )
    } )


    it( 'keeps single-select strict — AI must reference exactly one existing key (PRD-003 no regression)', () => {
        const q = {
            'id': 'F1', 'frage': 'Q', 'aiRecommendation': 'A B', 'typ': 'single',
            'options': [ { 'key': 'A', 'label': 'X', 'kind': 'option' }, { 'key': 'B', 'label': 'Y', 'kind': 'option' } ]
        }

        // Two referenced keys -> single-select still requires EXACTLY one.
        expect( cleanParse( q ) ).toBe( false )
    } )
} )
