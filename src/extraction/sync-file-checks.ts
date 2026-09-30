/**
 * Small path/content-hash helpers shared by the git-fast-path and full-scan
 * sync planners. Split out so both can use them without one importing the
 * other (which would create a require cycle between the two planner files).
 */

import * as fs from 'fs';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot } from '../utils';
import { hashContent } from './file-scanner';

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

/**
 * Hash + stat a file from a single open file descriptor, so the two are
 * guaranteed to describe the exact same snapshot of the file's bytes.
 * Reading the content and stat()-ing the path separately (even back to
 * back) leaves a window where a concurrent write lands in between, which
 * would pair an old content hash with a newer mtime/size in the DB.
 */
export function readContentHashWithStats(
  rootDir: string,
  filePath: string,
  maxFileSize: number
): { hash: string; stats: fs.Stats; oversized?: false } | { stats: fs.Stats; oversized: true } | null {
  const fullPath = validatePathWithinRoot(rootDir, filePath);
  if (!fullPath) {
    logWarn('Path traversal blocked while detecting changes', { filePath });
    return null;
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(fullPath, 'r');
    const stats = fs.fstatSync(fd);
    if (stats.size > maxFileSize) return { stats, oversized: true };

    // A writer can grow the file after fstat; cap the actual read too.
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maxFileSize - total + 1), null);
      if (count === 0) break;
      total += count;
      if (total > maxFileSize) return { stats, oversized: true };
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return { hash: hashContent(Buffer.concat(chunks).toString('utf-8')), stats };
  } catch (error) {
    logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed or invalid -- nothing more we can do.
      }
    }
  }
}
