import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'


// Memo 082, M082-09-FX2 — WHERE a cross-repo twin lives. One rule for the whole boundary.
//
// WHAT THIS REPLACES, AND WHY IT WAS A SILENT FAILURE. Three suites used to compute the sibling
// repository out of the NAME of the directory they happened to run in: take the basename of the repo
// root, cut the leading repo prefix off it, glue the sibling's name in front of the remainder, and
// look for a neighbour by that name. On 2026-09-27 the rollout moved its worktrees to
// `.worktrees/082/<slug>`, the directory name lost its prefix, the cut produced an empty remainder,
// the candidate collapsed to a bare `core` beside the worktree — which did not exist — and 22 cases
// were SKIPPED while the suite reported rc=0. A green over a set nobody had measured.
//
// THE RULE NOW. `git rev-parse --git-common-dir` answers, from EVERY linked worktree, with the git
// directory of the MAIN repository, independent of where that worktree sits and what it is called.
// Measured: from `.worktrees/082/viewer-p9-fx2` it answers
// `<root>/repos/viewer/.git`. The twin is then the neighbour of that main repository. The decisive
// property is negative: `siblingFilePath` takes the main repository and nothing else, so the name of
// the tree a suite runs in cannot reach the derivation at all — no rename can move the twin again.
//
// THREE SITUATIONS THAT MUST NOT LOOK ALIKE. A cross-repo case can miss its twin for reasons of very
// different weight, and the old guard collapsed all of them into one quiet `it.skip`:
//
//   `derivation`   — the main repository is not determinable (no git, or git refuses). That is a
//                    defect of the APPARATUS, not an absent object. RED.
//   `missing-repo` — the main repository sits among sibling repositories, but the named sibling root
//                    is not there. The boundary exists and the path into it is broken. RED.
//   `missing-file` — the sibling repository is there and the twin file inside it is not. That is a
//                    real PARITY finding, the very thing these suites exist to catch. RED.
//   `standalone`   — the main repository is the only repository under its parent: this checkout stands
//                    outside a multi-repo tree, so the cross-repo boundary does not exist here at all
//                    (CI checks each repo out alone — M080/PRD-V4). The precondition is legitimately
//                    absent and NO path is broken. This, and only this, stays `it.skip`.
//
// `siblingFailureMessage` names the resolved twin path, the main repository and the sibling repos it
// counted in every red case, so "broken twin" and "broken path" stay distinguishable in the text.


// Run git without a shell — the argument vector is built here, nothing from a caller reaches git as an
// option. Returns an object in every case; a non-zero git is a reported answer, never a throw.
function runGit( { args, cwd } ) {
    try {
        const text = execFileSync( 'git', args, { cwd, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } )

        return { status: true, text: text.trim(), reason: null }
    } catch ( error ) {
        const first = String( error.message ).split( '\n' )[ 0 ]

        return { status: false, text: '', reason: `git ${ args.join( ' ' ) } failed in ${ cwd }: ${ first }` }
    }
}


// `--path-format=absolute` needs git 2.31; the plain form is the fallback and answers relative to the
// working directory, which `resolve` below folds in. Measured on git 2.37.1: the absolute form answers
// `<root>/repos/viewer/.git`, the plain form answers `../../.git` from `tests/unit`.
//
// THE ANSWER IS VERIFIED, NOT TRUSTED — a counter-probe found this the hard way. `git rev-parse` ECHOES
// an argument it does not recognise instead of failing, so on a git older than 2.31 the output is two
// lines, the first of them the unrecognised `--path-format=absolute`. Reading the whole output as a path
// then produced a plausible-looking directory that was never a git directory at all. Hence: take the
// LAST line, and require the resolved directory to exist. A git directory that is not on disk is a
// failed derivation, never a path to compare against.
function gitCommonDir( { from } ) {
    const absolute = runGit( { args: [ 'rev-parse', '--path-format=absolute', '--git-common-dir' ], cwd: from } )
    const answer = absolute.status === true && absolute.text !== '' ? absolute : runGit( { args: [ 'rev-parse', '--git-common-dir' ], cwd: from } )

    if( answer.status === false ) {
        return { status: false, path: null, reason: answer.reason }
    }

    const lines = answer.text
        .split( '\n' )
        .map( ( line ) => line.trim() )
        .filter( ( line ) => line !== '' )

    if( lines.length === 0 ) {
        return { status: false, path: null, reason: `git rev-parse --git-common-dir answered empty in ${ from }` }
    }

    const path = resolve( from, lines[ lines.length - 1 ] )

    if( existsSync( path ) === false ) {
        return { status: false, path: null, reason: `git rev-parse --git-common-dir answered ${ JSON.stringify( lines ) } in ${ from }, which resolves to ${ path } — no such git directory` }
    }

    return { status: true, path, reason: null }
}


