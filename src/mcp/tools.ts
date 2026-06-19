/**
 * MCP Tool Definitions
 *
 * The ToolHandler wires the MCP tools to CodeGraph instances. Cross-project
 * caching/lifecycle lives in ProjectCache (tool-project-cache.ts), the per-tool
 * handlers in tool-handlers.ts, and arg coercion in tool-args.ts — split out to
 * stay within the file-size gate.
 *
 * Supports cross-project queries via the projectPath parameter.
 */

import type CodeGraph from '../index';
import { getExploreBudget } from './explore-output';
import {
  findAllSymbols as resolveAllSymbols,
  findSymbol as resolveSymbol,
  type SymbolMatch,
  type SymbolMatches,
} from './symbol-resolution';
import { tools } from './tool-definitions';
import type { ToolDefinition, ToolResult } from './tool-types';
import { ProjectCache } from './tool-project-cache';
import {
  handleCallees,
  handleCallers,
  handleContext,
  handleExplore,
  handleFiles,
  handleImpact,
  handleNode,
  handleSearch,
  handleStatus,
} from './tool-handlers';

export { tools } from './tool-definitions';
export { getExploreBudget, getExploreOutputBudget } from './explore-output';
export type { ToolDefinition, ToolResult } from './tool-types';
export type { ExploreOutputBudget } from './explore-output';

/** Maximum output length to prevent context bloat (characters) */
const MAX_OUTPUT_LENGTH = 15000;

/**
 * Tool handler that executes tools against a CodeGraph instance.
 * Other projects are opened on-demand and cached for performance.
 */
export class ToolHandler {
  private cache: ProjectCache;

  constructor(cg: CodeGraph | null) {
    this.cache = new ProjectCache(cg);
  }

  /** Update the default CodeGraph instance (e.g. after lazy initialization) */
  setDefaultCodeGraph(cg: CodeGraph): void {
    this.cache.setDefault(cg);
  }

  /** Whether a default CodeGraph instance is available */
  hasDefaultCodeGraph(): boolean {
    return this.cache.hasDefault();
  }

  /**
   * Get tool definitions with dynamic descriptions based on project size.
   * The codegraph_explore tool description includes a budget recommendation
   * scaled to the number of indexed files.
   */
  getTools(): ToolDefinition[] {
    const cg = this.cache.getDefault();
    if (!cg) return tools;

    try {
      const stats = cg.getStats();
      const budget = getExploreBudget(stats.fileCount);

      return tools.map(tool => {
        if (tool.name === 'codegraph_explore') {
          return {
            ...tool,
            description: `${tool.description} Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).`,
          };
        }
        return tool;
      });
    } catch {
      return tools;
    }
  }

  /** Get CodeGraph instance for a project (default, or opened on-demand). */
  getCodeGraph(projectPath?: string): CodeGraph {
    return this.cache.getCodeGraph(projectPath);
  }

  /** Close all cached project connections */
  closeAll(): void {
    this.cache.closeAll();
  }

  /** Validate that a value is a non-empty string */
  validateString(value: unknown, name: string): string | ToolResult {
    if (typeof value !== 'string' || value.length === 0) {
      return this.errorResult(`${name} must be a non-empty string`);
    }
    return value;
  }

  /**
   * Execute a tool by name
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.cache.beginExecution();
    try {
      switch (toolName) {
        case 'codegraph_search': return await handleSearch(this, args);
        case 'codegraph_context': return await handleContext(this, args);
        case 'codegraph_callers': return await handleCallers(this, args);
        case 'codegraph_callees': return await handleCallees(this, args);
        case 'codegraph_impact': return await handleImpact(this, args);
        case 'codegraph_explore': return await handleExplore(this, args);
        case 'codegraph_node': return await handleNode(this, args);
        case 'codegraph_status': return await handleStatus(this, args);
        case 'codegraph_files': return await handleFiles(this, args);
        default:
          return this.errorResult(`Unknown tool: ${toolName}`);
      }
    } catch (err) {
      return this.errorResult(`Tool execution failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.cache.endExecution();
    }
  }

  // Kept as wrappers for compatibility with existing tests that inspect
  // ToolHandler internals; the implementation lives in symbol-resolution.ts.
  findSymbol(cg: CodeGraph, symbol: string): SymbolMatch | null {
    return resolveSymbol(cg, symbol);
  }

  findAllSymbols(cg: CodeGraph, symbol: string): SymbolMatches {
    return resolveAllSymbols(cg, symbol);
  }

  /** Truncate output if it exceeds the maximum length */
  truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
    return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
  }

  textResult(text: string): ToolResult {
    return {
      content: [{ type: 'text', text }],
    };
  }

  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
