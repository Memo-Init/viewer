// AnnotationStore.mjs — canonical annotation store (Memo 075 Phase 3, PRD-P3-04 / WI-012/013).
//
// An "annotation" (Anmerkung) is a machine-addressable comment bound to an anchored passage or table
// row of ONE discussed revision. This store MIRRORS the WorkItemStore contract (Memo 068): MEMO-SCOPED
// (one JSON file per annotation under <memoDir>/_annotations/ANM-NNN.json), monotonically numbered via
// #nextId (max+1, padStart(3,'0')) so a deleted annotation never re-uses an id, and NO-OVERWRITE
// (archive-then-write on a name collision). Scope is the MEMO, not the revision — otherwise
// "Anmerkung 4" would be revision-ambiguous (r7-R4). There is deliberately NO auto-UPDATE/DELETE path;
// the reverse channel (memo-revision-generate) reads the store, it does not mutate it.
//
// House style (mirrors the viewer/core code): static methods, object params/returns, private #helpers,
// no loops, no silent defaults. Note: this store lives in repos/viewer/src (the live viewer owns it)
// rather than repos/core/cli — the viewer is the only consumer and the CLI footprint stays untouched.

import { readdir, readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises'
import { resolve } from 'node:path'


const ANNOTATIONS_DIRNAME = '_annotations'
const ANM_ID_PATTERN = /^ANM-\d{3}$/
const ANCHOR_TYPES = [ 'text-quote', 'table-row' ]
const ANM_STATUS_VALUES = [ 'offen', 'eingearbeitet' ]


class AnnotationStore {
    // Create an annotation. documentId + revisionId + anchor + comment are REQUIRED. The id is assigned
    // deterministically (max+1 over existing ANM-NNN.json). anmStatus defaults to 'offen'. NO-OVERWRITE:
    // the id is fresh, but the write still goes through #archiveThenWrite for parity with WorkItemStore.
    static async create( { documentId, revisionId, anchor, comment, memoDir } ) {
        const scope = AnnotationStore.#requireMemoDir( { memoDir } )
        if( scope.status !== true ) {
            return { status: false, messages: scope.messages }
        }

        const validation = AnnotationStore.#validateCreate( { documentId, revisionId, anchor, comment } )
        if( validation.status !== true ) {
            return { status: false, messages: validation.messages }
        }

        const dir = AnnotationStore.#itemsDir( { memoDir } )
        await mkdir( dir, { recursive: true } )

        const { id } = await AnnotationStore.#nextId( { dir } )
        const record = {
            id,
            documentId,
            revisionId,
            anchor: AnnotationStore.#normalizeAnchor( { anchor } ),
            comment,
            anmStatus: 'offen',
            createdAt: new Date().toISOString()
        }

        const path = await AnnotationStore.#archiveThenWrite( { dir, name: `${ id }.json`, record } )

        return { status: true, messages: [], id, path, annotation: record }
    }


    // Read-only list. Drops a broken/unreadable file rather than crashing the whole read (mirror of the
    // viewer's #readTopicFiles resilience). Optional revisionId filter.
    static async list( { memoDir, revisionId } ) {
        const scope = AnnotationStore.#requireMemoDir( { memoDir } )
        if( scope.status !== true ) {
            return { status: false, messages: scope.messages, annotations: [] }
        }

        const dir = AnnotationStore.#itemsDir( { memoDir } )
        const exists = await stat( dir ).then( () => true ).catch( () => false )
        if( exists !== true ) {
            return { status: true, messages: [], annotations: [] }
        }

        const entries = await readdir( dir )
        // Only canonical ANM-NNN.json — never the archived ANM-NNN.<stamp>.json versions (extra dot).
        const files = entries.filter( ( name ) => /^ANM-\d{3}\.json$/.test( name ) )
        const loaded = await Promise.all( files.map( async ( name ) => {
            const raw = await readFile( resolve( dir, name ), 'utf-8' ).catch( () => null )
            if( raw === null ) { return null }

            try {
                return JSON.parse( raw )
            } catch {
                return null
            }
        } ) )

        const present = loaded.filter( ( entry ) => entry !== null )
        const filtered = typeof revisionId === 'string' && revisionId.length > 0
            ? present.filter( ( entry ) => entry.revisionId === revisionId )
            : present

        const annotations = filtered.sort( ( a, b ) => String( a.id ).localeCompare( String( b.id ) ) )

        return { status: true, messages: [], annotations }
    }


    static async get( { id, memoDir } ) {
        const scope = AnnotationStore.#requireMemoDir( { memoDir } )
        if( scope.status !== true ) {
            return { status: false, messages: scope.messages }
        }

        const dir = AnnotationStore.#itemsDir( { memoDir } )
        const read = await AnnotationStore.#readItem( { dir, id } )

        return read.status === true
            ? { status: true, messages: [], annotation: read.item }
            : { status: false, messages: read.messages }
    }


    // ---- private ----

    static #requireMemoDir( { memoDir } ) {
        if( typeof memoDir !== 'string' || memoDir.length === 0 ) {
            return { status: false, messages: [ 'memoDir: required non-empty memo context (annotations are memo-scoped)' ] }
        }

        return { status: true, messages: [] }
    }


    static #itemsDir( { memoDir } ) {
        return resolve( memoDir, ANNOTATIONS_DIRNAME )
    }


    static async #archiveThenWrite( { dir, name, record } ) {
        const path = resolve( dir, name )

        const exists = await stat( path ).then( () => true ).catch( () => false )
        if( exists === true ) {
            const stamp = new Date().toISOString().replace( /[:.]/g, '-' )
            const stamped = name.replace( /\.json$/, `.${ stamp }.json` )
            await rename( path, resolve( dir, stamped ) )
        }

        await mkdir( dir, { recursive: true } )
        await writeFile( path, JSON.stringify( record, null, 4 ) + '\n', 'utf-8' )

        return path
    }


    static #normalizeAnchor( { anchor } ) {
        // PRD-005 (Memo 076 Phase 3, WI-122): `sourceLine` is the 1-based line of the quote/row in the
        // discussed revision markdown, computed server-side (MemoView.computeSourceLine) and whitelisted
        // here in BOTH anchor branches. No silent default — a missing/invalid value is an explicit null.
        const type = anchor.type
        if( type === 'table-row' ) {
            return {
                type,
                tableLabel: typeof anchor.tableLabel === 'string' ? anchor.tableLabel : null,
                rowKey: typeof anchor.rowKey === 'string' ? anchor.rowKey : null,
                rowText: typeof anchor.rowText === 'string' ? anchor.rowText : null,
                chapterSlug: typeof anchor.chapterSlug === 'string' ? anchor.chapterSlug : null,
                sourceLine: Number.isInteger( anchor.sourceLine ) ? anchor.sourceLine : null
            }
        }

        return {
            type: 'text-quote',
            exact: typeof anchor.exact === 'string' ? anchor.exact : '',
            prefix: typeof anchor.prefix === 'string' ? anchor.prefix : '',
            suffix: typeof anchor.suffix === 'string' ? anchor.suffix : '',
            chapterSlug: typeof anchor.chapterSlug === 'string' ? anchor.chapterSlug : null,
            sourceLine: Number.isInteger( anchor.sourceLine ) ? anchor.sourceLine : null
        }
    }


    static #validateCreate( { documentId, revisionId, anchor, comment } ) {
        const messages = []

        if( typeof documentId !== 'string' || documentId.length === 0 ) {
            messages.push( 'documentId: required non-empty string' )
        }
        if( typeof revisionId !== 'string' || revisionId.length === 0 ) {
            // PRD-005 (WI-127): precise cause — the open file is not a revision (REV-NN), not a generic
            // "non-empty string". The user-facing German message is delivered client-side (app.client.mjs).
            messages.push( 'revisionId: required — the open file is not a revision (REV-NN)' )
        }
        if( typeof comment !== 'string' || comment.trim().length === 0 ) {
            messages.push( 'comment: required non-empty string' )
        }
        if( anchor === null || typeof anchor !== 'object' ) {
            messages.push( 'anchor: required object { type, ... }' )
        } else if( ANCHOR_TYPES.includes( anchor.type ) !== true ) {
            messages.push( `anchor.type: must be one of ${ ANCHOR_TYPES.join( ', ' ) }` )
        } else if( anchor.type === 'text-quote' && ( typeof anchor.exact !== 'string' || anchor.exact.length === 0 ) ) {
            messages.push( 'anchor.exact: required non-empty string for a text-quote anchor' )
        } else if( anchor.type === 'table-row' && ( typeof anchor.rowKey !== 'string' || anchor.rowKey.length === 0 ) && ( typeof anchor.rowText !== 'string' || anchor.rowText.length === 0 ) ) {
            messages.push( 'anchor: a table-row anchor needs a rowKey or a rowText fallback' )
        }

        return { status: messages.length === 0, messages }
    }


    static async #nextId( { dir } ) {
        const entries = await readdir( dir ).catch( () => [] )
        const numbers = entries
            .filter( ( name ) => /^ANM-\d{3}\.json$/.test( name ) )
            .map( ( name ) => Number( name.slice( 4, 7 ) ) )

        const max = numbers.length === 0 ? 0 : Math.max( ...numbers )
        const next = max + 1

        return { id: `ANM-${ String( next ).padStart( 3, '0' ) }` }
    }


    static async #readItem( { dir, id } ) {
        if( typeof id !== 'string' || ANM_ID_PATTERN.test( id ) !== true ) {
            return { status: false, messages: [ `annotation id "${ id }" is not a valid ANM-NNN id` ] }
        }

        const path = resolve( dir, `${ id }.json` )
        const read = await readFile( path, 'utf-8' )
            .then( ( raw ) => ( { ok: true, raw } ) )
            .catch( ( error ) => ( { ok: false, code: error.code } ) )

        if( read.ok !== true ) {
            return { status: false, messages: [ `annotation "${ id }" not found (${ read.code })` ] }
        }

        return { status: true, item: JSON.parse( read.raw ) }
    }
}


export {
    AnnotationStore,
    ANM_ID_PATTERN,
    ANCHOR_TYPES,
    ANM_STATUS_VALUES
}
