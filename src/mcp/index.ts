/**
 * CodeGraph MCP Server
 *
 * Model Context Protocol server that exposes CodeGraph functionality
 * as tools for AI assistants like Claude.
 *
 * @module mcp
 *
 * @example
 * ```typescript
 * import { MCPServer } from 'codegraph';
 *
 * const server = new MCPServer('/path/to/project');
 * await server.start();
 * ```
 *
 * The init lifecycle and JSON-RPC request handlers live in mcp-lifecycle.ts /
 * mcp-handlers.ts (operating on this server via McpServerCore) to stay within
 * the file-size gate; this class owns the state + message dispatch.
 */

import CodeGraph from '../index';
import { StdioTransport, JsonRpcRequest, JsonRpcNotification, ErrorCodes } from './transport';
import { ToolHandler } from './tools';
import type { McpServerCore } from './mcp-lifecycle';
import { handleInitialize, handleToolsCall, handleToolsList } from './mcp-handlers';

/**
 * MCP Server for CodeGraph
 *
 * Implements the Model Context Protocol to expose CodeGraph
 * functionality as tools that can be called by AI assistants.
 */
export class MCPServer implements McpServerCore {
  transport: StdioTransport;
  cg: CodeGraph | null = null;
  toolHandler: ToolHandler;
  projectPath: string | null;
  initPromise: Promise<void> | null = null;

  constructor(projectPath?: string) {
    this.projectPath = projectPath || null;
    this.transport = new StdioTransport();
    // Create ToolHandler eagerly — cross-project queries work even without a default project
    this.toolHandler = new ToolHandler(null);
  }

  /**
   * Start the MCP server
   *
   * Note: CodeGraph initialization is deferred until the initialize request
   * is received, which includes the rootUri from the client.
   */
  async start(): Promise<void> {
    // Start listening for messages immediately - don't check initialization yet
    // We'll get the project path from the initialize request's rootUri
    this.transport.start(this.handleMessage.bind(this));

    // Keep the process running
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());

    // When the parent process (Claude Code) exits, stdin closes.
    // Detect this and shut down gracefully to prevent orphaned processes.
    process.stdin.on('end', () => this.stop());
    process.stdin.on('close', () => this.stop());
  }

  /**
   * Stop the server
   */
  stop(): void {
    // Close all cached cross-project connections first
    this.toolHandler.closeAll();
    // Close the main CodeGraph instance
    if (this.cg) {
      this.cg.close();
      this.cg = null;
    }
    this.transport.stop();
    process.exit(0);
  }

  /**
   * Handle incoming JSON-RPC messages
   */
  private async handleMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    // Check if it's a request (has id) or notification (no id)
    const isRequest = 'id' in message;

    switch (message.method) {
      case 'initialize':
        if (isRequest) {
          await handleInitialize(this, message as JsonRpcRequest);
        }
        break;

      case 'initialized':
        // Notification that client has finished initialization
        // No action needed - the client is ready
        break;

      case 'tools/list':
        if (isRequest) {
          await handleToolsList(this, message as JsonRpcRequest);
        }
        break;

      case 'tools/call':
        if (isRequest) {
          await handleToolsCall(this, message as JsonRpcRequest);
        }
        break;

      case 'ping':
        if (isRequest) {
          this.transport.sendResult((message as JsonRpcRequest).id, {});
        }
        break;

      default:
        if (isRequest) {
          this.transport.sendError(
            (message as JsonRpcRequest).id,
            ErrorCodes.MethodNotFound,
            `Method not found: ${message.method}`
          );
        }
    }
  }
}

// Export for use in CLI
export { StdioTransport } from './transport';
export { tools, ToolHandler } from './tools';
