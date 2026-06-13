import type { Node as SyntaxNode } from 'web-tree-sitter';
import { describe, expect, it } from 'vitest';

import type { Node } from '../src/types';
import {
  extractEnumMemberNodes,
  extractFieldDeclaration,
  extractPropertyDeclaration,
} from '../src/extraction/member-extraction';
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

const classMemberExtractor = {
  getVisibility: () => 'public',
  isStatic: () => true,
} as unknown as LanguageExtractor;

describe('member extraction helpers', () => {
  it('extracts enum member names from name fields', () => {
    const source = 'Ready';
    const name = syntaxNode('identifier', 0, 5);
    const variant = syntaxNode('enum_variant', 0, 5, [name], { name });
    const created: Array<{ kind: string; name: string }> = [];

    extractEnumMemberNodes(variant, source, (kind, nodeName) => {
      created.push({ kind, name: nodeName });
      return null;
    });

    expect(created).toEqual([{ kind: 'enum_member', name: 'Ready' }]);
  });

  it('extracts class properties and decorator references', () => {
    const source = 'stringName';
    const type = syntaxNode('predefined_type', 0, 6);
    const name = syntaxNode('identifier', 6, 10);
    const property = syntaxNode('property_declaration', 0, 10, [type, name], { name });
    const created: Array<{ kind: string; name: string; metadata?: Partial<Node> }> = [];
    const decorated: string[] = [];

    extractPropertyDeclaration({
      node: property,
      source,
      extractor: classMemberExtractor,
      createNode: (kind, nodeName, _node, metadata) => {
        created.push({ kind, name: nodeName, metadata });
        return { id: `node:${nodeName}` } as Node;
      },
      extractDecoratorsFor: (_node, decoratedId) => decorated.push(decoratedId),
    });

    expect(created).toEqual([
      {
        kind: 'property',
        name: 'Name',
        metadata: expect.objectContaining({
          signature: 'string Name',
          visibility: 'public',
          isStatic: true,
        }),
      },
    ]);
    expect(decorated).toEqual(['node:Name']);
  });

  it('extracts PHP property elements as fields', () => {
    const source = 'stringtitle';
    const type = syntaxNode('primitive_type', 0, 6);
    const name = syntaxNode('name', 6, 11);
    const variableName = syntaxNode('variable_name', 6, 11, [name]);
    const elem = syntaxNode('property_element', 6, 11, [variableName]);
    const declaration = syntaxNode('property_declaration', 0, 11, [type, elem]);
    const created: Array<{ kind: string; name: string; metadata?: Partial<Node> }> = [];

    extractFieldDeclaration({
      node: declaration,
      source,
      extractor: classMemberExtractor,
      createNode: (kind, nodeName, _node, metadata) => {
        created.push({ kind, name: nodeName, metadata });
        return null;
      },
      extractDecoratorsFor: () => {},
    });

    expect(created).toEqual([
      {
        kind: 'field',
        name: 'title',
        metadata: expect.objectContaining({
          signature: 'string $title',
          visibility: 'public',
          isStatic: true,
        }),
      },
    ]);
  });

  it('extracts declarator fields and decorates the outer field declaration', () => {
    const source = 'Stringname';
    const type = syntaxNode('type_identifier', 0, 6);
    const name = syntaxNode('identifier', 6, 10);
    const declarator = syntaxNode('variable_declarator', 6, 10, [name], { name });
    const declaration = syntaxNode('field_declaration', 0, 10, [type, declarator]);
    const created: Array<{ kind: string; name: string; metadata?: Partial<Node> }> = [];
    const decorated: string[] = [];

    extractFieldDeclaration({
      node: declaration,
      source,
      extractor: classMemberExtractor,
      createNode: (kind, nodeName, _node, metadata) => {
        created.push({ kind, name: nodeName, metadata });
        return { id: `node:${nodeName}` } as Node;
      },
      extractDecoratorsFor: (_node, decoratedId) => decorated.push(decoratedId),
    });

    expect(created).toEqual([
      {
        kind: 'field',
        name: 'name',
        metadata: expect.objectContaining({
          signature: 'String name',
          visibility: 'public',
          isStatic: true,
        }),
      },
    ]);
    expect(decorated).toEqual(['node:name']);
  });
});
