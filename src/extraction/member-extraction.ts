import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { Node, NodeKind } from '../types';
import { getChildByField, getNodeText, getPrecedingDocstring } from './tree-sitter-helpers';
import type { LanguageExtractor } from './tree-sitter-types';

type CreateMemberNode = (
  kind: NodeKind,
  name: string,
  node: SyntaxNode,
  metadata?: Partial<Node>
) => Node | null;

type ExtractDecoratorsFor = (declNode: SyntaxNode, decoratedId: string) => void;

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

function extractPhpPropertyElements(
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

function extractDeclaratorFields(
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
