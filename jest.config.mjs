// PRD-010 (Memo 011 Kap 9) — minimal jest config. The ONLY reason this file exists is to map the
// experimental built-in `node:sqlite` (not in module.builtinModules, so jest's default resolver
// cannot find it) to a thin ESM re-export shim. Everything else stays on jest defaults so the rest
// of the suite is unaffected. Production code imports 'node:sqlite' directly; the shim is test-only.

export default {
    moduleNameMapper: {
        '^node:sqlite$': '<rootDir>/tests/helpers/nodeSqliteShim.cjs'
    }
}
