import { describe, expect, it } from 'vitest';

import { buildNodeOutput, buildSearchOutput, type LookupGraph } from '../src/mcp/lookup-output';
import type { Node, SearchResult } from '../src/types';

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: overrides.id ?? 'node-1',
    kind: overrides.kind ?? 'function',
    name: overrides.name ?? 'buildThing',
    qualifiedName: overrides.qualifiedName ?? 'src/index.ts::buildThing',
    filePath: overrides.filePath ?? 'src/index.ts',
    language: overrides.language ?? 'typescript',
    startLine: overrides.startLine ?? 12,
    endLine: overrides.endLine ?? 20,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function graph(resultsByQuery: Record<string, SearchResult[]>, codeById: Record<string, string> = {}) {
  return {
    searchCalls: [] as Array<{ query: string; limit: number; kinds?: string[] }>,
    codeCalls: [] as string[],
    searchNodes(query: string, options: { limit: number; kinds?: string[] }): SearchResult[] {
      this.searchCalls.push({ query, limit: options.limit, kinds: options.kinds });
      return resultsByQuery[query] ?? [];
    },
    async getCode(nodeId: string): Promise<string | null> {
      this.codeCalls.push(nodeId);
      return codeById[nodeId] ?? null;
    },
  } as LookupGraph & {
    searchCalls: Array<{ query: string; limit: number; kinds?: string[] }>;
    codeCalls: string[];
  };
}

describe('MCP lookup output helpers', () => {
  it('formats search results and forwards filters', () => {
    const target = node({ kind: 'class', name: 'Service' });
    const cg = graph({ Service: [{ node: target, score: 1 }] });

    const output = buildSearchOutput(cg, 'Service', { limit: 7, kind: 'class' });

    expect(cg.searchCalls).toEqual([{ query: 'Service', limit: 7, kinds: ['class'] }]);
    expect(output).toContain('## Search Results (1 found)');
    expect(output).toContain('### Service (class)');
  });

  it('returns a clear search miss message', () => {
    expect(buildSearchOutput(graph({}), 'missing', { limit: 10 })).toBe(
      'No results found for "missing"',
    );
  });

  it('formats node details without loading code by default', async () => {
    const target = node({ id: 'target' });
    const cg = graph({ buildThing: [{ node: target, score: 1 }] }, {
      target: 'export function buildThing() {}',
    });

    const output = await buildNodeOutput(cg, 'buildThing', false);

    expect(cg.codeCalls).toEqual([]);
    expect(output).toContain('**Location:** src/index.ts:12');
    expect(output).not.toContain('```typescript');
  });

  it('loads code when requested and reports node misses', async () => {
    const target = node({ id: 'target' });
    const cg = graph({ buildThing: [{ node: target, score: 1 }] }, {
      target: 'export function buildThing() {}',
    });

    const output = await buildNodeOutput(cg, 'buildThing', true);

    expect(cg.codeCalls).toEqual(['target']);
    expect(output).toContain('```typescript');
    expect(output).toContain('export function buildThing() {}');
    await expect(buildNodeOutput(graph({}), 'missing', true)).resolves.toBe(
      'Symbol "missing" not found in the codebase',
    );
  });
});
