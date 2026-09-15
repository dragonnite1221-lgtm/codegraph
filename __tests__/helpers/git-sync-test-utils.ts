/**
 * Shared test utilities for buildGitSyncPlan regression tests: a minimal
 * temp-git-repo harness and an in-memory QueryBuilder stand-in.
 */
import { execFileSync } from 'node:child_process';
import type { FileRecord } from '../../src/types-records';
import type { QueryBuilder } from '../../src/db/queries';

export function initGit(cwd: string): void {
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'CodeGraph Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Minimal in-memory QueryBuilder stand-in: just the methods buildGitSyncPlan reads/writes. */
export function makeFakeQueries(initial: FileRecord[]): QueryBuilder & { upsertCalls: FileRecord[] } {
  const files = new Map(initial.map((f) => [f.path, f]));
  const upsertCalls: FileRecord[] = [];
  return {
    getAllFiles: () => [...files.values()],
    getFileByPath: (p: string) => files.get(p) ?? null,
    upsertFile: (f: FileRecord) => {
      upsertCalls.push(f);
      files.set(f.path, f);
    },
    upsertCalls,
  } as unknown as QueryBuilder & { upsertCalls: FileRecord[] };
}
