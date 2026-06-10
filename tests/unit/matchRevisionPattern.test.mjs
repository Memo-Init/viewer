import { describe, it, expect } from '@jest/globals'
import { MemoView } from '../../src/MemoView.mjs'


describe( 'MemoView.matchRevisionPattern', () => {
    it( 'matches v0.1.md format', () => {
        const { matched, pattern } = MemoView.matchRevisionPattern( { 'fileName': 'v0.1.md' } )

        expect( matched ).toBe( true )
        expect( pattern ).not.toBeNull()
    } )


    it( 'matches v0.2.md format', () => {
        const { matched } = MemoView.matchRevisionPattern( { 'fileName': 'v0.2.md' } )

        expect( matched ).toBe( true )
    } )


    it( 'matches v1.0.md format', () => {
        const { matched } = MemoView.matchRevisionPattern( { 'fileName': 'v1.0.md' } )

        expect( matched ).toBe( true )
    } )


    it( 'matches memo-v0.1.md format', () => {
        const { matched } = MemoView.matchRevisionPattern( { 'fileName': 'memo-v0.1.md' } )

        expect( matched ).toBe( true )
    } )


    it( 'matches REV-01.md format (legacy)', () => {
        const { matched, pattern } = MemoView.matchRevisionPattern( { 'fileName': 'REV-01.md' } )

        expect( matched ).toBe( true )
        expect( pattern ).not.toBeNull()
    } )


    it( 'matches REV-02.md format (legacy)', () => {
        const { matched } = MemoView.matchRevisionPattern( { 'fileName': 'REV-02.md' } )

        expect( matched ).toBe( true )
    } )


    it( 'matches rev-01.md case-insensitive (legacy)', () => {
        const { matched } = MemoView.matchRevisionPattern( { 'fileName': 'rev-01.md' } )

        expect( matched ).toBe( true )
    } )


    it( 'does not match random markdown files', () => {
        const { matched } = MemoView.matchRevisionPattern( { 'fileName': 'memo.md' } )

        expect( matched ).toBe( false )
    } )


    it( 'does not match README.md', () => {
        const { matched } = MemoView.matchRevisionPattern( { 'fileName': 'README.md' } )

        expect( matched ).toBe( false )
    } )


    it( 'does not match implementation-plan.md', () => {
        const { matched } = MemoView.matchRevisionPattern( { 'fileName': 'implementation-plan.md' } )

        expect( matched ).toBe( false )
    } )


    it( 'returns consistent pattern for same format family', () => {
        const { pattern: p1 } = MemoView.matchRevisionPattern( { 'fileName': 'v0.1.md' } )
        const { pattern: p2 } = MemoView.matchRevisionPattern( { 'fileName': 'v0.2.md' } )

        expect( p1.source ).toBe( p2.source )
    } )


    it( 'returns different pattern for different format families', () => {
        const { pattern: vPattern } = MemoView.matchRevisionPattern( { 'fileName': 'v0.1.md' } )
        const { pattern: revPattern } = MemoView.matchRevisionPattern( { 'fileName': 'REV-01.md' } )

        expect( vPattern.source ).not.toBe( revPattern.source )
    } )


    it( 'returns revisionNumber as integer for REV-XX.md (PRD-008)', () => {
        const { matched, revisionNumber, suffix } = MemoView.matchRevisionPattern( { 'fileName': 'REV-02.md' } )

        expect( matched ).toBe( true )
        expect( revisionNumber ).toBe( 2 )
        expect( suffix ).toBeNull()
    } )


    it( 'returns suffix prepare for REV-XX-prepare.md (PRD-008)', () => {
        const { matched, revisionNumber, suffix } = MemoView.matchRevisionPattern( { 'fileName': 'REV-02-prepare.md' } )

        expect( matched ).toBe( true )
        expect( revisionNumber ).toBe( 2 )
        expect( suffix ).toBe( 'prepare' )
    } )


    it( 'returns suffix update for REV-XX-update.md (PRD-008)', () => {
        const { matched, revisionNumber, suffix } = MemoView.matchRevisionPattern( { 'fileName': 'REV-02-update.md' } )

        expect( matched ).toBe( true )
        expect( revisionNumber ).toBe( 2 )
        expect( suffix ).toBe( 'update' )
    } )


    it( 'does not match README.md and returns null revisionNumber (PRD-008)', () => {
        const { matched, revisionNumber, suffix } = MemoView.matchRevisionPattern( { 'fileName': 'README.md' } )

        expect( matched ).toBe( false )
        expect( revisionNumber ).toBeNull()
        expect( suffix ).toBeNull()
    } )


    it( 'sorts mixed revision files numerically and by suffix order (PRD-008)', () => {
        const files = [ 'REV-03-prepare.md', 'REV-02.md', 'REV-01.md', 'REV-02-update.md', 'REV-02-prepare.md' ]
        const sorted = [ ...files ]
            .filter( ( f ) => {
                const { matched } = MemoView.matchRevisionPattern( { fileName: f } )

                return matched
            } )
            .sort( ( a, b ) => {
                const matchA = MemoView.matchRevisionPattern( { fileName: a } )
                const matchB = MemoView.matchRevisionPattern( { fileName: b } )

                if( matchA.revisionNumber !== matchB.revisionNumber ) {
                    return matchA.revisionNumber - matchB.revisionNumber
                }

                const order = ( suffix ) => {
                    if( suffix === 'prepare' ) { return 0 }
                    if( suffix === 'update' ) { return 1 }

                    return 2
                }

                return order( matchA.suffix ) - order( matchB.suffix )
            } )

        expect( sorted ).toEqual( [ 'REV-01.md', 'REV-02-prepare.md', 'REV-02-update.md', 'REV-02.md', 'REV-03-prepare.md' ] )
    } )
} )
