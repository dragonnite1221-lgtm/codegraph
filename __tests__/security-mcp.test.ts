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

describe('MCP Input Validation', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'example.ts'),
      [
        'export function exampleFunc(): void {}',
        'export function callerFunc(): void { exampleFunc(); }',
        'export class ExampleClass {}',
        '',
      ].join('\n')
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should reject non-string query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: null });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject empty string query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should accept valid query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example' });
    expect(result.isError).toBeFalsy();
  });

  it('should clamp limit to valid range in codegraph_search', async () => {
    // Extremely large limit should still work (clamped to 100)
    const result = await handler.execute('codegraph_search', { query: 'example', limit: 999999 });
    expect(result.isError).toBeFalsy();
  });

  it('should reject non-string symbol in codegraph_callers', async () => {
    const result = await handler.execute('codegraph_callers', { symbol: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject non-string task in codegraph_context', async () => {
    const result = await handler.execute('codegraph_context', { task: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should not follow pre-existing session marker symlinks', async () => {
    const previousSessionId = process.env.CLAUDE_SESSION_ID;
    const sessionId = `codegraph-security-${process.pid}-${Date.now()}`;
    const markerHash = createHash('md5').update(sessionId).digest('hex').slice(0, 16);
    const markerPath = path.join(os.tmpdir(), `codegraph-consulted-${markerHash}`);
    const protectedPath = path.join(testDir, 'protected.txt');

    fs.writeFileSync(protectedPath, 'do-not-overwrite', 'utf8');

    try {
      if (fs.existsSync(markerPath)) {
        fs.rmSync(markerPath, { force: true });
      }
      fs.symlinkSync(protectedPath, markerPath);
      process.env.CLAUDE_SESSION_ID = sessionId;

      const result = await handler.execute('codegraph_context', { task: 'example' });

      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(protectedPath, 'utf8')).toBe('do-not-overwrite');
    } finally {
      if (previousSessionId === undefined) {
        delete process.env.CLAUDE_SESSION_ID;
      } else {
        process.env.CLAUDE_SESSION_ID = previousSessionId;
      }
      if (fs.existsSync(markerPath)) {
        fs.rmSync(markerPath, { force: true });
      }
    }
  });

  it('should reject non-string symbol in codegraph_impact', async () => {
    const result = await handler.execute('codegraph_impact', { symbol: [] });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in codegraph_node', async () => {
    const result = await handler.execute('codegraph_node', { symbol: false });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in codegraph_callees', async () => {
    const result = await handler.execute('codegraph_callees', { symbol: {} });
    expect(result.isError).toBe(true);
  });

  it('should handle NaN limit gracefully', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example', limit: 'abc' });
    expect(result.isError).toBeFalsy();
  });

  it('should handle negative limit gracefully', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example', limit: -5 });
    expect(result.isError).toBeFalsy();
  });

  it('should ignore non-numeric numeric bounds in graph tools', async () => {
    const callers = await handler.execute('codegraph_callers', {
      symbol: 'exampleFunc',
      limit: 'not-a-number',
    });
    expect(callers.isError).toBeFalsy();
    expect(callers.content[0].text).toContain('callerFunc');

    const callees = await handler.execute('codegraph_callees', {
      symbol: 'callerFunc',
      limit: 'not-a-number',
    });
    expect(callees.isError).toBeFalsy();
    expect(callees.content[0].text).toContain('exampleFunc');

    const impact = await handler.execute('codegraph_impact', {
      symbol: 'callerFunc',
      depth: 'not-a-number',
    });
    expect(impact.isError).toBeFalsy();

    const files = await handler.execute('codegraph_files', {
      maxDepth: 'not-a-number',
    });
    expect(files.isError).toBeFalsy();

    const context = await handler.execute('codegraph_context', {
      task: 'example',
      maxNodes: 'not-a-number',
    });
    expect(context.isError).toBeFalsy();

    const explore = await handler.execute('codegraph_explore', {
      query: 'example',
      maxFiles: 'not-a-number',
    });
    expect(explore.isError).toBeFalsy();
  });
});

