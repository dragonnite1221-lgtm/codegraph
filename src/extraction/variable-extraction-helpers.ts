/**
 * Per-language variable-extraction helpers split out of variable-extraction.ts
 * to keep it within the 200-line limit. No behavior change.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Language, NodeKind } from '../types';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import { extractName } from './tree-sitter-node-helpers';
import { extractVariableTypeAnnotation } from './type-reference-extraction';
import type { LanguageExtractor } from './tree-sitter-types';
import type {
  CreateVariableNode,
  AddReference,
  ExtractNestedFunction,
} from './variable-extraction';

function buildInitializerSignature(valueNode: SyntaxNode | null, source: string): string | undefined {
  const initValue = valueNode ? getNodeText(valueNode, source).slice(0, 100) : undefined;
  return initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
}

export function extractJsLikeVariables(
  node: SyntaxNode,
  source: string,
  language: Language,
  kind: NodeKind,
  docstring: string | undefined,
  isExported: boolean,
  callbacks: {
    createNode: CreateVariableNode;
    extractFunction: ExtractNestedFunction;
    addReference: AddReference;
  }
): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== 'variable_declarator') continue;

    const nameNode = getChildByField(child, 'name');
    const valueNode = getChildByField(child, 'value');
    if (!nameNode) continue;

    if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') {
      continue;
    }

    if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
      callbacks.extractFunction(valueNode);
      continue;
    }

    const varNode = callbacks.createNode(kind, getNodeText(nameNode, source), child, {
      docstring,
      signature: buildInitializerSignature(valueNode, source),
      isExported,
    });

    if (varNode) {
      extractVariableTypeAnnotation(
        child,
        varNode.id,
        language,
        source,
        callbacks.addReference
      );
    }
  }
}

export function extractAssignmentVariable(
  node: SyntaxNode,
  source: string,
  kind: NodeKind,
  docstring: string | undefined,
  createNode: CreateVariableNode
): void {
  const left = getChildByField(node, 'left') || node.namedChild(0);
  const right = getChildByField(node, 'right') || node.namedChild(1);

  if (left?.type !== 'identifier') return;

  createNode(kind, getNodeText(left, source), node, {
    docstring,
    signature: buildInitializerSignature(right, source),
  });
}

export function extractGoVariables(
  node: SyntaxNode,
  source: string,
  docstring: string | undefined,
  createNode: CreateVariableNode
): void {
  const specs = node.namedChildren.filter(
    (child: SyntaxNode) => child.type === 'var_spec' || child.type === 'const_spec'
  );

  for (const spec of specs) {
    const nameNode = spec.namedChild(0);
    if (nameNode?.type !== 'identifier') continue;

    const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
    createNode(node.type === 'const_declaration' ? 'constant' : 'variable', getNodeText(nameNode, source), spec, {
      docstring,
      signature: buildInitializerSignature(valueNode, source),
    });
  }

  if (node.type !== 'short_var_declaration') return;

  const left = getChildByField(node, 'left');
  const right = getChildByField(node, 'right');
  if (!left) return;

  const identifiers = left.type === 'expression_list'
    ? left.namedChildren.filter((child: SyntaxNode) => child.type === 'identifier')
    : [left];

  for (const identifier of identifiers) {
    createNode('variable', getNodeText(identifier, source), node, {
      docstring,
      signature: buildInitializerSignature(right, source),
    });
  }
}

export function extractGenericVariables(
  node: SyntaxNode,
  source: string,
  extractor: LanguageExtractor,
  kind: NodeKind,
  docstring: string | undefined,
  isExported: boolean,
  createNode: CreateVariableNode
): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== 'identifier' && child?.type !== 'variable_declarator') {
      continue;
    }

    const name = child.type === 'identifier'
      ? getNodeText(child, source)
      : extractName(child, source, extractor);

    if (name && name !== '<anonymous>') {
      createNode(kind, name, child, {
        docstring,
        isExported,
      });
    }
  }
}
