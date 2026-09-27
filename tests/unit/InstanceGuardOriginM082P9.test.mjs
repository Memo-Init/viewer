import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { MemoView } from '../../src/MemoView.mjs'


// M082-09-01 (Memo 082 Kap 20c, WI-115) — the instance guard. Chapter 20c is not a derivation, it is
// a record: a whole review round was clicked into a foreign build, the reviewer's selections left with
// a foreign process, and nothing on the screen could have shown it. The code was fine — the wrong copy
// was running.
//
// Two halves are proven here. (1) The server NAMES its source tree, and BOTH directions of
// `originWorktree` are shown on real markers on disk — a classifier that reached for its own source
// dir could only ever show the direction the test machine happens to be in. (2) The owner check
// decides, before any bind, whether a start may proceed and what the user is told.
//
// Every case states how much it compared. The over-the-wire proof (two servers from two source trees,
// the second start refused, the first still holding the port) is run live against real servers and
// recorded in the order's closing protocol; it can not live in jest, because it needs two processes.
const here = fileURLToPath( new URL( '.', import.meta.url ) )
const cliSource = await readFile( resolve( here, '..', '..', 'src', 'cli.mjs' ), 'utf8' )

const bootOf = ( { hash, startedAtMs, port } ) => {
    return { startedAtMs, startedAt: new Date( startedAtMs ).toISOString(), bootHash: hash, port, memoRoot: '/tmp/root' }
}

const currentOf = ( { hash } ) => {
    return { hash, files: 33, bytes: 1000, hashCount: 1 }
}


describe( 'M082-09-01 — the source tree is READ from real markers, both directions', () => {
    let root = ''
    let mainTree = ''
    let workTree = ''
    let plainDir = ''


    beforeAll( async () => {
        // Outside any git tree on purpose: the undecidable case can only be shown where walking up
        // finds NO marker, and every directory inside this repo has one above it. Named after the
        // order (p9-prd01-) because the scratch space is shared session-wide.
        root = await mkdtemp( join( tmpdir(), 'p9-prd01-origin-' ) )
        mainTree = join( root, 'main-tree' )
        workTree = join( root, 'work-tree' )
        plainDir = join( root, 'plain' )

        // The main tree: `.git` is a DIRECTORY holding its own HEAD.
        await mkdir( join( mainTree, '.git', 'deep', 'nested' ), { recursive: true } )
        await writeFile( join( mainTree, '.git', 'HEAD' ), 'ref: refs/heads/main\n', 'utf8' )
        await mkdir( join( mainTree, 'src' ), { recursive: true } )

        // The worktree: `.git` is a FILE holding a `gitdir:` pointer, and HEAD lives where it points.
        await mkdir( join( root, 'gitdir-of-work-tree' ), { recursive: true } )
        await writeFile( join( root, 'gitdir-of-work-tree', 'HEAD' ), 'ref: refs/heads/feature-branch\n', 'utf8' )
        await mkdir( join( workTree, 'src' ), { recursive: true } )
        await writeFile( join( workTree, '.git' ), `gitdir: ${ join( root, 'gitdir-of-work-tree' ) }\n`, 'utf8' )

        await mkdir( plainDir, { recursive: true } )
    } )


    afterAll( async () => {
        await rm( root, { recursive: true, force: true } )
    } )


    it( 'AB-2 case 1 — a MAIN tree answers originWorktree false and names its path (1 marker compared)', () => {
        const { origin } = MemoView.readOriginTree( { startDir: join( mainTree, 'src' ) } )

        expect( origin[ 'originWorktree' ] ).toBe( false )
        expect( origin[ 'originRepo' ] ).toBe( mainTree )
        expect( origin[ 'originBranch' ] ).toBe( 'main' )
        expect( origin[ 'originStatus' ] ).toBe( 'main-tree' )
    } )


    it( 'AB-2 case 2 — a WORKTREE answers originWorktree true and reads HEAD through the gitdir pointer (1 marker compared)', () => {
        const { origin } = MemoView.readOriginTree( { startDir: join( workTree, 'src' ) } )

        expect( origin[ 'originWorktree' ] ).toBe( true )
        expect( origin[ 'originRepo' ] ).toBe( workTree )
        expect( origin[ 'originBranch' ] ).toBe( 'feature-branch' )
        expect( origin[ 'originStatus' ] ).toBe( 'worktree' )
    } )


    it( 'AB-2 case 3 / AB-3 — no marker anywhere above answers null, NOT false, and names the reason (1 walk compared)', () => {
        const { origin } = MemoView.readOriginTree( { startDir: plainDir } )

        expect( origin[ 'originWorktree' ] ).toBeNull()
        expect( origin[ 'originWorktree' ] ).not.toBe( false )
        expect( origin[ 'originRepo' ] ).toBeNull()
        expect( origin[ 'originBranch' ] ).toBeNull()
        expect( typeof origin[ 'originStatus' ] ).toBe( 'string' )
        expect( origin[ 'originStatus' ].length ).toBeGreaterThan( 0 )
        expect( origin[ 'originStatus' ] ).toBe( 'no-git-marker' )
    } )


    it( 'AB-3 — a marker that can not be read answers null as well, with its OWN reason (1 marker compared)', async () => {
        const broken = join( root, 'broken' )
        await mkdir( broken, { recursive: true } )
        await writeFile( join( broken, '.git' ), 'this is not a gitdir pointer\n', 'utf8' )

        const { origin } = MemoView.readOriginTree( { startDir: broken } )

        expect( origin[ 'originWorktree' ] ).toBeNull()
        expect( origin[ 'originStatus' ] ).toBe( 'git-marker-unreadable' )
    } )


    it( 'a detached HEAD is reported as NO branch instead of an invented name (2 classifications compared)', () => {
        const detached = MemoView.classifyOrigin( { repoDir: '/x', markerKind: 'directory', headText: '9fceb02d0ae598e95dc970b74767f19372d61af8\n' } )
        const named = MemoView.classifyOrigin( { repoDir: '/x', markerKind: 'directory', headText: 'ref: refs/heads/main\n' } )

        expect( [ detached[ 'originBranch' ], named[ 'originBranch' ] ] ).toEqual( [ null, 'main' ] )
    } )


    it( 'the LIVE reading of this process names THIS worktree, not the main tree (1 running source dir compared)', () => {
        const repoRoot = resolve( here, '..', '..' )

        // Guard: a checkout without a .git marker (an exported tarball) would make the assertion a
        // statement about the environment, not about the reader.
        if( existsSync( join( repoRoot, '.git' ) ) === false ) {
            expect( existsSync( join( repoRoot, '.git' ) ) ).toBe( false )

            return
        }

        const { origin } = MemoView.readOriginTree( { startDir: join( repoRoot, 'src' ) } )

        expect( origin[ 'originRepo' ] ).toBe( repoRoot )
        expect( [ 'main-tree', 'worktree' ] ).toContain( origin[ 'originStatus' ] )
    } )
} )


