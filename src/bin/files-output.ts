import { getGlyphs } from '../ui/glyphs';

import { chalk } from './cli-output';

export type FileListEntry = {
  path: string;
  language: string;
  nodeCount: number;
};

type FilesOutputOptions = {
  format: string;
  includeMetadata: boolean;
  maxDepth?: number;
};

type TreeNode = {
  name: string;
  children: Map<string, TreeNode>;
  file?: { language: string; nodeCount: number };
};

export function renderFiles(files: FileListEntry[], options: FilesOutputOptions): void {
  switch (options.format) {
    case 'flat':
      console.log(chalk.bold(`\nFiles (${files.length}):\n`));
      for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
        if (options.includeMetadata) {
          console.log(`  ${file.path} ${chalk.dim(`(${file.language}, ${file.nodeCount} symbols)`)}`);
        } else {
          console.log(`  ${file.path}`);
        }
      }
      break;

    case 'grouped':
      renderGroupedFiles(files, options.includeMetadata);
      break;

    case 'tree':
    default:
      console.log(chalk.bold(`\nProject Structure (${files.length} files):\n`));
      for (const line of buildFileTreeLines(files, options.includeMetadata, options.maxDepth)) {
        console.log(line);
      }
      break;
  }
}

export function buildFileTreeLines(
  files: FileListEntry[],
  includeMetadata: boolean,
  maxDepth: number | undefined,
): string[] {
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

  const lines: string[] = [];
  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const glyphs = getGlyphs();
    const connector = isLast ? glyphs.treeLast : glyphs.treeBranch;
    const childPrefix = isLast ? '    ' : glyphs.treePipe;

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += chalk.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
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
  return lines;
}

function renderGroupedFiles(files: FileListEntry[], includeMetadata: boolean): void {
  console.log(chalk.bold(`\nFiles by Language (${files.length} total):\n`));
  const byLang = new Map<string, FileListEntry[]>();
  for (const file of files) {
    const existing = byLang.get(file.language) || [];
    existing.push(file);
    byLang.set(file.language, existing);
  }
  const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [lang, langFiles] of sortedLangs) {
    console.log(chalk.cyan(`${lang} (${langFiles.length}):`));
    for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        console.log(`  ${file.path} ${chalk.dim(`(${file.nodeCount} symbols)`)}`);
      } else {
        console.log(`  ${file.path}`);
      }
    }
    console.log();
  }
}
