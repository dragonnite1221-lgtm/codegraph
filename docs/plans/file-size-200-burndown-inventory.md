# 200-line file-size burndown — class/structure inventory

Working inventory for the 200-line gate (`scripts/check-file-size.cjs`,
`LIMIT = 200`, baseline `scripts/file-size-baseline.txt`). The gate freezes
existing violations and blocks new ones / baseline growth / stale entries.
Burn the baseline down with **behavior-preserving** splits, then regenerate
the baseline (`node scripts/check-file-size.cjs --write-baseline`).

This doc categorizes the **non-test** `src/` baseline files by their internal
shape, so the right split strategy is obvious before touching code. Test files
(`__tests__/*.test.ts`, the largest being `extraction.test.ts` at 3654 lines)
are tracked in the baseline but are **not** delegation targets — split them
only by topic (describe-block extraction) if at all.

## Split strategies

- **Class delegation** — class with many methods. Extract cohesive method
  groups into free functions in a sibling `*-<topic>.ts` that take the deps
  they need as explicit parameters (private fields passed in), or bind methods
  on the instance. The class keeps its public surface; bodies move out.
- **Function module split** — file is a bag of exported/free functions. Split
  by topic into sibling modules and re-export from the original path (façade)
  so import paths stay stable.
- **Data/decl split** — large static tables or per-language declaration maps.
  Split by category into sibling files; pure data, near-zero risk.
- **Type-only split** — interfaces/types only. Split and `export type` re-export.

In all cases: preserve the original module's public import path with a
re-export façade, keep pure moves separate from behavior changes, and run
`npm run build && npm test` after each split.

## Class-dominated files (delegation candidates)

These are single-class modules; the class body is the bulk of the file. Best
handled with the delegation pattern — extract method groups to free functions
taking explicit deps.

| File | Lines | Class | ~methods | Notes |
|------|------:|-------|---------:|-------|
| `src/index.ts` | 826 | `CodeGraph` | 65 | Public API façade; group by concern (init/index/query/context/watch). Keep `src/index.ts` as the re-exporting entry. |
| `src/db/queries.ts` | 498 | `QueryBuilder` | 63 | Prepared-statement groups by entity (nodes/edges/files/fts). Already has a sibling `node-queries.ts` — continue that split. |
| `src/db/sqlite-adapter.ts` | 474 | adapter | 64 | Native/wasm backend wrapper; split by op category. |
| `src/graph/traversal.ts` | 477 | `GraphTraverser` | 52 | BFS/DFS vs impact-radius vs path-finding are natural groups. |
| `src/graph/queries.ts` | 428 | `GraphQueryManager` | 59 | High-level query groups. |
| `src/extraction/tree-sitter.ts` | 446 | wrapper | 54 | Parser lifecycle vs node-walking helpers. |
| `src/mcp/tools.ts` | 479 | tools | 60 | One handler-group per MCP tool family; coordinate with `tool-definitions.ts`. |
| `src/resolution/index.ts` | 438 | `ReferenceResolver` | 51 | Orchestrator; import-resolution vs name-matching vs framework dispatch. |
| `src/extraction/index.ts` | 493 | `ExtractionOrchestrator` | 25 | Fewer/larger methods; extract per-phase helpers. |
| `src/db/node-queries.ts` | 318 | queries | 34 | Already a split-off; further group if needed. |
| `src/extraction/parse-worker-pool.ts` | 241 | pool | 42 | Worker lifecycle vs task dispatch. |
| `src/mcp/index.ts` | 363 | `MCPServer` | 31 | Transport/init vs request handling. |
| `src/extraction/svelte-extractor.ts` | 323 | extractor | 27 | Standalone extractor; split script/template/style passes. |
| `src/extraction/liquid-extractor.ts` | 352 | extractor | 16 | Tag/object/filter passes. |
| `src/installer/targets/claude.ts` | 254 | target | 29 | Mostly config IO; small overage. |
| `src/installer/targets/opencode.ts` | 244 | target | 21 | jsonc IO; small overage. |
| `src/installer/targets/cursor.ts` | 240 | target | 19 | Small overage; `--path` wiring lives here (preserve). |

## Function/helper-dominated files (façade split)

No class (or class is incidental); these are collections of free functions.
Split by topic and re-export from the original path.

| File | Lines | ~funcs | Notes |
|------|------:|-------:|-------|
| `src/extraction/pascal-extraction-helpers.ts` | 491 | 97+14 | Largest helper bag; split by Pascal construct family. |
| `src/context/context-helpers.ts` | 465 | 66 | Markdown vs JSON formatting helpers. |
| `src/resolution/name-matcher.ts` | 463 | 51 | Match strategies as separate modules. |
| `src/extraction/extractors-decl.ts` | 428 | 66 | Declaration extractors; split by node kind. |
| `src/context/context-search.ts` | 421 | 61 | Search/format split. |
| `src/extraction/extractors-misc.ts` | 357 | 57 | Misc extractors; split by kind. |
| `src/bin/codegraph.ts` | 486 | 48 | Commander CLI; one module per subcommand group. |
| `src/extraction/languages/kotlin.ts` | 238 | 54 | Per-language extractor; split by construct. |
| `src/mcp/explore-output.ts` | 348 | 43 | Output-budget formatting helpers. |
| `src/installer/index.ts` | 351 | 27 | Install orchestration; split detect/write/report. |
| `src/installer/targets/shared.ts` | 206 | 22 | Small overage; shared target helpers. |

## Data/declaration-dominated files (data split)

| File | Lines | Notes |
|------|------:|-------|
| `src/extraction/grammars.ts` | 297 | Grammar/wasm registration table; split by language family. |
| `src/mcp/tool-definitions.ts` | 221 | Static MCP tool schema objects; split by tool. Zero-risk data move. |

## Order of attack

1. **Data/decl files first** (`tool-definitions.ts`, `grammars.ts`) — lowest
   risk, fastest baseline wins.
2. **Façade splits** of the helper bags (`pascal-extraction-helpers.ts`,
   `context-helpers.ts`, `name-matcher.ts`) — re-export keeps callers stable.
3. **Class delegation** for the orchestrators (`index.ts`, `db/queries.ts`,
   `graph/*`, `resolution/index.ts`) — highest care; one method-group per PR,
   `npm run build && npm test` between each.
4. **Installer targets** last and only with matching
   `__tests__/installer-targets.test.ts` coverage (house rule).

After each batch, regenerate the baseline and confirm the gate still passes
with a strictly smaller count.
