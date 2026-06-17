/**
 * Search query helpers
 *
 * Search uses ad hoc statements with dynamic filters, so keep it separate from
 * the core QueryBuilder CRUD/prepared statement cache.
 */

import type { SearchOptions, SearchResult } from '../types';
import { kindBonus, nameMatchBonus, scorePathRelevance } from '../search/query-utils';
import { parseQuery } from '../search/query-parser';
import {
  type SearchQueryContext,
  searchAllByFilters,
  searchNodesFTS,
  searchNodesFuzzy,
  searchNodesLike,
  supplementExactNameMatches,
} from './search-internals';

export type { SearchQueryContext } from './search-internals';
export {
  runFindNodesByExactName,
  runFindNodesByNameSubstring,
} from './search-queries-find';

/**
 * Search nodes by name using FTS with fallback to LIKE for better matching
 *
 * Search strategy:
 * 1. Try FTS5 prefix match (query*) for word-start matching
 * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
 * 3. Score results based on match quality
 */
export function runSearchNodes(
  context: SearchQueryContext,
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  const { limit = 100, offset = 0 } = options;

  // Parse field-qualified bits out of the raw query (kind:, lang:,
  // path:, name:). Anything not recognised stays in `text` and goes
  // to FTS unchanged. Filters compose with the SearchOptions arg —
  // both are applied (intersection-style).
  const parsed = parseQuery(query);
  const mergedKinds =
    parsed.kinds.length > 0
      ? Array.from(new Set([...(options.kinds ?? []), ...parsed.kinds]))
      : options.kinds;
  const mergedLanguages =
    parsed.languages.length > 0
      ? Array.from(new Set([...(options.languages ?? []), ...parsed.languages]))
      : options.languages;
  const pathFilters = parsed.pathFilters;
  const nameFilters = parsed.nameFilters;
  // The text portion drives FTS/LIKE; if all the user typed was
  // filters (`kind:function`), we still need *some* candidate set,
  // so synthesise an empty-text path that returns everything matching
  // the filters.
  const text = parsed.text;
  const kinds = mergedKinds;
  const languages = mergedLanguages;

  // First try FTS5 with prefix matching
  let results = text
    ? searchNodesFTS(context, text, { kinds, languages, limit, offset })
    // Over-fetch by 5× when running filter-only (no text). The
    // post-scoring path: + name: filters can be very selective, so
    // a smaller multiplier risks returning fewer than `limit`
    // results despite the DB having plenty of matches.
    : searchAllByFilters(context, { kinds, languages, limit: limit * 5 });

  // If no FTS results, try LIKE-based substring search
  if (results.length === 0 && text.length >= 2) {
    results = searchNodesLike(context, text, { kinds, languages, limit, offset });
  }

  // Final fuzzy fallback: scan all known names and keep those within
  // a tight Levenshtein distance. Only fires when both FTS and LIKE
  // returned nothing AND there's a text portion long enough to be
  // worth fuzzing (1-char queries would match too much).
  if (results.length === 0 && text.length >= 3) {
    results = searchNodesFuzzy(context, text, { kinds, languages, limit });
  }

  supplementExactNameMatches(context, results, query, kinds, languages);

  // Apply multi-signal scoring
  if (results.length > 0 && (text || query)) {
    const scoringQuery = text || query;
    results = results.map(r => ({
      ...r,
      score: r.score
        + kindBonus(r.node.kind)
        + scorePathRelevance(r.node.filePath, scoringQuery)
        + nameMatchBonus(r.node.name, scoringQuery),
    }));
    results.sort((a, b) => b.score - a.score);
  }

  // Apply path: + name: filters AFTER scoring. Scoring already uses
  // path/name as a soft signal; the explicit filters here are a hard
  // gate. Done last so the FTS limit fetched plenty of candidates to
  // narrow from.
  if (pathFilters.length > 0) {
    const lowered = pathFilters.map((p) => p.toLowerCase());
    results = results.filter((r) => {
      const fp = r.node.filePath.toLowerCase();
      return lowered.some((p) => fp.includes(p));
    });
  }
  if (nameFilters.length > 0) {
    const lowered = nameFilters.map((n) => n.toLowerCase());
    results = results.filter((r) => {
      const nm = r.node.name.toLowerCase();
      return lowered.some((n) => nm.includes(n));
    });
  }

  // Trim to requested limit after rescoring and explicit hard filters.
  if (results.length > limit) {
    results = results.slice(0, limit);
  }

  return results;
}

/**
 * Find nodes by exact name match
 *
 * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
 * Returns high-confidence matches for known symbol names extracted from query.
 *
 * @param names - Array of symbol names to look up
 * @param options - Search options (kinds, languages, limit)
 * @returns SearchResult array with exact matches scored at 1.0
 */
