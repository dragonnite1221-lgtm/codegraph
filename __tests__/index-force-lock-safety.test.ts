/**
 * Regression: `codegraph index --force` must not destroy the existing graph
 * when it can't actually win the cross-process file lock.
 *
 * The CLI used to call `cg.clear()` unconditionally, then `cg.indexAll()`.
 * `clear()` deletes unresolved_refs/edges/nodes/files in its own DB
 * transaction with no locking at all. If another live process (a sync, the
 * MCP server, a git hook) held the project file lock, `indexAll()`'s own
 * `fileLock.acquire()` would fail and it would return `{ success: false }`
 * -- but the graph was already wiped by `clear()` moments earlier, with no
 * reindex to follow. The fix threads a `force` option into `indexAll` so
 * the clear only runs after the same mutex + file lock indexAll already
 * requires are held, and the CLI no longer clears eagerly.
 *
 * This drives the real `registerIndexCommand` action handler (the exact
 * code the finding points at), not just the lower-level indexAll option,
 * so it also guards against the CLI regressing back to an eager cg.clear().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Command } from 'commander';
import { registerIndexCommand } from '../src/bin/cli-index-commands';
import type { CliCommandDeps } from '../src/bin/cli-lifecycle-commands';
import { CodeGraph } from '../src';

describe('codegraph index --force vs. a concurrently held file lock', () => {
  let testDir: string;
  let lockPath: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-force-lock-'));
    fs.writeFileSync(
      path.join(testDir, 'a.ts'),
      `export function hello() {\n  return 'world';\n}\n`
    );

    const cg = await CodeGraph.init(testDir, { index: true });
    cg.destroy();
    lockPath = path.join(testDir, '.codegraph', 'codegraph.lock');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not wipe the existing graph when the CLI force-clear loses the lock race', async () => {
    // Simulate another live process holding the project's file lock (our
    // own PID always reports as alive, matching FileLock's liveness check).
    fs.writeFileSync(lockPath, String(process.pid));

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    const deps: CliCommandDeps = {
      resolveProjectPath: () => testDir,
      loadCodeGraph: () => import('../src/index'),
      importESM: async () => {
        throw new Error('not needed in --quiet mode');
      },
    };

    const program = new Command();
    registerIndexCommand(program, deps);

    await expect(
      program.parseAsync(['index', '--force', '--quiet'], { from: 'user' })
    ).rejects.toThrow('process.exit(1)');

    exitSpy.mockRestore();

    // Reopen and confirm the graph survived the rejected force-reindex.
    const check = await CodeGraph.open(testDir);
    try {
      expect(check.getFiles().length).toBeGreaterThan(0);
      expect(check.getNodesByKind('function').length).toBeGreaterThan(0);
    } finally {
      check.destroy();
    }
  });
});
