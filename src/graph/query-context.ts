/**
 * Node-context assembly for GraphQueryManager, split out to stay within the
 * file-size gate. Free functions taking the QueryBuilder + GraphTraverser.
 */

import { Node, Edge, Context, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from './traversal';

/**
 * Get full context for a node: the focal node along with its ancestors,
 * children, and both incoming and outgoing references.
 */
export function getContext(
  queries: QueryBuilder,
  traverser: GraphTraverser,
  nodeId: string
): Context {
  const focal = queries.getNodeById(nodeId);

  if (!focal) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  // Get ancestors (containment hierarchy)
  const ancestors = traverser.getAncestors(nodeId);

  // Get children
  const children = traverser.getChildren(nodeId);

  // Get incoming references (things that reference this node)
  const incomingEdges = queries.getIncomingEdges(nodeId);
  const incomingRefs: Array<{ node: Node; edge: Edge }> = [];
  for (const edge of incomingEdges) {
    // Skip containment edges (already in ancestors)
    if (edge.kind === 'contains') {
      continue;
    }
    const node = queries.getNodeById(edge.source);
    if (node) {
      incomingRefs.push({ node, edge });
    }
  }

  // Get outgoing references (things this node references)
  const outgoingEdges = queries.getOutgoingEdges(nodeId);
  const outgoingRefs: Array<{ node: Node; edge: Edge }> = [];
  for (const edge of outgoingEdges) {
    // Skip containment edges (already in children)
    if (edge.kind === 'contains') {
      continue;
    }
    const node = queries.getNodeById(edge.target);
    if (node) {
      outgoingRefs.push({ node, edge });
    }
  }

  // Get type information (type_of, returns edges)
  const types: Node[] = [];
  const typeEdgeKinds: EdgeKind[] = ['type_of', 'returns'];
  for (const kind of typeEdgeKinds) {
    const typeEdges = queries.getOutgoingEdges(nodeId, [kind]);
    for (const edge of typeEdges) {
      const typeNode = queries.getNodeById(edge.target);
      if (typeNode && !types.some((t) => t.id === typeNode.id)) {
        types.push(typeNode);
      }
    }
  }

  // Get relevant imports
  const imports: Node[] = [];
  const fileNode = ancestors.find((a) => a.kind === 'file');
  if (fileNode) {
    const importEdges = queries.getOutgoingEdges(fileNode.id, ['imports']);
    for (const edge of importEdges) {
      const importNode = queries.getNodeById(edge.target);
      if (importNode) {
        imports.push(importNode);
      }
    }
  }

  return {
    focal,
    ancestors,
    children,
    incomingRefs,
    outgoingRefs,
    types,
    imports,
  };
}

/**
 * Get complexity metrics for a node.
 */
export function getNodeMetrics(
  queries: QueryBuilder,
  traverser: GraphTraverser,
  nodeId: string
): {
  incomingEdgeCount: number;
  outgoingEdgeCount: number;
  callCount: number;
  callerCount: number;
  childCount: number;
  depth: number;
} {
  const incomingEdges = queries.getIncomingEdges(nodeId);
  const outgoingEdges = queries.getOutgoingEdges(nodeId);

  const callEdges = outgoingEdges.filter((e) => e.kind === 'calls');
  const callerEdges = incomingEdges.filter((e) => e.kind === 'calls');
  const containsEdges = outgoingEdges.filter((e) => e.kind === 'contains');

  const ancestors = traverser.getAncestors(nodeId);

  return {
    incomingEdgeCount: incomingEdges.length,
    outgoingEdgeCount: outgoingEdges.length,
    callCount: callEdges.length,
    callerCount: callerEdges.length,
    childCount: containsEdges.length,
    depth: ancestors.length,
  };
}
