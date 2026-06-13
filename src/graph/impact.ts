/**
 * Impact radius
 *
 * Reverse-dependency traversal: all nodes that could be affected by changes
 * to a given node. Split out of traversal.ts to keep the GraphTraverser facade
 * thin while the impact algorithm lives in one focused module.
 */

import type { Node, Edge, Subgraph } from '../types';
import type { QueryBuilder } from '../db/queries';

const CONTAINER_KINDS = new Set([
  'class', 'interface', 'struct', 'trait', 'protocol', 'module', 'enum',
]);

/**
 * Calculate the impact radius of a node.
 *
 * Returns all nodes that could be affected by changes to this node, by
 * walking incoming edges (dependents) up to maxDepth, and descending into
 * container children so callers of contained methods are included.
 */
export function computeImpactRadius(
  queries: QueryBuilder,
  nodeId: string,
  maxDepth: number = 3
): Subgraph {
  const focalNode = queries.getNodeById(nodeId);
  if (!focalNode) {
    return { nodes: new Map(), edges: [], roots: [] };
  }

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const visited = new Set<string>();

  // Add focal node
  nodes.set(focalNode.id, focalNode);

  // Traverse incoming edges to find all dependents
  impactRecursive(queries, nodeId, maxDepth, 0, nodes, edges, visited);

  return {
    nodes,
    edges,
    roots: [nodeId],
  };
}

function impactRecursive(
  queries: QueryBuilder,
  nodeId: string,
  maxDepth: number,
  currentDepth: number,
  nodes: Map<string, Node>,
  edges: Edge[],
  visited: Set<string>
): void {
  if (currentDepth >= maxDepth || visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  // For container nodes (classes, interfaces, structs, etc.), also traverse
  // into their children so that callers of contained methods appear in impact
  const focalNode = queries.getNodeById(nodeId);
  if (focalNode && CONTAINER_KINDS.has(focalNode.kind)) {
    const containsEdges = queries.getOutgoingEdges(nodeId, ['contains']);
    for (const edge of containsEdges) {
      const childNode = queries.getNodeById(edge.target);
      if (childNode && !visited.has(childNode.id)) {
        nodes.set(childNode.id, childNode);
        edges.push(edge);
        // Recurse into children at the same depth (they're part of the same symbol)
        impactRecursive(queries, childNode.id, maxDepth, currentDepth, nodes, edges, visited);
      }
    }
  }

  // Get all incoming edges (things that depend on this node)
  const incomingEdges = queries.getIncomingEdges(nodeId);

  for (const edge of incomingEdges) {
    const sourceNode = queries.getNodeById(edge.source);
    if (sourceNode && !nodes.has(sourceNode.id)) {
      nodes.set(sourceNode.id, sourceNode);
      edges.push(edge);
      impactRecursive(queries, sourceNode.id, maxDepth, currentDepth + 1, nodes, edges, visited);
    }
  }
}
