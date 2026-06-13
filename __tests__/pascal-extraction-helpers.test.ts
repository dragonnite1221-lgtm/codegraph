import type { Node as SyntaxNode } from 'web-tree-sitter';
import { describe, expect, it } from 'vitest';

import {
  buildPascalMethodIndex,
  extractPascalCallName,
  extractPascalDefProcName,
  extractPascalInheritanceReferences,
  resolvePascalDefProcParentId,
  visitPascalCallExpressions,
} from '../src/extraction/pascal-extraction-helpers';
import type { Node, UnresolvedReference } from '../src/types';

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

function graphNode(overrides: Partial<Node>): Node {
  return {
    id: 'node-1',
    kind: 'method',
    name: 'Create',
    qualifiedName: 'TAuthService::Create',
    filePath: 'src/auth.pas',
    language: 'pascal',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 1,
    ...overrides,
  };
}

describe('Pascal extraction helpers', () => {
  it('indexes Pascal method names and resolves implementation procedures', () => {
    const methodIndex = buildPascalMethodIndex([
      graphNode({ id: 'method-1', qualifiedName: 'Unit1::TAuthService::Create' }),
    ]);
    const source = 'TAuthService.Create';
    const nameNode = syntaxNode('identifier', 0, source.length);
    const declProc = syntaxNode('declProc', 0, source.length, [], { name: nameNode });
    const defProc = syntaxNode('defProc', 0, source.length, [declProc]);

    const procName = extractPascalDefProcName(defProc, source);

    expect(procName).toMatchObject({
      fullName: 'TAuthService.Create',
      fullNameKey: 'tauthservice.create',
      shortNameKey: 'create',
    });
    expect(resolvePascalDefProcParentId(procName!, methodIndex)).toBe('method-1');
  });

  it('extracts Pascal class inheritance references', () => {
    const source = 'TParent ILogger';
    const declClass = syntaxNode('declClass', 0, source.length, [
      syntaxNode('typeref', 0, 7),
      syntaxNode('typeref', 8, 15),
    ]);
    const refs: UnresolvedReference[] = [];

    extractPascalInheritanceReferences(declClass, 'class-1', source, (ref) => refs.push(ref));

    expect(refs.map((ref) => [ref.referenceName, ref.referenceKind])).toEqual([
      ['TParent', 'extends'],
      ['ILogger', 'implements'],
    ]);
  });

  it('extracts direct and qualified Pascal call names while visiting blocks', () => {
    const source = 'WriteLnObj.DoWork';
    const directCall = syntaxNode('exprCall', 0, 7, [
      syntaxNode('identifier', 0, 7),
    ]);
    const dottedCall = syntaxNode('exprCall', 7, source.length, [
      syntaxNode('exprDot', 7, source.length, [
        syntaxNode('identifier', 7, 10),
        syntaxNode('identifier', 11, source.length),
      ]),
    ]);
    const block = syntaxNode('block', 0, source.length, [directCall, dottedCall]);
    const visited: string[] = [];

    visitPascalCallExpressions(block, (callNode) => {
      const name = extractPascalCallName(callNode, source);
      if (name) visited.push(name);
    });

    expect(visited).toEqual(['WriteLn', 'Obj.DoWork']);
  });
});
