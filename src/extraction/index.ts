/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  Language,
  ExtractionResult,
  ExtractionError,
  CodeGraphConfig,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, isLanguageSupported, initGrammars, loadGrammarsForLanguages } from './grammars';
import { logWarn } from '../errors';
import { validatePathWithinRoot } from '../utils';
import { detectFrameworks } from '../resolution/frameworks';
import type { ResolutionContext } from '../resolution/types';
import {
  scanDirectory,
  scanDirectoryAsync,
} from './file-scanner';
import { storeExtractionResult } from './result-storage';
import { getChangedFilesForIndex, runSync } from './sync-operations';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
const FILE_IO_BATCH_SIZE = 10;

// PARSER_RESET_INTERVAL moved to parse-worker.ts (runs in worker thread)

/**
 * Maximum time (ms) to wait for a single file to parse in the worker thread.
 * If tree-sitter hangs or WASM runs out of memory, this prevents the entire
 * indexing run from freezing. The worker is restarted after a timeout.
 */
const PARSE_TIMEOUT_MS = 10_000;

/**
 * Number of files to parse before recycling the worker thread.
 * WASM linear memory can grow but NEVER shrink (WebAssembly spec limitation).
 * The only way to reclaim tree-sitter's WASM heap is to destroy the entire
 * V8 isolate by terminating the worker thread and spawning a fresh one.
 * This interval balances memory usage against the cost of reloading grammars.
 */
const WORKER_RECYCLE_INTERVAL = 250;

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExtractionResult(value: unknown): value is ExtractionResult {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    Array.isArray(value.unresolvedReferences) &&
    Array.isArray(value.errors) &&
    typeof value.durationMs === 'number'
  );
}

function shouldStoreParseResult(result: ExtractionResult): boolean {
  return result.nodes.length > 0 || result.errors.length === 0;
}

