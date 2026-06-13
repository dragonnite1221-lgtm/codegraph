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
import {
  Node,
  NodeKind,
} from '../types';
import { getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import {
  extractInstantiationClassName,
  extractName,
  isInstantiationNodeType,
} from './tree-sitter-node-helpers';
import { extractCallReference } from './call-extraction';
import { extractDecoratorReferences } from './decorator-extraction';
import { extractInheritanceReferences } from './inheritance-extraction';
import { extractImportDeclarations } from './import-extraction';
import {
  extractEnumMemberNodes,
  extractFieldDeclaration,
  extractPropertyDeclaration,
} from './member-extraction';
import {
} from './pascal-extraction-helpers';
import {
  extractTypeAnnotationsFromDeclaration,
  extractTypeRefsFromSubtree,
  supportsTypeAnnotations,
} from './type-reference-extraction';
import { extractVariableDeclarations } from './variable-extraction';
import type { TreeSitterExtractor } from './tree-sitter';

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
export function extractTypeAlias(self: TreeSitterExtractor, node: SyntaxNode): boolean {
    if (!self.extractor) return false;

    const name = extractName(node, self.source, self.extractor);
    if (name === '<anonymous>') return false;
    const docstring = getPrecedingDocstring(node, self.source);
    const isExported = self.extractor.isExported?.(node, self.source);

    // Check if this type alias is actually a struct or interface definition
    // (e.g. Go: `type Foo struct { ... }` is a type_spec wrapping struct_type)
    const resolvedKind = self.extractor.resolveTypeAliasKind?.(node, self.source);

    if (resolvedKind === 'struct') {
      const structNode = self.createNode('struct', name, node, { docstring, isExported });
      if (!structNode) return true;
      // Visit body children for field extraction
      self.nodeStack.push(structNode.id);
      // Try Go-style 'type' field first, then find inner struct child (C typedef struct)
      const typeChild = getChildByField(node, 'type')
        || self.findChildByTypes(node, self.extractor.structTypes);
      if (typeChild) {
        // Extract struct embedding (e.g. Go: `type DB struct { *Head; Queryable }`)
        extractInheritance(self, typeChild, structNode.id);
        const body = getChildByField(typeChild, self.extractor.bodyField) || typeChild;
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) self.visitNode(child);
        }
      }
      self.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'enum') {
      const enumNode = self.createNode('enum', name, node, { docstring, isExported });
      if (!enumNode) return true;
      self.nodeStack.push(enumNode.id);
      // Find the inner enum type child (e.g. C: typedef enum { ... } name)
      const innerEnum = self.findChildByTypes(node, self.extractor.enumTypes);
      if (innerEnum) {
        extractInheritance(self, innerEnum, enumNode.id);
        const body = self.extractor.resolveBody?.(innerEnum, self.extractor.bodyField)
          ?? getChildByField(innerEnum, self.extractor.bodyField);
        if (body) {
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
        }
      }
      self.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'interface') {
      const kind: NodeKind = self.extractor.interfaceKind ?? 'interface';
      const interfaceNode = self.createNode(kind, name, node, { docstring, isExported });
      if (!interfaceNode) return true;
      // Extract interface inheritance from the inner type node
      const typeChild = getChildByField(node, 'type');
      if (typeChild) extractInheritance(self, typeChild, interfaceNode.id);
      return true;
    }

    const typeAliasNode = self.createNode('type_alias', name, node, {
      docstring,
      isExported,
    });

    // Extract type references from the alias value (e.g., `type X = ITextModel | null`)
    if (typeAliasNode && supportsTypeAnnotations(self.language)) {
      // The value is everything after the `=`, which is typically the last named child
      // In tree-sitter TS: type_alias_declaration has name + value children
      const value = getChildByField(node, 'value');
      if (value) {
        extractTypeRefsFromSubtree(
          value,
          self.source,
          typeAliasNode.id,
          (ref) => self.unresolvedReferences.push(ref)
        );
      }
    }
    return false;
  }

  // extractExportedVariables removed — the walker now descends into
  // export_statement children and the inner declaration's dedicated
  // extractor (extractVariable, extractFunction, extractClass, etc.)
  // handles the symbol with isExported=true via parent-walk in the
  // language extractor's isExported predicate.

  /**
   * Extract an import
   *
   * Creates an import node with the full import statement stored in signature for searchability.
   * Also creates unresolved references for resolution purposes.
   */
