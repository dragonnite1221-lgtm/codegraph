/**
 * Analysis graph queries for GraphQueryManager (qualified-name lookup, dead
 * code, filtered subgraph). Split out to stay within the file-size gate. Free
 * functions taking the QueryBuilder.
 */

import { Node, Edge, Subgraph } from '../types';
import { QueryBuilder } from '../db/queries';

/**
 * Find symbols by qualified name pattern (supports `*` and `?` wildcards).
 */
export function findByQualifiedName(queries: QueryBuilder, pattern: string): Node[] {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp(`^${regexPattern}$`);

  // This is inefficient for large graphs - would need FTS index on qualified_name
  // For now, use kind-based filtering if possible
  const allNodes: Node[] = [];
  const kinds: Node['kind'][] = [
    'class',
    'function',
    'method',
    'interface',
    'type_alias',
    'variable',
    'constant',
  ];

  for (const kind of kinds) {
    const nodes = queries.getNodesByKind(kind);
    for (const node of nodes) {
      if (regex.test(node.qualifiedName)) {
        allNodes.push(node);
      }
    }
  }

  return allNodes;
}

/**
 * Find dead code (nodes with no incoming references), excluding exported symbols.
 */
export function findDeadCode(queries: QueryBuilder, kinds?: Node['kind'][]): Node[] {
  const targetKinds = kinds || ['function', 'method', 'class'];
  const deadCode: Node[] = [];

  for (const kind of targetKinds) {
    const nodes = queries.getNodesByKind(kind);
    for (const node of nodes) {
      // Skip exported symbols (they may be used externally)
      if (node.isExported) {
        continue;
      }

      const incomingEdges = queries.getIncomingEdges(node.id);

      // Filter out containment edges
      const references = incomingEdges.filter((e) => e.kind !== 'contains');

      if (references.length === 0) {
        deadCode.push(node);
      }
    }
  }

  return deadCode;
}

/**
 * Get a subgraph containing nodes matching a filter, optionally with edges
 * between matching nodes.
 */
export function getFilteredSubgraph(
  queries: QueryBuilder,
  filter: (node: Node) => boolean,
  includeEdges: boolean = true
): Subgraph {
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];

  // Get all nodes of common kinds
  const kinds: Node['kind'][] = [
    'file',
    'module',
    'class',
    'struct',
    'interface',
    'trait',
    'function',
    'method',
    'variable',
    'constant',
    'enum',
    'type_alias',
  ];

  for (const kind of kinds) {
    const kindNodes = queries.getNodesByKind(kind);
    for (const node of kindNodes) {
      if (filter(node)) {
        nodes.set(node.id, node);
      }
    }
  }

  // Include edges between matching nodes
  if (includeEdges) {
    for (const nodeId of nodes.keys()) {
      const outgoing = queries.getOutgoingEdges(nodeId);
      for (const edge of outgoing) {
        if (nodes.has(edge.target)) {
          edges.push(edge);
        }
      }
    }
  }

  return {
    nodes,
    edges,
    roots: [],
  };
}
