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

describe('Resolution Module — aliases', () => {
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

  describe('Name Matcher: kind bias for new ref kinds', () => {
    const baseContext = (candidates: Node[]): ResolutionContext => ({
      getNodesInFile: () => [],
      getNodesByName: (name) => candidates.filter((c) => c.name === name),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => true,
      readFile: () => null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    });

    it('prefers a class candidate over a function for `instantiates` refs', () => {
      // A class and a function share a name across the codebase.
      // Without the kind bias, the function (which gets the +25 `calls`
      // bonus historically applied to all candidates of that kind) would
      // win. Now the instantiates branch reverses it.
      const fn: Node = {
        id: 'func:utils.ts:Logger:5', kind: 'function', name: 'Logger',
        qualifiedName: 'utils.ts::Logger', filePath: 'utils.ts', language: 'typescript',
        startLine: 5, endLine: 7, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const cls: Node = {
        id: 'class:logger.ts:Logger:10', kind: 'class', name: 'Logger',
        qualifiedName: 'logger.ts::Logger', filePath: 'logger.ts', language: 'typescript',
        startLine: 10, endLine: 30, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };

      const ref = {
        fromNodeId: 'func:main.ts:bootstrap:1',
        referenceName: 'Logger',
        referenceKind: 'instantiates' as const,
        line: 5, column: 0, filePath: 'main.ts', language: 'typescript' as const,
      };

      const result = matchReference(ref, baseContext([fn, cls]));
      expect(result?.targetNodeId).toBe('class:logger.ts:Logger:10');
    });

    it('prefers a function candidate over a non-function for `decorates` refs', () => {
      const variable: Node = {
        id: 'var:config.ts:Inject:5', kind: 'variable', name: 'Inject',
        qualifiedName: 'config.ts::Inject', filePath: 'config.ts', language: 'typescript',
        startLine: 5, endLine: 5, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const decorator: Node = {
        id: 'func:di.ts:Inject:10', kind: 'function', name: 'Inject',
        qualifiedName: 'di.ts::Inject', filePath: 'di.ts', language: 'typescript',
        startLine: 10, endLine: 20, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };

      const ref = {
        fromNodeId: 'class:svc.ts:UserService:1',
        referenceName: 'Inject',
        referenceKind: 'decorates' as const,
        line: 5, column: 0, filePath: 'svc.ts', language: 'typescript' as const,
      };

      const result = matchReference(ref, baseContext([variable, decorator]));
      expect(result?.targetNodeId).toBe('func:di.ts:Inject:10');
    });
  });

  describe('tsconfig path aliases', () => {
    it('resolves an aliased import to the alias-mapped file (not a same-named file elsewhere)', async () => {
      // Two same-named exports in different directories. Without alias
      // resolution, name-matcher would pick whichever it finds first;
      // with alias resolution, the import path uniquely picks one.
      fs.mkdirSync(path.join(tempDir, 'src/utils'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'src/legacy'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/utils/format.ts'),
        `export function pickMe(): number { return 1; }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/legacy/format.ts'),
        `export function pickMe(): number { return 99; }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { pickMe } from '@utils/format';\nexport function go(): number { return pickMe(); }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: './src',
            paths: { '@utils/*': ['utils/*'] },
          },
        })
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      // The two pickMe nodes live in different files. The aliased
      // import should attach the call edge to the @utils-mapped one,
      // not the legacy duplicate.
      const all = cg.getNodesByKind('function').filter((n) => n.name === 'pickMe');
      const utilsNode = all.find((n) => n.filePath === 'src/utils/format.ts');
      const legacyNode = all.find((n) => n.filePath === 'src/legacy/format.ts');
      expect(utilsNode).toBeDefined();
      expect(legacyNode).toBeDefined();

      const utilsCallers = cg.getCallers(utilsNode!.id);
      const legacyCallers = cg.getCallers(legacyNode!.id);
      expect(utilsCallers.length).toBeGreaterThan(0);
      expect(utilsCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
      // The legacy node should NOT have a caller from src/main.ts —
      // the alias correctly picked the utils version.
      expect(legacyCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(false);
    });

    it('falls back gracefully when tsconfig is absent', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/a.ts'),
        `export function aFn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/b.ts'),
        `import { aFn } from './a';\nexport function bFn(): void { aFn(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      // No tsconfig present — index should still complete and the
      // relative-import-based call edge should be created.
      const aFn = cg.getNodesByKind('function').find((n) => n.name === 'aFn');
      expect(aFn).toBeDefined();
      const callers = cg.getCallers(aFn!.id);
      expect(callers.some((c) => c.node.filePath === 'src/b.ts')).toBe(true);
    });
  });
});
