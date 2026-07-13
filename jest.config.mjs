// PRD-010 (Memo 011 Kap 9) — minimal jest config. The ONLY reason this file exists is to map the
// experimental built-in `node:sqlite` (not in module.builtinModules, so jest's default resolver
// cannot find it) to a thin ESM re-export shim. Everything else stays on jest defaults so the rest
// of the suite is unaffected. Production code imports 'node:sqlite' directly; the shim is test-only.

export default {
    moduleNameMapper: {
        '^node:sqlite$': '<rootDir>/tests/helpers/nodeSqliteShim.cjs'
    },
    // The repo-local .trash/ holds retired sources/tests (e.g. the M072-05-01 plans-teardown).
    // Keep jest's default node_modules ignore AND exclude .trash so retired *.test.mjs are not run.
    testPathIgnorePatterns: [ '/node_modules/', '/\\.trash/' ]
}
