/**
 * FTS5 + LIKE node search split out of search-internals.ts to keep it within
 * the 200-line limit. No behavior change.
 */

import type { SearchOptions, SearchResult } from '../types';
import { type NodeRow, rowToNode } from './row-mappers';
import type { SearchQueryContext } from './search-internals';

/**
 * FTS5 search with prefix matching
 */
export function searchNodesFTS(
  context: SearchQueryContext,
  query: string,
  options: SearchOptions
): SearchResult[] {
  const { kinds, languages, limit = 100, offset = 0 } = options;

  // Add prefix wildcard for better matching (e.g., "auth" matches "AuthService", "authenticate")
  // Escape special FTS5 characters and add prefix wildcard.
  //
  // `::` is a qualifier separator in Rust/C++/Ruby, not a token char,
  // so treat it as whitespace before the strip step. Otherwise queries
  // like `stage_apply::run` collapse to `stage_applyrun` (the colons
  // are stripped without splitting) and find nothing. See #173.
  const ftsQuery = query
    .replace(/::/g, ' ') // Rust/C++/Ruby qualifier separator
    .replace(/['"*():^]/g, '') // Remove FTS5 special chars
    .split(/\s+/)
    .filter(term => term.length > 0)
    // Strip FTS5 boolean operators to prevent query manipulation
    .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
    .map(term => `"${term}"*`) // Prefix match each term
    .join(' OR ');

  if (!ftsQuery) {
    return [];
  }

  // BM25 column weights: id=0, name=20, qualified_name=5, docstring=1, signature=2
  // Heavy name weight ensures exact/prefix name matches rank above incidental
  // mentions in long docstrings or qualified names of nested symbols.
  // Fetch 5x requested limit so post-hoc rescoring (kindBonus, pathRelevance,
  // nameMatchBonus) can promote results that BM25 alone undervalues.
  const ftsLimit = Math.max(limit * 5, 100);

  let sql = `
    SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2) as score
    FROM nodes_fts
    JOIN nodes ON nodes_fts.id = nodes.id
    WHERE nodes_fts MATCH ?
  `;

  const params: (string | number)[] = [ftsQuery];

  if (kinds && kinds.length > 0) {
    sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }

  if (languages && languages.length > 0) {
    sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
    params.push(...languages);
  }

  sql += ' ORDER BY score LIMIT ? OFFSET ?';
  params.push(ftsLimit, offset);

  try {
    const rows = context.runStatement(
      sql,
      (stmt) => stmt.all(...params) as (NodeRow & { score: number })[]
    );
    return rows.map((row) => ({
      node: rowToNode(row),
      score: Math.abs(row.score), // bm25 returns negative scores
    }));
  } catch {
    // FTS query failed, return empty
    return [];
  }
}

/**
 * LIKE-based substring search for cases where FTS doesn't match
 * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
 */
export function searchNodesLike(
  context: SearchQueryContext,
  query: string,
  options: SearchOptions
): SearchResult[] {
  const { kinds, languages, limit = 100, offset = 0 } = options;

  let sql = `
    SELECT nodes.*,
      CASE
        WHEN name = ? THEN 1.0
        WHEN name LIKE ? THEN 0.9
        WHEN name LIKE ? THEN 0.8
        WHEN qualified_name LIKE ? THEN 0.7
        ELSE 0.5
      END as score
    FROM nodes
    WHERE (
      name LIKE ? OR
      qualified_name LIKE ? OR
      name LIKE ?
    )
  `;

  // Pattern variants for better matching
  const exactMatch = query;
  const startsWith = `${query}%`;
  const contains = `%${query}%`;

  const params: (string | number)[] = [
    exactMatch, // Exact match score
    startsWith, // Starts with score
    contains, // Contains score
    contains, // Qualified name score
    contains, // WHERE: name contains
    contains, // WHERE: qualified_name contains
    startsWith, // WHERE: name starts with
  ];

  if (kinds && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }

  if (languages && languages.length > 0) {
    sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
    params.push(...languages);
  }

  sql += ' ORDER BY score DESC, length(name) ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = context.runStatement(
    sql,
    (stmt) => stmt.all(...params) as (NodeRow & { score: number })[]
  );

  return rows.map((row) => ({
    node: rowToNode(row),
    score: row.score,
  }));
}
