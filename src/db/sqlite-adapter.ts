/**
 * SQLite Adapter
 *
 * Provides a unified interface over better-sqlite3 (native) and
 * node-sqlite3-wasm (WASM fallback) for universal cross-platform support.
 */

import { WasmDatabaseAdapter } from './sqlite-wasm-adapter';

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


// Named-parameter translation lives in sqlite-params.ts (re-exported here for
// stable import paths); the WASM adapter in sqlite-wasm-adapter.ts.
export { translateNamedParams } from './sqlite-params';

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
