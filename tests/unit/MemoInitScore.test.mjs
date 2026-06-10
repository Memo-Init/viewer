import { describe, it, expect } from '@jest/globals'

import { MemoInitScore } from '../../src/MemoInitScore.mjs'


describe( 'MemoInitScore', () => {

    describe( 'validateGradeDimension', () => {
        it( 'fails when key is missing', () => {
            const { status, messages } = MemoInitScore.validateGradeDimension( { key: undefined, grade: 'A' } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'key' )
        } )


        it( 'fails when key is unknown', () => {
            const { status, messages } = MemoInitScore.validateGradeDimension( { key: 'something', grade: 'A' } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'Must be one of' )
        } )


        it( 'fails when grade is missing', () => {
            const { status, messages } = MemoInitScore.validateGradeDimension( { key: 'direction', grade: undefined } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'grade' )
        } )


        it( 'fails when grade is not A/B/C', () => {
            const { status, messages } = MemoInitScore.validateGradeDimension( { key: 'direction', grade: 'D' } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'Must be one of' )
        } )


        it( 'passes with valid key and grade', () => {
            const { status } = MemoInitScore.validateGradeDimension( { key: 'direction', grade: 'A' } )

            expect( status ).toBe( true )
        } )
    } )


    describe( 'gradeDimension', () => {
        it( 'grade A produces no hint and no code', () => {
            const { status, dimension } = MemoInitScore.gradeDimension( { key: 'direction', grade: 'A' } )

            expect( status ).toBe( true )
            expect( dimension['isHint'] ).toBe( false )
            expect( dimension['code'] ).toBeNull()
            expect( dimension['message'] ).toBeNull()
            expect( dimension['severity'] ).toBe( 'INFO' )
        } )


        it( 'grade B produces an INFO hint with code', () => {
            const { dimension } = MemoInitScore.gradeDimension( { key: 'context', grade: 'B' } )

            expect( dimension['isHint'] ).toBe( true )
            expect( dimension['severity'] ).toBe( 'INFO' )
            expect( dimension['code'] ).toBe( 'INIT-002' )
            expect( dimension['message'] ).toContain( 'INIT-002 context:' )
        } )


        it( 'grade C produces a WARNING hint with code', () => {
            const { dimension } = MemoInitScore.gradeDimension( { key: 'topics', grade: 'C' } )

            expect( dimension['isHint'] ).toBe( true )
            expect( dimension['severity'] ).toBe( 'WARNING' )
            expect( dimension['code'] ).toBe( 'INIT-003' )
            expect( dimension['message'] ).toContain( 'INIT-003 topics:' )
        } )


        it( 'never produces ERROR severity (advisory guarantee)', () => {
            const grades = [ 'A', 'B', 'C' ]
            const severities = grades
                .map( ( g ) => MemoInitScore.gradeDimension( { key: 'references', grade: g } ) )
                .map( ( r ) => r['dimension']['severity'] )

            expect( severities ).not.toContain( 'ERROR' )
        } )


        it( 'returns messages and does not throw on invalid input', () => {
            const { status, dimension, messages } = MemoInitScore.gradeDimension( { key: 'bogus', grade: 'A' } )

            expect( status ).toBe( false )
            expect( dimension ).toBeNull()
            expect( messages.length ).toBeGreaterThan( 0 )
        } )


        it( 'emits the correct code per dimension', () => {
            const map = {
                'direction': 'INIT-001',
                'context': 'INIT-002',
                'topics': 'INIT-003',
                'references': 'INIT-004'
            }
            const keys = Object.keys( map )

            keys
                .forEach( ( key ) => {
                    const { dimension } = MemoInitScore.gradeDimension( { key, grade: 'C' } )

                    expect( dimension['code'] ).toBe( map[ key ] )
                } )
        } )
    } )


    describe( 'validateEvaluate', () => {
        it( 'fails when grades is missing', () => {
            const { status, messages } = MemoInitScore.validateEvaluate( { grades: undefined } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'grades' )
        } )


        it( 'fails when grades is not an object', () => {
            const { status, messages } = MemoInitScore.validateEvaluate( { grades: 'A' } )

            expect( status ).toBe( false )
            expect( messages[0] ).toContain( 'Must be an object' )
        } )


        it( 'fails when a dimension grade is missing', () => {
            const { status, messages } = MemoInitScore.validateEvaluate( { grades: { direction: 'A', context: 'A', topics: 'A' } } )

            expect( status ).toBe( false )
            expect( messages.some( ( m ) => m.includes( 'references' ) ) ).toBe( true )
        } )


        it( 'fails when a dimension grade is invalid', () => {
            const { status, messages } = MemoInitScore.validateEvaluate( { grades: { direction: 'A', context: 'A', topics: 'A', references: 'Z' } } )

            expect( status ).toBe( false )
            expect( messages.some( ( m ) => m.includes( 'references' ) ) ).toBe( true )
        } )


        it( 'passes with all four valid grades', () => {
            const { status } = MemoInitScore.validateEvaluate( { grades: { direction: 'A', context: 'B', topics: 'C', references: 'A' } } )

            expect( status ).toBe( true )
        } )
    } )


    describe( 'evaluate', () => {
        it( 'all A produces overall A and no hints', () => {
            const { status, grade, dimensions, hints } = MemoInitScore.evaluate( { grades: { direction: 'A', context: 'A', topics: 'A', references: 'A' } } )

            expect( status ).toBe( true )
            expect( grade ).toBe( 'A' )
            expect( dimensions.length ).toBe( 4 )
            expect( hints.length ).toBe( 0 )
        } )


        it( 'lowest dimension dominates the overall grade (min rule)', () => {
            const { grade } = MemoInitScore.evaluate( { grades: { direction: 'A', context: 'B', topics: 'A', references: 'A' } } )

            expect( grade ).toBe( 'B' )
        } )


        it( 'a single C drags the overall grade to C', () => {
            const { grade } = MemoInitScore.evaluate( { grades: { direction: 'A', context: 'B', topics: 'C', references: 'A' } } )

            expect( grade ).toBe( 'C' )
        } )


        it( 'all C produces overall C but still status true (advisory, never blocking)', () => {
            const { status, grade, hints } = MemoInitScore.evaluate( { grades: { direction: 'C', context: 'C', topics: 'C', references: 'C' } } )

            expect( status ).toBe( true )
            expect( grade ).toBe( 'C' )
            expect( hints.length ).toBe( 4 )
        } )


        it( 'lists one hint per non-A dimension (not summed)', () => {
            const { hints } = MemoInitScore.evaluate( { grades: { direction: 'A', context: 'B', topics: 'C', references: 'A' } } )

            expect( hints.length ).toBe( 2 )
            const codes = hints.map( ( h ) => h['code'] )

            expect( codes ).toContain( 'INIT-002' )
            expect( codes ).toContain( 'INIT-003' )
        } )


        it( 'hints carry only INFO or WARNING severity (no ERROR, no gate)', () => {
            const { hints } = MemoInitScore.evaluate( { grades: { direction: 'C', context: 'B', topics: 'C', references: 'B' } } )
            const severities = hints.map( ( h ) => h['severity'] )

            expect( severities ).not.toContain( 'ERROR' )
            severities
                .forEach( ( s ) => {
                    expect( [ 'INFO', 'WARNING' ] ).toContain( s )
                } )
        } )


        it( 'returns messages and does not throw on invalid input', () => {
            const { status, grade, messages } = MemoInitScore.evaluate( { grades: { direction: 'A' } } )

            expect( status ).toBe( false )
            expect( grade ).toBeNull()
            expect( messages.length ).toBeGreaterThan( 0 )
        } )
    } )


    describe( 'getDimensionDefinitions', () => {
        it( 'returns all four dimensions with codes', () => {
            const { dimensions } = MemoInitScore.getDimensionDefinitions()

            expect( dimensions.length ).toBe( 4 )
            const keys = dimensions.map( ( d ) => d['key'] )

            expect( keys ).toEqual( [ 'direction', 'context', 'topics', 'references' ] )
            const codes = dimensions.map( ( d ) => d['code'] )

            expect( codes ).toEqual( [ 'INIT-001', 'INIT-002', 'INIT-003', 'INIT-004' ] )
        } )


        it( 'returns a copy that does not mutate internals', () => {
            const { dimensions } = MemoInitScore.getDimensionDefinitions()
            dimensions[0]['label'] = 'mutated'

            const { dimensions: again } = MemoInitScore.getDimensionDefinitions()

            expect( again[0]['label'] ).not.toBe( 'mutated' )
        } )
    } )
} )
