import { describe, expect, it } from 'vitest';

import { storeExtractionResult } from '../src/extraction/result-storage';
import type { Edge, ExtractionResult, FileRecord, Node } from '../src/types';

/**
 * Regression: reindexing a file cascades-deletes edges.target too, which
 * wipes incoming edges from OTHER, untouched files (e.g. a.ts calling
 * b.ts's function) even when a body-only edit doesn't change the callee's
 * identity. storeExtractionResult must replay those edges when the target
 * symbol's id survives the reindex, and must NOT replay them when it
 * doesn't (an actual rename/removal) or when it's no longer a valid
 * external reference target (e.g. `export` was dropped).
 */

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: id,
    filePath: 'src/b.ts',
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

function makeQueries(existingFile: FileRecord, oldNodes: Node[], incomingByTarget: Record<string, Edge[]>) {
  return {
    deleted: [] as string[],
    edges: [] as Edge[][],
    getFileByPath: () => existingFile,
    getNodesByFile: () => oldNodes,
    getIncomingEdgesForTargets(targetIds: string[]) {
      return targetIds.flatMap((id) => incomingByTarget[id] ?? []);
    },
    deleteFile(filePath: string) {
      this.deleted.push(filePath);
    },
    insertNodes() {},
    insertEdges(edges: Edge[]) {
      this.edges.push(edges);
    },
    insertUnresolvedRefsBatch() {},
    upsertFile() {},
    transaction<T>(fn: () => T): T {
      return fn();
    },
  };
}

const existingFile: FileRecord = {
  path: 'src/b.ts',
  contentHash: 'old-hash',
  language: 'typescript',
  size: 5,
  modifiedAt: 1,
  indexedAt: 1,
  nodeCount: 1,
};
const oldTarget = makeNode('target');
const callerEdge: Edge = { source: 'caller', target: 'target', kind: 'calls', line: 4, column: 9 };

describe('cross-file incoming edges on reindex', () => {
  it('preserves the caller edge when the callee id survives the reindex', () => {
    const queries = makeQueries(existingFile, [oldTarget], { target: [callerEdge] });

    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target')] })
    );

    expect(queries.deleted).toEqual(['src/b.ts']);
    expect(queries.edges.flat()).toContainEqual(callerEdge);
  });

  it('drops the caller edge when the callee symbol does not survive the reindex', () => {
    const queries = makeQueries(existingFile, [oldTarget], { target: [callerEdge] });

    // b.ts was reparsed and no longer produces a node with id 'target'
    // (renamed or removed) -- the old caller edge must not be resurrected.
    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('renamedTarget')] })
    );

    expect(queries.deleted).toEqual(['src/b.ts']);
    expect(queries.edges.flat()).not.toContainEqual(callerEdge);
  });

  it('drops the caller edge when the surviving id is no longer exported', () => {
    const queries = makeQueries(existingFile, [oldTarget], { target: [callerEdge] });

    // The id survives (same file+kind+name+line), but `export` was dropped
    // from the declaration -- it's no longer reachable from other files,
    // even though the old cross-file edge still references it by id.
    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target', { isExported: false })] })
    );

    expect(queries.edges.flat()).not.toContainEqual(callerEdge);
  });

  it('replays the edge when isExported is undefined (visibility not tracked)', () => {
    const queries = makeQueries(existingFile, [oldTarget], { target: [callerEdge] });

    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target')] }) // isExported left undefined
    );

    expect(queries.edges.flat()).toContainEqual(callerEdge);
  });

  it('keeps distinct edges with the same source/target/kind/line/column but different provenance or metadata', () => {
    const edgeA: Edge = { ...callerEdge, provenance: 'tree-sitter', metadata: { arg: 1 } };
    const edgeB: Edge = { ...callerEdge, provenance: 'heuristic', metadata: { arg: 2 } };
    const queries = makeQueries(existingFile, [oldTarget], { target: [edgeA, edgeB] });

    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target')] })
    );

    const preserved = queries.edges.flat();
    expect(preserved).toContainEqual(edgeA);
    expect(preserved).toContainEqual(edgeB);
  });

  it('dedupes truly identical edges (including matching metadata/provenance)', () => {
    const duplicate: Edge = { ...callerEdge, provenance: 'tree-sitter', metadata: { arg: 1 } };
    const queries = makeQueries(existingFile, [oldTarget], {
      target: [duplicate, { ...duplicate }],
    });

    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target')] })
    );

    const preserved = queries.edges.flat().filter((e) => e.source === 'caller');
    expect(preserved).toHaveLength(1);
  });
});
