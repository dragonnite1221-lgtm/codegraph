/**
 * Subgraph assembly trimming phases: BFS expansion from entry points, max-node
 * trimming, per-file / non-production diversity caps, and edge recovery. Split
 * out of context-helpers.ts to stay within the file-size gate. Each phase
 * mutates the shared node/edge/root accumulators.
 */

import type {
  Edge,
  EdgeKind,
  FindRelevantContextOptions,
  Node,
  SearchResult,
} from '../types';
import type { QueryBuilder } from '../db/queries';
import type { GraphTraverser } from '../graph';
import { isTestFile } from '../search/query-utils';

/** Traverse from each entry point (BFS), merging nodes + edges. */
export function traverseEntryPoints(
  nodes: Map<string, Node>,
  edges: Edge[],
  filteredResults: SearchResult[],
  opts: Required<FindRelevantContextOptions>,
  traverser: GraphTraverser
): void {
  for (const result of filteredResults) {
    const traversalResult = traverser.traverseBFS(result.node.id, {
      maxDepth: opts.traversalDepth,
      edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
      nodeKinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
      direction: 'both',
      limit: Math.ceil(opts.maxNodes / Math.max(1, filteredResults.length)),
    });

    // Merge nodes
    for (const [id, node] of traversalResult.nodes) {
      if (!nodes.has(id)) {
        nodes.set(id, node);
      }
    }

    // Merge edges (avoid duplicates)
    for (const edge of traversalResult.edges) {
      const exists = edges.some(
        (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
      );
      if (!exists) {
        edges.push(edge);
      }
    }
  }
}

/** Trim to opts.maxNodes, prioritizing entry points + their direct neighbors. */
export function trimToMaxNodes(
  nodes: Map<string, Node>,
  edges: Edge[],
  roots: string[],
  opts: Required<FindRelevantContextOptions>
): { finalNodes: Map<string, Node>; finalEdges: Edge[] } {
  if (nodes.size <= opts.maxNodes) {
    return { finalNodes: nodes, finalEdges: edges };
  }

  // Prioritize entry points and their direct neighbors
  const priorityIds = new Set(roots);
  for (const edge of edges) {
    if (priorityIds.has(edge.source)) priorityIds.add(edge.target);
    if (priorityIds.has(edge.target)) priorityIds.add(edge.source);
  }

  // Keep priority nodes, then fill remaining slots
  const finalNodes = new Map<string, Node>();
  for (const id of priorityIds) {
    const node = nodes.get(id);
    if (node && finalNodes.size < opts.maxNodes) {
      finalNodes.set(id, node);
    }
  }

  // Fill remaining from other nodes
  for (const [id, node] of nodes) {
    if (finalNodes.size >= opts.maxNodes) break;
    if (!finalNodes.has(id)) {
      finalNodes.set(id, node);
    }
  }

  // Filter edges to only include kept nodes
  const finalEdges = edges.filter((e) => finalNodes.has(e.source) && finalNodes.has(e.target));
  return { finalNodes, finalEdges };
}

/** Per-file diversity cap + non-production node cap (mutates finalNodes + roots). */
export function applyDiversityCaps(
  finalNodes: Map<string, Node>,
  roots: string[],
  opts: Required<FindRelevantContextOptions>,
  isTestQuery: boolean
): void {
  // Per-file diversity cap: prevent any single file from monopolizing the
  // node budget. Cap each file to ~20% to ensure cross-file diversity.
  const maxPerFile = Math.max(5, Math.ceil(opts.maxNodes * 0.2));
  const fileCounts = new Map<string, string[]>();
  for (const [id, node] of finalNodes) {
    const ids = fileCounts.get(node.filePath) || [];
    ids.push(id);
    fileCounts.set(node.filePath, ids);
  }
  const rootSet = new Set(roots);
  for (const [, nodeIds] of fileCounts) {
    if (nodeIds.length <= maxPerFile) continue;
    // Sort: entry points first, then classes/interfaces, then others
    const kindPriority: Record<string, number> = {
      class: 3, interface: 3, struct: 3, trait: 3, protocol: 3, enum: 3,
      method: 1, function: 1, property: 0, field: 0, variable: 0,
    };
    nodeIds.sort((a, b) => {
      const aRoot = rootSet.has(a) ? 10 : 0;
      const bRoot = rootSet.has(b) ? 10 : 0;
      const aKind = kindPriority[finalNodes.get(a)!.kind] ?? 0;
      const bKind = kindPriority[finalNodes.get(b)!.kind] ?? 0;
      return (bRoot + bKind) - (aRoot + aKind);
    });
    // Remove excess nodes (keep the highest-priority ones)
    for (const id of nodeIds.slice(maxPerFile)) {
      finalNodes.delete(id);
    }
  }

  // Non-production node cap: limit test/sample/example files to ~15% of budget.
  // Test entry points are NOT exempt — they should be evicted too.
  if (!isTestQuery) {
    const maxNonProd = Math.max(3, Math.ceil(opts.maxNodes * 0.15));
    const nonProdIds: string[] = [];
    for (const [id, node] of finalNodes) {
      if (isTestFile(node.filePath)) {
        nonProdIds.push(id);
      }
    }
    if (nonProdIds.length > maxNonProd) {
      for (const id of nonProdIds.slice(maxNonProd)) {
        finalNodes.delete(id);
        // Also remove from roots — test file entry points shouldn't anchor results
        const rootIdx = roots.indexOf(id);
        if (rootIdx !== -1) roots.splice(rootIdx, 1);
      }
    }
  }
}

/** Edge recovery: discover edges between already-selected nodes (mutates finalEdges). */
export function recoverEdges(
  finalNodes: Map<string, Node>,
  finalEdges: Edge[],
  queries: QueryBuilder
): void {
  const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
  const recoveredEdges = queries.findEdgesBetweenNodes([...finalNodes.keys()], recoveryKinds);
  const existingEdgeKeys = new Set(finalEdges.map((e) => `${e.source}:${e.target}:${e.kind}`));
  for (const edge of recoveredEdges) {
    const key = `${edge.source}:${edge.target}:${edge.kind}`;
    if (!existingEdgeKeys.has(key)) {
      finalEdges.push(edge);
      existingEdgeKeys.add(key);
    }
  }
}
