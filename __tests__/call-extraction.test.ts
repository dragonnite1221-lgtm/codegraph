import type { Node as SyntaxNode } from 'web-tree-sitter';
import { describe, expect, it } from 'vitest';

import { extractCallName, extractCallReference } from '../src/extraction/call-extraction';

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

describe('call extraction helpers', () => {
  it('extracts explicit receiver method calls and strips PHP variable prefixes', () => {
    const source = '$svcrun';
    const object = syntaxNode('variable_name', 0, 4);
    const name = syntaxNode('name', 4, 7);
    const call = syntaxNode('member_call_expression', 0, 7, [], { object, name });

    expect(extractCallName(call, source)).toBe('svc.run');
  });

  it('skips self-like explicit receivers', () => {
    const source = 'thissave';
    const object = syntaxNode('identifier', 0, 4);
    const name = syntaxNode('identifier', 4, 8);
    const call = syntaxNode('method_invocation', 0, 8, [], { object, name });

    expect(extractCallName(call, source)).toBe('save');
  });

  it('extracts member expressions with receiver qualification', () => {
    const source = 'console.log';
    const receiver = syntaxNode('identifier', 0, 7);
    const property = syntaxNode('property_identifier', 8, 11);
    const member = syntaxNode('member_expression', 0, 11, [receiver, property], {
      object: receiver,
      property,
    });
    const call = syntaxNode('call_expression', 0, 11, [member], { function: member });

    expect(extractCallName(call, source)).toBe('console.log');
  });

  it('drops self-like member receivers', () => {
    const source = 'this.save';
    const receiver = syntaxNode('identifier', 0, 4);
    const property = syntaxNode('property_identifier', 5, 9);
    const member = syntaxNode('member_expression', 0, 9, [receiver, property], {
      object: receiver,
      property,
    });
    const call = syntaxNode('call_expression', 0, 9, [member], { function: member });

    expect(extractCallName(call, source)).toBe('save');
  });

  it('creates call references with source position', () => {
    const source = 'build';
    const fn = syntaxNode('identifier', 0, 5);
    const call = syntaxNode('call_expression', 0, 5, [fn], { function: fn });

    expect(extractCallReference(call, source, 'caller-1')).toMatchObject({
      fromNodeId: 'caller-1',
      referenceName: 'build',
      referenceKind: 'calls',
      line: 1,
      column: 0,
    });
  });
});
