/**
 * Detects tracked files whose on-disk state has drifted from the DB record
 * without `git status` reporting anything. Split out of file-scanner.ts to
 * stay within the file-size gate.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { FileRecord } from '../types-records';
import { validatePathWithinRoot } from '../path-security';

/**
 * Reconciliation result for tracked files that `git status` didn't flag.
 */
export interface TrackedFileDrift {
  /** Tracked files whose on-disk mtime/size no longer match the DB record. */
  modified: string[];
  /** Tracked files that no longer exist (or aren't a regular file) on disk. */
  removed: string[];
}

// Filesystem mtime resolution (some filesystems only tick every 1-2s) plus
// clock skew means two writes landing in the same coarse tick can report
// identical mtimes -- the classic "racy git" problem. The ambiguity has to
// be judged against *when the DB snapshot was captured*, not against how
// long ago the check itself is running: a record indexed within
// RACY_WINDOW_MS of its own recorded mtime could have been snapshotted
// mid-edit, so an exact stat match against it is never trustworthy on its
// own, no matter how much time has passed since. (Comparing against
// "now" instead would make this a no-op in practice: the file watcher's
// own debounce alone typically exceeds this window before a sync even
// starts.)
const RACY_WINDOW_MS = 2000;

/**
 * Find tracked files whose actual disk state has drifted from what's
 * recorded in the DB, even though `git status` reports nothing for them.
 *
 * `getGitChangedFiles` only diffs the working tree against the CURRENT
 * index/HEAD, so it goes silent the moment that diff closes -- regardless
 * of whether the file's content still matches what codegraph last indexed.
 * That happens whenever HEAD-relative status becomes clean without the
 * file returning to the exact version the DB has on record: an
 * uncommitted edit that was indexed, then reverted with
 * `git checkout -- <file>` / `git restore <file>` (HEAD never moves); or a
 * `git checkout <other-commit>` that changes (or deletes) a tracked file
 * and already matches the new HEAD by the time codegraph looks.
 *
 * This is a cheap `stat()` sweep, not a content read -- callers still
 * verify with a full content hash before treating a file as changed, so a
 * touched-but-unchanged mtime/size causes no false positive. For the
 * common case (nothing changed, and long enough ago to trust that), each
 * tracked file costs exactly one `stat()`: the heavier realpath-based
 * root-containment check only runs for files that already look drifted.
 * This mirrors the synchronous execution model `getGitChangedFiles` and
 * `getGitVisibleFiles` already use for the git-status fast path this
 * feeds into -- it doesn't introduce a new class of blocking behavior.
 */
export function findDriftedTrackedFiles(
  rootDir: string,
  trackedFiles: Array<Pick<FileRecord, 'path' | 'modifiedAt' | 'size' | 'indexedAt'>>
): TrackedFileDrift {
  const modified: string[] = [];
  const removed: string[] = [];

  for (const file of trackedFiles) {
    const rawPath = path.join(rootDir, file.path);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(rawPath);
    } catch (error) {
      // Only a genuine "doesn't exist" error means the file was removed.
      // Anything else (EACCES, EIO, ELOOP, resource exhaustion, ...) is
      // transient/environmental -- skip rather than treat it as a
      // deletion, so a temporary filesystem hiccup can't erase an
      // indexed file's graph record.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        removed.push(file.path);
      }
      continue;
    }

    if (!stats.isFile()) {
      // The tracked path is no longer a regular file -- e.g. a commit
      // switch replaced `entry.ts` with a directory. Treat it the same as
      // a deletion rather than letting a stale file record linger forever
      // (a downstream content read would just fail with EISDIR).
      removed.push(file.path);
      continue;
    }

    const unchangedByStat = stats.mtimeMs === file.modifiedAt && stats.size === file.size;
    // Was this record's own capture too close to its recorded mtime to
    // trust as a stable "at rest" snapshot? If so, an exact match here
    // can't rule out a same-tick edit that happened right after capture.
    const wasRacyCapture = file.indexedAt - file.modifiedAt < RACY_WINDOW_MS;
    if (unchangedByStat && !wasRacyCapture) {
      continue;
    }

    // Defense in depth: only pay for the realpath-based boundary check
    // once a file already looks drifted (a tracked path could in
    // principle have been swapped for a symlink escaping root between
    // syncs). A boundary violation is treated the same as an unreadable
    // file -- skip, don't assume removal.
    if (!validatePathWithinRoot(rootDir, file.path)) {
      continue;
    }

    modified.push(file.path);
  }

  return { modified, removed };
}
