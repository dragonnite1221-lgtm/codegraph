/**
 * AST dispatch for TreeSitterExtractor: maps each node type to its per-construct
 * extractor (custom hook → Pascal → functions/classes/methods/types/imports/
 * calls), then walks children unless the extractor already did. Split out of
 * tree-sitter.ts to stay within the file-size gate.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { isInstantiationNodeType } from './tree-sitter-node-helpers';
import { visitPascalNode } from './pascal-visitor';
import {
  extractFunction, extractClass, extractMethod, extractInterface, extractStruct,
  extractEnum, extractProperty, extractField, extractVariable,
  extractTypeAlias, extractImport, extractCall, extractInstantiation,
  extractRustImplItem,
} from './extractors';
import type { TreeSitterExtractor } from './tree-sitter';

/** Visit a node and extract information, then recurse into children. */
export function visitNode(self: TreeSitterExtractor, node: SyntaxNode): void {
  if (!self.extractor) return;

  const nodeType = node.type;
  let skipChildren = false;

  // Language-specific custom visitor hook
  if (self.extractor.visitNode) {
    const ctx = self.makeExtractorContext();
    const handled = self.extractor.visitNode(node, ctx);
    if (handled) return;
  }

  // Pascal-specific AST handling
  if (self.language === 'pascal') {
    skipChildren = visitPascalNode(node, {
      filePath: self.filePath,
      source: self.source,
      extractor: self.extractor,
      nodes: self.nodes,
      nodeStack: self.nodeStack,
      createNode: (kind, name, sourceNode, extra) =>
        self.createNode(kind, name, sourceNode, extra),
      visitNode: (sourceNode) => self.visitNode(sourceNode),
      addUnresolvedReference: (ref) => self.unresolvedReferences.push(ref),
      pushScope: (nodeId) => self.nodeStack.push(nodeId),
      popScope: () => self.nodeStack.pop(),
      getMethodIndex: () => self.methodIndex,
      setMethodIndex: (index) => {
        self.methodIndex = index;
      },
    });
    if (skipChildren) return;
  }

  // Check for function declarations
  // For Python/Ruby, function_definition inside a class should be treated as method
  if (self.extractor.functionTypes.includes(nodeType)) {
    if (self.isInsideClassLikeNode() && self.extractor.methodTypes.includes(nodeType)) {
      // Inside a class - treat as method
      extractMethod(self, node);
      skipChildren = true; // extractMethod visits children via visitFunctionBody
    } else {
      extractFunction(self, node);
      skipChildren = true; // extractFunction visits children via visitFunctionBody
    }
  }
  // Check for class declarations
  else if (self.extractor.classTypes.includes(nodeType)) {
    // Some languages reuse class_declaration for structs/enums (e.g. Swift)
    const classification = self.extractor.classifyClassNode?.(node) ?? 'class';
    if (classification === 'struct') {
      extractStruct(self, node);
    } else if (classification === 'enum') {
      extractEnum(self, node);
    } else if (classification === 'interface') {
      extractInterface(self, node);
    } else if (classification === 'trait') {
      extractClass(self, node, 'trait');
    } else {
      extractClass(self, node);
    }
    skipChildren = true; // extractClass visits body children
  }
  // Extra class node types (e.g. Dart mixin_declaration, extension_declaration)
  else if (self.extractor.extraClassNodeTypes?.includes(nodeType)) {
    extractClass(self, node);
    skipChildren = true;
  }
  // Check for method declarations (only if not already handled by functionTypes)
  else if (self.extractor.methodTypes.includes(nodeType)) {
    extractMethod(self, node);
    skipChildren = true; // extractMethod visits children via visitFunctionBody
  }
  // Check for interface/protocol/trait declarations
  else if (self.extractor.interfaceTypes.includes(nodeType)) {
    extractInterface(self, node);
    skipChildren = true; // extractInterface visits body children
  }
  // Check for struct declarations
  else if (self.extractor.structTypes.includes(nodeType)) {
    extractStruct(self, node);
    skipChildren = true; // extractStruct visits body children
  }
  // Check for enum declarations
  else if (self.extractor.enumTypes.includes(nodeType)) {
    extractEnum(self, node);
    skipChildren = true; // extractEnum visits body children
  }
  // Check for type alias declarations (e.g. `type X = ...` in TypeScript)
  // For Go, type_spec wraps struct/interface definitions — resolveTypeAliasKind
  // detects these and extractTypeAlias creates the correct node kind.
  else if (self.extractor.typeAliasTypes.includes(nodeType)) {
    skipChildren = extractTypeAlias(self, node);
  }
  // Check for class properties (e.g. C# property_declaration)
  else if (self.extractor.propertyTypes?.includes(nodeType) && self.isInsideClassLikeNode()) {
    extractProperty(self, node);
    skipChildren = true;
  }
  // Check for class fields (e.g. Java field_declaration, C# field_declaration)
  else if (self.extractor.fieldTypes?.includes(nodeType) && self.isInsideClassLikeNode()) {
    extractField(self, node);
    skipChildren = true;
  }
  // Check for variable declarations (const, let, var, etc.)
  // Only extract top-level variables (not inside functions/methods)
  else if (self.extractor.variableTypes.includes(nodeType) && !self.isInsideClassLikeNode()) {
    extractVariable(self, node);
    skipChildren = true; // extractVariable handles children
  }
  // `export_statement` itself is not extracted — the walker descends into
  // children, where the inner declaration is dispatched to its own extractor.
  // `isExported` walks the parent chain, so the exported flag is preserved.
  // Check for imports
  else if (self.extractor.importTypes.includes(nodeType)) {
    extractImport(self, node);
  }
  // Check for function calls
  else if (self.extractor.callTypes.includes(nodeType)) {
    extractCall(self, node);
  }
  // `new Foo(...)` / `Foo::new(...)` / object_creation_expression — produce an
  // `instantiates` reference. Children still walked so nested calls inside the
  // constructor args (`new Foo(bar())`) get their own `calls` refs.
  else if (isInstantiationNodeType(nodeType)) {
    extractInstantiation(self, node);
  }
  // (Decorator handling lives inside the symbol-creating extractors — the
  // decorator node sits BEFORE the symbol in the AST.)
  // Rust: `impl Trait for Type { ... }` — creates implements edge from Type to Trait
  else if (nodeType === 'impl_item') {
    extractRustImplItem(self, node);
  }

  // Visit children (unless the extract method already visited them)
  if (!skipChildren) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        self.visitNode(child);
      }
    }
  }
}
