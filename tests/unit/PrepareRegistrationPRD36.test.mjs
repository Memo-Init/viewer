import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile, mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { MemoValidator } from '../../src/MemoValidator.mjs'


// PRD-36 (Memo 081, Kap 19 / WI-080) — "the registration path holds the type and does not hand it on".
//
// THE DEFECT, measured over the stock: MemoValidator derives the revision type in two stages — the file
// name first, the document's own signals only as a fallback. Every MemoView.#computeValidation call site
// used to omit the name, so the fallback was not a fallback but the only stage the viewer ever reached:
// 35 of 161 prepare files were then judged against the `full` schema and produced 341 of their 503
// findings a prepare file can never satisfy.
//
// WHAT THIS FILE PROVES. The chain the door-gate walks — addDocument -> getLatestRevision ->
// MemoValidator.validate — built from the REAL modules, without MemoView.startServer. The server boot
// scans the surrounding workbench tree (~390 documents, tens of seconds) which a CI checkout of this repo
// alone does not have; the repo already decided that the real end-to-end belongs in tests/manual/
// (HealthEndpointPRDV11.test.mjs:16) and this file follows that decision. The end-to-end answer (HTTP
// 200/422) is measured in tests/manual/prepare-registration-e2e.mjs.
//
// EVERY CASE STATES ITS COMPARISON BASE. A check without one counts as red, not green — and the
// load-bearing fixture is a prepare file that carries NEITHER stage-2 signal, because a prepare file WITH
// signals is judged `prepare` even before this change and would be green without comparing anything.
const here = dirname( fileURLToPath( import.meta.url ) )
const memoViewSource = resolve( here, '..', '..', 'src', 'MemoView.mjs' )
const fixturePath = resolve( here, '..', 'fixtures', 'sample-rev.md' )


// A prepare skeleton in the shape memo-revision-generate prescribes, in two variants. `withSignals: false`
// strips BOTH stage-2 signals (the `# REV-NN-prepare` title, the `| **Geplante Revision** |` header field)
// and falls back on the `| **Revision** |` alias the prepare schema also accepts — the exact shape of the
// 35 corpus files that are judged `full` today.
const prepareDoc = ( { revision, withSignals } ) => {
    const title = withSignals === true ? `# REV-${ revision }-prepare` : '# Vorbereitung der naechsten Revision'
    const revisionField = withSignals === true ? `| **Geplante Revision** | REV-${ revision } |` : `| **Revision** | REV-${ revision } |`

    return [
        title,
        '',
        '| Feld | Wert |',
        '|------|------|',
        '| **Memo** | 999-prd36-probe |',
        revisionField,
        '| **Geplanter Typ** | Full |',
        '| **Basiert auf** | REV-01 |',
        '| **Datum** | 2026-09-07 10:00 |',
        '',
        '## Interpretation des Feedbacks',
        'Probe fixture for PRD-36.',
        '',
        '## Geplante Änderungen pro Kapitel',
        '- none',
        '',
        '## Research',
        'Research noetig: Nein',
        '',
        '## Revisions-Blocker',
        'keine',
        '',
        '## Offene Fragen',
        'keine'
    ].join( '\n' )
}


// The positive control: a genuine FULL revision missing nine of its ten required sections. Its name
// carries no suffix, so handing the name through must NOT rescue it.
const BROKEN_FULL_DOC = [
    '# REV-02',
    '',
    '| Feld | Wert |',
    '|------|------|',
    '| **Memo** | 999-prd36-probe |',
    '',
    '## Kontext',
    'A full revision that is missing nine of its ten required sections.',
    '',
    'Schema-Version: 2'
].join( '\n' )


const PREPARE_WITHOUT_SIGNALS = prepareDoc( { 'revision': '02', 'withSignals': false } )
const PREPARE_WITH_SIGNALS = prepareDoc( { 'revision': '02', 'withSignals': true } )

let root = ''
let registry = null
let validRevision = ''
const registered = {}


