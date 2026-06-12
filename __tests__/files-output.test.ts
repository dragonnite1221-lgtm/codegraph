import { describe, expect, it } from 'vitest';

import { buildFileTreeLines } from '../src/bin/files-output';

describe('buildFileTreeLines', () => {
  it('renders directories before files and preserves nested tree structure', () => {
    const lines = buildFileTreeLines([
      { path: 'src/index.ts', language: 'typescript', nodeCount: 3 },
      { path: 'README.md', language: 'markdown', nodeCount: 0 },
      { path: 'src/bin/codegraph.ts', language: 'typescript', nodeCount: 12 },
    ], false, undefined);

    expect(lines).toEqual([
      '├── src',
      '│   ├── bin',
      '│   │   └── codegraph.ts',
      '│   └── index.ts',
      '└── README.md',
    ]);
  });

  it('adds metadata to file nodes when requested', () => {
    const lines = buildFileTreeLines([
      { path: 'src/index.ts', language: 'typescript', nodeCount: 3 },
    ], true, undefined);

    expect(lines[0]).toContain('src');
    expect(lines[1]).toContain('index.ts');
    expect(lines[1]).toContain('(typescript, 3 symbols)');
  });

  it('honors maxDepth', () => {
    const lines = buildFileTreeLines([
      { path: 'src/bin/codegraph.ts', language: 'typescript', nodeCount: 12 },
    ], false, 1);

    expect(lines).toEqual(['└── src']);
  });
});
