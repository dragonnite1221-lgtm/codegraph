import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { storeExtractionResult } from '../src/extraction/result-storage';
import type { Edge, ExtractionResult, Node } from '../src/types';

/**
 * Regression: a surviving node id (see result-storage-cross-file-edges.test.ts)
 * isn't always still a valid replay target -- isStillReferenceable() in
 * result-storage.ts also has to catch the case where the *identity* survives
 * a reindex but the symbol became unreachable from other files (export/
 * public dropped). Split out to stay under the 200-line file-size gate.
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

describe('replay eligibility on reindex (real SQLite)', () => {
  let dir: string;
  let conn: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-replay-eligibility-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(conn.getDb());
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

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

  it('drops the caller edge when the surviving id is no longer exported (JS/TS-style)', () => {
    const oldTarget = makeNode('target');
    const callerEdge: Edge = { source: 'caller', target: 'target', kind: 'calls', line: 4, column: 9 };
    seed(oldTarget, callerEdge);

    // The id survives (same file+kind+name+line), but `export` was dropped
    // from the declaration -- extractors that track isExported (JS/TS) now
    // report false, so it's no longer reachable from other files.
    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target', { isExported: false })] })
    );

    expect(queries.getIncomingEdgesForTargets(['target'])).toEqual([]);
  });

  it('drops the caller edge when the surviving id turns private (visibility-tracked languages)', () => {
    // Java/C#/Rust/Kotlin/Swift extractors never set isExported -- they
    // report access through `visibility` instead. A public-to-private
    // change must still disqualify replay even though isExported stays
    // undefined throughout.
    const oldTarget = makeNode('target', { language: 'java', visibility: 'public' });
    const callerEdge: Edge = { source: 'caller', target: 'target', kind: 'calls', line: 4, column: 9 };
    seed(oldTarget, callerEdge);

    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'java',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('target', { language: 'java', visibility: 'private' })] })
    );

    expect(queries.getIncomingEdgesForTargets(['target'])).toEqual([]);
  });

  it('preserves an incoming `imports` edge into the file node itself across reindex', () => {
    // File nodes are always emitted with isExported: false (extractors have
    // no "exported" concept for a file/module itself), but they're the
    // normal target of cross-file `imports` edges. A naive isExported check
    // would incorrectly drop this edge on every reindex of the imported file.
    const fileNode = makeNode('file:src/b.ts', { kind: 'file', name: 'b.ts', isExported: false });
    const importEdge: Edge = { source: 'caller', target: 'file:src/b.ts', kind: 'imports', line: 1, column: 0 };
    seed(fileNode, importEdge);

    storeExtractionResult(
      queries,
      'src/b.ts',
      'new content',
      'typescript',
      { size: 9, mtimeMs: 20 } as import('fs').Stats,
      makeResult({ nodes: [makeNode('file:src/b.ts', { kind: 'file', name: 'b.ts', isExported: false })] })
    );

    expect(queries.getIncomingEdgesForTargets(['file:src/b.ts'])).toContainEqual(
      expect.objectContaining(importEdge)
    );
  });
});
