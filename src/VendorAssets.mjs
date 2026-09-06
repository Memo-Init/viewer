import { existsSync, statSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'


// WI-103 (Memo 080, Kap 15 — Das Schaufenster; F13 = A: "schlanke Graph-Bibliothek mitgeliefert,
// alle Bausteine mitgeliefert"). Before this register the page pulled marked, mermaid and three
// vega bundles from cdn.jsdelivr.net. That had two consequences: five network requests on every
// page load of a tool that binds 127.0.0.1 only, and no way to set a Content-Security-Policy — a
// header that forbids foreign origins would have killed the page.
//
// ONE register, TWO consumers: the <script> tags of the page (VendorAssets.scriptTags) and the
// /vendor/<file> route that serves them (VendorAssets.resolve). Page and route therefore cannot
// drift apart — a tag without a route, or a route without a tag, is not expressible here.
//
// The array ORDER is the load order and is load-bearing:
//   marked      — the markdown renderer, needed by the client bundle at first render
//   mermaid     — the diagram renderer for ```mermaid blocks (F30 leaves this in place; the
//                 knowledge graph moves to cytoscape, the prose diagrams stay with mermaid)
//   cytoscape   — F30 = A: the interactive knowledge graph
//   vega -> vega-lite -> vega-embed — each builds on the global the previous one defines
const VENDOR_ASSETS = [
    { 'route': '/vendor/marked.min.js', 'packageName': 'marked', 'subPath': 'marked.min.js', 'globalName': 'marked' },
    { 'route': '/vendor/mermaid.min.js', 'packageName': 'mermaid', 'subPath': 'dist/mermaid.min.js', 'globalName': 'mermaid' },
    { 'route': '/vendor/cytoscape.min.js', 'packageName': 'cytoscape', 'subPath': 'dist/cytoscape.min.js', 'globalName': 'cytoscape' },
    { 'route': '/vendor/vega.min.js', 'packageName': 'vega', 'subPath': 'build/vega.min.js', 'globalName': 'vega' },
    { 'route': '/vendor/vega-lite.min.js', 'packageName': 'vega-lite', 'subPath': 'build/vega-lite.min.js', 'globalName': 'vegaLite' },
    { 'route': '/vendor/vega-embed.min.js', 'packageName': 'vega-embed', 'subPath': 'build/vega-embed.min.js', 'globalName': 'vegaEmbed' }
]


// Node's own resolver is NOT usable here: vega, vega-lite and vega-embed carry an `exports` map
// that does not publish their build/ directory, so createRequire().resolve() answers
// ERR_PACKAGE_PATH_NOT_EXPORTED for exactly the files the browser needs. The lookup below is the
// node_modules walk without the exports gate — deterministic, bounded by the path depth, and it
// never leaves the ancestor chain of this file.
const findInNodeModules = ( { startDir, packageName, subPath } ) => {
    const candidate = join( startDir, 'node_modules', packageName, subPath )

    if( existsSync( candidate ) === true ) {
        return candidate
    }

    const parent = dirname( startDir )

    return parent === startDir || parent === parse( startDir ).root
        ? null
        : findInNodeModules( { 'startDir': parent, packageName, subPath } )
}


const MODULE_DIR = dirname( fileURLToPath( import.meta.url ) )


class VendorAssets {

    // The register itself, as data. Callers get a copy — the array is the single source of truth for
    // the page tags AND the route, and nothing outside this module may reorder or extend it.
    static list() {
        const assets = VENDOR_ASSETS
            .map( ( entry ) => ( { ...entry } ) )

        return { assets }
    }


    // Where the file for one route lives on disk RIGHT NOW. Answers a ternary, never a throw: an
    // unknown route is `status: false` with a message (the caller turns it into a 404), a known route
    // whose package is missing from node_modules is ALSO `status: false` with a different message —
    // an install that never ran must not look like a typo in the URL.
    static resolve( { route } ) {
        VendorAssets.validationResolve( { route } )

        const entry = VENDOR_ASSETS
            .find( ( candidate ) => candidate[ 'route' ] === route )

        if( entry === undefined ) {
            return { 'status': false, 'filePath': null, 'bytes': null, 'messages': [ `Unbekannte Vendor-Datei: ${ route }` ] }
        }

        const filePath = findInNodeModules( {
            'startDir': MODULE_DIR, 'packageName': entry[ 'packageName' ], 'subPath': entry[ 'subPath' ]
        } )

        if( filePath === null ) {
            return {
                'status': false, 'filePath': null, 'bytes': null,
                'messages': [ `Mitgelieferte Datei fehlt: ${ entry[ 'packageName' ] }/${ entry[ 'subPath' ] } — "npm install" im Ordner repos/viewer ausfuehren` ]
            }
        }

        return { 'status': true, filePath, 'bytes': statSync( filePath ).size, 'messages': [] }
    }


    // The <script> tags for the page head, in register order. Every src is a SAME-ORIGIN absolute
    // path — that is the whole point of the register, and the Content-Security-Policy built next to
    // it (`script-src 'self'` plus the two inline hashes) only holds because of it.
    static scriptTags() {
        const tags = VENDOR_ASSETS
            .map( ( entry ) => `    <script src="${ entry[ 'route' ] }"></script>` )
            .join( '\n' )

        return { tags }
    }


    // ---- validation ----

    static validationResolve( { route } ) {
        const struct = { 'status': false, 'messages': [] }
        const n = []

        n.push( [ 'route', route, 'string', false ] )

        n
            .forEach( ( [ key, value, type, list ] ) => {
                if( value === undefined || value === null ) { struct['messages'].push( `${ key }: Missing value` ); return }
                if( type === 'string' && typeof value !== 'string' ) { struct['messages'].push( `${ key }: Is not type of "string"` ); return }
                if( type === 'string' && value.length === 0 ) { struct['messages'].push( `${ key }: Is empty` ); return }
                if( list !== false && !list.includes( value ) ) { struct['messages'].push( `${ key }: Is not in list "${ list.join( ', ' ) }"` ) }
            } )

        if( struct['messages'].length > 0 ) { throw new Error( `VendorAssets.resolve: ${ struct['messages'].join( ', ' ) }` ) }

        struct['status'] = true

        return struct
    }

}


export { VendorAssets }
