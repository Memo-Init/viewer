// RevisionLogic.mjs — single-source isomorphic logic (Memo 016, PRD-012 / catalog F3).
//
// F3 = a set of small, PURE decision helpers were duplicated: once as a static MemoView.xxx
// method (server-side, unit-tested) and once as an inline `function xxx(...)` inside the client
// browser script (src/public/app.client.mjs). Two hand-maintained copies of the same logic drift.
//
// This module is the SERVER single source of truth: every MemoView.xxx static below now delegates
// here, so there is exactly ONE server-side body per function. The client copy CANNOT runtime-import
// this module — app.client.mjs is served as a CLASSIC <script> (global scope so inline on*= handlers
// keep working; switching it to type=module is catalog item F8, a separate PRD). So the client keeps
// its own inline mirror, and the DRIFT is closed by a drift-guard test (tests/unit/IsomorphicDedupPRD012.test.mjs)
// that runs the SAME inputs through RevisionLogic.xxx AND the extracted client inline copy and asserts
// identical outputs. If the two ever diverge, that test fails.
//
// House style: static methods, object params/returns, no loops, no silent defaults. The object-return
// shapes here are byte-for-byte the shapes the existing MemoView.xxx callers already destructure
// (e.g. { slug }, { ballStatus }, { revisionId }, { html } ), so the wrappers stay trivial.


class RevisionLogic {
    // PRD-007 (Memo 016, D3/D7): the ONE slug algorithm — heading ids AND the diff-banner anchors.
    // Lowercase, Umlaut transliteration, punctuation collapses to a single '-' separator (never
    // stripped), trim leading/trailing dashes. Mirrored 1:1 by the inline browser slugify.
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


    // PRD-013 (Memo 016 Kap 3): Soll-Nummern-Logik for the sticky-header button. next = (highest
    // existing REV number) + 1, previous = highest existing. The number is NEVER derived from the
    // viewed revision suffix. Source is the memo's revisions bestand (rev.fileName).
    static nextRevisionNumbers( { revisions } ) {
        const safeRevisions = Array.isArray( revisions ) ? revisions : []

        const numbers = safeRevisions
            .map( ( rev ) => {
                const fileName = rev && typeof rev[ 'fileName' ] === 'string' ? rev[ 'fileName' ] : ''
                const match = fileName.match( /REV-(\d+)/ )

                return match === null ? null : parseInt( match[ 1 ], 10 )
            } )
            .filter( ( n ) => n !== null )

        const previous = numbers.length === 0 ? 0 : Math.max( ...numbers )
        const next = previous + 1

        return {
            previous,
            next,
            'previousId': `REV-${ String( previous ).padStart( 2, '0' ) }`,
            'nextId': `REV-${ String( next ).padStart( 2, '0' ) }`
        }
    }


    // PRD-001 (Memo 018 Kap 4, F7=A): the 3-state ball status derived from the revision-level
    // revisionStatus plus memoFinalized. eingeloggt + finalisiert -> Finalisiert (Locked);
    // transcript-eingetragen -> Transcript hinterlegt; otherwise -> Wartet auf User-Feedback.
    static deriveBallStatus( { revisionStatus, memoFinalized } ) {
        if( revisionStatus === 'eingeloggt' && memoFinalized === true ) {
            return { 'ballStatus': 'Finalisiert (Locked)' }
        }

        if( revisionStatus === 'transcript-eingetragen' ) {
            return { 'ballStatus': 'Transcript hinterlegt' }
        }

        return { 'ballStatus': 'Wartet auf User-Feedback' }
    }


    // Extracts a revisionId (REV-NN) from a sticky-header fileName like "REV-03.md".
    // Returns { revisionId: null } when the fileName does not encode a revision (e.g. plan phases).
    static revisionIdFromFileName( { fileName } ) {
        if( typeof fileName !== 'string' ) { return { 'revisionId': null } }

        const match = fileName.match( /(REV-\d{2,})/ )

        return { 'revisionId': match === null ? null : match[ 1 ] }
    }


    // PRD-010 (Memo 024 Kap 8): the mermaid render-fallback HTML. On a render failure the viewer
    // shows the error message PLUS the unchanged original source as an HTML-escaped <pre> block, so
    // a broken diagram degrades to readable text instead of a bare error. err/originalText are
    // HTML-escaped (&, <, >).
    static buildMermaidErrorHtml( { err, originalText } ) {
        const message = ( err && err.message ) ? err.message : String( err == null ? '' : err )
        const safeMessage = String( message )
            .replace( /&/g, '&amp;' )
            .replace( /</g, '&lt;' )
            .replace( />/g, '&gt;' )
        const safeOriginal = String( originalText == null ? '' : originalText )
            .replace( /&/g, '&amp;' )
            .replace( /</g, '&lt;' )
            .replace( />/g, '&gt;' )
        const html = '<div class="mermaid-error">Mermaid Error: ' + safeMessage
            + '</div><pre class="mermaid-error-source">' + safeOriginal + '</pre>'

        return { 'html': html }
    }


