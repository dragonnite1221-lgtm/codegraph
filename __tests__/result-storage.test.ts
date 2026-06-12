import { describe, expect, it } from 'vitest';

import { storeExtractionResult } from '../src/extraction/result-storage';
import type { Edge, ExtractionResult, FileRecord, Node, UnresolvedReference } from '../src/types';

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: id,
    filePath: 'src/a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [],
    durationMs: 1,
    ...overrides,
  };
}

function makeQueries(existingFile: FileRecord | null = null) {
  return {
    deleted: [] as string[],
    nodes: [] as Node[][],
    edges: [] as Edge[][],
    refs: [] as UnresolvedReference[][],
    files: [] as FileRecord[],
    getFileByPath: () => existingFile,
    deleteFile(filePath: string) {
      this.deleted.push(filePath);
    },
    insertNodes(nodes: Node[]) {
      this.nodes.push(nodes);
    },
    insertEdges(edges: Edge[]) {
      this.edges.push(edges);
    },
    insertUnresolvedRefsBatch(refs: UnresolvedReference[]) {
      this.refs.push(refs);
    },
    upsertFile(file: FileRecord) {
      this.files.push(file);
    },
  };
}

describe('extraction result storage', () => {
  it('skips unchanged files by content hash', () => {
    const queries = makeQueries({
      path: 'src/a.ts',
      contentHash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      language: 'typescript',
      size: 5,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 0,
    });

    storeExtractionResult(
      queries,
      'src/a.ts',
      'hello',
      'typescript',
      { size: 5, mtimeMs: 10 } as import('fs').Stats,
      makeResult()
    );

    expect(queries.deleted).toEqual([]);
    expect(queries.files).toEqual([]);
  });

  it('filters edges and unresolved refs to inserted nodes', () => {
    const queries = makeQueries();
    const validNode = makeNode('valid');
    const invalidNode = makeNode('', { id: '' });

    storeExtractionResult(
      queries,
      'src/a.ts',
      'content',
      'typescript',
      { size: 7, mtimeMs: 10 } as import('fs').Stats,
      makeResult({
        nodes: [validNode, invalidNode],
        edges: [
          { source: 'valid', target: 'valid', kind: 'calls' },
          { source: 'valid', target: 'missing', kind: 'calls' },
        ],
        unresolvedReferences: [
          {
            fromNodeId: 'valid',
            referenceName: 'build',
            referenceKind: 'calls',
            line: 1,
            column: 0,
          },
          {
            fromNodeId: 'missing',
            referenceName: 'skip',
            referenceKind: 'calls',
            line: 1,
            column: 0,
          },
        ],
      })
    );

    expect(queries.nodes[0]).toEqual([validNode]);
    expect(queries.edges[0]).toEqual([{ source: 'valid', target: 'valid', kind: 'calls' }]);
    expect(queries.refs[0]).toMatchObject([
      {
        fromNodeId: 'valid',
        referenceName: 'build',
        filePath: 'src/a.ts',
        language: 'typescript',
      },
    ]);
    expect(queries.files[0]).toMatchObject({
      path: 'src/a.ts',
      language: 'typescript',
      size: 7,
      nodeCount: 2,
    });
  });
});
