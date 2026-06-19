/**
 * File-record CRUD with lazy prepared statements. Split out of queries.ts to
 * stay within the file-size gate; QueryBuilder composes this and delegates.
 */

import { FileRecord } from '../types';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import { type FileRow, rowToFileRecord } from './row-mappers';
import {
  hasFileQueryFilters,
  runCountFiles,
  runGetFilteredFiles,
  type FileQueryOptions,
} from './file-queries';

type StatementRunner = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;

export class FileQueries {
  private stmts: {
    upsertFile?: SqliteStatement;
    deleteFile?: SqliteStatement;
    getFileByPath?: SqliteStatement;
    getAllFiles?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
  } = {};

  constructor(
    private readonly db: SqliteDatabase,
    private readonly runStatement: StatementRunner,
    private readonly deleteNodesByFile: (filePath: string) => void
  ) {}

  /** Insert or update a file record */
  upsertFile(file: FileRecord): void {
    if (!this.stmts.upsertFile) {
      this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors
      `);
    }

    this.stmts.upsertFile.run({
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : null,
    });
  }

  /** Delete a file record and its nodes */
  deleteFile(filePath: string): void {
    this.db.transaction(() => {
      this.deleteNodesByFile(filePath);
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      this.stmts.deleteFile.run(filePath);
    })();
  }

  /** Get a file record by path */
  getFileByPath(filePath: string): FileRecord | null {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  /** Get all tracked files */
  getAllFiles(options: FileQueryOptions = {}): FileRecord[] {
    if (!hasFileQueryFilters(options)) {
      if (!this.stmts.getAllFiles) {
        this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
      }
      const rows = this.stmts.getAllFiles.all() as FileRow[];
      return rows.map(rowToFileRecord);
    }

    return runGetFilteredFiles(this.runStatement, options);
  }

  countFiles(options: Pick<FileQueryOptions, 'pathPrefix'> = {}): number {
    return runCountFiles(this.runStatement, options);
  }

  /** Get files that need re-indexing (hash changed) */
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter((f) => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  /** Get all tracked file paths (lightweight — no full FileRecord objects) */
  getAllFilePaths(): string[] {
    if (!this.stmts.getAllFilePaths) {
      this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }
}
