        // Memo 080, PRD-V2 rework: the source-length limit is DECLARED here instead of being inherited as an
        // invisible library default. Measured in real Chromium against the pinned mermaid@11.4.1 CDN build:
        // getConfig().maxTextSize is 50000, and a source above it is NOT rejected — mermaid discards it and
        // resolves with a one-node placeholder tile, which is why an oversize graph looked like a success.
        // The server's graph budget (DoltDbAssembler GRAPH_SOURCE_BUDGET) sits BELOW this number, and the
        // renderer entry below measures every source against it before and after drawing.
        var MERMAID_MAX_TEXT_SIZE = 50000
        // mermaid's own substitution text. Its presence in a RESULT that is absent from the SOURCE is the
        // proof that the library replaced the diagram instead of drawing it.
        var MERMAID_OVERSIZE_MARKER = 'Maximum text size in diagram exceeded'

        mermaid.initialize({
            startOnLoad: false,
            theme: 'default',
            // PRD-015 (D10): 'strict' (was 'loose') so mermaid sanitises diagram-embedded HTML/JS
            // instead of trusting it — the rendered SVG is set via el.innerHTML, so a 'loose' diagram
            // was a stored-content injection surface. Strict keeps the error-fallback path intact
            // (buildMermaidErrorHtml escapes its own output).
            securityLevel: 'strict',
            maxTextSize: MERMAID_MAX_TEXT_SIZE
        })

        const renderer = new marked.Renderer()
        const originalCodeRenderer = renderer.code.bind( renderer )
        const slugCounts = new Map()

        // Memo 038 Kap 13: realistic dictation speed for spoken transcript minutes (~110-150 wpm).
        // The browser mirror of MemoView/TranscriptRegistry SPOKEN_WORDS_PER_MINUTE — replaces the
        // too-fast magic 200 so the sidebar/queue/zone-2 spoken estimates match the server.
        var SPOKEN_WORDS_PER_MINUTE = 130

        // Memo 038 Kap 13: dedupe transcript entries by identity (url|id|transcriptId) before summing
        // their words, so a doubly-registered transcript is not double-counted. Entries without a key
        // are kept (no invented identity). Mirror of MemoView.#dedupeTranscripts.
        function dedupeTranscripts( list ) {
            var seen = {}
            return ( list || [] ).filter( function( entry ) {
                var key = entry && ( entry.url || entry.id || entry.transcriptId )
                if( typeof key !== 'string' || key.length === 0 ) { return true }
                if( seen[ key ] ) { return false }
                seen[ key ] = true
                return true
            } )
        }

        // PRD-007 (D3/D7): ONE slug algorithm — mirrors MemoView.slugify 1:1. Used for heading
        // ids AND the diff-banner anchors so a banner link always lands on its heading, even with
        // Umlaut/Em-dash/punctuation. Punctuation collapses to a SEPARATOR (not stripped, D7) so
        // distinct headings never collide into a renumber.
        function slugify( text ) {
            return String( text == null ? '' : text )
                .toLowerCase()
                .replace( /ä/g, 'ae' )
                .replace( /ö/g, 'oe' )
                .replace( /ü/g, 'ue' )
                .replace( /ß/g, 'ss' )
                .replace( /[^a-z0-9]+/g, '-' )
                .replace( /^-+|-+$/g, '' )
        }

        // PRD-015 (D10): escape any string that is built from memo content before it is interpolated
        // into banner HTML (changed-chapter labels, skipped-update names). Escapes the four characters
        // that matter for an attribute/text context so a chapter title can never break out into markup.
        function escapeHtml( value ) {
            return String( value == null ? '' : value )
                .replace( /&/g, '&amp;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
                .replace( /"/g, '&quot;' )
                .replace( /'/g, '&#39;' )
        }

        // PRD-007 (D1): a block-meta fence must NOT render as a raw JSON code block in prose. It
        // is rendered INLINE as a compact Block-Card (Memo decision F2). The card lists the block's
        // machine-links (id, topics, prds, repos, tags) escaped as text; malformed JSON degrades to
        // an empty card rather than throwing, so a broken fence never breaks the whole render.
        function buildBlockMetaCard( raw ) {
            function esc( v ) {
                return String( v == null ? '' : v )
                    .replace( /&/g, '&amp;' )
                    .replace( /</g, '&lt;' )
                    .replace( />/g, '&gt;' )
            }
            var data = {}
            try {
                data = JSON.parse( raw )
            } catch( e ) {
                data = {}
            }
            var rows = []
            if( data.id ) { rows.push( '<span class="block-meta-id">' + esc( data.id ) + '</span>' ) }
            var topics = data.topic ? [ data.topic ] : ( Array.isArray( data.topics ) ? data.topics : [] )
            if( topics.length ) { rows.push( '<span class="block-meta-chip">Topics: ' + esc( topics.join( ', ' ) ) + '</span>' ) }
            if( Array.isArray( data.prds ) && data.prds.length ) { rows.push( '<span class="block-meta-chip">PRDs: ' + esc( data.prds.join( ', ' ) ) + '</span>' ) }
            if( Array.isArray( data.repos ) && data.repos.length ) { rows.push( '<span class="block-meta-chip">Repos: ' + esc( data.repos.join( ', ' ) ) + '</span>' ) }
            if( Array.isArray( data.tags ) && data.tags.length ) { rows.push( '<span class="block-meta-chip">Tags: ' + esc( data.tags.join( ', ' ) ) + '</span>' ) }

            return '<div class="block-meta-card"><span class="block-meta-label">Block</span>' + rows.join( '' ) + '</div>'
        }

        renderer.code = function( token ) {
            if( diagramRegistry[ token.lang ] ) {
                // PRD-003 (Memo 076 WI-031): the raw diagram source goes ESCAPED into a data-src
                // attribute with an EMPTY body — never interpolated unescaped into innerHTML. Otherwise
                // the browser parses <br/>, HTML entities and [[slug]] inside token.text before
                // renderAllDiagrams ever reads them back. getAttribute('data-src') returns the source
                // 1:1 (entity roundtrip, NO tag interpretation); the body stays empty until the SVG lands.
                return '<div class="' + token.lang + '" data-src="' + escapeHtml( token.text ) + '"></div>'
            }

            if( token.lang === 'block-meta' ) {
                return buildBlockMetaCard( token.text )
            }

            return originalCodeRenderer( token )
        }

        renderer.heading = function( token ) {
            var text = token.text
            var level = token.depth
            var inner
            try {
                inner = this.parser && this.parser.parseInline ? this.parser.parseInline( token.tokens ) : marked.parseInline( text )
            } catch( e ) {
                inner = text
            }
            if( level === 2 || level === 3 ) {
                var slug = slugify( text )
                var count = slugCounts.get( slug ) || 0
                slugCounts.set( slug, count + 1 )
                var finalSlug = count === 0 ? slug : slug + '-' + count
                return '<h' + level + ' id="' + finalSlug + '">' + inner + '</h' + level + '>\n'
            }
            return '<h' + level + '>' + inner + '</h' + level + '>\n'
        }

        // PRD-015 (D9): configure marked explicitly with GFM so pipe-tables and GitHub-flavoured
        // markdown render reliably (previously left to the library default, which could drift across
        // marked versions). `gfm: true` enables tables + strikethrough; `breaks: false` keeps GFM's
        // standard paragraph behaviour. Table CSS already exists in app.css (table / th, td / th).
        marked.setOptions( { renderer, gfm: true, breaks: false } )

        // PRD-V4 (Memo 080 Kap 16, WI-174): markdown footnotes are resolved HERE, BEFORE marked ever
        // sees them. `marked` is loaded from the CDN with an SRI hash and WITHOUT a footnote extension,
        // so a `[^1]: ...` line is read as a CommonMark link-reference definition: almost all of them
        // fall back to a raw paragraph inside the prose, and the one that ends title-shaped turns into
        // an <a> onto a dead route. Removing the definitions up front kills both symptoms at once and
        // lets us render a real, numbered reference apparatus at the end of the document instead.
        //
        // parseFootnotes( markdown ) -> { markdown, footnotes, unresolved }
        //   markdown    the source WITHOUT the definition lines, markers rewritten to <sup> markup
        //   footnotes   [ { number, label, text, target, targetKind, referenced } ] in definition order
        //   unresolved  [ label ] markers that carry no definition — left as a literal `[^N]` in the text
        // Fence-aware (``` / ~~~) and inline-code-aware (backtick runs): a definition or a marker quoted
        // inside code stays untouched. That is what keeps REV-18 Kap 16 and the research document
        // readable — they DOCUMENT the defect and must not be rewritten by the fix.
        function parseFootnotes( markdown ) {
            var source = String( markdown == null ? '' : markdown )

            // Pass 1 — tag every line with its fenced-code state. The fence line itself counts as
            // "inside" so an opening/closing ``` is never mistaken for prose.
            var scan = source.split( '\n' ).reduce( function( acc, line ) {
                if( /^\s*(```|~~~)/.test( line ) ) {
                    acc.rows.push( { line: line, inFence: true } )
                    acc.open = !acc.open

                    return acc
                }
                acc.rows.push( { line: line, inFence: acc.open } )

                return acc
            }, { open: false, rows: [] } )

            // Pass 2 — collect the definitions (column 1, outside a fence) in order of appearance.
            // The apparatus number is the ordinal, the label is the number written in the source.
            var defs = []
            scan.rows.forEach( function( row ) {
                if( row.inFence ) { return }
                var hit = row.line.match( /^\[\^([0-9]+)\]:[ \t]?(.*)$/ )
                if( !hit ) { return }
                var resolved = resolveFootnoteTarget( hit[ 2 ] )
                defs.push( {
                    number: defs.length + 1,
                    label: hit[ 1 ],
                    text: hit[ 2 ].trim(),
                    target: resolved.target,
                    targetKind: resolved.targetKind,
                    referenced: false
                } )
            } )

            var byLabel = new Map()
            defs.forEach( function( def ) {
                if( byLabel.has( def.label ) ) { return }
                byLabel.set( def.label, def )
            } )

            // Pass 3 — drop the definition lines, rewrite the remaining markers.
            var unresolved = []
            var out = scan.rows
                .filter( function( row ) {
                    if( row.inFence ) { return true }

                    return !/^\[\^[0-9]+\]:/.test( row.line )
                } )
                .map( function( row ) {
                    if( row.inFence ) { return row.line }

                    // Inline-code awareness: split on backtick RUNS. Everything between a matching
                    // pair of runs is code and stays literal; only the segments outside are rewritten.
                    var openRun = ''

                    return row.line
                        .split( /(`+)/ )
                        .map( function( segment ) {
                            if( /^`+$/.test( segment ) ) {
                                if( openRun === '' ) { openRun = segment }
                                else if( openRun === segment ) { openRun = '' }

                                return segment
                            }
                            if( openRun !== '' ) { return segment }

                            return segment.replace( /\[\^([0-9]+)\]/g, function( whole, label ) {
                                var def = byLabel.get( label )
                                if( !def ) {
                                    // A marker is NEVER silently dropped — an orphan marker stays a
                                    // literal and is reported back so the author can see the gap.
                                    if( unresolved.indexOf( label ) === -1 ) { unresolved.push( label ) }

                                    return whole
                                }
                                def.referenced = true

                                return '<sup class="fn-mark"><button type="button" class="fn-ref" id="fnref-' + def.number
                                    + '" data-fn="' + def.number
                                    + '" data-fn-target-kind="' + def.targetKind
                                    + '" aria-describedby="fn-' + def.number + '">' + def.number + '</button></sup>'
                            } )
                        } )
                        .join( '' )
                } )

            return { markdown: out.join( '\n' ), footnotes: defs, unresolved: unresolved }
        }

        // PRD-V4 (Memo 080 Kap 16): resolve the FIRST inline-code span of a definition into a document
        // target. Conservative on purpose (the memo does not decide research question 1): only a
        // memo-relative .md path counts as a document, so no read ever leaves the memo folder. A code
        // reference like `repos/core/cli/src/DoltSchema.mjs:50-344` stays plain evidence text.
        function resolveFootnoteTarget( definitionText ) {
            var span = String( definitionText == null ? '' : definitionText ).match( /`([^`]+)`/ )
            if( !span ) { return { target: null, targetKind: 'text' } }

            var candidate = span[ 1 ].trim().replace( /:[0-9]+(-[0-9]+)?$/, '' )
            if( candidate.indexOf( '..' ) !== -1 ) { return { target: null, targetKind: 'text' } }
            if( candidate.charAt( 0 ) === '/' ) { return { target: null, targetKind: 'text' } }
            if( /^https?:/i.test( candidate ) ) { return { target: null, targetKind: 'text' } }
            if( !/^[A-Za-z0-9._/-]+\.md$/.test( candidate ) ) { return { target: null, targetKind: 'text' } }

            return { target: candidate, targetKind: 'doc' }
        }

        // PRD-V4 (Memo 080 Kap 16): the reference apparatus at the end of the document — numbered
        // entries, resolved target, evidence text and a back-jump to the marker. Returns '' for an
        // empty list so documents WITHOUT footnotes never grow an empty box. The heading is an h2 so
        // buildTOC picks it up as a regular chapter. data-fn-target is the documented anchor point a
        // later overlay (PRD-V6) binds to; it is set here even though nobody reads it yet.
        function buildFootnoteApparatus( footnotes ) {
            var list = Array.isArray( footnotes ) ? footnotes : []
            if( list.length === 0 ) { return '' }

            var items = list
                .map( function( entry ) {
                    var head = entry.targetKind === 'doc'
                        ? '<span class="fn-entry-target" data-fn-target="' + escapeAttr( entry.target )
                            + '" data-fn-target-kind="doc">' + escapeHtml( entry.target ) + '</span>'
                        : ''
                    // A9/A10 keep evidence that is not a document as plain text — but a definition that
                    // nobody references is NEVER discarded, it is shown and flagged instead.
                    var orphan = entry.referenced ? '' : '<span class="fn-entry-orphan">ohne Verweis im Text</span>'

                    return '<li class="fn-entry" id="fn-' + entry.number + '">'
                        + head
                        + '<span class="fn-entry-text">' + escapeHtml( entry.text ) + '</span>'
                        + orphan
                        + '<a class="fn-backref" href="#fnref-' + entry.number + '" title="Zurueck zur Fundstelle">&#8617;</a>'
                        + '</li>'
                } )
                .join( '' )

            return '<section class="fn-apparatus"><h2 id="fn-apparatus">Referenzen</h2>'
                + '<ol class="fn-list">' + items + '</ol></section>'
        }

        // PRD-V4 (Memo 080 Kap 16): THE prose render path. All four prose render sites go through this
        // one function, so the footnote resolution can never land at three of four places again.
        function renderMarkdownWithFootnotes( markdown ) {
            var parsed = parseFootnotes( markdown )
            var html = marked.parse( parsed.markdown )

            return { html: html + buildFootnoteApparatus( parsed.footnotes ), footnotes: parsed.footnotes }
        }

        // PRD-V4 (Memo 080 Kap 16): bind the footnote markers WITHOUT an inline onclick (CSP-safe,
        // same rule the diff-chapter link already follows). A click stays inside the document — it
        // scrolls to the apparatus entry and moves focus there. Idempotent via a dataset flag, so a
        // repeated wiring pass never stacks a second listener on the same button.
        function wireFootnoteRefs( rootEl ) {
            if( !rootEl || !rootEl.querySelectorAll ) { return }

            rootEl.querySelectorAll( '.fn-ref' ).forEach( function( btn ) {
                if( btn.dataset.fnBound === '1' ) { return }
                btn.dataset.fnBound = '1'

                btn.addEventListener( 'click', function( e ) {
                    e.preventDefault()
                    var entry = document.getElementById( 'fn-' + btn.getAttribute( 'data-fn' ) )
                    if( !entry ) { return }

                    entry.setAttribute( 'tabindex', '-1' )
                    entry.scrollIntoView( { behavior: 'smooth', block: 'center' } )
                    entry.focus()
                } )
            } )
        }

        const contentEl = document.getElementById( 'content' )
        const statusEl = document.getElementById( 'status' )

        let reconnectTimer = null
        let currentWs = null
        const history = []
        let currentDiff = null
        // Memo 081, WI-105: showDiff used to start at true and be RESET on every incoming content
        // message (showDiff = hasDiff), so the reader's decision survived exactly until the next click
        // and the view was open by default on every single one. That is why "the diff is sent even
        // though nobody looks at it" was not the everyday case — and why a requestDiff message alone
        // would have saved nothing: the client would have asked back immediately. The preference is the
        // reader's now and persists across revisions; diffAvailable only decides whether the toggle is
        // OFFERED, never whether it is ON.
        let showDiff = false
        // The announcement of the current revision (server: diffAvailable/diffInfo) and the pair the
        // diff on screen belongs to. currentDiffKey is what makes a LATE answer discardable: a reply
        // naming a revision the reader has already left is dropped instead of painted.
        let diffAvailable = false
        let diffInfo = null
        let currentDiffKey = null
        let requestedDiffKey = null
        let lastContent = ''
        let lastQuestionSchema = []
        let lastVorwort = ''
        // PRD-Q3 (Memo 080, Kap 25): the validator result of the last content broadcast. The server
        // has been attaching `validation` to EVERY content message since PRD-040 — until now nobody
        // read it, so the non-blocking INFO hints of the shared validator only ever reached the CLI.
        // `undefined` means "no broadcast seen yet"; `null` means the server could not validate at
        // all, which is rendered as a stated gap, never as an empty (reassuring) band.
        let lastValidation = undefined
        let isFirstLoad = true
        // PRD-009 (Memo 024 Kap 7, F5=A): the last seen queue-key snapshot drives the Audio-Notify
        // diff. null = no snapshot yet (initial load) — the first renderSidebar only seeds it and
        // never plays a ton (no-spam-on-startup, AC-04). Keys are documentId::fileName strings.
        let lastQueueKeys = null
        // PRD-009: a single shared AudioContext, lazily created and only after the first user
        // gesture so a blocked context never throws (autoplay policy, AC-06).
        let notifyAudioCtx = null
        // E4 (Memo 016 Kap 2): no AudioContext may be constructed before a user gesture, and
        // there must be exactly ONE instance (no per-call leak). This flag is flipped once on the
        // first pointerdown/keydown; acquireNotifyAudioCtx gates context creation on it.
        let audioGestureSeen = false
        let currentFileName = ''
        let currentMemoName = ''
        // Memo 079 M3=A (T059): when a served research MD is open as an annotatable view, this holds its
        // memoDir-relative path (else null). saveAnnotation reads it to POST targetKind:'research' +
        // researchFile instead of the revision default; it is cleared whenever a normal revision renders.
        let currentResearchFile = null
        // PRD-V6 (Memo 080 Kap 16, WI-177): the memoDir-relative path shown in the #research-modal
        // overlay (else null). Separate from currentResearchFile on purpose — the overlay is the
        // LOOK-UP level and is NOT annotatable, so it must never make saveAnnotation post
        // targetKind:'research'. The "Vollansicht" bridge reads it to hand the same file to
        // openResearchDoc, which is where annotating still happens.
        let researchOverlayFile = null
        // PRD-012 (Memo 011 Kap 4, F16=A): track the active documentId so the requirements view
        // can fetch /api/documents/<id>/requirements for the currently selected memo.
        let currentDocumentId = ''
        // PRD-009 (Memo 016 Kap 7, F4/E6/E7/F10): the view-mode state for the #content area —
        // 'prose' (home), 'requirements' or 'blocks'. Drives the non-destructive panel switch
        // (toggle-off back to prose, .active indicator) and gates the WS content broadcast so an
        // open Req/Blocks panel is not overwritten (MemoView.nextViewState / shouldRerenderOnBroadcast).
        let currentContentView = 'prose'
        let reconnectAttempts = 0
        // E1 (Memo 016 Kap 2): capped exponential backoff. A dead/duplicate server must not
        // flood the console with an endless 2s reconnect loop. After MAX attempts we stop and
        // stay offline; a page reload (or the server returning) re-arms via the initial connect().
        const MAX_RECONNECT_ATTEMPTS = 8
        const RECONNECT_BASE_MS = 2000
        const RECONNECT_MAX_MS = 30000
        const collapsedProjects = new Set()
        const collapsedMemos = new Set()
        // Memo 081 (WI-070): which memos have their HIDDEN revisions revealed. Default empty — the
        // configured view stays what it was (showOnlyFullRevisions, § S3); what changes is that the
        // hidden ones are reachable at all. Kept beside the two collapse sets on purpose: it is the same
        // kind of per-session view state, and computeSidebarSignature has to see it or the next
        // documentList broadcast silently folds the row back up.
        const revealedMemos = new Set()
        // Memo 081, WI-106/WI-107: which projects this connection has asked for depth for, and which
        // request is still in flight. Both drive the markup (a project waiting for its revision lists
        // shows a named loading row), so both are part of computeSidebarSignature — a signature blind
        // to them would skip exactly the redraw the answer to our own question triggers.
        const scopedProjects = new Set()
        const pendingScopeProjects = new Set()
        // PRD-016 (Memo 016 Kap 6.1): namespaces default to COLLAPSED. We track which
        // namespaces have already been seeded into collapsedProjects so a later re-render
        // never re-collapses a group the user has manually expanded.
        const seededCollapseProjects = new Set()
        // PRD-006 (Memo 019 Kap 6.6): memos ALSO default to COLLAPSED on first open. Mirror the
        // namespace seed-once guard so a memo a user manually expanded is never re-collapsed.
        const seededCollapseMemos = new Set()
        // PRD-016 (Memo 072 WI-T011-4): the Transcripts tab renders its OWN namespace tree
        // (renderSidebarTranscripts) mirroring the Memos tree. It MUST keep separate collapse-state
        // sets so collapsing a namespace/memo in one tab never moves the other tab's tree.
        const collapsedTranscriptProjects = new Set()
        const collapsedTranscriptMemos = new Set()
        const seededCollapseTranscriptProjects = new Set()
        const seededCollapseTranscriptMemos = new Set()
        // PRD-006 (Memo 076, Phase 4, WI-058/059): the Specs tab renders its OWN namespace tree
        // (renderSidebarSpecs) mirroring the Memos/Transcripts trees. Namespaces default to
        // COLLAPSED via a seed-once guard so a namespace a user manually expanded is never
        // re-collapsed on a re-render, and the collapse-state lives OUTSIDE the DOM so it survives
        // the innerHTML rebuild. collapsedSpecSubs (WI-066) is the second collapse level per
        // namespace sub-group (key: namespace + '::' + sub.label); sub-groups default EXPANDED, so
        // expanding a namespace directly reveals its pages.
        const collapsedSpecNamespaces = new Set()
        const seededCollapseSpecNamespaces = new Set()
        const collapsedSpecSubs = new Set()
        let currentMode = 'memos'
        let lastTree = {}
        let lastLatest = []
        let lastTranscriptTree = {}
        // PRD-P3-02 (Memo 075 Phase 3, WI-009): the last client registry snapshot from the clientList
        // WS broadcast. Drives the Clients overlay (renderClientsModal), the head summary and the
        // memos-view instance chip (PRD-002, Memo 076).
        let lastClients = []
        // PRD-P3-04/05/06 (Memo 075 Phase 3, WI-012/013): the annotations of the currently viewed memo.
        // Fetched on content load + refreshed by the annotationList WS broadcast; rendered idempotently
        // by applyAnnotations() as <mark>/row-badges. Orphans (no anchor match) are surfaced, not dropped.
        let lastAnnotations = []
        // PRD-V7 (Memo 080 Kap 16, T082): a chapter slug remembered across a revision switch. Clicking a
        // chapter in an annotation's "eingearbeitet in"-back-reference navigates to the OTHER revision
        // first; the anchor can only be resolved once that document has rendered, so the render pass
        // (applyAnnotations) redeems and clears it. null = nothing pending.
        let pendingChapterAnchor = null
        let pendingQuestionsScroll = false
        // PRD-016 (Memo 016, E8): no-op-skip guard. renderSidebar() does a full innerHTML rebuild
        // on every WS broadcast (flicker + CPU). We keep the signature of the data that produced
        // the last render; when an incoming broadcast yields the identical signature the rebuild
        // is skipped (sidebarSignatureChanged === false). null = nothing rendered yet (forces a
        // first render). The signature also folds in collapse-state so a user toggle still redraws.
        let lastSidebarSignature = null

        // PRD-016 (Memo 016, E9): the visible offline banner. The old 6px #status dot only
        // showed at attempts >= 2 (effectively invisible). The banner is shown from the FIRST
        // failed attempt — its visibility is decided by MemoView.offlineBannerVisible (mirrored
        // here so a disconnect is immediately obvious). Connected always hides it.
        var offlineBannerEl = document.getElementById( 'offline-banner' )

        function offlineBannerVisible( state, attempts ) {
            if( state === 'connected' ) { return false }
            var safeAttempts = ( typeof attempts === 'number' && attempts > 0 ) ? attempts : 0

            return safeAttempts >= 1
        }

        function updateConnectionStatus( state ) {
            if( state === 'connected' ) {
                statusEl.classList.add( 'connected' )
                statusEl.title = 'Server verbunden'
                reconnectAttempts = 0
            } else {
                statusEl.classList.remove( 'connected' )
                statusEl.title = 'Offline — Server nicht erreichbar'
            }
            if( offlineBannerEl ) {
                var show = offlineBannerVisible( state, reconnectAttempts )
                offlineBannerEl.classList.toggle( 'offline-banner-hidden', !show )
                offlineBannerEl.setAttribute( 'aria-hidden', show ? 'false' : 'true' )
            }
        }

        // Memo 075 Phase 3 (PRD-P3-02): the M072 global SESSION head (Namespace/Memo/Mode + the merged
        // cockpit line) was removed. Per Memo 075 Kap 18 that shared-server viewer-head was the wrong
        // interpretation — a single global "activeMemo" is wrong when several CC instances run; the
        // per-terminal "du-bist-hier" belongs in the terminal statusline (lesson
        // you-are-here-belongs-in-terminal-statusline). The per-client Clients registry below is the
        // correct viewer surface, so renderSessionHead/refreshSessionHead and renderCockpit/refreshCockpit
        // (with /api/session and /api/cockpit) no longer exist here.

        // Memo 081, WI-066: the ONE address builder of this client. Every link in the sidebar and every
        // pushState goes through it, so there is a single spelling of a document address. The label is
        // the revision file name without .md — the same value renderRevEntry already shows as revLabel.
        function docPathFor( documentId, fileName ) {
            var base = '/doc/' + encodeURIComponent( String( documentId == null ? '' : documentId ) )
            if( !fileName ) { return base }
            return base + '/' + encodeURIComponent( String( fileName ).replace( /\.md$/, '' ) )
        }

        // Memo 081, WI-066: the ONE address reader, mirroring the server's parseDeepLinkPath. Used by
        // popstate and by the initial route — not three ad-hoc split() calls that could drift apart.
        // Returns null for anything that is not a document address; a caller decides what that means.
        function parseDocPath( pathname ) {
            var path = String( pathname == null ? '' : pathname ).split( '?' )[ 0 ]
            if( path !== '/doc' && path.indexOf( '/doc/' ) !== 0 ) { return null }
            var segments = path.split( '/' ).slice( 2 )
            if( segments.length === 0 || segments.length > 2 ) { return null }
            var decoded = []
            var broken = false
            segments.forEach( function( segment ) {
                if( !segment ) { broken = true; return }
                var value = null
                try { value = decodeURIComponent( segment ) } catch ( err ) { broken = true; return }
                if( !value || value === '.' || value === '..' || /[/\\]/.test( value ) ) { broken = true; return }
                decoded.push( value )
            } )
            if( broken || decoded.length !== segments.length ) { return null }
            return { documentId: decoded[ 0 ], fileName: decoded.length === 2 ? decoded[ 1 ] + '.md' : null }
        }

        // Memo 081, WI-066: the document address currently shown, so the memos tab keeps pointing at the
        // open document instead of erasing the deep link when the user clicks the tab they are on.
        var currentDocPath = null

        // Memo 081, WI-066: "echter Link" means the browser's own gestures still work. Only the plain
        // left click is intercepted; middle click and Cmd/Ctrl/Shift/Alt keep their default (new tab,
        // new window, save target). Half the meaning of a link lives in these gestures.
        function isPlainLeftClick( ev ) {
            if( !ev ) { return true }
            if( ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey ) { return false }
            if( typeof ev.button === 'number' && ev.button !== 0 ) { return false }
            return true
        }

        window.selectRevision = function( documentId, fileName ) {
            // PRD-009 (Memo 016 Kap 7, F4): explicitly picking a memo/revision returns home to
            // prose — the incoming content broadcast must NOT be gated off by a stale open panel.
            currentContentView = 'prose'
            if( currentWs && currentWs.readyState === 1 ) {
                currentWs.send( JSON.stringify( { 'type': 'selectRevision', 'documentId': documentId, 'fileName': fileName } ) )
            }
            // Memo 081, WI-066: the address follows the selection. Same condition setMode already
            // carries — push ONLY when the path actually differs, so picking the same revision twice
            // leaves ONE history entry, not two. That single condition also settles the way back: when
            // popstate calls this, the browser has ALREADY moved the address bar to the restored path,
            // the paths are equal, and nothing is pushed. So there is no second parameter and no second
            // selection route — the guard that prevents double entries is the same guard that prevents
            // the stack from growing on Back.
            // The signature is deliberately NOT widened: ViewStatePanelsPRD009 pins the first 300
            // characters of this function from the outside and had 6 characters of slack left.
            currentDocPath = docPathFor( documentId, fileName )
            if( window.location.pathname !== currentDocPath ) {
                window.history.pushState( { mode: 'memos', documentId: documentId, fileName: fileName }, '', currentDocPath )
            }
        }

        function badgeClassFor( memoStatus ) {
            if( memoStatus === 'Finalisiert' ) { return 'badge-final' }
            if( memoStatus === 'Bedingt finalisiert' ) { return 'badge-conditional' }
            return 'badge-draft'
        }

        function escapeAttr( value ) {
            return String( value == null ? '' : value )
                .replace( /&/g, '&amp;' )
                .replace( /"/g, '&quot;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
        }

        function revTypeLabel( revisionType ) {
            if( revisionType === 'update' ) { return 'Update' }
            if( revisionType === 'prepare' ) { return 'Prepare' }
            return 'Full'
        }

        // PRD-003: single normalization path for question counts (sidebar + sticky read
        // the same numbers, no divergent "0 offen" fallback on differing data).
        // PRD-F1 (Memo 080, Kap 18): a THIRD figure. A question that is retired (irrelevant / ersetzt)
        // used to leave "offen" and appear nowhere — a silent difference between the parsed stock and the
        // shown one. It now changes column instead of vanishing, and the label states it whenever it is
        // non-zero (a constant "· 0 zurueckgestellt" on every memo would be noise, not information).
        // Memo 081 (WI-064/WI-069): the fallback below used to manufacture a zero that was
        // indistinguishable from a measured one, and four display sites rendered it as "0". It now carries
        // the server's declaration through — `basis` and `comparison` (source, countedIn, counted, note).
        // A payload without a declaration is treated as UNDECLARED, not as good: an old server, a document
        // that was never counted and a memo with zero questions are three different statements, and the
        // display can finally tell them apart.
        function normalizeQuestions( questions ) {
            var q = questions || { open: 0, answered: 0, deferred: 0 }
            var declared = q.comparison && typeof q.basis === 'boolean'
            var comparison = declared
                ? { source: q.comparison.source, countedIn: q.comparison.countedIn, counted: q.comparison.counted, note: q.comparison.note }
                : { source: 'none', countedIn: null, counted: 0, note: 'Ohne Deklaration geliefert — die Zahl nennt ihre Menge nicht' }
            return {
                open: q.open || 0,
                answered: q.answered || 0,
                deferred: q.deferred || 0,
                basis: declared ? q.basis : false,
                comparison: comparison
            }
        }

        // Memo 081 (WI-064, Ä7): the ONE filter that decides which questions are open. renderQuestionWidgets
        // owned this expression alone, so the Zone-2 header and the popup label counted a different stock
        // than the cards they sit above. `status` (not `!answered`) is the axis PRD-F1 (Memo 080) settled on
        // — a retired question changes column, it is not answered. Two copies of one condition are exactly
        // where the next divergence starts, so both call sites read this one.
        function openQuestionsOf( schema ) {
            return ( schema || [] ).filter( function( q ) { return q && q.status === 'open' } )
        }

        // The counted stock of a rendered revision: open + answered elements of its question schema. This is
        // the ORACLE the Zone-2 header and the popup label answer to — "how many cards does the revision I am
        // looking at render?" — as opposed to the registry's per-memo figure. Both are legitimate; they answer
        // different questions, and Memo 081 asks that the difference be visible rather than smoothed over.
        // Memo 081 (WI-064/WI-069, Ä6): the set behind a per-memo figure, in plain words, for the title
        // attribute of every element that shows that figure. This is the cheapest form of the rule the memo
        // binds the rollout to — a number states what it was held against — and it is the difference between
        // "no open questions" and "nobody looked". `source` and `countedIn` stay machine values underneath;
        // only this sentence is German, because it is what the reader sees.
        function questionCountTitle( qMeta ) {
            if( !qMeta.basis ) {
                return 'Nicht gezählt' + ( qMeta.comparison.note ? ( ' — ' + qMeta.comparison.note ) : '' )
            }
            var where = qMeta.comparison.countedIn || 'unbenannter Quelle'
            var kind = qMeta.comparison.source === 'db' ? 'Datenbank' : 'Datei'
            return 'Gezählt in ' + where + ' (' + kind + ') — ' + qMeta.comparison.counted + ' Fragen, davon ' + qMeta.open + ' offen'
        }

        function countQuestionsOf( schema ) {
            var list = schema || []
            var open = openQuestionsOf( list ).length
            var answered = list.filter( function( q ) { return q && q.status === 'answered' } ).length
            return { open: open, answered: answered, total: open + answered, elements: list.length }
        }

        function questionsLabel( questions ) {
            var q = normalizeQuestions( questions )
            var base = q.answered + ' beantwortet · ' + q.open + ' offen'
            return q.deferred > 0 ? base + ' · ' + q.deferred + ' zurückgestellt' : base
        }

        // PRD-015 + PRD-016: sticky header showing memo name + current revision + read-only status badge.
        function lookupMemoStatus( memoName ) {
            var found = null
            Object.keys( lastTree || {} ).forEach( function( projectId ) {
                var node = lastTree[ projectId ]
                var memos = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                memos.forEach( function( m ) {
                    if( !found && m.memoName === memoName ) { found = m.memoStatus || 'Entwurf' }
                } )
            } )
            return found
        }

        // PRD-013: look up { projectId, doc } for a memoName from the memos tree. Needed for
        // the sticky-header button to read doc.revisions (Soll-Nummern-Logik) + projectId.
        function findMemoEntry( matches ) {
            var found = null
            Object.keys( lastTree || {} ).forEach( function( projectId ) {
                var node = lastTree[ projectId ]
                var memos = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                memos.forEach( function( m ) {
                    if( !found && matches( m ) ) { found = { projectId: projectId, doc: m } }
                } )
            } )
            return found
        }

        function lookupMemoEntry( memoName ) {
            return findMemoEntry( function( m ) { return m.memoName === memoName } )
        }

        // Memo 081 (WI-064): the same lookup keyed on documentId. renderQuestionWidgets needs the memo's
        // registry figure, and it runs BEFORE `currentMemoName` is adopted in the content handler —
        // `currentDocumentId` is adopted before the render pipeline, for exactly this reason. Looking the
        // memo up by name there would have compared this revision's cards against the PREVIOUSLY viewed
        // memo's count, which is the defect this PRD exists to remove, one level deeper.
        function lookupMemoEntryById( documentId ) {
            return findMemoEntry( function( m ) { return m.documentId === documentId } )
        }

        // PRD-013 (Memo 016 Kap 3) Soll-Nummern-Logik: next = (highest existing REV)+1,
        // previous = highest existing REV. NEVER derived from the viewed revision suffix
        // (that is the reproduced "Revision 2 betrachtet -> 'fuer Revision 3'" bug). Mirrors
        // the testable MemoView.nextRevisionNumbers static method.
        function nextRevisionNumbers( revisions ) {
            var numbers = ( revisions || [] )
                .map( function( rev ) {
                    var m = ( rev && rev.fileName ) ? String( rev.fileName ).match( /REV-(\d+)/ ) : null
                    return m ? parseInt( m[ 1 ], 10 ) : null
                } )
                .filter( function( n ) { return n !== null } )
            var previous = numbers.length === 0 ? 0 : Math.max.apply( null, numbers )
            var next = previous + 1
            function pad( n ) { return String( n ).padStart( 2, '0' ) }
            return { previous: previous, next: next, previousId: 'REV-' + pad( previous ), nextId: 'REV-' + pad( next ) }
        }

        // PRD-010 (Memo 024 Kap 8): inline 1:1 mirror of MemoView.buildMermaidErrorHtml.
        // On a mermaid render failure the viewer shows the error message PLUS the
        // unchanged original source as an HTML-escaped <pre> block, so a broken
        // diagram degrades to readable text instead of a bare error / empty bomb.
        function buildMermaidErrorHtml( err, originalText ) {
            var message = ( err && err.message ) ? err.message : String( err == null ? '' : err )
            var safeMessage = String( message )
                .replace( /&/g, '&amp;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
            // PRD-003 (Memo 076 WI-033): cap the raw source BEFORE escaping (~2000 chars) so a giant
            // CSS-dump/spec cannot blow the error box up to full-page height. Capping before the escape
            // avoids slicing a half-written &amp; entity in two.
            var capped = String( originalText == null ? '' : originalText )
            if( capped.length > 2000 ) { capped = capped.slice( 0, 2000 ) + '…' }
            var safeOriginal = capped
                .replace( /&/g, '&amp;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
            return '<div class="mermaid-error">Mermaid Error: ' + safeMessage
                + '</div><pre class="mermaid-error-source">' + safeOriginal + '</pre>'
        }

        // Memo 080, PRD-V2 rework: a RESOLVED render promise is NOT proof of a drawing. Measured against the
        // pinned mermaid@11.4.1 build in real Chromium: a source above maxTextSize does not reject — the
        // library throws the source away, resolves with a one-node placeholder tile and keeps every marker a
        // caller might test for (`error-icon` / `error-text` live in the injected CSS of EVERY flowchart, so
        // they prove nothing). The failure was therefore silent, and the graph view printed a success count
        // line above an error tile.
        // Both ends are checked, and the CLASS is closed rather than the reported case: the source is measured
        // against the limit we declared BEFORE the call (so the message can name the real figures and the
        // renderer is not even asked), and the returned SVG is checked for mermaid's own substitution marker
        // AFTER it (so a limit that drifts from the library default is still caught). A diagram that legitimately
        // contains the marker in its own source is not mistaken for a failure.
        // Returns the reason as a string, or null when the result really is the requested diagram.
        function mermaidDrawFailure( spec, svg ) {
            var source = String( spec == null ? '' : spec )
            if( source.length > MERMAID_MAX_TEXT_SIZE ) {
                return 'Die Diagramm-Quelle ist ' + source.length + ' Zeichen lang, die Grenze liegt bei '
                    + MERMAID_MAX_TEXT_SIZE + ' — mermaid zeichnet darüber nur eine Platzhalter-Kachel.'
            }
            if( typeof svg === 'string' && svg.indexOf( MERMAID_OVERSIZE_MARKER ) !== -1 && source.indexOf( MERMAID_OVERSIZE_MARKER ) === -1 ) {
                return 'mermaid hat die Quelle (' + source.length + ' Zeichen) durch die Platzhalter-Kachel "'
                    + MERMAID_OVERSIZE_MARKER + '" ersetzt, statt sie zu zeichnen.'
            }

            return null
        }

        // Memo 020 Kap 6 (pt 1): remote-data guard for Vega-Lite specs — the single biggest risk
        // reducer. A spec may only carry INLINE data (data.values / data.sequence). findUrlKey walks
        // the parsed spec and reports the first `url` key at ANY depth (data loaders, image-mark
        // hrefs, sphere/graticule loaders all use `url`), so the validator rejects anything that
        // would trigger a network fetch. Recursive (no loops) to cover layer/concat/facet nesting.
        function findUrlKey( node ) {
            if( node === null || typeof node !== 'object' ) { return null }
            if( Array.isArray( node ) ) {
                return node.reduce( function( found, item ) { return found || findUrlKey( item ) }, null )
            }
            return Object.keys( node ).reduce( function( found, key ) {
                if( found ) { return found }
                if( key === 'url' ) { return 'url' }
                return findUrlKey( node[ key ] )
            }, null )
        }

        // Memo 020 Kap 6: parse + validate a Vega-Lite spec before it is embedded. Returns
        // { ok:true, spec } for an inline-only spec, or { ok:false, reason } for invalid JSON or a
        // spec that references remote data. The render hook turns a reject into the error fallback
        // instead of letting vega fetch a URL.
        function validateVegaSpec( raw ) {
            var spec
            try {
                spec = JSON.parse( raw )
            } catch( e ) {
                return { ok: false, reason: 'Invalid JSON: ' + ( e && e.message ? e.message : 'parse error' ) }
            }
            if( findUrlKey( spec ) ) {
                return { ok: false, reason: 'Remote data is not allowed — use inline "data": { "values": [...] } only.' }
            }
            return { ok: true, spec: spec }
        }

        // Memo 020 Kap 6: error fallback for the scientific renderer, mirrors buildMermaidErrorHtml.
        // Shows the message PLUS the unchanged HTML-escaped source, so a broken/rejected spec
        // degrades to readable text instead of failing silently.
        function buildVegaErrorHtml( err, originalText ) {
            var message = ( err && err.message ) ? err.message : String( err == null ? '' : err )
            var safeMessage = String( message )
                .replace( /&/g, '&amp;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
            var safeOriginal = String( originalText == null ? '' : originalText )
                .replace( /&/g, '&amp;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
            return '<div class="vega-error">Vega-Lite Error: ' + safeMessage
                + '</div><pre class="vega-error-source">' + safeOriginal + '</pre>'
        }

        // Memo 020 Kap 4 (F3=A): ONE renderer registry replaces the formerly 5 hardcoded
        // 'mermaid' sites (1 renderer.code branch + 4 render callsites). Each entry is
        // { selector, render( spec, el ) }: renderer.code emits <div class="LANG">SPEC</div>
        // for any registered language, and renderAllDiagrams() walks every entry's selector
        // once and calls its render hook. Adding a diagram type is now a single registry entry,
        // no new callsite — that is the "kein Quellcode-Churn pro Diagramm"-Constraint resolved.
        // Invariant: each key K has selector '.K', so renderer.code can derive the div class
        // from the registry key and renderAllDiagrams can find it again by selector.
        // Memo 080, PRD-V2 rework: every render hook now ANSWERS whether it drew. The hook returns a promise
        // for { ok, error, el }, so a caller (the graph view) can put a failure on screen instead of leaving a
        // success headline above an error tile. A failure is still shown in place through the existing error
        // fallback — the return value adds the report, it does not replace the rendering contract.
        var diagramRegistry = {
            mermaid: {
                selector: '.mermaid',
                render: function( spec, el ) {
                    var tooBig = mermaidDrawFailure( spec, null )
                    if( tooBig !== null ) {
                        el.innerHTML = buildMermaidErrorHtml( new Error( tooBig ), spec )

                        return Promise.resolve( { ok: false, error: tooBig, el: el } )
                    }

                    return mermaid.render( 'mermaid-' + Math.random().toString( 36 ).slice( 2 ), spec )
                        .then( function( result ) {
                            var substituted = mermaidDrawFailure( spec, result.svg )
                            if( substituted !== null ) {
                                el.innerHTML = buildMermaidErrorHtml( new Error( substituted ), spec )

                                return { ok: false, error: substituted, el: el }
                            }
                            el.innerHTML = result.svg

                            return { ok: true, error: null, el: el }
                        } )
                        .catch( function( err ) {
                            el.innerHTML = buildMermaidErrorHtml( err, spec )

                            return { ok: false, error: ( err && err.message ) ? err.message : String( err ), el: el }
                        } )
                }
            },
            // Memo 020 Kap 3/6: the scientific renderer. The spec is validated (remote data
            // rejected) before embedding. vegaEmbed runs with the hardening config: ast:true selects
            // the CSP-safe AST interpreter bundled in vega-embed (no Function codegen, no unsafe-eval),
            // actions:false drops the export/editor menu, renderer:'svg', and the loader omits
            // credentials. Nothing is attached to window — the returned View stays local to this call.
            'vega-lite': {
                selector: '.vega-lite',
                render: function( spec, el ) {
                    var check = validateVegaSpec( spec )
                    if( !check.ok ) {
                        el.innerHTML = buildVegaErrorHtml( check.reason, spec )

                        return Promise.resolve( { ok: false, error: check.reason, el: el } )
                    }

                    return vegaEmbed( el, check.spec, {
                        actions: false,
                        ast: true,
                        renderer: 'svg',
                        loader: { http: { credentials: 'omit' } }
                    } )
                        .then( function() { return { ok: true, error: null, el: el } } )
                        .catch( function( err ) {
                            el.innerHTML = buildVegaErrorHtml( err, spec )

                            return { ok: false, error: ( err && err.message ) ? err.message : String( err ), el: el }
                        } )
                }
            }
        }

        // Memo 020 Kap 4: the single post-parse render pass. Walks each registry entry's
        // selector and renders every matching element from its data-src source. Replaces the four
        // identical querySelectorAll('.mermaid') callsites (prose, diff-new, diff-prev, ws-update).
        // PRD-003 (Memo 076 WI-030/WI-040): idempotent. The source is read from data-src, NEVER the
        // element's textContent — after the first render textContent is the SVG's CSS, which is the
        // root cause of the "No diagram type detected" second-pass error. A per-element renderedSrc
        // guard skips an element whose source has not changed, so a repeated pass (rapid WS broadcasts)
        // is a no-op instead of a re-render/flicker. Fallback to textContent guards against legacy DOM.
        // Memo 080, PRD-V2 rework: the pass now RETURNS a promise for one { ok, error, el } outcome per
        // rendered element. Callers that only want the drawing ignore it exactly as before; the graph view
        // uses it to replace a false success headline with the real failure. A hook that answers nothing
        // (a legacy or injected registry) counts as drawn, so the pass never invents a failure.
        function renderAllDiagrams() {
            var outcomes = []
            Object.keys( diagramRegistry ).forEach( function( lang ) {
                var entry = diagramRegistry[ lang ]
                document.querySelectorAll( entry.selector ).forEach( function( el ) {
                    var spec = el.getAttribute( 'data-src' )
                    if( spec == null ) { spec = el.textContent }
                    if( el.dataset.renderedSrc === spec ) { return }
                    el.dataset.renderedSrc = spec
                    // PRD-009 (Memo 076 H6, WI-083): a synchronous throw in one renderer (e.g.
                    // vegaEmbed undefined) used to abort the whole pass and leave every remaining
                    // diagram unrendered. Isolate each element so one failure only marks its own box.
                    try {
                        var answered = entry.render( spec, el )
                        outcomes.push( Promise.resolve( answered === undefined ? { ok: true, error: null, el: el } : answered )
                            .then( function( status ) {
                                // A failed element is unmarked again so a later pass may retry it, the same
                                // way the synchronous failure below has always done.
                                if( status && status.ok === false ) { el.dataset.renderedSrc = '' }

                                return status
                            } ) )
                    } catch ( err ) {
                        el.dataset.renderedSrc = ''
                        el.innerHTML = '<div class="diagram-error">Diagramm konnte nicht gerendert werden.</div>'
                        outcomes.push( Promise.resolve( { ok: false, error: ( err && err.message ) ? err.message : String( err ), el: el } ) )
                    }
                } )
            } )

            return Promise.all( outcomes )
        }

        // Memo 020 Kap 4: a node sits "inside a diagram" if it matches ANY registered diagram
        // selector. Registry-driven so a new renderer is covered automatically — used by the diff
        // marker (never mark diagram source as changed text) and the diagram modal handler.
        function closestDiagram( el ) {
            return Object.keys( diagramRegistry ).reduce( function( hit, lang ) {
                return hit || el.closest( diagramRegistry[ lang ].selector )
            }, null )
        }

        // PRD-003 (Memo 076 WI-039): a node IS a diagram container when its OWN classList carries a
        // registered diagram key (registry key K === selector '.K' === div class, see registry invariant).
        // Registry-driven so a new renderer is covered automatically — resolveWikiLinks uses this to
        // never descend into diagram source/SVG-label text (which would corrupt [[slug]] in a diagram).
        function isDiagramContainer( el ) {
            return Object.keys( diagramRegistry ).some( function( lang ) {
                return !!( el.classList && el.classList.contains( lang ) )
            } )
        }

        // PRD-001 (Memo 018 Kap 4, F7=A): the 3-state ball status is now DERIVED from the
        // revision-level revisionStatus (the single source of truth) plus memoFinalized.
        // Mapping: offen -> Wartet auf User-Feedback; transcript-eingetragen -> Transcript
        // hinterlegt; eingeloggt (+ finalisiert) -> Finalisiert (Locked). Mirrors the testable
        // MemoView.deriveBallStatus static method.
        function deriveBallStatus( revisionStatus, memoFinalized ) {
            if( revisionStatus === 'eingeloggt' && memoFinalized === true ) {
                return 'Finalisiert (Locked)'
            }
            if( revisionStatus === 'transcript-eingetragen' ) { return 'Transcript hinterlegt' }
            return 'Wartet auf User-Feedback'
        }

        // PRD-010 #2: each of the 3 states maps to a unique ball position/class.
        function ballPositionFor( ballStatus ) {
            if( ballStatus === 'Finalisiert (Locked)' ) { return 'ball-locked' }
            if( ballStatus === 'Transcript hinterlegt' ) { return 'ball-transcript' }
            return 'ball-feedback'
        }

        // PRD-011 (Memo 016 Kap 5): lose vs. explizit-Revision Zuordnung.
        // These mirror the testable MemoView.transcriptsForMemo / transcriptsForRevision
        // static methods. transcriptsForMemo = lose (memo-weit, aggregate); the per-revision
        // variant filters on entry.revisionId. The frontend transcript tree carries a
        // revisionId per entry (TranscriptRegistry.getTranscriptTree), so the per-revision
        // resolution needs no data-model change.
        function transcriptsForMemo( memoName ) {
            var tree = lastTranscriptTree || {}
            var collected = []
            Object.keys( tree ).forEach( function( projectId ) {
                var memos = tree[ projectId ] || {}
                var list = memos[ memoName ] || []
                list.forEach( function( entry ) { collected.push( entry ) } )
            } )
            return collected
        }

        function transcriptsForRevision( memoName, revisionId ) {
            return transcriptsForMemo( memoName ).filter( function( entry ) {
                return entry && entry.revisionId === revisionId
            } )
        }

        // Aggregate (lose) presence — the memo as a whole has at least one transcript.
        // Used ONLY for memo-weite aggregate displays, never to decide a single revision's pill.
        function hasTranscriptForMemo( memoName ) {
            return transcriptsForMemo( memoName ).length > 0
        }

        // Per-revision presence — the FIX for the REV-03 badge bug. A revision without its
        // own transcript must not show the "Transcript hinterlegt" badge.
        function hasTranscriptForRevision( memoName, revisionId ) {
            if( !revisionId ) { return false }
            return transcriptsForRevision( memoName, revisionId ).length > 0
        }

        // PRD-001 (Memo 019 Kap 1): aggregate the spoken minutes of ALL transcripts of a memo.
        // Mirrors MemoView.aggregateMemoMinutes / TranscriptRegistry.aggregateMemoMinutes — sums
        // the per-transcript word counts (the 'words' field in the transcript tree) and converts
        // at ~200 Woerter/Min. 0 transcripts -> 0 Min (no invented default, no date fallback).
        function aggregateMemoMinutes( memoName ) {
            var words = dedupeTranscripts( transcriptsForMemo( memoName ) )
                .map( function( entry ) { return ( entry && typeof entry.words === 'number' && entry.words > 0 ) ? entry.words : 0 } )
                .reduce( function( sum, value ) { return sum + value }, 0 )
            return words === 0 ? 0 : Math.ceil( words / SPOKEN_WORDS_PER_MINUTE )
        }

        // PRD-005 (Memo 022 Kap 9): per-revision spoken minutes — the rev-mini Leitkennzahl.
        // Sums the word counts of the transcripts that belong to THIS revision (own transcript
        // first, deterministic). No own transcript -> 0 Min (kein erfundener Default, das
        // Memo-Aggregat wird NICHT als Revisions-Wert vorgetaeuscht). ~200 Woerter/Min.
        function aggregateRevisionMinutes( memoName, revisionId ) {
            if( !revisionId ) { return 0 }
            var words = dedupeTranscripts( transcriptsForRevision( memoName, revisionId ) )
                .map( function( entry ) { return ( entry && typeof entry.words === 'number' && entry.words > 0 ) ? entry.words : 0 } )
                .reduce( function( sum, value ) { return sum + value }, 0 )
            return words === 0 ? 0 : Math.ceil( words / SPOKEN_WORDS_PER_MINUTE )
        }

        // Extracts the viewed revision (REV-NN) from a sticky-header fileName ("REV-03.md").
        function revisionIdFromFileName( fileName ) {
            var m = String( fileName || '' ).match( /(REV-\d{2,})/ )
            return m ? m[ 1 ] : null
        }

        // PRD-001 (Memo 018 Kap 4): icon for the derived 3-state ball status (sidebar + sticky).
        // Now driven by revisionStatus + memoFinalized (the single source of truth).
        function statusIconFor( revisionStatus, memoFinalized ) {
            var ballStatus = deriveBallStatus( revisionStatus, memoFinalized )
            if( ballStatus === 'Finalisiert (Locked)' ) { return '✓' }
            if( ballStatus === 'Transcript hinterlegt' ) { return '◑' }
            return '◐'
        }

        // PRD-001 (Memo 018 Kap 4): human-readable label for the derived 3-state ball status.
        function statusTextFor( revisionStatus, memoFinalized ) {
            return deriveBallStatus( revisionStatus, memoFinalized )
        }

        // PRD-001 (Memo 018 Kap 4): map the legacy memo-status string to the memoFinalized flag
        // that the new deriveBallStatus expects. 'Finalisiert'/'Bedingt finalisiert' -> true.
        function memoFinalizedFrom( memoStatus ) {
            return memoStatus === 'Finalisiert' || memoStatus === 'Bedingt finalisiert'
        }

        // PRD-004/006 (Memo 024 Kap 4): inline mirror of DocumentRegistry.deriveLifecycleStatus.
        // Same Ableitungs-Reihenfolge: planCompleted (Plan-/Rollout-Quelle) -> Frontmatter
        // (Finalisiert / Bedingt finalisiert / In Bearbeitung) -> Heuristik (>1 Revision ->
        // In Bearbeitung) -> Default 'Entwurf'. The browser has no plan-completion source today,
        // so planCompleted stays undefined here (additiver Hook, kein 'Abgeschlossen' im Frontend).
        function deriveLifecycleStatusFor( frontmatterStatus, revisionCount, planCompleted ) {
            if( planCompleted === true ) { return 'Abgeschlossen' }
            if( frontmatterStatus === 'Finalisiert' ) { return 'Finalisiert' }
            if( frontmatterStatus === 'Bedingt finalisiert' ) { return 'Bedingt finalisiert' }
            if( frontmatterStatus === 'In Bearbeitung' ) { return 'In Bearbeitung' }
            var count = ( typeof revisionCount === 'number' && revisionCount > 0 ) ? revisionCount : 0
            if( count > 1 ) { return 'In Bearbeitung' }
            return 'Entwurf'
        }

        // Memo 079 M4 (T013 / WI-021+025): un-collapse the rollout lifecycle. The coarse badge axis maps
        // rollout/pausiert/gelandet/gemerged ALL onto 'Finalisiert' and abgeschlossen/abgebrochen both onto
        // 'Abgeschlossen', so a memo mid-rollout looked identical to one merely finalized-not-started. Given
        // the RAW DB lifecycle state (DocumentRegistry surfaces it now), this returns a DISTINCT German
        // sub-label for the progression + aborted states, else null (the coarse label stands unchanged).
        function rolloutSubLabelFor( lifecycleState ) {
            var map = {
                'rollout': 'Rollout läuft',
                'pausiert': 'Pausiert',
                'gelandet': 'Gelandet',
                'gemerged': 'Gemerged',
                'abgebrochen': 'Abgebrochen'
            }
            return ( typeof lifecycleState === 'string' && map[ lifecycleState ] ) ? map[ lifecycleState ] : null
        }

        // PRD-001 (Memo 018 Kap 4): derive the viewed revision's revisionStatus from transcript
        // presence. No transcript -> 'offen'; transcript present -> 'transcript-eingetragen'.
        // When the memo is finalisiert the logged state 'eingeloggt' is reached. This is the one
        // place the inline display computes revisionStatus (mirrors DocumentRegistry.deriveRevisionStatus).
        function revisionStatusFrom( hasTranscript, memoFinalized ) {
            if( memoFinalized === true && hasTranscript === true ) { return 'eingeloggt' }
            if( hasTranscript === true ) { return 'transcript-eingetragen' }
            return 'offen'
        }

        // PRD-008: pill class for the derived 3-state ball status.
        function pillClassFor( ballStatus ) {
            if( ballStatus === 'Finalisiert (Locked)' ) { return 'pill-final' }
            if( ballStatus === 'Transcript hinterlegt' ) { return 'pill-transcript' }
            return 'pill-feedback'
        }

        // PRD-008 (F12): optional Memo-Typ from the rendered content header table
        // ("Memo-Typ" / "Typ" row). Returns null when not available (badge then omitted).
        function lookupMemoType() {
            var match = ( lastContent || '' ).match( /\|\s*\*{0,2}(?:Memo-)?Typ\*{0,2}\s*\|\s*([^|\n]+?)\s*\|/i )
            if( !match ) { return null }
            var value = ( match[ 1 ] || '' ).trim()
            if( !value || value === '---' || value === '-' ) { return null }
            return value
        }

        // PRD-008: latest transcript URL for the current memo (for "Transcript kopieren").
        function latestTranscriptUrlFor( memoName ) {
            var tree = lastTranscriptTree || {}
            var url = ''
            Object.keys( tree ).forEach( function( projectId ) {
                var memos = tree[ projectId ] || {}
                var list = memos[ memoName ] || []
                if( list.length > 0 ) { url = list[ list.length - 1 ].url || '' }
            } )
            return url
        }

        // PRD-011: latest transcript URL for the VIEWED revision; falls back to the memo's
        // latest only when the viewed revision has no own transcript (keeps line-2 useful).
        function latestTranscriptUrlForRevision( memoName, revisionId ) {
            if( revisionId ) {
                var list = transcriptsForRevision( memoName, revisionId )
                if( list.length > 0 ) { return list[ list.length - 1 ].url || '' }
                return ''
            }
            return latestTranscriptUrlFor( memoName )
        }

        // PRD-005 (Memo 018 Kap 8): the transcriptId for the VIEWED revision — needed so the
        // "bereit / einloggen" button can target POST /api/transcripts/{id}/login. Picks the
        // latest entry for the revision (same selection as latestTranscriptUrlForRevision).
        function latestTranscriptForRevision( memoName, revisionId ) {
            if( !revisionId ) { return null }
            var list = transcriptsForRevision( memoName, revisionId )
            if( list.length > 0 ) { return list[ list.length - 1 ] }
            return null
        }

        // PRD-005 (Kap 8): is the viewed revision currently logged in? Derived from the
        // transcript tree (loggedIn flag, propagated by TranscriptRegistry.getTranscriptTree).
        function isRevisionLoggedIn( memoName, revisionId ) {
            return transcriptsForRevision( memoName, revisionId )
                .some( function( entry ) { return entry && entry.loggedIn === true } )
        }

        // PRD-004 (Memo 018 Kap 7): the revision-level revisionStatus driving the Transcript-
        // Statuszeile. Reuses the Phase-1 status model (offen / transcript-eingetragen /
        // eingeloggt); the eingeloggt state is now sourced from the per-revision loggedIn flag.
        function revisionStatusForRow( hasTranscript, isLoggedIn ) {
            if( isLoggedIn === true ) { return 'eingeloggt' }
            if( hasTranscript === true ) { return 'transcript-eingetragen' }
            return 'offen'
        }

        // PRD-004 (Kap 7): unified status pill class for the Transcript-Statuszeile, following
        // the mh-badge--{typ} naming scheme shared by all header badges.
        function statusBadgeClassFor( revisionStatus ) {
            if( revisionStatus === 'eingeloggt' ) { return 'mh-badge--eingeloggt' }
            if( revisionStatus === 'transcript-eingetragen' ) { return 'mh-badge--transcript' }
            return 'mh-badge--offen'
        }

        // PRD-004 (Kap 7): readable label for the revision transcript status.
        function statusRowLabel( revisionStatus ) {
            if( revisionStatus === 'eingeloggt' ) { return 'eingeloggt' }
            if( revisionStatus === 'transcript-eingetragen' ) { return 'transcript-eingetragen' }
            return 'offen'
        }

        // PRD-008 (Memo 019 Kap 9): inline browser mirror of MemoView.promptStatusLine. The
        // static class method (unit-tested) is server-side only; this 1:1 copy runs in the page.
        // Minutes are the Leitkennzahl (BEFORE words, Kap 9.4): a measured spoken duration shows
        // "N Min gesprochen", otherwise the derived ~200-words/min estimate shows "N Min geschätzt"
        // (never fakes "gesprochen", AC-11). "Kein Wegklicken" (Kap 9.2): transcriptInPrompt is
        // derived from a present transcript and can never be toggled off.
        function promptStatusLineInline( opts ) {
            opts = opts || {}
            var hasTranscript = typeof opts.transcriptUrl === 'string' && opts.transcriptUrl.length > 0
            var wordCount = ( typeof opts.words === 'number' && opts.words > 0 ) ? opts.words : 0
            var measured = typeof opts.spokenMinutes === 'number' && opts.spokenMinutes > 0
            // Memo 038 Kap 13: estimate spoken minutes at the realistic dictation rate (was 200).
            var estimated = wordCount === 0 ? 0 : Math.ceil( wordCount / SPOKEN_WORDS_PER_MINUTE )
            var minutes = measured ? opts.spokenMinutes : estimated
            var minutesEstimated = !measured
            var answered = ( typeof opts.questionsAnswered === 'number' && opts.questionsAnswered > 0 ) ? opts.questionsAnswered : 0
            var total = ( typeof opts.questionsTotal === 'number' && opts.questionsTotal > 0 ) ? opts.questionsTotal : 0
            var open = total > answered ? total - answered : 0
            var minutesLabel = minutesEstimated ? ( minutes + ' Min geschätzt' ) : ( minutes + ' Min gesprochen' )

            return {
                transcriptInPrompt: hasTranscript,
                hasTranscript: hasTranscript,
                words: wordCount,
                minutes: minutes,
                minutesEstimated: minutesEstimated,
                minutesLabel: minutesLabel,
                wordsLabel: wordCount.toLocaleString( 'de-DE' ) + ' Wörter',
                answered: answered,
                total: total,
                open: open,
                // Memo 081 (WI-064): mirrors MemoView.promptStatusLine 1:1 — an explicit basis:false
                // renders "nicht gezählt" where the old model rendered "0 von 0 beantwortet".
                counted: opts.basis !== false,
                answeredLabel: opts.basis === false ? 'nicht gezählt' : answered + ' von ' + total + ' beantwortet',
                openLabel: opts.basis === false ? 'nicht gezählt' : open + ' offen'
            }
        }

        // PRD-001 (Memo 076, Phase 1, WI-041/042 — the 2 blockers): guard-independent clear of the
        // memo sticky header. updateSidebarSticky's mode-guard (currentMode !== 'memos' -> return)
        // would swallow an updateSidebarSticky(null,null) once the mode already switched away, so the
        // clear runs here directly (innerHTML=''). The CSS rule #main-header:empty { display:none }
        // then hides the emptied header, ending the bleed into clients/specs/transcripts.
        function clearMainHeader() {
            var headerEl = document.getElementById( 'main-header' )
            if( headerEl ) { headerEl.innerHTML = '' }
        }

        // PRD-002 (Memo 076, Phase 1, WI-050): zero-pad a memo number to 3 digits so the client-registry
        // value (server stores it ungepadded, e.g. '76') and the header number (derived as 3-digit '076')
        // compare equal. Non-numeric input is returned as its trimmed string so it never crashes.
        function pad3( value ) {
            var str = String( value === undefined || value === null ? '' : value ).trim()
            return /^\d+$/.test( str ) ? str.padStart( 3, '0' ) : str
        }

        // PRD-008: two-line content-sticky-header.
        //   Line 1: Titel + Memo-Typ-Badge (F12) + Status-Pill (derived 3-state) + Diff-Toggle.
        //   Line 2: "Transcript kopieren" + URL + Woerter/Minuten.
        // No 📍/📌 emoji (Phase 1). Diff-Toggle (#diff-toggle) lives here (moved out of Nav-Bar).
        function updateSidebarSticky( memoName, fileName ) {
            // PRD-017 (Memo 072, Phase 5): the memo sticky header does not belong in the Specs view —
            // its #main-header is left to the spec render. Skip so a transcriptList broadcast cannot
            // inject a memo sticky bar while the user is browsing specs.
            // PRD-001 (Memo 076, Phase 1, WI-042/043/047/048): generalized from 'specs'-only to
            // "any non-memos mode". The Zone-1 memo header belongs to the memos view alone; a
            // broadcast (content/transcriptList/transcriptLoggedIn/Out) must never re-inject it while
            // the user is in specs/clients/transcripts. An explicit clear does NOT flow through here —
            // clearMainHeader() below is guard-independent, so this early return cannot swallow it.
            if( currentMode !== 'memos' ) { return }
            var headerEl = document.getElementById( 'main-header' )
            if( !headerEl ) { return }
            if( !memoName && !fileName ) {
                headerEl.innerHTML = ''
                return
            }

            // PRD-002 (#9): the pill reflects the CONVERSATION state, not the raw memo-status
            // of the draft revision. deriveBallStatus derives one of three conversation states
            // ("Wartet auf User-Feedback" / "Transcript hinterlegt" / "Finalisiert (Locked)");
            // the raw 'Entwurf' memo-status is never shown as the pill text. memoStatus only
            // gates the Locked state.
            // PRD-011 (Memo 016 Kap 5): the "Transcript hinterlegt" presence is now resolved
            // PER REVISION (the one currently viewed, derived from fileName), not memo-weit.
            // A revision without its OWN transcript must not inherit the badge from a sibling
            // revision (REV-03 badge bug). Data source: lastTranscriptTree entries carry a
            // revisionId, so no data-model rebuild is needed.
            var memoStatus = lookupMemoStatus( memoName )
            var viewedRevision = revisionIdFromFileName( fileName )
            var hasTranscript = viewedRevision
                ? hasTranscriptForRevision( memoName, viewedRevision )
                : hasTranscriptForMemo( memoName )
            // PRD-001 (Memo 018 Kap 4): the ball state is now derived from the revision-level
            // revisionStatus + memoFinalized, not directly from (memoStatus, hasTranscript).
            var memoFinalized = memoFinalizedFrom( memoStatus )
            var revisionStatus = revisionStatusFrom( hasTranscript, memoFinalized )
            var ballStatus = deriveBallStatus( revisionStatus, memoFinalized )
            // Line-2 copy URL: prefer the transcript of the VIEWED revision; fall back to the
            // memo's latest only when the viewed revision has no own transcript.
            var transcriptUrl = latestTranscriptUrlForRevision( memoName, viewedRevision )

            // PRD-002 (#8): strip the .md extension from the file name in the sticky title.
            var cleanFile = String( fileName || '' ).replace( /\.md$/i, '' )

            // PRD-004 (Memo 018 Kap 7 / 014 Kap 10): the title line is its own first row.
            // It carries the Memo-number + name + the viewed revision as informational context
            // ("worum es geht") and holds NO action buttons. Memo names already start with the
            // number ("018 · ..."), so the name is the heading; the revision is appended as context.
            var titleHeading = ( memoName || cleanFile )
            if( memoName && cleanFile ) { titleHeading = memoName + ' · ' + cleanFile }

            // PRD-005 (Kap 8): per-revision logged-in state drives the status row + button gate.
            var loggedIn = isRevisionLoggedIn( memoName, viewedRevision )
            var rowStatus = revisionStatusForRow( hasTranscript, loggedIn )
            var viewedTranscript = latestTranscriptForRevision( memoName, viewedRevision )

            // PRD-002 (Memo 076, Phase 1, WI-046/050): resolve which registered CC instances belong to
            // the DISPLAYED memo. The header number is derived as 3-digit; the client stores it ungepadded
            // (e.g. '76'), so both sides are pad3-normalized before comparison ('76' matches '076').
            var chipHeaderMatch = String( memoName || '' ).match( /(\d{3})/ )
            var chipHeaderNum = chipHeaderMatch ? pad3( chipHeaderMatch[ 1 ] ) : ''
            var activeInstances = chipHeaderNum
                ? ( Array.isArray( lastClients ) ? lastClients : [] ).filter( function( client ) {
                    var hasNum = client && client.memoNumber !== undefined && client.memoNumber !== null && client.memoNumber !== ''
                    return hasNum && pad3( client.memoNumber ) === chipHeaderNum
                } )
                : []

            // Memo 038 Kap 13: the former rendered-document word/minute estimate that fed the Zone-2
            // "Transcript" line was removed — Zone 2 now uses the revision's TRANSCRIPT word count
            // (psTranscriptWords below), the same source as the sidebar, so the two never diverge.

            // ============================================================================
            // PRD-006 (Memo 019 Kap 6): 3-Zonen-Sticky-Header. Zone 1 = Informationsebene
            // (GELOCKT, v4 Frame JaA9o). Zone 2 = Interaktionsebene/Prompt-Statuszeile (Phase 5,
            // hier nur als Layout-Platzhalter mit dem bestehenden Inhalt). Zone 3 = Content
            // (scrollbar, NICHT sticky — lebt ausserhalb #main-header).
            // ============================================================================

            // ---- ZONE 1 — Informationsebene (gelockt, Frame JaA9o).
            // Zeile 1 (YtFVI): nur der MEMO-Titel (memoName) + Status-Pill. Die Pill zeigt
            // GELOCKT NUR "Entwurf" / "Finalisiert" (Frame NUj56) — NICHT die 3-State-Ball-
            // Status (PRD-006 AC-2/AC-4). Kein Typ-Badge, kein "Prepare" in Zone 1.
            var pillText = memoFinalized ? 'Finalisiert' : 'Entwurf'
            var pillStateClass = memoFinalized ? 'z1pill-final' : 'z1pill-draft'

            var z1Line1 = '<div class="z1-line1" data-zone1-line1>'
            z1Line1 += '<span class="z1-title" data-zone1-title>' + escapeAttr( memoName || cleanFile ) + '</span>'
            z1Line1 += '<span class="z1-pill ' + pillStateClass + '" data-zone1-pill data-pill="' + escapeAttr( pillText ) + '">' + escapeAttr( pillText ) + '</span>'
            // PRD-007 (Memo 022 Kap 5): the Diff-Toggle lives in Zone 1, Zeile 1, klein NEBEN der
            // Status-Pill (rechts davon) — nicht mehr als Balken am unteren Rand der Zone-2-
            // Statuszeile. Gleiche ID #diff-toggle -> bindDiffToggle findet ihn weiterhin per ID.
            // Startzustand display:none; bindDiffToggle blendet ihn ein, wenn ein Diff vorliegt.
            z1Line1 += '<button id="diff-toggle" style="display:none" title="Diff anzeigen/ausblenden">Diff</button>'
            // PRD-012 (Memo 011 Kap 4, F16=A): Requirements-Ansicht oeffnen (PRD-Ebene + Memo-Aggregat).
            z1Line1 += '<button id="req-view-toggle" title="Requirements anzeigen">Requirements</button>'
            // PRD-010 (Memo 014 Kap 2): Block-Ansicht oeffnen (Block-Overlay, read-only). Muster req-view-toggle.
            z1Line1 += '<button id="block-view-toggle" title="Blöcke anzeigen">Blöcke</button>'
            // PRD-V2 (Memo 080 Kap 15, WI-102): Graph-Ansicht oeffnen (Knowledge-Graph aus der Datenbank,
            // read-only). Muster block-view-toggle — gleiche Aufbau-Stelle, gleicher Vertrag.
            z1Line1 += '<button id="graph-view-toggle" title="Knowledge-Graph anzeigen">Graph</button>'
            // PRD-002 (Memo 076, Phase 1, WI-046/049/050): the instance chip. Rendered when a CC instance
            // is registered for THIS memo number (activeInstances, zero-padded match) OR the viewed
            // revision is logged in (loggedIn — the previously computed-but-unrendered flag, WI-049). The
            // chip carries rowStatus (offen/transcript-eingetragen/eingeloggt) as a data-attribute so the
            // per-revision login state is genuinely surfaced, not dead code.
            if( activeInstances.length > 0 || loggedIn ) {
                var chipParts = []
                if( activeInstances.length > 0 ) {
                    chipParts.push( activeInstances.length + ' Instanz' + ( activeInstances.length === 1 ? '' : 'en' ) + ' aktiv' )
                }
                if( loggedIn ) { chipParts.push( 'eingeloggt' ) }
                z1Line1 += '<span class="z1-instances z1-instances--' + escapeAttr( rowStatus ) + '"'
                    + ' data-zone1-instances data-row-status="' + escapeAttr( rowStatus ) + '"'
                    + ' title="Für dieses Memo eingeloggt / aktiv">'
                    + escapeAttr( chipParts.join( ' · ' ) ) + '</span>'
            }
            z1Line1 += '</div>'

            // Zeile 2 (9I8kz): aktuelles Dokument — "ressources · 019 · REV-NN" + Kalender-Icon
            // + Datum + "Implementierung" + KB. Datum ist Pflicht (Kap 6.2); KB ist Pflicht und
            // korrekt (Kap 6.5). Werte werden aus der angezeigten Revision aufgeloest.
            var memoEntryZ1 = memoName ? lookupMemoEntry( memoName ) : null
            var z1Project = memoEntryZ1 ? memoEntryZ1.projectId : ''
            var memoNumberMatch = String( memoName || '' ).match( /(\d{3})/ )
            var z1Number = memoNumberMatch ? memoNumberMatch[ 1 ] : ''
            var viewedRev = null
            if( memoEntryZ1 && memoEntryZ1.doc && Array.isArray( memoEntryZ1.doc.revisions ) ) {
                viewedRev = memoEntryZ1.doc.revisions.filter( function( r ) { return r.fileName === fileName } )[ 0 ] || null
            }
            var z1Date = viewedRev && viewedRev.mtime ? viewedRev.mtime : ''
            var z1Kb = viewedRev && viewedRev.sizeKb ? ( viewedRev.sizeKb + ' KB' ) : ''
            // Doc-Pfad "Namespace · Nr · REV-NN" — leere Teile werden weggelassen (kein Default).
            var docPathParts = []
            if( z1Project ) { docPathParts.push( z1Project ) }
            if( z1Number ) { docPathParts.push( z1Number ) }
            if( viewedRevision ) { docPathParts.push( viewedRevision ) }
            var docPath = docPathParts.join( ' \u00b7 ' )

            var z1Line2 = '<div class="z1-line2" data-zone1-line2>'
            z1Line2 += '<span class="z1-doc" data-zone1-doc>' + escapeAttr( docPath ) + '</span>'
            if( z1Date ) {
                z1Line2 += '<span class="z1-cal" aria-hidden="true">\uD83D\uDCC5</span>'
                z1Line2 += '<span class="z1-date" data-zone1-date>' + escapeAttr( z1Date ) + '</span>'
            }
            z1Line2 += '<span class="z1-sep">\u00b7</span>'
            // PRD-008 (F12): show the memo's ACTUAL type from the header table ("Memo-Typ" /
            // "Typ" row) instead of a hardcoded constant. lookupMemoType() reads the raw
            // markdown (lastContent) and returns null when no row is present — fall back to
            // "Implementierung" (the documented default) so the line-2 type is never empty.
            var z1Type = lookupMemoType() || 'Implementierung'
            z1Line2 += '<span class="z1-type" data-zone1-type>' + escapeAttr( z1Type ) + '</span>'
            if( z1Kb ) {
                z1Line2 += '<span class="z1-sep">\u00b7</span>'
                z1Line2 += '<span class="z1-kb" data-zone1-kb>' + escapeAttr( z1Kb ) + '</span>'
            }
            z1Line2 += '</div>'

            var titleRow = '<div class="hdr-zone hdr-zone-1" data-zone="1">' + z1Line1 + z1Line2 + '</div>'

            // ---- ZONE 2 — Prompt-Statuszeile (PRD-008 / Kap 9, Frame o0zun).
            // STRIKT zwei Zeilen (Kap 9.3): Transcript-Zeile + Fragen-Zeile. Reine Statusuebersicht,
            // KEIN Eingabeort (Kap 9.5/AC-09). Die alte Single-Row-Mischung (Status-Badge +
            // "Transcript"-Button + "bereit / einloggen"-Opt-out + "Transcript kopieren" + URL +
            // Woerter + Diff) ist ENTFALLEN. "Kein Wegklicken" (Kap 9.2/AC-05): es gibt keine
            // "mitloggen"-Checkbox und keinen Opt-out-Schalter mehr in Zone 2 — ein vorhandener
            // Transcript ist immer Teil des Prompts. Einziger Eintrittspunkt: "Prompt bearbeiten".
            var memoEntry = memoName ? lookupMemoEntry( memoName ) : null

            // Fragen-Counts. Memo 081 (WI-064, S2): Zone 2 sits above a rendered revision, so it counts THAT
            // revision's question schema — the very array renderQuestionWidgets filters. The old code read the
            // per-memo registry figure instead, which is why the header could say "0 von 0" while fifteen
            // cards stood below it: two sets, one number, and no way to see which one was meant. The registry
            // figure is still read (qMeta) — not to display, but to hold the two against each other.
            var qMeta = normalizeQuestions( memoEntry ? memoEntry.doc.questions : null )
            // No revision on screen means no set was counted — not a memo with zero questions.
            var psView = viewedRevision ? countQuestionsOf( lastQuestionSchema ) : null
            var psBasis = psView !== null
            var psAnswered = psBasis ? psView.answered : 0
            var psTotal = psBasis ? psView.total : 0

            // Minuten-Leitkennzahl (Kap 9.4): gemessene Sprech-Dauer aus dem Transcript-Record
            // (viewedTranscript.spokenMinutes), sonst Fallback auf die wordCount-Schaetzung.
            var psSpoken = ( viewedTranscript && typeof viewedTranscript.spokenMinutes === 'number' )
                ? viewedTranscript.spokenMinutes
                : 0
            // Memo 038 Kap 13: the Zone-2 "Transcript" line uses the TRANSCRIPT word count of the
            // viewed revision — NOT the rendered-document length (`words` above). Document length and
            // spoken transcript time are different quantities; feeding the doc length here made the
            // "Transcript" minutes diverge from the sidebar's transcript-based total (the 23-vs-38
            // bug). Deduped + realistic dictation wpm, so Zone 2 and the sidebar now agree.
            var psTranscriptWords = dedupeTranscripts( transcriptsForRevision( memoName, viewedRevision ) )
                .map( function( entry ) { return ( entry && typeof entry.words === 'number' && entry.words > 0 ) ? entry.words : 0 } )
                .reduce( function( sum, value ) { return sum + value }, 0 )
            // Inline mirror of MemoView.promptStatusLine (the static class is server-side only and
            // not available in the browser; promptStatusLineInline replicates it 1:1).
            var ps = promptStatusLineInline( {
                words: psTranscriptWords,
                spokenMinutes: psSpoken,
                questionsAnswered: psAnswered,
                questionsTotal: psTotal,
                transcriptUrl: transcriptUrl,
                basis: psBasis
            } )
            // Memo 081 (WI-064): the set behind the number, spelled out on the element that shows it. The
            // title is the smallest place where a figure can name what it counted, and it costs no layout.
            // Both sets, on the element that shows one of them. The header answers "what does the revision
            // in front of me render?", the memo overview answers "what does this memo carry?" — they may
            // legitimately differ, and the title is where the reader can see both without a banner.
            var psTitle = psBasis
                ? ( 'Gezählt in ' + ( viewedRevision || 'der angezeigten Revision' ) + ' — ' + psView.elements + ' Fragen im Schema, davon ' + psView.open + ' offen'
                    + ' · Memo-Übersicht: ' + questionCountTitle( qMeta ) )
                : 'Nicht gezählt — es ist keine Revision geöffnet · Memo-Übersicht: ' + questionCountTitle( qMeta )

            var statusRow = '<div class="hdr-zone hdr-zone-2" data-zone="2"><div class="prompt-statuszeile" id="prompt-statuszeile">'

            // ---- Zeile 1 — Transcript (reHrF): Icon+Label · Minuten-Chip · Woerter · Spacer ·
            //      "Prompt bearbeiten" · Copy-Icon. Minuten VOR Woertern (Kap 9.4).
            statusRow += '<div class="ps-row ps-row--transcript" data-zone2-line1>'
            statusRow += '<span class="ps-ico" aria-hidden="true">\uD83D\uDCC4</span>'
            statusRow += '<span class="ps-label">Transcript</span>'
            if( ps.hasTranscript ) {
                statusRow += '<span class="ps-sep">\u00b7</span>'
                statusRow += '<span class="ps-minutes" data-zone2-minutes data-estimated="' + ( ps.minutesEstimated ? '1' : '0' ) + '">'
                    + '<span class="ps-mic" aria-hidden="true">\uD83C\uDFA4</span>'
                    + '<span>' + escapeAttr( ps.minutesLabel ) + '</span>'
                    + '</span>'
                statusRow += '<span class="ps-sep">\u00b7</span>'
                statusRow += '<span class="ps-words" data-zone2-words>' + escapeAttr( ps.wordsLabel ) + '</span>'
            } else {
                // Ohne Transcript: keine Minuten/Woerter vortaeuschen (Kap 9.5).
                statusRow += '<span class="ps-empty" data-zone2-empty>Kein Transcript hinterlegt</span>'
            }
            // Revisions-Kontext (data-project/-memo/-next) sitzt am einzigen Eintrittspunkt, damit
            // der bestehende "ohne Transcript speichern"-Pfad (PRD-028) seinen Bezug findet, ohne
            // dass es noch einen separaten #sticky-add-transcript-Button gibt.
            var psNums = memoEntry ? nextRevisionNumbers( memoEntry.doc.revisions ) : { nextId: 'REV-01', previousId: 'REV-01' }
            statusRow += '<span class="ps-spacer"></span>'
            statusRow += '<button class="ps-edit" id="ps-edit-prompt" data-prompt-edit'
                + ' data-memo="' + escapeAttr( memoName || '' ) + '"'
                + ' data-project="' + escapeAttr( memoEntry ? memoEntry.projectId : '' ) + '"'
                + ' data-next="' + escapeAttr( psNums.nextId ) + '"'
                + ' data-prev="' + escapeAttr( psNums.previousId ) + '"'
                // PRD-001 (Memo 022): data-rev = the DISCUSSED (viewed) revision. The "ohne
                // Transcript speichern"-Pfad (saveAnswersOnly) binds feedback ZU REV-N to REV-N,
                // not to REV-(N+1). Fallback to data-next only when no revision is viewed.
                + ' data-rev="' + escapeAttr( viewedRevision || psNums.nextId ) + '"'
                + ' title="Prompt bearbeiten — Transcript + Fragen in einem Popup">'
                + '<span aria-hidden="true">\u270E</span><span>Prompt bearbeiten</span>'
                + '</button>'
            statusRow += '<button class="ps-copy" id="ps-copy"' + ( transcriptUrl ? '' : ' disabled' )
                + ' data-url="' + escapeAttr( transcriptUrl ) + '" title="Prompt/Transcript-URL kopieren" aria-label="Kopieren">\u29C9</button>'
            statusRow += '</div>'

            // ---- Zeile 2 — Fragen (CmWEX): Icon+Label · "N von M beantwortet" ·
            //      Fragezeichen-Indikator · Spacer · "Abschliessen" (F7=A, Kap 9.6).
            statusRow += '<div class="ps-row ps-row--fragen" data-zone2-line2>'
            statusRow += '<span class="ps-ico" aria-hidden="true">\u2611</span>'
            statusRow += '<span class="ps-label">Fragen</span>'
            statusRow += '<span class="ps-sep">\u00b7</span>'
            statusRow += '<span class="ps-answered" data-zone2-answered data-zone2-basis="' + ( psBasis ? '1' : '0' ) + '"'
                + ' data-zone2-counted="' + ( psBasis ? psView.elements : 0 ) + '"'
                + ' title="' + escapeAttr( psTitle ) + '">' + escapeAttr( ps.answeredLabel ) + '</span>'
            statusRow += '<span class="ps-qmark" data-zone2-qmark title="' + escapeAttr( psTitle ) + '">'
                + '<span class="ps-qmark-sign" aria-hidden="true">?</span>'
                + '<span>' + escapeAttr( ps.openLabel ) + '</span>'
                + '</span>'
            statusRow += '<span class="ps-spacer"></span>'
            statusRow += '<button class="ps-finish" id="ps-finish" data-abschliessen title="Prompt abschliessen (F7) — manueller Trigger, kein Auto-Versand">'
                + '<span aria-hidden="true">\u27A4</span><span>Abschließen</span>'
                + '</button>'
            statusRow += '</div>'

            // PRD-007 (Memo 022 Kap 5): der Diff-Toggle wurde aus der Zone-2-Statuszeile entfernt
            // und lebt jetzt in Zone 1, Zeile 1, neben der Status-Pill (siehe z1Line1). Kein
            // Button mehr am unteren Rand der Statuszeile ("Balken weg").

            statusRow += '</div></div>'

            headerEl.innerHTML = titleRow + statusRow

            // Rebind the diff-toggle (re-created on each render) to the existing diff logic.
            bindDiffToggle()

            // PRD-012 (Memo 011 Kap 4, F16=A): rebind the Requirements-view toggle (re-created on
            // each header render). Opens the PRD-level + Memo-aggregate view for the active memo.
            var reqViewToggle = document.getElementById( 'req-view-toggle' )
            if( reqViewToggle ) {
                reqViewToggle.addEventListener( 'click', function() {
                    loadRequirementsView( currentDocumentId )
                } )
            }

            // PRD-010 (Memo 014 Kap 2): rebind the Block-view toggle (re-created on each header
            // render). Opens the read-only block overlay for the active memo.
            var blockViewToggle = document.getElementById( 'block-view-toggle' )
            if( blockViewToggle ) {
                blockViewToggle.addEventListener( 'click', function() {
                    loadBlockView( currentDocumentId )
                } )
            }

            // PRD-V2 (Memo 080 Kap 15, WI-102): rebind the Graph-view toggle (re-created on each header
            // render). Opens the read-only knowledge graph of the active memo.
            var graphViewToggle = document.getElementById( 'graph-view-toggle' )
            if( graphViewToggle ) {
                graphViewToggle.addEventListener( 'click', function() {
                    loadGraphView( currentDocumentId )
                } )
            }

            // PRD-009 (Memo 016 Kap 7, F4/E6): the toggles are rebuilt with each header render —
            // re-apply the .active indicator so the open panel (requirements/blocks) stays marked
            // and the way back to prose is visible after a sticky-header refresh.
            syncContentViewToggles()

            // PRD-008 (Kap 9.5): the single entrypoint — "Prompt bearbeiten" opens the combined
            // popup (Transcript-Abschnitt + Fragen-Abschnitt). Bound per render (header rebuilt).
            bindPromptEdit( { memoEntry: memoEntry, memoName: memoName } )

            // PRD-008 (Kap 9.6): manual "Abschliessen" trigger. Bound per render.
            bindPromptFinish( { transcriptId: viewedTranscript ? viewedTranscript.transcriptId : '', revisionId: viewedRevision, memoName: memoName } )

            var copyBtn = document.getElementById( 'ps-copy' )
            if( copyBtn && transcriptUrl ) {
                copyBtn.addEventListener( 'click', function() {
                    navigator.clipboard.writeText( transcriptUrl ).then( function() {
                        var orig = copyBtn.textContent
                        copyBtn.textContent = '\u2713'
                        setTimeout( function() { copyBtn.textContent = orig }, 2000 )
                    } ).catch( function() {} )
                } )
            }

            // PRD-012 (Memo 076 H8, WI-106): the answers-only bar + mountAnswersOnlyBarInHeader stripper
            // are gone (dead path; the popup's "Übernehmen" persists transcript + answers).
        }

        // PRD-005 (Memo 022 Kap 9): the per-revision Typ-Badge (Full/Update/Prepare) was REMOVED
        // from the rev-mini widget — bei nur-Full-Ansicht (PRD-004) ist er redundant, die
        // prominente Revisionsnummer traegt jetzt die Identifikation. Das frühere revTypeBadge()
        // ist damit entfallen. Legacy wird weiterhin ueber revLegacyBadge gesetzt.

        // PRD-007 (Memo 018 Kap 10): legacy revisions stay readable but are explicitly marked
        // "alte Version" — clear old/new separation. parseError surfaces an unreadable file
        // without dropping it from the listing ("kein stilles Scheitern").
        function revLegacyBadge( rev ) {
            if( !rev || rev.isLegacy !== true ) { return '' }
            var title = rev.parseError === true ? 'Revision nicht lesbar/parsebar' : 'Nicht kompatibel mit dem Fragen-System'
            return '<span class="rev-type rt-legacy" title="' + escapeAttr( title ) + '">alte Version</span>'
        }

        function revQuestionsMeta( doc ) {
            var q = normalizeQuestions( doc.questions )
            if( q.open > 0 ) { return q.open + ' offen' }
            if( q.answered > 0 ) { return q.answered + ' beantw.' }
            return '0 offen'
        }

        // PRD-016 (Memo 016 Kap 6): flatten the memos tree into a single list of memo entries.
        // Used by the queue computation below; mirrors the namespace-aware tree shape used
        // throughout renderSidebarMemos (node.memos OR a bare array for legacy nodes).
        function flattenTreeMemos() {
            var tree = lastTree || {}
            var collected = []
            Object.keys( tree ).forEach( function( projectId ) {
                var node = tree[ projectId ]
                var memos = []
                if( Array.isArray( node ) ) {
                    memos = node
                } else if( node && typeof node === 'object' ) {
                    memos = node.memos || []
                }
                memos.forEach( function( m ) { collected.push( m ) } )
            } )
            return collected
        }

        // PRD-002 (Memo 018 Kap 5): the sidebar Queue. Mirrors MemoView.computeOpenRevisionQueue.
        // BUGFIX (fix/transcript-abschliessen-queue): Queue = UNFINISHED revisions (revisionStatus
        // !== 'eingeloggt', the geschaerfte Warteschlangen-Regel from DocumentRegistry.isInQueue)
        // across ALL namespaces. 'offen' + 'transcript-eingetragen' stay; only 'eingeloggt' drops.
        // The result is a FLAT list of
        // { doc, rev } pairs — one entry per open revision, NO grouping by memo or namespace (F3=A).
        // Sorted FIFO = OLDEST ON TOP (ascending mtimeMs). Entries without a timestamp sink to the
        // bottom. Replaces the old memo-level filter (memoStatus 'Finalisiert' && no transcript).
        function computeQueue() {
            var pairs = []
            flattenTreeMemos().forEach( function( doc ) {
                if( !doc || typeof doc !== 'object' ) { return }
                // PRD-001 (Memo 019 Kap 1): a finalized memo is done — none of its revisions
                // enter the queue, even when a single revision still reads 'offen'.
                if( memoFinalizedFrom( doc.memoStatus ) ) { return }
                // PRD-22 #5 (Memo 079): a memo the boot Altbestand-Sweep marked 'done' (all revisions
                // carry an on-disk completion fact — StaleQueueSweep) is out of the queue but stays in
                // the sidebar tree. Mirrors MemoView.computeOpenRevisionQueue's status guard.
                if( doc.status === 'done' ) { return }
                ;( doc.revisions || [] ).forEach( function( rev ) {
                    // BUGFIX (fix/transcript-abschliessen-queue): mirror DocumentRegistry.isInQueue —
                    // a revision stays in the queue while NOT logged in. Both 'offen' and
                    // 'transcript-eingetragen' belong to the queue; ONLY 'eingeloggt' (= abgeschlossen)
                    // drops out. The revisionStatus is the transcript-derived status joined server-side
                    // (MemoView.enrichRevisionStatus). Legacy/parseError revisions never queue.
                    // Prepare-Revisionen (revisionType 'prepare') sind Basis-Snapshots (memo-revision-
                    // generate) und nie Queue-Material — sie spiegeln keinen offenen Transcript-Job.
                    // PRD-P1-03 (Memo 075, WI-008): mirror DocumentRegistry.isInQueue — a revision
                    // superseded by a newer non-prepare revision of the same memo (isSuperseded, joined
                    // server-side in MemoView.#markSupersededRevisions) drops out too, so an old revision
                    // without a transcript is no longer a perpetually-open dead end.
                    // PRD-22 #4 (Memo 079): a revision whose memo's open questions are ALL covered by an
                    // answer record (widget OR terminal, joined server-side in MemoView.#markAnswered-
                    // Revisions) drops out too — closing the terminal-answer Karteileiche (forensics b5).
                    if( rev && rev.revisionStatus !== 'eingeloggt' && rev.isLegacy !== true && rev.parseError !== true && rev.revisionType !== 'prepare' && rev.isSuperseded !== true && rev.answeredComplete !== true ) {
                        pairs.push( { doc: doc, rev: rev } )
                    }
                } )
            } )
            return pairs.slice().sort( function( a, b ) {
                var aMs = typeof a.rev.mtimeMs === 'number' ? a.rev.mtimeMs : null
                var bMs = typeof b.rev.mtimeMs === 'number' ? b.rev.mtimeMs : null
                if( aMs === null && bMs === null ) { return 0 }
                if( aMs === null ) { return 1 }
                if( bMs === null ) { return -1 }
                return aMs - bMs
            } )
        }

        // PRD-009 (Memo 024 Kap 7, F5=A): derive the stable per-entry keys of a queue (the same
        // { doc, rev } shape computeQueue() produces). A key is documentId::fileName — stable
        // across re-renders, so a plain re-render yields the identical key set and never triggers.
        function queueKeysOf( queue ) {
            return ( queue || [] )
                .filter( function( pair ) { return pair && pair.doc && pair.rev } )
                .map( function( pair ) { return String( pair.doc.documentId || '' ) + '::' + String( pair.rev.fileName || '' ) } )
        }

        // PRD-009: diff the current queue against the last snapshot and play a short ton on a real
        // new entry. The decision logic is the pure, unit-tested MemoView.detectQueueGrowth — this
        // wrapper only owns the snapshot state + the audio side effect. The baseline is always
        // updated to nextKeys so the next render compares against the freshest state.
        function maybeNotifyQueueGrowth( queue ) {
            var currentKeys = queueKeysOf( queue )
            // Inline of the (server-side, unit-tested) MemoView.detectQueueGrowth — the browser
            // bundle cannot reference the server class. No prior snapshot = initial load: seed the
            // baseline and never trigger. Otherwise a real new key plays the ton.
            if( lastQueueKeys === null || lastQueueKeys === undefined ) {
                lastQueueKeys = currentKeys
                return
            }
            var previousMap = {}
            lastQueueKeys.forEach( function( key ) { previousMap[ key ] = true } )
            var addedKeys = currentKeys.filter( function( key ) { return !previousMap[ key ] } )
            lastQueueKeys = currentKeys
            if( addedKeys.length > 0 ) { playQueueNotifyTone() }
        }

        // E4 (Memo 016 Kap 2): the single, gesture-gated AudioContext accessor. Returns null
        // before the first user gesture (autoplay policy — never construct a context early) and
        // afterwards lazily creates ONE shared context, reusing it on every call (no per-call
        // leak). Both notify tones go through here, so there is exactly one AudioContext.
        function acquireNotifyAudioCtx() {
            if( !audioGestureSeen ) { return null }
            var Ctx = window.AudioContext || window.webkitAudioContext
            if( !Ctx ) { return null }
            if( !notifyAudioCtx ) { notifyAudioCtx = new Ctx() }
            if( notifyAudioCtx.state === 'suspended' && notifyAudioCtx.resume ) { notifyAudioCtx.resume() }

            return notifyAudioCtx
        }

        // PRD-009 (AC-03/AC-06): a short Web-Audio oscillator ton — no external asset. The
        // AudioContext is created lazily and resumed; a context blocked by the autoplay policy
        // (no user gesture yet) degrades silently instead of throwing. Any failure is swallowed
        // so a missing/blocked audio backend never breaks the sidebar render.
        function playQueueNotifyTone() {
            try {
                var notifyCtx = acquireNotifyAudioCtx()
                if( !notifyCtx ) { return }

                var osc = notifyCtx.createOscillator()
                var gain = notifyCtx.createGain()
                var now = notifyCtx.currentTime

                osc.type = 'sine'
                osc.frequency.setValueAtTime( 880, now )
                gain.gain.setValueAtTime( 0.0001, now )
                gain.gain.exponentialRampToValueAtTime( 0.12, now + 0.02 )
                gain.gain.exponentialRampToValueAtTime( 0.0001, now + 0.22 )

                osc.connect( gain )
                gain.connect( notifyCtx.destination )
                osc.start( now )
                osc.stop( now + 0.24 )
            } catch( err ) {
                // Autoplay-blocked or no audio backend — degrade silently (AC-06).
            }
        }

        // Memo 081, WI-106/WI-107: ONE requester for ONE message, used by both the memos tree and the
        // transcripts tree. The server answers this socket with the new depth of BOTH catalogues; the
        // client never asks twice for the same project (scopedProjects) and never asks while an answer
        // is outstanding (pendingScopeProjects).
        function requestProjectScope( projectIds ) {
            var wanted = ( projectIds || [] ).filter( function( id ) {
                return typeof id === 'string' && id.length > 0 && !scopedProjects.has( id ) && !pendingScopeProjects.has( id )
            } )
            if( wanted.length === 0 ) { return false }
            if( !currentWs || currentWs.readyState !== 1 ) { return false }
            wanted.forEach( function( id ) { pendingScopeProjects.add( id ) } )
            currentWs.send( JSON.stringify( { 'type': 'requestProjectScope', 'projectIds': wanted } ) )
            return true
        }

        function renderSidebarMemos() {
            var navEl = document.getElementById( 'doc-sidebar-body' )
            if( !navEl ) { return }
            var tree = lastTree || {}

            // PRD-016 (Memo 016 Kap 6.1): seed every namespace into collapsedProjects ONCE so
            // groups render collapsed by default. A namespace already toggled open by the user
            // is left untouched on re-render (seededCollapseProjects guard).
            Object.keys( tree ).forEach( function( projectId ) {
                if( !seededCollapseProjects.has( projectId ) ) {
                    seededCollapseProjects.add( projectId )
                    collapsedProjects.add( projectId )
                }
                // PRD-006 (Memo 019 Kap 6.6): seed every memo of the namespace into
                // collapsedMemos ONCE so memos also render collapsed by default. Same seed-once
                // guard as the namespace level — a user-expanded memo stays expanded on re-render.
                var node = tree[ projectId ]
                var memosForSeed = Array.isArray( node ) ? node : ( node && typeof node === 'object' ? ( node.memos || [] ) : [] )
                memosForSeed.forEach( function( m ) {
                    if( m && m.documentId && !seededCollapseMemos.has( m.documentId ) ) {
                        seededCollapseMemos.add( m.documentId )
                        collapsedMemos.add( m.documentId )
                    }
                } )
            } )

            // PRD-005 (Memo 022 Kap 9): rev-mini Fokus-Redesign. Die Informationshierarchie wird
            // geschaerft — Memo Kap 9 ist hier die hoechste Autoritaet (das Pencil-Mockup v4 zeigt
            // noch Doc-Icon + Typ-Badge + prominentes Datum; uebernommen werden NUR die visuellen
            // Tokens, nicht die Hierarchie). Neue Reihenfolge pro Zeile:
            //   1. REV-NN PROMINENT + vorne (erster textlicher Identifikator)
            //   2. Datum sekundaer (lesbar, aber gedaempft)
            //   3. Minuten-Chip (mic-Symbol + "N Min") als Leitkennzahl
            //   4. Spacer
            //   5. dezentes Status-Symbol (offen/abgeschlossen) statt grossem "ABGESCHLOSSEN"-Badge
            //   6. Fragen-Chip (offene Revisionen)
            // ENTFERNT: Doc-Icon (file-text), Typ-/FULL-Badge (redundant bei nur-Full, PRD-004).
            // Beibehalten: revLegacyBadge (Legacy bleibt sichtbar gedimmt).
            // Konstante Zeilenhoehe (min-height 38px) ueber alle Zustaende. Visuelle Tokens aus
            // Pencil v4 (7RCLz aktiv / yesxz inaktiv): height 38, radius 7, gap 8, padding 0/10.
            // PRD-006 (Memo 022 Kap 7): die drei funktionslosen Hover-Action-Icons (copy/open/
            // trash) sind ENTFERNT — kein Click-Handler war je verdrahtet (falsche Affordanz).
            // PRD-004 (Memo 022 Kap 8): sidebar revision filter. When showOnlyFullRevisions is ON
            // (Default), only Full-Revisionen pass; Prepare/Update are hidden (visual only). A
            // missing/unknown revisionType is treated as 'full' (Fallback konsistent zum
            // data-state in renderRevEntry). Flag OFF -> every revision passes.
            function revisionPassesConfigFilter( rev ) {
                var cfg = window.__MEMO_CONFIG__ || {}
                if( cfg.showOnlyFullRevisions !== true ) { return true }
                var revType = ( rev && rev.revisionType ) ? rev.revisionType : 'full'
                return revType === 'full'
            }

            // Memo 081, WI-070: THE FILTER REPORTS WHAT IT TOOK AWAY. The predicate above is unchanged —
            // what changes is that its loss becomes a number. Measured before this change: 13 of 27
            // registered revisions of memo 081 vanished from the tree without a single digit, and over
            // the whole corpus 184 of 524 (35.1 %). A filter that does not say how much it removed is
            // the display twin of a vacuum-green gate, and the same sidebar showed an update revision
            // under "Letzte Revisionen" while hiding it here — two truths about one stock, neither
            // declaring itself a selection. Returns the partition, so the caller renders the rest
            // instead of quietly shrinking the list.
            function partitionRevisionsByConfigFilter( revisions ) {
                var list = Array.isArray( revisions ) ? revisions : []
                var kept = list.filter( revisionPassesConfigFilter )
                var hidden = list.filter( function( rev ) { return revisionPassesConfigFilter( rev ) !== true } )
                var byType = hidden.reduce( function( acc, rev ) {
                    var type = ( rev && rev.revisionType ) ? rev.revisionType : 'full'
                    acc[ type ] = ( acc[ type ] || 0 ) + 1
                    return acc
                }, {} )

                return { kept: kept, hidden: hidden, byType: byType, considered: list.length }
            }

            // The German display text for the hidden row. Field and class names stay English, the label
            // speaks the language of the rest of the sidebar ("Warteschlange", "Basis-Snapshot") — a
            // German label over an English field is two artefacts, not mixed language in one.
            function hiddenRevisionsLabel( partition ) {
                var order = [ 'prepare', 'update', 'full' ]
                var parts = order
                    .filter( function( type ) { return ( partition.byType[ type ] || 0 ) > 0 } )
                    .map( function( type ) { return partition.byType[ type ] + ' ' + type } )

                return partition.hidden.length + ' ausgeblendet (' + parts.join( ', ' ) + ')'
            }

            function renderRevEntry( doc, rev ) {
                // Memo 081, WI-106: `doc.selectedRevision` is no longer a fact of the document but of THIS
                // connection — the server lays this viewer's own selection over the shared tree. The
                // comparison is unchanged; what changed is that two readers now get two answers.
                var isSelected = rev.fileName === doc.selectedRevision
                var cls = 'rev-mini'
                if( isSelected ) { cls += ' rev-mini-active' }
                // PRD-001 (Memo 019 Kap 1): legacy/parseError revisions stay listed in the
                // namespace tree but are visually dimmed (greyed out) and never enter the queue.
                var isLegacy = rev.isLegacy === true || rev.parseError === true
                if( isLegacy ) { cls += ' rev-legacy-muted' }

                var revLabel = rev.fileName.replace( /\.md$/, '' )
                var hasOwnTranscript = hasTranscriptForRevision( doc.memoName, revLabel )

                // 1. REV-NN PROMINENT + vorne (Memo Kap 9: primaerer Identifikator). Die
                // Transcript-Kopplung (eigenes Transcript der Revision) wird ueber data-rev-transcript
                // + Akzent-Farbe getragen, NICHT mehr ueber ein separates Doc-Icon (entfernt).
                var numCls = hasOwnTranscript ? 'rev-mini-num rev-mini-num-transcript' : 'rev-mini-num'
                var inner = '<span class="' + numCls + '" data-rev-num data-rev-transcript="' + ( hasOwnTranscript ? '1' : '0' ) + '">' + escapeAttr( revLabel ) + '</span>'
                // PRD-007 (Memo 018 Kap 10): Legacy/inkompatible Revisionen bleiben markiert.
                inner += revLegacyBadge( rev )
                // 2. Datum sekundaer (lesbar, gedaempft).
                var dateText = rev.mtime ? rev.mtime : ''
                inner += '<span class="rev-mini-date" data-rev-date>' + escapeAttr( dateText ) + '</span>'
                // 3. Minuten-Chip (Leitkennzahl): mic-Symbol + "N Min". Wert deterministisch aus
                // dem eigenen Revisions-Transcript, sonst 0 (kein erfundener Default, kein
                // Memo-Aggregat als Revisions-Wert). Visuelle Tokens aus Pencil v4.
                var revMinutes = aggregateRevisionMinutes( doc.memoName, revLabel )
                inner += '<span class="rev-mini-minutes" data-rev-minutes="' + revMinutes + '" title="Eingesprochene Minuten dieser Revision"><span class="rev-mini-mic" aria-hidden="true">\uD83C\uDF99</span>' + revMinutes + ' Min</span>'
                inner += '<span class="rev-mini-spacer"></span>'
                // 5. Dezentes Status-Symbol (offen vs. abgeschlossen) statt grossem Text-Badge.
                // Gefuellter Punkt = abgeschlossen (eingeloggt), offener Punkt = offen.
                var revDone = rev.revisionStatus === 'eingeloggt'
                var statusSym = revDone ? '\u25CF' : '\u25CB'
                var statusTitle = revDone ? 'Abgeschlossen (Transcript eingeloggt)' : 'Offen'
                inner += '<span class="rev-mini-status' + ( revDone ? ' rev-mini-status-done' : '' ) + '" data-rev-status="' + ( revDone ? 'eingeloggt' : 'offen' ) + '" title="' + escapeAttr( statusTitle ) + '">' + statusSym + '</span>'
                // 6. Fragen-Chip rechts (offene Revisionen). Prepare zeigt stattdessen die Note.
                if( rev.revisionType === 'prepare' ) {
                    inner += '<span class="rev-mini-note">Basis-Snapshot</span>'
                } else if( rev.revisionType === 'update' ) {
                    // Memo 081, WI-070: an update row can now actually appear in the tree (revealed via
                    // the hidden-count row), so it says what it is. Without this a revealed update row
                    // would be indistinguishable from a full revision — the type would live only in the
                    // data-state attribute, which is a hook, not a display.
                    inner += '<span class="rev-mini-note">Update</span>'
                } else {
                    // Memo 081 (WI-064, A6 Gegenprobe): a SIXTH reader of doc.questions, which the PRD's
                    // inventory of display sites did not list. It rendered a hard "0" for every revision
                    // that is not the selected one — a zero that never counted anything, on every row of
                    // the tree. Same rule as its five siblings: only a counted figure is shown as a number.
                    var revMeta = normalizeQuestions( doc.questions )
                    var revCounted = isSelected && revMeta.basis === true
                    var revChipTitle = isSelected
                        ? questionCountTitle( revMeta )
                        : 'Nicht gezählt — gezählt wird die ausgewählte Revision'
                    inner += '<span class="rev-mini-chip" data-rev-chip data-basis="' + ( revCounted ? '1' : '0' ) + '"'
                        + ' title="' + escapeAttr( revChipTitle ) + '"><span class="rev-mini-chip-q">?</span>'
                        + ( revCounted ? revMeta.open : '' ) + '</span>'
                }

                // Memo 081, WI-066: the row becomes a real link. The <li> keeps its data-doc/data-rev
                // attributes — the existing binding and the existing tests hang off them — and only the
                // SHELL around the unchanged inner content changes. display:contents leaves the flex row
                // exactly as it was, so app.css is not touched; inline style attributes are this
                // client's established form and are covered by style-src 'self' 'unsafe-inline'.
                var entryHtml = '<li class="' + cls + '" data-doc="' + escapeAttr( doc.documentId ) + '" data-rev="' + escapeAttr( rev.fileName ) + '" data-state="' + escapeAttr( rev.revisionType || 'full' ) + '">'
                entryHtml += '<a class="rev-mini-link" href="' + escapeAttr( docPathFor( doc.documentId, rev.fileName ) ) + '" style="display:contents">'
                entryHtml += inner
                entryHtml += '</a>'
                entryHtml += '</li>'
                return entryHtml
            }

            // PRD-001 (Memo 019 Kap 1): a Queue item carries the FULL information model so the
            // user sees at a glance where an entry comes from and what to do:
            //   line1: Namespace/Projekt-Label + Memo-Nr + Name + REV-ID + Status der Revision
            //   line2: Datum + Anzahl offener Fragen
            // Missing single values stay EMPTY (no invented default, AC-12) — the item never
            // crashes. The list stays FLAT and FIFO-sorted; the namespace is a label, not a group.
            // PRD-007 (Memo 019 Kap 7.4): the Queue-Item is its OWN, reicher Container (Soll
            // RdoSV/EHlQV, height 62, radius 8, linker Akzent-Balken 4px) — NICHT die 1:1-
            // Wiederverwendung der Baum-Revisionszeile. Drei Info-Zeilen:
            //   Zeile 1 (C0JZD): Memo-Titel + Fragen-Chip "❓N"
            //   Zeile 2 (8qi4f): "REV-NN · offen"
            //   Zeile 3 (Z36pN): folder-Icon + Namespace + · Datum
            // Pro Item klar erkennbar: Namespace · Datum · Anzahl offener Fragen (AC-5).
            // Fehlende Einzelwerte bleiben LEER (kein erfundener Default, AC-12 Phase 1).
            // WI-028 (Memo 076): sameNsAsPrev de-dups the namespace label across CONSECUTIVE queue items
            // of the SAME namespace (the queue is flat/FIFO, not grouped). Optional — undefined -> false ->
            // renders as before (backwards-safe). Only the ns text (Zeile 3) is suppressed; folder-icon +
            // date stay so each row keeps its shape.
            function renderQueueEntry( pair, sameNsAsPrev ) {
                var doc = pair.doc
                var rev = pair.rev
                var revLabel = String( rev.fileName || '' ).replace( /\.md$/, '' )
                // Memo 081 (WI-069, Ä6): the queue card is a PER-MEMO figure — it has no viewed revision to
                // count — so it keeps the registry source and names it instead. "? 0" was the reported
                // symptom here; with basis:false the card now shows a bare "?" and its title says why.
                var qCard = normalizeQuestions( doc.questions )
                var openNum = qCard.open
                var cardTitle = questionCountTitle( qCard )
                // BUGFIX (fix/transcript-abschliessen-queue): the queue now holds 'offen' AND
                // 'transcript-eingetragen' revisions (only 'eingeloggt' drops out). Map the raw enum
                // to a readable status word so the card line reads "REV-NN · offen" or
                // "REV-NN · transcript hinterlegt" (kein roher Enum, ruhige Formsprache Memo 019).
                var statusLabel = rev.revisionStatus === 'transcript-eingetragen' ? 'transcript hinterlegt' : ( rev.revisionStatus === 'eingeloggt' ? 'abgeschlossen' : ( rev.revisionStatus || '' ) )
                var revStatusLine = revLabel ? ( revLabel + ( statusLabel ? ( ' \u00b7 ' + statusLabel ) : '' ) ) : statusLabel
                // PRD-006 (Memo 024 Kap 5): the Queue-Card now carries the same Minuten-Chip as the
                // Sidebar (PRD-005) — same data source aggregateMemoMinutes( doc.memoName ). 0
                // transcripts -> "🎙 0 Min" (kein erfundener Default).
                var queueMemoMinutes = aggregateMemoMinutes( doc.memoName || '' )
                // PRD-006 (Memo 024 Kap 5): the Lifecycle-Status (PRD-004 model) of the memo — NOT
                // the raw revision enum. deriveLifecycleStatusFor mirrors DocumentRegistry.
                // deriveLifecycleStatus (planCompleted has no frontend source yet, additiver Hook).
                var queueLifecycle = deriveLifecycleStatusFor( doc.memoStatus, ( doc.revisions || [] ).length )
                // Memo 079 M4 (T013): a db-backed memo mid-rollout carries a RAW lifecycleState. When it is
                // one of the four progression states (or abgebrochen) show that DISTINCT sub-label instead of
                // the collapsed 'Finalisiert'/'Abgeschlossen' — the exact "nur finalisiert" picture T013 set
                // out to replace. Legacy memos (lifecycleState null) keep the coarse label unchanged.
                var rolloutSubLabel = rolloutSubLabelFor( doc.lifecycleState )
                var queueLifecycleDisplay = rolloutSubLabel || queueLifecycle

                // Memo 081, WI-066: same shell, same reasoning as the revision row above.
                var html = '<li class="queue-card" data-doc="' + escapeAttr( doc.documentId ) + '" data-rev="' + escapeAttr( rev.fileName ) + '">'
                html += '<a class="queue-card-link" href="' + escapeAttr( docPathFor( doc.documentId, rev.fileName ) ) + '" style="display:contents">'
                html += '<span class="queue-card-bar" aria-hidden="true"></span>'
                html += '<span class="queue-card-info" data-queue-info>'
                // Zeile 1: Memo-Titel + Minuten-Chip + Fragen-Chip.
                html += '<span class="queue-card-row1">'
                html += '<span class="queue-card-title" data-queue-title>' + escapeAttr( doc.memoName || '' ) + '</span>'
                html += '<span class="queue-card-spacer"></span>'
                html += '<span class="queue-card-minutes" data-queue-minutes="' + queueMemoMinutes + '" title="Gesamte gesprochene Transcript-Dauer">\uD83C\uDF99 ' + queueMemoMinutes + ' Min</span>'
                html += '<span class="queue-card-chip" data-queue-chip data-basis="' + ( qCard.basis ? '1' : '0' ) + '"'
                    + ' title="' + escapeAttr( cardTitle ) + '"><span class="queue-card-chip-q">?</span>'
                    + ( qCard.basis ? openNum : '' ) + '</span>'
                html += '</span>'
                // Zeile 2: REV-NN · offen + Lifecycle-Status des Memos (PRD-004-Modell). Memo 079 M4: the
                // label shows the distinct rollout sub-label when present; data-queue-lifecycle keeps the
                // coarse rung and data-queue-lifecycle-state carries the RAW db state (empty for legacy).
                var rolloutStateAttr = rolloutSubLabel ? ( ' data-queue-lifecycle-state="' + escapeAttr( doc.lifecycleState || '' ) + '"' ) : ''
                var lifecycleClass = rolloutSubLabel ? 'queue-card-lifecycle queue-card-lifecycle-rollout' : 'queue-card-lifecycle'
                html += '<span class="queue-card-row2" data-queue-status data-queue-lifecycle="' + escapeAttr( queueLifecycle ) + '"' + rolloutStateAttr + '>' + escapeAttr( revStatusLine ) + '<span class="' + lifecycleClass + '" data-queue-lifecycle-label>' + escapeAttr( queueLifecycleDisplay ) + '</span></span>'
                // Zeile 3: folder + Namespace + · Datum. WI-028: the ns label is suppressed when this item
                // repeats the previous item's namespace (no per-item repetition of the same namespace).
                html += '<span class="queue-card-row3">'
                html += '<span class="queue-card-folder" aria-hidden="true">\uD83D\uDCC1</span>'
                if( !sameNsAsPrev ) { html += '<span class="queue-card-ns" data-queue-ns>' + escapeAttr( doc.projectId || '' ) + '</span>' }
                if( rev.mtime ) { html += '<span class="queue-card-date" data-queue-date>\u00b7 ' + escapeAttr( rev.mtime ) + '</span>' }
                html += '</span>'
                html += '</span></a></li>'
                return html
            }

            // Memo-header row (caret + status icon + name + transcript count) + indented revisions.
            function renderMemo( doc ) {
                var isActive = !!doc.selectedRevision
                var isMemoCollapsed = collapsedMemos.has( doc.documentId )
                var memoCaret = isMemoCollapsed ? '&#9656;' : '&#9662;'
                var revDisplay = isMemoCollapsed ? 'none' : 'block'
                var memoHtml = '<div class="memo-group" data-memo="' + escapeAttr( doc.documentId ) + '">'
                memoHtml += '<div class="memo-head' + ( isActive ? ' selected' : '' ) + '" data-memo-toggle="' + escapeAttr( doc.documentId ) + '" title="Revisionen ein-/ausklappen">'
                memoHtml += '<span class="mh-caret">' + memoCaret + '</span>'
                // PRD-011 (#4): the memo-head icon shows the pure MEMO status only — it must
                // NOT mix in transcript presence (that suggested "Transcript hinterlegt" for the
                // whole memo even when only single revisions had transcripts). Per-revision
                // transcript presence is now shown on each revision entry (renderRevEntry).
                // PRD-001 (Memo 018 Kap 4): the icon is driven by (revisionStatus, memoFinalized).
                // For the memo-head we keep a clean memo-status indicator (◐ Wartet / ✓ Finalisiert):
                // finalisiert -> 'eingeloggt' + true -> ✓, otherwise 'offen' -> ◐. Aggregate
                // transcript presence stays on the transcript-indicator pill, not this icon.
                var memoHeadFinalized = memoFinalizedFrom( doc.memoStatus )
                var memoHeadRevStatus = memoHeadFinalized ? 'eingeloggt' : 'offen'
                memoHtml += '<span class="mh-icon">' + statusIconFor( memoHeadRevStatus, memoHeadFinalized ) + '</span>'
                // Memo 081, WI-066: the memo name becomes a TARGET while the row stays a SWITCH. Beleg
                // 29.2 named "the memo name in the tree is only a toggle, not a target" as one of three
                // reasons a fresh browser context cannot reach a document; this is that reason closed.
                // The short form /doc/{documentId} is what makes it possible — a memo head has no single
                // revision to point at.
                memoHtml += '<span class="mh-name"><a href="' + escapeAttr( docPathFor( doc.documentId, null ) ) + '" style="display:contents">' + escapeAttr( doc.memoName ) + '</a></span>'
                // Fix (#81): the full-width break keeps the memo name on line 1 to itself so the
                // status cluster wraps to line 2 — a long name stays fully readable.
                // PRD-005 (Memo 024 Kap 4, F4=A): the break is now UNCONDITIONAL — every memo
                // renders a fixed 2-line structure (Zeile 1 = Name, Zeile 2 = Status-Cluster),
                // even a plain "Entwurf" memo (the minutes chip below always provides a cluster).
                memoHtml += '<span class="mh-break"></span>'
                if( doc.memoStatus && doc.memoStatus !== 'Entwurf' ) {
                    memoHtml += '<span class="memo-badge ' + badgeClassFor( doc.memoStatus ) + '">' + escapeAttr( doc.memoStatus ) + '</span>'
                }
                memoHtml += '<span class="mh-spacer"></span>'
                // PRD-001 (Memo 019 Kap 1): a finalized memo shows NO date — instead a chip with
                // a microphone icon + the aggregated spoken minutes + "Min" (kurz, ohne "gesprochen").
                // Source = sum of all memo-transcript minutes (~200 Woerter/Min). 0 transcripts ->
                // "🎙 0 Min" (no invented default, no date fallback). Open memos keep "Entwurf"
                // + revisions unchanged (the chip is finalized-only).
                // PRD-007 (Memo 019 Kap 7.5): a finalized COLLAPSED memo shows a Minuten-Chip
                // (mic-Icon + "N Min", Soll bylkP) plus a "finalisiert" Status-Badge (check-Icon
                // + "finalisiert", Soll BVf3c). The minutes data source is Phase 1; here the
                // LAYOUT-Soll is verbindlich. Open memos keep "Entwurf" + revisions unchanged.
                // PRD-005 (Memo 024 Kap 4, F4=A): the Minuten-Chip is now rendered for EVERY memo,
                // unconditionally — independent of status (Entwurf, In Bearbeitung, Finalisiert,
                // Abgeschlossen, Bedingt finalisiert). 0 transcripts -> "🎙 0 Min" (kein erfundener
                // Default, kein Datums-Fallback). The data-memo-minutes attribute carries the raw
                // integer so the global sum (Sidebar-Kopf) can aggregate the displayed chips.
                var memoMinutes = aggregateMemoMinutes( doc.memoName )
                memoHtml += '<span class="mh-minutes" data-memo-minutes="' + memoMinutes + '" title="Gesamte gesprochene Transcript-Dauer">\uD83C\uDF99 ' + memoMinutes + ' Min</span>'
                // PRD-019 (Memo 016 Kap 7.3): emoji reduction. The ❓ emoji is replaced by a
                // quiet textual count badge ("N ?") — same information (open questions exist +
                // how many), no colourful emoji. Hidden when there are no open questions.
                // Memo 081 (WI-069, Ä6): same per-memo figure as the queue card, same declaration. Three
                // states instead of two: a COUNTED zero stays hidden (`:empty`, unchanged), a counted number
                // renders as before, and an UNCOUNTED memo shows a bare "?" — the old silent-zero form hid
                // exactly the case that needed to be seen.
                var qRow = normalizeQuestions( doc.questions )
                var openCount = qRow.open
                var rowTitle = qRow.basis ? ( 'Offene Fragen anzeigen — ' + questionCountTitle( qRow ) ) : questionCountTitle( qRow )
                // PRD-006 (Kap 6.4 / AC-10): "?" und Zahl in eigene Spans, damit der Chip-gap
                // den Box-Abstand zum Fragezeichen vergroessert. Leer bei 0 -> :empty blendet aus.
                var qlContent = ''
                if( qRow.basis !== true ) {
                    qlContent = '<span class="ql-q">\u003f</span>'
                } else if( openCount > 0 ) {
                    qlContent = '<span class="ql-q">\u003f</span><span class="ql-n">' + openCount + '</span>'
                }
                memoHtml += '<span class="questions-link" data-document-id="' + escapeAttr( doc.documentId ) + '" data-selected-rev="' + escapeAttr( doc.selectedRevision || '' ) + '" data-open="' + openCount + '" data-basis="' + ( qRow.basis ? '1' : '0' ) + '" title="' + escapeAttr( rowTitle ) + '">' + qlContent + '</span>'
                memoHtml += '</div>'
                memoHtml += '<ul data-memo-list="' + escapeAttr( doc.documentId ) + '" style="list-style:none;padding:0;margin:2px 0 0;display:' + revDisplay + '">'
                // PRD-004 (Memo 022 Kap 8): when showOnlyFullRevisions is ON (Default), Prepare-
                // and Update-Revisionen werden in der Sidebar AUSGEBLENDET (rein visuell — Registry
                // und Tree-Payload bleiben unveraendert). Fehlender/unbekannter Typ -> als 'full'
                // behandelt (Fallback konsistent zum data-state in renderRevEntry).
                // Memo 081, WI-070: the same predicate, but the remainder is no longer dropped on the
                // floor. `hidden` is rendered as ONE row that names the number and the types and is
                // itself the control that opens them — the config switch showOnlyFullRevisions has no
                // operating element anywhere (measured: 13 code sites, none of them an input, its only
                // override a gitignored file read once at server start), so "reachable" had to be built,
                // not configured. An empty `hidden` renders NOTHING: a "0 ausgeblendet" line under every
                // memo would be noise, and from the outside it is indistinguishable from "nothing was
                // filtered" anyway.
                // Memo 081, WI-106: a memo whose project is OUT OF SCOPE carries `revisionsIncluded:
                // false` and an empty list. Rendering that as an empty revision list would show "nothing
                // here" for a memo with 27 revisions — a missing basis dressed up as a result, which is
                // the display twin of the vacuum-green gate this project keeps taking apart. It gets a
                // NAMED row instead, and the number in it comes from revisionCounts (shipped to 385 of
                // 385 documents since PRD-35 and, until now, read by nobody here).
                var counts = ( doc.revisionCounts && typeof doc.revisionCounts === 'object' ) ? doc.revisionCounts : null
                var registered = ( counts && typeof counts.registered === 'number' )
                    ? counts.registered
                    : ( typeof doc.revisionCount === 'number' ? doc.revisionCount : null )
                if( doc.revisionsIncluded === false ) {
                    // The muted "rev-hidden-note" styling is reused deliberately: app.css is not touched
                    // by this change, and a row that states a missing basis should read like the other
                    // quiet meta row of this list, not like a revision.
                    memoHtml += '<li class="rev-hidden-note rev-not-loaded" data-rev-not-loaded="' + escapeAttr( doc.documentId ) + '"'
                        + ' data-rev-registered="' + ( registered === null ? '' : registered ) + '">'
                        + escapeHtml( registered === null ? 'Revisionen noch nicht geladen' : ( registered + ' Revisionen \u00b7 noch nicht geladen' ) )
                        + '</li>'
                    memoHtml += '</ul></div>'
                    return memoHtml
                }
                var partition = partitionRevisionsByConfigFilter( doc.revisions )
                // Memo 081, Phasen-Abnahme C1-3 § 2.4: a deep link to a HIDDEN revision used to show its
                // content with no row anywhere and zero active markers in the whole tree — the reader saw
                // content without a position. Neither PRD-33 nor PRD-35 owns that state; it appears only
                // when they are composed. It closes here because the server now knows, PER CONNECTION,
                // what THIS reader is looking at (doc.selectedRevision is this socket's own selection) and
                // can say so without pushing that selection onto everybody else.
                var viewedIsHidden = partition.hidden.some( function( rev ) { return rev.fileName === doc.selectedRevision } )
                var isRevealed = revealedMemos.has( doc.documentId ) || viewedIsHidden
                var shown = isRevealed ? ( doc.revisions || [] ) : partition.kept
                ;( shown ).forEach( function( rev ) {
                    memoHtml += renderRevEntry( doc, rev )
                } )
                if( partition.hidden.length > 0 ) {
                    memoHtml += '<li class="rev-hidden-note' + ( isRevealed ? ' rev-hidden-note-open' : '' ) + '"'
                        + ' data-hidden-toggle="' + escapeAttr( doc.documentId ) + '"'
                        + ' data-hidden-count="' + partition.hidden.length + '"'
                        + ' data-hidden-types="' + escapeAttr( JSON.stringify( partition.byType ) ) + '"'
                        + ' data-hidden-considered="' + partition.considered + '"'
                        + ' title="' + escapeAttr( isRevealed ? 'Ausgeblendete Revisionen wieder einklappen' : 'Ausgeblendete Revisionen anzeigen' ) + '">'
                        + escapeHtml( ( isRevealed ? '▾ ' : '▸ ' ) + hiddenRevisionsLabel( partition ) )
                        + '</li>'
                }
                memoHtml += '</ul></div>'
                return memoHtml
            }

            var html = ''

            // PRD-002 (Memo 018 Kap 5): the Queue (Warteschlange) renders ABOVE the namespace
            // groups. Contents = open revisions (computeQueue, FIFO oldest on top), flat one entry
            // per open revision. Each entry uses the SAME markup as the namespace revision lines
            // (renderRevEntry) — no separate queue-entry style. Empty -> a quiet placeholder.
            // PRD-005 (Memo 024 Kap 4): the global sidebar-head minutes total was removed on user
            // feedback (not needed). Per-memo minute chips (aggregateMemoMinutes) stay.

            var queue = computeQueue()
            // PRD-009 (Memo 024 Kap 7, F5=A): Audio-Notify on a NEW queue entry. The diff runs on
            // stable documentId::fileName keys (not counts) so a swap still counts. The very first
            // pass only seeds the baseline (lastQueueKeys === null) and stays silent (AC-04).
            maybeNotifyQueueGrowth( queue )
            html += '<div class="sb-group-header">Warteschlange</div>'
            if( queue.length === 0 ) {
                html += '<div class="sb-queue-empty">Nichts in der Warteschlange.</div>'
            } else {
                html += '<div class="sb-queue"><ul style="list-style:none;padding:0;margin:0">'
                // WI-028: carry the previous item's namespace so renderQueueEntry can suppress a repeated
                // ns label on consecutive same-namespace items (the queue is flat/FIFO, not grouped).
                var prevQueueNs = null
                queue.forEach( function( pair ) {
                    var thisNs = ( pair.doc && pair.doc.projectId ) ? pair.doc.projectId : ''
                    html += renderQueueEntry( pair, thisNs === prevQueueNs )
                    prevQueueNs = thisNs
                } )
                html += '</ul></div>'
            }
            html += '<div class="sb-divider"></div>'

            // PRD-003 (Memo 018 Kap 6): "Namespaces" section header above the namespace groups,
            // mirroring the "Warteschlange" header. Only rendered when at least one namespace exists.
            if( Object.keys( tree ).length > 0 ) {
                html += '<div class="sb-group-header">Namespaces</div>'
            }

            // PRD-006 (Memo 019 Kap 6.7): each namespace (= project) is an OUTER BOX (Soll npwAk:
            // radius 10, stroke #D4D4D8/1.5, clip). The box wraps the NS-Header (Soll Q2uZD:
            // chevron + folder + Name 13px/700 + spacer + Memo-Count-Chip "N Memos", height 42)
            // and the NS-Body (Soll ZUXs3: padding [6,8,8,8]) holding all memos. Hierarchie genau
            // Namespace -> Memo -> Revision (drei Stufen, keine vierte — AC-6 / F5).
            // The folder icon flips open/closed, the count-chip mirrors the collapsed/expanded fill.
            function nsHeaderInner( projectId, memoCount, collapsed ) {
                var chevron = collapsed ? '&#9656;' : '&#9662;'
                var folder = collapsed ? '\uD83D\uDCC1' : '\uD83D\uDCC2'
                var inner = '<span class="ns-chevron" data-ns-chevron>' + chevron + '</span>'
                inner += '<span class="ns-folder" aria-hidden="true">' + folder + '</span>'
                inner += '<span class="ns-name" data-ns-name>' + escapeAttr( projectId ) + '</span>'
                inner += '<span class="ns-spacer"></span>'
                inner += '<span class="ns-count" data-ns-count>' + memoCount + ' Memos</span>'
                return inner
            }

            // PRD-014 (Memo 076 Phase 7, WI-009): a namespace is ACTIVE when at least one registered
            // client is logged into it (lastClients[].projectId === projectId, non-stale) — a DERIVED
            // marker off the live clientList snapshot, NEVER a stored field. It rides the memos render
            // (unified projects[] source) so a config-rehydrated project with no working CC instance
            // reads as idle ([data-active="false"]) in the namespace tree/dropdown.
            function deriveProjectActive( projectId ) {
                var list = Array.isArray( lastClients ) ? lastClients : []
                return list.some( function( client ) {
                    return client && client.projectId === projectId && client.status !== 'stale'
                } )
            }

            Object.keys( tree ).forEach( function( projectId ) {
                var projectNode = tree[ projectId ]
                var memos = []

                if( Array.isArray( projectNode ) ) {
                    memos = projectNode
                } else if( projectNode && typeof projectNode === 'object' ) {
                    memos = projectNode.memos || []
                }

                // Memo 081, WI-106: a project with an empty memo list used to VANISH from the sidebar
                // (the `return` that stood here), while its header count was taken from that same list.
                // Both are derivations from what arrived, and with a scoped catalogue a derivation from
                // what arrived is a statement about what was SENT wearing the label of what EXISTS. The
                // head is rendered either way and the count comes from the tree's own figure.
                var isCollapsed = collapsedProjects.has( projectId )
                var bodyDisplay = isCollapsed ? 'none' : 'block'
                var boxCls = 'ns-box' + ( isCollapsed ? ' ns-box-collapsed' : '' )
                var isActive = deriveProjectActive( projectId )

                html += '<div class="' + boxCls + '" data-namespace="' + escapeAttr( projectId ) + '" data-active="' + ( isActive ? 'true' : 'false' ) + '">'
                html += '<div class="ns-header" data-project="' + escapeAttr( projectId ) + '" title="Namespace ein-/ausklappen">'
                var memoCount = ( projectNode && typeof projectNode.memoCount === 'number' ) ? projectNode.memoCount : memos.length
                html += nsHeaderInner( projectId, memoCount, isCollapsed )
                html += '</div>'
                html += '<div class="ns-body" data-project-list="' + escapeAttr( projectId ) + '" style="display:' + bodyDisplay + '">'
                memos.forEach( function( doc ) {
                    html += renderMemo( doc )
                } )
                html += '</div></div>'
            } )

            // PRD-003 (Memo 018 / 015 REV-05 F6): the "Neue Memos" section was removed. The
            // sidebar now contains exactly two sections — Warteschlange (top) and Namespaces.

            navEl.innerHTML = html

            // PRD-002 (Memo 018 Kap 5): queue entries are rendered via renderRevEntry, which carries the
            // same data-doc/data-rev pair as the revision lines. ONE binding serves both.
            // WI-103 (Memo 080 Kap 15): that binding used to be an inline onclick= attribute in the
            // generated markup — the last thing on the page that forced 'unsafe-inline' into script-src
            // and thereby made the Sicherheits-Kopf worth less than the header it is written in. Bound
            // here instead, the policy needs no script exception at all.
            // Memo 081, WI-066: the row now carries a real href, so the handler takes the EVENT and
            // decides. A plain left click keeps today's in-app selection without a page load
            // (preventDefault, then the unchanged selectRevision call); middle click and
            // Cmd/Ctrl/Shift/Alt fall through to the browser and open a new tab. Letting those through
            // is not a detail — it is the difference between a link and a string that looks like one.
            navEl.querySelectorAll( 'li[data-doc][data-rev]' ).forEach( function( el ) {
                el.addEventListener( 'click', function( ev ) {
                    if( !isPlainLeftClick( ev ) ) { return }
                    if( ev && typeof ev.preventDefault === 'function' ) { ev.preventDefault() }
                    selectRevision( el.getAttribute( 'data-doc' ), el.getAttribute( 'data-rev' ) )
                } )
            } )

            // Memo 081, WI-066: the memo name navigates, the rest of the head keeps toggling. Same
            // stopPropagation convention the other inner interactive children of .memo-head already use
            // — no preventDefault here, so the name really does navigate to its own address.
            navEl.querySelectorAll( '.mh-name a[href]' ).forEach( function( el ) {
                el.addEventListener( 'click', function( ev ) {
                    if( ev && typeof ev.stopPropagation === 'function' ) { ev.stopPropagation() }
                } )
            } )

            // PRD-006 (Memo 019 Kap 6.9): namespace box toggle. Clicking the NS-Header collapses/
            // expands the box body (the memos). Navigation must be reliable — the WHOLE header is
            // the hit target and the chevron/folder/count-chip rebuild consistently on toggle.
            navEl.querySelectorAll( '.ns-header[data-project]' ).forEach( function( el ) {
                el.addEventListener( 'click', function() {
                    var projectId = el.getAttribute( 'data-project' )
                    if( collapsedProjects.has( projectId ) ) {
                        collapsedProjects.delete( projectId )
                    } else {
                        collapsedProjects.add( projectId )
                    }
                    var nowCollapsed = collapsedProjects.has( projectId )
                    // Memo 081, WI-106/WI-107: opening a project is the moment its depth is needed —
                    // the revision lists are 60.1 % of the catalogue and a collapsed project never
                    // shows them. The request is additive: an opened project stays in the scope until
                    // the connection ends, so open/close does not re-fetch on every click.
                    if( !nowCollapsed ) { requestProjectScope( [ projectId ] ) }
                    var bodyEl = navEl.querySelector( '.ns-body[data-project-list="' + projectId + '"]' )
                    var boxEl = navEl.querySelector( '.ns-box[data-namespace="' + projectId + '"]' )
                    var headerNode = ( lastTree || {} )[ projectId ]
                    var memoCount = ( headerNode && typeof headerNode.memoCount === 'number' )
                        ? headerNode.memoCount
                        : ( bodyEl ? bodyEl.querySelectorAll( '.memo-group' ).length : 0 )
                    if( bodyEl ) { bodyEl.style.display = nowCollapsed ? 'none' : 'block' }
                    if( boxEl ) { boxEl.classList.toggle( 'ns-box-collapsed', nowCollapsed ) }
                    el.innerHTML = nsHeaderInner( projectId, memoCount, nowCollapsed )
                } )
            } )

            // REV-05 R3: the WHOLE memo-head toggles its revisions (not just the caret).
            // Inner interactive children (questions-link, transcript-indicator) call
            // stopPropagation, so clicking those does not collapse the memo.
            navEl.querySelectorAll( '.memo-head[data-memo-toggle]' ).forEach( function( el ) {
                el.addEventListener( 'click', function() {
                    var memoId = el.getAttribute( 'data-memo-toggle' )
                    if( collapsedMemos.has( memoId ) ) {
                        collapsedMemos.delete( memoId )
                    } else {
                        collapsedMemos.add( memoId )
                    }
                    var listEl = navEl.querySelector( '[data-memo-list="' + memoId + '"]' )
                    var caretEl = el.querySelector( '.mh-caret' )
                    var nowCollapsed = collapsedMemos.has( memoId )
                    if( listEl ) {
                        listEl.style.display = nowCollapsed ? 'none' : 'block'
                    }
                    if( caretEl ) {
                        caretEl.innerHTML = nowCollapsed ? '&#9656;' : '&#9662;'
                    }
                } )
            } )

            // Memo 081, WI-070: the count row IS the control. One click reveals this memo's hidden
            // revisions, another folds them back. The state lives in revealedMemos and is part of
            // computeSidebarSignature, so the next documentList broadcast redraws WITH it instead of
            // quietly closing what the user opened — an unfolding that does not survive a broadcast is
            // worthless for operating the tree, and every broadcast redraws this sidebar.
            navEl.querySelectorAll( 'li[data-hidden-toggle]' ).forEach( function( el ) {
                el.addEventListener( 'click', function( ev ) {
                    if( ev && typeof ev.stopPropagation === 'function' ) { ev.stopPropagation() }
                    var memoId = el.getAttribute( 'data-hidden-toggle' )
                    if( revealedMemos.has( memoId ) ) {
                        revealedMemos.delete( memoId )
                    } else {
                        revealedMemos.add( memoId )
                    }
                    lastSidebarSignature = null
                    renderSidebar()
                } )
            } )

            // Deep-link from questions icon -> open content + scroll to "Offene Fragen"
            navEl.querySelectorAll( '.questions-link' ).forEach( function( el ) {
                el.addEventListener( 'click', function( ev ) {
                    ev.stopPropagation()
                    var docId = el.getAttribute( 'data-document-id' )
                    var selectedRev = el.getAttribute( 'data-selected-rev' )
                    if( docId && selectedRev ) {
                        pendingQuestionsScroll = true
                        selectRevision( docId, selectedRev )
                    }
                } )
            } )

            if( !lastContent ) {
                contentEl.innerHTML = '<p class="content-placeholder">Dokument auswaehlen...</p>'
            }
        }

        // PRD-016 (Memo 016, E8): a cheap signature of everything that drives the sidebar markup
        // for the current mode. JSON of the mode + the broadcast data + the collapse-state and the
        // revision filter (so a user toggle / config change still redraws). Compared against
        // lastSidebarSignature to decide the no-op skip.
        function computeSidebarSignature() {
            var cfg = window.__MEMO_CONFIG__ || {}
            var collapse = {
                p: Array.from( collapsedProjects ).sort(),
                m: Array.from( collapsedMemos ).sort(),
                // Memo 081, WI-070: the reveal state joins the signature for the same reason the two
                // collapse sets are in it — it drives the markup, so a signature blind to it would skip
                // exactly the redraw the user asked for.
                r: Array.from( revealedMemos ).sort(),
                // Memo 081, WI-106: the scope state drives the markup (loaded lists vs a named loading
                // row), so it belongs in the signature for the same reason the collapse sets do —
                // otherwise the no-op skip drops exactly the redraw our own requestProjectScope asked
                // for, and the loading row would never resolve.
                s: Array.from( scopedProjects ).sort(),
                q: Array.from( pendingScopeProjects ).sort(),
                full: cfg.showOnlyFullRevisions === true
            }
            if( currentMode === 'transcripts' ) {
                return JSON.stringify( { mode: 'transcripts', t: lastTranscriptTree } )
            }
            return JSON.stringify( { mode: 'memos', tree: lastTree, latest: lastLatest, transcripts: lastTranscriptTree, collapse: collapse } )
        }

        // PRD-016 (Memo 016, E8): the no-op-skip decision, mirrors MemoView.sidebarSignatureChanged.
        // A first render (prev null) always changes; otherwise changed iff the signatures differ.
        function sidebarSignatureChanged( prev, next ) {
            if( prev === null || prev === undefined ) { return true }

            return prev !== next
        }

        function renderSidebar() {
            // PRD-017 (Memo 072, Phase 5): the Specs view owns the sidebar (renderSidebarSpecs) and is
            // NOT driven by the memo/transcript WS broadcasts. Bail out so a documentList/transcriptList
            // broadcast never clobbers the spec tree while the user is in Specs mode.
            if( currentMode === 'specs' ) { return }
            // PRD-016 (Memo 016, E8): no-op skip. The WS broadcast re-renders on every message;
            // when the incoming data + collapse-state yields the same signature as the last render
            // there is nothing to redraw, so we return early instead of rebuilding innerHTML
            // (kills the per-broadcast flicker/CPU). A mode change always changes the signature,
            // so mode switches still render. Mirrors MemoView.sidebarSignatureChanged.
            var nextSignature = computeSidebarSignature()
            if( !sidebarSignatureChanged( lastSidebarSignature, nextSignature ) ) {
                return
            }
            lastSidebarSignature = nextSignature

            if( currentMode === 'transcripts' ) {
                // PRD-008: transcripts view — sidebar lists the latest transcripts of all
                // storage locations; content shows a placeholder until one is selected.
                renderSidebarTranscripts()
            } else {
                renderSidebarMemos()
                // PRD-012 (Memo 076 H8, WI-107): updateTranscriptIndicators removed — the memo-head
                // no longer renders a .transcript-indicator pill, so the per-broadcast DOM scan found
                // nothing (dead/no-op). This also removes the only .transcript-indicator contextmenu
                // fetch, which subsumes WI-081 (the leaky-modal path can no longer be reached).
            }
        }

        // PRD-008: human-readable label + context-mode per transcript type. Memo 079 PRD-31 #3
        // adds the fifth type 'rollout' — the rollout is triggered in a FRESH/empty context (user
        // trigger in frischem Kontext), so its context mode is 'leerer Kontext'. Used to tag sidebar
        // entries and label the injection block (no more "Unbekannt" fallback for a rollout leaf).
        // Memo 079 M1 (REV-03 Kap 1 / WI-048): 'plan-start' removed — memo-plan was abolished,
        // so the type no longer exists server-side and must not be offered as a sidebar label.
        var transcriptTypeMeta = {
            'frei': { label: 'Frei', context: 'im Thread' },
            'memo-init': { label: 'Memo-Init', context: 'leerer Kontext' },
            'revision': { label: 'Revision', context: 'im Thread' },
            'rollout': { label: 'Rollout', context: 'leerer Kontext' }
        }

        function transcriptTypeLabel( type ) {
            var meta = transcriptTypeMeta[ type ]
            return meta ? meta.label : ( type || 'Unbekannt' )
        }

        // PRD-018 US-2: the only primary type is the one the user actually uses ("Memo
        // erstellen" -> memo-init); frei/revision/rollout are the nachrangige history.
        function isPrimaryTranscriptType( type ) {
            return type === 'memo-init'
        }

        // PRD-018 US-2: sort transcript sidebar entries by recency (mtime desc, then sequence
        // desc) so the long history list is ordered instead of arbitrary. Pure — no DOM, copies
        // the input. Entries without an mtime/sequence sort stably after dated ones.
        function sortTranscriptEntries( entries ) {
            var list = Array.isArray( entries ) ? entries.slice() : []
            list.sort( function( a, b ) {
                var ma = a && a.mtime ? Date.parse( a.mtime ) : NaN
                var mb = b && b.mtime ? Date.parse( b.mtime ) : NaN
                var va = isNaN( ma ) ? -Infinity : ma
                var vb = isNaN( mb ) ? -Infinity : mb
                if( va !== vb ) { return vb - va }
                var sa = Number( a && a.sequence )
                var sb = Number( b && b.sequence )
                var na = isNaN( sa ) ? -Infinity : sa
                var nb = isNaN( sb ) ? -Infinity : sb
                if( na !== nb ) { return nb - na }

                return 0
            } )

            return list
        }

        // PRD-016 (Memo 072 WI-T011-5): the pseudo-memo node key under which the server hangs the
        // memo-less transcripts (#otherTranscripts). Kept in sync with
        // TranscriptRegistry.OTHER_TRANSCRIPTS_MEMO_ID — the client cannot import the server class,
        // so the literal is mirrored here (one place both read).
        var TRANSCRIPT_UNBOUND_MEMO_ID = '(ungebunden)'

        // PRD-016 (Memo 072 WI-T011-4): Transcript-View sidebar — renders the SAME namespace tree
        // as the Memos tab (ns-box / ns-header / ns-body / memo-group), consuming the server tree
        // (lastTranscriptTree via the WS transcriptList broadcast, extended by WI-T011-5 to also
        // carry the memo-less transcripts under a pseudo-memo node). Replaces the old flat, mtime-
        // sorted "Verlauf" list and its two ad-hoc fetches — the server tree is now the ONE source.
        // Item actions (WI-T011-6) are carried over per leaf: click -> loadTranscriptIntoContent,
        // frei -> memo-init transform, memo-init highlight. Own collapse-state sets keep this tab's
        // collapse independent from the Memos tab (collapsedTranscriptProjects/-Memos).
        function renderSidebarTranscripts() {
            var navEl = document.getElementById( 'doc-sidebar-body' )
            if( !navEl ) { return }

            var tree = lastTranscriptTree || {}

            // Seed every namespace + memo of THIS tab into its own collapse set ONCE so groups
            // render collapsed by default (mirrors renderSidebarMemos). A group the user has
            // manually expanded is left untouched on re-render (seed-once guard). The memo key is
            // scoped by projectId because the pseudo memoId repeats across namespaces.
            Object.keys( tree ).forEach( function( projectId ) {
                if( !seededCollapseTranscriptProjects.has( projectId ) ) {
                    seededCollapseTranscriptProjects.add( projectId )
                    collapsedTranscriptProjects.add( projectId )
                }
                var node = tree[ projectId ] || {}
                Object.keys( node ).forEach( function( memoId ) {
                    var key = projectId + '::' + memoId
                    if( !seededCollapseTranscriptMemos.has( key ) ) {
                        seededCollapseTranscriptMemos.add( key )
                        collapsedTranscriptMemos.add( key )
                    }
                } )
            } )

            // The "+ Memo erstellen" entry point stays hoisted above the tree as the dominant
            // affordance (WI-T011-6). The "Verlauf"-Subheader is gone (PRD-016) — the tree replaces
            // the flat history list.
            var head = '<div class="sb-group-header">&#9662; Transcripts</div>'
                + '<button id="transcript-sb-new" class="transcript-sb-new" title="Neues Memo aus einem Transcript erstellen (Namespace waehlen)" style="display:block;width:calc(100% - 8px);margin:4px;padding:7px 8px;cursor:pointer;font-size:12px;font-weight:600;text-align:left;border:1px solid #4493f8;border-radius:6px;background:rgba(68,147,248,0.10);color:var(--text-1)">&#43; Memo erstellen</button>'
                + '<div id="transcript-sb-tree"></div>'

            navEl.innerHTML = head

            var newBtn = document.getElementById( 'transcript-sb-new' )
            if( newBtn ) {
                newBtn.addEventListener( 'click', function() {
                    if( typeof openTranscriptModal === 'function' ) { openTranscriptModal( {} ) }
                } )
            }

            if( !lastContent && contentEl ) {
                contentEl.innerHTML = '<p style="color:#888">Transcript auswaehlen...</p>'
            }

            var treeEl = document.getElementById( 'transcript-sb-tree' )
            if( !treeEl ) { return }

            // NS-Header inner markup — mirrors renderSidebarMemos.nsHeaderInner (chevron + folder +
            // name + spacer + count chip), but counts Transcripts instead of Memos.
            function tNsHeaderInner( projectId, count, collapsed ) {
                var chevron = collapsed ? '&#9656;' : '&#9662;'
                var folder = collapsed ? '📁' : '📂'
                var inner = '<span class="ns-chevron" data-ns-chevron>' + chevron + '</span>'
                inner += '<span class="ns-folder" aria-hidden="true">' + folder + '</span>'
                inner += '<span class="ns-name" data-ns-name>' + escapeAttr( projectId ) + '</span>'
                inner += '<span class="ns-spacer"></span>'
                inner += '<span class="ns-count" data-ns-count>' + count + ' Transcripts</span>'
                return inner
            }

            // One transcript leaf (WI-T011-6): the memo-bound review lines carry a REV-ID, the
            // ungebundene ones a type label. memo-init is lifted as primary; a frei leaf offers the
            // frei -> memo-init transform. Click loads the transcript into the content area.
            function renderTranscriptLeaf( leaf ) {
                var type = leaf.type || ( leaf.ungebunden ? 'frei' : 'revision' )
                var primary = isPrimaryTranscriptType( type )
                var canTransform = leaf.ungebunden === true && type === 'frei'
                var mainLabel = leaf.revisionId ? leaf.revisionId : transcriptTypeLabel( type )
                var seq = leaf.sequence ? ' · #' + escapeAttr( String( leaf.sequence ) ) : ''
                var entryCls = primary ? 'transcript-entry transcript-entry-primary' : 'transcript-entry'
                var badgeCls = primary ? 'transcript-type-badge transcript-type-badge-primary' : 'transcript-type-badge'
                var leafHtml = '<li class="' + entryCls + '" data-transcript-id="' + escapeAttr( leaf.transcriptId ) + '" data-type="' + escapeAttr( type ) + '" title="' + escapeAttr( leaf.transcriptId ) + '" style="list-style:none;padding:4px 6px;cursor:pointer;border-bottom:1px solid var(--border,#222)' + ( primary ? ';border-left:2px solid #4493f8' : '' ) + '">'
                leafHtml += '<div style="font-size:12px">' + escapeAttr( mainLabel ) + seq + '</div>'
                leafHtml += '<div style="font-size:10px;color:var(--text-muted)"><span class="' + badgeCls + '">' + escapeAttr( transcriptTypeLabel( type ) ) + '</span></div>'
                if( canTransform ) {
                    leafHtml += '<button class="transcript-transform-btn" data-transcript-id="' + escapeAttr( leaf.transcriptId ) + '" title="Freies Transcript als Quelle fuer ein neues Memo verwenden (Re-Injection)" style="margin-top:4px;font-size:10px;padding:2px 6px;cursor:pointer">Als Memo-Init verwenden</button>'
                }
                leafHtml += '</li>'
                return leafHtml
            }

            // One memo group inside a namespace box — a real memo shows its memoId, the pseudo node
            // (memo-less transcripts) shows a readable "Ungebunden" label. Collapse key is scoped by
            // projectId (the pseudo memoId repeats across namespaces).
            function renderTranscriptMemo( projectId, memoId, leaves ) {
                var key = projectId + '::' + memoId
                var isPseudo = memoId === TRANSCRIPT_UNBOUND_MEMO_ID
                var memoLabel = isPseudo ? 'Ungebunden (Bootstrap / Frei)' : memoId
                var isCollapsed = collapsedTranscriptMemos.has( key )
                var caret = isCollapsed ? '&#9656;' : '&#9662;'
                var listDisplay = isCollapsed ? 'none' : 'block'
                var memoHtml = '<div class="memo-group" data-tmemo-key="' + escapeAttr( key ) + '">'
                memoHtml += '<div class="memo-head" data-tmemo-toggle="' + escapeAttr( key ) + '" title="Transcripts ein-/ausklappen">'
                memoHtml += '<span class="mh-caret">' + caret + '</span>'
                memoHtml += '<span class="mh-name">' + escapeAttr( memoLabel ) + '</span>'
                memoHtml += '<span class="mh-spacer"></span>'
                memoHtml += '<span class="ns-count" data-tmemo-count>' + leaves.length + '</span>'
                memoHtml += '</div>'
                memoHtml += '<ul data-tmemo-list style="list-style:none;padding:0;margin:2px 0 0;display:' + listDisplay + '">'
                leaves.forEach( function( leaf ) {
                    memoHtml += renderTranscriptLeaf( leaf )
                } )
                memoHtml += '</ul></div>'
                return memoHtml
            }

            var projectIds = Object.keys( tree )
            var totalLeaves = projectIds.reduce( function( sum, projectId ) {
                var node = tree[ projectId ] || {}
                return sum + Object.keys( node ).reduce( function( s, memoId ) {
                    return s + ( node[ memoId ] || [] ).length
                }, 0 )
            }, 0 )

            if( totalLeaves === 0 ) {
                treeEl.innerHTML = '<div class="sb-queue-empty">Keine Transcripts.</div>'
                return
            }

            var html = ''
            projectIds.forEach( function( projectId ) {
                var node = tree[ projectId ] || {}
                var memoIds = Object.keys( node )
                var count = memoIds.reduce( function( s, memoId ) {
                    return s + ( node[ memoId ] || [] ).length
                }, 0 )
                if( count === 0 ) { return }

                var isCollapsed = collapsedTranscriptProjects.has( projectId )
                var bodyDisplay = isCollapsed ? 'none' : 'block'
                var boxCls = 'ns-box' + ( isCollapsed ? ' ns-box-collapsed' : '' )

                html += '<div class="' + boxCls + '" data-transcript-namespace="' + escapeAttr( projectId ) + '">'
                html += '<div class="ns-header" data-transcript-project="' + escapeAttr( projectId ) + '" title="Namespace ein-/ausklappen">'
                html += tNsHeaderInner( projectId, count, isCollapsed )
                html += '</div>'
                html += '<div class="ns-body" style="display:' + bodyDisplay + '">'
                memoIds.forEach( function( memoId ) {
                    html += renderTranscriptMemo( projectId, memoId, node[ memoId ] || [] )
                } )
                html += '</div></div>'
            } )

            treeEl.innerHTML = html

            // NS-box toggle (mirrors renderSidebarMemos). Traverses the DOM relative to the clicked
            // header instead of a key-selector, so the parenthesised pseudo key never touches a CSS
            // selector.
            treeEl.querySelectorAll( '.ns-header[data-transcript-project]' ).forEach( function( el ) {
                el.addEventListener( 'click', function() {
                    var projectId = el.getAttribute( 'data-transcript-project' )
                    if( collapsedTranscriptProjects.has( projectId ) ) {
                        collapsedTranscriptProjects.delete( projectId )
                    } else {
                        collapsedTranscriptProjects.add( projectId )
                    }
                    var nowCollapsed = collapsedTranscriptProjects.has( projectId )
                    // Memo 081, WI-107: THE SAME request, the same one message. Opening a project in the
                    // Transcripts tree needs the fields only this view uses (url, mtime, type, sequence)
                    // — measured 192 262 of 449 282 B over 1415 entries. One scope serves both trees; a
                    // second request message for the transcript side would be the second definition the
                    // memo forbids, and two definitions drift.
                    if( !nowCollapsed ) { requestProjectScope( [ projectId ] ) }
                    var boxEl = el.closest( '.ns-box' )
                    var bodyEl = boxEl ? boxEl.querySelector( '.ns-body' ) : null
                    var leafCount = boxEl ? boxEl.querySelectorAll( '.transcript-entry' ).length : 0
                    if( bodyEl ) { bodyEl.style.display = nowCollapsed ? 'none' : 'block' }
                    if( boxEl ) { boxEl.classList.toggle( 'ns-box-collapsed', nowCollapsed ) }
                    el.innerHTML = tNsHeaderInner( projectId, leafCount, nowCollapsed )
                } )
            } )

            // Memo-group toggle — collapses/expands the leaves of ONE memo (or the pseudo node).
            treeEl.querySelectorAll( '.memo-head[data-tmemo-toggle]' ).forEach( function( el ) {
                el.addEventListener( 'click', function() {
                    var key = el.getAttribute( 'data-tmemo-toggle' )
                    if( collapsedTranscriptMemos.has( key ) ) {
                        collapsedTranscriptMemos.delete( key )
                    } else {
                        collapsedTranscriptMemos.add( key )
                    }
                    var nowCollapsed = collapsedTranscriptMemos.has( key )
                    var group = el.closest( '.memo-group' )
                    var listEl = group ? group.querySelector( '[data-tmemo-list]' ) : null
                    var caretEl = el.querySelector( '.mh-caret' )
                    if( listEl ) { listEl.style.display = nowCollapsed ? 'none' : 'block' }
                    if( caretEl ) { caretEl.innerHTML = nowCollapsed ? '&#9656;' : '&#9662;' }
                } )
            } )

            // WI-T011-6: leaf click loads the transcript into the content area.
            treeEl.querySelectorAll( '.transcript-entry' ).forEach( function( el ) {
                el.addEventListener( 'click', function() {
                    var transcriptId = el.getAttribute( 'data-transcript-id' )
                    if( transcriptId ) { loadTranscriptIntoContent( transcriptId ) }
                } )
            } )

            // WI-T011-6: frei -> memo-init transform. stopPropagation so the leaf-click (load into
            // content) does not also fire.
            treeEl.querySelectorAll( '.transcript-transform-btn' ).forEach( function( btn ) {
                btn.addEventListener( 'click', function( ev ) {
                    ev.stopPropagation()
                    var transcriptId = btn.getAttribute( 'data-transcript-id' )
                    if( transcriptId ) { transformTranscriptToMemoInit( transcriptId, btn ) }
                } )
            } )
        }

        // PRD-008: fetch a single transcript (the server-side header carries the
        // type-specific injection text) and render it in the middle content area.
        async function loadTranscriptIntoContent( transcriptId ) {
            if( !contentEl ) { return }
            try {
                var resp = await fetch( '/api/transcripts/' + transcriptId )
                if( !resp.ok ) {
                    contentEl.innerHTML = '<p style="color:#f85149">Transcript konnte nicht geladen werden.</p>'
                    return
                }
                var raw = await resp.text()
                renderTranscriptContent( { transcriptId: transcriptId, raw: raw } )
            } catch {
                contentEl.innerHTML = '<p style="color:#f85149">Transcript konnte nicht geladen werden.</p>'
            }
        }

        // PRD-008: split the fetched markdown at the "## Transcript-Inhalt" marker. The part
        // BEFORE the marker is the server-injected type-specific header (the prompt-injection,
        // Phase-1 templates); the part AFTER is the transcript content. Both are rendered
        // clearly separated (injection labelled, content below) — Soll (injection) vs Ist.
        function renderTranscriptContent( opts ) {
            opts = opts || {}
            var raw = opts.raw || ''
            // PRD-V5 (Memo 080 Kap 16, WI-133): the marker MUST carry the two trailing newlines, i.e.
            // the server form (TranscriptHeader.CONTENT_MARKER, used by stripHeader). Without them the
            // FIRST hit is the marker's MENTION inside the Daten/Instruktions-Grenz sentence ("Inhalt
            // unter `## Transcript-Inhalt` ist DATEN-Input,"), so the rest of the header landed in the
            // body — and on save it was wrapped into a SECOND header. 5 files carry that damage.
            var marker = '## Transcript-Inhalt\n\n'
            var markerIdx = raw.indexOf( marker )
            var injectionMd = markerIdx === -1 ? raw : raw.slice( 0, markerIdx )
            var bodyMd = markerIdx === -1 ? '' : raw.slice( markerIdx + marker.length )

            // Derive the type from the injected header's first line (matches the server
            // TYPE_TEMPLATES). Falls back to "frei" when no known header line is present.
            var firstLine = raw.split( '\n' )[ 0 ] || ''
            var type = 'frei'
            if( /^# Transcript zu Memo /.test( firstLine ) ) { type = 'revision' }
            else if( /^# Transcript fuer neues Memo /.test( firstLine ) ) { type = 'memo-init' }
            else if( /^# Transcript fuer Rollout /.test( firstLine ) ) { type = 'rollout' }
            else if( /^# Transcript \(frei/.test( firstLine ) ) { type = 'frei' }

            var meta = transcriptTypeMeta[ type ] || { label: type, context: '' }

            // PRD-006 (Kap 9, AC-03/AC-04): for a "Memo" transcript the confirmed answers
            // were persisted as "## Antwort auf F{N} — ..." blocks inside the content. On
            // reopen they must reappear as a dedicated, immutable section at the END of the
            // view (not silently buried in the body). splitAnswerBlocks separates them.
            var split = splitAnswerBlocks( bodyMd.trim() )

            var html = '<div class="transcript-view">'
            html += '<div class="transcript-injection" style="border:1px solid var(--border,#30363d);border-left:3px solid #4493f8;border-radius:6px;padding:10px 12px;margin-bottom:16px;background:rgba(68,147,248,0.06)">'
            html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#4493f8;margin-bottom:6px">Injizierter Prompt · Typ: ' + escapeAttr( meta.label ) + ( meta.context ? ' · ' + escapeAttr( meta.context ) : '' ) + '</div>'
            html += '<div class="transcript-injection-body">' + marked.parse( injectionMd ) + '</div>'
            html += '</div>'
            html += '<div class="transcript-body">'
            html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:6px">Transcript-Inhalt</div>'
            html += marked.parse( split.bodyWithoutAnswers )
            html += '</div>'

            // AC-04: the re-attached answered-questions section. Rendered read-only at the
            // bottom — type "Memo" only, and only when answers actually exist.
            if( type === 'memo-init' && split.answersMd.trim().length > 0 ) {
                html += '<div class="transcript-answers" id="transcript-answers" style="border:1px solid var(--border,#30363d);border-left:3px solid #3fb950;border-radius:6px;padding:10px 12px;margin-top:16px;background:rgba(63,185,80,0.06)">'
                html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#3fb950;margin-bottom:6px">Beantwortete Fragen (angehängt · unveränderlich)</div>'
                html += '<div class="transcript-answers-body">' + marked.parse( split.answersMd.trim() ) + '</div>'
                html += '</div>'
            }

            html += '</div>'

            contentEl.innerHTML = html
        }

        // PRD-006 (Kap 9, AC-04): split persisted "## Antwort auf F{N} ..." answer blocks out
        // of the transcript body so they can be re-attached as a dedicated section. Returns
        // the body with those blocks removed plus the answer markdown collected separately.
        function splitAnswerBlocks( bodyMd ) {
            var text = String( bodyMd || '' )
            var lines = text.split( '\n' )
            var bodyLines = []
            var answerLines = []
            var inAnswer = false

            lines.forEach( function( line ) {
                var isAnswerHeading = /^##\s+Antwort auf\s+F\d+/.test( line )
                if( isAnswerHeading ) { inAnswer = true }
                else if( /^##\s/.test( line ) ) { inAnswer = false }

                if( inAnswer ) { answerLines.push( line ) }
                else { bodyLines.push( line ) }
            } )

            return {
                bodyWithoutAnswers: bodyLines.join( '\n' ).trim(),
                answersMd: answerLines.join( '\n' )
            }
        }

        // PRD-012: transform a free transcript into a memo-init transcript (Re-Injection).
        // Calls POST /api/other/transcripts/{id}/transform, then refreshes the view so the
        // type badge + injection header reflect the new memo-init type.
        async function transformTranscriptToMemoInit( transcriptId, btn ) {
            if( btn ) { btn.disabled = true }
            try {
                var resp = await fetch( '/api/other/transcripts/' + transcriptId + '/transform', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( { targetType: 'memo-init' } )
                } )
                var data = await resp.json()
                if( !resp.ok ) {
                    if( btn ) {
                        btn.disabled = false
                        btn.textContent = 'Fehler — erneut versuchen'
                    }

                    return
                }
                // Refresh the sidebar lists + indicators, then load the transformed content.
                renderSidebarTranscripts()
                loadTranscriptIntoContent( transcriptId )
            } catch {
                if( btn ) {
                    btn.disabled = false
                    btn.textContent = 'Fehler — erneut versuchen'
                }
            }
        }

        // PRD-012 (Memo 076 H8, WI-107): updateTranscriptIndicators was removed — the memo-head no
        // longer renders a .transcript-indicator pill (that aggregate display was dropped), so the
        // function scanned for elements that never exist and its click/contextmenu wiring was dead.
        // Removing it also deletes the only .transcript-indicator contextmenu fetch chain, subsuming
        // WI-081 (a right-click can no longer open an empty modal / throw an unhandled rejection).

        var modeTranscriptsBtn = document.getElementById( 'mode-transcripts' )
        var modeMemosBtn = document.getElementById( 'mode-memos' )
        // PRD-017 (Memo 072, Phase 5): the 4th VIEW mode button (merged Spec-Viewer).
        var modeSpecsBtn = document.getElementById( 'mode-specs' )
        // PRD-V1 (Memo 080, Kap 15): the RAW-TABLE view on the selected memo's per-memo database.
        var modeDbTablesBtn = document.getElementById( 'mode-dbtables' )
        // PRD-002 (Memo 076, Phase 1, F10): the Clients 4th-tab is gone — Clients is an overlay
        // opened from #clients-head, no longer a VIEW mode. No mode-clients button any more.
        var transcriptNavBtn = document.getElementById( 'transcript-new' )
        var docSidebarEl = document.getElementById( 'doc-sidebar' )

        // PRD-017: set the active class on exactly the one mode button.
        // PRD-002 (Memo 076, Phase 1, F10): three-way now — the Clients tab is gone.
        // PRD-012 (Memo 076 H8, WI-111): also expose the active mode to assistive tech — a screen
        // reader only had the visual .active class before. aria-pressed reflects the toggle state and
        // aria-current='page' marks the active view. Keep both in lock-step with the class.
        function setActiveModeButton( mode ) {
            var applyState = function( btn, isActive ) {
                if( !btn ) { return }
                btn.classList.toggle( 'active', isActive )
                btn.setAttribute( 'aria-pressed', isActive ? 'true' : 'false' )
                if( isActive ) { btn.setAttribute( 'aria-current', 'page' ) } else { btn.removeAttribute( 'aria-current' ) }
            }
            applyState( modeTranscriptsBtn, mode === 'transcripts' )
            applyState( modeMemosBtn, mode === 'memos' )
            applyState( modeSpecsBtn, mode === 'specs' )
            applyState( modeDbTablesBtn, mode === 'dbtables' )
        }

        // NavBar chrome per active view (REV-05 R4/F6): the redundant "+ Neues Memo" primary
        // button was removed — "Transcript" bootstraps new memos. Only the Transcript
        // visibility + sidebar mode class depend on the view now.
        function applyModeChrome() {
            if( currentMode === 'transcripts' ) {
                // Transcripts view: hide the "+ Transcript" bootstrap button (it belongs to
                // the memos view) and tag the sidebar so it can be styled per view.
                if( transcriptNavBtn ) { transcriptNavBtn.style.display = 'none' }
                if( docSidebarEl ) {
                    docSidebarEl.classList.add( 'transcripts-mode' )
                    docSidebarEl.classList.remove( 'specs-mode' )
                }
            } else if( currentMode === 'specs' ) {
                // PRD-017 (Memo 072, Phase 5): Specs view — like transcripts, the memo-only
                // "+ Transcript" button is hidden; the sidebar is tagged for spec-tree styling.
                if( transcriptNavBtn ) { transcriptNavBtn.style.display = 'none' }
                if( docSidebarEl ) {
                    docSidebarEl.classList.remove( 'transcripts-mode' )
                    docSidebarEl.classList.add( 'specs-mode' )
                }
            } else {
                if( transcriptNavBtn ) { transcriptNavBtn.style.display = '' }
                if( docSidebarEl ) {
                    docSidebarEl.classList.remove( 'transcripts-mode' )
                    docSidebarEl.classList.remove( 'specs-mode' )
                }
            }
        }

        // PRD-006/011: apply a view mode (transcripts | memos) without touching the
        // URL. setMode() couples it to the History-API route.
        function applyMode( mode ) {
            if( mode === 'specs' ) {
                // PRD-017 (Memo 072, Phase 5): the merged Spec-Viewer. Fetch the spec tree and
                // render the namespace/version sidebar; the first page auto-selects on cold start.
                // PRD-001 (Memo 076, Phase 1, WI-042): actively clear the memo sticky header on the
                // way into Specs so no Memo-Tab-Header bleeds over the spec page.
                clearMainHeader()
                currentMode = 'specs'
                setActiveModeButton( 'specs' )
                applyModeChrome()
                // WI-062 (PRD-007): entering the Specs view re-renders the page that was open before
                // (reselect), so returning from Memos shows the last spec page, not a stale memo.
                loadSpecs( { reselect: true } )
            } else if( mode === 'dbtables' ) {
                // PRD-V1 (Memo 080, Kap 15): the raw-table view. Like Specs it owns #content, so the memo
                // sticky header is cleared on the way in; the view itself renders the table list of the
                // currently selected memo's database.
                clearMainHeader()
                currentMode = 'dbtables'
                setActiveModeButton( 'dbtables' )
                applyModeChrome()
                renderDbTablesView()
            } else if( mode === 'transcripts' ) {
                // PRD-001 (Memo 076, Phase 1): clear the memo sticky header on the way into the
                // Transcripts view — the Zone-1 header belongs to the memos view only.
                clearMainHeader()
                currentMode = 'transcripts'
                setActiveModeButton( 'transcripts' )
                applyModeChrome()
                renderSidebar()
            } else {
                currentMode = 'memos'
                setActiveModeButton( 'memos' )
                applyModeChrome()
                renderSidebar()
                // Restore memo content when returning from another view (transcripts/specs/clients).
                // PRD-003 (Memo 076 WI-029/WI-037): route through the ONE shared renderProseContent(false)
                // path instead of a hand-rolled subset. That subset rebuilt innerHTML but never called
                // renderAllDiagrams (mermaid stayed raw source — the user's "Syntaxerror ganz unten") and
                // had no diff branch (the diff view vanished on the way back). renderProseContent contains
                // the exact slugCounts/marked/interceptLinks/applyContentStructure/vorwort/questions/TOC
                // sequence PLUS the diff branch PLUS renderAllDiagrams. updateSidebarSticky stays AFTER —
                // it is NOT part of renderProseContent and must re-set the sticky header after the return.
                if( lastContent ) {
                    renderProseContent( false )
                    updateSidebarSticky( currentMemoName, currentFileName )
                }
            }
        }

        // PRD-006/011: route <-> mode are kept consistent. /transcripts -> transcripts,
        // /memos (and default) -> memos (default lands on the current memo).
        // pushState updates the URL on user toggle; popstate restores the mode on back/forward.
        function modeForPath( pathname ) {
            if( pathname === '/transcripts' || pathname.indexOf( '/transcripts/' ) === 0 ) { return 'transcripts' }
            if( pathname === '/specs' || pathname.indexOf( '/specs/' ) === 0 ) { return 'specs' }
            if( pathname === '/dbtables' || pathname.indexOf( '/dbtables/' ) === 0 ) { return 'dbtables' }
            return 'memos'
        }

        function pathForMode( mode ) {
            if( mode === 'transcripts' ) { return '/transcripts' }
            if( mode === 'specs' ) { return '/specs' }
            if( mode === 'dbtables' ) { return '/dbtables' }
            // Memo 081, WI-066: with a document open, the memos view IS that document's address.
            // Without this, clicking the tab you are already on, or coming back from Specs, would
            // overwrite the deep link with a generic /memos — the address would not survive its own
            // application.
            if( currentDocPath ) { return currentDocPath }
            return '/memos'
        }

        function setMode( mode, options ) {
            var push = !options || options.push !== false
            applyMode( mode )
            if( push ) {
                var targetPath = pathForMode( mode )
                if( window.location.pathname !== targetPath ) {
                    window.history.pushState( { mode: mode }, '', targetPath )
                }
            }
        }

        if( modeMemosBtn ) {
            modeMemosBtn.addEventListener( 'click', function() { setMode( 'memos', { push: true } ) } )
        }

        if( modeTranscriptsBtn ) {
            modeTranscriptsBtn.addEventListener( 'click', function() { setMode( 'transcripts', { push: true } ) } )
        }

        if( modeSpecsBtn ) {
            modeSpecsBtn.addEventListener( 'click', function() { setMode( 'specs', { push: true } ) } )
        }

        if( modeDbTablesBtn ) {
            modeDbTablesBtn.addEventListener( 'click', function() { setMode( 'dbtables', { push: true } ) } )
        }

        // PRD-V1 (Memo 080, Kap 15 — Das Schaufenster): the RAW-TABLE view. Read-only window on the
        // selected memo's per-memo database: the table list (name + row count) on the left, the chosen
        // table as a plain HTML table on the right, paged with vor/zurück and a "Zeilen x–y von z"
        // position line. Every cell value goes through escapeHtml, so a stored `<script>` shows as TEXT.
        // A failing endpoint renders a VISIBLE error line (the renderFolderView precedent), never a
        // silent empty surface. Classic script style (var/function, no module syntax, no build step).
        var dbTablesState = { table: '', limit: 100, offset: 0 }

        function renderDbTablesView() {
            var content = document.getElementById( 'content' )
            if( !content ) { return }

            if( !currentDocumentId ) {
                content.innerHTML = '<div class="dbtables-view"><div class="dbtables-error">Kein Memo gewählt — die Rohtabellen-Ansicht zeigt die Datenbank des ausgewählten Memos.</div></div>'

                return
            }

            content.innerHTML = '<div class="dbtables-view"><div class="dbtables-loading">Lade Tabellen …</div></div>'

            fetch( '/api/db/tables?documentId=' + encodeURIComponent( currentDocumentId ) )
                .then( function( res ) {
                    return res.json()
                        .catch( function() { return { error: 'HTTP ' + res.status } } )
                        .then( function( payload ) {
                            if( !res.ok ) { throw new Error( ( payload && payload.error ) || ( 'HTTP ' + res.status ) ) }

                            return payload
                        } )
                } )
                .then( function( payload ) { renderDbTableList( payload ) } )
                .catch( function( err ) {
                    content.innerHTML = '<div class="dbtables-view"><div class="dbtables-error">Rohtabellen konnten nicht geladen werden: ' + escapeHtml( String( err && err.message ? err.message : err ) ) + '</div></div>'
                } )
        }

        function renderDbTableList( payload ) {
            var content = document.getElementById( 'content' )
            if( !content ) { return }

            var tables = ( payload && Array.isArray( payload.tables ) ) ? payload.tables : []
            var count = ( payload && typeof payload.tableCount === 'number' ) ? payload.tableCount : tables.length

            var head = '<div class="dbtables-head"><h2 class="dbtables-heading">Rohtabellen</h2>'
                + '<div class="dbtables-sub">' + escapeHtml( String( count ) ) + ' Tabelle(n) in der Memo-Datenbank · nur lesend</div></div>'

            if( tables.length === 0 ) {
                content.innerHTML = '<div class="dbtables-view">' + head + '<div class="dbtables-error">Diese Datenbank führt keine Tabelle.</div></div>'

                return
            }

            var items = tables
                .map( function( t ) {
                    return '<button class="dbtables-table-link" data-db-table="' + escapeHtml( t.name ) + '">'
                        + '<span class="dbtables-table-name">' + escapeHtml( t.name ) + '</span>'
                        + '<span class="dbtables-table-count">' + escapeHtml( String( t.rowCount ) ) + '</span></button>'
                } )
                .join( '' )

            content.innerHTML = '<div class="dbtables-view">' + head
                + '<div class="dbtables-body"><div class="dbtables-list">' + items + '</div>'
                + '<div class="dbtables-page" id="dbtables-page"></div></div></div>'

            Array.prototype.slice.call( content.querySelectorAll( '.dbtables-table-link' ) ).forEach( function( btn ) {
                btn.addEventListener( 'click', function() { selectDbTable( btn.getAttribute( 'data-db-table' ), 0 ) } )
            } )

            selectDbTable( tables[ 0 ].name, 0 )
        }

        function selectDbTable( name, offset ) {
            var page = document.getElementById( 'dbtables-page' )
            if( !page ) { return }

            dbTablesState.table = name
            dbTablesState.offset = offset

            Array.prototype.slice.call( document.querySelectorAll( '.dbtables-table-link' ) ).forEach( function( btn ) {
                btn.classList.toggle( 'active', btn.getAttribute( 'data-db-table' ) === name )
            } )

            page.innerHTML = '<div class="dbtables-loading">Lade Tabelle "' + escapeHtml( name ) + '" …</div>'

            var qs = '/api/db/table/' + encodeURIComponent( name )
                + '?documentId=' + encodeURIComponent( currentDocumentId )
                + '&limit=' + encodeURIComponent( String( dbTablesState.limit ) )
                + '&offset=' + encodeURIComponent( String( offset ) )

            fetch( qs )
                .then( function( res ) {
                    return res.json()
                        .catch( function() { return { error: 'HTTP ' + res.status } } )
                        .then( function( payload ) {
                            if( !res.ok ) { throw new Error( ( payload && payload.error ) || ( 'HTTP ' + res.status ) ) }

                            return payload
                        } )
                } )
                .then( function( payload ) { renderDbTablePage( payload ) } )
                .catch( function( err ) {
                    page.innerHTML = '<div class="dbtables-error">Tabelle "' + escapeHtml( name ) + '" konnte nicht geladen werden: ' + escapeHtml( String( err && err.message ? err.message : err ) ) + '</div>'
                } )
        }

        function renderDbTablePage( payload ) {
            var page = document.getElementById( 'dbtables-page' )
            if( !page ) { return }

            var columns = ( payload && Array.isArray( payload.columns ) ) ? payload.columns : []
            var rows = ( payload && Array.isArray( payload.rows ) ) ? payload.rows : []
            var total = ( payload && typeof payload.totalRows === 'number' ) ? payload.totalRows : 0
            var limit = ( payload && typeof payload.limit === 'number' ) ? payload.limit : dbTablesState.limit
            var offset = ( payload && typeof payload.offset === 'number' ) ? payload.offset : dbTablesState.offset

            dbTablesState.limit = limit
            dbTablesState.offset = offset

            var from = rows.length === 0 ? 0 : offset + 1
            var to = offset + rows.length
            var position = 'Zeilen ' + from + '–' + to + ' von ' + total

            var header = '<tr>' + columns
                .map( function( c ) { return '<th>' + escapeHtml( c ) + '</th>' } )
                .join( '' ) + '</tr>'

            var body = rows
                .map( function( cells ) {
                    return '<tr>' + cells
                        .map( function( cell ) {
                            var text = cell && cell.value !== null && cell.value !== undefined ? escapeHtml( cell.value ) : '<span class="dbtables-null">NULL</span>'
                            var mark = cell && cell.truncated === true
                                ? '<span class="dbtables-truncated" title="' + escapeHtml( String( cell.length ) ) + ' Zeichen, gekürzt">… gekürzt</span>'
                                : ''

                            return '<td>' + text + mark + '</td>'
                        } )
                        .join( '' ) + '</tr>'
                } )
                .join( '' )

            page.innerHTML = '<div class="dbtables-page-head">'
                + '<span class="dbtables-page-title">' + escapeHtml( String( payload && payload.table ? payload.table : dbTablesState.table ) ) + '</span>'
                + '<span class="dbtables-position">' + escapeHtml( position ) + '</span>'
                + '<button class="dbtables-nav" id="dbtables-prev">◀ zurück</button>'
                + '<button class="dbtables-nav" id="dbtables-next">vor ▶</button>'
                + '</div>'
                + '<div class="dbtables-scroll"><table class="dbtables-grid"><thead>' + header + '</thead><tbody>' + body + '</tbody></table></div>'

            var prev = document.getElementById( 'dbtables-prev' )
            var next = document.getElementById( 'dbtables-next' )

            if( prev ) {
                prev.disabled = offset <= 0
                prev.addEventListener( 'click', function() { selectDbTable( dbTablesState.table, Math.max( 0, offset - limit ) ) } )
            }
            if( next ) {
                next.disabled = to >= total
                next.addEventListener( 'click', function() { selectDbTable( dbTablesState.table, offset + limit ) } )
            }
        }

        // Memo 079 PRD-23 (WI-052, finding e): the configured folderTabs[] render as extra mode toggles,
        // generalizing the built-in Specs tab (the folder→tab precedent) to any workbench folder declared
        // in the root config. buildFolderTabDescriptors is the PURE mapping (config → render descriptors);
        // renderFolderTabs injects the buttons. A tab whose view maps to a BUILT-IN mode (spec/specs → the
        // existing Specs tab) is NOT duplicated — the built-in button already shows it, so the tab just
        // routes there. Memo 079 M2 (T052): a non-built-in folder tab now renders REAL content — its docs
        // list from /api/folder, each doc marked-rendered from /api/folder-page (the Specs precedent
        // generalized) — instead of the former dead-end placeholder.
        function buildFolderTabDescriptors( folderTabs ) {
            var builtinViews = { spec: 'specs', specs: 'specs' }
            var list = Array.isArray( folderTabs ) ? folderTabs : []
            var seen = {}

            return list
                .filter( function( tab ) {
                    return tab && typeof tab.id === 'string' && tab.id.length > 0 && typeof tab.folder === 'string' && tab.folder.length > 0
                } )
                .filter( function( tab ) {
                    if( seen[ tab.id ] ) { return false }
                    seen[ tab.id ] = true

                    return true
                } )
                .map( function( tab ) {
                    var view = typeof tab.view === 'string' && tab.view.length > 0 ? tab.view : tab.id
                    var builtinMode = builtinViews[ view ] || null
                    var label = tab.id.charAt( 0 ).toUpperCase() + tab.id.slice( 1 )

                    return {
                        id: tab.id,
                        folder: tab.folder,
                        view: view,
                        label: label,
                        buttonId: 'mode-folder-' + tab.id,
                        builtinMode: builtinMode
                    }
                } )
        }

        function renderFolderTabs( folderTabs ) {
            var container = document.getElementById( 'mode-toggle' )
            if( !container ) { return }

            // idempotent: drop any folder-tab buttons a prior call rendered (built-ins carry no
            // data-folder-tab attribute, so they are never touched).
            var prior = container.querySelectorAll( 'button[data-folder-tab]' )
            Array.prototype.slice.call( prior ).forEach( function( btn ) {
                if( btn.parentNode ) { btn.parentNode.removeChild( btn ) }
            } )

            buildFolderTabDescriptors( folderTabs ).forEach( function( d ) {
                // A built-in view already has its static button (e.g. #mode-specs) — never duplicate it.
                if( d.builtinMode && document.getElementById( 'mode-' + d.builtinMode ) ) { return }
                var btn = document.createElement( 'button' )
                btn.className = 'mode-toggle'
                btn.id = d.buttonId
                btn.setAttribute( 'data-folder-tab', d.id )
                btn.setAttribute( 'data-folder-view', d.view )
                btn.setAttribute( 'aria-pressed', 'false' )
                btn.textContent = d.label
                btn.addEventListener( 'click', function() { selectFolderTab( d ) } )
                container.appendChild( btn )
            } )
        }

        function selectFolderTab( d ) {
            if( d.builtinMode ) {
                // route a built-in-mapped folder tab (e.g. specs) to its existing, fully-wired view.
                setMode( d.builtinMode, { push: true } )

                return
            }

            renderFolderView( d )
        }

        // Memo 079 M2 (T052): mark the clicked folder tab active and deactivate the three built-in tabs.
        function markFolderTabActive( d ) {
            setActiveModeButton( '' )
            var container = document.getElementById( 'mode-toggle' )
            if( container ) {
                Array.prototype.slice.call( container.querySelectorAll( 'button[data-folder-tab]' ) ).forEach( function( btn ) {
                    var isActive = btn.getAttribute( 'data-folder-tab' ) === d.id
                    btn.classList.toggle( 'active', isActive )
                    btn.setAttribute( 'aria-pressed', isActive ? 'true' : 'false' )
                } )
            }
        }

        // Memo 079 M2 (T052 / WI-050): render a declared folder tab's CONTENT — the Specs precedent
        // generalized. Fetches the doc list from /api/folder and renders it into #content; clicking a doc
        // loads its raw markdown from /api/folder-page and marked-renders it. A fetch/parse error shows a
        // visible note instead of the former silent placeholder dead-end.
        function renderFolderView( d ) {
            markFolderTabActive( d )
            var content = document.getElementById( 'content' )
            if( !content ) { return }
            content.innerHTML = '<div class="folder-view-loading">Lade Ordner "' + escapeHtml( d.folder ) + '" …</div>'

            fetch( '/api/folder?id=' + encodeURIComponent( d.id ) )
                .then( function( res ) {
                    if( !res.ok ) { throw new Error( 'HTTP ' + res.status ) }
                    return res.json()
                } )
                .then( function( payload ) { renderFolderDocList( d, payload ) } )
                .catch( function( err ) {
                    content.innerHTML = '<div class="folder-view-error" style="color:#f85149">Ordner "' + escapeHtml( d.folder ) + '" konnte nicht geladen werden: ' + escapeHtml( String( err && err.message ? err.message : err ) ) + '</div>'
                } )
        }

        function renderFolderDocList( d, payload ) {
            var content = document.getElementById( 'content' )
            if( !content ) { return }
            var docs = ( payload && Array.isArray( payload.docs ) ) ? payload.docs : []
            content.innerHTML = ''

            var wrap = document.createElement( 'div' )
            wrap.className = 'folder-view'

            var heading = document.createElement( 'h2' )
            heading.className = 'folder-view-heading'
            heading.textContent = d.label
            wrap.appendChild( heading )

            var sub = document.createElement( 'div' )
            sub.className = 'folder-view-sub'
            sub.textContent = payload && payload.folder ? payload.folder : d.folder
            wrap.appendChild( sub )

            if( docs.length === 0 ) {
                var empty = document.createElement( 'p' )
                empty.className = 'folder-view-empty'
                empty.textContent = 'Keine Markdown-Dokumente in diesem Ordner.'
                wrap.appendChild( empty )
                content.appendChild( wrap )

                return
            }

            var list = document.createElement( 'div' )
            list.className = 'folder-doc-list'
            docs.forEach( function( doc ) {
                var link = document.createElement( 'button' )
                link.className = 'folder-doc-link'
                link.setAttribute( 'data-folder-doc', doc.stem )
                link.textContent = doc.name
                link.addEventListener( 'click', function() { selectFolderDoc( d, doc.stem ) } )
                list.appendChild( link )
            } )
            wrap.appendChild( list )

            var body = document.createElement( 'div' )
            body.className = 'folder-doc-body'
            body.id = 'folder-doc-body'
            wrap.appendChild( body )

            content.appendChild( wrap )

            // auto-open the first doc so the view never renders an empty body (mirrors autoSelectFirstSpecPage).
            selectFolderDoc( d, docs[ 0 ].stem )
        }

        function selectFolderDoc( d, stem ) {
            var body = document.getElementById( 'folder-doc-body' )
            if( !body ) { return }

            var list = document.querySelector( '.folder-doc-list' )
            if( list ) {
                Array.prototype.slice.call( list.querySelectorAll( '.folder-doc-link' ) ).forEach( function( btn ) {
                    btn.classList.toggle( 'active', btn.getAttribute( 'data-folder-doc' ) === stem )
                } )
            }

            body.innerHTML = '<div class="folder-doc-loading">Lade …</div>'
            fetch( '/api/folder-page?id=' + encodeURIComponent( d.id ) + '&page=' + encodeURIComponent( stem ) )
                .then( function( res ) {
                    if( !res.ok ) { throw new Error( 'HTTP ' + res.status ) }
                    return res.json()
                } )
                .then( function( payload ) {
                    body.innerHTML = marked.parse( ( payload && payload.content ) || '' )
                    renderAllDiagrams()
                } )
                .catch( function( err ) {
                    body.innerHTML = '<div style="color:#f85149">Dokument konnte nicht geladen werden: ' + escapeHtml( String( err && err.message ? err.message : err ) ) + '</div>'
                } )
        }

        // Memo 079 PRD-23 (WI-052): fetch the resolved folderTabs from /api/index and render them. The
        // config carries none live today, so this is a no-op unless a workbench declares folderTabs[].
        // Fail-open: a fetch/parse error leaves the built-in tabs untouched (never throws into boot).
        function loadFolderTabs() {
            fetch( '/api/index' )
                .then( function( resp ) { return resp.json() } )
                .then( function( payload ) { renderFolderTabs( payload && payload.folderTabs ) } )
                .catch( function() {} )
        }
        loadFolderTabs()

        // PRD-002 (Memo 076, Phase 1, F10, WI-053): #clients-head is now the ONLY Clients control —
        // it opens the overlay-popup instead of routing to a (removed) Clients mode.
        var clientsHeadEl = document.getElementById( 'clients-head' )
        if( clientsHeadEl ) {
            clientsHeadEl.addEventListener( 'click', function() { openClientsModal() } )
        }

        // PRD-012 (Memo 076 H8, WI-103): the "Unlink" nav button ("Memo entkoppeln") existed in the
        // HTML but had NO handler — a dead button. Wire it to the existing DELETE /api/documents/{id}
        // route (removeDocument), guarded by a confirm since it is destructive. The server broadcasts a
        // fresh documentList afterwards, so the sidebar refreshes without a reload.
        var navUnlinkBtn = document.getElementById( 'nav-unlink' )
        if( navUnlinkBtn ) {
            navUnlinkBtn.addEventListener( 'click', function() {
                if( !currentDocumentId ) { return }
                if( !window.confirm( 'Dieses Memo aus dem Viewer entkoppeln?' ) ) { return }
                fetch( '/api/documents/' + currentDocumentId, { method: 'DELETE' } )
                    .catch( function() {} )
            } )
        }

        // PRD-002 (Memo 076, Phase 1, WI-045): the Clients overlay open/close helpers. The popup lives
        // OVER the memo (#content stays intact); it toggles the shared .t-hidden class like #transcript-modal.
        function isClientsModalOpen() {
            var modal = document.getElementById( 'clients-modal' )
            return !!( modal && !modal.classList.contains( 't-hidden' ) )
        }

        function openClientsModal() {
            var modal = document.getElementById( 'clients-modal' )
            if( !modal ) { return }
            renderClientsModal()
            modal.classList.remove( 't-hidden' )
        }

        function closeClientsModal() {
            var modal = document.getElementById( 'clients-modal' )
            if( modal ) { modal.classList.add( 't-hidden' ) }
        }

        var clientsModalCloseEl = document.getElementById( 'clients-modal-close' )
        if( clientsModalCloseEl ) {
            clientsModalCloseEl.addEventListener( 'click', closeClientsModal )
        }

        // Backdrop click (outside the .t-modal-content) closes the popup — matches the .t-modal pattern.
        var clientsModalEl = document.getElementById( 'clients-modal' )
        if( clientsModalEl ) {
            clientsModalEl.addEventListener( 'click', function( ev ) {
                if( ev.target === clientsModalEl ) { closeClientsModal() }
            } )
        }

        document.addEventListener( 'keydown', function( ev ) {
            if( ev.key === 'Escape' && isClientsModalOpen() ) { closeClientsModal() }
        } )

        // PRD-002 (Memo 076, Phase 1, WI-055): the compact head summary "N Instanz(en) · M warten". M is
        // the number of clients in the derived `waiting-for-user-answer` status. Always visible in the
        // nav; a click opens the Clients overlay. One language (DE "Instanz(en)"), no Denglish.
        function renderClientsSummary( clients ) {
            if( !clientsHeadEl ) { return }
            var list = Array.isArray( clients ) ? clients : []
            var waiting = list.filter( function( c ) { return c && c.status === 'waiting-for-user-answer' } ).length
            var label = list.length + ' Instanz' + ( list.length === 1 ? '' : 'en' )
            if( waiting > 0 ) { label = label + ' · ' + waiting + ' warten' }
            clientsHeadEl.textContent = label
            clientsHeadEl.classList.toggle( 'has-waiting', waiting > 0 )
        }

        // PRD-002 (Memo 076, Phase 1, F10, WI-045): render the client registry into the overlay-popup
        // (#clients-modal-body), NOT into #content — the memo body stays visible behind the popup. One row
        // per registered CC instance: projectId · M{memo} · {mode} · {status} · {session}. A status pill
        // carries the derived state. Read-only surface — the viewer never mutates a client.
        function renderClientsModal() {
            var body = document.getElementById( 'clients-modal-body' )
            if( !body ) { return }

            var list = Array.isArray( lastClients ) ? lastClients : []
            var wrap = document.createElement( 'div' )
            wrap.className = 'clients-view'

            if( list.length === 0 ) {
                var empty = document.createElement( 'p' )
                empty.className = 'clients-empty'
                empty.textContent = 'Keine registrierten CC-Instanzen. Eine Instanz meldet sich beim SessionStart an (POST /api/clients).'
                wrap.appendChild( empty )
                body.innerHTML = ''
                body.appendChild( wrap )

                return
            }

            var table = document.createElement( 'table' )
            table.className = 'clients-table'
            var thead = document.createElement( 'thead' )
            thead.innerHTML = '<tr><th>Projekt</th><th>Memo</th><th>Mode</th><th>Status</th><th>Session</th></tr>'
            table.appendChild( thead )

            var tbody = document.createElement( 'tbody' )
            list.forEach( function( client ) {
                // WI-051: no more tote `.client-row status-*` class — the pill (.client-status-*)
                // already carries the status colour, so there is no second, dead colouring path.
                var tr = document.createElement( 'tr' )

                var project = ( client && client.projectId ) ? client.projectId : '—'
                var memo = ( client && client.memoNumber ) ? ( 'M' + client.memoNumber ) : '—'
                // Memo 076 F3 (T012): the work-mode is a FOUR-state enum idle < create < rollout < review.
                // A client without a memo/workMode (the normal case right after SessionStart registration)
                // is the idle floor — presentation maps null/absent to 'Idle' (grey ampel .client-mode-idle),
                // mirroring the CLI deriveWorkMode Idle floor and the statusline loc grey idle.
                var mode = ( client && client.workMode ) ? client.workMode : 'Idle'
                var status = ( client && client.status ) ? client.status : '—'
                var session = ( client && client.sessionId ) ? client.sessionId : '—'
                // WI-052: show only the first 8 chars of the session UUID (full value in title=)
                // so the table does not overflow. A dash placeholder stays as-is.
                var sessionShort = session === '—' ? '—' : session.slice( 0, 8 )

                tr.innerHTML =
                    '<td>' + escapeHtml( project ) + '</td>' +
                    '<td>' + escapeHtml( memo ) + '</td>' +
                    '<td><span class="client-mode client-mode-' + escapeAttr( String( mode ).toLowerCase() ) + '">' + escapeHtml( mode ) + '</span></td>' +
                    '<td><span class="client-status-pill client-status-' + escapeAttr( status ) + '">' + escapeHtml( status ) + '</span></td>' +
                    '<td><code title="' + escapeAttr( session ) + '">' + escapeHtml( sessionShort ) + '</code></td>'
                tbody.appendChild( tr )
            } )
            table.appendChild( tbody )
            wrap.appendChild( table )

            body.innerHTML = ''
            body.appendChild( wrap )
        }

        window.addEventListener( 'popstate', function( ev ) {
            var mode = ( ev.state && ev.state.mode ) ? ev.state.mode : modeForPath( window.location.pathname )
            applyMode( mode )
            // Memo 081, WI-066: a restored document address selects again. selectRevision pushes only
            // on a differing path, and popstate runs AFTER the browser moved the address bar — so the
            // paths are equal here and nothing is pushed. No extra flag is needed for that.
            // Only the LONG form re-selects. The short form deliberately does NOT: it names a document
            // without naming a revision, so re-selecting would have to resolve "newest" a second time
            // in the client, push the resulting long form, and thereby grow the stack the user just
            // walked back through — pressing Back again would land on the same short form and repeat it.
            // A second preselection rule (PRD-35's subject) plus an endless Back loop is a steep price
            // for re-resolving an address that already shows a revision of the very document it names.
            // Named limitation, not an oversight.
            var restored = parseDocPath( window.location.pathname )
            if( restored ) {
                currentDocPath = window.location.pathname
                if( restored.fileName ) { selectRevision( restored.documentId, restored.fileName ) }
            }
        } )

        // Initial route: derive the mode from the current path (default -> memos / current memo).
        ;( function initRoute() {
            var initialMode = modeForPath( window.location.pathname )
            // Memo 081, WI-066: a document address is REMEMBERED here, not acted on. The selection for
            // the initial address is made by the server on socket connect, over the same registry calls
            // a click uses — selecting a second time from here would be a competing decider for the same
            // display. What this line prevents is the opposite failure: a later mode toggle silently
            // replacing the address the page was opened under.
            if( parseDocPath( window.location.pathname ) ) { currentDocPath = window.location.pathname }
            window.history.replaceState( { mode: initialMode }, '', window.location.pathname )
            applyMode( initialMode )
        } )()

        applyModeChrome()

        // ====================================================================
        // PRD-017 (Memo 072, Phase 5, F9=A): the merged Spec-Viewer client. The separate
        // cli/spec-view (port 3344) is dissolved into this 4th VIEW mode — namespace → version →
        // pages of the project's spec/ workshop, latest preselected, plus a local 3-stage publish
        // badge (PUBLISHED/DRAFT-ONLY/DRIFT). It REUSES this client's render core (marked renderer
        // with heading-slug ids, renderAllDiagrams, buildTOC) and adds only the spec-only pieces:
        // the /api/specs tree, a version switcher, the publish badge, RFC-2119 keyword highlighting
        // and relative ./NN-slug.md intra-spec link interception.
        // ====================================================================
        var specState = { specs: [], current: null, selectedVersion: {} }

        // PRD-007 (Memo 076, Phase 4): loadSpecs is called two ways — on ENTERING the Specs view
        // (options.reselect = true → re-render the last selected page, WI-062) and on a live WS
        // refresh (no options → refresh the tree only, keep the open page/scroll, WI-070). res.ok is
        // checked so an /api/specs failure surfaces a visible error instead of being misread as
        // "no specs" (WI-069).
        function loadSpecs( options ) {
            var reselect = !!( options && options.reselect )
            fetch( '/api/specs' )
                .then( function( res ) {
                    if( !res.ok ) { throw new Error( 'HTTP ' + res.status ) }
                    return res.json()
                } )
                .then( function( payload ) { applySpecList( payload, reselect ) } )
                .catch( function( err ) { renderSpecsError( err ) } )
        }

        // WI-069: a visible sidebar error state — a failed /api/specs must not look like an empty
        // workshop. Mirrors the error-render pattern in selectSpecPage.
        function renderSpecsError( err ) {
            var navEl = document.getElementById( 'doc-sidebar-body' )
            if( !navEl ) { return }
            navEl.innerHTML = ''
            var warn = document.createElement( 'div' )
            warn.className = 'spec-warn spec-warn-error'
            warn.textContent = 'Spec-Tree konnte nicht geladen werden: ' + String( err && err.message ? err.message : err )
            navEl.appendChild( warn )
        }

        function applySpecList( payload, reselect ) {
            specState.specs = ( payload && payload.specs ) || []
            // Preselect the latest version per namespace on first sight; never override a user's
            // explicit version-switcher choice on a later refresh.
            specState.specs.forEach( function( spec ) {
                if( !specState.selectedVersion[ spec.namespace ] && spec.latestVersion ) {
                    specState.selectedVersion[ spec.namespace ] = spec.latestVersion
                }
            } )
            if( currentMode === 'specs' ) {
                renderSidebarSpecs()
                if( specState.current ) {
                    // WI-062: re-entering the Specs view re-renders the page that was open before —
                    // no stale memo, no manual click. A live refresh (reselect=false) keeps the open
                    // page untouched (only the tree updates), preserving scroll.
                    if( reselect ) {
                        selectSpecPage( { namespace: specState.current.namespace, version: specState.current.version, stem: specState.current.stem } )
                    }
                } else {
                    autoSelectFirstSpecPage()
                }
            }
        }

        function specVersionEntry( spec, version ) {
            var versions = spec.versions || []
            return versions.find( function( v ) { return v.version === version } ) || null
        }

        function autoSelectFirstSpecPage() {
            var firstSpec = specState.specs.find( function( s ) { return s.versions && s.versions.length > 0 } )
            if( !firstSpec ) { return }
            var version = specState.selectedVersion[ firstSpec.namespace ] || firstSpec.latestVersion
            var entry = specVersionEntry( firstSpec, version )
            if( !entry ) { return }
            var firstGroup = ( entry.groups || [] ).find( function( g ) { return g.pages && g.pages.length > 0 } )
            if( !firstGroup ) { return }
            selectSpecPage( { namespace: firstSpec.namespace, version: version, stem: firstGroup.pages[ 0 ].stem } )
        }

        // WI-060 (PRD-007): a version switch stays inside the SAME namespace — it keeps the current
        // stem if that page still exists in the new version, otherwise it lands on the first page of
        // THIS namespace. The old change-handler called autoSelectFirstSpecPage, which always jumped
        // to the globally first namespace.
        function selectFirstPageOfNamespace( namespace, version ) {
            var spec = specState.specs.find( function( s ) { return s.namespace === namespace } )
            if( !spec ) { return }
            var useVersion = version || specState.selectedVersion[ namespace ] || spec.latestVersion
            var entry = specVersionEntry( spec, useVersion )
            if( !entry ) { return }
            var groups = entry.groups || []
            var keepStem = specState.current && specState.current.namespace === namespace ? specState.current.stem : null
            var stemExists = keepStem && groups.some( function( g ) {
                return ( g.pages || [] ).some( function( p ) { return p.stem === keepStem } )
            } )
            if( stemExists ) {
                selectSpecPage( { namespace: namespace, version: useVersion, stem: keepStem } )

                return
            }
            var firstGroup = groups.find( function( g ) { return g.pages && g.pages.length > 0 } )
            if( !firstGroup ) { return }
            selectSpecPage( { namespace: namespace, version: useVersion, stem: firstGroup.pages[ 0 ].stem } )
        }

        function specBadgeClass( badge ) {
            if( badge === 'PUBLISHED' ) { return 'published' }
            if( badge === 'DRIFT' ) { return 'drift' }
            return 'draft-only'
        }

        // WI-063/064: the namespace-header inner markup — a mirror of renderSidebarMemos.nsHeaderInner
        // (chevron + flipping folder icon + name + spacer + count chip), reusing the shared .ns-*
        // tokens. The chip counts the pages of the SELECTED version instead of "N Memos".
        function specNsHeaderInner( namespace, pageCount, collapsed ) {
            var chevron = collapsed ? '&#9656;' : '&#9662;'
            var folder = collapsed ? '📁' : '📂'
            var inner = '<span class="ns-chevron" data-ns-chevron>' + chevron + '</span>'
            inner += '<span class="ns-folder" aria-hidden="true">' + folder + '</span>'
            inner += '<span class="ns-name" data-ns-name>' + escapeAttr( namespace ) + '</span>'
            inner += '<span class="ns-spacer"></span>'
            inner += '<span class="ns-count" data-ns-count>' + pageCount + ' Seiten</span>'
            return inner
        }

        // PRD-006 (Memo 076, Phase 4): the Specs sidebar rendered a flat wall — no section header,
        // no box per namespace, everything expanded, and the collapse-state died on every innerHTML
        // rebuild. This lifts it to the Memos-tree structure: a "Specs" section header, an .ns-box
        // per namespace with a folder-icon + page-count header, seed-once default-collapse backed by
        // the persistent collapsedSpecNamespaces Set (survives the rebuild), and a collapsible
        // second level for the sub-groups. It REUSES the Memos-tree tokens (.ns-box/.ns-header/
        // .ns-chevron/.ns-folder/.ns-name/.ns-count/.sb-group-header) rather than inventing a second
        // tree language.
        function renderSidebarSpecs() {
            var navEl = document.getElementById( 'doc-sidebar-body' )
            if( !navEl ) { return }
            navEl.innerHTML = ''

            if( !specState.specs || specState.specs.length === 0 ) {
                var empty = document.createElement( 'div' )
                empty.className = 'spec-warn'
                empty.textContent = 'Keine Spec entdeckt (spec/ Workshop leer?).'
                navEl.appendChild( empty )
                return
            }

            // WI-056: the "Specs" section header, mirroring the Memos "Namespaces" header.
            var groupHeader = document.createElement( 'div' )
            groupHeader.className = 'sb-group-header'
            groupHeader.textContent = 'Specs'
            navEl.appendChild( groupHeader )

            // WI-058/059: seed every namespace into collapsedSpecNamespaces ONCE (default collapsed).
            // The seed-once guard leaves a namespace the user manually expanded untouched on re-render.
            specState.specs.forEach( function( spec ) {
                if( !seededCollapseSpecNamespaces.has( spec.namespace ) ) {
                    seededCollapseSpecNamespaces.add( spec.namespace )
                    collapsedSpecNamespaces.add( spec.namespace )
                }
            } )

            specState.specs.forEach( function( spec ) {
                var isCollapsed = collapsedSpecNamespaces.has( spec.namespace )
                var selected = specState.selectedVersion[ spec.namespace ] || spec.latestVersion
                var entry = specVersionEntry( spec, selected )
                var pageCount = ( ( entry && entry.groups ) || [] ).reduce( function( sum, g ) {
                    return sum + ( ( g.pages || [] ).length )
                }, 0 )

                // WI-057: each namespace is an .ns-box (border/radius/bg via the shared token).
                var group = document.createElement( 'div' )
                group.className = 'spec-ns-group ns-box' + ( isCollapsed ? ' collapsed ns-box-collapsed' : '' )
                group.setAttribute( 'data-spec-namespace', spec.namespace )

                var body = document.createElement( 'div' )
                body.className = 'spec-ns-body'
                body.style.display = isCollapsed ? 'none' : 'block'

                // WI-063/064: the .ns-header with folder icon + page-count chip.
                var header = document.createElement( 'div' )
                header.className = 'spec-ns-header ns-header'
                header.setAttribute( 'title', 'Namespace ein-/ausklappen' )
                header.innerHTML = specNsHeaderInner( spec.namespace, pageCount, isCollapsed )
                // WI-059: the toggle mutates the persistent Set (not just a DOM class), so the state
                // survives the next innerHTML rebuild. Mirrors the Memos namespace toggle.
                header.addEventListener( 'click', function() {
                    if( collapsedSpecNamespaces.has( spec.namespace ) ) {
                        collapsedSpecNamespaces.delete( spec.namespace )
                    } else {
                        collapsedSpecNamespaces.add( spec.namespace )
                    }
                    var nowCollapsed = collapsedSpecNamespaces.has( spec.namespace )
                    group.classList.toggle( 'collapsed', nowCollapsed )
                    group.classList.toggle( 'ns-box-collapsed', nowCollapsed )
                    body.style.display = nowCollapsed ? 'none' : 'block'
                    header.innerHTML = specNsHeaderInner( spec.namespace, pageCount, nowCollapsed )
                } )
                group.appendChild( header )

                // Version switcher + publish badge row.
                var vrow = document.createElement( 'div' )
                vrow.className = 'spec-version-row'
                var versions = spec.versions || []
                if( versions.length > 0 ) {
                    var select = document.createElement( 'select' )
                    select.className = 'spec-version-select'
                    versions.forEach( function( v ) {
                        var opt = document.createElement( 'option' )
                        opt.value = v.version
                        opt.textContent = v.version
                        if( v.version === selected ) { opt.selected = true }
                        select.appendChild( opt )
                    } )
                    // WI-060 (PRD-007): stay in THIS namespace after a version switch.
                    select.addEventListener( 'change', function() {
                        specState.selectedVersion[ spec.namespace ] = this.value
                        renderSidebarSpecs()
                        selectFirstPageOfNamespace( spec.namespace, this.value )
                    } )
                    vrow.appendChild( select )
                }
                if( entry ) {
                    var badge = document.createElement( 'span' )
                    badge.className = 'spec-badge ' + specBadgeClass( entry.badge )
                    badge.textContent = entry.badge
                    badge.title = entry.badgeReason || ''
                    vrow.appendChild( badge )
                }
                body.appendChild( vrow )

                // Warnings (mixed levels / no manifest / no pages).
                var warnings = ( entry && entry.warnings ) || []
                warnings.forEach( function( w ) {
                    var warn = document.createElement( 'div' )
                    warn.className = 'spec-warn'
                    warn.textContent = '⚠ ' + w
                    body.appendChild( warn )
                } )

                // WI-066: collapsible sub-groups (second collapse level). The label is a toggle,
                // its pages live in a wrapper whose display follows the collapsedSpecSubs Set (keyed
                // namespace::label). Sub-groups default expanded so an opened namespace shows pages.
                var subGroups = ( entry && entry.groups ) || []
                subGroups.forEach( function( sub ) {
                    var subKey = spec.namespace + '::' + sub.label
                    var subCollapsed = collapsedSpecSubs.has( subKey )

                    var subWrap = document.createElement( 'div' )
                    subWrap.className = 'spec-sub' + ( subCollapsed ? ' collapsed' : '' )

                    var label = document.createElement( 'div' )
                    label.className = 'spec-sub-label'
                    label.innerHTML = '<span class="spec-sub-caret">' + ( subCollapsed ? '&#9656;' : '&#9662;' ) + '</span>'
                        + '<span class="spec-sub-name">' + escapeHtml( sub.label ) + '</span>'

                    var pagesWrap = document.createElement( 'div' )
                    pagesWrap.className = 'spec-sub-pages'
                    pagesWrap.style.display = subCollapsed ? 'none' : 'block'

                    label.addEventListener( 'click', function() {
                        if( collapsedSpecSubs.has( subKey ) ) {
                            collapsedSpecSubs.delete( subKey )
                        } else {
                            collapsedSpecSubs.add( subKey )
                        }
                        var nowCollapsed = collapsedSpecSubs.has( subKey )
                        subWrap.classList.toggle( 'collapsed', nowCollapsed )
                        pagesWrap.style.display = nowCollapsed ? 'none' : 'block'
                        var caret = label.querySelector( '.spec-sub-caret' )
                        if( caret ) { caret.innerHTML = nowCollapsed ? '&#9656;' : '&#9662;' }
                    } )
                    subWrap.appendChild( label )

                    var pages = sub.pages || []
                    pages.forEach( function( page ) {
                        // PRD-012 (Memo 076 H8, WI-110): a <button> instead of an <a> without href, so
                        // the spec page link is keyboard-focusable/activatable (Enter/Space).
                        var link = document.createElement( 'button' )
                        link.type = 'button'
                        link.className = 'spec-page-link'
                        link.textContent = page.title
                        link.setAttribute( 'data-namespace', spec.namespace )
                        link.setAttribute( 'data-stem', page.stem )
                        // WI-071 (PRD-007): carry the version so markActiveSpec can compare it.
                        link.setAttribute( 'data-version', selected )
                        link.addEventListener( 'click', function() { selectSpecPage( { namespace: spec.namespace, version: selected, stem: page.stem } ) } )
                        pagesWrap.appendChild( link )
                    } )
                    subWrap.appendChild( pagesWrap )
                    body.appendChild( subWrap )
                } )

                group.appendChild( body )
                navEl.appendChild( group )
            } )

            markActiveSpec()
        }

        function selectSpecPage( ref ) {
            specState.current = { namespace: ref.namespace, version: ref.version, stem: ref.stem }
            markActiveSpec()

            var qs = '/api/spec-page?namespace=' + encodeURIComponent( ref.namespace )
                + '&page=' + encodeURIComponent( ref.stem )
                + ( ref.version ? '&version=' + encodeURIComponent( ref.version ) : '' )

            fetch( qs )
                .then( function( res ) {
                    if( !res.ok ) { throw new Error( 'page not found' ) }
                    return res.json()
                } )
                .then( function( payload ) { renderSpecPage( payload ) } )
                .catch( function( err ) {
                    contentEl.innerHTML = '<p style="color:#f85149">Konnte Spec-Seite nicht laden: ' + escapeHtml( String( err && err.message ? err.message : err ) ) + '</p>'
                } )
        }

        function markActiveSpec() {
            var navEl = document.getElementById( 'doc-sidebar-body' )
            if( !navEl ) { return }
            var cur = specState.current
            var links = navEl.querySelectorAll( '.spec-page-link' )
            links.forEach( function( link ) {
                // WI-071 (PRD-007): match namespace + stem + VERSION so that, with several visible
                // versions, the right page is marked (not just the namespace/stem pair).
                var isActive = cur
                    && link.getAttribute( 'data-namespace' ) === cur.namespace
                    && link.getAttribute( 'data-stem' ) === cur.stem
                    && link.getAttribute( 'data-version' ) === cur.version
                link.classList.toggle( 'active', !!isActive )
            } )

            // WI-067 (PRD-006): mark the active page's namespace header and expand it so the page is
            // always visible. Done via direct DOM mutation (never a re-render — markActiveSpec is
            // called FROM renderSidebarSpecs, so re-rendering here would recurse).
            var groups = navEl.querySelectorAll( '.spec-ns-group' )
            groups.forEach( function( groupEl ) {
                var ns = groupEl.getAttribute( 'data-spec-namespace' )
                var isActiveNs = !!( cur && ns === cur.namespace )
                groupEl.classList.toggle( 'spec-ns-active', isActiveNs )
                var headerEl = groupEl.querySelector( '.spec-ns-header' )
                if( headerEl ) { headerEl.classList.toggle( 'active', isActiveNs ) }
                if( isActiveNs && collapsedSpecNamespaces.has( ns ) ) {
                    collapsedSpecNamespaces.delete( ns )
                    groupEl.classList.remove( 'collapsed', 'ns-box-collapsed' )
                    var bodyEl = groupEl.querySelector( '.spec-ns-body' )
                    if( bodyEl ) { bodyEl.style.display = 'block' }
                    if( headerEl ) {
                        var pageCount = groupEl.querySelectorAll( '.spec-page-link' ).length
                        headerEl.innerHTML = specNsHeaderInner( ns, pageCount, false )
                    }
                }
            } )
        }

        function renderSpecPage( payload ) {
            slugCounts.clear()
            // WI-061 (PRD-007): a sticky breadcrumb "namespace / version / seite" above the
            // provenance bar. Provenance bar (path/version/mtime) next, then the RAW markdown
            // rendered through THIS client's marked core, then diagrams + RFC highlight +
            // intra-spec links + TOC.
            var breadcrumb = buildSpecBreadcrumb( payload )
            var meta = buildSpecPageMeta( payload )
            contentEl.innerHTML = breadcrumb + meta + marked.parse( payload.content || '' )
            wireSpecPageMeta( payload )
            renderAllDiagrams()
            specHighlightRfc()
            interceptRelativeSpecLinks()
            buildTOC( null )
            window.scrollTo( { top: 0 } )
        }

        // WI-061 (PRD-007): the sticky context anchor. Sources namespace/version from the page
        // payload (falling back to specState.current) and the page title from the payload; renders
        // nothing if all three are empty. position:sticky is applied in CSS (#spec-breadcrumb).
        function buildSpecBreadcrumb( payload ) {
            var cur = specState.current || {}
            var ns = payload.namespace || cur.namespace || ''
            var version = payload.version || cur.version || ''
            var title = payload.title || cur.stem || ''
            var parts = []
            if( ns ) { parts.push( '<span class="sbc-ns">' + escapeHtml( ns ) + '</span>' ) }
            if( version ) { parts.push( '<span class="sbc-version">' + escapeHtml( version ) + '</span>' ) }
            if( title ) { parts.push( '<span class="sbc-page">' + escapeHtml( title ) + '</span>' ) }
            if( parts.length === 0 ) { return '' }
            return '<div id="spec-breadcrumb">' + parts.join( '<span class="sbc-sep">/</span>' ) + '</div>'
        }

        function buildSpecPageMeta( payload ) {
            var parts = []
            if( payload.path ) { parts.push( '<span class="spm-path" title="Pfad kopieren">' + escapeHtml( payload.path ) + '</span>' ) }
            if( payload.version ) { parts.push( '<span class="spm-badge">' + escapeHtml( payload.version ) + '</span>' ) }
            if( payload.mtime ) { parts.push( '<span class="spm-badge">geändert ' + escapeHtml( formatSpecMtime( payload.mtime ) ) + '</span>' ) }
            return '<div id="spec-page-meta">' + parts.join( '<span class="spm-sep">·</span>' ) + '</div>'
        }

        function wireSpecPageMeta( payload ) {
            var pathEl = contentEl.querySelector( '#spec-page-meta .spm-path' )
            if( !pathEl || !payload.path ) { return }
            pathEl.addEventListener( 'click', function() {
                if( navigator.clipboard ) { navigator.clipboard.writeText( payload.path ) }
                var prev = pathEl.textContent
                pathEl.textContent = 'kopiert ✓'
                setTimeout( function() { pathEl.textContent = prev }, 1000 )
            } )
        }

        function formatSpecMtime( ms ) {
            try {
                return new Date( ms ).toLocaleString( 'de-DE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } )
            } catch( e ) {
                return String( ms )
            }
        }

        // RFC-2119 highlight (ported from cli/spec-view): a post-marked DOM text-node walk that wraps
        // the ALL-CAPS keyword set only (BCP 14 — keywords count only in all capitals). Multi-word
        // keywords match before their single-word prefixes. code/pre/a/.rfc-keyword subtrees are
        // skipped so a keyword inside a code fence is never reformatted. Recursion + reduce replaces a
        // TreeWalker loop (house rule: no for/while).
        var SPEC_RFC_PATTERN = /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|NOT RECOMMENDED|RECOMMENDED|MAY|OPTIONAL)\b/

        function collectSpecRfcTextNodes( el ) {
            var children = Array.prototype.slice.call( el.childNodes )
            return children.reduce( function( acc, child ) {
                if( child.nodeType === 3 ) {
                    if( SPEC_RFC_PATTERN.test( child.nodeValue || '' ) ) { acc.push( child ) }
                    return acc
                }
                if( child.nodeType === 1 ) {
                    var tag = child.nodeName
                    var skip = tag === 'CODE' || tag === 'PRE' || tag === 'A' || ( child.classList && child.classList.contains( 'rfc-keyword' ) )
                    if( !skip ) { return acc.concat( collectSpecRfcTextNodes( child ) ) }
                }
                return acc
            }, [] )
        }

        function specHighlightRfc() {
            var globalPattern = new RegExp( SPEC_RFC_PATTERN.source, 'g' )
            var nodes = collectSpecRfcTextNodes( contentEl )
            nodes.forEach( function( textNode ) {
                var text = textNode.nodeValue
                var matches = Array.from( text.matchAll( globalPattern ) )
                if( matches.length === 0 ) { return }

                var frag = document.createDocumentFragment()
                var cursor = 0

                matches.forEach( function( match ) {
                    if( match.index > cursor ) {
                        frag.appendChild( document.createTextNode( text.slice( cursor, match.index ) ) )
                    }
                    var span = document.createElement( 'span' )
                    span.className = 'rfc-keyword'
                    span.textContent = match[ 0 ]
                    frag.appendChild( span )
                    cursor = match.index + match[ 0 ].length
                } )

                if( cursor < text.length ) {
                    frag.appendChild( document.createTextNode( text.slice( cursor ) ) )
                }

                textNode.parentNode.replaceChild( frag, textNode )
            } )
        }

        // Relative ./NN-slug.md (and NN-slug.md) intra-spec links → in-app page switch within the
        // same namespace/version. The memo render has no inter-page link handling; this is spec-new.
        function interceptRelativeSpecLinks() {
            var links = contentEl.querySelectorAll( 'a[href]' )
            links.forEach( function( a ) {
                var href = a.getAttribute( 'href' )
                var m = href && href.match( /^\.?\/?(\d+-[a-z0-9-]+)\.md(?:#.*)?$/i )
                if( !m ) { return }
                a.addEventListener( 'click', function( ev ) {
                    if( !specState.current ) { return }
                    ev.preventDefault()
                    selectSpecPage( { namespace: specState.current.namespace, version: specState.current.version, stem: m[ 1 ] } )
                } )
            } )
        }

        var transcriptMode = { active: false, transcriptId: null, originalContent: null, tab: 'revision' }

        // PRD-002/003 (Memo 019 Kap 2+3): the Transcript-Button modal offers exactly two tabs —
        // 'new' (Memo erstellen) and 'add' (zum Memo hinzufügen). 'revision' is NOT a
        // Transcript-Button tab anymore (REV-03: ein Revisionsprompt entsteht nur aus der
        // Revision selbst); it is driven programmatically by the sticky-header / edit callers,
        // which hide the tab-bar and show the hidden #t-panel-revision panel.
        // PRD-008 (Memo 022 Kap 6): clear the field values of a specific transcript tab so its
        // state can never leak into the other tab's save path (onTranscriptSave branches on
        // transcriptMode.tab and reads #t2-* for 'new', #ta-* for 'add'). Pure value reset; the
        // DOM nodes / dropdown options stay intact.
        function clearTranscriptTabFields( tab ) {
            var ids = []
            if( tab === 'new' ) { ids = [ 't2-content' ] }
            if( tab === 'add' ) { ids = [ 'ta-content' ] }
            ids.forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.value = '' }
            } )
        }

        function switchTranscriptTab( tab ) {
            // PRD-008: isolate the now-inactive tab. Switching away from 'new'/'add' clears the
            // OTHER tab's free-text field so the save path only ever reads the active tab's input.
            var previousTab = transcriptMode.tab
            if( previousTab === 'new' && tab !== 'new' ) { clearTranscriptTabFields( 'new' ) }
            if( previousTab === 'add' && tab !== 'add' ) { clearTranscriptTabFields( 'add' ) }
            transcriptMode.tab = tab
            var tabsBar = document.getElementById( 't-tabs' )
            var tabNew = document.getElementById( 't-tab-new' )
            var tabAdd = document.getElementById( 't-tab-add' )
            var panelRevision = document.getElementById( 't-panel-revision' )
            var panelNew = document.getElementById( 't-panel-new' )
            var panelAdd = document.getElementById( 't-panel-add' )
            var isRevision = tab === 'revision'
            var isNew = tab === 'new'
            var isAdd = tab === 'add'
            // Tab-bar is only shown for the two Transcript-Button actions.
            if( tabsBar ) { tabsBar.classList.toggle( 't-hidden', isRevision ) }
            if( tabNew ) { tabNew.classList.toggle( 'active', isNew ) }
            if( tabAdd ) { tabAdd.classList.toggle( 'active', isAdd ) }
            if( panelRevision ) { panelRevision.classList.toggle( 't-hidden', !isRevision ) }
            if( panelNew ) { panelNew.classList.toggle( 't-hidden', !isNew ) }
            if( panelAdd ) { panelAdd.classList.toggle( 't-hidden', !isAdd ) }
            updateTranscriptSaveState()
            // PRD-003 (Memo 024 Kap 3): the word counter is tab-aware — on every tab switch it
            // re-reads the now-active textarea so it shows the active tab's numbers, not a stale tab.
            updateTranscriptWordCount()
        }

        // PRD-002/003: fill a <select> with the namespace keys from lastTree. Returns the
        // number of namespaces so callers can fall back when none exist.
        function fillNamespaceSelect( selectEl ) {
            if( !selectEl ) { return { count: 0 } }
            var groups = allMemosByNamespace()
            var keys = Object.keys( groups )
            selectEl.innerHTML = ''
            keys.forEach( function( ns ) {
                var opt = document.createElement( 'option' )
                opt.value = ns
                opt.textContent = ns
                selectEl.appendChild( opt )
            } )

            return { count: keys.length }
        }

        // PRD-003: memos of a namespace, sorted newest first (highest revision number, then
        // mtime). Drives the #ta-memo dropdown after a namespace is chosen.
        function memosForNamespaceNewestFirst( namespace ) {
            var groups = allMemosByNamespace()
            var memos = ( groups[ namespace ] || [] ).slice()
            memos.sort( function( a, b ) {
                var ra = highestRevisionNumber( a )
                var rb = highestRevisionNumber( b )
                if( ra !== rb ) { return rb - ra }
                var ma = a.mtime ? Date.parse( a.mtime ) : 0
                var mb = b.mtime ? Date.parse( b.mtime ) : 0

                return mb - ma
            } )

            return memos
        }

        function highestRevisionNumber( memo ) {
            var revs = ( memo && memo.revisions ) ? memo.revisions : []
            var highest = 0
            revs.forEach( function( r ) {
                var m = ( r.fileName || '' ).match( /REV-(\d+)/ )
                if( m ) {
                    var n = parseInt( m[ 1 ], 10 )
                    if( n > highest ) { highest = n }
                }
            } )

            return highest
        }

        // PRD-003: (re)fill the #ta-memo dropdown for the currently selected namespace, newest
        // first. Each option carries the memoName, memoPath and documentId so the save call can
        // resolve the target folder without a re-lookup.
        function fillAddMemoSelect() {
            var nsSelect = document.getElementById( 'ta-namespace' )
            var memoSelect = document.getElementById( 'ta-memo' )
            if( !nsSelect || !memoSelect ) { return }
            var namespace = nsSelect.value || ''
            var memos = memosForNamespaceNewestFirst( namespace )
            memoSelect.innerHTML = ''
            memos.forEach( function( m ) {
                var opt = document.createElement( 'option' )
                opt.value = m.memoName || ''
                opt.textContent = m.memoName || ''
                if( typeof m.memoPath === 'string' ) { opt.setAttribute( 'data-memo-path', m.memoPath ) }
                memoSelect.appendChild( opt )
            } )
            updateTranscriptSaveState()
        }

        // PRD-007 (#44): footer word/minute counter for the transcript textarea.
        // Mirrors the estimate used in updateSidebarSticky (~200 Wörter/Min).
        // PRD-003 (Memo 024 Kap 3): resolve the textarea of the currently active Transcript tab.
        // The shared #t-wordcount footer must reflect the tab the user is actually typing in:
        // 'new' -> #t2-content, 'add' -> #ta-content, otherwise the revision field #t-content.
        function activeTranscriptContentEl() {
            var tab = transcriptMode.tab
            var id = tab === 'new' ? 't2-content' : ( tab === 'add' ? 'ta-content' : 't-content' )

            return document.getElementById( id )
        }

        function updateTranscriptWordCount() {
            var contentArea = activeTranscriptContentEl()
            var el = document.getElementById( 't-wordcount' )
            if( !contentArea || !el ) { return }
            var plain = ( contentArea.value || '' ).replace( /[^A-Za-zÀ-ÿ0-9]+/g, ' ' ).trim()
            var words = plain.length === 0
                ? 0
                : plain.split( /\s+/ ).filter( function( t ) { return t.length > 0 } ).length
            var minutes = words === 0 ? 0 : Math.ceil( words / SPOKEN_WORDS_PER_MINUTE )
            // PRD-019 (Memo 016 Kap 7.4): label as the transcript length, consistent with the
            // sticky-header read-out, so the count is never mistaken for a user-typed value.
            el.textContent = 'Transcript: ' + words.toLocaleString( 'de-DE' ) + ' Wörter · ' + minutes + ' Min'
        }

        function openTranscriptModal( opts ) {
            opts = opts || {}
            transcriptMode.active = true
            transcriptMode.transcriptId = opts.transcriptId || null
            var modal = document.getElementById( 'transcript-modal' )
            var title = document.querySelector( '#transcript-modal .t-title' )
            var projectInput = document.getElementById( 't-project' )
            var memoInput = document.getElementById( 't-memo' )
            var revisionInput = document.getElementById( 't-revision' )
            var contentArea = document.getElementById( 't-content' )
            var savedState = document.getElementById( 't-saved-state' )
            var errorBox = document.getElementById( 't-error' )
            var urlBox = document.getElementById( 't-url-box' )

            errorBox.classList.add( 't-hidden' )
            savedState.classList.add( 't-hidden' )
            if( urlBox ) {
                urlBox.textContent = '🔗 URL erscheint erst nach dem Speichern'
                urlBox.classList.remove( 'has-url' )
            }

            // PRD-008: a plain Transcript-Button open must never show leftover "Prompt bearbeiten"
            // UI. Hide the combined prompt panel/footer and restore the default transcript footer.
            ;[ 't-panel-prompt', 'pp-footer' ].forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.classList.add( 't-hidden' ) }
            } )
            ;[ 't-url-box', 't-actions-default', 't-footnote-default' ].forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.classList.remove( 't-hidden' ) }
            } )

            var projectId = ''
            var memoId = ''
            var nextRevision = 'REV-01'

            if( opts.transcriptId ) {
                if( title ) { title.textContent = 'Transcript bearbeiten' }
                projectInput.readOnly = true
                memoInput.readOnly = true
                revisionInput.readOnly = true
            } else {
                if( title ) { title.textContent = 'Transcript hinzufügen' }
                projectInput.readOnly = true
                memoInput.readOnly = true
                revisionInput.readOnly = false

                var docs = []
                Object.keys( lastTree ).forEach( function( pId ) {
                    var node = lastTree[ pId ]
                    var memos = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                    memos.forEach( function( m ) {
                        docs.push( { projectId: pId, doc: m } )
                    } )
                } )

                var current = null
                docs.forEach( function( entry ) {
                    if( !current && entry.doc.selectedRevision ) {
                        current = entry
                    }
                } )

                if( !current && docs.length > 0 ) {
                    current = docs[ 0 ]
                }

                if( current ) {
                    projectId = current.projectId
                    memoId = current.doc.memoName
                    var revs = current.doc.revisions || []
                    var highest = 0
                    revs.forEach( function( r ) {
                        var m = r.fileName.match( /REV-(\d+)/ )
                        if( m ) {
                            var n = parseInt( m[ 1 ], 10 )
                            if( n > highest ) { highest = n }
                        }
                    } )
                    nextRevision = 'REV-' + String( highest + 1 ).padStart( 2, '0' )
                }
            }

            projectInput.value = opts.projectId || projectId
            memoInput.value = opts.memoId || memoId
            revisionInput.value = opts.revisionId || nextRevision
            contentArea.value = opts.content || ''
            // PRD-007 (#44): seed the footer word/minute counter from the opened content.
            updateTranscriptWordCount()

            // PRD-002 (Memo 019 Kap 2): reset + fill the "Memo erstellen" namespace dropdown.
            var t2Namespace = document.getElementById( 't2-namespace' )
            var t2Content = document.getElementById( 't2-content' )
            fillNamespaceSelect( t2Namespace )
            if( t2Content ) { t2Content.value = '' }

            // PRD-003 (Memo 019 Kap 3): reset + fill the "zum Memo hinzufügen" dropdowns.
            var taNamespace = document.getElementById( 'ta-namespace' )
            var taContent = document.getElementById( 'ta-content' )
            fillNamespaceSelect( taNamespace )
            fillAddMemoSelect()
            if( taContent ) { taContent.value = '' }

            // PRD-018: dedupe baseline — the content present at open time is the "unchanged" state.
            transcriptMode.originalContent = opts.content || ''

            // PRD-002/003: callers that pass a transcriptId, an explicit revisionId, or seed
            // content (sidebar-edit / sticky-header / "+Frage") drive the programmatic
            // revision mode. The Transcript-Button (empty opts) defaults to the "Memo
            // erstellen" tab — it never opens a revision-anlegen action (REV-03).
            var revisionMode = !!( opts.transcriptId || opts.revisionId || ( opts.content && opts.content.length > 0 ) )
            switchTranscriptTab( revisionMode ? 'revision' : 'new' )

            modal.classList.remove( 't-hidden' )
            if( revisionMode ) {
                contentArea.focus()
            } else {
                if( t2Content ) { t2Content.focus() }
            }
        }

        function updateTranscriptSaveState() {
            var saveBtn = document.getElementById( 't-save' )
            if( !saveBtn ) { return }

            if( transcriptMode.tab === 'new' ) {
                // PRD-002 (Memo 019 Kap 2): require a chosen Namespace (dropdown) + Bootstrap-Text.
                var nsInput = document.getElementById( 't2-namespace' )
                var t2Content = document.getElementById( 't2-content' )
                var hasNamespace = !!( nsInput && nsInput.value && nsInput.value.trim().length > 0 )
                var newContent = t2Content ? t2Content.value : ''
                var newEmpty = newContent.trim().length === 0
                saveBtn.disabled = !hasNamespace || newEmpty
                if( saveBtn.disabled ) {
                    saveBtn.title = !hasNamespace ? 'Namespace erforderlich' : 'Bootstrap-Text erforderlich'
                } else {
                    saveBtn.title = ''
                }

                return
            }

            if( transcriptMode.tab === 'add' ) {
                // PRD-003 (Memo 019 Kap 3): require Namespace + Memo (dropdowns) + non-empty content.
                var aNs = document.getElementById( 'ta-namespace' )
                var aMemo = document.getElementById( 'ta-memo' )
                var aContent = document.getElementById( 'ta-content' )
                var hasNs = !!( aNs && aNs.value && aNs.value.trim().length > 0 )
                var hasMemoSel = !!( aMemo && aMemo.value && aMemo.value.trim().length > 0 )
                var addContent = aContent ? aContent.value : ''
                var addEmpty = addContent.trim().length === 0
                saveBtn.disabled = !hasNs || !hasMemoSel || addEmpty
                if( saveBtn.disabled ) {
                    saveBtn.title = !hasNs ? 'Namespace erforderlich' : ( !hasMemoSel ? 'Memo erforderlich' : 'Inhalt erforderlich' )
                } else {
                    saveBtn.title = ''
                }

                return
            }

            var memoInput = document.getElementById( 't-memo' )
            var contentArea = document.getElementById( 't-content' )
            var hasMemo = !!( memoInput && memoInput.value && memoInput.value.trim().length > 0 )
            var content = contentArea ? contentArea.value : ''
            // Dedupe: unchanged content vs. baseline disables save (PRD-018 #5).
            var unchanged = transcriptMode.originalContent !== null
                && content.trim() === ( transcriptMode.originalContent || '' ).trim()
            var empty = content.trim().length === 0

            saveBtn.disabled = !hasMemo || unchanged || empty
            if( saveBtn.disabled ) {
                saveBtn.title = !hasMemo ? 'Memo-Bezug erforderlich' : ( empty ? 'Inhalt erforderlich' : 'Inhalt unveraendert' )
            } else {
                saveBtn.title = ''
            }
        }

        function closeTranscriptModal() {
            transcriptMode.active = false
            transcriptMode.transcriptId = null
            document.getElementById( 'transcript-modal' ).classList.add( 't-hidden' )

            // PRD-008 (Memo 022 Kap 6): on close, reset ALL transcript tab fields so a re-open
            // never shows stale content from a previous session. Textareas -> empty value;
            // selects -> first option (selectedIndex 0). DOM nodes / option lists stay intact.
            ;[ 't2-content', 'ta-content' ].forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.value = '' }
            } )
            ;[ 't2-namespace', 'ta-namespace', 'ta-memo' ].forEach( function( id ) {
                var sel = document.getElementById( id )
                if( sel && sel.options && sel.options.length > 0 ) { sel.selectedIndex = 0 }
            } )

            // PRD-008: when the popup was in "Prompt bearbeiten" mode, restore the default
            // transcript layout so the next plain Transcript-Button open is unaffected.
            if( transcriptMode.tab === 'prompt' ) {
                var ppFooter = document.getElementById( 'pp-footer' )
                var ppPanel = document.getElementById( 't-panel-prompt' )
                if( ppFooter ) { ppFooter.classList.add( 't-hidden' ) }
                if( ppPanel ) { ppPanel.classList.add( 't-hidden' ) }
                ;[ 't-url-box', 't-actions-default', 't-footnote-default' ].forEach( function( id ) {
                    var el = document.getElementById( id )
                    if( el ) { el.classList.remove( 't-hidden' ) }
                } )
                transcriptMode.tab = 'revision'
            }
        }

        // PRD-031: surface the saved URL AND auto-copy it to the clipboard right away,
        // so the link can never be lost in the in-between step. Clipboard write is
        // best-effort: a failure must never hide the saved state or throw.
        async function showTranscriptSavedUrl( finalUrl ) {
            var savedState = document.getElementById( 't-saved-state' )
            var savedUrlEl = document.getElementById( 't-saved-url' )
            savedUrlEl.textContent = finalUrl
            savedState.classList.remove( 't-hidden' )

            var urlBox = document.getElementById( 't-url-box' )
            if( urlBox ) {
                urlBox.textContent = '🔗 ' + finalUrl
                urlBox.classList.add( 'has-url' )
            }

            // Auto-copy: the saved-state stays visible regardless of clipboard outcome.
            var hint = document.getElementById( 't-autocopy-hint' )
            try {
                await navigator.clipboard.writeText( finalUrl )
                if( hint ) {
                    hint.textContent = '✓ URL bereits in die Zwischenablage kopiert'
                    hint.classList.remove( 't-hidden' )
                }
            } catch {
                if( hint ) {
                    hint.textContent = 'Bitte URL manuell kopieren'
                    hint.classList.remove( 't-hidden' )
                }
            }
        }

        async function saveTranscript() {
            // Tab-Weiche: 'new' -> Memo erstellen (memo-init), 'add' -> zum Memo hinzufügen (frei),
            // sonst (programmatic revision mode) -> /api/transcripts.
            if( transcriptMode.tab === 'new' ) {
                await saveNewMemoTranscript()

                return
            }

            if( transcriptMode.tab === 'add' ) {
                await saveFreeMemoTranscript()

                return
            }

            var errorBox = document.getElementById( 't-error' )

            errorBox.classList.add( 't-hidden' )

            var projectId = document.getElementById( 't-project' ).value
            var memoId = document.getElementById( 't-memo' ).value
            var revisionId = document.getElementById( 't-revision' ).value
            var content = document.getElementById( 't-content' ).value

            // PRD-22 (Memo 081 Kap 19, WI-130): name what the export omits BEFORE the write runs,
            // out of the same measured state — so the user sees it while acting is still possible.
            // The flow is not held: this reports, it does not ask (S1, N1).
            renderUnconfirmedNotice( 't-unconfirmed', unconfirmedNotice() )

            // PRD-006 (Kap 9, AC-03): the confirmed question answers (st.addedText) must be
            // saved together with the transcript on the NORMAL save path too — not only via
            // "ohne Transcript speichern". Append them so a reopened "Memo" transcript can
            // re-attach the answered-questions section (AC-04).
            content = appendAddedAnswers( content )

            if( !/^REV-\d{2,}$/.test( revisionId ) ) {
                errorBox.textContent = 'Revision-Format: REV-XX (mind. 2 Ziffern)'
                errorBox.classList.remove( 't-hidden' )

                return
            }

            try {
                var isUpdate = !!transcriptMode.transcriptId
                var url = isUpdate
                    ? '/api/transcripts/' + transcriptMode.transcriptId
                    : '/api/transcripts'
                var method = isUpdate ? 'PUT' : 'POST'
                var body = isUpdate
                    ? JSON.stringify( { content: content } )
                    : JSON.stringify( { projectId: projectId, memoId: memoId, revisionId: revisionId, content: content } )

                var resp = await fetch( url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: body
                } )
                var data = await resp.json()

                if( !resp.ok ) {
                    errorBox.textContent = data.error || 'Server-Fehler'
                    errorBox.classList.remove( 't-hidden' )

                    return
                }

                var finalUrl = isUpdate
                    ? window.location.origin + '/transcripts/' + transcriptMode.transcriptId
                    : data.url

                await showTranscriptSavedUrl( finalUrl )

                // After save the current content becomes the new baseline -> dedupe greys save again.
                transcriptMode.originalContent = content
                updateTranscriptSaveState()
            } catch( err ) {
                errorBox.textContent = 'Netzwerkfehler: ' + err.message
                errorBox.classList.remove( 't-hidden' )
            }
        }

        // PRD-002 (Memo 019 Kap 2): "Memo erstellen" — the user only picks the Namespace
        // (dropdown); the memo number / Ablageort is decided later by the AI (next = max+1).
        // The transcript is saved with type 'memo-init' so it carries the memo-init default
        // header (no number, no path) — a single atomic write via /api/other/transcripts.
        async function saveNewMemoTranscript() {
            var errorBox = document.getElementById( 't-error' )
            var nsInput = document.getElementById( 't2-namespace' )
            var contentInput = document.getElementById( 't2-content' )

            errorBox.classList.add( 't-hidden' )

            var projectId = nsInput ? nsInput.value.trim() : ''
            var content = contentInput ? contentInput.value : ''

            if( projectId.length === 0 ) {
                errorBox.textContent = 'Namespace ist ein Pflichtfeld'
                errorBox.classList.remove( 't-hidden' )

                return
            }

            try {
                var resp = await fetch( '/api/other/transcripts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( { projectId: projectId, content: content, type: 'memo-init' } )
                } )
                var data = await resp.json()

                if( !resp.ok ) {
                    errorBox.textContent = data.error || 'Server-Fehler'
                    errorBox.classList.remove( 't-hidden' )

                    return
                }

                var finalUrl = data.url || ( window.location.origin + '/transcripts/' + data.transcriptId )
                await showTranscriptSavedUrl( finalUrl )
            } catch( err ) {
                errorBox.textContent = 'Netzwerkfehler: ' + err.message
                errorBox.classList.remove( 't-hidden' )
            }
        }

        // PRD-003 (Memo 019 Kap 3): "zum Memo hinzufügen" — append a FREE transcript to an
        // existing memo. Namespace + Memo come from the two dropdowns; the memoPath is taken
        // from the selected option (sourced from lastTree). POST /api/memo/transcripts stores
        // a frei-typed, fortlaufend nummerierte Datei im transcripts/-Ordner des Memos.
        async function saveFreeMemoTranscript() {
            var errorBox = document.getElementById( 't-error' )
            var nsInput = document.getElementById( 'ta-namespace' )
            var memoInput = document.getElementById( 'ta-memo' )
            var contentInput = document.getElementById( 'ta-content' )

            errorBox.classList.add( 't-hidden' )

            var projectId = nsInput ? nsInput.value.trim() : ''
            var memoId = memoInput ? memoInput.value.trim() : ''
            var content = contentInput ? contentInput.value : ''
            var selectedOption = ( memoInput && memoInput.selectedIndex >= 0 ) ? memoInput.options[ memoInput.selectedIndex ] : null
            var memoPath = selectedOption ? selectedOption.getAttribute( 'data-memo-path' ) : null

            if( projectId.length === 0 ) {
                errorBox.textContent = 'Namespace ist ein Pflichtfeld'
                errorBox.classList.remove( 't-hidden' )

                return
            }

            if( memoId.length === 0 ) {
                errorBox.textContent = 'Memo ist ein Pflichtfeld'
                errorBox.classList.remove( 't-hidden' )

                return
            }

            try {
                var payload = { projectId: projectId, memoId: memoId, content: content }
                if( memoPath ) { payload.memoPath = memoPath }

                var resp = await fetch( '/api/memo/transcripts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( payload )
                } )
                var data = await resp.json()

                if( !resp.ok ) {
                    errorBox.textContent = data.error || 'Server-Fehler'
                    errorBox.classList.remove( 't-hidden' )

                    return
                }

                var finalUrl = data.url || ( window.location.origin + '/transcripts/' + data.transcriptId )
                await showTranscriptSavedUrl( finalUrl )
            } catch( err ) {
                errorBox.textContent = 'Netzwerkfehler: ' + err.message
                errorBox.classList.remove( 't-hidden' )
            }
        }

        // PRD-032: single source of truth for writing the saved URL to the clipboard.
        // Both the prominent button (#t-copy) and the inline icon (#t-copy-inline)
        // call this — no duplicated writeText logic.
        async function writeSavedTranscriptUrlToClipboard() {
            var savedUrlEl = document.getElementById( 't-saved-url' )
            var urlText = savedUrlEl.textContent
            await navigator.clipboard.writeText( urlText )

            return { url: urlText }
        }

        async function copyTranscriptUrl() {
            var copyBtn = document.getElementById( 't-copy' )
            try {
                await writeSavedTranscriptUrlToClipboard()
                var original = copyBtn.textContent
                copyBtn.textContent = 'Kopiert!'
                setTimeout( function() {
                    copyBtn.textContent = original
                }, 2000 )
            } catch {
                copyBtn.textContent = 'Fehler — bitte manuell kopieren'
            }
        }

        // PRD-011 (Memo 076 H7b, WI-097): the copy glyph was U+29C9, which is missing from most
        // macOS system fonts and rendered as a tofu box. Use an inline SVG copy icon (currentColor)
        // instead — this string mirrors the one in MemoView #buildHtmlPage's #t-copy-inline button so
        // the reset path restores the SAME icon, not the tofu glyph.
        var COPY_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"></rect><path d="M3.5 10.5V3.5a1 1 0 0 1 1-1h7"></path></svg>'

        // PRD-032: inline-icon copy — same clipboard logic, icon-bound feedback.
        async function copyTranscriptUrlInline() {
            var inlineBtn = document.getElementById( 't-copy-inline' )
            try {
                await writeSavedTranscriptUrlToClipboard()
                var originalTitle = inlineBtn.title
                inlineBtn.textContent = '✓'
                inlineBtn.title = 'Kopiert!'
                setTimeout( function() {
                    inlineBtn.innerHTML = COPY_ICON_SVG
                    inlineBtn.title = originalTitle
                }, 2000 )
            } catch {
                inlineBtn.title = 'Fehler — bitte manuell kopieren'
            }
        }

        var newTranscriptBtn = document.getElementById( 'transcript-new' )
        if( newTranscriptBtn ) {
            newTranscriptBtn.addEventListener( 'click', function() {
                openTranscriptModal( {} )
            } )
        }

        var saveBtn = document.getElementById( 't-save' )
        if( saveBtn ) { saveBtn.addEventListener( 'click', saveTranscript ) }

        // PRD-018: re-evaluate dedupe/required state on every edit.
        var tContentEl = document.getElementById( 't-content' )
        if( tContentEl ) {
            tContentEl.addEventListener( 'input', updateTranscriptSaveState )
            // PRD-007 (#44): live word/minute counter while typing.
            tContentEl.addEventListener( 'input', updateTranscriptWordCount )
            // PRD-028: once a real transcript text is entered, "ohne Transcript speichern"
            // must disable itself (the normal Speichern path takes over).
            tContentEl.addEventListener( 'input', updateSaveAnswersOnlyState )
        }
        var tMemoEl = document.getElementById( 't-memo' )
        if( tMemoEl ) { tMemoEl.addEventListener( 'input', updateTranscriptSaveState ) }

        // PRD-002/003: tab switching — the Transcript-Button modal offers exactly two tabs:
        // 'new' (Memo erstellen) and 'add' (zum Memo hinzufügen). "Revision anlegen" was
        // removed as a Transcript-Button action (REV-03).
        var tTabNewEl = document.getElementById( 't-tab-new' )
        if( tTabNewEl ) { tTabNewEl.addEventListener( 'click', function() { switchTranscriptTab( 'new' ) } ) }
        var tTabAddEl = document.getElementById( 't-tab-add' )
        if( tTabAddEl ) { tTabAddEl.addEventListener( 'click', function() { switchTranscriptTab( 'add' ) } ) }

        // PRD-002: "Memo erstellen" required-state listeners (Namespace-Dropdown + Bootstrap-Text).
        var t2NamespaceEl = document.getElementById( 't2-namespace' )
        if( t2NamespaceEl ) { t2NamespaceEl.addEventListener( 'change', updateTranscriptSaveState ) }
        var t2ContentEl = document.getElementById( 't2-content' )
        if( t2ContentEl ) {
            t2ContentEl.addEventListener( 'input', updateTranscriptSaveState )
            // PRD-003 (Memo 024 Kap 3): the "neues Memo"-Tab must also drive the live word counter.
            t2ContentEl.addEventListener( 'input', updateTranscriptWordCount )
        }

        // PRD-003: "zum Memo hinzufügen" listeners — namespace change refills the memo dropdown
        // (newest first); memo + content changes re-evaluate the save state.
        var taNamespaceEl = document.getElementById( 'ta-namespace' )
        if( taNamespaceEl ) { taNamespaceEl.addEventListener( 'change', fillAddMemoSelect ) }
        var taMemoEl = document.getElementById( 'ta-memo' )
        if( taMemoEl ) { taMemoEl.addEventListener( 'change', updateTranscriptSaveState ) }
        var taContentEl = document.getElementById( 'ta-content' )
        if( taContentEl ) {
            taContentEl.addEventListener( 'input', updateTranscriptSaveState )
            // PRD-003 (Memo 024 Kap 3): the "hinzufügen"-Tab must also drive the live word counter.
            taContentEl.addEventListener( 'input', updateTranscriptWordCount )
        }

        // PRD-007 (#43): the "Abbrechen" button was removed — closing happens via the X
        // (#t-cancel-x) and the saved-state "Schliessen" button (#t-close).
        var cancelXBtn = document.getElementById( 't-cancel-x' )
        if( cancelXBtn ) { cancelXBtn.addEventListener( 'click', closeTranscriptModal ) }

        var copyBtn = document.getElementById( 't-copy' )
        if( copyBtn ) { copyBtn.addEventListener( 'click', copyTranscriptUrl ) }

        // PRD-032: inline copy icon next to the saved URL reuses the shared copy logic.
        var copyInlineBtn = document.getElementById( 't-copy-inline' )
        if( copyInlineBtn ) { copyInlineBtn.addEventListener( 'click', copyTranscriptUrlInline ) }

        var closeBtn = document.getElementById( 't-close' )
        if( closeBtn ) { closeBtn.addEventListener( 'click', closeTranscriptModal ) }

        // PRD-008 (Kap 9.5): the combined "Prompt bearbeiten" popup — Übernehmen writes back,
        // the live Min/Wörter counter updates while typing the transcript text.
        var ppApplyBtn = document.getElementById( 'pp-apply' )
        if( ppApplyBtn ) { ppApplyBtn.addEventListener( 'click', applyPromptEdit ) }
        var ppContentEl = document.getElementById( 'pp-content' )
        if( ppContentEl ) { ppContentEl.addEventListener( 'input', updatePromptTranscriptCount ) }
        // PRD-008 (Memo 076 H5, WI-078): live-update the quality label on any check toggle.
        var ppQualityList = document.getElementById( 'pp-quality-list' )
        if( ppQualityList ) { ppQualityList.addEventListener( 'change', updatePromptQualityLabel ) }

        // PRD-005 (Memo 016 Kap 4, B1/B2): 1:1 inline mirror of MemoView.requirementsEmptyState.
        // Turns ( count, setPresent, missingCount ) into a ternary empty-state verdict + reason copy
        // so the view explains WHY it is empty and tells a missing eval set apart from an empty one.
        function requirementsEmptyState( count, setPresent, missingCount ) {
            var safeCount = ( typeof count === 'number' && count > 0 ) ? count : 0
            var safeMissing = ( typeof missingCount === 'number' && missingCount > 0 ) ? missingCount : 0
            if( safeCount > 0 ) {
                return { empty: false, kind: 'resolved', reason: '' }
            }
            if( setPresent !== true ) {
                return {
                    empty: true,
                    kind: 'no-set',
                    reason: 'Kein Eval-Set hinterlegt — fuer dieses Memo existiert keine memo-NNN.set.json. 0 aufgeloest.'
                }
            }
            var missingNote = safeMissing > 0
                ? ( ' Das Set referenziert ' + safeMissing + ' ID(s), die der Store nicht kennt.' )
                : ''
            return {
                empty: true,
                kind: 'empty-set',
                reason: 'Eval-Set vorhanden, aber 0 aufgeloest.' + missingNote
            }
        }

        // PRD-005 (Memo 016 Kap 4, B5): 1:1 inline mirror of MemoView.resolveBlockRequirements.
        // The route already lints server-side; this client mirror keeps the decision testable/visible.
        function resolveBlockRequirements( blockRequirementNames, knownIds ) {
            var names = ( blockRequirementNames && blockRequirementNames.length ) ? blockRequirementNames : []
            var ids = ( knownIds && knownIds.length ) ? knownIds : []
            var normalize = function( value ) {
                return String( value == null ? '' : value ).trim().toUpperCase().replace( /_/g, '-' )
            }
            var knownByNorm = {}
            ids.forEach( function( id ) { knownByNorm[ normalize( id ) ] = id } )
            var seen = {}
            var uniqueNames = names
                .map( function( name ) { return String( name == null ? '' : name ).trim() } )
                .filter( function( name ) { return name.length > 0 } )
                .filter( function( name ) {
                    if( seen[ name ] === true ) { return false }
                    seen[ name ] = true
                    return true
                } )
            var resolved = uniqueNames
                .map( function( name ) { return knownByNorm[ normalize( name ) ] } )
                .filter( function( id ) { return id !== undefined } )
            var unresolved = uniqueNames
                .filter( function( name ) { return knownByNorm[ normalize( name ) ] === undefined } )
            return {
                resolved: resolved,
                unresolved: unresolved,
                hasNamespaceMismatch: unresolved.length > 0
            }
        }

        // PRD-014 (Memo 016 Kap 9, F9/A10): 1:1 inline mirror of MemoView.blocksEmptyState. Gives the
        // blocks view a REAL empty-state (Keine Blöcke) + a parse-error reason instead of a blank panel.
        function blocksEmptyState( count, errorCount ) {
            var safeCount = ( typeof count === 'number' && count > 0 ) ? count : 0
            var safeErrors = ( typeof errorCount === 'number' && errorCount > 0 ) ? errorCount : 0
            if( safeCount > 0 ) {
                return { empty: false, kind: 'present', reason: '' }
            }
            if( safeErrors > 0 ) {
                return {
                    empty: true,
                    kind: 'parse-error',
                    reason: 'Keine Blöcke aufgeloest — ' + safeErrors + ' block-meta-Fence(s) konnten nicht geparst werden.'
                }
            }

            return {
                empty: true,
                kind: 'no-blocks',
                reason: 'Keine Blöcke — dieses Memo enthaelt keinen block-meta-Fence.'
            }
        }

        // PRD-014 (Memo 016 Kap 9, B8): 1:1 inline mirror of MemoView.requirementsConsistency. Compares
        // expected-from-blocks vs resolved so the view can render an "X von Y aufgeloest" consistency badge.
        function requirementsConsistency( expectedFromBlocks, resolvedCount ) {
            var expected = ( typeof expectedFromBlocks === 'number' && expectedFromBlocks > 0 ) ? expectedFromBlocks : 0
            var resolved = ( typeof resolvedCount === 'number' && resolvedCount > 0 ) ? resolvedCount : 0
            if( expected === resolved ) {
                return {
                    consistent: true,
                    expected: expected,
                    resolved: resolved,
                    reason: resolved + ' von ' + expected + ' Block-Requirement(s) aufgeloest.'
                }
            }

            return {
                consistent: false,
                expected: expected,
                resolved: resolved,
                reason: 'Inkonsistenz: Blöcke erwarten ' + expected + ' Requirement(s), aufgeloest sind ' + resolved + '.'
            }
        }

        // PRD-014 (Memo 016 Kap 9, B9): 1:1 inline mirror of MemoView.requirementSeverityClass. Maps a
        // severity to a stable class suffix so chips get a SEVERITY COLOR (no longer all identical).
        function requirementSeverityClass( severity ) {
            var known = [ 'blocker', 'major', 'minor', 'warning', 'info' ]
            var value = String( severity == null ? '' : severity ).trim().toLowerCase()
            var safe = known.indexOf( value ) !== -1 ? value : 'info'

            return { severityClass: 'req-sev-' + safe, severity: safe }
        }

        // PRD-014 (Memo 016 Kap 9, B9): 1:1 inline mirror of MemoView.requirementKindLabel. Derives a
        // short KIND badge (tool/skill/command) from check.kind so chips show their kind.
        function requirementKindLabel( requirement ) {
            var req = ( requirement && typeof requirement === 'object' ) ? requirement : {}
            var check = ( req.check && typeof req.check === 'object' ) ? req.check : {}
            var kind = ( typeof check.kind === 'string' ) ? check.kind.trim() : ''

            return { kind: kind, kindLabel: kind.length > 0 ? kind.toUpperCase() : '' }
        }

        // PRD-014 (Memo 016 Kap 9, A11): 1:1 inline mirror of MemoView.blockChildHook. A child carries
        // no B-id, so this composes a non-empty automation hook from its binding topic (child-<topic>).
        function blockChildHook( block ) {
            var safe = ( block && typeof block === 'object' ) ? block : {}
            var id = ( typeof safe.id === 'string' ) ? safe.id.trim() : ''
            if( id.length > 0 ) { return { hook: id } }
            var topic = ( typeof safe.topic === 'string' ) ? safe.topic.trim() : ''
            if( topic.length > 0 ) { return { hook: 'child-' + topic } }

            return { hook: 'block-unknown' }
        }

        // PRD-014 (Memo 016 Kap 9, F9): the ONE empty-/error-state component reused by BOTH the
        // requirements and the blocks view. Builds a labelled box with a stable data-empty-state hook
        // (kind) + a head line + a reason line, so Playwright/tests can assert a real empty-/error
        // state was rendered instead of a blank or generic-failure panel.
        function buildEmptyState( kind, head, reason ) {
            var box = document.createElement( 'div' )
            box.className = 'view-empty-state'
            box.setAttribute( 'data-empty-state', kind )
            var headEl = document.createElement( 'div' )
            headEl.className = 'view-empty-head'
            headEl.textContent = head
            box.appendChild( headEl )
            var reasonEl = document.createElement( 'div' )
            reasonEl.className = 'view-empty-reason'
            reasonEl.textContent = reason
            box.appendChild( reasonEl )

            return box
        }

        // PRD-014 (Memo 016 Kap 9, B11/F9): render the shared ERROR-state into a content target. Used
        // by both load paths when a fetch is non-200 or the JSON envelope carries an `error` — the
        // error is SHOWN (data-error-state hook + message), never swallowed into a generic line.
        function renderViewError( contentTarget, message ) {
            contentTarget.textContent = ''
            var box = document.createElement( 'div' )
            box.className = 'view-error-state'
            box.setAttribute( 'data-error-state', 'load-failed' )
            var headEl = document.createElement( 'div' )
            headEl.className = 'view-error-head'
            headEl.textContent = 'Fehler'
            box.appendChild( headEl )
            var msgEl = document.createElement( 'div' )
            msgEl.className = 'view-error-reason'
            msgEl.textContent = message
            box.appendChild( msgEl )
            contentTarget.appendChild( box )

            return box
        }

        // PRD-012 (Memo 011 Kap 4, F16=A): Requirements-Ansicht.
        // Build a single requirement chip. Stable DOM hooks for Playwright/jsdom assertions:
        //   - class "req-item", attribute data-req-id (US-1 PRD-level item)
        //   - title attribute = derived short name (US-2 hover -> Kurzname)
        //   - click -> openRequirementModal (US-3 click -> centered reused popup)
        // PRD-014 (Memo 016 Kap 9, B9): the chip now carries a SEVERITY color class (data-req-severity)
        // and a KIND badge (data-req-kind), so a blocker tool requirement is visually distinct from a
        // minor skill one — previously every chip looked identical.
        function buildRequirementChip( req ) {
            var chip = document.createElement( 'div' )
            var sev = requirementSeverityClass( req.severity )
            chip.className = 'req-item ' + sev.severityClass
            chip.setAttribute( 'data-req-id', req.id )
            chip.setAttribute( 'data-req-severity', sev.severity )
            var shortName = req.shortName || req.title || req.id
            chip.setAttribute( 'title', shortName )

            var idSpan = document.createElement( 'span' )
            idSpan.className = 'req-item-id'
            idSpan.textContent = req.id
            chip.appendChild( idSpan )

            var shortSpan = document.createElement( 'span' )
            shortSpan.className = 'req-item-short'
            shortSpan.textContent = shortName
            chip.appendChild( shortSpan )

            var kindInfo = requirementKindLabel( req )
            if( kindInfo.kindLabel.length > 0 ) {
                var kindBadge = document.createElement( 'span' )
                kindBadge.className = 'req-item-kind'
                kindBadge.setAttribute( 'data-req-kind', kindInfo.kind )
                kindBadge.textContent = kindInfo.kindLabel
                chip.appendChild( kindBadge )
            }

            chip.addEventListener( 'click', function() {
                openRequirementModal( req )
            } )

            return chip
        }

        // Render the requirements view model into the given container. payload = the /requirements
        // API shape { groups[], aggregate[] }. Renders BOTH levels:
        //   - PRD-level: one .req-group per scope group, items carry data-req-id.
        //   - Memo-aggregate: a single container with attribute data-req-aggregate holding ALL items.
        function renderRequirementsView( payload, container ) {
            container.textContent = ''
            var root = document.createElement( 'div' )
            root.className = 'req-view'

            var groups = ( payload && payload.groups ) ? payload.groups : []
            var aggregate = ( payload && payload.aggregate ) ? payload.aggregate : []
            var missingIds = ( payload && payload.missingIds ) ? payload.missingIds : []
            var unresolvedBlockReqs = ( payload && payload.unresolvedBlockRequirements )
                ? payload.unresolvedBlockRequirements
                : []
            var blockReqNames = ( payload && payload.blockRequirementNames ) ? payload.blockRequirementNames : []
            var setPresent = !!( payload && payload.setPresent )

            // B1/B2 + F9: explanatory empty-state. When nothing resolved, render WHY (missing set vs
            // empty set) instead of two bare empty titles. Keeps the data-req-empty-kind hook (PRD-005
            // contract) AND wears the shared .view-empty-state class so it gets the F9 empty-state look.
            var emptyState = requirementsEmptyState( aggregate.length, setPresent, missingIds.length )
            if( emptyState.empty === true ) {
                var emptyEl = document.createElement( 'div' )
                emptyEl.className = 'req-empty-state view-empty-state'
                emptyEl.setAttribute( 'data-req-empty-kind', emptyState.kind )
                emptyEl.setAttribute( 'data-empty-state', emptyState.kind )
                var emptyHead = document.createElement( 'div' )
                emptyHead.className = 'req-empty-head view-empty-head'
                emptyHead.textContent = '0 aufgeloest'
                emptyEl.appendChild( emptyHead )
                var emptyReason = document.createElement( 'div' )
                emptyReason.className = 'req-empty-reason view-empty-reason'
                emptyReason.textContent = emptyState.reason
                emptyEl.appendChild( emptyReason )
                root.appendChild( emptyEl )
            }

            // B8: consistency check — expected-from-blocks vs resolved. The bare count never told the
            // user whether 0 resolved meant "blocks declared none" or "blocks declared 8 but none
            // resolved". Render a badge with the verdict (data-req-consistent hook).
            var consistency = ( payload && payload.consistency )
                ? payload.consistency
                : requirementsConsistency( blockReqNames.length, aggregate.length )
            var consistencyEl = document.createElement( 'div' )
            consistencyEl.className = 'req-consistency req-consistency-' + ( consistency.consistent ? 'ok' : 'mismatch' )
            consistencyEl.setAttribute( 'data-req-consistent', String( consistency.consistent ) )
            consistencyEl.textContent = consistency.reason
            root.appendChild( consistencyEl )

            // B7/B10: the two requirement LEVELS stay distinct and are honestly labelled. The
            // upper level groups by REPO-SCOPE (the data-driven proxy, not "PRD-Ebene" — every
            // requirement here actually lands in "(all repos)", so the old label was misleading, B10).
            // The lower level is the flat memo-wide aggregate. data-req-level keeps them separable.
            var prdTitle = document.createElement( 'div' )
            prdTitle.className = 'req-section-title'
            prdTitle.setAttribute( 'data-req-level', 'repo-scope' )
            prdTitle.textContent = 'Requirements (nach Repo-Scope)'
            root.appendChild( prdTitle )

            groups.forEach( function( group ) {
                var groupEl = document.createElement( 'div' )
                groupEl.className = 'req-group'
                groupEl.setAttribute( 'data-req-group', group.groupKey )

                var head = document.createElement( 'div' )
                head.className = 'req-group-head'
                head.textContent = group.groupKey
                groupEl.appendChild( head )

                var items = document.createElement( 'div' )
                items.className = 'req-items'
                ;( group.requirements || [] ).forEach( function( req ) {
                    items.appendChild( buildRequirementChip( req ) )
                } )
                groupEl.appendChild( items )
                root.appendChild( groupEl )
            } )

            var aggTitle = document.createElement( 'div' )
            aggTitle.className = 'req-section-title'
            aggTitle.setAttribute( 'data-req-level', 'memo-aggregate' )
            aggTitle.textContent = 'Memo-Aggregat (' + aggregate.length + ')'
            root.appendChild( aggTitle )

            var aggEl = document.createElement( 'div' )
            aggEl.className = 'req-items'
            aggEl.setAttribute( 'data-req-aggregate', payload && payload.memoName ? payload.memoName : 'aggregate' )
            aggregate.forEach( function( req ) {
                aggEl.appendChild( buildRequirementChip( req ) )
            } )
            root.appendChild( aggEl )

            // B4: render the "Nicht aufgeloest (N)" section — set ids that could not be resolved to a
            // store body. Previously computed (missingIds) but never shown to the user.
            if( missingIds.length > 0 ) {
                var missingTitle = document.createElement( 'div' )
                missingTitle.className = 'req-section-title'
                missingTitle.textContent = 'Nicht aufgeloest (' + missingIds.length + ')'
                root.appendChild( missingTitle )

                var missingEl = document.createElement( 'div' )
                missingEl.className = 'req-missing'
                missingEl.setAttribute( 'data-req-missing', String( missingIds.length ) )
                missingIds.forEach( function( id ) {
                    var miss = document.createElement( 'div' )
                    miss.className = 'req-missing-id'
                    miss.textContent = id
                    missingEl.appendChild( miss )
                } )
                root.appendChild( missingEl )
            }

            // B5: surface the ID-namespace mismatch. Block requirements use the 'req-*' namespace,
            // the store uses 'REQ-NNN'; names that do not resolve are WARNED here, not swallowed.
            if( unresolvedBlockReqs.length > 0 ) {
                var warnEl = document.createElement( 'div' )
                warnEl.className = 'req-namespace-warning'
                warnEl.setAttribute( 'data-req-namespace-warning', String( unresolvedBlockReqs.length ) )
                warnEl.textContent = 'Namespace-Mismatch: ' + unresolvedBlockReqs.length
                    + ' Block-Requirement(s) ohne Store-Entsprechung — ' + unresolvedBlockReqs.join( ', ' )
                root.appendChild( warnEl )
            }

            container.appendChild( root )

            return root
        }

        // US-3: open the REUSED .t-modal popup with requirement details. Toggles t-hidden only —
        // centering is inherited from .t-modal (align-items/justify-content center). NO new modal CSS.
        function openRequirementModal( req ) {
            var modal = document.getElementById( 'requirement-modal' )
            var title = document.getElementById( 'req-modal-title' )
            var body = document.getElementById( 'req-modal-body' )
            if( !modal || !body ) { return }

            if( title ) { title.textContent = req.id + ' · ' + ( req.shortName || req.title || '' ) }

            body.textContent = ''
            var scope = req.scope || {}
            var repos = ( scope.repos && scope.repos.length > 0 ) ? scope.repos.join( ', ' ) : '(alle)'
            var rows = [
                { label: 'Statement', value: req.statement || req.title || '' },
                { label: 'Scope (repos)', value: repos },
                { label: 'Severity', value: req.severity || '' },
                { label: 'Origin', value: req.origin || '' }
            ]
            rows.forEach( function( row ) {
                var rowEl = document.createElement( 'div' )
                rowEl.className = 'req-detail-row'
                var labelEl = document.createElement( 'div' )
                labelEl.className = 'req-detail-label'
                labelEl.textContent = row.label
                var valueEl = document.createElement( 'div' )
                valueEl.className = 'req-detail-value'
                valueEl.textContent = row.value
                rowEl.appendChild( labelEl )
                rowEl.appendChild( valueEl )
                body.appendChild( rowEl )
            } )

            modal.classList.remove( 't-hidden' )

            return modal
        }

        function closeRequirementModal() {
            var modal = document.getElementById( 'requirement-modal' )
            if( modal ) { modal.classList.add( 't-hidden' ) }
        }

        // PRD-009 (Memo 016 Kap 7, F4/E6): inline mirror of MemoView.nextViewState. Prose is the
        // home view; requesting the active non-prose view again toggles back to prose, a different
        // view switches. Returns { view, render } so a toggle knows whether to fetch+rebuild.
        // PRD-V2 (Memo 080, Kap 15 / WI-102): the Graph panel joins the SAME contract — one more entry
        // in the known list, no second state machine. Mirrors RevisionLogic.nextViewState.
        function nextViewState( current, requested ) {
            var known = [ 'prose', 'requirements', 'blocks', 'graph' ]
            var safeCurrent = known.indexOf( current ) !== -1 ? current : 'prose'
            var safeRequested = known.indexOf( requested ) !== -1 ? requested : 'prose'
            if( safeRequested === 'prose' ) {
                return { view: 'prose', render: safeCurrent !== 'prose' }
            }
            if( safeRequested === safeCurrent ) {
                return { view: 'prose', render: true }
            }

            return { view: safeRequested, render: true }
        }

        // PRD-009 (Memo 016 Kap 7, E7/F10): inline mirror of MemoView.shouldRerenderOnBroadcast.
        // A WS content broadcast may only redraw the prose content when prose/memo is on screen —
        // an open Req/Blocks panel must survive the broadcast untouched.
        function shouldRerenderOnBroadcast( currentView ) {
            return currentView === 'prose' || currentView === 'memo' || !currentView
        }

        // PRD-009 (Memo 016 Kap 7, F4): reflect the active view-mode on the Zone-1 toggles so the
        // user sees which panel is open (.active) and has a visible way back to prose (E6). Re-run
        // after each header render (toggles are rebuilt) and after every view switch.
        function syncContentViewToggles() {
            var reqBtn = document.getElementById( 'req-view-toggle' )
            var blockBtn = document.getElementById( 'block-view-toggle' )
            // PRD-V2 (Memo 080 Kap 15, WI-102): the Graph toggle is carried the same way as the two above.
            var graphBtn = document.getElementById( 'graph-view-toggle' )
            if( reqBtn ) {
                if( currentContentView === 'requirements' ) { reqBtn.classList.add( 'active' ) }
                else { reqBtn.classList.remove( 'active' ) }
            }
            if( blockBtn ) {
                if( currentContentView === 'blocks' ) { blockBtn.classList.add( 'active' ) }
                else { blockBtn.classList.remove( 'active' ) }
            }
            if( graphBtn ) {
                if( currentContentView === 'graph' ) { graphBtn.classList.add( 'active' ) }
                else { graphBtn.classList.remove( 'active' ) }
            }
        }

        // PRD-009 (Memo 016 Kap 7, F4/F10): render the prose/memo content into #content from the
        // last broadcast (lastContent + diff/vorwort/questions/TOC pipeline). Extracted so the WS
        // content handler AND the "back to prose" path (toggle-off) share ONE non-destructive
        // render — returning home never rebuilds the whole content area from a destructive reset.
        function renderProseContent( preserveScroll ) {
            var scrollY = preserveScroll ? window.scrollY : 0
            if( showDiff && currentDiff ) {
                renderDiffView( lastContent, currentDiff )
            } else {
                slugCounts.clear()
                // PRD-V4 (Memo 080 Kap 16): ONE prose render path — footnotes resolved, apparatus
                // appended, markers wired BEFORE interceptLinks so the back-jump anchors survive.
                contentEl.innerHTML = renderMarkdownWithFootnotes( lastContent ).html
                wireFootnoteRefs( contentEl )
                interceptLinks()
                renderAllDiagrams()
            }
            applyContentStructure()
            renderVorwort( lastVorwort )
            renderFormHints( lastValidation )
            renderQuestionWidgets( lastQuestionSchema )
            buildTOC( currentDiff )
            window.scrollTo( 0, scrollY )
        }

        // US-1: fetch the requirements view model for the active memo and render it into #content.
        // Read-only: GET /api/documents/<id>/requirements. No-op without an active documentId.
        // PRD-009 (F4/E6): a non-destructive view-mode panel — requested via the Req-toggle, which
        // resolves nextViewState. A request that toggles back to prose restores the prose content
        // instead of fetching requirements; otherwise the requirements panel replaces #content but
        // the prose stays recoverable (lastContent) and is NOT destroyed.
        async function loadRequirementsView( documentId ) {
            // PRD-001 (Memo 076, Phase 1, WI-044): the Requirements overlay belongs to the memos
            // view. After the header-clear the toggle is gone from the DOM, but a stray callback
            // must never load a memo overlay over the clients/specs surface.
            if( currentMode !== 'memos' ) { return }
            var contentTarget = document.getElementById( 'content' )
            if( !documentId || !contentTarget ) { return }

            var step = nextViewState( currentContentView, 'requirements' )
            currentContentView = step.view
            if( step.view === 'prose' ) {
                renderProseContent( false )
                syncContentViewToggles()

                return
            }

            try {
                var resp = await fetch( '/api/documents/' + encodeURIComponent( documentId ) + '/requirements' )
                var payload = await resp.json()
                // B11: a non-200 response or an error envelope is SHOWN, not swallowed into a render
                // of an empty view. The real server message reaches the user via the error-state.
                if( !resp.ok || ( payload && payload.error ) ) {
                    var reqMsg = ( payload && payload.error ) ? payload.error : ( 'HTTP ' + resp.status )
                    renderViewError( contentTarget, 'Requirements konnten nicht geladen werden: ' + reqMsg )
                    syncContentViewToggles()

                    return
                }
                renderRequirementsView( payload, contentTarget )
                syncContentViewToggles()
            } catch( err ) {
                renderViewError( contentTarget, 'Requirements konnten nicht geladen werden.' )
                syncContentViewToggles()
            }
        }

        // PRD-004 (Memo 016 Kap 3, A1/A6/A7): partition the flat /blocks list into a nested
        // parent/child view model. Mirrors MemoView.partitionBlocks server-side. Children bind
        // to a parent via the singular 'topic' matching one of the parent's 'topics' (A1 nesting),
        // parents are grouped by 'chapter' (A6, one header per chapter), and each child gets its
        // effectiveRequirements = parent default union child requirementsPlus (A7 union; the route
        // already pre-computes it, this is the self-contained client mirror/fallback).
        function partitionBlocks( blocks ) {
            var safeBlocks = ( blocks && blocks.length ) ? blocks : []
            var parents = safeBlocks.filter( function( block ) { return block && block.role !== 'child' } )
            var children = safeBlocks.filter( function( block ) { return block && block.role === 'child' } )

            var findParent = function( child ) {
                return parents.find( function( parent ) {
                    var topics = ( parent.topics && parent.topics.length ) ? parent.topics : []

                    return typeof child.topic === 'string' && topics.indexOf( child.topic ) !== -1
                } )
            }

            var effectiveFor = function( parent, child ) {
                var parentReqs = ( parent && parent.requirements && parent.requirements.length ) ? parent.requirements : []
                var childReqs = ( child && child.requirementsPlus && child.requirementsPlus.length ) ? child.requirementsPlus : []
                if( child && child.effectiveRequirements && child.effectiveRequirements.length ) {
                    return child.effectiveRequirements
                }
                var union = []
                parentReqs.concat( childReqs ).forEach( function( req ) {
                    if( union.indexOf( req ) === -1 ) { union.push( req ) }
                } )

                return union
            }

            var withChildren = parents.map( function( parent ) {
                var own = children.filter( function( child ) { return findParent( child ) === parent } )
                var enriched = own.map( function( child ) {
                    return Object.assign( {}, child, { effectiveRequirements: effectiveFor( parent, child ) } )
                } )

                return Object.assign( {}, parent, { children: enriched } )
            } )

            var orphans = children
                .filter( function( child ) { return findParent( child ) === undefined } )
                .map( function( child ) {
                    return Object.assign( {}, child, { effectiveRequirements: effectiveFor( null, child ) } )
                } )

            var chapterOrder = []
            withChildren.forEach( function( parent ) {
                var chapter = parent.chapter || ''
                if( chapterOrder.indexOf( chapter ) === -1 ) { chapterOrder.push( chapter ) }
            } )

            var groups = chapterOrder.map( function( chapter ) {
                var groupParents = withChildren.filter( function( parent ) { return ( parent.chapter || '' ) === chapter } )

                return { chapter: chapter, parents: groupParents }
            } )

            return { groups: groups, orphans: orphans }
        }

        // PRD-010 (Memo 014 Kap 2) + PRD-004 (Memo 016 Kap 3): Build one block card. Stable DOM hooks:
        //   - class "block-item" + "block-role-<role>" (A5 parent/child indicator), data-block-role
        //   - data-block-id (B-id); children carry data-child-topic composite hook (A2/A11)
        //   - A3 singular 'topic' rendered as a chip; A4 effectiveRequirements rendered as req chips
        //   - click -> openBlockModal (centered REUSED #block-modal popup)
        function buildBlockItem( block ) {
            var role = ( block.role === 'child' ) ? 'child' : 'parent'
            var item = document.createElement( 'div' )
            item.className = 'block-item block-role-' + role
            item.setAttribute( 'data-block-role', role )
            // A11: data-block-id must NEVER be empty (automation/tests went blind on children, which
            // carry no B-id). A parent keeps its B-id; a child falls back to a composite child-<topic>
            // hook via blockChildHook so every card has a non-empty, stable automation handle.
            var blockId = block.id || ''
            var hookId = ( role === 'child' || blockId.length === 0 ) ? blockChildHook( block ).hook : blockId
            item.setAttribute( 'data-block-id', hookId )
            if( role === 'child' && block.topic ) {
                item.setAttribute( 'data-child-topic', block.topic )
            }

            var head = document.createElement( 'div' )
            head.className = 'block-item-head'

            var roleBadge = document.createElement( 'span' )
            roleBadge.className = 'block-role-badge'
            roleBadge.textContent = ( role === 'child' ) ? 'Child' : 'Parent'
            head.appendChild( roleBadge )

            var idSpan = document.createElement( 'span' )
            idSpan.className = 'block-item-id'
            idSpan.textContent = blockId
            head.appendChild( idSpan )

            var chapterSpan = document.createElement( 'span' )
            chapterSpan.className = 'block-item-chapter'
            // A6: chapter header is rendered once per group; a child binds to its topic instead.
            chapterSpan.textContent = ( role === 'child' ) ? ( block.topic || '' ) : ( block.chapter || '' )
            head.appendChild( chapterSpan )
            item.appendChild( head )

            var meta = document.createElement( 'div' )
            meta.className = 'block-item-meta'
            var repos = ( block.repos && block.repos.length > 0 ) ? block.repos : []
            var tags = ( block.tags && block.tags.length > 0 ) ? block.tags : []
            var topics = ( block.topics && block.topics.length > 0 ) ? block.topics : []
            // A3: a child shows its singular 'topic' as a chip (no plural topics/repos on a child).
            var topicChips = ( role === 'child' && block.topic ) ? [ block.topic ] : topics
            repos.concat( tags ).concat( topicChips ).forEach( function( label ) {
                var tag = document.createElement( 'span' )
                tag.className = 'block-tag'
                tag.textContent = label
                meta.appendChild( tag )
            } )
            // A4: effective requirements (parent default ∪ child additive) rendered as req chips.
            var reqs = ( block.effectiveRequirements && block.effectiveRequirements.length > 0 )
                ? block.effectiveRequirements
                : ( ( block.requirements && block.requirements.length > 0 ) ? block.requirements : [] )
            reqs.forEach( function( label ) {
                var reqChip = document.createElement( 'span' )
                reqChip.className = 'block-tag block-req-chip'
                reqChip.textContent = label
                meta.appendChild( reqChip )
            } )
            item.appendChild( meta )

            item.addEventListener( 'click', function() {
                openBlockModal( block )
            } )

            return item
        }

        // Render the block view model into the given container. payload = the /blocks API shape
        // { blocks[] } from BlockMeta.parse. PRD-004 (A1/A6): blocks are partitioned into parent/child
        // groups; each chapter renders ONE header (A6), parents render as cards and their children
        // render NESTED+indented under them (A1). Orphan children (no matching parent) stay visible.
        function renderBlockView( payload, container ) {
            container.textContent = ''
            var root = document.createElement( 'div' )
            root.className = 'block-view'

            var blocks = ( payload && payload.blocks ) ? payload.blocks : []
            var errors = ( payload && payload.errors ) ? payload.errors : []
            var partition = partitionBlocks( blocks )

            var title = document.createElement( 'div' )
            title.className = 'block-section-title'
            title.textContent = 'Blöcke (' + blocks.length + ')'
            root.appendChild( title )

            // A10/F9: a REAL empty-state. When there are no blocks, render WHY via the shared
            // empty-state component (and tell "no block-meta fence" apart from "all fences failed
            // to parse"). The parse `errors` (discarded before A10) are surfaced as warnings.
            var emptyState = blocksEmptyState( blocks.length, errors.length )
            if( emptyState.empty === true ) {
                root.appendChild( buildEmptyState( emptyState.kind, 'Keine Blöcke', emptyState.reason ) )
            }
            if( errors.length > 0 ) {
                var errBox = document.createElement( 'div' )
                errBox.className = 'block-parse-errors'
                errBox.setAttribute( 'data-block-parse-errors', String( errors.length ) )
                errors.forEach( function( entry ) {
                    var line = document.createElement( 'div' )
                    line.className = 'block-parse-error'
                    line.textContent = ( entry && entry.reason ) ? entry.reason : 'block-meta-Fence ungueltig'
                    errBox.appendChild( line )
                } )
                root.appendChild( errBox )
            }

            var renderChildren = function( parent, host ) {
                var kids = ( parent.children && parent.children.length ) ? parent.children : []
                if( kids.length === 0 ) { return }
                var nest = document.createElement( 'div' )
                nest.className = 'block-children'
                kids.forEach( function( child ) {
                    nest.appendChild( buildBlockItem( child ) )
                } )
                host.appendChild( nest )
            }

            partition.groups.forEach( function( group ) {
                var groupEl = document.createElement( 'div' )
                groupEl.className = 'block-group'
                groupEl.setAttribute( 'data-block-chapter', group.chapter )

                var header = document.createElement( 'div' )
                header.className = 'block-group-header'
                header.textContent = group.chapter
                groupEl.appendChild( header )

                group.parents.forEach( function( parent ) {
                    groupEl.appendChild( buildBlockItem( parent ) )
                    renderChildren( parent, groupEl )
                } )

                root.appendChild( groupEl )
            } )

            if( partition.orphans.length > 0 ) {
                var orphanGroup = document.createElement( 'div' )
                orphanGroup.className = 'block-group block-group-orphans'
                var orphanHeader = document.createElement( 'div' )
                orphanHeader.className = 'block-group-header'
                orphanHeader.textContent = 'Ohne Parent'
                orphanGroup.appendChild( orphanHeader )
                partition.orphans.forEach( function( child ) {
                    orphanGroup.appendChild( buildBlockItem( child ) )
                } )
                root.appendChild( orphanGroup )
            }

            container.appendChild( root )

            return root
        }

        // Open the REUSED .t-modal popup with block details. Toggles t-hidden only; centering is
        // inherited from .t-modal. Section wrappers carry data-block-section hooks for Playwright.
        // PRD-004 (A8/A9): a PARENT shows its three prose body sections (Problem, Loesung, Offene
        // Fragen); a CHILD has no prose (problem/solution/openQuestions are null -> 3x "—"), so it
        // instead shows 'topic' (binding) + its effective requirements, and the title carries the
        // topic (A9 empty-title fix). NO new modal CSS.
        function openBlockModal( block ) {
            var modal = document.getElementById( 'block-modal' )
            var title = document.getElementById( 'block-modal-title' )
            var body = document.getElementById( 'block-modal-body' )
            if( !modal || !body ) { return }

            var isChild = ( block.role === 'child' )

            if( title ) {
                var titleLead = isChild ? ( block.topic || 'Child' ) : ( block.id || 'Block' )
                title.textContent = titleLead + ( ( !isChild && block.chapter ) ? ' · ' + block.chapter : '' )
            }

            body.textContent = ''

            var addSection = function( key, label, value ) {
                var sectionEl = document.createElement( 'div' )
                sectionEl.className = 'block-detail-section'
                sectionEl.setAttribute( 'data-block-section', key )
                var labelEl = document.createElement( 'div' )
                labelEl.className = 'block-detail-label'
                labelEl.textContent = label
                var valueEl = document.createElement( 'div' )
                valueEl.className = 'block-detail-value'
                valueEl.textContent = value || '—'
                sectionEl.appendChild( labelEl )
                sectionEl.appendChild( valueEl )
                body.appendChild( sectionEl )
            }

            if( isChild ) {
                // A8: child has no prose body — show its binding + effective requirements instead of 3x "—".
                addSection( 'topic', 'Topic (Bindung)', block.topic )
                var reqs = ( block.effectiveRequirements && block.effectiveRequirements.length > 0 )
                    ? block.effectiveRequirements
                    : ( ( block.requirementsPlus && block.requirementsPlus.length > 0 ) ? block.requirementsPlus : [] )
                addSection( 'requirements', 'Effektive Requirements', reqs.length > 0 ? reqs.join( ', ' ) : '' )
            } else {
                // Memo 080, PRD-B1: the detail rows follow the ONE register instead of the four
                // hand-typed legacy names. The four ALWAYS stand (unchanged, "—" when empty), so a block
                // authored before the toolkit looks exactly as it did; every OTHER writable section is
                // added when it carries text. Without this the modal would have shown four dashes for a
                // block written with ### Ist-Zustand — the parser would know the section and the display
                // would not, which is the very drift this PRD closes. The list is kept on ONE line and
                // LOCAL (the unit tests lift this function on its own, so it must close over nothing),
                // and the parity test holds it against BlockSections field for field.
                // Entry = [ registerField, dom-hook, label, mode ]. `always` are the four rows this modal
                // has always shown (they keep rendering "—" when empty, so nothing that stood there
                // disappears); `when-set` are the toolkit sections that only appear once authored.
                var BLOCK_DETAIL_SECTIONS = [ [ 'userMandate', 'user-mandate', 'User-Auftrag', 'when-set' ], [ 'currentState', 'current-state', 'Ist-Zustand', 'when-set' ], [ 'targetState', 'target-state', 'Soll-Zustand', 'when-set' ], [ 'delimitation', 'delimitation', 'Abgrenzung', 'when-set' ], [ 'decision', 'decision', 'Entscheidung', 'when-set' ], [ 'measurement', 'measurement', 'Messung', 'when-set' ], [ 'example', 'example', 'Beispiel', 'when-set' ], [ 'risk', 'risk', 'Risiko', 'when-set' ], [ 'counterArgument', 'counter-argument', 'Gegenargument', 'when-set' ], [ 'openItems', 'open-items', 'Offene Punkte', 'when-set' ], [ 'factualAccount', 'factual-account', 'Faktenlage', 'always' ], [ 'assessment', 'assessment', 'Bewertung', 'always' ], [ 'solution', 'solution', 'Loesungsansatz', 'always' ], [ 'openQuestions', 'open-questions', 'Offene Fragen', 'always' ] ]
                BLOCK_DETAIL_SECTIONS.forEach( function( entry ) {
                    var value = block[ entry[ 0 ] ]
                    if( entry[ 3 ] !== 'always' && !value ) { return }
                    addSection( entry[ 1 ], entry[ 2 ], value )
                } )
            }

            // B6: drilldown link Block -> resolved Requirements. The two views used to be fully
            // disconnected; this link closes the block modal and opens the requirements view so the
            // user can see which store requirements the block requirement names resolve to.
            var drillReqs = ( block.effectiveRequirements && block.effectiveRequirements.length > 0 )
                ? block.effectiveRequirements
                : ( ( block.requirements && block.requirements.length > 0 )
                    ? block.requirements
                    : ( ( block.requirementsPlus && block.requirementsPlus.length > 0 ) ? block.requirementsPlus : [] ) )
            var drill = document.createElement( 'a' )
            drill.className = 'block-req-drilldown'
            drill.setAttribute( 'data-block-req-drilldown', String( drillReqs.length ) )
            drill.setAttribute( 'href', '#' )
            drill.textContent = drillReqs.length > 0
                ? ( 'Zu Requirements (' + drillReqs.length + ') →' )
                : 'Zu Requirements →'
            drill.addEventListener( 'click', function( ev ) {
                if( ev && ev.preventDefault ) { ev.preventDefault() }
                closeBlockModal()
                currentContentView = 'prose'
                loadRequirementsView( currentDocumentId )
            } )
            body.appendChild( drill )

            modal.classList.remove( 't-hidden' )

            return modal
        }

        function closeBlockModal() {
            var modal = document.getElementById( 'block-modal' )
            if( modal ) { modal.classList.add( 't-hidden' ) }
        }

        // Fetch the block view model for the active memo and render it into #content.
        // Read-only: GET /api/documents/<id>/blocks. No-op without an active documentId.
        // PRD-009 (F4/E6): non-destructive view-mode panel — same nextViewState contract as
        // loadRequirementsView. Toggling Blocks while Blocks is open returns home to prose.
        async function loadBlockView( documentId ) {
            // PRD-001 (Memo 076, Phase 1, WI-044): the Block overlay belongs to the memos view —
            // same belt-and-suspenders guard as loadRequirementsView.
            if( currentMode !== 'memos' ) { return }
            var contentTarget = document.getElementById( 'content' )
            if( !documentId || !contentTarget ) { return }

            var step = nextViewState( currentContentView, 'blocks' )
            currentContentView = step.view
            if( step.view === 'prose' ) {
                renderProseContent( false )
                syncContentViewToggles()

                return
            }

            try {
                var resp = await fetch( '/api/documents/' + encodeURIComponent( documentId ) + '/blocks' )
                var payload = await resp.json()
                // B11/F9: surface a non-200 or error envelope via the shared error-state instead of
                // swallowing it into a generic line — the real server message reaches the user.
                if( !resp.ok || ( payload && payload.error ) ) {
                    var blockMsg = ( payload && payload.error ) ? payload.error : ( 'HTTP ' + resp.status )
                    renderViewError( contentTarget, 'Blöcke konnten nicht geladen werden: ' + blockMsg )
                    syncContentViewToggles()

                    return
                }
                renderBlockView( payload, contentTarget )
                syncContentViewToggles()
            } catch( err ) {
                renderViewError( contentTarget, 'Blöcke konnten nicht geladen werden.' )
                syncContentViewToggles()
            }
        }

        // WI-103 (Memo 080 Kap 15, F30 = A): the four node colours of the interactive graph. They are the
        // SAME four the mermaid classDefs used (DoltDbAssembler GRAPH_CLASS_DEFS) so the drawing did not
        // silently change its colour language when the renderer changed.
        var GRAPH_KIND_STYLES = [
            { kind: 'T', fill: '#1f3a5f', stroke: '#4a90d9', text: '#e6f0fa' },
            { kind: 'W', fill: '#24402b', stroke: '#5aa75a', text: '#e8f5e8' },
            { kind: 'P', fill: '#4a3a1f', stroke: '#c9a227', text: '#faf3e0' },
            { kind: 'R', fill: '#3f2b4a', stroke: '#9b6ad9', text: '#f2e8fa' }
        ]

        var GRAPH_KIND_LABELS = { T: 'Topic', W: 'Work-Item', P: 'Phase', R: 'PRD' }

        var GRAPH_CY_STYLE = [
            {
                selector: 'node',
                style: {
                    // Fixed box instead of the auto-fit `width: 'label'` / `height: 'label'` pair: cytoscape
                    // deprecated that value and warns on every draw. The server already caps the drawing
                    // label, so a fixed box holds it, and the untruncated title is one click away.
                    'label': 'data(label)', 'font-size': '11px', 'text-wrap': 'wrap', 'text-max-width': '160px',
                    'text-valign': 'center', 'shape': 'round-rectangle', 'width': 178, 'height': 44,
                    'border-width': 1
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 1.4, 'line-color': '#5b6673', 'target-arrow-color': '#5b6673',
                    'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.8
                }
            },
            { selector: 'edge[kind = "topic-prd"]', style: { 'line-style': 'dashed', 'line-color': '#9b6ad9', 'target-arrow-color': '#9b6ad9' } },
            { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#ffffff' } }
        ].concat( GRAPH_KIND_STYLES.map( function( entry ) {
            return {
                selector: 'node[kind = "' + entry.kind + '"]',
                style: { 'background-color': entry.fill, 'border-color': entry.stroke, 'color': entry.text }
            }
        } ) )

        // The live cytoscape instance of the graph view, or null. Held at this level because the view is
        // torn down and rebuilt on every toggle and every memo switch — an instance left behind keeps its
        // listeners and its render loop attached to a container that is no longer in the document.
        var graphInstance = null

        function destroyGraphInstance() {
            if( graphInstance === null ) { return }
            try { graphInstance.destroy() } catch( err ) { /* an already-destroyed instance is not an error */ }
            graphInstance = null
        }

        // PRD-V2 (Memo 080 Kap 15, WI-102): render the knowledge graph answer into #content. The head
        // line ALWAYS states how much was compared (nodes per kind, edges per kind) — an empty drawing
        // area could equally mean "nothing in the database" and "the read failed", so the numbers, the
        // warnings and the explicit empty message carry that difference (Oelstand-Regel).
        // WI-103 (Memo 080 Kap 15, F30 = A): the drawing itself is INTERACTIVE and goes through cytoscape,
        // shipped with the viewer (F13 = A). It replaces the mermaid tile of stage 1, which could only ever
        // be a picture: mermaid runs with securityLevel 'strict' here, and strict switches its click
        // bindings off — a graph whose whole purpose is "welches Topic steckt in welchem PRD" has to be
        // explorable, not just legible. Prose ```mermaid blocks keep using mermaid; only THIS view moved.
        function renderGraphView( payload, contentTarget ) {
            contentTarget.textContent = ''
            var counts = ( payload && payload.counts ) ? payload.counts : {}
            var num = function( value ) { return ( typeof value === 'number' ) ? String( value ) : '?' }

            var wrap = document.createElement( 'div' )
            wrap.className = 'graph-view'
            wrap.setAttribute( 'data-graph-view', payload && payload.empty === true ? 'empty' : 'graph' )

            var headText = 'Topics ' + num( counts.topics )
                + ' · Work-Items ' + num( counts.workItems )
                + ' · Phasen ' + num( counts.phases )
                + ' · PRDs ' + num( counts.prds )
                + ' — Kanten: Topic→Work-Item ' + num( counts.edgesTopicWorkItem )
                + ' · Phase→PRD ' + num( counts.edgesPhasePrd )
                + ' · Topic→PRD ' + num( counts.edgesTopicPrd )
            var head = document.createElement( 'div' )
            head.className = 'graph-counts'
            head.setAttribute( 'data-graph-counts', '1' )
            head.textContent = headText
            wrap.appendChild( head )

            var warnings = ( payload && payload.warnings && payload.warnings.length ) ? payload.warnings : []
            warnings.forEach( function( text ) {
                var note = document.createElement( 'div' )
                note.className = 'graph-warning'
                note.setAttribute( 'data-graph-warning', '1' )
                note.textContent = text
                wrap.appendChild( note )
            } )

            // WI-103 (Memo 080 Kap 15, F30 = A): the drawing is decided by the ELEMENT set, not by the
            // mermaid source. That is the whole point of the change — a graph whose text source blew the
            // mermaid budget ('source-too-large') used to land here as "kein Graph gezeichnet"; cytoscape
            // has no text budget, so it draws exactly those graphs too.
            var elements = ( payload && payload.elements ) ? payload.elements : null
            var elementNodes = ( elements && elements.nodes ) ? elements.nodes : []
            var elementEdges = ( elements && elements.edges ) ? elements.edges : []

            if( !payload || payload.empty === true || elementNodes.length === 0 ) {
                var emptyBox = document.createElement( 'div' )
                emptyBox.className = 'graph-empty'
                emptyBox.setAttribute( 'data-graph-empty', '1' )
                emptyBox.textContent = 'Kein Graph gezeichnet — die gemessenen Zahlen stehen in der Zeile darüber.'
                wrap.appendChild( emptyBox )
                contentTarget.appendChild( wrap )

                return wrap
            }

            // The detail panel a node click fills. It exists BEFORE the graph is drawn and starts with the
            // instruction, so the interaction is discoverable instead of hidden.
            var detail = document.createElement( 'div' )
            detail.className = 'graph-detail'
            detail.setAttribute( 'data-graph-detail', 'empty' )
            detail.textContent = 'Knoten anklicken für Details · Knoten ziehen zum Umordnen · Mausrad zoomt'
            wrap.appendChild( detail )

            var box = document.createElement( 'div' )
            box.className = 'graph-canvas'
            box.setAttribute( 'data-graph-canvas', '1' )
            wrap.appendChild( box )
            contentTarget.appendChild( wrap )

            // A previous instance keeps listeners and a render loop alive on a container that is no longer
            // in the document. Destroy it BEFORE the new one exists — the view is re-entered often.
            destroyGraphInstance()

            try {
                graphInstance = cytoscape( {
                    container: box,
                    elements: { nodes: elementNodes, edges: elementEdges },
                    style: GRAPH_CY_STYLE,
                    layout: { name: 'cose', animate: false, nodeRepulsion: 12000, idealEdgeLength: 120, padding: 30 },
                    // The three properties that make this a GRAPH and not a picture. Spelled out rather than
                    // left to defaults so a later cytoscape release cannot quietly turn interaction off.
                    userZoomingEnabled: true,
                    userPanningEnabled: true,
                    autoungrabify: false
                } )
            } catch( err ) {
                renderViewError( contentTarget, 'Graph konnte nicht gezeichnet werden: ' + ( err && err.message ? err.message : String( err ) ) + ' — gemessen: ' + headText )

                return wrap
            }

            graphInstance.on( 'tap', 'node', function( event ) {
                var data = event.target.data()
                var kindLabel = GRAPH_KIND_LABELS[ data.kind ] || data.kind
                detail.setAttribute( 'data-graph-detail', 'node' )
                detail.setAttribute( 'data-graph-detail-id', data.rawId || '' )
                detail.textContent = kindLabel + ' ' + ( data.rawId || '' )
                    + ( data.title ? ' — ' + data.title : '' )
                    + ' · Kanten: ' + event.target.degree( false )
            } )

            // Tapping the empty background returns the panel to its instruction — the panel never keeps
            // stating a selection that is no longer highlighted.
            graphInstance.on( 'tap', function( event ) {
                if( event.target !== graphInstance ) { return }
                detail.setAttribute( 'data-graph-detail', 'empty' )
                detail.removeAttribute( 'data-graph-detail-id' )
                detail.textContent = 'Knoten anklicken für Details · Knoten ziehen zum Umordnen · Mausrad zoomt'
            } )

            return wrap
        }

        // PRD-V2 (Memo 080 Kap 15, WI-102): fetch the knowledge graph for the active memo and render it
        // into #content. Read-only: GET /api/documents/<id>/graph. Same nextViewState contract as
        // loadRequirementsView / loadBlockView — pressing Graph while Graph is open returns home to prose.
        async function loadGraphView( documentId ) {
            // Same belt-and-suspenders guard as the two panels above: a memo overlay never loads over
            // the clients/specs surface.
            if( currentMode !== 'memos' ) { return }
            var contentTarget = document.getElementById( 'content' )
            if( !documentId || !contentTarget ) { return }

            var step = nextViewState( currentContentView, 'graph' )
            currentContentView = step.view
            if( step.view === 'prose' ) {
                // WI-103: leaving the graph tears the instance down. Without this the toggle back to prose
                // would leave a live cytoscape attached to a container the next render throws away.
                destroyGraphInstance()
                renderProseContent( false )
                syncContentViewToggles()

                return
            }

            try {
                var resp = await fetch( '/api/documents/' + encodeURIComponent( documentId ) + '/graph' )
                var payload = await resp.json()
                // B11/F9: a non-200 or an error envelope is SHOWN with the REAL server message via the
                // shared error-state, never swallowed into a generic line.
                if( !resp.ok || ( payload && payload.error ) ) {
                    var graphMsg = ( payload && payload.error ) ? payload.error : ( 'HTTP ' + resp.status )
                    renderViewError( contentTarget, 'Graph konnte nicht geladen werden: ' + graphMsg )
                    syncContentViewToggles()

                    return
                }
                renderGraphView( payload, contentTarget )
                syncContentViewToggles()
            } catch( err ) {
                renderViewError( contentTarget, 'Graph konnte nicht geladen werden.' )
                syncContentViewToggles()
            }
        }

        function allMemosByNamespace() {
            // All memos grouped by namespace; finalized = selectable, others = greyed/not selectable.
            var groups = {}
            Object.keys( lastTree || {} ).forEach( function( projectId ) {
                var node = lastTree[ projectId ]
                var memos = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                memos.forEach( function( m ) {
                    if( !groups[ projectId ] ) { groups[ projectId ] = [] }
                    groups[ projectId ].push( m )
                } )
            } )
            return groups
        }

        // PRD-012 (Memo 011 Kap 4, F16=A): requirement-modal close wiring — X button, Esc,
        // overlay click. Same toggle mechanic (.t-hidden) as the existing transcript modal.
        var reqCloseBtn = document.getElementById( 'req-modal-close' )
        if( reqCloseBtn ) { reqCloseBtn.addEventListener( 'click', closeRequirementModal ) }

        var reqModalEl = document.getElementById( 'requirement-modal' )
        if( reqModalEl ) {
            reqModalEl.addEventListener( 'click', function( ev ) {
                if( ev.target === reqModalEl ) { closeRequirementModal() }
            } )
        }

        // PRD-010 (Memo 014 Kap 2): block-modal close wiring — X button, Esc, overlay click. Same
        // toggle mechanic (.t-hidden) as the requirement/transcript/plan modals.
        var blockCloseBtn = document.getElementById( 'block-modal-close' )
        if( blockCloseBtn ) { blockCloseBtn.addEventListener( 'click', closeBlockModal ) }

        var blockModalEl = document.getElementById( 'block-modal' )
        if( blockModalEl ) {
            blockModalEl.addEventListener( 'click', function( ev ) {
                if( ev.target === blockModalEl ) { closeBlockModal() }
            } )
        }

        document.addEventListener( 'keydown', function( ev ) {
            if( ev.key === 'Escape' ) { closeRequirementModal() }
        } )

        document.addEventListener( 'keydown', function( ev ) {
            if( ev.key === 'Escape' ) { closeBlockModal() }
        } )

        // E4 (Memo 016 Kap 2): route through the shared gesture-gated singleton instead of
        // constructing a new AudioContext on every call (the old leak). Silent no-op before the
        // first user gesture.
        function playNotification() {
            try {
                var ctx = acquireNotifyAudioCtx()
                if( !ctx ) { return }
                var osc = ctx.createOscillator()
                var gain = ctx.createGain()
                osc.connect( gain )
                gain.connect( ctx.destination )
                osc.frequency.value = 880
                osc.type = 'sine'
                gain.gain.value = 0.08
                gain.gain.exponentialRampToValueAtTime( 0.001, ctx.currentTime + 0.15 )
                osc.start( ctx.currentTime )
                osc.stop( ctx.currentTime + 0.15 )
            } catch( e ) {}
        }

        // E4: flip the gesture flag on the first user interaction. Once set, acquireNotifyAudioCtx
        // is allowed to create the single shared context; before it, every tone is a silent no-op.
        function unlockAudioGesture() {
            audioGestureSeen = true
        }

        document.addEventListener( 'pointerdown', unlockAudioGesture, { once: true } )
        document.addEventListener( 'keydown', unlockAudioGesture, { once: true } )

        // PRD-008: the diff-toggle now lives in the content-sticky-header and is re-created on
        // each updateSidebarSticky render. bindDiffToggle wires the (current) #diff-toggle node
        // to the diff logic and restores its show/hide + active state from currentDiff/showDiff.
        // Memo 081, WI-105: the diff is fetched, not received. This asks for the diff of the revision on
        // screen and asks AT MOST ONCE per revision — a second toggle-on of the same revision uses what
        // is already here. The key is the documentId/fileName pair the server echoes back, so an answer
        // that arrives after the reader moved on can be recognised as stale and dropped.
        function requestDiffIfNeeded() {
            if( diffAvailable !== true ) { return false }
            if( !currentDocumentId || !currentFileName ) { return false }

            var key = currentDocumentId + '::' + currentFileName
            if( currentDiffKey === key && currentDiff ) { return false }
            if( requestedDiffKey === key ) { return false }
            if( !currentWs || currentWs.readyState !== 1 ) { return false }

            requestedDiffKey = key
            currentWs.send( JSON.stringify( { type: 'requestDiff', documentId: currentDocumentId, fileName: currentFileName } ) )

            return true
        }

        function bindDiffToggle() {
            var diffToggleEl = document.getElementById( 'diff-toggle' )
            if( !diffToggleEl ) { return }

            // The toggle is OFFERED on the announcement, not on a payload that is no longer here.
            if( diffAvailable === true ) {
                diffToggleEl.style.display = ''
                diffToggleEl.classList.toggle( 'active', showDiff )
            } else {
                diffToggleEl.style.display = 'none'
                diffToggleEl.classList.remove( 'active' )
            }

            if( diffToggleEl.dataset.bound === '1' ) { return }
            diffToggleEl.dataset.bound = '1'

            diffToggleEl.addEventListener( 'click', function() {
                showDiff = !showDiff
                diffToggleEl.classList.toggle( 'active', showDiff )

                if( showDiff ) { requestDiffIfNeeded() }

                if( showDiff && currentDiff ) {
                    renderDiffView( lastContent, currentDiff )
                } else {
                    slugCounts.clear()
                    // PRD-V4 (Memo 080 Kap 16): same single prose render path as renderProseContent.
                    contentEl.innerHTML = renderMarkdownWithFootnotes( lastContent ).html
                    wireFootnoteRefs( contentEl )
                    interceptLinks()
                    renderAllDiagrams()
                }

                // PRD-007 (D2): toggling the diff re-renders contentEl.innerHTML, which wipes the
                // structure the initial content render applied. Re-run the SAME structure set the
                // data.type==='content' handler runs so sections/vorwort/widgets/TOC survive the
                // toggle (both ON and OFF), instead of leaving a flat, structureless body.
                applyContentStructure()
                renderVorwort( lastVorwort )
                renderFormHints( lastValidation )
                renderQuestionWidgets( lastQuestionSchema )
                buildTOC( currentDiff )
            } )
        }

        // PRD-008 (Memo 019 Kap 9.2/9.5): the old Zone-2 entrypoints — the separate
        // "Transcript fuer diese Revision einfuegen"-Button (#sticky-add-transcript, PRD-013) and
        // the Opt-out-/"bereit / einloggen"-Button (#btn-einloggen, PRD-005) — were REMOVED with
        // the Prompt-Statuszeile-Umbau. Zone 2 has exactly ONE entrypoint now ("Prompt
        // bearbeiten", bindPromptEdit) and NO Opt-out-Schalter ("kein Wegklicken"). The
        // einloggen/Abschluss semantics live on the manual "Abschliessen"-Button (bindPromptFinish).

        // PRD-008 (Memo 019 Kap 9.5): the SINGLE entrypoint of Zone 2. "Prompt bearbeiten" opens
        // ONE combined popup with BOTH prompt parts (Transcript-Abschnitt + Fragen-Abschnitt).
        // Re-bound on each updateSidebarSticky render (header is rebuilt), mirroring the other
        // sticky binders. Zone 2 itself stays a pure status overview — every input lives here.
        var promptEditState = { memoName: null, projectId: null, memoId: null, revisionId: null, transcriptId: null, questions: [] }

        function bindPromptEdit( opts ) {
            opts = opts || {}
            var btn = document.getElementById( 'ps-edit-prompt' )
            if( !btn ) { return }
            if( btn.dataset.bound === '1' ) { return }
            btn.dataset.bound = '1'

            btn.addEventListener( 'click', function() {
                openPromptModal( { memoEntry: opts.memoEntry, memoName: opts.memoName } )
            } )
        }

        // Open #transcript-modal in the combined "Prompt bearbeiten" mode (Kap 9.5). Shows the
        // dedicated #t-panel-prompt (Transcript-Abschnitt + Fragen-Abschnitt), hides the tab-bar
        // + the default Transcript-save footer, and shows the prompt footer ("nichts wegklickbar"
        // + Übernehmen). Prefills the transcript field from the viewed revision's transcript and
        // builds an answer-field per open question.
        function openPromptModal( opts ) {
            opts = opts || {}
            var memoEntry = opts.memoEntry || ( opts.memoName ? lookupMemoEntry( opts.memoName ) : null )
            var modal = document.getElementById( 'transcript-modal' )
            var title = document.querySelector( '#transcript-modal .t-title' )
            if( !modal ) { return }

            transcriptMode.active = true
            transcriptMode.tab = 'prompt'

            if( title ) { title.textContent = 'Prompt bearbeiten' }

            // Toggle the panels: show the combined prompt panel, hide the three transcript panels.
            ;[ 't-tabs', 't-panel-revision', 't-panel-new', 't-panel-add', 't-url-box', 't-actions-default', 't-footnote-default', 't-saved-state' ]
                .forEach( function( id ) {
                    var el = document.getElementById( id )
                    if( el ) { el.classList.add( 't-hidden' ) }
                } )
            ;[ 't-panel-prompt', 'pp-footer' ].forEach( function( id ) {
                var el = document.getElementById( id )
                if( el ) { el.classList.remove( 't-hidden' ) }
            } )

            var ppError = document.getElementById( 'pp-error' )
            if( ppError ) { ppError.classList.add( 't-hidden' ) }
            var ppSuccess = document.getElementById( 'pp-success' )
            if( ppSuccess ) { ppSuccess.classList.add( 't-hidden' ); ppSuccess.textContent = '' }

            // ---- Abschnitt 1: Transcript. Prefill from the viewed revision (next = max REV + 1
            // when none exists yet, matching the sticky add-transcript semantics).
            var projectId = memoEntry ? memoEntry.projectId : ''
            var memoId = memoEntry ? memoEntry.doc.memoName : ''
            var nums = memoEntry ? nextRevisionNumbers( memoEntry.doc.revisions ) : { nextId: 'REV-01' }
            var viewedRev = revisionIdFromFileName( currentFileName )
            var existing = memoEntry ? latestTranscriptForRevision( memoEntry.doc.memoName, viewedRev ) : null

            promptEditState.memoName = opts.memoName || ''
            promptEditState.projectId = projectId
            promptEditState.memoId = memoId
            promptEditState.transcriptId = existing ? existing.transcriptId : null
            // PRD-001 (Memo 022): bind to the DISCUSSED (viewed) revision, not nums.nextId. Feedback
            // ZU REV-N is bound to REV-N. Editing an existing transcript keeps its revision; otherwise
            // bind the viewed revision. nums.nextId is only the fallback when no revision is viewed
            // (e.g. a brand-new memo without any REV file yet).
            promptEditState.revisionId = existing && existing.revisionId ? existing.revisionId : ( viewedRev || nums.nextId )

            var ppProject = document.getElementById( 'pp-project' )
            var ppMemo = document.getElementById( 'pp-memo' )
            var ppRevision = document.getElementById( 'pp-revision' )
            var ppContent = document.getElementById( 'pp-content' )
            if( ppProject ) { ppProject.value = projectId }
            if( ppMemo ) { ppMemo.value = memoId }
            if( ppRevision ) { ppRevision.value = promptEditState.revisionId }
            if( ppContent ) { ppContent.value = '' }
            // PRD-008 (Memo 076 H5, WI-072): the quality checkboxes are NOT part of the field reset
            // above, so a check ticked for memo A leaked silently into memo B's payload. Reset them on
            // every open, then restamp the label (WI-078) so the count starts from zero.
            document.querySelectorAll( '#pp-quality-list .pp-quality-check' ).forEach( function( box ) { box.checked = false } )
            updatePromptQualityLabel()
            updatePromptTranscriptCount()

            // Load the existing transcript body into the field (no header — body only).
            if( promptEditState.transcriptId ) {
                fetch( '/api/transcripts/' + promptEditState.transcriptId )
                    .then( function( resp ) { return resp.ok ? resp.text() : '' } )
                    .then( function( raw ) {
                        // PRD-V5 (Memo 080 Kap 16, WI-133): server form WITH the two trailing newlines
                        // — same reason as in renderTranscriptContent. This is the split that fed the
                        // edit field, so it is the one that produced the second header on save.
                        var marker = '## Transcript-Inhalt\n\n'
                        var idx = raw.indexOf( marker )
                        var body = idx === -1 ? '' : raw.slice( idx + marker.length ).trim()
                        if( ppContent ) { ppContent.value = body }
                        updatePromptTranscriptCount()
                    } )
                    .catch( function() {} )
            }

            // ---- Abschnitt 2: Fragen. Open questions of the viewed memo, each with an answer
            // field. Memo 081 (WI-064): the label used to count doc.questions while the list below it
            // rendered questionNav — two sets under one heading. Both now come from the schema of the
            // viewed revision, so the label counts what the list shows.
            renderPromptQuestions( memoEntry )

            modal.classList.remove( 't-hidden' )
            if( ppContent ) { ppContent.focus() }
        }

        function updatePromptTranscriptCount() {
            var ppContent = document.getElementById( 'pp-content' )
            var el = document.getElementById( 'pp-tcount' )
            if( !ppContent || !el ) { return }
            var plain = ( ppContent.value || '' ).replace( /[^A-Za-zÀ-ÿ0-9]+/g, ' ' ).trim()
            var w = plain.length === 0 ? 0 : plain.split( /\s+/ ).filter( function( t ) { return t.length > 0 } ).length
            var m = w === 0 ? 0 : Math.ceil( w / SPOKEN_WORDS_PER_MINUTE )
            el.textContent = m + ' Min · ' + w.toLocaleString( 'de-DE' ) + ' Wörter'
        }

        // PRD-008 (Memo 076 H5, WI-078): the quality-section label was static ("3 · QUALITY-CHECKS
        // (optional)"), unlike the live Fragen label. Reflect the number of ticked checks live —
        // "(optional)" while none is chosen, "(n gewählt)" once at least one is.
        function updatePromptQualityLabel() {
            var label = document.getElementById( 'pp-quality-label' )
            if( !label ) { return }
            var boxes = document.querySelectorAll( '#pp-quality-list .pp-quality-check' )
            var chosen = Array.prototype.filter.call( boxes, function( box ) { return box.checked } ).length
            var suffix = chosen > 0 ? ( chosen + ' gewählt' ) : 'optional'
            label.textContent = '3 · QUALITY-CHECKS (' + suffix + ')'
        }

        // PRD-008 (Kap 9.5): build the Fragen-Abschnitt — one answer field per open question.
        // Reuses the live questionNav.questions (already parsed from the rendered revision). Memo 081
        // (WI-064): the label "2 · FRAGEN BEANTWORTEN (n / m)" now counts the SAME question schema the
        // list renders. It used to read doc.questions — the per-memo figure — which is how "(0 / 0)"
        // came to sit over five pre-filled answer fields (Beleg 19.2).
        function renderPromptQuestions( memoEntry ) {
            var list = document.getElementById( 'pp-questions-list' )
            var label = document.getElementById( 'pp-questions-label' )
            if( !list ) { return }
            list.innerHTML = ''

            // Memo 081 (WI-064, S2/Ä7): the sharpest form of the defect stood in these four lines — the
            // LABEL counted the registry while the LIST below it rendered questionNav, so "(0 / 0)" could
            // sit over five pre-filled answer fields. The label now counts the same schema the list does.
            // Only the label is touched here; questionNav and its state belong to PRD-31 and are read, not
            // written.
            var qView = countQuestionsOf( lastQuestionSchema )
            if( label ) { label.textContent = '2 · FRAGEN BEANTWORTEN (' + qView.answered + ' / ' + qView.total + ')' }

            var open = Array.isArray( questionNav.questions ) ? questionNav.questions : []
            promptEditState.questions = open

            if( open.length === 0 ) {
                var empty = document.createElement( 'span' )
                empty.className = 'pp-questions-empty'
                empty.textContent = 'Keine offenen Fragen.'
                list.appendChild( empty )

                return
            }

            open.forEach( function( q, qIdx ) {
                var row = document.createElement( 'div' )
                row.className = 'pp-question'
                row.setAttribute( 'data-pp-qidx', String( qIdx ) )

                var t = document.createElement( 'span' )
                t.className = 'pp-question-title'
                t.textContent = ( q.id ? q.id + ' — ' : '' ) + ( q.title || '' )
                row.appendChild( t )

                var input = document.createElement( 'input' )
                input.className = 'pp-question-input'
                input.setAttribute( 'data-pp-answer', String( qIdx ) )
                input.placeholder = 'Antwort...'
                // Memo 081 (REV-10 User-Befund): ONLY the confirmed answer (st.added/st.addedText)
                // may become a value here — this field's value is written verbatim into the
                // "## Antwort auf F{N}" block below, i.e. it becomes a recorded user decision.
                // Prefilling from the LIVE state (Memo 079 PRD-24) turned an un-confirmed click
                // into an answer the user never gave. That is the "Vorauswahl ist keine Antwort"
                // class (Memo 081 Kap 19): held/selected is irrelevant, only deterministically
                // AND visibly confirmed counts.
                // PRD-24's intent (do not silently drop a selection the user forgot to confirm)
                // is preserved via placeholder: visible as a hint, never read as a value.
                // PRD-F3 (Memo 080 Kap 18, S2): the value gate is now TOUCHED **and** CONFIRMED. `added`
                // alone was not enough — PRD-026 lets a machine injection set added/addedText without any
                // user interaction, and such an answer would have been read as a value here. The
                // preselection seeds the display and never reaches this field.
                var st = questionNav.state[ qIdx ]
                var stored = storedAnswerFor( q )
                if( st && st.added === true && st.addedText && st.touched === true ) {
                    input.value = buildAnswerText( q, st ).answerLine
                } else if( stored.found === true ) {
                    // PRD-F3 (S2): an answer ALREADY saved into the transcript is read BACK out of the
                    // content instead of the field starting empty — otherwise a second "Uebernehmen" would
                    // silently drop it. It is the user's own earlier answer, never a preselection.
                    input.value = stored.answer
                } else if( st && ( st.selected.length > 0 || st.custom.length > 0 ) ) {
                    input.placeholder = 'Nicht bestätigt: ' + buildAnswerText( q, st ).answerLine
                        + ' — im Widget auf "Hinzufügen" klicken, sonst wird nichts übernommen.'
                    input.classList.add( 'pp-question-input-unconfirmed' )
                }
                row.appendChild( input )

                list.appendChild( row )
            } )
        }

        // PRD-F3 (Memo 080 Kap 18, S3): read EVERY "## Antwort auf …" block out of a content string.
        // A block runs from its heading to the next "## " heading (exclusive) — the same cut both
        // server-side parsers make, so client and server see the same blocks.
        //
        // IT REPORTS ITS COMPARISON BASIS. `markers` is how many answer headings the content carries at
        // all; `parsed` is how many of them yielded a question id. The two differ exactly when a heading
        // is malformed — and a check whose comparison set is incomplete is not allowed to report green.
        function scanAnswerBlocks( content ) {
            var text = String( content || '' )
            var lines = text.split( '\n' )
            var indexed = lines.map( function( line, index ) { return { line: line, index: index } } )
            var headings = indexed.filter( function( entry ) { return /^##\s+Antwort auf/.test( entry.line ) } )

            var blocks = headings.map( function( entry ) {
                var match = entry.line.match( /^##\s+Antwort auf\s+(F\d+)/ )
                var following = indexed.slice( entry.index + 1 ).filter( function( c ) { return /^##\s/.test( c.line ) } )
                var end = following.length > 0 ? following[ 0 ].index : lines.length

                return {
                    id: match ? match[ 1 ] : null,
                    start: entry.index,
                    end: end,
                    body: lines.slice( entry.index + 1, end ).join( '\n' ).trim()
                }
            } )

            return { markers: headings.length, parsed: blocks.filter( function( b ) { return b.id !== null } ).length, blocks: blocks }
        }

        // PRD-F3 (Memo 080 Kap 18, S3): merge fresh answer blocks into a content BY QUESTION ID.
        //
        // WHY THE ID AND NOT THE TEXT: the previous filter compared whole block TEXT. That closed the
        // "same block twice" half of the defect and left the other half wide open — two DIFFERENT answers
        // to the same question are two different strings, so both were kept and the transcript carried a
        // question answered twice, contradictorily. Measured in this memo's own stock: one recording holds
        // 36 blocks for 18 distinct questions, and F12 appears once with option A and once with option B.
        //
        // THE RULE: no block for this id -> append. One with the SAME text -> nothing happens. One with a
        // DIFFERENT text -> the existing block is REPLACED, not joined by a second. Further blocks for the
        // same id are dropped, so a content that already carries the doubling is repaired on the next save.
        //
        // NOTHING FOUND IS NEVER GREEN: when the content carries answer headings that do not yield a
        // question id, the comparison set is incomplete — the merge refuses with ok:false instead of
        // appending blindly. Every return states how much was compared.
        function mergeAnswerBlocks( content, blocks ) {
            var base = String( content || '' ).trim()
            var scan = scanAnswerBlocks( base )
            var result = { ok: true, content: base, markers: scan.markers, compared: scan.parsed,
                replaced: 0, unchanged: 0, dropped: 0, appended: 0, reason: null }

            if( scan.markers > scan.parsed ) {
                result.ok = false
                result.reason = ( scan.markers - scan.parsed ) + ' von ' + scan.markers
                    + ' "## Antwort auf"-Überschriften tragen keine lesbare Frage-Kennung — '
                    + 'die Dubletten-Prüfung hatte keine vollständige Vergleichsmenge.'

                return result
            }

            var newById = {}
            var unkeyed = []
            blocks.forEach( function( block ) {
                var match = String( block ).match( /^##\s+Antwort auf\s+(F\d+)/ )
                if( match ) { newById[ match[ 1 ] ] = String( block ).trim() }
                else { unkeyed.push( String( block ).trim() ) }
            } )

            // First occurrence per id is REPLACED in place (position preserved), every further one dropped.
            var seen = {}
            var planByStart = {}
            scan.blocks
                .filter( function( blk ) { return blk.id !== null && newById[ blk.id ] !== undefined } )
                .forEach( function( blk ) {
                    var mode = seen[ blk.id ] === true ? 'drop' : 'replace'
                    seen[ blk.id ] = true
                    planByStart[ blk.start ] = { blk: blk, mode: mode }
                    if( mode === 'drop' ) { result.dropped = result.dropped + 1 }
                } )

            var lines = base.split( '\n' )
            var rebuilt = lines.reduce( function( acc, line, idx ) {
                if( idx < acc.skipUntil ) { return acc }
                var planned = planByStart[ idx ]
                if( planned ) {
                    acc.skipUntil = planned.blk.end
                    if( planned.mode === 'replace' ) {
                        var span = lines.slice( planned.blk.start, planned.blk.end )
                        var fresh = newById[ planned.blk.id ]
                        if( span.join( '\n' ).trim() === fresh ) { result.unchanged = result.unchanged + 1 }
                        else { result.replaced = result.replaced + 1 }
                        acc.out.push( fresh )
                        // Re-attach the blank lines the replaced block carried after its body. Without
                        // them a replaced block would butt straight against the next heading, and a
                        // second "Uebernehmen" over an UNCHANGED content would produce different bytes —
                        // which is exactly the idempotency PRD-V5 established and this must not undo.
                        var lastFilled = span.reduce( function( found, line, i ) { return line.trim().length > 0 ? i : found }, -1 )
                        span.slice( lastFilled + 1 ).forEach( function() { acc.out.push( '' ) } )
                    }

                    return acc
                }
                acc.out.push( line )

                return acc
            }, { out: [], skipUntil: 0 } )

            var fresh = Object.keys( newById )
                .filter( function( id ) { return seen[ id ] !== true } )
                .map( function( id ) { return newById[ id ] } )
                .concat( unkeyed.filter( function( block ) { return base.indexOf( block ) === -1 } ) )
            result.appended = fresh.length

            var merged = rebuilt.out.join( '\n' ).trim()
            var sep = merged.length > 0 && fresh.length > 0 ? '\n\n' : ''
            result.content = merged + sep + fresh.join( '\n\n' )

            return result
        }

        // PRD-F3 (Memo 080 Kap 18, S2): the answer this question ALREADY has in the popup content. Read
        // back so a second "Uebernehmen" carries the saved answer instead of starting from an empty field.
        // ONLY a single-line body is offered — the field holds one line, and flattening a multi-line answer
        // would rewrite the user's own text. A multi-line block is therefore left untouched in the content.
        function storedAnswerFor( q ) {
            var out = { found: false, answer: '' }
            if( !q || !q.id ) { return out }
            var el = document.getElementById( 'pp-content' )
            if( !el ) { return out }

            var hits = scanAnswerBlocks( el.value || '' ).blocks
                .filter( function( blk ) { return blk.id === q.id && blk.body.length > 0 && blk.body.indexOf( '\n' ) === -1 } )
            if( hits.length === 0 ) { return out }

            out.found = true
            out.answer = hits[ hits.length - 1 ].body

            return out
        }

        // PRD-008 (Kap 9.5): "Übernehmen" writes BOTH prompt parts back through the existing
        // transcript persistence path, then closes the popup. The transcriptList WS broadcast
        // re-renders Zone 2, so it mirrors the new state (Minuten/Wörter/"N von M beantwortet").
        async function applyPromptEdit() {
            var ppError = document.getElementById( 'pp-error' )
            var ppSuccess = document.getElementById( 'pp-success' )
            var ppContent = document.getElementById( 'pp-content' )
            var ppRevision = document.getElementById( 'pp-revision' )
            if( ppError ) { ppError.classList.add( 't-hidden' ) }
            if( ppSuccess ) { ppSuccess.classList.add( 't-hidden' ); ppSuccess.textContent = '' }

            var transcript = ppContent ? ppContent.value : ''
            var revisionId = ppRevision ? ppRevision.value.trim() : promptEditState.revisionId

            // Assemble the answers from the popup answer fields (Fragen-Abschnitt).
            var answerBlocks = []
            var inputs = document.querySelectorAll( '#pp-questions-list .pp-question-input' )
            inputs.forEach( function( input ) {
                var qIdx = parseInt( input.getAttribute( 'data-pp-answer' ), 10 )
                var q = promptEditState.questions[ qIdx ]
                var val = ( input.value || '' ).trim()
                if( !q || val.length === 0 ) { return }
                // PRD-F3 (Memo 080 Kap 18, S4): the popup path emits the SAME provenance mark as the
                // widget path. typeof-guards so the isolated applyPromptEdit vm-eval (no module scope)
                // simply gets no mark instead of a ReferenceError — the same pattern lastAnnotations uses.
                var stForMark = ( typeof questionNav !== 'undefined' && questionNav && questionNav.state ) ? questionNav.state[ qIdx ] : null
                var mark = ( typeof answerMarkSuffix === 'function' && stForMark ) ? answerMarkSuffix( q, stForMark ) : ''
                answerBlocks.push( '## Antwort auf ' + q.id + ' — ' + q.title + mark + '\n\n' + val + '\n' )
            } )

            // "Kein Wegklicken" (Kap 9.2): both parts always go into the prompt — never optional.
            // PRD-V5 (Memo 080 Kap 16, WI-135) deduped by whole block TEXT. That closed "the same block
            // twice" and left "two different answers to the same question" open — measured in this memo's
            // own recordings (36 blocks for 18 questions; F12 once as A, once as B).
            // PRD-F3 (Memo 080 Kap 18, S3) therefore merges BY QUESTION ID: absent -> append, same text ->
            // nothing, different text -> REPLACE in place. A byte-identical second "Uebernehmen" is
            // unchanged by this (every block matches its own id with the same text and is written back
            // verbatim), so the idempotency this path already had is preserved.
            // PRD-22 (Memo 081 Kap 19, WI-130, S3): the SAME defect, a second mechanism. On an
            // unconfirmed selection the WI-109 gate leaves input.value empty — the intent sits in the
            // placeholder, not the value — so the entry drops out at `val.length === 0` above, equally
            // without a word. Closing only the named functions would close the case and leave the
            // class open. Same producer, so both paths say the same thing.
            // typeof-guard like the marks above: the isolated applyPromptEdit vm-eval has no module
            // scope and must get no notice instead of a ReferenceError.
            if( typeof unconfirmedNotice === 'function' && typeof renderUnconfirmedNotice === 'function' ) {
                renderUnconfirmedNotice( 'pp-unconfirmed', unconfirmedNotice() )
            }

            var merge = mergeAnswerBlocks( transcript, answerBlocks )

            // A6: an incomplete comparison set is RED — the write is refused rather than appending into a
            // content the check could not read. The message names how much was compared.
            if( merge.ok !== true ) {
                if( ppError ) {
                    ppError.textContent = 'Dubletten-Prüfung rot: ' + merge.reason
                    ppError.classList.remove( 't-hidden' )
                }

                return
            }

            var content = merge.content

            // PRD-P3-08 (Memo 075 Phase 3, WI-026/027): append the selected on-demand quality checks as
            // a "## Quality-Checks angefragt" section so the next memo-revision-generate reads it and runs
            // each chosen check in a separate subagent (the viewer never spawns agents — skill-triggered).
            // Inlined (not a helper) so the payload assembly stays self-contained.
            var chosenQuality = []
            document.querySelectorAll( '#pp-quality-list .pp-quality-check' ).forEach( function( box ) {
                if( box.checked ) { chosenQuality.push( box.getAttribute( 'data-quality' ) || box.value ) }
            } )
            if( chosenQuality.length > 0 ) {
                var qualityLines = chosenQuality.map( function( name ) { return '- ' + name } )
                var qualitySection = '## Quality-Checks angefragt\n\n' + qualityLines.join( '\n' ) + '\n'
                var qSep = content.trim().length > 0 ? '\n\n' : ''
                content = content + qSep + qualitySection
            }

            // PRD-P3-07 (Memo 075 Phase 3, WI-012/013/014): fold the discussed revision's annotations into
            // the review transcript as a "## Anmerkungen" section, so "bei Anmerkung 4 war…" resolves in
            // ONE payload (no second fetch, no bare reference — lesson substance-in-revision-not-links).
            // Idempotent/dedupe like appendAddedAnswers: a block already present in the content is skipped.
            // typeof-guard so the isolated applyPromptEdit vm-eval (no module scope) treats it as empty.
            var annSource = ( typeof lastAnnotations !== 'undefined' && Array.isArray( lastAnnotations ) ) ? lastAnnotations : []
            var annForRev = annSource.filter( function( a ) { return a && ( !revisionId || a.revisionId === revisionId ) } )
            var annBlocks = annForRev
                .map( function( a ) {
                    var num = String( a.id || '' ).replace( /ANM-0*/, '' )
                    var quote = a.anchor && a.anchor.type === 'table-row'
                        ? ( 'Zeile: ' + ( a.anchor.rowKey || a.anchor.rowText || '' ) )
                        : ( 'Zitat: "' + ( a.anchor && a.anchor.exact ? a.anchor.exact : '' ) + '"' + ( a.anchor && a.anchor.chapterSlug ? ( ' (Kap. ' + a.anchor.chapterSlug + ')' ) : '' ) )

                    return '### ' + a.id + ' — Anmerkung ' + num + '\n> ' + quote + '\nKommentar: ' + ( a.comment || '' )
                } )
                .filter( function( block ) { return content.indexOf( block ) === -1 } )
            if( annBlocks.length > 0 ) {
                var aSep = content.trim().length > 0 ? '\n\n' : ''
                content = content + aSep + '## Anmerkungen\n\n' + annBlocks.join( '\n\n' ) + '\n'
            }

            if( content.trim().length === 0 ) {
                if( ppError ) {
                    ppError.textContent = 'Mindestens ein Transcript-Text oder eine Antwort ist erforderlich.'
                    ppError.classList.remove( 't-hidden' )
                }

                return
            }

            if( !/^REV-\d{2,}$/.test( revisionId ) ) {
                if( ppError ) {
                    ppError.textContent = 'Revision-Format: REV-XX (mind. 2 Ziffern)'
                    ppError.classList.remove( 't-hidden' )
                }

                return
            }

            try {
                var isUpdate = !!promptEditState.transcriptId
                var url = isUpdate ? '/api/transcripts/' + promptEditState.transcriptId : '/api/transcripts'
                var method = isUpdate ? 'PUT' : 'POST'
                var body = isUpdate
                    ? JSON.stringify( { content: content } )
                    : JSON.stringify( { projectId: promptEditState.projectId, memoId: promptEditState.memoId, revisionId: revisionId, content: content } )

                var resp = await fetch( url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body } )
                var data = await resp.json()

                if( !resp.ok ) {
                    if( ppError ) {
                        ppError.textContent = data.error || 'Server-Fehler'
                        ppError.classList.remove( 't-hidden' )
                    }

                    return
                }

                // PRD-002 (Memo 022, Kap 3): the save succeeded — now make the result visible
                // and reusable instead of closing silently.
                // a) Idempotenz: remember the server-assigned transcriptId so a SECOND
                //    "Übernehmen" without a re-render goes through PUT (Update) instead of
                //    POST (Anlage) — no Karteileichen-Stapel for the same viewed revision.
                if( data && data.transcriptId ) { promptEditState.transcriptId = data.transcriptId }

                // b) URL + Clipboard: copy the fresh transcript URL. The clipboard write is a
                //    Promise; reject (denied permission) must not crash the flow.
                var savedUrl = data && data.url ? data.url : ''
                if( savedUrl && navigator.clipboard && navigator.clipboard.writeText ) {
                    navigator.clipboard.writeText( savedUrl ).catch( function() {} )
                }

                // c) Sichtbare Erfolgs-Quittung mit der URL statt stumm zu schliessen.
                //    PRD-F3 (Memo 080 Kap 18, A6/US-6): the quittance states HOW MUCH the duplicate
                //    check compared. A report without a number counts as a check that did not run.
                if( ppSuccess ) {
                    var checked = 'Dubletten-Prüfung: ' + merge.compared + ' Blöcke verglichen, '
                        + merge.replaced + ' ersetzt, ' + merge.dropped + ' Dublette(n) entfernt, '
                        + merge.appended + ' neu.'
                    ppSuccess.textContent = ( savedUrl
                        ? 'Gespeichert · in Zwischenablage kopiert: ' + savedUrl
                        : 'Gespeichert.' ) + ' · ' + checked
                    ppSuccess.classList.remove( 't-hidden' )
                }

                // d) ps-copy sofort aktiv schalten — ohne auf den WS-Render-Roundtrip zu warten.
                //    Zone 2 (Minuten/Wörter, "N von M beantwortet") spiegelt den neuen Stand
                //    weiterhin über den bestehenden transcriptList-Broadcast → updateSidebarSticky.
                activatePsCopy( savedUrl )
            } catch( err ) {
                if( ppError ) {
                    ppError.textContent = 'Netzwerkfehler: ' + err.message
                    ppError.classList.remove( 't-hidden' )
                }
            }
        }

        // PRD-002 (Memo 022, Kap 3): make the Zone-2 copy button (#ps-copy) usable right after a
        // save, BEFORE the WS broadcast re-renders the header. Removes the disabled state, sets the
        // fresh URL on data-url, and binds a copy-handler once (mirrors updateSidebarSticky's
        // handler at the ps-copy bind site: copies + shows a short ✓). No-op without a URL.
        function activatePsCopy( url ) {
            if( !url ) { return }
            var copyBtn = document.getElementById( 'ps-copy' )
            if( !copyBtn ) { return }

            copyBtn.removeAttribute( 'disabled' )
            copyBtn.disabled = false
            copyBtn.setAttribute( 'data-url', url )

            if( copyBtn.dataset.ppCopyBound !== '1' ) {
                copyBtn.dataset.ppCopyBound = '1'
                copyBtn.addEventListener( 'click', function() {
                    var current = copyBtn.getAttribute( 'data-url' ) || ''
                    if( !current ) { return }
                    navigator.clipboard.writeText( current ).then( function() {
                        var orig = copyBtn.textContent
                        copyBtn.textContent = '\u2713'
                        setTimeout( function() { copyBtn.textContent = orig }, 2000 )
                    } ).catch( function() {} )
                } )
            }
        }

        // PRD-008 (Memo 019 Kap 9.6): manual "Abschliessen" trigger (F7 = A). User-only — there
        // is NO auto-trigger and NO Transcript-opt-out beside it (a present transcript is always
        // part of the prompt). The future auto-send to the agent docks onto the existing
        // TranscriptRegistry #onChangeCallback / transcriptLoggedIn event-hook; PRD-008 only
        // wires the manual login trigger here, it does NOT activate the automatic send.
        // WI-017 (Memo 076, deferred-documented): the automatic injection of question-rounds
        // (code-driven agent re-invocation on a new round) stays DELIBERATELY inactive — its
        // activation was NOT among the bound F-decisions and is its own, not-yet-decided decision.
        // This is a known open point, not a bug; do not wire the auto-send without a separate
        // user decision (see Memo 076 "Nicht im Scope"). Note-only, no behaviour change here.
        function bindPromptFinish( opts ) {
            opts = opts || {}
            var btn = document.getElementById( 'ps-finish' )
            if( !btn ) { return }
            if( btn.dataset.bound === '1' ) { return }
            btn.dataset.bound = '1'

            btn.addEventListener( 'click', function() {
                var transcriptId = opts.transcriptId || ''
                if( !transcriptId ) {
                    window.alert( 'Kein Transcript zum Abschliessen — bitte zuerst "Prompt bearbeiten" und Übernehmen.' )

                    return
                }

                // Manual finish = log in the revision (event-hook for the future auto-send).
                fetch( '/api/transcripts/' + transcriptId + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } )
                    .then( function( resp ) {
                        if( !resp.ok ) { return }
                        // The transcriptLoggedIn WS broadcast re-renders Zone 2; no reload.
                        // PRD-031 (Memo 067 Phase 9, WI-8-04/05): additionally wake the session(s) armed
                        // on THIS transcript — a token-free reverse-channel signal to the waiting agent.
                        // Reads the armed session-ids (GET-Anteil), then POSTs wake to each; the flag
                        // filename is session-scoped so parallel sessions never cross-wake.
                        fetch( '/api/session/armed?transcriptId=' + encodeURIComponent( transcriptId ) )
                            .then( function( r ) { return r.ok ? r.json() : { sessions: [] } } )
                            .then( function( data ) {
                                var sessions = ( data && data.sessions ) ? data.sessions : []
                                sessions.forEach( function( sessionId ) {
                                    // PRD-P3-03 (Memo 075 Phase 3, WI-010): carry the transcriptId in the
                                    // wake payload so the re-invoked agent full-reads THIS transcript
                                    // without a second lookup (the flag is no longer empty).
                                    fetch( '/api/session/' + encodeURIComponent( sessionId ) + '/wake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { transcriptId: transcriptId } ) } ).catch( function() {} )
                                } )
                            } )
                            .catch( function() {} )
                    } )
                    .catch( function() {} )
            } )
        }

        var tocListEl = document.getElementById( 'toc-list' )

        // PRD-009: enforce the interactive-area structure inside the rendered content.
        // Order: Metatags -> Kontext -> Topics -> interaktiver Bereich (Vorwort OBEN, dann Fragen).
        // - "Offene Fragen" heading becomes a prominent, linkable anchor (id="offene-fragen", F11).
        // - A Vorwort placeholder section (id="vorwort") is inserted directly before it
        //   (Befuellung Phase 6 / Kap 19); it stays hidden while empty.
        // PRD-Q3 (Memo 080, Kap 25): the hint-band placeholder, mirroring the Vorwort placeholder
        // inside applyContentStructure. Its own function on purpose — applyContentStructure returns
        // early on a document WITHOUT an "Offene Fragen" heading, and a memo without open questions
        // must still be able to show its hints, so this runs before that guard.
        function ensureFormHintsSection() {
            if( document.getElementById( 'form-hints' ) ) { return }

            var formHints = document.createElement( 'section' )
            formHints.id = 'form-hints'
            formHints.className = 'form-hints-section form-hints-empty'
            formHints.setAttribute( 'aria-label', 'Form-Hinweise' )
            contentEl.insertBefore( formHints, contentEl.firstChild )
        }

        function applyContentStructure() {
            ensureFormHintsSection()
            var headings = contentEl.querySelectorAll( 'h1, h2, h3, h4' )
            // PRD-006 (#C2/#C3): anchor on the canonical EXACT "## Offene Fragen" (H2), NOT the
            // first h1-h4 match. The old first-match scan landed on a chapter-5 "### Offene Fragen"
            // (H3), so the widget mounted there and the real H2 section ended up empty. Mirrors
            // MemoView.questionsSection anchorIndex (level === 2 + exact text match).
            var fragenHeading = null
            headings.forEach( function( h ) {
                if( fragenHeading ) { return }
                if( h.tagName === 'H2' && /offene\s+fragen/i.test( h.textContent || '' ) ) { fragenHeading = h }
            } )
            // Fallback: only if there is truly no H2 (degraded memo), take the first h1-h4 match so
            // the interactive area still appears somewhere rather than vanishing.
            if( !fragenHeading ) {
                headings.forEach( function( h ) {
                    if( fragenHeading ) { return }
                    if( /offene\s+fragen/i.test( h.textContent || '' ) ) { fragenHeading = h }
                } )
            }

            if( !fragenHeading ) { return }

            // Prominent, linkable anchor (F11).
            fragenHeading.id = 'offene-fragen'
            fragenHeading.classList.add( 'offene-fragen-anchor' )

            // PRD-007 (#49): set an anchor on the "Finalisierungs-Frage" heading so the
            // On-this-page list can link to it. Detected by regex over all headings.
            var finalHeading = null
            headings.forEach( function( h ) {
                if( finalHeading ) { return }
                if( /finalisierung/i.test( h.textContent || '' ) ) { finalHeading = h }
            } )
            if( finalHeading ) { finalHeading.id = 'finalisierungs-frage' }

            // Neutralise the raw markdown "## Vorwort" / "## Claude-Vorwort" heading from the
            // main flow: marked renders it as <h2 id="vorwort">, which (a) collides with the
            // placeholder id below — so the placeholder was never created and renderVorwort
            // filled the H2 itself, rendering the whole Vorwort at h2 size ("komplett in h1") —
            // and (b) duplicates the prose. Strip its id (frees "vorwort" for the placeholder)
            // and hide the heading + its level-aware body siblings (reusing the raw-question class).
            var rawVorwortHeading = null
            headings.forEach( function( h ) {
                if( rawVorwortHeading ) { return }
                if( /^(?:claude-)?vorwort$/i.test( ( h.textContent || '' ).trim() ) ) { rawVorwortHeading = h }
            } )
            if( rawVorwortHeading ) {
                rawVorwortHeading.removeAttribute( 'id' )
                rawVorwortHeading.classList.add( 'raw-question-hidden' )
                hiddenSiblingsAfter( rawVorwortHeading ).forEach( function( node ) {
                    node.classList.add( 'raw-question-hidden' )
                } )
            }

            // PRD-006 (#C5/#C6): the Vorwort placeholder is placed at its SOURCE position (right
            // where the raw "## Vorwort" heading sat), not forced to the top — that contradicted
            // the source order. The id="vorwort" placeholder is created defensively by this scope
            // itself (C6): the raw heading's id was already stripped above, so the placeholder owns
            // "vorwort" unambiguously regardless of heading-scan order. When no raw Vorwort heading
            // exists, fall back to the top (after the title H1) so renderVorwort still has a host.
            if( !document.getElementById( 'vorwort' ) ) {
                var vorwort = document.createElement( 'section' )
                vorwort.id = 'vorwort'
                vorwort.className = 'vorwort-section vorwort-empty'
                vorwort.setAttribute( 'aria-label', 'Vorwort' )
                if( rawVorwortHeading && rawVorwortHeading.parentNode ) {
                    rawVorwortHeading.parentNode.insertBefore( vorwort, rawVorwortHeading )
                } else {
                    var titleH1 = contentEl.querySelector( 'h1' )
                    if( titleH1 ) {
                        titleH1.parentNode.insertBefore( vorwort, titleH1.nextSibling )
                    } else {
                        contentEl.insertBefore( vorwort, contentEl.firstChild )
                    }
                }
            }

            // PRD-002 (#12/#15): Caps-Section-Labels + INTERAKTIVER BEREICH.
            applySectionLabels()
            // PRD-002 (#13): TOPICS-Sektion als nummerierte Chip-Leiste.
            applyTopicChips()
            // PRD-002 (#14): Metatags-Tabelle als Chip-Leiste.
            applyMetatagChips()
            // PRD-001 (#16-18): Roh-Markdown der Frage-Sektionen ausblenden, Anchor behalten.
            hideRawQuestionBodies()
            // PRD-015 (D6) + Memo 081, WI-113: fold a block's structured H3 body sections below a
            // block-meta card into <details> frames carrying a computed figure line. WHICH sections fold
            // comes from the ONE contract (BlockSections.chapterContract(), mirrored as
            // CHAPTER_FOLD_SECTIONS below) — six, not the twenty labels of the vocabulary. Runs after
            // hideRawQuestionBodies (a block's own "### Offene Fragen" is already raw-question-hidden)
            // and BEFORE wrapTablesCollapsible, so a table can ask whether its heading is already
            // visible inside the same frame (WI-114).
            foldBlockBodySections()
            // PRD-018 (Memo 072 Kap 13, F10=A): the deterministic Block↔Topic UI from the STORE.
            // resolveWikiLinks + wrapTablesCollapsible are pure sync DOM surgery; applyTopicPillsFromStore
            // is async (reads /api/documents/<id>/topics) and runs fire-and-forget so it never blocks the
            // sync render. Order: [[…]] links first (before tables reparent nodes), then collapse tables,
            // then the store-driven chapter pill + cross-link line.
            // Memo 081, WI-076: the identifier pass runs at exactly ONE call point, immediately after
            // the [[wiki-link]] pass it was modelled on, on EVERY content render — a pass that only ran
            // on the first load would be gone after the next revision click. It is async (the stock
            // arrives over the network) and shares that ONE request with applyTopicPillsFromStore
            // below; the cache is cleared here so each render still reads the store fresh.
            resetTopicStoreCache()
            resolveWikiLinks()
            resolveIdLinks( currentDocumentId )
            wrapTablesCollapsible()
            // PRD-P3-05/06 (Memo 075 Phase 3, WI-012/013): the annotation render pass. Runs on EVERY
            // render path (this method is the common post-render hook, incl. after renderDiffView), and
            // is idempotent (skips nodes already inside an .anm-mark / rows already .anm-row).
            applyAnnotations()
            applyTopicPillsFromStore( currentDocumentId )
        }


        // PRD-018 (Memo 072 Kap 13, WI-T013-1/2, F10=A): wrap every rendered content table in a
        // <details class="table-collapsible" open> so long tables can be collapsed by the reader.
        // Default OPEN (F10=A: the reading flow stays intact; collapsing is a user action). The summary
        // label is the nearest preceding heading or bold lead-in (e.g. "Befund", "Work-Items"), falling
        // back to "Tabelle". Runs AFTER applyMetatagChips (which replaces the Metatags table with chips),
        // so that table is already gone and never wrapped. No while-loop (Memo-Standard).
        function wrapTablesCollapsible() {
            var tables = contentEl.querySelectorAll( 'table' )
            tables.forEach( function( table ) {
                // Idempotent: skip a table already inside a collapsible wrapper (re-render safety).
                if( table.closest && table.closest( '.table-collapsible' ) ) { return }

                var label = tableSummaryLabel( table )
                var details = document.createElement( 'details' )
                details.className = 'table-collapsible'
                details.setAttribute( 'open', '' )
                var summary = document.createElement( 'summary' )
                // Memo 081, WI-114: an omitted label keeps the toggle but carries no text — the second
                // class lets the stylesheet render a bare toggle instead of an empty line with padding.
                summary.className = label.length > 0 ? 'table-collapsible-summary' : 'table-collapsible-summary bare-table-summary'
                summary.textContent = label
                table.parentNode.insertBefore( details, table )
                details.appendChild( summary )
                details.appendChild( table )
            } )
        }


        // PRD-018: derive a human summary label for a collapsible table from the nearest preceding
        // heading or bold lead-in paragraph. Walks previous siblings (no while-loop — bounded recursion,
        // stops at the first heading or bold lead-in). Falls back to "Tabelle".
        //
        // Memo 081, WI-114 (REV-16:4139-4140): A SECTION TITLE AND A FOLD LABEL MUST NOT SHOW THE SAME
        // TEXT. Measured before this change: the label is derived from the nearest PRECEDING heading,
        // and in a chapter that heading is `### Belege` sitting directly above the table — so the
        // summary read "Belege" one line under the heading "Belege", in all 41 chapters.
        //
        // THE RULE IS ABOUT VISIBILITY, NOT ABOUT THE WORD "Belege", and that is what makes it close the
        // CLASS rather than the case. Testing for that word would leave `### Topics`, `### Work-Items`
        // and `### Abhaengigkeiten` with the identical duplication — measured, their tables sit directly
        // under their heading too, so the duplication is four sections times 41 chapters, not one.
        // The question asked here is: is the heading the label would come from ALREADY VISIBLE inside
        // the same fold frame? If it is, the table takes no label at all — the frame already names it,
        // and its own summary already carries the figure.
        //
        // OUTSIDE A FOLD FRAME NOTHING CHANGES. Tables in the Vorwort, in the questions and in the
        // Nachtraege keep their heading label; a rewrite that relabelled those would be unasked scope.
        function tableSummaryLabel( table ) {
            var fromSibling = function( node ) {
                if( !node ) { return null }
                if( headingLevel( node ) > 0 ) { return { text: ( node.textContent || '' ).trim(), node } }
                if( node.tagName === 'P' ) {
                    var strong = node.querySelector( 'strong, b' )
                    if( strong && ( strong.textContent || '' ).trim().length > 0 ) { return { text: strong.textContent.trim(), node } }
                }
                return fromSibling( node.previousElementSibling )
            }

            var found = fromSibling( table.previousElementSibling )

            if( found && headingLevel( found[ 'node' ] ) > 0 && sameFoldFrame( table, found[ 'node' ] ) ) { return '' }

            return ( found && found[ 'text' ].length > 0 ) ? found[ 'text' ] : 'Tabelle'
        }

        // Two nodes share a fold frame when both sit inside the SAME <details class="chapter-section">.
        // A null frame on either side is not a match: two tables outside every frame do not share one.
        function sameFoldFrame( table, heading ) {
            if( !table.closest || !heading.closest ) { return false }
            var here = table.closest( '.chapter-section' )
            var there = heading.closest( '.chapter-section' )

            return here !== null && here === there
        }


        // PRD-018 (Memo 072 Kap 13, WI-T013-7): turn literal [[slug]] wiki-links (rendered today as
        // plain text) into navigable links. Post-render text-node pass — skips code/pre/a/script/style so
        // a [[…]] inside a code sample stays literal. A click scrolls to a matching in-page heading id
        // when present, otherwise asks the server to navigate (WS 'navigate' to slug.md). No while-loop:
        // the tree is walked via recursion, each matching text node replaced by a fragment of anchors.
        var WIKI_LINK_RE = /\[\[([^\[\]]+)\]\]/g

        // Memo 081, WI-076 (REV-16:3062): THE SKIP SET IS SHARED, NOT COPIED. It IS the opt-out of
        // T060 — an identifier (or a [[slug]]) written inside a code span or a fence is text and stays
        // text — and the identifier pass below is required to use "the SAME skip set". Two skip sets
        // that are supposed to agree are the parallel path T060 rejects in its own reasoning, so the
        // list was lifted out of resolveWikiLinks to module scope and both passes read THIS one.
        // The diagram containers are NOT in here on purpose: they are <div>s, so they are caught by
        // the isDiagramContainer predicate both passes call next to this lookup, not by a tag name.
        var CONTENT_SKIP_TAGS = { 'CODE': true, 'PRE': true, 'A': true, 'SCRIPT': true, 'STYLE': true }

        function resolveWikiLinks() {
            var skip = CONTENT_SKIP_TAGS
            var textNodes = []
            var collect = function( node ) {
                node.childNodes.forEach( function( child ) {
                    if( child.nodeType === 3 ) {
                        WIKI_LINK_RE.lastIndex = 0
                        if( WIKI_LINK_RE.test( child.nodeValue || '' ) ) { textNodes.push( child ) }

                        return
                    }
                    // PRD-003 (Memo 076 WI-039): also skip diagram containers (.mermaid/.vega-lite) —
                    // they are <div>s (not caught by the tagName skip-set), and their [[slug]] source /
                    // SVG label text must never be rewritten into wiki-link anchors.
                    if( child.nodeType === 1 && !skip[ child.tagName ] && !isDiagramContainer( child ) ) { collect( child ) }
                } )
            }
            collect( contentEl )

            textNodes.forEach( function( node ) {
                var frag = document.createDocumentFragment()
                // split on a capturing group interleaves [text, slug, text, slug, …, text].
                var parts = String( node.nodeValue ).split( WIKI_LINK_RE )
                parts.forEach( function( part, idx ) {
                    if( idx % 2 === 1 ) {
                        frag.appendChild( buildWikiLink( part ) )
                    } else if( part.length > 0 ) {
                        frag.appendChild( document.createTextNode( part ) )
                    }
                } )
                node.parentNode.replaceChild( frag, node )
            } )
        }


        // PRD-018: one wiki-link anchor. Clicking scrolls to an in-page heading id when the slug
        // matches one, otherwise asks the server to navigate to slug.md (reuses the WS 'navigate'
        // channel interceptLinks uses). The visible text keeps the [[slug]] form so it reads as a link.
        function buildWikiLink( slug ) {
            var a = document.createElement( 'a' )
            a.className = 'wiki-link'
            a.setAttribute( 'href', '#' )
            a.setAttribute( 'data-wiki', slug )
            a.textContent = '[[' + slug + ']]'
            a.addEventListener( 'click', function( e ) {
                e.preventDefault()
                var target = slug ? document.getElementById( slug ) : null
                if( target && target.scrollIntoView ) {
                    target.scrollIntoView( { behavior: 'smooth', block: 'start' } )

                    return
                }
                if( currentWs ) {
                    currentWs.send( JSON.stringify( { type: 'navigate', path: slug + '.md' } ) )
                    window.scrollTo( 0, 0 )
                }
            } )

            return a
        }


        // ====================================================================
        // Memo 081, WI-076 (REV-16:3046-3062, T055/T060): IDENTIFIERS IN THE RENDERED DOCUMENT.
        //
        // resolveIdLinks() is built NEXT TO the [[wiki-link]] pass, as an additive post-render pass
        // with the SAME skip set (CONTENT_SKIP_TAGS above) — "no new route, no second renderer"
        // (REV-16:3055). The wiki pass is the template down to the details: text nodes collected by
        // recursion (no while loop), CODE/PRE/A/SCRIPT/STYLE skipped by tag, diagram containers
        // skipped by predicate, each hit replaced by a fragment.
        //
        // THE MARK ADDS NO MARKUP TO THE TEXT. The visible label stays the bare identifier: the
        // reference syntax is "the bare identifier in running prose, no additional markup"
        // (REV-16:3061), and a mark that wrapped it in brackets would reintroduce exactly that.
        //
        // CLASS 3 IS NOT RECOGNIZED, AND THAT IS A DECISION (F12 = A, REV-16:3046). `F7`, `P1`, `C01`,
        // `K1` stay plain text. The reason is measured and lives in the vocabulary itself: 6694 `F`
        // hits across the five corpora are not separable in running prose from formula symbols, figure
        // numbers and keyboard keys. The honest limit of the old vocabulary, not an oversight.
        // ====================================================================

        // The recognized identifier vocabulary, MIRRORED from src/IdRegister.mjs (WI-075 / PRD-40).
        // The browser cannot import the module — the same situation BLOCK_BODY_HEADINGS is in, and the
        // same answer: one readable literal line, held against the module by a parity case that reads
        // THIS line back and fails under an injected divergence.
        //
        // ONLY THE TABLE IS MIRRORED, NEVER THE EXPRESSION. idTokenSource() below rebuilds the
        // alternation from these rows with the same algorithm IdRegister uses, and the parity case
        // compares the RESULT against the module's ID_TOKEN_SOURCE character for character. Two typed
        // expressions would be two truths; one typed table and two builders are one.
        var ID_VOCABULARY_MIRROR = [ { prefix: 'M', separator: 'none', min: 3, max: 4 }, { prefix: 'MNT', separator: 'required', min: 3, max: 4 }, { prefix: 'T', separator: 'none', min: 3, max: 4 }, { prefix: 'B', separator: 'none', min: 3, max: 4 }, { prefix: 'G', separator: 'none', min: 3, max: 4 }, { prefix: 'WI', separator: 'required', min: 3, max: 4 }, { prefix: 'RES', separator: 'required', min: 3, max: 4 }, { prefix: 'PRD', separator: 'required', min: 1, max: 4 }, { prefix: 'REQ', separator: 'required', min: 3, max: 4 }, { prefix: 'PLAN', separator: 'required', min: 3, max: 4 }, { prefix: 'ANM', separator: 'required', min: 3, max: 4 }, { prefix: 'LL', separator: 'required', min: 3, max: 4 }, { prefix: 'REV', separator: 'required', min: 2, max: 4 }, { prefix: 'SR', separator: 'required', min: 2, max: 3 } ]

        // The optional scope prefix of a QUALIFIED, memo-foreign reference — `M080-T096`, `M080/WI-221`
        // (F20 = A). Mirrored from IdRegister.SCOPE_PREFIX_SOURCE and parity-checked with it.
        var ID_SCOPE_PREFIX_SOURCE = '(?:M\\d{3,4}[-/])?'

        // The separator sources, mirrored from IdRegister.SEPARATOR_SOURCE.
        var ID_SEPARATOR_SOURCE = { 'required': '-', 'optional': '-?', 'none': '' }

        // The prefixes the CLIENT stock can carry — the topic store's three corners plus the memo
        // catalogue the sidebar already holds. This is the load-bearing half of the stock: it says
        // which KINDS this view can look up, and that is what tells a missing entry apart from a kind
        // the browser cannot resolve at all. Without it every `PRD-42` and `REV-16` in the prose would
        // be handed to the author as HIS broken reference, which is a defect the machine made.
        var ID_STOCK_PREFIXES = [ 'T', 'B', 'WI', 'M' ]

        // idTokenSource — the alternation, rebuilt from ID_VOCABULARY_MIRROR with the algorithm of
        // IdRegister.buildSource: group by (separator, digit span) in order of first appearance;
        // inside a group sort prefixes by LENGTH DESCENDING then alphabetically so a longer prefix can
        // never be shadowed; sort the groups by their longest prefix, descending. Both orders are
        // computed, never hand-kept.
        function idTokenSource() {
            var groups = []
            ID_VOCABULARY_MIRROR.forEach( function( row ) {
                var key = row.separator + '|' + row.min + '|' + row.max
                var found = groups.find( function( group ) { return group.key === key } )
                if( !found ) {
                    found = { key: key, members: [] }
                    groups.push( found )
                }
                found.members.push( row )
            } )

            return groups
                .map( function( group ) {
                    var prefixes = group.members
                        .map( function( row ) { return row.prefix } )
                        .sort( function( a, b ) { return b.length - a.length || a.localeCompare( b ) } )
                    var head = group.members[ 0 ]
                    var digits = head.min === head.max ? ( '\\d{' + head.min + '}' ) : ( '\\d{' + head.min + ',' + head.max + '}' )

                    return { longest: prefixes[ 0 ].length, source: '(?:' + prefixes.join( '|' ) + ')' + ID_SEPARATOR_SOURCE[ head.separator ] + digits }
                } )
                .sort( function( a, b ) { return b.longest - a.longest || a.source.localeCompare( b.source ) } )
                .map( function( group ) { return group.source } )
                .join( '|' )
        }


        // idRecognizedPrefixes — the mirrored prefix list, in table order. What the parity case holds
        // against IdRegister.prefixes( { recognized: true } ).
        function idRecognizedPrefixes() {
            return ID_VOCABULARY_MIRROR.map( function( row ) { return row.prefix } )
        }


        // idTokenPattern — a FRESH global expression per pass. Global regexes carry lastIndex, and a
        // shared instance walked by two consumers skips hits; the wiki pass resets lastIndex by hand
        // for the same reason. A new object per pass makes that impossible rather than careful.
        function idTokenPattern() {
            return new RegExp( '\\b' + ID_SCOPE_PREFIX_SOURCE + '(?:' + idTokenSource() + ')\\b', 'g' )
        }


        // idSplitToken — a matched token into scope, identifier, prefix and digits. Mirrors
        // IdRegister.#splitToken including its measured rule: A MEMO CANNOT BE SCOPED INSIDE ANOTHER
        // MEMO — `M080/M081` in prose means "M080 and M081", not "M081 within M080". Returns null when
        // the token does not decompose, so a shape the expression matched but the table cannot name is
        // dropped rather than marked under a guessed prefix.
        function idSplitToken( token ) {
            var scoped = /^M(\d{3,4})[-/](.+)$/.exec( token )
            var anchored = new RegExp( '^(?:' + idTokenSource() + ')$' )
            var targetsMemo = scoped !== null && /^M\d{3,4}$/.test( scoped[ 2 ] ) === true
            var qualified = scoped !== null && targetsMemo !== true && anchored.test( scoped[ 2 ] ) === true
            var scope = qualified === true ? ( 'M' + scoped[ 1 ] ) : null
            var id = qualified === true ? scoped[ 2 ] : ( targetsMemo === true ? ( 'M' + scoped[ 1 ] ) : token )
            var parts = /^([A-Z]+)-?(\d+)$/.exec( id )

            if( parts === null ) { return null }

            return { token: token, id: id, scope: scope, qualified: qualified, prefix: parts[ 1 ], key: ( scope === null ? '' : ( scope + '-' ) ) + id }
        }


        // idMemoCatalogue — the memos this viewer knows, from the sidebar tree it already holds. No
        // second fetch: flattenTreeMemos() is the same flattening computeQueue uses. `M081` is derived
        // from the memo FOLDER NAME, exactly as the server derives it (MemoView.#memoIdOf).
        function idMemoCatalogue() {
            var entries = []
            flattenTreeMemos().forEach( function( doc ) {
                if( !doc || typeof doc !== 'object' ) { return }
                var hit = /^(\d{3,4})-/.exec( String( doc.memoName == null ? '' : doc.memoName ) )
                if( hit === null ) { return }
                entries.push( { memo: 'M' + hit[ 1 ], documentId: doc.documentId, memoName: doc.memoName } )
            } )

            return entries
        }


        // buildIdStock — the stock the three display states are decided against, folded out of the
        // topic-store payload the client ALREADY fetches plus the memo catalogue it already holds.
        //
        // A NULL PAYLOAD IS NOT AN EMPTY STOCK. `null` in, `null` out — and the caller then marks
        // NOTHING and says why. An empty stock would report every identifier as broken and claim to
        // have measured, which is the vacuum-green gate with its sign flipped. An empty but PRESENT
        // payload is a different statement and yields a real stock with zero entries: then every
        // T/B/WI reference is genuinely unresolved, and that is the truth about that memo.
        function buildIdStock( payload ) {
            if( !payload || typeof payload !== 'object' ) { return null }

            var topics = Array.isArray( payload.topics ) ? payload.topics : []
            var blocks = Array.isArray( payload.blocks ) ? payload.blocks : []
            var workItems = Array.isArray( payload.workItems ) ? payload.workItems : []
            var chapterOfTopic = {}
            var titleOf = {}
            topics.forEach( function( topic ) {
                if( !topic || typeof topic.id !== 'string' ) { return }
                chapterOfTopic[ topic.id ] = ( typeof topic.chapter === 'string' && topic.chapter.length > 0 ) ? topic.chapter : null
                titleOf[ topic.id ] = topic.title || ''
            } )

            var ids = []
            topics.forEach( function( topic ) {
                if( !topic || typeof topic.id !== 'string' ) { return }
                ids.push( { id: topic.id, title: titleOf[ topic.id ], chapter: chapterOfTopic[ topic.id ] } )
            } )
            blocks.forEach( function( block ) {
                if( !block || typeof block.blockId !== 'string' ) { return }
                // A block has no chapter of its own — it inherits the chapter of the first topic that
                // stands in it. The forward edge topic.blockId is the ONE checked edge the store view
                // uses; block.topicIds is deliberately not read as a second truth.
                var owner = topics.find( function( topic ) { return topic && topic.blockId === block.blockId && chapterOfTopic[ topic.id ] !== null } )

                ids.push( { id: block.blockId, title: '', chapter: owner === undefined ? null : chapterOfTopic[ owner.id ] } )
            } )
            workItems.forEach( function( item ) {
                if( !item || typeof item.id !== 'string' ) { return }
                var chapter = ( typeof item.topicId === 'string' && chapterOfTopic[ item.topicId ] !== undefined ) ? chapterOfTopic[ item.topicId ] : null
                ids.push( { id: item.id, title: item.title || '', chapter: chapter } )
            } )

            var catalogue = idMemoCatalogue()
            var localMemo = null
            catalogue.forEach( function( entry ) {
                if( entry.documentId === currentDocumentId ) { localMemo = entry.memo }
            } )

            return { memo: localMemo, prefixes: ID_STOCK_PREFIXES, ids: ids, catalogue: catalogue }
        }


        // idVerdictOf — the display state of ONE reference. Four states from the memo (REV-16:3048-3052)
        // and a fifth the memo does not name but PRD-40 already minted for the write side:
        //
        //   local        the identifier stands in THIS memo's stock -> anchor, jumps to its chapter
        //   foreign      a qualified `M080-…` (or a bare `M080`) whose memo the catalogue knows ->
        //                anchor to the deep link /doc/{documentId} (WI-066, built as PRD-33). It lands
        //                at the TOP of that document, NOT at the chapter: the client does not hold the
        //                foreign memo's stock and fetching it per identifier would be a request per
        //                link. The tooltip SAYS SO instead of pretending the jump hit a chapter.
        //   unresolved   covered kind, no entry -> muted mark, NO anchor, tooltip naming the reason.
        //                "the mark IS the finding" (REV-16:3052).
        //   ambiguous    covered kind, MORE than one entry — the more dangerous class, kept apart from
        //                unresolved for the same reason IdRegister keeps it apart.
        //   no-carrier   this view carries no stock for the KIND at all (REV, PRD, RES, REQ, …). NOT
        //                the author's defect and never shown as one — a quiet mark whose tooltip says
        //                the browser cannot look this kind up. Reporting it as `unresolved` would hand
        //                the author a defect the machine made, which is exactly why PRD-40 split the
        //                two verdicts in the first place.
        function idVerdictOf( entry, stock ) {
            var memoOf = function( memo ) {
                return stock.catalogue.find( function( item ) { return item.memo === memo } )
            }

            if( entry.qualified === true ) {
                var target = memoOf( entry.scope )
                if( target === undefined ) {
                    return { state: 'unresolved', hint: entry.token + ' — Memo ' + entry.scope.slice( 1 ) + ' ist in diesem Katalog nicht bekannt' }
                }

                return { state: 'foreign', href: '/doc/' + encodeURIComponent( target.documentId ), hint: entry.token + ' — liegt in Memo ' + entry.scope.slice( 1 ) + '. Der Sprung trifft das Dokument, nicht das Kapitel.' }
            }

            if( entry.prefix === 'M' ) {
                var known = memoOf( entry.id )
                if( known === undefined ) {
                    return { state: 'unresolved', hint: entry.token + ' — Memo ' + entry.id.slice( 1 ) + ' ist in diesem Katalog nicht bekannt' }
                }
                if( known.documentId === currentDocumentId ) {
                    return { state: 'foreign', href: '/doc/' + encodeURIComponent( known.documentId ), hint: entry.token + ' — dieses Memo. Der Sprung fuehrt an den Anfang des Dokuments.' }
                }

                return { state: 'foreign', href: '/doc/' + encodeURIComponent( known.documentId ), hint: entry.token + ' — liegt in Memo ' + entry.id.slice( 1 ) + '. Der Sprung trifft das Dokument, nicht das Kapitel.' }
            }

            if( stock.prefixes.indexOf( entry.prefix ) === -1 ) {
                return { state: 'no-carrier', hint: entry.token + ' — fuer diese Art fuehrt die Ansicht keinen Bestand. Nicht geprueft, kein Befund am Text.' }
            }

            var matches = stock.ids.filter( function( item ) { return item.id === entry.id } )

            if( matches.length === 0 ) {
                return { state: 'unresolved', hint: entry.token + ' — kein Eintrag im Bestand dieses Memos' }
            }
            if( matches.length > 1 ) {
                return { state: 'ambiguous', hint: entry.token + ' — ' + matches.length + ' Eintraege tragen diese Kennung' }
            }

            var found = matches[ 0 ]
            var label = found.title && found.title.length > 0 ? ( ' „' + found.title + '"' ) : ''
            if( found.chapter === null ) {
                return { state: 'resolved', hint: entry.token + label + ' — im Bestand, aber ohne Kapitel-Bindung. Kein Sprungziel.' }
            }

            return { state: 'local', chapter: found.chapter, hint: entry.token + label + ' — Kapitel „' + found.chapter + '"' }
        }


        // buildIdMark — one mark. An ANCHOR only where a jump target exists; everything else is a span,
        // because a link that does not move is a promise the display cannot keep. No state is designed
        // to alarm: the unresolved mark is muted, not red — the author has not made a mistake, he has
        // not yet applied a convention this very revision introduces.
        function buildIdMark( entry, verdict, headings ) {
            var target = verdict.state === 'local' ? matchChapterHeading( headings, verdict.chapter ) : null
            var node = ( verdict.state === 'foreign' || target !== null ) ? document.createElement( 'a' ) : document.createElement( 'span' )
            node.className = 'id-ref id-ref-' + ( target === null && verdict.state === 'local' ? 'resolved' : verdict.state )
            node.setAttribute( 'data-id-ref', entry.key )
            node.setAttribute( 'title', verdict.hint )
            node.textContent = entry.token

            if( verdict.state === 'foreign' ) {
                // classifyLinkHref reads a leading "/" as a ROUTE and interceptLinks leaves those
                // alone, so the deep link navigates natively — no WS message, no second handler.
                node.setAttribute( 'href', verdict.href )

                return node
            }

            if( target !== null ) {
                node.setAttribute( 'href', '#' )
                node.addEventListener( 'click', function( e ) {
                    e.preventDefault()
                    if( target.scrollIntoView ) { target.scrollIntoView( { behavior: 'smooth', block: 'start' } ) }
                } )
            }

            return node
        }


        // renderIdStockNote — the FOURTH state, and it is not optional. If "stock missing" and
        // "everything resolved" both looked unremarkable, a failed fetch would read as a clean
        // document. That is the most expensive confusion this project knows, and renderFormHints keeps
        // the same three-way distinction for the same reason. This note is written NEXT TO that band
        // and never into it — the hint band belongs to the server's validator, not to this pass.
        function renderIdStockNote( stock, counted ) {
            var existing = contentEl.querySelector( '.id-ref-note' )
            if( existing ) { existing.parentNode.removeChild( existing ) }
            if( stock !== null && counted > 0 ) { return }

            var note = document.createElement( 'div' )
            note.className = 'id-ref-note'
            note.textContent = stock === null
                ? 'Kennungen: Bestand nicht geladen — keine Kennung wurde geprueft.'
                : 'Kennungen: Bestand geladen, keine Kennung im Text gefunden.'
            contentEl.insertBefore( note, contentEl.firstChild )
        }


        // resolveIdLinks — THE pass. Async because the stock arrives over the network; it shares the
        // ONE in-flight topic-store request with applyTopicPillsFromStore (loadTopicStore) rather than
        // issuing a second fetch. Idempotent: an element already carrying an `id-ref` class is not
        // descended into, so a second run over the same tree produces no nested marks — the form
        // wrapTablesCollapsible already uses with `closest( '.table-collapsible' )`.
        //
        // Returns the counted result so a measurement can state HOW MUCH it looked at. Occurrences and
        // distinct references are TWO statements and an answer that gives only one of them is
        // ambiguous, so both are carried.
        async function resolveIdLinks( documentId ) {
            var payload = documentId ? await loadTopicStore( documentId ) : null

            // The reader switched documents while the stock was in flight: marking now would decorate
            // the NEW document with the OLD memo's stock. Bail instead.
            if( documentId !== currentDocumentId ) { return { ran: false, reason: 'document changed while the stock was loading', occurrences: 0, distinct: 0, states: {} } }

            var stock = buildIdStock( payload )
            if( stock === null ) {
                renderIdStockNote( null, 0 )

                return { ran: true, available: false, reason: 'no stock — nothing was marked and nothing was checked', occurrences: 0, distinct: 0, states: {} }
            }

            var pattern = idTokenPattern()
            var textNodes = []
            var collect = function( node ) {
                node.childNodes.forEach( function( child ) {
                    if( child.nodeType === 3 ) {
                        pattern.lastIndex = 0
                        if( pattern.test( child.nodeValue || '' ) ) { textNodes.push( child ) }

                        return
                    }
                    if( child.nodeType !== 1 ) { return }
                    if( CONTENT_SKIP_TAGS[ child.tagName ] ) { return }
                    if( isDiagramContainer( child ) ) { return }
                    if( child.classList && child.classList.contains( 'id-ref' ) ) { return }
                    collect( child )
                } )
            }
            collect( contentEl )

            var headings = contentEl.querySelectorAll( 'h2' )
            var counted = { occurrences: 0, states: {}, keys: {} }
            textNodes.forEach( function( node ) {
                var text = String( node.nodeValue )
                pattern.lastIndex = 0
                var hits = Array.from( text.matchAll( pattern ) )
                var frag = document.createDocumentFragment()
                var cursor = hits.reduce( function( position, hit ) {
                    if( hit.index > position ) { frag.appendChild( document.createTextNode( text.slice( position, hit.index ) ) ) }
                    var entry = idSplitToken( hit[ 0 ] )
                    if( entry === null ) {
                        frag.appendChild( document.createTextNode( hit[ 0 ] ) )

                        return hit.index + hit[ 0 ].length
                    }
                    var verdict = idVerdictOf( entry, stock )
                    frag.appendChild( buildIdMark( entry, verdict, headings ) )
                    counted.occurrences = counted.occurrences + 1
                    counted.keys[ entry.key ] = true
                    counted.states[ verdict.state ] = ( counted.states[ verdict.state ] || 0 ) + 1

                    return hit.index + hit[ 0 ].length
                }, 0 )
                if( cursor < text.length ) { frag.appendChild( document.createTextNode( text.slice( cursor ) ) ) }
                node.parentNode.replaceChild( frag, node )
            } )

            renderIdStockNote( stock, counted.occurrences )

            return { ran: true, available: true, reason: null, occurrences: counted.occurrences, distinct: Object.keys( counted.keys ).length, states: counted.states, comparedStockEntries: stock.ids.length, comparedStockPrefixes: stock.prefixes.length, comparedCatalogue: stock.catalogue.length }
        }


        // ====================================================================
        // PRD-P3-04/05/06 (Memo 075 Phase 3, WI-012/013): text-passage + table-row annotations.
        // Anchors are W3C-style TextQuoteSelectors (exact+prefix+suffix+chapterSlug) for prose and a
        // stable rowKey (Nr-column, Phase-2 WI-036) for table rows — offsets break on a DOM rebuild
        // (r7-F04), so the anchor is content-addressed, resolved in this idempotent post-render pass.
        // ====================================================================

        // The discussed revision id from the current filename ("REV-06.md" -> "REV-06"). Annotations are
        // memo-scoped but rendered/created against the revision being read.
        function currentRevisionId() {
            var m = String( currentFileName || '' ).match( /(REV-\d+)/ )

            return m ? m[ 1 ] : null
        }

        // Fetch the memo's annotations (scoped to the current revision, or — Memo 079 M3=A — to the open
        // research file) and re-run the pass.
        function refreshAnnotations() {
            if( !currentDocumentId ) { return }
            var rev = currentRevisionId()
            var qs = currentResearchFile
                ? ( '?researchFile=' + encodeURIComponent( currentResearchFile ) )
                : ( rev ? ( '?revisionId=' + encodeURIComponent( rev ) ) : '' )
            fetch( '/api/documents/' + encodeURIComponent( currentDocumentId ) + '/annotations' + qs )
                .then( function( r ) { return r.ok ? r.json() : { annotations: [] } } )
                .then( function( data ) {
                    lastAnnotations = ( data && data.annotations ) ? data.annotations : []
                    applyAnnotations()
                } )
                .catch( function() {} )
        }

        // The numeric display label "Anmerkung N" from an ANM-NNN id.
        function annotationNumber( id ) {
            var m = String( id || '' ).match( /ANM-0*(\d+)/ )

            return m ? String( parseInt( m[ 1 ], 10 ) ) : '?'
        }

        // PRD-V7 (Memo 080 Kap 16, T082): the display status of an annotation. Anything that is not the
        // explicit 'eingearbeitet' reads as 'offen' — an old record without the field included.
        function annotationStatus( ann ) {
            return ( ann && ann.anmStatus === 'eingearbeitet' ) ? 'eingearbeitet' : 'offen'
        }

        // Build a small numbered badge for an annotation. PRD-V7: the badge is the FORWARD reference of
        // the apparatus (like a footnote marker) — clicking jumps to #anm-ref-ANM-NNN instead of opening
        // a second, read-only detail popup. preventDefault + stopPropagation stay: the badge may sit
        // inside an <a> now that the linearization no longer skips links, and must never navigate.
        function annotationBadge( ann ) {
            var badge = document.createElement( 'span' )
            var status = annotationStatus( ann )
            badge.className = status === 'eingearbeitet' ? 'anm-badge anm-badge-done' : 'anm-badge'
            badge.setAttribute( 'data-anm', ann.id )
            badge.setAttribute( 'data-anm-status', status )
            badge.textContent = annotationNumber( ann.id )
            badge.title = 'Anmerkung ' + annotationNumber( ann.id ) + ( ann.comment ? ( ': ' + ann.comment ) : '' )
            badge.addEventListener( 'click', function( e ) {
                e.preventDefault()
                e.stopPropagation()
                jumpToApparatusEntry( ann.id )
            } )

            return badge
        }

        // PRD-V7 (Memo 080 Kap 16, T082, Research-Befund C4): the SCOPE filter. The annotationList WS
        // broadcast carries EVERY annotation of the memo (it is memo-scoped), so without this filter a
        // revision would render the annotations of its sibling revisions — all of them unanchorable, all
        // of them landing in the apparatus as false orphans. A research view sees only its own file's
        // annotations, a revision view only that revision's. Anything that is neither shows none.
        function annotationsInScope( list ) {
            var items = Array.isArray( list ) ? list : []
            if( currentResearchFile ) {
                return items.filter( function( ann ) {
                    return ann && ann.targetKind === 'research' && ann.researchFile === currentResearchFile
                } )
            }

            var rev = currentRevisionId()
            if( !rev ) { return [] }

            return items.filter( function( ann ) {
                return ann && ann.targetKind !== 'research' && ann.revisionId === rev
            } )
        }

        // The idempotent render pass. Runs from applyContentStructure on every render path. Each
        // annotation in scope is anchored; unanchored ones are surfaced fail-loud (r7 — never silently
        // dropped). Skips content already carrying its mark/row (re-render safety). PRD-V7: anchored AND
        // unanchored go into ONE apparatus at the content end, so the sum of both groups always equals
        // the number of annotations in scope; an annotation without an anchor object counts as orphan
        // rather than disappearing between the two groups.
        function applyAnnotations() {
            if( !contentEl ) { return }
            var list = annotationsInScope( lastAnnotations )

            var anchored = []
            var orphans = []
            list.forEach( function( ann ) {
                var hit = ann.anchor
                    ? ( ann.anchor.type === 'table-row' ? anchorTableRow( ann ) : anchorTextQuote( ann ) )
                    : false
                if( hit ) { anchored.push( ann ) } else { orphans.push( ann ) }
            } )

            renderAnnotationApparatus( { anchored: anchored, orphans: orphans } )
            resolvePendingChapterAnchor()
        }

        // Collect forward element siblings until the next H2 (recursion, no while-loop).
        function collectUntilNextH2( node, acc ) {
            if( !node || node.tagName === 'H2' ) { return acc }
            acc.push( node )

            return collectUntilNextH2( node.nextElementSibling, acc )
        }

        // The id of the nearest preceding H2 heading (chapterSlug), scanning previous siblings then up
        // the ancestor chain (recursion, no while-loop). Null when none is found before #content.
        function scanPrevForH2( prev ) {
            if( !prev ) { return null }
            if( prev.tagName === 'H2' && prev.id ) { return prev.id }

            return scanPrevForH2( prev.previousElementSibling )
        }

        function nearestPrecedingH2Slug( fromEl ) {
            if( !fromEl || fromEl === contentEl ) { return null }
            var found = scanPrevForH2( fromEl.previousElementSibling )
            if( found ) { return found }

            return nearestPrecedingH2Slug( fromEl.parentNode )
        }

        // Text-quote anchor (PRD-005 WI-128/129): linearize the chapter scope's text nodes in document
        // order, find ALL `exact` candidates in the linearized string, pick the one whose surrounding text
        // best matches prefix/suffix (W3C TextQuoteSelector — no longer blindly the first occurrence), then
        // wrap the [start,end) range across possibly MULTIPLE text nodes/inline elements (**bold**, `code`)
        // in <mark class="anm-mark" data-anm="ANM-NNN"> fragments + badge. Returns true when anchored.
        function anchorTextQuote( ann ) {
            // Already anchored in this pass? (idempotent skip.)
            if( contentEl.querySelector( '.anm-mark[data-anm="' + cssEscapeAttr( ann.id ) + '"]' ) ) { return true }

            var exact = ann.anchor.exact || ''
            if( exact.length === 0 ) { return false }

            // WI-176 (Memo 080 Kap 16, Beleg 16.7): 'A' and 'CODE' are GONE from the skip set. Skipping
            // them made every selection that spans a link or inline code a permanent orphan — the reader
            // marks a passage, the passage is silently unanchorable, and no marker exists that an
            // apparatus could point at. 'PRE' stays: a code BLOCK is <pre><code>, so keeping PRE shields
            // the block while inline <code> becomes reachable. 'MARK' stays so the pass does not recurse
            // into the marks it just produced. SCRIPT/STYLE stay — they carry no reader-visible text.
            var skip = { 'PRE': true, 'SCRIPT': true, 'STYLE': true, 'MARK': true }
            var scope = chapterScopeRoot( ann.anchor.chapterSlug )

            // Linearize: collect text nodes in document order with their cumulative offset into `full`.
            var segments = []
            var full = ''
            var collect = function( node ) {
                node.childNodes.forEach( function( child ) {
                    if( child.nodeType === 3 ) {
                        var value = String( child.nodeValue || '' )
                        if( value.length > 0 ) {
                            segments.push( { node: child, start: full.length, text: value } )
                            full += value
                        }

                        return
                    }
                    if( child.nodeType === 1 && !skip[ child.tagName ] && !( child.classList && child.classList.contains( 'anm-mark' ) ) ) { collect( child ) }
                } )
            }
            collect( scope )

            var offsets = allIndexesOf( full, exact )
            if( offsets.length === 0 ) { return false }

            var chosen = pickByContext( full, offsets, exact, ann.anchor.prefix || '', ann.anchor.suffix || '' )

            return wrapLinearRange( segments, chosen, exact.length, ann )
        }

        // All start offsets of `needle` in `hay` (recursion, no while-loop). Empty when none.
        function allIndexesOf( hay, needle ) {
            var out = []
            var find = function( from ) {
                var at = hay.indexOf( needle, from )
                if( at === -1 ) { return }
                out.push( at )
                find( at + Math.max( 1, needle.length ) )
            }
            find( 0 )

            return out
        }

        // Pick the candidate offset whose surrounding linearized text best matches prefix (before) and
        // suffix (after). A single candidate or absent prefix/suffix keeps the first occurrence (fallback).
        function pickByContext( full, offsets, exact, prefix, suffix ) {
            if( offsets.length === 1 || ( prefix.length === 0 && suffix.length === 0 ) ) { return offsets[ 0 ] }
            var scored = offsets.map( function( at ) {
                var before = full.slice( Math.max( 0, at - Math.max( prefix.length, 1 ) ), at )
                var after = full.slice( at + exact.length, at + exact.length + Math.max( suffix.length, 1 ) )
                var pre = prefix.length === 0 ? 0 : ( before.slice( -prefix.length ) === prefix ? 2 : ( before.indexOf( prefix ) !== -1 ? 1 : 0 ) )
                var suf = suffix.length === 0 ? 0 : ( after.slice( 0, suffix.length ) === suffix ? 2 : ( after.indexOf( suffix ) !== -1 ? 1 : 0 ) )

                return { at: at, score: pre + suf }
            } )
            var best = scored.reduce( function( acc, cur ) { return cur.score > acc.score ? cur : acc }, scored[ 0 ] )

            return best.at
        }

        // Wrap the linearized range [start, start+len) across the overlapping text-node segments: each
        // overlapping node is split into before/<mark>middle</mark>/after; the badge is appended after the
        // LAST mark. Reproduces the single-node case (before + mark + badge + after). Returns true.
        function wrapLinearRange( segments, start, len, ann ) {
            var end = start + len
            var overlapping = segments.filter( function( seg ) { return seg.start < end && ( seg.start + seg.text.length ) > start } )
            if( overlapping.length === 0 ) { return false }

            overlapping.forEach( function( seg, idx ) {
                var localStart = Math.max( 0, start - seg.start )
                var localEnd = Math.min( seg.text.length, end - seg.start )
                var before = seg.text.slice( 0, localStart )
                var middle = seg.text.slice( localStart, localEnd )
                var after = seg.text.slice( localEnd )

                var frag = document.createDocumentFragment()
                if( before.length > 0 ) { frag.appendChild( document.createTextNode( before ) ) }
                var mark = document.createElement( 'mark' )
                mark.className = 'anm-mark'
                mark.setAttribute( 'data-anm', ann.id )
                // PRD-V7: the FIRST mark of an annotation carries the id the apparatus jumps back to.
                // Only the first — a range spanning several text nodes must not mint a duplicate id.
                if( idx === 0 ) { mark.id = 'anm-mark-' + ann.id }
                mark.textContent = middle
                frag.appendChild( mark )
                if( idx === overlapping.length - 1 ) { frag.appendChild( annotationBadge( ann ) ) }
                if( after.length > 0 ) { frag.appendChild( document.createTextNode( after ) ) }

                if( seg.node.parentNode ) { seg.node.parentNode.replaceChild( frag, seg.node ) }
            } )

            return true
        }

        // Table-row anchor: find the tr whose first cell (Nr-column, Phase-2 WI-036 rowKey) equals the
        // stored rowKey; fall back to a normalized rowText contains-match. Marks tr.anm-row + a badge in
        // the first cell. Returns true when anchored. Idempotent (skips a row already carrying the badge).
        function anchorTableRow( ann ) {
            if( contentEl.querySelector( 'tr.anm-row [data-anm="' + cssEscapeAttr( ann.id ) + '"]' ) ) { return true }

            var scope = chapterScopeRoot( ann.anchor.chapterSlug )
            var rows = scope.querySelectorAll ? scope.querySelectorAll( 'tr' ) : []
            var rowKey = ann.anchor.rowKey || ''
            var rowText = ann.anchor.rowText || ''
            var match = null

            rows.forEach( function( tr ) {
                if( match ) { return }
                var firstCell = tr.querySelector( 'td, th' )
                // PRD-005 WI-115: read the cell/row text WITHOUT the hover gutter "+" so a rowKey like
                // "WI-012" is not seen as "WI-012+" (which would push the row into the orphan list).
                var firstText = firstCell ? nodeTextWithoutGutter( firstCell ).trim() : ''
                if( rowKey.length > 0 && firstText === rowKey ) { match = tr; return }
                if( rowKey.length === 0 && rowText.length > 0 ) {
                    var norm = nodeTextWithoutGutter( tr ).replace( /\s+/g, ' ' ).trim()
                    if( norm.indexOf( rowText ) !== -1 ) { match = tr }
                }
            } )

            if( !match ) { return false }

            match.classList.add( 'anm-row' )
            // PRD-V7: the marked row is the jump target of the apparatus back-link. An id is only minted
            // when the row carries none yet — a second annotation on the SAME row keeps the first row id
            // and is reached through the data-anm fallback in jumpToAnnotationMark (never a duplicate id).
            if( !match.id ) { match.id = 'anm-mark-' + ann.id }
            match.setAttribute( 'data-row-key', rowKey || rowText.slice( 0, 40 ) )
            var host = match.querySelector( 'td, th' )
            if( host ) { host.appendChild( annotationBadge( ann ) ) }

            return true
        }

        // The chapter scope root: the section spanned by the H2 whose id === chapterSlug up to the next
        // H2. Returns a detached container of the in-scope nodes when found, else the whole #content so an
        // anchor without a resolvable chapter still gets a chance to match.
        function chapterScopeRoot( chapterSlug ) {
            if( !chapterSlug ) { return contentEl }
            var heading = document.getElementById( chapterSlug )
            if( !heading || heading.tagName !== 'H2' ) { return contentEl }

            // Collect forward siblings until the next H2 (no while-loop — bounded recursion). We mutate
            // the live nodes in place, so return a lightweight wrapper over childNodes + querySelectorAll.
            var nodes = collectUntilNextH2( heading.nextElementSibling, [] )

            return {
                childNodes: nodes,
                querySelectorAll: function( sel ) {
                    var out = []
                    nodes.forEach( function( n ) {
                        if( n.matches && n.matches( sel ) ) { out.push( n ) }
                        if( n.querySelectorAll ) {
                            n.querySelectorAll( sel ).forEach( function( x ) { out.push( x ) } )
                        }
                    } )

                    return out
                }
            }
        }

        // PRD-V7 (Memo 080 Kap 16, Soll-Zustand "Annotations-Referenzen"): the annotation apparatus —
        // one reference section at the end of #content, the way a scientific paper carries its notes.
        // It REPLACES the former orphan-only error box: anchored annotations form the main group, the
        // unanchorable ones stay visible as their own "nicht verankert" group (r7 fail-loud, never
        // dropped). The container is removed and rebuilt on every pass, so it is idempotent AND always
        // ends up last — independent of the order in which the other post-render passes append.
        function renderAnnotationApparatus( groups ) {
            if( !contentEl ) { return }
            var anchored = ( groups && Array.isArray( groups.anchored ) ) ? groups.anchored : []
            var orphans = ( groups && Array.isArray( groups.orphans ) ) ? groups.orphans : []

            var stale = document.getElementById( 'anm-apparatus' )
            if( stale && stale.parentNode ) { stale.parentNode.removeChild( stale ) }
            if( anchored.length === 0 && orphans.length === 0 ) { return }

            var byId = function( a, b ) { return String( a.id ).localeCompare( String( b.id ) ) }
            var box = document.createElement( 'section' )
            box.id = 'anm-apparatus'
            box.className = 'anm-apparatus'

            var title = document.createElement( 'div' )
            title.className = 'anm-apparatus-title'
            title.textContent = 'Anmerkungen (' + ( anchored.length + orphans.length ) + ')'
            box.appendChild( title )

            var main = document.createElement( 'div' )
            main.className = 'anm-apparatus-group'
            main.setAttribute( 'data-anm-group', 'verankert' )
            anchored.slice().sort( byId ).forEach( function( ann ) {
                main.appendChild( annotationApparatusEntry( ann, { anchored: true } ) )
            } )
            box.appendChild( main )

            if( orphans.length > 0 ) {
                var group = document.createElement( 'div' )
                group.className = 'anm-apparatus-group'
                group.setAttribute( 'data-anm-group', 'nicht-verankert' )
                var groupTitle = document.createElement( 'div' )
                groupTitle.className = 'anm-apparatus-title'
                groupTitle.textContent = 'Nicht verankert (' + orphans.length + ')'
                group.appendChild( groupTitle )
                orphans.slice().sort( byId ).forEach( function( ann ) {
                    group.appendChild( annotationApparatusEntry( ann, { anchored: false } ) )
                } )
                box.appendChild( group )
            }

            contentEl.appendChild( box )
        }


        // One apparatus entry: head ("Anmerkung N" · status chip · back-jump, the latter only when the
        // annotation actually has a mark to return to), the enriched reference line, the comment, and —
        // once the annotation has been worked in — the back-reference to WHERE that happened. Built with
        // DOM nodes and textContent, so memo text never reaches an innerHTML sink.
        function annotationApparatusEntry( ann, options ) {
            var isAnchored = ( options && options.anchored === true )
            var status = annotationStatus( ann )

            var item = document.createElement( 'div' )
            item.id = 'anm-ref-' + ann.id
            item.className = 'anm-ref-item'
            item.setAttribute( 'data-anm', ann.id )
            item.setAttribute( 'data-anm-status', status )

            var head = document.createElement( 'div' )
            head.className = 'anm-ref-head'
            var label = document.createElement( 'strong' )
            label.textContent = 'Anmerkung ' + annotationNumber( ann.id )
            head.appendChild( label )

            var chip = document.createElement( 'span' )
            chip.className = status === 'eingearbeitet' ? 'anm-chip anm-chip-done' : 'anm-chip'
            chip.setAttribute( 'data-anm-status', status )
            chip.textContent = status
            head.appendChild( chip )

            if( isAnchored ) {
                var back = document.createElement( 'button' )
                back.type = 'button'
                back.className = 'anm-ref-back'
                back.setAttribute( 'data-anm-back', ann.id )
                back.textContent = '↩'
                back.title = 'Zurück zur markierten Stelle'
                back.addEventListener( 'click', function( e ) {
                    e.preventDefault()
                    e.stopPropagation()
                    jumpToAnnotationMark( ann.id )
                } )
                head.appendChild( back )
            }
            item.appendChild( head )

            var quote = document.createElement( 'div' )
            quote.className = 'anm-ref-quote'
            quote.textContent = annotationReference( ann.anchor )
            item.appendChild( quote )

            var comment = document.createElement( 'div' )
            comment.className = 'anm-ref-comment'
            comment.textContent = ann.comment ? ann.comment : ''
            item.appendChild( comment )

            if( ann.resolvedIn && ann.resolvedIn.revisionId ) {
                item.appendChild( annotationResolvedLine( ann.resolvedIn ) )
            }

            return item
        }


        // The back-reference line of a worked-in annotation: "Eingearbeitet in REV-NN · Kapitel …", one
        // clickable chapter per entry. Same revision -> in-page jump; another revision -> the existing
        // WS navigate channel plus a remembered anchor (pendingChapterAnchor).
        function annotationResolvedLine( resolvedIn ) {
            var line = document.createElement( 'div' )
            line.className = 'anm-ref-resolved'
            var lead = document.createElement( 'span' )
            lead.textContent = 'Eingearbeitet in ' + resolvedIn.revisionId + ': '
            line.appendChild( lead )

            var chapters = Array.isArray( resolvedIn.chapters ) ? resolvedIn.chapters : []
            chapters.forEach( function( slug, idx ) {
                if( idx > 0 ) { line.appendChild( document.createTextNode( ' · ' ) ) }
                line.appendChild( buildResolvedChapterLink( resolvedIn.revisionId, slug ) )
            } )

            return line
        }


        function buildResolvedChapterLink( revisionId, slug ) {
            var a = document.createElement( 'a' )
            a.className = 'anm-ref-forward'
            a.setAttribute( 'href', '#' )
            a.setAttribute( 'data-anm-chapter', slug )
            a.textContent = 'Kapitel ' + slug
            a.addEventListener( 'click', function( e ) {
                e.preventDefault()
                e.stopPropagation()
                jumpToResolvedChapter( revisionId, slug )
            } )

            return a
        }


        // A short highlight on the jump target so the reader sees WHERE they landed.
        function flashAnnotationTarget( el ) {
            if( !el || !el.classList ) { return }
            el.classList.add( 'anm-flash' )
            setTimeout( function() { el.classList.remove( 'anm-flash' ) }, 1200 )
        }


        function scrollToAnnotationTarget( el ) {
            if( !el ) { return false }
            if( el.scrollIntoView ) { el.scrollIntoView( { behavior: 'smooth', block: 'start' } ) }
            flashAnnotationTarget( el )

            return true
        }


        // Badge -> apparatus entry (the forward reference).
        function jumpToApparatusEntry( id ) {
            return scrollToAnnotationTarget( document.getElementById( 'anm-ref-' + id ) )
        }


        // Apparatus entry -> mark (the back reference). The data-anm fallback covers the case where the
        // mark id was already taken by an earlier annotation on the same table row.
        function jumpToAnnotationMark( id ) {
            var target = document.getElementById( 'anm-mark-' + id )
            if( !target && contentEl && contentEl.querySelector ) {
                target = contentEl.querySelector( '[data-anm="' + cssEscapeAttr( id ) + '"]' )
            }

            return scrollToAnnotationTarget( target )
        }


        // The heading of a chapter slug: the rendered heading id first, then a slugify comparison over
        // the H2s (a duplicate slug gets a "-N" suffix in the id, so the id lookup alone is not enough).
        function scrollToChapterSlug( slug ) {
            var target = slug ? document.getElementById( slug ) : null
            if( !target && contentEl && contentEl.querySelectorAll ) {
                contentEl.querySelectorAll( 'h2' ).forEach( function( h ) {
                    if( target ) { return }
                    if( slugify( ( h.textContent || '' ).trim() ) === slug ) { target = h }
                } )
            }

            return scrollToAnnotationTarget( target )
        }


        // The forward jump of the back-reference. Same revision -> jump inside the page. Another
        // revision -> remember the anchor, ask the server to navigate (the channel the wiki links
        // already use), and let the next render pass redeem it.
        function jumpToResolvedChapter( revisionId, slug ) {
            if( revisionId && currentRevisionId() === revisionId ) {
                return scrollToChapterSlug( slug )
            }

            pendingChapterAnchor = slug
            if( currentWs ) {
                currentWs.send( JSON.stringify( { type: 'navigate', path: revisionId + '.md' } ) )
                window.scrollTo( 0, 0 )
            }

            return false
        }


        // Redeem a chapter anchor remembered across a revision switch — ONCE, then cleared, so a later
        // render pass never scrolls the reader away again.
        function resolvePendingChapterAnchor() {
            if( !pendingChapterAnchor ) { return false }
            var slug = pendingChapterAnchor
            pendingChapterAnchor = null

            return scrollToChapterSlug( slug )
        }

        // A minimal attribute-safe escaper for the data-anm selector (ANM-NNN is already safe; this
        // guards against any unexpected value without pulling in CSS.escape, absent in older engines).
        function cssEscapeAttr( value ) {
            return String( value == null ? '' : value ).replace( /["\\\]]/g, '\\$&' )
        }

        // ---- annotation authoring UI (selection -> modal -> POST) ----

        var annotateFloatingBtn = document.getElementById( 'annotate-floating' )
        var pendingAnnotationAnchor = null

        // Build a TextQuoteSelector from the current window selection inside #content: exact + ~32-char
        // prefix/suffix from the surrounding block text + chapterSlug from the nearest preceding H2 id.
        function buildTextQuoteAnchorFromSelection() {
            var sel = window.getSelection ? window.getSelection() : null
            if( !sel || sel.rangeCount === 0 || sel.isCollapsed ) { return null }
            var exact = String( sel.toString() || '' ).trim()
            if( exact.length === 0 ) { return null }

            var range = sel.getRangeAt( 0 )
            var container = range.startContainer
            var blockEl = container.nodeType === 3 ? container.parentNode : container
            if( !contentEl.contains( blockEl ) ) { return null }

            var blockText = String( blockEl.textContent || '' )
            var idx = blockText.indexOf( exact )
            var prefix = idx > 0 ? blockText.slice( Math.max( 0, idx - 32 ), idx ) : ''
            var suffix = idx >= 0 ? blockText.slice( idx + exact.length, idx + exact.length + 32 ) : ''

            var chapterSlug = nearestPrecedingH2Slug( blockEl )

            return { type: 'text-quote', exact: exact, prefix: prefix, suffix: suffix, chapterSlug: chapterSlug }
        }

        // Wire the selection -> floating "Anmerken" button -> modal flow. Only active on the memo view.
        function initAnnotationUI() {
            if( !contentEl || !annotateFloatingBtn ) { return }

            contentEl.addEventListener( 'mouseup', function() {
                if( currentMode !== 'memos' ) { return }
                var anchor = buildTextQuoteAnchorFromSelection()
                if( !anchor ) {
                    annotateFloatingBtn.classList.add( 't-hidden' )

                    return
                }
                var sel = window.getSelection()
                var rect = sel.getRangeAt( 0 ).getBoundingClientRect()
                // PRD-011 (Memo 076 H7b, WI-100): the button (z-index 60) sits below the fixed 52px
                // nav-bar (z-index 1000). For a selection near the top of the viewport, rect.top-34
                // placed it under the nav-bar where it is invisible/unclickable. Clamp the document
                // top so its viewport position never rises above the nav-bar's 52px.
                var floatTop = window.scrollY + rect.top - 34
                var minTop = window.scrollY + 52
                if( floatTop < minTop ) { floatTop = minTop }
                annotateFloatingBtn.style.top = floatTop + 'px'
                annotateFloatingBtn.style.left = ( window.scrollX + rect.left ) + 'px'
                annotateFloatingBtn.classList.remove( 't-hidden' )
                pendingAnnotationAnchor = anchor
            } )

            annotateFloatingBtn.addEventListener( 'click', function() {
                annotateFloatingBtn.classList.add( 't-hidden' )
                if( pendingAnnotationAnchor ) { openAnnotationModal( pendingAnnotationAnchor ) }
            } )

            bindAnnotationModal()
        }

        // Open the annotation modal in CREATE mode for a prepared anchor (text-quote from selection or
        // table-row from the gutter button). REUSES the .t-modal overlay. PRD-004 WI-125/126: symmetric
        // reset of the write-state (generic title, editable textarea, visible Save) so a prior read-only
        // DETAIL view never leaks into the create flow.
        function openAnnotationModal( anchor ) {
            var modal = document.getElementById( 'annotation-modal' )
            var titleEl = document.getElementById( 'anm-modal-title' )
            var quoteEl = document.getElementById( 'anm-modal-quote' )
            var commentEl = document.getElementById( 'anm-modal-comment' )
            var saveBtn = document.getElementById( 'anm-modal-save' )
            var errEl = document.getElementById( 'anm-modal-error' )
            if( !modal ) { return }

            pendingAnnotationAnchor = anchor
            if( titleEl ) { titleEl.textContent = 'Anmerkung' }
            if( quoteEl ) { quoteEl.textContent = annotationReference( anchor ) }
            if( commentEl ) { commentEl.value = ''; commentEl.readOnly = false }
            if( saveBtn ) { saveBtn.classList.remove( 't-hidden' ) }
            if( errEl ) { errEl.classList.add( 't-hidden' ); errEl.textContent = '' }
            modal.classList.remove( 't-hidden' )
        }

        function closeAnnotationModal() {
            var modal = document.getElementById( 'annotation-modal' )
            if( modal ) { modal.classList.add( 't-hidden' ) }
            pendingAnnotationAnchor = null
        }

        function bindAnnotationModal() {
            var modal = document.getElementById( 'annotation-modal' )
            if( !modal || modal.dataset.bound === '1' ) { return }
            modal.dataset.bound = '1'

            var closeBtn = document.getElementById( 'anm-modal-close' )
            var cancelBtn = document.getElementById( 'anm-modal-cancel' )
            var saveBtn = document.getElementById( 'anm-modal-save' )
            if( closeBtn ) { closeBtn.addEventListener( 'click', closeAnnotationModal ) }
            if( cancelBtn ) { cancelBtn.addEventListener( 'click', closeAnnotationModal ) }
            if( saveBtn ) { saveBtn.addEventListener( 'click', saveAnnotation ) }

            // PRD-004 WI-132: click on the overlay itself (outside .t-modal-content) closes; a click INTO
            // the content bubbles up to .t-modal-content, not to #annotation-modal, so it does not close.
            modal.addEventListener( 'click', function( e ) {
                if( e.target === modal ) { closeAnnotationModal() }
            } )
            // PRD-004 WI-132: Escape closes the modal while it is visible.
            document.addEventListener( 'keydown', function( e ) {
                if( e.key === 'Escape' && !modal.classList.contains( 't-hidden' ) ) { closeAnnotationModal() }
            } )
        }

        // POST /api/annotations for the pending anchor + comment. On success the annotationList WS
        // broadcast re-runs applyAnnotations (mark + badge appear without a reload).
        function saveAnnotation() {
            var commentEl = document.getElementById( 'anm-modal-comment' )
            var errEl = document.getElementById( 'anm-modal-error' )
            var comment = commentEl ? String( commentEl.value || '' ).trim() : ''
            if( !pendingAnnotationAnchor ) { return }

            // Memo 079 M3=A (T059): a research view is annotatable too — when currentResearchFile is set the
            // POST carries targetKind:'research' + researchFile (no REV-NN required). Otherwise the existing
            // revision path applies, and the missing-revision case is caught BEFORE the POST (PRD-005
            // WI-127) with a clear German message instead of a generic 422.
            var rev = currentRevisionId()
            if( !currentResearchFile && !rev ) {
                if( errEl ) { errEl.textContent = 'Anmerkungen sind nur auf einer Revisions-Datei (REV-NN.md) oder einem Research-Dokument möglich.'; errEl.classList.remove( 't-hidden' ) }

                return
            }
            if( comment.length === 0 ) {
                if( errEl ) { errEl.textContent = 'Kommentar ist erforderlich.'; errEl.classList.remove( 't-hidden' ) }

                return
            }

            var payload = currentResearchFile
                ? { documentId: currentDocumentId, targetKind: 'research', researchFile: currentResearchFile, anchor: pendingAnnotationAnchor, comment: comment }
                : { documentId: currentDocumentId, revisionId: rev, anchor: pendingAnnotationAnchor, comment: comment }
            var body = JSON.stringify( payload )

            fetch( '/api/annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body } )
                .then( function( r ) { return r.json().then( function( d ) { return { ok: r.ok, data: d } } ) } )
                .then( function( res ) {
                    if( !res.ok ) {
                        if( errEl ) { errEl.textContent = ( res.data && res.data.error ) || 'Server-Fehler'; errEl.classList.remove( 't-hidden' ) }

                        return
                    }
                    closeAnnotationModal()
                    refreshAnnotations()
                } )
                .catch( function() {
                    if( errEl ) { errEl.textContent = 'Netzwerkfehler.'; errEl.classList.remove( 't-hidden' ) }
                } )
        }

        // PRD-V7 (Memo 080 Kap 16, T082): the read-only detail popup (former showAnnotationDetail,
        // PRD-004 WI-125/126) is GONE. The apparatus entry shows the same fields and more — status,
        // back-jump to the mark, back-reference to the place it was worked in — so a second read-only
        // parallel path for the same record no longer exists. The AUTHORING path (openAnnotationModal /
        // saveAnnotation) is untouched and remains the only owner of #annotation-modal.

        // Remove the hover gutter (and its host marker) from a row (PRD-004 WI-114).
        function removeRowGutter( tr ) {
            if( !tr ) { return }
            var gutter = tr.querySelector( '.anm-row-gutter' )
            if( gutter && gutter.parentNode ) { gutter.parentNode.removeChild( gutter ) }
            var host = tr.querySelector( '.anm-gutter-host' )
            if( host && host.classList ) { host.classList.remove( 'anm-gutter-host' ) }
        }

        // PRD-P3-06 (WI-013): table-row gutter "+" button on hover. Delegated so it survives re-renders.
        // PRD-004 WI-130: only tbody rows whose first cell is a <td> (never thead/th header rows).
        // PRD-004 WI-114: a mouseout that actually leaves the row removes the gutter again.
        function initTableRowAnnotationGutter() {
            if( !contentEl ) { return }
            contentEl.addEventListener( 'mouseover', function( e ) {
                if( currentMode !== 'memos' ) { return }
                var tr = e.target && e.target.closest ? e.target.closest( 'tr' ) : null
                if( !tr || tr.querySelector( '.anm-row-gutter' ) ) { return }
                if( tr.closest && tr.closest( 'thead' ) ) { return }
                var firstCell = tr.querySelector( 'td, th' )
                if( !firstCell || firstCell.tagName !== 'TD' ) { return }
                var gutter = document.createElement( 'button' )
                gutter.type = 'button'
                gutter.className = 'anm-row-gutter'
                gutter.textContent = '+'
                gutter.title = 'Zeile anmerken'
                gutter.addEventListener( 'click', function( ev ) {
                    ev.preventDefault()
                    ev.stopPropagation()
                    openAnnotationModal( buildTableRowAnchor( tr ) )
                } )
                // WI-131: the host cell becomes the positioning context so the absolutely-placed gutter
                // does not stack in-flow with the number badge in the first cell (purely presentational).
                firstCell.classList.add( 'anm-gutter-host' )
                firstCell.appendChild( gutter )
            } )
            contentEl.addEventListener( 'mouseout', function( e ) {
                if( currentMode !== 'memos' ) { return }
                var tr = e.target && e.target.closest ? e.target.closest( 'tr' ) : null
                if( !tr ) { return }
                // Ignore moves that stay inside the same row (cell->cell, or onto the gutter button).
                var to = e.relatedTarget
                if( to && tr.contains && tr.contains( to ) ) { return }
                removeRowGutter( tr )
            } )
        }

        // The text of a cell/row EXCLUDING the hover gutter "+" — a clone with .anm-row-gutter removed
        // (PRD-005 WI-115/116). Preserves legitimate "+" cell values (C++, A+); no blind .replace('+','').
        function nodeTextWithoutGutter( node ) {
            if( !node ) { return '' }
            if( !node.cloneNode ) { return String( node.textContent || '' ) }
            var clone = node.cloneNode( true )
            var gutters = clone.querySelectorAll ? clone.querySelectorAll( '.anm-row-gutter' ) : []
            if( gutters.forEach ) { gutters.forEach( function( el ) { if( el.parentNode ) { el.parentNode.removeChild( el ) } } ) }

            return String( clone.textContent || '' )
        }

        // Build a table-row anchor: rowKey = first cell text when it looks like an ID (Nr-column), else
        // null; rowText = normalized tr textContent fallback; chapterSlug from the nearest preceding H2.
        // PRD-005 WI-116: the gutter "+" is excluded via nodeTextWithoutGutter, never a blind .replace.
        function buildTableRowAnchor( tr ) {
            var firstCell = tr.querySelector( 'td, th' )
            var firstText = firstCell ? nodeTextWithoutGutter( firstCell ).trim() : ''
            var looksLikeId = /^([A-Z]{1,4}-)?\d{1,4}[a-z]?$/.test( firstText ) || /^[A-Z]{1,4}-\d{1,4}$/.test( firstText )
            var rowText = nodeTextWithoutGutter( tr ).replace( /\s+/g, ' ' ).trim()
            var tableEl = tr.closest ? tr.closest( 'table' ) : null
            var chapterSlug = nearestPrecedingH2Slug( tableEl || tr )

            return {
                type: 'table-row',
                rowKey: looksLikeId ? firstText : null,
                rowText: rowText.slice( 0, 200 ),
                tableLabel: tableEl ? tableSummaryLabel( tableEl ) : null,
                chapterSlug: chapterSlug
            }
        }

        // Enriched reference line for the modal quote (PRD-005 WI-122/123/124): Kapitel · tableLabel · the
        // quote/row · the real document line. WI-123: the rowKey is labelled "Tabellenzeile" (a row ID like
        // WI-012), while the persisted document line is shown separately as "Zeile <sourceLine>".
        function annotationReference( anchor ) {
            if( !anchor ) { return '' }
            var parts = []
            if( anchor.chapterSlug ) { parts.push( 'Kapitel ' + anchor.chapterSlug ) }
            if( anchor.type === 'table-row' ) {
                if( anchor.tableLabel ) { parts.push( anchor.tableLabel ) }
                var rowRef = anchor.rowKey || anchor.rowText || ''
                if( rowRef ) { parts.push( 'Tabellenzeile: ' + rowRef ) }
            } else if( anchor.exact ) {
                parts.push( '„' + anchor.exact + '"' )
            }
            if( Number.isInteger( anchor.sourceLine ) ) { parts.push( 'Zeile ' + anchor.sourceLine ) }

            return parts.join( ' · ' )
        }

        initAnnotationUI()
        initTableRowAnnotationGutter()


        // PRD-018 (Memo 072 Kap 13, WI-T013-4/5/8, F10=A): inject the chapter topic-pille + cross-link
        // line DETERMINISTICALLY from the STORE (the topic `chapter` field), NOT from block-meta fences
        // (the REV has 0 fences). Fetches /api/documents/<id>/topics, maps each topic's `chapter` onto
        // its rendered "## N. Titel" heading, groups topics per heading, and injects one pill-header per
        // chapter: a pill "T00N · Block B00X" per topic plus a cross-link line (topics · work-items ·
        // deps · research). Fire-and-forget from applyContentStructure (the store read is async; the sync
        // DOM surgery does not block on it). Idempotent: a heading already carrying a pill-header is left
        // alone (no duplicate on a re-render race).
        // Memo 081, WI-076: the ONE in-flight topic-store request of a render pass. Two consumers now
        // need the same payload — the pill/section injection below and the identifier pass
        // (resolveIdLinks) — and the memo is explicit that the second must not add a fetch of its own
        // ("no second fetch, no new route", REV-16:3055). The promise is cached per documentId and
        // cleared at the start of each content render, so a render still reads the store FRESH while
        // the two consumers inside one render share exactly one request.
        //
        // A FAILURE RESOLVES TO null, IT DOES NOT REJECT. null is a real answer here: it says "no
        // stock", which is a different statement from an empty store, and the identifier pass turns it
        // into a named absence rather than into a document full of false findings.
        var topicStorePending = {}

        function resetTopicStoreCache() {
            topicStorePending = {}
        }

        function loadTopicStore( documentId ) {
            if( !documentId ) { return Promise.resolve( null ) }
            if( topicStorePending[ documentId ] ) { return topicStorePending[ documentId ] }

            topicStorePending[ documentId ] = fetch( '/api/documents/' + encodeURIComponent( documentId ) + '/topics' )
                .then( function( resp ) { return resp.ok ? resp.json() : null } )
                .catch( function() { return null } )

            return topicStorePending[ documentId ]
        }


        async function applyTopicPillsFromStore( documentId ) {
            if( !documentId ) { return }

            var payload = await loadTopicStore( documentId )
            if( payload === null || typeof payload !== 'object' ) { return }

            var topics = ( payload && Array.isArray( payload.topics ) ) ? payload.topics : []
            // PRD-V8 (Memo 080 Kap 16, T080): the same payload now carries the (chapter, block)
            // sections, the unplaceable backlog and the seven counters. The early exit stays an exit
            // for a document WITHOUT a store — it must not swallow a store that has sections.
            var sections = ( payload && Array.isArray( payload.sections ) ) ? payload.sections : []
            var unbound = ( payload && Array.isArray( payload.unbound ) ) ? payload.unbound : []
            var counts = ( payload && payload.counts ) ? payload.counts : null
            if( topics.length === 0 && sections.length === 0 && unbound.length === 0 ) { return }

            var headings = contentEl.querySelectorAll( 'h2' )
            var byHeading = []
            topics.forEach( function( topic ) {
                if( !topic || typeof topic.chapter !== 'string' || topic.chapter.length === 0 ) { return }
                var heading = matchChapterHeading( headings, topic.chapter )
                if( !heading ) { return }
                var entry = byHeading.find( function( e ) { return e.heading === heading } )
                if( !entry ) {
                    entry = { heading: heading, topics: [] }
                    byHeading.push( entry )
                }
                entry.topics.push( topic )
            } )

            byHeading.forEach( function( entry ) {
                injectTopicPillHeader( entry.heading, entry.topics )
            } )

            // PRD-V8: the pill header is the short overview, the tables below are its unfolding. The
            // sections are grouped onto their heading with the SAME matcher the pills use, so a chapter
            // the pills could not place gets no orphan table either.
            var sectionsByHeading = []
            sections.forEach( function( section ) {
                if( !section || typeof section.chapter !== 'string' || section.chapter.length === 0 ) { return }
                var heading = matchChapterHeading( headings, section.chapter )
                if( !heading ) { return }
                var entry = sectionsByHeading.find( function( e ) { return e.heading === heading } )
                if( !entry ) {
                    entry = { heading: heading, sections: [] }
                    sectionsByHeading.push( entry )
                }
                entry.sections.push( section )
            } )

            sectionsByHeading.forEach( function( entry ) {
                injectBlockStoreSections( entry.heading, entry.sections )
            } )

            injectUnboundWorkItems( { unbound: unbound, counts: counts } )
        }


        // PRD-018: map a topic's `chapter` string onto a rendered H2. Primary match is the shared
        // slugify (same normaliser that builds heading ids) so Umlaut/punctuation drift never breaks it;
        // a leading "N." number is the fallback when the title drifted. Returns the heading node or null.
        function matchChapterHeading( headings, chapter ) {
            var wantSlug = slugify( chapter )
            var slugHit = null
            headings.forEach( function( h ) {
                if( slugHit ) { return }
                if( slugify( ( h.textContent || '' ).trim() ) === wantSlug ) { slugHit = h }
            } )
            if( slugHit ) { return slugHit }

            var wantNum = ( chapter.match( /^\s*(\d+)\b/ ) || [] )[ 1 ] || null
            if( wantNum === null ) { return null }

            var numHit = null
            headings.forEach( function( h ) {
                if( numHit ) { return }
                var hNum = ( ( h.textContent || '' ).trim().match( /^\s*(\d+)\./ ) || [] )[ 1 ] || null
                if( hNum !== null && hNum === wantNum ) { numHit = h }
            } )

            return numHit
        }


        // PRD-018: build + insert one topic pill-header directly after a chapter heading. Idempotent —
        // a heading whose next sibling is already a .topic-pill-header is skipped. The cross-link line
        // (WI-T013-8) lists the addressed topics, their linked work-items, deps and research file from
        // the store fields — the user-wished "complexity", without duplicating prose.
        function injectTopicPillHeader( heading, topics ) {
            var next = heading.nextElementSibling
            if( next && next.classList && next.classList.contains( 'topic-pill-header' ) ) { return }

            var wrap = document.createElement( 'div' )
            wrap.className = 'topic-pill-header'

            var pillRow = document.createElement( 'div' )
            pillRow.className = 'topic-pill-row'
            topics.forEach( function( topic ) {
                var pill = document.createElement( 'span' )
                pill.className = 'topic-pill'
                var blockPart = ( typeof topic.blockId === 'string' && topic.blockId.length > 0 ) ? ' · Block ' + topic.blockId : ''
                pill.textContent = topic.id + blockPart
                pill.title = topic.title || ''
                pillRow.appendChild( pill )
            } )
            wrap.appendChild( pillRow )

            var topicIds = topics.map( function( t ) { return t.id } )
            var wis = topics.reduce( function( acc, t ) { return acc.concat( Array.isArray( t.workItemIds ) ? t.workItemIds : [] ) }, [] )
            var deps = topics.reduce( function( acc, t ) { return acc.concat( Array.isArray( t.dependsOn ) ? t.dependsOn : [] ) }, [] )
            var research = topics
                .map( function( t ) { return t.researchFile } )
                .filter( function( r ) { return typeof r === 'string' && r.length > 0 } )

            var crossParts = [ 'Topics: ' + topicIds.join( ', ' ) ]
            if( wis.length ) { crossParts.push( 'Work-Items: ' + uniqueList( wis ).join( ', ' ) ) }
            if( deps.length ) { crossParts.push( 'Abhängt: ' + uniqueList( deps ).join( ', ' ) ) }

            if( crossParts.length ) {
                var cross = document.createElement( 'div' )
                cross.className = 'topic-crosslink-line'
                cross.textContent = crossParts.join( '  ·  ' )
                wrap.appendChild( cross )
            }

            // Memo 079 M3=A (T059): the research file(s) are no longer read-only text — each renders as a
            // CLICKABLE link that opens the research MD. Memo 080 PRD-V6 (WI-177) re-targets that click
            // from the full-page view to the overlay; the annotatable view stays one click away.
            var uniqueResearch = uniqueList( research )
            if( uniqueResearch.length ) {
                var researchRow = document.createElement( 'div' )
                researchRow.className = 'topic-research-line'
                var label = document.createElement( 'span' )
                label.className = 'topic-research-label'
                label.textContent = 'Research: '
                researchRow.appendChild( label )
                uniqueResearch.forEach( function( file, index ) {
                    if( index > 0 ) { researchRow.appendChild( document.createTextNode( ', ' ) ) }
                    var link = document.createElement( 'button' )
                    link.className = 'research-open-link'
                    link.setAttribute( 'data-research-file', file )
                    link.textContent = file
                    // PRD-V6 (Memo 080 Kap 16, WI-177): the entry point now opens the OVERLAY, so the
                    // reading position in #content survives. The title drops the "annotierbar" promise —
                    // annotating lives one click further, behind "Vollansicht" in the overlay header.
                    link.title = 'Research-Dokument öffnen'
                    link.addEventListener( 'click', function() { openResearchOverlay( file ) } )
                    researchRow.appendChild( link )
                } )
                wrap.appendChild( researchRow )
            }

            heading.parentNode.insertBefore( wrap, heading.nextSibling )
        }


        // PRD-V8 (Memo 080 Kap 16, T080, WI-203): unfold one chapter's blocks under the pill header —
        // a Topics table and a Work-Items table PER BLOCK, so a work item is read where it belongs
        // instead of as a bare comma list of ids. Idempotent: a chapter whose pill header is already
        // followed by a .block-store-wrap is left alone, so a second render pass adds no second table.
        // Returns the number of sections injected (0 when it skipped) so a caller can state how much
        // it drew.
        function injectBlockStoreSections( heading, sections ) {
            if( !heading || !Array.isArray( sections ) || sections.length === 0 ) { return 0 }

            var pill = heading.nextElementSibling
            var anchor = ( pill && pill.classList && pill.classList.contains( 'topic-pill-header' ) ) ? pill : heading
            var after = anchor.nextElementSibling
            if( after && after.classList && after.classList.contains( 'block-store-wrap' ) ) { return 0 }

            // The seam to the generator half (PRD-R3): a chapter that already carries its OWN
            // "Work-Items" heading gets a one-line pointer instead of a second table.
            var carriesOwn = chapterCarriesOwnWorkItems( heading )
            var wrap = document.createElement( 'div' )
            wrap.className = 'block-store-wrap'

            sections.forEach( function( section ) {
                var items = Array.isArray( section.workItems ) ? section.workItems : []
                var sectionTopics = Array.isArray( section.topics ) ? section.topics : []
                var topicRows = sectionTopics.map( function( topic ) {
                    var mine = items.filter( function( item ) { return item.topicId === topic.id } )

                    return [ topic.id, topic.title, topic.status, mine.map( function( item ) { return item.id } ).join( ', ' ) ]
                } )
                wrap.appendChild( buildStoreTable( {
                    label: 'Topics',
                    blockId: section.blockId,
                    columns: [ 'Topic', 'Titel', 'Status', 'Work-Items' ],
                    rows: topicRows
                } ) )

                var others = Array.isArray( section.otherChapters ) ? section.otherChapters : []
                if( others.length > 0 ) {
                    var note = document.createElement( 'div' )
                    note.className = 'block-store-note'
                    note.textContent = section.blockId + ' · ' + sectionTopics.length + ' von ' + section.topicCountInBlock
                        + ' Topics in diesem Kapitel · weitere in: ' + others.join( ', ' )
                    wrap.appendChild( note )
                }

                // A block without work items in this chapter gets no work-item section at all — the same
                // treatment the generator path gives it. There is nothing to suppress and nothing to say.
                if( items.length === 0 ) { return }

                if( carriesOwn ) {
                    var seam = document.createElement( 'div' )
                    seam.className = 'block-store-note'
                    seam.textContent = 'Work-Items: im Dokument enthalten'
                    wrap.appendChild( seam )

                    return
                }

                var itemRows = items.map( function( item ) {
                    return [ item.id, item.topicId, item.title, item.status, formatProvenance( item.provenance ), item.group ]
                } )
                wrap.appendChild( buildStoreTable( {
                    label: 'Work-Items',
                    blockId: section.blockId,
                    columns: [ 'WI', 'Topic', 'Titel', 'Status', 'Herkunft', 'Gruppe' ],
                    rows: itemRows
                } ) )
            } )

            anchor.parentNode.insertBefore( wrap, anchor.nextSibling )

            return sections.length
        }


        // PRD-V8: build ONE collapsible store table. The <details class="table-collapsible" open> is
        // built here by hand on purpose: wrapTablesCollapsible() runs synchronously during the render
        // pass, while this injection happens after the async store read — the wrapper is long past.
        // Every cell goes through textContent, never innerHTML, so a title carrying < or & shows up
        // literally instead of being executed as markup.
        function buildStoreTable( spec ) {
            var label = spec.label
            var blockId = spec.blockId
            var columns = Array.isArray( spec.columns ) ? spec.columns : []
            var rows = Array.isArray( spec.rows ) ? spec.rows : []

            var details = document.createElement( 'details' )
            details.className = 'table-collapsible block-store-section'
            details.setAttribute( 'open', '' )

            var summary = document.createElement( 'summary' )
            summary.className = 'table-collapsible-summary'
            summary.textContent = ( typeof blockId === 'string' && blockId.length > 0 ) ? label + ' — ' + blockId : label
            details.appendChild( summary )

            var table = document.createElement( 'table' )
            var thead = document.createElement( 'thead' )
            var headRow = document.createElement( 'tr' )
            columns.forEach( function( name ) {
                var th = document.createElement( 'th' )
                th.textContent = name
                headRow.appendChild( th )
            } )
            thead.appendChild( headRow )
            table.appendChild( thead )

            var tbody = document.createElement( 'tbody' )
            rows.forEach( function( row ) {
                var tr = document.createElement( 'tr' )
                row.forEach( function( cell ) {
                    var td = document.createElement( 'td' )
                    td.textContent = ( cell === null || cell === undefined ) ? '' : String( cell )
                    tr.appendChild( td )
                } )
                tbody.appendChild( tr )
            } )
            table.appendChild( tbody )
            details.appendChild( table )

            return details
        }


        // PRD-V8 (In-Scope 10, the seam to PRD-R3): does this chapter already carry its OWN Work-Items
        // heading, written by the generator into the revision? Walks the siblings after the chapter
        // heading up to the next H2 — bounded recursion, no loop (Memo standard).
        function chapterCarriesOwnWorkItems( heading ) {
            var scan = function( node ) {
                if( !node ) { return false }
                var level = headingLevel( node )
                if( level > 0 && level <= 2 ) { return false }
                if( level > 2 && ( node.textContent || '' ).trim().indexOf( 'Work-Items' ) === 0 ) { return true }

                return scan( node.nextElementSibling )
            }

            return scan( heading.nextElementSibling )
        }


        // PRD-V8 (US-3): the backlog after the last chapter — every work item that could NOT be placed,
        // with the reason, plus the count line that says how much was compared. The count line appears
        // ALWAYS, also with an empty backlog: it is the visible proof that a comparison happened. A
        // silently missing backlog would be exactly the loss this display is meant to prevent.
        function injectUnboundWorkItems( spec ) {
            var counts = spec.counts
            if( !counts ) { return 0 }
            if( contentEl.querySelector( '.block-store-unbound' ) ) { return 0 }

            var unbound = Array.isArray( spec.unbound ) ? spec.unbound : []
            var wrap = document.createElement( 'section' )
            wrap.className = 'block-store-unbound'

            if( unbound.length > 0 ) {
                var rows = unbound.map( function( item ) {
                    var reason = item.topicStatus ? item.reason + ' (' + item.topicStatus + ')' : item.reason

                    return [ item.id, item.topicId, item.title, item.status, formatProvenance( item.provenance ), item.group, reason ]
                } )
                wrap.appendChild( buildStoreTable( {
                    label: 'Work-Items ohne Block-Bindung (' + unbound.length + ')',
                    blockId: null,
                    columns: [ 'WI', 'Topic', 'Titel', 'Status', 'Herkunft', 'Gruppe', 'Grund' ],
                    rows: rows
                } ) )
            }

            var line = document.createElement( 'div' )
            line.className = 'block-store-count'
            line.textContent = counts.workItems + ' Work-Items · ' + counts.blocks + ' Blöcke · '
                + counts.workItemsInSections + ' im Block · ' + counts.workItemsUnbound + ' ohne Bindung'
            wrap.appendChild( line )

            contentEl.appendChild( wrap )

            return unbound.length
        }


        // PRD-V8: render a work item's provenance as "pfad:zeilen", several joined by " · ". An entry
        // without a line span shows the path alone; an entry without a path is dropped rather than
        // printed as a bare colon.
        function formatProvenance( provenance ) {
            if( !Array.isArray( provenance ) ) { return '' }

            return provenance
                .map( function( entry ) {
                    if( !entry || typeof entry.path !== 'string' || entry.path.length === 0 ) { return '' }
                    var lines = ( entry.lines === null || entry.lines === undefined ) ? '' : String( entry.lines )

                    return lines.length === 0 ? entry.path : entry.path + ':' + lines
                } )
                .filter( function( text ) { return text.length > 0 } )
                .join( ' · ' )
        }


        // Memo 079 M3=A (T059): open a served research MD as an ANNOTATABLE view. Fetches the raw markdown
        // from /api/research-page (memoDir-relative, path-traversal-guarded server side), renders it into
        // #content and sets currentResearchFile so the existing selection→anchor→POST pipeline emits
        // targetKind:'research' + researchFile. A back-link returns to the memo prose (re-render on click).
        function openResearchDoc( researchFile ) {
            if( !currentDocumentId || typeof researchFile !== 'string' || researchFile.length === 0 ) { return }

            var qs = '/api/research-page?documentId=' + encodeURIComponent( currentDocumentId )
                + '&file=' + encodeURIComponent( researchFile )

            fetch( qs )
                .then( function( res ) {
                    if( !res.ok ) { throw new Error( 'HTTP ' + res.status ) }
                    return res.json()
                } )
                .then( function( payload ) {
                    currentResearchFile = researchFile
                    slugCounts.clear()
                    var back = '<div class="research-view-bar"><button id="research-back" class="research-back-link">← zurück zum Memo</button>'
                        + '<span class="research-view-file">' + escapeHtml( researchFile ) + '</span></div>'
                    // PRD-V4 (Memo 080 Kap 16): same single prose render path; the research-view-bar
                    // stays in front of the rendered body unchanged.
                    contentEl.innerHTML = back + renderMarkdownWithFootnotes( ( payload && payload.content ) || '' ).html
                    wireFootnoteRefs( contentEl )
                    var backBtn = document.getElementById( 'research-back' )
                    if( backBtn ) {
                        backBtn.addEventListener( 'click', function() {
                            currentResearchFile = null
                            if( currentDocumentId && currentFileName ) { window.selectRevision( currentDocumentId, currentFileName ) }
                        } )
                    }
                    renderAllDiagrams()
                    refreshAnnotations()
                } )
                .catch( function() {
                    contentEl.innerHTML = '<p style="color:#f85149">Research-Dokument konnte nicht geladen werden: ' + escapeHtml( researchFile ) + '</p>'
                } )
        }


        // PRD-V6 (Memo 080 Kap 16, WI-177): client PRE-check for an overlay-openable research path. It is
        // a pre-check, NOT a replacement: MemoView.readResearchDoc stays the authoritative guard. Written
        // as a CLASS rule rather than a list of the three known bad cases:
        //   scheme    ANY uri scheme (http:, https:, file:, javascript:, data:, ...)  -> refused
        //   absolute  starts with '/' or '\'  (filesystem root, UNC)                  -> refused
        //   traversal ANY '..' SEGMENT, on either separator ('/' or '\')               -> refused
        // A segment test, not a substring test — a file honestly named `a..b.md` is not a traversal.
        function isResearchOverlayPath( researchFile ) {
            if( typeof researchFile !== 'string' ) { return false }
            var target = researchFile.trim()
            if( target.length === 0 ) { return false }
            if( /^[a-z][a-z0-9+.-]*:/i.test( target ) ) { return false }
            if( target.charAt( 0 ) === '/' || target.charAt( 0 ) === '\\' ) { return false }

            return target.split( /[\\/]/ ).indexOf( '..' ) === -1
        }


        // PRD-V6 (Memo 080 Kap 16, WI-177): open a research MD as an OVERLAY over the memo — the "tiefere
        // Ebene" from the user brief. Same route as openResearchDoc, but the result lands in
        // #research-modal-body, so #content (and with it the reading position) is never touched. The
        // overlay is the LOOK-UP level and is deliberately not annotatable; "Vollansicht" bridges to
        // openResearchDoc, which keeps the Memo 079 M3=A capability reachable.
        function openResearchOverlay( researchFile ) {
            if( !currentDocumentId ) { return }
            if( !isResearchOverlayPath( researchFile ) ) { return }

            var modal = document.getElementById( 'research-modal' )
            var body = document.getElementById( 'research-modal-body' )
            var titleEl = document.getElementById( 'research-modal-title' )
            if( !modal || !body ) { return }

            researchOverlayFile = researchFile
            if( titleEl ) { titleEl.textContent = researchFile }
            body.innerHTML = '<p class="research-overlay-loading">Wird geladen: ' + escapeHtml( researchFile ) + '</p>'
            modal.classList.remove( 't-hidden' )

            var qs = '/api/research-page?documentId=' + encodeURIComponent( currentDocumentId )
                + '&file=' + encodeURIComponent( researchFile )

            fetch( qs )
                .then( function( res ) {
                    if( !res.ok ) { throw new Error( 'HTTP ' + res.status ) }

                    return res.json()
                } )
                .then( function( payload ) {
                    body.innerHTML = marked.parse( ( payload && payload.content ) || '' )
                    // Diagrams are collected document-wide, so an embedded diagram in the overlay renders too.
                    renderAllDiagrams()
                } )
                .catch( function() {
                    // Loud, inside the overlay: no silent failure and no navigation away from the memo.
                    body.innerHTML = '<p class="research-overlay-error">Research-Dokument konnte nicht geladen werden: '
                        + escapeHtml( researchFile ) + '</p>'
                } )
        }


        function isResearchOverlayOpen() {
            var modal = document.getElementById( 'research-modal' )

            return !!( modal && !modal.classList.contains( 't-hidden' ) )
        }


        function closeResearchOverlay() {
            var modal = document.getElementById( 'research-modal' )
            var body = document.getElementById( 'research-modal-body' )
            researchOverlayFile = null
            if( body ) { body.innerHTML = '' }
            if( modal ) { modal.classList.add( 't-hidden' ) }
        }


        // Close wiring after the shared .t-modal convention: close button, backdrop click, Escape.
        var researchModalCloseBtn = document.getElementById( 'research-modal-close' )
        if( researchModalCloseBtn ) { researchModalCloseBtn.addEventListener( 'click', closeResearchOverlay ) }

        var researchModalEl = document.getElementById( 'research-modal' )
        if( researchModalEl ) {
            researchModalEl.addEventListener( 'click', function( ev ) {
                if( ev.target === researchModalEl ) { closeResearchOverlay() }
            } )
        }

        document.addEventListener( 'keydown', function( ev ) {
            if( ev.key === 'Escape' && isResearchOverlayOpen() ) { closeResearchOverlay() }
        } )

        // The bridge to the annotatable full view. The file is read BEFORE closing, because
        // closeResearchOverlay clears researchOverlayFile.
        var researchModalFullBtn = document.getElementById( 'research-modal-full' )
        if( researchModalFullBtn ) {
            researchModalFullBtn.addEventListener( 'click', function() {
                var file = researchOverlayFile
                closeResearchOverlay()
                if( file ) { openResearchDoc( file ) }
            } )
        }


        // PRD-018: order-stable de-dup for the cross-link lists (no Set spread — keeps the client
        // classic-script style consistent with the rest of this file). No while-loop.
        function uniqueList( arr ) {
            var seen = {}
            var out = []
            arr.forEach( function( x ) {
                var key = String( x )
                if( seen[ key ] === true ) { return }
                seen[ key ] = true
                out.push( x )
            } )

            return out
        }

        // PRD-015 (D6): the structured block-body section headings that follow a block-meta fence.
        // Mirrored here so the DOM can recognise an H3 that belongs to a block body (vs. a real prose
        // H3) without re-parsing the source.
        //
        // Memo 080, PRD-B1: this is no longer a hand-typed set of three. It is the label list of the
        // ONE register (BlockSections.labels(), heading + alias, lower-cased, register order), kept on
        // ONE line so the parity test can read it verbatim and hold it against the register and against
        // MemoView.isBlockBodyHeading. It used to carry the LEGACY alias "problem-beschreibung" while
        // the canonical name was already "faktenlage" — a drift that hid nothing here but would hide
        // content the moment the parser renamed a section (Beleg 2.7).
        var BLOCK_BODY_HEADINGS = [ 'user-auftrag', 'ist-zustand', 'soll-zustand', 'bewertung', 'abgrenzung', 'entscheidung', 'messung', 'beispiel', 'risiko', 'gegenargument', 'offene punkte', 'topics', 'work-items', 'abhaengigkeiten', 'prd-zuordnung', 'belege', 'faktenlage', 'problem-beschreibung', 'loesungsansatz', 'offene fragen' ]
        // The two suffix forms the register accepts (": " 25x and " (" 1x in REV-18). Same list, same
        // order as BlockSections SUFFIX_SEPARATORS — the parity test compares this line too, so the
        // browser cannot decide differently from the server mirror.
        var BLOCK_BODY_SUFFIXES = [ ': ', ' (' ]

        // Memo 081, WI-113 (REV-16:4110-4111): the six chapter sections that FOLD, mirrored from
        // BlockSections.chapterContract() — the entries whose `overview` is false, lower-cased, in
        // contract order. Kept on ONE line so the parity test can read it verbatim and hold it against
        // the register, exactly as BLOCK_BODY_HEADINGS above is held.
        //
        // THIS IS NOT BLOCK_BODY_HEADINGS AND MUST NOT BECOME IT. That list is the derived copy of the
        // whole VOCABULARY (20 labels) — it answers "is this an H3 the register knows?". This one
        // answers "does this section fold?". Measured, the two differ by thirteen: the vocabulary folds
        // `user-auftrag`, which the memo wants OPEN, plus twelve headings nobody asked to fold.
        var CHAPTER_FOLD_SECTIONS = [ 'ist-zustand', 'soll-zustand', 'belege', 'topics', 'work-items', 'abhaengigkeiten' ]

        // The display noun of each folding section, and the dimension its distribution is measured over.
        // `Abhaengigkeiten` counts EDGES rather than repeating its own heading (REV-16:4111 calls them
        // Kanten). `art` reads the Art column of the section table, `evidence` the evidence tags of the
        // section body; the other three carry no second dimension and say only how many.
        var CHAPTER_FIGURE_KINDS = {
            'ist-zustand': { noun: 'Befunde', dimension: 'evidence' },
            'soll-zustand': { noun: 'Aussagen', dimension: 'evidence' },
            'belege': { noun: 'Belege', dimension: 'art' },
            'topics': { noun: 'Topics', dimension: null },
            'work-items': { noun: 'Work-Items', dimension: null },
            'abhaengigkeiten': { noun: 'Kanten', dimension: null }
        }

        // The six values the `Art` column of a Belege table carries, measured over REV-16 (399 rows:
        // gemessen 214, gelesen 96, entschieden 53, beobachtet 17, Spezifikation 9, abgeleitet 3 — a sum
        // of 392, so SEVEN rows carry none of them). The list is closed on purpose: a seventh value is a
        // finding, and the remainder rule below is what makes it visible instead of swallowing it.
        var EVIDENCE_ART_VALUES = [ 'gemessen', 'gelesen', 'entschieden', 'beobachtet', 'Spezifikation', 'abgeleitet' ]

        // The five evidence tags. They are shown lower-cased because the upper case of `[GEMESSEN]` is
        // TAG SYNTAX, not spelling — the Art values above are shown exactly as the table writes them.
        var EVIDENCE_TAGS = [ 'GEMESSEN', 'FAKT', 'ABGELEITET', 'ANNAHME', 'VERMUTUNG' ]

        function isBlockBodyHeading( node ) {
            if( headingLevel( node ) !== 3 ) { return false }
            var label = ( node.textContent || '' ).trim().toLowerCase()
            return BLOCK_BODY_HEADINGS.some( function( heading ) {
                if( label === heading ) { return true }
                return BLOCK_BODY_SUFFIXES.some( function( separator ) {
                    return label.indexOf( heading + separator ) === 0
                } )
            } )
        }

        // Memo 081, WI-113 (REV-16:4127): the fold recogniser is PREFIX-BASED, not an equality test —
        // `### Soll-Zustand: {Aspekt}` must count as a Soll-Zustand. Measured over REV-16: 25 of the 60
        // Soll-Zustand sections carry a suffix, so an equality test would leave 41.7 % of them unfolded
        // and without a figure, and the reader would meet a half-folded document.
        //
        // The capability is NOT new: BLOCK_BODY_SUFFIXES and the shape of isBlockBodyHeading above
        // already do exactly this for the vocabulary. This reuses that shape against the FOLD list
        // instead of building a second recogniser beside it. Returns the matched contract label (the
        // key into CHAPTER_FIGURE_KINDS) or null.
        function chapterFoldLabel( node ) {
            if( headingLevel( node ) !== 3 ) { return null }
            var label = ( node.textContent || '' ).trim().toLowerCase()
            var hit = CHAPTER_FOLD_SECTIONS.filter( function( heading ) {
                if( label === heading ) { return true }
                return BLOCK_BODY_SUFFIXES.some( function( separator ) {
                    return label.indexOf( heading + separator ) === 0
                } )
            } )

            return hit.length > 0 ? hit[ 0 ] : null
        }

        // PRD-015 (D6) + Memo 081, WI-113 (REV-16:4126): walk each block-meta card's body region — from
        // the card to the next H2 or the next block-meta card (the SAME bounds as BlockMeta.#bodySections)
        // — and FOLD every one of the six chapter sections into a <details> whose <summary> is the
        // computed figure line. The region and the level-aware range are unchanged; what changed is the
        // mechanism.
        //
        // ONE COLLAPSE MECHANISM INSTEAD OF TWO HALVES. Measured before this change: tables collapse
        // through <details class="table-collapsible"> with a <summary>, sections collapsed through the
        // CSS class `block-body-hidden` — and a class has no line a figure could sit on. Worse, it could
        // not be REOPENED: `#content .block-body-hidden { display: none }` HIDES, it does not fold. What
        // was called "collapsed sections" was in truth "invisible sections".
        //
        // THE FIGURE LINE IS THE SUMMARY. That is the whole design: <details> gives the fold, <summary>
        // gives the line, the line says what is inside. Both rules stand side by side (REV-16:4124) —
        // the section is CLOSED by default, the table inside it stays <details open> (F10=A), so opening
        // a section shows an open table.
        //
        // THE FOLD STATE IS A READER SETTING, NOT A DOCUMENT STATE (REV-16:4125). Nothing is written
        // back into the revision and the markdown source is untouched — this pass runs over the rendered
        // DOM, where every other post-render pass runs.
        //
        // No while-loop (Memo-Standard) — the sibling chain is walked via recursion. The continuation
        // point is taken BEFORE the nodes move: once the heading and its body sit inside the <details>,
        // `heading.nextElementSibling` no longer points into the chapter.
        function foldBlockBodySections() {
            var cards = contentEl.querySelectorAll( '.block-meta-card' )
            cards.forEach( function( card ) {
                var step = function( node ) {
                    if( !node ) { return }
                    if( node.classList && node.classList.contains( 'block-meta-card' ) ) { return }
                    if( headingLevel( node ) === 2 ) { return }

                    var label = chapterFoldLabel( node )
                    // Idempotent: a heading already inside a fold frame is left alone, so a second pass
                    // over the same DOM produces no second <details> and no second figure line. Same
                    // guard wrapTablesCollapsible uses with closest( '.table-collapsible' ).
                    var folded = node.closest && node.closest( '.chapter-section' )
                    if( label === null || folded ) { step( node.nextElementSibling ); return }

                    var body = hiddenSiblingsAfter( node )
                    var resume = body.length > 0 ? body[ body.length - 1 ].nextElementSibling : node.nextElementSibling
                    foldOneSection( { heading: node, body, label } )
                    step( resume )
                }
                step( card.nextElementSibling )
            } )
        }

        // Move one section into its own <details>. The heading stays INSIDE the frame: it is the anchor
        // the table of contents and the identifier jumps address, and taking it out would break both.
        function foldOneSection( payload ) {
            var heading = payload[ 'heading' ]
            var body = payload[ 'body' ]
            var label = payload[ 'label' ]

            var details = document.createElement( 'details' )
            details.className = 'chapter-section'
            var summary = document.createElement( 'summary' )
            summary.className = 'chapter-section-summary'
            summary.textContent = chapterSectionFigure( { body, label } )

            heading.parentNode.insertBefore( details, heading )
            details.appendChild( summary )
            details.appendChild( heading )
            body.forEach( function( sibling ) { details.appendChild( sibling ) } )
        }

        // Memo 081, WI-113 (REV-16:4133-4135): the figure line is a RENDER RESULT, never an author's
        // duty. Nobody writes "399 Belege · 214 gemessen" into the revision; the renderer counts the
        // section's units and the values of its Art column or its evidence tags and assembles the line.
        // The reason is correctness, not convenience: a typed figure is a CLAIM ABOUT THE CONTENT from
        // the next edit onwards, and nobody maintains it. A computed figure cannot drift.
        //
        // TYPED FIGURES IN THE DOCUMENT ARE NOT READ. The revision carries author lines like
        // "> **9 Belege** — gemessen 5 · gelesen 4". They belong to the author, they stay in the body,
        // and they are never a source for this line — that is the entire point of computing it.
        //
        // THE VACUUM RULE APPLIES TO COUNTING TOO (REV-16:4135). A section with nothing to count states
        // "0 Belege"; it never drops the line. A MISSING figure line is a renderer defect, not an empty
        // section, and those two must never look alike.
        //
        // THE COUNTING UNIT IS NAMED RATHER THAN ASSUMED: a list item and a table data row both count as
        // one unit, because the corpus writes the same content in both forms — measured over REV-16, the
        // Belege sections are tables throughout while Ist-/Soll-Zustand are bullet lists, and a rule that
        // counted only one of the two would report 0 for 41 sections. A section carrying both counts both.
        function chapterSectionFigure( payload ) {
            var body = payload[ 'body' ]
            var label = payload[ 'label' ]
            var kind = CHAPTER_FIGURE_KINDS[ label ]
            var total = countSectionUnits( body )
            var parts = distributionOf( { body, dimension: kind[ 'dimension' ] } )
            var head = total + ' ' + kind[ 'noun' ]

            if( parts.length === 0 ) { return head }

            // AND THE DISTRIBUTION STATES ITS REMAINDER, in BOTH directions. Measured over REV-16: 399
            // evidence rows against a distribution summing to 392 — seven rows carry none of the six Art
            // values. A line that lists the six and stops would silently drop those seven. The same
            // statement `basis` makes for questionCounts and revisionCounts: a total that does not add
            // up says so. The upward case is named too, because an evidence tag can sit in a paragraph
            // that is not a counted unit, and "more marks than units" is a finding, not a rounding error.
            var counted = parts.reduce( function( sum, part ) { return sum + part[ 'count' ] }, 0 )
            var shown = parts.map( function( part ) { return part[ 'count' ] + ' ' + part[ 'value' ] } )
            var rest = counted < total ? [ ( total - counted ) + ' ohne Angabe' ] : []
            var over = counted > total ? [ ( counted - total ) + ' zusaetzlich ausgezeichnet' ] : []

            return [ head ].concat( shown ).concat( rest ).concat( over ).join( ' · ' )
        }

        // List items plus table DATA rows (tbody only — a header row is not a finding). Nodes are
        // counted through querySelectorAll on each body node, and the node itself is counted when it IS
        // one of the two, so a bare <li> sibling is not lost.
        function countSectionUnits( body ) {
            return body.reduce( function( sum, node ) {
                var items = node.querySelectorAll ? node.querySelectorAll( 'li' ).length : 0
                var rows = node.querySelectorAll ? node.querySelectorAll( 'tbody tr' ).length : 0
                var self = ( node.tagName === 'LI' ) ? 1 : 0

                return sum + items + rows + self
            }, 0 )
        }

        // The second dimension of the figure line. `art` reads the Art column of the section tables,
        // `evidence` the evidence tags of the section text. Values with a count of zero are dropped —
        // naming all six every time would bury the ones that actually occur — but the REMAINDER above
        // is computed against the TOTAL, so nothing silently disappears with them.
        function distributionOf( payload ) {
            var body = payload[ 'body' ]
            var dimension = payload[ 'dimension' ]

            if( dimension === 'art' ) {
                var rowValues = body.reduce( function( acc, node ) {
                    var rows = node.querySelectorAll ? Array.prototype.slice.call( node.querySelectorAll( 'tbody tr' ) ) : []

                    return acc.concat( rows.map( artValueOfRow ) )
                }, [] )

                return EVIDENCE_ART_VALUES
                    .map( function( value ) {
                        var count = rowValues.filter( function( found ) { return found === value } ).length

                        return { value, count }
                    } )
                    .filter( function( part ) { return part[ 'count' ] > 0 } )
            }

            if( dimension === 'evidence' ) {
                var text = body.reduce( function( acc, node ) { return acc + ' ' + ( node.textContent || '' ) }, '' )

                return EVIDENCE_TAGS
                    .map( function( tag ) {
                        var hits = text.match( new RegExp( '\\[' + tag + '\\]', 'g' ) ) || []

                        return { value: tag.toLowerCase(), count: hits.length }
                    } )
                    .filter( function( part ) { return part[ 'count' ] > 0 } )
            }

            return []
        }

        // The Art value of one table row, or null. A row DECLARES its Art in a cell that holds nothing
        // but that word — never anywhere in its prose. Measured, a Belege row reads
        // "| 38.4 | app.client.mjs:8116 | gemessen | … |", and the word `gemessen` also occurs inside
        // neighbouring prose cells; a substring test would count those rows twice and inflate the
        // distribution past the row count. Cell equality is the same rule the independent count over
        // the markdown uses, which is what makes the two comparable at all.
        function artValueOfRow( row ) {
            var cells = row.querySelectorAll ? Array.prototype.slice.call( row.querySelectorAll( 'td, th' ) ) : []
            var hit = cells
                .map( function( cell ) { return ( cell.textContent || '' ).trim().toLowerCase() } )
                .map( function( text ) {
                    var found = EVIDENCE_ART_VALUES.filter( function( value ) { return value.toLowerCase() === text } )

                    return found.length > 0 ? found[ 0 ] : null
                } )
                .filter( function( value ) { return value !== null } )

            return hit.length > 0 ? hit[ 0 ] : null
        }

        // PRD-006 (#C2): the heading level (1-4) of a DOM node, or 0 when it is not a heading.
        // Mirrors the level field MemoView.questionsSection reasons over.
        function headingLevel( node ) {
            if( !node || !node.tagName ) { return 0 }
            var m = /^H([1-6])$/.exec( node.tagName )
            return m ? Number( m[ 1 ] ) : 0
        }

        // PRD-001 (#16-18) + PRD-006 (#C4): collect all sibling nodes after a heading up to the
        // next heading of level <= the start heading's level (level-aware, NOT just an H2 stop).
        // For an H2 start this stops at the next H2 — the exact DocumentRegistry.#extractSection
        // rule, mirrored by MemoView.questionsSection.collapseRangeFrom. For an H3 start (a
        // chapter's own "### Offene Fragen") it stops at the next H2/H3, so that nested copy is
        // fully collapsed. No while-loop (Memo-Standard) — sibling chain walked via recursion.
        function hiddenSiblingsAfter( heading ) {
            var startLevel = headingLevel( heading )
            var collected = []
            var step = function( node ) {
                if( !node ) { return }
                var lvl = headingLevel( node )
                if( lvl > 0 && lvl <= startLevel ) { return }
                collected.push( node )
                step( node.nextElementSibling )
            }
            step( heading.nextElementSibling )
            return collected
        }

        // PRD-006 (#C2): an EXACT open/answered-questions section heading at H2 (the canonical
        // anchor). Mirrors MemoView.questionsSection anchorIndex — never an H3/H4 copy.
        function isExactSectionH2( node ) {
            if( headingLevel( node ) !== 2 ) { return false }
            var label = ( node.textContent || '' ).toLowerCase()
            return /offene\s+fragen/.test( label ) || /beantwortete\s+fragen/.test( label )
        }

        // PRD-001 (#16-18) + PRD-006 (#C1/#C9): hide the raw "Offene Fragen" / "Beantwortete
        // Fragen" markdown bodies once the interactive widgets render — heading stays as anchor.
        // Now scans h2,h3,h4 (was h2-only) so a chapter's OWN "### Offene Fragen" H3 copy is
        // collapsed too (C1) instead of surviving as a second visible questions block. The
        // level-aware hiddenSiblingsAfter keeps each collapse scoped to its own section. Freetext
        // mentions like "(F9)" are not headings, so they stay prose (C9).
        function hideRawQuestionBodies() {
            var headings = contentEl.querySelectorAll( 'h2, h3, h4' )
            headings.forEach( function( h ) {
                var label = ( h.textContent || '' ).toLowerCase()
                var isQuestionSection = /offene\s+fragen/.test( label )
                    || /beantwortete\s+fragen/.test( label )
                if( !isQuestionSection ) { return }

                // The heading node itself is also collapsed for the nested H3/H4 copies so no
                // duplicate "Offene Fragen" title remains; the canonical H2 anchor is restored
                // below (the H2 keeps its body collapsed but the heading stays as the anchor).
                if( headingLevel( h ) > 2 ) {
                    h.classList.add( 'raw-question-hidden' )
                }
                hiddenSiblingsAfter( h ).forEach( function( node ) {
                    node.classList.add( 'raw-question-hidden' )
                } )
            } )
        }

        // PRD-002 (#12/#15): Caps-Section-Labels for the main content sections.
        function applySectionLabels() {
            // Order per comment above: Metatags -> Kontext -> Topics -> interaktiver Bereich.
            var labelMap = [
                { match: /metatags/i, label: 'METATAGS' },
                { match: /kontext/i, label: 'KONTEXT' },
                { match: /topics?/i, label: 'TOPICS' }
            ]

            var headings = contentEl.querySelectorAll( 'h2' )
            headings.forEach( function( h ) {
                var text = h.textContent || ''
                var hit = labelMap.find( function( entry ) { return entry.match.test( text ) } )
                if( hit && !h.hasAttribute( 'data-caps' ) ) {
                    h.classList.add( 'section-caps-host' )
                    h.setAttribute( 'data-caps', hit.label )
                }
            } )

            // INTERAKTIVER BEREICH label (#15) — above Vorwort / Offene-Fragen anchor.
            var fragen = document.getElementById( 'offene-fragen' )
            if( fragen && !document.getElementById( 'interaktiv-label' ) ) {
                var lbl = document.createElement( 'div' )
                lbl.id = 'interaktiv-label'
                lbl.className = 'section-caps-label'
                lbl.textContent = 'INTERAKTIVER BEREICH'
                // Vorwort now lives at the TOP of the document, so the INTERAKTIVER BEREICH
                // label anchors on the Offene-Fragen heading only (was: vorwort || fragen).
                var anchorNode = fragen
                anchorNode.parentNode.insertBefore( lbl, anchorNode )
            }
        }

        // PRD-002 (#13): render TOPICS list as a numbered chip strip.
        function applyTopicChips() {
            var headings = contentEl.querySelectorAll( 'h2, h3' )
            var topicsHeading = null
            headings.forEach( function( h ) {
                if( topicsHeading ) { return }
                if( /topics?/i.test( h.textContent || '' ) ) { topicsHeading = h }
            } )
            if( !topicsHeading ) { return }

            var list = topicsHeading.nextElementSibling
            if( !list || ( list.tagName !== 'UL' && list.tagName !== 'OL' ) ) { return }

            var chips = document.createElement( 'div' )
            chips.className = 'topic-chips'
            var items = Array.from( list.querySelectorAll( ':scope > li' ) )
            items.forEach( function( li, idx ) {
                var chip = document.createElement( 'span' )
                chip.className = 'topic-chip'
                chip.textContent = ( idx + 1 ) + ' ' + li.textContent.trim()
                chips.appendChild( chip )
            } )
            list.parentNode.replaceChild( chips, list )
        }

        // PRD-002 (#14): render the Metatags table as a chip strip.
        function applyMetatagChips() {
            var headings = contentEl.querySelectorAll( 'h2, h3' )
            var metaHeading = null
            headings.forEach( function( h ) {
                if( metaHeading ) { return }
                if( /metatags/i.test( h.textContent || '' ) ) { metaHeading = h }
            } )
            if( !metaHeading ) { return }

            var table = metaHeading.nextElementSibling
            if( !table || table.tagName !== 'TABLE' ) { return }

            var chips = document.createElement( 'div' )
            chips.className = 'meta-chips'
            var rows = Array.from( table.querySelectorAll( 'tbody tr' ) )
            rows.forEach( function( row ) {
                var cells = Array.from( row.querySelectorAll( 'td' ) )
                if( cells.length === 0 ) { return }
                var label = cells
                    .map( function( c ) { return c.textContent.trim() } )
                    .join( ': ' )
                var chip = document.createElement( 'span' )
                chip.className = 'meta-chip'
                chip.textContent = label
                chips.appendChild( chip )
            } )
            table.parentNode.replaceChild( chips, table )
        }

        // PRD-014 (Kap 19): fill the persisted Vorwort into the section that
        // applyContentStructure() inserts directly above the "Offene Fragen" anchor.
        // Single-Channel: the Vorwort lives here (not only in the terminal). It may raise
        // new decision questions, but those become F-Eintraege in the memo, not terminal-only.
        function renderVorwort( vorwort ) {
            var section = document.getElementById( 'vorwort' )
            if( !section ) { return }

            var text = String( vorwort || '' ).trim()

            if( text.length === 0 ) {
                section.innerHTML = ''
                section.classList.add( 'vorwort-empty' )
                return
            }

            section.classList.remove( 'vorwort-empty' )
            section.innerHTML = '<div class="vorwort-body">' + marked.parse( text ) + '</div>'
        }

        // PRD-Q3 (Memo 080, Kap 25): the non-blocking hint band of the SHARED validator.
        //
        // The channel has been carrying this for a long time — the server attaches `validation` to
        // every content message (four send sites) — but no client code ever read it, so the INFO
        // family only ever showed up in `memo lint`. This function is that missing receiver.
        //
        // Three states that must NEVER look alike:
        //   info: [ ... ]  -> the hints, one line each, WITH their number
        //   info: []       -> an invisible band (pattern vorwort-empty), NOT a green "all good"
        //   validation null-> the stated gap "Pruefung nicht verfuegbar", NOT an empty band
        // Nothing here blocks or gates: `struct.status` is computed from `messages`, and an INFO
        // code never lands in `messages` (MemoValidator #route) — the band is a hint, never a verdict.
        //
        // Degrades silently by contract: a hint must never be able to break the document render.
        function renderFormHints( validation ) {
            try {
                var section = document.getElementById( 'form-hints' )
                if( !section ) { return }

                // Nothing broadcast yet — there is nothing to say, so the band stays invisible.
                if( validation === undefined ) {
                    section.innerHTML = ''
                    section.classList.add( 'form-hints-empty' )
                    return
                }

                // Defensive server fallback: the validator could not run at all. "Not checked" and
                // "nothing to complain about" are different statements and get different displays.
                if( validation === null || typeof validation !== 'object' ) {
                    section.classList.remove( 'form-hints-empty' )
                    section.innerHTML = '<div class="form-hints-band form-hints-luecke">'
                        + '<div class="form-hints-head">Form-Hinweise: Pruefung nicht verfuegbar</div>'
                        + '<div class="form-hints-note">Kein Hinweis-Bestand — das ist eine Luecke, keine Freigabe.</div>'
                        + '</div>'
                    return
                }

                var info = Array.isArray( validation.info ) ? validation.info : []

                if( info.length === 0 ) {
                    section.innerHTML = ''
                    section.classList.add( 'form-hints-empty' )
                    return
                }

                var items = info
                    .map( function( entry ) { return '<li class="form-hints-item">' + escHtml( entry ) + '</li>' } )
                    .join( '' )

                section.classList.remove( 'form-hints-empty' )
                section.innerHTML = '<div class="form-hints-band form-hints-info">'
                    + '<div class="form-hints-head">Form-Hinweise: ' + info.length + ' (nicht blockierend)</div>'
                    + '<ul class="form-hints-list">' + items + '</ul>'
                    + '</div>'
            } catch( err ) {
                // Silent degradation: the document render must never fail because of a hint.
            }
        }

        // PRD-013 (Kap 15): interactive question-widget state.
        // questionNav drives the Claude-Code-style carousel keyboard navigation.
        // PRD-006 (Kap 9): fertig carries the explicit "abgeschlossen"-state (AC-05);
        // footerFocus tracks Tab-cycling through the footer buttons (AC-06).
        // PRD-001 (Memo 024 Kap 1): engaged distinguishes the freshly rendered state (active=0
        // but the user has not navigated yet) from an active carousel. The FIRST Shift+Down must
        // land on the FIRST question (data-qidx=0), not the second — so it only engages without
        // applying the delta. Every later Shift+Up/Down then steps normally.
        var questionNav = { active: -1, optionFocus: -1, lane: 'option', questions: [], state: [], fertig: false, footerFocus: -1, engaged: false }

        // Memo 081 WI-118: the working state that came back from the server, plus the document+revision
        // pair it belongs to. `key` is what makes the load happen ONCE per pair — a second broadcast of
        // the same pair must not re-fetch, or a late answer would overwrite a fresh selection. The
        // entries are the raw stored records; stateFromStoredRecord maps them, nothing else reads them.
        var questionStateStored = { key: null, entries: {}, seen: 0, skipped: 0 }
        var questionStateSaveTimer = null

        // Memo 080 (Kap 18, PRD-F2): THE RE-FORMULATION KINDS AND THEIR FREE-TEXT ROWS. `reframe` says the
        // QUESTION is wrong (Memo 059), `reoption` says the ANSWER OPTIONS go past the decision — the case
        // the user named as the recurring one. Two turns, two prompts, ONE mechanism: the row build, the
        // reveal-on-selection, the harvest-before-submit and the answer join all read this list. Hanging a
        // second `if` beside the first is exactly how the four places drift apart, and a harvest that knows
        // one row while the reveal knows two silently drops what the user typed.
        var REFORMULATION_KINDS = [
            { kind: 'reframe', attribute: 'data-reframe-row', placeholder: 'Wie sollte die Frage richtig lauten?' },
            { kind: 'reoption', attribute: 'data-reoption-row', placeholder: 'Was stimmt an den Antwortmoeglichkeiten nicht?' }
        ]

        // Which re-formulation kinds a question really offers, in the order the option list carries them.
        function reformulationRowsOf( optionList ) {
            var list = optionList || []

            return REFORMULATION_KINDS
                .map( function( entry ) {
                    var idx = list.findIndex( function( o ) { return o && o.kind === entry.kind } )

                    return { kind: entry.kind, attribute: entry.attribute, placeholder: entry.placeholder, idx: idx }
                } )
                .filter( function( entry ) { return entry.idx !== -1 } )
        }

        function escHtml( str ) {
            return String( str || '' )
                .replace( /&/g, '&amp;' )
                .replace( /</g, '&lt;' )
                .replace( />/g, '&gt;' )
                .replace( /"/g, '&quot;' )
        }

        // PRD-013 #8: consume the schema from PRD-012 directly — no client-side parsing.
        function renderQuestionWidgets( schema ) {
            var container = document.getElementById( 'question-widgets' )
            if( !container ) {
                container = document.createElement( 'div' )
                container.id = 'question-widgets'
            }
            container.innerHTML = ''

            // Only OPEN questions get an interactive widget. PRD-F1 (Memo 080, Kap 18): the filter reads
            // `status`, not `!answered` — a question retired as irrelevant/ersetzt is not answered either,
            // so the old test handed it a widget and it kept collecting answers nobody would ever read.
            // `status` is set on BOTH parse paths (json fence and markdown blocks), so this is one axis.
            // Memo 081 (WI-064, Ä7): the filter moved into openQuestionsOf so the Zone-2 header and the
            // popup label count the SAME stock this renders, by construction rather than by agreement.
            var open = openQuestionsOf( schema )

            // Anchor the widgets directly under the "Offene Fragen" section (Phase 4),
            // or at the end of the content if that anchor is missing.
            var anchor = document.getElementById( 'offene-fragen' )
            if( anchor && anchor.parentNode ) {
                anchor.parentNode.insertBefore( container, anchor.nextSibling )
            } else {
                contentEl.appendChild( container )
            }

            // Memo 079 PRD-24: merge prior answer state by question id instead of a hard reset, so a WS
            // content-broadcast (parallel REV write) no longer wipes unsaved selections/custom entries.
            var prevById = {}
            ;( questionNav.questions || [] ).forEach( function( pq, pIdx ) {
                if( pq && pq.id ) { prevById[ pq.id ] = questionNav.state[ pIdx ] }
            } )
            // Memo 081 WI-118: the STORED working state fills the SAME map, right before it is read — no
            // second merge branch. Everything the map already guarantees therefore holds for a restored
            // state too: keyed by q.id (not by position), and dropped whole by the validity latch in
            // seedQuestionState when its selection index outruns today's option list.
            //
            // WHO WINS. A live entry the user has WORKED ON (touched, or already confirmed) beats the
            // stored one — otherwise a broadcast arriving mid-typing would replace the fresh selection
            // with an older saved one, which is Memo 079 PRD-24's defect in new clothes. An UNTOUCHED
            // live entry is not the user's work, it is the AI preselection the seed just built, and it
            // yields. That distinction is not a softening of the rule but the only way it can hold at
            // all: the load is async, so the restore ALWAYS arrives at a second render that already
            // found a freshly seeded entry under every question id. "Any live entry wins" would make
            // the restore a no-op by construction.
            fillPrevFromStoredQuestionState( prevById, questionStateStored.entries )
            questionNav.questions = open
            questionNav.state = seedQuestionState( open, prevById )
            questionNav.active = open.length > 0 ? 0 : -1
            questionNav.optionFocus = -1
            questionNav.lane = 'option'
            // PRD-001 (Memo 024 Kap 1): a freshly rendered widget set is not engaged yet — the
            // first Shift+Down/Up engages the already-active first question instead of skipping it.
            questionNav.engaged = false
            // PRD-006 (Kap 9): a freshly rendered widget is always in the open editing state.
            questionNav.fertig = false
            questionNav.footerFocus = -1

            // PRD-004 (Memo 019, Kap 4) — the 100%-Regel render gate. A question becomes an
            // interactive widget ONLY when it parsed 100% cleanly (isQuestionCleanParse). A
            // question that is not clean falls back to a readable markdown/text rendering at
            // the same anchor position — NEVER a half-filled qw-card. The decision is taken
            // per question, so mixed cases (some clean, some not) render correctly side by side.
            var fallbackCount = 0
            open.forEach( function( q, qIdx ) {
                if( isQuestionCleanParse( q ) ) {
                    container.appendChild( buildQuestionCard( q, qIdx ) )
                } else {
                    fallbackCount = fallbackCount + 1
                    container.appendChild( buildQuestionFallback( q ) )
                }
            } )

            // PRD-001 (Memo 024 Kap 1): Count == Parse. When the counter promises N questions but
            // some of them could not be rendered as interactive widgets, show a single VISIBLE
            // banner at the top of the widget area — never a silent difference between counter and
            // rendered widgets. Each affected question additionally carries its own inline warning.
            if( fallbackCount > 0 ) {
                var banner = document.createElement( 'div' )
                banner.className = 'qw-parse-warn'
                banner.id = 'qw-parse-warn'
                banner.textContent = '⚠ ' + fallbackCount + ' von ' + open.length
                    + ' Fragen konnten nicht als Widget geparst werden — sie werden als Rohtext angezeigt.'
                container.insertBefore( banner, container.firstChild )
            }

            // Memo 081 (WI-064/WI-069, S3 + Ä8): the SECOND axis at the same place. The banner above covers
            // parse ("the counter promised N, only N-k could be rendered"); this one covers SOURCE ("the memo
            // list says N, this revision renders M"). Both are legitimate figures answering different
            // questions — per memo against per revision — and the memo asks that the difference be stated,
            // not resolved. The container also carries the rendered count on a stable hook so a later
            // end-to-end check can compare cards and number in one read instead of counting cards.
            var registryEntry = lookupMemoEntryById( currentDocumentId )
            var registry = normalizeQuestions( registryEntry ? registryEntry.doc.questions : null )
            container.setAttribute( 'data-qw-rendered', String( open.length ) )
            container.setAttribute( 'data-qw-source', registry.comparison.source )
            container.setAttribute( 'data-qw-registry-open', registry.basis ? String( registry.open ) : '' )

            if( registry.basis === true && registry.open !== open.length ) {
                var divergence = document.createElement( 'div' )
                divergence.className = 'qw-parse-warn'
                divergence.id = 'qw-source-warn'
                divergence.setAttribute( 'data-qw-divergence', '1' )
                divergence.textContent = '⚠ Zwei Mengen: die Memo-Übersicht zählt ' + registry.open
                    + ' offene Fragen (' + questionCountTitle( registry ) + '), diese Revision rendert '
                    + open.length + ' Karten. Beide Zahlen stehen hier, damit die Differenz sichtbar ist.'
                container.insertBefore( divergence, container.firstChild )
            }

            // PRD-012 (Memo 076 H8, WI-106): the answers-only bar + mountAnswersOnlyBarInHeader are
            // removed (dead path; the popup's "Übernehmen" persists transcript + answers).
            updateSaveAnswersOnlyState()
            renderQuestionFocus()
        }

        // Build the per-question widget state for a freshly rendered question set.
        //
        // Memo 079 PRD-24: a prior state (by question id) is CARRIED OVER instead of hard-reset, so a WS
        // content broadcast no longer wipes unsaved selections. PRD-F3 (Memo 080 Kap 18, S1) adds the
        // `touched` marker, and it is the reason this map is its own function: the marker is the datum
        // that separates "the widget shows the AI preselection" from "the user decided", so it has to be
        // testable on its own rather than only through a DOM render.
        //
        // THE PRESELECTION SEEDS THE DISPLAY AND IS NOT A DECISION. A freshly built state is `touched:
        // false` even when it already shows a selected option — only markQuestionTouched sets the marker,
        // and only a real interaction calls it. A carried-over state keeps its marker (a broadcast must
        // not turn a real choice back into a preselection); a state object from before the field existed
        // normalises to false, because an absent marker is "not touched", never an assumed touch.
        function seedQuestionState( open, prevById ) {
            var previous = prevById || {}

            return ( open || [] ).map( function( q ) {
                // single = first preselected index; multi = full preselected set.
                var pre = Array.isArray( q.preselected ) ? q.preselected.slice() : []
                var selected = q.typ === 'single' ? ( pre.length > 0 ? [ pre[ 0 ] ] : [] ) : pre
                var prev = q.id ? previous[ q.id ] : null
                var optCount = ( q.options || [] ).length
                if( prev && prev.selected.every( function( i ) { return i < optCount } ) ) {
                    prev.touched = prev.touched === true

                    return prev
                }

                // PRD-026 (Kap 12.1): added/addedText hold the machine-injected, confirmed answer for
                // this question (no popup, no extra storage). The button state is bound to st.added so
                // the visible "hinzugefügt" quittance stays consistent.
                // PRD-006 (Kap 9): rejected drives the reversible "Ablehnen" toggle — purely a UI state,
                // the question data + selection always survive.
                return { selected: selected, custom: [], added: false, addedText: null, rejected: false, touched: false }
            } )
        }

        // PRD-028 (Kap 12.3): assemble the injected, confirmed answers (state.addedText) into
        // a single answers-only content block. Returns empty when nothing was added.
        //
        // PRD-22 (Memo 081 Kap 19, WI-130): IT REPORTS ITS COMPARISON BASIS. `count` says how many
        // blocks were TAKEN and nothing said how many states were CHECKED — so no caller could tell
        // "nothing was there" from "something was left out", and a selection the user forgot to
        // confirm vanished without a word. A check without a declared comparison set is not green,
        // it is blind. Same rule the answer-block merge below already follows.
        //
        // THE HARVEST FILTER IS UNTOUCHED (WI-109): an unconfirmed selection still does NOT reach
        // `content`. This function NAMES it, it does not harvest it — an intent is displayed, never
        // recorded as a decision (REV-16 :1748). `skipped` therefore uses exactly the predicate the
        // amber placeholder uses, so field and edge speak about the same thing.
        //
        // `present` vs `compared`: how many state entries exist at all versus how many were actually
        // readable. They differ only when the state carries holes — and that difference is what lets
        // the caller report an empty comparison set instead of silently reporting nothing to say.
        //
        // isConfirmedAnswer is the harvest predicate, written ONCE. It stood twice (here and in
        // appendAddedAnswers) with identical text; the second copy is gone. Naming it also keeps the
        // "how many places may harvest" count honest — a substring buried in a lambda cannot be
        // counted, a named predicate can.
        function isConfirmedAnswer( st ) {
            return !!( st && st.added === true && st.addedText )
        }

        // Memo 081 WI-118: map ONE stored record onto the widget state shape seedQuestionState produces.
        // Its own named function so it can be lifted out and tested directly (extractFunction.mjs), and
        // because this is where the whole WI-109 guarantee is cashed in:
        //
        // A record without a `confirmed` part carries NO answer text ANYWHERE — the intent half has no
        // field that could hold one. So `addedText` is null not because this function chose to be
        // careful but because there is nothing to take it from, and the restored state then fails the
        // very same isConfirmedAnswer above that an unconfirmed selection fails today. The separation is
        // not a rule to obey, it is a sentence that cannot be formed.
        //
        // Returns null for a shape it does not recognise — never a half-filled state.
        function stateFromStoredRecord( record ) {
            if( !record || typeof record !== 'object' ) { return null }
            var intent = record.intent
            if( !intent || typeof intent !== 'object' || !Array.isArray( intent.selected ) ) { return null }
            var confirmed = record.confirmed
            var answerText = ( confirmed && typeof confirmed.answerText === 'string' && confirmed.answerText.length > 0 )
                ? confirmed.answerText
                : null

            return {
                selected: intent.selected.slice(),
                custom: Array.isArray( intent.custom ) ? intent.custom.slice() : [],
                added: answerText !== null,
                addedText: answerText,
                rejected: intent.rejected === true,
                touched: intent.touched === true
            }
        }

        // Memo 081 WI-118: fill the merge map from the stored state for every question id whose LIVE
        // entry is not the user's own work (see the caller for why untouched yields). Mutates the map it
        // is handed — the same map seedQuestionState then reads, so there is exactly one merge path.
        // Both operands are PARAMETERS, not module state: that is what makes the precedence rule
        // testable on its own instead of only through a render.
        function fillPrevFromStoredQuestionState( prevById, stored ) {
            var records = stored || {}

            Object.keys( records ).forEach( function( id ) {
                var live = prevById[ id ]
                var isOwnWork = !!( live && ( live.touched === true || live.added === true || live.rejected === true ) )
                if( isOwnWork ) { return }
                var restored = stateFromStoredRecord( records[ id ] )
                if( restored ) { prevById[ id ] = restored }
            } )
        }

        function collectAddedAnswers() {
            var entries = questionNav.state || []
            var examined = entries.filter( function( st ) { return !!st } )
            var blocks = examined
                .filter( isConfirmedAnswer )
                .map( function( st ) { return st.addedText } )

            var skipped = entries
                .map( function( st, idx ) { return { st: st, idx: idx } } )
                .filter( function( entry ) { return !!entry.st } )
                .filter( function( entry ) { return !isConfirmedAnswer( entry.st ) } )
                .filter( function( entry ) {
                    return ( entry.st.selected || [] ).length > 0 || ( entry.st.custom || [] ).length > 0
                } )
                .map( function( entry ) {
                    // The state carries no question id (seedQuestionState), so the name comes from the
                    // index-parallel questions array. A missing question falls back to the 1-based
                    // position — NEVER to an invented id.
                    var q = ( questionNav.questions || [] )[ entry.idx ]

                    return {
                        id: ( q && q.id ) ? q.id : ( 'Frage ' + ( entry.idx + 1 ) ),
                        title: ( q && q.title ) ? q.title : '',
                        intent: q ? buildAnswerText( q, entry.st ).answerLine : ''
                    }
                } )

            return {
                count: blocks.length,
                content: blocks.join( '\n' ),
                compared: examined.length,
                present: entries.length,
                skipped: skipped,
                blocks: blocks
            }
        }

        // PRD-006 (Kap 9, AC-03): append the collected answer blocks to a transcript content
        // string, avoiding duplicates if the user re-saves (a block already present is not
        // appended again). Idempotent so re-saving never multiplies the answers section.
        function appendAddedAnswers( content ) {
            var base = String( content || '' )
            var collected = collectAddedAnswers()
            if( collected.count === 0 ) { return base }

            // PRD-22 (Memo 081 Kap 19, WI-130): the SAME predicate stood here a second time and
            // walked questionNav.state again. Two copies of one condition are exactly where a later
            // change touches one and drifts them apart — so this reads the blocks the collector
            // already measured. One filter site, one truth. The idempotency rule is unchanged.
            var missing = collected.blocks
                .filter( function( block ) { return base.indexOf( block.trim() ) === -1 } )

            if( missing.length === 0 ) { return base }

            var sep = base.trim().length > 0 ? '\n\n' : ''

            return base + sep + missing.join( '\n' )
        }

        // PRD-22 (Memo 081 Kap 19, WI-130): the loud edge before sending — ONE producer for both
        // export paths, so the two cannot drift into two different wordings of the same fact.
        //
        // IT ONLY REPORTS. Nothing here changes what is exported: the unconfirmed selection stays out
        // of the content (WI-109). "Angezeigt, nicht geerntet" (REV-16 :1748) is the whole point, and
        // :1750 picks the display level with an action hint — not a modal that holds up the save.
        //
        // THE TEXT ALWAYS NAMES BOTH NUMBERS ("2 von 7"). A message that says how many were dropped
        // but not how many were checked repeats, in the fix, the exact blindness being fixed.
        //
        // NOTHING FOUND IS NOT AUTOMATICALLY GREEN: a state that carries entries of which none was
        // readable has an EMPTY comparison set, and that is reported rather than passed over in
        // silence — the same distinction mergeAnswerBlocks draws between markers and compared. No
        // questions at all is a legitimate null case and stays quiet.
        function unconfirmedNotice() {
            var collected = collectAddedAnswers()

            if( collected.compared === 0 ) {
                if( collected.present === 0 ) { return { count: 0, compared: 0, text: '' } }

                return {
                    count: 0,
                    compared: 0,
                    text: 'Antwort-Prüfung ohne Vergleichsgrundlage: 0 von ' + collected.present
                        + ' Fragen konnten gelesen werden — es lässt sich nicht sagen, ob etwas fehlt.'
                }
            }

            if( collected.skipped.length === 0 ) { return { count: 0, compared: collected.compared, text: '' } }

            var names = collected.skipped
                .map( function( entry ) { return entry.id } )
                .join( ', ' )
            // Same wording as the placeholder above, so the field and the edge do not give the user
            // two different instructions for one action.
            var text = 'Nicht übernommen: ' + collected.skipped.length + ' von ' + collected.compared
                + ' Fragen sind ausgewählt, aber nicht bestätigt (' + names + ').'
                + '\nSie werden NICHT gespeichert — im Widget auf "Hinzufügen" klicken, sonst geht die Auswahl verloren.'

            return { count: collected.skipped.length, compared: collected.compared, text: text }
        }

        // PRD-22 (Memo 081 Kap 19, WI-130): render the notice into a field. Its own field, never the
        // error channel — an omitted intent is not an error, and the error box is cleared on every
        // save attempt. Missing field is not an error either (the popup path runs vm-isolated).
        function renderUnconfirmedNotice( fieldId, notice ) {
            var box = document.getElementById( fieldId )
            if( !box ) { return }

            box.textContent = notice.text
            if( notice.text.length > 0 ) { box.classList.remove( 't-hidden' ) }
            else { box.classList.add( 't-hidden' ) }
        }

        // PRD-012 (Memo 076 H8, WI-106): the answers-only bar ("ohne Transcript speichern" + "Fertig")
        // dead path is removed — buildAnswersOnlyBar had no caller, mountAnswersOnlyBarInHeader only
        // stripped a bar that was never built, and saveAnswersOnly/markQuestionsFertig were only
        // reachable through buildAnswersOnlyBar. The "Prompt bearbeiten" popup's "Übernehmen"
        // (applyPromptEdit) already persists both the transcript and the answers, so this whole path
        // was superseded. updateSaveAnswersOnlyState is retained (still called from live handlers and
        // self-guards on the now-absent button).

        // PRD-028: the button only makes sense when at least one answer was injected and the
        // user has NOT entered real transcript text (then the normal "Speichern" is the path).
        function updateSaveAnswersOnlyState() {
            var btn = document.getElementById( 'qw-save-answers-only' )
            if( !btn ) { return }

            var collected = collectAddedAnswers()
            var contentArea = document.getElementById( 't-content' )
            var hasRealTranscript = !!( contentArea && contentArea.value && contentArea.value.trim().length > 0 )

            btn.disabled = collected.count === 0 || hasRealTranscript
            if( btn.disabled ) {
                btn.title = collected.count === 0
                    ? 'Erst mindestens eine Antwort hinzufügen'
                    : 'Es liegt bereits ein echter Transcript-Text vor — normal speichern'
            } else {
                btn.title = ''
            }
        }

        // PRD-012 (Memo 076 H8, WI-106): saveAnswersOnly removed with the dead answers-only bar (its
        // only caller was buildAnswersOnlyBar). The popup's "Übernehmen" (applyPromptEdit) is the path.

        // PRD-004 (Memo 019, Kap 4) — the clean-parse criterion (100%-Regel). A question is
        // Widget-faehig ONLY when ALL of these hold. The criterion is deliberately identical
        // to the validator's question checks (MemoValidator MEMO-020a/b/c/d, MEMO-030) so the
        // render-gate (View) and the reject-gate (PRD-005) share one truth:
        //   - id present + non-empty (form F{N}),
        //   - frage present + non-empty,
        //   - aiRecommendation present + non-empty,
        //   - >= 2 real options (kind 'option') with distinct, non-empty key AND non-empty label,
        //   - the aiRecommendation references an existing option key (single: exactly one such key).
        // Memo 041 Teil B (Kap 10): this function is the browser MIRROR of QuestionContract.isRenderable
        // (src/QuestionContract.mjs) — the ONE render contract, shared with MemoValidator. This client
        // script is inlined into the page (not an importable module), so the logic is hand-kept in
        // lock-step; tests/unit/QuestionContract.test.mjs asserts the two return identical verdicts so
        // they can never drift again (the split-brain Memo 041 fixes).
        function isQuestionCleanParse( q ) {
            if( !q || typeof q !== 'object' ) { return false }

            var id = typeof q.id === 'string' ? q.id.trim() : ''
            if( !/^F\d+$/.test( id ) ) { return false }

            var frage = typeof q.frage === 'string' ? q.frage.trim() : ''
            if( frage.length === 0 ) { return false }

            var aiRecommendation = typeof q.aiRecommendation === 'string' ? q.aiRecommendation.trim() : ''
            // PRD-003 (Memo 022, Kap 4, F9=A): a checklist / multi-select question derives its
            // options from "- [ ] ..." items and has no A/B/C letter recommendation. For the
            // multi case the AI-Empfehlung is therefore NOT mandatory — only single-select keeps
            // the strict "non-empty recommendation that references exactly one key" contract.
            var isMulti = q.typ === 'multi'
            if( !isMulti && aiRecommendation.length === 0 ) { return false }

            var realOptions = ( Array.isArray( q.options ) ? q.options : [] )
                .filter( function( o ) { return o && typeof o === 'object' && o.kind === 'option' } )
                .filter( function( o ) {
                    return typeof o.key === 'string' && o.key.trim().length > 0
                        && typeof o.label === 'string' && o.label.trim().length > 0
                } )

            var optionKeys = realOptions.map( function( o ) { return o.key.trim() } )
            var distinctKeys = optionKeys.filter( function( key, idx ) { return optionKeys.indexOf( key ) === idx } )
            if( distinctKeys.length < 2 ) { return false }

            // Memo 045 (Kap 16): a single-select is renderable on STRUCTURE alone. The old gate
            // re-scraped the recommendation prose with /\b([A-H])\b/g and required "exactly one
            // referenced key" — that rejected a prose-only recommendation and mis-read the "B" in the
            // German "z. B." as a phantom second key. Preselection is advisory (the renderer reads the
            // structured `preselected`), so the prose scan is gone. Keep this mirror in lock-step with
            // QuestionContract.isRenderable (tests/unit/QuestionContract.test.mjs is the drift guard).
            return true
        }

        // PRD-004: the runtime safety net. A question that fails the clean-parse gate is shown
        // as a plain, readable markdown/text block (title + question text + raw option text) at
        // the same anchor — never an empty or half-filled widget. No interactive state is wired.
        function buildQuestionFallback( q ) {
            var safe = ( q && typeof q === 'object' ) ? q : {}
            var wrap = document.createElement( 'div' )
            wrap.className = 'qw-fallback'
            wrap.setAttribute( 'data-qfallback', '1' )

            // PRD-001 (Memo 024 Kap 1): a question that does not parse cleanly must NOT vanish
            // silently. Prepend a VISIBLE warning so the gap is obvious, then keep the question
            // text as raw markdown below it (so the user can still read and answer it manually).
            var warn = document.createElement( 'div' )
            warn.className = 'qw-fallback-warn'
            warn.setAttribute( 'data-qfallback-warn', '1' )
            var warnId = typeof safe.id === 'string' && safe.id.trim().length > 0 ? safe.id.trim() : 'Frage'
            warn.textContent = '⚠ ' + warnId + ' konnte nicht vollständig geparst werden — als Rohtext angezeigt.'
            wrap.appendChild( warn )

            var lines = []
            var id = typeof safe.id === 'string' ? safe.id.trim() : ''
            var title = typeof safe.title === 'string' ? safe.title.trim() : ''
            var heading = [ id, title ].filter( function( s ) { return s.length > 0 } ).join( ' — ' )
            if( heading.length > 0 ) { lines.push( '### ' + heading ) }

            var hintergrund = typeof safe.hintergrund === 'string' ? safe.hintergrund.trim() : ''
            if( hintergrund.length > 0 ) { lines.push( '**Hintergrund:** ' + hintergrund ) }

            var frage = typeof safe.frage === 'string' ? safe.frage.trim() : ''
            if( frage.length > 0 ) { lines.push( '**Frage:** ' + frage ) }

            var aiRecommendation = typeof safe.aiRecommendation === 'string' ? safe.aiRecommendation.trim() : ''
            if( aiRecommendation.length > 0 ) { lines.push( '**AI-Empfehlung:** ' + aiRecommendation ) }

            var optionLines = ( Array.isArray( safe.options ) ? safe.options : [] )
                .filter( function( o ) { return o && typeof o === 'object' && o.kind === 'option' } )
                .map( function( o ) {
                    var key = typeof o.key === 'string' ? o.key : ''
                    var label = typeof o.label === 'string' ? o.label : ''
                    return ( key.length > 0 ? key + ') ' : '' ) + label
                } )
                .filter( function( s ) { return s.trim().length > 0 } )

            optionLines.forEach( function( optionLine ) { lines.push( optionLine ) } )

            // PRD-001 (Memo 024 Kap 1): append the raw-text body AFTER the warning banner — using
            // a child container instead of overwriting wrap.innerHTML keeps the warning visible.
            var bodyEl = document.createElement( 'div' )
            bodyEl.className = 'qw-fallback-body'
            bodyEl.innerHTML = marked.parse( lines.join( '\n\n' ) )
            wrap.appendChild( bodyEl )

            return wrap
        }

        function buildQuestionCard( q, qIdx ) {
            var card = document.createElement( 'div' )
            card.className = 'qw-card'
            // F7 = C: first/primary question prominent, the rest collapsed/expandable.
            if( qIdx > 0 ) { card.classList.add( 'qw-collapsed' ) }
            card.setAttribute( 'data-qidx', String( qIdx ) )

            var badge = q.typ === 'multi' ? 'Multi-Select' : 'Single-Select'

            // Memo 038 Kap 7 (P3a, F5=A): provenance badge. When a question was pre-decided by the
            // AI "im Namen des Users" (answeredBy === 'ai-on-behalf'), render a prominent pill so the
            // user always sees an AI-on-behalf decision is NOT a user answer. A 'user' answer (the
            // default) shows no badge — it stays unobtrusive.
            var provBadge = ( q && q.answeredBy === 'ai-on-behalf' )
                ? '<span class="qw-prov-badge" title="ai-on-behalf">🤖 KI im Namen des Users</span>'
                : ''

            var head = document.createElement( 'div' )
            head.className = 'qw-head'
            head.innerHTML = '<span class="qw-id">' + escHtml( q.id ) + '</span>'
                + '<span class="qw-title">' + escHtml( q.title ) + '</span>'
                + '<span class="qw-badge">' + badge + '</span>'
                + provBadge
                + '<span class="qw-toggle">' + ( qIdx > 0 ? '+' : '−' ) + '</span>'
            head.addEventListener( 'click', function() {
                card.classList.toggle( 'qw-collapsed' )
                var tog = head.querySelector( '.qw-toggle' )
                if( tog ) { tog.textContent = card.classList.contains( 'qw-collapsed' ) ? '+' : '−' }
            } )
            card.appendChild( head )

            var body = document.createElement( 'div' )
            body.className = 'qw-body'

            if( q.hintergrund ) {
                var hg = document.createElement( 'div' )
                hg.className = 'qw-hintergrund'
                hg.innerHTML = '<span class="qw-hintergrund-label">HINTERGRUND</span> '
                    + escHtml( q.hintergrund )
                body.appendChild( hg )
            }

            if( q.frage ) {
                // PRD-023 (Kap 11.4): the question block carries its own "FRAGE" label so it
                // is visually a distinct, labelled block — not a continuation of the
                // Hintergrund prose. The label span mirrors qw-hintergrund-label.
                var fr = document.createElement( 'div' )
                fr.className = 'qw-frage'
                var frLabel = document.createElement( 'span' )
                frLabel.className = 'qw-frage-label'
                frLabel.textContent = 'FRAGE'
                var frText = document.createElement( 'span' )
                frText.className = 'qw-frage-text'
                frText.textContent = q.frage
                fr.appendChild( frLabel )
                fr.appendChild( document.createTextNode( ' ' ) )
                fr.appendChild( frText )
                body.appendChild( fr )
            }

            // WI-041 (Memo 081): the AI recommendation is a DISPLAY property, never a selection.
            // Both the option marker (qw-ai + "(KI-Empfehlung)" hint) and the green KI-EMPFEHLUNG
            // line used to read `preselected` — a field that meant two things at once, so the
            // Vorauswahl-Sperre of REV-02 (writing preselected:[] into every question) silently
            // switched the whole recommendation display off. WI-025 ends that: the server now ships
            // `aiRecommended` as its own display field and `preselected` carries only what an author
            // explicitly chose. This reads the display field FIRST.
            //
            // Two fallbacks stay, in this order, and both earn their place: a payload from an older
            // server build carries no aiRecommended at all (then the old preselected reading is the
            // right one), and a payload from neither still has the recommendation TEXT. The regex
            // fallback is strictly weaker than the server derivation — measured against 1285 single
            // questions with a non-empty recommendation it finds 1158 and misses 127 (9.9 %), namely
            // "Option A — …" and "**A** — …". Dropping it would be a new regression of the same
            // family as REV-02, only smaller and therefore harder to notice.
            var aiReasoning = typeof q.aiRecommendation === 'string' ? q.aiRecommendation.trim() : ''
            var aiRecommendedIdx = -1
            if( q.typ === 'single' ) {
                if( Array.isArray( q.aiRecommended ) && q.aiRecommended.length > 0 ) {
                    aiRecommendedIdx = q.aiRecommended[ 0 ]
                } else if( !Array.isArray( q.aiRecommended ) && Array.isArray( q.preselected ) && q.preselected.length > 0 ) {
                    aiRecommendedIdx = q.preselected[ 0 ]
                } else if( aiReasoning.length > 0 ) {
                    var aiKeyMatch = aiReasoning.match( /^([A-H])\b/ )
                    if( aiKeyMatch ) {
                        aiRecommendedIdx = ( q.options || [] )
                            .findIndex( function( o ) { return o && o.kind === 'option' && o.key === aiKeyMatch[ 1 ] } )
                    }
                }
            }

            // Options (may be only the two defaults custom/topic if no A/B/C were found).
            var optsWrap = document.createElement( 'div' )
            optsWrap.className = 'qw-options'
            var pre = questionNav.state[ qIdx ].selected
            var optionList = q.options || []

            optionList.forEach( function( opt, optIdx ) {
                var row = document.createElement( 'div' )
                row.className = 'qw-option'
                row.setAttribute( 'data-oidx', String( optIdx ) )
                var isSel = pre.indexOf( optIdx ) !== -1
                // AI recommendation marker — display only, from the derived index above (WI-041).
                var isAi = aiRecommendedIdx === optIdx
                if( isSel ) { row.classList.add( 'qw-selected' ) }
                if( isAi ) { row.classList.add( 'qw-ai' ) }

                // PRD-011 (Memo 076 H7b, WI-101): ☑/☐ (U+2611/2610) render as coloured emoji boxes on
                // macOS next to the plain text ◉/○ glyphs. The U+FE0E variation selector forces the
                // text presentation so all four choice markers render as consistent mono glyphs.
                var marker = q.typ === 'single' ? ( isSel ? '◉' : '○' ) : ( isSel ? '☑︎' : '☐︎' )
                var keyLabel = ( opt.kind === 'option' ) ? ( '<span class="qw-option-key">' + escHtml( opt.key ) + ')</span> ' ) : ''
                row.innerHTML = '<span class="qw-marker">' + marker + '</span>' + keyLabel
                    + '<span class="qw-option-label">' + escHtml( opt.label ) + ( isAi ? ' <span class="qw-ai-hint">(KI-Empfehlung)</span>' : '' ) + '</span>'

                row.addEventListener( 'click', function() {
                    questionNav.active = qIdx
                    questionNav.lane = 'option'
                    questionNav.optionFocus = optIdx
                    toggleOption( qIdx, optIdx )
                } )
                optsWrap.appendChild( row )
            } )
            body.appendChild( optsWrap )

            // PRD-005 (#25): green AI recommendation line fed from the preselected single option.
            // PRD-004 (Memo 011 Kap 11, Bug B): render the FULL aiRecommendation reasoning, not
            // just the preselected option label — the bare label never explained WHY the AI
            // recommends it. Prefer the reasoning string; fall back to the option label when no
            // reasoning text is present (e.g. a bare "A" recommendation).
            // WI-041: both aiReasoning and the recommended option are derived above the option
            // loop (display-only), so the line and the option marker can never drift apart again.
            var aiOpt = aiRecommendedIdx >= 0 ? ( ( q.options || [] )[ aiRecommendedIdx ] || null ) : null
            if( aiReasoning.length > 0 || aiOpt !== null ) {
                // PRD-023 (Kap 11.4): the AI recommendation is its own clearly labelled,
                // visually separated block (own label span + qw-ai-line styling), not a
                // run-on sentence after the options.
                var aiLine = document.createElement( 'div' )
                aiLine.className = 'qw-ai-line'
                var aiLabel = document.createElement( 'span' )
                aiLabel.className = 'qw-ai-label'
                aiLabel.textContent = 'KI-EMPFEHLUNG'
                var aiText = document.createElement( 'span' )
                aiText.className = 'qw-ai-text'
                // Avoid a doubled key when the reasoning already starts with it ("A — …").
                var aiKeyPrefix = ( aiOpt !== null && aiOpt.kind === 'option' && aiReasoning.indexOf( aiOpt.key ) !== 0 )
                    ? ( aiOpt.key + ') ' )
                    : ''
                aiText.textContent = aiReasoning.length > 0
                    ? ( aiKeyPrefix + aiReasoning )
                    : ( aiOpt.key + ') ' + aiOpt.label )
                aiLine.appendChild( aiLabel )
                aiLine.appendChild( document.createTextNode( ' ' ) )
                aiLine.appendChild( aiText )
                body.appendChild( aiLine )
            }

            // Custom-entry input. Multi-select gets it as "+ eigener Eintrag" (allowCustomEntries).
            // Memo 079 PRD-24 / Memo 080 PRD-F2: a single-select ALSO gets a free-text row per injected
            // RE-FORMULATION option — "Frage neu formulieren" (reframe) and "Antwortmoeglichkeiten neu
            // formulieren" (reoption) — each hidden until its own option is actually selected, so the user
            // can type HOW the question should read, or WHAT is wrong with the answer options.
            // buildAnswerText folds the typed text in; refreshOptionMarkers reveals/hides each row as its
            // option is (de)selected. The rows come from REFORMULATION_KINDS, never from a per-kind branch.
            var reformulationRows = reformulationRowsOf( optionList )
            var buildFreeTextRow = function( spec ) {
                var customRow = document.createElement( 'div' )
                customRow.className = 'qw-custom-row'
                if( spec !== null ) {
                    customRow.setAttribute( spec.attribute, '1' )
                    // Only visible while the owning option is selected (no free-text clutter otherwise).
                    if( questionNav.state[ qIdx ].selected.indexOf( spec.idx ) === -1 ) { customRow.style.display = 'none' }
                }
                var input = document.createElement( 'input' )
                input.type = 'text'
                input.className = 'qw-custom-input'
                input.placeholder = spec !== null ? spec.placeholder : '+ eigener Eintrag'
                input.addEventListener( 'keydown', function( ev ) {
                    // Let text input flow normally — never hijack typing here.
                    ev.stopPropagation()
                    if( ev.key === 'Enter' && input.value.trim().length > 0 ) {
                        markQuestionTouched( qIdx )
                        questionNav.state[ qIdx ].custom.push( input.value.trim() )
                        input.value = ''
                        // PRD-026: a new custom entry changes the answer -> reset added state.
                        var cst = questionNav.state[ qIdx ]
                        if( cst.added ) {
                            cst.added = false
                            cst.addedText = null
                            setAddButtonState( qIdx, false )
                            updateSaveAnswersOnlyState()
                        }
                        persistQuestionState()
                    }
                } )
                // Memo 079 reframe-freetext-click-loss: the reformulation was committed ONLY on Enter, so
                // typing it and clicking "Hinzufügen" (or opening the answer popup) — both of which blur the
                // input BEFORE reading st.custom — silently dropped the typed text. Commit on blur too.
                input.addEventListener( 'blur', function() { harvestReformulationInputs( qIdx ) } )
                customRow.appendChild( input )
                body.appendChild( customRow )
            }
            if( q.allowCustomEntries ) {
                buildFreeTextRow( null )
            } else {
                reformulationRows.forEach( buildFreeTextRow )
            }

            // Topic chips for carousel left/right navigation (F15).
            if( Array.isArray( q.topicPositions ) && q.topicPositions.length > 0 ) {
                var topics = document.createElement( 'div' )
                topics.className = 'qw-topics'
                q.topicPositions.forEach( function( pos, tIdx ) {
                    var chip = document.createElement( 'span' )
                    chip.className = 'qw-topic-link'
                    chip.setAttribute( 'data-tidx', String( tIdx ) )
                    chip.textContent = 'Topic ' + pos
                    // PRD-025 (Kap 11.6): cursor and jumpability must be consistent — only a
                    // chip with an actual target heading gets the link cursor + click handler.
                    // A dead chip (no matching "Kap. {pos}" heading) stays neutral (qw-dead),
                    // so no pointer-cursor falsely suggests it is clickable.
                    if( findTopicTarget( pos ) ) {
                        chip.addEventListener( 'click', function() {
                            scrollToTopic( pos )
                        } )
                    } else {
                        chip.classList.add( 'qw-topic-dead' )
                    }
                    topics.appendChild( chip )
                } )
                body.appendChild( topics )
            }

            // Footer: unified "Hinzufuegen" (F13 = B) + Leitplanke note.
            var footer = document.createElement( 'div' )
            footer.className = 'qw-footer'
            var addBtn = document.createElement( 'button' )
            addBtn.className = 'qw-add-btn'
            addBtn.textContent = 'Hinzufügen'
            addBtn.addEventListener( 'click', function() { submitQuestionAnswer( qIdx ) } )
            footer.appendChild( addBtn )

            // PRD-005 (#22): secondary footer actions per card — "+ Frage" / "Ablehnen".
            var addQBtn = document.createElement( 'button' )
            addQBtn.className = 'qw-secondary-btn'
            addQBtn.textContent = '+ Frage'
            addQBtn.addEventListener( 'click', function() { addCustomQuestionRow( qIdx ) } )
            footer.appendChild( addQBtn )

            // PRD-006 (Kap 9, Bug 2 / AC-08): "Ablehnen" is reversible. The SAME button
            // toggles between "Ablehnen" and "Ablehnen rückgängig" — rejecting never clears
            // the selection or deletes any data, it only visually collapses + marks the card.
            var rejectBtn = document.createElement( 'button' )
            rejectBtn.className = 'qw-secondary-btn qw-reject-btn'
            rejectBtn.textContent = 'Ablehnen'
            rejectBtn.addEventListener( 'click', function() { toggleRejectQuestion( qIdx ) } )
            footer.appendChild( rejectBtn )

            var note = document.createElement( 'span' )
            note.className = 'qw-note'
            note.textContent = 'Optional — der Standardweg bleibt das Transcript.'
            footer.appendChild( note )
            body.appendChild( footer )

            card.appendChild( body )

            return card
        }

        // PRD-F3 (Memo 080 Kap 18, S1): the ONE place that flips a question from "shows the AI
        // preselection" to "the user worked on this". Every interaction path calls this — selecting an
        // option, typing a custom entry, harvesting a re-formulation, confirming, rejecting — so a new
        // interaction path is marked by joining this call, not by remembering a flag in five places.
        function markQuestionTouched( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st ) { return }
            st.touched = true
        }

        // Memo 081, WI-118: the ONE place a widget interaction becomes durable. Every mutating path joins
        // it AFTER its mutation — selecting an option, typing a custom entry, harvesting a re-formulation,
        // confirming, undoing, rejecting, un-rejecting — so a new interaction path is persisted by joining
        // this call, not by remembering a save in seven places. markQuestionTouched above is the same idea
        // at the START of a mutation; this is its counterpart at the END, and the two must not be merged: a
        // save that ran before the assignment would store the state the user just left.
        //
        // It bundles: seven clicks in a row do not become seven writes. It never delays or breaks the
        // click — the write runs on a timer and its failure surfaces as a visible message rather than an
        // exception (the "best-effort but visible" rule UserInputCapture already follows).
        function persistQuestionState() {
            if( questionStateSaveTimer !== null ) { return }
            questionStateSaveTimer = setTimeout( function() {
                questionStateSaveTimer = null
                flushQuestionState()
            }, 250 )
        }

        // Build the records for the current widget state. The confirmed half is derived from
        // isConfirmedAnswer — THE existing predicate, not a second copy of its condition. If the harvest
        // condition ever narrows or widens, the store follows it automatically; two copies of one
        // condition are exactly where a later change touches one of them and they drift apart.
        //
        // It reports its comparison set: `seen` how many states were examined, `skipped` how many carry
        // no question id and are therefore neither stored nor restored (the same rule prevById follows).
        // A silent drop would be expensive here, because a half-filled store looks like an empty one.
        function buildQuestionStateRecords() {
            var questions = questionNav.questions || []
            var state = questionNav.state || []
            var entries = {}
            var counted = { seen: 0, skipped: 0 }

            questions.forEach( function( q, qIdx ) {
                var st = state[ qIdx ]
                if( !st ) { return }
                counted.seen = counted.seen + 1
                if( !q || !q.id ) {
                    counted.skipped = counted.skipped + 1

                    return
                }
                var record = {
                    intent: {
                        selected: ( st.selected || [] ).slice(),
                        custom: ( st.custom || [] ).slice(),
                        rejected: st.rejected === true,
                        touched: st.touched === true
                    }
                }
                if( isConfirmedAnswer( st ) ) { record.confirmed = { answerText: st.addedText } }
                entries[ q.id ] = record
            } )

            return { entries: entries, seen: counted.seen, skipped: counted.skipped }
        }

        function flushQuestionState() {
            if( !currentDocumentId ) { return }
            var rev = currentRevisionId()
            if( !rev ) { return }
            var built = buildQuestionStateRecords()

            fetch( '/api/documents/' + encodeURIComponent( currentDocumentId ) + '/question-state', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify( { revisionId: rev, entries: built.entries } )
            } )
                .then( function( r ) { return r.ok ? r.json() : { status: false, messages: [ 'HTTP ' + r.status ] } } )
                .then( function( data ) {
                    if( data && data.status === true ) { return }
                    showQuestionStateSaveError( data && data.messages ? data.messages : [] )
                } )
                .catch( function( err ) { showQuestionStateSaveError( [ String( err && err.message ? err.message : err ) ] ) } )
        }

        // A failed save is VISIBLE. A store that fails quietly is worse than none, because it promises
        // that the restart is harmless — and the user only finds out when the state is already gone.
        // German display text over English fields, like every other widget message here.
        function showQuestionStateSaveError( messages ) {
            var container = document.getElementById( 'question-widgets' )
            if( !container ) { return }
            var box = document.getElementById( 'qw-state-save-warn' )
            if( !box ) {
                box = document.createElement( 'div' )
                box.className = 'qw-parse-warn'
                box.id = 'qw-state-save-warn'
                container.insertBefore( box, container.firstChild )
            }
            var detail = ( messages || [] ).join( '; ' )
            box.textContent = '⚠ Der Antwort-Zustand konnte nicht gespeichert werden'
                + ( detail.length > 0 ? ( ' (' + detail + ')' ) : '' )
                + ' — nach einem Neustart des Servers ist er verloren.'
        }

        // Memo 081 WI-118: load the stored working state for THIS document+revision, then render again.
        // The load is async and therefore cannot be finished before the first render, so it re-runs the
        // SAME idempotent renderQuestionWidgets three other callers already run — a fourth call of the
        // third path, never a fourth render path. Loading happens ONCE per document+revision pair: the
        // key is claimed BEFORE the request goes out, so a repeated broadcast of the same pair cannot
        // let a late answer overwrite a fresh selection.
        function refreshQuestionState() {
            if( !currentDocumentId ) { return }
            var rev = currentRevisionId()
            if( !rev ) { return }
            var key = currentDocumentId + '::' + rev
            if( questionStateStored.key === key ) { return }
            questionStateStored.key = key

            fetch( '/api/documents/' + encodeURIComponent( currentDocumentId ) + '/question-state?revisionId=' + encodeURIComponent( rev ) )
                .then( function( r ) { return r.ok ? r.json() : { entries: {}, seen: 0, skipped: 0 } } )
                .then( function( data ) {
                    questionStateStored.entries = ( data && data.entries ) ? data.entries : {}
                    questionStateStored.seen = ( data && typeof data.seen === 'number' ) ? data.seen : 0
                    questionStateStored.skipped = ( data && typeof data.skipped === 'number' ) ? data.skipped : 0
                    renderQuestionWidgets( lastQuestionSchema )
                } )
                .catch( function() {} )
        }

        // PRD-F3 (Memo 080 Kap 18, S4): does the CONFIRMED selection say exactly what the AI had
        // preselected? This is the provenance datum the `preselected` column exists for — "the user went
        // with the recommendation" — and it is written only for an answer the user actually confirmed.
        // Empty selection is never a preselection match (nothing was chosen at all).
        function isPreselectionAnswer( q, st ) {
            if( !q || !st ) { return false }
            // Memo 081, WI-025: the datum this asks about is "did the user go with the RECOMMENDATION",
            // so it reads the display field, not the selection field. Without this the provenance chain
            // — [Vorauswahl] in the answer heading -> PRESELECTED_MARK -> the --preselected CLI flag ->
            // the user_input_answers.preselected column — would report a constant false as soon as the
            // derivation left `preselected`, and a constant value in a provenance column looks exactly
            // like a result. The fallback is the older-payload case, same reasoning as in the widget.
            var pre = Array.isArray( q.aiRecommended ) ? q.aiRecommended : ( Array.isArray( q.preselected ) ? q.preselected : [] )
            var expected = q.typ === 'single' ? pre.slice( 0, 1 ) : pre
            if( expected.length === 0 || st.selected.length !== expected.length ) { return false }
            if( st.custom.length > 0 ) { return false }

            return expected.every( function( idx ) { return st.selected.indexOf( idx ) !== -1 } )
        }

        function toggleOption( qIdx, optIdx ) {
            var q = questionNav.questions[ qIdx ]
            var st = questionNav.state[ qIdx ]
            if( !q || !st ) { return }

            markQuestionTouched( qIdx )

            var pos = st.selected.indexOf( optIdx )
            if( q.typ === 'single' ) {
                // Single-select: exactly one (or none — never forced).
                st.selected = pos !== -1 ? [] : [ optIdx ]
            } else {
                if( pos !== -1 ) { st.selected.splice( pos, 1 ) }
                else { st.selected.push( optIdx ) }
            }
            // PRD-026 (Kap 12.1, Scope 3): if the selection changes after "Hinzufügen", the
            // confirmed state and the live selection must never drift apart. Reset the added
            // status (button back to "Hinzufügen") so re-adding is possible.
            if( st.added ) {
                st.added = false
                st.addedText = null
                setAddButtonState( qIdx, false )
                updateSaveAnswersOnlyState()
            }
            refreshOptionMarkers( qIdx )
            persistQuestionState()
        }

        function refreshOptionMarkers( qIdx ) {
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( !card ) { return }
            var q = questionNav.questions[ qIdx ]
            var st = questionNav.state[ qIdx ]
            var rows = card.querySelectorAll( '.qw-option' )
            rows.forEach( function( row, optIdx ) {
                var isSel = st.selected.indexOf( optIdx ) !== -1
                row.classList.toggle( 'qw-selected', isSel )
                var marker = row.querySelector( '.qw-marker' )
                if( marker ) {
                    // PRD-011 (Memo 076 H7b, WI-101): U+FE0E forces the text presentation of ☑/☐
                    // (else macOS renders them as emoji boxes) — mirrors the initial render above.
                    marker.textContent = q.typ === 'single'
                        ? ( isSel ? '◉' : '○' )
                        : ( isSel ? '☑︎' : '☐︎' )
                }
            } )
            // Memo 079 PRD-24 / Memo 080 PRD-F2: reveal each re-formulation free-text row only while ITS
            // own option is selected (single-select has no free-text otherwise). One loop over the kind
            // list, so a new kind is revealed by the same code that builds and harvests it.
            reformulationRowsOf( q.options ).forEach( function( entry ) {
                var row = card.querySelector( '.qw-custom-row[' + entry.attribute + '="1"]' )
                if( !row ) { return }
                row.style.display = st.selected.indexOf( entry.idx ) !== -1 ? '' : 'none'
            } )
        }

        function renderQuestionFocus() {
            // PRD-004: with the render gate, non-clean questions render as a markdown fallback
            // (not a .qw-card) and may sit BETWEEN interactive cards. The NodeList position is
            // therefore no longer the question index — read the explicit data-qidx the card was
            // built with so focus/selection always map to the correct questionNav state.
            var cards = document.querySelectorAll( '#question-widgets .qw-card' )
            cards.forEach( function( card ) {
                var qIdx = parseInt( card.getAttribute( 'data-qidx' ), 10 )
                if( isNaN( qIdx ) ) { return }
                card.classList.toggle( 'qw-active', qIdx === questionNav.active )
                card.querySelectorAll( '.qw-option' ).forEach( function( row, optIdx ) {
                    var focused = qIdx === questionNav.active && questionNav.lane === 'option' && optIdx === questionNav.optionFocus
                    row.classList.toggle( 'qw-focus', focused )
                } )
                card.querySelectorAll( '.qw-topic-link' ).forEach( function( chip, tIdx ) {
                    var focused = qIdx === questionNav.active && questionNav.lane === 'topic' && tIdx === questionNav.optionFocus
                    chip.classList.toggle( 'qw-focus', focused )
                } )
            } )
        }

        function findTopicTarget( pos ) {
            // PRD-012 (Memo 076 H8, WI-104): app.client.mjs is now served as a STANDALONE file (no
            // template-literal escaping layer any more — that stale assumption is what broke this).
            // In a plain JS string literal single backslashes collapse: '\s' -> 's', '\b' -> the
            // backspace char (U+0008), '\.' -> '.', so the old source built the regex
            // /kap(itel)?.?s*<pos>\b/ and matched NO real heading. Use DOUBLE backslashes so the
            // regex source keeps its metaclasses (\. \s \b) and regex-escape the dynamic pos so
            // "11.7" cannot accidentally match "11x7". Returns null when no heading matches.
            var headings = contentEl.querySelectorAll( 'h1, h2, h3, h4' )
            var target = null
            // Build the source from regex-literal .source fragments so the metaclasses (dot, whitespace,
            // word-boundary) stay intact without any backslash-doubled STRING escapes — the extracted
            // client file must remain free of template-literal escape artifacts (AssetExtractJsPRD011).
            // escapedPos escapes the dot in the position ("11.7" -> "11.7" with an escaped dot) via a
            // regex-literal source too, same reasoning.
            var escapedPos = String( pos ).replace( /\./g, /\./.source )
            var re = new RegExp( /kap(itel)?\.?\s*/.source + escapedPos + /\b/.source, 'i' )
            headings.forEach( function( h ) {
                if( target ) { return }
                if( re.test( h.textContent || '' ) ) { target = h }
            } )

            return target
        }

        function scrollToTopic( pos ) {
            var target = findTopicTarget( pos )
            if( target ) {
                var top = target.getBoundingClientRect().top + window.scrollY - 52
                window.scrollTo( { top: top, behavior: 'smooth' } )
            }
        }

        // PRD-026 (Kap 12.1): "Hinzufügen" injects the answer machine-side into the widget
        // state and flips the button to "hinzugefügt" — NO popup. The previous flow opened
        // the transcript modal; Kap 12.1 explicitly abolishes that. Where/how the answer is
        // held is irrelevant — only deterministic + visibly confirmed matters.
        function buildAnswerText( q, st ) {
            var parts = st.selected.map( function( optIdx ) {
                var opt = q.options[ optIdx ]
                if( !opt ) { return '' }
                if( opt.kind === 'option' ) { return opt.key + ') ' + opt.label }
                return opt.label
            } ).filter( function( s ) { return s.length > 0 } )

            st.custom.forEach( function( c ) { parts.push( c ) } )

            // Memo 079 PRD-24 / Memo 080 PRD-F2: a single-select RE-FORMULATION answer carries the typed
            // text as a custom entry — join the option label + that text so the single-select "first part
            // only" rule does not silently drop it. The kind list decides, so the reoption turn keeps its
            // "was stimmt nicht" exactly as the reframe turn keeps its new wording.
            var reformulationKinds = REFORMULATION_KINDS.map( function( entry ) { return entry.kind } )
            var isReformulationAnswer = q.typ === 'single' && st.selected.some( function( optIdx ) {
                var opt = q.options[ optIdx ]
                return opt && reformulationKinds.indexOf( opt.kind ) !== -1
            } )
            var answerLine = ( q.typ === 'multi' || isReformulationAnswer ) ? parts.join( '; ' ) : ( parts[ 0 ] || '' )
            // Markdown form unchanged from the previous modal flow: "## Antwort auf {id} — {title}"
            // + answer line, multi joined by "; ".
            // PRD-F3 (Memo 080 Kap 18, S4): a confirmed answer that says exactly what the AI preselected
            // carries the provenance mark on the HEADING tail. Body and answer line stay the user's words
            // verbatim, and both existing block parsers already skip the heading tail — so this is
            // readable provenance without a second format.
            var text = '## Antwort auf ' + q.id + ' — ' + q.title + answerMarkSuffix( q, st ) + '\n\n' + answerLine + '\n'

            return { answerLine: answerLine, text: text }
        }

        // PRD-F3 (Memo 080 Kap 18, S4): the heading suffix carrying the provenance mark, or the empty
        // string. Kept as its own function so the popup path (applyPromptEdit) emits the SAME bytes as
        // the widget path — one mark, one producer, no second spelling.
        function answerMarkSuffix( q, st ) {
            return isPreselectionAnswer( q, st ) ? ' [Vorauswahl]' : ''
        }

        function setAddButtonState( qIdx, added ) {
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( !card ) { return }
            var addBtn = card.querySelector( '.qw-add-btn' )
            if( !addBtn ) { return }
            if( added ) {
                // PRD-006 (AC-07): the button stays CLICKABLE in the done-state and its
                // title advertises the undo path — the "hinzugefügt" quittance is no longer
                // a dead end. A second click runs undoQuestionAnswer.
                addBtn.textContent = 'hinzugefügt ✓ (rückgängig)'
                addBtn.classList.add( 'qw-add-btn--done' )
                addBtn.title = 'Erneut klicken, um das Hinzufügen rückgängig zu machen'
                addBtn.disabled = false
            } else {
                addBtn.textContent = 'Hinzufügen'
                addBtn.classList.remove( 'qw-add-btn--done' )
                addBtn.title = ''
                addBtn.disabled = false
            }
        }

        // Memo 079 reframe-freetext-click-loss: fold the LIVE re-formulation input into st.custom (deduped)
        // before any reader consumes st.custom. The reformulation used to be committed ONLY on Enter
        // (keydown), so a user who typed it and clicked "Hinzufügen" — or opened the answer popup — lost the
        // text (buildAnswerText / the popup prefill read st.custom while the value still sat in the input).
        // Mirrors the Enter handler's push + clear + added-reset.
        //
        // Memo 080 PRD-F2: it harvests EVERY re-formulation row, not only the reframe one. A harvest that knows
        // one row while the card builds two is the same silent drop one kind further on — the defect this
        // function exists to close, re-opened by the next kind.
        function harvestReformulationInputs( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st ) { return }
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( !card ) { return }
            var harvested = REFORMULATION_KINDS
                .map( function( entry ) { return card.querySelector( '.qw-custom-row[' + entry.attribute + '="1"] .qw-custom-input' ) } )
                // DISTINCT nodes, and the value is read ONCE per node: clearing an input and then reading
                // it again would harvest an empty string as if it were a second answer.
                .filter( function( input, idx, all ) { return input !== null && all.indexOf( input ) === idx } )
                .map( function( input ) { return { input: input, value: String( input.value || '' ).trim() } } )
                .filter( function( entry ) { return entry.value.length > 0 } )
                .map( function( entry ) {
                    if( st.custom.indexOf( entry.value ) === -1 ) { st.custom.push( entry.value ) }
                    entry.input.value = ''

                    return entry.value
                } )
            if( harvested.length === 0 ) { return }
            markQuestionTouched( qIdx )
            if( st.added ) {
                st.added = false
                st.addedText = null
                setAddButtonState( qIdx, false )
                updateSaveAnswersOnlyState()
            }
            persistQuestionState()
        }

        function submitQuestionAnswer( qIdx ) {
            var q = questionNav.questions[ qIdx ]
            var st = questionNav.state[ qIdx ]
            if( !q || !st ) { return }

            // PRD-006 (Kap 9, Bug 1 / AC-07): "Hinzufügen" is reversible. A second click on
            // an already-added question is an UNDO: it resets st.added + st.addedText and
            // flips the button back to "Hinzufügen". This is the explicit Rückgängig-Pfad the
            // memo demands ("NICHTS wird gelöscht, alles rückgängig machbar").
            if( st.added ) {
                undoQuestionAnswer( qIdx )

                return
            }

            // PRD-F3 (Memo 080 Kap 18, S1): clicking "Hinzufügen" IS the interaction. A machine injection
            // that reached st.added without this click stays untouched and is therefore never read as a
            // value — that is the whole point of the second condition in S2.
            markQuestionTouched( qIdx )

            // Memo 079 reframe-freetext-click-loss: harvest a typed-but-not-Entered reformulation before
            // buildAnswerText reads st.custom, so clicking "Hinzufügen" never drops it.
            harvestReformulationInputs( qIdx )

            // PRD-006 (AC-09): re-adding after the selection changed simply overwrites
            // st.addedText with the freshly built answer — answers stay changeable.
            var built = buildAnswerText( q, st )

            // Machine injection: store the confirmed answer in the widget state.
            // No transcript-modal is opened (Kap 12.1) — the only feedback is the button.
            st.added = true
            st.addedText = built.text
            setAddButtonState( qIdx, true )
            // PRD-028: a collected answer enables the "ohne Transcript speichern" path.
            updateSaveAnswersOnlyState()
            persistQuestionState()
        }

        // PRD-006 (Kap 9, AC-07): explicit undo of a confirmed answer. Resets the added
        // state and the injected text, then restores the button — no data is destroyed,
        // the selection stays exactly as the user left it so re-adding is one click away.
        function undoQuestionAnswer( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st ) { return }

            st.added = false
            st.addedText = null
            setAddButtonState( qIdx, false )
            updateSaveAnswersOnlyState()
            persistQuestionState()
        }

        // PRD-005 (#22): "+ Frage" — open the transcript modal pre-filled with a
        // follow-up-question template that references the originating question.
        function addCustomQuestionRow( qIdx ) {
            var q = questionNav.questions[ qIdx ]
            if( !q ) { return }
            var text = '## Rueckfrage zu ' + q.id + ' — ' + q.title + '\n\n- '
            if( typeof openTranscriptModal === 'function' ) {
                openTranscriptModal( { content: text } )
            }
        }

        // PRD-006 (Kap 9, Bug 2 / AC-08): "Ablehnen" REVERSIBLE. Rejecting only collapses
        // and visually marks the card — it NEVER clears st.selected and NEVER deletes the
        // question. A second click ("Ablehnen rückgängig") expands the card and removes the
        // rejected mark. All options + custom entries are preserved across the toggle.
        function rejectQuestion( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st || st.rejected === true ) { return }

            // PRD-F3 (Memo 080 Kap 18, S1): rejecting is an interaction with this question too.
            markQuestionTouched( qIdx )
            st.rejected = true
            // Deliberately do NOT touch st.selected (Bug 2 fix) — the data stays intact.
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( card ) {
                card.classList.add( 'qw-collapsed', 'qw-rejected' )
                var tog = card.querySelector( '.qw-toggle' )
                if( tog ) { tog.textContent = '+' }
                setRejectButtonState( qIdx, true )
            }
            persistQuestionState()
        }

        // PRD-006 (AC-08): "Ablehnen rückgängig" — restore a rejected card to normal.
        function undoRejectQuestion( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st || st.rejected !== true ) { return }

            markQuestionTouched( qIdx )
            st.rejected = false
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( card ) {
                card.classList.remove( 'qw-collapsed', 'qw-rejected' )
                var tog = card.querySelector( '.qw-toggle' )
                if( tog ) { tog.textContent = '−' }
                setRejectButtonState( qIdx, false )
            }
            // The selection survived the reject, so the markers just need a redraw.
            refreshOptionMarkers( qIdx )
            persistQuestionState()
        }

        function toggleRejectQuestion( qIdx ) {
            var st = questionNav.state[ qIdx ]
            if( !st ) { return }
            if( st.rejected === true ) { undoRejectQuestion( qIdx ) }
            else { rejectQuestion( qIdx ) }
        }

        function setRejectButtonState( qIdx, rejected ) {
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + qIdx + '"]' )
            if( !card ) { return }
            var btn = card.querySelector( '.qw-reject-btn' )
            if( !btn ) { return }
            btn.textContent = rejected ? 'Ablehnen rückgängig' : 'Ablehnen'
            // A rejected card is collapsed, so its footer button is hidden; the toggle lives
            // on the card head (qw-rejected). Keep the head clickable so the user can expand
            // and reach the "Ablehnen rückgängig" button again.
            if( rejected ) { card.setAttribute( 'data-rejected', '1' ) }
            else { card.removeAttribute( 'data-rejected' ) }
        }

        // Carousel keyboard navigation (F15 = A, "wie Claude Code").
        // Active only when a widget is present and the user is not typing in a field.
        document.addEventListener( 'keydown', function( ev ) {
            if( questionNav.active < 0 || questionNav.questions.length === 0 ) { return }

            // Never interfere with text inputs, the transcript modal, or other typing.
            var tag = ( ev.target && ev.target.tagName ) ? ev.target.tagName.toLowerCase() : ''
            if( tag === 'input' || tag === 'textarea' || ( ev.target && ev.target.isContentEditable ) ) { return }
            var modal = document.getElementById( 'transcript-modal' )
            if( modal && !modal.classList.contains( 't-hidden' ) ) { return }

            var widgets = document.getElementById( 'question-widgets' )
            if( !widgets || widgets.children.length === 0 ) { return }

            var q = questionNav.questions[ questionNav.active ]
            var optionCount = ( q.options || [] ).length
            var topicCount = ( q.topicPositions || [] ).length

            if( ev.shiftKey && ( ev.key === 'ArrowUp' || ev.key === 'ArrowDown' ) ) {
                // Shift+Up/Down: switch the active question.
                // PRD-024 (Kap 11.5): circular wrap instead of edge clamping — last + down
                // wraps to first, first + up wraps to last, via ( i + delta + n ) % n.
                // The n === 0 case is already guarded by the early return at the top of
                // this handler (questionNav.questions.length === 0), so modulo is never by 0.
                ev.preventDefault()
                var delta = ev.key === 'ArrowDown' ? 1 : -1
                var n = questionNav.questions.length
                // PRD-001 (Memo 024 Kap 1): the FIRST directional press only engages the already
                // active question (data-qidx=0) — it does not skip ahead. Subsequent presses step.
                var next = questionNav.engaged
                    ? ( ( questionNav.active + delta ) % n + n ) % n
                    : questionNav.active
                questionNav.engaged = true
                questionNav.active = next
                questionNav.lane = 'option'
                questionNav.optionFocus = -1
                // PRD-001 (Memo 024 Kap 1): expand the now-active card by its EXPLICIT data-qidx,
                // never by NodeList position. In the collapsed state non-card fallbacks sit between
                // the cards, so the n-th .qw-card no longer equals data-qidx=n — cards[next] drifted.
                var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + next + '"]' )
                if( card ) {
                    card.classList.remove( 'qw-collapsed' )
                    var tog = card.querySelector( '.qw-toggle' )
                    if( tog ) { tog.textContent = '−' }
                    card.scrollIntoView( { block: 'center', behavior: 'smooth' } )
                }
                renderQuestionFocus()

                return
            }

            if( ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' ) {
                // Left/Right: carousel between the option lane and the topic lane.
                if( topicCount === 0 ) { return }
                ev.preventDefault()
                questionNav.lane = ev.key === 'ArrowRight' ? 'topic' : 'option'
                questionNav.optionFocus = 0
                renderQuestionFocus()

                return
            }

            if( ev.key === 'ArrowUp' || ev.key === 'ArrowDown' ) {
                ev.preventDefault()
                var count = questionNav.lane === 'topic' ? topicCount : optionCount
                if( count === 0 ) { return }
                var step = ev.key === 'ArrowDown' ? 1 : -1
                var cur = questionNav.optionFocus
                cur = cur + step
                if( cur < 0 ) { cur = count - 1 }
                if( cur > count - 1 ) { cur = 0 }
                questionNav.optionFocus = cur
                renderQuestionFocus()

                return
            }

            if( ev.key === ' ' || ev.key === 'Spacebar' ) {
                // Space: toggle/confirm the focused option (or activate the focused topic).
                ev.preventDefault()
                if( questionNav.lane === 'topic' ) {
                    var pos = q.topicPositions[ questionNav.optionFocus ]
                    if( pos !== undefined ) { scrollToTopic( pos ) }
                } else if( questionNav.optionFocus >= 0 ) {
                    toggleOption( questionNav.active, questionNav.optionFocus )
                }

                return
            }

            // PRD-006 (Kap 9, AC-06): Enter on the focused question triggers "Hinzufügen"
            // (identical to the button click, incl. its reversible undo on a second Enter).
            if( ev.key === 'Enter' ) {
                ev.preventDefault()
                submitQuestionAnswer( questionNav.active )

                return
            }

            // PRD-006 (Kap 9, AC-06): a keyboard shortcut to "log in" (confirm) the focused
            // option without the mouse. Ctrl/Cmd+Enter selects the focused option AND adds
            // the answer in one keystroke — the "einloggen per Tastatur"-Aktion.
            if( ev.key === 'l' && ( ev.ctrlKey || ev.metaKey ) ) {
                ev.preventDefault()
                if( questionNav.lane === 'option' && questionNav.optionFocus >= 0 ) {
                    toggleOption( questionNav.active, questionNav.optionFocus )
                }
                submitQuestionAnswer( questionNav.active )

                return
            }

            // PRD-006 (Kap 9, AC-06): Tab cycles the focus WITHIN the active card across the
            // three footer actions (Hinzufügen -> + Frage -> Ablehnen) and back to the option
            // lane. Shift+Tab steps backwards. Keeping the cycle inside the card means the
            // whole interaction is reachable without the mouse.
            if( ev.key === 'Tab' ) {
                ev.preventDefault()
                cycleFooterFocus( ev.shiftKey ? -1 : 1 )

                return
            }

            // PageUp/PageDown: scroll (default browser behaviour is fine — no preventDefault).
        } )

        // PRD-006 (Kap 9, AC-06): focus-cycle helper for the active card's footer buttons.
        // footerFocus -1 means "no footer button focused" (focus is back on the option lane).
        function cycleFooterFocus( step ) {
            var card = document.querySelector( '#question-widgets .qw-card[data-qidx="' + questionNav.active + '"]' )
            if( !card ) { return }
            var buttons = Array.prototype.slice.call( card.querySelectorAll( '.qw-footer button' ) )
            if( buttons.length === 0 ) { return }

            var next = questionNav.footerFocus + step
            // -1 .. buttons.length-1, wrapping so the cycle returns to the option lane.
            if( next < -1 ) { next = buttons.length - 1 }
            if( next > buttons.length - 1 ) { next = -1 }
            questionNav.footerFocus = next

            if( next === -1 ) {
                questionNav.lane = 'option'
                if( questionNav.optionFocus < 0 ) { questionNav.optionFocus = 0 }
                // Move focus off any button back into the document so the global keydown
                // handler (option/topic navigation) regains control. The visual focus marker
                // is the qw-focus class, not native focus (the option rows are plain divs).
                if( document.activeElement && document.activeElement.blur ) { document.activeElement.blur() }
                renderQuestionFocus()

                return
            }

            questionNav.lane = 'footer'
            renderQuestionFocus()
            buttons[ next ].focus()
        }

        function buildTOC( diffData ) {
            // PRD-015 (D11): index BOTH h2 AND h3 (was h2-only), so sub-sections are navigable. The
            // function is already re-run after every re-render (content handler, bindDiffToggle D2,
            // renderProseContent), so the list never goes stale on a diff-toggle.
            var headings = contentEl.querySelectorAll( 'h2, h3' )
            // PRD-015 (D5): changedSections are RAW server strings, heading.textContent is RENDERED.
            // Normalise BOTH sides through slugify so a changed chapter matches its rendered heading.
            var changedSet = new Set()

            if( diffData && diffData.changedSections ) {
                diffData.changedSections.forEach( function( s ) { changedSet.add( slugify( s ) ) } )
            }

            tocListEl.innerHTML = ''

            headings.forEach( function( heading, idx ) {
                // PRD-015 (D6/D11): skip headings the structure pass collapsed — block-body H3s
                // (the toolkit headings of the BlockSections register under a block-meta card, Memo 080
                // PRD-B1) and raw-question/vorwort bodies. They are hidden in the prose, so they must not pollute
                // the TOC either. buildTOC always runs after applyContentStructure, so the classes
                // are present by now.
                //
                // Memo 081, WI-113: this READER of `block-body-hidden` was not foreseen by the order,
                // which expected the class in two places and measured four. It is why the class could
                // not simply be deleted: the six folding sections are no longer hidden, they are folded,
                // so the test moves from "is this heading hidden" to "does this heading sit inside a
                // fold frame". Without it the table of contents would gain 265 entries the reader never
                // had — the six section headings of all 41 chapters — which is the same pollution this
                // line was written against.
                if( heading.closest && heading.closest( '.chapter-section' ) ) { return }
                if( heading.classList.contains( 'raw-question-hidden' ) ) { return }

                var li = document.createElement( 'li' )
                var text = heading.textContent
                var hasChange = changedSet.has( slugify( text ) )

                li.textContent = text
                li.title = text
                // PRD-015 (D11): mark the level so h3 entries can be indented under their h2.
                li.classList.add( heading.tagName === 'H3' ? 'toc-h3' : 'toc-h2' )

                if( hasChange ) {
                    var dot = document.createElement( 'span' )
                    dot.className = 'toc-dot'
                    li.prepend( dot )
                }

                var headingId = heading.id || ( 'toc-heading-' + idx )
                if( !heading.id ) { heading.id = headingId }
                li.setAttribute( 'data-target', headingId )

                li.addEventListener( 'click', function() {
                    var target = document.getElementById( this.getAttribute( 'data-target' ) )
                    if( target ) {
                        var top = target.getBoundingClientRect().top + window.scrollY - 52
                        window.scrollTo( { top: top, behavior: 'smooth' } )
                    }
                } )

                tocListEl.appendChild( li )
            } )

            // PRD-007 (#49): finer granularity — append "Offene Fragen" and
            // "Finalisierungs-Frage" entries when their anchors exist and are not
            // already represented by an h2 entry above.
            ;[ { id: 'offene-fragen', label: 'Offene Fragen' },
                { id: 'finalisierungs-frage', label: 'Finalisierungs-Frage' } ].forEach( function( extra ) {
                var target = document.getElementById( extra.id )
                if( !target ) { return }
                var already = tocListEl.querySelector( 'li[data-target="' + extra.id + '"]' )
                if( already ) { return }
                var li = document.createElement( 'li' )
                li.textContent = extra.label
                li.title = extra.label
                li.setAttribute( 'data-target', extra.id )
                li.addEventListener( 'click', function() {
                    var t = document.getElementById( this.getAttribute( 'data-target' ) )
                    if( t ) {
                        var top = t.getBoundingClientRect().top + window.scrollY - 52
                        window.scrollTo( { top: top, behavior: 'smooth' } )
                    }
                } )
                tocListEl.appendChild( li )
            } )

            updateActiveTOC()
        }

        function updateActiveTOC() {
            var items = tocListEl.querySelectorAll( 'li' )
            if( items.length === 0 ) { return }

            var activeItem = null

            // PRD-019: guarantee exactly one highlight — clear all first.
            // PRD-012 (Memo 076 H8, WI-112): the old code compared target.offsetTop (offsetParent-
            // relative) against window.scrollY+52 (document-relative) — a mismatch that highlighted the
            // wrong entry whenever a heading sat inside a positioned ancestor. Compare the viewport-
            // relative getBoundingClientRect().top against the 52px nav offset instead.
            items.forEach( function( li ) {
                li.classList.remove( 'toc-active' )
                var targetId = li.getAttribute( 'data-target' )
                var target = document.getElementById( targetId )

                if( target && target.getBoundingClientRect().top <= 52 ) {
                    activeItem = li
                }
            } )

            // Fallback: if nothing is above the fold, the first entry stays active (never zero).
            if( !activeItem ) {
                activeItem = items[ 0 ]
            }

            activeItem.classList.add( 'toc-active' )
            // PRD-012 (WI-112): scrollIntoView only when the active entry CHANGES, and WITHOUT smooth —
            // a smooth scrollIntoView on every scroll tick made the TOC jump/flicker continuously.
            if( activeItem !== lastActiveTocItem ) {
                lastActiveTocItem = activeItem
                activeItem.scrollIntoView( { block: 'nearest' } )
            }
        }

        window.addEventListener( 'scroll', function() {
            if( tocScrollTimer ) { clearTimeout( tocScrollTimer ) }
            tocScrollTimer = setTimeout( updateActiveTOC, 50 )
        } )

        var tocScrollTimer = null
        var lastActiveTocItem = null

        // PRD-019 + PRD-006 (#C8): scroll to the canonical "Offene Fragen" anchor. Prefer the
        // id="offene-fragen" node set by applyContentStructure (the exact H2) so deeplinks land on
        // the real section, not a chapter's H3 copy. Fall back to an exact-H2 text scan, then to
        // any h1-h4 match only as a last resort.
        function scrollToOpenQuestions() {
            var target = document.getElementById( 'offene-fragen' )
            if( !target ) {
                var headings = contentEl.querySelectorAll( 'h1, h2, h3, h4' )
                headings.forEach( function( h ) {
                    if( target ) { return }
                    if( isExactSectionH2( h ) ) { target = h }
                } )
                headings.forEach( function( h ) {
                    if( target ) { return }
                    if( /offene\s+fragen/i.test( h.textContent || '' ) ) { target = h }
                } )
            }
            if( target ) {
                var top = target.getBoundingClientRect().top + window.scrollY - 52
                window.scrollTo( { top: top, behavior: 'smooth' } )
            } else {
                window.scrollTo( { top: 0, behavior: 'smooth' } )
            }
        }

        function stripMarkdown( line ) {
            var result = line
            result = result.replace( /^#{1,6}\s+/, '' )
            result = result.replace( /^[-*+]\s+/, '' )
            result = result.replace( /^>\s+/, '' )
            result = result.replace( /^\d+\.\s+/, '' )
            result = result.replace( /\*\*/g, '' )
            result = result.replace( /\*/g, '' )
            result = result.replace( /~~([^~]+)~~/g, '$1' )
            result = result.replace( /\[([^\]]+)\]\([^)]+\)/g, '$1' )
            return result.trim()
        }

        // Memo 080, PRD-R5 (Kap 14, WI-171): the PURE assignment of removed lines to the chapters of
        // the CURRENT document, deliberately split off from the DOM insertion below — this is the part
        // that could silently drop a line, and it is unit-testable without a browser. It DECLARES how
        // many entries it placed (assignedCount) so the caller can hold that against
        // comparison.removedCount instead of trusting that red simply "showed up".
        //
        // An entry becomes an orphan when it has NO chapter (it stood before the first "## " — 6 of the
        // 43 removed lines in REV-17 -> REV-18 did) or when its chapter no longer exists in the current
        // document (renamed, deleted). Orphans get a collecting block at the end of the document.
        // NOTHING falls off the table: groups + orphans === removed.length, always.
        function groupRemovedLines( removed, chapterSlugs ) {
            var list = Array.isArray( removed ) ? removed : []
            var known = new Set( Array.isArray( chapterSlugs ) ? chapterSlugs : [] )
            var groups = []
            var index = new Map()
            var orphans = []

            list.forEach( function( entry ) {
                var chapter = ( entry && entry.chapter !== undefined ) ? entry.chapter : null
                var slug = ( chapter === null ) ? null : slugify( chapter )

                if( slug === null || slug === '' || !known.has( slug ) ) {
                    orphans.push( entry )
                    return
                }
                if( !index.has( slug ) ) {
                    index.set( slug, { slug: slug, entries: [] } )
                    groups.push( index.get( slug ) )
                }
                index.get( slug ).entries.push( entry )
            } )

            var placed = groups.reduce( function( sum, group ) { return sum + group.entries.length }, 0 )

            return { groups: groups, orphans: orphans, assignedCount: placed + orphans.length }
        }


        // Memo 080, PRD-R5 (Kap 14, WI-171): the markup of ONE removed-lines block. A removed line is
        // memo content, so it goes through escapeHtml and its line number through escapeAttr —
        // masking is a duty here, not polish: this very function's neighbour needed exactly that fix
        // once already for raw-interpolated filenames (PRD-012, Memo 076 WI-109).
        //
        // Every element is a div ON PURPOSE. The .diff-added pass selects p/li/h*/blockquote>p/td/th,
        // and a block built only from divs cannot enter that selector — so showing deletions cannot
        // disturb the marking of additions.
        function removedBlockMarkup( title, entries ) {
            var rows = entries.map( function( entry ) {
                var lineNo = String( entry.previousLineNumber )

                return '<div class="diff-removed" data-previous-line="' + escapeAttr( lineNo ) + '">'
                    + '<span class="diff-removed-no">' + escapeHtml( lineNo ) + '</span>'
                    + '<span class="diff-removed-text">' + escapeHtml( entry.line ) + '</span>'
                    + '</div>'
            } ).join( '' )

            return '<div class="diff-removed-block">'
                + '<div class="diff-removed-title">' + escapeHtml( title ) + '</div>'
                + rows
                + '</div>'
        }


        // Memo 080, PRD-R5 (Kap 14, WI-171): put the deleted lines into the DOCUMENT BODY, at the
        // chapter they vanished from — at the END of that chapter's section, i.e. directly before the
        // next h2. Chapter-less and vanished-chapter lines go into one collecting block at the very
        // end. Returns what it inserted so the count can be checked, never assumed.
        function renderRemovedBlocks( diff ) {
            var removed = ( diff && Array.isArray( diff.removed ) ) ? diff.removed : []

            if( removed.length === 0 ) { return { inserted: 0 } }

            var headings = []
            contentEl.querySelectorAll( 'h2' ).forEach( function( heading ) {
                if( heading.closest( '.diff-banner' ) ) { return }
                headings.push( heading )
            } )

            // PRD-015 (D5) again: the server chapter is a RAW memo string, the heading is RENDERED
            // text. Both sides go through the SAME slugify, or Umlaut/Em-dash drift loses the match.
            var slugs = headings.map( function( heading ) { return slugify( heading.textContent.trim() ) } )
            var grouped = groupRemovedLines( removed, slugs )

            var insertBlock = function( markup, before ) {
                var holder = document.createElement( 'div' )
                holder.innerHTML = markup
                var block = holder.firstChild

                if( before && before.parentNode ) { before.parentNode.insertBefore( block, before ) }
                else { contentEl.appendChild( block ) }
            }

            grouped.groups.forEach( function( group ) {
                var at = slugs.indexOf( group.slug )
                var title = 'Aus diesem Kapitel entfernt (' + group.entries.length + ' Zeilen)'

                insertBlock( removedBlockMarkup( title, group.entries ), headings[ at + 1 ] )
            } )

            if( grouped.orphans.length > 0 ) {
                var tailTitle = 'Entfernt, ohne Kapitel im aktuellen Stand (' + grouped.orphans.length + ' Zeilen)'

                insertBlock( removedBlockMarkup( tailTitle, grouped.orphans ), null )
            }

            return { inserted: grouped.assignedCount }
        }


        function renderDiffView( content, diff ) {
            var banner = '<div class="diff-banner">'
            // PRD-012 (Memo 076 H8, WI-109): the filenames come from the filesystem and were
            // interpolated raw, unlike the neighbouring skippedUpdates/changedSections which are
            // escaped. Run them through escapeHtml too so a "<"/">" in a filename cannot inject HTML.
            if( diff.currentFullFile && diff.previousFile ) {
                banner += 'Vergleich Full &harr; Full: <strong>' + escapeHtml( diff.currentFullFile ) + '</strong> vs <strong>' + escapeHtml( diff.previousFile ) + '</strong>'
            } else {
                banner += 'Vergleich mit: <strong>' + escapeHtml( diff.previousFile ) + '</strong>'
            }

            // Memo 080, PRD-R5 (Kap 14, WI-171): the comparison verdict — ALWAYS, and BEFORE every
            // conditional banner part below. Until now the view coloured additions only, so a deletion
            // was invisible; and worse, a comparison WITHOUT a finding looked exactly like a comparison
            // without a basis. The three states come from ONE implementation (MemoView.diffSummary) and
            // travel inside the verdict, so no second copy lives over here to drift from it. The unit
            // is never spelled out here either — it comes from comparison.mode, which is the single
            // point a later entity comparison attaches to.
            //   verdict / empty -> muted, the empty set states its comparison size and is NOT silence
            //   missing-basis   -> carried as a DEFECT, never as reassurance
            // A payload without a verdict IS the defect case: an unstated comparison basis is exactly
            // what this must never look calm about.
            var summary = ( diff.comparison && diff.comparison.summary )
                ? diff.comparison.summary
                : { state: 'missing-basis', text: 'Vergleichsgrundlage fehlt — dieser Befund traegt nicht' }
            var summaryColor = summary.state === 'missing-basis' ? 'var(--danger)' : '#8b949e'
            banner += '<br><span class="diff-comparison" data-state="' + escapeAttr( summary.state ) + '"'
                + ' style="color:' + summaryColor + ';font-size:0.85em">' + escapeHtml( summary.text ) + '</span>'

            if( diff.skippedUpdates && diff.skippedUpdates.length > 0 ) {
                // PRD-015 (D10): skipped-update names come from content -> escape before interpolating.
                var skippedLabels = diff.skippedUpdates.map( function( u ) { return escapeHtml( u ) } )
                banner += '<br><span style="color:#8b949e;font-size:0.85em">' + diff.skippedUpdates.length + ' Update(s) uebersprungen: ' + skippedLabels.join( ', ' ) + '</span>'
            }

            // PRD-R4 (Memo 080, Kap 14): the comparison banner answers "what disappeared?" — the
            // question the green diff never asks. Three states that must not look alike:
            //   continuity absent      -> nothing is said (an older server sends no such field)
            //   warnings present       -> the comparison basis line + one line per warning
            //   warnings empty         -> the comparison basis alone, so a clean verdict still
            //                             states HOW MANY chapters it rests on
            // Additive to the banner only; the document body and changedSections stay untouched.
            if( diff.continuity ) {
                var continuityWarnings = diff.continuity.warnings || []
                banner += '<br><span style="color:#8b949e;font-size:0.85em">Vollstaendigkeit: '
                    + escapeHtml( String( diff.continuity.comparedChapters ) ) + ' Kapitel verglichen</span>'
                banner += continuityWarnings.map( function( w ) {
                    return '<br><span style="color:#d29922;font-size:0.85em">' + escapeHtml( w ) + '</span>'
                } ).join( '' )
            }

            if( diff.changedSections && diff.changedSections.length > 0 ) {
                banner += '<br>Geaenderte Kapitel: '
                banner += diff.changedSections.map( function( s ) {
                    // PRD-007 (D3): the SAME slugify that builds heading ids — so the banner anchor
                    // always equals the heading anchor (Umlaut/Em-dash/punctuation safe).
                    var id = slugify( s )
                    // PRD-012 (Memo 076 H8, WI-110): render a <button> (keyboard-focusable, no inline
                    // onclick — CSP-safe) instead of an <a> with an inline onclick string. The click is
                    // wired via addEventListener after the banner is inserted (below). The chapter label
                    // is memo content -> escapeHtml; the slug id -> escapeAttr.
                    return '<button type="button" class="diff-chapter-link" data-target="' + escapeAttr( id ) + '">' + escapeHtml( s ) + '</button>'
                } ).join( ', ' )
            }

            banner += '</div>'

            slugCounts.clear()
            var html = marked.parse( content )

            // PRD-018 (Kap 13): rendered-vs-rendered. The previous side must run through the
            // SAME render pipeline (marked.parse) and use the SAME block selector as the
            // current side, otherwise rendered-block-text is compared against raw stripped
            // lines and almost everything is flagged green (systematic false positives).
            // Selector includes td, th so unchanged table cells are not marked added either.
            var diffBlockSelector = 'p, li, h1, h2, h3, h4, h5, h6, blockquote > p, td, th'

            function collectBlockTexts( rootEl ) {
                var set = new Set()
                rootEl.querySelectorAll( diffBlockSelector ).forEach( function( el ) {
                    if( el.closest( '.diff-banner' ) ) { return }
                    if( closestDiagram( el ) ) { return }
                    if( el.closest( 'pre' ) ) { return }

                    var text = el.textContent.trim()
                    if( text.length <= 2 ) { return }
                    set.add( text )
                } )
                return set
            }

            // Memo 081, WI-105: the previous side no longer arrives as raw markdown to be parsed a
            // second time in the browser. The server ships previousBlockTexts — the SAME set this code
            // used to build here, formed by the SAME rule (MemoView.collectBlockTexts). With it go the
            // throwaway container, the second marked.parse and the slugCounts rescue that only existed
            // because of them. A null value means "not built", which is a different statement from
            // "built and empty": on null every block stays UNMARKED rather than every block being
            // marked new, because a missing comparison basis must not look like a comparison that found
            // everything changed.
            var previousTextSet = new Set()
            if( Array.isArray( diff.previousBlockTexts ) ) {
                diff.previousBlockTexts.forEach( function( text ) { previousTextSet.add( text ) } )
            }

            // PRD-018: changedSections is the server-side, reliable chapter granularity.
            // When present, only blocks living under a changed H2 are eligible for the
            // .diff-added marker — this further suppresses false positives in unchanged
            // chapters. When absent, fall back to plain rendered-vs-rendered text equality.
            // PRD-015 (D5): changedSections are RAW server strings; the chapter we compare against
            // below (currentChapter) is RENDERED heading text. Comparing raw vs rendered drifts on
            // Umlaut/Em-dash/punctuation. Normalise BOTH sides through the shared slugify so a chapter
            // matches its rendered heading regardless of how marked rewrote the inline text.
            var changedSectionSet = new Set()
            if( diff.changedSections ) {
                diff.changedSections.forEach( function( s ) { changedSectionSet.add( slugify( s ) ) } )
            }

            contentEl.innerHTML = banner + html
            interceptLinks()
            // PRD-012 (Memo 076 H8, WI-110): wire the changed-chapter buttons now that the banner is
            // in the DOM — null-guard the target (a renumbered/removed chapter has no heading node).
            contentEl.querySelectorAll( '.diff-banner .diff-chapter-link' ).forEach( function( btn ) {
                btn.addEventListener( 'click', function() {
                    var t = document.getElementById( btn.getAttribute( 'data-target' ) )
                    if( t ) { t.scrollIntoView( { behavior: 'smooth' } ) }
                } )
            } )

            renderAllDiagrams()

            if( previousTextSet.size > 0 ) {
                // Track the nearest preceding H2 chapter so changedSections can gate marking.
                var currentChapter = ''
                contentEl.querySelectorAll( diffBlockSelector + ', h2' ).forEach( function( el ) {
                    if( el.closest( '.diff-banner' ) ) { return }
                    if( closestDiagram( el ) ) { return }
                    if( el.closest( 'pre' ) ) { return }

                    if( el.tagName === 'H2' ) {
                        currentChapter = el.textContent.trim()
                        return
                    }

                    var text = el.textContent.trim()
                    if( text.length <= 2 ) { return }

                    // rendered-vs-rendered: already present on the previous side -> unchanged.
                    if( previousTextSet.has( text ) ) { return }

                    // When changedSections is available, only mark blocks inside a changed
                    // chapter — server-side granularity beats fuzzy text equality.
                    // PRD-015 (D5): compare the slugified rendered chapter against the slugified set.
                    if( changedSectionSet.size > 0 && !changedSectionSet.has( slugify( currentChapter ) ) ) { return }

                    el.classList.add( 'diff-added' )
                } )
            }

            // Memo 080, PRD-R5 (Kap 14, WI-171): the deleted lines go in LAST — after the .diff-added
            // pass has run — so that pass walks exactly the DOM it walked before this PRD existed.
            // Showing what disappeared must not change what is marked as added.
            renderRemovedBlocks( diff )
        }

        // PRD-V4 (Memo 080 Kap 16, WI-175): the decision core of interceptLinks, extracted as a pure
        // function. The old gate tested the RAW href for the string '.md', so a percent-encoded or
        // backtick-wrapped address (`%60context/foo.md%60`) missed the in-app path and fell through to
        // a real browser navigation onto the server 404 page. Normalise FIRST, then decide:
        //   external  http/https/mailto/tel and any other scheme  -> untouched
        //   anchor    starts with '#'                             -> untouched (TOC, footnote back-jump)
        //   route     starts with '/'                             -> untouched (SPA routes /memos, /specs)
        //   doc       document-relative, normalises to a .md path -> in-app navigation
        //   dead      document-relative, anything else            -> swallowed, no browser navigation
        function classifyLinkHref( href ) {
            var raw = String( href == null ? '' : href ).trim()
            var decoded = raw
            try {
                decoded = decodeURIComponent( raw )
            } catch( e ) {
                // A malformed percent sequence throws URIError — fall back to the raw value.
                decoded = raw
            }
            var target = decoded.trim().replace( /^`+/, '' ).replace( /`+$/, '' ).trim()

            if( target.length === 0 ) { return { href: target, kind: 'none' } }
            if( target.charAt( 0 ) === '#' ) { return { href: target, kind: 'anchor' } }
            if( target.charAt( 0 ) === '/' ) { return { href: target, kind: 'route' } }
            if( /^[a-z][a-z0-9+.-]*:/i.test( target ) ) { return { href: target, kind: 'external' } }
            if( target.split( '#' )[ 0 ].split( '?' )[ 0 ].endsWith( '.md' ) ) { return { href: target, kind: 'doc' } }

            return { href: target, kind: 'dead' }
        }

        function interceptLinks() {
            contentEl.querySelectorAll( 'a' ).forEach( function( link ) {
                const decision = classifyLinkHref( link.getAttribute( 'href' ) )

                if( decision.kind === 'none' ) { return }
                if( decision.kind === 'external' || decision.kind === 'anchor' || decision.kind === 'route' ) { return }

                link.addEventListener( 'click', function( e ) {
                    // A document-relative link can no longer leave the viewer: a 'doc' goes into the
                    // in-app navigation, a 'dead' one is swallowed instead of hitting the 404 page.
                    e.preventDefault()

                    if( decision.kind !== 'doc' ) { return }

                    // PRD-V6 (Memo 080 Kap 16, WI-177): inside an open memo a document-relative .md link
                    // is a DEEPER LEVEL of that memo, so it opens as an overlay instead of navigating the
                    // whole viewer away. The fragment/query is dropped for the read — classifyLinkHref
                    // decided 'doc' on exactly that stem. Without an open memo the navigate branch stays.
                    var stem = decision.href.split( '#' )[ 0 ].split( '?' )[ 0 ]
                    if( currentDocumentId && isResearchOverlayPath( stem ) ) {
                        openResearchOverlay( stem )

                        return
                    }

                    if( !currentWs ) { return }
                    currentWs.send( JSON.stringify( { type: 'navigate', path: decision.href } ) )
                    window.scrollTo( 0, 0 )
                } )
            } )
        }

        // PRD-V3 (Memo 080, Kap 15 / WI-104): the LAUFZEIT-STATUS line, built as a PURE function of the
        // `runtimeStatus` message so it can be measured without a DOM.
        //
        // Returns { html, gap }. `gap` is true for the honest case the memo names: the rollout state is NOT
        // in the database. `phases: 0, workItems: 0` reads exactly like a finished rollout with nothing left,
        // so a bare "0 von 0" would look green while NOTHING was ever compared — with rolloutInDb false the
        // line says so in words instead of printing a null balance.
        //
        // Every value passes through escapeHtml: `entity`, `entityId` and `at` come out of the database and
        // are put into markup here.
        function buildRuntimeStatusLine( data ) {
            var payload = data || {}
            var latest = payload.latest || null
            var seq = typeof payload.seq === 'number' ? payload.seq : 0
            var parts = [ 'DB #' + escapeHtml( seq ) ]

            if( latest !== null ) {
                var kind = latest.entity == null ? '—' : latest.entity
                var subject = latest.entityId == null ? '' : latest.entityId
                parts.push( escapeHtml( kind ) + ( subject.length === 0 ? '' : ' ' + escapeHtml( subject ) ) )
                if( latest.at != null ) { parts.push( escapeHtml( latest.at ) ) }
            }

            var gap = payload.rolloutInDb !== true

            parts.push( gap === true
                ? 'Rollout-Zustand nicht in der Datenbank'
                : escapeHtml( payload.phases ) + ' Phasen · ' + escapeHtml( payload.workItems ) + ' PRDs' )

            return { html: parts.join( ' · ' ), gap: gap }
        }


        // Write the line into the head bar. No re-render of the revision view, no scroll intervention —
        // the whole point of the tracer is that the number appears WITHOUT the page moving.
        function renderRuntimeStatus( data ) {
            var host = document.getElementById( 'runtime-status' )

            if( !host ) { return }

            var line = buildRuntimeStatusLine( data )
            host.innerHTML = line.html
            host.title = line.gap === true
                ? 'Die Rollout-Tabellen der Memo-Datenbank sind leer — es wurde nichts verglichen.'
                : 'Laufzeit-Status aus dem Verlaufs-Journal der Memo-Datenbank.'
            host.classList.toggle( 'runtime-status-gap', line.gap === true )
        }


        function connect() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
            // Memo 081, WI-066: the socket carries the CURRENT path so the server can honour a document
            // address on connect. A path in a WebSocket URL is legal and the upgrade ignores it — it is
            // transport, nothing else. Read live at every (re)connect, never frozen at start: a value
            // taken once and used later is the two-timepoints form PRD-29 just removed from this file.
            const ws = new WebSocket( protocol + '//' + location.host + window.location.pathname )
            currentWs = ws

            ws.onopen = function() {
                updateConnectionStatus( 'connected' )
                reconnectAttempts = 0

                if( reconnectTimer ) {
                    clearTimeout( reconnectTimer )
                    reconnectTimer = null
                }
            }

            ws.onmessage = function( event ) {
                // PRD-009 (Memo 076 H6, WI-082): a malformed (non-JSON) frame must not throw an
                // unhandled exception that kills the onmessage handler — ignore it and keep the
                // live updates running.
                let data
                try {
                    data = JSON.parse( event.data )
                } catch ( err ) {
                    return
                }

                // PRD-009 (Memo 076 H6, WI-080): build-ID handshake. The server sends its current
                // bundle hash on connect. If this page was rendered from an OLDER bundle, reload to
                // pick up the new client (this is what stops a restarted server's stale tabs from
                // polling the removed /api/session + /api/cockpit routes).
                //
                // Memo 081 (WI-068): the reload is throttled to ONCE per build-ID pair. The server side
                // of this defect is fixed (the page is no longer frozen at boot), but the throttle is
                // not a second fix of the same case — it closes the CLASS. An unconditional reload on
                // mismatch turns ANY future source of disagreement — an interposed cache, a tab out of
                // the bfcache, a second process on the same port — back into the measured 100 % loop.
                // If a reload does NOT resolve the mismatch, the assumption "one reload fetches the new
                // client" is refuted, and then the right move is the one /api/health makes: report the
                // disagreement, do not act on it. The marker has to survive the reload that it throttles
                // (a reload discards every variable in memory), so it lives in sessionStorage, and it
                // carries BOTH ids so a later, genuinely new build is not throttled along with it.
                // The decision itself is a PURE function, deliberately: a reload cannot be observed
                // from inside the page that performs it, so the only way to prove both directions —
                // it throttles, and it does not throttle too much — is to decide separately from
                // acting. `attempt` names the PAIR (old id -> new id), not just the new id: a later,
                // genuinely new build must not be throttled along with the one before it.
                function decideBuildReload( pageBuild, serverId, lastAttempt ) {
                    if( !serverId || !pageBuild || serverId === pageBuild ) { return { action: 'none', attempt: null } }

                    var attempt = pageBuild + '->' + serverId

                    if( lastAttempt === attempt ) { return { action: 'warn', attempt: attempt } }

                    return { action: 'reload', attempt: attempt }
                }

                if( data.type === 'build' ) {
                    var lastAttempt = null

                    // A sandboxed or storage-blocked context throws on access. This is not a silent
                    // default: with no storage there is no throttle to read, and falling back to the
                    // pre-081 behaviour (reload once) is the honest answer.
                    try { lastAttempt = sessionStorage.getItem( 'memoViewBuildReload' ) } catch ( err ) { lastAttempt = null }

                    var decision = decideBuildReload( window.__MEMO_VIEW_BUILD__, data.id, lastAttempt )

                    if( decision.action === 'reload' ) {
                        try { sessionStorage.setItem( 'memoViewBuildReload', decision.attempt ) } catch ( err ) { /* storage blocked — reload once, unthrottled */ }
                        location.reload()
                    }

                    if( decision.action === 'warn' ) {
                        // The measured defect left NO JS error and NO failed request — it was invisible
                        // to every error console. From here on it is not.
                        console.warn( 'memo-view: build handshake still disagrees after a reload — page was rendered with ' + window.__MEMO_VIEW_BUILD__ + ', server is serving ' + data.id + '. Not reloading again.' )
                        statusEl.title = 'Server verbunden, aber der Build weicht ab: Seite ' + window.__MEMO_VIEW_BUILD__ + ', Server ' + data.id + '. Server neu starten.'
                    }

                    return
                }

                if( data.type === 'pushHistory' ) {
                    history.push( data.path )
                }

                if( data.type === 'documentList' ) {
                    lastTree = data.tree || {}
                    lastLatest = data.latest || []
                    // Memo 081, WI-106: book the depth this payload actually brought — read off the
                    // payload itself (revisionsIncluded), never off the request we sent. A request that
                    // was answered with less than it asked for must leave the loading row standing, and
                    // a pending flag cleared by hope instead of by evidence is how a spinner becomes
                    // permanent.
                    Object.keys( lastTree ).forEach( function( pId ) {
                        var node = lastTree[ pId ]
                        var list = ( node && node.memos ) ? node.memos : ( Array.isArray( node ) ? node : [] )
                        var included = list.length > 0 && list.every( function( m ) { return m && m.revisionsIncluded === true } )
                        if( included ) { scopedProjects.add( pId ) } else { scopedProjects.delete( pId ) }
                        pendingScopeProjects.delete( pId )
                    } )
                    // Memo 081, D1: `comparison` now reaches this message (it was built by PRD-35 and
                    // dropped two lines later by its only caller, so the payload carried three keys and
                    // no explanation). It is deliberately NOT stashed in a client variable here:
                    // measured, `lastLatest` has no rendered surface in this client at all — it feeds
                    // computeSidebarSignature and nothing else — so a reader would be a variable nobody
                    // reads, which is the defect D1 describes rather than its repair.
                    if( currentMode === 'memos' ) {
                        renderSidebar()
                    }
                    // WI-070 (PRD-076, Phase 4): the server emits no dedicated specList broadcast, so
                    // the Specs tree rides on the documentList broadcast (a filesystem change). Refresh
                    // it live while in Specs mode — reselect=false keeps the open page + scroll, and
                    // the version/collapse choices persist (selectedVersion map + collapsedSpec* Sets).
                    if( currentMode === 'specs' ) {
                        loadSpecs()
                    }
                }

                if( data.type === 'transcriptList' ) {
                    lastTranscriptTree = data.tree || {}
                    // PRD-016 (Memo 016 Kap 6.3) Auto-Move: a fresh transcript can push a memo
                    // out of the queue, so the memos sidebar (which renders the queue) must
                    // re-render here — not only the transcript indicators.
                    // PRD-016 (Memo 072 WI-T011-4): the Transcripts tab now renders the server
                    // tree too (renderSidebarTranscripts consumes lastTranscriptTree), so it must
                    // re-render on a fresh broadcast as well. renderSidebar() dispatches per mode
                    // (memos: memos + indicators; transcripts: the namespace tree).
                    renderSidebar()
                    // PRD-005 (Kap 8): an einloggen/ausloggen change updates the per-revision
                    // loggedIn flag in the tree — refresh the sticky-header status row so the
                    // status pill + button label reflect the new state without a page reload.
                    // PRD-001 (Memo 076, Phase 1, WI-047): only in the memos view — a transcriptList
                    // broadcast must not inject the memo sticky header while browsing clients/specs.
                    if( currentMode === 'memos' ) {
                        updateSidebarSticky( currentMemoName, currentFileName )
                    }
                }

                // PRD-005 (Memo 018 Kap 8 AC-7): dedicated login/logout broadcast. The status
                // refresh itself rides on the transcriptList message above; this branch keeps the
                // event observable for the integration/UI tests and future client-side hooks.
                if( data.type === 'transcriptLoggedIn' || data.type === 'transcriptLoggedOut' ) {
                    // EVENT-HOOK (client): future — surface a toast / drive an agent loop here.
                    // PRD-001 (Memo 076, Phase 1, WI-048): gate the sticky-header refresh to the
                    // memos view so a login/logout broadcast cannot inject the memo header in
                    // clients/specs.
                    if( currentMode === 'memos' ) {
                        updateSidebarSticky( currentMemoName, currentFileName )
                    }
                }

                // PRD-P3-02 (Memo 075 Phase 3, WI-009): the client-registry broadcast. Refresh the head
                // summary always; re-render the Clients view only while it is the active mode (no reload).
                if( data.type === 'clientList' ) {
                    lastClients = data.clients || []
                    renderClientsSummary( lastClients )
                    // PRD-002 (Memo 076, Phase 1): Clients is an overlay now, not a mode — re-render the
                    // popup only while it is OPEN so a live broadcast keeps it fresh without a reload.
                    if( isClientsModalOpen() ) {
                        renderClientsModal()
                    }
                    // PRD-002 (Memo 076, Phase 1, WI-046): a client (de)registration can change the
                    // instance chip for the displayed memo — refresh the memo sticky header in memos mode.
                    if( currentMode === 'memos' ) {
                        updateSidebarSticky( currentMemoName, currentFileName )
                    }
                }

                // PRD-P3-04/05/06 (Memo 075 Phase 3, WI-012/013): the annotation-list broadcast. Adopt
                // the fresh set for the discussed document and re-run the idempotent render pass so new
                // annotations appear as marks/badges without a reload.
                if( data.type === 'annotationList' ) {
                    if( !data.documentId || data.documentId === currentDocumentId ) {
                        lastAnnotations = data.annotations || []
                        applyAnnotations()
                    }
                }

                // PRD-V3 (Memo 080, Kap 15 / WI-104): the runtime-status broadcast. Additive — none of the
                // eight existing message types is touched. The server sends it to EVERY connected client
                // (MemoView broadcasts over wss.clients), and the message names the document it belongs to,
                // so the branch has to ask the same question its annotationList sibling above asks: is this
                // about the document on screen? Without it a write into document B paints B's figures into
                // the head bar of document A. "The sequence has grown" answers WHETHER something was sent,
                // never TO WHICH document the number belongs. Same spelling as the sibling on purpose.
                if( data.type === 'runtimeStatus' ) {
                    if( !data.documentId || data.documentId === currentDocumentId ) {
                        renderRuntimeStatus( data )
                    }
                }

                if( data.type === 'content' ) {
                    // notification sound disabled in server mode
                    isFirstLoad = false
                    const scrollY = data.preserveScroll ? window.scrollY : 0
                    // PRD-018 (Memo 072 Kap 13, F10=A): adopt the incoming documentId BEFORE the render
                    // pipeline runs — applyContentStructure() -> applyTopicPillsFromStore reads
                    // currentDocumentId to fetch the STORE, and the canonical assignment below sits AFTER
                    // applyContentStructure (inside `if( data.fileName )`), so without this the pills
                    // would fetch the previous doc's topics.
                    if( data.documentId ) { currentDocumentId = data.documentId }
                    lastContent = data.content
                    lastQuestionSchema = data.questionSchema || []
                    lastVorwort = data.vorwort || ''
                    // PRD-Q3 (Memo 080, Kap 25): adopt the validator result of THIS broadcast. No
                    // `|| {}` fallback on purpose — a missing/failed validation must stay null so
                    // the band can state the gap instead of showing an empty, reassuring strip.
                    lastValidation = data.validation === undefined ? null : data.validation
                    // Memo 081, WI-105: a content message no longer carries the diff — it carries the
                    // ANNOUNCEMENT. The payload of the PREVIOUS revision is dropped here (it belongs to
                    // a revision that is no longer on screen), and showDiff is NOT touched: the reader's
                    // choice survives the click that used to overwrite it. What the message decides is
                    // only whether the toggle is offered.
                    currentDiff = null
                    currentDiffKey = null
                    requestedDiffKey = null
                    diffAvailable = data.diffAvailable === true
                    diffInfo = data.diffInfo || null
                    // The diff-toggle now lives in the sticky header and is (re)bound there
                    // via updateSidebarSticky -> bindDiffToggle (called later in this handler).

                    // PRD-009 (Memo 016 Kap 7, E7/F10): only the prose/memo home view may have its
                    // #content redrawn by a broadcast. With a requirements/blocks panel open the
                    // re-render is GATED OFF so the open panel survives — the snapshots above
                    // (lastContent/diff/vorwort/questions) are already refreshed, so a later
                    // toggle-off restores the fresh prose without a destructive reset of the panel.
                    if( shouldRerenderOnBroadcast( currentContentView ) ) {
                        // PRD-017 (Memo 072, Phase 5): the Specs view owns #content; a memo content
                        // broadcast must NOT overwrite the open spec page. The snapshots above
                        // (lastContent/diff/vorwort/questions) are already refreshed, so leaving Specs
                        // (applyMode('memos')) restores the fresh memo prose without a page reload.
                        // PRD-002 (Memo 076, Phase 1, F10): Clients is no longer a mode that owns #content
                        // — it is an overlay-popup floating over the memo, so the memo body SHOULD keep
                        // re-rendering behind it. Only Specs still owns #content.
                        if( currentMode !== 'specs' ) {
                            if( showDiff && currentDiff ) {
                                renderDiffView( data.content, currentDiff )
                            } else {
                                slugCounts.clear()
                                // PRD-V4 (Memo 080 Kap 16): same single prose render path as renderProseContent.
                                contentEl.innerHTML = renderMarkdownWithFootnotes( data.content ).html
                                wireFootnoteRefs( contentEl )
                                interceptLinks()

                                renderAllDiagrams()
                            }

                            applyContentStructure()
                            renderVorwort( lastVorwort )
                            renderFormHints( lastValidation )
                            renderQuestionWidgets( lastQuestionSchema )
                            buildTOC( currentDiff )

                            // PRD-019: deep-link from questions icon -> scroll to "Offene Fragen" section.
                            if( pendingQuestionsScroll ) {
                                pendingQuestionsScroll = false
                                scrollToOpenQuestions()
                            } else {
                                window.scrollTo( 0, scrollY )
                            }
                        }
                    }

                    if( data.fileName ) {
                        currentFileName = data.fileName
                        // Memo 079 M3=A (T059): a real revision content broadcast means we left any research
                        // view — clear the research scope so annotations bind to the revision again.
                        currentResearchFile = null
                        currentMemoName = data.memoName || ''
                        currentDocumentId = data.documentId || currentDocumentId
                        // The sticky-header refresh is already neutralized by the generalized
                        // updateSidebarSticky mode-guard (returns outside memos); the snapshots
                        // above stay so a later applyMode('memos') restores the prose without a reload.
                        updateSidebarSticky( data.memoName, data.fileName )
                        // PRD-001 (Memo 076, Phase 1, WI-043): the document.title rewrite must not
                        // stamp a FOREIGN memo name onto the tab while the user is in clients/specs/
                        // transcripts. Only rewrite the title in the memos view; the reader in a
                        // non-memos mode keeps its own title (spec page / clients overlay context).
                        if( currentMode === 'memos' ) {
                            var h1 = contentEl.querySelector( 'h1' )
                            var heading = h1 ? h1.textContent.trim() : data.fileName
                            var portEmojis = { '3333': '🔵', '4444': '🟢', '5555': '🟠', '6666': '🔴', '7777': '🟣', '8888': '🩵' }
                            var portEmoji = portEmojis[ window.location.port ] || '⚪'
                            var versionMatch = data.fileName ? data.fileName.match( /v(\d+\.\d+)/ ) : null
                            var revSuffix = versionMatch ? ' #v' + versionMatch[1] : ''
                            // WI-027 (Memo 076): the port NUMBER is redundant to the colour-coded portEmoji
                            // (favicon-style port indicator), so it is dropped from the tab title — the emoji
                            // alone carries the port. Title = "<emoji> <heading>[ #vX.Y]".
                            document.title = portEmoji + ' ' + heading + revSuffix
                        }
                        // PRD-P3-05/06 (Memo 075 Phase 3, WI-012/013): load this revision's annotations
                        // and run the render pass now that the document + revision are known.
                        refreshAnnotations()
                        // PRD-31 (Memo 081, WI-118): same place, same reason — currentFileName is only
                        // assigned in THIS branch, and currentRevisionId() reads it, so a load started
                        // before this point would ask for the PREVIOUS revision's state.
                        refreshQuestionState()
                        // Memo 081, WI-105: a reader who left the diff view ON gets it back without a
                        // second click — the request goes out as soon as the pair is known. A reader who
                        // left it off sends nothing at all, which is the whole point of the change.
                        if( showDiff ) { requestDiffIfNeeded() }
                    }
                }

                // Memo 081, WI-105: the answer to requestDiff. The echoed pair is checked against the
                // revision on screen BEFORE anything is rendered — a late answer for a revision the
                // reader has already left is dropped, never painted over the current one. `diff: null`
                // with a named reason is an answer too: the view says why it is empty instead of waiting
                // silently for something that will not come.
                if( data.type === 'diff' ) {
                    if( !data.documentId || data.documentId === currentDocumentId ) {
                        // The line above is the ONE document guard this client uses for every
                        // document-scoped message (RuntimeStatusFeedPRDV3 measures that there is no second
                        // spelling — a private one here was written first and the class detector found it).
                        // A diff needs a SECOND half the other messages do not: it belongs to a REVISION,
                        // not only to a document, so an answer for the right document but the revision the
                        // reader has already left is dropped as well.
                        if( data.fileName !== currentFileName ) { return }

                        var answeredKey = data.documentId + '::' + data.fileName
                        currentDiff = data.diff || null
                        currentDiffKey = answeredKey
                        requestedDiffKey = null

                        if( currentDiff === null ) {
                            // Named, not silent: the toggle goes inactive and says WHY on hover, instead
                            // of leaving the reader before an empty view waiting for an answer that came.
                            var reasonText = 'Kein Diff verfügbar' + ( data.reason ? ' — ' + data.reason : '' )
                            var toggleEl = document.getElementById( 'diff-toggle' )
                            showDiff = false
                            if( toggleEl ) {
                                toggleEl.classList.remove( 'active' )
                                toggleEl.title = reasonText
                            }
                            console.warn( reasonText )

                            return
                        }

                        if( showDiff && shouldRerenderOnBroadcast( currentContentView ) && currentMode !== 'specs' ) {
                            renderProseContent( true )
                        }
                    }
                }
            }

            ws.onclose = function() {
                currentWs = null
                reconnectAttempts++

                // PRD-016 (Memo 016, E9): show the offline indicator from the FIRST failed
                // attempt (was >= 2). updateConnectionStatus -> offlineBannerVisible drives the
                // visible banner. The E1 backoff/cap below is untouched: visibility is a separate
                // concern from when reconnect stops.
                if( reconnectAttempts >= 1 ) {
                    updateConnectionStatus( 'offline' )
                }

                if( reconnectAttempts > MAX_RECONNECT_ATTEMPTS ) {
                    // E1: stop hammering — the server is gone. A page reload re-arms reconnect.
                    return
                }

                if( !reconnectTimer ) {
                    const delay = Math.min( RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow( 2, reconnectAttempts - 1 ) )
                    reconnectTimer = setTimeout( function() {
                        reconnectTimer = null
                        connect()
                    }, delay )
                }
            }

            ws.onerror = function() {
                // E10: do not double-count attempts — onclose owns the increment/backoff.
                if( currentWs ) { currentWs.close() }
            }
        }

        (function setFavicon() {
            var colors = { '3333': '#4493f8', '4444': '#3fb950', '5555': '#d29922', '6666': '#f85149', '7777': '#a371f7', '8888': '#39d2c0' }
            var color = colors[ window.location.port ] || '#8b949e'
            var canvas = document.createElement( 'canvas' )
            canvas.width = 64
            canvas.height = 64
            var ctx = canvas.getContext( '2d' )
            ctx.fillStyle = '#0d1117'
            ctx.beginPath()
            // PRD-009 (Memo 076 H6, WI-084): ctx.roundRect exists only from Safari 16.4+. Calling it
            // ungeguarded threw before connect() ran below, killing the whole live-update + modal
            // wiring on older browsers. Feature-detect and fall back to a square favicon.
            if( typeof ctx.roundRect === 'function' ) {
                ctx.roundRect( 0, 0, 64, 64, 12 )
            } else {
                ctx.rect( 0, 0, 64, 64 )
            }
            ctx.fill()
            ctx.fillStyle = color
            ctx.font = 'bold 40px -apple-system, sans-serif'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText( 'M', 32, 35 )
            var link = document.getElementById( 'favicon' )
            link.href = canvas.toDataURL( 'image/png' )
        })()

        connect()

        var mermaidModal = document.getElementById( 'mermaid-modal' )
        var mermaidModalSvg = document.getElementById( 'mermaid-modal-svg' )

        window.openMermaidModal = function( svgContent ) {
            mermaidModalSvg.innerHTML = svgContent
            var svg = mermaidModalSvg.querySelector( 'svg' )
            if( svg ) {
                var vb = svg.getAttribute( 'viewBox' )
                if( !vb ) {
                    var w = svg.getAttribute( 'width' ) || '800'
                    var h = svg.getAttribute( 'height' ) || '600'
                    svg.setAttribute( 'viewBox', '0 0 ' + parseFloat(w) + ' ' + parseFloat(h) )
                }
                svg.removeAttribute( 'width' )
                svg.removeAttribute( 'height' )
                svg.style.width = '100%'
                svg.style.height = '100%'
            }
            mermaidModal.classList.add( 'open' )
            document.body.style.overflow = 'hidden'
        }

        window.closeMermaidModal = function() {
            mermaidModal.classList.remove( 'open' )
            document.body.style.overflow = ''
        }

        // Memo 038 Kap 11: image lightbox. A content image opens the SAME full-view modal as a
        // diagram — the modal body (#mermaid-modal-svg) holds an <img> instead of an SVG. Close,
        // Esc, and overlay-click reuse the existing diagram-modal handlers (closeMermaidModal).
        window.openImageModal = function( src, alt ) {
            if( !src ) { return }
            mermaidModalSvg.innerHTML = ''
            var img = document.createElement( 'img' )
            img.setAttribute( 'src', src )
            img.setAttribute( 'alt', typeof alt === 'string' ? alt : '' )
            img.style.maxWidth = '100%'
            img.style.maxHeight = '100%'
            mermaidModalSvg.appendChild( img )
            mermaidModal.classList.add( 'open' )
            document.body.style.overflow = 'hidden'
        }

        // PRD-013 (Memo 016, F8): the formerly inline on* handlers of #mermaid-modal
        // (onclick=closeMermaidModal on the overlay + close button, onclick=stopPropagation on
        // the inner box) are now wired here via addEventListener — identical behavior.
        mermaidModal.addEventListener( 'click', function() { closeMermaidModal() } )
        var mermaidModalInner = document.getElementById( 'mermaid-modal-inner' )
        if( mermaidModalInner ) {
            mermaidModalInner.addEventListener( 'click', function( e ) { e.stopPropagation() } )
        }
        var mermaidModalClose = document.getElementById( 'mermaid-modal-close' )
        if( mermaidModalClose ) {
            mermaidModalClose.addEventListener( 'click', function() { closeMermaidModal() } )
        }

        document.addEventListener( 'keydown', function( e ) {
            if( e.key === 'Escape' ) { closeMermaidModal() }
        } )

        // Memo 020 Kap 5/6: clicking ANY rendered diagram (mermaid or vega-lite) opens the shared
        // full-view modal. Registry-driven via closestDiagram so new renderers are covered too.
        document.addEventListener( 'click', function( e ) {
            var diagramEl = closestDiagram( e.target )
            if( diagramEl && !diagramEl.closest( '#mermaid-modal' ) ) {
                var svg = diagramEl.querySelector( 'svg' )
                if( svg ) { openMermaidModal( svg.outerHTML ) }
                return
            }
            // Memo 038 Kap 11: content images are click-to-zoom into the same full-view modal.
            // Scoped to <img> inside #content (never UI icons, never the modal's own image).
            var target = e.target
            if( target && target.tagName === 'IMG' && target.closest( '#content' ) && !target.closest( '#mermaid-modal' ) ) {
                openImageModal( target.getAttribute( 'src' ), target.getAttribute( 'alt' ) )
            }
        } )
