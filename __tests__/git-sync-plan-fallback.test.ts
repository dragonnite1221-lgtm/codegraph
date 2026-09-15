/**
 * Regression: buildGitSyncPlan must not silently return an incomplete plan
 * when it can't fully trust its own git-based reconciliation.
 *
 * getGitVisibleFiles() can return null (git ls-files failure, timeout, or a
 * project ignored by a parent repo) even when getGitChangedFiles() (git
 * status) just succeeded. Without the full git-visible set, a file
 * introduced by a commit switch (never shown as `??` by git status) can't
 * be reconciled -- so buildGitSyncPlan must fall back to a full scan
 * (return null) rather than return a plan it knows is incomplete.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fileScanner from '../src/extraction/file-scanner';
import { buildGitSyncPlan } from '../src/extraction/sync-operations-plan';
import type { SyncOperationsContext } from '../src/extraction/sync-operations';
import { DEFAULT_CONFIG } from '../src/types';
import type { QueryBuilder } from '../src/db/queries';

describe('buildGitSyncPlan falls back when git visibility is unavailable', () => {
  it('returns null so the caller falls back to a full scan', () => {
    vi.spyOn(fileScanner, 'getGitChangedFiles').mockReturnValue({
      modified: [],
      added: [],
      deleted: [],
    });
    vi.spyOn(fileScanner, 'getGitVisibleFiles').mockReturnValue(null);

    const context: SyncOperationsContext = {
      rootDir: '/tmp/does-not-matter',
      config: { ...DEFAULT_CONFIG, rootDir: '/tmp/does-not-matter', exclude: [] },
      queries: { getAllFiles: () => [] } as unknown as QueryBuilder,
      indexFile: async () => {
        throw new Error('not used in this test');
      },
    };

    const plan = buildGitSyncPlan(context);

    expect(plan).toBeNull();

    vi.restoreAllMocks();
  });
});
