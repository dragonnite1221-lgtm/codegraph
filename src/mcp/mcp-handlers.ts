/**
 * MCPServer JSON-RPC request handlers (initialize / tools.list / tools.call)
 * and the URI helper + server constants. Free functions operating on
 * McpServerCore. Split out of index.ts to stay within the file-size gate.
 */

import * as path from 'path';
import { JsonRpcRequest, ErrorCodes } from './transport';
import { tools } from './tools';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { type McpServerCore, tryInitializeDefault, retryInitIfNeeded } from './mcp-lifecycle';

/** MCP Server Info */
const SERVER_INFO = {
  name: 'codegraph',
  version: '0.1.0',
};

/** MCP Protocol Version */
const PROTOCOL_VERSION = '2024-11-05';

/**
 * Convert a file:// URI to a filesystem path.
 * Handles URL encoding and Windows drive letter paths.
 */
export function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    let filePath = decodeURIComponent(url.pathname);
    // On Windows, file:///C:/path produces pathname /C:/path — strip leading /
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return path.resolve(filePath);
  } catch {
    // Fallback for non-standard URIs
    return uri.replace(/^file:\/\/\/?/, '');
  }
}

/** Handle initialize request */
export async function handleInitialize(server: McpServerCore, request: JsonRpcRequest): Promise<void> {
  const params = request.params as {
    rootUri?: string;
    workspaceFolders?: Array<{ uri: string; name: string }>;
  } | undefined;

  // Extract project path from rootUri or workspaceFolders
  let projectPath = server.projectPath;

  if (params?.rootUri) {
    projectPath = fileUriToPath(params.rootUri);
  } else if (params?.workspaceFolders?.[0]?.uri) {
    projectPath = fileUriToPath(params.workspaceFolders[0].uri);
  }

  // Fall back to current working directory if no path provided
  if (!projectPath) {
    projectPath = process.cwd();
  }

  // Respond to the handshake BEFORE doing any heavy initialization. Loading
  // the SQLite DB and the tree-sitter WASM runtime can take many seconds on
  // slow filesystems (Docker Desktop VirtioFS on macOS, WSL2). Clients like
  // Claude Code time out the handshake at ~30s, which manifested as
  // "MCP tools never appear" — the child was alive and had received the
  // initialize but was still awaiting initGrammars(). See issue #172.
  //
  // We accept the client's protocol version but respond with our supported
  // version. The `instructions` field is surfaced by MCP clients in the
  // agent's system prompt automatically — it's the right place for the
  // universal tool-selection playbook, ahead of individual tool descriptions.
  server.transport.sendResult(request.id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
  });

  // Kick off the default-project init in the background. Tool calls that
  // arrive before it finishes will see the "not initialized yet" path and
  // fall through to `retryInitIfNeeded`, which now waits for this promise
  // rather than racing against it with a second open.
  server.initPromise = tryInitializeDefault(server, projectPath).finally(() => {
    server.initPromise = null;
  });
}

/** Handle tools/list request */
export async function handleToolsList(server: McpServerCore, request: JsonRpcRequest): Promise<void> {
  await retryInitIfNeeded(server);
  server.transport.sendResult(request.id, {
    tools: server.toolHandler.getTools(),
  });
}

/** Handle tools/call request */
export async function handleToolsCall(server: McpServerCore, request: JsonRpcRequest): Promise<void> {
  const params = request.params as {
    name: string;
    arguments?: Record<string, unknown>;
  };

  if (!params || !params.name) {
    server.transport.sendError(request.id, ErrorCodes.InvalidParams, 'Missing tool name');
    return;
  }

  const toolName = params.name;
  const toolArgs = params.arguments || {};

  // Validate tool exists
  const tool = tools.find(t => t.name === toolName);
  if (!tool) {
    server.transport.sendError(request.id, ErrorCodes.InvalidParams, `Unknown tool: ${toolName}`);
    return;
  }

  // If the default project isn't initialized yet, retry in case it was
  // initialized after the MCP server started (e.g. user ran codegraph init)
  await retryInitIfNeeded(server);

  const result = await server.toolHandler.execute(toolName, toolArgs);

  server.transport.sendResult(request.id, result);
}
