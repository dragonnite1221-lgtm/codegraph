/**
 * Full-project indexing driver for ExtractionOrchestrator: scan, framework
 * detection, worker-pool parsing, WASM-memory retry. Split out of index.ts to
 * stay within the file-size gate. Operates on the orchestrator via
 * OrchestratorApi.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExtractionError } from '../types';
import { detectLanguage, initGrammars, loadGrammarsForLanguages } from './grammars';
import { scanDirectoryAsync } from './file-scanner';
import { ParseWorkerPool } from './parse-worker-pool';
import { retryWasmMemoryFailures, type IndexCounters } from './bulk-retry';
import { runBulkParseLoop } from './bulk-parse';
import type { IndexProgress, IndexResult, OrchestratorApi } from './index';

/** Index all files in the project. */
export async function indexAll(
  orch: OrchestratorApi,
  onProgress?: (progress: IndexProgress) => void,
  signal?: AbortSignal,
  verbose?: boolean
): Promise<IndexResult> {
  await initGrammars();
  const startTime = Date.now();
  const errors: ExtractionError[] = [];
  const counters: IndexCounters = { filesIndexed: 0, filesSkipped: 0, filesErrored: 0, totalNodes: 0, totalEdges: 0 };

  const log = verbose
    ? (msg: string) => { console.log(`[worker] ${msg}`); }
    : (_msg: string) => {};

  // Phase 1: Scan for files
  onProgress?.({ phase: 'scanning', current: 0, total: 0 });

  const files = await scanDirectoryAsync(orch.rootDir, orch.config, (current, file) => {
    onProgress?.({ phase: 'scanning', current, total: 0, currentFile: file });
  });

  // Detect frameworks once per indexAll run using the scanned file list.
  // Reset each run so adding e.g. requirements.txt between runs is picked up.
  orch.detectedFrameworkNames = null;
  const frameworkNames = orch.ensureDetectedFrameworks(files);

  if (signal?.aborted) {
    return {
      success: false,
      filesIndexed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [{ message: 'Aborted', severity: 'error' }],
      durationMs: Date.now() - startTime,
    };
  }

  // Phase 2: Parse files in a worker thread (keeps main thread unblocked for UI)
  const total = files.length;

  // Emit parsing phase immediately so the progress bar appears during worker setup.
  onProgress?.({ phase: 'parsing', current: 0, total });
  await new Promise(resolve => setImmediate(resolve));

  // Detect needed languages and load grammars in the parse worker
  const neededLanguages = [...new Set(files.map((f) => detectLanguage(f)))];
  // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded when c is needed
  if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
    neededLanguages.push('cpp');
  }

  // Try to use a worker thread for parsing; fall back to in-process (e.g. tests).
  const parseWorkerPath = path.join(__dirname, 'parse-worker.js');
  const useWorker = fs.existsSync(parseWorkerPath);
  let WorkerClass: typeof import('worker_threads').Worker | null = null;

  if (useWorker) {
    const { Worker } = await import('worker_threads');
    WorkerClass = Worker;
  } else {
    // In-process fallback: load grammars locally
    await loadGrammarsForLanguages(neededLanguages);
  }

  // Off-thread parsing with per-file timeouts and periodic recycling to reclaim
  // WASM memory; falls back to in-process when the compiled worker is absent.
  const pool = new ParseWorkerPool({ WorkerClass, parseWorkerPath, neededLanguages, frameworkNames, log });
  await pool.ensureReady();

  const { aborted } = await runBulkParseLoop({
    files,
    pool,
    counters,
    errors,
    rootDir: orch.rootDir,
    maxFileSize: orch.config.maxFileSize,
    total,
    signal,
    onProgress,
    store: (filePath, content, language, stats, result) =>
      orch.storeExtractionResult(filePath, content, language, stats, result),
  });
  if (aborted) {
    pool.terminate();
    return {
      success: false,
      filesIndexed: counters.filesIndexed,
      filesSkipped: counters.filesSkipped,
      filesErrored: counters.filesErrored,
      nodesCreated: counters.totalNodes,
      edgesCreated: counters.totalEdges,
      errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
      durationMs: Date.now() - startTime,
    };
  }

  // Report 100% so the progress bar doesn't hang at 99%
  onProgress?.({ phase: 'parsing', current: total, total });

  // Yield so the shimmer worker's buffered stdout writes can flush.
  await new Promise(resolve => setImmediate(resolve));

  // Retry WASM-memory failures (fresh worker, then comment-stripped fallback).
  await retryWasmMemoryFailures({
    pool,
    hasWorker: WorkerClass !== null,
    errors,
    counters,
    rootDir: orch.rootDir,
    signal,
    log,
    store: (filePath, content, language, stats, result) =>
      orch.storeExtractionResult(filePath, content, language, stats, result),
  });

  // Shut down the parse worker and clear any pending timers
  pool.dispose();

  return {
    success: counters.filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
    filesIndexed: counters.filesIndexed,
    filesSkipped: counters.filesSkipped,
    filesErrored: counters.filesErrored,
    nodesCreated: counters.totalNodes,
    edgesCreated: counters.totalEdges,
    errors,
    durationMs: Date.now() - startTime,
  };
}
