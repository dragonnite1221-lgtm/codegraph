/**
 * Context builder helpers
 *
 * Subgraph-derived assembly used by ContextBuilder: node source extraction,
 * code-block selection, entry-point/related-file collection, summary text, and
 * import→definition resolution. Pulled out as pure functions taking explicit
 * deps so the ContextBuilder stays focused on orchestration.
 */

import * as fs from 'fs';

import type {
  CodeBlock,
  EdgeKind,
  Node,
  SearchResult,
  Subgraph,
} from '../types';
import type { QueryBuilder } from '../db/queries';
import { validatePathWithinRoot } from '../utils';
import { logDebug } from '../errors';

/**
 * Extract code from a node's source file (the lines spanning the node).
 */
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
 * Get entry points from a subgraph (the root nodes).
 */
export function getEntryPoints(subgraph: Subgraph): Node[] {
  return subgraph.roots
    .map((id) => subgraph.nodes.get(id))
    .filter((n): n is Node => n !== undefined);
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

/**
 * Get unique files from a subgraph (sorted).
 */
export function getRelatedFiles(subgraph: Subgraph): string[] {
  const files = new Set<string>();
  for (const node of subgraph.nodes.values()) {
    files.add(node.filePath);
  }
  return Array.from(files).sort();
}

/**
 * Generate a one-line summary of the context.
 */
export function generateSummary(_query: string, subgraph: Subgraph, entryPoints: Node[]): string {
  const nodeCount = subgraph.nodes.size;
  const edgeCount = subgraph.edges.length;
  const files = getRelatedFiles(subgraph);

  const entryPointNames = entryPoints
    .slice(0, 3)
    .map((n) => n.name)
    .join(', ');

  const remaining = entryPoints.length > 3 ? ` and ${entryPoints.length - 3} more` : '';

  return `Found ${nodeCount} relevant code symbols across ${files.length} files. ` +
    `Key entry points: ${entryPointNames}${remaining}. ` +
    `${edgeCount} relationships identified.`;
}

/**
 * Resolve import/export nodes to their actual definitions.
 *
 * When search returns `import { TerminalPanel }`, users want the TerminalPanel
 * class definition, not the import statement. This follows the `imports` /
 * `exports` edge to find and return the actual definition instead.
 */
export function resolveImportsToDefinitions(
  results: SearchResult[],
  queries: QueryBuilder
): SearchResult[] {
  const resolved: SearchResult[] = [];
  const seenIds = new Set<string>();

  for (const result of results) {
    const { node, score } = result;

    // If it's not an import/export, keep it as-is
    if (node.kind !== 'import' && node.kind !== 'export') {
      if (!seenIds.has(node.id)) {
        seenIds.add(node.id);
        resolved.push(result);
      }
      continue;
    }

    // For imports/exports, try to find what they reference
    // Imports have outgoing 'imports' edges to the definition
    // Exports have outgoing 'exports' edges to the definition
    const edgeKind = node.kind === 'import' ? 'imports' : 'exports';
    const outgoingEdges = queries.getOutgoingEdges(node.id, [edgeKind as EdgeKind]);

    let foundDefinition = false;
    for (const edge of outgoingEdges) {
      const targetNode = queries.getNodeById(edge.target);
      if (targetNode && !seenIds.has(targetNode.id)) {
        // Found the definition - use it instead of the import
        seenIds.add(targetNode.id);
        resolved.push({
          node: targetNode,
          score: score, // Preserve the original score
        });
        foundDefinition = true;
        logDebug('Resolved import to definition', {
          import: node.name,
          definition: targetNode.name,
          kind: targetNode.kind,
        });
      }
    }

    // If we couldn't resolve the import, skip it (it's low-value on its own)
    if (!foundDefinition) {
      logDebug('Skipping unresolved import', { name: node.name, file: node.filePath });
    }
  }

  return resolved;
}
