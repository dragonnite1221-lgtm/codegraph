/**
 * QueryBuilder file/unresolved/edge query tests. Split out of
 * sqlite-backend.test.ts to stay within the file-size gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { CodeGraph } from '../src';
import type { FileRecord, Node, UnresolvedReference } from '../src/types';
describe('QueryBuilder unresolved reference queries', () => {
  let dir: string;

  function nodeRecord(id: string, filePath: string): Node {
    return {
      id,
      kind: 'function',
      name: id,
      qualifiedName: id,
      filePath,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 1,
      updatedAt: 1,
    };
  }

  function unresolvedRef(
    fromNodeId: string,
    referenceName: string,
    filePath: string
  ): UnresolvedReference {
    return {
      fromNodeId,
      referenceName,
      referenceKind: 'calls',
      line: 1,
      column: 1,
      filePath,
      language: 'typescript',
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-unresolved-query-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads unresolved refs by file scope and deletes resolved refs precisely', () => {
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(conn.getDb());

    queries.insertNode(nodeRecord('from-a', 'src/a.ts'));
    queries.insertNode(nodeRecord('from-b', 'src/b.ts'));
    queries.insertUnresolvedRefsBatch([
      unresolvedRef('from-a', 'targetA', 'src/a.ts'),
      unresolvedRef('from-b', 'targetB', 'src/b.ts'),
      unresolvedRef('from-b', 'targetC', 'src/b.ts'),
    ]);

    try {
      expect(queries.getUnresolvedReferences().map(ref => ref.referenceName)).toEqual([
        'targetA',
        'targetB',
        'targetC',
      ]);
      expect(
        queries.getUnresolvedReferencesByFiles(['src/b.ts']).map(ref => ref.referenceName)
      ).toEqual(['targetB', 'targetC']);
      expect(queries.getUnresolvedReferencesBatch(1, 1).map(ref => ref.referenceName)).toEqual([
        'targetB',
      ]);

      queries.deleteSpecificResolvedReferences([
        { fromNodeId: 'from-b', referenceName: 'targetB', referenceKind: 'calls' },
      ]);
      expect(queries.getUnresolvedReferences().map(ref => ref.referenceName)).toEqual([
        'targetA',
        'targetC',
      ]);

      queries.deleteResolvedReferences(['from-a']);
      expect(queries.getUnresolvedReferences().map(ref => ref.referenceName)).toEqual([
        'targetC',
      ]);
    } finally {
      conn.close();
    }
  });
});

