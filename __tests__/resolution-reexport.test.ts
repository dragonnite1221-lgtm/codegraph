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

describe('Resolution Module — re-export', () => {
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

  describe('re-export chain following', () => {
    it('chases a 3-hop barrel chain (wildcard → named → declaration)', async () => {
      // main.ts → all.ts (wildcard) → index.ts (named) → auth.ts (declaration).
      // Without chain following, `signIn` resolves to nothing because
      // none of the barrel files declare it directly.
      fs.mkdirSync(path.join(tempDir, 'src/services'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/services/auth.ts'),
        `export function signIn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/services/index.ts'),
        `export { signIn } from './auth';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/all.ts'),
        `export * from './services/index';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { signIn } from './all';\nexport function go(): void { signIn(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const signInNode = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'signIn' && n.filePath === 'src/services/auth.ts');
      expect(signInNode).toBeDefined();
      const callers = cg.getCallers(signInNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    });

    it('follows a renamed named re-export (export { foo as bar } from ...)', async () => {
      // The chase has to look up `foo` in the upstream module even
      // though the importer asked for `bar` — exercises the rename
      // branch of findExportedSymbol.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/auth.ts'),
        `export function signIn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/index.ts'),
        `export { signIn as login } from './auth';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { login } from './index';\nexport function go(): void { login(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const signInNode = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'signIn' && n.filePath === 'src/auth.ts');
      expect(signInNode).toBeDefined();
      const callers = cg.getCallers(signInNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    });
  });
});
