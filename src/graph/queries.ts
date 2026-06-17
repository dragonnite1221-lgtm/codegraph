/**
 * Graph Query Functions
 *
 * GraphQueryManager: higher-level queries built on the traversal algorithms.
 * The query bodies live in sibling modules (query-context / query-files /
 * query-analysis) to stay within the file-size gate; this class wires them to
 * a QueryBuilder + GraphTraverser and delegates.
 */

import { Node, Context, Subgraph } from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from './traversal';
import { getContext, getNodeMetrics } from './query-context';
import {
  findCircularDependencies,
  getExportedSymbols,
  getFileDependencies,
  getFileDependents,
  getModuleStructure,
} from './query-files';
import {
  findByQualifiedName,
  findDeadCode,
  getFilteredSubgraph,
} from './query-analysis';

/**
 * Graph query manager for complex queries
 */
export class GraphQueryManager {
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
    this.traverser = new GraphTraverser(queries);
  }

  getContext(nodeId: string): Context {
    return getContext(this.queries, this.traverser, nodeId);
  }

  getFileDependencies(filePath: string): string[] {
    return getFileDependencies(this.queries, filePath);
  }

  getFileDependents(filePath: string): string[] {
    return getFileDependents(this.queries, filePath);
  }

  getExportedSymbols(filePath: string): Node[] {
    return getExportedSymbols(this.queries, filePath);
  }

  findByQualifiedName(pattern: string): Node[] {
    return findByQualifiedName(this.queries, pattern);
  }

  getModuleStructure(): Map<string, string[]> {
    return getModuleStructure(this.queries);
  }

  findCircularDependencies(): string[][] {
    return findCircularDependencies(this.queries);
  }

  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return getNodeMetrics(this.queries, this.traverser, nodeId);
  }

  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return findDeadCode(this.queries, kinds);
  }

  getFilteredSubgraph(
    filter: (node: Node) => boolean,
    includeEdges: boolean = true
  ): Subgraph {
    return getFilteredSubgraph(this.queries, filter, includeEdges);
  }

  /**
   * Access the underlying traverser for direct traversal operations
   */
  getTraverser(): GraphTraverser {
    return this.traverser;
  }
}
