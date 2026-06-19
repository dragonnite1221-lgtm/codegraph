/**
 * Context builder helpers
 *
 * Subgraph-derived assembly used by ContextBuilder. Code extraction lives in
 * context-code.ts and final subgraph assembly in context-assemble.ts (with its
 * trim phases in context-assemble-trim.ts); this module keeps the small
 * subgraph accessors + summary and re-exports the rest for stable import paths.
 */

import type { Node, Subgraph } from '../types';

export { extractNodeCode, extractCodeBlocks } from './context-code';
export { assembleContextSubgraph, resolveImportsToDefinitions } from './context-assemble';

/** Get entry points from a subgraph (the root nodes). */
export function getEntryPoints(subgraph: Subgraph): Node[] {
  return subgraph.roots
    .map((id) => subgraph.nodes.get(id))
    .filter((n): n is Node => n !== undefined);
}

/** Get unique files from a subgraph (sorted). */
export function getRelatedFiles(subgraph: Subgraph): string[] {
  const files = new Set<string>();
  for (const node of subgraph.nodes.values()) {
    files.add(node.filePath);
  }
  return Array.from(files).sort();
}

/** Generate a one-line summary of the context. */
export function generateSummary(_query: string, subgraph: Subgraph, entryPoints: Node[]): string {
  const nodeCount = subgraph.nodes.size;
  const edgeCount = subgraph.edges.length;
  const files = getRelatedFiles(subgraph);

  const entryPointNames = entryPoints
    .slice(0, 3)
    .map((n) => n.name)
    .join(', ');

  const remaining = entryPoints.length > 3 ? ` and ${entryPoints.length - 3} more` : '';

  return `Found ${nodeCount} relevant code symbols across ${files.length} files. ` +
    `Key entry points: ${entryPointNames}${remaining}. ` +
    `${edgeCount} relationships identified.`;
}
