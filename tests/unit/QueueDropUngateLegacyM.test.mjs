import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'


// Memo 079 queue-drop-ungate: the terminal-answer queue-drop used to be gated on hasDb — the 383 legacy
// (file-parsed) memos, the live Karteileichen stock, could NEVER be cleared by a terminal answer. The fix
// mirrors the db answer-completeness from the FILE question parse: a legacy memo whose full revision shows
// ZERO open questions and at least one answered (terminal answers folded into `## Beantwortete Fragen`)
// is answer-complete and leaves the queue too. A memo with open questions — or none at all — does not.
describe( 'Memo 079 queue-drop-ungate — legacy (file) memo answer-completeness', () => {
    let root = ''

    // Seed a legacy memo folder (NO db): <memoDir>/revisions/REV-01.md with the given questions section.
    const seedLegacyMemo = ( { slug, body } ) => {
        const revDir = join( root, slug, 'revisions' )
        mkdirSync( revDir, { recursive: true } )
        writeFileSync( join( revDir, 'REV-01.md' ), body )

        return join( root, slug, 'revisions' )
    }

    const allAnsweredBody = [
        '# 070-fully-answered',
        '',
        '| Feld | Wert |',
        '| --- | --- |',
        '| **Status** | Finalisiert |',
        '',
        '## Beantwortete Fragen',
        '',
        '### F1 — Erste Frage',
        '',
        '**Frage:** Soll X passieren?',
        '**Antwort:** Ja (im Terminal beantwortet).',
        '',
        '### F2 — Zweite Frage',
        '',
        '**Frage:** Wie Y?',
        '**Antwort:** So.'
    ].join( '\n' )

    const openBody = [
        '# 071-still-open',
        '',
        '| Feld | Wert |',
        '| --- | --- |',
        '| **Status** | In Bearbeitung |',
        '',
        '## Offene Fragen',
        '',
        '### F1 — Offene Frage',
        '',
        '**Frage:** Noch offen?',
        '',
        'A) eins',
        'B) zwei'
    ].join( '\n' )

    const noQuestionsBody = [
        '# 072-no-questions',
        '',
        '| Feld | Wert |',
        '| --- | --- |',
        '| **Status** | Finalisiert |',
        '',
        'Kein Fragen-Abschnitt in diesem Memo.'
    ].join( '\n' )


    const answerRecordsCompleteOf = ( { registry, memoName } ) => {
        const { documents } = registry.getDocuments()
        const doc = documents
            .find( ( entry ) => entry[ 'memoName' ] === memoName )

        return doc === undefined ? undefined : doc[ 'answerRecordsComplete' ]
    }


    beforeEach( () => {
        root = mkdtempSync( join( tmpdir(), 'queue-ungate-' ) )
    } )

    afterEach( () => {
        rmSync( root, { recursive: true, force: true } )
    } )


    it( 'REGRESSION: a legacy memo with all questions answered (open 0, answered > 0) is answer-complete → drops from queue', async () => {
        seedLegacyMemo( { slug: '070-fully-answered', body: allAnsweredBody } )

        const { registry } = DocumentRegistry.create( {} )
        await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '070-fully-answered', 'revisions' ) } )

        expect( answerRecordsCompleteOf( { registry, memoName: '070-fully-answered' } ) ).toBe( true )
        registry.shutdown()
    } )


    it( 'a legacy memo with an OPEN question stays in the queue (answerRecordsComplete false)', async () => {
        seedLegacyMemo( { slug: '071-still-open', body: openBody } )

        const { registry } = DocumentRegistry.create( {} )
        await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '071-still-open', 'revisions' ) } )

        expect( answerRecordsCompleteOf( { registry, memoName: '071-still-open' } ) ).toBe( false )
        registry.shutdown()
    } )


    it( 'a legacy memo with NO questions is NOT "all answered" (answered 0) — flag stays false', async () => {
        seedLegacyMemo( { slug: '072-no-questions', body: noQuestionsBody } )

        const { registry } = DocumentRegistry.create( {} )
        await registry.addDocument( { projectId: 'memo-init', memoPath: join( root, '072-no-questions', 'revisions' ) } )

        expect( answerRecordsCompleteOf( { registry, memoName: '072-no-questions' } ) ).toBe( false )
        registry.shutdown()
    } )


    it( 'isInQueue drops a revision once answeredComplete is joined (the gate consumed downstream)', () => {
        const inQueueOpen = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'transcript-eingetragen', answeredComplete: false } } )
        const inQueueAnswered = DocumentRegistry.isInQueue( { revision: { revisionStatus: 'transcript-eingetragen', answeredComplete: true } } )

        expect( inQueueOpen.inQueue ).toBe( true )
        expect( inQueueAnswered.inQueue ).toBe( false )
    } )
} )
