/**
 * SQLite Adapter
 *
 * Provides a unified interface over better-sqlite3 (native) and
 * node-sqlite3-wasm (WASM fallback) for universal cross-platform support.
 */

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  finalize?(): void;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

export type SqliteBackend = 'native' | 'wasm';

/**
 * One-line summary of the recovery steps shown when WASM fallback is
 * active. Single source of truth so the recipe can't drift between the
 * stderr banner and the MCP status formatter.
 */
export const WASM_FALLBACK_FIX_RECIPE =
  '`xcode-select --install` (macOS) or `apt install build-essential` (Debian/Ubuntu), ' +
  'then `npm rebuild better-sqlite3`, or `npm install better-sqlite3 --save` to force-include it.';

/**
 * Multi-line banner shown to stderr when `createDatabase` falls back to
 * WASM. Replaces a one-line `console.warn` that MCP transports (which
 * take stdout for the protocol) typically swallow, leaving users on a
 * 5-10x slower backend with no signal.
 *
 * Exported for unit testing — pinning the recipe content prevents
 * future edits from silently stripping the recovery commands.
 */
export function buildWasmFallbackBanner(nativeError?: string): string {
  const sep = '─'.repeat(72);
  const lines = [
    sep,
    '[CodeGraph] WASM SQLite fallback active (better-sqlite3 unavailable)',
    sep,
    'Indexing and sync will be 5-10x slower than the native backend.',
    '',
    'Fix on macOS:',
    '  xcode-select --install        # install C build tools',
    '  npm rebuild better-sqlite3    # rebuild native binding for current Node',
    '',
    'Fix on Linux:',
    '  sudo apt install build-essential python3 make    # Debian/Ubuntu',
    '  # or: sudo yum groupinstall "Development Tools"  # RHEL/Fedora',
    '  npm rebuild better-sqlite3',
    '',
    'Or force-include as a hard dependency on any platform:',
    '  npm install better-sqlite3 --save',
    '',
    'Verify after fix: `codegraph status` should show `Backend: native`.',
  ];
  if (nativeError) {
    lines.push('', `Native load error: ${nativeError}`);
  }
  lines.push(sep);
  return lines.join('\n');
}

/**
 * Translate @named parameters (better-sqlite3 style) to positional ? params
 * for node-sqlite3-wasm, which only supports positional binding.
 *
 * Returns the rewritten SQL and an ordered list of parameter names.
 * If no named params are found, returns null for paramOrder (positional mode).
 */
export function translateNamedParams(sql: string): { sql: string; paramOrder: string[] | null } {
  const paramOrder: string[] = [];
  let rewritten = '';
  let i = 0;
  let state:
    | 'code'
    | 'single'
    | 'double'
    | 'backtick'
    | 'bracket'
    | 'line-comment'
    | 'block-comment' = 'code';

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (state === 'line-comment') {
      rewritten += ch;
      if (ch === '\n') state = 'code';
      i += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        rewritten += '*/';
        state = 'code';
        i += 2;
      } else {
        rewritten += ch;
        i += 1;
      }
      continue;
    }

    if (state === 'single') {
      rewritten += ch;
      if (ch === "'" && next === "'") {
        rewritten += next;
        i += 2;
      } else {
        if (ch === "'") state = 'code';
        i += 1;
      }
      continue;
    }

    if (state === 'double') {
      rewritten += ch;
      if (ch === '"' && next === '"') {
        rewritten += next;
        i += 2;
      } else {
        if (ch === '"') state = 'code';
        i += 1;
      }
      continue;
    }

    if (state === 'backtick') {
      rewritten += ch;
      if (ch === '`' && next === '`') {
        rewritten += next;
        i += 2;
      } else {
        if (ch === '`') state = 'code';
        i += 1;
      }
      continue;
    }

    if (state === 'bracket') {
      rewritten += ch;
      if (ch === ']' && next === ']') {
        rewritten += next;
        i += 2;
      } else {
        if (ch === ']') state = 'code';
        i += 1;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      rewritten += '--';
      state = 'line-comment';
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      rewritten += '/*';
      state = 'block-comment';
      i += 2;
      continue;
    }

    if (ch === "'") {
      rewritten += ch;
      state = 'single';
      i += 1;
      continue;
    }

    if (ch === '"') {
      rewritten += ch;
      state = 'double';
      i += 1;
      continue;
    }

    if (ch === '`') {
      rewritten += ch;
      state = 'backtick';
      i += 1;
      continue;
    }

    if (ch === '[') {
      rewritten += ch;
      state = 'bracket';
      i += 1;
      continue;
    }

    if (ch === '@' && next && /\w/.test(next)) {
      let end = i + 1;
      while (end < sql.length) {
        const paramChar = sql[end];
        if (!paramChar || !/\w/.test(paramChar)) break;
        end += 1;
      }
      paramOrder.push(sql.slice(i + 1, end));
      rewritten += '?';
      i = end;
      continue;
    }

    rewritten += ch;
    i += 1;
  }

  if (paramOrder.length === 0) {
    return { sql, paramOrder: null };
  }
  return { sql: rewritten, paramOrder };
}

