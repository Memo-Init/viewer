import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'


// PRD-002 (Memo 022, Kap 3): "Prompt bearbeiten → Übernehmen" (applyPromptEdit) must, after a
// successful save: (a) remember the server transcriptId for idempotency (second save -> PUT,
// not POST), (b) copy the returned URL to the clipboard, (c) show a visible success quittance
// with the URL, (d) activate the Zone-2 ps-copy button immediately. applyPromptEdit + the
// activatePsCopy helper live inside the single emitted inline <script>; booting the server would
// open a browser, so — like QuestionRenderGate.test.mjs — we read the source, reproduce the
// template-literal escape processing to obtain the EXACT browser string, then run the two
// functions in a vm sandbox with light fetch/clipboard/document stubs.
const here = dirname( fileURLToPath( import.meta.url ) )
const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )


function extractFunction( script, signature ) {
    const start = script.indexOf( signature )
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


function makeNode() {
    const node = { textContent: '', value: '', disabled: false, className: '', dataset: {}, attrs: {}, classes: new Set(), handlers: {} }
    node.classList = {
        add: ( c ) => node.classes.add( c ),
        remove: ( c ) => node.classes.delete( c ),
        contains: ( c ) => node.classes.has( c )
    }
    node.setAttribute = ( k, v ) => { node.attrs[ k ] = v }
    node.getAttribute = ( k ) => ( k in node.attrs ? node.attrs[ k ] : null )
    node.removeAttribute = ( k ) => { delete node.attrs[ k ] }
    node.addEventListener = ( ev, fn ) => { node.handlers[ ev ] = fn }
    node.querySelectorAll = () => []
    return node
}


describe( 'PRD-002 applyPromptEdit — emitted browser string', () => {
    let extractedSource = ''
    let sandbox = null
    let nodes = null
    let fetchCalls = null
    let clipboardWrites = null


    beforeAll( async () => {
        const source = await readFile( sourcePath, 'utf8' )
        const open = source.lastIndexOf( '<script>' )
        const close = source.indexOf( '</script>', open )
        const rawSlice = source.slice( open + '<script>'.length, close )

        expect( rawSlice.includes( '${' ) ).toBe( false )

        const toRuntime = new Function( 'return `' + rawSlice.replace( /`/g, '\\`' ) + '`' )
        const emittedScript = toRuntime()

        const applySrc = extractFunction( emittedScript, 'async function applyPromptEdit(' )
        const activateSrc = extractFunction( emittedScript, 'function activatePsCopy(' )

        expect( applySrc.length ).toBeGreaterThan( 0 )
        expect( activateSrc.length ).toBeGreaterThan( 0 )

        extractedSource = applySrc + '\n' + activateSrc
            + '\nglobalThis.__apply = applyPromptEdit;'
            + '\nglobalThis.__activate = activatePsCopy;'
    } )


    function freshSandbox() {
        nodes = {
            'pp-error': makeNode(),
            'pp-success': makeNode(),
            'pp-content': makeNode(),
            'pp-revision': makeNode(),
            'ps-copy': makeNode()
        }
        nodes[ 'ps-copy' ].disabled = true
        fetchCalls = []
        clipboardWrites = []

        sandbox = {
            promptEditState: { transcriptId: null, projectId: 'p1', memoId: 'M022', revisionId: 'REV-04', questions: [] },
            document: {
                getElementById: ( id ) => ( id in nodes ? nodes[ id ] : null ),
                querySelectorAll: () => []
            },
            navigator: {
                clipboard: {
                    writeText: ( txt ) => { clipboardWrites.push( txt ); return Promise.resolve() }
                }
            },
            setTimeout: () => 0,
            fetch: ( url, opts ) => {
                fetchCalls.push( { url, opts } )
                return Promise.resolve( {
                    ok: true,
                    json: () => Promise.resolve( { transcriptId: 'T-NEW-1', url: 'http://localhost:3333/transcripts/T-NEW-1' } )
                } )
            },
            closeTranscriptModal: () => {},
            console
        }

        vm.createContext( sandbox )
        vm.runInContext( extractedSource, sandbox )
    }


    it( 'first save POSTs (Anlage), then sets transcriptId for idempotency (AC-5)', async () => {
        freshSandbox()
        nodes[ 'pp-content' ].value = 'Ein Transcript-Text'
        nodes[ 'pp-revision' ].value = 'REV-04'

        await sandbox.__apply()

        expect( fetchCalls.length ).toBe( 1 )
        expect( fetchCalls[ 0 ].url ).toBe( '/api/transcripts' )
        expect( fetchCalls[ 0 ].opts.method ).toBe( 'POST' )
        // Idempotency: the server-assigned id is now remembered.
        expect( sandbox.promptEditState.transcriptId ).toBe( 'T-NEW-1' )
    } )


    it( 'second save without re-render PUTs the SAME id — no duplicate (AC-5)', async () => {
        freshSandbox()
        nodes[ 'pp-content' ].value = 'Erster Text'
        nodes[ 'pp-revision' ].value = 'REV-04'
        await sandbox.__apply()

        // second "Übernehmen" without a render — id is already remembered.
        nodes[ 'pp-content' ].value = 'Geänderter Text'
        fetchCalls.length = 0
        await sandbox.__apply()

        expect( fetchCalls.length ).toBe( 1 )
        expect( fetchCalls[ 0 ].url ).toBe( '/api/transcripts/T-NEW-1' )
        expect( fetchCalls[ 0 ].opts.method ).toBe( 'PUT' )
    } )


    it( 'copies the returned URL to the clipboard after save (AC-2)', async () => {
        freshSandbox()
        nodes[ 'pp-content' ].value = 'Text'
        nodes[ 'pp-revision' ].value = 'REV-04'

        await sandbox.__apply()

        expect( clipboardWrites ).toContain( 'http://localhost:3333/transcripts/T-NEW-1' )
    } )


    it( 'shows a visible success quittance with the URL (AC-2)', async () => {
        freshSandbox()
        nodes[ 'pp-content' ].value = 'Text'
        nodes[ 'pp-revision' ].value = 'REV-04'

        await sandbox.__apply()

        const success = nodes[ 'pp-success' ]
        expect( success.classes.has( 't-hidden' ) ).toBe( false )
        expect( success.textContent.includes( 'http://localhost:3333/transcripts/T-NEW-1' ) ).toBe( true )
    } )


    it( 'activates the ps-copy button after save — not disabled, data-url set (AC-4)', async () => {
        freshSandbox()
        nodes[ 'pp-content' ].value = 'Text'
        nodes[ 'pp-revision' ].value = 'REV-04'

        await sandbox.__apply()

        const psCopy = nodes[ 'ps-copy' ]
        expect( psCopy.disabled ).toBe( false )
        expect( psCopy.getAttribute( 'data-url' ) ).toBe( 'http://localhost:3333/transcripts/T-NEW-1' )
        expect( typeof psCopy.handlers.click ).toBe( 'function' )
    } )


    it( 'ps-copy click copies the fresh URL from data-url (AC-4)', async () => {
        freshSandbox()
        nodes[ 'pp-content' ].value = 'Text'
        nodes[ 'pp-revision' ].value = 'REV-04'

        await sandbox.__apply()
        clipboardWrites.length = 0
        nodes[ 'ps-copy' ].handlers.click()

        expect( clipboardWrites ).toContain( 'http://localhost:3333/transcripts/T-NEW-1' )
    } )


    it( 'activatePsCopy is a no-op without a URL (no crash, button untouched)', () => {
        freshSandbox()
        nodes[ 'ps-copy' ].disabled = true

        sandbox.__activate( '' )

        expect( nodes[ 'ps-copy' ].disabled ).toBe( true )
    } )
} )
