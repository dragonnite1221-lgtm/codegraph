/**
 * Context candidate generation
 *
 * The hybrid-search front half of findRelevantContext: extracts likely symbol
 * names from the query, runs exact-name / FTS / CamelCase / compound-term
 * search channels, merges them, and applies multi-term co-occurrence and
 * test-file scoring. Returns the scored candidate set; subgraph assembly is
 * handled separately by assembleContextSubgraph.
 */

import * as path from 'path';

import type {
  FindRelevantContextOptions,
  Node,
  NodeKind,
  SearchResult,
} from '../types';
import type { QueryBuilder } from '../db/queries';
import { logDebug } from '../errors';
import {
  extractSearchTerms,
  getStemVariants,
  isTestFile,
  scorePathRelevance,
} from '../search/query-utils';
import { extractSymbolsFromQuery } from './query-symbols';

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

    // Step 2: Look up exact matches for extracted symbols
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

    // Step 3: Run text search for natural language term matching
    // This catches file-name and node-name matches that semantic search may miss,
    // which is critical for template-heavy codebases (e.g., Liquid/Shopify themes)
    // where file names are the primary identifiers.
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

    // Step 4: Merge results, taking the max score when duplicates appear
    // across search channels. Exact matches may have lower scores than FTS
    // results for the same node — use the best score from any channel.
    const resultById = new Map<string, SearchResult>();
    let searchResults: SearchResult[] = [];

    // Add exact matches first
    for (const result of exactMatches) {
      const existing = resultById.get(result.node.id);
      if (existing) {
        existing.score = Math.max(existing.score, result.score);
      } else {
        resultById.set(result.node.id, result);
        searchResults.push(result);
      }
    }

    // Add text search results, upgrading scores for duplicates
    for (const result of textResults) {
      const existing = resultById.get(result.node.id);
      if (existing) {
        existing.score = Math.max(existing.score, result.score);
      } else {
        resultById.set(result.node.id, result);
        searchResults.push(result);
      }
    }

    const queryLower = query.toLowerCase();
    const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');

    // Deprioritize test files early so they don't take multi-term boost slots
    if (!isTestQuery) {
      for (const result of searchResults) {
        if (isTestFile(result.node.filePath)) {
          result.score *= 0.3;
        }
      }
    }

    // Step 5a: Multi-term co-occurrence re-ranking (applied BEFORE truncation).
    // For multi-word queries like "search execution from request to shard",
    // nodes matching 2+ query terms in their name or path are far more relevant
    // than nodes matching just one generic term. Without this, "ExecutionUtils"
    // (matches only "execution") fills budget slots meant for "ShardSearchRequest"
    // (matches "shard" + "search" + "request").
    const queryTermsForBoost = extractSearchTerms(query);
    if (queryTermsForBoost.length >= 2) {
      // Group terms that are substrings of each other (stem variants of the same
      // root word). "indexed", "indexe", "index" should count as ONE concept match,
      // not three. Without this, stem variants inflate matchCount and give false
      // multi-term boosts to symbols matching one root word multiple times.
      const termGroups: string[][] = [];
      const sorted = [...queryTermsForBoost].sort((a, b) => b.length - a.length);
      const assigned = new Set<string>();
      for (const term of sorted) {
        if (assigned.has(term)) continue;
        const group = [term];
        assigned.add(term);
        for (const other of sorted) {
          if (assigned.has(other)) continue;
          if (term.includes(other) || other.includes(term)) {
            group.push(other);
            assigned.add(other);
          }
        }
        termGroups.push(group);
      }

      // Build a set of exact-match node IDs so we can exempt them from dampening.
      // When the query is "LiveEditMode DevServerPreview", these are specific
      // symbols the user asked for — dampening them because they only match 1
      // term group is counter-productive.
      const exactMatchIds = new Set(exactMatches.map(r => r.node.id));

      for (const result of searchResults) {
        // Check term matches in name (substring) and path DIRECTORIES (exact).
        // Directory segments must match exactly — "search" matches directory
        // "search/" but NOT "elasticsearch/". The class name is checked
        // separately via substring match on the node name.
        const nameLower = result.node.name.toLowerCase();
        const dirSegments = path.dirname(result.node.filePath).toLowerCase().split('/');
        let matchCount = 0;
        for (const group of termGroups) {
          const groupMatches = group.some(term => {
            const inName = nameLower.includes(term);
            const inDir = dirSegments.some(seg => seg === term);
            return inName || inDir;
          });
          if (groupMatches) matchCount++;
        }
        if (matchCount >= 2) {
          // Multiplicative boost — 2 terms → 2x, 3 terms → 2.5x
          result.score *= 1 + matchCount * 0.5;
        } else if (!exactMatchIds.has(result.node.id)) {
          // Mild dampen for single-term matches — they might be generic
          // but could also be the right result (e.g., "Protocol" class for an IPC query).
          // Exempt exact name matches: they are specific symbols the user queried for.
          result.score *= 0.6;
        }
      }
      searchResults.sort((a, b) => b.score - a.score);
    }

    // Step 5b: CamelCase-boundary matching via LIKE query.
    // FTS can't find "Search" inside "TransportSearchAction" (one FTS token).
    // LIKE reliably finds these substring matches. Results are appended with
    // guaranteed slots so they don't compete with higher-scoring prefix matches.
    if (symbolsFromQuery.length > 0) {
      const camelDefinitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
        'protocol', 'enum', 'type_alias'];
      const camelSearchedTerms = new Set<string>();
      const searchIdSet = new Set(searchResults.map(r => r.node.id));
      // Track per-node term hits for multi-term boosting
      const camelNodeTerms = new Map<string, { result: SearchResult; termCount: number }>();
      const maxCamelPerTerm = Math.ceil(opts.searchLimit / 2);

      for (const sym of symbolsFromQuery) {
        const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
        if (titleCased.length < 3) continue;
        const termKey = titleCased.toLowerCase();
        if (camelSearchedTerms.has(termKey)) continue;
        camelSearchedTerms.add(termKey);

        // Fetch a large batch — popular terms like "Search" in Elasticsearch
        // have hundreds of substring matches. The LIKE scan cost is the same
        // regardless of LIMIT (SQLite scans all matches to sort), so we fetch
        // generously and let path-relevance scoring pick the best ones.
        const likeResults = queries.findNodesByNameSubstring(titleCased, {
          limit: 200,
          kinds: camelDefinitionKinds,
          excludePrefix: true,
        });

        // Filter to CamelCase boundaries, score by path relevance, and take top N
        const termCandidates: SearchResult[] = [];
        for (const r of likeResults) {
          const name = r.node.name;
          const idx = name.indexOf(titleCased);
          if (idx <= 0) continue;
          // Accept CamelCase boundary (lowercase before match) OR
          // acronym boundary (uppercase before match, e.g., RPCProtocol)
          if (!/[a-zA-Z]/.test(name.charAt(idx - 1))) continue;
          if (searchIdSet.has(r.node.id)) continue;
          if (isTestFile(r.node.filePath) && !isTestQuery) continue;

          const pathScore = scorePathRelevance(r.node.filePath, query);
          const brevityBonus = Math.max(0, 6 - (name.length - titleCased.length) / 4);
          termCandidates.push({ node: r.node, score: 8 + brevityBonus + pathScore });
        }
        termCandidates.sort((a, b) => b.score - a.score);

        // Widen the per-term pool for accumulation so multi-term co-occurrences
        // can be discovered. A class matching 3 query terms at CamelCase boundaries
        // is far more relevant than one matching just 1, but it needs to survive
        // the per-term cut for EACH term to accumulate its count.
        const accumPerTerm = maxCamelPerTerm * 4;
        for (const r of termCandidates.slice(0, accumPerTerm)) {
          const existing = camelNodeTerms.get(r.node.id);
          if (existing) {
            existing.termCount++;
          } else {
            camelNodeTerms.set(r.node.id, {
              result: r,
              termCount: 1,
            });
          }
        }
      }

      // Append CamelCase matches with multi-term boost.
      // These are structurally important (class names containing query terms at
      // CamelCase boundaries) but score much lower than FTS results. Scale their
      // scores up so multi-term CamelCase matches can compete with FTS results.
      const camelResults: SearchResult[] = [];
      for (const [, info] of camelNodeTerms) {
        // Multi-term CamelCase matches are extremely relevant — a class matching
        // 3+ query terms in its name (e.g., ExtensionHostProcess) is almost
        // certainly what the user wants. Scale aggressively.
        info.result.score = info.result.score * (1 + info.termCount) + (info.termCount - 1) * 30;
        camelResults.push(info.result);
      }
      camelResults.sort((a, b) => b.score - a.score);
      const maxCamelTotal = opts.searchLimit;
      for (const r of camelResults.slice(0, maxCamelTotal)) {
        searchResults.push(r);
        searchIdSet.add(r.node.id);
      }

      // Step 5c: Compound term matching — find classes whose name contains 2+
      // query terms at ANY position (not just CamelCase boundaries).
      // The CamelCase step above requires idx > 0, which misses classes that
      // START with a query term (e.g., "SearchShardsRequest" starts with "Search").
      // For multi-word queries, a class matching multiple query terms in its name
      // is almost certainly relevant regardless of position.
      if (symbolsFromQuery.length >= 2) {
        // Collect ALL LIKE results per term (reusing findNodesByNameSubstring)
        // but without the CamelCase boundary or prefix exclusion filters.
        const compoundTermMap = new Map<string, { node: Node; terms: Set<string> }>();
        for (const sym of symbolsFromQuery) {
          const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
          if (titleCased.length < 3) continue;

          const likeResults = queries.findNodesByNameSubstring(titleCased, {
            limit: 200,
            kinds: camelDefinitionKinds,
            excludePrefix: false,
          });

          for (const r of likeResults) {
            if (searchIdSet.has(r.node.id)) continue;
            if (isTestFile(r.node.filePath) && !isTestQuery) continue;
            const entry = compoundTermMap.get(r.node.id);
            if (entry) {
              entry.terms.add(titleCased);
            } else {
              compoundTermMap.set(r.node.id, { node: r.node, terms: new Set([titleCased]) });
            }
          }
        }

        // Keep only nodes matching 2+ distinct terms
        const compoundResults: SearchResult[] = [];
        for (const [, entry] of compoundTermMap) {
          if (entry.terms.size >= 2) {
            const pathScore = scorePathRelevance(entry.node.filePath, query);
            const brevityBonus = Math.max(0, 6 - entry.node.name.length / 8);
            compoundResults.push({
              node: entry.node,
              score: 10 + (entry.terms.size - 1) * 20 + pathScore + brevityBonus,
            });
          }
        }
        compoundResults.sort((a, b) => b.score - a.score);
        const maxCompound = Math.ceil(opts.searchLimit / 2);
        for (const r of compoundResults.slice(0, maxCompound)) {
          searchResults.push(r);
          searchIdSet.add(r.node.id);
        }
      }
    }

    return searchResults;
}
