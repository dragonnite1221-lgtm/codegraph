/**
 * Per-tool handlers for the MCP ToolHandler.execute dispatch. Free functions
 * taking the handler context (ToolHandlerCtx) so they can live outside the
 * class. Split out of tools.ts to stay within the file-size gate.
 */

import type { NodeKind } from '../types';
import type { ToolResult } from './tool-types';
import {
  type ToolHandlerCtx,
  boundedNumber,
  markSessionConsulted,
  optionalBoundedNumber,
} from './tool-args';
import { buildExploreOutput } from './explore-output';
import {
  DEFAULT_MCP_FILES_LIMIT,
  filterMcpFiles,
  formatMcpFiles,
  limitMcpFiles,
  type McpFileEntry,
} from './files-output';
import { buildContextOutput } from './context-output';
import { buildNodeOutput, buildSearchOutput } from './lookup-output';
import { buildCallersOutput, buildCalleesOutput, buildImpactOutput } from './relationship-output';
import { buildMcpStatusOutput } from './status-output';

export async function handleSearch(ctx: ToolHandlerCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const query = ctx.validateString(args.query, 'query');
  if (typeof query !== 'string') return query;

  const cg = ctx.getCodeGraph(args.projectPath as string | undefined);
  const kind = args.kind as NodeKind | undefined;
  const limit = boundedNumber(args.limit, 10, 1, 100);

  return ctx.textResult(ctx.truncateOutput(buildSearchOutput(cg, query, { limit, kind })));
}

export async function handleContext(ctx: ToolHandlerCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const task = ctx.validateString(args.task, 'task');
  if (typeof task !== 'string') return task;

  // Mark session as consulted (enables Grep/Glob/Bash)
  const sessionId = process.env.CLAUDE_SESSION_ID;
  if (sessionId) {
    markSessionConsulted(sessionId);
  }

  const cg = ctx.getCodeGraph(args.projectPath as string | undefined);
  const maxNodes = boundedNumber(args.maxNodes, 20, 1, 100);
  const includeCode = args.includeCode !== false;

  return ctx.textResult(await buildContextOutput(cg, task, { maxNodes, includeCode }));
}

export async function handleCallers(ctx: ToolHandlerCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = ctx.validateString(args.symbol, 'symbol');
  if (typeof symbol !== 'string') return symbol;

  const cg = ctx.getCodeGraph(args.projectPath as string | undefined);
  const limit = boundedNumber(args.limit, 20, 1, 100);

  return ctx.textResult(ctx.truncateOutput(buildCallersOutput(cg, symbol, limit)));
}

export async function handleCallees(ctx: ToolHandlerCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = ctx.validateString(args.symbol, 'symbol');
  if (typeof symbol !== 'string') return symbol;

  const cg = ctx.getCodeGraph(args.projectPath as string | undefined);
  const limit = boundedNumber(args.limit, 20, 1, 100);

  return ctx.textResult(ctx.truncateOutput(buildCalleesOutput(cg, symbol, limit)));
}

export async function handleImpact(ctx: ToolHandlerCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = ctx.validateString(args.symbol, 'symbol');
  if (typeof symbol !== 'string') return symbol;

  const cg = ctx.getCodeGraph(args.projectPath as string | undefined);
  const depth = boundedNumber(args.depth, 2, 1, 10);

  return ctx.textResult(ctx.truncateOutput(buildImpactOutput(cg, symbol, depth)));
}

export async function handleExplore(ctx: ToolHandlerCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const query = ctx.validateString(args.query, 'query');
  if (typeof query !== 'string') return query;

  const cg = ctx.getCodeGraph(args.projectPath as string | undefined);
  const output = await buildExploreOutput(cg, query, {
    maxFiles: optionalBoundedNumber(args.maxFiles, 1, 20),
  });
  return ctx.textResult(output);
}

export async function handleNode(ctx: ToolHandlerCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = ctx.validateString(args.symbol, 'symbol');
  if (typeof symbol !== 'string') return symbol;

  const cg = ctx.getCodeGraph(args.projectPath as string | undefined);
  const includeCode = args.includeCode === true;

  return ctx.textResult(ctx.truncateOutput(await buildNodeOutput(cg, symbol, includeCode)));
}

export async function handleStatus(ctx: ToolHandlerCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = ctx.getCodeGraph(args.projectPath as string | undefined);
  return ctx.textResult(buildMcpStatusOutput(cg));
}

export async function handleFiles(ctx: ToolHandlerCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = ctx.getCodeGraph(args.projectPath as string | undefined);
  const pathFilter = args.path as string | undefined;
  const pattern = args.pattern as string | undefined;
  const format = (args.format as 'tree' | 'flat' | 'grouped') || 'tree';
  const includeMetadata = args.includeMetadata !== false;
  const maxDepth = optionalBoundedNumber(args.maxDepth, 1, 20);
  const limit = boundedNumber(args.limit, DEFAULT_MCP_FILES_LIMIT, 1, 5000);

  const totalIndexedFiles = pathFilter || pattern ? undefined : cg.countFiles();
  if (totalIndexedFiles === 0) {
    return ctx.textResult('No files indexed. Run `codegraph index` first.');
  }

  let files: McpFileEntry[];
  let omitted = 0;
  if (pattern) {
    const pathScopedFiles = cg.getFiles({ pathPrefix: pathFilter });
    files = filterMcpFiles(pathScopedFiles, { pattern });
    const limited = limitMcpFiles(files, limit);
    files = limited.files;
    omitted = limited.omitted;
  } else {
    const totalMatches = cg.countFiles({ pathPrefix: pathFilter });
    files = cg.getFiles({ pathPrefix: pathFilter, limit });
    omitted = Math.max(0, totalMatches - files.length);
  }

  if (files.length === 0) {
    return ctx.textResult(`No files found matching the criteria.`);
  }

  const output = formatMcpFiles(files, { includeMetadata, format, maxDepth, omitted });

  return ctx.textResult(ctx.truncateOutput(output));
}
