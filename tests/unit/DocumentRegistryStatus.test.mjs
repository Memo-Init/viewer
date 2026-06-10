import { describe, it, expect } from '@jest/globals'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// PRD-001 (Memo 018 Kap 4, F2=A / F7=A): the revision-level status model is the single source
// of truth. Memo- and namespace-status are DERIVED from it; the queue membership and the
// Memo-014 ball state are derived too. These tests cover all three enum states, the inheritance
// edge cases, and the full mapping table.
describe( 'DocumentRegistry revision-status enum (PRD-001)', () => {
    it( 'contains exactly the three defined values (AC-01)', () => {
        const { values } = DocumentRegistry.getRevisionStatusValues()

        expect( values ).toEqual( [ 'offen', 'transcript-eingetragen', 'eingeloggt' ] )
    } )


    it( 'has default "offen" (AC-02)', () => {
        const { default: fallback } = DocumentRegistry.getRevisionStatusValues()

        expect( fallback ).toBe( 'offen' )
    } )
} )


describe( 'DocumentRegistry.deriveRevisionStatus (PRD-001)', () => {
    it( 'returns offen when no transcript is present (AC-03)', () => {
        const { revisionStatus } = DocumentRegistry.deriveRevisionStatus( { hasTranscript: false, isLoggedIn: false } )

        expect( revisionStatus ).toBe( 'offen' )
    } )


    it( 'returns transcript-eingetragen when a transcript is present but not logged (AC-04)', () => {
        const { revisionStatus } = DocumentRegistry.deriveRevisionStatus( { hasTranscript: true, isLoggedIn: false } )

        expect( revisionStatus ).toBe( 'transcript-eingetragen' )
    } )


    it( 'returns eingeloggt when the transcript is logged (AC-05)', () => {
        const { revisionStatus } = DocumentRegistry.deriveRevisionStatus( { hasTranscript: true, isLoggedIn: true } )

        expect( revisionStatus ).toBe( 'eingeloggt' )
    } )


    it( 'isLoggedIn wins even when hasTranscript is not set', () => {
        const { revisionStatus } = DocumentRegistry.deriveRevisionStatus( { hasTranscript: false, isLoggedIn: true } )

        expect( revisionStatus ).toBe( 'eingeloggt' )
    } )
} )


describe( 'DocumentRegistry.deriveMemoStatus (PRD-001)', () => {
    it( 'returns offen when at least one revision is offen (AC-06)', () => {
        const { memoStatus } = DocumentRegistry.deriveMemoStatus( { revisions: [ { revisionStatus: 'offen' } ], memoFinalized: false } )

        expect( memoStatus ).toBe( 'offen' )
    } )


    it( 'returns offen when a single offen revision sits among closed ones', () => {
        const revisions = [
            { revisionStatus: 'eingeloggt' },
            { revisionStatus: 'offen' },
            { revisionStatus: 'transcript-eingetragen' }
        ]

        const { memoStatus } = DocumentRegistry.deriveMemoStatus( { revisions, memoFinalized: false } )

        expect( memoStatus ).toBe( 'offen' )
    } )


    it( 'returns geschlossen when no revision is offen (AC-07)', () => {
        const { memoStatus } = DocumentRegistry.deriveMemoStatus( { revisions: [ { revisionStatus: 'eingeloggt' } ], memoFinalized: false } )

        expect( memoStatus ).toBe( 'geschlossen' )
    } )


    it( 'returns finalisiert when memoFinalized is true (AC-08)', () => {
        const { memoStatus } = DocumentRegistry.deriveMemoStatus( { revisions: [], memoFinalized: true } )

        expect( memoStatus ).toBe( 'finalisiert' )
    } )


    it( 'finalisiert wins over an open revision', () => {
        const { memoStatus } = DocumentRegistry.deriveMemoStatus( { revisions: [ { revisionStatus: 'offen' } ], memoFinalized: true } )

        expect( memoStatus ).toBe( 'finalisiert' )
    } )


    it( 'treats a memo with no revisions and no finalize as geschlossen', () => {
        const { memoStatus } = DocumentRegistry.deriveMemoStatus( { revisions: [], memoFinalized: false } )

        expect( memoStatus ).toBe( 'geschlossen' )
    } )


    it( 'tolerates non-array revisions input', () => {
        const { memoStatus } = DocumentRegistry.deriveMemoStatus( { revisions: undefined, memoFinalized: false } )

        expect( memoStatus ).toBe( 'geschlossen' )
    } )
} )


describe( 'DocumentRegistry.deriveNamespaceStatus (PRD-001)', () => {
    it( 'returns offen when at least one memo is offen (AC-09)', () => {
        const memos = [ { memoStatus: 'offen' }, { memoStatus: 'geschlossen' } ]

        const { namespaceStatus } = DocumentRegistry.deriveNamespaceStatus( { memos } )

        expect( namespaceStatus ).toBe( 'offen' )
    } )


    it( 'returns geschlossen when all memos are closed (AC-10)', () => {
        const { namespaceStatus } = DocumentRegistry.deriveNamespaceStatus( { memos: [ { memoStatus: 'geschlossen' } ] } )

        expect( namespaceStatus ).toBe( 'geschlossen' )
    } )


    it( 'a finalisiert memo does not make the namespace offen', () => {
        const { namespaceStatus } = DocumentRegistry.deriveNamespaceStatus( { memos: [ { memoStatus: 'finalisiert' } ] } )

        expect( namespaceStatus ).toBe( 'geschlossen' )
    } )


    it( 'tolerates non-array memos input', () => {
        const { namespaceStatus } = DocumentRegistry.deriveNamespaceStatus( { memos: null } )

        expect( namespaceStatus ).toBe( 'geschlossen' )
    } )
} )


describe( 'DocumentRegistry.isInQueue (PRD-001)', () => {
    it( 'returns true for revisionStatus offen (AC-15)', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'offen' } } )

        expect( inQueue ).toBe( true )
    } )


    it( 'returns false for revisionStatus eingeloggt (AC-16)', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'eingeloggt' } } )

        expect( inQueue ).toBe( false )
    } )


    // BUGFIX (fix/transcript-abschliessen-queue): a transcript-eingetragen (transcript present,
    // not yet logged) revision is UNFINISHED and stays in the queue. Only eingeloggt drops out.
    it( 'returns true for revisionStatus transcript-eingetragen', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'transcript-eingetragen' } } )

        expect( inQueue ).toBe( true )
    } )


    // BUGFIX (fix/transcript-abschliessen-queue): the rule is status !== 'eingeloggt'. A revision
    // without an explicit status is not eingeloggt, so it counts as unfinished -> in queue.
    it( 'returns true for a revision without a status (not eingeloggt)', () => {
        const { inQueue } = DocumentRegistry.isInQueue( { revision: {} } )

        expect( inQueue ).toBe( true )
    } )


    it( 'still drops eingeloggt revisions that are legacy/parseError? — legacy guard wins', () => {
        const legacy = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'transcript-eingetragen', isLegacy: true } } )
        const broken = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'transcript-eingetragen', parseError: true } } )

        expect( legacy.inQueue ).toBe( false )
        expect( broken.inQueue ).toBe( false )
    } )
} )
