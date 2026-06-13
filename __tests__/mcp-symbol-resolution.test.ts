import { describe, expect, it } from 'vitest';

import {
  findAllSymbols,
  findSymbol,
  lastQualifierPart,
  matchesSymbol,
} from '../src/mcp/symbol-resolution';
import type { Node, SearchResult } from '../src/types';

function node(overrides: Partial<Node>): Node {
  return {
    id: overrides.id ?? 'id',
    kind: overrides.kind ?? 'function',
    name: overrides.name ?? 'run',
    qualifiedName: overrides.qualifiedName ?? 'src/stage_apply.rs::run',
    filePath: overrides.filePath ?? 'src/stage_apply.rs',
    language: overrides.language ?? 'rust',
    startLine: overrides.startLine ?? 10,
    endLine: overrides.endLine ?? 12,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function graph(resultsByQuery: Record<string, SearchResult[]>) {
  return {
    calls: [] as Array<{ query: string; limit: number }>,
    searchNodes(query: string, options: { limit: number }): SearchResult[] {
      this.calls.push({ query, limit: options.limit });
      return resultsByQuery[query] ?? [];
    },
  };
}

describe('MCP symbol resolution helpers', () => {
  it('extracts the tail of qualified symbols', () => {
    expect(lastQualifierPart('crate::configurator::stage_apply::run')).toBe('run');
    expect(lastQualifierPart('Session.request')).toBe('request');
    expect(lastQualifierPart('plain')).toBe('plain');
  });

  it('matches Rust file-path qualified symbols while ignoring crate prefixes', () => {
    expect(matchesSymbol(node({}), 'crate::stage_apply::run')).toBe(true);
    expect(matchesSymbol(node({}), 'stage_detect::run')).toBe(false);
  });

  it('matches dotted qualified names by semantic suffix', () => {
    expect(matchesSymbol(node({
      name: 'request',
      qualifiedName: 'src/session.ts::Session::request',
      filePath: 'src/session.ts',
    }), 'Session.request')).toBe(true);
  });

  it('falls back to the qualified tail when FTS strips separators', () => {
    const target = node({});
    const cg = graph({
      run: [{ node: target, score: 1 }],
    });

    expect(findSymbol(cg, 'stage_apply::run')?.node).toBe(target);
    expect(cg.calls).toEqual([
      { query: 'stage_apply::run', limit: 50 },
      { query: 'run', limit: 50 },
    ]);
  });

  it('does not fall back to fuzzy results for qualified misses', () => {
    const cg = graph({
      missing: [{ node: node({ name: 'other' }), score: 0.2 }],
    });

    expect(findSymbol(cg, 'stage_apply::missing')).toBeNull();
    expect(findAllSymbols(cg, 'stage_apply::missing')).toEqual({ nodes: [], note: '' });
  });

  it('aggregates all exact matches and reports their locations', () => {
    const first = node({ id: 'a', filePath: 'src/a/stage_apply.rs', startLine: 10 });
    const second = node({ id: 'b', filePath: 'src/b/stage_apply.rs', startLine: 20 });
    const cg = graph({
      run: [
        { node: first, score: 1 },
        { node: second, score: 0.9 },
      ],
    });

    const matches = findAllSymbols(cg, 'stage_apply::run');

    expect(matches.nodes).toEqual([first, second]);
    expect(matches.note).toContain('Aggregated results across 2 symbols');
  });
});
