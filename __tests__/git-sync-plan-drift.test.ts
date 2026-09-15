/**
 * Regression: buildGitSyncPlan must not rely on `git status` alone to decide
 * which tracked files changed.
 *
 * `getGitChangedFiles` (file-scanner.ts) shells out to `git status
 * --porcelain`, which only diffs the working tree against the CURRENT
 * index/HEAD. It goes clean the instant that diff closes -- even when a
 * tracked file's actual bytes still differ from what's recorded in the DB.
 * Two concrete ways that happens:
 *
 *  - An uncommitted edit gets indexed (DB records its hash), then the edit
 *    is reverted with `git checkout -- <file>` / `git restore <file>`.
 *    HEAD never moved, so git status is clean again, but the DB still
 *    holds the hash of the now-gone edit instead of the restored original.
 *  - `git checkout <other-commit>` changes a tracked file's content, and by
 *    the time codegraph looks, the working tree already matches the new
 *    HEAD -- so git status reports nothing, even though the file's content
 *    (and the DB's stale hash for it) no longer match.
 *
 * Both cases leave the graph silently describing content that's no longer
 * on disk. buildGitSyncPlan must fall back to checking tracked files git
 * status didn't flag.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGitSyncPlan } from '../src/extraction/sync-operations-plan';
import type { SyncOperationsContext } from '../src/extraction/sync-operations';
import { hashContent } from '../src/extraction/file-scanner';
import { DEFAULT_CONFIG } from '../src/types';
import type { FileRecord } from '../src/types-records';
import type { QueryBuilder } from '../src/db/queries';

const posixIt = process.platform === 'win32' ? it.skip : it;

function initGit(cwd: string): void {
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'CodeGraph Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Minimal in-memory QueryBuilder stand-in: just the two methods buildGitSyncPlan reads. */
function makeFakeQueries(initial: FileRecord[]): QueryBuilder {
  const files = new Map(initial.map((f) => [f.path, f]));
  return {
    getAllFiles: () => [...files.values()],
    getFileByPath: (p: string) => files.get(p) ?? null,
  } as unknown as QueryBuilder;
}

describe('buildGitSyncPlan git-status blind spots', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-drift-'));
    initGit(rootDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { force: true, recursive: true });
  });

  posixIt('detects a tracked file reverted to its original content with `git checkout --`', () => {
    const filePath = 'a.ts';
    const original = 'export const a = 1;';
    const edited = 'export const a = 2;';

    fs.writeFileSync(path.join(rootDir, filePath), original);
    git(rootDir, 'add', filePath);
    git(rootDir, 'commit', '-qm', 'initial');

    // Simulate a prior sync that indexed the (still uncommitted-at-the-time)
    // edit: the DB now holds the edited content's hash/mtime.
    fs.writeFileSync(path.join(rootDir, filePath), edited);
    const editedMtime = fs.statSync(path.join(rootDir, filePath)).mtimeMs;
    const tracked: FileRecord = {
      path: filePath,
      contentHash: hashContent(edited),
      language: 'typescript',
      size: edited.length,
      modifiedAt: editedMtime,
      indexedAt: Date.now(),
      nodeCount: 0,
    };

    // Revert the uncommitted edit back to the last commit. HEAD never
    // moves, so `git status` is clean again.
    git(rootDir, 'checkout', '--', filePath);
    expect(fs.readFileSync(path.join(rootDir, filePath), 'utf-8')).toBe(original);

    const context: SyncOperationsContext = {
      rootDir,
      config: { ...DEFAULT_CONFIG, rootDir, exclude: [] },
      queries: makeFakeQueries([tracked]),
      indexFile: async () => {
        throw new Error('not used in this test');
      },
    };

    const plan = buildGitSyncPlan(context);

    // The restored file's real content (`original`) no longer matches the
    // DB's stale hash (of `edited`) -- it must be queued for reindexing.
    expect(plan?.modified).toContain(filePath);
  });
});
