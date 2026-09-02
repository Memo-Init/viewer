// VENDORED FROM THE CORE REPO — repos/core/cli/src/BlockTablePayload.mjs is the single source. This copy
// exists because the viewer is its own checkout and must resolve the same pointers with the same rules;
// re-vendor by copying the core file over this one and re-applying these three lines. Never edit one side
// alone: the cross-repo byte-parity fixture (tests/fixtures/revision-body-pointer-v1) is what catches it.

// BlockTablePayload.mjs — the table-specific SHAPE of an external payload (Memo 080, PRD-D5).
//
// This class owns exactly one thing: what a table payload LOOKS like — the deterministic
// `{ columns: [...], rows: [[...]] }` document and its rendering into the `tsv` a block table carries.
// It deliberately owns NO path handling: resolving the pointer, reading the file and comparing the
// checksum belong to PayloadPointer, so there is ONE notion of a path and ONE error rule in the tree
// instead of a second, table-shaped twin of both.
//
// The read is inline (PointerSites declares mode 'inline' for this site): a payload whose checksum does
// not match, that is missing, or that was never measured ABORTS. It is never substituted by the last
// known content, by an empty table, or by a skipped entry.
//
// Class architecture per node-class-architecture: static-only, object params, object returns,
// private-by-default, NO SILENT DEFAULTS, no for/while.

import { PayloadPointer } from './PayloadPointer.mjs'
import { PointerSites } from './PointerSites.mjs'


class BlockTablePayload {
    // The shape gate. A payload document is exactly { columns: [ string ], rows: [ [ cell ] ] }; every
    // row must carry one cell per column. A short row is a defect, never a row padded with blanks.
    static assertShape( { payload } ) {
        if( payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray( payload ) === true ) {
            throw new Error( 'BlockTablePayload.assertShape: "payload" is required (object with columns[] and rows[][])' )
        }

        const columns = payload[ 'columns' ]
        const rows = payload[ 'rows' ]
        if( Array.isArray( columns ) !== true || columns.length === 0 ) {
            throw new Error( 'BlockTablePayload.assertShape: "columns" is required (non-empty array of column names)' )
        }
        const badColumns = columns
            .filter( ( column ) => typeof column !== 'string' || column.length === 0 )
        if( badColumns.length > 0 ) {
            throw new Error( `BlockTablePayload.assertShape: ${ badColumns.length } column name(s) are not non-empty strings` )
        }
        if( Array.isArray( rows ) !== true ) {
            throw new Error( 'BlockTablePayload.assertShape: "rows" is required (array of row arrays)' )
        }
        const badRows = rows
            .map( ( row, index ) => ( { index, row } ) )
            .filter( ( entry ) => Array.isArray( entry.row ) !== true || entry.row.length !== columns.length )
        if( badRows.length > 0 ) {
            const which = badRows
                .map( ( entry ) => `rows[${ entry.index }]` )
                .join( ', ' )

            throw new Error( `BlockTablePayload.assertShape: ${ which } do not carry exactly ${ columns.length } cell(s) — a short row is a defect, not a row to pad` )
        }

        return { columns, rows }
    }


    // The deterministic rendering: header line, then one line per row, tab separated. Identical payload
    // in, identical bytes out — the premise the frozen revision's hash rests on.
    static toTsv( { payload } ) {
        const { columns, rows } = BlockTablePayload.assertShape( { payload } )
        const lines = [ columns.join( '\t' ) ]
            .concat( rows.map( ( row ) => row.map( ( cell ) => String( cell ) ).join( '\t' ) ) )
        const tsv = lines.join( '\n' )

        return { tsv }
    }


    // Pull an external table payload IN — through the checksum, never around it. Path resolution and the
    // inline error branch are PayloadPointer's; this method adds only the JSON parse and the shape gate.
    static load( { memoDir, projectRoot, ref, expected } ) {
        const { site } = BlockTablePayload.#site()
        const { content, sha256, resolved } = PayloadPointer.readVerified( {
            base: site.base, memoDir, projectRoot, ref, expected
        } )

        const payload = BlockTablePayload.#parse( { content, resolved } )
        const { tsv } = BlockTablePayload.toTsv( { payload } )

        return { payload, tsv, sha256, resolved }
    }


    // Measure a payload file at the WRITE edge: the same read, the same shape gate, but the checksum is
    // produced rather than compared (there is nothing to compare against yet).
    static measure( { memoDir, projectRoot, ref } ) {
        const { site } = BlockTablePayload.#site()
        const { content, sha256, resolved } = PayloadPointer.readAndHash( {
            base: site.base, memoDir, projectRoot, ref
        } )

        const payload = BlockTablePayload.#parse( { content, resolved } )
        const { tsv } = BlockTablePayload.toTsv( { payload } )

        return { payload, tsv, sha256, resolved }
    }


    // ---- private ----

    // The reference point is READ FROM THE REGISTER, never written down a second time here — that is what
    // keeps this class from becoming a second path authority.
    static #site() {
        const { site } = PointerSites.bySite( { table: 'block_tables' } )
        if( site === null ) {
            throw new Error( 'BlockTablePayload: the block table payload site is not declared in PointerSites' )
        }

        return { site }
    }


    static #parse( { content, resolved } ) {
        try {
            return JSON.parse( content )
        } catch( error ) {
            throw new Error( `BlockTablePayload: ${ resolved } is not readable JSON — ${ error.message }` )
        }
    }
}


export { BlockTablePayload }
