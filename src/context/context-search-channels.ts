/**
 * Context search channels: exact-name (+ definition-prefix) lookup and FTS
 * text search. Split out of context-search.ts to stay within the file-size
 * gate. Each returns a scored candidate set for one channel.
 */

import type { FindRelevantContextOptions, NodeKind, SearchResult } from '../types';
import type { QueryBuilder } from '../db/queries';
import { logDebug } from '../errors';
import { extractSearchTerms, getStemVariants } from '../search/query-utils';

/** Steps 2 + 2b: exact-name matches with co-location boost + definition-prefix matches. */
export function runExactMatchChannel(
  opts: Required<FindRelevantContextOptions>,
  queries: QueryBuilder,
  symbolsFromQuery: string[]
): SearchResult[] {
  let exactMatches: SearchResult[] = [];
  if (symbolsFromQuery.length > 0) {
    try {
      // Get more results so we can apply co-location boosting before trimming
      exactMatches = queries.findNodesByExactName(symbolsFromQuery, {
        limit: Math.ceil(opts.searchLimit * 5),
        kinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
      });

      // Co-location boost: when multiple extracted symbols appear in the same file,
      // those results are much more likely to be what the user is looking for.
      // E.g., "scrapeLoop" + "run" both in scrape/scrape.go → boost both.
      if (exactMatches.length > 1) {
        // Build a map of files → how many distinct symbol names matched in that file
        const fileSymbolCounts = new Map<string, Set<string>>();
        for (const r of exactMatches) {
          const names = fileSymbolCounts.get(r.node.filePath) || new Set();
          names.add(r.node.name.toLowerCase());
          fileSymbolCounts.set(r.node.filePath, names);
        }
        // Boost results in files where multiple query symbols co-occur
        exactMatches = exactMatches.map(r => {
          const symbolCount = fileSymbolCounts.get(r.node.filePath)?.size || 1;
          return {
            ...r,
            score: symbolCount > 1 ? r.score + (symbolCount - 1) * 20 : r.score,
          };
        });
        exactMatches.sort((a, b) => b.score - a.score);
      }

      // Trim back to reasonable size
      exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 2));
      logDebug('Exact symbol matches', { count: exactMatches.length });
    } catch (error) {
      logDebug('Exact symbol lookup failed', { error: String(error) });
    }
  }

  // Step 2b: Search for extracted symbols as definition (class/interface) prefixes.
  // When the user writes "REST", "bulk", or "allocation", they usually mean classes
  // like RestController, BulkRequest, AllocationService — not nodes named exactly that.
  // Also tries stem variants: "caching" → "cache" finds Cache, CacheBuilder.
  if (symbolsFromQuery.length > 0) {
    const definitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
      'protocol', 'enum', 'type_alias'];
    // Expand symbols with stem variants for broader definition matching
    const expandedSymbols = new Set(symbolsFromQuery);
    for (const sym of symbolsFromQuery) {
      for (const variant of getStemVariants(sym)) {
        expandedSymbols.add(variant);
      }
    }
    for (const sym of expandedSymbols) {
      // Title-case the symbol: "REST" → "Rest", "bulk" → "Bulk", "allocation" → "Allocation"
      const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
      if (titleCased === sym) continue; // already title-case (e.g., "Engine") — handled by exact match
      // Fetch more results since popular prefixes have many matches
      const prefixResults = queries.searchNodes(titleCased, {
        limit: 30,
        kinds: definitionKinds,
      });
      const matched: SearchResult[] = [];
      for (const r of prefixResults) {
        if (r.node.name.toLowerCase().startsWith(titleCased.toLowerCase())) {
          // Favor shorter names: "AllocationService" (18 chars) over
          // "AllocationBalancingRoundMetrics" (31 chars). Core classes tend
          // to have concise names; test/helper classes are verbose.
          const brevityBonus = Math.max(0, 10 - (r.node.name.length - titleCased.length) / 3);
          matched.push({ ...r, score: r.score + 15 + brevityBonus });
        }
      }
      matched.sort((a, b) => b.score - a.score);
      for (const r of matched.slice(0, Math.ceil(opts.searchLimit))) {
        const existing = exactMatches.find(e => e.node.id === r.node.id);
        if (!existing) {
          exactMatches.push(r);
        }
      }
    }
    exactMatches.sort((a, b) => b.score - a.score);
    exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 3));
  }

  return exactMatches;
}

/** Step 3: FTS text search across query terms, boosting multi-term hits. */
export function runTextSearchChannel(
  query: string,
  opts: Required<FindRelevantContextOptions>,
  queries: QueryBuilder
): SearchResult[] {
  let textResults: SearchResult[] = [];
  try {
    const searchTerms = extractSearchTerms(query);
    if (searchTerms.length > 0) {
      // Search each term individually to get broader coverage,
      // then boost results that match multiple terms
      const termResultsMap = new Map<string, { result: SearchResult; termHits: number }>();
      // When no explicit kind filter is set, exclude imports — they flood FTS
      // results with qualified name matches (e.g., "REST" matches 445K import paths)
      // but are almost never what exploration queries want.
      const searchKinds = opts.nodeKinds && opts.nodeKinds.length > 0
        ? opts.nodeKinds
        : ['file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
           'function', 'method', 'property', 'field', 'variable', 'constant',
           'enum', 'enum_member', 'type_alias', 'namespace', 'export',
           'route', 'component'] as NodeKind[];
      for (const term of searchTerms) {
        const termResults = queries.searchNodes(term, {
          limit: opts.searchLimit * 2,
          kinds: searchKinds,
        });
        for (const r of termResults) {
          const existing = termResultsMap.get(r.node.id);
          if (existing) {
            existing.termHits++;
            existing.result.score = Math.max(existing.result.score, r.score);
          } else {
            termResultsMap.set(r.node.id, { result: r, termHits: 1 });
          }
        }
      }
      // Boost results matching multiple terms and sort
      textResults = Array.from(termResultsMap.values())
        .map(({ result, termHits }) => ({
          ...result,
          score: result.score + (termHits - 1) * 5,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.searchLimit * 2);
    }
    logDebug('Text search results', { count: textResults.length });
  } catch (error) {
    logDebug('Text search failed', { query, error: String(error) });
  }
  return textResults;
}
