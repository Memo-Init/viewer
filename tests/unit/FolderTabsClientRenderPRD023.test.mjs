import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { extractFunctions } from '../helpers/extractFunction.mjs'


// Memo 079 PRD-23 (WI-052, finding e): the configured folderTabs[] render as extra mode toggles in the
// client, generalizing the built-in Specs tab (the folder→tab precedent). This project has NO jsdom (see
// A11yAndLabelsPRD013), so the DOM insertion + click behaviour of renderFolderTabs are asserted at SOURCE
// level and left to a Playwright pass; the PURE mapping buildFolderTabDescriptors (config → render
// descriptors) is lifted out via extractFunctions and unit-tested directly.
describe( 'folderTabs client rendering — Memo 079 PRD-23 (WI-052)', () => {
    let client = ''
    let buildFolderTabDescriptors = null


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        client = await readFile( join( here, '..', '..', 'src', 'public', 'app.client.mjs' ), 'utf8' )
        const fns = await extractFunctions( [ 'buildFolderTabDescriptors' ] )
        buildFolderTabDescriptors = fns.buildFolderTabDescriptors
    } )


    describe( 'buildFolderTabDescriptors (pure)', () => {
        it( 'maps a valid folderTab to a render descriptor with a capitalized label + button id', () => {
            const out = buildFolderTabDescriptors( [ { id: 'context', folder: 'context', view: 'context' } ] )

            expect( out ).toEqual( [ {
                id: 'context',
                folder: 'context',
                view: 'context',
                label: 'Context',
                buttonId: 'mode-folder-context',
                builtinMode: null
            } ] )
        } )


        it( 'maps a spec/specs view to the BUILT-IN specs mode (so the tab routes to the existing Specs view)', () => {
            const out = buildFolderTabDescriptors( [ { id: 'specs', folder: 'spec', view: 'spec' } ] )

            expect( out ).toHaveLength( 1 )
            expect( out[ 0 ].builtinMode ).toBe( 'specs' )
        } )


        it( 'defaults view to the id when the tab omits an explicit view', () => {
            const out = buildFolderTabDescriptors( [ { id: 'proofs', folder: 'proofs' } ] )

            expect( out[ 0 ].view ).toBe( 'proofs' )
            expect( out[ 0 ].builtinMode ).toBeNull()
        } )


        it( 'drops malformed tabs (missing id or folder) and dedups by id', () => {
            const out = buildFolderTabDescriptors( [
                { id: 'context', folder: 'context' },
                { id: 'context', folder: 'other' },
                { id: 'bad' },
                { folder: 'no-id' },
                null
            ] )

            expect( out.map( ( d ) => d.id ) ).toEqual( [ 'context' ] )
        } )


        it( 'a non-array / empty input yields no descriptors (fail-open)', () => {
            expect( buildFolderTabDescriptors( undefined ) ).toEqual( [] )
            expect( buildFolderTabDescriptors( [] ) ).toEqual( [] )
        } )
    } )


    // ---- SOURCE-LEVEL wiring (the DOM parts need a Playwright pass — the Lead runs Playwright). ----
    describe( 'renderFolderTabs wiring (source-level; DOM behaviour = Playwright)', () => {
        it( 'defines renderFolderTabs + selectFolderTab + loadFolderTabs', () => {
            expect( client.includes( 'function renderFolderTabs( folderTabs )' ) ).toBe( true )
            expect( client.includes( 'function selectFolderTab( d )' ) ).toBe( true )
            expect( client.includes( 'function loadFolderTabs()' ) ).toBe( true )
        } )

        it( 'fetches /api/index and renders the returned folderTabs', () => {
            expect( client.includes( "fetch( '/api/index' )" ) ).toBe( true )
            expect( /renderFolderTabs\(\s*payload\s*&&\s*payload\.folderTabs\s*\)/.test( client ) ).toBe( true )
            expect( client.includes( 'loadFolderTabs()' ) ).toBe( true )
        } )

        it( 'injects the folder-tab buttons into #mode-toggle, tagged with data-folder-tab (idempotent removal)', () => {
            expect( /getElementById\(\s*'mode-toggle'\s*\)/.test( client ) ).toBe( true )
            expect( client.includes( "setAttribute( 'data-folder-tab', d.id )" ) ).toBe( true )
            expect( client.includes( "querySelectorAll( 'button[data-folder-tab]' )" ) ).toBe( true )
        } )

        it( 'routes a built-in-mapped tab to setMode and never duplicates the static built-in button', () => {
            expect( client.includes( 'if( d.builtinMode ) {' ) ).toBe( true )
            expect( client.includes( 'setMode( d.builtinMode, { push: true } )' ) ).toBe( true )
            expect( client.includes( "getElementById( 'mode-' + d.builtinMode )" ) ).toBe( true )
        } )
    } )
} )
