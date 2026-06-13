/**
 * Parse worker pool
 *
 * Manages the single parse worker thread used during bulk indexing: spawn,
 * grammar loading, per-file parse requests with scaled timeouts, periodic
 * recycling (to reclaim WASM linear memory), and crash/timeout recovery.
 * Falls back to in-process parsing when the compiled worker is unavailable
 * (e.g. tests). Extracted from ExtractionOrchestrator.indexAll so the
 * orchestration loop stays readable.
 */

import type { Worker } from 'worker_threads';
import type { ExtractionResult, Language } from '../types';
import { extractFromSource } from './extract-from-source';
import { detectLanguage } from './grammars';
import { logWarn } from '../errors';

const PARSE_TIMEOUT_MS = 10_000;
const WORKER_RECYCLE_INTERVAL = 250;

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

export interface ParseWorkerPoolOptions {
  /** Worker constructor, or null to force the in-process fallback. */
  WorkerClass: typeof Worker | null;
  parseWorkerPath: string;
  neededLanguages: Language[];
  frameworkNames: string[];
  /** Verbose logger (no-op when not verbose). */
  log: (msg: string) => void;
}

export class ParseWorkerPool {
  private parseWorker: Worker | null = null;
  private nextId = 0;
  private workerParseCount = 0;
  private readonly pendingParses = new Map<number, {
    resolve: (result: ExtractionResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly opts: ParseWorkerPoolOptions) {}

  /** Pre-spawn the worker (and load grammars) when a worker is available. */
  async ensureReady(): Promise<void> {
    if (this.opts.WorkerClass) {
      await this.ensureWorker();
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of [...this.pendingParses]) {
      clearTimeout(pending.timer);
      this.pendingParses.delete(id);
      pending.reject(new Error(reason));
    }
  }

  private attachWorkerHandlers(w: Worker): void {
    w.on('message', (msg: unknown) => {
      if (this.parseWorker !== w) return;
      if (!isRecord(msg) || msg.type !== 'parse-result' || typeof msg.id !== 'number') {
        return;
      }

      const pending = this.pendingParses.get(msg.id);
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
      this.rejectAllPending(`Worker error: ${err.message}`);
    });

    w.on('exit', (code) => {
      if (code !== 0 && this.pendingParses.size > 0) {
        logWarn('Parse worker exited unexpectedly', { code });
        this.rejectAllPending(`Worker exited with code ${code}`);
      }
      // Clear reference so we know to respawn, reset count so
      // the fresh worker gets a full cycle before recycling.
      if (this.parseWorker === w) {
        this.parseWorker = null;
        this.workerParseCount = 0;
      }
    });
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.parseWorker) return this.parseWorker;
    this.opts.log('Spawning new parse worker...');
    const worker = new this.opts.WorkerClass!(this.opts.parseWorkerPath);
    this.parseWorker = worker;
    this.attachWorkerHandlers(worker);

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
      worker.postMessage({ type: 'load-grammars', languages: this.opts.neededLanguages });
    });

    return worker;
  }

  /**
   * Recycle the worker thread to reclaim WASM memory.
   * Terminates the current worker and clears the reference so
   * ensureWorker() will spawn a fresh one on the next call.
   */
  recycle(): void {
    if (!this.parseWorker) return;
    this.opts.log(`Recycling worker after ${this.workerParseCount} parses (heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`);
    const w = this.parseWorker;
    this.parseWorker = null;
    this.workerParseCount = 0;
    // Fire-and-forget: worker.terminate() can hang if WASM is stuck
    w.terminate().catch(() => {});
  }

  async requestParse(filePath: string, content: string): Promise<ExtractionResult> {
    if (!this.opts.WorkerClass) {
      // In-process fallback
      return extractFromSource(
        filePath,
        content,
        detectLanguage(filePath, content),
        this.opts.frameworkNames
      );
    }

    // Recycle the worker before the next parse if we've hit the threshold.
    // This destroys the WASM linear memory (which can grow but never shrink)
    // and starts a fresh worker with a clean heap.
    if (this.workerParseCount >= WORKER_RECYCLE_INTERVAL) {
      this.recycle();
    }

    const worker = await this.ensureWorker();
    const id = this.nextId++;
    this.workerParseCount++;

    // Scale timeout for large files: base 10s + 10s per 100KB
    const timeoutMs = PARSE_TIMEOUT_MS + Math.floor(content.length / 100_000) * 10_000;

    return new Promise<ExtractionResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.pendingParses.delete(id);
        fn();
      };

      timer = setTimeout(() => {
        this.opts.log(`TIMEOUT: ${filePath} exceeded ${timeoutMs}ms — killing worker`);
        // Reject FIRST — worker.terminate() can hang if WASM is stuck
        settle(() => reject(new Error(`Parse timed out after ${timeoutMs}ms`)));
        if (this.parseWorker === worker) {
          this.parseWorker = null;
          this.workerParseCount = 0;
        }
        // Fire-and-forget: kill the stuck worker in the background
        worker.terminate().catch(() => {});
      }, timeoutMs);

      this.pendingParses.set(id, {
        resolve: (result) => settle(() => resolve(result)),
        reject: (err) => settle(() => reject(err)),
        timer,
      });
      worker.postMessage({ type: 'parse', id, filePath, content, frameworkNames: this.opts.frameworkNames });
    });
  }

  /** Terminate the active worker (used on abort). Safe if none is running. */
  terminate(): void {
    if (this.parseWorker) {
      this.parseWorker.terminate().catch(() => {});
    }
  }

  /** Reject any in-flight parses and terminate the worker (end of indexing). */
  dispose(): void {
    if (this.pendingParses.size > 0) {
      this.rejectAllPending('Indexing complete');
    }
    this.terminate();
  }
}
