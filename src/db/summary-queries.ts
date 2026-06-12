/**
 * Database summary and metadata queries.
 *
 * These helpers keep aggregate/reporting SQL out of the CRUD-heavy QueryBuilder
 * while preserving QueryBuilder as the public facade.
 */

import { EdgeKind, GraphStats, Language, NodeKind } from '../types';
import { SqliteStatement } from './sqlite-adapter';

export interface StatementRunner {
  runStatement<T>(sql: string, fn: (stmt: SqliteStatement) => T): T;
}

export function runGetStats(context: StatementRunner): GraphStats {
  const counts = context.runStatement(
    `
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM files) AS file_count
    `,
    (stmt) => stmt.get() as { node_count: number; edge_count: number; file_count: number }
  );

  const nodesByKind = {} as Record<NodeKind, number>;
  const nodeKindRows = context.runStatement(
    'SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind',
    (stmt) => stmt.all() as Array<{ kind: string; count: number }>
  );
  for (const row of nodeKindRows) {
    nodesByKind[row.kind as NodeKind] = row.count;
  }

  const edgesByKind = {} as Record<EdgeKind, number>;
  const edgeKindRows = context.runStatement(
    'SELECT kind, COUNT(*) as count FROM edges GROUP BY kind',
    (stmt) => stmt.all() as Array<{ kind: string; count: number }>
  );
  for (const row of edgeKindRows) {
    edgesByKind[row.kind as EdgeKind] = row.count;
  }

  const filesByLanguage = {} as Record<Language, number>;
  const languageRows = context.runStatement(
    'SELECT language, COUNT(*) as count FROM files GROUP BY language',
    (stmt) => stmt.all() as Array<{ language: string; count: number }>
  );
  for (const row of languageRows) {
    filesByLanguage[row.language as Language] = row.count;
  }

  return {
    nodeCount: counts.node_count,
    edgeCount: counts.edge_count,
    fileCount: counts.file_count,
    nodesByKind,
    edgesByKind,
    filesByLanguage,
    dbSizeBytes: 0,
    lastUpdated: Date.now(),
  };
}

export function runGetMetadata(context: StatementRunner, key: string): string | null {
  const row = context.runStatement(
    'SELECT value FROM project_metadata WHERE key = ?',
    (stmt) => stmt.get(key) as { value: string } | undefined
  );
  return row?.value ?? null;
}

export function runSetMetadata(context: StatementRunner, key: string, value: string): void {
  context.runStatement(
    'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    (stmt) => stmt.run(key, value, Date.now())
  );
}

export function runGetAllMetadata(context: StatementRunner): Record<string, string> {
  const rows = context.runStatement(
    'SELECT key, value FROM project_metadata',
    (stmt) => stmt.all() as { key: string; value: string }[]
  );
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
