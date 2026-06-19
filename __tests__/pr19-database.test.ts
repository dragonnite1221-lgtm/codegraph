/**
 * PR19 improvements: database layer. Split out of pr19-improvements.test.ts for the file-size gate.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractFromSource } from '../src/extraction';
import {
  getParser, isLanguageSupported, getSupportedLanguages, clearParserCache,
  getUnavailableGrammarErrors, initGrammars, loadAllGrammars,
} from '../src/extraction/grammars';
import { createTempDir, cleanupTempDir, hasSqliteBindings, HAS_SQLITE } from './pr19-helpers';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Database Layer Improvements', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it.skipIf(!HAS_SQLITE)('should support batch insert of unresolved refs', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');

    const dbPath = path.join(testDir, 'codegraph.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a node first (needed as foreign key)
    queries.insertNode({
      id: 'func:test:1',
      kind: 'function',
      name: 'testFunc',
      qualifiedName: 'test::testFunc',
      filePath: 'test.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 5,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });

    // Batch insert unresolved refs with filePath and language
    queries.insertUnresolvedRefsBatch([
      {
        fromNodeId: 'func:test:1',
        referenceName: 'helperA',
        referenceKind: 'calls',
        line: 2,
        column: 4,
        filePath: 'test.ts',
        language: 'typescript',
      },
      {
        fromNodeId: 'func:test:1',
        referenceName: 'helperB',
        referenceKind: 'calls',
        line: 3,
        column: 4,
        filePath: 'test.ts',
        language: 'typescript',
      },
    ]);

    const refs = queries.getUnresolvedReferences();
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.referenceName).sort()).toEqual(['helperA', 'helperB']);

    // Verify filePath and language are persisted
    expect(refs[0]?.filePath).toBe('test.ts');
    expect(refs[0]?.language).toBe('typescript');

    db.close();
  });

  it.skipIf(!HAS_SQLITE)('should support getAllNodes', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');

    const dbPath = path.join(testDir, 'codegraph.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert some nodes
    for (let i = 0; i < 3; i++) {
      queries.insertNode({
        id: `func:test:${i}`,
        kind: 'function',
        name: `func${i}`,
        qualifiedName: `test::func${i}`,
        filePath: 'test.ts',
        language: 'typescript',
        startLine: i * 10 + 1,
        endLine: i * 10 + 5,
        startColumn: 0,
        endColumn: 1,
        updatedAt: Date.now(),
      });
    }

    const allNodes = queries.getAllNodes();
    expect(allNodes).toHaveLength(3);
    expect(allNodes.map((n) => n.name).sort()).toEqual(['func0', 'func1', 'func2']);

    db.close();
  });

  it.skipIf(!HAS_SQLITE)('should set performance pragmas on initialization', async () => {
    const { DatabaseConnection } = await import('../src/db');

    const dbPath = path.join(testDir, 'codegraph.db');
    const db = DatabaseConnection.initialize(dbPath);
    const rawDb = db.getDb();

    // Check pragmas were set
    const synchronous = rawDb.pragma('synchronous', { simple: true });
    expect(synchronous).toBe(1); // NORMAL = 1

    const cacheSize = rawDb.pragma('cache_size', { simple: true }) as number;
    expect(cacheSize).toBe(-64000);

    const tempStore = rawDb.pragma('temp_store', { simple: true });
    expect(tempStore).toBe(2); // MEMORY = 2

    const mmapSize = rawDb.pragma('mmap_size', { simple: true }) as number;
    expect(mmapSize).toBe(268435456); // 256 MB

    db.close();
  });

  it.skipIf(!HAS_SQLITE)('should handle empty batch insert gracefully', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');

    const dbPath = path.join(testDir, 'codegraph.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Should not throw on empty array
    expect(() => queries.insertUnresolvedRefsBatch([])).not.toThrow();

    db.close();
  });
});

// =============================================================================
// Resolution Warm Caches
// =============================================================================

