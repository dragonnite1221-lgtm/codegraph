/**
 * Context search CamelCase-boundary + compound-term matching (steps 5b/5c).
 * Appends structurally-relevant class matches (query terms inside CamelCase
 * names) that FTS misses. Split out of context-search.ts for the file-size gate.
 */

import type { FindRelevantContextOptions, Node, NodeKind, SearchResult } from '../types';
import type { QueryBuilder } from '../db/queries';
import { isTestFile, scorePathRelevance } from '../search/query-utils';

const CAMEL_DEFINITION_KINDS: NodeKind[] = ['class', 'interface', 'struct', 'trait',
  'protocol', 'enum', 'type_alias'];

/**
 * Steps 5b + 5c: append CamelCase-boundary matches (with multi-term boost) and
 * compound-term matches (classes containing 2+ query terms at any position).
 * Mutates `searchResults` in place.
 */
export function appendCamelAndCompound(
  searchResults: SearchResult[],
  query: string,
  opts: Required<FindRelevantContextOptions>,
  queries: QueryBuilder,
  symbolsFromQuery: string[],
  isTestQuery: boolean
): void {
  if (symbolsFromQuery.length === 0) return;

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
      kinds: CAMEL_DEFINITION_KINDS,
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
        camelNodeTerms.set(r.node.id, { result: r, termCount: 1 });
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
  if (symbolsFromQuery.length < 2) return;

  // Collect ALL LIKE results per term (reusing findNodesByNameSubstring)
  // but without the CamelCase boundary or prefix exclusion filters.
  const compoundTermMap = new Map<string, { node: Node; terms: Set<string> }>();
  for (const sym of symbolsFromQuery) {
    const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
    if (titleCased.length < 3) continue;

    const likeResults = queries.findNodesByNameSubstring(titleCased, {
      limit: 200,
      kinds: CAMEL_DEFINITION_KINDS,
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
