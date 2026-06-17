/**
 * Node read/lookup queries. Free functions taking the shared lazy prepared-
 * statement cache (`NodeStmts`) and (where relevant) the NodeCache, split out
 * of node-queries.ts to stay within the file-size gate.
 */

import type { Node, NodeKind } from '../types';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import { type NodeRow, rowToNode } from './row-mappers';
import { NodeCache } from './node-cache';

type StatementRunner = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;

/** Lazy prepared-statement cache shared by NodeQueries and its read helpers. */
export interface NodeStmts {
  insertNode?: SqliteStatement;
  updateNode?: SqliteStatement;
  deleteNode?: SqliteStatement;
  deleteNodesByFile?: SqliteStatement;
  getNodeById?: SqliteStatement;
  getNodesByFile?: SqliteStatement;
  getNodesByKind?: SqliteStatement;
  getNodesByName?: SqliteStatement;
  getNodesByQualifiedNameExact?: SqliteStatement;
  getNodesByLowerName?: SqliteStatement;
  getAllNodeNames?: SqliteStatement;
}

/** Get a node by ID (cache-aware) */
export function getNodeById(
  db: SqliteDatabase,
  stmts: NodeStmts,
  cache: NodeCache,
  id: string
): Node | null {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }

  if (!stmts.getNodeById) {
    stmts.getNodeById = db.prepare('SELECT * FROM nodes WHERE id = ?');
  }
  const row = stmts.getNodeById.get(id) as NodeRow | undefined;
  if (!row) {
    return null;
  }

  const node = rowToNode(row);
  cache.set(node);
  return node;
}

/** Get all nodes in a file */
export function getNodesByFile(db: SqliteDatabase, stmts: NodeStmts, filePath: string): Node[] {
  if (!stmts.getNodesByFile) {
    stmts.getNodesByFile = db.prepare(
      'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
    );
  }
  const rows = stmts.getNodesByFile.all(filePath) as NodeRow[];
  return rows.map(rowToNode);
}

/** Get all nodes of a specific kind */
export function getNodesByKind(db: SqliteDatabase, stmts: NodeStmts, kind: NodeKind): Node[] {
  if (!stmts.getNodesByKind) {
    stmts.getNodesByKind = db.prepare('SELECT * FROM nodes WHERE kind = ?');
  }
  const rows = stmts.getNodesByKind.all(kind) as NodeRow[];
  return rows.map(rowToNode);
}

/** Get all nodes in the database */
export function getAllNodes(runStatement: StatementRunner): Node[] {
  const rows = runStatement('SELECT * FROM nodes', (stmt) => stmt.all() as NodeRow[]);
  return rows.map(rowToNode);
}

/** Get nodes by exact name match (uses idx_nodes_name index) */
export function getNodesByName(db: SqliteDatabase, stmts: NodeStmts, name: string): Node[] {
  if (!stmts.getNodesByName) {
    stmts.getNodesByName = db.prepare('SELECT * FROM nodes WHERE name = ?');
  }
  const rows = stmts.getNodesByName.all(name) as NodeRow[];
  return rows.map(rowToNode);
}

/** Get nodes by exact qualified name match (uses idx_nodes_qualified_name index) */
export function getNodesByQualifiedNameExact(
  db: SqliteDatabase,
  stmts: NodeStmts,
  qualifiedName: string
): Node[] {
  if (!stmts.getNodesByQualifiedNameExact) {
    stmts.getNodesByQualifiedNameExact = db.prepare(
      'SELECT * FROM nodes WHERE qualified_name = ?'
    );
  }
  const rows = stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
  return rows.map(rowToNode);
}

/** Get nodes by lowercase name match (uses idx_nodes_lower_name expression index) */
export function getNodesByLowerName(db: SqliteDatabase, stmts: NodeStmts, lowerName: string): Node[] {
  if (!stmts.getNodesByLowerName) {
    stmts.getNodesByLowerName = db.prepare(
      'SELECT * FROM nodes WHERE lower(name) = ?'
    );
  }
  const rows = stmts.getNodesByLowerName.all(lowerName) as NodeRow[];
  return rows.map(rowToNode);
}

/** Get all distinct node names (lightweight — just name strings for pre-filtering) */
export function getAllNodeNames(db: SqliteDatabase, stmts: NodeStmts): string[] {
  if (!stmts.getAllNodeNames) {
    stmts.getAllNodeNames = db.prepare('SELECT DISTINCT name FROM nodes');
  }
  const rows = stmts.getAllNodeNames.all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
