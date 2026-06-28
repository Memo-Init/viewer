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
const B_ID = /^B\d{3}$/

// PRD-003 (Memo 054 Kap 6) body sections: four canonical Markdown headings a Block carries below
// its fence, aligned with the spec-primitive / core MemoBlock. Mapped to flat fields so the
// downstream PRD derivation (Kap 8) can read them machine-readably without re-parsing prose.
// `aliases` provides legacy heading names that still match (additive, no hard break for old memos):
//   factualAccount: canonical "### Faktenlage", alias "### Problem-Beschreibung" (pre-054 memos).
const BODY_SECTIONS = [
    { field: 'factualAccount', heading: 'Faktenlage', aliases: [ 'Problem-Beschreibung' ] },
    { field: 'assessment', heading: 'Bewertung', aliases: [] },
    { field: 'solution', heading: 'Loesungsansatz', aliases: [] },
    { field: 'openQuestions', heading: 'Offene Fragen', aliases: [] }
]


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
            const fenceEnd = offset + match[ 0 ].length
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
            const body = BlockMeta.#bodySections( { doc, fenceEnd } )

            return BlockMeta.#classify( { value, chapter, body } )
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

    static #classify( { value, chapter, body } ) {
        const hasChildMarker = typeof value.topic === 'string' && value.topic.length > 0
        const role = hasChildMarker ? 'child' : 'parent'

        // PRD-008: id (B-id) and tags are additive block-meta fields; the four body sections are
        // merged in as flat fields. A "strand" key is deliberately NOT read — the strand is emergent
        // (PRD-009), so a fence carrying strand:"x" produces NO strand field on the parsed block.
        // PRD-003 (Memo 054 Kap 6): `problem` renamed to `factualAccount`; `assessment` added as
        // the second section. Old "### Problem-Beschreibung" headings are accepted as alias.
        return {
            ok: true,
            chapter,
            role,
            id: typeof value.id === 'string' ? value.id : null,
            topic: typeof value.topic === 'string' ? value.topic : null,
            topics: BlockMeta.#stringArray( { value: value.topics } ),
            repos: BlockMeta.#stringArray( { value: value.repos } ),
            tags: BlockMeta.#stringArray( { value: value.tags } ),
            prds: BlockMeta.#stringArray( { value: value.prds } ),
            requirements: BlockMeta.#stringArray( { value: value.requirements } ),
            requirementsPlus: BlockMeta.#stringArray( { value: value[ 'requirements+' ] } ),
            factualAccount: body.factualAccount,
            assessment: body.assessment,
            solution: body.solution,
            openQuestions: body.openQuestions,
            hasIdKey: Object.prototype.hasOwnProperty.call( value, 'id' ),
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
        // PRD-008: a block id, when present, must be a B-id (B001). Absent id stays valid (additive).
        const badBlockId = ( typeof block.id === 'string' && B_ID.test( block.id ) === false )
            ? [ block.id ]
            : []

        return []
            .concat( badTopics.map( ( id ) => `topic id "${ id }" is not a T-id (expected T001)` ) )
            .concat( badTopic.map( ( id ) => `topic id "${ id }" is not a T-id (expected T001)` ) )
            .concat( badPrds.map( ( id ) => `prd id "${ id }" is not a PRD-id (expected PRD-001)` ) )
            .concat( badBlockId.map( ( id ) => `block id "${ id }" is not a B-id (expected B001)` ) )
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


    // PRD-003 (Memo 054 Kap 6): extract the four canonical body sections that follow a block-meta
    // fence: ### Faktenlage (factualAccount), ### Bewertung (assessment), ### Loesungsansatz
    // (solution), ### Offene Fragen (openQuestions). Legacy "### Problem-Beschreibung" is accepted
    // as an alias for factualAccount so pre-054 memos keep working without any hard break.
    // The body region runs from the fence end to the next chapter ("## ") or the next block-meta
    // fence, whichever comes first — sections are scoped to THIS block only. A missing section
    // yields null (no silent default). Non-throwing.
    static #bodySections( { doc, fenceEnd } ) {
        const after = doc.slice( fenceEnd )
        const nextChapter = after.search( /^##\s+/m )
        const nextFence = after.search( /```block-meta/ )
        const bounds = [ nextChapter, nextFence ].filter( ( index ) => index >= 0 )
        const limit = bounds.length === 0 ? after.length : Math.min( ...bounds )
        const region = after.slice( 0, limit )

        const lines = region.split( '\n' )
        const headingIndexes = lines
            .map( ( line, index ) => ( { line, index } ) )
            .filter( ( entry ) => /^###\s+/.test( entry.line ) )

        const sectionFor = ( section ) => {
            const headings = [ section.heading ].concat( section.aliases || [] )
            const start = headingIndexes.find( ( entry ) => {
                const text = entry.line.replace( /^###\s+/, '' ).trim()

                return headings.includes( text )
            } )

            if( start === undefined ) {
                return null
            }

            const next = headingIndexes.find( ( entry ) => entry.index > start.index )
            const end = next === undefined ? lines.length : next.index
            const text = lines.slice( start.index + 1, end ).join( '\n' ).trim()

            return text.length === 0 ? null : text
        }

        return BODY_SECTIONS.reduce( ( acc, section ) => {
            acc[ section.field ] = sectionFor( section )

            return acc
        }, {} )
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
