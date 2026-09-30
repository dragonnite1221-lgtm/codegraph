import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { buildFullScanSyncPlan, buildGitSyncPlan } from '../src/extraction/sync-operations-plan';
import { readContentHashWithStats } from '../src/extraction/sync-file-checks';
import { hashContent } from '../src/extraction/file-scanner';
import type { SyncOperationsContext } from '../src/extraction/sync-operations';
import { DEFAULT_CONFIG } from '../src/types';
import type { FileRecord } from '../src/types-records';
import { initGit, git, makeFakeQueries } from './helpers/git-sync-test-utils';

const posixIt = process.platform === 'win32' ? it.skip : it;

posixIt('does not hash an oversized tracked file and removes its stale graph', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-oversized-sync-'));
  try {
    initGit(rootDir);
    const filePath = 'growing.ts';
    const oldContent = 'export const value = 1;';
    fs.writeFileSync(path.join(rootDir, filePath), oldContent);
    git(rootDir, 'add', filePath);
    git(rootDir, 'commit', '-qm', 'initial');
    const oldStats = fs.statSync(path.join(rootDir, filePath));
    const tracked: FileRecord = {
      path: filePath,
      contentHash: hashContent(oldContent),
      language: 'typescript',
      size: oldStats.size,
      modifiedAt: oldStats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: 1,
    };
    fs.writeFileSync(path.join(rootDir, filePath), oldContent + 'x'.repeat(1024));
    const context: SyncOperationsContext = {
      rootDir,
      config: { ...DEFAULT_CONFIG, rootDir, exclude: [], maxFileSize: 64 },
      queries: makeFakeQueries([tracked]),
      indexFile: async () => { throw new Error('not needed'); },
    };

    expect(readContentHashWithStats(rootDir, filePath, 64)?.oversized).toBe(true);
    const gitPlan = buildGitSyncPlan(context);
    expect(gitPlan?.removed).toContain(filePath);
    expect(gitPlan?.modified).not.toContain(filePath);
    const fullPlan = buildFullScanSyncPlan(context);
    expect(fullPlan.removed).toContain(filePath);
    expect(fullPlan.modified).not.toContain(filePath);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
