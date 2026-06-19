/**
 * Edge CRUD with lazy prepared statements. Split out of queries.ts to stay
 * within the file-size gate; QueryBuilder composes this and delegates.
 */

import { Edge, EdgeKind } from '../types';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import { type EdgeRow, rowToEdge } from './row-mappers';
import {
  hasOutgoingEdgeFilters,
  runFindEdgesBetweenNodes,
  runGetFilteredOutgoingEdges,
  runGetIncomingEdgesByKinds,
} from './edge-queries';

type StatementRunner = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;

export class EdgeQueries {
  private stmts: {
    insertEdge?: SqliteStatement;
    deleteEdgesBySource?: SqliteStatement;
    getEdgesBySource?: SqliteStatement;
    getEdgesByTarget?: SqliteStatement;
  } = {};

  constructor(
    private readonly db: SqliteDatabase,
    private readonly runStatement: StatementRunner
  ) {}

  /** Insert a new edge */
  insertEdge(edge: Edge): void {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
      `);
    }

    this.stmts.insertEdge.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      line: edge.line ?? null,
      col: edge.column ?? null,
      provenance: edge.provenance ?? null,
    });
  }

  /** Insert multiple edges in a transaction */
  insertEdges(edges: Edge[]): void {
    this.db.transaction(() => {
      for (const edge of edges) {
        this.insertEdge(edge);
      }
    })();
  }

  /** Delete all edges from a source node */
  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /** Get outgoing edges from a node */
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    if (hasOutgoingEdgeFilters(kinds, provenance)) {
      return runGetFilteredOutgoingEdges(this.runStatement, sourceId, kinds, provenance);
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /** Get incoming edges to a node */
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      return runGetIncomingEdgesByKinds(this.runStatement, targetId, kinds);
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Find all edges where both source and target are in the given node set.
   * Useful for recovering inter-node connectivity after BFS.
   */
  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    return runFindEdgesBetweenNodes(this.runStatement, nodeIds, kinds);
  }
}
