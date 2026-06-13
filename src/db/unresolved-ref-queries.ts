import type { UnresolvedReference } from '../types';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import { type UnresolvedRefRow, rowToUnresolvedReference } from './row-mappers';

type StatementRunner = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;

export type ResolvedReferenceKey = {
  fromNodeId: string;
  referenceName: string;
  referenceKind: string;
};

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

  const placeholders = filePaths.map(() => '?').join(',');
  const rows = runStatement(
    `SELECT * FROM unresolved_refs WHERE file_path IN (${placeholders})`,
    (stmt) => stmt.all(...filePaths) as UnresolvedRefRow[]
  );

  return rows.map(rowToUnresolvedReference);
}

export function runDeleteResolvedReferences(
  runStatement: StatementRunner,
  fromNodeIds: string[]
): void {
  if (fromNodeIds.length === 0) return;

  const placeholders = fromNodeIds.map(() => '?').join(',');
  runStatement(
    `DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`,
    (stmt) => stmt.run(...fromNodeIds)
  );
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
