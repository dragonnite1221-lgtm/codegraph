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
import type { IndexOptions } from './index';

export interface IndexingDeps {
  indexMutex: Mutex;
  fileLock: FileLock;
  orchestrator: ExtractionOrchestrator;
  queries: QueryBuilder;
  resolver: ReferenceResolver;
}

  export async function runIndexAll(deps: IndexingDeps, options: IndexOptions = {}): Promise<IndexResult> {
    return deps.indexMutex.withLock(async () => {
      try {
        deps.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        const result = await deps.orchestrator.indexAll(options.onProgress, options.signal, options.verbose);

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
        return deps.orchestrator.indexFiles(filePaths);
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
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
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
