import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import picomatch from 'picomatch';

import type { CodeGraphConfig } from '../types';
import { normalizePath } from '../utils';

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


export { scanDirectory, scanDirectoryAsync } from './file-scanner-scan';
