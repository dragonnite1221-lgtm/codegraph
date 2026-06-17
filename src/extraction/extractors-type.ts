/**
 * Type-declaration extractors: classes, interfaces/protocols/traits, structs,
 * enums, and enum members.
 *
 * Split out of extractors-decl.ts to stay within the file-size gate;
 * re-exported from extractors-decl.ts so import paths are unchanged. Each
 * takes the extractor instance as `self`.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import { NodeKind } from '../types';
import { getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import { extractName } from './tree-sitter-node-helpers';
import { extractEnumMemberNodes } from './member-extraction';
import type { TreeSitterExtractor } from './tree-sitter';
import { extractDecoratorsFor, extractInheritance } from './extractors-misc';

export function extractClass(self: TreeSitterExtractor, node: SyntaxNode, kind: NodeKind = 'class'): void {
    if (!self.extractor) return;

    const name = extractName(node, self.source, self.extractor);
    const docstring = getPrecedingDocstring(node, self.source);
    const visibility = self.extractor.getVisibility?.(node);
    const isExported = self.extractor.isExported?.(node, self.source);

    const classNode = self.createNode(kind, name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!classNode) return;

    // Extract extends/implements
    extractInheritance(self, node, classNode.id);

    // Extract decorators applied to the class (`@Foo class X {}`).
    extractDecoratorsFor(self, node, classNode.id);

    // Push to stack and visit body
    self.nodeStack.push(classNode.id);
    let body = self.extractor.resolveBody?.(node, self.extractor.bodyField)
      ?? getChildByField(node, self.extractor.bodyField);
    if (!body) body = node;

    // Visit all children for methods and properties
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        self.visitNode(child);
      }
    }
    self.nodeStack.pop();
  }

  /**
   * Extract an interface/protocol/trait
   */
export function extractInterface(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (!self.extractor) return;

    const name = extractName(node, self.source, self.extractor);
    const docstring = getPrecedingDocstring(node, self.source);
    const isExported = self.extractor.isExported?.(node, self.source);

    const kind: NodeKind = self.extractor.interfaceKind ?? 'interface';

    const interfaceNode = self.createNode(kind, name, node, {
      docstring,
      isExported,
    });
    if (!interfaceNode) return;

    // Extract extends (interface inheritance)
    extractInheritance(self, node, interfaceNode.id);

    // Visit body children for interface methods and nested types
    self.nodeStack.push(interfaceNode.id);
    let body = self.extractor.resolveBody?.(node, self.extractor.bodyField)
      ?? getChildByField(node, self.extractor.bodyField);
    if (!body) body = node;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        self.visitNode(child);
      }
    }
    self.nodeStack.pop();
  }

  /**
   * Extract a struct
   */
export function extractStruct(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (!self.extractor) return;

    // Skip forward declarations and type references (no body = not a definition)
    const body = getChildByField(node, self.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, self.source, self.extractor);
    const docstring = getPrecedingDocstring(node, self.source);
    const visibility = self.extractor.getVisibility?.(node);
    const isExported = self.extractor.isExported?.(node, self.source);

    const structNode = self.createNode('struct', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!structNode) return;

    // Extract inheritance (e.g. Swift: struct HTTPMethod: RawRepresentable)
    extractInheritance(self, node, structNode.id);

    // Push to stack for field extraction
    self.nodeStack.push(structNode.id);
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        self.visitNode(child);
      }
    }
    self.nodeStack.pop();
  }

  /**
   * Extract an enum
   */
export function extractEnum(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (!self.extractor) return;

    // Skip forward declarations and type references (no body = not a definition)
    const body = self.extractor.resolveBody?.(node, self.extractor.bodyField)
      ?? getChildByField(node, self.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, self.source, self.extractor);
    const docstring = getPrecedingDocstring(node, self.source);
    const visibility = self.extractor.getVisibility?.(node);
    const isExported = self.extractor.isExported?.(node, self.source);

    const enumNode = self.createNode('enum', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!enumNode) return;

    // Extract inheritance (e.g. Swift: enum AFError: Error)
    extractInheritance(self, node, enumNode.id);

    // Push to stack and visit body children (enum members, nested types, methods)
    self.nodeStack.push(enumNode.id);

    const memberTypes = self.extractor.enumMemberTypes;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;

      if (memberTypes?.includes(child.type)) {
        extractEnumMembers(self, child);
      } else {
        self.visitNode(child);
      }
    }
    self.nodeStack.pop();
  }

  /**
   * Extract enum member names from an enum member node.
   * Handles multi-case declarations (Swift: `case put, delete`) and single-case patterns.
   */
export function extractEnumMembers(self: TreeSitterExtractor, node: SyntaxNode): void {
    extractEnumMemberNodes(node, self.source, (kind, name, sourceNode, metadata) =>
      self.createNode(kind, name, sourceNode, metadata)
    );
  }
