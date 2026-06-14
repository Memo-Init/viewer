// PRD-001 (Memo 011 Kap 10) — `memo init` CLI core. Removes the manual folder/number bookkeeping
// (friction root F11): scan the highest existing memo number in .memo/, assign the next zero-padded
// 3-digit number, derive the slug, and lay down .memo/{XXX}-{slug}/revisions/REV-01.md from the
// shared template (templates/REV.md.template, PRD-002). NO-OVERWRITE is a hard rule
// (~/.claude/CLAUDE.md § .env / Memo 032): an existing target folder or REV-01.md is never clobbered.
//
// No for/while loops anywhere — array methods only (map/filter/reduce).

import { readdir, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'


class MemoInit {
    // Scan { memoDir } for sub-folders matching `^(\d{3})-` and return { highest } (the largest
    // 3-digit prefix found, or 0). A missing .memo/ directory is graceful: { highest: 0 } — the
    // numbering then starts at 001 (Spec Z.136). Non-numeric folders are ignored (no crash).
    static async scanHighestNumber( { memoDir } ) {
        const { entries } = await MemoInit.#readEntries( { memoDir } )

        const numbers = entries
            .map( ( name ) => {
                const matched = name.match( /^(\d{3})-/ )

                return matched !== null ? Number.parseInt( matched[ 1 ], 10 ) : null
            } )
            .filter( ( value ) => value !== null )

        const highest = numbers
            .reduce( ( max, value ) => ( value > max ? value : max ), 0 )

        return { highest }
    }


    // Given { highest }, return { number } = String( highest + 1 ).padStart( 3, '0' ).
    static nextNumber( { highest } ) {
        const number = String( highest + 1 ).padStart( 3, '0' )

        return { number }
    }


    // Derive a slug from { topic }: lowercase, non-alphanumeric runs collapsed to single hyphens,
    // trimmed, max 40 chars (Spec Z.118-121).
    static slugFromTopic( { topic } ) {
        const lower = String( topic ).toLowerCase()
        const hyphenated = lower
            .replace( /[^a-z0-9]+/g, '-' )
            .replace( /^-+|-+$/g, '' )
        const slug = hyphenated.slice( 0, 40 ).replace( /-+$/g, '' )

        return { slug }
    }


    // Full init: scan -> next number -> slug -> mkdir -p revisions/ -> copy template with
    // placeholders filled. NO-OVERWRITE: aborts (throws) if the target folder OR REV-01.md exists.
    // `date` is injected (default 'TBD') so this stays a pure, testable function — never Date.now()
    // inside the logic. Returns { number, slug, path, revPath }.
    //
    // Andock-Punkt (Kap 4): Topic-Anlage + Tag-Auto-Attach hooks here — NOT built in this PRD.
    // Andock-Punkt (Kap 9): the SQL-Gate as a second CLI function docks here — NOT built in this PRD.
    static async createMemoStructure( { memoDir, topic, templatePath, date = 'TBD' } ) {
        const { highest } = await MemoInit.scanHighestNumber( { memoDir } )
        const { number } = MemoInit.nextNumber( { highest } )
        const { slug } = MemoInit.slugFromTopic( { topic } )

        const folderName = `${ number }-${ slug }`
        const path = join( memoDir, folderName )
        const revisionsDir = join( path, 'revisions' )
        const revPath = join( revisionsDir, 'REV-01.md' )

        const folderExists = await MemoInit.#exists( { filePath: path } )

        if( folderExists === true ) {
            throw new Error( `NO-OVERWRITE: memo folder already exists: ${ folderName }` )
        }

        await mkdir( revisionsDir, { recursive: true } )

        const revExists = await MemoInit.#exists( { filePath: revPath } )

        if( revExists === true ) {
            throw new Error( `NO-OVERWRITE: REV-01.md already exists: ${ revPath }` )
        }

        const template = await readFile( templatePath, 'utf8' )
        const { content } = MemoInit.#fillTemplate( { template, number, slug, topic, date } )

        await writeFile( revPath, content )

        return { number, slug, path, revPath }
    }


    // Replace the header placeholders in the template with the resolved values. The remaining
    // structural placeholders (chapters, questions) stay untouched — the AI fills those later.
    static #fillTemplate( { template, number, slug, topic, date } ) {
        const content = template
            .replaceAll( '{XXX}', number )
            .replaceAll( '{slug}', slug )
            .replaceAll( '{TOPIC}', String( topic ) )
            .replaceAll( '{YYYY-MM-DD HH:MM}', date )

        return { content }
    }


    static async #readEntries( { memoDir } ) {
        try {
            const entries = await readdir( memoDir )

            return { entries }
        } catch( error ) {
            const { code } = error

            return { entries: [], code }
        }
    }


    static async #exists( { filePath } ) {
        try {
            await access( filePath )

            return true
        } catch( error ) {
            return false
        }
    }
}


export { MemoInit }
