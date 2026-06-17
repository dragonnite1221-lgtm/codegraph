/**
 * Concurrency, batching, and memory utilities
 *
 * Cross-process/file locking, in-process mutex, bounded batch processing,
 * chunked file reads, debounce/throttle, and memory estimation/monitoring.
 * Split out of utils.ts to keep these runtime primitives in one place.
 */

import * as fs from 'fs';

/**
 * Cross-process file lock using a lock file with PID tracking.
 *
 * Prevents multiple processes (e.g., git hooks, CLI, MCP server) from
 * writing to the same database simultaneously.
 */
export class FileLock {
  private lockPath: string;
  private held = false;

  /** Locks older than this are considered stale regardless of PID status */
  private static readonly STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  /**
   * Acquire the lock. Throws if the lock is held by another live process.
   */
  acquire(): void {
    // Check for existing lock
    if (fs.existsSync(this.lockPath)) {
      try {
        const content = fs.readFileSync(this.lockPath, 'utf-8').trim();
        const pid = parseInt(content, 10);
        const stat = fs.statSync(this.lockPath);
        const lockAge = Date.now() - stat.mtimeMs;

        // Treat locks older than the timeout as stale, regardless of PID
        if (lockAge < FileLock.STALE_TIMEOUT_MS && !isNaN(pid) && this.isProcessAlive(pid)) {
          throw new Error(
            `CodeGraph database is locked by another process (PID ${pid}). ` +
            `If this is stale, run 'codegraph unlock' or delete ${this.lockPath}`
          );
        }

        // Stale lock (dead process or timed out) - remove it
        fs.unlinkSync(this.lockPath);
      } catch (err) {
        if (err instanceof Error && err.message.includes('locked by another')) {
          throw err;
        }
        // Other errors reading lock file - try to remove it
        try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
      }
    }

    // Write our PID to the lock file using exclusive create flag
    try {
      fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
      this.held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Race condition: another process grabbed the lock between our check and write
        throw new Error(
          'CodeGraph database is locked by another process. ' +
          `If this is stale, run 'codegraph unlock' or delete ${this.lockPath}`
        );
      }
      throw err;
    }
  }

  /**
   * Release the lock
   */
  release(): void {
    if (!this.held) return;
    try {
      // Only remove if we still own it (check PID)
      const content = fs.readFileSync(this.lockPath, 'utf-8').trim();
      if (parseInt(content, 10) === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Lock file already gone - that's fine
    }
    this.held = false;
  }

  /**
   * Execute a function while holding the lock
   */
  withLock<T>(fn: () => T): T {
    this.acquire();
    try {
      return fn();
    } finally {
      this.release();
    }
  }

  /**
   * Execute an async function while holding the lock
   */
  async withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Check if a process is still running
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Process items in batches to manage memory
 *
 * @param items - Array of items to process
 * @param batchSize - Number of items per batch
 * @param processor - Function to process each item
 * @param onBatchComplete - Optional callback after each batch
 * @returns Array of results
 */
export async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T, index: number) => Promise<R>,
  onBatchComplete?: (completed: number, total: number) => void
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, Math.min(i + batchSize, items.length));
    const batchResults = await Promise.all(
      batch.map((item, idx) => processor(item, i + idx))
    );
    results.push(...batchResults);

    if (onBatchComplete) {
      onBatchComplete(Math.min(i + batchSize, items.length), items.length);
    }

    // Allow GC between batches
    if (global.gc) {
      global.gc();
    }
  }

  return results;
}


export {
  Mutex,
  readFileInChunks,
  debounce,
  throttle,
} from './concurrency-mutex';
export { estimateSize, MemoryMonitor } from './concurrency-mem';
