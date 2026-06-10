// Memo 019 Phase 2 (PRD-003) — "zum Memo hinzufügen" memo-dropdown ordering.
// Pure, side-effect-free sort logic mirrored by the inline client script in MemoView.mjs
// (the browser cannot import modules), kept here so the algorithm is Jest-tested.


class MemoDropdownSort {
    // Highest existing revision number of a memo, derived from its revisions[].fileName
    // (REV-NN). 0 when no revision file is present.
    static highestRevisionNumber( { memo } ) {
        const revisions = ( memo && Array.isArray( memo[ 'revisions' ] ) ) ? memo[ 'revisions' ] : []

        const numbers = revisions
            .map( ( r ) => ( r && typeof r[ 'fileName' ] === 'string' ) ? r[ 'fileName' ].match( /REV-(\d+)/ ) : null )
            .filter( ( m ) => m !== null )
            .map( ( m ) => parseInt( m[ 1 ], 10 ) )

        const highest = numbers.length === 0 ? 0 : Math.max( ...numbers )

        return { highest }
    }


    // Sort memos newest first: highest revision number first, then most recent mtime.
    // Returns a new array — the input is never mutated.
    static newestFirst( { memos } ) {
        const list = Array.isArray( memos ) ? memos.slice() : []

        list.sort( ( a, b ) => {
            const ra = MemoDropdownSort.highestRevisionNumber( { memo: a } ).highest
            const rb = MemoDropdownSort.highestRevisionNumber( { memo: b } ).highest

            if( ra !== rb ) {
                return rb - ra
            }

            const ma = ( a && typeof a[ 'mtime' ] === 'string' ) ? Date.parse( a[ 'mtime' ] ) : 0
            const mb = ( b && typeof b[ 'mtime' ] === 'string' ) ? Date.parse( b[ 'mtime' ] ) : 0
            const safeMa = Number.isFinite( ma ) ? ma : 0
            const safeMb = Number.isFinite( mb ) ? mb : 0

            return safeMb - safeMa
        } )

        return { 'memos': list }
    }
}


export { MemoDropdownSort }
