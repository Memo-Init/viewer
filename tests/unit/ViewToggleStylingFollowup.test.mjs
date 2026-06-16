import { describe, it, expect } from '@jest/globals'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'


// Memo 016 follow-up: the content-view toggles (#req-view-toggle, #block-view-toggle) were
// raw default-browser buttons — unstyled white boxes that clashed with the dark theme and the
// styled #diff-toggle pill. They must share the #diff-toggle pill look (base + hover + active).
describe( 'content-view toggles share the diff-toggle pill style', () => {
    const css = readFileSync( fileURLToPath( new URL( '../../src/public/app.css', import.meta.url ) ), 'utf8' )

    const ruleFor = ( selectorLine ) => {
        const start = css.indexOf( selectorLine )
        if( start === -1 ) { return '' }
        const open = css.indexOf( '{', start )
        const close = css.indexOf( '}', open )

        return css.slice( start, close + 1 )
    }

    it( 'styles both view toggles in the same base rule as #diff-toggle', () => {
        const base = ruleFor( '#diff-toggle,' )

        expect( base ).toContain( '#req-view-toggle' )
        expect( base ).toContain( '#block-view-toggle' )
        expect( base ).toContain( 'border-radius' )
        expect( base ).toContain( 'border:' )
    } )


    it( 'gives both view toggles a hover state', () => {
        expect( css ).toMatch( /#req-view-toggle:hover/ )
        expect( css ).toMatch( /#block-view-toggle:hover/ )
    } )


    it( 'gives both view toggles an .active state (PRD-009 marks the open panel)', () => {
        expect( css ).toMatch( /#req-view-toggle\.active/ )
        expect( css ).toMatch( /#block-view-toggle\.active/ )
    } )


    it( 'no longer leaves the view toggles without any border-radius styling', () => {
        // The regression was zero CSS for these ids — assert they now appear styled.
        expect( ( css.match( /#req-view-toggle/g ) || [] ).length ).toBeGreaterThanOrEqual( 3 )
        expect( ( css.match( /#block-view-toggle/g ) || [] ).length ).toBeGreaterThanOrEqual( 3 )
    } )
} )
