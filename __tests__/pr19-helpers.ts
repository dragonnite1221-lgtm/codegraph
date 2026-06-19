/**
 * Shared helpers for the pr19-improvements test files (temp dirs + sqlite
 * availability probe). Split out so the topic files share one setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pr19-test-'));
}

export function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function hasSqliteBindings(): boolean {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

export const HAS_SQLITE = hasSqliteBindings();
