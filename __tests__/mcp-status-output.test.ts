import { describe, expect, it } from 'vitest';

import { buildMcpStatusOutput } from '../src/mcp/status-output';
import type { StatusProvider } from '../src/mcp/status-output';

const stats = {
  fileCount: 12,
  nodeCount: 34,
  edgeCount: 56,
  dbSizeBytes: 2 * 1024 * 1024,
  nodesByKind: {
    function: 20,
    class: 3,
    variable: 0,
  },
  edgesByKind: {},
  filesByLanguage: {
    typescript: 5,
    markdown: 2,
    python: 0,
  },
  lastUpdated: 0,
} as const;

function provider(backend: 'native' | 'wasm'): StatusProvider {
  return {
    getStats: () => stats,
    getBackend: () => backend,
  };
}

describe('MCP status output', () => {
  it('renders index statistics and non-zero group counts', () => {
    const output = buildMcpStatusOutput(provider('native'));

    expect(output).toContain('## CodeGraph Status');
    expect(output).toContain('**Files indexed:** 12');
    expect(output).toContain('**Total nodes:** 34');
    expect(output).toContain('**Total edges:** 56');
    expect(output).toContain('**Database size:** 2.00 MB');
    expect(output).toContain('**Backend:** native (better-sqlite3)');
    expect(output).toContain('- function: 20');
    expect(output).toContain('- class: 3');
    expect(output).not.toContain('- variable: 0');
    expect(output).toContain('- typescript: 5');
    expect(output).toContain('- markdown: 2');
    expect(output).not.toContain('- python: 0');
  });

  it('renders WASM fallback repair guidance', () => {
    const output = buildMcpStatusOutput(provider('wasm'));

    expect(output).toContain('**Backend:** ⚠ wasm');
    expect(output).toContain('better-sqlite3 unavailable');
    expect(output).toContain('npm rebuild better-sqlite3');
  });
});
