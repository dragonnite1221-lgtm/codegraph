/**
 * Regression: `force`-reindexing a reused `CodeGraph` instance must not
 * resolve references against the `ReferenceResolver`'s stale caches.
 *
 * `runIndexAll` clears the DB (`queries.clear()`) once the lock is held for
 * a `force` reindex, then reruns extraction + resolution. The resolver's
 * `knownNames`/`knownFiles` caches (warmed once, then reused across calls)
 * are keyed off DB contents at warm-time. If they aren't invalidated when
 * the DB is cleared, resolution's pre-filter (`hasAnyPossibleMatch`) sees a
 * name that didn't exist in the old graph, decides it can't possibly match
 * anything, and silently drops the reference — producing an incomplete
 * graph with no error surfaced.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

describe('force-reindex on a reused CodeGraph instance', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-force-cache-'));
    fs.writeFileSync(
      path.join(testDir, 'a.ts'),
      `export function oldFn() {\n  return 1;\n}\n`
    );
    fs.writeFileSync(
      path.join(testDir, 'b.ts'),
      `import { oldFn } from './a';\n\nexport function useIt() {\n  return oldFn();\n}\n`
    );
  });

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('resolves calls to a brand-new symbol name after a force-reindex', async () => {
    cg = await CodeGraph.init(testDir, { index: true });

    // Rename the exported symbol and its only call site — a name the
    // resolver's caches, warmed on the first index, have never seen.
    fs.writeFileSync(
      path.join(testDir, 'a.ts'),
      `export function brandNewName() {\n  return 2;\n}\n`
    );
    fs.writeFileSync(
      path.join(testDir, 'b.ts'),
      `import { brandNewName } from './a';\n\nexport function useIt() {\n  return brandNewName();\n}\n`
    );

    const result = await cg.indexAll({ force: true });
    expect(result.success).toBe(true);

    const target = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'brandNewName');
    expect(target).toBeDefined();

    const incoming = cg.getIncomingEdges(target!.id);
    expect(incoming.some((e) => e.kind === 'calls')).toBe(true);
  });

  it('re-detects frameworks after a force-reindex on a reused instance', async () => {
    cg = await CodeGraph.init(testDir, { index: true });
    expect(cg.getDetectedFrameworks()).not.toContain('react');

    // package.json didn't exist at first index — framework detection reads
    // it via the resolver's fileCache, which must not serve a stale "file
    // not found" (null) result from before this file existed.
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.0.0' } })
    );

    const result = await cg.indexAll({ force: true });
    expect(result.success).toBe(true);
    expect(cg.getDetectedFrameworks()).toContain('react');
  });

  it('re-detects file-extension-based frameworks after force-reindex (no package.json signal)', async () => {
    // React's detector also matches on .tsx files present in the indexed
    // file table, with no package.json involved at all. That table is
    // emptied by `queries.clear()` and only repopulated once
    // orchestrator.indexAll() finishes -- reinitializing the resolver
    // before that (right after the clear) would see zero files and
    // always miss this signal, even though the .tsx file is right there
    // on disk in the force-reindexed result.
    cg = await CodeGraph.init(testDir, { index: true });
    expect(cg.getDetectedFrameworks()).not.toContain('react');

    fs.writeFileSync(
      path.join(testDir, 'component.tsx'),
      `export function Widget() { return null; }\n`
    );

    const result = await cg.indexAll({ force: true });
    expect(result.success).toBe(true);
    expect(cg.getDetectedFrameworks()).toContain('react');
  });

  it('re-resolves tsconfig path aliases after a force-reindex on a reused instance', async () => {
    fs.mkdirSync(path.join(testDir, 'src/utils'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'src/legacy'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'src/utils/format.ts'),
      `export function pickMe(): number { return 1; }\n`
    );
    fs.writeFileSync(
      path.join(testDir, 'src/legacy/format.ts'),
      `export function pickMe(): number { return 99; }\n`
    );
    fs.writeFileSync(
      path.join(testDir, 'src/main.ts'),
      `import { pickMe } from '@app/format';\nexport function go(): number { return pickMe(); }\n`
    );
    fs.writeFileSync(
      path.join(testDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: './src', paths: { '@app/*': ['utils/*'] } } })
    );

    cg = await CodeGraph.init(testDir, { index: true });

    const pickUtils = () =>
      cg.getNodesByKind('function').find((n) => n.name === 'pickMe' && n.filePath === 'src/utils/format.ts')!;
    const pickLegacy = () =>
      cg.getNodesByKind('function').find((n) => n.name === 'pickMe' && n.filePath === 'src/legacy/format.ts')!;

    expect(cg.getCallers(pickUtils().id).some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    expect(cg.getCallers(pickLegacy().id).some((c) => c.node.filePath === 'src/main.ts')).toBe(false);

    // Repoint the alias at the legacy directory instead — a cached, stale
    // projectAliases map would keep resolving '@app/format' to src/utils/
    // even though the config now says src/legacy/.
    fs.writeFileSync(
      path.join(testDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: './src', paths: { '@app/*': ['legacy/*'] } } })
    );

    const result = await cg.indexAll({ force: true });
    expect(result.success).toBe(true);

    expect(cg.getCallers(pickLegacy().id).some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    expect(cg.getCallers(pickUtils().id).some((c) => c.node.filePath === 'src/main.ts')).toBe(false);
  });

  it('does not wipe the graph on a force-reindex called with an already-aborted signal', async () => {
    cg = await CodeGraph.init(testDir, { index: true });

    const controller = new AbortController();
    controller.abort();

    const result = await cg.indexAll({ force: true, signal: controller.signal });
    expect(result.success).toBe(false);

    // orchestrator.indexAll() only checks `signal.aborted` after its scan
    // phase -- too late to stop `queries.clear()`, which runs before it.
    // The graph from the initial index must survive an abort that happened
    // before any real work could start.
    expect(cg.getFiles().length).toBeGreaterThan(0);
    expect(cg.getNodesByKind('function').length).toBeGreaterThan(0);
  });
});