// The main repository's work-tree root — the parent of its git directory. From a linked worktree this
// is the MAIN tree, which is the whole point of `--git-common-dir`.
function mainRepoRoot( { from } ) {
    const gitDir = gitCommonDir( { from } )

    if( gitDir.status === false ) {
        return { status: false, root: null, reason: gitDir.reason }
    }

    return { status: true, root: dirname( gitDir.path ), reason: null }
}


// Pure: the twin's path from the MAIN repository alone. Takes no directory name, computes no name, and
// therefore cannot be moved by a rename — this is the function the named-input cases measure.
function siblingFilePath( { mainRepo, repo, segments } ) {
    const base = resolve( dirname( mainRepo ), repo )

    return segments.reduce( ( acc, segment ) => resolve( acc, segment ), base )
}


// Is this checkout part of a multi-repo tree at all? MEASURED, not declared: count the repositories
// that share the main repository's parent directory. Two or more means the cross-repo boundary exists
// here and a missing twin is a finding; one means the repo stands alone (CI) and there is nothing to
// compare against. The count travels into every message so the verdict states its basis.
function siblingRepoLayout( { mainRepo } ) {
    const parent = dirname( mainRepo )
    const entries = ( () => {
        try {
            return readdirSync( parent )
        } catch {
            return []
        }
    } )()
    const repos = entries
        .filter( ( entry ) => existsSync( resolve( parent, entry, '.git' ) ) === true )
        .sort()

    return { status: repos.length >= 2, parent, repos, count: repos.length }
}


// The project root — the directory holding `repos/`, and with it the workbench `.memo/` store. Derived
// from the main repository for the same reason the twin is: counting levels up from a test file broke the
// moment the rollout moved its worktrees (`.memo/memos` then resolved under `.worktrees/`, where nothing
// of the kind exists, and three cases went quietly to skip).
function projectRoot( { from } ) {
    const main = mainRepoRoot( { from } )

    if( main.status === false ) {
        return { status: false, root: null, mainRepo: null, reason: main.reason }
    }

    return { status: true, root: dirname( dirname( main.root ) ), mainRepo: main.root, reason: null }
}


// Pure: the `worktree`/`branch` pairs out of `git worktree list --porcelain`. A parse of a documented
// machine format — not an inference from a directory name, which is the thing that broke.
function parseWorktreePorcelain( { text } ) {
    return text
        .split( '\n' )
        .reduce( ( acc, line ) => {
            if( line.startsWith( 'worktree ' ) === true ) {
                return acc.concat( [ { path: line.slice( 'worktree '.length ).trim(), branch: null } ] )
            }
            if( line.startsWith( 'branch ' ) === true && acc.length > 0 ) {
                const ref = line.slice( 'branch '.length ).trim()
                acc[ acc.length - 1 ].branch = ref.startsWith( 'refs/heads/' ) === true ? ref.slice( 'refs/heads/'.length ) : ref

                return acc
            }

            return acc
        }, [] )
}


// Pure: the sibling worktree checked out on the SAME BRANCH NAME. This restores what PRD-39 wanted — a
// test reads the boundary belonging to its OWN work — without the fragility it used: the branch is a fact
// about the work, the directory name was only a fact about where a rollout happened to put it.
function siblingWorktreeForBranch( { entries, branch } ) {
    const hit = entries
        .filter( ( entry ) => entry.branch === branch )

    return { status: hit.length > 0, path: hit.length > 0 ? hit[ 0 ].path : null, candidates: entries.length }
}


// The branch this tree is on, or null when it is detached. A detached tree has no own work to match, so
// it falls back to the sibling's main line — and the fallback is NAMED, never silent.
function currentBranch( { from } ) {
    const answer = runGit( { args: [ 'symbolic-ref', '--short', '-q', 'HEAD' ], cwd: from } )

    if( answer.status === false || answer.text === '' ) {
        return { status: false, branch: null, reason: `no branch (detached HEAD) in ${ from }` }
    }

    return { status: true, branch: answer.text.split( '\n' )[ 0 ].trim(), reason: null }
}


// The own-branch sibling worktree, measured against the sibling repository's own worktree list.
function ownBranchTwin( { from, repoRoot, segments } ) {
    const branch = currentBranch( { from } )

    if( branch.status === false ) {
        return { status: false, path: null, branch: null, reason: branch.reason }
    }

    const listed = runGit( { args: [ 'worktree', 'list', '--porcelain' ], cwd: repoRoot } )

    if( listed.status === false ) {
        return { status: false, path: null, branch: branch.branch, reason: listed.reason }
    }

    const entries = parseWorktreePorcelain( { text: listed.text } )
    const hit = siblingWorktreeForBranch( { entries, branch: branch.branch } )

    if( hit.status === false ) {
        return { status: false, path: null, branch: branch.branch, reason: `no worktree of ${ repoRoot } is on branch ${ branch.branch } (${ hit.candidates } checked)` }
    }

    const path = segments.reduce( ( acc, segment ) => resolve( acc, segment ), hit.path )

    return { status: true, path, branch: branch.branch, worktree: hit.path, reason: null }
}


