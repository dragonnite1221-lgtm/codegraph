/**
 * MCPServer default-project initialization lifecycle: lazy open, retry, and
 * file-watching. Free functions operating on the server's mutable state via
 * McpServerCore. Split out of index.ts to stay within the file-size gate.
 */

import CodeGraph, { findNearestCodeGraphRoot } from '../index';
import type { StdioTransport } from './transport';
import type { ToolHandler } from './tools';

/** Mutable MCPServer state the lifecycle + request handlers operate on. */
export interface McpServerCore {
  transport: StdioTransport;
  toolHandler: ToolHandler;
  cg: CodeGraph | null;
  projectPath: string | null;
  // In-flight background init kicked off from handleInitialize. Tracked so the
  // sync retry path doesn't race against it (double-opening the SQLite file).
  initPromise: Promise<void> | null;
}

/**
 * Try to initialize CodeGraph for the default project. Walks up parent
 * directories to find the nearest .codegraph/. Failures are logged but
 * non-fatal — cross-project queries and later retries still work.
 */
export async function tryInitializeDefault(server: McpServerCore, projectPath: string): Promise<void> {
  // Walk up parent directories to find nearest .codegraph/
  const resolvedRoot = findNearestCodeGraphRoot(projectPath);

  if (!resolvedRoot) {
    server.projectPath = projectPath;
    return;
  }

  server.projectPath = resolvedRoot;

  try {
    server.cg = await CodeGraph.open(resolvedRoot);
    server.toolHandler.setDefaultCodeGraph(server.cg);
    startWatching(server);
  } catch (err) {
    // Log the error so transient failures are diagnosable (see issue #47)
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[CodeGraph MCP] Failed to open project at ${resolvedRoot}: ${msg}\n`);
  }
}

/**
 * Retry initialization of the default project if it previously failed. Awaits
 * any in-flight background init (from handleInitialize) so we never open the
 * SQLite file twice concurrently, then re-walks for a .codegraph/ root.
 */
export async function retryInitIfNeeded(server: McpServerCore): Promise<void> {
  // Wait for the background init started during handleInitialize, if any.
  if (server.initPromise) {
    try { await server.initPromise; } catch { /* errored init falls through to retry */ }
  }

  // Already initialized successfully
  if (server.toolHandler.hasDefaultCodeGraph()) return;
  // No project path to retry with
  if (!server.projectPath) return;

  const resolvedRoot = findNearestCodeGraphRoot(server.projectPath);
  if (!resolvedRoot) return;

  try {
    // Close any previously failed instance to avoid leaking resources
    if (server.cg) {
      try { server.cg.close(); } catch { /* ignore */ }
      server.cg = null;
    }
    server.cg = CodeGraph.openSync(resolvedRoot);
    server.projectPath = resolvedRoot;
    server.toolHandler.setDefaultCodeGraph(server.cg);
    startWatching(server);
  } catch {
    // Still failing — will retry on next tool call
  }
}

/**
 * Start file watching on the active CodeGraph instance. Logs sync activity to
 * stderr for diagnostics.
 */
export function startWatching(server: McpServerCore): void {
  if (!server.cg) return;

  const started = server.cg.watch({
    onSyncComplete: (result) => {
      if (result.filesChanged > 0) {
        process.stderr.write(
          `[CodeGraph MCP] Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms\n`
        );
      }
    },
    onSyncError: (err) => {
      process.stderr.write(`[CodeGraph MCP] Auto-sync error: ${err.message}\n`);
    },
  });

  if (started) {
    process.stderr.write('[CodeGraph MCP] File watcher active — graph will auto-sync on changes\n');
  }
}
