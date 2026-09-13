/**
 * Regression: runIndexFiles must hold the cross-process file lock for the
 * full duration of orchestrator.indexFiles, not just until the promise is
 * created.
 *
 * `return deps.orchestrator.indexFiles(filePaths);` inside a try/finally
 * completes the try block (and therefore runs `finally`) as soon as the
 * promise object exists -- it does not wait for that promise to settle.
 * That released the cross-process file lock while indexing (stat/readFile,
 * parsing, DB writes) was still in flight, letting a second process (CLI,
 * git hook, MCP server) acquire the same lock and start writing to the
 * same project mid-index.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Mutex, FileLock } from '../src/concurrency';
import { runIndexFiles, type IndexingDeps } from '../src/indexing-operations';
import type { ExtractionOrchestrator, IndexResult } from '../src/extraction';

describe('runIndexFiles file lock lifetime', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-indexfiles-lock-'));
    lockPath = path.join(tmpDir, 'codegraph.lock');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps the lock held until the underlying indexFiles() promise resolves', async () => {
    let resolveIndexing!: (result: IndexResult) => void;
    const indexingInFlight = new Promise<IndexResult>((resolve) => {
      resolveIndexing = resolve;
    });

    const deps: IndexingDeps = {
      indexMutex: new Mutex(),
      fileLock: new FileLock(lockPath),
      orchestrator: {
        indexFiles: () => indexingInFlight,
      } as unknown as ExtractionOrchestrator,
      queries: {} as IndexingDeps['queries'],
      resolver: {} as IndexingDeps['resolver'],
    };

    const runPromise = runIndexFiles(deps, ['a.ts']);

    // Drain the microtask queue up to the point where orchestrator.indexFiles()
    // has been invoked but its promise is still pending.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fs.existsSync(lockPath)).toBe(true); // still held while "indexing" is in flight

    resolveIndexing({
      success: true,
      filesIndexed: 1,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      durationMs: 0,
    });

    await runPromise;

    expect(fs.existsSync(lockPath)).toBe(false); // released only after indexing actually finished
  });
});
