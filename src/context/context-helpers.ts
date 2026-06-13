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
  Edge,
  EdgeKind,
  FindRelevantContextOptions,
  Node,
  SearchResult,
  Subgraph,
} from '../types';
import type { QueryBuilder } from '../db/queries';
import type { GraphTraverser } from '../graph';
import { validatePathWithinRoot } from '../utils';
import { isTestFile } from '../search/query-utils';
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

/**
 * Assemble the final context subgraph from scored search results.
 *
 * Takes the fully-scored candidate set and builds the returned subgraph:
 * min-score filtering, import→definition resolution, entry-point capping,
 * type-hierarchy expansion, BFS traversal, max-node / per-file / non-prod
 * trimming, and edge recovery. Pure given (searchResults, opts, deps).
 */
export function assembleContextSubgraph(
  searchResults: SearchResult[],
  opts: Required<FindRelevantContextOptions>,
  isTestQuery: boolean,
  deps: { traverser: GraphTraverser; queries: QueryBuilder }
): Subgraph {
  const { traverser, queries } = deps;
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const roots: string[] = [];

    searchResults.sort((a, b) => b.score - a.score);
    searchResults = searchResults.slice(0, opts.searchLimit * 3);

    // Filter by minimum score
    let filteredResults = searchResults.filter((r) => r.score >= opts.minScore);

    // Resolve imports/exports to their actual definitions
    // If someone searches "terminal" and finds `import { TerminalPanel }`,
    // they want the TerminalPanel class, not the import statement
    filteredResults = resolveImportsToDefinitions(filteredResults, queries);

    // Cap entry points so traversal budget isn't spread too thin.
    // With 36 entry points and maxNodes=120, each gets only 3 nodes — useless.
    // Cap to searchLimit so each entry point gets a meaningful traversal budget.
    if (filteredResults.length > opts.searchLimit) {
      filteredResults = filteredResults.slice(0, opts.searchLimit);
    }

    // Add entry points to subgraph
    for (const result of filteredResults) {
      nodes.set(result.node.id, result.node);
      roots.push(result.node.id);
    }

    // Expand type hierarchy for class/interface entry points.
    // BFS often exhausts its per-entry-point budget on contained methods
    // before reaching extends/implements neighbors. This dedicated step
    // ensures subclasses and superclasses always appear in results.
    // Budget: up to maxNodes/4 hierarchy nodes to avoid flooding.
    const typeHierarchyKinds = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol']);
    const maxHierarchyNodes = Math.ceil(opts.maxNodes / 4);
    let hierarchyNodesAdded = 0;
    for (const result of filteredResults) {
      if (hierarchyNodesAdded >= maxHierarchyNodes) break;
      if (typeHierarchyKinds.has(result.node.kind)) {
        const hierarchy = traverser.getTypeHierarchy(result.node.id);
        for (const [id, node] of hierarchy.nodes) {
          if (!nodes.has(id)) {
            nodes.set(id, node);
            hierarchyNodesAdded++;
          }
        }
        for (const edge of hierarchy.edges) {
          const exists = edges.some(
            (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
          );
          if (!exists) {
            edges.push(edge);
          }
        }
      }
    }

    // Pass 2: expand hierarchy of newly-discovered parent types to find siblings.
    // E.g., InternalEngine → Engine (parent, from pass 1) → ReadOnlyEngine (sibling).
    if (hierarchyNodesAdded > 0) {
      const pass2Candidates = [...nodes.values()].filter(
        n => typeHierarchyKinds.has(n.kind) && !roots.includes(n.id)
      );
      for (const candidate of pass2Candidates) {
        if (hierarchyNodesAdded >= maxHierarchyNodes) break;
        const siblingHierarchy = traverser.getTypeHierarchy(candidate.id);
        for (const [id, node] of siblingHierarchy.nodes) {
          if (!nodes.has(id) && hierarchyNodesAdded < maxHierarchyNodes) {
            nodes.set(id, node);
            hierarchyNodesAdded++;
          }
        }
        for (const edge of siblingHierarchy.edges) {
          if (nodes.has(edge.source) && nodes.has(edge.target)) {
            const exists = edges.some(
              (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
            );
            if (!exists) {
              edges.push(edge);
            }
          }
        }
      }
    }

    // Traverse from each entry point
    for (const result of filteredResults) {
      const traversalResult = traverser.traverseBFS(result.node.id, {
        maxDepth: opts.traversalDepth,
        edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
        nodeKinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        direction: 'both',
        limit: Math.ceil(opts.maxNodes / Math.max(1, filteredResults.length)),
      });

      // Merge nodes
      for (const [id, node] of traversalResult.nodes) {
        if (!nodes.has(id)) {
          nodes.set(id, node);
        }
      }

      // Merge edges (avoid duplicates)
      for (const edge of traversalResult.edges) {
        const exists = edges.some(
          (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
        );
        if (!exists) {
          edges.push(edge);
        }
      }
    }

    // Trim to max nodes if needed
    let finalNodes = nodes;
    let finalEdges = edges;
    if (nodes.size > opts.maxNodes) {
      // Prioritize entry points and their direct neighbors
      const priorityIds = new Set(roots);
      for (const edge of edges) {
        if (priorityIds.has(edge.source)) {
          priorityIds.add(edge.target);
        }
        if (priorityIds.has(edge.target)) {
          priorityIds.add(edge.source);
        }
      }

      // Keep priority nodes, then fill remaining slots
      finalNodes = new Map<string, Node>();
      for (const id of priorityIds) {
        const node = nodes.get(id);
        if (node && finalNodes.size < opts.maxNodes) {
          finalNodes.set(id, node);
        }
      }

      // Fill remaining from other nodes
      for (const [id, node] of nodes) {
        if (finalNodes.size >= opts.maxNodes) break;
        if (!finalNodes.has(id)) {
          finalNodes.set(id, node);
        }
      }

      // Filter edges to only include kept nodes
      finalEdges = edges.filter(
        (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
      );
    }

    // Per-file diversity cap: prevent any single file from monopolizing the
    // node budget. When BFS traverses from a method, it follows `contains`
    // to the parent class, then back down to all sibling methods. With
    // multiple entry points in the same class, one file can consume 30-40%
    // of maxNodes. Cap each file to ~20% to ensure cross-file diversity.
    const maxPerFile = Math.max(5, Math.ceil(opts.maxNodes * 0.2));
    const fileCounts = new Map<string, string[]>();
    for (const [id, node] of finalNodes) {
      const ids = fileCounts.get(node.filePath) || [];
      ids.push(id);
      fileCounts.set(node.filePath, ids);
    }
    const rootSet = new Set(roots);
    for (const [, nodeIds] of fileCounts) {
      if (nodeIds.length <= maxPerFile) continue;
      // Sort: entry points first, then classes/interfaces, then others
      const kindPriority: Record<string, number> = {
        class: 3, interface: 3, struct: 3, trait: 3, protocol: 3, enum: 3,
        method: 1, function: 1, property: 0, field: 0, variable: 0,
      };
      nodeIds.sort((a, b) => {
        const aRoot = rootSet.has(a) ? 10 : 0;
        const bRoot = rootSet.has(b) ? 10 : 0;
        const aKind = kindPriority[finalNodes.get(a)!.kind] ?? 0;
        const bKind = kindPriority[finalNodes.get(b)!.kind] ?? 0;
        return (bRoot + bKind) - (aRoot + aKind);
      });
      // Remove excess nodes (keep the highest-priority ones)
      for (const id of nodeIds.slice(maxPerFile)) {
        finalNodes.delete(id);
      }
    }
    // Non-production node cap: limit test/sample/integration/example files to
    // at most 15% of the budget. Many codebases have dozens of near-identical
    // test implementations (e.g., 6 Guard classes in integration tests) that
    // individually survive score dampening but collectively flood the result.
    // Test entry points are NOT exempt — they should be evicted too.
    if (!isTestQuery) {
      const maxNonProd = Math.max(3, Math.ceil(opts.maxNodes * 0.15));
      const nonProdIds: string[] = [];
      for (const [id, node] of finalNodes) {
        if (isTestFile(node.filePath)) {
          nonProdIds.push(id);
        }
      }
      if (nonProdIds.length > maxNonProd) {
        for (const id of nonProdIds.slice(maxNonProd)) {
          finalNodes.delete(id);
          // Also remove from roots — test file entry points shouldn't anchor results
          const rootIdx = roots.indexOf(id);
          if (rootIdx !== -1) roots.splice(rootIdx, 1);
        }
      }
    }

    // Re-filter edges after per-file and non-production caps
    finalEdges = finalEdges.filter(
      (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
    );

    // Edge recovery: BFS with many entry points leaves most nodes disconnected.
    // Discover edges between already-selected nodes to recover connectivity.
    const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
    const recoveredEdges = queries.findEdgesBetweenNodes(
      [...finalNodes.keys()],
      recoveryKinds,
    );
    const existingEdgeKeys = new Set(
      finalEdges.map((e) => `${e.source}:${e.target}:${e.kind}`)
    );
    for (const edge of recoveredEdges) {
      const key = `${edge.source}:${edge.target}:${edge.kind}`;
      if (!existingEdgeKeys.has(key)) {
        finalEdges.push(edge);
        existingEdgeKeys.add(key);
      }
    }

  return { nodes: finalNodes, edges: finalEdges, roots };
}
