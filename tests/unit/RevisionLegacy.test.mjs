import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { TranscriptHeader } from '../../src/TranscriptHeader.mjs'


// PRD-007 (Memo 018 Kap 10, refined REV-05): a MEMO revision is "alte Version" (legacy) exactly
// when it has NO parsable `### F{N} —` question structure. The transcript-only `Schema-Version: 2`
// marker is NOT applied to memo .md revisions (they never carry that header). Unreadable revisions
// stay listed, flagged isLegacy + parseError, never dropped (kein stilles Scheitern).


const SCHEMA_LINE = 'Schema-Version: 2'

const validQuestionBody = [
    '## Offene Fragen',
    '',
    '### F1 — Beispiel-Titel',
    '',
    '- **Frage (Original):** Was soll passieren?',
    '- **AI-Empfehlung:** A',
    ''
].join( '\n' )

const fixtureWithFStructure = [ '# Memo', '', validQuestionBody ].join( '\n' )
const fixtureWithMarkerAndFStructure = [ SCHEMA_LINE, '', '# Memo', '', validQuestionBody ].join( '\n' )
const fixtureNoFStructure = [ '# Memo', '', '## Offene Fragen', '', 'keine' ].join( '\n' )
const fixtureEmpty = ''


// PRD-001 (Memo 019 Kap 1): the single Warteschlangen-Regel = an OPEN, NON-legacy, parsable
// revision. Legacy / parseError revisions stay visible in the tree but never enter the queue.
// BUGFIX (fix/transcript-abschliessen-queue): rule = status !== 'eingeloggt' && non-legacy.
describe( 'DocumentRegistry.isInQueue — unfinished + non-legacy rule (PRD-001 Memo 019)', () => {
    it( 'AC-1/AC-4: open + non-legacy revision is in the queue', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen' } } )

        expect( inQueue ).toBe( true )
    } )


    it( 'AC-1: open + isLegacy revision is NOT in the queue', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen', isLegacy: true } } )

        expect( inQueue ).toBe( false )
    } )


    it( 'AC-1: open + parseError revision is NOT in the queue', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen', parseError: true } } )

        expect( inQueue ).toBe( false )
    } )


    it( 'an eingeloggt (abgeschlossen) revision is never in the queue', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'eingeloggt' } } )

        expect( inQueue ).toBe( false )
    } )


    // BUGFIX (fix/transcript-abschliessen-queue): transcript-eingetragen stays in the queue.
    it( 'a transcript-eingetragen revision STAYS in the queue', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'transcript-eingetragen' } } )

        expect( inQueue ).toBe( true )
    } )


    it( 'tolerates a missing/invalid revision (no throw)', () => {
        const a = DocumentRegistry.isInQueue( { revision: undefined } )
        const b = DocumentRegistry.isInQueue( { revision: null } )

        expect( a.inQueue ).toBe( false )
        expect( b.inQueue ).toBe( false )
    } )


    it( 'a prepare revision is NEVER in the queue (Basis-Snapshot, not a transcript job)', () => {
        const open = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen', revisionType: 'prepare' } } )
        const withTranscript = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'transcript-eingetragen', revisionType: 'prepare' } } )

        expect( open.inQueue ).toBe( false )
        expect( withTranscript.inQueue ).toBe( false )
    } )
} )


describe( 'detectSchema — TranscriptHeader (transcript-scope only, unchanged)', () => {
    it( 'missing Schema-Version marker returns isLegacy: true', () => {
        const { isLegacy, schemaVersion } = TranscriptHeader.detectSchema( { content: fixtureWithFStructure } )

        expect( isLegacy ).toBe( true )
        expect( schemaVersion ).toBe( null )
    } )


    it( 'Schema-Version: 2 returns isLegacy: false, schemaVersion: 2', () => {
        const { isLegacy, schemaVersion } = TranscriptHeader.detectSchema( { content: fixtureWithMarkerAndFStructure } )

        expect( isLegacy ).toBe( false )
        expect( schemaVersion ).toBe( 2 )
    } )
} )


describe( 'parseQuestionSchema — DocumentRegistry (F-structure detection)', () => {
    it( 'content without ### F{N} — returns empty questions array', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: fixtureNoFStructure } )

        expect( Array.isArray( questions ) ).toBe( true )
        expect( questions.length ).toBe( 0 )
    } )


    it( 'content with ### F1 — returns at least one question', () => {
        const { questions } = DocumentRegistry.parseQuestionSchema( { content: fixtureWithFStructure } )

        expect( questions.length ).toBeGreaterThan( 0 )
    } )
} )


describe( 'detectRevisionLegacy — refined F-structure criterion (REV-05)', () => {
    it( 'F-structure present, NO schema marker → NOT legacy (criterion change)', () => {
        const { isLegacy, hasQuestionStructure } = DocumentRegistry.detectRevisionLegacy( { content: fixtureWithFStructure } )

        expect( isLegacy ).toBe( false )
        expect( hasQuestionStructure ).toBe( true )
    } )


    it( 'F-structure present, WITH schema marker → NOT legacy', () => {
        const { isLegacy } = DocumentRegistry.detectRevisionLegacy( { content: fixtureWithMarkerAndFStructure } )

        expect( isLegacy ).toBe( false )
    } )


    it( 'no F-structure → legacy', () => {
        const { isLegacy, hasQuestionStructure } = DocumentRegistry.detectRevisionLegacy( { content: fixtureNoFStructure } )

        expect( isLegacy ).toBe( true )
        expect( hasQuestionStructure ).toBe( false )
    } )


    it( 'empty content → legacy (no F-structure), does not throw', () => {
        const { isLegacy } = DocumentRegistry.detectRevisionLegacy( { content: fixtureEmpty } )

        expect( isLegacy ).toBe( true )
    } )
} )


