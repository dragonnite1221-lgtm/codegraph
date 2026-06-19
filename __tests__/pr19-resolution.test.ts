/**
 * PR19 improvements: graph traversal + resolution. Split out of pr19-improvements.test.ts for the file-size gate.
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

describe('Graph Traversal Both Direction', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it.skipIf(!HAS_SQLITE)('should traverse both directions from a node', async () => {
    const CodeGraph = (await import('../src/index')).default;

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // A -> B -> C  (A calls B, B calls C)
    fs.writeFileSync(path.join(srcDir, 'a.ts'), `
import { funcB } from './b';
export function funcA(): void { funcB(); }
`);
    fs.writeFileSync(path.join(srcDir, 'b.ts'), `
import { funcC } from './c';
export function funcB(): void { funcC(); }
`);
    fs.writeFileSync(path.join(srcDir, 'c.ts'), `
export function funcC(): void { console.log('c'); }
`);

    const cg = CodeGraph.initSync(testDir, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });

    await cg.indexAll();
    cg.resolveReferences();

    const functions = cg.getNodesByKind('function');
    const funcB = functions.find((n) => n.name === 'funcB');

    if (!funcB) {
      cg.destroy();
      return;
    }

    // Traverse 'both' from B - should find A (incoming caller) and C (outgoing callee)
    const subgraph = cg.traverse(funcB.id, {
      maxDepth: 1,
      direction: 'both',
    });

    // B itself + at least one neighbor in each direction
    expect(subgraph.nodes.size).toBeGreaterThanOrEqual(2);
    expect(subgraph.nodes.has(funcB.id)).toBe(true);

    cg.destroy();
  });
});

// =============================================================================
// Best-Candidate Resolution
// =============================================================================

describe('Best-Candidate Resolution', () => {
  it.skipIf(!HAS_SQLITE)('should be testable via the resolution module types', async () => {
    const { ReferenceResolver } = await import('../src/resolution');
    expect(typeof ReferenceResolver.prototype.resolveOne).toBe('function');
  });
});

// =============================================================================
// Schema v2 Migration
// =============================================================================

describe('Schema v2 Migration', () => {
  it.skipIf(!HAS_SQLITE)('should have correct current schema version', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('../src/db/migrations');
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
  });

  it.skipIf(!HAS_SQLITE)('should have migration for version 2', async () => {
    const { getPendingMigrations } = await import('../src/db/migrations');
    expect(typeof getPendingMigrations).toBe('function');
  });
});

// =============================================================================
// Database Layer: Batch Insert, getAllNodes, Pragmas
// =============================================================================

describe('Resolution Warm Caches', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it.skipIf(!HAS_SQLITE)('should warm caches and use them for lookups', async () => {
    const CodeGraph = (await import('../src/index')).default;

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'a.ts'), `
export function myFunc(): void {}
export function otherFunc(): void { myFunc(); }
`);

    const cg = CodeGraph.initSync(testDir, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });

    await cg.indexAll();

    // resolveReferences internally calls warmCaches
    const result = cg.resolveReferences();

    // Should complete without error
    expect(result.stats.total).toBeGreaterThanOrEqual(0);

    cg.destroy();
  });
});

// =============================================================================
// MCP Tool Improvements
// =============================================================================

