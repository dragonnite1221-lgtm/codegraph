/**
 * Context Formatter
 *
 * Formats TaskContext as markdown or JSON for consumption by Claude.
 */

import { Node, Edge, TaskContext, Subgraph } from '../types';
import { formatNodeTree, serializeNode, serializeEdge } from './formatter-helpers';
export { formatBytes } from './formatter-helpers';

/**
 * Format context as markdown
 *
 * Creates a compact markdown document optimized for Claude with minimal context usage:
 * - Brief summary
 * - Entry points with locations
 * - Code blocks only for key symbols
 */
export function formatContextAsMarkdown(context: TaskContext): string {
  const lines: string[] = [];

  // Header with query
  lines.push('## Code Context\n');
  lines.push(`**Query:** ${context.query}\n`);

  // Entry points - compact format
  if (context.entryPoints.length > 0) {
    lines.push('### Entry Points\n');
    for (const node of context.entryPoints) {
      const location = node.startLine ? `:${node.startLine}` : '';
      lines.push(`- **${node.name}** (${node.kind}) - ${node.filePath}${location}`);
      if (node.signature) {
        lines.push(`  \`${node.signature}\``);
      }
    }
    lines.push('');
  }

  // Related symbols - compact list (skip verbose structure tree)
  const otherSymbols = Array.from(context.subgraph.nodes.values())
    .filter(n => !context.entryPoints.some(e => e.id === n.id))
    .slice(0, 10); // Limit to 10 related symbols

  if (otherSymbols.length > 0) {
    lines.push('### Related Symbols\n');
    const byFile = new Map<string, Node[]>();
    for (const node of otherSymbols) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
      lines.push(`- ${file}: ${nodeList}`);
    }
    lines.push('');
  }

  // Code blocks - only for key entry points
  if (context.codeBlocks.length > 0) {
    lines.push('### Code\n');
    for (const block of context.codeBlocks) {
      const nodeName = block.node?.name ?? 'Unknown';
      lines.push(`#### ${nodeName} (${block.filePath}:${block.startLine})\n`);
      lines.push('```' + block.language);
      lines.push(block.content);
      lines.push('```\n');
    }
  }

  return lines.join('\n');
}

/**
 * Format context as JSON
 *
 * Returns a structured JSON representation suitable for programmatic use.
 */
export function formatContextAsJson(context: TaskContext): string {
  // Convert Map to array for JSON serialization
  const serializable = {
    query: context.query,
    summary: context.summary,
    entryPoints: context.entryPoints.map(serializeNode),
    nodes: Array.from(context.subgraph.nodes.values()).map(serializeNode),
    edges: context.subgraph.edges.map(serializeEdge),
    codeBlocks: context.codeBlocks.map((block) => ({
      filePath: block.filePath,
      startLine: block.startLine,
      endLine: block.endLine,
      language: block.language,
      content: block.content,
      nodeName: block.node?.name,
      nodeKind: block.node?.kind,
    })),
    relatedFiles: context.relatedFiles,
    stats: context.stats,
  };

  return JSON.stringify(serializable, null, 2);
}

/**
 * Format a subgraph as an ASCII tree structure
 */
export function formatSubgraphTree(subgraph: Subgraph, entryPoints: Node[]): string {
  const lines: string[] = [];
  const printed = new Set<string>();

  // Build adjacency list for outgoing edges
  const outgoing = new Map<string, Edge[]>();
  for (const edge of subgraph.edges) {
    const existing = outgoing.get(edge.source) ?? [];
    existing.push(edge);
    outgoing.set(edge.source, existing);
  }

  // Print each entry point as a tree root
  for (const entry of entryPoints) {
    formatNodeTree(entry, subgraph, outgoing, printed, lines, 0, '');
    lines.push(''); // Blank line between trees
  }

  // Print any remaining nodes not reached from entry points
  const remaining: Node[] = [];
  for (const node of subgraph.nodes.values()) {
    if (!printed.has(node.id)) {
      remaining.push(node);
    }
  }

  if (remaining.length > 0 && remaining.length <= 10) {
    lines.push('Other relevant symbols:');
    for (const node of remaining) {
      const location = node.startLine ? `:${node.startLine}` : '';
      lines.push(`  ${node.kind}: ${node.name} (${node.filePath}${location})`);
    }
  } else if (remaining.length > 10) {
    lines.push(`... and ${remaining.length} more related symbols`);
  }

  return lines.join('\n').trim();
}
