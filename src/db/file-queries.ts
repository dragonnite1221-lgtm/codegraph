import type { FileRecord } from '../types';
import type { SqliteStatement } from './sqlite-adapter';
import { type FileRow, rowToFileRecord } from './row-mappers';

export type FileQueryOptions = {
  pathPrefix?: string;
  limit?: number;
};

type StatementRunner = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;

function normalizePathPrefix(pathPrefix?: string): string | undefined {
  let value = pathPrefix?.trim();
  while (value?.startsWith('./')) {
    value = value.slice(2);
  }
  return value || undefined;
}

function normalizeLimit(limit?: number): number | undefined {
  return limit && limit > 0 ? Math.floor(limit) : undefined;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, char => `\\${char}`);
}

function buildFilePrefixWhere(pathPrefix?: string): { clause: string; params: unknown[] } {
  const normalized = normalizePathPrefix(pathPrefix);
  if (!normalized) {
    return { clause: '', params: [] };
  }
  return {
    clause: " WHERE path LIKE ? ESCAPE '\\'",
    params: [`${escapeSqlLike(normalized)}%`],
  };
}

export function hasFileQueryFilters(options: FileQueryOptions = {}): boolean {
  return normalizePathPrefix(options.pathPrefix) !== undefined || normalizeLimit(options.limit) !== undefined;
}

export function runGetFilteredFiles(
  runStatement: StatementRunner,
  options: FileQueryOptions = {}
): FileRecord[] {
  const where = buildFilePrefixWhere(options.pathPrefix);
  const limit = normalizeLimit(options.limit);
  let sql = `SELECT * FROM files${where.clause} ORDER BY path`;
  const params = [...where.params];

  if (limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const rows = runStatement(sql, stmt => stmt.all(...params) as FileRow[]);
  return rows.map(rowToFileRecord);
}

export function runCountFiles(
  runStatement: StatementRunner,
  options: Pick<FileQueryOptions, 'pathPrefix'> = {}
): number {
  const where = buildFilePrefixWhere(options.pathPrefix);
  const row = runStatement(
    `SELECT COUNT(*) as count FROM files${where.clause}`,
    stmt => stmt.get(...where.params) as { count?: number } | undefined,
  );
  return Number(row?.count || 0);
}
