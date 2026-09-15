/**
 * Sync plan-building helpers split out of sync-operations.ts to keep it within
 * the 200-line limit. No behavior change.
 */

import type { FileRecord } from '../types';
import { scanDirectory } from './file-scanner';
import { readContentHash } from './sync-file-checks';
import { buildGitSyncPlan } from './sync-operations-git-plan';
import type { SyncOperationsContext, SyncPlan } from './sync-operations';

export { readContentHash, isPathWithinRoot } from './sync-file-checks';
export { buildGitSyncPlan } from './sync-operations-git-plan';

export function addCppHeaderGrammarIfNeeded(languages: string[]): void {
  // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded
  if (languages.includes('c') && !languages.includes('cpp')) {
    languages.push('cpp');
  }
}

export function buildFullScanSyncPlan(context: SyncOperationsContext): SyncPlan {
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
    // The full scan already reads + hashes every current file to decide
    // added/modified, so there's no separate "looked drifted but wasn't"
    // case here needing a metadata-only refresh.
    staleMetadataRefresh: [],
  };
}

export function buildSyncPlan(context: SyncOperationsContext): SyncPlan {
  return buildGitSyncPlan(context) ?? buildFullScanSyncPlan(context);
}

/**
 * Sync with current file state.
 * Uses git status as a fast path when available, falling back to full scan.
 */
