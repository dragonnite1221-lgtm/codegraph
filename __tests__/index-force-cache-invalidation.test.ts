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
});
