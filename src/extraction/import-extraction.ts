import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { Language, UnresolvedReference } from '../types';
import { getNodeText } from './tree-sitter-helpers';
import type { LanguageExtractor } from './tree-sitter-types';

type AddReference = (ref: UnresolvedReference) => void;
type CreateImportNode = (moduleName: string, node: SyntaxNode, signature: string) => void;

export type ImportExtractionOptions = {
  node: SyntaxNode;
  source: string;
  language: Language;
  extractor: LanguageExtractor;
  parentId?: string;
  createImportNode: CreateImportNode;
  addReference: AddReference;
};

function emitImportReference(
  addReference: AddReference,
  parentId: string | undefined,
  moduleName: string,
  node: SyntaxNode
): void {
  if (!parentId || !moduleName) return;
  addReference({
    fromNodeId: parentId,
    referenceName: moduleName,
    referenceKind: 'imports',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * Extract import nodes and import references for languages whose import syntax
 * cannot be represented by a simple per-language hook.
 */
export function extractImportDeclarations(options: ImportExtractionOptions): void {
  const {
    node,
    source,
    language,
    extractor,
    parentId,
    createImportNode,
    addReference,
  } = options;
  const importText = getNodeText(node, source).trim();

  if (extractor.extractImport) {
    const info = extractor.extractImport(node, source);
    if (info) {
      createImportNode(info.moduleName, node, info.signature);
      if (!info.handledRefs) {
        emitImportReference(addReference, parentId, info.moduleName, node);
      }
      return;
    }
  }

  if (language === 'python' && node.type === 'import_statement') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'dotted_name') {
        createImportNode(getNodeText(child, source), node, importText);
      } else if (child?.type === 'aliased_import') {
        const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
        if (dottedName) {
          createImportNode(getNodeText(dottedName, source), node, importText);
        }
      }
    }
    return;
  }

  if (language === 'go') {
    const extractFromSpec = (spec: SyntaxNode): void => {
      const stringLiteral = spec.namedChildren.find(
        c => c.type === 'interpreted_string_literal'
      );
      if (!stringLiteral) return;

      const importPath = getNodeText(stringLiteral, source).replace(/['"]/g, '');
      if (!importPath) return;

      createImportNode(importPath, spec, getNodeText(spec, source).trim());
      emitImportReference(addReference, parentId, importPath, spec);
    };

    const importSpecList = node.namedChildren.find(c => c.type === 'import_spec_list');
    if (importSpecList) {
      for (const spec of importSpecList.namedChildren.filter(c => c.type === 'import_spec')) {
        extractFromSpec(spec);
      }
    } else {
      const importSpec = node.namedChildren.find(c => c.type === 'import_spec');
      if (importSpec) {
        extractFromSpec(importSpec);
      }
    }
    return;
  }

  if (language === 'php') {
    const namespacePrefix = node.namedChildren.find(c => c.type === 'namespace_name');
    const useGroup = node.namedChildren.find(c => c.type === 'namespace_use_group');
    if (namespacePrefix && useGroup) {
      const prefix = getNodeText(namespacePrefix, source);
      const useClauses = useGroup.namedChildren.filter((c: SyntaxNode) =>
        c.type === 'namespace_use_group_clause' || c.type === 'namespace_use_clause'
      );
      for (const clause of useClauses) {
        const nsName = clause.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
        const name = nsName
          ? nsName.namedChildren.find((c: SyntaxNode) => c.type === 'name')
          : clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
        if (name) {
          createImportNode(`${prefix}\\${getNodeText(name, source)}`, node, importText);
        }
      }
      return;
    }
  }

  if (extractor.extractImport) return;

  createImportNode(importText, node, importText);
}
