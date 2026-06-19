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

describe('Glob Matching (picomatch)', () => {
  const makeConfig = (include: string[], exclude: string[]): CodeGraphConfig => ({
    ...DEFAULT_CONFIG,
    rootDir: '/test',
    include,
    exclude,
  });

  it('should match standard glob patterns in extraction', () => {
    const config = makeConfig(['**/*.ts'], ['node_modules/**']);

    expect(shouldIncludeFile('src/index.ts', config)).toBe(true);
    expect(shouldIncludeFile('src/deep/nested/file.ts', config)).toBe(true);
    expect(shouldIncludeFile('src/index.js', config)).toBe(false);
    expect(shouldIncludeFile('node_modules/lib/index.ts', config)).toBe(false);
  });

  it('should match standard glob patterns in config', () => {
    const config = makeConfig(['**/*.py'], ['__pycache__/**']);

    expect(configShouldInclude('src/main.py', config)).toBe(true);
    expect(configShouldInclude('src/main.ts', config)).toBe(false);
    expect(configShouldInclude('__pycache__/module.py', config)).toBe(false);
  });

  it('should handle complex glob patterns correctly', () => {
    const config = makeConfig(['src/**/*.{ts,tsx}', 'lib/**/*.js'], []);

    expect(shouldIncludeFile('src/component.ts', config)).toBe(true);
    expect(shouldIncludeFile('src/component.tsx', config)).toBe(true);
    expect(shouldIncludeFile('lib/util.js', config)).toBe(true);
    expect(shouldIncludeFile('src/component.css', config)).toBe(false);
  });

  it('should handle patterns that previously caused ReDoS', () => {
    // This pattern would cause catastrophic backtracking with hand-rolled regex
    const evilPattern = '**/**/**/**/**/**/**/**/**/**/**/**/**/**/a';
    const config = makeConfig([evilPattern], []);

    const start = Date.now();
    // This should return quickly, not hang
    shouldIncludeFile('x/x/x/x/x/x/x/x/x/x/x/x/x/x/b', config);
    const elapsed = Date.now() - start;

    // Should complete quickly, not hang for seconds.
    expect(elapsed).toBeLessThan(500);
  });

  it('should handle dot files correctly', () => {
    const config = makeConfig(['**/*.ts'], []);

    expect(shouldIncludeFile('.hidden/index.ts', config)).toBe(true);
  });
});

describe('Symlink Cycle Detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should handle symlink cycle without infinite loop', () => {
    // Create directory structure with a symlink cycle
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;\n');

    // Create a symlink from src/loop -> tempDir (parent directory)
    try {
      fs.symlinkSync(tempDir, path.join(srcDir, 'loop'), 'dir');
    } catch {
      // Skip test if symlinks not supported (e.g., Windows without admin)
      return;
    }

    const config: CodeGraphConfig = {
      ...DEFAULT_CONFIG,
      rootDir: tempDir,
      include: ['**/*.ts'],
      exclude: [],
    };

    // This should complete without hanging
    const files = scanDirectory(tempDir, config);

    // Should find the real file but not loop infinitely
    expect(files).toContain('src/index.ts');
    // Should not find duplicates via the symlink path
    const indexFiles = files.filter(f => f.endsWith('index.ts'));
    expect(indexFiles.length).toBe(1);
  });

  it('should follow valid symlinks to directories', () => {
    // Create source directory with a file
    const realDir = path.join(tempDir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'hello.ts'), 'export function hello() {}\n');

    // Create a symlink to realDir
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    try {
      fs.symlinkSync(realDir, path.join(srcDir, 'linked'), 'dir');
    } catch {
      return;
    }

    const config: CodeGraphConfig = {
      ...DEFAULT_CONFIG,
      rootDir: tempDir,
      include: ['**/*.ts'],
      exclude: [],
    };

    const files = scanDirectory(tempDir, config);

    // Should find files from both the real dir and via the symlink
    // But deduplicate since they resolve to the same real path
    expect(files.some(f => f.includes('hello.ts'))).toBe(true);
  });

  it('should skip broken symlinks gracefully', () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'valid.ts'), 'export const y = 2;\n');

    try {
      fs.symlinkSync('/nonexistent/path', path.join(srcDir, 'broken'), 'dir');
    } catch {
      return;
    }

    const config: CodeGraphConfig = {
      ...DEFAULT_CONFIG,
      rootDir: tempDir,
      include: ['**/*.ts'],
      exclude: [],
    };

    // Should not throw
    const files = scanDirectory(tempDir, config);
    expect(files).toContain('src/valid.ts');
  });
});
