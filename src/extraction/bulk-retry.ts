/**
 * Bulk index retry
 *
 * Files that fail with WASM memory corruption (worker exit / "memory access
 * out of bounds") often succeed on a fresh worker with a clean heap. This pass
 * recycles the worker before each retry, then — as a last resort — retries with
 * comment-only lines stripped to cut parser memory pressure. Mutates the passed
 * `errors` list and `counters` in place. Extracted from indexAll.
 */

import * as fsp from 'fs/promises';
import type { ExtractionError, ExtractionResult, Language } from '../types';
import type * as fs from 'fs';
import { detectLanguage } from './grammars';
import { validatePathWithinRoot } from '../utils';
import { shouldStoreParseResult } from './parse-result-predicates';
import type { ParseWorkerPool } from './parse-worker-pool';

export interface IndexCounters {
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  totalNodes: number;
  totalEdges: number;
}

export interface RetryArgs {
  pool: ParseWorkerPool;
  hasWorker: boolean;
  errors: ExtractionError[];
  counters: IndexCounters;
  rootDir: string;
  signal: AbortSignal | undefined;
  log: (msg: string) => void;
  store: (
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult,
  ) => void;
}

export async function retryWasmMemoryFailures(args: RetryArgs): Promise<void> {
  const { pool, hasWorker, errors, counters, rootDir, signal, log, store } = args;

    // Retry pass: files that failed due to WASM memory corruption may succeed
    // on a fresh worker with a clean heap. Recycle before each attempt so
    // every file gets the absolute cleanest WASM state possible.
    const retryableErrors = errors.filter(
      (e) => e.code === 'parse_error' && e.filePath &&
        (e.message.includes('Worker exited') || e.message.includes('memory access out of bounds'))
    );

    if (retryableErrors.length > 0 && hasWorker) {
      log(`Retrying ${retryableErrors.length} files that failed due to WASM memory errors...`);

      const stillFailing: typeof retryableErrors = [];

      for (const errEntry of retryableErrors) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;

        // Fresh worker for every retry — maximum WASM headroom
        pool.recycle();

        const fullPath = validatePathWithinRoot(rootDir, filePath);
        if (!fullPath) continue;

        let content: string;
        try {
          content = await fsp.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        let result: ExtractionResult;
        try {
          result = await pool.requestParse(filePath, content);
        } catch {
          stillFailing.push(errEntry);
          continue;
        }

        if (shouldStoreParseResult(result)) {
          const language = detectLanguage(filePath, content);
          const stats = await fsp.stat(fullPath);
          store(filePath, content, language, stats, result);

          const idx = errors.indexOf(errEntry);
          if (idx >= 0) errors.splice(idx, 1);
          counters.filesErrored--;
          counters.totalNodes += result.nodes.length;
          counters.totalEdges += result.edges.length;
          if (result.nodes.length > 0) {
            counters.filesIndexed++;
          } else {
            counters.filesSkipped++;
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

          pool.recycle();

          const fullPath = validatePathWithinRoot(rootDir, filePath);
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
            result = await pool.requestParse(filePath, stripped);
          } catch {
            continue;
          }

          if (shouldStoreParseResult(result)) {
            const language = detectLanguage(filePath, fullContent);
            const stats = await fsp.stat(fullPath);
            store(filePath, fullContent, language, stats, result);

            const idx = errors.indexOf(errEntry);
            if (idx >= 0) errors.splice(idx, 1);
            counters.filesErrored--;
            counters.totalNodes += result.nodes.length;
            counters.totalEdges += result.edges.length;
            if (result.nodes.length > 0) {
              counters.filesIndexed++;
            } else {
              counters.filesSkipped++;
            }
            log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
          }
        }
      }
    }
}
