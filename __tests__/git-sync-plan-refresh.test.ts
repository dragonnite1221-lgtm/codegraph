/**
 * Regression: buildGitSyncPlan must surface a refreshed FileRecord (mtime,
 * size, and a bumped indexedAt) when the drift sweep flags a tracked file
 * but a real content hash shows nothing actually changed.
 *
 * Without this, a file touched without a real content change (or one
 * whose racy-window re-check comes back with matching content) would keep
 * getting re-flagged -- and re-hashed -- by the drift sweep on every
 * future sync indefinitely, since the DB record's mtime/size would never
 * catch up to reality.
 *
 * buildGitSyncPlan returns the refresh via `plan.staleMetadataRefresh`
 * rather than writing it directly: this planner is also called from the
 * unlocked, read-only `getChangedFilesForIndex` path, which must stay
 * side-effect-free. Only `runSync` (which always runs under the indexing
 * mutex/file lock) applies the refresh -- see the runSync test below.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGitSyncPlan } from '../src/extraction/sync-operations-plan';
import { runSync, type SyncOperationsContext } from '../src/extraction/sync-operations';
import { hashContent } from '../src/extraction/file-scanner';
import { DEFAULT_CONFIG } from '../src/types';
import type { FileRecord } from '../src/types-records';
import { initGit, git, makeFakeQueries } from './helpers/git-sync-test-utils';

const posixIt = process.platform === 'win32' ? it.skip : it;

describe('buildGitSyncPlan drift refresh', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-drift-refresh-'));
    initGit(rootDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { force: true, recursive: true });
  });

  posixIt('refreshes stat bookkeeping for a drifted file whose content is unchanged', () => {
    const filePath = 'touched.ts';
    const content = 'export const touched = 1;';

    fs.writeFileSync(path.join(rootDir, filePath), content);
    git(rootDir, 'add', filePath);
    git(rootDir, 'commit', '-qm', 'initial');

    // Simulate a stale DB record: the file's content matches what's on
    // disk, but the recorded mtime/size are out of date (e.g. the file was
    // touched, or briefly edited and restored, well outside the racy
    // window this test doesn't need to fight).
    const staleTracked: FileRecord = {
      path: filePath,
      contentHash: hashContent(content),
      language: 'typescript',
      size: content.length + 5, // deliberately wrong -- forces drift
      modifiedAt: 0, // deliberately wrong -- forces drift
      indexedAt: Date.now(),
      nodeCount: 0,
    };

    const queries = makeFakeQueries([staleTracked]);
    const context: SyncOperationsContext = {
      rootDir,
      config: { ...DEFAULT_CONFIG, rootDir, exclude: [] },
      queries,
      indexFile: async () => {
        throw new Error('not used in this test');
      },
    };

    const plan = buildGitSyncPlan(context);

    // Content is unchanged -- it must not be queued for reindexing...
    expect(plan?.modified).not.toContain(filePath);
    // ...but the plan must carry a refreshed record so this file doesn't
    // keep getting re-flagged (and re-hashed) forever. buildGitSyncPlan
    // itself must NOT have written it (see the locking rationale above).
    expect(queries.upsertCalls).toHaveLength(0);
    expect(plan?.staleMetadataRefresh).toHaveLength(1);
    const refreshed = plan!.staleMetadataRefresh[0]!;
    expect(refreshed.path).toBe(filePath);
    expect(refreshed.size).toBe(content.length);
    expect(refreshed.modifiedAt).not.toBe(0);
  });

  posixIt('runSync applies the metadata refresh (the read-only plan does not)', async () => {
    const filePath = 'touched.ts';
    const content = 'export const touched = 1;';

    fs.writeFileSync(path.join(rootDir, filePath), content);
    git(rootDir, 'add', filePath);
    git(rootDir, 'commit', '-qm', 'initial');

    const staleTracked: FileRecord = {
      path: filePath,
      contentHash: hashContent(content),
      language: 'typescript',
      size: content.length + 5,
      modifiedAt: 0,
      indexedAt: Date.now(),
      nodeCount: 0,
    };

    const queries = makeFakeQueries([staleTracked]);
    const context: SyncOperationsContext = {
      rootDir,
      config: { ...DEFAULT_CONFIG, rootDir, exclude: [] },
      queries,
      indexFile: async () => {
        throw new Error('not used in this test -- content is unchanged, nothing should be (re)parsed');
      },
    };

    await runSync(context);

    expect(queries.upsertCalls).toHaveLength(1);
    expect(queries.upsertCalls[0]!.path).toBe(filePath);
    expect(queries.upsertCalls[0]!.size).toBe(content.length);
  });
});
