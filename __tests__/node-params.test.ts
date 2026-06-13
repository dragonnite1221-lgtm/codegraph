import { describe, expect, it, vi } from 'vitest';

import {
  describeNodeRequiredFields,
  isNodePersistable,
  nodeToStatementParams,
} from '../src/db/node-params';
import type { Node } from '../src/types';

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'node-1',
    kind: 'function',
    name: 'run',
    qualifiedName: 'Service::run',
    filePath: 'src/service.ts',
    language: 'typescript',
    startLine: 4,
    endLine: 8,
    startColumn: 2,
    endColumn: 1,
    updatedAt: 123,
    ...overrides,
  };
}

describe('node statement params', () => {
  it('maps optional node fields to SQLite-safe params', () => {
    const params = nodeToStatementParams(node({
      isExported: true,
      decorators: ['memo'],
      typeParameters: ['T'],
    }));

    expect(params).toMatchObject({
      id: 'node-1',
      qualifiedName: 'Service::run',
      isExported: 1,
      isAsync: 0,
      docstring: null,
      decorators: '["memo"]',
      typeParameters: '["T"]',
      updatedAt: 123,
    });
  });

  it('falls back to name and current time when optional fields are absent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T00:00:00Z'));
    try {
      const params = nodeToStatementParams(node({ qualifiedName: undefined, updatedAt: undefined }));

      expect(params.qualifiedName).toBe('run');
      expect(params.updatedAt).toBe(Date.parse('2026-06-13T00:00:00Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports missing required fields without including optional columns', () => {
    const incomplete = node({ name: '' });

    expect(isNodePersistable(incomplete)).toBe(false);
    expect(describeNodeRequiredFields(incomplete)).toEqual({
      id: 'node-1',
      kind: 'function',
      name: '',
      filePath: 'src/service.ts',
      language: 'typescript',
    });
  });
});
