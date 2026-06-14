// PRD-003 (Memo 011 Kap 6) — project-prefix reader. The prefix (F18 = MEMO) is declared ONCE in
// .memo/config.json ({ "projectPrefix": "MEMO" }) and consumed by the memo-CLI (PRD-001) and the
// git-commit workflow. NO-OVERWRITE is a hard rule (~/.claude/CLAUDE.md § .env / Memo 032): init()
// never clobbers an existing config.json — it checks existence first and aborts cleanly.

import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'


class MemoConfig {
    // Read { memoDir }/config.json and return { projectPrefix, found }. A missing file (or unreadable
    // JSON) is graceful: { projectPrefix: null, found: false } — and never triggers a write.
    static async read( { memoDir } ) {
        const filePath = join( memoDir, 'config.json' )

        const result = await MemoConfig.#readFile( { filePath } )
        const { found, content } = result

        if( found === false ) {
            return { projectPrefix: null, found: false }
        }

        const parsed = MemoConfig.#parse( { content } )
        const { projectPrefix } = parsed

        return { projectPrefix, found: true }
    }


    // Existence probe — returns { found } without reading or parsing the body.
    static async has( { memoDir } ) {
        const filePath = join( memoDir, 'config.json' )
        const { exists } = await MemoConfig.#exists( { filePath } )

        return { found: exists }
    }


    // Optional init/write — NO-OVERWRITE: if config.json already exists, abort with
    // { written: false, reason: 'exists' }; only when absent do we write { projectPrefix }.
    static async init( { memoDir, projectPrefix } ) {
        const filePath = join( memoDir, 'config.json' )
        const { exists } = await MemoConfig.#exists( { filePath } )

        if( exists === true ) {
            return { written: false, reason: 'exists' }
        }

        const payload = JSON.stringify( { projectPrefix } )
        await writeFile( filePath, `${payload}\n` )

        return { written: true }
    }


    static async #exists( { filePath } ) {
        try {
            await access( filePath )

            return { exists: true }
        } catch( error ) {
            const { code } = error

            return { exists: false, code }
        }
    }


    static async #readFile( { filePath } ) {
        try {
            const content = await readFile( filePath, 'utf8' )

            return { found: true, content }
        } catch( error ) {
            const { code } = error

            return { found: false, code }
        }
    }


    static #parse( { content } ) {
        try {
            const data = JSON.parse( content )
            const value = ( data === null || typeof data !== 'object' ) ? null : data.projectPrefix
            const projectPrefix = ( typeof value === 'string' ) ? value : null

            return { projectPrefix }
        } catch( error ) {
            return { projectPrefix: null }
        }
    }
}


export { MemoConfig }
