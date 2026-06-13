/**
 * Tree-sitter symbol extractors
 *
 * The per-construct extraction routines (functions, classes, methods, types,
 * imports, calls, etc.) split out of TreeSitterExtractor. Each takes the
 * extractor instance as `self` and mutates its node/edge buffers via the
 * exposed members. Kept here so the core TreeSitterExtractor (parse loop,
 * createNode, dispatch) stays readable.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import { Node, NodeKind } from '../types';
import { getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import { extractName } from './tree-sitter-node-helpers';

import { extractEnumMemberNodes, extractFieldDeclaration, extractPropertyDeclaration } from './member-extraction';

import { extractTypeAnnotationsFromDeclaration } from './type-reference-extraction';
import { extractVariableDeclarations } from './variable-extraction';
import type { TreeSitterExtractor } from './tree-sitter';
import { extractDecoratorsFor, extractInheritance, visitFunctionBody } from './extractors-misc';

export function extractFunction(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (!self.extractor) return;

    // If the language provides getReceiverType and this function has a receiver
    // (e.g., Rust function_item inside an impl block), extract as method instead
    if (self.extractor.getReceiverType?.(node, self.source)) {
      extractMethod(self, node);
      return;
    }

    let name = extractName(node, self.source, self.extractor);
    // For arrow functions and function expressions assigned to variables,
    // resolve the name from the parent variable_declarator.
    // e.g. `export const useAuth = () => { ... }` — the arrow_function node
    // has no `name` field; the name lives on the variable_declarator.
    if (
      name === '<anonymous>' &&
      (node.type === 'arrow_function' || node.type === 'function_expression')
    ) {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator') {
        const varName = getChildByField(parent, 'name');
        if (varName) {
          name = getNodeText(varName, self.source);
        }
      }
    }
    if (name === '<anonymous>') return; // Skip anonymous functions

    // Check for misparse artifacts (e.g. C++ macros causing "namespace detail" functions)
    // Skip the node but still visit the body for calls and structural nodes
    if (self.extractor.isMisparsedFunction?.(name, node)) {
      const body = self.extractor.resolveBody?.(node, self.extractor.bodyField)
        ?? getChildByField(node, self.extractor.bodyField);
      if (body) {
        visitFunctionBody(self, body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, self.source);
    const signature = self.extractor.getSignature?.(node, self.source);
    const visibility = self.extractor.getVisibility?.(node);
    const isExported = self.extractor.isExported?.(node, self.source);
    const isAsync = self.extractor.isAsync?.(node);
    const isStatic = self.extractor.isStatic?.(node);

    const funcNode = self.createNode('function', name, node, {
      docstring,
      signature,
      visibility,
      isExported,
      isAsync,
      isStatic,
    });
    if (!funcNode) return;

    // Extract type annotations (parameter types and return type)
    extractTypeAnnotationsFromDeclaration(
      node,
      funcNode.id,
      self.language,
      self.source,
      self.extractor,
      (ref) => self.unresolvedReferences.push(ref)
    );

    // Extract decorators applied to the function (rare in JS/TS but
    // present in Python `@decorator def f():` and Java/Kotlin
    // annotations on free functions).
    extractDecoratorsFor(self, node, funcNode.id);

    // Push to stack and visit body
    self.nodeStack.push(funcNode.id);
    const body = self.extractor.resolveBody?.(node, self.extractor.bodyField)
      ?? getChildByField(node, self.extractor.bodyField);
    if (body) {
      visitFunctionBody(self, body, funcNode.id);
    }
    self.nodeStack.pop();
  }

  /**
   * Extract a class
   */
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
   * Extract a method
   */
export function extractMethod(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (!self.extractor) return;

    // For languages with receiver types (Go, Rust), include receiver in qualified name
    // so FTS can match "scrapeLoop.run" → qualified_name "...::scrapeLoop::run"
    const receiverType = self.extractor.getReceiverType?.(node, self.source);

    // For most languages, only extract as method if inside a class-like node
    // Languages with methodsAreTopLevel (e.g. Go) always treat them as methods
    // Languages with getReceiverType (e.g. Rust) extract as method when receiver is found
    if (!self.isInsideClassLikeNode() && !self.extractor.methodsAreTopLevel && !receiverType) {
      // Skip method_definition nodes inside object literals (getters/setters/methods
      // in inline objects). These are ephemeral and create noise (e.g., Svelte context
      // objects: `ctx.set({ get view() { ... } })`).
      if (node.parent?.type === 'object' || node.parent?.type === 'object_expression') {
        return;
      }
      // Not inside a class-like node and no receiver type, treat as function
      extractFunction(self, node);
      return;
    }

    const name = extractName(node, self.source, self.extractor);

    // Check for misparse artifacts (e.g. C++ "switch" inside macro-confused class body)
    if (self.extractor.isMisparsedFunction?.(name, node)) {
      const body = self.extractor.resolveBody?.(node, self.extractor.bodyField)
        ?? getChildByField(node, self.extractor.bodyField);
      if (body) {
        visitFunctionBody(self, body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, self.source);
    const signature = self.extractor.getSignature?.(node, self.source);
    const visibility = self.extractor.getVisibility?.(node);
    const isAsync = self.extractor.isAsync?.(node);
    const isStatic = self.extractor.isStatic?.(node);
    const extraProps: Partial<Node> = {
      docstring,
      signature,
      visibility,
      isAsync,
      isStatic,
    };
    if (receiverType) {
      extraProps.qualifiedName = `${receiverType}::${name}`;
    }

    const methodNode = self.createNode('method', name, node, extraProps);
    if (!methodNode) return;

    // For methods with a receiver type but no class-like parent on the stack
    // (e.g., Rust impl blocks), add a contains edge from the owning struct/trait
    if (receiverType && !self.isInsideClassLikeNode()) {
      const ownerNode = self.nodes.find(
        (n) =>
          n.name === receiverType &&
          n.filePath === self.filePath &&
          (n.kind === 'struct' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait')
      );
      if (ownerNode) {
        self.edges.push({
          source: ownerNode.id,
          target: methodNode.id,
          kind: 'contains',
        });
      }
    }

    // Extract type annotations (parameter types and return type)
    extractTypeAnnotationsFromDeclaration(
      node,
      methodNode.id,
      self.language,
      self.source,
      self.extractor,
      (ref) => self.unresolvedReferences.push(ref)
    );

    // Extract decorators (`@Get('/list') list() {}`).
    extractDecoratorsFor(self, node, methodNode.id);

    // Push to stack and visit body
    self.nodeStack.push(methodNode.id);
    const body = self.extractor.resolveBody?.(node, self.extractor.bodyField)
      ?? getChildByField(node, self.extractor.bodyField);
    if (body) {
      visitFunctionBody(self, body, methodNode.id);
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

  /**
   * Extract a type alias (e.g. `export type X = ...` in TypeScript).
   * For languages like Go, resolveTypeAliasKind detects when the type_spec
   * wraps a struct or interface definition and creates the correct node kind.
   * Returns true if children should be skipped (struct/interface handled body visiting).
   */
