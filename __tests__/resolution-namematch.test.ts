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

describe('Resolution Module — name matcher cont.', () => {
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

  describe('Name Matcher (cont.)', () => {
    it('should lower confidence for cross-module exact matches', () => {
      // Only one candidate but in a completely different module
      const candidates: Node[] = [
        {
          id: 'func:apps/app_b/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_b/src/server.py::navigate',
          filePath: 'apps/app_b/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
        {
          id: 'func:apps/app_c/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_c/src/server.py::navigate',
          filePath: 'apps/app_c/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => name === 'navigate' ? candidates : [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a — neither candidate is in the same module
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

      // Should still resolve but with low confidence
      expect(result).not.toBeNull();
      expect(result?.confidence).toBeLessThanOrEqual(0.4);
    });

    it('should match qualified name references', () => {
      const mockClassNode: Node = {
        id: 'class:user.ts:User:5',
        kind: 'class',
        name: 'User',
        qualifiedName: 'user.ts::User',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 5,
        endLine: 30,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const mockMethodNode: Node = {
        id: 'method:user.ts:User.save:15',
        kind: 'method',
        name: 'save',
        qualifiedName: 'user.ts::User::save',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        getNodesInFile: (fp) => fp === 'user.ts' ? [mockClassNode, mockMethodNode] : [],
        getNodesByName: (name) => {
          if (name === 'User') return [mockClassNode];
          if (name === 'save') return [mockMethodNode];
          return [];
        },
        getNodesByQualifiedName: (qn) => {
          if (qn === 'user.ts::User::save') return [mockMethodNode];
          return [];
        },
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['user.ts'],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:main:5',
        referenceName: 'User.save',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('method:user.ts:User.save:15');
    });
  });
});
