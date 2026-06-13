/**
 * Hierarchy traversal
 *
 * Type inheritance (extends/implements) and containment (contains) hierarchy
 * walks. Split out of traversal.ts so the GraphTraverser facade stays thin.
 */

import type { Node, Edge, Subgraph } from '../types';
import type { QueryBuilder } from '../db/queries';

/**
 * Get the type hierarchy (ancestors + descendants) for a class/interface.
 */
export function computeTypeHierarchy(queries: QueryBuilder, nodeId: string): Subgraph {
  const focalNode = queries.getNodeById(nodeId);
  if (!focalNode) {
    return { nodes: new Map(), edges: [], roots: [] };
  }

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const visited = new Set<string>();

  // Add focal node
  nodes.set(focalNode.id, focalNode);

  // Get ancestors (what this extends/implements)
  collectTypeAncestors(queries, nodeId, nodes, edges, visited);

  // Get descendants (what extends/implements this)
  collectTypeDescendants(queries, nodeId, nodes, edges, visited);

  return {
    nodes,
    edges,
    roots: [nodeId],
  };
}

function collectTypeAncestors(
  queries: QueryBuilder,
  nodeId: string,
  nodes: Map<string, Node>,
  edges: Edge[],
  visited: Set<string>
): void {
  if (visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  const outgoingEdges = queries.getOutgoingEdges(nodeId, ['extends', 'implements']);

  for (const edge of outgoingEdges) {
    const parentNode = queries.getNodeById(edge.target);
    if (parentNode && !nodes.has(parentNode.id)) {
      nodes.set(parentNode.id, parentNode);
      edges.push(edge);
      collectTypeAncestors(queries, parentNode.id, nodes, edges, visited);
    }
  }
}

function collectTypeDescendants(
  queries: QueryBuilder,
  nodeId: string,
  nodes: Map<string, Node>,
  edges: Edge[],
  visited: Set<string>
): void {
  if (visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  const incomingEdges = queries.getIncomingEdges(nodeId, ['extends', 'implements']);

  for (const edge of incomingEdges) {
    const childNode = queries.getNodeById(edge.source);
    if (childNode && !nodes.has(childNode.id)) {
      nodes.set(childNode.id, childNode);
      edges.push(edge);
      collectTypeDescendants(queries, childNode.id, nodes, edges, visited);
    }
  }
}

/**
 * Get the containment hierarchy for a node (ancestors from immediate parent to root).
 */
export function getAncestors(queries: QueryBuilder, nodeId: string): Node[] {
  const ancestors: Node[] = [];
  const visited = new Set<string>();
  let currentId = nodeId;

  while (true) {
    if (visited.has(currentId)) {
      break;
    }
    visited.add(currentId);

    // Look for 'contains' edges pointing to this node
    const containingEdges = queries.getIncomingEdges(currentId, ['contains']);

    const firstEdge = containingEdges[0];
    if (!firstEdge) {
      break;
    }

    // Typically there should be at most one containing parent
    const parentNode = queries.getNodeById(firstEdge.source);
    if (parentNode) {
      ancestors.push(parentNode);
      currentId = parentNode.id;
    } else {
      break;
    }
  }

  return ancestors;
}

/**
 * Get immediate children of a node (outgoing 'contains' edges).
 */
export function getChildren(queries: QueryBuilder, nodeId: string): Node[] {
  const containsEdges = queries.getOutgoingEdges(nodeId, ['contains']);
  const children: Node[] = [];

  for (const edge of containsEdges) {
    const childNode = queries.getNodeById(edge.target);
    if (childNode) {
      children.push(childNode);
    }
  }

  return children;
}
