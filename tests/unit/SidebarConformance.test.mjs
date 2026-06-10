import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'


// PRD-003 (Memo 018 Kap 6): sidebar conformance to the finalized 014 (Kap 7) and 015 (REV-05)
// decisions. The sidebar markup is produced by renderSidebarMemos inside the single inline
// <script> of the HTML page; the matching CSS lives in the page <style>. Rather than booting
// the server, we read the source and assert on the emitted browser script + full source.
describe( 'Sidebar conformance — PRD-003 (Memo 018 Kap 6 / 014 / 015)', () => {
    let source = ''
    let emittedScript = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )
        source = await readFile( sourcePath, 'utf8' )

        const open = source.lastIndexOf( '<script>' )
        const close = source.indexOf( '</script>', open )
        const rawSlice = source.slice( open + '<script>'.length, close )

        expect( rawSlice.includes( '${' ) ).toBe( false )

        // eslint-disable-next-line no-new-func — controlled, no interpolation, escape-faithful.
        const toRuntime = new Function( 'return `' + rawSlice.replace( /`/g, '\\`' ) + '`' )
        emittedScript = toRuntime()
    } )


    it( 'no longer emits the "Neue Memos" sidebar section (A1; 015 REV-05 F6)', () => {
        expect( emittedScript.includes( 'Neue Memos</div>' ) ).toBe( false )
        expect( emittedScript.includes( "id=\"staging-list\"" ) ).toBe( false )
        expect( emittedScript.includes( 'staging-entry' ) ).toBe( false )
    } )


    it( 'no longer references loadOtherTranscripts in the memos view (A1)', () => {
        expect( emittedScript.includes( 'loadOtherTranscripts' ) ).toBe( false )
    } )


    it( 'has no .staging-entry CSS rule in the source (A1; AC3)', () => {
        expect( source.includes( '.staging-entry' ) ).toBe( false )
    } )


    it( 'emits a "Namespaces" group header (A2; AC4)', () => {
        expect( emittedScript.includes( "'<div class=\"sb-group-header\">Namespaces</div>'" ) ).toBe( true )
    } )


    it( 'defines a .memo-group margin-bottom for memo spacing (A3; AC5)', () => {
        expect( /\.memo-group\s*\{[^}]*margin-bottom:\s*6px/.test( source ) ).toBe( true )
    } )


    // SUPERSEDED by Memo 022 PRD-005: the per-revision Typ-Badge (Full/Update) was REMOVED from
    // the rev-mini Mini-Widget — bei nur-Full-Ansicht (PRD-004) ist er redundant; die prominente
    // Revisionsnummer (data-rev-num) traegt jetzt die Identifikation. The old "Fragen beantworten"
    // wording must of course also stay gone.
    it( 'no per-revision type-badge label in the Mini-Widget (Memo 022 PRD-005 AC-2)', () => {
        expect( emittedScript.includes( 'rt-full">Full</span>' ) ).toBe( false )
        expect( emittedScript.includes( 'rt-update">Update</span>' ) ).toBe( false )
        expect( emittedScript.includes( 'rt-full">Fragen beantworten</span>' ) ).toBe( false )
        // The prominent REV-NN identifier is what replaces the badge.
        expect( emittedScript.includes( 'data-rev-num' ) ).toBe( true )
    } )


    it( 'uses .content-placeholder instead of inline color:#888 for the doc placeholder (A5; AC7/AC8)', () => {
        expect( emittedScript.includes( '<p class="content-placeholder">Dokument auswaehlen...</p>' ) ).toBe( true )
        expect( emittedScript.includes( '<p style="color:#888">Dokument auswaehlen...</p>' ) ).toBe( false )
        expect( /\.content-placeholder\s*\{[^}]*var\(--text-muted\)/.test( source ) ).toBe( true )
    } )


    it( 'keeps the memo-head clickable with a subtle hover (AC9; 015 REV-05 R2/R3)', () => {
        expect( /\.memo-head\s*\{[^}]*cursor:\s*pointer/.test( source ) ).toBe( true )
        expect( /\.memo-head:hover\s*\{[^}]*var\(--hover-bg\)/.test( source ) ).toBe( true )
    } )
} )
