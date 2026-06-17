/**
 * Import/variable info interfaces split out of tree-sitter-types.ts to keep
 * it within the 200-line limit. Re-exported from tree-sitter-types for
 * backward-compatible import paths.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import type { NodeKind } from '../types';

/**
 * Information returned by a language's extractImport hook.
 */
export interface ImportInfo {
  /** The module/package name being imported */
  moduleName: string;
  /** Full import statement text for display */
  signature: string;
  /** If true, the hook already created unresolved references itself */
  handledRefs?: boolean;
}

/**
 * Information about a single variable within a declaration.
 * Returned by a language's extractVariables hook.
 */
export interface VariableInfo {
  /** Variable name */
  name: string;
  /** Node kind: 'variable' or 'constant' */
  kind: NodeKind;
  /** Optional signature string */
  signature?: string;
  /** If set, this declarator is actually a function and should be extracted as such */
  delegateToFunction?: SyntaxNode;
  /** The AST node to use for positioning (may differ from the declaration node) */
  positionNode?: SyntaxNode;
}
