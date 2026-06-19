/**
 * Shared helpers for the extraction test suite. Not a *.test.ts file so vitest
 * does not execute it directly. Split out of extraction.test.ts for the
 * file-size gate.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}

export function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
