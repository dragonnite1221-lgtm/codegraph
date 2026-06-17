/**
 * Callable symbol extractors: functions and methods.
 *
 * Split out of extractors-decl.ts to stay within the file-size gate;
 * re-exported from extractors-decl.ts so import paths are unchanged.
 * extractFunction and extractMethod are mutually recursive (a function with a
 * receiver becomes a method; a method outside a class-like node becomes a
 * function), so they live together. Each takes the extractor instance as
 * `self`.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import { Node } from '../types';
import { getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import { extractName } from './tree-sitter-node-helpers';
import { extractTypeAnnotationsFromDeclaration } from './type-reference-extraction';
import type { TreeSitterExtractor } from './tree-sitter';
import { extractDecoratorsFor, visitFunctionBody } from './extractors-misc';

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
