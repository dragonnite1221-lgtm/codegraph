/**
 * SQLite backend visibility tests
 *
 * Pins the WASM-fallback banner content + the per-instance backend
 * tracking. Closes the visibility gap behind issue #138.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildWasmFallbackBanner,
  rollbackAndRethrowTransactionError,
  translateNamedParams,
  WASM_FALLBACK_FIX_RECIPE,
} from '../src/db/sqlite-adapter';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { CodeGraph } from '../src';
import type { FileRecord, Node, UnresolvedReference } from '../src/types';

describe('buildWasmFallbackBanner — fix-recipe content', () => {
  it('includes the macOS / Linux / cross-platform fix commands', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).toContain('WASM SQLite fallback active');
    expect(banner).toContain('5-10x slower');
    expect(banner).toContain('xcode-select --install');
    expect(banner).toContain('apt install build-essential');
    expect(banner).toContain('npm rebuild better-sqlite3');
    expect(banner).toContain('npm install better-sqlite3 --save');
    expect(banner).toContain('codegraph status');
  });

  it('appends the native load error when one is provided', () => {
    const banner = buildWasmFallbackBanner(
      "Cannot find module 'better-sqlite3'"
    );
    expect(banner).toContain(
      "Native load error: Cannot find module 'better-sqlite3'"
    );
  });

  it('omits the load-error block when no error is supplied', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).not.toContain('Native load error:');
  });
});

describe('WASM_FALLBACK_FIX_RECIPE — single source of truth', () => {
  it('mentions the three recovery commands', () => {
    expect(WASM_FALLBACK_FIX_RECIPE).toContain('xcode-select --install');
    expect(WASM_FALLBACK_FIX_RECIPE).toContain('npm rebuild better-sqlite3');
    expect(WASM_FALLBACK_FIX_RECIPE).toContain(
      'npm install better-sqlite3 --save'
    );
  });
});

describe('rollbackAndRethrowTransactionError', () => {
  it('preserves the original transaction error when rollback also fails', () => {
    const original = new Error('insert failed');
    const db = {
      exec(sql: string): void {
        expect(sql).toBe('ROLLBACK');
        throw new Error('cannot rollback - no transaction is active');
      },
    };

    expect(() => rollbackAndRethrowTransactionError(db, original)).toThrow(original);
  });
});

describe('translateNamedParams', () => {
  it('does not replace @ characters inside SQL string literals or comments', () => {
    const result = translateNamedParams(
      "SELECT '@literal' AS email, value FROM users -- @comment\nWHERE id = @id AND note = 'user@domain.com'"
    );

    expect(result.sql).toBe(
      "SELECT '@literal' AS email, value FROM users -- @comment\nWHERE id = ? AND note = 'user@domain.com'"
    );
    expect(result.paramOrder).toEqual(['id']);
  });

  it('preserves escaped quotes and quoted identifiers while translating params', () => {
    const result = translateNamedParams(
      `SELECT "owner@name", 'it''s @literal' FROM t WHERE a = @a AND b = @b`
    );

    expect(result.sql).toBe(
      `SELECT "owner@name", 'it''s @literal' FROM t WHERE a = ? AND b = ?`
    );
    expect(result.paramOrder).toEqual(['a', 'b']);
  });

  it('preserves backtick and bracket quoted identifiers', () => {
    const result = translateNamedParams(
      'SELECT `owner@name`, [user@domain] FROM t WHERE id = @id'
    );

    expect(result.sql).toBe(
      'SELECT `owner@name`, [user@domain] FROM t WHERE id = ?'
    );
    expect(result.paramOrder).toEqual(['id']);
  });
});

describe('DatabaseConnection — per-instance backend reporting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-backend-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a concrete backend (native or wasm) for an initialized DB', () => {
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const backend = conn.getBackend();
    expect(['native', 'wasm']).toContain(backend);
    conn.close();
  });

  it('CodeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(['native', 'wasm']).toContain(cg.getBackend());
    } finally {
      cg.destroy();
    }
  });
});

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
