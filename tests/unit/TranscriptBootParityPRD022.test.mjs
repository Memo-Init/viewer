import { describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectAutoRegister } from '../../src/ProjectAutoRegister.mjs'
import { DocumentRegistry } from '../../src/DocumentRegistry.mjs'
import { TranscriptRegistry } from '../../src/TranscriptRegistry.mjs'


// Memo 079 PRD-22 (WI-046) / Snag 076-wi133 Restpunkt: the BOOT gate must load BOTH axes — documents
// AND transcripts — across the configured projects, so a previously completed (eingeloggt) revision does
// not reappear in the queue after a restart. Before this, only POST /api/documents ran scanMemo; boot
// registered documents but scanned transcripts only from the cwd other-store. Two complementary covers:
//   1. SOURCE-LEVEL lock: the boot gate wires ProjectAutoRegister.autoRegister (documents) AND
//      #hydrateMemoTranscripts (transcripts) over the SAME resolved projects — in BOTH the projects[]
//      branch and the cwd fallback.
//   2. BEHAVIOURAL: over a fixture MULTI-PROJECT workspace, the building blocks the boot gate composes
//      populate both axes and reconstruct the .loggedin marker from disk.
// Writes go ONLY into a repo-internal temp dir (.test-tmp/), never the real .memo/ or the user home.
describe( 'Transcript boot parity — Memo 079 PRD-22 (WI-046, Snag 076-wi133 Restpunkt)', () => {
    describe( 'boot gate wires BOTH axes over the resolved projects (source-level lock)', () => {
        let src = ''

        beforeAll( async () => {
            const here = dirname( fileURLToPath( import.meta.url ) )
            src = await readFile( join( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
        } )

        it( 'the projects[] branch hydrates transcripts for the SAME registered document ids (documents+transcripts)', () => {
            // documents axis: autoRegister per resolved project.
            expect( src.includes( 'await ProjectAutoRegister.autoRegister( { projectRoot, registry } )' ) ).toBe( true )
            // transcripts axis: hydrate the freshly-registered ids at the same gate.
            expect( /const registeredIds = configOutcomes\.flatMap/.test( src ) ).toBe( true )
            expect( /registeredIds\.map\(\s*\(\s*documentId\s*\)\s*=>\s*MemoView\.#hydrateMemoTranscripts/.test( src ) ).toBe( true )
        } )

        it( 'the cwd fallback branch ALSO hydrates transcripts for its registered ids (parity, not just documents)', () => {
            expect( src.includes( 'ProjectAutoRegister.autoRegister( { projectRoot: process.cwd(), registry } )' ) ).toBe( true )
            expect( /autoRegistered\.map\(\s*\(\s*documentId\s*\)\s*=>\s*MemoView\.#hydrateMemoTranscripts/.test( src ) ).toBe( true )
        } )

        it( '#hydrateMemoTranscripts runs scanMemo (the fact source POST used) so .loggedin is reloaded at boot', () => {
            expect( src.includes( 'static async #hydrateMemoTranscripts(' ) ).toBe( true )
            expect( /#hydrateMemoTranscripts[\s\S]*?scanMemo\(/.test( src ) ).toBe( true )
        } )
    } )


    describe( 'behavioural: a fixture MULTI-PROJECT workspace populates both axes at once', () => {
        const repoTmpRoot = join( process.cwd(), '.test-tmp' )
        let workspace = ''
        const docRegistries = []


        const makeMemoWithLoggedInTranscript = async ( { projectRoot, memoName } ) => {
            const memoDir = resolve( projectRoot, '.memo', 'memos', memoName )
            await mkdir( resolve( memoDir, 'revisions' ), { recursive: true } )
            await writeFile( resolve( memoDir, 'revisions', 'REV-01.md' ), `# ${memoName}\n\n| **Status** | Entwurf |\n`, 'utf8' )

            const transcriptsDir = resolve( memoDir, 'transcripts' )
            await mkdir( transcriptsDir, { recursive: true } )
            await writeFile( resolve( transcriptsDir, 'REV-01--review--01.md' ), `# review of ${memoName}\n\nsome spoken words here\n`, 'utf8' )
            // the completed-marker on disk — the exact fact the boot gap dropped before WI-046.
            await writeFile( resolve( transcriptsDir, 'REV-01.loggedin' ), '', 'utf8' )

            return memoDir
        }


        const trackedDocRegistry = () => {
            const { registry } = DocumentRegistry.create( {} )
            docRegistries.push( registry )

            return registry
        }


        beforeEach( async () => {
            await mkdir( repoTmpRoot, { recursive: true } )
            workspace = await mkdtemp( join( repoTmpRoot, 'bootparity-' ) )
        } )

        afterEach( async () => {
            docRegistries
                .splice( 0 )
                .forEach( ( reg ) => {
                    if( reg && typeof reg.shutdown === 'function' ) { reg.shutdown() }
                } )
            await rm( workspace, { recursive: true, force: true } )
        } )


        it( 'documents register AND transcripts (incl. .loggedin) load for EACH project, mirroring the boot loop', async () => {
            const projA = resolve( workspace, 'proj-a' )
            const projB = resolve( workspace, 'proj-b' )
            await makeMemoWithLoggedInTranscript( { projectRoot: projA, memoName: '001-alpha' } )
            await makeMemoWithLoggedInTranscript( { projectRoot: projB, memoName: '002-beta' } )

            const docRegistry = trackedDocRegistry()
            const transcriptRegistry = TranscriptRegistry.create( { onChange: () => {}, host: 'http://localhost:3333' } ).registry

            const projectRoots = [ projA, projB ]

            // mirror the boot gate: documents via autoRegister, transcripts via the per-memo scan.
            const outcomes = await Promise.all( projectRoots.map( async ( projectRoot ) => {
                const projectId = basename( projectRoot )
                const doc = await ProjectAutoRegister.autoRegister( { projectRoot, registry: docRegistry } )

                return { projectId, doc }
            } ) )

            // documents axis: both projects registered at least one memo.
            outcomes.forEach( ( { doc } ) => {
                expect( doc.status ).toBe( true )
                expect( doc.registered.length ).toBeGreaterThan( 0 )
            } )

            // transcripts axis: scan each memo's transcripts (as #hydrateMemoTranscripts does at boot).
            await Promise.all( [
                transcriptRegistry.scanMemo( { memoPath: resolve( projA, '.memo', 'memos', '001-alpha' ), projectId: basename( projA ), memoId: '001-alpha' } ),
                transcriptRegistry.scanMemo( { memoPath: resolve( projB, '.memo', 'memos', '002-beta' ), projectId: basename( projB ), memoId: '002-beta' } )
            ] )

            const tree = transcriptRegistry.getTranscriptTree().tree

            const leafA = tree[ basename( projA ) ][ '001-alpha' ].find( ( t ) => t.revisionId === 'REV-01' )
            const leafB = tree[ basename( projB ) ][ '002-beta' ].find( ( t ) => t.revisionId === 'REV-01' )

            expect( leafA ).toBeDefined()
            expect( leafB ).toBeDefined()
            // the completed-marker on disk is reconstructed → the revision would leave the queue, not reappear.
            expect( leafA.loggedIn ).toBe( true )
            expect( leafB.loggedIn ).toBe( true )
        } )
    } )
} )
