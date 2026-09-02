// VENDORED FROM THE CORE REPO — repos/core/cli/src/PayloadPointer.mjs is the single source. This copy
// exists because the viewer is its own checkout and must resolve the same pointers with the same rules;
// re-vendor by copying the core file over this one and re-applying these three lines. Never edit one side
// alone: the cross-repo byte-parity fixture (tests/fixtures/revision-body-pointer-v1) is what catches it.

// PayloadPointer.mjs — the ONE resolver, reader and checker for every external payload pointer
// (Memo 080, PRD-D5 Vollausbau, Kapitel 4). The sites it serves are declared in PointerSites; this
// class deliberately names none of them, so a new site is a register entry and never new code here.
//
// THE ERROR RULE (binding, Kapitel 4 — "halb gelesen ist ein Fehler, kein Ergebnis"):
//
//   A SILENT SUBSTITUTE IS FORBIDDEN. A missing source is reported as a GAP, never as a zero.
//
//   | case                        | mode 'inline' (content is pulled in) | mode 'reference' (pointer only) |
//   | checksum differs            | ABORT, naming path/expected/actual   | GAP (path + reason)             |
//   | file missing                | ABORT, naming the resolved path      | GAP (resolved path) — never omitted |
//   | pointer leaves its base     | ABORT (already at the write edge)    | ABORT (already at the write edge)   |
//   | checksum is null            | ABORT — never pull in an unmeasured payload | GAP "never measured", counted as unhashed, never as matched |
//
//   Never substituted: the last known content, an empty table, a skipped entry, a re-written checksum.
//   A differing hash is a finding a HUMAN decides, not a state a run tidies away.
//
// The reference point comes from the register (`base`), never from the caller's working directory:
// a pointer resolved against the shell would mean a different file depending on where the command ran.
//
// Class architecture per node-class-architecture: static-only, object params, object returns,
// private-by-default, NO SILENT DEFAULTS, no for/while.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, isAbsolute, relative, sep, normalize } from 'node:path'

import { PointerSites } from './PointerSites.mjs'


const STATE_MATCHED = 'matched'
const STATE_MISMATCHED = 'mismatched'
const STATE_MISSING = 'missing'
const STATE_UNHASHED = 'unhashed'
const STATES = [ STATE_MATCHED, STATE_MISMATCHED, STATE_MISSING, STATE_UNHASHED ]


class PayloadPointer {
    // Resolve a STORED pointer against its declared base. The stored form is always base-relative:
    // an absolute value or a value climbing out with `..` is refused fail-loud, naming the boundary.
    static resolveRef( { base, memoDir, projectRoot, ref } ) {
        const { root } = PayloadPointer.#rootFor( { base, memoDir, projectRoot } )
        if( typeof ref !== 'string' || ref.length === 0 ) {
            throw new Error( 'PayloadPointer.resolveRef: "ref" is required (non-empty string) — a pointer without a path carries nothing' )
        }
        if( isAbsolute( ref ) === true ) {
            throw new Error( `PayloadPointer.resolveRef: "${ ref }" is an absolute path — a pointer is stored relative to its base "${ base }" (${ root }), so an absolute value is refused` )
        }

        const resolved = resolve( root, ref )
        PayloadPointer.#assertInside( { resolved, root, base, ref } )

        return { resolved, root }
    }


    // The WRITE edge: turn a caller-supplied path into the canonical base-relative pointer. The path is
    // read relative to the BASE (never to the caller's working directory), so the same argument yields the
    // same database value from any working directory. A path that leaves the base is refused, naming it.
    static normalizeRef( { base, memoDir, projectRoot, path } ) {
        const { root } = PayloadPointer.#rootFor( { base, memoDir, projectRoot } )
        if( typeof path !== 'string' || path.length === 0 ) {
            throw new Error( 'PayloadPointer.normalizeRef: "path" is required (non-empty string)' )
        }
        if( isAbsolute( path ) === true ) {
            throw new Error( `PayloadPointer.normalizeRef: "${ path }" is an absolute path — pass it relative to the base "${ base }" (${ root }); an absolute value is not reproducible and is refused` )
        }

        const resolved = resolve( root, path )
        PayloadPointer.#assertInside( { resolved, root, base, ref: path } )
        const ref = relative( root, resolved )
            .split( sep )
            .join( '/' )

        return { ref, resolved, root }
    }


