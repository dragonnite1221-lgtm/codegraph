import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { buildGitSyncPlan } from '../src/extraction/sync-operations-plan';
import { hashContent } from '../src/extraction/file-scanner';
import type { SyncOperationsContext } from '../src/extraction/sync-operations';
import { DEFAULT_CONFIG } from '../src/types';
import type { FileRecord } from '../src/types-records';
import { initGit, git, makeFakeQueries } from './helpers/git-sync-test-utils';

const posixIt = process.platform === 'win32' ? it.skip : it;

posixIt('prunes an indexed file newly excluded by config even when Git is unchanged', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-exclude-prune-'));
  try {
    initGit(rootDir);
    const filePath = 'excluded.ts';
    const content = 'export const excluded = 1;';
    fs.writeFileSync(path.join(rootDir, filePath), content);
    git(rootDir, 'add', filePath);
    git(rootDir, 'commit', '-qm', 'initial');
    const stats = fs.statSync(path.join(rootDir, filePath));
    const tracked: FileRecord = {
      path: filePath,
      contentHash: hashContent(content),
      language: 'typescript',
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: 1,
    };
    const context: SyncOperationsContext = {
      rootDir,
      config: { ...DEFAULT_CONFIG, rootDir, include: ['**/*.ts'], exclude: ['excluded.ts'] },
      queries: makeFakeQueries([tracked]),
      indexFile: async () => { throw new Error('not needed'); },
    };

    const plan = buildGitSyncPlan(context);
    expect(plan?.removed).toEqual([filePath]);
    expect(plan?.filesToIndex).toEqual([]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
