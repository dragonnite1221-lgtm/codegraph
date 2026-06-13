/**
 * CodeGraph Utilities
 *
 * Small general-purpose helpers, plus re-exports of the path-security and
 * concurrency/memory primitives that used to live here. Import paths are
 * unchanged: `from '../utils'` still resolves every previously-exported symbol.
 *
 * @module utils
 *
 * @example
 * ```typescript
 * import { Mutex, processInBatches, MemoryMonitor, validatePathWithinRoot } from 'codegraph';
 *
 * // Use mutex for concurrent safety
 * const mutex = new Mutex();
 * await mutex.withLock(async () => {
 *   await performCriticalOperation();
 * });
 *
 * // Process items in batches to manage memory
 * const results = await processInBatches(items, 100, async (item) => {
 *   return await processItem(item);
 * });
 * ```
 */

// Path-traversal / sensitive-directory guards.
export {
  validatePathWithinRoot,
  validateProjectPath,
  isPathWithinRoot,
  isPathWithinRootReal,
} from './path-security';

// Concurrency, batching, and memory primitives.
export {
  FileLock,
  processInBatches,
  Mutex,
  readFileInChunks,
  debounce,
  throttle,
  estimateSize,
  MemoryMonitor,
} from './concurrency';

/**
 * Safely parse JSON with a fallback value.
 * Prevents crashes from corrupted database metadata.
 */
export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Clamp a numeric value to a range.
 * Used to enforce sane limits on MCP tool inputs.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Normalize a file path to use forward slashes.
 * Fixes Windows backslash paths so glob matching works consistently.
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
