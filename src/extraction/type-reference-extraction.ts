import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { Language, UnresolvedReference } from '../types';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { LanguageExtractor } from './tree-sitter-types';

const TYPE_ANNOTATION_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'tsx',
  'dart',
  'kotlin',
  'swift',
  'rust',
  'go',
  'java',
  'csharp',
]);

const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'void',
  'null',
  'undefined',
  'never',
  'any',
  'unknown',
  'object',
  'symbol',
  'bigint',
  'true',
  'false',
  // Rust
  'str',
  'bool',
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'isize',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'usize',
  'f32',
  'f64',
  'char',
  // Java/C#
  'int',
  'long',
  'short',
  'byte',
  'float',
  'double',
  // Go
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float32',
  'float64',
  'complex64',
  'complex128',
  'rune',
  'error',
]);

export function supportsTypeAnnotations(language: Language): boolean {
  return TYPE_ANNOTATION_LANGUAGES.has(language);
}

type AddReference = (ref: UnresolvedReference) => void;

export function extractTypeAnnotationsFromDeclaration(
  node: SyntaxNode,
  nodeId: string,
  language: Language,
  source: string,
  extractor: LanguageExtractor,
  addReference: AddReference
): void {
  if (!supportsTypeAnnotations(language)) return;

  const params = getChildByField(node, extractor.paramsField || 'parameters');
  if (params) {
    extractTypeRefsFromSubtree(params, source, nodeId, addReference);
  }

  const returnType = getChildByField(node, extractor.returnField || 'return_type');
  if (returnType) {
    extractTypeRefsFromSubtree(returnType, source, nodeId, addReference);
  }

  const typeAnnotation = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'type_annotation'
  );
  if (typeAnnotation) {
    extractTypeRefsFromSubtree(typeAnnotation, source, nodeId, addReference);
  }
}

export function extractVariableTypeAnnotation(
  node: SyntaxNode,
  nodeId: string,
  language: Language,
  source: string,
  addReference: AddReference
): void {
  if (!supportsTypeAnnotations(language)) return;

  const typeAnnotation = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'type_annotation'
  );
  if (typeAnnotation) {
    extractTypeRefsFromSubtree(typeAnnotation, source, nodeId, addReference);
  }
}

export function extractTypeRefsFromSubtree(
  node: SyntaxNode,
  source: string,
  fromNodeId: string,
  addReference: AddReference
): void {
  if (node.type === 'type_identifier') {
    const typeName = getNodeText(node, source);
    if (typeName && !BUILTIN_TYPES.has(typeName)) {
      addReference({
        fromNodeId,
        referenceName: typeName,
        referenceKind: 'references',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) {
      extractTypeRefsFromSubtree(child, source, fromNodeId, addReference);
    }
  }
}
