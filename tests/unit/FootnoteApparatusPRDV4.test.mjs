import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { extractFunctions } from '../helpers/extractFunction.mjs'


// Memo 080 PRD-V4 (Kap 16, WI-174 + WI-175): the viewer resolves markdown footnotes ITSELF before
// handing the markdown to marked, and the link interception decides on the NORMALISED target instead
// of the raw href. This project has NO jsdom (see A11yAndLabelsPRD013), so the DOM-near parts are
// asserted at SOURCE level and the pure functions are lifted out via extractFunctions.
//
// The REV-02/REV-18 runs read the REAL memo files. They live in the workbench .memo/ tree, which a
// standalone checkout of this repo (CI) does not have — so those cases are EXPLICITLY skipped there
// (jest reports "skipped", never a silent pass) and run as the real proof wherever the tree exists.
// Everything else in this suite is repo-local and always runs. A run that counts zero definitions is
// still asserted red — a pass without a comparison basis is no pass.
const MEMO_REVISIONS = join(
    '..', '..', '..', '..', '.memo', 'memos', '080-db-vollausbau-und-laufzeit-transparenz', 'revisions'
)
const HERE = dirname( fileURLToPath( import.meta.url ) )
const REAL_REV02 = join( HERE, MEMO_REVISIONS, 'REV-02.md' )
const REAL_REV18 = join( HERE, MEMO_REVISIONS, 'REV-18.md' )
const withTree = existsSync( REAL_REV02 ) && existsSync( REAL_REV18 ) ? it : it.skip

