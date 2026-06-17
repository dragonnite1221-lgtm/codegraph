/**
 * Caller/callee traversal and call-graph assembly.
 *
 * Free functions taking the QueryBuilder explicitly, split out of
 * GraphTraverser to stay within the file-size gate. The class methods delegate
 * here.
 */

import { Node, Edge, Subgraph } from '../types';
import { QueryBuilder } from '../db/queries';

/**
 * Find all callers of a function/method (recursively up to maxDepth).
 */
export function getCallers(
  queries: QueryBuilder,
  nodeId: string,
  maxDepth: number = 1
): Array<{ node: Node; edge: Edge }> {
  const result: Array<{ node: Node; edge: Edge }> = [];
  const visited = new Set<string>();

  getCallersRecursive(queries, nodeId, maxDepth, 0, result, visited);

  return result;
}

function getCallersRecursive(
  queries: QueryBuilder,
  nodeId: string,
  maxDepth: number,
  currentDepth: number,
  result: Array<{ node: Node; edge: Edge }>,
  visited: Set<string>
): void {
  if (currentDepth >= maxDepth || visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  const incomingEdges = queries.getIncomingEdges(nodeId, ['calls', 'references', 'imports']);

  for (const edge of incomingEdges) {
    const callerNode = queries.getNodeById(edge.source);
    if (callerNode && !visited.has(callerNode.id)) {
      result.push({ node: callerNode, edge });
      getCallersRecursive(queries, callerNode.id, maxDepth, currentDepth + 1, result, visited);
    }
  }
}

/**
 * Find all functions/methods called by a function (recursively up to maxDepth).
 */
export function getCallees(
  queries: QueryBuilder,
  nodeId: string,
  maxDepth: number = 1
): Array<{ node: Node; edge: Edge }> {
  const result: Array<{ node: Node; edge: Edge }> = [];
  const visited = new Set<string>();

  getCalleesRecursive(queries, nodeId, maxDepth, 0, result, visited);

  return result;
}

function getCalleesRecursive(
  queries: QueryBuilder,
  nodeId: string,
  maxDepth: number,
  currentDepth: number,
  result: Array<{ node: Node; edge: Edge }>,
  visited: Set<string>
): void {
  if (currentDepth >= maxDepth || visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  const outgoingEdges = queries.getOutgoingEdges(nodeId, ['calls', 'references', 'imports']);

  for (const edge of outgoingEdges) {
    const calleeNode = queries.getNodeById(edge.target);
    if (calleeNode && !visited.has(calleeNode.id)) {
      result.push({ node: calleeNode, edge });
      getCalleesRecursive(queries, calleeNode.id, maxDepth, currentDepth + 1, result, visited);
    }
  }
}

/**
 * Get the call graph for a function (both callers and callees).
 */
export function getCallGraph(
  queries: QueryBuilder,
  nodeId: string,
  depth: number = 2
): Subgraph {
  const focalNode = queries.getNodeById(nodeId);
  if (!focalNode) {
    return { nodes: new Map(), edges: [], roots: [] };
  }

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];

  // Add focal node
  nodes.set(focalNode.id, focalNode);

  // Get callers
  const callers = getCallers(queries, nodeId, depth);
  for (const { node, edge } of callers) {
    nodes.set(node.id, node);
    edges.push(edge);
  }

  // Get callees
  const callees = getCallees(queries, nodeId, depth);
  for (const { node, edge } of callees) {
    nodes.set(node.id, node);
    edges.push(edge);
  }

  return {
    nodes,
    edges,
    roots: [nodeId],
  };
}
