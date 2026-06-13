import { getGlyphs } from '../ui/glyphs';

import { chalk, formatNumber } from './cli-output';

export type StatusStats = {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  nodesByKind: Record<string, number>;
  filesByLanguage: Record<string, number>;
};

export type StatusChanges = {
  added: string[];
  modified: string[];
  removed: string[];
};

export type StatusInput = {
  projectPath: string;
  stats: StatusStats;
  changes: StatusChanges;
  backend: string;
};

export type InitializedStatusJson = {
  initialized: true;
  projectPath: string;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  backend: string;
  nodesByKind: Record<string, number>;
  languages: string[];
  pendingChanges: {
    added: number;
    modified: number;
    removed: number;
  };
};

export type UninitializedStatusJson = {
  initialized: false;
  projectPath: string;
};

export function buildUninitializedStatusJson(projectPath: string): UninitializedStatusJson {
  return { initialized: false, projectPath };
}

export function buildStatusJson(input: StatusInput): InitializedStatusJson {
  const { projectPath, stats, changes, backend } = input;

  return {
    initialized: true,
    projectPath,
    fileCount: stats.fileCount,
    nodeCount: stats.nodeCount,
    edgeCount: stats.edgeCount,
    dbSizeBytes: stats.dbSizeBytes,
    backend,
    nodesByKind: stats.nodesByKind,
    languages: Object.entries(stats.filesByLanguage)
      .filter(([, count]) => count > 0)
      .map(([lang]) => lang),
    pendingChanges: {
      added: changes.added.length,
      modified: changes.modified.length,
      removed: changes.removed.length,
    },
  };
}

export function buildUninitializedStatusLines(projectPath: string): string[] {
  return [
    chalk.bold('\nCodeGraph Status\n'),
    infoLine(`Project: ${projectPath}`),
    warnLine('Not initialized'),
    infoLine('Run "codegraph init" to initialize'),
  ];
}

export function buildStatusLines(input: StatusInput): string[] {
  const { projectPath, stats, changes, backend } = input;
  const lines: string[] = [
    chalk.bold('\nCodeGraph Status\n'),
    `${chalk.cyan('Project:')} ${projectPath}`,
    '',
    chalk.bold('Index Statistics:'),
    `  Files:     ${formatNumber(stats.fileCount)}`,
    `  Nodes:     ${formatNumber(stats.nodeCount)}`,
    `  Edges:     ${formatNumber(stats.edgeCount)}`,
    `  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
    `  Backend:   ${backendLabel(backend)}`,
    '',
    chalk.bold('Nodes by Kind:'),
  ];

  const nodesByKind = Object.entries(stats.nodesByKind)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of nodesByKind) {
    lines.push(`  ${kind.padEnd(15)} ${formatNumber(count)}`);
  }

  lines.push('', chalk.bold('Files by Language:'));
  const filesByLang = Object.entries(stats.filesByLanguage)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [lang, count] of filesByLang) {
    lines.push(`  ${lang.padEnd(15)} ${formatNumber(count)}`);
  }
  lines.push('');

  const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
  if (totalChanges > 0) {
    lines.push(chalk.bold('Pending Changes:'));
    if (changes.added.length > 0) {
      lines.push(`  Added:     ${changes.added.length} files`);
    }
    if (changes.modified.length > 0) {
      lines.push(`  Modified:  ${changes.modified.length} files`);
    }
    if (changes.removed.length > 0) {
      lines.push(`  Removed:   ${changes.removed.length} files`);
    }
    lines.push(infoLine('Run "codegraph sync" to update the index'));
  } else {
    lines.push(successLine('Index is up to date'));
  }
  lines.push('');

  return lines;
}

export function printStatusLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function backendLabel(backend: string): string {
  if (backend === 'native') {
    return chalk.green('native');
  }

  return chalk.yellow(`wasm ${getGlyphs().dash} slower fallback; run \`npm rebuild better-sqlite3\``);
}

function successLine(message: string): string {
  return chalk.green(getGlyphs().ok) + ' ' + message;
}

function infoLine(message: string): string {
  return chalk.blue(getGlyphs().info) + ' ' + message;
}

function warnLine(message: string): string {
  return chalk.yellow(getGlyphs().warn) + ' ' + message;
}