describe( 'footnote apparatus + link interception — Memo 080 PRD-V4 (WI-174, WI-175)', () => {
    let client = ''
    let parseFootnotes = null
    let resolveFootnoteTarget = null
    let buildFootnoteApparatus = null
    let classifyLinkHref = null
    let rev02 = ''
    let rev18 = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        client = await readFile( join( here, '..', '..', 'src', 'public', 'app.client.mjs' ), 'utf8' )
        const fns = await extractFunctions( [
            'escapeHtml',
            'escapeAttr',
            'resolveFootnoteTarget',
            'parseFootnotes',
            'buildFootnoteApparatus',
            'classifyLinkHref'
        ] )
        parseFootnotes = fns.parseFootnotes
        resolveFootnoteTarget = fns.resolveFootnoteTarget
        buildFootnoteApparatus = fns.buildFootnoteApparatus
        classifyLinkHref = fns.classifyLinkHref

        // Only read the workbench-only files where they exist; the guarded cases below are the
        // sole consumers and are skipped (never silently passed) when the tree is absent.
        if( existsSync( REAL_REV02 ) === true ) rev02 = await readFile( REAL_REV02, 'utf8' )
        if( existsSync( REAL_REV18 ) === true ) rev18 = await readFile( REAL_REV18, 'utf8' )
    } )


    // ---- Vorverarbeitung (A1-A8) ----
    describe( 'parseFootnotes (pure)', () => {
        it( 'A1 — removes every column-1 definition line outside a code fence', () => {
            const out = parseFootnotes( 'Text mit [^1] Beleg.\n\n[^1]: `context/a.md` — Quelle\n' )

            expect( out.markdown.includes( '[^1]: ' ) ).toBe( false )
            expect( out.footnotes ).toHaveLength( 1 )
            expect( out.footnotes[ 0 ].number ).toBe( 1 )
            expect( out.footnotes[ 0 ].label ).toBe( '1' )
            expect( out.footnotes[ 0 ].text ).toBe( '`context/a.md` — Quelle' )
        } )


        it( 'A2 — the same pattern INSIDE a fence stays untouched and produces no apparatus entry', () => {
            const md = [ 'Doku:', '', '```markdown', '[^18]: pfad.md', '```', '' ].join( '\n' )
            const out = parseFootnotes( md )

            expect( out.markdown.includes( '[^18]: pfad.md' ) ).toBe( true )
            expect( out.footnotes ).toEqual( [] )
        } )


        it( 'A3 — a marker inside an inline-code span stays a literal, one outside becomes a marker', () => {
            const md = 'Zitat `[^7]` bleibt, Verweis [^7] nicht.\n\n[^7]: `context/b.md`\n'
            const out = parseFootnotes( md )

            expect( out.markdown.includes( '`[^7]`' ) ).toBe( true )
            expect( out.markdown.includes( '<button type="button" class="fn-ref" id="fnref-1"' ) ).toBe( true )
            expect( ( out.markdown.match( /class="fn-ref"/g ) || [] ).length ).toBe( 1 )
        } )


        withTree( 'A4 — against the REAL REV-02.md: 56 entries, 0 leftover definition lines, 65 rewritten markers', () => {
            const out = parseFootnotes( rev02 )

            expect( out.footnotes.length ).toBeGreaterThan( 0 )
            expect( out.footnotes ).toHaveLength( 56 )
            expect( ( out.markdown.match( /^\[\^[0-9]+\]:/gm ) || [] ).length ).toBe( 0 )
            expect( ( out.markdown.match( /class="fn-ref"/g ) || [] ).length ).toBe( 65 )
            expect( out.unresolved ).toEqual( [] )
        } )


        withTree( 'A5 — against the REAL REV-18.md: 0 entries, and the quoted inline-code span survives verbatim', () => {
            expect( rev18.includes( '`[^18]: pfad.md`' ) ).toBe( true )
            const out = parseFootnotes( rev18 )

            expect( out.footnotes ).toEqual( [] )
            expect( out.markdown.includes( '`[^18]: pfad.md`' ) ).toBe( true )
            expect( out.markdown.includes( 'fn-ref' ) ).toBe( false )
        } )


        it( 'A6 — a marker without a definition stays literal and is reported as unresolved', () => {
            const out = parseFootnotes( 'Verweis [^9] ohne Beleg.\n' )

            expect( out.markdown.includes( '[^9]' ) ).toBe( true )
            expect( out.markdown.includes( 'fn-ref' ) ).toBe( false )
            expect( out.unresolved ).toEqual( [ '9' ] )
            expect( out.footnotes ).toEqual( [] )
        } )


        it( 'A7 — a definition without a marker still produces an entry, flagged as unreferenced', () => {
            const out = parseFootnotes( 'Kein Verweis hier.\n\n[^4]: `context/c.md`\n' )

            expect( out.footnotes ).toHaveLength( 1 )
            expect( out.footnotes[ 0 ].referenced ).toBe( false )
            expect( buildFootnoteApparatus( out.footnotes ).includes( 'ohne Verweis im Text' ) ).toBe( true )
        } )


        withTree( 'A8 — is idempotent: a second run over the result changes nothing', () => {
            const once = parseFootnotes( rev02 ).markdown
            const twice = parseFootnotes( once ).markdown

            expect( twice ).toBe( once )
        } )
    } )


    // ---- Ziel-Aufloesung (A9-A11) ----
    describe( 'resolveFootnoteTarget (pure)', () => {
        it( 'A9 — a memo-relative .md path in the FIRST inline-code span resolves to a doc target', () => {
            expect( resolveFootnoteTarget( '`context/research-db-ist-zustand.md` — Kap 4' ) )
                .toEqual( { target: 'context/research-db-ist-zustand.md', targetKind: 'doc' } )
        } )


        it( 'A9 — an optional :line / :from-to suffix is stripped before the .md test', () => {
            expect( resolveFootnoteTarget( '`context/a.md:12`' ) ).toEqual( { target: 'context/a.md', targetKind: 'doc' } )
            expect( resolveFootnoteTarget( '`context/a.md:12-40`' ) ).toEqual( { target: 'context/a.md', targetKind: 'doc' } )
        } )


        it( 'A10 — a code reference is evidence TEXT, never a doc target', () => {
            expect( resolveFootnoteTarget( '`repos/core/cli/src/DoltSchema.mjs:50-344` — via `context/x.md`' ) )
                .toEqual( { target: null, targetKind: 'text' } )
        } )


        it( 'A10 — traversal, absolute paths, http(s) schemes and text-only definitions stay text', () => {
            expect( resolveFootnoteTarget( '`../secret/a.md`' ).targetKind ).toBe( 'text' )
            expect( resolveFootnoteTarget( '`/etc/a.md`' ).targetKind ).toBe( 'text' )
            expect( resolveFootnoteTarget( '`https://example.com/a.md`' ).targetKind ).toBe( 'text' )
            expect( resolveFootnoteTarget( 'Snag-Sichtung, gegen HEAD verifiziert' ) )
                .toEqual( { target: null, targetKind: 'text' } )
        } )


        withTree( 'A11 — every REV-02 entry resolves into exactly one of the two classes', () => {
            const out = parseFootnotes( rev02 )
            const kinds = out.footnotes.map( ( entry ) => entry.targetKind )

            expect( kinds ).toHaveLength( 56 )
            expect( kinds.filter( ( k ) => k !== 'doc' && k !== 'text' ) ).toEqual( [] )
            expect( out.footnotes.filter( ( e ) => e.targetKind === 'doc' && e.target === null ) ).toEqual( [] )
        } )
    } )


    // ---- Darstellung (A12-A15) ----
    describe( 'marker + apparatus markup (pure)', () => {
        it( 'A12 — the marker is a CSP-safe <sup><button> with id/data-fn/target-kind/aria-describedby', () => {
            const out = parseFootnotes( 'Beleg [^1].\n\n[^1]: `context/a.md`\n' )

            expect( out.markdown.includes(
                '<sup class="fn-mark"><button type="button" class="fn-ref" id="fnref-1"'
                + ' data-fn="1" data-fn-target-kind="doc" aria-describedby="fn-1">1</button></sup>'
            ) ).toBe( true )
            expect( out.markdown.includes( 'onclick' ) ).toBe( false )
        } )


        it( 'A13 — the apparatus is a <section class="fn-apparatus"> with fn-entry items and back-refs', () => {
            const out = parseFootnotes( 'Beleg [^1].\n\n[^1]: `context/a.md` — Quelle\n' )
            const html = buildFootnoteApparatus( out.footnotes )

            expect( html.startsWith( '<section class="fn-apparatus">' ) ).toBe( true )
            expect( html.includes( '<li class="fn-entry" id="fn-1">' ) ).toBe( true )
            expect( html.includes( '<a class="fn-backref" href="#fnref-1"' ) ).toBe( true )
            expect( html.includes( 'data-fn-target="context/a.md"' ) ).toBe( true )
            expect( html.includes( 'onclick' ) ).toBe( false )
        } )


        it( 'A14 — definition text and target reach the DOM escaped, never raw', () => {
            const out = parseFootnotes( 'Beleg [^1].\n\n[^1]: <script>alert(1)</script> "x"\n' )
            const html = buildFootnoteApparatus( out.footnotes )

            expect( html.includes( '<script>' ) ).toBe( false )
            expect( html.includes( '&lt;script&gt;alert(1)&lt;/script&gt;' ) ).toBe( true )
        } )


        withTree( 'A15 — no footnotes means no apparatus section at all (no empty box)', () => {
            expect( buildFootnoteApparatus( [] ) ).toBe( '' )
            expect( buildFootnoteApparatus( undefined ) ).toBe( '' )
            expect( buildFootnoteApparatus( parseFootnotes( rev18 ).footnotes ) ).toBe( '' )
        } )
    } )


    // ---- WI-175 Abfang-Logik (A19-A24) ----
    describe( 'classifyLinkHref (pure)', () => {
        it( 'A19 — normalises: trim, decodeURIComponent, strip enclosing backticks', () => {
            expect( classifyLinkHref( '  context/a.md  ' ).href ).toBe( 'context/a.md' )
            expect( classifyLinkHref( '%60context/a.md%60' ).href ).toBe( 'context/a.md' )
            expect( classifyLinkHref( '`context/a.md`' ).href ).toBe( 'context/a.md' )
        } )


        it( 'A19 — a malformed percent sequence falls back to the raw value instead of throwing', () => {
            expect( () => classifyLinkHref( '%E0%A4%A' ) ).not.toThrow()
            expect( classifyLinkHref( '%E0%A4%A' ).href ).toBe( '%E0%A4%A' )
        } )


        it( 'A21 — http/https/mailto/tel and in-page anchors pass through untouched', () => {
            expect( classifyLinkHref( 'http://example.com' ).kind ).toBe( 'external' )
            expect( classifyLinkHref( 'https://example.com/a.md' ).kind ).toBe( 'external' )
            expect( classifyLinkHref( 'mailto:a@b.c' ).kind ).toBe( 'external' )
            expect( classifyLinkHref( 'tel:+49123' ).kind ).toBe( 'external' )
            expect( classifyLinkHref( '#fnref-20' ).kind ).toBe( 'anchor' )
            expect( classifyLinkHref( '#kapitel-16' ).kind ).toBe( 'anchor' )
        } )


        it( 'A23 — a leading slash stays an untouched SPA route', () => {
            expect( classifyLinkHref( '/memos' ).kind ).toBe( 'route' )
            expect( classifyLinkHref( '/specs' ).kind ).toBe( 'route' )
        } )


        it( 'A22 — a document-relative non-.md link is a dead end, never a browser navigation', () => {
            expect( classifyLinkHref( 'context/research-agent-hooks-gleichheit' ).kind ).toBe( 'dead' )
            expect( classifyLinkHref( 'repos/core/cli/src/DoltSchema.mjs' ).kind ).toBe( 'dead' )
            expect( classifyLinkHref( 'irgendwas' ).kind ).toBe( 'dead' )
        } )


        it( 'A24 — the historic %60…%60 case is recognised as an in-app document link', () => {
            const decision = classifyLinkHref( '%60context/research-agent-hooks-gleichheit.md%60' )

            expect( decision.kind ).toBe( 'doc' )
            expect( decision.href ).toBe( 'context/research-agent-hooks-gleichheit.md' )
        } )


        it( 'a plain .md link and one with an anchor/query suffix stay in-app', () => {
            expect( classifyLinkHref( 'revisions/REV-02.md' ).kind ).toBe( 'doc' )
            expect( classifyLinkHref( 'revisions/REV-02.md#kap-10' ).kind ).toBe( 'doc' )
        } )
    } )


    // ---- Quell-Ebene (A16-A20, A25, A26) — DOM behaviour is the Playwright/Sicht-Pruefung pass ----
    describe( 'wiring (source-level)', () => {
        it( 'A16 — all FOUR prose render sites go through renderMarkdownWithFootnotes', () => {
            expect( ( client.match( /renderMarkdownWithFootnotes\( lastContent \)\.html/g ) || [] ).length ).toBe( 2 )
            expect( client.includes( 'renderMarkdownWithFootnotes( data.content ).html' ) ).toBe( true )
            expect( client.includes( "back + renderMarkdownWithFootnotes( ( payload && payload.content ) || '' ).html" ) ).toBe( true )
            expect( ( client.match( /wireFootnoteRefs\( contentEl \)/g ) || [] ).length ).toBe( 4 )
        } )


        it( 'A16 — none of the four sites calls marked.parse directly any more', () => {
            expect( client.includes( 'contentEl.innerHTML = marked.parse( lastContent )' ) ).toBe( false )
            expect( client.includes( 'contentEl.innerHTML = marked.parse( data.content )' ) ).toBe( false )
            expect( client.includes( 'back + marked.parse(' ) ).toBe( false )
            expect( client.includes( 'function renderMarkdownWithFootnotes( markdown )' ) ).toBe( true )
        } )


        it( 'A17 — wireFootnoteRefs runs BEFORE interceptLinks, and the apparatus lands before buildTOC', () => {
            expect( /renderMarkdownWithFootnotes\( lastContent \)\.html\s*\n\s*wireFootnoteRefs\( contentEl \)\s*\n\s*interceptLinks\(\)/
                .test( client ) ).toBe( true )

            const prose = client.slice(
                client.indexOf( 'function renderProseContent( preserveScroll )' ),
                client.indexOf( 'async function loadRequirementsView( documentId )' )
            )
            expect( prose.indexOf( 'renderMarkdownWithFootnotes' ) ).toBeGreaterThan( -1 )
            expect( prose.indexOf( 'renderMarkdownWithFootnotes' ) ).toBeLessThan( prose.indexOf( 'buildTOC(' ) )
        } )


        it( 'A17 — the apparatus heading is an h2 so buildTOC lists it instead of tearing the TOC apart', () => {
            const html = buildFootnoteApparatus( parseFootnotes( 'Beleg [^1].\n\n[^1]: `context/a.md`\n' ).footnotes )

            expect( html.includes( '<h2 id="fn-apparatus">' ) ).toBe( true )
        } )


        it( 'A19/A20 — interceptLinks decides on the normalised target and sends exactly that path', () => {
            const intercept = client.slice(
                client.indexOf( 'function classifyLinkHref( href )' ),
                client.indexOf( 'function connect()' )
            )
            expect( intercept.includes( 'decodeURIComponent( raw )' ) ).toBe( true )
            expect( /try \{\s*\n\s*decoded = decodeURIComponent\( raw \)\s*\n\s*\} catch\(/.test( intercept ) ).toBe( true )
            expect( intercept.includes( 'classifyLinkHref( link.getAttribute( \'href\' ) )' ) ).toBe( true )
            expect( intercept.includes( "{ type: 'navigate', path: decision.href }" ) ).toBe( true )
            expect( intercept.includes( "{ type: 'navigate', path: href }" ) ).toBe( false )
        } )


        it( 'A25/A26 — the new code is function declarations, 4-space steps, no for/while, no semicolons', () => {
            const block = client.slice(
                client.indexOf( 'function parseFootnotes( markdown )' ),
                client.indexOf( "const contentEl = document.getElementById( 'content' )" )
            )
            const intercept = client.slice(
                client.indexOf( 'function classifyLinkHref( href )' ),
                client.indexOf( 'function connect()' )
            )

            expect( block.length ).toBeGreaterThan( 0 )
            expect( intercept.length ).toBeGreaterThan( 0 )
            const declared = [
                'function parseFootnotes( markdown )',
                'function resolveFootnoteTarget( definitionText )',
                'function buildFootnoteApparatus( footnotes )',
                'function renderMarkdownWithFootnotes( markdown )',
                'function wireFootnoteRefs( rootEl )'
            ]
            declared.forEach( ( decl ) => { expect( block.includes( decl ) ).toBe( true ) } )
            expect( /\b(for|while)\s*\(/.test( block ) ).toBe( false )
            expect( /\b(for|while)\s*\(/.test( intercept ) ).toBe( false )
            expect( /;\s*\n/.test( block ) ).toBe( false )
            expect( /;\s*\n/.test( intercept ) ).toBe( false )
        } )


        it( 'the app stylesheet carries the marker / apparatus / back-ref rules', async () => {
            const here = dirname( fileURLToPath( import.meta.url ) )
            const css = await readFile( join( here, '..', '..', 'src', 'public', 'app.css' ), 'utf8' )
            const rules = [
                '.fn-mark',
                '.fn-ref',
                '.fn-ref:hover',
                '.fn-ref:focus-visible',
                '.fn-apparatus',
                '.fn-apparatus h2',
                '.fn-entry',
                '.fn-entry:target',
                '.fn-entry-target',
                '.fn-entry-orphan',
                '.fn-backref'
            ]

            rules.forEach( ( rule ) => { expect( css.includes( rule + ' ' ) ).toBe( true ) } )
        } )
    } )
} )
