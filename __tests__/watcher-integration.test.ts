/**
 * FileWatcher callback + CodeGraph integration tests. Split out of
 * watcher.test.ts to stay within the file-size gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileWatcher } from '../src/sync/watcher';
import type { CodeGraphConfig } from '../src/types';
import CodeGraph from '../src/index';

/**
 * Helper to wait for a condition with timeout
 */
function waitFor(
  condition: () => boolean,
  timeoutMs = 10000,
  intervalMs = 100
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe('FileWatcher', () => {
  let testDir: string;

  const baseConfig: CodeGraphConfig = {
    version: 1,
    rootDir: '.',
    include: ['**/*.ts', '**/*.js'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    languages: [],
    frameworks: [],
    maxFileSize: 1024 * 1024,
    extractDocstrings: true,
    trackCallSites: true,
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watcher-'));
    // Create a source file so the directory isn't empty
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });


  describe('callbacks', () => {
    it('should call onSyncComplete after successful sync', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 2, durationMs: 50 });
      const onSyncComplete = vi.fn();
      const watcher = new FileWatcher(testDir, baseConfig, syncFn, {
        debounceMs: 200,
        onSyncComplete,
      });

      watcher.start();

      fs.writeFileSync(path.join(testDir, 'src', 'test.ts'), 'export const z = 3;');

      await waitFor(() => onSyncComplete.mock.calls.length > 0, 5000);
      expect(onSyncComplete).toHaveBeenCalledWith({ filesChanged: 2, durationMs: 50 });

      watcher.stop();
    });

    it('should call onSyncError when sync throws', async () => {
      const syncFn = vi.fn().mockRejectedValue(new Error('sync failed'));
      const onSyncError = vi.fn();
      const watcher = new FileWatcher(testDir, baseConfig, syncFn, {
        debounceMs: 200,
        onSyncError,
      });

      watcher.start();

      fs.writeFileSync(path.join(testDir, 'src', 'test.ts'), 'export const z = 3;');

      await waitFor(() => onSyncError.mock.calls.length > 0, 5000);
      expect(onSyncError).toHaveBeenCalled();
      expect(onSyncError.mock.calls[0]![0]).toBeInstanceOf(Error);

      watcher.stop();
    });
  });

  describe('CodeGraph integration', () => {
    let cg: CodeGraph;

    afterEach(() => {
      if (cg) cg.close();
    });

    it('should watch and unwatch via CodeGraph API', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      expect(cg.isWatching()).toBe(false);

      const started = cg.watch({ debounceMs: 200 });
      expect(started).toBe(true);
      expect(cg.isWatching()).toBe(true);

      cg.unwatch();
      expect(cg.isWatching()).toBe(false);
    });

    it('should stop watching on close', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      cg.watch({ debounceMs: 200 });
      expect(cg.isWatching()).toBe(true);

      cg.close();
      // After close, isWatching should be false
      // (we can't call isWatching after close since DB is closed,
      //  but we verify no errors are thrown)
    });

    it('should auto-sync when files change while watching', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const initialStats = cg.getStats();
      const initialNodes = initialStats.nodeCount;

      cg.watch({ debounceMs: 300 });

      // Add a new file with a function
      fs.writeFileSync(
        path.join(testDir, 'src', 'added.ts'),
        'export function added() { return 42; }'
      );

      // Wait for auto-sync to pick it up
      await waitFor(() => {
        const stats = cg.getStats();
        return stats.nodeCount > initialNodes;
      }, 10000);

      // The new function should be in the graph
      const results = cg.searchNodes('added');
      expect(results.length).toBeGreaterThan(0);

      cg.unwatch();
    });
  });
});
