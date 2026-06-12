/**
 * MCP status output helpers.
 */

import type { SqliteBackend } from '../db';
import { WASM_FALLBACK_FIX_RECIPE } from '../db';
import type { GraphStats } from '../types';

export interface StatusProvider {
  getStats(): GraphStats;
  getBackend(): SqliteBackend;
}

export function buildMcpStatusOutput(cg: StatusProvider): string {
  const stats = cg.getStats();
  const lines: string[] = [
    '## CodeGraph Status',
    '',
    `**Files indexed:** ${stats.fileCount}`,
    `**Total nodes:** ${stats.nodeCount}`,
    `**Total edges:** ${stats.edgeCount}`,
    `**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
  ];

  // Surface the active SQLite backend. Without this, users on the
  // silent WASM fallback (better-sqlite3 install failed) see "slow"
  // indexing and DB-lock errors with no signal of why.
  const backend = cg.getBackend();
  if (backend === 'native') {
    lines.push(`**Backend:** native (better-sqlite3)`);
  } else {
    lines.push(
      `**Backend:** ⚠ wasm (better-sqlite3 unavailable) — ` +
      `5-10x slower than native. Fix: ${WASM_FALLBACK_FIX_RECIPE}`
    );
  }

  lines.push('', '### Nodes by Kind:');

  for (const [kind, count] of Object.entries(stats.nodesByKind)) {
    if ((count as number) > 0) {
      lines.push(`- ${kind}: ${count}`);
    }
  }

  lines.push('', '### Languages:');
  for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
    if ((count as number) > 0) {
      lines.push(`- ${lang}: ${count}`);
    }
  }

  return lines.join('\n');
}
