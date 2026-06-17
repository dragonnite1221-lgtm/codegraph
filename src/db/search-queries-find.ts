/**
 * Exact-name / substring node search queries split out of search-queries.ts
 * to keep it within the 200-line limit. No behavior change.
 */

import type { SearchOptions, SearchResult } from '../types';
import { type NodeRow, rowToNode } from './row-mappers';
import {
  type SearchQueryContext,
} from './search-internals';

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
