/**
 * Node query tests
 *
 * Pins the behavior of the NodeQueries split out of QueryBuilder: CRUD,
 * cache invalidation on update/delete, kind/file/name lookups, and the
 * lightweight getAllNodeNames pre-filter. Exercised through the public
 * QueryBuilder surface against a real SQLite database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { Node } from '../src/types';

function nodeRecord(id: string, name: string, filePath: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    ...overrides,
  };
}

describe('QueryBuilder node queries', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-query-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function open(): { queries: QueryBuilder; close: () => void } {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    return { queries: new QueryBuilder(conn.getDb()), close: () => conn.close() };
  }

  it('inserts, reads, and deletes nodes', () => {
    const { queries, close } = open();
    try {
      queries.insertNodes([
        nodeRecord('a', 'alpha', 'src/a.ts'),
        nodeRecord('b', 'beta', 'src/a.ts', { kind: 'class' }),
        nodeRecord('c', 'gamma', 'src/c.ts'),
      ]);

      expect(queries.getNodeById('a')?.name).toBe('alpha');
      expect(queries.getNodesByFile('src/a.ts').map((n) => n.id)).toEqual(['a', 'b']);
      expect(queries.getNodesByKind('class').map((n) => n.id)).toEqual(['b']);
      expect(queries.getAllNodes()).toHaveLength(3);

      queries.deleteNode('a');
      expect(queries.getNodeById('a')).toBeNull();

      queries.deleteNodesByFile('src/a.ts');
      expect(queries.getNodesByFile('src/a.ts')).toEqual([]);
      expect(queries.getAllNodes().map((n) => n.id)).toEqual(['c']);
    } finally {
      close();
    }
  });

  it('reflects updates after invalidating the cache', () => {
    const { queries, close } = open();
    try {
      queries.insertNode(nodeRecord('a', 'alpha', 'src/a.ts'));
      // Prime the cache.
      expect(queries.getNodeById('a')?.signature).toBeUndefined();

      queries.updateNode(nodeRecord('a', 'alpha', 'src/a.ts', { signature: 'alpha(): void' }));
      expect(queries.getNodeById('a')?.signature).toBe('alpha(): void');
    } finally {
      close();
    }
  });

  it('looks up nodes by exact, qualified, and lowercased name', () => {
    const { queries, close } = open();
    try {
      queries.insertNode(nodeRecord('a', 'Widget', 'src/a.ts', { qualifiedName: 'pkg.Widget' }));

      expect(queries.getNodesByName('Widget').map((n) => n.id)).toEqual(['a']);
      expect(queries.getNodesByQualifiedNameExact('pkg.Widget').map((n) => n.id)).toEqual(['a']);
      expect(queries.getNodesByLowerName('widget').map((n) => n.id)).toEqual(['a']);
      expect(queries.getAllNodeNames()).toEqual(['Widget']);
    } finally {
      close();
    }
  });

  it('skips nodes missing required fields without throwing', () => {
    const { queries, close } = open();
    try {
      // Empty name is not persistable; insert is a no-op rather than a bind error.
      queries.insertNode(nodeRecord('bad', '', 'src/bad.ts'));
      expect(queries.getNodeById('bad')).toBeNull();
      expect(queries.getAllNodes()).toEqual([]);
    } finally {
      close();
    }
  });
});
