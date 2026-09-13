/**
 * Indexing operations
 *
 * Mutex- and file-lock-guarded bulk indexing, single-file indexing, and
 * incremental sync, including reference resolution after the parse pass.
 * Extracted from the CodeGraph facade so the orchestration logic lives in
 * one place.
 */

import type { Mutex, FileLock } from './utils';
import type { ExtractionOrchestrator, IndexResult, SyncResult } from './extraction';
import type { QueryBuilder } from './db/queries';
import type { ReferenceResolver } from './resolution';
import type { IndexOptions, IndexAllOptions } from './index';

export interface IndexingDeps {
  indexMutex: Mutex;
  fileLock: FileLock;
  orchestrator: ExtractionOrchestrator;
  queries: QueryBuilder;
  resolver: ReferenceResolver;
}

  export async function runIndexAll(deps: IndexingDeps, options: IndexAllOptions = {}): Promise<IndexResult> {
    return deps.indexMutex.withLock(async () => {
      try {
        deps.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        // Bail out before any destructive work if the caller's signal is
        // already aborted -- orchestrator.indexAll() only checks `signal`
        // AFTER the scan phase, which is too late: `queries.clear()` below
        // would already have wiped the graph for a force-index that never
        // gets to actually reindex anything.
        if (options.signal?.aborted) {
          return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Aborted', severity: 'error' as const }], durationMs: 0 };
        }
        // Clear only after the lock is held (a force-index that loses the
        // lock race never wipes the existing graph -- see IndexOptions.force)
        // AND only via `beforeParse`, which orchestrator.indexAll() invokes
        // after its own scan phase + abort check pass, right before it
        // starts parsing. That defers the destructive clear past grammar
        // init and the full directory scan, so an abort during either of
        // those (already covered above for the abort-before-any-of-this
        // case) never destroys the graph with no replacement work even
        // started. ponytail: parsing itself still isn't cancellation-safe --
        // an abort mid-parse, after the clear runs, leaves a partially
        // rebuilt graph. Closing that needs a staged rebuild (shadow table
        // set + atomic swap) or WAL-aware snapshot/restore across both
        // SQLite backends -- a bigger change than this fix, and the same
        // "cancelled mid-run" exposure every other index/sync path here
        // already has (none of them are transactional either).
        const beforeParse = options.force ? () => deps.queries.clear() : undefined;
        const result = await deps.orchestrator.indexAll(options.onProgress, options.signal, options.verbose, beforeParse);

        // Reinitialize the resolver AFTER extraction (not alongside the
        // clear, above) so framework detectors that scan indexed files
        // (React's .tsx fallback, Vue, SwiftUI, ASP.NET, ...) see the
        // freshly repopulated file table instead of the just-cleared,
        // still-empty one. `initialize()` also drops the cached
        // knownNames/knownFiles/tsconfig-alias state, all of which are
        // otherwise never recomputed for a reused CodeGraph instance —
        // resolving the rebuilt graph against any of that stale state
        // would silently drop or misdirect edges. Must still run before
        // resolveAndPersistBatched below, which is what actually consumes it.
        if (options.force) {
          deps.resolver.initialize();
        }

        // Resolve references to create call/import/extends edges
        if (result.success && result.filesIndexed > 0) {
          // Get count without loading all refs into memory
          const unresolvedCount = deps.queries.getUnresolvedReferencesCount();

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedCount,
          });

          await deps.resolver.resolveAndPersistBatched((current, total) => {
            options.onProgress?.({
              phase: 'resolving',
              current,
              total,
            });
          });
        }

        return result;
      } finally {
        deps.fileLock.release();
      }
    });
  }

  export async function runIndexFiles(deps: IndexingDeps, filePaths: string[]): Promise<IndexResult> {
    return deps.indexMutex.withLock(async () => {
      try {
        deps.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        // Must await here (not `return deps.orchestrator.indexFiles(...)`):
        // the outer try/finally releases the cross-process file lock as
        // soon as the try block's completion value is produced, not when
        // the returned promise settles. Returning the promise unawaited
        // let the lock be released while indexing was still in flight.
        return await deps.orchestrator.indexFiles(filePaths);
      } finally {
        deps.fileLock.release();
      }
    });
  }

  export async function runSync(deps: IndexingDeps, options: IndexOptions = {}): Promise<SyncResult> {
    return deps.indexMutex.withLock(async () => {
      try {
        deps.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0, error: 'Could not acquire file lock - another process may be indexing' };
      }
      try {
        const result = await deps.orchestrator.sync(options.onProgress);

        // Resolve references if files were updated
        if (result.filesAdded > 0 || result.filesModified > 0) {
          if (result.changedFilePaths) {
            // Scope resolution to changed files (git fast path — bounded set)
            const unresolvedRefs = deps.queries.getUnresolvedReferencesByFiles(result.changedFilePaths);

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedRefs.length,
            });

            deps.resolver.resolveAndPersist(unresolvedRefs, (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          } else {
            // No git info — use batched resolution to avoid OOM
            const unresolvedCount = deps.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedCount,
            });

            await deps.resolver.resolveAndPersistBatched((current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          }
        }

        return result;
      } finally {
        deps.fileLock.release();
      }
    });
  }
