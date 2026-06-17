import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { Node, NodeKind } from '../types';
import { getChildByField, getNodeText, getPrecedingDocstring } from './tree-sitter-helpers';
import type { LanguageExtractor } from './tree-sitter-types';
import { extractPhpPropertyElements, extractDeclaratorFields } from './member-extraction-helpers';

export type CreateMemberNode = (
  kind: NodeKind,
  name: string,
  node: SyntaxNode,
  metadata?: Partial<Node>
) => Node | null;

export type ExtractDecoratorsFor = (declNode: SyntaxNode, decoratedId: string) => void;

interface ExtractClassMemberOptions {
  node: SyntaxNode;
  source: string;
  extractor: LanguageExtractor;
  createNode: CreateMemberNode;
  extractDecoratorsFor: ExtractDecoratorsFor;
}

export function extractEnumMemberNodes(
  node: SyntaxNode,
  source: string,
  createNode: CreateMemberNode
): void {
  const nameNode = getChildByField(node, 'name');
  if (nameNode) {
    createNode('enum_member', getNodeText(nameNode, source), node);
    return;
  }

  let found = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'simple_identifier' ||
        child.type === 'identifier' ||
        child.type === 'property_identifier')
    ) {
      createNode('enum_member', getNodeText(child, source), child);
      found = true;
    }
  }

  if (!found && node.namedChildCount === 0) {
    createNode('enum_member', getNodeText(node, source), node);
  }
}

export function extractPropertyDeclaration({
  node,
  source,
  extractor,
  createNode,
  extractDecoratorsFor,
}: ExtractClassMemberOptions): void {
  const docstring = getPrecedingDocstring(node, source);
  const visibility = extractor.getVisibility?.(node);
  const isStatic = extractor.isStatic?.(node) ?? false;

  const nameNode =
    getChildByField(node, 'name') ||
    node.namedChildren.find((child: SyntaxNode) => child.type === 'identifier');
  if (!nameNode) return;

  const name = getNodeText(nameNode, source);
  const typeNode = node.namedChildren.find(
    (child: SyntaxNode) =>
      child.type !== 'modifier' &&
      child.type !== 'modifiers' &&
      child.type !== 'identifier' &&
      child.type !== 'accessor_list' &&
      child.type !== 'accessors' &&
      child.type !== 'equals_value_clause'
  );
  const typeText = typeNode ? getNodeText(typeNode, source) : undefined;
  const signature = typeText ? `${typeText} ${name}` : name;

  const propertyNode = createNode('property', name, node, {
    docstring,
    signature,
    visibility,
    isStatic,
  });

  if (propertyNode) {
    extractDecoratorsFor(node, propertyNode.id);
  }
}

export function extractFieldDeclaration({
  node,
  source,
  extractor,
  createNode,
  extractDecoratorsFor,
}: ExtractClassMemberOptions): void {
  const docstring = getPrecedingDocstring(node, source);
  const visibility = extractor.getVisibility?.(node);
  const isStatic = extractor.isStatic?.(node) ?? false;

  let declarators = node.namedChildren.filter(
    (child: SyntaxNode) => child.type === 'variable_declarator'
  );

  if (declarators.length === 0) {
    const varDecl = node.namedChildren.find(
      (child: SyntaxNode) => child.type === 'variable_declaration'
    );
    if (varDecl) {
      declarators = varDecl.namedChildren.filter(
        (child: SyntaxNode) => child.type === 'variable_declarator'
      );
    }
  }

  if (declarators.length === 0 && extractPhpPropertyElements(node, source, {
    createNode,
    docstring,
    visibility,
    isStatic,
  })) {
    return;
  }

  if (declarators.length > 0) {
    extractDeclaratorFields(node, source, declarators, {
      createNode,
      extractDecoratorsFor,
      docstring,
      visibility,
      isStatic,
    });
    return;
  }

  const nameNode =
    getChildByField(node, 'name') ||
    node.namedChildren.find((child: SyntaxNode) => child.type === 'identifier');
  if (nameNode) {
    createNode('field', getNodeText(nameNode, source), node, {
      docstring,
      visibility,
      isStatic,
    });
  }
}

