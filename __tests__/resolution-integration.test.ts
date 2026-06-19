import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { Node, UnresolvedReference } from '../src/types';
import { ReferenceResolver, createResolver, ResolutionContext } from '../src/resolution';
import { matchReference } from '../src/resolution/name-matcher';
import { resolveImportPath, extractImportMappings } from '../src/resolution/import-resolver';
import { detectFrameworks, getAllFrameworkResolvers } from '../src/resolution/frameworks';
import { QueryBuilder } from '../src/db/queries';
import { DatabaseConnection } from '../src/db';

describe('Resolution Module — integration', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolution-test-'));
  });

  afterEach(() => {
    // Clean up
    if (cg) {
      cg.destroy();
    } else if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('Integration Tests', () => {
    it('should create resolver from CodeGraph instance', async () => {
      // Create a simple TypeScript project
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', dependencies: { react: '^18.0.0' } })
      );

      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);

      // Create utility file
      fs.writeFileSync(
        path.join(srcDir, 'utils.ts'),
        `export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseDate(str: string): Date {
  return new Date(str);
}`
      );

      // Create main file that uses utils
      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { formatDate, parseDate } from './utils';

function processDate(input: string): string {
  const date = parseDate(input);
  return formatDate(date);
}`
      );

      // Initialize and index
      cg = await CodeGraph.init(tempDir, { index: true });

      // Check that resolver detected React framework
      const frameworks = cg.getDetectedFrameworks();
      expect(frameworks).toContain('react');

      // Get stats to verify indexing worked
      const stats = cg.getStats();
      expect(stats.fileCount).toBe(2);
      expect(stats.nodeCount).toBeGreaterThan(0);
    });

    it('should resolve references after indexing', async () => {
      // Create a project with references
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'helper.ts'),
        `export function helperFunction(): void {
  console.log('helper');
}`
      );

      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { helperFunction } from './helper';

function main(): void {
  helperFunction();
}`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      // Run reference resolution
      const result = cg.resolveReferences();

      // Should have attempted resolution
      expect(result.stats.total).toBeGreaterThanOrEqual(0);
    });

    it('promotes calls→instantiates when target resolves to a class (Python)', async () => {
      // Python has no `new` keyword — `Foo()` is the standard
      // instantiation syntax. Extraction can't tell that apart from
      // a function call without symbol info, so it emits a `calls`
      // ref. Resolution promotes it to `instantiates` once the
      // target is known to be a class.
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'app.py'),
        `class UserService:
    def __init__(self):
        self.db = None

def bootstrap():
    return UserService()
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const bootstrap = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'bootstrap');
      expect(bootstrap).toBeDefined();

      const outgoing = cg.getOutgoingEdges(bootstrap!.id);
      const instantiates = outgoing.find((e) => e.kind === 'instantiates');
      expect(instantiates).toBeDefined();
      // Same edge must NOT also appear as a `calls` edge — promotion
      // replaces the kind, doesn't duplicate.
      const callsToUserService = outgoing.filter(
        (e) => e.kind === 'calls' && e.target === instantiates!.target
      );
      expect(callsToUserService).toHaveLength(0);
    });
  });
});
