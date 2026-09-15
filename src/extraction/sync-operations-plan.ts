/**
 * Sync plan-building helpers split out of sync-operations.ts to keep it within
 * the 200-line limit. No behavior change.
 */

import * as fs from 'fs';
import type { FileRecord } from '../types';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot } from '../utils';
import { getGitChangedFiles, getGitVisibleFiles, hashContent, scanDirectory, shouldIncludeFile } from './file-scanner';
import { findDriftedTrackedFiles } from './file-drift';
import type { SyncOperationsContext, SyncPlan } from './sync-operations';

export function addCppHeaderGrammarIfNeeded(languages: string[]): void {
  // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded
  if (languages.includes('c') && !languages.includes('cpp')) {
    languages.push('cpp');
  }
}

export function readContentHash(rootDir: string, filePath: string, logContext: string): string | null {
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

export function isPathWithinRoot(rootDir: string, filePath: string): boolean {
  const fullPath = validatePathWithinRoot(rootDir, filePath);
  if (!fullPath) {
    logWarn('Path traversal blocked while detecting changes', { filePath });
    return false;
  }
  return true;
}

export function buildGitSyncPlan(context: SyncOperationsContext): SyncPlan | null {
  const gitChanges = getGitChangedFiles(context.rootDir, context.config);
  if (!gitChanges) {
    return null;
  }

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  const trackedFiles = context.queries.getAllFiles();
  const trackedPaths = new Set(trackedFiles.map((f) => f.path));
  const gitFlagged = new Set([...gitChanges.modified, ...gitChanges.added, ...gitChanges.deleted]);

  // `git status` only diffs the working tree against the CURRENT
  // index/HEAD, so it stays silent about a tracked file whose content
  // still differs from the DB's last-indexed record once that diff closes
  // -- e.g. an uncommitted edit that got indexed and was then reverted
  // with `git checkout -- <file>` / `git restore <file>` (HEAD never
  // moved), or a `git checkout <other-commit>` that already matches the
  // new HEAD by the time codegraph looks. Sweep tracked files git status
  // didn't flag (respecting the current include/exclude config, same as
  // every other candidate) for a drifted mtime/size or disappearance; the
  // hash checks below still gate whether a drifted file actually gets
  // reindexed.
  const unflaggedTracked = trackedFiles.filter(
    (f) => !gitFlagged.has(f.path) && shouldIncludeFile(f.path, context.config)
  );
  const drift = findDriftedTrackedFiles(context.rootDir, unflaggedTracked);

  // A commit switch can also introduce a file that's brand new to the DB
  // -- it's part of git's tracked tree the moment `git checkout` finishes,
  // so it never shows up as `??` in `git status`. Reconcile against the
  // full git-visible set (cheap -- `git ls-files`, no content reads) to
  // catch those too.
  const gitVisible = getGitVisibleFiles(context.rootDir);
  const newlyVisible: string[] = [];
  if (gitVisible) {
    for (const filePath of gitVisible) {
      if (trackedPaths.has(filePath) || gitFlagged.has(filePath)) continue;
      if (!shouldIncludeFile(filePath, context.config)) continue;
      newlyVisible.push(filePath);
    }
  }

  // Deleted files — only report/delete if tracked in DB
  for (const filePath of [...gitChanges.deleted, ...drift.removed]) {
    const tracked = context.queries.getFileByPath(filePath);
    if (tracked) {
      removed.push(filePath);
    }
  }

  // Modified files — read + hash only these, compare with DB
  for (const filePath of [...gitChanges.modified, ...drift.modified]) {
    const contentHash = readContentHash(context.rootDir, filePath, 'during sync');
    if (contentHash === null) continue;

    const tracked = context.queries.getFileByPath(filePath);
    if (!tracked) {
      added.push(filePath);
    } else if (tracked.contentHash !== contentHash) {
      modified.push(filePath);
    }
  }

  // Added (untracked-by-DB) files. indexFile has its own traversal gate
  // too, but validating here keeps sync bookkeeping consistent with
  // modified/deleted paths.
  for (const filePath of [...gitChanges.added, ...newlyVisible]) {
    if (isPathWithinRoot(context.rootDir, filePath)) {
      added.push(filePath);
    }
  }

  const filesToIndex = [...modified, ...added];
  return {
    filesChecked:
      gitChanges.modified.length +
      gitChanges.added.length +
      gitChanges.deleted.length +
      drift.modified.length +
      drift.removed.length +
      newlyVisible.length,
    added,
    modified,
    removed,
    filesToIndex,
    changedFilePaths: filesToIndex,
  };
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
  };
}

export function buildSyncPlan(context: SyncOperationsContext): SyncPlan {
  return buildGitSyncPlan(context) ?? buildFullScanSyncPlan(context);
}

/**
 * Sync with current file state.
 * Uses git status as a fast path when available, falling back to full scan.
 */
