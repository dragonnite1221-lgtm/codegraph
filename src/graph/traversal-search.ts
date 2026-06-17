/**
 * BFS/DFS graph traversal.
 *
 * Free functions taking the QueryBuilder explicitly, split out of
 * GraphTraverser to stay within the file-size gate. The class methods delegate
 * here.
 */

import { Node, Edge, Subgraph, TraversalOptions, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';

/** Default traversal options */
export const DEFAULT_OPTIONS: Required<TraversalOptions> = {
  maxDepth: Infinity,
  edgeKinds: [],
  nodeKinds: [],
  direction: 'outgoing',
  limit: 1000,
  includeStart: true,
};

/** Result of a single traversal step */
interface TraversalStep {
  node: Node;
  edge: Edge | null;
  depth: number;
}

/** Get adjacent edges based on direction */
export function getAdjacentEdges(
  queries: QueryBuilder,
  nodeId: string,
  direction: 'outgoing' | 'incoming' | 'both',
  edgeKinds?: EdgeKind[]
): Edge[] {
  const kinds = edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined;

  if (direction === 'outgoing') {
    return queries.getOutgoingEdges(nodeId, kinds);
  } else if (direction === 'incoming') {
    return queries.getIncomingEdges(nodeId, kinds);
  } else {
    // Both directions
    const outgoing = queries.getOutgoingEdges(nodeId, kinds);
    const incoming = queries.getIncomingEdges(nodeId, kinds);
    return [...outgoing, ...incoming];
  }
}

/** Traverse the graph using breadth-first search */
export function traverseBFS(
  queries: QueryBuilder,
  startId: string,
  options: TraversalOptions = {}
): Subgraph {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const startNode = queries.getNodeById(startId);

  if (!startNode) {
    return { nodes: new Map(), edges: [], roots: [] };
  }

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const visited = new Set<string>();
  const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];

  if (opts.includeStart) {
    nodes.set(startNode.id, startNode);
  }

  while (queue.length > 0 && nodes.size < opts.limit) {
    const step = queue.shift()!;
    const { node, edge, depth } = step;

    if (visited.has(node.id)) {
      continue;
    }
    visited.add(node.id);

    if (edge) {
      edges.push(edge);
    }

    if (depth >= opts.maxDepth) {
      continue;
    }

    // Prioritize structural edges (contains, calls) over reference edges so BFS
    // discovers internal structure before fanning out to external references.
    const adjacentEdges = getAdjacentEdges(queries, node.id, opts.direction, opts.edgeKinds);
    adjacentEdges.sort((a, b) => {
      const priority = (e: Edge) => e.kind === 'contains' ? 0 : e.kind === 'calls' ? 1 : 2;
      return priority(a) - priority(b);
    });

    for (const adjEdge of adjacentEdges) {
      // For 'both' direction, pick whichever end is not the current node.
      const nextNodeId = adjEdge.source === node.id ? adjEdge.target : adjEdge.source;

      if (visited.has(nextNodeId)) {
        continue;
      }

      const nextNode = queries.getNodeById(nextNodeId);
      if (!nextNode) {
        continue;
      }

      if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
        continue;
      }

      nodes.set(nextNode.id, nextNode);
      queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
    }
  }

  return {
    nodes,
    edges,
    roots: [startId],
  };
}

/** Traverse the graph using depth-first search */
export function traverseDFS(
  queries: QueryBuilder,
  startId: string,
  options: TraversalOptions = {}
): Subgraph {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const startNode = queries.getNodeById(startId);

  if (!startNode) {
    return { nodes: new Map(), edges: [], roots: [] };
  }

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const visited = new Set<string>();

  if (opts.includeStart) {
    nodes.set(startNode.id, startNode);
  }

  dfsRecursive(queries, startNode, 0, opts, nodes, edges, visited);

  return {
    nodes,
    edges,
    roots: [startId],
  };
}

/** Recursive DFS helper */
function dfsRecursive(
  queries: QueryBuilder,
  node: Node,
  depth: number,
  opts: Required<TraversalOptions>,
  nodes: Map<string, Node>,
  edges: Edge[],
  visited: Set<string>
): void {
  if (visited.has(node.id) || nodes.size >= opts.limit || depth >= opts.maxDepth) {
    return;
  }

  visited.add(node.id);

  // Get adjacent edges
  const adjacentEdges = getAdjacentEdges(queries, node.id, opts.direction, opts.edgeKinds);

  for (const edge of adjacentEdges) {
    // For 'both' direction, pick whichever end is not the current node.
    const nextNodeId = edge.source === node.id ? edge.target : edge.source;

    if (visited.has(nextNodeId)) {
      continue;
    }

    const nextNode = queries.getNodeById(nextNodeId);
    if (!nextNode) {
      continue;
    }

    if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
      continue;
    }

    nodes.set(nextNode.id, nextNode);
    edges.push(edge);

    dfsRecursive(queries, nextNode, depth + 1, opts, nodes, edges, visited);
  }
}
