/**
 * Context candidate generation
 *
 * The hybrid-search front half of findRelevantContext: extracts likely symbol
 * names from the query, runs exact-name / FTS / CamelCase / compound-term
 * search channels, merges them, and applies multi-term co-occurrence and
 * test-file scoring. Returns the scored candidate set; subgraph assembly is
 * handled separately by assembleContextSubgraph.
 *
 * The channels / merge / re-rank / CamelCase phases live in sibling modules to
 * stay within the file-size gate; this orchestrates them.
 */

import type { FindRelevantContextOptions, SearchResult } from '../types';
import type { QueryBuilder } from '../db/queries';
import { logDebug } from '../errors';
import { extractSymbolsFromQuery } from './query-symbols';
import {
  runExactMatchChannel,
  runTextSearchChannel,
} from './context-search-channels';
import { applyMultiTermReranking, mergeChannels } from './context-search-rank';
import { appendCamelAndCompound } from './context-search-camel';

/**
 * Run all search channels for `query` and return the merged, scored candidate
 * set (pre-assembly). The caller filters/expands this into the final subgraph.
 */
export function generateScoredCandidates(
  query: string,
  opts: Required<FindRelevantContextOptions>,
  queries: QueryBuilder
): SearchResult[] {
  // === HYBRID SEARCH ===

  // Step 1: Extract potential symbol names from query
  const symbolsFromQuery = extractSymbolsFromQuery(query);
  logDebug('Extracted symbols from query', { query, symbols: symbolsFromQuery });

  // Steps 2/2b + 3: independent search channels
  const exactMatches = runExactMatchChannel(opts, queries, symbolsFromQuery);
  const textResults = runTextSearchChannel(query, opts, queries);

  // Step 4: merge channels + test-file deprioritization
  const { searchResults, isTestQuery } = mergeChannels(exactMatches, textResults, query);

  // Step 5a: multi-term co-occurrence re-ranking
  applyMultiTermReranking(searchResults, query, exactMatches);

  // Steps 5b/5c: CamelCase-boundary + compound-term matches
  appendCamelAndCompound(searchResults, query, opts, queries, symbolsFromQuery, isTestQuery);

  return searchResults;
}
