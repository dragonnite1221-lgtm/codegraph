/**
 * Helpers shared across `AgentTarget` implementations.
 *
 * Lifted from the original `config-writer.ts` so each target can
 * compose them without inheritance. Kept deliberately small — the
 * targets are different enough (JSON vs TOML vs Markdown, varying
 * idempotency markers) that a base class would force the awkward
 * shape onto everyone.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * The MCP-server config block codegraph injects. Same shape across
 * all JSON-shaped agent configs (Claude, Cursor, opencode), only the
 * surrounding wrapper differs. Codex (TOML) builds its own block.
 */
export function getMcpServerConfig(): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

/**
 * Permissions list for Claude `settings.json`. Other targets that
 * have a permissions concept can compose this list directly. The
 * permission strings follow Claude's `mcp__<server>__<tool>` format.
 */
export function getCodeGraphPermissions(): string[] {
  return [
    'mcp__codegraph__codegraph_search',
    'mcp__codegraph__codegraph_context',
    'mcp__codegraph__codegraph_callers',
    'mcp__codegraph__codegraph_callees',
    'mcp__codegraph__codegraph_impact',
    'mcp__codegraph__codegraph_node',
    'mcp__codegraph__codegraph_status',
  ];
}

/**
 * Raised when a config file exists but cannot be parsed as JSON.
 *
 * Callers that are about to *rewrite* the file must let this propagate
 * rather than proceed — writing on top of a failed parse would replace
 * the user's real config (all their other MCP servers, settings) with
 * just our codegraph entry. See `readJsonFileForUpdate`.
 */
export class JsonParseError extends Error {
  constructor(
    readonly filePath: string,
    readonly backupPath: string | null,
    readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const where = backupPath
      ? ` A backup of the original was saved to ${path.basename(backupPath)}.`
      : '';
    super(
      `Refusing to overwrite ${path.basename(filePath)}: it exists but is not valid JSON (${detail}). ` +
      `Fix or remove the file, then re-run.${where}`,
    );
    this.name = 'JsonParseError';
  }
}

/**
 * Copy an unparseable file to a timestamped, non-overwriting backup.
 *
 * The name includes a timestamp + pid so a second run never clobbers
 * the first backup (the original bug: a fixed `<path>.backup` meant a
 * second run overwrote the only good copy with already-corrupt data).
 * Returns the backup path, or null if the backup itself failed.
 */
function backupUnparseableFile(filePath: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.corrupt-${stamp}.${process.pid}.bak`;
  try {
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(filePath, backupPath);
    }
    return backupPath;
  } catch {
    return null;
  }
}

/**
 * Read a JSON file for read-only inspection (detect / has* checks).
 *
 * Returns `{}` when the file is missing OR unparseable. Safe precisely
 * because callers only READ the result — they never write it back, so
 * the `{}` fallback here cannot destroy an existing config. Side-effect
 * free (no backup, no write) so repeated detection never litters the
 * directory. Paths that mutate-and-write must use
 * `readJsonFileForUpdate` instead.
 */
export function readJsonFile(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Could not parse ${path.basename(filePath)}: ${msg}`);
    return {};
  }
}

/**
 * Read a JSON file that is about to be merged and written back.
 *
 * Returns `{}` for a genuinely missing file (first install). But when
 * the file EXISTS and fails to parse, it makes a timestamped backup and
 * throws `JsonParseError` — the caller must NOT continue, because the
 * next step would be to `writeJsonFile` our entry over the top and wipe
 * the user's real config. Missing != corrupt: only the latter aborts.
 */
export function readJsonFileForUpdate(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const backupPath = backupUnparseableFile(filePath);
    throw new JsonParseError(filePath, backupPath, err);
  }
}

/**
 * Write a file atomically: write to `<path>.tmp.<pid>`, then rename.
 *
 * Prevents corruption if the process crashes mid-write. The temp
 * file is cleaned up on rename failure.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Atomic JSON write. Trailing newline matches the convention every
 * existing target had — preserves diff-friendly file shape.
 */
export function writeJsonFile(filePath: string, data: Record<string, any>): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Compare two JSON values for deep equality, ignoring key order.
 *
 * Used for idempotency: when the on-disk config already exactly
 * matches what we'd write, return action=`unchanged` instead of
 * re-writing (and emitting a confusing "Updated" log line).
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => jsonDeepEqual(ao[k], bo[k]));
}

export {
  replaceOrAppendMarkedSection,
  removeMarkedSection,
} from './shared-sections';