function hasFatalExtractionError(result: ExtractionResult): boolean {
  return result.errors.some((error) => error.severity === 'error');
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private config: CodeGraphConfig;
  private queries: QueryBuilder;
  /**
   * Names of frameworks detected for this project, populated by indexAll().
   * Passed to extractFromSource so framework-specific extractors (route nodes,
   * middleware, etc.) run after the tree-sitter pass. Cleared if detection
   * hasn't run yet so single-file re-index paths can detect on the spot.
   */
  private detectedFrameworkNames: string[] | null = null;

  constructor(rootDir: string, config: CodeGraphConfig, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.config = config;
    this.queries = queries;
  }

  /**
   * Build a filesystem-backed ResolutionContext sufficient for framework
   * detection. Graph-query methods (getNodesByName etc.) return empty because
   * the DB hasn't been populated yet, but detect() only uses readFile,
   * fileExists, and getAllFiles, so that's fine.
   */
  private buildDetectionContext(files: string[]): ResolutionContext {
    const rootDir = this.rootDir;
    return {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      getAllFiles: () => files,
      getProjectRoot: () => rootDir,
      fileExists: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return false;
        try {
          return fs.existsSync(full);
        } catch {
          return false;
        }
      },
      readFile: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return null;
        try {
          return fs.readFileSync(full, 'utf-8');
        } catch {
          return null;
        }
      },
    };
  }

  /**
   * Detect frameworks on demand using the current scanned files (or a fresh
   * scan if none are provided). Cached on the orchestrator so repeat calls
   * inside a single run don't re-scan.
   */
  private ensureDetectedFrameworks(files?: string[]): string[] {
    if (this.detectedFrameworkNames !== null) return this.detectedFrameworkNames;
    const fileList = files ?? scanDirectory(this.rootDir, this.config);
    const context = this.buildDetectionContext(fileList);
    this.detectedFrameworkNames = detectFrameworks(context).map((r) => r.name);
    return this.detectedFrameworkNames;
  }

  /**
   * Index all files in the project
   */
  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    verbose?: boolean
  ): Promise<IndexResult> {
    await initGrammars();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    const log = verbose
      ? (msg: string) => { console.log(`[worker] ${msg}`); }
      : (_msg: string) => {};

    // Phase 1: Scan for files
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const files = await scanDirectoryAsync(this.rootDir, this.config, (current, file) => {
      onProgress?.({
        phase: 'scanning',
        current,
        total: 0,
        currentFile: file,
      });
    });

    // Detect frameworks once per indexAll run using the scanned file list.
    // Names are passed to each parse call so framework-specific extractors
    // (route nodes, middleware, etc.) run after the tree-sitter pass.
    // Framework detection is reset each run so adding e.g. requirements.txt
    // between runs is picked up without restarting the process.
    this.detectedFrameworkNames = null;
    const frameworkNames = this.ensureDetectedFrameworks(files);

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
    let processed = 0;

    // Emit parsing phase immediately so the progress bar appears during worker setup.
    // The yield lets the shimmer worker flush the phase transition to stdout before
    // the main thread starts synchronous grammar detection work.
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total,
    });
    await new Promise(resolve => setImmediate(resolve));

    // Detect needed languages and load grammars in the parse worker
    const neededLanguages = [...new Set(files.map((f) => detectLanguage(f)))];
    // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded when c is needed
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp');
    }

    // Try to use a worker thread for parsing (keeps main thread unblocked for UI).
    // Falls back to in-process parsing if the compiled worker is unavailable (e.g. tests).
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

    // --- Worker lifecycle management ---
    // The worker can crash (OOM in WASM) or hang on pathological files.
    // We track pending parse promises and handle both cases:
    //   - Timeout: terminate + restart the worker, reject the timed-out request
    //   - Crash: reject all pending promises, restart for remaining files
    let parseWorker: import('worker_threads').Worker | null = null;
    let nextId = 0;
    let workerParseCount = 0;
    const pendingParses = new Map<number, {
      resolve: (result: ExtractionResult) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();

    function rejectAllPending(reason: string): void {
      for (const [id, pending] of [...pendingParses]) {
        clearTimeout(pending.timer);
        pendingParses.delete(id);
        pending.reject(new Error(reason));
      }
    }

    function attachWorkerHandlers(w: import('worker_threads').Worker): void {
      w.on('message', (msg: unknown) => {
        if (parseWorker !== w) return;
        if (!isRecord(msg) || msg.type !== 'parse-result' || typeof msg.id !== 'number') {
          return;
        }

        const pending = pendingParses.get(msg.id);
        if (pending) {
          if (isExtractionResult(msg.result)) {
            pending.resolve(msg.result);
          } else {
            pending.reject(new Error('Malformed parse result from worker'));
          }
        }
      });

      w.on('error', (err) => {
        logWarn('Parse worker error', { error: err.message });
        rejectAllPending(`Worker error: ${err.message}`);
      });

      w.on('exit', (code) => {
        if (code !== 0 && pendingParses.size > 0) {
          logWarn('Parse worker exited unexpectedly', { code });
          rejectAllPending(`Worker exited with code ${code}`);
        }
        // Clear reference so we know to respawn, reset count so
        // the fresh worker gets a full cycle before recycling.
        if (parseWorker === w) {
          parseWorker = null;
          workerParseCount = 0;
        }
      });
    }

    async function ensureWorker(): Promise<import('worker_threads').Worker> {
      if (parseWorker) return parseWorker;
      log('Spawning new parse worker...');
      const worker = new WorkerClass!(parseWorkerPath);
      parseWorker = worker;
      attachWorkerHandlers(worker);

      // Load grammars in the new worker
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        };
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const onMessage = (msg: unknown): void => {
          if (isRecord(msg) && msg.type === 'grammars-loaded') {
            settle(resolve);
          } else {
            settle(() => reject(new Error('Unexpected worker message during grammar load')));
          }
        };
        const onError = (err: Error): void => {
          settle(() => reject(err));
        };
        const onExit = (code: number): void => {
          settle(() => reject(new Error(`Worker exited during grammar load with code ${code}`)));
        };

        worker.once('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
        worker.postMessage({ type: 'load-grammars', languages: neededLanguages });
      });

      return worker;
    }

    if (WorkerClass) {
      await ensureWorker();
    }

    /**
     * Recycle the worker thread to reclaim WASM memory.
     * Terminates the current worker and clears the reference so
     * ensureWorker() will spawn a fresh one on the next call.
     */
    function recycleWorker(): void {
      if (!parseWorker) return;
      log(`Recycling worker after ${workerParseCount} parses (heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`);
      const w = parseWorker;
      parseWorker = null;
      workerParseCount = 0;
      // Fire-and-forget: worker.terminate() can hang if WASM is stuck
      w.terminate().catch(() => {});
    }

    async function requestParse(filePath: string, content: string): Promise<ExtractionResult> {
      if (!WorkerClass) {
        // In-process fallback
        return extractFromSource(
          filePath,
          content,
          detectLanguage(filePath, content),
          frameworkNames
        );
      }

      // Recycle the worker before the next parse if we've hit the threshold.
      // This destroys the WASM linear memory (which can grow but never shrink)
      // and starts a fresh worker with a clean heap.
      if (workerParseCount >= WORKER_RECYCLE_INTERVAL) {
        recycleWorker();
      }

      const worker = await ensureWorker();
      const id = nextId++;
      workerParseCount++;

      // Scale timeout for large files: base 10s + 10s per 100KB
      const timeoutMs = PARSE_TIMEOUT_MS + Math.floor(content.length / 100_000) * 10_000;

      return new Promise<ExtractionResult>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          pendingParses.delete(id);
          fn();
        };

        timer = setTimeout(() => {
          log(`TIMEOUT: ${filePath} exceeded ${timeoutMs}ms — killing worker`);
          // Reject FIRST — worker.terminate() can hang if WASM is stuck
          settle(() => reject(new Error(`Parse timed out after ${timeoutMs}ms`)));
          if (parseWorker === worker) {
            parseWorker = null;
            workerParseCount = 0;
          }
          // Fire-and-forget: kill the stuck worker in the background
          worker.terminate().catch(() => {});
        }, timeoutMs);

        pendingParses.set(id, {
          resolve: (result) => settle(() => resolve(result)),
          reject: (err) => settle(() => reject(err)),
          timer,
        });
        worker.postMessage({ type: 'parse', id, filePath, content, frameworkNames });
      });
    }

    for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) {
        if (parseWorker) (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
        return {
          success: false,
          filesIndexed,
          filesSkipped,
          filesErrored,
          nodesCreated: totalNodes,
          edgesCreated: totalEdges,
          errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
          durationMs: Date.now() - startTime,
        };
      }

      const batch = files.slice(i, i + FILE_IO_BATCH_SIZE);

      // Read files in parallel (with path validation before any I/O)
      const fileContents = await Promise.all(
        batch.map(async (fp) => {
          try {
            const fullPath = validatePathWithinRoot(this.rootDir, fp);
            if (!fullPath) {
              logWarn('Path traversal blocked in batch reader', { filePath: fp });
              return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: new Error('Path traversal blocked') };
            }
            const content = await fsp.readFile(fullPath, 'utf-8');
            const stats = await fsp.stat(fullPath);
            return { filePath: fp, content, stats, error: null as Error | null };
          } catch (err) {
            return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: err as Error };
          }
        })
      );

      // Send to worker for parsing, store results on main thread
      for (const { filePath, content, stats, error } of fileContents) {
        if (signal?.aborted) {
          if (parseWorker) (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
          return {
            success: false,
            filesIndexed,
            filesSkipped,
            filesErrored,
            nodesCreated: totalNodes,
            edgesCreated: totalEdges,
            errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
            durationMs: Date.now() - startTime,
          };
        }

        // Report progress before parsing (show current file being worked on)
        onProgress?.({
          phase: 'parsing',
          current: processed,
          total,
          currentFile: filePath,
        });

        if (error || content === null || stats === null) {
          processed++;
          filesErrored++;
          errors.push({
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath,
            severity: 'error',
            code: 'read_error',
          });
          continue;
        }

        // Honour config.maxFileSize. Without this check, vendored
        // generated headers, minified bundles, and other multi-MB
        // files get indexed despite the user setting a size cap —
        // wasting WASM heap and the worker recycle budget on inputs
        // the user explicitly opted out of. The single-file extractFile
        // path already enforces this; the bulk path used to silently
        // skip the check.
        if (stats.size > this.config.maxFileSize) {
          processed++;
          filesSkipped++;
          errors.push({
            message: `File exceeds max size (${stats.size} > ${this.config.maxFileSize})`,
            filePath,
            severity: 'warning',
            code: 'size_exceeded',
          });
          onProgress?.({ phase: 'parsing', current: processed, total });
          continue;
        }

        // Parse in worker thread (main thread stays unblocked).
        // Wrapped in try/catch to handle worker timeouts and crashes gracefully.
        let result: ExtractionResult;
        try {
          result = await requestParse(filePath, content);
        } catch (parseErr) {
          processed++;
          filesErrored++;
          errors.push({
            message: parseErr instanceof Error ? parseErr.message : String(parseErr),
            filePath,
            severity: 'error',
            code: 'parse_error',
          });
          continue;
        }

        processed++;

        // Store in database on main thread (SQLite is not thread-safe)
        if (shouldStoreParseResult(result)) {
          const language = detectLanguage(filePath, content);
          this.storeExtractionResult(filePath, content, language, stats, result);
        }

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            if (!err.filePath) err.filePath = filePath;
          }
          errors.push(...result.errors);
        }

        if (result.nodes.length > 0) {
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
        } else if (hasFatalExtractionError(result)) {
          filesErrored++;
        } else {
          filesSkipped++;
        }
      }
    }

    // Report 100% so the progress bar doesn't hang at 99%
    onProgress?.({
      phase: 'parsing',
      current: total,
      total,
    });

    // Yield so the shimmer worker's buffered stdout writes can flush.
    // Worker thread stdout is proxied through the main thread's event loop,
    // so synchronous work here blocks the animation from rendering.
    await new Promise(resolve => setImmediate(resolve));

    // Retry pass: files that failed due to WASM memory corruption may succeed
    // on a fresh worker with a clean heap. Recycle before each attempt so
    // every file gets the absolute cleanest WASM state possible.
    const retryableErrors = errors.filter(
      (e) => e.code === 'parse_error' && e.filePath &&
        (e.message.includes('Worker exited') || e.message.includes('memory access out of bounds'))
    );

    if (retryableErrors.length > 0 && WorkerClass) {
      log(`Retrying ${retryableErrors.length} files that failed due to WASM memory errors...`);

      const stillFailing: typeof retryableErrors = [];

      for (const errEntry of retryableErrors) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;

        // Fresh worker for every retry — maximum WASM headroom
        recycleWorker();

        const fullPath = validatePathWithinRoot(this.rootDir, filePath);
        if (!fullPath) continue;

        let content: string;
        try {
          content = await fsp.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        let result: ExtractionResult;
        try {
          result = await requestParse(filePath, content);
        } catch {
          stillFailing.push(errEntry);
          continue;
        }

        if (shouldStoreParseResult(result)) {
          const language = detectLanguage(filePath, content);
          const stats = await fsp.stat(fullPath);
          this.storeExtractionResult(filePath, content, language, stats, result);

          const idx = errors.indexOf(errEntry);
          if (idx >= 0) errors.splice(idx, 1);
          filesErrored--;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
          if (result.nodes.length > 0) {
            filesIndexed++;
          } else {
            filesSkipped++;
          }
          log(`Retry OK: ${filePath} (${result.nodes.length} nodes)`);
        }
      }

      // Last resort: for files that still crash on a clean worker, strip
      // comment-only lines to reduce WASM memory pressure. Many compiler
      // test files are 90%+ comments (CHECK directives) that don't contribute
      // code nodes but consume parser memory.
      if (stillFailing.length > 0) {
        log(`${stillFailing.length} files still failing — retrying with comments stripped...`);

        for (const errEntry of stillFailing) {
          const filePath = errEntry.filePath!;
          if (signal?.aborted) break;

          recycleWorker();

          const fullPath = validatePathWithinRoot(this.rootDir, filePath);
          if (!fullPath) continue;

          let fullContent: string;
          try {
            fullContent = await fsp.readFile(fullPath, 'utf-8');
          } catch {
            continue;
          }

          // Strip lines that are entirely comments (preserving line numbers
          // by replacing with empty lines so node positions stay correct)
          const stripped = fullContent
            .split('\n')
            .map(line => /^\s*\/\//.test(line) ? '' : line)
            .join('\n');

          let result: ExtractionResult;
          try {
            result = await requestParse(filePath, stripped);
          } catch {
            continue;
          }

          if (shouldStoreParseResult(result)) {
            const language = detectLanguage(filePath, fullContent);
            const stats = await fsp.stat(fullPath);
            this.storeExtractionResult(filePath, fullContent, language, stats, result);

            const idx = errors.indexOf(errEntry);
            if (idx >= 0) errors.splice(idx, 1);
            filesErrored--;
            totalNodes += result.nodes.length;
            totalEdges += result.edges.length;
            if (result.nodes.length > 0) {
              filesIndexed++;
            } else {
              filesSkipped++;
            }
            log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
          }
        }
      }
    }

    // Shut down parse worker and clear any pending timers
    if (pendingParses.size > 0) {
      rejectAllPending('Indexing complete');
    }
    if (parseWorker) {
      (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        filesSkipped++;
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);

    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Read file content and stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(fullPath);
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(relativePath, content, stats);
  }

  /**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
  async indexFileWithContent(
    relativePath: string,
    content: string,
    stats: fs.Stats
  ): Promise<ExtractionResult> {
    // Prevent path traversal
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);
    if (!fullPath) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Check file size
    if (stats.size > this.config.maxFileSize) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `File exceeds max size (${stats.size} > ${this.config.maxFileSize})`,
            filePath: relativePath,
            severity: 'warning',
            code: 'size_exceeded',
          },
        ],
        durationMs: 0,
      };
    }

    // Detect language
    const language = detectLanguage(relativePath, content);
    if (!isLanguageSupported(language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
    }

    // Extract from source. Use cached framework names if indexAll has run,
    // otherwise detect on the spot so single-file re-index paths still emit
    // route nodes / middleware / etc.
    const frameworkNames = this.ensureDetectedFrameworks();
    const result = extractFromSource(relativePath, content, language, frameworkNames);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      this.storeExtractionResult(relativePath, content, language, stats, result);
    }

    return result;
  }

  /**
   * Store extraction result in database
   */
  private storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): void {
    storeExtractionResult(this.queries, filePath, content, language, stats, result);
  }

  /**
   * Sync with current file state.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    return runSync(
      {
        rootDir: this.rootDir,
        config: this.config,
        queries: this.queries,
        indexFile: (filePath) => this.indexFile(filePath),
      },
      onProgress
    );
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return getChangedFilesForIndex({
      rootDir: this.rootDir,
      config: this.config,
      queries: this.queries,
      indexFile: (filePath) => this.indexFile(filePath),
    });
  }
}

// Re-export useful types and functions
export { hashContent, scanDirectory, scanDirectoryAsync, shouldIncludeFile } from './file-scanner';
export { extractFromSource } from './tree-sitter';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './grammars';
