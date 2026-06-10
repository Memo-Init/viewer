import { describe, it, expect, beforeAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'


// PRD-006 + PRD-007 (Memo 019 Kap 6+7, Phase 4): the Pencil-v4 Sidebar + Sticky-Header redesign.
// The markup is produced by updateSidebarSticky / renderSidebarMemos inside the single inline
// <script> of the HTML page; the matching CSS lives in the page <style>. As in SidebarConformance
// we read the source and evaluate the escape-faithful script slice, asserting on emitted markup
// plus the source CSS. No server boot needed — the assertions are deterministic on the source.
describe( 'Sidebar + Sticky-Header v4 — PRD-006 / PRD-007 (Memo 019 Kap 6+7)', () => {
    let source = ''
    let emittedScript = ''


    beforeAll( async () => {
        const here = dirname( fileURLToPath( import.meta.url ) )
        const sourcePath = join( here, '..', '..', 'src', 'MemoView.mjs' )
        source = await readFile( sourcePath, 'utf8' )

        const open = source.lastIndexOf( '<script>' )
        const close = source.indexOf( '</script>', open )
        const rawSlice = source.slice( open + '<script>'.length, close )

        expect( rawSlice.includes( '${' ) ).toBe( false )

        // eslint-disable-next-line no-new-func — controlled, no interpolation, escape-faithful.
        const toRuntime = new Function( 'return `' + rawSlice.replace( /`/g, '\\`' ) + '`' )
        emittedScript = toRuntime()
    } )


    // ---- PRD-006 Kap 6.0 / AC-1: 3-Zonen-Modell mit stabilen DOM-Hooks. ----
    describe( 'AC-1 — 3-Zonen-Sticky-Header', () => {
        it( 'emits Zone 1 + Zone 2 wrappers with data-zone hooks', () => {
            expect( emittedScript.includes( 'class="hdr-zone hdr-zone-1" data-zone="1"' ) ).toBe( true )
            expect( emittedScript.includes( 'class="hdr-zone hdr-zone-2" data-zone="2"' ) ).toBe( true )
        } )

        it( 'keeps #main-header sticky so Zone 1 + Zone 2 stay fixed (Content scrolls)', () => {
            expect( /#main-header\s*\{[^}]*position:\s*sticky/.test( source ) ).toBe( true )
        } )

        it( 'Zone 3 (Content) lives in #content, NOT inside the sticky header', () => {
            // The content placeholder + #content scroll outside #main-header.
            expect( emittedScript.includes( 'data-zone="3"' ) ).toBe( false )
        } )
    } )


    // ---- PRD-006 Kap 6.1 / AC-2 / AC-4: Zone 1 gelockt — Titel + Status-Pill. ----
    describe( 'AC-2 / AC-4 — Zone 1 Titel + Status-Pill (nur Entwurf/Finalisiert)', () => {
        it( 'Zone 1 Zeile 1 carries title + pill hooks', () => {
            expect( emittedScript.includes( 'class="z1-line1" data-zone1-line1' ) ).toBe( true )
            expect( emittedScript.includes( 'class="z1-title" data-zone1-title' ) ).toBe( true )
            expect( emittedScript.includes( 'data-zone1-pill' ) ).toBe( true )
        } )

        it( 'the pill shows ONLY "Entwurf" or "Finalisiert" (no 3-state ball text in Zone 1)', () => {
            // The pill text is data-bound to the memoFinalized flag → Entwurf / Finalisiert.
            expect( emittedScript.includes( "var pillText = memoFinalized ? 'Finalisiert' : 'Entwurf'" ) ).toBe( true )
            // The 3-state ball pill (pillClassFor / ballStatus) is NOT used for the Zone-1 pill.
            expect( emittedScript.includes( 'mh-badge mh-pill ' ) ).toBe( false )
        } )

        it( 'Zone 1 contains NO "Prepare" and NO type/Full/Update badge (Badge-Reduktion)', () => {
            const z1 = emittedScript.slice(
                emittedScript.indexOf( 'data-zone="1"' ),
                emittedScript.indexOf( 'data-zone="2"' )
            )
            expect( z1.includes( 'Prepare' ) ).toBe( false )
            expect( z1.includes( 'rev-type' ) ).toBe( false )
            expect( z1.includes( 'mh-type-badge' ) ).toBe( false )
        } )

        it( 'Zone 1 title font-size is 17px / weight 700 (Soll BKYwK)', () => {
            expect( /\.z1-title\s*\{[^}]*font-size:\s*17px/.test( source ) ).toBe( true )
            expect( /\.z1-title\s*\{[^}]*font-weight:\s*700/.test( source ) ).toBe( true )
        } )

        it( 'Status-Pill geometry matches Soll NUj56 (radius 7, padding 3px 10px, 1.5px stroke)', () => {
            expect( /#main-header \.z1-pill\s*\{[^}]*border-radius:\s*7px/.test( source ) ).toBe( true )
            expect( /#main-header \.z1-pill\s*\{[^}]*padding:\s*3px 10px/.test( source ) ).toBe( true )
            expect( /#main-header \.z1-pill\s*\{[^}]*border:\s*1\.5px/.test( source ) ).toBe( true )
        } )
    } )


    // ---- PRD-006 Kap 6.2 / 6.5 / AC-3: Zone 1 Zeile 2 — Doc-Pfad + Datum + Typ + KB. ----
    describe( 'AC-3 — Zone 1 Zeile 2 (doc-path · Datum · Implementierung · KB)', () => {
        it( 'carries doc / date / type / kb hooks', () => {
            expect( emittedScript.includes( 'class="z1-doc" data-zone1-doc' ) ).toBe( true )
            expect( emittedScript.includes( 'data-zone1-date' ) ).toBe( true )
            expect( emittedScript.includes( 'data-zone1-type' ) ).toBe( true )
            expect( emittedScript.includes( 'data-zone1-kb' ) ).toBe( true )
        } )

        it( 'KB is sourced from the viewed revision sizeKb (Kap 6.5 — "echt wichtig")', () => {
            expect( emittedScript.includes( "var z1Kb = viewedRev && viewedRev.sizeKb ? ( viewedRev.sizeKb + ' KB' ) : ''" ) ).toBe( true )
        } )

        it( 'the doc-type label is "Implementierung"', () => {
            expect( emittedScript.includes( '>Implementierung</span>' ) ).toBe( true )
        } )
    } )


    // ---- PRD-006 Kap 6.6 / AC-5: Default — alle Memos UND Namespaces eingeklappt. ----
    describe( 'AC-5 — Default eingeklappt (Namespaces + Memos)', () => {
        it( 'seeds every memo into collapsedMemos once (seededCollapseMemos guard)', () => {
            expect( emittedScript.includes( 'const seededCollapseMemos = new Set()' ) ).toBe( true )
            expect( emittedScript.includes( 'seededCollapseMemos.add( m.documentId )' ) ).toBe( true )
            expect( emittedScript.includes( 'collapsedMemos.add( m.documentId )' ) ).toBe( true )
        } )

        it( 'still seeds namespaces collapsed (unchanged Phase-1 behaviour)', () => {
            expect( emittedScript.includes( 'collapsedProjects.add( projectId )' ) ).toBe( true )
        } )
    } )


    // ---- PRD-006 Kap 6.7 / AC-6: Echte Namespace-Box (3 Ebenen, keine 4.). ----
    describe( 'AC-6 — Namespace-Box (Namespace → Memo → Revision)', () => {
        it( 'renders an outer .ns-box per namespace with header + body hooks', () => {
            // boxCls is "ns-box" (+ optional collapsed mod) → the box class always starts ns-box.
            expect( emittedScript.includes( "var boxCls = 'ns-box'" ) ).toBe( true )
            expect( emittedScript.includes( 'class="ns-header" data-project=' ) ).toBe( true )
            expect( emittedScript.includes( 'class="ns-body" data-project-list=' ) ).toBe( true )
        } )

        it( 'NS-Header carries chevron + folder + name + count-chip "N Memos"', () => {
            expect( emittedScript.includes( 'data-ns-chevron' ) ).toBe( true )
            expect( emittedScript.includes( 'data-ns-name' ) ).toBe( true )
            expect( emittedScript.includes( 'data-ns-count' ) ).toBe( true )
            expect( emittedScript.includes( "memoCount + ' Memos</span>'" ) ).toBe( true )
        } )

        it( 'no longer emits the old flat sb-namespace / sb-ns-bar header', () => {
            expect( emittedScript.includes( 'sb-group-header sb-namespace' ) ).toBe( false )
        } )

        it( 'NS-Box geometry matches Soll npwAk (radius 10, 1.5px stroke); header height 42', () => {
            expect( /\.ns-box\s*\{[^}]*border-radius:\s*10px/.test( source ) ).toBe( true )
            expect( /\.ns-box\s*\{[^}]*border:\s*1\.5px/.test( source ) ).toBe( true )
            expect( /\.ns-header\s*\{[^}]*height:\s*42px/.test( source ) ).toBe( true )
        } )

        it( 'has exactly three hierarchy levels — no 4th (F5): no diff/frage sub-block class', () => {
            // The mini-widget is a single row (no nested revision sub-list).
            expect( emittedScript.includes( 'rev-mini-subblock' ) ).toBe( false )
        } )
    } )


    // ---- PRD-007 Kap 7.1 / AC-1 / AC-2: Revisions-Mini-Widget. ----
    // SUPERSEDED by Memo 022 Phase 3 (PRD-005/006): the rev-mini was redesigned. REV-NN is now
    // the prominent leading identifier (data-rev-num), the date is secondary, a mic+minutes chip
    // is the Leitkennzahl, and a dezentes Status-Symbol replaces the big "abgeschlossen" badge.
    // The doc-icon, the type-/FULL-badge and the funktionslosen Hover-Actions were removed.
    describe( 'PRD-007 / Memo 022 PRD-005 — Revisions-Mini-Widget (redesign)', () => {
        it( 'each revision renders a .rev-mini widget with state + transcript hooks', () => {
            expect( emittedScript.includes( "var cls = 'rev-mini'" ) ).toBe( true )
            expect( emittedScript.includes( 'data-rev-date' ) ).toBe( true )
            expect( emittedScript.includes( 'data-rev-num' ) ).toBe( true )
            expect( emittedScript.includes( 'data-rev-transcript=' ) ).toBe( true )
            expect( emittedScript.includes( 'data-state=' ) ).toBe( true )
        } )

        it( 'active revision gets rev-mini-active (fill/stroke), inactive stays quiet (AC-1)', () => {
            expect( emittedScript.includes( "cls += ' rev-mini-active'" ) ).toBe( true )
            expect( /li\.rev-mini\.rev-mini-active\s*\{/.test( source ) ).toBe( true )
        } )

        it( 'REV-NN is the prominent leading element (12px/600), date is secondary (Memo 022 Kap 9)', () => {
            expect( /\.rev-mini-num\s*\{[^}]*font-size:\s*12px/.test( source ) ).toBe( true )
            expect( /\.rev-mini-num\s*\{[^}]*font-weight:\s*600/.test( source ) ).toBe( true )
            expect( /\.rev-mini-date\s*\{[^}]*font-size:\s*10px/.test( source ) ).toBe( true )
        } )

        it( 'minutes chip (mic + "Min") is present as the Leitkennzahl (PRD-005 AC-4)', () => {
            expect( emittedScript.includes( 'data-rev-minutes=' ) ).toBe( true )
            expect( emittedScript.includes( ' Min</span>' ) ).toBe( true )
            expect( /\.rev-mini-minutes\s*\{/.test( source ) ).toBe( true )
        } )

        it( 'dezentes Status-Symbol replaces the big "abgeschlossen" text badge (PRD-005 AC-5)', () => {
            expect( emittedScript.includes( 'rev-mini-status' ) ).toBe( true )
            expect( emittedScript.includes( '>abgeschlossen</span>' ) ).toBe( false )
        } )

        it( 'no doc-icon and no type-/FULL-badge in the rev-mini widget (PRD-005 AC-1/AC-2)', () => {
            expect( emittedScript.includes( 'rev-mini-icon' ) ).toBe( false )
            expect( emittedScript.includes( 'rt-full">Full</span>' ) ).toBe( false )
        } )

        it( 'widget height 38, radius 7 (Soll 7RCLz/yesxz)', () => {
            expect( /li\.rev-mini\s*\{[^}]*min-height:\s*38px/.test( source ) ).toBe( true )
            expect( /li\.rev-mini\s*\{[^}]*border-radius:\s*7px/.test( source ) ).toBe( true )
        } )

        it( '1-line widget is vertically centered (AC-8 / Kap 6.8)', () => {
            expect( /li\.rev-mini\s*\{[^}]*align-items:\s*center/.test( source ) ).toBe( true )
        } )
    } )


    // ---- Memo 022 PRD-006: the funktionslosen Hover-Action-Icons were removed. ----
    describe( 'Memo 022 PRD-006 — Hover-Actions removed', () => {
        it( 'no rev-mini-actions markup is emitted anymore (PRD-006 AC-1)', () => {
            expect( emittedScript.includes( 'rev-mini-actions' ) ).toBe( false )
            expect( emittedScript.includes( 'data-rev-actions' ) ).toBe( false )
        } )

        it( 'no .rev-mini-act / .rev-mini-actions CSS rule remains in the source (PRD-006 AC-4)', () => {
            // Precise match — avoid the .rev-mini-active substring collision.
            expect( source.includes( '.rev-mini-actions' ) ).toBe( false )
            expect( /\.rev-mini-act\s*\{/.test( source ) ).toBe( false )
            expect( source.includes( '.rev-mini-act:hover' ) ).toBe( false )
        } )

        it( 'the hover chip-hide rule is gone so the Fragen-Chip stays visible on hover (AC-3)', () => {
            expect( /\.rev-mini:hover\s+\.rev-mini-chip\s*\{[^}]*display:\s*none/.test( source ) ).toBe( false )
        } )
    } )


    // ---- PRD-007 Kap 7.4 / AC-5: Queue-Item-Container (Namespace + Datum + offene Fragen). ----
    describe( 'PRD-007 AC-5 — Queue-Item info model', () => {
        it( 'queue items render a dedicated .queue-card (not the tree revision line)', () => {
            expect( emittedScript.includes( 'class="queue-card"' ) ).toBe( true )
            expect( emittedScript.includes( 'class="queue-card-bar"' ) ).toBe( true )
            expect( emittedScript.includes( 'data-queue-ns' ) ).toBe( true )
            expect( emittedScript.includes( 'data-queue-date' ) ).toBe( true )
            expect( emittedScript.includes( 'data-queue-chip' ) ).toBe( true )
        } )

        it( 'queue card has a 4px left accent bar + height 62 (Soll RdoSV)', () => {
            expect( /li\.queue-card\s*\{[^}]*min-height:\s*62px/.test( source ) ).toBe( true )
            expect( /\.queue-card-bar\s*\{[^}]*width:\s*4px/.test( source ) ).toBe( true )
        } )

        it( 'no longer reuses the old .rev-entry qe-entry markup for the queue', () => {
            expect( emittedScript.includes( 'rev-entry qe-entry' ) ).toBe( false )
        } )
    } )


    // ---- PRD-007 Kap 7.5 / AC-7 (revised): collapsed finalisiertes Memo — Minuten-Chip only. ----
    // The earlier design also added a green "finalisiert" badge to the memo-head; user feedback
    // dropped it because the orange "FINALISIERT" memo-badge already conveys the same state, and
    // the aggregate transcript-indicator pill was removed at the same time (per-revision indicators
    // remain on the rev entries). Keeps the memo-head at two lines for finalized memos with transcripts.
    describe( 'PRD-007 AC-7 (revised) — finalized collapsed memo shows the minutes chip only', () => {
        it( 'still emits the minutes chip for a finalized memo', () => {
            expect( emittedScript.includes( 'data-memo-minutes' ) ).toBe( true )
        } )

        it( 'no longer emits the redundant green mh-final-badge', () => {
            expect( emittedScript.includes( 'class="mh-final-badge"' ) ).toBe( false )
            expect( emittedScript.includes( 'data-memo-final' ) ).toBe( false )
        } )

        it( 'no longer emits the aggregate transcript-indicator pill in the memo-head', () => {
            expect( emittedScript.includes( 'class="transcript-indicator"' ) ).toBe( false )
        } )
    } )


    // ---- PRD-006 Kap 6.4 / AC-10: Fragezeichen-Indikator — vergroesserter Box-Abstand. ----
    describe( 'AC-10 — question-mark indicator with enlarged box spacing', () => {
        it( 'questions-link is a chip with gap (bigger spacing to the "?")', () => {
            expect( /\.questions-link\s*\{[^}]*gap:\s*5px/.test( source ) ).toBe( true )
            expect( /\.questions-link\s*\{[^}]*padding:/.test( source ) ).toBe( true )
            expect( emittedScript.includes( 'class="ql-q"' ) ).toBe( true )
        } )

        it( 'the rev-mini question chip also separates "?" from the number with a gap', () => {
            expect( /\.rev-mini-chip\s*\{[^}]*gap:\s*5px/.test( source ) ).toBe( true )
            expect( emittedScript.includes( 'class="rev-mini-chip-q"' ) ).toBe( true )
        } )
    } )
} )
