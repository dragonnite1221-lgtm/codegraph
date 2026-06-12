/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the CodeGraph MCP server.
 */

import CodeGraph, { findNearestCodeGraphRoot } from '../index';
import type { NodeKind } from '../types';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { clamp } from '../utils';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { buildExploreOutput, getExploreBudget } from './explore-output';
import { filterMcpFiles, formatMcpFiles } from './files-output';
import {
  formatNodeDetails,
  formatSearchResults,
} from './format-output';
import { buildContextOutput } from './context-output';
import {
  findAllSymbols as resolveAllSymbols,
  findSymbol as resolveSymbol,
  type SymbolMatch,
  type SymbolMatches,
} from './symbol-resolution';
import { buildCallersOutput, buildCalleesOutput, buildImpactOutput } from './relationship-output';
import { buildMcpStatusOutput } from './status-output';
import { tools } from './tool-definitions';
import type { ToolDefinition, ToolResult } from './tool-types';

export { tools } from './tool-definitions';
export { getExploreBudget, getExploreOutputBudget } from './explore-output';
export type { ToolDefinition, ToolResult } from './tool-types';
export type { ExploreOutputBudget } from './explore-output';

/** Maximum output length to prevent context bloat (characters) */
const MAX_OUTPUT_LENGTH = 15000;
const MAX_PROJECT_CACHE_SIZE = 32;

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null || value === '') {
    return fallback;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

function optionalBoundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : undefined;
}

/**
 * Mark a Claude session as having consulted MCP tools.
 * This enables Grep/Glob/Bash commands that would otherwise be blocked.
 */
