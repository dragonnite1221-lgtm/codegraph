/**
 * Extraction sync operations
 *
 * Keeps git/full-scan change detection and sync bookkeeping out of the main
 * ExtractionOrchestrator, while preserving the same QueryBuilder-backed state
 * transitions.
 */

import type { CodeGraphConfig, ExtractionResult } from '../types';
import type { QueryBuilder } from '../db/queries';
import { detectLanguage, initGrammars, loadGrammarsForLanguages } from './grammars';
import type { IndexProgress, SyncResult } from './index';
import { addCppHeaderGrammarIfNeeded, buildSyncPlan } from './sync-operations-plan';

export interface SyncOperationsContext {
  rootDir: string;
  config: CodeGraphConfig;
  queries: QueryBuilder;
  indexFile: (filePath: string) => Promise<ExtractionResult>;
}

export interface SyncPlan {
  filesChecked: number;
  added: string[];
  modified: string[];
  removed: string[];
  filesToIndex: string[];
  changedFilePaths: string[];
}

export async function runSync(
  context: SyncOperationsContext,
  onProgress?: (progress: IndexProgress) => void
): Promise<SyncResult> {
  await initGrammars(); // Initialize WASM runtime (grammars loaded lazily below)
  const startTime = Date.now();

  onProgress?.({
    phase: 'scanning',
    current: 0,
    total: 0,
  });

  const plan = buildSyncPlan(context);

  for (const filePath of plan.removed) {
    context.queries.deleteFile(filePath);
  }

  // Load only grammars needed for changed files
  if (plan.filesToIndex.length > 0) {
    const neededLanguages = [...new Set(plan.filesToIndex.map((f) => detectLanguage(f)))];
    addCppHeaderGrammarIfNeeded(neededLanguages);
    await loadGrammarsForLanguages(neededLanguages);
  }

  let nodesUpdated = 0;
  const total = plan.filesToIndex.length;
  for (let i = 0; i < plan.filesToIndex.length; i++) {
    const filePath = plan.filesToIndex[i]!;
    onProgress?.({
      phase: 'parsing',
      current: i + 1,
      total,
      currentFile: filePath,
    });

    const result = await context.indexFile(filePath);
    nodesUpdated += result.nodes.length;
  }

  return {
    filesChecked: plan.filesChecked,
    filesAdded: plan.added.length,
    filesModified: plan.modified.length,
    filesRemoved: plan.removed.length,
    nodesUpdated,
    durationMs: Date.now() - startTime,
    changedFilePaths: plan.changedFilePaths.length > 0 ? plan.changedFilePaths : undefined,
  };
}

/**
 * Get files that have changed since last index.
 * Uses git status as a fast path when available, falling back to full scan.
 */
export function getChangedFilesForIndex(context: SyncOperationsContext): {
  added: string[];
  modified: string[];
  removed: string[];
} {
  const plan = buildSyncPlan(context);
  return {
    added: plan.added,
    modified: plan.modified,
    removed: plan.removed,
  };
}
