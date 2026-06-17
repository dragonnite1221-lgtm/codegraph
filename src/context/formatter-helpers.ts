/**
 * Context formatter helpers split out of formatter.ts to keep it within the
 * 200-line limit. No behavior change.
 */

import { Node, Edge, Subgraph } from '../types';

export function formatNodeTree(
  node: Node,
  subgraph: Subgraph,
  outgoing: Map<string, Edge[]>,
  printed: Set<string>,
  lines: string[],
  depth: number,
  prefix: string
): void {
  if (printed.has(node.id)) {
    return;
  }
  printed.add(node.id);

  // Node header
  const location = node.startLine ? `:${node.startLine}` : '';
  const signature = node.signature ? ` - ${truncate(node.signature, 50)}` : '';
  lines.push(`${prefix}${node.kind}: ${node.name} (${node.filePath}${location})${signature}`);

  // Outgoing edges
  const edges = outgoing.get(node.id) ?? [];
  const significantEdges = edges.filter((e) =>
    ['calls', 'extends', 'implements', 'imports', 'references'].includes(e.kind)
  );

  // Group by kind
  const edgesByKind = new Map<string, Edge[]>();
  for (const edge of significantEdges) {
    const existing = edgesByKind.get(edge.kind) ?? [];
    existing.push(edge);
    edgesByKind.set(edge.kind, existing);
  }

  // Print edges grouped by kind
  const newPrefix = prefix + '  ';
  for (const [kind, kindEdges] of edgesByKind) {
    if (kindEdges.length > 3) {
      // Summarize if too many
      const names = kindEdges
        .slice(0, 3)
        .map((e) => {
          const target = subgraph.nodes.get(e.target);
          return target?.name ?? 'unknown';
        })
        .join(', ');
      lines.push(`${newPrefix}├── ${kind}: ${names} and ${kindEdges.length - 3} more`);
    } else {
      for (let i = 0; i < kindEdges.length; i++) {
        const edge = kindEdges[i]!;
        const target = subgraph.nodes.get(edge.target);
        const targetName = target?.name ?? 'unknown';
        const connector = i === kindEdges.length - 1 ? '└──' : '├──';
        lines.push(`${newPrefix}${connector} ${kind} → ${targetName}`);
      }
    }
  }

  // Recurse for directly connected nodes (limited depth)
  if (depth < 1) {
    for (const edge of significantEdges.slice(0, 3)) {
      const target = subgraph.nodes.get(edge.target);
      if (target && !printed.has(target.id)) {
        formatNodeTree(target, subgraph, outgoing, printed, lines, depth + 1, newPrefix);
      }
    }
  }
}

/**
 * Serialize a node for JSON output
 */
export function serializeNode(node: Node): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    signature: node.signature,
    docstring: node.docstring,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
  };
}

/**
 * Serialize an edge for JSON output
 */
export function serializeEdge(edge: Edge): Record<string, unknown> {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: edge.line,
    column: edge.column,
  };
}

/**
 * Truncate a string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Format bytes as human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
