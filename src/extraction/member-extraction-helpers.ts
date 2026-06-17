/**
 * Member-extraction private helpers split out of member-extraction.ts to keep
 * it within the 200-line limit. No behavior change.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node } from '../types';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { CreateMemberNode, ExtractDecoratorsFor } from './member-extraction';

export function extractPhpPropertyElements(
  node: SyntaxNode,
  source: string,
  context: {
    createNode: CreateMemberNode;
    docstring: string | undefined;
    visibility: Node['visibility'];
    isStatic: boolean;
  }
): boolean {
  const propElements = node.namedChildren.filter(
    (child: SyntaxNode) => child.type === 'property_element'
  );
  if (propElements.length === 0) return false;

  const typeNode = node.namedChildren.find(
    (child: SyntaxNode) =>
      child.type !== 'visibility_modifier' &&
      child.type !== 'static_modifier' &&
      child.type !== 'readonly_modifier' &&
      child.type !== 'property_element' &&
      child.type !== 'var_modifier'
  );
  const typeText = typeNode ? getNodeText(typeNode, source) : undefined;

  for (const elem of propElements) {
    const varName = elem.namedChildren.find(
      (child: SyntaxNode) => child.type === 'variable_name'
    );
    const nameNode = varName?.namedChildren.find(
      (child: SyntaxNode) => child.type === 'name'
    );
    if (!nameNode) continue;

    const name = getNodeText(nameNode, source);
    context.createNode('field', name, elem, {
      docstring: context.docstring,
      signature: typeText ? `${typeText} $${name}` : `$${name}`,
      visibility: context.visibility,
      isStatic: context.isStatic,
    });
  }

  return true;
}

export function extractDeclaratorFields(
  node: SyntaxNode,
  source: string,
  declarators: SyntaxNode[],
  context: {
    createNode: CreateMemberNode;
    extractDecoratorsFor: ExtractDecoratorsFor;
    docstring: string | undefined;
    visibility: Node['visibility'];
    isStatic: boolean;
  }
): void {
  const varDecl = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'variable_declaration'
  );
  const typeSearchNode = varDecl ?? node;
  const typeNode = typeSearchNode.namedChildren.find(
    (child: SyntaxNode) =>
      child.type !== 'modifiers' &&
      child.type !== 'modifier' &&
      child.type !== 'variable_declarator' &&
      child.type !== 'variable_declaration' &&
      child.type !== 'marker_annotation' &&
      child.type !== 'annotation'
  );
  const typeText = typeNode ? getNodeText(typeNode, source) : undefined;

  for (const decl of declarators) {
    const nameNode =
      getChildByField(decl, 'name') ||
      decl.namedChildren.find((child: SyntaxNode) => child.type === 'identifier');
    if (!nameNode) continue;

    const name = getNodeText(nameNode, source);
    const fieldNode = context.createNode('field', name, decl, {
      docstring: context.docstring,
      signature: typeText ? `${typeText} ${name}` : name,
      visibility: context.visibility,
      isStatic: context.isStatic,
    });
    if (fieldNode) context.extractDecoratorsFor(node, fieldNode.id);
  }
}
