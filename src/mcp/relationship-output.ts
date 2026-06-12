import type { Edge, Node, SearchResult, Subgraph } from '../types';
import { formatImpact, formatNodeList } from './format-output';
import { findAllSymbols } from './symbol-resolution';

export type RelationshipGraph = {
  searchNodes(query: string, options: { limit: number }): SearchResult[];
  getCallers(nodeId: string): Array<{ node: Node; edge: Edge }>;
  getCallees(nodeId: string): Array<{ node: Node; edge: Edge }>;
  getImpactRadius(nodeId: string, maxDepth?: number): Subgraph;
};

function aggregateRelatedNodes(
  roots: Node[],
  getRelated: (nodeId: string) => Array<{ node: Node; edge: Edge }>,
): Node[] {
  const seen = new Set<string>();
  const related: Node[] = [];

  for (const root of roots) {
    for (const candidate of getRelated(root.id)) {
      if (!seen.has(candidate.node.id)) {
        seen.add(candidate.node.id);
        related.push(candidate.node);
      }
    }
  }

  return related;
}

export function buildCallersOutput(cg: RelationshipGraph, symbol: string, limit: number): string {
  const allMatches = findAllSymbols(cg, symbol);
  if (allMatches.nodes.length === 0) {
    return `Symbol "${symbol}" not found in the codebase`;
  }

  const allCallers = aggregateRelatedNodes(allMatches.nodes, (nodeId) => cg.getCallers(nodeId));
  if (allCallers.length === 0) {
    return `No callers found for "${symbol}"${allMatches.note}`;
  }

  return formatNodeList(allCallers.slice(0, limit), `Callers of ${symbol}`) + allMatches.note;
}

export function buildCalleesOutput(cg: RelationshipGraph, symbol: string, limit: number): string {
  const allMatches = findAllSymbols(cg, symbol);
  if (allMatches.nodes.length === 0) {
    return `Symbol "${symbol}" not found in the codebase`;
  }

  const allCallees = aggregateRelatedNodes(allMatches.nodes, (nodeId) => cg.getCallees(nodeId));
  if (allCallees.length === 0) {
    return `No callees found for "${symbol}"${allMatches.note}`;
  }

  return formatNodeList(allCallees.slice(0, limit), `Callees of ${symbol}`) + allMatches.note;
}

export function buildImpactOutput(cg: RelationshipGraph, symbol: string, depth: number): string {
  const allMatches = findAllSymbols(cg, symbol);
  if (allMatches.nodes.length === 0) {
    return `Symbol "${symbol}" not found in the codebase`;
  }

  const mergedNodes = new Map<string, Node>();
  const mergedEdges: Edge[] = [];
  const seenEdges = new Set<string>();

  for (const node of allMatches.nodes) {
    const impact = cg.getImpactRadius(node.id, depth);
    for (const [id, relatedNode] of impact.nodes) {
      mergedNodes.set(id, relatedNode);
    }
    for (const edge of impact.edges) {
      const key = `${edge.source}->${edge.target}:${edge.kind}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        mergedEdges.push(edge);
      }
    }
  }

  const mergedImpact: Subgraph = {
    nodes: mergedNodes,
    edges: mergedEdges,
    roots: allMatches.nodes.map((node) => node.id),
  };

  return formatImpact(symbol, mergedImpact) + allMatches.note;
}
