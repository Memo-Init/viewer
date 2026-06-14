// BlockMeta.mjs — machine-parseable Block overlay (Memo 012, Kap 7).
//
// F2 = Overlay: existing memo chapters stay prose; a Block adds a SEPARATE machine-readable
// "block-meta" fenced code block carrying the structured links the system needs:
//
//   ```block-meta
//   { "topics": ["T012"], "repos": ["repos/core"], "prds": ["PRD-001"] }
//   ```
//
// This is what lets `memo lint` and `memo topic` check Topic <-> PRD programmatically without
// re-parsing prose. The parser is deliberate about being non-throwing and additive: a memo with
// NO block-meta block parses to an empty list (no false positives on legacy/finalized memos).
//
// House style: static methods, object params/returns, no loops, no silent defaults.

const FENCE = /```block-meta\s*\n([\s\S]*?)\n```/g
const T_ID = /^T\d{3}$/
const PRD_ID = /^PRD-\d{3}$/


class BlockMeta {
    // Parse every block-meta fence in the document, associating each with the nearest
    // preceding "## " chapter heading. Returns { blocks:[...], errors:[...] }. Never throws.
    static parse( { doc } ) {
        if( typeof doc !== 'string' || doc.length === 0 ) {
            return { blocks: [], errors: [] }
        }

        const matches = [ ...doc.matchAll( FENCE ) ]
        const parsed = matches.map( ( match ) => {
            const raw = match[ 1 ]
            const offset = match.index
            const chapter = BlockMeta.#chapterBefore( { doc, offset } )

            const json = ( () => {
                try {
                    return { ok: true, value: JSON.parse( raw ) }
                } catch( error ) {
                    return { ok: false, reason: error.message }
                }
            } )()

            if( json.ok !== true ) {
                return { ok: false, chapter, reason: `invalid JSON: ${ json.reason }` }
            }

            const value = json.value !== null && typeof json.value === 'object' ? json.value : {}

            return {
                ok: true,
                chapter,
                topics: BlockMeta.#stringArray( { value: value.topics } ),
                repos: BlockMeta.#stringArray( { value: value.repos } ),
                prds: BlockMeta.#stringArray( { value: value.prds } )
            }
        } )

        const blocks = parsed.filter( ( entry ) => entry.ok === true )
        const errors = parsed.filter( ( entry ) => entry.ok !== true )

        return { blocks, errors }
    }


    // Structural validation of one parsed (JSON-valid) block: id-shape of topics (T001) and
    // prds (PRD-001). Returns { messages:[] } — empty when the block is well-formed.
    static validateShape( { block } ) {
        const badTopics = block.topics.filter( ( id ) => T_ID.test( id ) === false )
        const badPrds = block.prds.filter( ( id ) => PRD_ID.test( id ) === false )

        const messages = []
            .concat( badTopics.map( ( id ) => `topic id "${ id }" is not a T-id (expected T001)` ) )
            .concat( badPrds.map( ( id ) => `prd id "${ id }" is not a PRD-id (expected PRD-001)` ) )

        return { messages }
    }


    // ---- private ----

    static #stringArray( { value } ) {
        return Array.isArray( value ) ? value.filter( ( item ) => typeof item === 'string' ) : []
    }


    static #chapterBefore( { doc, offset } ) {
        const before = doc.slice( 0, offset )
        const headings = [ ...before.matchAll( /^##\s+(.+)$/gm ) ]
        if( headings.length === 0 ) {
            return null
        }

        return headings[ headings.length - 1 ][ 1 ].trim()
    }
}


export { BlockMeta }
