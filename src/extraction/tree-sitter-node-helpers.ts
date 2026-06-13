import type { Node as SyntaxNode } from 'web-tree-sitter';

import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { LanguageExtractor } from './tree-sitter-types';

/**
 * Extract the name from a node based on language.
 */
export function extractName(
  node: SyntaxNode,
  source: string,
  extractor: LanguageExtractor
): string {
  // Try field name first
  const nameNode = getChildByField(node, extractor.nameField);
  if (nameNode) {
    // Unwrap pointer_declarator(s) for C/C++ pointer return types
    let resolved = nameNode;
    while (resolved.type === 'pointer_declarator') {
      const inner = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      if (!inner) break;
      resolved = inner;
    }
    // Handle complex declarators (C/C++)
    if (resolved.type === 'function_declarator' || resolved.type === 'declarator') {
      const innerName = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      return innerName ? getNodeText(innerName, source) : getNodeText(resolved, source);
    }
    return getNodeText(resolved, source);
  }

  // For Dart method_signature, look inside inner signature types
  if (node.type === 'method_signature') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (
        child.type === 'function_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'factory_constructor_signature'
      )) {
        // Find identifier inside the inner signature
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (inner?.type === 'identifier') {
            return getNodeText(inner, source);
          }
        }
      }
    }
  }

  // Arrow/function expressions get their name from the parent variable_declarator,
  // not from identifiers in their body. Without this, single-expression arrow
  // functions like `const fn = () => someIdentifier` get named "someIdentifier"
  // instead of "fn", because the fallback below finds the body identifier.
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return '<anonymous>';
  }

  // Fall back to first identifier child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'simple_identifier' ||
        child.type === 'constant')
    ) {
      return getNodeText(child, source);
    }
  }

  return '<anonymous>';
}

/**
 * Tree-sitter node kinds that represent constructor invocations.
 */
const INSTANTIATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'new_expression',
  'object_creation_expression',
  'instance_creation_expression',
]);

export function isInstantiationNodeType(nodeType: string): boolean {
  return INSTANTIATION_NODE_TYPES.has(nodeType);
}

export function normalizeInstantiationClassName(rawName: string): string {
  let className = rawName;

  // Strip type-argument suffix first: `new Map<K, V>()` would otherwise
  // produce className 'Map<K, V>' and fail to match class nodes by name.
  const ltIdx = className.indexOf('<');
  if (ltIdx > 0) className = className.slice(0, ltIdx);

  // For namespaced/qualified constructors (`new ns.Foo()`, `new ns::Foo()`)
  // keep the trailing identifier.
  const lastDot = Math.max(
    className.lastIndexOf('.'),
    className.lastIndexOf('::')
  );
  if (lastDot >= 0) className = className.slice(lastDot + 1).replace(/^[:.]/, '');

  return className.trim();
}

export function extractInstantiationClassName(
  node: SyntaxNode,
  source: string
): string | undefined {
  const ctor =
    getChildByField(node, 'constructor') ||
    getChildByField(node, 'type') ||
    getChildByField(node, 'name') ||
    node.namedChild(0);
  if (!ctor) return undefined;

  const className = normalizeInstantiationClassName(getNodeText(ctor, source));
  return className || undefined;
}
