/**
 * Search internals
 *
 * FTS5 / LIKE / fuzzy candidate generation and exact-name supplementation used
 * by runSearchNodes. Split out of search-queries.ts to keep the public search
 * entrypoints readable while the strategy-specific SQL lives here.
 */

import type { Language, NodeKind, SearchOptions, SearchResult } from '../types';
import { boundedEditDistance } from '../search/query-parser';
import type { SqliteStatement } from './sqlite-adapter';
import { type NodeRow, rowToNode } from './row-mappers';

export type RunStatement = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;

export interface SearchQueryContext {
  runStatement: RunStatement;
  getAllNodeNames: () => string[];
}

export function supplementExactNameMatches(
  context: SearchQueryContext,
  results: SearchResult[],
  query: string,
  kinds?: NodeKind[],
  languages?: Language[]
): void {
  // Supplement: ensure exact name matches are always candidates.
  // BM25 can bury short exact-match names (e.g. "getBean") under hundreds of
  // compound names (e.g. "getBeanDescriptor") in large codebases,
  // pushing them past the FTS fetch limit before post-hoc scoring can help.
  // Use the max BM25 score as the base so the nameMatchBonus (exact=30 vs
  // prefix=20) actually differentiates them after rescoring.
  if (results.length === 0 || !query) {
    return;
  }

  const existingIds = new Set(results.map(r => r.node.id));
  const maxFtsScore = Math.max(...results.map(r => r.score));
  const terms = query.split(/\s+/).filter(t => t.length >= 2);
  for (const term of terms) {
    let sql = 'SELECT * FROM nodes WHERE lower(name) = ?';
    const params: (string | number)[] = [term.toLowerCase()];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    sql += ' LIMIT 20';
    const rows = context.runStatement(sql, (stmt) => stmt.all(...params) as NodeRow[]);
    for (const row of rows) {
      if (!existingIds.has(row.id)) {
        results.push({ node: rowToNode(row), score: maxFtsScore });
        existingIds.add(row.id);
      }
    }
  }
}

/**
 * Match-everything path used when the user supplied only field filters
 * (`kind:function lang:typescript`) with no text. Returns candidates ordered
 * by name; the caller's filter pass narrows to what was asked for.
 */
export function searchAllByFilters(
  context: SearchQueryContext,
  options: {
    kinds?: NodeKind[];
    languages?: Language[];
    limit: number;
  }
): SearchResult[] {
  const { kinds, languages, limit } = options;
  let sql = 'SELECT * FROM nodes WHERE 1=1';
  const params: (string | number)[] = [];
  if (kinds && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  if (languages && languages.length > 0) {
    sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
    params.push(...languages);
  }
  sql += ' ORDER BY name LIMIT ?';
  params.push(limit);
  const rows = context.runStatement(sql, (stmt) => stmt.all(...params) as NodeRow[]);
  return rows.map((row) => ({ node: rowToNode(row), score: 1 }));
}

/**
 * Fuzzy fallback: when zero FTS/LIKE hits, try an edit-distance sweep over the
 * distinct symbol-name set. Caps `maxDist` at 2 so `getUssr` finds `getUser`
 * but `process` doesn't match `prosody`.
 */
export function searchNodesFuzzy(
  context: SearchQueryContext,
  text: string,
  options: { kinds?: NodeKind[]; languages?: Language[]; limit: number }
): SearchResult[] {
  const { kinds, languages, limit } = options;
  const lowered = text.toLowerCase();
  const maxDist = lowered.length <= 4 ? 1 : 2;

  // Pull the distinct name list once. The set is cached on QueryBuilder
  // by getAllNodeNames(); even on a 200k-node project the distinct
  // name set is typically O(10k) because most names repeat. The
  // candidate-cap below bounds memory regardless.
  const allNames = context.getAllNodeNames();
  const candidates: Array<{ name: string; dist: number }> = [];
  for (const name of allNames) {
    const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
    if (dist <= maxDist) candidates.push({ name, dist });
  }
  candidates.sort((a, b) => a.dist - b.dist);

  // Cap the per-name follow-up queries. Each survivor triggers a
  // separate `SELECT * FROM nodes WHERE name = ?`; without this cap
  // a project with many similar names (`getUser1`, `getUser2`...)
  // could fan out far beyond `limit` queries before the inner-loop
  // limit kicks in.
  const FUZZY_FOLLOWUP_CAP = Math.max(limit * 2, 50);
  const cappedCandidates = candidates.slice(0, FUZZY_FOLLOWUP_CAP);

  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const c of cappedCandidates) {
    if (results.length >= limit) break;
    let sql = 'SELECT * FROM nodes WHERE name = ?';
    const params: (string | number)[] = [c.name];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    sql += ' LIMIT 5';
    const rows = context.runStatement(sql, (stmt) => stmt.all(...params) as NodeRow[]);
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      // Lower the score for each edit step away from the query so
      // exact-match fallbacks (dist 0) outrank dist-2 typos.
      results.push({ node: rowToNode(row), score: 1 / (1 + c.dist) });
      if (results.length >= limit) break;
    }
  }
  return results;
}

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
