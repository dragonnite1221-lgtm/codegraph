/**
 * Bulk parse loop
 *
 * Phase 2 of indexAll: read files in batches, parse each through the worker
 * pool, and store results on the main thread (SQLite is not thread-safe).
 * Mutates the shared `counters` and `errors`. Returns { aborted } so the
 * caller can build the aborted IndexResult. Extracted from indexAll.
 */

import * as fsp from 'fs/promises';
import type * as fs from 'fs';
import type { ExtractionError, ExtractionResult, Language } from '../types';
import type { IndexProgress } from './index';
import { detectLanguage } from './grammars';
import { validatePathWithinRoot } from '../utils';
import { logWarn } from '../errors';
import { shouldStoreParseResult, hasFatalExtractionError } from './parse-result-predicates';
import type { ParseWorkerPool } from './parse-worker-pool';
import type { IndexCounters } from './bulk-retry';

const FILE_IO_BATCH_SIZE = 10;

export interface BulkParseArgs {
  files: string[];
  pool: ParseWorkerPool;
  counters: IndexCounters;
  errors: ExtractionError[];
  rootDir: string;
  maxFileSize: number;
  total: number;
  signal: AbortSignal | undefined;
  onProgress?: (progress: IndexProgress) => void;
  store: (
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult,
  ) => void;
}

export async function runBulkParseLoop(args: BulkParseArgs): Promise<{ aborted: boolean }> {
  const { files, pool, counters, errors, rootDir, maxFileSize, total, signal, onProgress, store } = args;
  let processed = 0;

    for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) {
        pool.terminate();
        return { aborted: true };
      }

      const batch = files.slice(i, i + FILE_IO_BATCH_SIZE);

      // Read files in parallel (with path validation before any I/O)
      const fileContents = await Promise.all(
        batch.map(async (fp) => {
          try {
            const fullPath = validatePathWithinRoot(rootDir, fp);
            if (!fullPath) {
              logWarn('Path traversal blocked in batch reader', { filePath: fp });
              return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: new Error('Path traversal blocked') };
            }
            const stats = await fsp.stat(fullPath);
            if (stats.size > maxFileSize) {
              return { filePath: fp, content: '', stats, error: null as Error | null };
            }
            const content = await fsp.readFile(fullPath, 'utf-8');
            return { filePath: fp, content, stats, error: null as Error | null };
          } catch (err) {
            return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: err as Error };
          }
        })
      );

      // Send to worker for parsing, store results on main thread
      for (const { filePath, content, stats, error } of fileContents) {
        if (signal?.aborted) {
          pool.terminate();
          return { aborted: true };
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
          counters.filesErrored++;
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
        if (stats.size > maxFileSize) {
          processed++;
          counters.filesSkipped++;
          errors.push({
            message: `File exceeds max size (${stats.size} > ${maxFileSize})`,
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
          result = await pool.requestParse(filePath, content);
        } catch (parseErr) {
          processed++;
          counters.filesErrored++;
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
          store(filePath, content, language, stats, result);
        }

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            if (!err.filePath) err.filePath = filePath;
          }
          errors.push(...result.errors);
        }

        if (result.nodes.length > 0) {
          counters.filesIndexed++;
          counters.totalNodes += result.nodes.length;
          counters.totalEdges += result.edges.length;
        } else if (hasFatalExtractionError(result)) {
          counters.filesErrored++;
        } else {
          counters.filesSkipped++;
        }
      }
    }

  return { aborted: false };
}
