/**
 * Extraction sync operations
 *
 * Keeps git/full-scan change detection and sync bookkeeping out of the main
 * ExtractionOrchestrator, while preserving the same QueryBuilder-backed state
 * transitions.
 */

import * as fs from 'fs';
import type { CodeGraphConfig, ExtractionResult, FileRecord } from '../types';
import type { QueryBuilder } from '../db/queries';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot } from '../utils';
import { detectLanguage, initGrammars, loadGrammarsForLanguages } from './grammars';
import { getGitChangedFiles, hashContent, scanDirectory } from './file-scanner';
import type { IndexProgress, SyncResult } from './index';

interface SyncOperationsContext {
  rootDir: string;
  config: CodeGraphConfig;
  queries: QueryBuilder;
  indexFile: (filePath: string) => Promise<ExtractionResult>;
}

interface SyncPlan {
  filesChecked: number;
  added: string[];
  modified: string[];
  removed: string[];
  filesToIndex: string[];
  changedFilePaths: string[];
}

function addCppHeaderGrammarIfNeeded(languages: string[]): void {
  // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded
  if (languages.includes('c') && !languages.includes('cpp')) {
    languages.push('cpp');
  }
}

function readContentHash(rootDir: string, filePath: string, logContext: string): string | null {
  const fullPath = validatePathWithinRoot(rootDir, filePath);
  if (!fullPath) {
    logWarn('Path traversal blocked while detecting changes', { filePath });
    return null;
  }

  try {
    return hashContent(fs.readFileSync(fullPath, 'utf-8'));
  } catch (error) {
    logDebug(`Skipping unreadable file ${logContext}`, { filePath, error: String(error) });
    return null;
  }
}

function isPathWithinRoot(rootDir: string, filePath: string): boolean {
  const fullPath = validatePathWithinRoot(rootDir, filePath);
  if (!fullPath) {
    logWarn('Path traversal blocked while detecting changes', { filePath });
    return false;
  }
  return true;
}

function buildGitSyncPlan(context: SyncOperationsContext): SyncPlan | null {
  const gitChanges = getGitChangedFiles(context.rootDir, context.config);
  if (!gitChanges) {
    return null;
  }

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  // Deleted files — only report/delete if tracked in DB
  for (const filePath of gitChanges.deleted) {
    const tracked = context.queries.getFileByPath(filePath);
    if (tracked) {
      removed.push(filePath);
    }
  }

  // Modified files — read + hash only these, compare with DB
  for (const filePath of gitChanges.modified) {
    const contentHash = readContentHash(context.rootDir, filePath, 'during sync');
    if (contentHash === null) continue;

    const tracked = context.queries.getFileByPath(filePath);
    if (!tracked) {
      added.push(filePath);
    } else if (tracked.contentHash !== contentHash) {
      modified.push(filePath);
    }
  }

  // Added (untracked) files. indexFile has its own traversal gate too, but
  // validating here keeps sync bookkeeping consistent with modified/deleted paths.
  for (const filePath of gitChanges.added) {
    if (isPathWithinRoot(context.rootDir, filePath)) {
      added.push(filePath);
    }
  }

  const filesToIndex = [...modified, ...added];
  return {
    filesChecked: gitChanges.modified.length + gitChanges.added.length + gitChanges.deleted.length,
    added,
    modified,
    removed,
    filesToIndex,
    changedFilePaths: filesToIndex,
  };
}

function buildFullScanSyncPlan(context: SyncOperationsContext): SyncPlan {
  const currentFiles = new Set(scanDirectory(context.rootDir, context.config));

  // Build Map for O(1) lookups instead of .find() per file
  const trackedFiles = context.queries.getAllFiles();
  const trackedMap = new Map<string, FileRecord>();
  for (const f of trackedFiles) {
    trackedMap.set(f.path, f);
  }

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  // Find files to remove (in DB but not on disk)
  for (const tracked of trackedFiles) {
    if (!currentFiles.has(tracked.path)) {
      removed.push(tracked.path);
    }
  }

  // Find files to add or update
  for (const filePath of currentFiles) {
    const contentHash = readContentHash(context.rootDir, filePath, 'during sync');
    if (contentHash === null) continue;

    const tracked = trackedMap.get(filePath);
    if (!tracked) {
      added.push(filePath);
    } else if (tracked.contentHash !== contentHash) {
      modified.push(filePath);
    }
  }

  const filesToIndex = [...added, ...modified];
  return {
    filesChecked: currentFiles.size,
    added,
    modified,
    removed,
    filesToIndex,
    changedFilePaths: filesToIndex,
  };
}

function buildSyncPlan(context: SyncOperationsContext): SyncPlan {
  return buildGitSyncPlan(context) ?? buildFullScanSyncPlan(context);
}

/**
 * Sync with current file state.
 * Uses git status as a fast path when available, falling back to full scan.
 */
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
