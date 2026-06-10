import { describe, it, expect } from '@jest/globals'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-004 (Memo 024 Kap 4, F3=A): the memo status is a full lifecycle:
//   Entwurf -> In Bearbeitung -> Finalisiert -> Abgeschlossen   (+ Sonderfall Bedingt finalisiert).
// parseStatus reads the frontmatter status (all enum values, including the two new ones), while
// deriveLifecycleStatus adds the plan-derived 'Abgeschlossen' and the 'In Bearbeitung' heuristic.
function statusFrontmatter( value ) {
    return [
        '# Memo',
        '',
        '| Feld | Wert |',
        '|------|------|',
        '| **Status** | ' + value + ' |',
        ''
    ].join( '\n' )
}


describe( 'DocumentRegistry.getMemoStatusValues (PRD-004)', () => {
    it( 'AC: exposes exactly the 5 lifecycle values (4 ordered + Sonderfall)', () => {
        const { values } = DocumentRegistry.getMemoStatusValues()

        expect( values ).toEqual( [ 'Entwurf', 'In Bearbeitung', 'Finalisiert', 'Abgeschlossen', 'Bedingt finalisiert' ] )
    } )


    it( 'AC: exposes the ordered lifecycle ladder (without the Sonderfall)', () => {
        const { lifecycle } = DocumentRegistry.getMemoStatusValues()

        expect( lifecycle ).toEqual( [ 'Entwurf', 'In Bearbeitung', 'Finalisiert', 'Abgeschlossen' ] )
    } )


    it( 'has default "Entwurf"', () => {
        const { default: fallback } = DocumentRegistry.getMemoStatusValues()

        expect( fallback ).toBe( 'Entwurf' )
    } )


    it( 'returns copies, never the shared array references', () => {
        const first = DocumentRegistry.getMemoStatusValues()
        first.values.push( 'Manipuliert' )
        first.lifecycle.push( 'Manipuliert' )

        const second = DocumentRegistry.getMemoStatusValues()

        expect( second.values ).toEqual( [ 'Entwurf', 'In Bearbeitung', 'Finalisiert', 'Abgeschlossen', 'Bedingt finalisiert' ] )
        expect( second.lifecycle ).toEqual( [ 'Entwurf', 'In Bearbeitung', 'Finalisiert', 'Abgeschlossen' ] )
    } )
} )


describe( 'DocumentRegistry.parseStatus lifecycle values (PRD-004)', () => {
    it( 'AC: recognizes a frontmatter status "In Bearbeitung"', () => {
        const { memoStatus } = DocumentRegistry.parseStatus( { content: statusFrontmatter( 'In Bearbeitung' ) } )

        expect( memoStatus ).toBe( 'In Bearbeitung' )
    } )


    it( 'AC: still recognizes Entwurf (no regression)', () => {
        const { memoStatus } = DocumentRegistry.parseStatus( { content: statusFrontmatter( 'Entwurf' ) } )

        expect( memoStatus ).toBe( 'Entwurf' )
    } )


    it( 'AC: still recognizes Finalisiert (no regression)', () => {
        const { memoStatus } = DocumentRegistry.parseStatus( { content: statusFrontmatter( 'Finalisiert' ) } )

        expect( memoStatus ).toBe( 'Finalisiert' )
    } )


    it( 'AC: still recognizes Bedingt finalisiert (no regression)', () => {
        const { memoStatus } = DocumentRegistry.parseStatus( { content: statusFrontmatter( 'Bedingt finalisiert' ) } )

        expect( memoStatus ).toBe( 'Bedingt finalisiert' )
    } )


    it( 'matches case-insensitively (no regression)', () => {
        const { memoStatus } = DocumentRegistry.parseStatus( { content: statusFrontmatter( 'in bearbeitung' ) } )

        expect( memoStatus ).toBe( 'In Bearbeitung' )
    } )


    it( 'AC: an unknown status falls back silently to the default "Entwurf"', () => {
        const { memoStatus } = DocumentRegistry.parseStatus( { content: statusFrontmatter( 'Irgendwas' ) } )

        expect( memoStatus ).toBe( 'Entwurf' )
    } )


    it( 'tolerates empty content (default)', () => {
        const { memoStatus } = DocumentRegistry.parseStatus( { content: '' } )

        expect( memoStatus ).toBe( 'Entwurf' )
    } )
} )


describe( 'DocumentRegistry.deriveLifecycleStatus (PRD-004)', () => {
    it( 'AC: "Abgeschlossen" is derived from the plan source (planCompleted), NOT the frontmatter', () => {
        const { memoStatus } = DocumentRegistry.deriveLifecycleStatus( {
            frontmatterStatus: 'Finalisiert',
            revisionCount: 3,
            planCompleted: true
        } )

        expect( memoStatus ).toBe( 'Abgeschlossen' )
    } )


    it( 'planCompleted has highest priority — wins over every frontmatter value', () => {
        const draftDone = DocumentRegistry.deriveLifecycleStatus( { frontmatterStatus: 'Entwurf', planCompleted: true } )
        const conditionalDone = DocumentRegistry.deriveLifecycleStatus( { frontmatterStatus: 'Bedingt finalisiert', planCompleted: true } )

        expect( draftDone.memoStatus ).toBe( 'Abgeschlossen' )
        expect( conditionalDone.memoStatus ).toBe( 'Abgeschlossen' )
    } )


    it( 'carries over the frontmatter Finalisiert when no plan completion', () => {
        const { memoStatus } = DocumentRegistry.deriveLifecycleStatus( { frontmatterStatus: 'Finalisiert', revisionCount: 5 } )

        expect( memoStatus ).toBe( 'Finalisiert' )
    } )


    it( 'carries over the Sonderfall Bedingt finalisiert', () => {
        const { memoStatus } = DocumentRegistry.deriveLifecycleStatus( { frontmatterStatus: 'Bedingt finalisiert' } )

        expect( memoStatus ).toBe( 'Bedingt finalisiert' )
    } )


    it( 'carries over an explicit frontmatter In Bearbeitung', () => {
        const { memoStatus } = DocumentRegistry.deriveLifecycleStatus( { frontmatterStatus: 'In Bearbeitung', revisionCount: 1 } )

        expect( memoStatus ).toBe( 'In Bearbeitung' )
    } )


    it( 'AC: heuristic — non-finalized memo with more than one revision is "In Bearbeitung"', () => {
        const { memoStatus } = DocumentRegistry.deriveLifecycleStatus( { frontmatterStatus: 'Entwurf', revisionCount: 2 } )

        expect( memoStatus ).toBe( 'In Bearbeitung' )
    } )


    it( 'a single-revision draft stays "Entwurf" (heuristic does not fire)', () => {
        const { memoStatus } = DocumentRegistry.deriveLifecycleStatus( { frontmatterStatus: 'Entwurf', revisionCount: 1 } )

        expect( memoStatus ).toBe( 'Entwurf' )
    } )


    it( 'AC: backward compatible — no inputs at all falls back to "Entwurf"', () => {
        const empty = DocumentRegistry.deriveLifecycleStatus( {} )
        const undef = DocumentRegistry.deriveLifecycleStatus()

        expect( empty.memoStatus ).toBe( 'Entwurf' )
        expect( undef.memoStatus ).toBe( 'Entwurf' )
    } )


    it( 'tolerates a non-numeric revisionCount (no throw, default path)', () => {
        const { memoStatus } = DocumentRegistry.deriveLifecycleStatus( { frontmatterStatus: 'Entwurf', revisionCount: 'x' } )

        expect( memoStatus ).toBe( 'Entwurf' )
    } )
} )
