# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CodeGraph is a local-first code intelligence library + CLI + MCP server. It parses any supported codebase with tree-sitter, stores symbols/edges/files in SQLite (FTS5), and exposes a knowledge graph to AI agents (Claude Code, Cursor, Codex CLI, opencode) over MCP. Per-project data lives in `.codegraph/`. Extraction is deterministic — derived from AST, not LLM-summarized.

Distributed as `@colbymchenry/codegraph` on npm; same binary serves as installer, indexer, and MCP server.

## Build, Test, Run

```bash
npm run build           # tsc + copy schema.sql and *.wasm into dist/; chmods dist/bin/codegraph.js
npm run dev             # tsc --watch
npm run clean           # rm -rf dist

npm test                # vitest run (all)
npm run test:watch
npm run test:eval       # only __tests__/evaluation/
npm run eval -- /path/to/indexed/codebase
                        # build then run __tests__/evaluation/runner.ts via tsx

npm run cli             # build then run the local dist binary

# Single test file / pattern
npx vitest run __tests__/installer-targets.test.ts
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

`copy-assets` (called from `build`) copies `src/db/schema.sql` and all `src/extraction/wasm/*.wasm` files into `dist/`. **Any new SQL or grammar wasm must be copied or it won't ship.**

Node engines: `>=18.0.0 <24.0.0`. There is a hard exit on Node 24.x and newer (see `src/bin/node-version-check.ts`).

## Architecture

### Layered pipeline

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

The public API surface is `src/index.ts` — the `CodeGraph` class wires all the layers and re-exports types. Library users only touch this file; the MCP server and CLI also drive it.

### Module layout

- `src/index.ts` — `CodeGraph` class: `init`/`open`/`close`, `indexAll`, `sync`, `searchNodes`, `getCallers`/`getCallees`, `getImpactRadius`, `buildContext`, `watch`/`unwatch`.
- `src/db/` — `DatabaseConnection`, `QueryBuilder` (prepared statements), `schema.sql`. Backed by `better-sqlite3` (native) when available, transparently falls back to `node-sqlite3-wasm`. `codegraph status` surfaces which backend is live; wasm is the slow path.
- `src/extraction/` — `ExtractionOrchestrator`, tree-sitter wrappers, per-language extractors under `languages/` (one file per language), plus standalone extractors for non-tree-sitter formats (`svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` for Delphi). `parse-worker.ts` runs heavy parsing off the main thread.
- `src/resolution/` — `ReferenceResolver` orchestrates `import-resolver.ts` (with `path-aliases.ts` for tsconfig path aliases + cargo workspace member globs), `name-matcher.ts`, and `frameworks/` (Express, Laravel, Rails, FastAPI, Django, Flask, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, Vue/Nuxt, Cargo workspaces). Frameworks emit `route` nodes and `references` edges.
- `src/graph/` — `GraphTraverser` (BFS/DFS, impact radius, path finding) and `GraphQueryManager` (high-level queries).
- `src/context/` — `ContextBuilder` + formatter for markdown/JSON output.
- `src/search/` — full-text query parser and helpers for FTS5.
- `src/sync/` — `FileWatcher` (native FSEvents/inotify/RDCW) with debounce + filter, and git-hook helpers.
- `src/mcp/` — MCP server (`MCPServer`, `tools.ts`, `transport.ts`). `server-instructions.ts` is what the server returns in the MCP `initialize` response — keep it in sync with the user-facing tool guidance.
- `src/installer/` — see below.
- `src/bin/codegraph.ts` — CLI (commander). Subcommands: `install`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `files`, `context`, `affected`, `serve --mcp`.
- `src/ui/` — terminal UI (shimmer progress, worker).

### NodeKind / EdgeKind

Defined in `src/types.ts`. Both extractors and resolvers must use these exact strings.

- **NodeKind**: `file`, `module`, `class`, `struct`, `interface`, `trait`, `protocol`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`.
- **EdgeKind**: `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.

### Multi-agent installer

`src/installer/` is the entry point for `codegraph install` (and the bare `codegraph`/`npx @colbymchenry/codegraph` invocation). Architecture:

- `targets/registry.ts` lists every supported agent.
- `targets/types.ts` defines the `AgentTarget` interface — adding a 5th agent (Continue, Zed, Windsurf…) is **one new file in `targets/` + one entry in `registry.ts`**. Each target owns its config-file location, MCP-server JSON/TOML/JSONC writing, and instructions-file path.
- Current targets: `claude.ts`, `cursor.ts`, `codex.ts`, `opencode.ts`.
- `targets/toml.ts` is a hand-rolled TOML serializer scoped to `[mcp_servers.codegraph]` (used by Codex). Sibling tables and `[[array_of_tables]]` are preserved verbatim. No new dependency.
- opencode reads `opencode.jsonc` by default; the installer prefers existing `.jsonc`, falls back to `.json`, and creates `.jsonc` for greenfield installs. Edits are surgical via `jsonc-parser` so user comments and formatting survive install/re-install/uninstall round-trips.
- `instructions-template.ts` is the agent-agnostic instructions file written to each target (e.g. `CLAUDE.md`, `.cursor/rules/codegraph.mdc`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`). It explicitly says "trust codegraph results, don't re-verify with grep" — earlier versions prescribed Claude-specific "spawn an Explore agent" and confused other agents.
- `claude-md-template.ts` is the legacy Claude-only template, retained for compatibility paths.
- All installer changes need matching coverage in `__tests__/installer-targets.test.ts` — there are ~47 parameterized contract tests covering install idempotency, sibling preservation, uninstall reverses install, byte-equal re-runs returning `unchanged`, and partial-state recovery for Codex.

### Cursor MCP working-directory quirk

Cursor launches MCP subprocesses with the wrong cwd and doesn't pass `rootUri` in `initialize`. The installer injects `--path` into Cursor's MCP args — absolute path for local installs, `${workspaceFolder}` for global installs. If you touch Cursor wiring, preserve this.

### MCP server instructions

`src/mcp/server-instructions.ts` is sent back to the agent in the MCP `initialize` response. This is the *first* thing every agent sees about how to use the tools — treat it as the authoritative tool guidance and keep it in sync with `instructions-template.ts` and `.cursor/rules/codegraph.mdc`.

## Tests

Tests live in `__tests__/` and mirror the module they cover. Notable ones beyond the obvious:

- `installer-targets.test.ts` — parameterized contract suite across all 4 agent targets (see installer notes above).
- `evaluation/` — `runner.ts` + `test-cases.ts` exercise codegraph against an already indexed codebase and score the results; run via `EVAL_CODEBASE=/path/to/indexed/codebase npm run eval` or `npm run eval -- /path/to/indexed/codebase` (builds first). The target must contain `.codegraph/codegraph.db`. Not part of `npm test`.
- `sqlite-backend.test.ts` — covers native + wasm backend selection and fallback.
- `pr19-improvements.test.ts`, `frameworks-integration.test.ts` — regression coverage for specific past PRs/incidents; don't rename these, the names anchor to git history.

Tests create temp dirs with `fs.mkdtempSync` and clean up in `afterEach`. They write real files and exercise real SQLite — there is no DB mocking.

- `mcp-initialize.test.ts` spawns the **built** server from `dist/`, so it asserts against the last `npm run build`, not your working tree. `npm test` runs `pretest` (build) first; a bare `npx vitest run __tests__/mcp-initialize.test.ts` skips the build and can fail on stale `dist/`. Run `npm run build` first when invoking that file directly.

## Releases

Released to npm and mirrored as [GitHub Releases](https://github.com/colbymchenry/codegraph/releases). `CHANGELOG.md` is the source of truth; GitHub Release notes are extracted from it.

### Writing changelog entries

When asked for an entry for a new version:

1. Add a new `## [X.Y.Z] - YYYY-MM-DD` block at the **top** of `CHANGELOG.md` (under the intro, above the previous version).
2. Group under `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security` — omit empty sections.
3. Write from the **user's perspective**, not the implementation's. Lead with the observable symptom or capability; mention internals only if a user needs them (e.g., to work around an existing bad install).
4. Add the link reference at the bottom: `[X.Y.Z]: https://github.com/colbymchenry/codegraph/releases/tag/vX.Y.Z`.

### Release flow (the user runs these)

After the changelog entry is written and `package.json` is bumped:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: X.Y.Z (<one-line summary>)"
git push
npm publish
./scripts/release.sh   # idempotent: tags vX.Y.Z, pushes, creates GitHub Release with notes from CHANGELOG.md
```

`scripts/release.sh` is safe to re-run after a partial failure — it skips steps already done (tag exists locally, tag on origin, release published). It extracts release notes from `CHANGELOG.md` by matching the `## [X.Y.Z]` block.

**Do not run `npm publish`, `git push`, `git tag`, or `./scripts/release.sh` yourself** — these are publish actions on shared state. Write the file, hand the user the commands.

## House rules

- The `0.7.x` line is in active multi-agent rollout. Any change to `src/installer/` (especially `targets/`) needs corresponding test coverage and a CHANGELOG entry — installer regressions break every new install silently.
- When changing what the MCP tools do or how agents should use them, update `src/mcp/server-instructions.ts` (the MCP `initialize` playbook) and `src/installer/instructions-template.ts` (the agent-agnostic body). `.cursor/rules/codegraph.mdc` is **generated** from the template — run `node scripts/gen-cursor-rule.cjs` after editing it, never hand-edit the `.mdc` body. `__tests__/instructions-sync.test.ts` enforces the sync: the `.mdc` body must equal `INSTRUCTIONS_TEMPLATE`, and all three docs must reference exactly the tools the MCP server registers.
- CodeGraph provides **code context**, not product requirements. For new features, ask the user about UX, edge cases, and acceptance criteria — the graph won't tell you.
- **200-line file-size gate.** `scripts/check-file-size.cjs` (`LIMIT = 200`, roots `src/` + `__tests__/`, excludes `.d.ts`) freezes existing oversized files in `scripts/file-size-baseline.txt` and blocks new violations, baseline growth, and stale entries. New `src/` files must stay ≤200 lines; never grow a baselined file. The CI workflow runs it, and `.githooks/pre-push` runs it locally — enable once with `git config core.hooksPath .githooks`. Regenerate the baseline only when you've genuinely shrunk files: `node scripts/check-file-size.cjs --write-baseline`. Burndown plan + per-file split strategy: `docs/plans/file-size-200-burndown-inventory.md`.
