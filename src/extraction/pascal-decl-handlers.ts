/**
 * Pascal declaration handlers: type declarations (class/interface/enum/alias),
 * uses clauses, constants, and inheritance. Split out of
 * pascal-extraction-helpers.ts to stay within the file-size gate. Called from
 * the visitPascalNode dispatch.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import {
  PascalVisitorContext,
  extractPascalInheritanceReferences,
} from './pascal-extraction-helpers';

/**
 * Extract a Pascal declType node (class, interface, enum, or type alias).
 */
export function extractPascalDeclType(node: SyntaxNode, ctx: PascalVisitorContext): void {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, ctx.source);

  // Find the inner type declaration
  const declClass = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'declClass'
  );
  const declIntf = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'declIntf'
  );
  const typeChild = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'type'
  );

  if (declClass) {
    const classNode = ctx.createNode('class', name, node);
    if (classNode) {
      // Extract inheritance from typeref children of declClass
      extractPascalInheritance(declClass, classNode.id, ctx);
      // Visit class body
      ctx.pushScope(classNode.id);
      for (let i = 0; i < declClass.namedChildCount; i++) {
        const child = declClass.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      ctx.popScope();
    }
  } else if (declIntf) {
    const ifaceNode = ctx.createNode('interface', name, node);
    if (ifaceNode) {
      // Visit interface members
      ctx.pushScope(ifaceNode.id);
      for (let i = 0; i < declIntf.namedChildCount; i++) {
        const child = declIntf.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      ctx.popScope();
    }
  } else if (typeChild) {
    // Check if it contains a declEnum
    const declEnum = typeChild.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declEnum'
    );
    if (declEnum) {
      const enumNode = ctx.createNode('enum', name, node);
      if (enumNode) {
        // Extract enum members
        ctx.pushScope(enumNode.id);
        for (let i = 0; i < declEnum.namedChildCount; i++) {
          const child = declEnum.namedChild(i);
          if (child?.type === 'declEnumValue') {
            const memberName = getChildByField(child, 'name');
            if (memberName) {
              ctx.createNode('enum_member', getNodeText(memberName, ctx.source), child);
            }
          }
        }
        ctx.popScope();
      }
    } else {
      // Simple type alias: type TFoo = string / type TFoo = Integer
      ctx.createNode('type_alias', name, node);
    }
  } else {
    // Fallback: could be a forward declaration or simple alias
    ctx.createNode('type_alias', name, node);
  }
}

/**
 * Extract Pascal uses clause into individual import nodes.
 */
export function extractPascalUses(node: SyntaxNode, ctx: PascalVisitorContext): void {
  const importText = getNodeText(node, ctx.source).trim();
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'moduleName') {
      const unitName = getNodeText(child, ctx.source);
      ctx.createNode('import', unitName, child, {
        signature: importText,
      });
      // Create unresolved reference for resolution
      if (ctx.nodeStack.length > 0) {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (parentId) {
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: unitName,
            referenceKind: 'imports',
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
        }
      }
    }
  }
}

/**
 * Extract a Pascal constant declaration.
 */
export function extractPascalConst(node: SyntaxNode, ctx: PascalVisitorContext): void {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, ctx.source);
  const defaultValue = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'defaultValue'
  );
  const sig = defaultValue ? getNodeText(defaultValue, ctx.source) : undefined;
  ctx.createNode('constant', name, node, { signature: sig });
}

/**
 * Extract Pascal inheritance (extends/implements) from declClass typeref children.
 */
export function extractPascalInheritance(
  declClass: SyntaxNode,
  classId: string,
  ctx: PascalVisitorContext
): void {
  extractPascalInheritanceReferences(
    declClass,
    classId,
    ctx.source,
    (ref) => ctx.addUnresolvedReference(ref)
  );
}
