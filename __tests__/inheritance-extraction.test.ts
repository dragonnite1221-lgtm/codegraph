import type { Node as SyntaxNode } from 'web-tree-sitter';
import { describe, expect, it } from 'vitest';

import { extractInheritanceReferences } from '../src/extraction/inheritance-extraction';
import type { UnresolvedReference } from '../src/types';

function node(
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

describe('inheritance extraction helpers', () => {
  it('extracts Python superclass argument lists', () => {
    const source = 'Base Mixin';
    const root = node('class_definition', 0, source.length, [
      node('argument_list', 0, source.length, [
        node('identifier', 0, 4),
        node('identifier', 5, 10),
      ]),
    ]);
    const refs: UnresolvedReference[] = [];

    extractInheritanceReferences(root, 'class-1', source, (ref) => refs.push(ref));

    expect(refs.map((ref) => ref.referenceName)).toEqual(['Base', 'Mixin']);
    expect(refs.every((ref) => ref.referenceKind === 'extends')).toBe(true);
  });

  it('extracts implements clauses through type lists', () => {
    const source = 'IFoo IBar';
    const root = node('class_declaration', 0, source.length, [
      node('implements_clause', 0, source.length, [
        node('type_list', 0, source.length, [
          node('type_identifier', 0, 4),
          node('type_identifier', 5, 9),
        ]),
      ]),
    ]);
    const refs: UnresolvedReference[] = [];

    extractInheritanceReferences(root, 'class-1', source, (ref) => refs.push(ref));

    expect(refs.map((ref) => [ref.referenceName, ref.referenceKind])).toEqual([
      ['IFoo', 'implements'],
      ['IBar', 'implements'],
    ]);
  });

  it('recurses into JavaScript class heritage containers', () => {
    const source = 'Parent';
    const root = node('class_declaration', 0, source.length, [
      node('class_heritage', 0, source.length, [
        node('identifier', 0, 6),
      ]),
    ]);
    const refs: UnresolvedReference[] = [];

    extractInheritanceReferences(root, 'class-1', source, (ref) => refs.push(ref));

    expect(refs).toMatchObject([
      { fromNodeId: 'class-1', referenceName: 'Parent', referenceKind: 'extends' },
    ]);
  });
});
