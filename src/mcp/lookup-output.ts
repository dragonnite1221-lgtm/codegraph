import type { NodeKind, SearchResult } from '../types';
import { formatNodeDetails, formatSearchResults } from './format-output';
import { findSymbol } from './symbol-resolution';

export type LookupGraph = {
  searchNodes(query: string, options: { limit: number; kinds?: NodeKind[] }): SearchResult[];
  getCode(nodeId: string): Promise<string | null>;
};

export function buildSearchOutput(
  cg: LookupGraph,
  query: string,
  options: { limit: number; kind?: NodeKind },
): string {
  const results = cg.searchNodes(query, {
    limit: options.limit,
    kinds: options.kind ? [options.kind] : undefined,
  });

  if (results.length === 0) {
    return `No results found for "${query}"`;
  }

  return formatSearchResults(results);
}

export async function buildNodeOutput(
  cg: LookupGraph,
  symbol: string,
  includeCode: boolean,
): Promise<string> {
  const match = findSymbol(cg, symbol);
  if (!match) {
    return `Symbol "${symbol}" not found in the codebase`;
  }

  const code = includeCode ? await cg.getCode(match.node.id) : null;
  return formatNodeDetails(match.node, code) + match.note;
}
