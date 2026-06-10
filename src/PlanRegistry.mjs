import { watch } from 'node:fs'
import { access, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'


const DEFAULT_REGISTRY_DIR = resolve( homedir(), '.memo-view' )
const DEFAULT_REGISTRY_FILE = resolve( DEFAULT_REGISTRY_DIR, 'plan-registry.json' )


class PlanRegistry {
    #plans = new Map()
    #loaded = false
    #registryFilePath


    constructor( { registryFilePath = DEFAULT_REGISTRY_FILE } = {} ) {
        this.#registryFilePath = registryFilePath
    }


    static create( { registryFilePath = DEFAULT_REGISTRY_FILE } = {} ) {
        const registry = new PlanRegistry( { registryFilePath } )

        return { registry }
    }


    async add( { absolutePath, projectId, onChange } ) {
        const struct = { 'status': false, 'messages': [], 'planId': null }

        const { status: validStatus, messages: validMessages } = PlanRegistry.validateAdd( { absolutePath, projectId } )

        if( !validStatus ) {
            struct['messages'] = validMessages

            return struct
        }

        const resolvedPath = resolve( absolutePath )

        try {
            await access( resolvedPath )
        } catch {
            struct['messages'].push( `absolutePath: Path not found: ${resolvedPath}` )

            return struct
        }

        const pathStat = await stat( resolvedPath )

        if( !pathStat.isDirectory() ) {
            struct['messages'].push( 'absolutePath: Must be a directory' )

            return struct
        }

        await this.#ensureLoaded()

        const planFolderName = basename( resolvedPath )
        const planId = `${projectId}--${planFolderName}`

        const existing = [ ...this.#plans.values() ]
            .find( ( plan ) => plan['absolutePath'] === resolvedPath )

        if( existing !== undefined ) {
            struct['status'] = true
            struct['planId'] = existing['planId']

            return struct
        }

        let watcher = null

        if( typeof onChange === 'function' ) {
            try {
                watcher = watch( resolvedPath, { recursive: false }, onChange )
                watcher.unref()
            } catch {
                watcher = null
            }
        }

        const plan = {
            planId,
            projectId,
            'planName': planFolderName,
            'absolutePath': resolvedPath,
            watcher
        }

        this.#plans.set( planId, plan )

        await this.saveToDisk()

        struct['status'] = true
        struct['planId'] = planId

        return struct
    }


    async remove( { planId } ) {
        const struct = { 'status': false, 'messages': [] }

        await this.#ensureLoaded()

        if( !this.#plans.has( planId ) ) {
            struct['messages'].push( `planId: Not found: ${planId}` )

            return struct
        }

        const plan = this.#plans.get( planId )

        if( plan['watcher'] !== null ) {
            plan['watcher'].close()
        }

        this.#plans.delete( planId )

        await this.saveToDisk()

        struct['status'] = true

        return struct
    }


    async list() {
        await this.#ensureLoaded()

        const plans = [ ...this.#plans.values() ]
            .map( ( plan ) => {
                return {
                    'planId': plan['planId'],
                    'projectId': plan['projectId'],
                    'planName': plan['planName'],
                    'absolutePath': plan['absolutePath']
                }
            } )

        return { plans }
    }


    getPlans() {
        const plans = [ ...this.#plans.values() ]
            .map( ( plan ) => {
                return {
                    'planId': plan['planId'],
                    'projectId': plan['projectId'],
                    'planName': plan['planName'],
                    'absolutePath': plan['absolutePath']
                }
            } )

        return { plans }
    }


    async resolveById( { planId } ) {
        const struct = { 'status': false, 'messages': [], 'plan': null }

        await this.#ensureLoaded()

        if( !this.#plans.has( planId ) ) {
            struct['messages'].push( `planId: Not found: ${planId}` )

            return struct
        }

        const plan = this.#plans.get( planId )

        struct['status'] = true
        struct['plan'] = {
            'planId': plan['planId'],
            'projectId': plan['projectId'],
            'planName': plan['planName'],
            'absolutePath': plan['absolutePath']
        }

        return struct
    }


    async resolveByProjectId( { projectId } ) {
        const struct = { 'status': false, 'messages': [], 'root': null }

        await this.#ensureLoaded()

        const match = [ ...this.#plans.values() ]
            .find( ( plan ) => plan['projectId'] === projectId )

        if( match === undefined ) {
            struct['messages'].push( `projectId: No registered root for: ${projectId}` )

            return struct
        }

        struct['status'] = true
        struct['root'] = {
            'planId': match['planId'],
            'projectId': match['projectId'],
            'planName': match['planName'],
            'absolutePath': match['absolutePath']
        }

        return struct
    }


    async scanAll() {
        await this.#ensureLoaded()

        const planIds = [ ...this.#plans.keys() ]

        return { planIds, 'count': planIds.length }
    }


    async loadFromDisk() {
        try {
            const raw = await readFile( this.#registryFilePath, 'utf-8' )
            const parsed = JSON.parse( raw )

            if( !Array.isArray( parsed ) ) {
                this.#plans = new Map()
                this.#loaded = true

                return { 'status': true, 'loaded': 0, 'warning': 'Registry file malformed — initialized empty' }
            }

            this.#plans = new Map()

            parsed
                .forEach( ( entry ) => {
                    if( !entry['planId'] || !entry['absolutePath'] || !entry['projectId'] ) {
                        return
                    }

                    this.#plans.set( entry['planId'], {
                        'planId': entry['planId'],
                        'projectId': entry['projectId'],
                        'planName': entry['planName'] || basename( entry['absolutePath'] ),
                        'absolutePath': entry['absolutePath'],
                        'watcher': null
                    } )
                } )

            this.#loaded = true

            return { 'status': true, 'loaded': this.#plans.size }
        } catch( err ) {
            if( err.code === 'ENOENT' ) {
                this.#plans = new Map()
                this.#loaded = true

                return { 'status': true, 'loaded': 0 }
            }

            this.#plans = new Map()
            this.#loaded = true

            return { 'status': false, 'loaded': 0, 'warning': `Registry load error: ${err.message}` }
        }
    }


    async saveToDisk() {
        const entries = [ ...this.#plans.values() ]
            .map( ( plan ) => {
                return {
                    'planId': plan['planId'],
                    'projectId': plan['projectId'],
                    'planName': plan['planName'],
                    'absolutePath': plan['absolutePath']
                }
            } )

        try {
            await mkdir( resolve( this.#registryFilePath, '..' ), { recursive: true } )
            await writeFile( this.#registryFilePath, JSON.stringify( entries, null, 2 ), 'utf-8' )

            return { 'status': true }
        } catch( err ) {
            return { 'status': false, 'messages': [ `saveToDisk failed: ${err.message}` ] }
        }
    }


    static validateAdd( { absolutePath, projectId } ) {
        const struct = { 'status': false, 'messages': [] }

        if( absolutePath === undefined || absolutePath === null ) {
            struct['messages'].push( 'absolutePath: Missing required parameter' )

            return struct
        }

        if( typeof absolutePath !== 'string' || absolutePath.trim() === '' ) {
            struct['messages'].push( 'absolutePath: Must be a non-empty string' )

            return struct
        }

        if( projectId === undefined || projectId === null ) {
            struct['messages'].push( 'projectId: Missing required parameter' )

            return struct
        }

        if( typeof projectId !== 'string' || projectId.trim() === '' ) {
            struct['messages'].push( 'projectId: Must be a non-empty string' )

            return struct
        }

        if( !/^[a-zA-Z0-9_-]+$/.test( projectId.trim() ) ) {
            struct['messages'].push( 'projectId: Must contain only alphanumeric characters, hyphens, and underscores' )

            return struct
        }

        struct['status'] = true

        return struct
    }


    async #ensureLoaded() {
        if( !this.#loaded ) {
            await this.loadFromDisk()
        }
    }
}


export { PlanRegistry }
