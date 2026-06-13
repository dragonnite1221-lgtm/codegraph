import type { Node as SyntaxNode } from 'web-tree-sitter';
import * as path from 'path';

import type { Node, NodeKind, UnresolvedReference } from '../types';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { LanguageExtractor } from './tree-sitter-types';

type AddReference = (ref: UnresolvedReference) => void;

export interface PascalVisitorContext {
  filePath: string;
  source: string;
  extractor: LanguageExtractor;
  nodes: readonly Node[];
  nodeStack: string[];
  createNode(kind: NodeKind, name: string, node: SyntaxNode, extra?: Partial<Node>): Node | null;
  visitNode(node: SyntaxNode): void;
  addUnresolvedReference(ref: UnresolvedReference): void;
  pushScope(nodeId: string): void;
  popScope(): void;
  getMethodIndex(): Map<string, string> | null;
  setMethodIndex(index: Map<string, string>): void;
}

export type PascalDefProcName = {
  fullName: string;
  fullNameKey: string;
  shortNameKey: string;
};

export function buildPascalMethodIndex(nodes: readonly Node[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === 'method' || node.kind === 'function') {
      const nameKey = node.name.toLowerCase();
      // Keep first seen short-name mapping to avoid silently overwriting earlier entries.
      if (!index.has(nameKey)) {
        index.set(nameKey, node.id);
      }

      // For Pascal methods, also index qualified forms (e.g. TAuthService.Create).
      if (node.kind === 'method') {
        const qualifiedParts = node.qualifiedName.split('::');
        if (qualifiedParts.length >= 2) {
          // Create suffix keys so both "Module.Class.Method" and "Class.Method" can resolve.
          for (let i = 0; i < qualifiedParts.length - 1; i++) {
            const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
            index.set(scopedName, node.id);
          }
        }
      }
    }
  }
  return index;
}

export function extractPascalDefProcName(
  node: SyntaxNode,
  source: string
): PascalDefProcName | null {
  const declProc = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'declProc'
  );
  if (!declProc) return null;

  const nameNode = getChildByField(declProc, 'name');
  if (!nameNode) return null;

  const fullName = getNodeText(nameNode, source).trim();
  const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
  return {
    fullName,
    fullNameKey: fullName.toLowerCase(),
    shortNameKey: shortName.toLowerCase(),
  };
}

export function resolvePascalDefProcParentId(
  procName: PascalDefProcName,
  methodIndex: ReadonlyMap<string, string>,
  fallbackParentId?: string
): string | undefined {
  return (
    methodIndex.get(procName.fullNameKey) ||
    methodIndex.get(procName.shortNameKey) ||
    fallbackParentId
  );
}

export function extractPascalInheritanceReferences(
  declClass: SyntaxNode,
  classId: string,
  source: string,
  addReference: AddReference
): void {
  const typerefs = declClass.namedChildren.filter(
    (child: SyntaxNode) => child.type === 'typeref'
  );
  for (let i = 0; i < typerefs.length; i++) {
    const ref = typerefs[i]!;
    addReference({
      fromNodeId: classId,
      referenceName: getNodeText(ref, source),
      referenceKind: i === 0 ? 'extends' : 'implements',
      line: ref.startPosition.row + 1,
      column: ref.startPosition.column,
    });
  }
}

export function extractPascalCallName(node: SyntaxNode, source: string): string | undefined {
  const firstChild = node.namedChild(0);
  if (!firstChild) return undefined;

  if (firstChild.type === 'exprDot') {
    const identifiers = firstChild.namedChildren.filter(
      (child: SyntaxNode) => child.type === 'identifier'
    );
    if (identifiers.length > 0) {
      return identifiers.map((identifier: SyntaxNode) => getNodeText(identifier, source)).join('.');
    }
    return undefined;
  }

  if (firstChild.type === 'identifier') {
    return getNodeText(firstChild, source);
  }

  return undefined;
}

export function visitPascalCallExpressions(
  node: SyntaxNode,
  visitCall: (callNode: SyntaxNode) => void
): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'exprCall') {
      visitCall(child);
    } else if (child.type === 'exprDot') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const grandchild = child.namedChild(j);
        if (grandchild?.type === 'exprCall') {
          visitCall(grandchild);
        }
      }
    } else {
      visitPascalCallExpressions(child, visitCall);
    }
  }
}

/**
 * Handle Pascal-specific AST structures.
 * Returns true if the node was fully handled and children should be skipped.
 */