// One probe directory: a valid full revision as REV-01.md plus a younger second file. #scanRevisions
// sorts by mtimeMs descending, so the younger file becomes revisions[0] — the "latest revision" the door
// gate validates. A checkout never establishes an mtime order, so it is set explicitly here.
const buildProbe = async ( { name, youngest, youngestBody } ) => {
    const revisions = join( root, name, 'revisions' )
    await mkdir( revisions, { recursive: true } )
    await writeFile( join( revisions, 'REV-01.md' ), validRevision, 'utf8' )
    await writeFile( join( revisions, youngest ), youngestBody, 'utf8' )

    const older = new Date( Date.now() - 600000 )
    const newer = new Date( Date.now() )
    await utimes( join( revisions, 'REV-01.md' ), older, older )
    await utimes( join( revisions, youngest ), newer, newer )

    const result = await registry.addDocument( { 'projectId': 'prd36', 'memoPath': revisions } )

    return { 'documentId': result[ 'documentId' ], 'revisionsFound': result[ 'revisionsFound' ], 'status': result[ 'status' ] }
}


beforeAll( async () => {
    // Test isolation: write ONLY into the repo-internal .test-tmp/, never .memo/ and never the home.
    await mkdir( join( process.cwd(), '.test-tmp' ), { recursive: true } )
    root = await mkdtemp( join( process.cwd(), '.test-tmp', 'prd36-' ) )
    validRevision = await readFile( fixturePath, 'utf-8' )

    const created = DocumentRegistry.create( { 'onChange': null } )
    registry = created[ 'registry' ]

    registered[ 'blind' ] = await buildProbe( { 'name': 'probe-blind', 'youngest': 'REV-02-prepare.md', 'youngestBody': PREPARE_WITHOUT_SIGNALS } )
    registered[ 'signalled' ] = await buildProbe( { 'name': 'probe-signalled', 'youngest': 'REV-02-prepare.md', 'youngestBody': PREPARE_WITH_SIGNALS } )
    registered[ 'broken' ] = await buildProbe( { 'name': 'probe-broken', 'youngest': 'REV-02.md', 'youngestBody': BROKEN_FULL_DOC } )
    // One digit instead of two: #classifyRevisionType accepts it as `prepare`, MemoValidator's stricter
    // two-digit suffix does not. The divergence of T-G is built, not imagined.
    registered[ 'divergent' ] = await buildProbe( { 'name': 'probe-divergent', 'youngest': 'REV-7-prepare.md', 'youngestBody': PREPARE_WITHOUT_SIGNALS } )
} )


afterAll( async () => {
    // shutdown() closes every directory watcher addDocument opened — the repo's own teardown
    // convention (DocumentRegistry.test.mjs). Without it the run leaves an open handle and the jest
    // process never exits, which in CI is a hang rather than a failure.
    registry.shutdown()

    await rm( root, { 'recursive': true, 'force': true } )
} )


