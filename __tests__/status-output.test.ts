import { describe, expect, it } from 'vitest';

import {
  buildStatusJson,
  buildStatusLines,
  buildUninitializedStatusJson,
  buildUninitializedStatusLines,
} from '../src/bin/status-output';

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

const input = {
  projectPath: '/repo',
  stats: {
    fileCount: 12,
    nodeCount: 3456,
    edgeCount: 7890,
    dbSizeBytes: 2 * 1024 * 1024,
    nodesByKind: {
      function: 20,
      class: 3,
      variable: 0,
    },
    filesByLanguage: {
      typescript: 5,
      markdown: 2,
      python: 0,
    },
  },
  changes: {
    added: ['src/new.ts'],
    modified: ['src/existing.ts', 'README.md'],
    removed: [],
  },
  backend: 'wasm',
};

describe('status output helpers', () => {
  it('builds the initialized JSON status payload', () => {
    expect(buildStatusJson(input)).toEqual({
      initialized: true,
      projectPath: '/repo',
      fileCount: 12,
      nodeCount: 3456,
      edgeCount: 7890,
      dbSizeBytes: 2 * 1024 * 1024,
      backend: 'wasm',
      nodesByKind: input.stats.nodesByKind,
      languages: ['typescript', 'markdown'],
      pendingChanges: {
        added: 1,
        modified: 2,
        removed: 0,
      },
    });
  });

  it('builds the uninitialized JSON status payload', () => {
    expect(buildUninitializedStatusJson('/repo')).toEqual({
      initialized: false,
      projectPath: '/repo',
    });
  });

  it('renders sorted sections and pending changes', () => {
    const lines = buildStatusLines(input).map(stripAnsi);

    expect(lines).toContain('Project: /repo');
    expect(lines).toContain('  Files:     12');
    expect(lines).toContain('  Nodes:     3,456');
    expect(lines).toContain('  Edges:     7,890');
    expect(lines).toContain('  DB Size:   2.00 MB');
    expect(lines.some((line) => line.startsWith('  Backend:   wasm '))).toBe(true);
    expect(lines.some((line) => line.includes('slower fallback; run `npm rebuild better-sqlite3`'))).toBe(true);
    expect(lines).toContain('  function        20');
    expect(lines).toContain('  class           3');
    expect(lines).toContain('  typescript      5');
    expect(lines).toContain('  markdown        2');
    expect(lines).toContain('Pending Changes:');
    expect(lines).toContain('  Added:     1 files');
    expect(lines).toContain('  Modified:  2 files');
    expect(lines.some((line) => line.includes('Run "codegraph sync" to update the index'))).toBe(true);
  });

  it('renders the up-to-date status when there are no changes', () => {
    const lines = buildStatusLines({
      ...input,
      changes: { added: [], modified: [], removed: [] },
      backend: 'native',
    }).map(stripAnsi);

    expect(lines).toContain('  Backend:   native');
    expect(lines.some((line) => line.includes('Index is up to date'))).toBe(true);
  });

  it('renders uninitialized status guidance', () => {
    const lines = buildUninitializedStatusLines('/repo').map(stripAnsi);

    expect(lines.some((line) => line.includes('CodeGraph Status'))).toBe(true);
    expect(lines.some((line) => line.includes('Project: /repo'))).toBe(true);
    expect(lines.some((line) => line.includes('Not initialized'))).toBe(true);
    expect(lines.some((line) => line.includes('Run "codegraph init" to initialize'))).toBe(true);
  });
});