export function visitPascalNode(node: SyntaxNode, ctx: PascalVisitorContext): boolean {
  const nodeType = node.type;

  // Unit/Program/Library -> module node
  if (nodeType === 'unit' || nodeType === 'program' || nodeType === 'library') {
    const moduleNameNode = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'moduleName'
    );
    const name = moduleNameNode ? getNodeText(moduleNameNode, ctx.source) : '';
    // Fallback to filename without extension if module name is empty
    const moduleName = name || path.basename(ctx.filePath).replace(/\.[^.]+$/, '');
    ctx.createNode('module', moduleName, node);
    // Continue visiting children (interface/implementation sections)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    return true;
  }

  // declType wraps declClass/declIntf/declEnum/type-alias
  // The name lives on declType, the inner node determines the kind
  if (nodeType === 'declType') {
    extractPascalDeclType(node, ctx);
    return true;
  }

  // declUses -> import nodes for each unit name
  if (nodeType === 'declUses') {
    extractPascalUses(node, ctx);
    return true;
  }

  // declConsts -> container; visit children for individual declConst
  if (nodeType === 'declConsts') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'declConst') {
        extractPascalConst(child, ctx);
      }
    }
    return true;
  }

  // declConst at top level (outside declConsts)
  if (nodeType === 'declConst') {
    extractPascalConst(node, ctx);
    return true;
  }

  // declTypes -> container for type declarations
  if (nodeType === 'declTypes') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    return true;
  }

  // declVars -> container for variable declarations
  if (nodeType === 'declVars') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'declVar') {
        const nameNode = getChildByField(child, 'name');
        if (nameNode) {
          const name = getNodeText(nameNode, ctx.source);
          ctx.createNode('variable', name, child);
        }
      }
    }
    return true;
  }

  // defProc in implementation section -> extract calls but don't create duplicate nodes
  if (nodeType === 'defProc') {
    extractPascalDefProc(node, ctx);
    return true;
  }

  // declProp -> property node
  if (nodeType === 'declProp') {
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      const name = getNodeText(nameNode, ctx.source);
      const visibility = ctx.extractor.getVisibility?.(node);
      ctx.createNode('property', name, node, { visibility });
    }
    return true;
  }

  // declField -> field node
  if (nodeType === 'declField') {
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      const name = getNodeText(nameNode, ctx.source);
      const visibility = ctx.extractor.getVisibility?.(node);
      ctx.createNode('field', name, node, { visibility });
    }
    return true;
  }

  // declSection -> visit children (propagates visibility via getVisibility)
  if (nodeType === 'declSection') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    return true;
  }

  // exprCall -> extract function call reference
  if (nodeType === 'exprCall') {
    extractPascalCall(node, ctx);
    return true;
  }

  // interface/implementation sections -> visit children
  if (nodeType === 'interface' || nodeType === 'implementation') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    return true;
  }

  // block (begin..end) -> visit for calls
  if (nodeType === 'block') {
    visitPascalBlock(node, ctx);
    return true;
  }

  return false;
}

/**
 * Extract a Pascal declType node (class, interface, enum, or type alias).
 */
function extractPascalDeclType(node: SyntaxNode, ctx: PascalVisitorContext): void {
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
function extractPascalUses(node: SyntaxNode, ctx: PascalVisitorContext): void {
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
function extractPascalConst(node: SyntaxNode, ctx: PascalVisitorContext): void {
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
function extractPascalInheritance(
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

/**
 * Extract calls and resolve method context from a Pascal defProc implementation body.
 */
function extractPascalDefProc(node: SyntaxNode, ctx: PascalVisitorContext): void {
  const procName = extractPascalDefProcName(node, ctx.source);
  if (!procName) return;

  let methodIndex = ctx.getMethodIndex();
  if (!methodIndex) {
    methodIndex = buildPascalMethodIndex(ctx.nodes);
    ctx.setMethodIndex(methodIndex);
  }

  const parentId = resolvePascalDefProcParentId(
    procName,
    methodIndex,
    ctx.nodeStack[ctx.nodeStack.length - 1]
  );
  if (!parentId) return;

  // Visit the block for calls
  const block = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'block'
  );
  if (block) {
    ctx.pushScope(parentId);
    visitPascalBlock(block, ctx);
    ctx.popScope();
  }
}

/**
 * Extract function calls from a Pascal expression.
 */
function extractPascalCall(node: SyntaxNode, ctx: PascalVisitorContext): void {
  if (ctx.nodeStack.length === 0) return;
  const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!callerId) return;

  const calleeName = extractPascalCallName(node, ctx.source);

  if (calleeName) {
    ctx.addUnresolvedReference({
      fromNodeId: callerId,
      referenceName: calleeName,
      referenceKind: 'calls',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  // Also visit arguments for nested calls
  const args = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'exprArgs'
  );
  if (args) {
    visitPascalBlock(args, ctx);
  }
}

/**
 * Recursively visit a Pascal block/statement tree for call expressions.
 */
function visitPascalBlock(node: SyntaxNode, ctx: PascalVisitorContext): void {
  visitPascalCallExpressions(node, (callNode) => extractPascalCall(callNode, ctx));
}
