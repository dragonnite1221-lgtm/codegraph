/**
 * PR19 improvements: CLI uninit + tree-sitter WASM + Float32Array. Split out of pr19-improvements.test.ts for the file-size gate.
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

describe('CLI uninit', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it.skipIf(!HAS_SQLITE)('should uninitialize a project via CodeGraph.uninitialize()', async () => {
    const CodeGraph = (await import('../src/index')).default;

    // Initialize
    const cg = CodeGraph.initSync(testDir);
    expect(CodeGraph.isInitialized(testDir)).toBe(true);

    // Uninitialize
    cg.uninitialize();

    // .codegraph directory should be removed
    expect(CodeGraph.isInitialized(testDir)).toBe(false);
  });
});

// =============================================================================
// Tree-sitter Version Pinning
// =============================================================================

describe('Tree-sitter WASM Setup', () => {
  it('should use web-tree-sitter and tree-sitter-wasms in dependencies', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    expect(pkg.dependencies['web-tree-sitter']).toBeDefined();
    expect(pkg.dependencies['tree-sitter-wasms']).toBeDefined();
  });

  it('should not have native tree-sitter in dependencies', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    expect(pkg.dependencies['tree-sitter']).toBeUndefined();
    expect(pkg.overrides).toBeUndefined();
  });
});

// =============================================================================
// Embedder Float32Array Fix
// =============================================================================

describe('Float32Array Fix', () => {
  it('should correctly convert typed arrays (regression check)', () => {
    // Simulates the fix: Float32Array.from(Array.from(arr)) vs new Float32Array(arr.length)
    const source = new Float64Array([1.5, 2.5, 3.5, 4.5]);

    // The OLD buggy approach:
    const buggy = new Float32Array(source.length);
    // buggy is all zeros!
    expect(buggy[0]).toBe(0);
    expect(buggy[1]).toBe(0);

    // The NEW fixed approach:
    const fixed = Float32Array.from(Array.from(source));
    expect(fixed[0]).toBeCloseTo(1.5);
    expect(fixed[1]).toBeCloseTo(2.5);
    expect(fixed[2]).toBeCloseTo(3.5);
    expect(fixed[3]).toBeCloseTo(4.5);
  });
});
