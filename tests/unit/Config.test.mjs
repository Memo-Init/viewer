import { describe, it, expect } from '@jest/globals'

import { Config } from '../../src/data/config.mjs'


// PRD-004 (Memo 022 Kap 8): the config fundament. Two levels — hard defaults (#defaults) and an
// optional local override (config.local.mjs, read via dynamic import in boot()). The override may
// ONLY overwrite existing default keys; unknown keys are dropped (no silent default). A missing
// override file is graceful (no crash). boot() validates types (showOnlyFullRevisions boolean).
//
// The merge + validation is tested via the pure Config.applyOverride() — deterministic and free
// of ESM import caching. boot()'s default path (no override file present) is asserted directly.
describe( 'Config — PRD-004 (Memo 022 Kap 8)', () => {
    it( 'AC-1: exports a Config class with boot(), applyOverride() and get()', () => {
        expect( typeof Config.boot ).toBe( 'function' )
        expect( typeof Config.applyOverride ).toBe( 'function' )
        expect( typeof Config.prototype.get ).toBe( 'function' )
    } )


    it( 'AC-2: boot() without an override file -> showOnlyFullRevisions === true (Default ON)', async () => {
        const { config } = await Config.boot()
        const { value } = config.get( { key: 'showOnlyFullRevisions' } )
        expect( value ).toBe( true )
    } )


    it( 'applyOverride() with empty override -> Default (showOnlyFullRevisions true)', () => {
        const { config } = Config.applyOverride( { override: {} } )
        const { value } = config.get( { key: 'showOnlyFullRevisions' } )
        expect( value ).toBe( true )
    } )


    it( 'AC-3: applyOverride() with showOnlyFullRevisions:false is applied; unknown keys dropped', () => {
        const { config } = Config.applyOverride( { override: { showOnlyFullRevisions: false, bogusUnknownKey: 123 } } )
        const { value } = config.get( { key: 'showOnlyFullRevisions' } )
        expect( value ).toBe( false )

        const { object } = config.toObject()
        expect( Object.prototype.hasOwnProperty.call( object, 'bogusUnknownKey' ) ).toBe( false )
        expect( Object.keys( object ) ).toEqual( [ 'showOnlyFullRevisions' ] )
    } )


    it( 'applyOverride() throws on a non-boolean showOnlyFullRevisions (type validation)', () => {
        expect( () => Config.applyOverride( { override: { showOnlyFullRevisions: 'yes' } } ) )
            .toThrow( /CFG-001|boolean|validation/i )
    } )


    it( 'applyOverride() is graceful for a null/non-object override (falls back to defaults)', () => {
        const { config } = Config.applyOverride( { override: null } )
        const { value } = config.get( { key: 'showOnlyFullRevisions' } )
        expect( value ).toBe( true )
    } )


    it( 'get() returns { value } and throws on an unknown key (no silent default)', async () => {
        const { config } = await Config.boot()
        const result = config.get( { key: 'showOnlyFullRevisions' } )
        expect( Object.prototype.hasOwnProperty.call( result, 'value' ) ).toBe( true )
        expect( () => config.get( { key: 'doesNotExist' } ) ).toThrow()
    } )
} )
