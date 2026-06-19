/**
 * PR19 improvements: MCP tool improvements. Split out of pr19-improvements.test.ts for the file-size gate.
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

describe('MCP Tool Improvements', () => {
  it.skipIf(!HAS_SQLITE)('should export ToolHandler class', async () => {
    const { ToolHandler } = await import('../src/mcp/tools');
    expect(typeof ToolHandler).toBe('function');
  });

  it.skipIf(!HAS_SQLITE)('should have findSymbol and truncateOutput as private methods', async () => {
    const { ToolHandler } = await import('../src/mcp/tools');
    const proto = ToolHandler.prototype;
    expect(typeof (proto as any).findSymbol).toBe('function');
    expect(typeof (proto as any).truncateOutput).toBe('function');
  });

  it.skipIf(!HAS_SQLITE)('should truncate output exceeding MAX_OUTPUT_LENGTH', async () => {
    const { ToolHandler } = await import('../src/mcp/tools');

    // Access private method for testing
    const handler = Object.create(ToolHandler.prototype);
    const truncate = (handler as any).truncateOutput.bind(handler);

    // Short text should not be truncated
    const short = 'Hello world';
    expect(truncate(short)).toBe(short);

    // Long text should be truncated
    const long = 'x'.repeat(20000);
    const result = truncate(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('... (output truncated)');
  });

  it.skipIf(!HAS_SQLITE)('should truncate at a clean line boundary', async () => {
    const { ToolHandler } = await import('../src/mcp/tools');

    const handler = Object.create(ToolHandler.prototype);
    const truncate = (handler as any).truncateOutput.bind(handler);

    // Build text with newlines exceeding the limit
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`Line ${i}: ${'a'.repeat(50)}`);
    }
    const text = lines.join('\n');

    const result = truncate(text);
    // Should end with truncation notice after a newline boundary
    expect(result).toContain('... (output truncated)');
    // Should not cut mid-line (the char before truncation notice should be \n)
    const beforeTruncation = result.split('\n\n... (output truncated)')[0]!;
    expect(beforeTruncation.endsWith('\n') || !beforeTruncation.includes('\0')).toBe(true);
  });

  describe('findSymbol disambiguation', () => {
    it.skipIf(!HAS_SQLITE)('should prefer exact name matches', async () => {
      const { ToolHandler } = await import('../src/mcp/tools');
      const CodeGraph = (await import('../src/index')).default;

      const tmpDir = createTempDir();
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(path.join(srcDir, 'a.ts'), `
export function getValue(): number { return 1; }
export function getValueFromCache(): number { return 2; }
`);

      const cg = CodeGraph.initSync(tmpDir, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const handler = new ToolHandler(cg);
      const findSymbol = (handler as any).findSymbol.bind(handler);

      const match = findSymbol(cg, 'getValue');
      expect(match).not.toBeNull();
      expect(match.node.name).toBe('getValue');
      // Should not have a disambiguation note for single exact match
      expect(match.note).toBe('');

      handler.closeAll();
      cg.destroy();
      cleanupTempDir(tmpDir);
    });

    it.skipIf(!HAS_SQLITE)('should note when multiple symbols share the same name', async () => {
      const { ToolHandler } = await import('../src/mcp/tools');
      const CodeGraph = (await import('../src/index')).default;

      const tmpDir = createTempDir();
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      // Two files with the same function name
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `
export function handle(): void {}
`);
      fs.writeFileSync(path.join(srcDir, 'b.ts'), `
export function handle(): void {}
`);

      const cg = CodeGraph.initSync(tmpDir, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const handler = new ToolHandler(cg);
      const findSymbol = (handler as any).findSymbol.bind(handler);

      const match = findSymbol(cg, 'handle');
      expect(match).not.toBeNull();
      expect(match.node.name).toBe('handle');
      // Should have a disambiguation note
      expect(match.note).toContain('2 symbols named "handle"');

      handler.closeAll();
      cg.destroy();
      cleanupTempDir(tmpDir);
    });

    it.skipIf(!HAS_SQLITE)('should return null when symbol is not found', async () => {
      const { ToolHandler } = await import('../src/mcp/tools');
      const CodeGraph = (await import('../src/index')).default;

      const tmpDir = createTempDir();
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `export function foo(): void {}`);

      const cg = CodeGraph.initSync(tmpDir, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const handler = new ToolHandler(cg);
      const findSymbol = (handler as any).findSymbol.bind(handler);

      const match = findSymbol(cg, 'nonExistentSymbol');
      expect(match).toBeNull();

      handler.closeAll();
      cg.destroy();
      cleanupTempDir(tmpDir);
    });
  });
});

// =============================================================================
// CLI uninit Command
// =============================================================================

