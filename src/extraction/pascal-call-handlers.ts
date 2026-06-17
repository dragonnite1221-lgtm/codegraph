/**
 * Pascal call/procedure handlers: defProc implementation bodies, call
 * expressions, and block traversal. Split out of pascal-extraction-helpers.ts
 * to stay within the file-size gate. Called from the visitPascalNode dispatch.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import {
  PascalVisitorContext,
  buildPascalMethodIndex,
  extractPascalCallName,
  extractPascalDefProcName,
  resolvePascalDefProcParentId,
  visitPascalCallExpressions,
} from './pascal-extraction-helpers';

/**
 * Extract calls and resolve method context from a Pascal defProc implementation body.
 */
export function extractPascalDefProc(node: SyntaxNode, ctx: PascalVisitorContext): void {
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
export function extractPascalCall(node: SyntaxNode, ctx: PascalVisitorContext): void {
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
export function visitPascalBlock(node: SyntaxNode, ctx: PascalVisitorContext): void {
  visitPascalCallExpressions(node, (callNode) => extractPascalCall(callNode, ctx));
}
