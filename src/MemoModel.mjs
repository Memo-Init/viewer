// MemoModel.mjs — typed, server-side memo model (Memo 016 Kap, PRD-008, F5).
//
// F5 root cause: prose structure was a fragile post-hoc DOM-rewrite pipeline (regex on rendered
// HTML in MemoView.applyContentStructure). The fix is a thin first slice — parse the memo markdown
// ONCE, server-side, into a typed model so rendering can become deterministic FROM DATA instead of
// being re-derived from the DOM. This module is that parser. It does NOT yet rewire the render
// pipeline (that is a follow-up PRD); it only provides the typed model and proves it extracts
// correctly from a real memo.
//
// Design rules (PRD-008):
// - PURE: no DOM, no I/O, deterministic. Input markdown string -> output object. Unit-testable in
//   Node without a browser.
// - REUSE over re-implement: the question + vorwort extraction already exists as pure static
//   methods on DocumentRegistry (parseVorwort, parseQuestionSchema), and the block-meta fences
//   already have a parser (BlockMeta.parse). Those are imported and delegated to — NOT re-coded.
//   Only a SMALL slug helper is re-implemented here (importing MemoView is heavy) and it mirrors
//   MemoView.slugify 1:1 (documented rule: lowercase, ae/oe/ue/ss umlaut mapping, any run of
//   non-[a-z0-9] collapses to a single "-" separator, trim leading/trailing "-").
//
// House style: static methods, object params/returns, no loops, no silent defaults.

import { BlockMeta } from './BlockMeta.mjs'
import { DocumentRegistry } from './DocumentRegistry.mjs'


// A requirement id is either an explicit REQ-NNN reference or a block-meta "req-*" id. Both forms
// are deduped into a single, order-stable list. The patterns are intentionally narrow so prose
// words ("required", "request") never match.
const REQ_ID = /\bREQ-\d+\b/g
const REQ_SLUG = /\breq-[a-z0-9][a-z0-9-]*\b/g

