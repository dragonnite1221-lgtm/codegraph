import type { UnresolvedReference } from '../types';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import { type UnresolvedRefRow, rowToUnresolvedReference } from './row-mappers';

type StatementRunner = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;
const SQLITE_VARIABLE_CHUNK_SIZE = 900;

export type ResolvedReferenceKey = {
  fromNodeId: string;
  referenceName: string;
  referenceKind: string;
};

function chunkValues<T>(values: T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += SQLITE_VARIABLE_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + SQLITE_VARIABLE_CHUNK_SIZE));
  }
  return chunks;
}

export class UnresolvedReferenceQueries {
  private stmts: {
    insert?: SqliteStatement;
    deleteByNode?: SqliteStatement;
    getByName?: SqliteStatement;
    count?: SqliteStatement;
    batch?: SqliteStatement;
  } = {};

  constructor(
    private readonly db: SqliteDatabase,
    private readonly runStatement: StatementRunner
  ) {}

  insert(ref: UnresolvedReference): void {
    if (!this.stmts.insert) {
      this.stmts.insert = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
    }

    this.stmts.insert.run({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
      candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
      filePath: ref.filePath ?? '',
      language: ref.language ?? 'unknown',
    });
  }

  insertBatch(refs: UnresolvedReference[]): void {
    if (refs.length === 0) return;

    const insert = this.db.transaction(() => {
      for (const ref of refs) {
        this.insert(ref);
      }
    });
    insert();
  }

  deleteByNode(nodeId: string): void {
    if (!this.stmts.deleteByNode) {
      this.stmts.deleteByNode = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ?'
      );
    }
    this.stmts.deleteByNode.run(nodeId);
  }

  getByName(name: string): UnresolvedReference[] {
    if (!this.stmts.getByName) {
      this.stmts.getByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = this.stmts.getByName.all(name) as UnresolvedRefRow[];
    return rows.map(rowToUnresolvedReference);
  }

  getAll(): UnresolvedReference[] {
    return runGetUnresolvedReferences(this.runStatement);
  }

  count(): number {
    if (!this.stmts.count) {
      this.stmts.count = this.db.prepare('SELECT COUNT(*) as count FROM unresolved_refs');
    }
    const row = this.stmts.count.get() as { count: number };
    return row.count;
  }

  getBatch(offset: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.batch) {
      this.stmts.batch = this.db.prepare(
        'SELECT * FROM unresolved_refs ORDER BY id LIMIT ? OFFSET ?'
      );
    }
    const rows = this.stmts.batch.all(limit, offset) as UnresolvedRefRow[];
    return rows.map(rowToUnresolvedReference);
  }

  getByFiles(filePaths: string[]): UnresolvedReference[] {
    return runGetUnresolvedReferencesByFiles(this.runStatement, filePaths);
  }

  clear(): void {
    this.db.exec('DELETE FROM unresolved_refs');
  }

  deleteResolved(fromNodeIds: string[]): void {
    runDeleteResolvedReferences(this.runStatement, fromNodeIds);
  }

  deleteSpecificResolved(refs: ResolvedReferenceKey[]): void {
    runDeleteSpecificResolvedReferences(this.db, refs);
  }
}

export function runGetUnresolvedReferences(
  runStatement: StatementRunner
): UnresolvedReference[] {
  const rows = runStatement(
    'SELECT * FROM unresolved_refs',
    (stmt) => stmt.all() as UnresolvedRefRow[]
  );
  return rows.map(rowToUnresolvedReference);
}

export function runGetUnresolvedReferencesByFiles(
  runStatement: StatementRunner,
  filePaths: string[]
): UnresolvedReference[] {
  if (filePaths.length === 0) return [];

  const rows: UnresolvedRefRow[] = [];
  for (const chunk of chunkValues(filePaths)) {
    const placeholders = chunk.map(() => '?').join(',');
    const chunkRows = runStatement(
      `SELECT * FROM unresolved_refs WHERE file_path IN (${placeholders})`,
      (stmt) => stmt.all(...chunk) as UnresolvedRefRow[]
    );
    for (const row of chunkRows) {
      rows.push(row);
    }
  }

  return rows.map(rowToUnresolvedReference);
}

export function runDeleteResolvedReferences(
  runStatement: StatementRunner,
  fromNodeIds: string[]
): void {
  if (fromNodeIds.length === 0) return;

  for (const chunk of chunkValues(fromNodeIds)) {
    const placeholders = chunk.map(() => '?').join(',');
    runStatement(
      `DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`,
      (stmt) => stmt.run(...chunk)
    );
  }
}

export function runDeleteSpecificResolvedReferences(
  db: SqliteDatabase,
  refs: ResolvedReferenceKey[]
): void {
  if (refs.length === 0) return;

  const stmt = db.prepare(
    'DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
  );
  const deleteMany = db.transaction((items: ResolvedReferenceKey[]) => {
    for (const ref of items) {
      stmt.run(ref.fromNodeId, ref.referenceName, ref.referenceKind);
    }
  });

  try {
    deleteMany(refs);
  } finally {
    stmt.finalize?.();
  }
}
