import type { SearchResult } from '../types';

import { chalk } from './cli-output';

export function buildQueryResultLines(search: string, results: SearchResult[]): string[] {
  if (results.length === 0) {
    return [];
  }

  const lines = [chalk.bold(`\nSearch Results for "${search}":\n`)];

  for (const result of results) {
    const node = result.node;
    const location = `${node.filePath}:${node.startLine}`;
    const score = chalk.dim(`(${(result.score * 100).toFixed(0)}%)`);

    lines.push(chalk.cyan(node.kind.padEnd(12)) + chalk.white(node.name) + ' ' + score);
    lines.push(chalk.dim(`  ${location}`));
    if (node.signature) {
      lines.push(chalk.dim(`  ${node.signature}`));
    }
    lines.push('');
  }

  return lines;
}

export function printQueryResultLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}
