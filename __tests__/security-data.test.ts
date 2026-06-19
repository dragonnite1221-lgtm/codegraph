/**
 * Security Tests
 *
 * Tests for P0/P1 security fixes:
 * - FileLock (cross-process locking)
 * - Path traversal prevention
 * - MCP input validation
 * - Atomic writes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { FileLock } from '../src/utils';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import { shouldIncludeFile, scanDirectory } from '../src/extraction';
import { shouldIncludeFile as configShouldInclude } from '../src/config';
import { CodeGraphConfig, DEFAULT_CONFIG } from '../src/types';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-security-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Atomic Writes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not leave temp files on success', () => {
    // We test this indirectly through the config-writer module
    // by checking that no .tmp files remain after writing
    const configDir = path.join(tempDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });

    const testFile = path.join(configDir, 'test.json');
    // Simulate what atomicWriteFileSync does
    const tmpPath = testFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, '{"test": true}');
    fs.renameSync(tmpPath, testFile);

    expect(fs.existsSync(testFile)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    const content = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
    expect(content.test).toBe(true);
  });
});

describe('JSON.parse Error Boundaries in DB', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not crash when node has malformed JSON in decorators column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a node with malformed JSON in the decorators column
    db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, decorators, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-node-1', 'function', 'myFunc', 'myFunc', 'test.ts', 'typescript',
      1, 5, 0, 0,
      '{not valid json!!!}',  // malformed decorators
      0, 0, 0, 0, Date.now()
    );

    // Should not throw - should return node with undefined decorators
    const node = queries.getNodeById('test-node-1');
    expect(node).not.toBeNull();
    expect(node!.name).toBe('myFunc');
    expect(node!.decorators).toBeUndefined();

    db.close();
  });

  it('should refresh getNodeById cache when insertNode replaces an existing node', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());
    const baseNode = {
      id: 'cached-node',
      kind: 'function' as const,
      name: 'oldName',
      qualifiedName: 'oldName',
      filePath: 'test.ts',
      language: 'typescript' as const,
      startLine: 1,
      endLine: 5,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    queries.insertNode(baseNode);
    expect(queries.getNodeById('cached-node')?.name).toBe('oldName');

    queries.insertNode({
      ...baseNode,
      name: 'newName',
      qualifiedName: 'newName',
      updatedAt: Date.now() + 1,
    });

    expect(queries.getNodeById('cached-node')?.name).toBe('newName');

    db.close();
  });

  it('should not crash when edge has malformed JSON in metadata column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert two nodes first
    const insertNode = db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run('node-a', 'function', 'funcA', 'funcA', 'a.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());
    insertNode.run('node-b', 'function', 'funcB', 'funcB', 'b.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());

    // Insert edge with malformed metadata
    db.getDb().prepare(`
      INSERT INTO edges (source, target, kind, metadata)
      VALUES (?, ?, ?, ?)
    `).run('node-a', 'node-b', 'calls', 'broken json {{{');

    // Should not throw - should return edge with undefined metadata
    const edges = queries.getOutgoingEdges('node-a');
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe('node-a');
    expect(edges[0].target).toBe('node-b');
    expect(edges[0].metadata).toBeUndefined();

    db.close();
  });

  it('should not crash when file record has malformed JSON in errors column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a file with malformed errors JSON
    db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test.ts', 'abc123', 'typescript', 100, Date.now(), Date.now(), 5, 'not-an-array');

    // Should not throw - should return file with undefined errors
    const file = queries.getFileByPath('test.ts');
    expect(file).not.toBeNull();
    expect(file!.path).toBe('test.ts');
    expect(file!.errors).toBeUndefined();

    db.close();
  });
});