// A heading line: capture the level (# count) and the raw title text. Only H2+ are modelled as
// document sections (the H1 is the memo title, not a section).
const HEADING = /^(#{1,6})\s+(.+?)\s*$/

// A topic id of the canonical T-id shape (T012). Topics may also arrive via block-meta.
const T_ID = /\bT\d{3}\b/g


class MemoModel {
    // Parse a memo markdown string ONCE into a typed model. Never throws — a non-string or empty
    // input yields a fully-shaped empty model so callers can read every field unconditionally.
    static parse( { markdown } ) {
        if( typeof markdown !== 'string' || markdown.length === 0 ) {
            return MemoModel.#emptyModel()
        }

        const { vorwort } = DocumentRegistry.parseVorwort( { content: markdown } )
        const sections = MemoModel.#parseSections( { markdown } )
        const questions = MemoModel.#parseQuestions( { markdown } )
        const { blocks } = BlockMeta.parse( { doc: markdown } )
        const topics = MemoModel.#parseTopics( { markdown, blocks } )
        const requirements = MemoModel.#parseRequirements( { markdown, blocks } )

        return { vorwort, sections, questions, topics, blocks, requirements }
    }


    // The slug rule, mirrored 1:1 from MemoView.slugify / the inline browser slugify (PRD-007). It
    // is re-implemented here (rather than importing MemoView) because MemoView is a heavy module;
    // the rule itself is small and documented. Returns { slug }.
    static slugify( { text } ) {
        const slug = String( text == null ? '' : text )
            .toLowerCase()
            .replace( /ä/g, 'ae' )
            .replace( /ö/g, 'oe' )
            .replace( /ü/g, 'ue' )
            .replace( /ß/g, 'ss' )
            .replace( /[^a-z0-9]+/g, '-' )
            .replace( /^-+|-+$/g, '' )

        return { slug }
    }


    // ---- private ----

    static #emptyModel() {
        return { vorwort: '', sections: [], questions: [], topics: [], blocks: [], requirements: [] }
    }


    // Walk the document line-by-line, capturing every H2+ heading as a section. The body of a
    // section runs from just after its heading line up to (but not including) the next heading of
    // ANY level. Fenced code blocks are skipped so a "## " inside a ``` fence never registers as a
    // heading. Each section carries { level, title, slug, body }; the slug uses the shared rule and
    // is de-duplicated with a numeric suffix exactly as the renderer does (slug, slug-1, ...).
    static #parseSections( { markdown } ) {
        const lines = markdown.split( '\n' )

        const headingIndexes = lines
            .map( ( line, index ) => ( { line, index } ) )
            .filter( ( entry ) => MemoModel.#isHeadingLine( { lines, index: entry.index } ) )
            .map( ( entry ) => {
                const match = entry.line.match( HEADING )

                return { index: entry.index, level: match[ 1 ].length, title: match[ 2 ].trim() }
            } )
            .filter( ( entry ) => entry.level >= 2 )

        const slugCounts = new Map()

        return headingIndexes.map( ( entry, position ) => {
            const next = headingIndexes[ position + 1 ]
            const end = next === undefined ? lines.length : next.index
            const body = lines
                .slice( entry.index + 1, end )
                .join( '\n' )
                .trim()

            const { slug: baseSlug } = MemoModel.slugify( { text: entry.title } )
            const seen = slugCounts.get( baseSlug ) || 0
            slugCounts.set( baseSlug, seen + 1 )
            const slug = seen === 0 ? baseSlug : `${ baseSlug }-${ seen }`

            return { level: entry.level, title: entry.title, slug, body }
        } )
    }


    // A line is a heading only when it matches the heading pattern AND is not inside a ``` fenced
    // code block. The fence state is recomputed from the document prefix so the check stays pure
    // (no shared mutable cursor). Counting the ``` fences before `index`: an odd count means the
    // line sits inside an open fence.
    static #isHeadingLine( { lines, index } ) {
        const line = lines[ index ]
        if( HEADING.test( line ) === false ) {
            return false
        }

        const fencesBefore = lines
            .slice( 0, index )
            .filter( ( candidate ) => /^\s*```/.test( candidate ) )
            .length

        return fencesBefore % 2 === 0
    }


    // Questions: delegate to the existing DocumentRegistry.parseQuestionSchema (the canonical
    // `### F{N}` parser, covering both "Offene Fragen" and "Beantwortete Fragen") and project it
    // down to the thin typed shape PRD-008 asks for: { id, text, answered }. The richer parser
    // output (options/typ/preselected/...) is intentionally NOT carried here — this model keeps the
    // question slice simple and robust; a consumer that needs the full schema still calls the
    // registry directly.
    static #parseQuestions( { markdown } ) {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: markdown } )

        return questions
            .filter( ( question ) => typeof question.id === 'string' && question.id.length > 0 )
            .map( ( question ) => {
                const text = typeof question.frage === 'string' && question.frage.length > 0
                    ? question.frage
                    : ( typeof question.title === 'string' ? question.title : '' )

                // Memo 038 Kap 6/7 (P1c): keep { id, text, answered } intact for back-compat and
                // additively project the answer-provenance fields when present. `answeredBy` always
                // exists on a parsed question (defaults to 'user'); the decision pair is only carried
                // when the answered entry actually wrote it — so legacy memos keep the thin shape.
                const projected = { id: question.id, text, answered: question.answered === true }

                const answeredBy = question.answeredBy === 'ai-on-behalf' ? 'ai-on-behalf' : 'user'
                projected.answeredBy = answeredBy

                if( typeof question.userDecision === 'string' && question.userDecision.length > 0 ) {
                    projected.userDecision = question.userDecision
                }

                if( typeof question.aiRecommendationWas === 'string' && question.aiRecommendationWas.length > 0 ) {
                    projected.aiRecommendationWas = question.aiRecommendationWas
                }

                return projected
            } )
    }


    // Topics: gathered from two sources, deduped, order-stable. (1) block-meta topics — every
    // parsed block contributes its singular `topic` (child) and plural `topics` (parent). (2) prose
    // T-ids — any canonical T-id (T012) mentioned in a "## Topics" / "### Topic" style block. When
    // neither source yields anything the list is [] (the common case for finalized memos).
    static #parseTopics( { markdown, blocks } ) {
        const fromBlocks = blocks
            .flatMap( ( block ) => {
                const singular = typeof block.topic === 'string' && block.topic.length > 0 ? [ block.topic ] : []

                return [].concat( singular ).concat( block.topics )
            } )

        const fromProse = MemoModel.#topicSectionText( { markdown } )
            .match( T_ID ) || []

        return [ ...new Set( [].concat( fromBlocks ).concat( fromProse ) ) ]
    }


    // Isolate the text of a topics-bearing region so prose T-ids are only harvested where topics
    // are actually declared (not from every chapter that happens to mention a T-id). Matches a
    // "## Topics" H2 section or any "### Topic" H3 heading region. Returns '' when none exists.
    static #topicSectionText( { markdown } ) {
        const lines = markdown.split( '\n' )

        const regionFor = ( startIndex, headingLevel ) => {
            const rest = lines.slice( startIndex + 1 )
            const stopPattern = headingLevel === 2 ? /^##\s/ : /^#{1,3}\s/
            const endOffset = rest.findIndex( ( line ) => stopPattern.test( line ) )
            const regionLines = endOffset === -1 ? rest : rest.slice( 0, endOffset )

            return regionLines.join( '\n' )
        }

        const h2Index = lines.findIndex( ( line ) => /^##\s+Topics?\s*$/i.test( line ) )
        const h2Text = h2Index === -1 ? '' : regionFor( h2Index, 2 )

        const h3Texts = lines
            .map( ( line, index ) => ( { line, index } ) )
            .filter( ( entry ) => /^###\s+Topics?\b/i.test( entry.line ) )
            .map( ( entry ) => `${ entry.line }\n${ regionFor( entry.index, 3 ) }` )

        return [].concat( h2Text ).concat( h3Texts ).join( '\n' )
    }


    // Requirement ids referenced anywhere in the document, deduped and order-stable. Two forms:
    // explicit REQ-NNN references in prose, and block-meta `req-*` slugs (which also appear on
    // parsed blocks as requirements / requirementsPlus). Both the raw markdown scan and the parsed
    // blocks are unioned so a req declared only inside a block-meta JSON fence is still captured.
    static #parseRequirements( { markdown, blocks } ) {
        const reqIds = markdown.match( REQ_ID ) || []
        const reqSlugs = markdown.match( REQ_SLUG ) || []
        const fromBlocks = blocks
            .flatMap( ( block ) => [].concat( block.requirements ).concat( block.requirementsPlus ) )

        return [ ...new Set( [].concat( reqIds ).concat( reqSlugs ).concat( fromBlocks ) ) ]
    }
}


export { MemoModel }