function markSessionConsulted(sessionId: string): void {
  try {
    const hash = createHash('md5').update(sessionId).digest('hex').slice(0, 16);
    const markerPath = join(tmpdir(), `codegraph-consulted-${hash}`);
    writeFileSync(markerPath, new Date().toISOString(), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    // Silently fail - don't break MCP on marker write failure
  }
}

/**
 * Tool handler that executes tools against a CodeGraph instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export class ToolHandler {
  // Cache of opened CodeGraph instances for cross-project queries, keyed by
  // resolved project root to avoid duplicate SQLite handles for path aliases.
  private projectCache: Map<string, CodeGraph> = new Map();

  constructor(private cg: CodeGraph | null) {}

  /**
   * Update the default CodeGraph instance (e.g. after lazy initialization)
   */
  setDefaultCodeGraph(cg: CodeGraph): void {
    this.cg = cg;
  }

  /**
   * Whether a default CodeGraph instance is available
   */
  hasDefaultCodeGraph(): boolean {
    return this.cg !== null;
  }

  /**
   * Get tool definitions with dynamic descriptions based on project size.
   * The codegraph_explore tool description includes a budget recommendation
   * scaled to the number of indexed files.
   */
  getTools(): ToolDefinition[] {
    if (!this.cg) return tools;

    try {
      const stats = this.cg.getStats();
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

  /**
   * Get CodeGraph instance for a project
   *
   * If projectPath is provided, opens that project's CodeGraph (cached).
   * Otherwise returns the default CodeGraph instance.
   *
   * Walks up parent directories to find the nearest .codegraph/ folder,
   * similar to how git finds .git/ directories.
   */
  private getCodeGraph(projectPath?: string): CodeGraph {
    if (!projectPath) {
      if (!this.cg) {
        throw new Error('CodeGraph not initialized for this project. Run \'codegraph init\' first.');
      }
      return this.cg;
    }

    const requestedPath = resolve(projectPath);

    // Walk up parent directories to find nearest .codegraph/
    const resolvedRoot = findNearestCodeGraphRoot(requestedPath);

    if (!resolvedRoot) {
      throw new Error(`CodeGraph not initialized in ${projectPath}. Run 'codegraph init' in that project first.`);
    }

    if (this.projectCache.has(resolvedRoot)) {
      return this.projectCache.get(resolvedRoot)!;
    }

    const cg = CodeGraph.openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    this.evictOldestCachedProjects();
    return cg;
  }

  private evictOldestCachedProjects(): void {
    while (this.projectCache.size > MAX_PROJECT_CACHE_SIZE) {
      const oldest = this.projectCache.entries().next().value;
      if (!oldest) return;
      const [projectRoot, cg] = oldest;
      this.projectCache.delete(projectRoot);
      cg.close();
    }
  }

  /**
   * Close all cached project connections
   */
  closeAll(): void {
    for (const cg of new Set(this.projectCache.values())) {
      cg.close();
    }
    this.projectCache.clear();
  }

  /**
   * Validate that a value is a non-empty string
   */
  private validateString(value: unknown, name: string): string | ToolResult {
    if (typeof value !== 'string' || value.length === 0) {
      return this.errorResult(`${name} must be a non-empty string`);
    }
    return value;
  }

  /**
   * Execute a tool by name
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'codegraph_search':
          return await this.handleSearch(args);
        case 'codegraph_context':
          return await this.handleContext(args);
        case 'codegraph_callers':
          return await this.handleCallers(args);
        case 'codegraph_callees':
          return await this.handleCallees(args);
        case 'codegraph_impact':
          return await this.handleImpact(args);
        case 'codegraph_explore':
          return await this.handleExplore(args);
        case 'codegraph_node':
          return await this.handleNode(args);
        case 'codegraph_status':
          return await this.handleStatus(args);
        case 'codegraph_files':
          return await this.handleFiles(args);
        default:
          return this.errorResult(`Unknown tool: ${toolName}`);
      }
    } catch (err) {
      return this.errorResult(`Tool execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle codegraph_search
   */
  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const kind = args.kind as string | undefined;
    const rawLimit = Number(args.limit) || 10;
    const limit = clamp(rawLimit, 1, 100);

    const results = cg.searchNodes(query, {
      limit,
      kinds: kind ? [kind as NodeKind] : undefined,
    });

    if (results.length === 0) {
      return this.textResult(`No results found for "${query}"`);
    }

    const formatted = formatSearchResults(results);
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_context
   */
  private async handleContext(args: Record<string, unknown>): Promise<ToolResult> {
    const task = this.validateString(args.task, 'task');
    if (typeof task !== 'string') return task;

    // Mark session as consulted (enables Grep/Glob/Bash)
    const sessionId = process.env.CLAUDE_SESSION_ID;
    if (sessionId) {
      markSessionConsulted(sessionId);
    }

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const maxNodes = boundedNumber(args.maxNodes, 20, 1, 100);
    const includeCode = args.includeCode !== false;

    return this.textResult(await buildContextOutput(cg, task, { maxNodes, includeCode }));
  }

  /**
   * Handle codegraph_callers
   */
  private async handleCallers(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = boundedNumber(args.limit, 20, 1, 100);

    return this.textResult(this.truncateOutput(buildCallersOutput(cg, symbol, limit)));
  }

  /**
   * Handle codegraph_callees
   */
  private async handleCallees(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = boundedNumber(args.limit, 20, 1, 100);

    return this.textResult(this.truncateOutput(buildCalleesOutput(cg, symbol, limit)));
  }

  /**
   * Handle codegraph_impact
   */
  private async handleImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const depth = boundedNumber(args.depth, 2, 1, 10);

    return this.textResult(this.truncateOutput(buildImpactOutput(cg, symbol, depth)));
  }

  /**
   * Handle codegraph_explore — deep exploration in a single call
   *
   * Strategy: find relevant symbols via graph traversal, group by file,
   * then read contiguous file sections covering all symbols per file.
   * This replaces multiple codegraph_node + Read calls.
   *
   * Output size is adaptive to project file count via
   * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
   * tax on small projects while earning its keep on large ones.
   */
  private async handleExplore(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const output = await buildExploreOutput(cg, query, {
      maxFiles: optionalBoundedNumber(args.maxFiles, 1, 20),
    });
    return this.textResult(output);
  }

  /**
   * Handle codegraph_node
   */
  private async handleNode(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    // Default to false to minimize context usage
    const includeCode = args.includeCode === true;

    const match = this.findSymbol(cg, symbol);
    if (!match) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    let code: string | null = null;

    if (includeCode) {
      code = await cg.getCode(match.node.id);
    }

    const formatted = formatNodeDetails(match.node, code) + match.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_status
   */
  private async handleStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    return this.textResult(buildMcpStatusOutput(cg));
  }

  /**
   * Handle codegraph_files - get project file structure from the index
   */
  private async handleFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const pathFilter = args.path as string | undefined;
    const pattern = args.pattern as string | undefined;
    const format = (args.format as 'tree' | 'flat' | 'grouped') || 'tree';
    const includeMetadata = args.includeMetadata !== false;
    const maxDepth = optionalBoundedNumber(args.maxDepth, 1, 20);

    // Get all files from the index
    const allFiles = cg.getFiles();

    if (allFiles.length === 0) {
      return this.textResult('No files indexed. Run `codegraph index` first.');
    }

    const files = filterMcpFiles(allFiles, { pathFilter, pattern });

    if (files.length === 0) {
      return this.textResult(`No files found matching the criteria.`);
    }

    const output = formatMcpFiles(files, { includeMetadata, format, maxDepth });

    return this.textResult(this.truncateOutput(output));
  }

  // =========================================================================
  // Symbol resolution helpers
  // =========================================================================

  // Kept as wrappers for compatibility with existing tests that inspect
  // ToolHandler internals; the implementation lives in symbol-resolution.ts.
  private findSymbol(cg: CodeGraph, symbol: string): SymbolMatch | null {
    return resolveSymbol(cg, symbol);
  }

  findAllSymbols(cg: CodeGraph, symbol: string): SymbolMatches {
    return resolveAllSymbols(cg, symbol);
  }

  /**
   * Truncate output if it exceeds the maximum length
   */
  private truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
    return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
  }

  private textResult(text: string): ToolResult {
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
