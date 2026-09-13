/**
 * Regression: runIndexAll must not clear the graph for a force-reindex
 * until orchestrator.indexAll() has itself passed its post-scan abort
 * check -- i.e. right before it actually starts parsing.
 *
 * `deps.queries.clear()` used to run eagerly before calling into
 * orchestrator.indexAll() at all. orchestrator.indexAll() only checks
 * `signal.aborted` AFTER its own (async) scan phase; if the caller's signal
 * got aborted during grammar init or the directory scan -- after the clear
 * already ran, but before any parsing (replacement work) started -- the
 * previous graph was destroyed for nothing. The fix threads a `beforeParse`
 * callback into orchestrator.indexAll(), invoked only once its own abort
 * gate has passed, and runIndexAll uses it to defer the clear that far.
 */
import { describe, it, expect, vi } from 'vitest';
import { Mutex, FileLock } from '../src/concurrency';
import { runIndexAll, type IndexingDeps } from '../src/indexing-operations';
import type { ExtractionOrchestrator, IndexResult } from '../src/extraction';
import type { QueryBuilder } from '../src/db/queries';

function makeDeps(
  fakeOrchestratorIndexAll: ExtractionOrchestrator['indexAll'],
  clearSpy: () => void
): IndexingDeps {
  return {
    indexMutex: new Mutex(),
    fileLock: { acquire: () => {}, release: () => {} } as unknown as FileLock,
    orchestrator: { indexAll: fakeOrchestratorIndexAll } as unknown as ExtractionOrchestrator,
    queries: { clear: clearSpy } as unknown as QueryBuilder,
    resolver: { initialize: () => {} } as unknown as IndexingDeps['resolver'],
  };
}

const emptyResult: IndexResult = {
  success: false,
  filesIndexed: 0,
  filesSkipped: 0,
  filesErrored: 0,
  nodesCreated: 0,
  edgesCreated: 0,
  errors: [{ message: 'Aborted', severity: 'error' }],
  durationMs: 0,
};

describe('runIndexAll force-clear timing', () => {
  it('never clears the graph when the signal aborts during the scan phase (before beforeParse runs)', async () => {
    const clear = vi.fn();
    // Mimics orchestrator.indexAll()'s real shape: scan (async), THEN check
    // abort, and only call `beforeParse` if not aborted.
    const fakeIndexAll: ExtractionOrchestrator['indexAll'] = async (_onProgress, signal, _verbose, beforeParse) => {
      await Promise.resolve(); // simulate the async scan phase
      if (signal?.aborted) return emptyResult;
      beforeParse?.();
      return { ...emptyResult, success: true };
    };

    const controller = new AbortController();
    const deps = makeDeps(fakeIndexAll, clear);

    const runPromise = runIndexAll(deps, { force: true, signal: controller.signal });
    controller.abort(); // fires while the fake "scan" is still in flight

    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });

  it('still clears the graph for a force-reindex that completes normally', async () => {
    const clear = vi.fn();
    const fakeIndexAll: ExtractionOrchestrator['indexAll'] = async (_onProgress, signal, _verbose, beforeParse) => {
      await Promise.resolve();
      if (signal?.aborted) return emptyResult;
      beforeParse?.();
      // filesIndexed stays 0 so runIndexAll's resolution phase (which needs
      // a fuller resolver/queries mock) is skipped -- out of scope here.
      return { ...emptyResult, success: true };
    };

    const deps = makeDeps(fakeIndexAll, clear);
    const result = await runIndexAll(deps, { force: true });

    expect(result.success).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
