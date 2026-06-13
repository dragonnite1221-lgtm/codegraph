export type McpFileEntry = {
  path: string;
  language: string;
  nodeCount: number;
};

export type McpFilesFormat = 'tree' | 'flat' | 'grouped';
export const DEFAULT_MCP_FILES_LIMIT = 500;

export function filterMcpFiles(
  files: McpFileEntry[],
  options: { pathFilter?: string; pattern?: string },
): McpFileEntry[] {
  let filtered = options.pathFilter
    ? files.filter(f => f.path.startsWith(options.pathFilter!) || f.path.startsWith('./' + options.pathFilter))
    : files;

  if (options.pattern) {
    const regex = globToRegex(options.pattern);
    filtered = filtered.filter(f => regex.test(f.path));
  }

  return filtered;
}

export function limitMcpFiles(files: McpFileEntry[], limit: number): {
  files: McpFileEntry[];
  omitted: number;
} {
  if (files.length <= limit) {
    return { files, omitted: 0 };
  }
  return { files: files.slice(0, limit), omitted: files.length - limit };
}

export function formatMcpFiles(
  files: McpFileEntry[],
  options: { includeMetadata: boolean; format: McpFilesFormat; maxDepth?: number; omitted?: number },
): string {
  const omitted = options.omitted || 0;
  const output = formatMcpFilesBody(files, options);
  if (omitted <= 0) {
    return output;
  }
  return `${output}\n\n... (${omitted} more files omitted; narrow with path/pattern or increase limit)`;
}

function formatMcpFilesBody(
  files: McpFileEntry[],
  options: { includeMetadata: boolean; format: McpFilesFormat; maxDepth?: number },
): string {
  switch (options.format) {
    case 'flat':
      return formatFilesFlat(files, options.includeMetadata);
    case 'grouped':
      return formatFilesGrouped(files, options.includeMetadata);
    case 'tree':
    default:
      return formatFilesTree(files, options.includeMetadata, options.maxDepth);
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function formatFilesFlat(files: McpFileEntry[], includeMetadata: boolean): string {
  const lines: string[] = [`## Files (${files.length})`, ''];

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (includeMetadata) {
      lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
    } else {
      lines.push(`- ${file.path}`);
    }
  }

  return lines.join('\n');
}

function formatFilesGrouped(files: McpFileEntry[], includeMetadata: boolean): string {
  const byLang = new Map<string, McpFileEntry[]>();

  for (const file of files) {
    const existing = byLang.get(file.language) || [];
    existing.push(file);
    byLang.set(file.language, existing);
  }

  const lines: string[] = [`## Files by Language (${files.length} total)`, ''];
  const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [lang, langFiles] of sortedLangs) {
    lines.push(`### ${lang} (${langFiles.length})`);
    for (const file of [...langFiles].sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatFilesTree(
  files: McpFileEntry[],
  includeMetadata: boolean,
  maxDepth?: number,
): string {
  type TreeNode = {
    name: string;
    children: Map<string, TreeNode>;
    file?: { language: string; nodeCount: number };
  };

  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;

      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  const lines: string[] = [`## Project Structure (${files.length} files)`, ''];

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
      }
      lines.push(line);
    }

    const children = [...node.children.values()];
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };

  renderNode(root, '', true, 0);

  return lines.join('\n');
}