/**
 * Convert better-sqlite3-style params to a positional array for node-sqlite3-wasm.
 *
 * Handles three calling conventions:
 * - Named object: run({ id: '1', name: 'a' }) → positional array via paramOrder
 * - Positional args: run('a', 'b') → ['a', 'b']
 * - No args: run() → undefined
 */
function resolveParams(params: any[], paramOrder: string[] | null): any {
  if (params.length === 0) return undefined;

  // If paramOrder exists and first arg is a plain object, do named→positional translation
  if (paramOrder && params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0]) && !(params[0] instanceof Buffer) && !(params[0] instanceof Uint8Array)) {
    const obj = params[0];
    return paramOrder.map(name => obj[name]);
  }

  // Positional: single value or already an array
  if (params.length === 1) return params[0];
  return params;
}

export function rollbackAndRethrowTransactionError(
  db: { exec(sql: string): void },
  error: unknown
): never {
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite can auto-rollback on some failures; preserve the original
    // database error instead of replacing it with "no transaction".
  }
  throw error;
}

/**
 * Wraps node-sqlite3-wasm to match the better-sqlite3 interface.
 *
 * Key differences handled:
 * - better-sqlite3 uses @named params; node-sqlite3-wasm uses positional ? only
 * - better-sqlite3 uses variadic args: stmt.run(a, b, c)
 * - node-sqlite3-wasm uses a single array/object: stmt.run([a, b, c])
 * - node-sqlite3-wasm has `isOpen` instead of `open`
 * - node-sqlite3-wasm doesn't have a `pragma()` method
 * - node-sqlite3-wasm doesn't have a `transaction()` method
 */
class WasmDatabaseAdapter implements SqliteDatabase {
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

/**
 * Create a database connection. Tries native better-sqlite3 first,
 * falls back to node-sqlite3-wasm. Returns the active backend
 * alongside the db so each `DatabaseConnection` can report its own
 * backend per-instance — MCP can open multiple project DBs in one
 * process (`tools.ts` getCodeGraph cache), so a process-global would
 * race / overwrite.
 */
export function createDatabase(dbPath: string): { db: SqliteDatabase; backend: SqliteBackend } {
  let nativeError: string | undefined;
  let wasmError: string | undefined;

  // Try native better-sqlite3 first
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    return { db: db as SqliteDatabase, backend: 'native' };
  } catch (error) {
    nativeError = error instanceof Error ? error.message : String(error);
  }

  // Fall back to WASM
  try {
    const db = new WasmDatabaseAdapter(dbPath);
    console.warn(buildWasmFallbackBanner(nativeError));
    return { db, backend: 'wasm' };
  } catch (error) {
    wasmError = error instanceof Error ? error.message : String(error);
  }

  throw new Error(
    `Failed to load any SQLite backend.\n` +
    `  Native (better-sqlite3): ${nativeError}\n` +
    `  WASM (node-sqlite3-wasm): ${wasmError}`
  );
}