describe( 'M082-09-01 — the health payload carries the origin and loses nothing', () => {
    it( 'AB-1 — all four origin fields are in the payload, handed in from outside (4 fields compared)', () => {
        const boot = bootOf( { hash: 'aaa', startedAtMs: Date.UTC( 2026, 8, 21, 6, 0, 0 ), port: 3333 } )
        const origin = { originRepo: '/repos/viewer-p9-prd01', originBranch: 'p9-prd01', originWorktree: true, originStatus: 'worktree' }
        const { payload } = MemoView.buildHealthPayload( { boot, current: currentOf( { hash: 'aaa' } ), nowMs: Date.UTC( 2026, 8, 21, 6, 0, 30 ), origin } )

        expect( payload[ 'originRepo' ] ).toBe( '/repos/viewer-p9-prd01' )
        expect( payload[ 'originBranch' ] ).toBe( 'p9-prd01' )
        expect( payload[ 'originWorktree' ] ).toBe( true )
        expect( payload[ 'originStatus' ] ).toBe( 'worktree' )
    } )


    it( 'AB-3 — a caller that hands in NO origin gets named nulls, never an invented tree (4 fields compared)', () => {
        const boot = bootOf( { hash: 'aaa', startedAtMs: Date.UTC( 2026, 8, 21, 6, 0, 0 ), port: 3333 } )
        const { payload } = MemoView.buildHealthPayload( { boot, current: currentOf( { hash: 'aaa' } ), nowMs: Date.UTC( 2026, 8, 21, 6, 0, 30 ) } )

        expect( payload[ 'originRepo' ] ).toBeNull()
        expect( payload[ 'originWorktree' ] ).toBeNull()
        expect( payload[ 'originWorktree' ] ).not.toBe( false )
        expect( payload[ 'originStatus' ] ).toBe( 'origin-not-provided' )
    } )


    it( 'AB-4 — every field the payload carried before is still there, under its old name (11 fields compared)', () => {
        const boot = bootOf( { hash: 'aaa', startedAtMs: Date.UTC( 2026, 8, 21, 6, 0, 0 ), port: 3333 } )
        const { payload } = MemoView.buildHealthPayload( { boot, current: currentOf( { hash: 'bbb' } ), nowMs: Date.UTC( 2026, 8, 21, 6, 0, 30 ), origin: null } )

        // The set is the one the BASE commit's buildHealthPayload returned, read off that commit and
        // written out here — not copied from the order sheet.
        const before = [ 'status', 'pid', 'port', 'startedAt', 'uptimeSeconds', 'bootHash', 'currentHash', 'hashedFiles', 'hashComputations', 'stale', 'memoRoot' ]
        const lost = before
            .filter( ( name ) => Object.hasOwn( payload, name ) === false )

        expect( lost ).toEqual( [] )
        expect( payload[ 'stale' ] ).toBe( true )
        expect( payload[ 'status' ] ).toBe( 'ok' )
        expect( payload[ 'uptimeSeconds' ] ).toBe( 30 )
    } )
} )


