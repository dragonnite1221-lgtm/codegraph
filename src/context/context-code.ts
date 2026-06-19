/**
 * Source-code extraction for context building: read a node's lines and select
 * prioritized code blocks. Split out of context-helpers.ts to stay within the
 * file-size gate.
 */

import * as fs from 'fs';
import type { CodeBlock, Node, Subgraph } from '../types';
import { validatePathWithinRoot } from '../utils';
import { logDebug } from '../errors';

/** Extract code from a node's source file (the lines spanning the node). */
export async function extractNodeCode(node: Node, projectRoot: string): Promise<string | null> {
  const filePath = validatePathWithinRoot(projectRoot, node.filePath);

  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Extract lines (1-indexed to 0-indexed)
    const startIdx = Math.max(0, node.startLine - 1);
    const endIdx = Math.min(lines.length, node.endLine);

    return lines.slice(startIdx, endIdx).join('\n');
  } catch (error) {
    logDebug('Failed to extract code from node', { nodeId: node.id, filePath: node.filePath, error: String(error) });
    return null;
  }
}

/**
 * Extract code blocks for key nodes in the subgraph, prioritizing entry
 * points, then functions/methods, then classes, up to maxBlocks.
 */
export async function extractCodeBlocks(
  subgraph: Subgraph,
  maxBlocks: number,
  maxBlockSize: number,
  projectRoot: string
): Promise<CodeBlock[]> {
  const blocks: CodeBlock[] = [];

  // Prioritize entry points, then functions/methods
  const priorityNodes: Node[] = [];

  // First: entry points
  for (const id of subgraph.roots) {
    const node = subgraph.nodes.get(id);
    if (node) {
      priorityNodes.push(node);
    }
  }

  // Then: functions and methods
  for (const node of subgraph.nodes.values()) {
    if (!subgraph.roots.includes(node.id)) {
      if (node.kind === 'function' || node.kind === 'method') {
        priorityNodes.push(node);
      }
    }
  }

  // Then: classes
  for (const node of subgraph.nodes.values()) {
    if (!subgraph.roots.includes(node.id)) {
      if (node.kind === 'class') {
        priorityNodes.push(node);
      }
    }
  }

  // Extract code for priority nodes
  for (const node of priorityNodes) {
    if (blocks.length >= maxBlocks) break;

    const code = await extractNodeCode(node, projectRoot);
    if (code) {
      // Truncate if too long. Language-neutral marker (no `//` — not a
      // comment in Python, Ruby, etc.); this renders inside a fenced
      // source block whose language varies.
      const truncated = code.length > maxBlockSize
        ? code.slice(0, maxBlockSize) + '\n... (truncated) ...'
        : code;

      blocks.push({
        content: truncated,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        language: node.language,
        node,
      });
    }
  }

  return blocks;
}
