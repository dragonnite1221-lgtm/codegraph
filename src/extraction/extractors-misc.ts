/**
 * Tree-sitter symbol extractors
 *
 * The per-construct extraction routines (functions, classes, methods, types,
 * imports, calls, etc.) split out of TreeSitterExtractor. Each takes the
 * extractor instance as `self` and mutates its node/edge buffers via the
 * exposed members. Kept here so the core TreeSitterExtractor (parse loop,
 * createNode, dispatch) stays readable.
 *
 * The short reference-emitting routines live in extractors-refs.ts; they are
 * re-exported below so every `./extractors-misc` import path is unchanged.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import { NodeKind } from '../types';
import { getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import { extractName, isInstantiationNodeType } from './tree-sitter-node-helpers';

import { extractTypeRefsFromSubtree, supportsTypeAnnotations } from './type-reference-extraction';

import type { TreeSitterExtractor } from './tree-sitter';
import { extractClass, extractEnum, extractEnumMembers, extractInterface, extractStruct } from './extractors-decl';
import { extractCall, extractInheritance, extractInstantiation } from './extractors-refs';

export {
  extractImport, extractCall, extractInstantiation, extractDecoratorsFor,
  extractInheritance, extractRustImplItem, findNodeByName,
} from './extractors-refs';

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
