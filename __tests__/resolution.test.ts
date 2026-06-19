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

describe('Resolution Module', () => {
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

  describe('Name Matcher', () => {
    it('should match exact name references', () => {
      // Create a mock context
      const mockNodes: Node[] = [
        {
          id: 'func:test.ts:myFunction:10',
          kind: 'function',
          name: 'myFunction',
          qualifiedName: 'test.ts::myFunction',
          filePath: 'test.ts',
          language: 'typescript',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: () => mockNodes,
        getNodesByName: (name) => mockNodes.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['test.ts'],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:caller:5',
        referenceName: 'myFunction',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:test.ts:myFunction:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

    it('should prefer same-module candidates over cross-module matches', () => {
      // Simulates a Python monorepo where multiple apps define navigate()
      const candidateA: Node = {
        id: 'func:apps/app_a/src/server.py:navigate:10',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_a/src/server.py::navigate',
        filePath: 'apps/app_a/src/server.py',
        language: 'python',
        startLine: 10,
        endLine: 20,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const candidateB: Node = {
        id: 'func:apps/app_b/src/server.py:navigate:15',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_b/src/server.py::navigate',
        filePath: 'apps/app_b/src/server.py',
        language: 'python',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => name === 'navigate' ? [candidateA, candidateB] : [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a should resolve to app_a's navigate, not app_b's
      const ref = {
        fromNodeId: 'func:apps/app_a/src/handler.py:handler:5',
        referenceName: 'navigate',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'apps/app_a/src/handler.py',
        language: 'python' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:apps/app_a/src/server.py:navigate:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

  });
});
