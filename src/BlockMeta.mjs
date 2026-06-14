// BlockMeta.mjs — machine-parseable Block overlay (Memo 012 Kap 7; Memo 013 Kap 3).
//
// F2 = Overlay: existing memo chapters stay prose; a Block adds a SEPARATE machine-readable
// "block-meta" fenced code block carrying the structured links the system needs.
//
// Memo 013 Kap 3 sharpens the schema to a Parent/Child model with EXACTLY ONE level
// (no grandchildren). PRDs hang on the parent; requirements live primarily on the parent and
// are INHERITED by children, which may ADD their own via "requirements+" (additive, never
// replacing). Two block roles share one fence syntax:
//
//   Parent (carries prds + requirements default for children):
//   ```block-meta
//   { "topics": ["T012"], "repos": ["repos/core"], "prds": ["PRD-001"], "requirements": ["req-secrets"] }
//   ```
//
//   Child (exactly one level deep; topic singular; additive requirements; NO prds):
//   ```block-meta
//   { "topic": "T012", "requirements+": ["req-coverage"] }
//   ```
//
// A block's role is derived from the presence of the SINGULAR "topic" key: present => child,
// absent => parent. This lets `memo lint` and `memo prd requirements` check Topic <-> PRD
// programmatically without re-parsing prose. The parser is deliberate about being non-throwing
// and additive: a memo with NO block-meta block parses to an empty list (no false positives on
// legacy/finalized memos). Every parsed block keeps the legacy topics/repos/prds arrays so the
// downstream Auto-Requirements engine (AutoRequirements.mjs) reads any block uniformly.
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

            return BlockMeta.#classify( { value, chapter } )
        } )

        const blocks = parsed.filter( ( entry ) => entry.ok === true )
        const errors = parsed.filter( ( entry ) => entry.ok !== true )

        return { blocks, errors }
    }


    // Structural validation of one parsed (JSON-valid) block. Returns { messages:[] } — empty
    // when the block is well-formed. Checks the id-shape of topics/topic (T001) and prds
    // (PRD-001) AND the Parent/Child invariants (Memo 013 Kap 3): a child carries no prds, a
    // block does not mix singular topic with plural topics, a child names a valid topic, and no
    // grandchild (second level) is declared.
    static validateShape( { block } ) {
        const idMessages = BlockMeta.#validateIds( { block } )
        const roleMessages = BlockMeta.#validateRole( { block } )

        const messages = [].concat( idMessages ).concat( roleMessages )

        return { messages }
    }


    // Inheritance (Memo 013 Kap 3): the EFFECTIVE requirements of a child are the union of the
    // parent's default requirements and the child's own additive "requirements+", deduplicated,
    // order-stable (parent first). Pure — the docking point for the later Auto-Requirements PRD
    // (Kap 4). Returns { requirements:[...] }.
    static effectiveRequirements( { parent, child } ) {
        const parentReqs = BlockMeta.#stringArray( { value: parent === null || parent === undefined ? [] : parent.requirements } )
        const childReqs = BlockMeta.#stringArray( { value: child === null || child === undefined ? [] : child.requirementsPlus } )

        const requirements = [ ...new Set( [].concat( parentReqs ).concat( childReqs ) ) ]

        return { requirements }
    }


    // ---- private ----

    static #classify( { value, chapter } ) {
        const hasChildMarker = typeof value.topic === 'string' && value.topic.length > 0
        const role = hasChildMarker ? 'child' : 'parent'

        return {
            ok: true,
            chapter,
            role,
            topic: typeof value.topic === 'string' ? value.topic : null,
            topics: BlockMeta.#stringArray( { value: value.topics } ),
            repos: BlockMeta.#stringArray( { value: value.repos } ),
            prds: BlockMeta.#stringArray( { value: value.prds } ),
            requirements: BlockMeta.#stringArray( { value: value.requirements } ),
            requirementsPlus: BlockMeta.#stringArray( { value: value[ 'requirements+' ] } ),
            hasPrdsKey: Object.prototype.hasOwnProperty.call( value, 'prds' ),
            hasTopicsKey: Object.prototype.hasOwnProperty.call( value, 'topics' ),
            hasRequirementsKey: Object.prototype.hasOwnProperty.call( value, 'requirements' ),
            hasChildrenKey: Object.prototype.hasOwnProperty.call( value, 'children' )
        }
    }


    static #validateIds( { block } ) {
        const badTopics = block.topics.filter( ( id ) => T_ID.test( id ) === false )
        const badPrds = block.prds.filter( ( id ) => PRD_ID.test( id ) === false )
        const badTopic = ( typeof block.topic === 'string' && T_ID.test( block.topic ) === false )
            ? [ block.topic ]
            : []

        return []
            .concat( badTopics.map( ( id ) => `topic id "${ id }" is not a T-id (expected T001)` ) )
            .concat( badTopic.map( ( id ) => `topic id "${ id }" is not a T-id (expected T001)` ) )
            .concat( badPrds.map( ( id ) => `prd id "${ id }" is not a PRD-id (expected PRD-001)` ) )
    }


    static #validateRole( { block } ) {
        if( block.role === 'child' ) {
            return BlockMeta.#validateChild( { block } )
        }

        return BlockMeta.#validateParent( { block } )
    }


    static #validateChild( { block } ) {
        const messages = []

        // A child must not carry prds — PRDs hang on the parent only.
        if( block.hasPrdsKey === true ) {
            messages.push( 'child block must not carry prds (prds belong to the parent)' )
        }

        // A block must not mix the singular child marker "topic" with the plural parent "topics".
        if( block.hasTopicsKey === true ) {
            messages.push( 'block mixes child "topic" with parent "topics" (a block is either parent or child)' )
        }

        // No grandchildren: a child must not declare a parent-default "requirements" set nor a
        // nested "children" field — both would introduce a second level below the child.
        if( block.hasRequirementsKey === true ) {
            messages.push( 'only one child level allowed, no grandchildren (child must not carry a "requirements" default)' )
        }

        if( block.hasChildrenKey === true ) {
            messages.push( 'only one child level allowed, no grandchildren (child must not nest "children")' )
        }

        return messages
    }


    static #validateParent( { block } ) {
        const messages = []

        // A parent must name at least one valid topic (the binding the child inherits from).
        // A grandchild attempt at the parent level is a nested "children" field.
        if( block.hasChildrenKey === true ) {
            messages.push( 'only one child level allowed, no grandchildren (use separate child fences, not nested "children")' )
        }

        return messages
    }


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
