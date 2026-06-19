/**
 * Context search merge + multi-term re-ranking. Split out of context-search.ts
 * to stay within the file-size gate.
 */

import * as path from 'path';
import type { SearchResult } from '../types';
import { extractSearchTerms, isTestFile } from '../search/query-utils';

/**
 * Step 4: merge channels (max score on duplicates), then deprioritize test
 * files unless the query itself is test-oriented. Returns the merged set and
 * whether the query is a test query.
 */
export function mergeChannels(
  exactMatches: SearchResult[],
  textResults: SearchResult[],
  query: string
): { searchResults: SearchResult[]; isTestQuery: boolean } {
  const resultById = new Map<string, SearchResult>();
  const searchResults: SearchResult[] = [];

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

  return { searchResults, isTestQuery };
}

/**
 * Step 5a: multi-term co-occurrence re-ranking (in place, before truncation).
 * Nodes matching 2+ query-term groups in name/directory get a multiplicative
 * boost; single-term non-exact matches are mildly dampened.
 */
export function applyMultiTermReranking(
  searchResults: SearchResult[],
  query: string,
  exactMatches: SearchResult[]
): void {
  const queryTermsForBoost = extractSearchTerms(query);
  if (queryTermsForBoost.length < 2) return;

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
