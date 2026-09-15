/**
 * Regression: findDriftedTrackedFiles must not treat every stat() failure
 * as a deletion. Only a genuine "doesn't exist" error (ENOENT/ENOTDIR)
 * should mark a tracked file removed -- a transient/environmental failure
 * (EACCES, EIO, ...) must be skipped instead, otherwise a temporary
 * filesystem hiccup would cause `runSync` to delete a still-valid file's
 * graph record.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDriftedTrackedFiles } from '../src/extraction/file-drift';
import type { FileRecord } from '../src/types-records';

// Permission checks don't apply to root, so a real EACCES can't be forced
// there -- skip rather than produce a flaky pass/fail depending on the CI
// container's user.
const posixNonRootIt =
  process.platform === 'win32' || (process.getuid?.() ?? -1) === 0 ? it.skip : it;

function restoreDirPermissions(dir: string): void {
  try {
    fs.chmodSync(dir, 0o755);
  } catch {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      restoreDirPermissions(path.join(dir, entry.name));
    }
  }
}

function makeTracked(overrides: Partial<FileRecord> & { path: string }): FileRecord {
  return {
    contentHash: 'irrelevant',
    language: 'typescript',
    size: 0,
    modifiedAt: 0,
    indexedAt: 0,
    nodeCount: 0,
    ...overrides,
  };
}

describe('findDriftedTrackedFiles', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-file-drift-'));
  });

  afterEach(() => {
    // Restore exec permission on every directory a test may have locked
    // down -- otherwise recursive removal of its contents would itself fail.
    restoreDirPermissions(rootDir);
    fs.rmSync(rootDir, { force: true, recursive: true });
  });

  it('reports a genuinely deleted tracked file as removed', () => {
    const tracked = makeTracked({ path: 'missing.ts', modifiedAt: 123, size: 10 });

    const result = findDriftedTrackedFiles(rootDir, [tracked]);

    expect(result.removed).toContain('missing.ts');
    expect(result.modified).not.toContain('missing.ts');
  });

  posixNonRootIt('does not treat a transient stat error (EACCES) as a deletion', () => {
    const subDir = path.join(rootDir, 'locked');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'flaky.ts'), 'export const flaky = 1;');
    // Strip exec permission on the containing directory so `stat()` on the
    // file inside it fails with EACCES without the file itself moving.
    fs.chmodSync(subDir, 0o000);

    const tracked = makeTracked({ path: 'locked/flaky.ts', modifiedAt: 1, size: 1 });

    const result = findDriftedTrackedFiles(rootDir, [tracked]);

    // A transient failure must not be reported as either removed or
    // modified -- the DB record should be left untouched this cycle.
    expect(result.removed).not.toContain('locked/flaky.ts');
    expect(result.modified).not.toContain('locked/flaky.ts');
  });

  it('flags a file whose size changed even when mtime coincidentally matches', () => {
    const content = 'export const value = 42;';
    fs.writeFileSync(path.join(rootDir, 'sized.ts'), content);
    const stats = fs.statSync(path.join(rootDir, 'sized.ts'));

    // DB record has the same mtime (simulating a coarse filesystem clock
    // collision) but a different recorded size -- must still be flagged.
    const tracked = makeTracked({
      path: 'sized.ts',
      modifiedAt: stats.mtimeMs,
      size: content.length - 1,
    });

    const result = findDriftedTrackedFiles(rootDir, [tracked]);

    expect(result.modified).toContain('sized.ts');
  });

  it('leaves an unchanged tracked file out of both lists', () => {
    const content = 'export const value = 1;';
    fs.writeFileSync(path.join(rootDir, 'stable.ts'), content);
    const stats = fs.statSync(path.join(rootDir, 'stable.ts'));

    const tracked = makeTracked({
      path: 'stable.ts',
      modifiedAt: stats.mtimeMs,
      size: content.length,
    });

    const result = findDriftedTrackedFiles(rootDir, [tracked]);

    expect(result.modified).not.toContain('stable.ts');
    expect(result.removed).not.toContain('stable.ts');
  });
});
