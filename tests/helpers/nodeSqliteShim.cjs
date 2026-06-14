// PRD-010 (Memo 011 Kap 9) — jest module-mapper shim for the built-in `node:sqlite`.
//
// node:sqlite is an experimental Node 22 builtin and is NOT yet listed in module.builtinModules, so
// jest's default resolver cannot find it (it tries a bare "sqlite" npm package and fails). The jest
// config maps `node:sqlite` to this CJS shim.
//
// We MUST reach the genuine native binding. A plain require('node:sqlite') here re-enters jest's
// mapper (it matches the same regex) and loops back to this shim, yielding undefined classes.
// Module._load bypasses jest's sandbox resolver and returns the real native module, whose
// DatabaseSync/StatementSync we then re-export by name. Test-only indirection: production code
// (src/FindingsStore.mjs) imports 'node:sqlite' directly and never touches this file. No third-party
// SQLite dependency — this is the same Node built-in.

const Module = require( 'module' )
const sqlite = Module._load( 'node:sqlite', null, false )

Object.defineProperty( exports, '__esModule', { value: true } )

exports.DatabaseSync = sqlite.DatabaseSync
exports.StatementSync = sqlite.StatementSync
exports.constants = sqlite.constants
exports.default = sqlite
