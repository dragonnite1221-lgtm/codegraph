import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';

import type { CodeGraphConfig } from '../types';
import { logDebug } from '../errors';
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
function matchesGlob(filePath: string, pattern: string): boolean {
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
function getGitVisibleFiles(rootDir: string): Set<string> | null {
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

    const tracked = execFileSync('git', ['ls-files', '-c', '--recurse-submodules'], gitOpts);
    for (const line of tracked.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        files.add(normalizePath(trimmed));
      }
    }

    const untracked = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], gitOpts);
    for (const line of untracked.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        files.add(normalizePath(trimmed));
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
    const output = execFileSync('git', ['status', '--porcelain', '--no-renames'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const modified: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];

    for (const line of output.split('\n')) {
      if (line.length < 4) continue;

      const statusCode = line.substring(0, 2);
      const filePath = normalizePath(line.substring(3));
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
 * Marker file name that indicates a directory (and all children) should be skipped.
 */
const CODEGRAPH_IGNORE_MARKER = '.codegraphignore';

/**
 * Recursively scan directory for source files.
 *
 * In git repos, uses `git ls-files` to get the file list (inherently
 * respects .gitignore at all levels), then filters by config include patterns.
 * Falls back to filesystem walk for non-git projects.
 */
export function scanDirectory(
  rootDir: string,
  config: CodeGraphConfig,
  onProgress?: (current: number, file: string) => void
): string[] {
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (shouldIncludeFile(filePath, config)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
      }
    }
    return files;
  }

  return scanDirectoryWalk(rootDir, config, onProgress);
}

/**
 * Async variant of scanDirectory that yields to the event loop periodically,
 * allowing worker threads to receive and render progress messages.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  config: CodeGraphConfig,
  onProgress?: (current: number, file: string) => void
): Promise<string[]> {
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (shouldIncludeFile(filePath, config)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
        if (count % 100 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }
    return files;
  }

  return scanDirectoryWalk(rootDir, config, onProgress);
}

/**
 * Filesystem walk fallback for non-git projects.
 */
function scanDirectoryWalk(
  rootDir: string,
  config: CodeGraphConfig,
  onProgress?: (current: number, file: string) => void
): string[] {
  const files: string[] = [];
  let count = 0;
  const visitedDirs = new Set<string>();

  function walk(dir: string): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('Skipping unresolvable directory', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    const ignoreMarker = path.join(dir, CODEGRAPH_IGNORE_MARKER);
    if (fs.existsSync(ignoreMarker)) {
      logDebug('Skipping directory due to .codegraphignore marker', { dir });
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('Skipping unreadable directory', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const stat = fs.statSync(realTarget);
          if (stat.isDirectory()) {
            const dirPattern = relativePath + '/';
            let excluded = false;
            for (const pattern of config.exclude) {
              if (matchesGlob(dirPattern, pattern) || matchesGlob(relativePath, pattern)) {
                excluded = true;
                break;
              }
            }
            if (!excluded) {
              walk(fullPath);
            }
          } else if (stat.isFile() && shouldIncludeFile(relativePath, config)) {
            files.push(relativePath);
            count++;
            onProgress?.(count, relativePath);
          }
        } catch {
          logDebug('Skipping broken symlink', { path: fullPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        const dirPattern = relativePath + '/';
        let excluded = false;
        for (const pattern of config.exclude) {
          if (matchesGlob(dirPattern, pattern) || matchesGlob(relativePath, pattern)) {
            excluded = true;
            break;
          }
        }
        if (!excluded) {
          walk(fullPath);
        }
      } else if (entry.isFile() && shouldIncludeFile(relativePath, config)) {
        files.push(relativePath);
        count++;
        onProgress?.(count, relativePath);
      }
    }
  }

  walk(rootDir);
  return files;
}
