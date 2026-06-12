import { describe, expect, it } from 'vitest';

import { buildQueryResultLines } from '../src/bin/query-output';
import type { SearchResult } from '../src/types';

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function searchResult(overrides: Partial<SearchResult['node']>, score = 0.87): SearchResult {
  return {
    score,
    node: {
      id: 'node-id',
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
    },
  };
}

describe('query output helpers', () => {
  it('renders an empty line set for no results', () => {
    expect(buildQueryResultLines('missing', [])).toEqual([]);
  });

  it('renders search result names, score, location, and signature', () => {
    const lines = buildQueryResultLines('build', [
      searchResult({ signature: 'function buildThing(): void' }),
    ]).map(stripAnsi);

    expect(lines.some((line) => line.includes('Search Results for "build"'))).toBe(true);
    expect(lines).toContain('function    buildThing (87%)');
    expect(lines).toContain('  src/index.ts:12');
    expect(lines).toContain('  function buildThing(): void');
    expect(lines.at(-1)).toBe('');
  });

  it('omits the signature line when a node has no signature', () => {
    const lines = buildQueryResultLines('App', [
      searchResult({
        kind: 'class',
        name: 'App',
        qualifiedName: 'src/app.ts::App',
        filePath: 'src/app.ts',
        startLine: 5,
      }, 0.414),
    ]).map(stripAnsi);

    expect(lines).toContain('class       App (41%)');
    expect(lines).toContain('  src/app.ts:5');
    expect(lines).not.toContain('  function buildThing(): void');
  });
});
