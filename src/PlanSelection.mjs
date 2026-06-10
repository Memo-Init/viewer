// Memo 016 Phase 9 (PRD-041) — Plan-Start memo multi-select state.
// Pure, side-effect-free toggle/resolve logic mirrored by the inline client script in
// MemoView.mjs (browser cannot import modules), kept here so the algorithm is Jest-tested.


class PlanSelection {
    // Toggle a documentId in the current selection. Selecting adds (in order), selecting an
    // already-selected id removes it — the other entries are never touched (PRD-041 AK 1-2).
    static toggle( { selected, documentId } ) {
        const current = Array.isArray( selected ) ? selected : []
        const index = current.indexOf( documentId )

        if( index === -1 ) {
            return { 'selected': [ ...current, documentId ] }
        }

        const next = current.filter( ( id ) => id !== documentId )

        return { 'selected': next }
    }


    // Create-button gate: active as soon as at least one memo is selected (PRD-041 AK 4).
    static canCreate( { selected } ) {
        const current = Array.isArray( selected ) ? selected : []

        return { 'canCreate': current.length > 0 }
    }


    // PRD-042: resolve selected documentIds to their absolute memoPath via a lookup map.
    // Drops ids without a known path — no invented/relative paths.
    static resolvePaths( { selected, pathById } ) {
        const current = Array.isArray( selected ) ? selected : []
        const lookup = ( pathById === undefined || pathById === null ) ? {} : pathById

        const memoPaths = current
            .map( ( id ) => lookup[ id ] )
            .filter( ( p ) => typeof p === 'string' && p.length > 0 )

        return { memoPaths }
    }
}


export { PlanSelection }