    // The LEXICAL half of the boundary rule, usable WITHOUT a reference point. A stored pointer is
    // base-relative BY CONSTRUCTION, so an absolute value or one that climbs out with `..` is refusable
    // from the shape alone. This is what a STORE can check: a flat-file store (ResearchStore, MemoBlock)
    // holds no root, yet it is a write edge, and the error rule demands the refusal happen AT the write
    // edge — every one of them, not only the leaf that happens to know a root. Returns a verdict object
    // (no throw) because the stores answer in { status, messages }; assertStorableRef is the throwing twin
    // for callers that raise.
    static checkStorableRef( { ref } ) {
        if( typeof ref !== 'string' || ref.length === 0 ) {
            return { ok: false, ref: null, reason: 'a pointer needs a non-empty, base-relative path' }
        }
        if( isAbsolute( ref ) === true ) {
            return { ok: false, ref: null, reason: `"${ ref }" is an absolute path — a pointer is stored relative to its base, so an absolute value is refused (it is not reproducible on another machine)` }
        }

        const cleaned = normalize( ref )
            .split( sep )
            .join( '/' )
        const escapes = cleaned === '..' || cleaned.startsWith( '../' ) === true
        if( escapes === true ) {
            return { ok: false, ref: null, reason: `"${ ref }" climbs out of its base (normalizes to "${ cleaned }") — a pointer that leaves its reference point is refused at the write edge` }
        }

        return { ok: true, ref: cleaned, reason: `"${ cleaned }" stays inside its base` }
    }


    static assertStorableRef( { ref, where } ) {
        const checked = PayloadPointer.checkStorableRef( { ref } )
        if( checked.ok !== true ) {
            throw new Error( `${ where }: ${ checked.reason }` )
        }

        return { ref: checked.ref }
    }


    // Read the payload and measure it. Returns the content AND its sha256 — the two things that are
    // needed together at every write edge (store the hash) and every inline read (compare the hash).
    static readAndHash( { base, memoDir, projectRoot, ref } ) {
        const { resolved, root } = PayloadPointer.resolveRef( { base, memoDir, projectRoot, ref } )
        if( existsSync( resolved ) !== true ) {
            throw new Error( `PayloadPointer.readAndHash: no payload at ${ resolved } (ref "${ ref }" under base "${ base }") — a missing source is a gap, never an empty result` )
        }

        const bytes = readFileSync( resolved )
        const sha256 = createHash( 'sha256' ).update( bytes ).digest( 'hex' )
        const content = bytes.toString( 'utf8' )
        const byteLength = statSync( resolved ).size

        return { resolved, root, content, sha256, byteLength }
    }


    // The checker. `expected` is the checksum stored in the row; `mode` decides the error branch.
    // A null/empty `expected` is NEVER matched — it is 'unhashed' ("never measured"), which is a gap,
    // not a pass. Under mode 'inline' every non-matched state throws; under 'reference' the state is
    // returned so the caller can render it as a gap.
    static verify( { base, memoDir, projectRoot, ref, expected, mode } ) {
        if( mode !== 'inline' && mode !== 'reference' ) {
            throw new Error( `PayloadPointer.verify: "mode" must be inline or reference — got "${ mode }"` )
        }

        const { resolved, root } = PayloadPointer.resolveRef( { base, memoDir, projectRoot, ref } )
        const hasExpected = typeof expected === 'string' && expected.length > 0
        const present = existsSync( resolved )
        const actual = present === true && hasExpected === true
            ? createHash( 'sha256' ).update( readFileSync( resolved ) ).digest( 'hex' )
            : null
        const state = PayloadPointer.#stateOf( { hasExpected, present, expected, actual } )
        const reason = PayloadPointer.#reasonOf( { state, resolved, expected, actual } )
        // `resolvedRef` is the resolution stated REPRODUCIBLY: base + the path relative to that base. A
        // renderer that names a gap must say where it looked, and the absolute `resolved` cannot be that
        // name — it would freeze one machine's home directory into a committed revision and break byte
        // parity everywhere else. Both are returned; a durable artefact uses base + resolvedRef.
        const resolvedRef = relative( root, resolved )
            .split( sep )
            .join( '/' )
        const result = { state, resolved, resolvedRef, root, ref, base, expected: hasExpected === true ? expected : null, actual, reason }

        if( mode === 'inline' && state !== STATE_MATCHED ) {
            throw new Error( `PayloadPointer.verify: inline payload "${ ref }" (base "${ base }") is ${ state } — ${ reason }` )
        }

        return result
    }


