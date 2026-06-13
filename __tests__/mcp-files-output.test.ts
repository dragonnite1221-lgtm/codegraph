import { describe, expect, it } from 'vitest';

import { filterMcpFiles, formatMcpFiles, limitMcpFiles } from '../src/mcp/files-output';

const files = [
  { path: 'src/index.ts', language: 'typescript', nodeCount: 3 },
  { path: 'src/bin/codegraph.ts', language: 'typescript', nodeCount: 12 },
  { path: 'README.md', language: 'markdown', nodeCount: 0 },
];

describe('MCP files output helpers', () => {
  it('filters by path prefix and glob pattern', () => {
    expect(filterMcpFiles(files, { pathFilter: 'src', pattern: '**/*.ts' }).map(f => f.path)).toEqual([
      'src/index.ts',
      'src/bin/codegraph.ts',
    ]);
  });

  it('anchors glob patterns so suffix lookalikes do not match', () => {
    expect(filterMcpFiles([
      ...files,
      { path: 'src/index.tsx', language: 'tsx', nodeCount: 2 },
      { path: 'src/index.ts.bak', language: 'unknown', nodeCount: 0 },
    ], { pattern: '**/*.ts' }).map(f => f.path)).toEqual([
      'src/index.ts',
      'src/bin/codegraph.ts',
    ]);
  });

  it('renders flat output with metadata', () => {
    expect(formatMcpFiles(files, { includeMetadata: true, format: 'flat' })).toContain(
      '- src/index.ts (typescript, 3 symbols)',
    );
  });

  it('renders grouped output without metadata', () => {
    const output = formatMcpFiles(files, { includeMetadata: false, format: 'grouped' });

    expect(output).toContain('## Files by Language (3 total)');
    expect(output).toContain('### typescript (2)');
    expect(output).toContain('- src/bin/codegraph.ts');
    expect(output).not.toContain('(12 symbols)');
  });

  it('renders tree output and honors maxDepth', () => {
    const output = formatMcpFiles(files, { includeMetadata: false, format: 'tree', maxDepth: 1 });

    expect(output).toContain('## Project Structure (3 files)');
    expect(output).toContain('├── src');
    expect(output).toContain('└── README.md');
    expect(output).not.toContain('codegraph.ts');
  });

  it('limits files before formatting and reports omitted entries', () => {
    const limited = limitMcpFiles(files, 2);
    const output = formatMcpFiles(limited.files, {
      includeMetadata: false,
      format: 'flat',
      omitted: limited.omitted,
    });

    expect(limited.files.map(file => file.path)).toEqual(['src/index.ts', 'src/bin/codegraph.ts']);
    expect(output).toContain('## Files (2)');
    expect(output).toContain('... (1 more files omitted; narrow with path/pattern or increase limit)');
  });
});
