/**
 * Path security utilities
 *
 * Path-traversal and sensitive-directory guards used at MCP/API/extraction
 * entry points. Split out of utils.ts to keep security-sensitive validation
 * in one cohesive, well-tested module.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Sensitive system directories that should never be used as project roots.
 * Checked on all platforms; non-applicable paths are harmlessly skipped.
 */
const SENSITIVE_PATHS = new Set([
  '/', '/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/dev', '/proc', '/sys',
  '/root', '/boot', '/lib', '/lib64', '/opt',
  'C:\\', 'C:\\Windows', 'C:\\Windows\\System32',
]);

/**
 * Validate that a resolved file path stays within the project root.
 * Prevents path traversal attacks (e.g. node.filePath = "../../etc/passwd").
 *
 * @param projectRoot - The project root directory
 * @param filePath - The relative file path to validate
 * @returns The resolved absolute path, or null if it escapes the root
 */
export function validatePathWithinRoot(projectRoot: string, filePath: string): string | null {
  const resolved = path.resolve(projectRoot, filePath);
  const normalizedRoot = path.resolve(projectRoot);

  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    return null;
  }
  return resolved;
}

/**
 * Validate that a path is a safe project root directory.
 *
 * Rejects sensitive system directories and ensures the path is
 * a real, existing directory. Used at MCP and API entry points
 * to prevent arbitrary directory access.
 *
 * @param dirPath - The path to validate
 * @returns An error message if invalid, or null if valid
 */
export function validateProjectPath(dirPath: string): string | null {
  const resolved = path.resolve(dirPath);

  // Block sensitive system directories
  if (SENSITIVE_PATHS.has(resolved) || SENSITIVE_PATHS.has(resolved.toLowerCase())) {
    return `Refusing to operate on sensitive system directory: ${resolved}`;
  }

  // Also block common sensitive home subdirectories
  const homeDir = require('os').homedir();
  const sensitiveHomeDirs = ['.ssh', '.gnupg', '.aws', '.config'];
  for (const dir of sensitiveHomeDirs) {
    const sensitivePath = path.join(homeDir, dir);
    if (resolved === sensitivePath || resolved.startsWith(sensitivePath + path.sep)) {
      return `Refusing to operate on sensitive directory: ${resolved}`;
    }
  }

  // Verify it's a real directory
  try {
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return `Path is not a directory: ${resolved}`;
    }
  } catch {
    return `Path does not exist or is not accessible: ${resolved}`;
  }

  return null;
}

/**
 * Check if a file path resolves to a location within the given root directory.
 *
 * Prevents path traversal attacks by ensuring the resolved absolute path
 * starts with the resolved root path. Handles '..' sequences, symlink-like
 * relative paths, and platform-specific separators.
 *
 * @param filePath - The path to check (can be relative or absolute)
 * @param rootDir - The root directory that filePath must stay within
 * @returns true if filePath resolves to a location within rootDir
 */
export function isPathWithinRoot(filePath: string, rootDir: string): boolean {
  const resolvedPath = path.resolve(rootDir, filePath);
  const resolvedRoot = path.resolve(rootDir);
  return resolvedPath.startsWith(resolvedRoot + path.sep) || resolvedPath === resolvedRoot;
}

/**
 * Like isPathWithinRoot but also resolves symlinks via fs.realpathSync.
 *
 * This catches symlink escapes where the logical path appears to be within
 * root but the real path on disk points elsewhere. Falls back to logical
 * path checking if realpath resolution fails (e.g. broken symlink).
 */
export function isPathWithinRootReal(filePath: string, rootDir: string): boolean {
  // First do the cheap logical check
  if (!isPathWithinRoot(filePath, rootDir)) {
    return false;
  }

  // Then verify with realpath to catch symlink escapes
  try {
    const realPath = fs.realpathSync(path.resolve(rootDir, filePath));
    const realRoot = fs.realpathSync(rootDir);
    return realPath.startsWith(realRoot + path.sep) || realPath === realRoot;
  } catch {
    // If realpath fails (broken symlink, permissions), fall back to logical check
    return true;
  }
}
