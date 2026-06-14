// PRD-001 (Memo 011 Kap 10) — `memo init` CLI core. Removes the manual folder/number bookkeeping
// (friction root F11): scan the highest existing memo number in .memo/, assign the next zero-padded
// 3-digit number, derive the slug, and lay down .memo/memos/{XXX}-{slug}/revisions/REV-01.md from the
// shared template (templates/REV.md.template, PRD-002). NO-OVERWRITE is a hard rule
// (~/.claude/CLAUDE.md § .env / Memo 032): an existing target folder or REV-01.md is never clobbered.
//
// PRD-002 (Memo 013 Kap 9) — dual-scan migration awareness. Memos moved from the legacy flat layout
// (.memo/NNN-slug) into the co-located layout (.memo/memos/NNN-slug). scanHighestNumber now scans BOTH
// layouts (the maximum number across <root>/memos AND <root>) so a fresh memo gets the next free number
// across the migration boundary; createMemoStructure WRITES into <root>/memos (never the flat root).
//
// No for/while loops anywhere — array methods only (map/filter/reduce).

import { readdir, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'


// The co-located write target / scan layer. Mirrors memo-locator.mjs SEARCH_LAYOUTS (new layout
// first, flat root as legacy fallback) — the single source of truth for the `memos/` knowledge.
const MEMOS_SUBDIR = 'memos'


class MemoInit {
    // Scan { memoDir } DUAL-LAYOUT for sub-folders matching `^(\d{3})-` and return { highest } (the
    // largest 3-digit prefix across <memoDir>/memos AND <memoDir>, or 0). A missing directory on
    // either side is graceful (#readEntries -> []). Non-numeric folders are ignored (no crash).
    // The maximum over both layouts is the next-free anchor across the migration boundary (PRD-002).
    static async scanHighestNumber( { memoDir } ) {
        const candidates = [ join( memoDir, MEMOS_SUBDIR ), memoDir ]

        const reads = await Promise.all(
            candidates.map( ( dir ) => MemoInit.#readEntries( { memoDir: dir } ) )
        )

        const numbers = reads
            .flatMap( ( read ) => read.entries )
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


    // Full init: dual-scan -> next number -> slug -> mkdir -p memos/<folder>/revisions/ -> copy
    // template with placeholders filled. The WRITE TARGET is the co-located layer (<memoDir>/memos),
    // never the flat root — this fixes the Memo 013 Kap 9 root-pollution bug. NO-OVERWRITE: aborts
    // (throws) if the target folder OR REV-01.md exists. `date` is injected (default 'TBD') so this
    // stays a pure, testable function — never Date.now() inside the logic.
    // Returns { number, slug, path, revPath } with path/revPath now under memos/.
    //
    // Andock-Punkt (Kap 4): Topic-Anlage + Tag-Auto-Attach hooks here — NOT built in this PRD.
    // Andock-Punkt (Kap 9): the SQL-Gate as a second CLI function docks here — NOT built in this PRD.
    static async createMemoStructure( { memoDir, topic, templatePath, date = 'TBD' } ) {
        const { highest } = await MemoInit.scanHighestNumber( { memoDir } )
        const { number } = MemoInit.nextNumber( { highest } )
        const { slug } = MemoInit.slugFromTopic( { topic } )

        const folderName = `${ number }-${ slug }`
        const path = join( memoDir, MEMOS_SUBDIR, folderName )
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
