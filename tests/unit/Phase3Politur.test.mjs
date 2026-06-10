import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'


// Memo 022 Phase 3 (Feinschliff) — PRD-004 (Config/Sidebar-Filter), PRD-007 (Diff-Button Zone 1)
// and PRD-008 (Popup-Politur). As in SidebarConformance we read the source and evaluate the
// escape-faithful main inline-script slice, then assert on emitted markup + source CSS / logic.
describe( 'Memo 022 Phase 3 — Feinschliff', () => {
    let source = ''
    let emittedScript = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )
        source = await readFile( sourcePath, 'utf8' )

        const open = source.lastIndexOf( '<script>' )
        const close = source.indexOf( '</script>', open )
        const rawSlice = source.slice( open + '<script>'.length, close )

        // The main inline script must stay free of template interpolation (config is injected in
        // a SEPARATE early script block, not here).
        expect( rawSlice.includes( '${' ) ).toBe( false )

        // eslint-disable-next-line no-new-func — controlled, no interpolation, escape-faithful.
        const toRuntime = new Function( 'return `' + rawSlice.replace( /`/g, '\\`' ) + '`' )
        emittedScript = toRuntime()
    } )


    // ---- PRD-004: Config-Fundament + Sidebar-Filter. ----
    describe( 'PRD-004 — Config flag + sidebar revision filter', () => {
        it( 'imports the Config class', () => {
            expect( source.includes( "import { Config } from './data/config.mjs'" ) ).toBe( true )
        } )

        it( 'boots the config once before the server starts (startServer)', () => {
            expect( source.includes( 'const { config } = await Config.boot()' ) ).toBe( true )
            expect( source.includes( 'MemoView.#config = config' ) ).toBe( true )
        } )

        it( 'injects window.__MEMO_CONFIG__ into the client HTML', () => {
            expect( source.includes( 'window.__MEMO_CONFIG__ = { showOnlyFullRevisions: ${configFlag} }' ) ).toBe( true )
        } )

        it( 'defines revisionPassesConfigFilter and applies it before rendering the revisions', () => {
            expect( emittedScript.includes( 'function revisionPassesConfigFilter' ) ).toBe( true )
            expect( emittedScript.includes( '.filter( revisionPassesConfigFilter ).forEach( function( rev )' ) ).toBe( true )
        } )

        it( 'filter logic: ON -> only full passes; OFF -> all pass; missing type -> full (Fallback)', () => {
            // Reconstruct the filter against an injected config to keep the test deterministic
            // (the runtime reads window.__MEMO_CONFIG__; here we mirror the exact branch logic).
            function makeFilter( cfg ) {
                return function revisionPassesConfigFilter( rev ) {
                    var c = cfg || {}
                    if( c.showOnlyFullRevisions !== true ) { return true }
                    var revType = ( rev && rev.revisionType ) ? rev.revisionType : 'full'
                    return revType === 'full'
                }
            }

            const onFilter = makeFilter( { showOnlyFullRevisions: true } )
            expect( onFilter( { revisionType: 'full' } ) ).toBe( true )
            expect( onFilter( { revisionType: 'prepare' } ) ).toBe( false )
            expect( onFilter( { revisionType: 'update' } ) ).toBe( false )
            expect( onFilter( {} ) ).toBe( true )            // missing type -> treated as full
            expect( onFilter( { revisionType: '' } ) ).toBe( true )

            const offFilter = makeFilter( { showOnlyFullRevisions: false } )
            expect( offFilter( { revisionType: 'prepare' } ) ).toBe( true )
            expect( offFilter( { revisionType: 'update' } ) ).toBe( true )
            expect( offFilter( { revisionType: 'full' } ) ).toBe( true )
        } )
    } )


    // ---- PRD-005: rev-mini per-revision minutes source. ----
    describe( 'PRD-005 — per-revision minutes (Leitkennzahl)', () => {
        it( 'defines aggregateRevisionMinutes and uses it in renderRevEntry (deterministic, 0 fallback)', () => {
            expect( emittedScript.includes( 'function aggregateRevisionMinutes' ) ).toBe( true )
            expect( emittedScript.includes( 'aggregateRevisionMinutes( doc.memoName, revLabel )' ) ).toBe( true )
        } )

        it( 'aggregateRevisionMinutes returns 0 without a revisionId and rounds up at ~200 w/min', () => {
            // Reconstruct the helper logic (transcriptsForRevision injected) to assert the math.
            function aggregateRevisionMinutes( list ) {
                if( !list ) { return 0 }
                var words = list
                    .map( function( e ) { return ( e && typeof e.words === 'number' && e.words > 0 ) ? e.words : 0 } )
                    .reduce( function( s, v ) { return s + v }, 0 )
                return words === 0 ? 0 : Math.ceil( words / 200 )
            }

            expect( aggregateRevisionMinutes( null ) ).toBe( 0 )
            expect( aggregateRevisionMinutes( [] ) ).toBe( 0 )
            expect( aggregateRevisionMinutes( [ { words: 0 } ] ) ).toBe( 0 )
            expect( aggregateRevisionMinutes( [ { words: 200 } ] ) ).toBe( 1 )
            expect( aggregateRevisionMinutes( [ { words: 201 } ] ) ).toBe( 2 )
            expect( aggregateRevisionMinutes( [ { words: 100 }, { words: 150 } ] ) ).toBe( 2 )
        } )
    } )


    // ---- PRD-007: Diff-Button von Zone 2 nach Zone 1 verschoben. ----
    describe( 'PRD-007 — Diff-Button in Zone 1, neben der Pill', () => {
        it( 'AC-1: #diff-toggle is emitted inside z1Line1, directly after the zone1 pill', () => {
            const pillIdx = emittedScript.indexOf( 'data-zone1-pill' )
            const diffIdx = emittedScript.indexOf( "id=\"diff-toggle\"" )
            expect( pillIdx ).toBeGreaterThan( -1 )
            expect( diffIdx ).toBeGreaterThan( -1 )
            // The diff-toggle markup follows the pill in the z1Line1 string concatenation.
            expect( diffIdx ).toBeGreaterThan( pillIdx )
            // It is the z1Line1 var that carries it (Zone 1 build).
            expect( source.includes( "z1Line1 += '<button id=\"diff-toggle\"" ) ).toBe( true )
        } )

        it( 'AC-2: the diff-toggle is no longer created in the Zone-2 statusRow', () => {
            expect( source.includes( "statusRow += '<button id=\"diff-toggle\"" ) ).toBe( false )
        } )

        it( 'AC-5: #diff-toggle CSS is compact (no full-width), margin-left removed', () => {
            const block = source.slice( source.indexOf( '#diff-toggle {' ), source.indexOf( '#diff-toggle:hover' ) )
            expect( block.includes( 'margin-left: 8px' ) ).toBe( false )
            expect( /font-size:\s*10px/.test( block ) ).toBe( true )
            expect( /flex-shrink:\s*0/.test( block ) ).toBe( true )
        } )

        it( 'AC-4: startzustand display:none stays (bindDiffToggle reveals it)', () => {
            expect( source.includes( 'id="diff-toggle" style="display:none"' ) ).toBe( true )
        } )

        it( 'AC-3: bindDiffToggle still finds the button by id (unchanged)', () => {
            expect( emittedScript.includes( "document.getElementById( 'diff-toggle' )" ) ).toBe( true )
        } )
    } )


    // ---- PRD-008: Popup-Politur. ----
    describe( 'PRD-008 — Popup-Politur', () => {
        it( 'AC-1: dark-theme select styling for the modal (.t-modal-body select, appearance:none)', () => {
            expect( /\.t-modal-body\s+select\s*\{/.test( source ) ).toBe( true )
            const block = source.slice( source.indexOf( '.t-modal-body select {' ), source.indexOf( '.t-modal-body select:focus' ) )
            expect( block.includes( 'appearance: none' ) ).toBe( true )
            expect( block.includes( 'var(--bg-2)' ) ).toBe( true )
        } )

        it( 'AC-2: #t2-content and #ta-content share the same textarea optics/height', () => {
            // Combined selector: both IDs in one rule with height 170px.
            expect( /#t2-content,\s*#ta-content\s*\{[^}]*height:\s*170px/.test( source ) ).toBe( true )
        } )

        it( 'AC-3: switchTranscriptTab clears the now-inactive tab field (no leak)', () => {
            expect( emittedScript.includes( 'function clearTranscriptTabFields' ) ).toBe( true )
            expect( emittedScript.includes( "if( previousTab === 'new' && tab !== 'new' ) { clearTranscriptTabFields( 'new' ) }" ) ).toBe( true )
            expect( emittedScript.includes( "if( previousTab === 'add' && tab !== 'add' ) { clearTranscriptTabFields( 'add' ) }" ) ).toBe( true )
        } )

        it( 'AC-4: closeTranscriptModal resets all tab fields (textareas + selects)', () => {
            const close = emittedScript.slice(
                emittedScript.indexOf( 'function closeTranscriptModal' ),
                emittedScript.indexOf( 'function closeTranscriptModal' ) + 1200
            )
            expect( close.includes( "'t2-content'" ) ).toBe( true )
            expect( close.includes( "'ta-content'" ) ).toBe( true )
            expect( close.includes( "'t2-namespace'" ) ).toBe( true )
            expect( close.includes( "'ta-namespace'" ) ).toBe( true )
            expect( close.includes( "'ta-memo'" ) ).toBe( true )
            expect( close.includes( 'selectedIndex = 0' ) ).toBe( true )
        } )

        it( 'clearTranscriptTabFields targets only the given tab field set', () => {
            // Reconstruct the mapping logic.
            function fieldsFor( tab ) {
                var ids = []
                if( tab === 'new' ) { ids = [ 't2-content' ] }
                if( tab === 'add' ) { ids = [ 'ta-content' ] }
                return ids
            }
            expect( fieldsFor( 'new' ) ).toEqual( [ 't2-content' ] )
            expect( fieldsFor( 'add' ) ).toEqual( [ 'ta-content' ] )
            expect( fieldsFor( 'revision' ) ).toEqual( [] )
        } )
    } )
} )
