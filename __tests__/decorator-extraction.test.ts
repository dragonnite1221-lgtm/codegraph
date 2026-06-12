import type { Node as SyntaxNode } from 'web-tree-sitter';
import { describe, expect, it } from 'vitest';

import { extractDecoratorReferences } from '../src/extraction/decorator-extraction';
import type { UnresolvedReference } from '../src/types';

type FakeNode = SyntaxNode & {
  parent?: SyntaxNode | null;
};

function node(
  type: string,
  startIndex: number,
  endIndex: number,
  children: FakeNode[] = [],
  fields: Record<string, FakeNode> = {}
): FakeNode {
  const fake = {
    type,
    startIndex,
    endIndex,
    startPosition: { row: 0, column: startIndex },
    namedChildren: children,
    namedChildCount: children.length,
    namedChild: (index: number) => children[index] ?? null,
    childForFieldName: (fieldName: string) => fields[fieldName] ?? null,
    parent: null,
  } as unknown as FakeNode;
  for (const child of children) {
    child.parent = fake;
  }
  return fake;
}

describe('decorator extraction helpers', () => {
  it('extracts direct declaration decorators', () => {
    const source = 'auth.Controller';
    const identifier = node('member_expression', 0, source.length);
    const call = node('call_expression', 0, source.length, [identifier], { function: identifier });
    const decorator = node('decorator', 0, source.length, [call]);
    const decl = node('method_definition', 0, source.length, [decorator]);
    const refs: UnresolvedReference[] = [];

    extractDecoratorReferences(decl, 'method-1', source, (ref) => refs.push(ref));

    expect(refs).toMatchObject([
      { fromNodeId: 'method-1', referenceName: 'Controller', referenceKind: 'decorates' },
    ]);
  });

  it('extracts immediately preceding decorator siblings', () => {
    const source = 'ABClass';
    const decoratorA = node('decorator', 0, 1, [node('identifier', 0, 1)]);
    const decoratorB = node('decorator', 1, 2, [node('identifier', 1, 2)]);
    const decl = node('class_declaration', 2, 7);
    node('export_statement', 0, 7, [decoratorA, decoratorB, decl]);
    const refs: UnresolvedReference[] = [];

    extractDecoratorReferences(decl, 'class-1', source, (ref) => refs.push(ref));

    expect(refs.map((ref) => ref.referenceName)).toEqual(['B', 'A']);
  });

  it('stops sibling scanning at the first non-decorator separator', () => {
    const source = 'ABClass';
    const decoratorA = node('decorator', 0, 1, [node('identifier', 0, 1)]);
    const separator = node('lexical_declaration', 1, 2);
    const decoratorB = node('decorator', 1, 2, [node('identifier', 1, 2)]);
    const decl = node('class_declaration', 2, 7);
    node('program', 0, 7, [decoratorA, separator, decoratorB, decl]);
    const refs: UnresolvedReference[] = [];

    extractDecoratorReferences(decl, 'class-1', source, (ref) => refs.push(ref));

    expect(refs.map((ref) => ref.referenceName)).toEqual(['B']);
  });
});
