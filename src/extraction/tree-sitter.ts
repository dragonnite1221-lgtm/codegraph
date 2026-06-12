/**
 * Tree-sitter Parser Wrapper
 *
 * Handles parsing source code and extracting structural information.
 */

import { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import * as path from 'path';
import {
  Language,
  Node,
  Edge,
  NodeKind,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
} from '../types';
import { getParser, detectLanguage, isLanguageSupported } from './grammars';
import { generateNodeId, getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
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
  visitPascalNode,
} from './pascal-extraction-helpers';
import {
  extractTypeAnnotationsFromDeclaration,
  extractTypeRefsFromSubtree,
  supportsTypeAnnotations,
} from './type-reference-extraction';
import { extractVariableDeclarations } from './variable-extraction';
import type { LanguageExtractor, ExtractorContext } from './tree-sitter-types';
import { EXTRACTORS } from './languages';
import { LiquidExtractor } from './liquid-extractor';
import { SvelteExtractor } from './svelte-extractor';
import { DfmExtractor } from './dfm-extractor';
import { VueExtractor } from './vue-extractor';
import {
  getAllFrameworkResolvers,
  getApplicableFrameworks,
} from '../resolution/frameworks';

// Re-export for backward compatibility
export { generateNodeId } from './tree-sitter-helpers';

/**
 * TreeSitterExtractor - Main extraction class
 */
export class TreeSitterExtractor {
  private filePath: string;
  private language: Language;
  private source: string;
  private tree: Tree | null = null;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private extractor: LanguageExtractor | null = null;
  private nodeStack: string[] = []; // Stack of parent node IDs
  private methodIndex: Map<string, string> | null = null; // lookup key → node ID for Pascal defProc lookup

  constructor(filePath: string, source: string, language?: Language) {
    this.filePath = filePath;
    this.source = source;
    this.language = language || detectLanguage(filePath, source);
    this.extractor = EXTRACTORS[this.language] || null;
  }

  /**
   * Parse and extract from the source code
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    if (!isLanguageSupported(this.language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Unsupported language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'unsupported_language',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    const parser = getParser(this.language);
    if (!parser) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to get parser for language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'parser_error',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    try {
      this.tree = parser.parse(this.source) ?? null;
      if (!this.tree) {
        throw new Error('Parser returned null tree');
      }

      // Create file node representing the source file
      const fileNode: Node = {
        id: `file:${this.filePath}`,
        kind: 'file',
        name: path.basename(this.filePath),
        qualifiedName: this.filePath,
        filePath: this.filePath,
        language: this.language,
        startLine: 1,
        endLine: this.source.split('\n').length,
        startColumn: 0,
        endColumn: 0,
        isExported: false,
        updatedAt: Date.now(),
      };
      this.nodes.push(fileNode);

      // Push file node onto stack so top-level declarations get contains edges
      this.nodeStack.push(fileNode.id);
      this.visitNode(this.tree.rootNode);
      this.nodeStack.pop();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // WASM memory errors leave the module in a corrupted state — all subsequent
      // parses would also fail. Re-throw so the worker can detect and crash,
      // forcing a clean restart with a fresh heap.
      if (msg.includes('memory access out of bounds') || msg.includes('out of memory')) {
        throw error;
      }

      this.errors.push({
        message: `Parse error: ${msg}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    } finally {
      // Free tree-sitter WASM memory immediately — trees hold native heap memory
      // invisible to V8's GC that accumulates across thousands of files.
      if (this.tree) {
        this.tree.delete();
        this.tree = null;
      }
      // Release source string to reduce GC pressure
      this.source = '';
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Visit a node and extract information
   */
  private visitNode(node: SyntaxNode): void {
    if (!this.extractor) return;

    const nodeType = node.type;
    let skipChildren = false;

    // Language-specific custom visitor hook
    if (this.extractor.visitNode) {
      const ctx = this.makeExtractorContext();
      const handled = this.extractor.visitNode(node, ctx);
      if (handled) return;
    }

    // Pascal-specific AST handling
    if (this.language === 'pascal') {
      skipChildren = visitPascalNode(node, {
        filePath: this.filePath,
        source: this.source,
        extractor: this.extractor,
        nodes: this.nodes,
        nodeStack: this.nodeStack,
        createNode: (kind, name, sourceNode, extra) =>
          this.createNode(kind, name, sourceNode, extra),
        visitNode: (sourceNode) => this.visitNode(sourceNode),
        addUnresolvedReference: (ref) => this.unresolvedReferences.push(ref),
        pushScope: (nodeId) => this.nodeStack.push(nodeId),
        popScope: () => this.nodeStack.pop(),
        getMethodIndex: () => this.methodIndex,
        setMethodIndex: (index) => {
          this.methodIndex = index;
        },
      });
      if (skipChildren) return;
    }

    // Check for function declarations
    // For Python/Ruby, function_definition inside a class should be treated as method
    if (this.extractor.functionTypes.includes(nodeType)) {
      if (this.isInsideClassLikeNode() && this.extractor.methodTypes.includes(nodeType)) {
        // Inside a class - treat as method
        this.extractMethod(node);
        skipChildren = true; // extractMethod visits children via visitFunctionBody
      } else {
        this.extractFunction(node);
        skipChildren = true; // extractFunction visits children via visitFunctionBody
      }
    }
    // Check for class declarations
    else if (this.extractor.classTypes.includes(nodeType)) {
      // Some languages reuse class_declaration for structs/enums (e.g. Swift)
      const classification = this.extractor.classifyClassNode?.(node) ?? 'class';
      if (classification === 'struct') {
        this.extractStruct(node);
      } else if (classification === 'enum') {
        this.extractEnum(node);
      } else if (classification === 'interface') {
        this.extractInterface(node);
      } else if (classification === 'trait') {
        this.extractClass(node, 'trait');
      } else {
        this.extractClass(node);
      }
      skipChildren = true; // extractClass visits body children
    }
    // Extra class node types (e.g. Dart mixin_declaration, extension_declaration)
    else if (this.extractor.extraClassNodeTypes?.includes(nodeType)) {
      this.extractClass(node);
      skipChildren = true;
    }
    // Check for method declarations (only if not already handled by functionTypes)
    else if (this.extractor.methodTypes.includes(nodeType)) {
      this.extractMethod(node);
      skipChildren = true; // extractMethod visits children via visitFunctionBody
    }
    // Check for interface/protocol/trait declarations
    else if (this.extractor.interfaceTypes.includes(nodeType)) {
      this.extractInterface(node);
      skipChildren = true; // extractInterface visits body children
    }
    // Check for struct declarations
    else if (this.extractor.structTypes.includes(nodeType)) {
      this.extractStruct(node);
      skipChildren = true; // extractStruct visits body children
    }
    // Check for enum declarations
    else if (this.extractor.enumTypes.includes(nodeType)) {
      this.extractEnum(node);
      skipChildren = true; // extractEnum visits body children
    }
    // Check for type alias declarations (e.g. `type X = ...` in TypeScript)
    // For Go, type_spec wraps struct/interface definitions — resolveTypeAliasKind
    // detects these and extractTypeAlias creates the correct node kind.
    else if (this.extractor.typeAliasTypes.includes(nodeType)) {
      skipChildren = this.extractTypeAlias(node);
    }
    // Check for class properties (e.g. C# property_declaration)
    else if (this.extractor.propertyTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractProperty(node);
      skipChildren = true;
    }
    // Check for class fields (e.g. Java field_declaration, C# field_declaration)
    else if (this.extractor.fieldTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractField(node);
      skipChildren = true;
    }
    // Check for variable declarations (const, let, var, etc.)
    // Only extract top-level variables (not inside functions/methods)
    else if (this.extractor.variableTypes.includes(nodeType) && !this.isInsideClassLikeNode()) {
      this.extractVariable(node);
      skipChildren = true; // extractVariable handles children
    }
    // `export_statement` itself is not extracted — the walker descends
    // into children, where the inner declaration (lexical_declaration,
    // function_declaration, class_declaration, etc.) is dispatched to
    // its own extractor. `isExported` walks the parent chain, so the
    // exported flag is preserved automatically.
    //
    // Calling extractExportedVariables here AND descending caused every
    // `export const X = ...` to produce two nodes for the same symbol —
    // one kind:'variable' from extractExportedVariables and one
    // kind:'constant' from extractVariable. The dedicated dispatch is
    // the correct one (it picks kind from isConst, captures the
    // initializer signature, and walks type annotations); the
    // export-statement helper was redundant.
    // Check for imports
    else if (this.extractor.importTypes.includes(nodeType)) {
      this.extractImport(node);
    }
    // Check for function calls
    else if (this.extractor.callTypes.includes(nodeType)) {
      this.extractCall(node);
    }
    // `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
    // produce an `instantiates` reference. Children still walked so
    // nested calls inside the constructor args (`new Foo(bar())`) get
    // their own `calls` refs.
    else if (isInstantiationNodeType(nodeType)) {
      this.extractInstantiation(node);
    }
    // (Decorator handling lives inside the symbol-creating extractors
    // — extractClass / extractFunction / extractProperty — because the
    // decorator node sits BEFORE the symbol in the AST and the walker
    // would otherwise see the wrong nodeStack head.)
    // Rust: `impl Trait for Type { ... }` — creates implements edge from Type to Trait
    else if (nodeType === 'impl_item') {
      this.extractRustImplItem(node);
    }

    // Visit children (unless the extract method already visited them)
    if (!skipChildren) {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          this.visitNode(child);
        }
      }
    }
  }

  /**
   * Create a Node object
   */
  private createNode(
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
  private findChildByTypes(node: SyntaxNode, types: string[]): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && types.includes(child.type)) return child;
    }
    return null;
  }

  /**
   * Build qualified name from node stack
   */
  private buildQualifiedName(name: string): string {
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
  private makeExtractorContext(): ExtractorContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      createNode: (kind, name, node, extra) => self.createNode(kind, name, node, extra),
      visitNode: (node) => self.visitNode(node),
      visitFunctionBody: (body, functionId) => self.visitFunctionBody(body, functionId),
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
  private isInsideClassLikeNode(): boolean {
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
  private extractFunction(node: SyntaxNode): void {
    if (!this.extractor) return;

    // If the language provides getReceiverType and this function has a receiver
    // (e.g., Rust function_item inside an impl block), extract as method instead
    if (this.extractor.getReceiverType?.(node, this.source)) {
      this.extractMethod(node);
      return;
    }

    let name = extractName(node, this.source, this.extractor);
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
          name = getNodeText(varName, this.source);
        }
      }
    }
    if (name === '<anonymous>') return; // Skip anonymous functions

    // Check for misparse artifacts (e.g. C++ macros causing "namespace detail" functions)
    // Skip the node but still visit the body for calls and structural nodes
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);

    const funcNode = this.createNode('function', name, node, {
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
      this.language,
      this.source,
      this.extractor,
      (ref) => this.unresolvedReferences.push(ref)
    );

    // Extract decorators applied to the function (rare in JS/TS but
    // present in Python `@decorator def f():` and Java/Kotlin
    // annotations on free functions).
    this.extractDecoratorsFor(node, funcNode.id);

    // Push to stack and visit body
    this.nodeStack.push(funcNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, funcNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a class
   */
  private extractClass(node: SyntaxNode, kind: NodeKind = 'class'): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const classNode = this.createNode(kind, name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!classNode) return;

    // Extract extends/implements
    this.extractInheritance(node, classNode.id);

    // Extract decorators applied to the class (`@Foo class X {}`).
    this.extractDecoratorsFor(node, classNode.id);

    // Push to stack and visit body
    this.nodeStack.push(classNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;

    // Visit all children for methods and properties
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a method
   */
  private extractMethod(node: SyntaxNode): void {
    if (!this.extractor) return;

    // For languages with receiver types (Go, Rust), include receiver in qualified name
    // so FTS can match "scrapeLoop.run" → qualified_name "...::scrapeLoop::run"
    const receiverType = this.extractor.getReceiverType?.(node, this.source);

    // For most languages, only extract as method if inside a class-like node
    // Languages with methodsAreTopLevel (e.g. Go) always treat them as methods
    // Languages with getReceiverType (e.g. Rust) extract as method when receiver is found
    if (!this.isInsideClassLikeNode() && !this.extractor.methodsAreTopLevel && !receiverType) {
      // Skip method_definition nodes inside object literals (getters/setters/methods
      // in inline objects). These are ephemeral and create noise (e.g., Svelte context
      // objects: `ctx.set({ get view() { ... } })`).
      if (node.parent?.type === 'object' || node.parent?.type === 'object_expression') {
        return;
      }
      // Not inside a class-like node and no receiver type, treat as function
      this.extractFunction(node);
      return;
    }

    const name = extractName(node, this.source, this.extractor);

    // Check for misparse artifacts (e.g. C++ "switch" inside macro-confused class body)
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);
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

    const methodNode = this.createNode('method', name, node, extraProps);
    if (!methodNode) return;

    // For methods with a receiver type but no class-like parent on the stack
    // (e.g., Rust impl blocks), add a contains edge from the owning struct/trait
    if (receiverType && !this.isInsideClassLikeNode()) {
      const ownerNode = this.nodes.find(
        (n) =>
          n.name === receiverType &&
          n.filePath === this.filePath &&
          (n.kind === 'struct' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait')
      );
      if (ownerNode) {
        this.edges.push({
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
      this.language,
      this.source,
      this.extractor,
      (ref) => this.unresolvedReferences.push(ref)
    );

    // Extract decorators (`@Get('/list') list() {}`).
    this.extractDecoratorsFor(node, methodNode.id);

    // Push to stack and visit body
    this.nodeStack.push(methodNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, methodNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an interface/protocol/trait
   */
  private extractInterface(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';

    const interfaceNode = this.createNode(kind, name, node, {
      docstring,
      isExported,
    });
    if (!interfaceNode) return;

    // Extract extends (interface inheritance)
    this.extractInheritance(node, interfaceNode.id);

    // Visit body children for interface methods and nested types
    this.nodeStack.push(interfaceNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a struct
   */
  private extractStruct(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Skip forward declarations and type references (no body = not a definition)
    const body = getChildByField(node, this.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const structNode = this.createNode('struct', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!structNode) return;

    // Extract inheritance (e.g. Swift: struct HTTPMethod: RawRepresentable)
    this.extractInheritance(node, structNode.id);

    // Push to stack for field extraction
    this.nodeStack.push(structNode.id);
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an enum
   */
  private extractEnum(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Skip forward declarations and type references (no body = not a definition)
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const enumNode = this.createNode('enum', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!enumNode) return;

    // Extract inheritance (e.g. Swift: enum AFError: Error)
    this.extractInheritance(node, enumNode.id);

    // Push to stack and visit body children (enum members, nested types, methods)
    this.nodeStack.push(enumNode.id);

    const memberTypes = this.extractor.enumMemberTypes;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;

      if (memberTypes?.includes(child.type)) {
        this.extractEnumMembers(child);
      } else {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract enum member names from an enum member node.
   * Handles multi-case declarations (Swift: `case put, delete`) and single-case patterns.
   */
  private extractEnumMembers(node: SyntaxNode): void {
    extractEnumMemberNodes(node, this.source, (kind, name, sourceNode, metadata) =>
      this.createNode(kind, name, sourceNode, metadata)
    );
  }

  /**
   * Extract a class property declaration (e.g. C# `public string Name { get; set; }`).
   * Extracts as 'property' kind node inside the owning class.
   */
  private extractProperty(node: SyntaxNode): void {
    if (!this.extractor) return;

    extractPropertyDeclaration({
      node,
      source: this.source,
      extractor: this.extractor,
      createNode: (kind, name, sourceNode, metadata) =>
        this.createNode(kind, name, sourceNode, metadata),
      extractDecoratorsFor: (declNode, decoratedId) =>
        this.extractDecoratorsFor(declNode, decoratedId),
    });
  }

  /**
   * Extract a class field declaration (e.g. Java field_declaration, C# field_declaration).
   * Extracts each declarator as a 'field' kind node inside the owning class.
   */
  private extractField(node: SyntaxNode): void {
    if (!this.extractor) return;

    extractFieldDeclaration({
      node,
      source: this.source,
      extractor: this.extractor,
      createNode: (kind, name, sourceNode, metadata) =>
        this.createNode(kind, name, sourceNode, metadata),
      extractDecoratorsFor: (declNode, decoratedId) =>
        this.extractDecoratorsFor(declNode, decoratedId),
    });
  }

  /**
   * Extract a variable declaration (const, let, var, etc.)
   *
   * Extracts top-level and module-level variable declarations.
   * Captures the variable name and first 100 chars of initializer in signature for searchability.
   */
  private extractVariable(node: SyntaxNode): void {
    if (!this.extractor) return;

    extractVariableDeclarations({
      node,
      source: this.source,
      language: this.language,
      extractor: this.extractor,
      createNode: (kind, name, sourceNode, metadata) =>
        this.createNode(kind, name, sourceNode, metadata),
      extractFunction: (functionNode) => this.extractFunction(functionNode),
      addReference: (ref) => this.unresolvedReferences.push(ref),
    });
  }

  /**
   * Extract a type alias (e.g. `export type X = ...` in TypeScript).
   * For languages like Go, resolveTypeAliasKind detects when the type_spec
   * wraps a struct or interface definition and creates the correct node kind.
   * Returns true if children should be skipped (struct/interface handled body visiting).
   */
  private extractTypeAlias(node: SyntaxNode): boolean {
    if (!this.extractor) return false;

    const name = extractName(node, this.source, this.extractor);
    if (name === '<anonymous>') return false;
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    // Check if this type alias is actually a struct or interface definition
    // (e.g. Go: `type Foo struct { ... }` is a type_spec wrapping struct_type)
    const resolvedKind = this.extractor.resolveTypeAliasKind?.(node, this.source);

    if (resolvedKind === 'struct') {
      const structNode = this.createNode('struct', name, node, { docstring, isExported });
      if (!structNode) return true;
      // Visit body children for field extraction
      this.nodeStack.push(structNode.id);
      // Try Go-style 'type' field first, then find inner struct child (C typedef struct)
      const typeChild = getChildByField(node, 'type')
        || this.findChildByTypes(node, this.extractor.structTypes);
      if (typeChild) {
        // Extract struct embedding (e.g. Go: `type DB struct { *Head; Queryable }`)
        this.extractInheritance(typeChild, structNode.id);
        const body = getChildByField(typeChild, this.extractor.bodyField) || typeChild;
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) this.visitNode(child);
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'enum') {
      const enumNode = this.createNode('enum', name, node, { docstring, isExported });
      if (!enumNode) return true;
      this.nodeStack.push(enumNode.id);
      // Find the inner enum type child (e.g. C: typedef enum { ... } name)
      const innerEnum = this.findChildByTypes(node, this.extractor.enumTypes);
      if (innerEnum) {
        this.extractInheritance(innerEnum, enumNode.id);
        const body = this.extractor.resolveBody?.(innerEnum, this.extractor.bodyField)
          ?? getChildByField(innerEnum, this.extractor.bodyField);
        if (body) {
          const memberTypes = this.extractor.enumMemberTypes;
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (!child) continue;
            if (memberTypes?.includes(child.type)) {
              this.extractEnumMembers(child);
            } else {
              this.visitNode(child);
            }
          }
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'interface') {
      const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';
      const interfaceNode = this.createNode(kind, name, node, { docstring, isExported });
      if (!interfaceNode) return true;
      // Extract interface inheritance from the inner type node
      const typeChild = getChildByField(node, 'type');
      if (typeChild) this.extractInheritance(typeChild, interfaceNode.id);
      return true;
    }

    const typeAliasNode = this.createNode('type_alias', name, node, {
      docstring,
      isExported,
    });

    // Extract type references from the alias value (e.g., `type X = ITextModel | null`)
    if (typeAliasNode && supportsTypeAnnotations(this.language)) {
      // The value is everything after the `=`, which is typically the last named child
      // In tree-sitter TS: type_alias_declaration has name + value children
      const value = getChildByField(node, 'value');
      if (value) {
        extractTypeRefsFromSubtree(
          value,
          this.source,
          typeAliasNode.id,
          (ref) => this.unresolvedReferences.push(ref)
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
  private extractImport(node: SyntaxNode): void {
    if (!this.extractor) return;

    extractImportDeclarations({
      node,
      source: this.source,
      language: this.language,
      extractor: this.extractor,
      parentId: this.nodeStack[this.nodeStack.length - 1],
      createImportNode: (moduleName, importNode, signature) => {
        this.createNode('import', moduleName, importNode, { signature });
      },
      addReference: (ref) => this.unresolvedReferences.push(ref),
    });
  }

  /**
   * Extract a function call
   */
  private extractCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;

    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    const ref = extractCallReference(node, this.source, callerId);
    if (ref) this.unresolvedReferences.push(ref);
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
  private extractInstantiation(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const fromId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromId) return;

    const className = extractInstantiationClassName(node, this.source);

    if (className) {
      this.unresolvedReferences.push({
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
  private extractDecoratorsFor(declNode: SyntaxNode, decoratedId: string): void {
    extractDecoratorReferences(
      declNode,
      decoratedId,
      this.source,
      (ref) => this.unresolvedReferences.push(ref)
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
  private visitFunctionBody(body: SyntaxNode, _functionId: string): void {
    if (!this.extractor) return;

    const visitForCallsAndStructure = (node: SyntaxNode): void => {
      const nodeType = node.type;

      if (this.extractor!.callTypes.includes(nodeType)) {
        this.extractCall(node);
      } else if (isInstantiationNodeType(nodeType)) {
        // `new Foo()` inside a function body — emit an `instantiates`
        // reference. Without this branch the body walker only knew
        // about `call_expression`, so constructor invocations
        // produced no graph edges at all.
        this.extractInstantiation(node);
      } else if (this.extractor!.extractBareCall) {
        const calleeName = this.extractor!.extractBareCall(node, this.source);
        if (calleeName && this.nodeStack.length > 0) {
          const callerId = this.nodeStack[this.nodeStack.length - 1];
          if (callerId) {
            this.unresolvedReferences.push({
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
      if (this.extractor!.classTypes.includes(nodeType)) {
        const classification = this.extractor!.classifyClassNode?.(node) ?? 'class';
        if (classification === 'struct') this.extractStruct(node);
        else if (classification === 'enum') this.extractEnum(node);
        else if (classification === 'interface') this.extractInterface(node);
        else if (classification === 'trait') this.extractClass(node, 'trait');
        else this.extractClass(node);
        return;
      }
      if (this.extractor!.structTypes.includes(nodeType)) {
        this.extractStruct(node);
        return;
      }
      if (this.extractor!.enumTypes.includes(nodeType)) {
        this.extractEnum(node);
        return;
      }
      if (this.extractor!.interfaceTypes.includes(nodeType)) {
        this.extractInterface(node);
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
  private extractInheritance(node: SyntaxNode, classId: string): void {
    extractInheritanceReferences(
      node,
      classId,
      this.source,
      (ref) => this.unresolvedReferences.push(ref)
    );
  }

  /**
   * Rust `impl Trait for Type` — creates an implements edge from Type to Trait.
   * For plain `impl Type { ... }` (no trait), no inheritance edge is needed.
   */
  private extractRustImplItem(node: SyntaxNode): void {
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
      ? this.source.substring(traitNode.startIndex, traitNode.endIndex)
      : getNodeText(traitNode, this.source);

    // Get the implementing type name (extract inner type_identifier for generics)
    let typeName: string;
    if (typeNode.type === 'generic_type') {
      const inner = typeNode.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_identifier'
      );
      typeName = inner ? getNodeText(inner, this.source) : getNodeText(typeNode, this.source);
    } else {
      typeName = getNodeText(typeNode, this.source);
    }

    // Find the struct/type node for the implementing type
    const typeNodeId = this.findNodeByName(typeName);
    if (typeNodeId) {
      this.unresolvedReferences.push({
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
  private findNodeByName(name: string): string | undefined {
    for (const node of this.nodes) {
      if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
        return node.id;
      }
    }
    return undefined;
  }

}


/**
 * Extract nodes and edges from source code.
 *
 * If `frameworkNames` is provided, framework-specific extractors matching
 * those names and the file's language are run after the tree-sitter pass.
 * Their nodes/references/errors are merged into the returned result.
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language,
  frameworkNames?: string[]
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  let result: ExtractionResult;

  // Use custom extractor for Svelte
  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'vue') {
    // Use custom extractor for Vue
    const extractor = new VueExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'liquid') {
    // Use custom extractor for Liquid
    const extractor = new LiquidExtractor(filePath, source);
    result = extractor.extract();
  } else if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    // Use custom extractor for DFM/FMX form files
    const extractor = new DfmExtractor(filePath, source);
    result = extractor.extract();
  } else {
    const extractor = new TreeSitterExtractor(filePath, source, detectedLanguage);
    result = extractor.extract();
  }

  // Framework-specific extraction (routes, middleware, etc.)
  if (frameworkNames && frameworkNames.length > 0) {
    const allResolvers = getAllFrameworkResolvers();
    const applicable = getApplicableFrameworks(
      allResolvers.filter((r) => frameworkNames.includes(r.name)),
      detectedLanguage
    );
    for (const fw of applicable) {
      if (!fw.extract) continue;
      try {
        const fwResult = fw.extract(filePath, source);
        result.nodes.push(...fwResult.nodes);
        result.unresolvedReferences.push(...fwResult.references);
      } catch (err) {
        result.errors.push({
          message: `Framework extractor '${fw.name}' failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          filePath,
          severity: 'warning',
        });
      }
    }
  }

  return result;
}
