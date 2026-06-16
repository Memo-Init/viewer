import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MemoView } from '../../src/MemoView.mjs'


// PRD-009 (Memo 016 Kap 7, F4/E6): the #content area has a view-mode state machine — prose is the
// home view, 'requirements'/'blocks' are non-destructive panels. Requesting the active non-prose
// view again toggles BACK to prose (E6 toggle-off / F4 way back). MemoView.nextViewState encodes
// the truth table and is mirrored 1:1 by the inline browser toggles.
describe( 'MemoView.nextViewState (PRD-009, F4/E6)', () => {
    it( 'prose -> requirements switches to the requirements panel', () => {
        const result = MemoView.nextViewState( { current: 'prose', requested: 'requirements' } )

        expect( result ).toEqual( { view: 'requirements', render: true } )
    } )


    it( 'prose -> blocks switches to the blocks panel', () => {
        const result = MemoView.nextViewState( { current: 'prose', requested: 'blocks' } )

        expect( result ).toEqual( { view: 'blocks', render: true } )
    } )


    it( 'requirements -> requirements toggles back to prose (E6 toggle-off)', () => {
        const result = MemoView.nextViewState( { current: 'requirements', requested: 'requirements' } )

        expect( result ).toEqual( { view: 'prose', render: true } )
    } )


    it( 'blocks -> blocks toggles back to prose (E6 toggle-off)', () => {
        const result = MemoView.nextViewState( { current: 'blocks', requested: 'blocks' } )

        expect( result ).toEqual( { view: 'prose', render: true } )
    } )


    it( 'requirements -> blocks switches directly between non-prose panels', () => {
        const result = MemoView.nextViewState( { current: 'requirements', requested: 'blocks' } )

        expect( result ).toEqual( { view: 'blocks', render: true } )
    } )


    it( 'blocks -> requirements switches directly between non-prose panels', () => {
        const result = MemoView.nextViewState( { current: 'blocks', requested: 'requirements' } )

        expect( result ).toEqual( { view: 'requirements', render: true } )
    } )


    it( 'requirements -> prose returns home and re-renders the prose', () => {
        const result = MemoView.nextViewState( { current: 'requirements', requested: 'prose' } )

        expect( result ).toEqual( { view: 'prose', render: true } )
    } )


    it( 'prose -> prose is a no-op home click (no render)', () => {
        const result = MemoView.nextViewState( { current: 'prose', requested: 'prose' } )

        expect( result ).toEqual( { view: 'prose', render: false } )
    } )


    it( 'guards an unknown current to the prose home view', () => {
        const result = MemoView.nextViewState( { current: 'garbage', requested: 'requirements' } )

        expect( result ).toEqual( { view: 'requirements', render: true } )
    } )


    it( 'guards an unknown requested to prose', () => {
        const result = MemoView.nextViewState( { current: 'blocks', requested: 'garbage' } )

        expect( result ).toEqual( { view: 'prose', render: true } )
    } )


    it( 'is idempotent on the way home: two requirements clicks land on prose', () => {
        const open = MemoView.nextViewState( { current: 'prose', requested: 'requirements' } )
        const back = MemoView.nextViewState( { current: open.view, requested: 'requirements' } )

        expect( open.view ).toBe( 'requirements' )
        expect( back.view ).toBe( 'prose' )
    } )
} )


// PRD-009 (Memo 016 Kap 7, E7/F10): a WS content broadcast may only redraw #content when the
// prose/memo home view is on screen. With a requirements/blocks panel open the re-render is gated
// OFF so the open panel survives (E7) and the view-state is preserved across the broadcast (F10).
describe( 'MemoView.shouldRerenderOnBroadcast (PRD-009, E7/F10)', () => {
    it( 'allows a re-render for the prose home view', () => {
        expect( MemoView.shouldRerenderOnBroadcast( { currentView: 'prose' } ) ).toBe( true )
    } )


    it( 'allows a re-render for the legacy memo view alias', () => {
        expect( MemoView.shouldRerenderOnBroadcast( { currentView: 'memo' } ) ).toBe( true )
    } )


    it( 'blocks a re-render when the requirements panel is open (E7)', () => {
        expect( MemoView.shouldRerenderOnBroadcast( { currentView: 'requirements' } ) ).toBe( false )
    } )


    it( 'blocks a re-render when the blocks panel is open (E7)', () => {
        expect( MemoView.shouldRerenderOnBroadcast( { currentView: 'blocks' } ) ).toBe( false )
    } )


    it( 'treats an unset view as prose (initial load default)', () => {
        expect( MemoView.shouldRerenderOnBroadcast( { currentView: undefined } ) ).toBe( true )
        expect( MemoView.shouldRerenderOnBroadcast( { currentView: '' } ) ).toBe( true )
    } )
} )


// Source-shape regression: the inline browser client must keep mirroring the static state machine
// and the broadcast guard — toggles track currentContentView + .active, the WS content handler
// gates its #content re-render on the guard, and the toggle-off path returns to prose.
describe( 'inline view-state client shape (PRD-009, F4/E6/E7/F10)', () => {
    const mjsSource = readFileSync( fileURLToPath( new URL( '../../src/MemoView.mjs', import.meta.url ) ), 'utf8' )
    const clientSource = readFileSync( fileURLToPath( new URL( '../../src/public/app.client.mjs', import.meta.url ) ), 'utf8' )
    const source = mjsSource + '\n' + clientSource

    it( 'declares the currentContentView state, defaulting to prose', () => {
        expect( source ).toContain( "let currentContentView = 'prose'" )
    } )


    it( 'mirrors nextViewState and shouldRerenderOnBroadcast inline', () => {
        expect( source ).toContain( 'function nextViewState( current, requested )' )
        expect( source ).toContain( 'function shouldRerenderOnBroadcast( currentView )' )
    } )


    it( 'gates the WS content re-render on the broadcast guard (E7/F10)', () => {
        expect( source ).toContain( 'if( shouldRerenderOnBroadcast( currentContentView ) )' )
    } )


    it( 'wires the .active toggle indicator to the current view (E6)', () => {
        expect( source ).toContain( 'function syncContentViewToggles()' )
        expect( source ).toContain( "reqBtn.classList.add( 'active' )" )
        expect( source ).toContain( "blockBtn.classList.add( 'active' )" )
    } )


    it( 'resolves the toggle through nextViewState and stores the resulting view', () => {
        expect( source ).toMatch( /var step = nextViewState\( currentContentView, 'requirements' \)/ )
        expect( source ).toMatch( /var step = nextViewState\( currentContentView, 'blocks' \)/ )
        expect( source ).toContain( 'currentContentView = step.view' )
    } )


    it( 'has a non-destructive way back to prose (renderProseContent on toggle-off)', () => {
        expect( source ).toContain( 'function renderProseContent( preserveScroll )' )
        expect( source ).toMatch( /if\( step\.view === 'prose' \) \{\s*renderProseContent\( false \)/ )
    } )


    it( 'resets the view to prose when a memo/revision is explicitly selected', () => {
        const selectRevision = source.slice( source.indexOf( 'window.selectRevision = function' ) )
            .slice( 0, 300 )

        expect( selectRevision ).toContain( "currentContentView = 'prose'" )
    } )
} )
