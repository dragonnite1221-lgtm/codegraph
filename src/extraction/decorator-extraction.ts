import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { UnresolvedReference } from '../types';
import { getChildByField, getNodeText } from './tree-sitter-helpers';

type AddReference = (ref: UnresolvedReference) => void;

function isDecoratorNode(node: SyntaxNode): boolean {
  return (
    node.type === 'decorator' ||
    node.type === 'annotation' ||
    node.type === 'marker_annotation'
  );
}

function normalizeDecoratorTargetName(rawName: string): string {
  let name = rawName;
  const lastDot = Math.max(name.lastIndexOf('.'), name.lastIndexOf('::'));
  if (lastDot >= 0) name = name.slice(lastDot + 1).replace(/^[:.]/, '');
  return name;
}

function extractDecoratorTarget(node: SyntaxNode, source: string): string | undefined {
  let target: SyntaxNode | null = null;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'call_expression') {
      const fn = getChildByField(child, 'function') ?? child.namedChild(0);
      if (fn) target = fn;
      if (target) break;
    }
    if (
      child.type === 'identifier' ||
      child.type === 'member_expression' ||
      child.type === 'scoped_identifier' ||
      child.type === 'navigation_expression'
    ) {
      target = child;
      break;
    }
  }

  if (!target) return undefined;
  const name = normalizeDecoratorTargetName(getNodeText(target, source));
  return name || undefined;
}

function emitDecoratorReference(
  node: SyntaxNode | null,
  decoratedId: string,
  source: string,
  addReference: AddReference
): void {
  if (!node || !isDecoratorNode(node)) return;

  const name = extractDecoratorTarget(node, source);
  if (!name) return;

  addReference({
    fromNodeId: decoratedId,
    referenceName: name,
    referenceKind: 'decorates',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * Scan a declaration node and its immediately preceding decorator siblings.
 */
export function extractDecoratorReferences(
  declNode: SyntaxNode,
  decoratedId: string,
  source: string,
  addReference: AddReference
): void {
  for (let i = 0; i < declNode.namedChildCount; i++) {
    emitDecoratorReference(declNode.namedChild(i), decoratedId, source, addReference);
  }

  const parent = declNode.parent;
  if (!parent) return;

  const declStart = declNode.startIndex;
  let declIdx = -1;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const sibling = parent.namedChild(i);
    if (sibling && sibling.startIndex === declStart) {
      declIdx = i;
      break;
    }
  }
  if (declIdx <= 0) return;

  for (let j = declIdx - 1; j >= 0; j--) {
    const sibling = parent.namedChild(j);
    if (!sibling) continue;
    if (!isDecoratorNode(sibling)) {
      break;
    }
    emitDecoratorReference(sibling, decoratedId, source, addReference);
  }
}
