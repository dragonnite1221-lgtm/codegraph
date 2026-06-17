import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { Language, Node, NodeKind, UnresolvedReference } from '../types';
import { getPrecedingDocstring } from './tree-sitter-helpers';
import type { LanguageExtractor } from './tree-sitter-types';
import {
  extractJsLikeVariables,
  extractAssignmentVariable,
  extractGoVariables,
  extractGenericVariables,
} from './variable-extraction-helpers';

export type CreateVariableNode = (
  kind: NodeKind,
  name: string,
  node: SyntaxNode,
  metadata?: Partial<Node>
) => Node | null;

export type AddReference = (ref: UnresolvedReference) => void;

export type ExtractNestedFunction = (node: SyntaxNode) => void;

interface ExtractVariableDeclarationsOptions {
  node: SyntaxNode;
  source: string;
  language: Language;
  extractor: LanguageExtractor;
  createNode: CreateVariableNode;
  extractFunction: ExtractNestedFunction;
  addReference: AddReference;
}

const JS_LIKE_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
]);

export function extractVariableDeclarations({
  node,
  source,
  language,
  extractor,
  createNode,
  extractFunction,
  addReference,
}: ExtractVariableDeclarationsOptions): void {
  const isConst = extractor.isConst?.(node) ?? false;
  const kind: NodeKind = isConst ? 'constant' : 'variable';
  const docstring = getPrecedingDocstring(node, source);
  const isExported = extractor.isExported?.(node, source) ?? false;

  if (JS_LIKE_LANGUAGES.has(language)) {
    extractJsLikeVariables(node, source, language, kind, docstring, isExported, {
      createNode,
      extractFunction,
      addReference,
    });
    return;
  }

  if (language === 'python' || language === 'ruby') {
    extractAssignmentVariable(node, source, kind, docstring, createNode);
    return;
  }

  if (language === 'go') {
    extractGoVariables(node, source, docstring, createNode);
    return;
  }

  extractGenericVariables(node, source, extractor, kind, docstring, isExported, createNode);
}