// The one entry point the suites use. Returns the resolved path in EVERY case — including the red ones,
// because a message that cannot name the path it failed on is the defect this replaces.
//
// TWO CANDIDATES, IN ORDER, AND THE CHOICE IS DECLARED. (1) the sibling worktree on the SAME BRANCH NAME,
// (2) the sibling repository's main line as the fallback. `origin` says which one was taken, and every
// caller prints it — because a green against the own branch and a green against main are two DIFFERENT
// statements, and whoever reads the number has to know which one they got. Measured reason for the order:
// `repos/core` main carries 0 members of the answered-provenance family while the branch `p9-prd08`
// carries 5, and main holds 0 M082 commits at all — comparing always against main would make the case red
// for the whole rollout, which is noise, and noise gets read away.
function resolveSiblingFile( { from, repo, segments } ) {
    const main = mainRepoRoot( { from } )

    if( main.status === false ) {
        return { status: false, kind: 'derivation', origin: null, path: null, mainRepo: null, repoRoot: null, layout: null, branch: null, reason: main.reason }
    }

    const layout = siblingRepoLayout( { mainRepo: main.root } )
    const repoRoot = resolve( dirname( main.root ), repo )
    const mainPath = siblingFilePath( { mainRepo: main.root, repo, segments } )

    if( layout.status === false ) {
        return { status: false, kind: 'standalone', origin: 'main', path: mainPath, mainRepo: main.root, repoRoot, layout, branch: null, reason: `${ layout.count } repository under ${ layout.parent } — this checkout stands outside a multi-repo tree, the ${ repo } boundary does not exist here` }
    }
    if( existsSync( repoRoot ) === false ) {
        return { status: false, kind: 'missing-repo', origin: 'main', path: mainPath, mainRepo: main.root, repoRoot, layout, branch: null, reason: `the sibling repository root is absent although ${ layout.count } repositories share ${ layout.parent } — the path into the boundary is broken, the twin is not` }
    }

    const own = ownBranchTwin( { from, repoRoot, segments } )
    const origin = own.status === true ? 'own-branch' : 'main'
    const path = own.status === true ? own.path : mainPath
    const fallbackReason = own.status === true ? null : own.reason

    if( existsSync( path ) === false ) {
        return { status: false, kind: 'missing-file', origin, path, mainRepo: main.root, repoRoot, layout, branch: own.branch, reason: `the ${ origin } twin is absent although its repository is present — a parity finding, not a path problem${ origin === 'main' ? ` (fell back to main: ${ fallbackReason })` : '' }` }
    }

    return { status: true, kind: 'resolved', origin, path, mainRepo: main.root, repoRoot, layout, branch: own.branch, worktree: own.status === true ? own.worktree : repoRoot, fallbackReason, reason: null }
}


// The one line a cross-repo case prints so its number is readable: WHICH twin was compared, and whether
// that twin is the own branch or the sibling's main line.
function siblingOriginLine( { label, twin } ) {
    const where = twin.origin === 'own-branch' ? `own branch ${ twin.branch }` : `sibling main line (${ twin.fallbackReason === null || twin.fallbackReason === undefined ? 'no branch to match' : twin.fallbackReason })`

    return `[${ label }] twin=${ twin.path } origin=${ twin.origin } via ${ where }`
}


// The red message. Names the resolved path, the main repository and the measured sibling count, so a
// reader can tell a broken twin from a broken path without re-running anything.
function siblingFailureMessage( { twin } ) {
    const layout = twin.layout === null ? '<not measured>' : `${ twin.layout.count } in ${ twin.layout.parent } (${ twin.layout.repos.join( ', ' ) })`
    const lines = [
        `cross-repo twin unusable [${ twin.kind }] — ${ twin.reason }`,
        `  derived twin file : ${ twin.path === null ? '<not derivable>' : twin.path }`,
        `  twin chosen from  : ${ twin.origin === null ? '<not derivable>' : twin.origin }${ twin.branch === null || twin.branch === undefined ? '' : ` (branch ${ twin.branch })` }`,
        `  main repository   : ${ twin.mainRepo === null ? '<not derivable>' : twin.mainRepo }`,
        `  sibling repo root : ${ twin.repoRoot === null ? '<not derivable>' : twin.repoRoot }`,
        `  repositories seen : ${ layout }`
    ]

    return lines.join( '\n' )
}


// Call this as the first statement of a cross-repo case. It THROWS — which is a jest failure — for
// every path-related absence, and the throw carries the resolved path. The only situation it is never
// reached in is `standalone`, because the suite has skipped the case before it runs.
function assertSiblingResolved( { twin } ) {
    if( twin.status === true ) {
        return { status: true, path: twin.path }
    }

    throw new Error( siblingFailureMessage( { twin } ) )
}


export { resolveSiblingFile, siblingFilePath, siblingRepoLayout, mainRepoRoot, projectRoot, parseWorktreePorcelain, siblingWorktreeForBranch, currentBranch, assertSiblingResolved, siblingFailureMessage, siblingOriginLine }
