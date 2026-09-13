import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { storeExtractionResult } from '../src/extraction/result-storage';
import type { Edge, ExtractionResult, Node } from '../src/types';

/**
 * Regression: reindexing a file cascades-deletes edges.target too, which
 * wipes incoming edges from OTHER, untouched files (e.g. a.ts calling
 * b.ts's function) even when a body-only edit doesn't change the callee's
 * identity. storeExtractionResult must replay those edges when the target
 * symbol's id survives the reindex, and must NOT replay them when it
 * doesn't (an actual rename/removal).
 *
 * Runs against a real SQLite-backed QueryBuilder (not a hand-rolled mock)
 * so the actual `getIncomingEdgesForTargets` json_each query, ON DELETE
 * CASCADE behavior, and transaction/insert path this patch touches are
 * exercised, not stubbed away.
 *
 * Replay-eligibility (isExported/visibility/file-node) cases live in
 * result-storage-replay-eligibility.test.ts to stay under the 200-line gate.
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

describe('cross-file incoming edges on reindex (real SQLite)', () => {
  let dir: string;
  let conn: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-result-storage-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(conn.getDb());
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Seed b.ts with one old node and one incoming edge from a.ts's 'caller'. */
  function seed(oldTarget: Node, callerEdge: Edge) {
    queries.insertNode({ ...makeNode('caller'), filePath: 'src/a.ts' });
    queries.insertNode(oldTarget);
    queries.insertEdge(callerEdge);
    queries.upsertFile({
      path: 'src/b.ts',
      contentHash: 'old-hash',
      language: 'typescript',
      size: 5,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 1,
    });
  }

  it('preserves the caller edge when the callee id survives the reindex', () => {
    const oldTarget = makeNode('target');
    const callerEdge: Edge = { source: 'caller', target: 'target', kind: 'calls', line: 4, column: 9 };
    seed(oldTarget, callerEdge);

    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target')] })
    );

    expect(queries.getIncomingEdgesForTargets(['target'])).toContainEqual(
      expect.objectContaining(callerEdge)
    );
  });

  it('drops the caller edge when the callee symbol does not survive the reindex', () => {
    const oldTarget = makeNode('target');
    const callerEdge: Edge = { source: 'caller', target: 'target', kind: 'calls', line: 4, column: 9 };
    seed(oldTarget, callerEdge);

    // b.ts was reparsed and no longer produces a node with id 'target'
    // (renamed or removed) -- the old caller edge must not be resurrected,
    // and the cascade delete already removed it from the DB.
    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('renamedTarget')] })
    );

    expect(queries.getIncomingEdgesForTargets(['target', 'renamedTarget'])).toEqual([]);
  });

  it('keeps distinct edges with the same source/target/kind/line/column but different provenance or metadata', () => {
    const oldTarget = makeNode('target');
    const edgeA: Edge = { source: 'caller', target: 'target', kind: 'calls', line: 4, column: 9, provenance: 'tree-sitter', metadata: { arg: 1 } };
    const edgeB: Edge = { source: 'caller', target: 'target', kind: 'calls', line: 4, column: 9, provenance: 'heuristic', metadata: { arg: 2 } };
    queries.insertNode({ ...makeNode('caller'), filePath: 'src/a.ts' });
    queries.insertNode(oldTarget);
    queries.insertEdge(edgeA);
    queries.insertEdge(edgeB);
    queries.upsertFile({
      path: 'src/b.ts', contentHash: 'old-hash', language: 'typescript',
      size: 5, modifiedAt: 1, indexedAt: 1, nodeCount: 1,
    });

    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target')] })
    );

    const preserved = queries.getIncomingEdgesForTargets(['target']);
    expect(preserved).toContainEqual(edgeA);
    expect(preserved).toContainEqual(edgeB);
    expect(preserved).toHaveLength(2);
  });

  it('does not duplicate an edge that already exists as more than one identical row', () => {
    // The edges table has no uniqueness constraint beyond its autoincrement
    // id, so two genuinely identical rows can coexist (e.g. from an earlier
    // extraction quirk). Without dedup, replaying both on every subsequent
    // reindex would make the duplication grow without bound.
    const oldTarget = makeNode('target');
    const dup: Edge = { source: 'caller', target: 'target', kind: 'calls', line: 4, column: 9, provenance: 'tree-sitter', metadata: { arg: 1 } };
    queries.insertNode({ ...makeNode('caller'), filePath: 'src/a.ts' });
    queries.insertNode(oldTarget);
    queries.insertEdge(dup);
    queries.insertEdge({ ...dup });
    queries.upsertFile({
      path: 'src/b.ts', contentHash: 'old-hash', language: 'typescript',
      size: 5, modifiedAt: 1, indexedAt: 1, nodeCount: 1,
    });

    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target')] })
    );

    const preservedFromCaller = queries
      .getIncomingEdgesForTargets(['target'])
      .filter((e) => e.source === 'caller');
    expect(preservedFromCaller).toHaveLength(1);
  });
});
