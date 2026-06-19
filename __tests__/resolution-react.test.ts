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

describe('Resolution Module — react', () => {
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

  describe('React Framework Resolver', () => {
    it('should resolve React component references', () => {
      const mockNodes: Node[] = [
        {
          id: 'component:src/Button.tsx:Button:5',
          kind: 'component',
          name: 'Button',
          qualifiedName: 'src/Button.tsx::Button',
          filePath: 'src/Button.tsx',
          language: 'tsx',
          startLine: 5,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: (fp) => (fp === 'src/Button.tsx' ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/Button.tsx', 'src/App.tsx'],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');
      expect(reactResolver).toBeDefined();

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'Button',
        referenceKind: 'renders' as const,
        line: 10,
        column: 5,
        filePath: 'src/App.tsx',
        language: 'typescript' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('component:src/Button.tsx:Button:5');
    });

    it('should resolve custom hook references', () => {
      const mockNodes: Node[] = [
        {
          id: 'hook:src/hooks/useAuth.ts:useAuth:1',
          kind: 'function',
          name: 'useAuth',
          qualifiedName: 'src/hooks/useAuth.ts::useAuth',
          filePath: 'src/hooks/useAuth.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: (fp) => (fp.includes('useAuth') ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/hooks/useAuth.ts'],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'useAuth',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'src/App.tsx',
        language: 'typescript' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('hook:src/hooks/useAuth.ts:useAuth:1');
    });
  });
});
