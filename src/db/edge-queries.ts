import type { Edge, EdgeKind } from '../types';
import type { SqliteStatement } from './sqlite-adapter';
import { type EdgeRow, rowToEdge } from './row-mappers';

type StatementRunner = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;

export function hasOutgoingEdgeFilters(kinds?: EdgeKind[], provenance?: string): boolean {
  return Boolean((kinds && kinds.length > 0) || provenance);
}

export function runGetFilteredOutgoingEdges(
  runStatement: StatementRunner,
  sourceId: string,
  kinds?: EdgeKind[],
  provenance?: string
): Edge[] {
  let sql = 'SELECT * FROM edges WHERE source = ?';
  const params: (string | number)[] = [sourceId];

  if (kinds && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }

  if (provenance) {
    sql += ' AND provenance = ?';
    params.push(provenance);
  }

  const rows = runStatement(sql, (stmt) => stmt.all(...params) as EdgeRow[]);
  return rows.map(rowToEdge);
}

export function runGetIncomingEdgesByKinds(
  runStatement: StatementRunner,
  targetId: string,
  kinds: EdgeKind[]
): Edge[] {
  const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
  const rows = runStatement(sql, (stmt) => stmt.all(targetId, ...kinds) as EdgeRow[]);
  return rows.map(rowToEdge);
}

export function runFindEdgesBetweenNodes(
  runStatement: StatementRunner,
  nodeIds: string[],
  kinds?: EdgeKind[]
): Edge[] {
  if (nodeIds.length === 0) return [];

  const idsJson = JSON.stringify(nodeIds);
  let sql = `SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))`;
  const params: string[] = [idsJson, idsJson];

  if (kinds && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }

  const rows = runStatement(sql, (stmt) => stmt.all(...params) as EdgeRow[]);
  return rows.map(rowToEdge);
}