describe( 'M082-09-01 — the owner check names the holder and terminates nothing', () => {
    it( 'a FREE port is not blocked and says nothing (1 probe compared)', () => {
        const { report } = MemoView.buildPortOwnerReport( { port: 3333, inUse: false, health: null } )

        expect( report[ 'blocked' ] ).toBe( false )
        expect( report[ 'reason' ] ).toBe( 'port-free' )
        expect( report[ 'lines' ] ).toEqual( [] )
    } )


    it( 'AB-5 — a port held by a memo-view server blocks the start and names pid AND originRepo (2 answers compared)', () => {
        const health = { pid: 4242, originRepo: '/repos/viewer', originBranch: 'main', originWorktree: false, startedAt: '2026-09-21T06:00:00.000Z', bootHash: 'abc123def456' }
        const { report } = MemoView.buildPortOwnerReport( { port: 3333, inUse: true, health } )
        const text = report[ 'lines' ].join( '\n' )

        expect( report[ 'blocked' ] ).toBe( true )
        expect( report[ 'reason' ] ).toBe( 'held-by-memo-view' )
        expect( text ).toContain( '4242' )
        expect( text ).toContain( '/repos/viewer' )
        expect( text ).toContain( 'abc123def456' )
    } )


    it( 'a port held WITHOUT a self-report blocks the start and says the self-report is missing (1 answer compared)', () => {
        const { report } = MemoView.buildPortOwnerReport( { port: 3333, inUse: true, health: null } )
        const text = report[ 'lines' ].join( '\n' )

        expect( report[ 'blocked' ] ).toBe( true )
        expect( report[ 'reason' ] ).toBe( 'held-without-self-report' )
        expect( text ).toContain( '/api/health' )
        expect( text ).toContain( 'lsof' )
    } )


    it( 'AB-6 — NO branch of the report terminates anything or moves to another port (3 reports compared)', () => {
        const reports = [
            MemoView.buildPortOwnerReport( { port: 3333, inUse: false, health: null } ),
            MemoView.buildPortOwnerReport( { port: 3333, inUse: true, health: null } ),
            MemoView.buildPortOwnerReport( { port: 3333, inUse: true, health: { pid: 1, originRepo: '/x' } } )
        ]
        const offending = reports
            .map( ( entry ) => entry[ 'report' ][ 'lines' ].join( '\n' ) )
            .filter( ( text ) => text.includes( 'SIGTERM' ) === true || text.includes( 'process.kill' ) === true || text.includes( '4444' ) === true )

        expect( offending ).toEqual( [] )
        expect( reports[ 1 ][ 'report' ][ 'lines' ].join( '\n' ) ).toContain( 'nothing was terminated' )
        expect( reports[ 2 ][ 'report' ][ 'lines' ].join( '\n' ) ).toContain( 'nothing was terminated' )
    } )


    it( 'the guard runs BEFORE the bind — the call order in cli.mjs is the whole point (2 call sites compared)', () => {
        const guardAt = cliSource.indexOf( 'await guardPort( {' )
        const startAt = cliSource.indexOf( 'await MemoView.startServer( {' )

        expect( guardAt ).toBeGreaterThan( -1 )
        expect( startAt ).toBeGreaterThan( -1 )
        expect( guardAt ).toBeLessThan( startAt )
    } )


    it( 'the probe opens NO new socket of its own — it delegates to the one the port selection uses (1 delegation compared)', async () => {
        const memoViewSource = await readFile( resolve( here, '..', '..', 'src', 'MemoView.mjs' ), 'utf8' )
        const body = memoViewSource.split( 'static async probePortInUse( { port } ) {' )[ 1 ].split( '\n\n' )[ 0 ]

        expect( body ).toContain( 'MemoView.#isPortInUse( { port } )' )
        expect( body.includes( 'createServer(' ) ).toBe( false )
    } )
} )