export function extractImport(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (!self.extractor) return;

    extractImportDeclarations({
      node,
      source: self.source,
      language: self.language,
      extractor: self.extractor,
      parentId: self.nodeStack[self.nodeStack.length - 1],
      createImportNode: (moduleName, importNode, signature) => {
        self.createNode('import', moduleName, importNode, { signature });
      },
      addReference: (ref) => self.unresolvedReferences.push(ref),
    });
  }

  /**
   * Extract a function call
   */
export function extractCall(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (self.nodeStack.length === 0) return;

    const callerId = self.nodeStack[self.nodeStack.length - 1];
    if (!callerId) return;

    const ref = extractCallReference(node, self.source, callerId);
    if (ref) self.unresolvedReferences.push(ref);
  }

  /**
   * `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
   * emit an `instantiates` reference to the class name. The resolver
   * then links it to the class node, producing the `instantiates`
   * edge that powers "what creates instances of X" queries.
   *
   * Children are still walked so nested calls inside the constructor
   * arguments (`new Foo(bar())`) get their own `calls` references.
   */
export function extractInstantiation(self: TreeSitterExtractor, node: SyntaxNode): void {
    if (self.nodeStack.length === 0) return;
    const fromId = self.nodeStack[self.nodeStack.length - 1];
    if (!fromId) return;

    const className = extractInstantiationClassName(node, self.source);

    if (className) {
      self.unresolvedReferences.push({
        fromNodeId: fromId,
        referenceName: className,
        referenceKind: 'instantiates',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * Scan `declNode` and its preceding siblings (within the parent's
   * named children) for decorator nodes, emitting a `decorates`
   * reference from `decoratedId` to each decorator's function name.
   *
   * Why preceding siblings: in TypeScript, `@Foo class Bar {}` parses
   * as an `export_statement` (or top-level wrapper) with the
   * `decorator` as a child *before* the `class_declaration` — so the
   * decorator isn't a child of the class itself. For methods/
   * properties, the decorator IS a direct child of the declaration,
   * so we also scan declNode.namedChildren.
   *
   * Idempotent across grammars: if neither location yields decorators
   * (most non-decorator-using languages), the function is a no-op.
   */
export function extractDecoratorsFor(self: TreeSitterExtractor, declNode: SyntaxNode, decoratedId: string): void {
    extractDecoratorReferences(
      declNode,
      decoratedId,
      self.source,
      (ref) => self.unresolvedReferences.push(ref)
    );
  }

  /**
   * Visit function body and extract calls (and structural nodes).
   *
   * In addition to call expressions, this also detects class/struct/enum
   * definitions inside function bodies. This handles two cases:
   *   1. Local class/struct/enum definitions (valid in C++, Java, etc.)
   *   2. C++ macro misparsing — macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause
   *      tree-sitter to interpret the namespace block as a function_definition,
   *      hiding real class/struct/enum nodes inside the "function body".
   */
export function visitFunctionBody(self: TreeSitterExtractor, body: SyntaxNode, _functionId: string): void {
    if (!self.extractor) return;

    const visitForCallsAndStructure = (node: SyntaxNode): void => {
      const nodeType = node.type;

      if (self.extractor!.callTypes.includes(nodeType)) {
        extractCall(self, node);
      } else if (isInstantiationNodeType(nodeType)) {
        // `new Foo()` inside a function body — emit an `instantiates`
        // reference. Without this branch the body walker only knew
        // about `call_expression`, so constructor invocations
        // produced no graph edges at all.
        extractInstantiation(self, node);
      } else if (self.extractor!.extractBareCall) {
        const calleeName = self.extractor!.extractBareCall(node, self.source);
        if (calleeName && self.nodeStack.length > 0) {
          const callerId = self.nodeStack[self.nodeStack.length - 1];
          if (callerId) {
            self.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: calleeName,
              referenceKind: 'calls',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
      }

      // Extract structural nodes found inside function bodies.
      // Each extract method visits its own children, so we return after extracting.
      if (self.extractor!.classTypes.includes(nodeType)) {
        const classification = self.extractor!.classifyClassNode?.(node) ?? 'class';
        if (classification === 'struct') extractStruct(self, node);
        else if (classification === 'enum') extractEnum(self, node);
        else if (classification === 'interface') extractInterface(self, node);
        else if (classification === 'trait') extractClass(self, node, 'trait');
        else extractClass(self, node);
        return;
      }
      if (self.extractor!.structTypes.includes(nodeType)) {
        extractStruct(self, node);
        return;
      }
      if (self.extractor!.enumTypes.includes(nodeType)) {
        extractEnum(self, node);
        return;
      }
      if (self.extractor!.interfaceTypes.includes(nodeType)) {
        extractInterface(self, node);
        return;
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          visitForCallsAndStructure(child);
        }
      }
    };

    visitForCallsAndStructure(body);
  }

  /**
   * Extract inheritance relationships
   */
export function extractInheritance(self: TreeSitterExtractor, node: SyntaxNode, classId: string): void {
    extractInheritanceReferences(
      node,
      classId,
      self.source,
      (ref) => self.unresolvedReferences.push(ref)
    );
  }

  /**
   * Rust `impl Trait for Type` — creates an implements edge from Type to Trait.
   * For plain `impl Type { ... }` (no trait), no inheritance edge is needed.
   */
export function extractRustImplItem(self: TreeSitterExtractor, node: SyntaxNode): void {
    // Check if this is `impl Trait for Type` by looking for a `for` keyword
    const hasFor = node.children.some(
      (c: SyntaxNode) => c.type === 'for' && !c.isNamed
    );
    if (!hasFor) return;

    // In `impl Trait for Type`, the type_identifiers are:
    // first = Trait name, last = implementing Type name
    // Also handle generic types like `impl<T> Trait for MyStruct<T>`
    const typeIdents = node.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
    );
    if (typeIdents.length < 2) return;

    const traitNode = typeIdents[0]!;
    const typeNode = typeIdents[typeIdents.length - 1]!;

    // Get the trait name (handle scoped paths like std::fmt::Display)
    const traitName = traitNode.type === 'scoped_type_identifier'
      ? self.source.substring(traitNode.startIndex, traitNode.endIndex)
      : getNodeText(traitNode, self.source);

    // Get the implementing type name (extract inner type_identifier for generics)
    let typeName: string;
    if (typeNode.type === 'generic_type') {
      const inner = typeNode.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_identifier'
      );
      typeName = inner ? getNodeText(inner, self.source) : getNodeText(typeNode, self.source);
    } else {
      typeName = getNodeText(typeNode, self.source);
    }

    // Find the struct/type node for the implementing type
    const typeNodeId = findNodeByName(self, typeName);
    if (typeNodeId) {
      self.unresolvedReferences.push({
        fromNodeId: typeNodeId,
        referenceName: traitName,
        referenceKind: 'implements',
        line: traitNode.startPosition.row + 1,
        column: traitNode.startPosition.column,
      });
    }
  }

  /**
   * Find a previously-extracted node by name (used for back-references like impl blocks)
   */
export function findNodeByName(self: TreeSitterExtractor, name: string): string | undefined {
    for (const node of self.nodes) {
      if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
        return node.id;
      }
    }
    return undefined;
  }
