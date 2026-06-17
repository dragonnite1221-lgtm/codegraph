/**
 * Reference-emitting tree-sitter extractors.
 *
 * The short per-construct routines that push unresolved references onto the
 * extractor (imports, calls, instantiations, decorators, inheritance, Rust
 * impl blocks) plus the name back-reference helper. Split out of
 * extractors-misc.ts to stay within the file-size gate; re-exported from
 * extractors-misc.ts so import paths are unchanged. Each takes the extractor
 * instance as `self`.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from './tree-sitter-helpers';
import { extractInstantiationClassName } from './tree-sitter-node-helpers';
import { extractCallReference } from './call-extraction';
import { extractDecoratorReferences } from './decorator-extraction';
import { extractInheritanceReferences } from './inheritance-extraction';
import { extractImportDeclarations } from './import-extraction';

import type { TreeSitterExtractor } from './tree-sitter';

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
