// PRD-004 (Memo 022 Kap 8): erste, bewusst minimale Konfigurationsschicht fuer memo-view.
// Zwei Ebenen: harte Default-Werte (#defaults) + optionaler lokaler Override (config.local.mjs).
// Der Override darf NUR existierende Default-Keys ueberschreiben (unbekannte Keys werden
// verworfen — kein Silent-Default-Verstoss). Fehlt die Override-Datei, gilt der Default
// (graceful, kein Crash). Boot-Read erfolgt EINMAL beim Serverstart.

class Config {
    static #defaults = {
        'showOnlyFullRevisions': true
    }


    static async #readOverride() {
        let override = {}

        try {
            const module = await import( './config.local.mjs' )
            const candidate = module && module.default

            if( candidate !== undefined && candidate !== null && typeof candidate === 'object' ) {
                override = candidate
            }
        } catch( error ) {
            override = {}
        }

        return { override }
    }


    static #validate( { merged } ) {
        const status = { 'status': true, 'messages': [] }

        if( typeof merged.showOnlyFullRevisions !== 'boolean' ) {
            status.messages.push( 'CFG-001 showOnlyFullRevisions must be boolean' )
        }

        status.status = status.messages.length === 0

        return status
    }


    // Pure merge + validation step (testable without the file-system import). Merges the given
    // override over the hard defaults — ONLY existing default keys are taken from the override,
    // unknown keys are dropped (kein Silent-Default-Verstoss). Validates types, then returns a
    // Config instance. Throws on a type violation.
    static applyOverride( { override } ) {
        const source = ( override !== undefined && override !== null && typeof override === 'object' ) ? override : {}
        const defaultKeys = Object.keys( Config.#defaults )
        const merged = {}

        defaultKeys
            .forEach( ( key ) => {
                const hasOverride = Object.prototype.hasOwnProperty.call( source, key )
                merged[ key ] = hasOverride ? source[ key ] : Config.#defaults[ key ]
            } )

        const { status, messages } = Config.#validate( { merged } )

        if( !status ) {
            throw new Error( `Config validation failed: ${ messages.join( ', ' ) }` )
        }

        const config = new Config( { values: merged } )

        return { config }
    }


    static async boot() {
        const { override } = await Config.#readOverride()
        const { config } = Config.applyOverride( { override } )

        return { config }
    }


    #values


    constructor( { values } ) {
        this.#values = values
    }


    get( { key } ) {
        const exists = Object.prototype.hasOwnProperty.call( this.#values, key )

        if( !exists ) {
            throw new Error( `Config.get unknown key: ${ key }` )
        }

        const value = this.#values[ key ]

        return { value }
    }


    toObject() {
        const object = {}

        Object.keys( this.#values )
            .forEach( ( key ) => {
                object[ key ] = this.#values[ key ]
            } )

        return { object }
    }
}


export { Config }
