/**
 * Search query helpers
 *
 * Search uses ad hoc statements with dynamic filters, so keep it separate from
 * the core QueryBuilder CRUD/prepared statement cache.
 */

import type { SearchOptions, SearchResult } from '../types';
import { kindBonus, nameMatchBonus, scorePathRelevance } from '../search/query-utils';
import { parseQuery } from '../search/query-parser';
import { type NodeRow, rowToNode } from './row-mappers';
import {
  type SearchQueryContext,
  searchAllByFilters,
  searchNodesFTS,
  searchNodesFuzzy,
  searchNodesLike,
  supplementExactNameMatches,
} from './search-internals';

export type { SearchQueryContext } from './search-internals';

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
export function runFindNodesByExactName(
  context: SearchQueryContext,
  names: string[],
  options: SearchOptions = {}
): SearchResult[] {
  if (names.length === 0) return [];

  const { kinds, languages, limit = 50 } = options;

  // Two-pass approach to handle common names (e.g., "run" has 40+ matches):
  // Pass 1: Find which files contain distinctive (rare) symbols from the query.
  // Pass 2: Query each name, boosting results that co-locate with distinctive symbols.

  // Pass 1: Find files containing each queried name, identify distinctive names
  const nameToFiles = new Map<string, Set<string>>();
  for (const name of names) {
    let sql = 'SELECT DISTINCT file_path FROM nodes WHERE lower(name) = ?';
    const params: (string | number)[] = [name.toLowerCase()];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    sql += ' LIMIT 100';
    const rows = context.runStatement(
      sql,
      (stmt) => stmt.all(...params) as { file_path: string }[]
    );
    nameToFiles.set(name.toLowerCase(), new Set(rows.map(r => r.file_path)));
  }

  // Distinctive names are those with fewer than 10 file matches (e.g., "scrapeLoop" = 1 file)
  const distinctiveFiles = new Set<string>();
  for (const [, files] of nameToFiles) {
    if (files.size > 0 && files.size < 10) {
      for (const f of files) distinctiveFiles.add(f);
    }
  }

  // Pass 2: Query each name with per-name limit, scoring by co-location
  const perNameLimit = Math.max(8, Math.ceil(limit / names.length));
  const allResults: SearchResult[] = [];
  const seenIds = new Set<string>();

  for (const name of names) {
    let sql = `
      SELECT nodes.*, 1.0 as score
      FROM nodes
      WHERE lower(name) = ?
    `;
    const params: (string | number)[] = [name.toLowerCase()];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    // Fetch enough to find co-located results among common names
    sql += ' LIMIT ?';
    params.push(Math.max(perNameLimit * 3, 50));

    const rows = context.runStatement(
      sql,
      (stmt) => stmt.all(...params) as (NodeRow & { score: number })[]
    );
    const nameResults: SearchResult[] = [];
    for (const row of rows) {
      const node = rowToNode(row);
      if (seenIds.has(node.id)) continue;
      // Boost results in files that also contain distinctive symbols
      const coLocationBoost = distinctiveFiles.has(node.filePath) ? 20 : 0;
      nameResults.push({ node, score: row.score + coLocationBoost });
    }

    // Sort by score (co-located first), take per-name limit
    nameResults.sort((a, b) => b.score - a.score);
    for (const r of nameResults.slice(0, perNameLimit)) {
      seenIds.add(r.node.id);
      allResults.push(r);
    }
  }

  // Sort all results by score so co-located results bubble up
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, limit);
}

/**
 * Find nodes whose name contains a substring (LIKE-based).
 * Useful for CamelCase-part matching where FTS fails because
 * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
 *
 * Results are ordered by name length (shorter = more likely to be the core type).
 */
export function runFindNodesByNameSubstring(
  context: SearchQueryContext,
  substring: string,
  options: SearchOptions & { excludePrefix?: boolean } = {}
): SearchResult[] {
  const { kinds, languages, limit = 30, excludePrefix } = options;

  let sql = `
    SELECT nodes.*, 1.0 as score
    FROM nodes
    WHERE name LIKE ?
  `;
  const params: (string | number)[] = [`%${substring}%`];

  // Exclude prefix matches (handled by FTS-based prefix search in Step 2b)
  if (excludePrefix) {
    sql += ` AND name NOT LIKE ?`;
    params.push(`${substring}%`);
  }

  if (kinds && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }

  if (languages && languages.length > 0) {
    sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
    params.push(...languages);
  }

  sql += ' ORDER BY length(name) ASC LIMIT ?';
  params.push(limit);

  const rows = context.runStatement(
    sql,
    (stmt) => stmt.all(...params) as (NodeRow & { score: number })[]
  );
  return rows.map((row) => ({
    node: rowToNode(row),
    score: row.score,
  }));
}
