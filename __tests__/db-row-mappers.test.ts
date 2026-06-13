import { describe, expect, it } from 'vitest';

import {
  rowToEdge,
  rowToFileRecord,
  rowToNode,
  rowToUnresolvedReference,
  type EdgeRow,
  type FileRow,
  type NodeRow,
  type UnresolvedRefRow,
} from '../src/db/row-mappers';

function nodeRow(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id: 'node-1',
    kind: 'function',
    name: 'buildThing',
    qualified_name: 'src/index.ts::buildThing',
    file_path: 'src/index.ts',
    language: 'typescript',
    start_line: 12,
    end_line: 20,
    start_column: 0,
    end_column: 1,
    docstring: null,
    signature: null,
    visibility: 'public',
    is_exported: 1,
    is_async: 0,
    is_static: 0,
    is_abstract: 0,
    decorators: null,
    type_parameters: null,
    updated_at: 1,
    ...overrides,
  };
}

describe('database row mappers', () => {
  it('maps node rows and tolerates malformed JSON columns', () => {
    const node = rowToNode(nodeRow({
      decorators: '{not json',
      type_parameters: '["T"]',
    }));

    expect(node.name).toBe('buildThing');
    expect(node.isExported).toBe(true);
    expect(node.decorators).toBeUndefined();
    expect(node.typeParameters).toEqual(['T']);
  });

  it('maps edge rows with optional metadata', () => {
    const row: EdgeRow = {
      id: 1,
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: '{"weight":2}',
      line: 3,
      col: 4,
      provenance: 'parser',
    };

    expect(rowToEdge(row)).toMatchObject({
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { weight: 2 },
      line: 3,
      column: 4,
      provenance: 'parser',
    });
  });

  it('maps file rows and unresolved reference rows', () => {
    const fileRow: FileRow = {
      path: 'src/index.ts',
      content_hash: 'abc',
      language: 'typescript',
      size: 123,
      modified_at: 10,
      indexed_at: 20,
      node_count: 2,
      errors: '["warn"]',
    };
    const refRow: UnresolvedRefRow = {
      id: 1,
      from_node_id: 'node-1',
      reference_name: 'missing',
      reference_kind: 'calls',
      line: 4,
      col: 8,
      candidates: '["candidate"]',
      file_path: 'src/index.ts',
      language: 'typescript',
    };

    expect(rowToFileRecord(fileRow).errors).toEqual(['warn']);
    expect(rowToUnresolvedReference(refRow)).toMatchObject({
      fromNodeId: 'node-1',
      referenceName: 'missing',
      referenceKind: 'calls',
      candidates: ['candidate'],
    });
  });
});
