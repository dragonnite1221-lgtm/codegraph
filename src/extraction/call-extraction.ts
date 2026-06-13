import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { UnresolvedReference } from '../types';
import { getChildByField, getNodeText } from './tree-sitter-helpers';

const EXPLICIT_RECEIVER_CALL_TYPES = new Set([
  'method_invocation',
  'member_call_expression',
  'scoped_call_expression',
]);

const EXPLICIT_RECEIVER_SKIP_NAMES = new Set([
  'self',
  'this',
  'cls',
  'super',
  'parent',
  'static',
]);

const MEMBER_RECEIVER_SKIP_NAMES = new Set(['self', 'this', 'cls', 'super']);

const MEMBER_EXPRESSION_TYPES = new Set([
  'member_expression',
  'attribute',
  'selector_expression',
  'navigation_expression',
]);

function extractMemberCallName(node: SyntaxNode, source: string): string | undefined {
  let property = getChildByField(node, 'property') || getChildByField(node, 'field');
  if (!property) {
    const child1 = node.namedChild(1);
    if (child1?.type === 'navigation_suffix') {
      property = child1.namedChildren.find(
        (child: SyntaxNode) => child.type === 'simple_identifier'
      ) ?? child1;
    } else {
      property = child1;
    }
  }
  if (!property) return undefined;

  const methodName = getNodeText(property, source);
  const receiver =
    getChildByField(node, 'object') ||
    getChildByField(node, 'operand') ||
    node.namedChild(0);
  if (receiver && (receiver.type === 'identifier' || receiver.type === 'simple_identifier')) {
    const receiverName = getNodeText(receiver, source);
    return MEMBER_RECEIVER_SKIP_NAMES.has(receiverName)
      ? methodName
      : `${receiverName}.${methodName}`;
  }

  return methodName;
}

export function extractCallName(node: SyntaxNode, source: string): string | undefined {
  const nameField = getChildByField(node, 'name');
  const objectField = getChildByField(node, 'object') || getChildByField(node, 'scope');

  if (nameField && objectField && EXPLICIT_RECEIVER_CALL_TYPES.has(node.type)) {
    const methodName = getNodeText(nameField, source);
    let receiverName = getNodeText(objectField, source);
    receiverName = receiverName.replace(/^\$/, '');
    if (!methodName) return undefined;
    return EXPLICIT_RECEIVER_SKIP_NAMES.has(receiverName)
      ? methodName
      : `${receiverName}.${methodName}`;
  }

  const func = getChildByField(node, 'function') || node.namedChild(0);
  if (!func) return undefined;

  if (MEMBER_EXPRESSION_TYPES.has(func.type)) {
    return extractMemberCallName(func, source);
  }

  if (func.type === 'scoped_identifier' || func.type === 'scoped_call_expression') {
    return getNodeText(func, source);
  }

  return getNodeText(func, source);
}

export function extractCallReference(
  node: SyntaxNode,
  source: string,
  fromNodeId: string
): UnresolvedReference | undefined {
  const calleeName = extractCallName(node, source);
  if (!calleeName) return undefined;

  return {
    fromNodeId,
    referenceName: calleeName,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  };
}
