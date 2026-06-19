/**
 * node-sqlite3-wasm adapter matching the better-sqlite3 interface. Split out of
 * sqlite-adapter.ts to stay within the file-size gate.
 *
 * Key differences handled:
 * - better-sqlite3 uses @named params; node-sqlite3-wasm uses positional ? only
 * - better-sqlite3 uses variadic args: stmt.run(a, b, c)
 * - node-sqlite3-wasm uses a single array/object: stmt.run([a, b, c])
 * - node-sqlite3-wasm has `isOpen` instead of `open`
 * - node-sqlite3-wasm doesn't have `pragma()` / `transaction()` methods
 */

import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import { rollbackAndRethrowTransactionError } from './sqlite-adapter';
import { resolveParams, translateNamedParams } from './sqlite-params';

export class WasmDatabaseAdapter implements SqliteDatabase {
  private _db: any;
  private _closed = false;
  // Track WASM statement handles so VACUUM and close can finalize them.
  // The wrapper can lazily reprepare after a release, preserving the reusable
  // statement contract that callers expect from better-sqlite3.
  private _openStmts = new Set<{ sql: string; stmt: any | null }>();

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('node-sqlite3-wasm');
    this._db = new Database(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    const { sql: rewrittenSql, paramOrder } = translateNamedParams(sql);
    const record = { sql: rewrittenSql, stmt: this._db.prepare(rewrittenSql) };
    this._openStmts.add(record);
    let finalized = false;

    const getStmt = () => {
      if (this._closed) {
        throw new Error('Database already closed');
      }
      if (finalized) {
        throw new Error('Statement already finalized');
      }
      if (!record.stmt) {
        record.stmt = this._db.prepare(record.sql);
      }
      return record.stmt;
    };

    const finalizeRecord = () => {
      if (!record.stmt) {
        this._openStmts.delete(record);
        return;
      }
      try {
        record.stmt.finalize();
      } catch {
        // Already finalized by the WASM runtime.
      }
      record.stmt = null;
      this._openStmts.delete(record);
    };

    return {
      run(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        const stmt = getStmt();
        const result = resolved !== undefined ? stmt.run(resolved) : stmt.run();
        return {
          changes: result?.changes ?? 0,
          lastInsertRowid: result?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        const stmt = getStmt();
        return resolved !== undefined ? stmt.get(resolved) : stmt.get();
      },
      all(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        const stmt = getStmt();
        return resolved !== undefined ? stmt.all(resolved) : stmt.all();
      },
      finalize() {
        finalized = true;
        finalizeRecord();
      },
    };
  }

  exec(sql: string): void {
    if (sql.trim().toUpperCase().startsWith('VACUUM')) {
      this.releaseStatements();
    }
    this._db.exec(sql);
  }

  pragma(str: string): any {
    const trimmed = str.trim();

    // Write pragma: "key = value"
    if (trimmed.includes('=')) {
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();

      // WAL is not supported in WASM SQLite — use DELETE journal mode
      if (key === 'journal_mode' && value.toUpperCase() === 'WAL') {
        this._db.exec('PRAGMA journal_mode = DELETE');
        return;
      }

      // mmap is not available in WASM — silently skip
      if (key === 'mmap_size') {
        return;
      }

      // synchronous = NORMAL is unsafe without WAL — use FULL
      if (key === 'synchronous' && value.toUpperCase() === 'NORMAL') {
        this._db.exec('PRAGMA synchronous = FULL');
        return;
      }

      this._db.exec(`PRAGMA ${key} = ${value}`);
      return;
    }

    // Read pragma: "key" — return the value
    const stmt = this._db.prepare(`PRAGMA ${trimmed}`);
    const result = stmt.get();
    stmt.finalize();
    return result;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        rollbackAndRethrowTransactionError(this._db, error);
      }
    };
  }

  close(): void {
    if (this._closed || !this._db.isOpen) {
      this._closed = true;
      return;
    }
    this.releaseStatements(true);
    this._db.close();
    this._closed = true;
  }

  private releaseStatements(clearRecords = false): void {
    // node-sqlite3-wasm keeps SQL statements active until finalized. Leaving
    // them open blocks VACUUM and can make repeated close paths throw.
    for (const record of this._openStmts) {
      if (!record.stmt) continue;
      try {
        record.stmt.finalize();
      } catch {
        // Already finalized by the WASM runtime.
      }
      record.stmt = null;
    }
    if (clearRecords) {
      this._openStmts.clear();
    }
  }
}
