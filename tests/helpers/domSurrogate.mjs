// A DOM surrogate rich enough for the passes that MOVE nodes — Memo 081, WI-113.
//
// There is no jsdom in this project (M11), so browser passes are driven against a shim. The shim that
// existed until now (BlockSectionsParityPRDB1) carried tagName, textContent, classList and a
// nextElementSibling chain, which is everything a pass needs that only SETS A CLASS. The fold pass
// re-parents nodes into a <details>, so it needs parentNode, insertBefore, appendChild, closest and
// querySelectorAll as well.
//
// IT LIVES HERE RATHER THAN IN BOTH SUITES BECAUSE TWO COPIES OF A SHIM ARE TWO SHIMS. The fold pass is
// exercised from ChapterSectionsPRD43 and from BlockSectionsParityPRDB1; a surrogate typed twice would
// let one of them drift into testing a DOM the other does not have — the parallel-path defect this
// project rejects elsewhere. `extractFunction.mjs` beside it is the precedent for a shared test helper.
//
// It is a SURROGATE, not a browser: it implements the surface the passes under test actually touch and
// nothing more. Where a real DOM would be richer, the shim stays narrow on purpose, so a pass that
// starts relying on something else fails loudly here instead of passing against a fiction.


// One selector part: `.class` or a tag name. Anything else matches nothing rather than everything —
// a matcher that silently accepts an unsupported selector would make querySelectorAll return the whole
// tree and every count in every caller would be wrong in the same direction.
// The digit in the tag pattern is not cosmetic: `h2`/`h3` are the tags the table of contents and the
// section walk are selected by, and a letters-only pattern silently matched NONE of them — measured
// here on the first run, where a heading inside a fold frame reported as absent.
function matchesPart( node, part ) {
    if( part.startsWith( '.' ) ) { return node.classList.contains( part.slice( 1 ) ) }
    if( /^[a-zA-Z][a-zA-Z0-9]*$/.test( part ) ) { return node.tagName === part.toUpperCase() }

    return false
}


function descendants( node ) {
    return node.children.flatMap( ( child ) => [ child ].concat( descendants( child ) ) )
}


function hasAncestorMatching( node, part ) {
    if( node.parentNode === null ) { return false }
    if( matchesPart( node.parentNode, part ) ) { return true }

    return hasAncestorMatching( node.parentNode, part )
}


// `a b` (descendant) and `a, b` (alternatives) are the two selector forms the passes use.
function matchesSelector( node, selector ) {
    return selector
        .split( ',' )
        .map( ( alternative ) => alternative.trim().split( /\s+/ ).filter( ( part ) => part.length > 0 ) )
        .filter( ( parts ) => parts.length > 0 )
        .some( ( parts ) => {
            const last = parts[ parts.length - 1 ]
            if( !matchesPart( node, last ) ) { return false }

            return parts.slice( 0, -1 ).every( ( part ) => hasAncestorMatching( node, part ) )
        } )
}


function detach( node ) {
    if( node.parentNode === null ) { return }
    const siblings = node.parentNode.children
    const at = siblings.indexOf( node )
    if( at >= 0 ) { siblings.splice( at, 1 ) }
    node.parentNode = null
}


export function makeNode( tag, text, classes ) {
    const node = {
        tagName: String( tag ).toUpperCase(),
        parentNode: null,
        children: [],
        _text: text === undefined ? '' : text,
        _classes: new Set( classes === undefined ? [] : classes )
    }

    node.classList = {
        add: ( ...names ) => names.forEach( ( name ) => node._classes.add( name ) ),
        remove: ( ...names ) => names.forEach( ( name ) => node._classes.delete( name ) ),
        contains: ( name ) => node._classes.has( name )
    }

    // A live sibling link, not a frozen one: the fold pass re-parents nodes, so a chain captured once
    // would keep answering with the layout the document had BEFORE the move.
    Object.defineProperty( node, 'nextElementSibling', {
        get: () => {
            if( node.parentNode === null ) { return null }
            const at = node.parentNode.children.indexOf( node )

            return ( at >= 0 && at + 1 < node.parentNode.children.length ) ? node.parentNode.children[ at + 1 ] : null
        }
    } )

    Object.defineProperty( node, 'previousElementSibling', {
        get: () => {
            if( node.parentNode === null ) { return null }
            const at = node.parentNode.children.indexOf( node )

            return at > 0 ? node.parentNode.children[ at - 1 ] : null
        }
    } )

    Object.defineProperty( node, 'className', {
        get: () => [ ...node._classes ].join( ' ' ),
        set: ( value ) => { node._classes = new Set( String( value ).split( /\s+/ ).filter( ( name ) => name.length > 0 ) ) }
    } )

    // Concatenated like the real thing, so a table row reads as its cells and a section reads as its
    // whole body — which is what the evidence-tag distribution counts over.
    Object.defineProperty( node, 'textContent', {
        get: () => node._text + node.children.map( ( child ) => child.textContent ).join( '' ),
        set: ( value ) => { node._text = String( value ); node.children = [] }
    } )

    // wrapTablesCollapsible opens its <details> with setAttribute( 'open', '' ) rather than a property,
    // so the surrogate has to carry attributes to tell an open frame from a closed one at all.
    node._attributes = {}
    node.setAttribute = ( name, value ) => { node._attributes[ name ] = String( value ) }
    node.getAttribute = ( name ) => ( Object.hasOwn( node._attributes, name ) ? node._attributes[ name ] : null )
    node.hasAttribute = ( name ) => Object.hasOwn( node._attributes, name )

    node.querySelectorAll = ( selector ) => descendants( node ).filter( ( child ) => matchesSelector( child, selector ) )
    node.querySelector = ( selector ) => {
        const [ first ] = node.querySelectorAll( selector )

        return first === undefined ? null : first
    }

    node.closest = ( selector ) => {
        if( matchesSelector( node, selector ) ) { return node }
        if( node.parentNode === null ) { return null }

        return node.parentNode.closest( selector )
    }

    node.appendChild = ( child ) => {
        detach( child )
        child.parentNode = node
        node.children.push( child )

        return child
    }

    node.insertBefore = ( fresh, reference ) => {
        detach( fresh )
        fresh.parentNode = node
        const at = node.children.indexOf( reference )
        node.children.splice( at < 0 ? node.children.length : at, 0, fresh )

        return fresh
    }

    return node
}


// A container holding the given nodes as siblings — the shape a rendered chapter has. Returned as the
// `contentEl` the passes read their cards from.
export function makeRoot( nodes ) {
    const root = makeNode( 'DIV', '', [ 'content-root' ] )
    nodes.forEach( ( node ) => root.appendChild( node ) )

    return root
}


// The `document` the fold pass creates its <details>/<summary> with.
export function makeDocument() {
    return { createElement: ( tag ) => makeNode( tag ) }
}
