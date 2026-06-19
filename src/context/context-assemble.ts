/**
 * Final context-subgraph assembly: import→definition resolution, type-hierarchy
 * expansion, and the orchestrator that wires the traversal/trim phases (in
 * context-assemble-trim.ts). Split out of context-helpers.ts for the file-size
 * gate.
 */

import type {
  Edge,
  EdgeKind,
  FindRelevantContextOptions,
  Node,
  SearchResult,
  Subgraph,
} from '../types';
import type { QueryBuilder } from '../db/queries';
import type { GraphTraverser } from '../graph';
import { logDebug } from '../errors';
import {
  applyDiversityCaps,
  recoverEdges,
  traverseEntryPoints,
  trimToMaxNodes,
} from './context-assemble-trim';

/**
 * Resolve import/export nodes to their actual definitions. When search returns
 * `import { TerminalPanel }`, users want the TerminalPanel class definition, not
 * the import — follow the `imports`/`exports` edge to the definition instead.
 */
export function resolveImportsToDefinitions(
  results: SearchResult[],
  queries: QueryBuilder
): SearchResult[] {
  const resolved: SearchResult[] = [];
  const seenIds = new Set<string>();

  for (const result of results) {
    const { node, score } = result;

    // If it's not an import/export, keep it as-is
    if (node.kind !== 'import' && node.kind !== 'export') {
      if (!seenIds.has(node.id)) {
        seenIds.add(node.id);
        resolved.push(result);
      }
      continue;
    }

    // For imports/exports, follow the outgoing edge to the definition.
    const edgeKind = node.kind === 'import' ? 'imports' : 'exports';
    const outgoingEdges = queries.getOutgoingEdges(node.id, [edgeKind as EdgeKind]);

    let foundDefinition = false;
    for (const edge of outgoingEdges) {
      const targetNode = queries.getNodeById(edge.target);
      if (targetNode && !seenIds.has(targetNode.id)) {
        seenIds.add(targetNode.id);
        resolved.push({ node: targetNode, score }); // Preserve the original score
        foundDefinition = true;
        logDebug('Resolved import to definition', {
          import: node.name,
          definition: targetNode.name,
          kind: targetNode.kind,
        });
      }
    }

    // If we couldn't resolve the import, skip it (it's low-value on its own)
    if (!foundDefinition) {
      logDebug('Skipping unresolved import', { name: node.name, file: node.filePath });
    }
  }

  return resolved;
}

/**
 * Expand type hierarchies for class/interface entry points (two passes: entry
 * points, then newly-discovered parent types) so subclasses/superclasses appear
 * even when BFS exhausts its per-entry-point budget. Mutates nodes + edges.
 */
function expandTypeHierarchy(
  nodes: Map<string, Node>,
  edges: Edge[],
  roots: string[],
  filteredResults: SearchResult[],
  opts: Required<FindRelevantContextOptions>,
  traverser: GraphTraverser
): void {
  const typeHierarchyKinds = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol']);
  const maxHierarchyNodes = Math.ceil(opts.maxNodes / 4);
  let hierarchyNodesAdded = 0;

  const mergeEdge = (edge: Edge, requireBothEnds: boolean): void => {
    if (requireBothEnds && !(nodes.has(edge.source) && nodes.has(edge.target))) return;
    const exists = edges.some(
      (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
    );
    if (!exists) edges.push(edge);
  };

  // Pass 1: entry points
  for (const result of filteredResults) {
    if (hierarchyNodesAdded >= maxHierarchyNodes) break;
    if (!typeHierarchyKinds.has(result.node.kind)) continue;
    const hierarchy = traverser.getTypeHierarchy(result.node.id);
    for (const [id, node] of hierarchy.nodes) {
      if (!nodes.has(id)) {
        nodes.set(id, node);
        hierarchyNodesAdded++;
      }
    }
    for (const edge of hierarchy.edges) mergeEdge(edge, false);
  }

  // Pass 2: expand hierarchy of newly-discovered parent types to find siblings.
  if (hierarchyNodesAdded === 0) return;
  const pass2Candidates = [...nodes.values()].filter(
    n => typeHierarchyKinds.has(n.kind) && !roots.includes(n.id)
  );
  for (const candidate of pass2Candidates) {
    if (hierarchyNodesAdded >= maxHierarchyNodes) break;
    const siblingHierarchy = traverser.getTypeHierarchy(candidate.id);
    for (const [id, node] of siblingHierarchy.nodes) {
      if (!nodes.has(id) && hierarchyNodesAdded < maxHierarchyNodes) {
        nodes.set(id, node);
        hierarchyNodesAdded++;
      }
    }
    for (const edge of siblingHierarchy.edges) mergeEdge(edge, true);
  }
}

/**
 * Assemble the final context subgraph from scored search results: min-score
 * filtering, import→definition resolution, entry-point capping, type-hierarchy
 * expansion, BFS traversal, max-node / per-file / non-prod trimming, and edge
 * recovery. Pure given (searchResults, opts, deps).
 */
export function assembleContextSubgraph(
  searchResults: SearchResult[],
  opts: Required<FindRelevantContextOptions>,
  isTestQuery: boolean,
  deps: { traverser: GraphTraverser; queries: QueryBuilder }
): Subgraph {
  const { traverser, queries } = deps;
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const roots: string[] = [];

  searchResults.sort((a, b) => b.score - a.score);
  searchResults = searchResults.slice(0, opts.searchLimit * 3);

  // Min-score filter, then resolve imports/exports to their definitions.
  let filteredResults = searchResults.filter((r) => r.score >= opts.minScore);
  filteredResults = resolveImportsToDefinitions(filteredResults, queries);

  // Cap entry points so traversal budget isn't spread too thin.
  if (filteredResults.length > opts.searchLimit) {
    filteredResults = filteredResults.slice(0, opts.searchLimit);
  }

  // Add entry points to subgraph
  for (const result of filteredResults) {
    nodes.set(result.node.id, result.node);
    roots.push(result.node.id);
  }

  expandTypeHierarchy(nodes, edges, roots, filteredResults, opts, traverser);
  traverseEntryPoints(nodes, edges, filteredResults, opts, traverser);

  let { finalNodes, finalEdges } = trimToMaxNodes(nodes, edges, roots, opts);
  applyDiversityCaps(finalNodes, roots, opts, isTestQuery);

  // Re-filter edges after per-file and non-production caps
  finalEdges = finalEdges.filter((e) => finalNodes.has(e.source) && finalNodes.has(e.target));

  recoverEdges(finalNodes, finalEdges, queries);

  return { nodes: finalNodes, edges: finalEdges, roots };
}