describe( '#scanRevisions integration — isLegacy in revision objects', () => {
    let tempDir
    let registry


    beforeEach( async () => {
        tempDir = await mkdtemp( join( tmpdir(), 'memo-legacy-' ) )
        const { registry: reg } = DocumentRegistry.create( { onChange: null } )
        registry = reg
    } )


    afterEach( async () => {
        registry.shutdown()
        await rm( tempDir, { recursive: true, force: true } )
    } )


    const scanRevisions = async ( { fileMap } ) => {
        const revisionsDir = join( tempDir, '018-feature', 'revisions' )
        await mkdir( revisionsDir, { recursive: true } )

        await Promise.all(
            Object.keys( fileMap )
                .map( ( name ) => writeFile( join( revisionsDir, name ), fileMap[ name ] ) )
        )

        const addResult = await registry.addDocument( { projectId: 'proj', memoPath: revisionsDir } )
        const { document } = registry.getDocument( { documentId: addResult[ 'documentId' ] } )

        return { registry, documentId: addResult[ 'documentId' ], revisions: document[ 'revisions' ] }
    }


    it( 'revision with F-structure (no marker) → isLegacy: false', async () => {
        const { revisions } = await scanRevisions( { fileMap: { 'REV-01.md': fixtureWithFStructure } } )
        const rev = revisions.find( ( r ) => r[ 'fileName' ] === 'REV-01.md' )

        expect( rev[ 'isLegacy' ] ).toBe( false )
    } )


    it( 'revision without F-structure → isLegacy: true', async () => {
        const { revisions } = await scanRevisions( { fileMap: { 'REV-02.md': fixtureNoFStructure } } )
        const rev = revisions.find( ( r ) => r[ 'fileName' ] === 'REV-02.md' )

        expect( rev[ 'isLegacy' ] ).toBe( true )
    } )


    it( 'readFile failure → revision still present with isLegacy + parseError, no throw', async () => {
        const revisionsDir = join( tempDir, '019-broken', 'revisions' )
        await mkdir( revisionsDir, { recursive: true } )
        // A directory named like a revision file passes the name filter, stat() succeeds, but
        // readFile() throws EISDIR — a deterministic, mock-free read/parse-failure path.
        await mkdir( join( revisionsDir, 'REV-09.md' ) )
        await writeFile( join( revisionsDir, 'REV-08.md' ), fixtureWithFStructure )

        const addResult = await registry.addDocument( { projectId: 'proj', memoPath: revisionsDir } )
        const { document } = registry.getDocument( { documentId: addResult[ 'documentId' ] } )
        const revisions = document[ 'revisions' ]

        const broken = revisions.find( ( r ) => r[ 'fileName' ] === 'REV-09.md' )

        expect( broken ).toBeDefined()
        expect( broken[ 'isLegacy' ] ).toBe( true )
        expect( broken[ 'parseError' ] ).toBe( true )

        const fileNames = revisions.map( ( r ) => r[ 'fileName' ] )
        expect( fileNames ).toContain( 'REV-08.md' )
        expect( fileNames ).toContain( 'REV-09.md' )
    } )


    it( 'existing fields stay unchanged when isLegacy is added', async () => {
        const { revisions } = await scanRevisions( { fileMap: { 'REV-04.md': fixtureWithFStructure } } )
        const rev = revisions.find( ( r ) => r[ 'fileName' ] === 'REV-04.md' )

        expect( rev ).toMatchObject( {
            'fileName': 'REV-04.md',
            'revisionType': 'full',
            'revisionStatus': 'offen'
        } )
        expect( typeof rev[ 'absolutePath' ] ).toBe( 'string' )
        expect( typeof rev[ 'mtimeMs' ] ).toBe( 'number' )
    } )


    it( 'isLegacy is propagated through getDocumentTree (frontend allow-list)', async () => {
        const { registry: reg } = await scanRevisions( { fileMap: {
            'REV-05.md': fixtureWithFStructure,
            'REV-06.md': fixtureNoFStructure
        } } )

        const { tree } = reg.getDocumentTree()
        const memos = Object.keys( tree )
            .flatMap( ( projectId ) => tree[ projectId ][ 'memos' ] )
        const allRevs = memos.flatMap( ( m ) => m[ 'revisions' ] )

        const newRev = allRevs.find( ( r ) => r[ 'fileName' ] === 'REV-05.md' )
        const oldRev = allRevs.find( ( r ) => r[ 'fileName' ] === 'REV-06.md' )

        expect( newRev[ 'isLegacy' ] ).toBe( false )
        expect( oldRev[ 'isLegacy' ] ).toBe( true )
    } )


    it( 'isLegacy is propagated through getDocuments (frontend allow-list)', async () => {
        const { registry: reg } = await scanRevisions( { fileMap: {
            'REV-07.md': fixtureNoFStructure
        } } )

        const { documents } = reg.getDocuments()
        const allRevs = documents.flatMap( ( d ) => d[ 'revisions' ] )
        const oldRev = allRevs.find( ( r ) => r[ 'fileName' ] === 'REV-07.md' )

        expect( oldRev[ 'isLegacy' ] ).toBe( true )
    } )
} )
