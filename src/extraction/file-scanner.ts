import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';

import type { CodeGraphConfig } from '../types';
import type { FileRecord } from '../types-records';
import { normalizePath } from '../utils';
import { validatePathWithinRoot } from '../path-security';

/**
 * Calculate SHA256 hash of file contents.
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a path matches any glob pattern.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  filePath = normalizePath(filePath);
  return picomatch.isMatch(filePath, pattern, { dot: true });
}

/**
 * Check if a file should be included based on config.
 */
export function shouldIncludeFile(
  filePath: string,
  config: CodeGraphConfig
): boolean {
  for (const pattern of config.exclude) {
    if (matchesGlob(filePath, pattern)) {
      return false;
    }
  }

  for (const pattern of config.include) {
    if (matchesGlob(filePath, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Get all files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore at all levels (root, subdirectories).
 * Returns null on failure (non-git project) so callers can fall back.
 */
export function getGitVisibleFiles(rootDir: string): Set<string> | null {
  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing, so fall back to filesystem walk.
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (path.resolve(gitRoot) !== path.resolve(rootDir)) {
      try {
        execFileSync('git', ['check-ignore', '-q', path.resolve(rootDir)], {
          cwd: rootDir,
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return null;
      } catch {
        // Not ignored, safe to use git ls-files.
      }
    }

    const files = new Set<string>();
    const gitOpts = {
      cwd: rootDir,
      encoding: 'utf-8' as const,
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    };

    const tracked = execFileSync('git', ['ls-files', '-z', '-c', '--recurse-submodules'], gitOpts);
    for (const filePath of tracked.split('\0')) {
      if (filePath) {
        files.add(normalizePath(filePath));
      }
    }

    const untracked = execFileSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], gitOpts);
    for (const filePath of untracked.split('\0')) {
      if (filePath) {
        files.add(normalizePath(filePath));
      }
    }

    return files;
  } catch {
    return null;
  }
}

/**
 * Result of git-based change detection.
 * Returns null when git is unavailable (non-git project or command failure),
 * signaling the caller to fall back to full filesystem scan.
 */
export interface GitChanges {
  modified: string[];
  added: string[];
  deleted: string[];
}

/**
 * Use `git status` to detect changed files instead of scanning every file.
 * Returns null on failure so callers fall back to full scan.
 */
export function getGitChangedFiles(
  rootDir: string,
  config: CodeGraphConfig
): GitChanges | null {
  try {
    const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--no-renames'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const modified: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];

    for (const entry of output.split('\0')) {
      if (entry.length < 4) continue;

      const statusCode = entry.slice(0, 2);
      const filePath = normalizePath(entry.slice(3));
      if (!shouldIncludeFile(filePath, config)) continue;

      if (statusCode === '??') {
        added.push(filePath);
      } else if (statusCode.includes('D')) {
        deleted.push(filePath);
      } else {
        modified.push(filePath);
      }
    }

    return { modified, added, deleted };
  } catch {
    return null;
  }
}

/**
 * Reconciliation result for tracked files that `git status` didn't flag.
 */
export interface TrackedFileDrift {
  /** Tracked files whose on-disk mtime no longer matches the DB record. */
  modified: string[];
  /** Tracked files that no longer exist (or resolve) on disk. */
  removed: string[];
}

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
 * touched-but-unchanged mtime causes no false positive.
 */
export function findDriftedTrackedFiles(
  rootDir: string,
  trackedFiles: Array<Pick<FileRecord, 'path' | 'modifiedAt'>>
): TrackedFileDrift {
  const modified: string[] = [];
  const removed: string[] = [];

  for (const file of trackedFiles) {
    const fullPath = validatePathWithinRoot(rootDir, file.path);
    if (!fullPath) {
      removed.push(file.path);
      continue;
    }

    try {
      const stats = fs.statSync(fullPath);
      if (stats.mtimeMs !== file.modifiedAt) {
        modified.push(file.path);
      }
    } catch {
      removed.push(file.path);
    }
  }

  return { modified, removed };
}

export { scanDirectory, scanDirectoryAsync } from './file-scanner-scan';
