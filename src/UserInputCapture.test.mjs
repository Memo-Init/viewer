import { describe, it, expect } from '@jest/globals'

import { UserInputCapture } from './UserInputCapture.mjs'


// PRD-09/11 (Memo 079): the viewer captures every transcript-server user input as a user_inputs row
// (+ user_input_answers for review widget answers) by EXEC-ing the core CLI leaf. F4=A single-writer:
// there is NO direct DB write in the viewer — these tests inject a FAKE exec seam and assert the exact
// argv + stdin payload the module hands to the CLI. No real binary and no real DB are touched.
describe( 'UserInputCapture — PRD-09/11 user_inputs capture via CLI (Memo 079)', () => {

    // Fake exec seam: records every { bin, args, input } call and returns a scripted result. Default
    // result mimics `memo user-input record` emitting the new input_id as JSON on stdout.
    const makeExec = ( { impl } = {} ) => {
        const calls = []
        const fn = async ( { bin, args, input } ) => {
            calls.push( { bin, args, input } )

            if( typeof impl === 'function' ) {
                return impl( { bin, args, input, calls } )
            }

            return { 'status': true, 'code': 0, 'stdout': '{"status":true,"input_id":"UI-0001"}', 'stderr': '' }
        }

        return { fn, calls }
    }


    describe( 'recordInput', () => {

        it( 'builds the exact record argv and pipes the RAW payload on stdin', async () => {
            const { fn, calls } = makeExec( {} )
            const payload = 'Roh-Transcript VOR Dictionary-Korrektur — PRD statt PAD.'

            const result = await UserInputCapture.recordInput( {
                'memoId': '079',
                'kind': 'voice-review',
                'sessionId': 'sess-123',
                'source': 'transcript-server',
                'payload': payload,
                'bin': 'memo',
                'exec': fn
            } )

            expect( result[ 'status' ] ).toBe( true )
            expect( result[ 'inputId' ] ).toBe( 'UI-0001' )
            expect( calls ).toHaveLength( 1 )
            expect( calls[ 0 ][ 'bin' ] ).toBe( 'memo' )
            expect( calls[ 0 ][ 'args' ] ).toEqual( [
                'user-input', 'record',
                '--memo', '079',
                '--kind', 'voice-review',
                '--source', 'transcript-server',
                '--session-id', 'sess-123',
                '--payload', '-'
            ] )
            // The verbatim content must go through stdin, never as an argv value.
            expect( calls[ 0 ][ 'input' ] ).toBe( payload )
        } )


        it( 'surfaces a visible message (not a silent skip) when record exits non-zero', async () => {
            const { fn } = makeExec( { 'impl': () => ( { 'status': false, 'code': 1, 'stdout': '', 'stderr': 'db locked' } ) } )

            const result = await UserInputCapture.recordInput( {
                'memoId': '079', 'kind': 'voice-review', 'sessionId': 'sess-1', 'source': 'transcript-server', 'payload': 'x', 'bin': 'memo', 'exec': fn
            } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'messages' ].join( ' ' ) ).toContain( 'USERINPUT-EXEC-002' )
            expect( result[ 'messages' ].join( ' ' ) ).toContain( 'db locked' )
        } )


        it( 'reports a visible message when record succeeds but emits no input_id', async () => {
            const { fn } = makeExec( { 'impl': () => ( { 'status': true, 'code': 0, 'stdout': 'ok\n', 'stderr': '' } ) } )

            const result = await UserInputCapture.recordInput( {
                'memoId': '079', 'kind': 'voice-init', 'sessionId': 'sess-1', 'source': 'transcript-server', 'payload': 'x', 'bin': 'memo', 'exec': fn
            } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'messages' ].join( ' ' ) ).toContain( 'USERINPUT-EXEC-003' )
        } )
    } )


    describe( 'parseAnswerBlocks', () => {

        it( 'extracts one answer per "## Antwort auf F{N}" block and excludes trailing sections', () => {
            const content = [
                'Freitext-Feedback zur Revision.',
                '',
                '## Antwort auf F1 — Speicherort',
                '',
                'DoltLite als DB.',
                '',
                '## Antwort auf F6 — Backfill',
                '',
                'Ja, mit lost:true.',
                '',
                '## Quality-Checks angefragt',
                '',
                '- memo-coherence',
                '',
                '## Anmerkungen',
                '',
                '### ANM-01 — Anmerkung 1',
                '> Zitat: "foo"',
                'Kommentar: bar'
            ].join( '\n' )

            const { answers } = UserInputCapture.parseAnswerBlocks( { content } )

            // PRD-F3 (Memo 080 Kap 18): every entry now also carries the derived `preselected`; an
            // unmarked block — every block written before the mark existed — derives to false.
            expect( answers ).toEqual( [
                { 'question': 'F1', 'answer': 'DoltLite als DB.', 'preselected': false },
                { 'question': 'F6', 'answer': 'Ja, mit lost:true.', 'preselected': false }
            ] )
        } )


        it( 'returns no answers for a plain transcript body', () => {
            const { answers } = UserInputCapture.parseAnswerBlocks( { 'content': 'Nur Fliesstext, keine Antwortbloecke.' } )

            expect( answers ).toEqual( [] )
        } )
    } )


    describe( 'capture — review with widget answers (WI-044: widget + terminal -> same record)', () => {

        it( 'records the input then one answer per block, chained to the returned input_id', async () => {
            const { fn, calls } = makeExec( {} )
            const content = [
                'Feedback-Text.',
                '',
                '## Antwort auf F1 — Speicherort',
                '',
                'DoltLite.',
                '',
                '## Antwort auf F2 — Kanal',
                '',
                'Server als einziger Writer.'
            ].join( '\n' )

            const result = await UserInputCapture.capture( {
                'memoId': '079',
                'transcriptType': 'revision',
                content,
                'bodySessionId': 'sess-xyz',
                'env': {},
                'source': 'transcript-server',
                'bin': 'memo',
                'exec': fn,
                'withAnswers': true
            } )

            expect( result[ 'status' ] ).toBe( true )
            expect( result[ 'kind' ] ).toBe( 'voice-review' )
            expect( result[ 'inputId' ] ).toBe( 'UI-0001' )
            expect( result[ 'answersRecorded' ] ).toBe( 2 )
            expect( result[ 'messages' ] ).toEqual( [] )

            // 1 record + 2 answers = 3 CLI invocations, all via the same fake exec seam.
            expect( calls ).toHaveLength( 3 )
            expect( calls[ 0 ][ 'args' ].slice( 0, 2 ) ).toEqual( [ 'user-input', 'record' ] )
            expect( calls[ 1 ][ 'args' ] ).toEqual( [
                'user-input', 'answer', '--memo', '079', '--input-id', 'UI-0001', '--question', 'F1', '--answer', 'DoltLite.'
            ] )
            expect( calls[ 2 ][ 'args' ] ).toEqual( [
                'user-input', 'answer', '--memo', '079', '--input-id', 'UI-0001', '--question', 'F2', '--answer', 'Server als einziger Writer.'
            ] )
        } )
    } )


    describe( 'capture — session id transparency (PRD-19)', () => {

        it( 'surfaces a visible error and does NOT exec when the session id is truly absent', async () => {
            const { fn, calls } = makeExec( {} )

            const result = await UserInputCapture.capture( {
                'memoId': '079',
                'transcriptType': 'memo-init',
                'content': 'Init-Transcript.',
                'bodySessionId': undefined,
                'env': {},
                'source': 'transcript-server',
                'bin': 'memo',
                'exec': fn,
                'withAnswers': false
            } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'messages' ].join( ' ' ) ).toContain( 'USERINPUT-SESSION-001' )
            // Missing session id must NOT be a silent skip AND must NOT attempt a DB write.
            expect( calls ).toHaveLength( 0 )
        } )


        it( 'falls back to the ambient CLAUDE_CODE_SESSION_ID when the body carries none', async () => {
            const { fn, calls } = makeExec( {} )

            const result = await UserInputCapture.capture( {
                'memoId': '079',
                'transcriptType': 'memo-init',
                'content': 'Init.',
                'bodySessionId': undefined,
                'env': { 'CLAUDE_CODE_SESSION_ID': 'amb-9' },
                'exec': fn,
                'withAnswers': false
            } )

            expect( result[ 'status' ] ).toBe( true )
            expect( result[ 'kind' ] ).toBe( 'voice-init' )
            const sessionIdx = calls[ 0 ][ 'args' ].indexOf( '--session-id' )
            expect( calls[ 0 ][ 'args' ][ sessionIdx + 1 ] ).toBe( 'amb-9' )
        } )
    } )


    describe( 'resolveSessionId / mapKind / resolveBin', () => {

        it( 'prefers the body session id and marks the source as flag', () => {
            const result = UserInputCapture.resolveSessionId( { 'bodySessionId': 'from-body', 'env': { 'CLAUDE_CODE_SESSION_ID': 'from-env' } } )

            expect( result ).toMatchObject( { 'status': true, 'sessionId': 'from-body', 'sessionSource': 'flag' } )
        } )


        it( 'maps init/review/frei to the user_inputs kind and unknown types to null', () => {
            expect( UserInputCapture.mapKind( { 'transcriptType': 'memo-init' } ) ).toEqual( { 'kind': 'voice-init' } )
            expect( UserInputCapture.mapKind( { 'transcriptType': 'revision' } ) ).toEqual( { 'kind': 'voice-review' } )
            expect( UserInputCapture.mapKind( { 'transcriptType': 'frei' } ) ).toEqual( { 'kind': 'voice-frei' } )
            expect( UserInputCapture.mapKind( { 'transcriptType': 'bogus' } ) ).toEqual( { 'kind': null } )
        } )


        it( 'resolves the binary via MEMO_CLI_BIN so verification can point at a worktree build', () => {
            expect( UserInputCapture.resolveBin( { 'env': { 'MEMO_CLI_BIN': '/wt/bin/memo' } } ) ).toEqual( { 'bin': '/wt/bin/memo' } )
            expect( UserInputCapture.resolveBin( { 'env': {} } ) ).toEqual( { 'bin': 'memo' } )
        } )


        it( 'capture surfaces an unknown-type message without exec-ing', async () => {
            const { fn, calls } = makeExec( {} )

            const result = await UserInputCapture.capture( {
                'memoId': '079', 'transcriptType': 'unknown-kind', 'content': 'x', 'bodySessionId': 'sess-1', 'env': {}, 'exec': fn, 'withAnswers': false
            } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'messages' ].join( ' ' ) ).toContain( 'USERINPUT-KIND-001' )
            expect( calls ).toHaveLength( 0 )
        } )
    } )


    // PRD-F3 (Memo 080 Kap 18, WI-139 / Forensik H6): the memo id the routes forward is the VIEWER id,
    // and the live registry carries the full folder slug there (measured: 976 transcripts with values
    // like "080-db-vollausbau-und-laufzeit-transparenz"). The core leaf resolves memo folders by NUMBER
    // (`startsWith( "<memo>-" )`), so the full slug was refused with exit 3 on EVERY capture. Measured
    // against the real CLI: `--memo 080` writes a row, `--memo 080-db-vollausbau-…` returns
    // "could not resolve a database for memo". That is the chain-wide reason both tables stayed empty.
    describe( 'PRD-F3 — normalizeMemoId (the forwarded id must resolve)', () => {

        it( 'reduces the full folder slug to the memo NUMBER — the form the leaf resolves', () => {
            const out = UserInputCapture.normalizeMemoId( { 'memoId': '080-db-vollausbau-und-laufzeit-transparenz' } )

            expect( out[ 'status' ] ).toBe( true )
            expect( out[ 'memoId' ] ).toBe( '080' )
        } )


        it( 'leaves a bare number and the reserve id untouched (2 pass-through cases)', () => {
            expect( UserInputCapture.normalizeMemoId( { 'memoId': '079' } ) ).toEqual( { 'status': true, 'memoId': '079', 'messages': [] } )
            expect( UserInputCapture.normalizeMemoId( { 'memoId': UserInputCapture.OTHER_MEMO_ID } ) ).toEqual( { 'status': true, 'memoId': '(ungebunden)', 'messages': [] } )
        } )


        it( 'NO SILENT DEFAULT: an id without a leading number is refused with a named gap', () => {
            const empty = UserInputCapture.normalizeMemoId( { 'memoId': '' } )
            const nonsense = UserInputCapture.normalizeMemoId( { 'memoId': 'irgendein-ordner' } )

            expect( empty[ 'status' ] ).toBe( false )
            expect( empty[ 'messages' ].join( ' ' ) ).toContain( 'USERINPUT-MEMO-001' )
            expect( nonsense[ 'status' ] ).toBe( false )
            expect( nonsense[ 'memoId' ] ).toBe( null )
            expect( nonsense[ 'messages' ].join( ' ' ) ).toContain( 'USERINPUT-MEMO-002' )
        } )


        it( 'capture execs with the NUMBER even when the route forwards the slug (2 argv checked)', async () => {
            const { fn, calls } = makeExec( {} )

            const result = await UserInputCapture.capture( {
                'memoId': '080-db-vollausbau-und-laufzeit-transparenz',
                'transcriptType': 'revision',
                'content': 'Text.\n\n## Antwort auf F1 — Erste Frage\n\nA) eins\n',
                'bodySessionId': 'sess-1', 'env': {}, 'exec': fn, 'withAnswers': true
            } )

            expect( result[ 'status' ] ).toBe( true )
            expect( calls ).toHaveLength( 2 )
            calls.forEach( ( call ) => {
                expect( call[ 'args' ][ call[ 'args' ].indexOf( '--memo' ) + 1 ] ).toBe( '080' )
            } )
        } )


        it( 'capture refuses an unresolvable id BEFORE exec-ing — no child process, no silent row', async () => {
            const { fn, calls } = makeExec( {} )

            const result = await UserInputCapture.capture( {
                'memoId': 'irgendein-ordner', 'transcriptType': 'revision', 'content': 'x',
                'bodySessionId': 'sess-1', 'env': {}, 'exec': fn, 'withAnswers': false
            } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'messages' ].join( ' ' ) ).toContain( 'USERINPUT-MEMO-002' )
            expect( calls ).toHaveLength( 0 )
        } )
    } )


    // PRD-F3 (Memo 080 Kap 18, WI-078, A7): the `preselected` column had a flag in the leaf and no
    // caller anywhere — so it could hold nothing but 0. The mark on the answer heading is the caller.
    describe( 'PRD-F3 — the preselection mark reaches the leaf as --preselected', () => {

        const answerArgs = ( calls ) => calls.filter( ( call ) => call[ 'args' ][ 1 ] === 'answer' )


        it( 'parseAnswerBlocks reads the mark off the heading tail, not out of the body', () => {
            const { answers } = UserInputCapture.parseAnswerBlocks( {
                'content': '## Antwort auf F1 — Erste [Vorauswahl]\n\nA) eins\n\n## Antwort auf F2 — Zweite\n\nB) zwei\n'
            } )

            expect( answers ).toHaveLength( 2 )
            expect( answers[ 0 ] ).toEqual( { 'question': 'F1', 'answer': 'A) eins', 'preselected': true } )
            expect( answers[ 1 ] ).toEqual( { 'question': 'F2', 'answer': 'B) zwei', 'preselected': false } )
        } )


        it( 'A7 — a marked answer execs WITH --preselected, an unmarked one WITHOUT (2 of 2 argv)', async () => {
            const { fn, calls } = makeExec( {} )

            await UserInputCapture.capture( {
                'memoId': '080', 'transcriptType': 'revision',
                'content': '## Antwort auf F1 — Erste [Vorauswahl]\n\nA) eins\n\n## Antwort auf F2 — Zweite\n\nB) zwei\n',
                'bodySessionId': 'sess-1', 'env': {}, 'exec': fn, 'withAnswers': true
            } )

            const answers = answerArgs( calls )
            expect( answers ).toHaveLength( 2 )
            expect( answers[ 0 ][ 'args' ] ).toContain( '--preselected' )
            expect( answers[ 1 ][ 'args' ] ).not.toContain( '--preselected' )
            // The flag is LAST, so the token parser reads it as the boolean true (no following value).
            expect( answers[ 0 ][ 'args' ][ answers[ 0 ][ 'args' ].length - 1 ] ).toBe( '--preselected' )
        } )


        it( 'an OLD transcript without any mark parses exactly as before (0 marked of 1)', () => {
            const { answers } = UserInputCapture.parseAnswerBlocks( { 'content': '## Antwort auf F19 — Cron-Watchdog\n\nFrage neu formulieren\n' } )

            expect( answers ).toHaveLength( 1 )
            expect( answers[ 0 ][ 'answer' ] ).toBe( 'Frage neu formulieren' )
            expect( answers[ 0 ][ 'preselected' ] ).toBe( false )
        } )
    } )
} )
