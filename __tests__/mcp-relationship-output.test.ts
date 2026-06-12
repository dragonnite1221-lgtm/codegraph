import { describe, expect, it } from 'vitest';

import {
  buildCallersOutput,
  buildCalleesOutput,
  buildImpactOutput,
  type RelationshipGraph,
} from '../src/mcp/relationship-output';
import type { Edge, Node, SearchResult, Subgraph } from '../src/types';

function node(overrides: Partial<Node>): Node {
  return {
    id: overrides.id ?? 'id',
    kind: overrides.kind ?? 'function',
    name: overrides.name ?? 'run',
    qualifiedName: overrides.qualifiedName ?? `src/${overrides.id ?? 'id'}.ts::run`,
    filePath: overrides.filePath ?? `src/${overrides.id ?? 'id'}.ts`,
    language: overrides.language ?? 'typescript',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 2,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function edge(overrides: Partial<Edge>): Edge {
  return {
    source: overrides.source ?? 'source',
    target: overrides.target ?? 'target',
    kind: overrides.kind ?? 'calls',
    ...overrides,
  };
}

function graph(options: {
  search?: Record<string, Node[]>;
  callers?: Record<string, Node[]>;
  callees?: Record<string, Node[]>;
  impact?: Record<string, Subgraph>;
  impactDepths?: number[];
} = {}): RelationshipGraph {
  return {
    searchNodes(query: string): SearchResult[] {
      return (options.search?.[query] ?? []).map((result) => ({ node: result, score: 1 }));
    },
    getCallers(nodeId: string) {
      return (options.callers?.[nodeId] ?? []).map((caller) => ({
        node: caller,
        edge: edge({ source: caller.id, target: nodeId }),
      }));
    },
    getCallees(nodeId: string) {
      return (options.callees?.[nodeId] ?? []).map((callee) => ({
        node: callee,
        edge: edge({ source: nodeId, target: callee.id }),
      }));
    },
    getImpactRadius(nodeId: string, maxDepth?: number) {
      options.impactDepths?.push(maxDepth ?? -1);
      return options.impact?.[nodeId] ?? { nodes: new Map(), edges: [], roots: [nodeId] };
    },
  };
}

describe('MCP relationship output helpers', () => {
  it('aggregates callers across matching symbols and removes duplicates', () => {
    const first = node({ id: 'root-a', filePath: 'src/a.ts', startLine: 10 });
    const second = node({ id: 'root-b', filePath: 'src/b.ts', startLine: 20 });
    const sharedCaller = node({ id: 'caller', name: 'invoke', filePath: 'src/use.ts', startLine: 5 });
    const cg = graph({
      search: { run: [first, second] },
      callers: {
        'root-a': [sharedCaller],
        'root-b': [sharedCaller],
      },
    });

    const output = buildCallersOutput(cg, 'run', 20);

    expect(output).toContain('## Callers of run (1 found)');
    expect(output).toContain('- invoke (function) - src/use.ts:5');
    expect(output).toContain('Aggregated results across 2 symbols named "run"');
  });

  it('returns a not-found message when the symbol cannot be resolved', () => {
    expect(buildCallersOutput(graph(), 'missing', 20)).toBe(
      'Symbol "missing" not found in the codebase',
    );
  });

  it('aggregates callees and respects the requested limit', () => {
    const root = node({ id: 'root', name: 'handler' });
    const first = node({ id: 'callee-a', name: 'parseInput', startLine: 3 });
    const second = node({ id: 'callee-b', name: 'saveOutput', startLine: 9 });
    const cg = graph({
      search: { handler: [root] },
      callees: { root: [first, second] },
    });

    const output = buildCalleesOutput(cg, 'handler', 1);

    expect(output).toContain('## Callees of handler (1 found)');
    expect(output).toContain('parseInput');
    expect(output).not.toContain('saveOutput');
  });

  it('merges impact graphs and forwards the depth limit', () => {
    const first = node({ id: 'root-a', filePath: 'src/a.ts', startLine: 10 });
    const second = node({ id: 'root-b', filePath: 'src/b.ts', startLine: 20 });
    const shared = node({ id: 'shared', name: 'shared', filePath: 'src/shared.ts', startLine: 30 });
    const depths: number[] = [];
    const cg = graph({
      search: { run: [first, second] },
      impactDepths: depths,
      impact: {
        'root-a': {
          nodes: new Map([[first.id, first], [shared.id, shared]]),
          edges: [edge({ source: first.id, target: shared.id })],
          roots: [first.id],
        },
        'root-b': {
          nodes: new Map([[second.id, second], [shared.id, shared]]),
          edges: [edge({ source: second.id, target: shared.id })],
          roots: [second.id],
        },
      },
    });

    const output = buildImpactOutput(cg, 'run', 4);

    expect(depths).toEqual([4, 4]);
    expect(output).toContain('## Impact: "run" affects 3 symbols');
    expect(output).toContain('**src/shared.ts:**');
    expect(output).toContain('Aggregated results across 2 symbols named "run"');
  });
});