describe( 'PRD-36 T-A/T-B — the same file, asked two ways (comparison base: 1 prepare file, 2 question forms)', () => {
    it( 'T-A VACUUM LOCK: asked WITHOUT a name the registry-fed prepare file reads `full` and is red', async () => {
        const latest = await registry.getLatestRevision( { 'documentId': registered[ 'blind' ][ 'documentId' ] } )
        const blind = MemoValidator.validate( { 'doc': latest[ 'content' ] } )

        // The number is printed rather than pinned: it is the proof that the fixture carries no stage-2
        // signal. Were it 0, this file would compare nothing and every case below would be vacuum-green.
        expect( latest[ 'fileName' ] ).toBe( 'REV-02-prepare.md' )
        expect( blind[ 'revisionType' ] ).toBe( 'full' )
        expect( blind[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'T-B: asked WITH the name the registry already holds, the same file reads `prepare` and is clean', async () => {
        const latest = await registry.getLatestRevision( { 'documentId': registered[ 'blind' ][ 'documentId' ] } )
        const named = MemoValidator.validate( { 'doc': latest[ 'content' ], 'fileName': latest[ 'fileName' ] } )

        expect( named[ 'revisionType' ] ).toBe( 'prepare' )
        expect( named[ 'messages' ].length ).toBe( 0 )
        // The comparison base of the run, not a side note: the prepare schema compared FEWER duties than
        // the full one, and it says how many. A pass whose basis is 0 would be the vacuum this memo keeps
        // finding.
        expect( named[ 'checked' ][ 'sections' ] ).toBeGreaterThan( 0 )
    } )


    it( 'T-C POSITIVE CONTROL: a genuinely broken FULL revision stays red WITH its name', async () => {
        const latest = await registry.getLatestRevision( { 'documentId': registered[ 'broken' ][ 'documentId' ] } )
        const named = MemoValidator.validate( { 'doc': latest[ 'content' ], 'fileName': latest[ 'fileName' ] } )

        expect( latest[ 'fileName' ] ).toBe( 'REV-02.md' )
        expect( named[ 'revisionType' ] ).toBe( 'full' )
        expect( named[ 'status' ] ).toBe( false )
        expect( named[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )
} )


describe( 'PRD-36 T-D — the prepare document is processed, not merely un-rejected (comparison base: 4 registered probes)', () => {
    it( 'T-D: addDocument takes the directory and leads with the prepare file', () => {
        const { documents } = registry.getDocuments()
        const probes = documents.filter( ( doc ) => String( doc[ 'documentId' ] ).startsWith( 'prd36--' ) )
        const blind = probes.find( ( doc ) => doc[ 'documentId' ] === registered[ 'blind' ][ 'documentId' ] )

        expect( probes.length ).toBe( 4 )
        expect( registered[ 'blind' ][ 'status' ] ).toBe( true )
        expect( registered[ 'blind' ][ 'revisionsFound' ] ).toBe( 2 )
        expect( blind[ 'revisions' ].length ).toBe( 2 )
        expect( blind[ 'revisions' ][ 0 ][ 'fileName' ] ).toBe( 'REV-02-prepare.md' )
        expect( blind[ 'revisions' ][ 0 ][ 'revisionType' ] ).toBe( 'prepare' )
    } )
} )


describe( 'PRD-36 T-E — getLatestRevision hands out what it already knows (comparison base: 4 probes, 2 sources per probe)', () => {
    it( 'T-E: the returned revisionType equals the one #classifyRevisionType stored at scan time', async () => {
        const { documents } = registry.getDocuments()

        const pairs = await Promise.all( Object.keys( registered ).map( async ( key ) => {
            const documentId = registered[ key ][ 'documentId' ]
            const latest = await registry.getLatestRevision( { documentId } )
            const doc = documents.find( ( entry ) => entry[ 'documentId' ] === documentId )

            return { key, 'fromGate': latest[ 'revisionType' ], 'fromScan': doc[ 'revisions' ][ 0 ][ 'revisionType' ], 'fileName': latest[ 'fileName' ] }
        } ) )

        expect( pairs.length ).toBe( 4 )
        pairs
            .forEach( ( pair ) => {
                expect( pair[ 'fromGate' ] ).toBe( pair[ 'fromScan' ] )
            } )
        expect( pairs.filter( ( pair ) => pair[ 'fromGate' ] === 'prepare' ).length ).toBe( 3 )
        expect( pairs.filter( ( pair ) => pair[ 'fromGate' ] === 'full' ).length ).toBe( 1 )
    } )


    it( 'T-E: a document without any revision reports revisionType null, never a silent `full`', async () => {
        const empty = join( root, 'probe-empty', 'revisions' )
        await mkdir( empty, { recursive: true } )
        const added = await registry.addDocument( { 'projectId': 'prd36empty', 'memoPath': empty } )
        const latest = await registry.getLatestRevision( { 'documentId': added[ 'documentId' ] } )

        expect( added[ 'revisionsFound' ] ).toBe( 0 )
        expect( latest[ 'found' ] ).toBe( false )
        expect( latest[ 'revisionType' ] ).toBe( null )

        registry.removeDocument( { 'documentId': added[ 'documentId' ] } )
    } )
} )


describe( 'PRD-36 T-F — the call sites are counted, not assumed (comparison base: src/MemoView.mjs)', () => {
    it( 'T-F: every #computeValidation call site passes a fileName argument, explicitly', async () => {
        const src = await readFile( memoViewSource, 'utf-8' )
        const all = ( src.match( /MemoView\.#computeValidation\( \{ [^}]*\} \)/g ) || [] )
        const withNull = all.filter( ( call ) => /'fileName': null/.test( call ) === true )
        const withName = all.filter( ( call ) => /'fileName': null/.test( call ) === false )

        // 8 call sites, not the 7 the PRD text measured: PRD-35 (WI-025) added an eighth three commits
        // earlier — the empty state a socket gets when its address names a document that holds no
        // revision. It has no file at all and joins the explicit-null group. The number is re-measured
        // here rather than carried over from the order.
        // Memo 081, WI-075: 9, not 8 — the ninth site (#computeQuestionReject) used to call the
        // validator directly and was invisible to this count for exactly the reason this case exists.
        // It has no file and joins the explicit-null group.
        expect( all.length ).toBe( 9 )
        expect( withName.length ).toBe( 5 )
        expect( withNull.length ).toBe( 4 )
        // No silent default: the parameter is never optional and never defaulted in the signature.
        expect( src ).toMatch( /static #computeValidation\( \{ content, fileName, knownIds \} \)/ )
        expect( src ).not.toMatch( /#computeValidation\( \{ content, fileName = / )
    } )


    it( 'T-F: the door-gate hands on the very name it prints in its own error line', async () => {
        const src = await readFile( memoViewSource, 'utf-8' )
        const gate = src.slice( src.indexOf( 'const latestRevision = await MemoView.#registry.getLatestRevision' ) )
        const block = gate.slice( 0, gate.indexOf( 'if( MemoView.#transcriptRegistry )' ) )

        expect( block.length ).toBeGreaterThan( 200 )
        // The trailing `, knownIds` is Memo 081 / WI-075; the fileName half this case is about is
        // unchanged and is still matched literally.
        expect( block ).toMatch( /#computeValidation\( \{ 'content': latestRevision\[ 'content' \], 'fileName': latestRevision\[ 'fileName' \], knownIds \} \)/ )
        expect( block ).toMatch( /latestRevision\[ 'fileName' \]/ )
    } )
} )


describe( 'PRD-36 T-G — a disagreement about the type is reported, never resolved (comparison base: 1 constructed divergence)', () => {
    it( 'T-G: the two derivations really can disagree — one digit is enough', async () => {
        const latest = await registry.getLatestRevision( { 'documentId': registered[ 'divergent' ][ 'documentId' ] } )
        const fromValidator = MemoValidator.validate( { 'doc': latest[ 'content' ], 'fileName': latest[ 'fileName' ] } )

        expect( latest[ 'fileName' ] ).toBe( 'REV-7-prepare.md' )
        expect( latest[ 'revisionType' ] ).toBe( 'prepare' )
        expect( fromValidator[ 'revisionType' ] ).toBe( 'full' )
        expect( latest[ 'revisionType' ] ).not.toBe( fromValidator[ 'revisionType' ] )
    } )


    it( 'T-G: the gate names BOTH values instead of picking one', async () => {
        const src = await readFile( memoViewSource, 'utf-8' )
        const gate = src.slice( src.indexOf( 'const latestRevision = await MemoView.#registry.getLatestRevision' ) )
        const block = gate.slice( 0, gate.indexOf( 'if( MemoView.#transcriptRegistry )' ) )

        expect( block ).toMatch( /registryRevisionType/ )
        expect( block ).toMatch( /validation\[ 'revisionType' \]/ )
        expect( block ).toMatch( /'checked': validation\[ 'checked' \]/ )
        // Reported, not acted upon: the gate must not branch its status code on the revision type.
        expect( block ).not.toMatch( /=== 'prepare'/ )
    } )
} )
