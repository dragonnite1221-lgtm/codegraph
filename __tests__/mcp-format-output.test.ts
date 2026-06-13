import { describe, expect, it } from 'vitest';

import {
  formatImpact,
  formatNodeDetails,
  formatNodeList,
  formatSearchResults,
  formatTaskContext,
} from '../src/mcp/format-output';
import type { Node, Subgraph, TaskContext } from '../src/types';

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'node-1',
    kind: 'function',
    name: 'buildThing',
    qualifiedName: 'src/index.ts::buildThing',
    filePath: 'src/index.ts',
    language: 'typescript',
    startLine: 12,
    endLine: 20,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('MCP format output helpers', () => {
  it('formats search results with location and signature', () => {
    const output = formatSearchResults([
      { node: node({ signature: 'function buildThing(): void' }), score: 1 },
    ]);

    expect(output).toContain('## Search Results (1 found)');
    expect(output).toContain('### buildThing (function)');
    expect(output).toContain('src/index.ts:12');
    expect(output).toContain('`function buildThing(): void`');
  });

  it('formats compact node lists', () => {
    expect(formatNodeList([node()], 'Callers of buildThing')).toContain(
      '- buildThing (function) - src/index.ts:12',
    );
  });

  it('formats impact grouped by file', () => {
    const impact: Subgraph = {
      nodes: new Map([
        ['a', node({ id: 'a', name: 'alpha', filePath: 'src/a.ts', startLine: 1 })],
        ['b', node({ id: 'b', name: 'beta', filePath: 'src/a.ts', startLine: 5 })],
      ]),
      edges: [],
      roots: ['a'],
    };

    const output = formatImpact('alpha', impact);

    expect(output).toContain('## Impact: "alpha" affects 2 symbols');
    expect(output).toContain('**src/a.ts:**');
    expect(output).toContain('alpha:1, beta:5');
  });

  it('formats node details with optional code and short docs', () => {
    const output = formatNodeDetails(
      node({ docstring: 'Short docs.', signature: 'function buildThing(): void' }),
      'export function buildThing() {}',
    );

    expect(output).toContain('**Location:** src/index.ts:12');
    expect(output).toContain('Short docs.');
    expect(output).toContain('```typescript');
    expect(output).toContain('export function buildThing() {}');
  });

  it('falls back for empty task-context summaries', () => {
    expect(formatTaskContext({ summary: '' } as TaskContext)).toBe('No context found');
  });
});
