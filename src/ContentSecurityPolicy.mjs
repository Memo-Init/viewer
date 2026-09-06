import { createHash } from 'node:crypto'


// WI-103 (Memo 080, Kap 15 — Das Schaufenster): "Alle Bausteine mitgeliefert plus Sicherheits-Kopf".
// The header is the logical consequence of F13 = A, not a separate idea: as long as five bundles came
// from cdn.jsdelivr.net, ANY policy that forbids foreign origins would have blanked the page. Once
// every building block is served from this process, `default-src 'self'` costs nothing and the
// network is closed.
//
// The two inline <script> blocks the page still needs (the injected config flag and the build stamp)
// are admitted by their sha256 hash, NOT by 'unsafe-inline'. A hash is stricter than a nonce here
// because it is bound to the exact bytes: an inline block that changes without its hash changing is
// not expressible, and an injected inline block has no hash at all.
//
// TWO deliberate relaxations, both named so they can be argued with:
//   style-src 'unsafe-inline' — the client writes 27 `style="…"` attributes into generated markup and
//       mermaid/cytoscape inject <style> elements into their own subtrees. This is style, not script:
//       it cannot execute and it cannot fetch.
//   img-src / font-src data: — the favicon is drawn on a canvas and set via toDataURL('image/png'),
//       and mermaid embeds fonts and markers as data URIs. `data:` is local by definition.
// Everything else is 'self' or 'none'. There is NO 'unsafe-eval': vega is embedded with { ast: true },
// its CSP-safe expression interpreter, so its one `new Function` site is never reached.
const STATIC_DIRECTIVES = [
    [ 'default-src', [ "'self'" ] ],
    [ 'style-src', [ "'self'", "'unsafe-inline'" ] ],
    [ 'img-src', [ "'self'", 'data:', 'blob:' ] ],
    [ 'font-src', [ "'self'", 'data:' ] ],
    [ 'worker-src', [ "'self'", 'blob:' ] ],
    [ 'object-src', [ "'none'" ] ],
    [ 'base-uri', [ "'self'" ] ],
    [ 'frame-ancestors', [ "'none'" ] ],
    [ 'form-action', [ "'self'" ] ]
]


class ContentSecurityPolicy {

    // Build the header value for ONE page render. `inlineScripts` are the exact bodies of the inline
    // <script> blocks of that page — same strings that go into the HTML, so the hash can never
    // describe a different text than the browser sees. `port` closes the WebSocket hole: the live
    // channel connects to ws://127.0.0.1:<port>, and naming it explicitly means connect-src does not
    // have to rely on browsers folding ws: into 'self'.
    static build( { inlineScripts, port } ) {
        ContentSecurityPolicy.validationBuild( { inlineScripts, port } )

        const hashes = inlineScripts
            .map( ( body ) => ContentSecurityPolicy.hashOf( { body } ) )

        const directives = []
            .concat( [ [ 'script-src', [ "'self'" ].concat( hashes ) ] ] )
            .concat( [ [ 'connect-src', [ "'self'", `ws://127.0.0.1:${ port }`, `ws://localhost:${ port }` ] ] ] )
            .concat( STATIC_DIRECTIVES )

        const header = directives
            .map( ( [ name, values ] ) => `${ name } ${ values.join( ' ' ) }` )
            .join( '; ' )

        return { header, directives, hashes }
    }


    // The CSP source expression for one inline script body: sha256 over the EXACT bytes between
    // <script> and </script>, base64-encoded, in the `'sha256-…'` wrapper the header expects.
    static hashOf( { body } ) {
        ContentSecurityPolicy.validationHashOf( { body } )

        const digest = createHash( 'sha256' ).update( body, 'utf8' ).digest( 'base64' )

        return `'sha256-${ digest }'`
    }


    // ---- validation ----

    static validationBuild( { inlineScripts, port } ) {
        const struct = { 'status': false, 'messages': [] }

        if( inlineScripts === undefined || inlineScripts === null ) { struct['messages'].push( 'inlineScripts: Missing value' ) }
        else if( Array.isArray( inlineScripts ) !== true ) { struct['messages'].push( 'inlineScripts: Is not type of "array"' ) }
        else if( inlineScripts.length === 0 ) { struct['messages'].push( 'inlineScripts: Is empty' ) }
        else {
            inlineScripts
                .forEach( ( body, index ) => {
                    if( typeof body !== 'string' ) { struct['messages'].push( `inlineScripts[${ index }]: Is not type of "string"` ); return }
                    if( body.length === 0 ) { struct['messages'].push( `inlineScripts[${ index }]: Is empty` ) }
                } )
        }

        if( port === undefined || port === null ) { struct['messages'].push( 'port: Missing value' ) }
        else if( Number.isInteger( port ) !== true ) { struct['messages'].push( 'port: Is not type of "integer"' ) }
        else if( port < 1 || port > 65535 ) { struct['messages'].push( 'port: Is out of range 1..65535' ) }

        if( struct['messages'].length > 0 ) { throw new Error( `ContentSecurityPolicy.build: ${ struct['messages'].join( ', ' ) }` ) }

        struct['status'] = true

        return struct
    }


    static validationHashOf( { body } ) {
        const struct = { 'status': false, 'messages': [] }

        if( body === undefined || body === null ) { struct['messages'].push( 'body: Missing value' ) }
        else if( typeof body !== 'string' ) { struct['messages'].push( 'body: Is not type of "string"' ) }
        else if( body.length === 0 ) { struct['messages'].push( 'body: Is empty' ) }

        if( struct['messages'].length > 0 ) { throw new Error( `ContentSecurityPolicy.hashOf: ${ struct['messages'].join( ', ' ) }` ) }

        struct['status'] = true

        return struct
    }

}


export { ContentSecurityPolicy }
