import type { Node, SearchResult, Subgraph, TaskContext } from '../types';

export function formatSearchResults(results: SearchResult[]): string {
  const lines: string[] = [`## Search Results (${results.length} found)`, ''];

  for (const result of results) {
    const { node } = result;
    const location = node.startLine ? `:${node.startLine}` : '';
    lines.push(`### ${node.name} (${node.kind})`);
    lines.push(`${node.filePath}${location}`);
    if (node.signature) lines.push(`\`${node.signature}\``);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatNodeList(nodes: Node[], title: string): string {
  const lines: string[] = [`## ${title} (${nodes.length} found)`, ''];

  for (const node of nodes) {
    const location = node.startLine ? `:${node.startLine}` : '';
    lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}`);
  }

  return lines.join('\n');
}

export function formatImpact(symbol: string, impact: Subgraph): string {
  const nodeCount = impact.nodes.size;
  const lines: string[] = [
    `## Impact: "${symbol}" affects ${nodeCount} symbols`,
    '',
  ];

  const byFile = new Map<string, Node[]>();
  for (const node of impact.nodes.values()) {
    const existing = byFile.get(node.filePath) || [];
    existing.push(node);
    byFile.set(node.filePath, existing);
  }

  for (const [file, nodes] of byFile) {
    lines.push(`**${file}:**`);
    const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
    lines.push(nodeList);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatNodeDetails(node: Node, code: string | null): string {
  const location = node.startLine ? `:${node.startLine}` : '';
  const lines: string[] = [
    `## ${node.name} (${node.kind})`,
    '',
    `**Location:** ${node.filePath}${location}`,
  ];

  if (node.signature) {
    lines.push(`**Signature:** \`${node.signature}\``);
  }

  if (node.docstring && node.docstring.length < 200) {
    lines.push('', node.docstring);
  }

  if (code) {
    lines.push('', '```' + node.language, code, '```');
  }

  return lines.join('\n');
}

export function formatTaskContext(context: TaskContext): string {
  return context.summary || 'No context found';
}
