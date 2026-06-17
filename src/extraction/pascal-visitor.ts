/**
 * Pascal AST dispatch. visitPascalNode maps each Pascal node type to its
 * handler (in pascal-decl-handlers / pascal-call-handlers) or handles simple
 * container/member nodes inline. Split out of pascal-extraction-helpers.ts to
 * stay within the file-size gate.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import * as path from 'path';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { PascalVisitorContext } from './pascal-extraction-helpers';
import {
  extractPascalConst,
  extractPascalDeclType,
  extractPascalUses,
} from './pascal-decl-handlers';
import {
  extractPascalCall,
  extractPascalDefProc,
  visitPascalBlock,
} from './pascal-call-handlers';

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
