import type { Node as SyntaxNode } from 'web-tree-sitter';
import { describe, expect, it } from 'vitest';

import {
  extractTypeRefsFromSubtree,
  supportsTypeAnnotations,
} from '../src/extraction/type-reference-extraction';
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

describe('type reference extraction helpers', () => {
  it('reports supported type-annotation languages', () => {
    expect(supportsTypeAnnotations('typescript')).toBe(true);
    expect(supportsTypeAnnotations('rust')).toBe(true);
    expect(supportsTypeAnnotations('python')).toBe(false);
  });

  it('extracts custom type identifiers while ignoring built-ins', () => {
    const source = 'User string Account';
    const root = node('union_type', 0, source.length, [
      node('type_identifier', 0, 4),
      node('type_identifier', 5, 11),
      node('type_identifier', 12, 19),
    ]);
    const refs: UnresolvedReference[] = [];

    extractTypeRefsFromSubtree(root, source, 'node-1', (ref) => refs.push(ref));

    expect(refs.map((ref) => ref.referenceName)).toEqual(['User', 'Account']);
    expect(refs).toMatchObject([
      { fromNodeId: 'node-1', referenceKind: 'references', line: 1, column: 0 },
      { fromNodeId: 'node-1', referenceKind: 'references', line: 1, column: 12 },
    ]);
  });
});
