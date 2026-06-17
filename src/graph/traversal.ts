/**
 * Graph Traversal Algorithms
 *
 * GraphTraverser is the public entry point. The BFS/DFS machinery lives in
 * traversal-search.ts and the caller/callee machinery in traversal-calls.ts;
 * impact radius and type hierarchy live in their own modules. This class wires
 * them to a QueryBuilder and keeps the small usage/path helpers inline.
 */

import { Node, Edge, Subgraph, TraversalOptions, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';
import { computeImpactRadius } from './impact';
import {
  computeTypeHierarchy,
  getAncestors,
  getChildren,
} from './hierarchy';
import { traverseBFS, traverseDFS } from './traversal-search';
import { getCallers, getCallees, getCallGraph } from './traversal-calls';

/**
 * Graph traverser for BFS and DFS traversal
 */
export class GraphTraverser {
  private queries: QueryBuilder;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
  }

  /**
   * Traverse the graph using breadth-first search
   */
  traverseBFS(startId: string, options: TraversalOptions = {}): Subgraph {
    return traverseBFS(this.queries, startId, options);
  }

  /**
   * Traverse the graph using depth-first search
   */
  traverseDFS(startId: string, options: TraversalOptions = {}): Subgraph {
    return traverseDFS(this.queries, startId, options);
  }

  /**
   * Find all callers of a function/method
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return getCallers(this.queries, nodeId, maxDepth);
  }

  /**
   * Find all functions/methods called by a function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return getCallees(this.queries, nodeId, maxDepth);
  }

  /**
   * Get the call graph for a function (both callers and callees)
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return getCallGraph(this.queries, nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return computeTypeHierarchy(this.queries, nodeId);
  }

  /**
   * Find all usages of a symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];

    // Get all incoming edges (references, calls, type_of, etc.)
    const incomingEdges = this.queries.getIncomingEdges(nodeId);

    for (const edge of incomingEdges) {
      const sourceNode = this.queries.getNodeById(edge.source);
      if (sourceNode) {
        result.push({ node: sourceNode, edge });
      }
    }

    return result;
  }

  /**
   * Calculate the impact radius of a node
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return computeImpactRadius(this.queries, nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds: EdgeKind[] = []
  ): Array<{ node: Node; edge: Edge | null }> | null {
    const fromNode = this.queries.getNodeById(fromId);
    const toNode = this.queries.getNodeById(toId);

    if (!fromNode || !toNode) {
      return null;
    }

    // BFS to find shortest path
    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; path: Array<{ node: Node; edge: Edge | null }> }> = [
      { nodeId: fromId, path: [{ node: fromNode, edge: null }] },
    ];

    while (queue.length > 0) {
      const { nodeId, path } = queue.shift()!;

      if (nodeId === toId) {
        return path;
      }

      if (visited.has(nodeId)) {
        continue;
      }
      visited.add(nodeId);

      // Get outgoing edges
      const outgoingEdges = this.queries.getOutgoingEdges(
        nodeId,
        edgeKinds.length > 0 ? edgeKinds : undefined
      );

      for (const edge of outgoingEdges) {
        if (!visited.has(edge.target)) {
          const nextNode = this.queries.getNodeById(edge.target);
          if (nextNode) {
            queue.push({
              nodeId: edge.target,
              path: [...path, { node: nextNode, edge }],
            });
          }
        }
      }
    }

    return null; // No path found
  }

  /**
   * Get the containment hierarchy for a node (ancestors)
   */
  getAncestors(nodeId: string): Node[] {
    return getAncestors(this.queries, nodeId);
  }

  /**
   * Get immediate children of a node
   */
  getChildren(nodeId: string): Node[] {
    return getChildren(this.queries, nodeId);
  }
}
