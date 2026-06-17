/**
 * Tree-sitter symbol extractors: declaration entry point.
 *
 * The per-construct extraction routines split out of TreeSitterExtractor. Each
 * takes the extractor instance as `self` and mutates its node/edge buffers.
 * Callable (function/method) and type (class/interface/struct/enum) extractors
 * live in sibling modules to stay within the file-size gate; they are
 * re-exported here so every `./extractors-decl` import path is unchanged. This
 * module keeps the member/variable extractors.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import { extractFieldDeclaration, extractPropertyDeclaration } from './member-extraction';
import { extractVariableDeclarations } from './variable-extraction';
import type { TreeSitterExtractor } from './tree-sitter';
import { extractDecoratorsFor } from './extractors-misc';
import { extractFunction } from './extractors-callable';

export * from './extractors-callable';
export * from './extractors-type';

/**
 * Extract a class property declaration (e.g. C# `public string Name { get; set; }`).
 * Extracts as 'property' kind node inside the owning class.
 */
export function extractProperty(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (!self.extractor) return;

    extractPropertyDeclaration({
      node,
      source: self.source,
      extractor: self.extractor,
      createNode: (kind, name, sourceNode, metadata) =>
        self.createNode(kind, name, sourceNode, metadata),
      extractDecoratorsFor: (declNode, decoratedId) =>
        extractDecoratorsFor(self, declNode, decoratedId),
    });
  }

  /**
   * Extract a class field declaration (e.g. Java field_declaration, C# field_declaration).
   * Extracts each declarator as a 'field' kind node inside the owning class.
   */
export function extractField(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (!self.extractor) return;

    extractFieldDeclaration({
      node,
      source: self.source,
      extractor: self.extractor,
      createNode: (kind, name, sourceNode, metadata) =>
        self.createNode(kind, name, sourceNode, metadata),
      extractDecoratorsFor: (declNode, decoratedId) =>
        extractDecoratorsFor(self, declNode, decoratedId),
    });
  }

  /**
   * Extract a variable declaration (const, let, var, etc.)
   *
   * Extracts top-level and module-level variable declarations.
   * Captures the variable name and first 100 chars of initializer in signature for searchability.
   */
export function extractVariable(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (!self.extractor) return;

    extractVariableDeclarations({
      node,
      source: self.source,
      language: self.language,
      extractor: self.extractor,
      createNode: (kind, name, sourceNode, metadata) =>
        self.createNode(kind, name, sourceNode, metadata),
      extractFunction: (functionNode) => extractFunction(self, functionNode),
      addReference: (ref) => self.unresolvedReferences.push(ref),
    });
  }