    // Read an inline payload THROUGH the check: the content is only handed out once the checksum agreed.
    // This is the order the error rule demands — verify, then interpolate; never interpolate, then notice.
    static readVerified( { base, memoDir, projectRoot, ref, expected } ) {
        const checked = PayloadPointer.verify( { base, memoDir, projectRoot, ref, expected, mode: 'inline' } )
        const { content, sha256, byteLength, resolved } = PayloadPointer.readAndHash( { base, memoDir, projectRoot, ref } )

        return { content, sha256, byteLength, resolved, state: checked.state }
    }


    // The reference point of ONE register entry, looked up by table name. Kept here so a caller holding
    // only a table name never has to rebuild the base itself (which is how three reference points drifted
    // apart in the first place).
    static rootOfSite( { table, memoDir, projectRoot } ) {
        const { site } = PointerSites.bySite( { table } )
        if( site === null ) {
            throw new Error( `PayloadPointer.rootOfSite: "${ table }" is not a declared pointer site — declare it in PointerSites, do not resolve it ad hoc` )
        }

        const { root } = PayloadPointer.#rootFor( { base: site.base, memoDir, projectRoot } )

        return { root, site }
    }


    // ---- private ----

    static #rootFor( { base, memoDir, projectRoot } ) {
        if( base === 'memo' ) {
            if( typeof memoDir !== 'string' || memoDir.length === 0 ) {
                throw new Error( 'PayloadPointer: base "memo" needs "memoDir" (non-empty string) — the reference point is never guessed' )
            }

            return { root: resolve( memoDir ) }
        }
        if( base === 'project' ) {
            if( typeof projectRoot !== 'string' || projectRoot.length === 0 ) {
                throw new Error( 'PayloadPointer: base "project" needs "projectRoot" (non-empty string) — the reference point is never guessed' )
            }

            return { root: resolve( projectRoot ) }
        }

        throw new Error( `PayloadPointer: unknown base "${ base }" — expected memo or project (declared per site in PointerSites)` )
    }


    static #assertInside( { resolved, root, base, ref } ) {
        const inside = resolved === root || resolved.startsWith( `${ root }${ sep }` ) === true
        if( inside !== true ) {
            throw new Error( `PayloadPointer: "${ ref }" leaves its base "${ base }" — the boundary is ${ root }, the path resolves to ${ resolved }` )
        }

        return { inside }
    }


    static #stateOf( { hasExpected, present, expected, actual } ) {
        if( hasExpected !== true ) {
            return STATE_UNHASHED
        }
        if( present !== true ) {
            return STATE_MISSING
        }

        return actual === expected ? STATE_MATCHED : STATE_MISMATCHED
    }


    static #reasonOf( { state, resolved, expected, actual } ) {
        if( state === STATE_MATCHED ) {
            return `checksum matched at ${ resolved }`
        }
        if( state === STATE_UNHASHED ) {
            return `never measured — the row carries no checksum for ${ resolved }`
        }
        if( state === STATE_MISSING ) {
            return `file missing at ${ resolved }`
        }

        return `checksum mismatch at ${ resolved }: expected ${ expected }, read ${ actual }`
    }
}


export { PayloadPointer, STATES, STATE_MATCHED, STATE_MISMATCHED, STATE_MISSING, STATE_UNHASHED }
