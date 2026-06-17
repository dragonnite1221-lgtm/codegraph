import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { Node, NodeKind, UnresolvedReference } from '../types';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { LanguageExtractor } from './tree-sitter-types';

export type AddReference = (ref: UnresolvedReference) => void;

export interface PascalVisitorContext {
  filePath: string;
  source: string;
  extractor: LanguageExtractor;
  nodes: readonly Node[];
  nodeStack: string[];
  createNode(kind: NodeKind, name: string, node: SyntaxNode, extra?: Partial<Node>): Node | null;
  visitNode(node: SyntaxNode): void;
  addUnresolvedReference(ref: UnresolvedReference): void;
  pushScope(nodeId: string): void;
  popScope(): void;
  getMethodIndex(): Map<string, string> | null;
  setMethodIndex(index: Map<string, string>): void;
}

export type PascalDefProcName = {
  fullName: string;
  fullNameKey: string;
  shortNameKey: string;
};

export function buildPascalMethodIndex(nodes: readonly Node[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === 'method' || node.kind === 'function') {
      const nameKey = node.name.toLowerCase();
      // Keep first seen short-name mapping to avoid silently overwriting earlier entries.
      if (!index.has(nameKey)) {
        index.set(nameKey, node.id);
      }

      // For Pascal methods, also index qualified forms (e.g. TAuthService.Create).
      if (node.kind === 'method') {
        const qualifiedParts = node.qualifiedName.split('::');
        if (qualifiedParts.length >= 2) {
          // Create suffix keys so both "Module.Class.Method" and "Class.Method" can resolve.
          for (let i = 0; i < qualifiedParts.length - 1; i++) {
            const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
            index.set(scopedName, node.id);
          }
        }
      }
    }
  }
  return index;
}

export function extractPascalDefProcName(
  node: SyntaxNode,
  source: string
): PascalDefProcName | null {
  const declProc = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'declProc'
  );
  if (!declProc) return null;

  const nameNode = getChildByField(declProc, 'name');
  if (!nameNode) return null;

  const fullName = getNodeText(nameNode, source).trim();
  const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
  return {
    fullName,
    fullNameKey: fullName.toLowerCase(),
    shortNameKey: shortName.toLowerCase(),
  };
}

export function resolvePascalDefProcParentId(
  procName: PascalDefProcName,
  methodIndex: ReadonlyMap<string, string>,
  fallbackParentId?: string
): string | undefined {
  return (
    methodIndex.get(procName.fullNameKey) ||
    methodIndex.get(procName.shortNameKey) ||
    fallbackParentId
  );
}

export function extractPascalInheritanceReferences(
  declClass: SyntaxNode,
  classId: string,
  source: string,
  addReference: AddReference
): void {
  const typerefs = declClass.namedChildren.filter(
    (child: SyntaxNode) => child.type === 'typeref'
  );
  for (let i = 0; i < typerefs.length; i++) {
    const ref = typerefs[i]!;
    addReference({
      fromNodeId: classId,
      referenceName: getNodeText(ref, source),
      referenceKind: i === 0 ? 'extends' : 'implements',
      line: ref.startPosition.row + 1,
      column: ref.startPosition.column,
    });
  }
}

export function extractPascalCallName(node: SyntaxNode, source: string): string | undefined {
  const firstChild = node.namedChild(0);
  if (!firstChild) return undefined;

  if (firstChild.type === 'exprDot') {
    const identifiers = firstChild.namedChildren.filter(
      (child: SyntaxNode) => child.type === 'identifier'
    );
    if (identifiers.length > 0) {
      return identifiers.map((identifier: SyntaxNode) => getNodeText(identifier, source)).join('.');
    }
    return undefined;
  }

  if (firstChild.type === 'identifier') {
    return getNodeText(firstChild, source);
  }

  return undefined;
}

export function visitPascalCallExpressions(
  node: SyntaxNode,
  visitCall: (callNode: SyntaxNode) => void
): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'exprCall') {
      visitCall(child);
    } else if (child.type === 'exprDot') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const grandchild = child.namedChild(j);
        if (grandchild?.type === 'exprCall') {
          visitCall(grandchild);
        }
      }
    } else {
      visitPascalCallExpressions(child, visitCall);
    }
  }
}
