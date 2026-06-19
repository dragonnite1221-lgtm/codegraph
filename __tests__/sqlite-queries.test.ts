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

describe('QueryBuilder file queries', () => {
  let dir: string;

  function fileRecord(filePath: string): FileRecord {
    return {
      path: filePath,
      contentHash: `hash:${filePath}`,
      language: filePath.endsWith('.ts') ? 'typescript' : 'unknown',
      size: 10,
      modifiedAt: 1,
      indexedAt: 2,
      nodeCount: 0,
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-file-query-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes dot prefixes and escapes LIKE wildcards', () => {
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(conn.getDb());

    queries.upsertFile(fileRecord('src/foo%literal.ts'));
    queries.upsertFile(fileRecord('src/foo_extra.ts'));
    queries.upsertFile(fileRecord('src/foo/literal.ts'));

    try {
      expect(queries.getAllFiles({ pathPrefix: './src/foo%' }).map(file => file.path)).toEqual([
        'src/foo%literal.ts',
      ]);
      expect(queries.countFiles({ pathPrefix: './src/foo%' })).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('keeps unfiltered file reads ordered and applies positive limits', () => {
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(conn.getDb());

    queries.upsertFile(fileRecord('src/b.ts'));
    queries.upsertFile(fileRecord('src/a.ts'));

    try {
      expect(queries.getAllFiles().map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(queries.getAllFiles({ limit: 1 }).map(file => file.path)).toEqual(['src/a.ts']);
    } finally {
      conn.close();
    }
  });
});

describe('QueryBuilder edge queries', () => {
  let dir: string;

  function nodeRecord(id: string): Node {
    return {
      id,
      kind: 'function',
      name: id,
      qualifiedName: id,
      filePath: `${id}.ts`,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 1,
      updatedAt: 1,
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-edge-query-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters outgoing and incoming edges and recovers edges inside a node set', () => {
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(conn.getDb());

    queries.insertNodes([nodeRecord('a'), nodeRecord('b'), nodeRecord('c')]);
    queries.insertEdges([
      { source: 'a', target: 'b', kind: 'calls', provenance: 'tree-sitter' },
      { source: 'a', target: 'c', kind: 'imports', provenance: 'scip' },
      { source: 'b', target: 'a', kind: 'references' },
    ]);

    try {
      expect(
        queries.getOutgoingEdges('a', ['calls'], 'tree-sitter').map(edge => edge.target)
      ).toEqual(['b']);
      expect(queries.getIncomingEdges('a', ['references']).map(edge => edge.source)).toEqual([
        'b',
      ]);
      expect(
        queries.findEdgesBetweenNodes(['a', 'b'], ['calls']).map(edge => [
          edge.source,
          edge.target,
        ])
      ).toEqual([['a', 'b']]);
    } finally {
      conn.close();
    }
  });
});
