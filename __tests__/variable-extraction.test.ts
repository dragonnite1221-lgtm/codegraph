import type { Node as SyntaxNode } from 'web-tree-sitter';
import { describe, expect, it } from 'vitest';

import type { Node } from '../src/types';
import { extractVariableDeclarations } from '../src/extraction/variable-extraction';
import type { LanguageExtractor } from '../src/extraction/tree-sitter-types';

function syntaxNode(
  type: string,
  startIndex: number,
  endIndex: number,
  children: SyntaxNode[] = [],
  fields: Record<string, SyntaxNode> = {}
): SyntaxNode {
  return {
    type,
    startIndex,
    endIndex,
    startPosition: { row: 0, column: startIndex },
    namedChildren: children,
    namedChildCount: children.length,
    namedChild: (index: number) => children[index] ?? null,
    childForFieldName: (fieldName: string) => fields[fieldName] ?? null,
  } as unknown as SyntaxNode;
}

const tsExtractor = {
  isConst: () => true,
  isExported: () => true,
  nameField: 'name',
} as unknown as LanguageExtractor;

describe('variable extraction helpers', () => {
  it('extracts JavaScript-like declarators with initializer signatures', () => {
    const source = 'API_VERSION1';
    const name = syntaxNode('identifier', 0, 11);
    const value = syntaxNode('number', 11, 12);
    const declarator = syntaxNode('variable_declarator', 0, 12, [name, value], {
      name,
      value,
    });
    const declaration = syntaxNode('lexical_declaration', 0, 12, [declarator]);
    const created: Array<{ kind: string; name: string; metadata?: Partial<Node> }> = [];

    extractVariableDeclarations({
      node: declaration,
      source,
      language: 'typescript',
      extractor: tsExtractor,
      createNode: (kind, nodeName, _node, metadata) => {
        created.push({ kind, name: nodeName, metadata });
        return { id: `node:${nodeName}` } as Node;
      },
      extractFunction: () => {
        throw new Error('unexpected function extraction');
      },
      addReference: () => {},
    });

    expect(created).toEqual([
      {
        kind: 'constant',
        name: 'API_VERSION',
        metadata: expect.objectContaining({
          signature: '= 1',
          isExported: true,
        }),
      },
    ]);
  });

  it('skips destructured JavaScript-like declarators', () => {
    const source = '{x}1';
    const name = syntaxNode('object_pattern', 0, 3);
    const value = syntaxNode('number', 3, 4);
    const declarator = syntaxNode('variable_declarator', 0, 4, [name, value], {
      name,
      value,
    });
    const declaration = syntaxNode('lexical_declaration', 0, 4, [declarator]);
    const created: string[] = [];

    extractVariableDeclarations({
      node: declaration,
      source,
      language: 'typescript',
      extractor: tsExtractor,
      createNode: (_kind, nodeName) => {
        created.push(nodeName);
        return null;
      },
      extractFunction: () => {},
      addReference: () => {},
    });

    expect(created).toEqual([]);
  });

  it('delegates arrow function initializers to function extraction', () => {
    const source = 'handler()=>ok';
    const name = syntaxNode('identifier', 0, 7);
    const value = syntaxNode('arrow_function', 7, 13);
    const declarator = syntaxNode('variable_declarator', 0, 13, [name, value], {
      name,
      value,
    });
    const declaration = syntaxNode('lexical_declaration', 0, 13, [declarator]);
    const delegated: SyntaxNode[] = [];

    extractVariableDeclarations({
      node: declaration,
      source,
      language: 'typescript',
      extractor: tsExtractor,
      createNode: () => {
        throw new Error('unexpected variable creation');
      },
      extractFunction: (node) => delegated.push(node),
      addReference: () => {},
    });

    expect(delegated).toEqual([value]);
  });

  it('extracts assignment variables for Python and Ruby', () => {
    const source = 'total42';
    const left = syntaxNode('identifier', 0, 5);
    const right = syntaxNode('integer', 5, 7);
    const assignment = syntaxNode('assignment', 0, 7, [left, right], {
      left,
      right,
    });
    const created: Array<{ kind: string; name: string; metadata?: Partial<Node> }> = [];

    extractVariableDeclarations({
      node: assignment,
      source,
      language: 'python',
      extractor: tsExtractor,
      createNode: (kind, nodeName, _node, metadata) => {
        created.push({ kind, name: nodeName, metadata });
        return null;
      },
      extractFunction: () => {},
      addReference: () => {},
    });

    expect(created).toEqual([
      {
        kind: 'constant',
        name: 'total',
        metadata: expect.objectContaining({ signature: '= 42' }),
      },
    ]);
  });

  it('emits type annotation references for JavaScript-like variables', () => {
    const source = 'svcService';
    const name = syntaxNode('identifier', 0, 3);
    const typeIdentifier = syntaxNode('type_identifier', 3, 10);
    const typeAnnotation = syntaxNode('type_annotation', 3, 10, [typeIdentifier]);
    const declarator = syntaxNode('variable_declarator', 0, 10, [name, typeAnnotation], {
      name,
    });
    const declaration = syntaxNode('lexical_declaration', 0, 10, [declarator]);
    const refs: Array<{ referenceName: string; fromNodeId: string }> = [];

    extractVariableDeclarations({
      node: declaration,
      source,
      language: 'typescript',
      extractor: tsExtractor,
      createNode: (_kind, nodeName) => ({ id: `node:${nodeName}` } as Node),
      extractFunction: () => {},
      addReference: (ref) => refs.push(ref),
    });

    expect(refs).toMatchObject([
      {
        fromNodeId: 'node:svc',
        referenceName: 'Service',
      },
    ]);
  });
});
