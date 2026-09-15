/**
 * The `git status`-driven fast path for building a sync plan. Split out of
 * sync-operations-plan.ts to stay within the file-size gate.
 */

import type { FileRecord } from '../types';
import { getGitChangedFiles, getGitVisibleFiles, shouldIncludeFile } from './file-scanner';
import { findDriftedTrackedFiles } from './file-drift';
import { readContentHashWithStats, isPathWithinRoot } from './sync-file-checks';
import type { SyncOperationsContext, SyncPlan } from './sync-operations';

/**
 * Build a refreshed FileRecord for a tracked file whose stat bookkeeping
 * drifted (mtime/size, or a racy-window re-check) but whose content hash
 * -- read from the exact same snapshot as the stats used here -- confirms
 * nothing actually changed. Without this, the same file would keep
 * getting re-flagged and re-hashed by every future sync.
 *
 * `indexedAt` is bumped to now alongside `modifiedAt` so the racy-window
 * math in findDriftedTrackedFiles stays meaningful: once real time has
 * passed since this refreshed capture without the file changing again,
 * the record naturally stops looking racy on its own.
 *
 * Returned rather than written here -- see SyncPlan.staleMetadataRefresh.
 */
function buildRefreshedRecord(tracked: FileRecord, stats: { mtimeMs: number; size: number }): FileRecord | null {
  if (stats.mtimeMs === tracked.modifiedAt && stats.size === tracked.size) return null;
  return { ...tracked, modifiedAt: stats.mtimeMs, size: stats.size, indexedAt: Date.now() };
}

export function buildGitSyncPlan(context: SyncOperationsContext): SyncPlan | null {
  const gitChanges = getGitChangedFiles(context.rootDir, context.config);
  if (!gitChanges) {
    return null;
  }

  // A commit switch can introduce a file that's brand new to the DB -- it's
  // part of git's tracked tree the moment `git checkout` finishes, so it
  // never shows up as `??` in `git status`. Reconciling that requires the
  // full git-visible set; if it can't be obtained here even though `git
  // status` just succeeded above, this fast path can't be trusted to be
  // complete, so fall back to a full scan rather than silently returning
  // an incomplete plan forever.
  const gitVisible = getGitVisibleFiles(context.rootDir);
  if (!gitVisible) {
    return null;
  }

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const staleMetadataRefresh: FileRecord[] = [];

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

  // Reconcile files git status never had a reason to mention at all.
  const newlyVisible: string[] = [];
  for (const filePath of gitVisible) {
    if (trackedPaths.has(filePath) || gitFlagged.has(filePath)) continue;
    if (!shouldIncludeFile(filePath, context.config)) continue;
    newlyVisible.push(filePath);
  }

  // Deleted files — only report/delete if tracked in DB
  for (const filePath of [...gitChanges.deleted, ...drift.removed]) {
    const tracked = context.queries.getFileByPath(filePath);
    if (tracked) {
      removed.push(filePath);
    }
  }

  // Modified files — read + hash only these, compare with DB. Stat and
  // hash come from the same file descriptor (see readContentHashWithStats)
  // so a refresh below can never pair an old hash with a newer mtime/size.
  for (const filePath of [...gitChanges.modified, ...drift.modified]) {
    const snapshot = readContentHashWithStats(context.rootDir, filePath);
    if (snapshot === null) continue;

    const tracked = context.queries.getFileByPath(filePath);
    if (!tracked) {
      added.push(filePath);
    } else if (tracked.contentHash !== snapshot.hash) {
      modified.push(filePath);
    } else {
      const refreshed = buildRefreshedRecord(tracked, snapshot.stats);
      if (refreshed) {
        staleMetadataRefresh.push(refreshed);
      }
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
    staleMetadataRefresh,
  };
}
