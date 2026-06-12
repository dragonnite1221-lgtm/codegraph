import type { Node as SyntaxNode } from 'web-tree-sitter';
import { describe, expect, it } from 'vitest';

import { extractImportDeclarations } from '../src/extraction/import-extraction';
import type { LanguageExtractor } from '../src/extraction/tree-sitter-types';
import type { Language, UnresolvedReference } from '../src/types';

function syntaxNode(
  type: string,
  startIndex: number,
  endIndex: number,
  children: SyntaxNode[] = []
): SyntaxNode {
  return {
    type,
    startIndex,
    endIndex,
    startPosition: { row: 0, column: startIndex },
    namedChildren: children,
    namedChildCount: children.length,
    namedChild: (index: number) => children[index] ?? null,
  } as unknown as SyntaxNode;
}

function extractor(overrides: Partial<LanguageExtractor> = {}): LanguageExtractor {
  return {
    functionTypes: [],
    classTypes: [],
    methodTypes: [],
    interfaceTypes: [],
    structTypes: [],
    enumTypes: [],
    typeAliasTypes: [],
    importTypes: [],
    callTypes: [],
    variableTypes: [],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameters',
    ...overrides,
  };
}

function runImportExtraction(
  language: Language,
  source: string,
  node: SyntaxNode,
  extractorOverrides: Partial<LanguageExtractor> = {},
  parentId = 'file-1'
): { imports: Array<{ moduleName: string; signature: string }>; refs: UnresolvedReference[] } {
  const imports: Array<{ moduleName: string; signature: string }> = [];
  const refs: UnresolvedReference[] = [];
  extractImportDeclarations({
    node,
    source,
    language,
    extractor: extractor(extractorOverrides),
    parentId,
    createImportNode: (moduleName, _node, signature) => imports.push({ moduleName, signature }),
    addReference: (ref) => refs.push(ref),
  });
  return { imports, refs };
}

describe('import extraction helpers', () => {
  it('uses language import hooks and emits unresolved references', () => {
    const source = 'import Foo';
    const node = syntaxNode('import_statement', 0, source.length);

    const { imports, refs } = runImportExtraction('typescript', source, node, {
      extractImport: () => ({ moduleName: 'Foo', signature: source }),
    });

    expect(imports).toEqual([{ moduleName: 'Foo', signature: source }]);
    expect(refs).toMatchObject([
      { fromNodeId: 'file-1', referenceName: 'Foo', referenceKind: 'imports' },
    ]);
  });

  it('extracts Python multi-import statements without hook fallback', () => {
    const source = 'os sys';
    const node = syntaxNode('import_statement', 0, source.length, [
      syntaxNode('dotted_name', 0, 2),
      syntaxNode('aliased_import', 3, 6, [syntaxNode('dotted_name', 3, 6)]),
    ]);

    const { imports } = runImportExtraction('python', source, node, {
      extractImport: () => null,
    });

    expect(imports.map((entry) => entry.moduleName)).toEqual(['os', 'sys']);
  });

  it('extracts Go import specs and creates import references', () => {
    const source = '"fmt" "os"';
    const fmtLiteral = syntaxNode('interpreted_string_literal', 0, 5);
    const osLiteral = syntaxNode('interpreted_string_literal', 6, 10);
    const root = syntaxNode('import_declaration', 0, source.length, [
      syntaxNode('import_spec_list', 0, source.length, [
        syntaxNode('import_spec', 0, 5, [fmtLiteral]),
        syntaxNode('import_spec', 6, 10, [osLiteral]),
      ]),
    ]);

    const { imports, refs } = runImportExtraction('go', source, root);

    expect(imports.map((entry) => entry.moduleName)).toEqual(['fmt', 'os']);
    expect(refs.map((ref) => ref.referenceName)).toEqual(['fmt', 'os']);
  });

  it('extracts PHP grouped imports', () => {
    const source = 'Vendor\\PackageClassOneClassTwo';
    const prefix = syntaxNode('namespace_name', 0, 14);
    const useGroup = syntaxNode('namespace_use_group', 14, source.length, [
      syntaxNode('namespace_use_clause', 14, 22, [syntaxNode('name', 14, 22)]),
      syntaxNode('namespace_use_clause', 22, 30, [syntaxNode('name', 22, 30)]),
    ]);
    const root = syntaxNode('namespace_use_declaration', 0, source.length, [prefix, useGroup]);

    const { imports } = runImportExtraction('php', source, root);

    expect(imports.map((entry) => entry.moduleName)).toEqual([
      'Vendor\\Package\\ClassOne',
      'Vendor\\Package\\ClassTwo',
    ]);
  });

  it('does not create generic fallback when a hook intentionally declines', () => {
    const source = 'unknown import';
    const node = syntaxNode('import_statement', 0, source.length);

    const { imports } = runImportExtraction('ruby', source, node, {
      extractImport: () => null,
    });

    expect(imports).toEqual([]);
  });
});
