/**
 * Kotlin `fun interface` misparse recovery. tree-sitter-kotlin doesn't support
 * `fun interface` (Kotlin 1.4+), producing two misparse shapes; this detects
 * and recovers them. Split out of kotlin.ts to stay within the file-size gate.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ExtractorContext } from '../tree-sitter-types';

/** Check if a node matches the `fun interface` misparse pattern */
export function isFunInterfaceNode(node: SyntaxNode): boolean {
  let hasFun = false;
  let hasInterfaceType = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'fun' && !child.isNamed) hasFun = true;
    if (child.type === 'user_type') {
      const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId && typeId.text === 'interface') hasInterfaceType = true;
    }
    // Pattern 2b: user_type("interface") is inside an ERROR child
    if (child.type === 'ERROR') {
      for (let j = 0; j < child.childCount; j++) {
        const gc = child.child(j);
        if (gc && gc.type === 'user_type') {
          const typeId = gc.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (typeId && typeId.text === 'interface') hasInterfaceType = true;
        }
      }
    }
  }
  return hasFun && hasInterfaceType;
}

/** visitNode hook for the Kotlin extractor: recover `fun interface` declarations. */
export function visitKotlinNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  // Handle Kotlin `fun interface` declarations.
  // Tree-sitter-kotlin doesn't support `fun interface` syntax (Kotlin 1.4+).
  // It produces two different misparse patterns:
  //   Pattern 1 (simple): ERROR node + sibling lambda_literal for body
  //   Pattern 2 (complex): function_declaration misparse with ERROR child
  // Skip lambda_literal bodies that were already consumed by a fun interface ERROR node
  if (node.type === 'lambda_literal') {
    const prev = node.previousSibling;
    if (prev && prev.type === 'ERROR' && isFunInterfaceNode(prev)) return true;
    return false;
  }

  if (node.type !== 'ERROR' && node.type !== 'function_declaration') return false;

  // Skip ERROR nodes that are class bodies (start with `{`). These contain parent
  // methods + trailing `fun interface` tokens. The methods are extracted via
  // resolveBody; handling the ERROR here would consume the whole body.
  if (node.type === 'ERROR') {
    const firstChild = node.child(0);
    if (firstChild && firstChild.type === '{') return false;
  }

  if (!isFunInterfaceNode(node)) return false;

  // Extract the interface name.
  // For function_declaration misparses (patterns 2a/2b), the real name is inside
  // an ERROR child — direct simple_identifier children are the misparsed method name.
  let nameText: string | null = null;
  if (node.type === 'function_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === 'ERROR') {
        for (let j = 0; j < child.childCount; j++) {
          const gc = child.child(j);
          if (gc && gc.type === 'simple_identifier') {
            nameText = gc.text;
            break;
          }
        }
        if (nameText) break;
      }
    }
  }
  // Fallback: direct simple_identifier child (Pattern 1: ERROR node at top level)
  if (!nameText) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === 'simple_identifier') {
        nameText = child.text;
        break;
      }
    }
  }
  if (!nameText) return false;

  // Create the interface node
  const ifaceNode = ctx.createNode('interface', nameText, node);
  if (!ifaceNode) return false;

  ctx.pushScope(ifaceNode.id);

  if (node.type === 'ERROR') {
    // Pattern 1: body is in the next sibling lambda_literal
    const nextSibling = node.nextSibling;
    if (nextSibling && nextSibling.type === 'lambda_literal') {
      for (let i = 0; i < nextSibling.namedChildCount; i++) {
        const child = nextSibling.namedChild(i);
        if (child && child.type === 'statements') {
          for (let j = 0; j < child.namedChildCount; j++) {
            const stmt = child.namedChild(j);
            if (stmt) ctx.visitNode(stmt);
          }
        }
      }
    }
  }
  // Pattern 2 (function_declaration): nested classes are siblings at source_file level,
  // already visited by the normal traversal. The single abstract method is misparsed
  // and cannot be reliably recovered, but the interface node itself is the key value.

  ctx.popScope();
  return true;
}
