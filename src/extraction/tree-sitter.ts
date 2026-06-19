/**
 * Tree-sitter Parser Wrapper
 *
 * Handles parsing source code and extracting structural information.
 */

import { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import {
  Language,
  Node,
  Edge,
  NodeKind,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
} from '../types';
import { detectLanguage } from './grammars';
import { generateNodeId } from './tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from './tree-sitter-types';
import { EXTRACTORS } from './languages';
import { visitFunctionBody } from './extractors';
import { extract as runExtract } from './tree-sitter-extract';
import { visitNode as runVisitNode } from './tree-sitter-visit';


// Re-export for backward compatibility
export { generateNodeId } from './tree-sitter-helpers';

/**
 * TreeSitterExtractor - Main extraction class
 */
export class TreeSitterExtractor {
  filePath: string;
  language: Language;
  source: string;
  tree: Tree | null = null;
  nodes: Node[] = [];
  edges: Edge[] = [];
  unresolvedReferences: UnresolvedReference[] = [];
  errors: ExtractionError[] = [];
  extractor: LanguageExtractor | null = null;
  nodeStack: string[] = []; // Stack of parent node IDs
  methodIndex: Map<string, string> | null = null; // lookup key → node ID for Pascal defProc lookup

  constructor(filePath: string, source: string, language?: Language) {
    this.filePath = filePath;
    this.source = source;
    this.language = language || detectLanguage(filePath, source);
    this.extractor = EXTRACTORS[this.language] || null;
  }

  /** Parse and extract from the source code */
  extract(): ExtractionResult {
    return runExtract(this);
  }

  /** Visit a node and extract information */
  visitNode(node: SyntaxNode): void {
    runVisitNode(this, node);
  }

  /**
   * Create a Node object
   */
  createNode(
    kind: NodeKind,
    name: string,
    node: SyntaxNode,
    extra?: Partial<Node>
  ): Node | null {
    // Skip nodes with empty/missing names — they are not meaningful symbols
    // and would cause FK violations when edges reference them (see issue #42)
    if (!name) {
      return null;
    }

    const id = generateNodeId(this.filePath, kind, name, node.startPosition.row + 1);

    const newNode: Node = {
      id,
      kind,
      name,
      qualifiedName: this.buildQualifiedName(name),
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      updatedAt: Date.now(),
      ...extra,
    };

    this.nodes.push(newNode);

    // Add containment edge from parent
    if (this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.edges.push({
          source: parentId,
          target: id,
          kind: 'contains',
        });
      }
    }

    return newNode;
  }

  /**
   * Find first named child whose type is in the given list.
   * Used to locate inner type nodes (e.g. enum_specifier inside a typedef).
   */
  findChildByTypes(node: SyntaxNode, types: string[]): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && types.includes(child.type)) return child;
    }
    return null;
  }

  /**
   * Build qualified name from node stack
   */
  buildQualifiedName(name: string): string {
    // Build a qualified name from the semantic hierarchy only (no file path).
    // The file path is stored separately in filePath and pollutes FTS if included here.
    const parts: string[] = [];
    for (const nodeId of this.nodeStack) {
      const node = this.nodes.find((n) => n.id === nodeId);
      if (node && node.kind !== 'file') {
        parts.push(node.name);
      }
    }
    parts.push(name);
    return parts.join('::');
  }

  /**
   * Build an ExtractorContext for passing to language-specific visitNode hooks.
   */
  makeExtractorContext(): ExtractorContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      createNode: (kind, name, node, extra) => self.createNode(kind, name, node, extra),
      visitNode: (node) => self.visitNode(node),
      visitFunctionBody: (body, functionId) => visitFunctionBody(self, body, functionId),
      addUnresolvedReference: (ref) => self.unresolvedReferences.push(ref),
      pushScope: (nodeId) => self.nodeStack.push(nodeId),
      popScope: () => self.nodeStack.pop(),
      get filePath() { return self.filePath; },
      get source() { return self.source; },
      get nodeStack() { return self.nodeStack; },
      get nodes() { return self.nodes; },
    };
  }

  /**
   * Check if the current node stack indicates we are inside a class-like node
   * (class, struct, interface, trait). File nodes do not count as class-like.
   */
  isInsideClassLikeNode(): boolean {
    if (this.nodeStack.length === 0) return false;
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return false;
    const parentNode = this.nodes.find((n) => n.id === parentId);
    if (!parentNode) return false;
    return (
      parentNode.kind === 'class' ||
      parentNode.kind === 'struct' ||
      parentNode.kind === 'interface' ||
      parentNode.kind === 'trait' ||
      parentNode.kind === 'enum' ||
      parentNode.kind === 'module'
    );
  }

  /**
   * Extract a function
   */

}