    // PRD-005 (Memo 016 Kap 4, B1/B2): the explanatory empty-state decision for the requirements
    // view. Turns ( count, setPresent, missingCount ) into a ternary verdict + a German reason line:
    //   - count > 0           -> { empty:false, kind:'resolved' }
    //   - setPresent !== true -> { empty:true, kind:'no-set' }
    //   - present, count === 0-> { empty:true, kind:'empty-set' }  (missingCount woven into reason)
    static requirementsEmptyState( { count, setPresent, missingCount } ) {
        const safeCount = typeof count === 'number' && count > 0 ? count : 0
        const safeMissing = typeof missingCount === 'number' && missingCount > 0 ? missingCount : 0

        if( safeCount > 0 ) {
            return { 'empty': false, 'kind': 'resolved', 'reason': '' }
        }

        if( setPresent !== true ) {
            return {
                'empty': true,
                'kind': 'no-set',
                'reason': 'Kein Eval-Set hinterlegt — fuer dieses Memo existiert keine memo-NNN.set.json. 0 aufgeloest.'
            }
        }

        const missingNote = safeMissing > 0
            ? ` Das Set referenziert ${ safeMissing } ID(s), die der Store nicht kennt.`
            : ''

        return {
            'empty': true,
            'kind': 'empty-set',
            'reason': `Eval-Set vorhanden, aber 0 aufgeloest.${ missingNote }`
        }
    }


    // PRD-005 (Memo 016 Kap 4, B3/B5): resolve a block's requirement names (the `req-*` namespace)
    // against the requirements store id index (the `REQ-NNN` namespace). A block name resolves only
    // when its normalized form (uppercased, '_' -> '-') equals a known store id, otherwise it is
    // reported as `unresolved` so the view can WARN — the namespace mismatch becomes VISIBLE.
    static resolveBlockRequirements( { blockRequirementNames, knownIds } ) {
        const names = Array.isArray( blockRequirementNames ) ? blockRequirementNames : []
        const ids = Array.isArray( knownIds ) ? knownIds : []
        const normalize = ( value ) => String( value == null ? '' : value ).trim().toUpperCase().replace( /_/g, '-' )
        const knownByNorm = {}
        ids.forEach( ( id ) => { knownByNorm[ normalize( id ) ] = id } )

        const seen = new Set()
        const uniqueNames = names
            .map( ( name ) => String( name == null ? '' : name ).trim() )
            .filter( ( name ) => name.length > 0 )
            .filter( ( name ) => {
                if( seen.has( name ) === true ) { return false }
                seen.add( name )

                return true
            } )

        const resolved = uniqueNames
            .map( ( name ) => knownByNorm[ normalize( name ) ] )
            .filter( ( id ) => id !== undefined )
        const unresolved = uniqueNames
            .filter( ( name ) => knownByNorm[ normalize( name ) ] === undefined )

        return {
            'resolved': resolved,
            'unresolved': unresolved,
            'hasNamespaceMismatch': unresolved.length > 0
        }
    }


    // PRD-009 (Memo 016 Kap 7, F4/E6): the view-mode state machine for the #content area. Prose is
    // home; requirements/blocks are non-destructive panels. Requesting the active non-prose view
    // toggles BACK to prose (E6/F4). `render` is false only for a no-op prose-on-prose click.
    static nextViewState( { current, requested } ) {
        const known = [ 'prose', 'requirements', 'blocks' ]
        const safeCurrent = known.indexOf( current ) !== -1 ? current : 'prose'
        const safeRequested = known.indexOf( requested ) !== -1 ? requested : 'prose'

        if( safeRequested === 'prose' ) {
            return { 'view': 'prose', 'render': safeCurrent !== 'prose' }
        }

        if( safeRequested === safeCurrent ) {
            return { 'view': 'prose', 'render': true }
        }

        return { 'view': safeRequested, 'render': true }
    }


    // PRD-009 (Memo 016 Kap 7, E7/F10): the broadcast guard. A WS `content` broadcast may only
    // re-render prose content when the prose/memo home view is on screen; an open requirements/blocks
    // panel must survive the broadcast untouched. Returns { rerender } — true ONLY for the home view.
    static shouldRerenderOnBroadcast( { currentView } ) {
        const rerender = currentView === 'prose'
            || currentView === 'memo'
            || currentView === undefined
            || currentView === null
            || currentView === ''

        return { rerender }
    }
}


export { RevisionLogic }
