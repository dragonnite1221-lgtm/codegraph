import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFileTreeLines } from '../src/bin/files-output';
import { _resetGlyphsCache } from '../src/ui/glyphs';

describe('buildFileTreeLines', () => {
  // buildFileTreeLines picks tree connectors via getGlyphs(), which probes
  // the host terminal (e.g. TERM=linux forces the ASCII fallback). Pin the
  // Unicode path so assertions are environment-independent.
  let savedUnicode: string | undefined;

  beforeEach(() => {
    savedUnicode = process.env.CODEGRAPH_UNICODE;
    process.env.CODEGRAPH_UNICODE = '1';
    _resetGlyphsCache();
  });

  afterEach(() => {
    if (savedUnicode === undefined) delete process.env.CODEGRAPH_UNICODE;
    else process.env.CODEGRAPH_UNICODE = savedUnicode;
    _resetGlyphsCache();
  });

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
