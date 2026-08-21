/**
 * Directory scanning split out of file-scanner.ts to keep it within the
 * 200-line limit. No behavior change.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CodeGraphConfig } from '../types';
import { isPathWithinRootReal, normalizePath } from '../utils';
import { logDebug } from '../errors';
import { getGitVisibleFiles, matchesGlob, shouldIncludeFile } from './file-scanner';

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
      if (shouldIncludeFile(filePath, config) && isPathWithinRootReal(filePath, rootDir)) {
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
      if (shouldIncludeFile(filePath, config) && isPathWithinRootReal(filePath, rootDir)) {
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

    // Pass the lexical path into the boundary check. Passing `realDir` here
    // would reject a safe project whose *root* is itself a symlink (for
    // example macOS /tmp) before the helper can compare both real paths.
    if (!isPathWithinRootReal(dir, rootDir)) {
      logDebug('Skipping directory outside project root', { dir, realDir });
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
          // `fullPath` is still rooted beneath the configured project path.
          // The helper resolves it and the root together, so it rejects an
          // outward link while accepting an in-root link through a symlinked
          // project root.
          if (!isPathWithinRootReal(fullPath, rootDir)) {
            logDebug('Skipping symlink outside project root', { path: fullPath, realTarget });
          } else if (stat.isDirectory()) {
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
