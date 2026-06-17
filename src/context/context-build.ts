/**
 * buildContext implementation split out of context/index.ts to keep it within
 * the 200-line limit. No behavior change.
 */

import type {
  Subgraph,
  TaskContext,
  TaskInput,
  BuildContextOptions,
  FindRelevantContextOptions,
} from '../types';
import { formatContextAsMarkdown, formatContextAsJson } from './formatter';
import {
  extractCodeBlocks,
  generateSummary,
  getEntryPoints,
  getRelatedFiles,
} from './context-helpers';

const DEFAULT_BUILD_OPTIONS: Required<BuildContextOptions> = {
  maxNodes: 20,           // Reduced from 50 - most tasks don't need 50 symbols
  maxCodeBlocks: 5,       // Reduced from 10 - only show most relevant code
  maxCodeBlockSize: 1500, // Reduced from 2000
  includeCode: true,
  format: 'markdown',
  searchLimit: 3,         // Reduced from 5 - fewer entry points
  traversalDepth: 1,      // Reduced from 2 - shallower graph expansion
  minScore: 0.3,
};

export async function buildContext(
  projectRoot: string,
  findRelevantContext: (
    query: string,
    options: FindRelevantContextOptions,
  ) => Promise<Subgraph>,
  input: TaskInput,
  options: BuildContextOptions = {},
): Promise<TaskContext | string> {
    const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };

    // Parse input
    const query = typeof input === 'string' ? input : `${input.title}${input.description ? `: ${input.description}` : ''}`;

    // Find relevant context (semantic search + graph expansion)
    const subgraph = await findRelevantContext(query, {
      searchLimit: opts.searchLimit,
      traversalDepth: opts.traversalDepth,
      maxNodes: opts.maxNodes,
      minScore: opts.minScore,
    });

    // Get entry points (nodes from semantic search)
    const entryPoints = getEntryPoints(subgraph);

    // Extract code blocks for key nodes
    const codeBlocks = opts.includeCode
      ? await extractCodeBlocks(subgraph, opts.maxCodeBlocks, opts.maxCodeBlockSize, projectRoot)
      : [];

    // Get related files
    const relatedFiles = getRelatedFiles(subgraph);

    // Generate summary
    const summary = generateSummary(query, subgraph, entryPoints);

    // Calculate stats
    const stats = {
      nodeCount: subgraph.nodes.size,
      edgeCount: subgraph.edges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
    };

    const context: TaskContext = {
      query,
      subgraph,
      entryPoints,
      codeBlocks,
      relatedFiles,
      summary,
      stats,
    };

    // Return formatted output or raw context
    if (opts.format === 'markdown') {
      return formatContextAsMarkdown(context);
    } else if (opts.format === 'json') {
      return formatContextAsJson(context);
    }

    return context;
}
