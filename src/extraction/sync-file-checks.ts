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
