import type { Command } from 'commander';

import type { NodeKind } from '../types';
import { isInitialized } from '../directory';

import { error, info } from './cli-output';
import { buildQueryResultLines, printQueryResultLines } from './query-output';

type CommandDeps = {
  resolveProjectPath(pathArg?: string): string;
  loadCodeGraph(): Promise<typeof import('../index')>;
};

export function registerQueryCommand(program: Command, deps: CommandDeps): void {
  program
    .command('query <search>')
    .description('Search for symbols in the codebase')
    .option('-p, --path <path>', 'Project path')
    .option('-l, --limit <number>', 'Maximum results', '10')
    .option('-k, --kind <kind>', 'Filter by node kind (function, class, etc.)')
    .option('-j, --json', 'Output as JSON')
    .action(async (search: string, options: { path?: string; limit?: string; kind?: string; json?: boolean }) => {
      const projectPath = deps.resolveProjectPath(options.path);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          process.exit(1);
        }

        const { default: CodeGraph } = await deps.loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);

        const limit = parseInt(options.limit || '10', 10);
        const results = cg.searchNodes(search, {
          limit,
          kinds: options.kind ? [options.kind as NodeKind] : undefined,
        });

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else if (results.length === 0) {
          info(`No results found for "${search}"`);
        } else {
          printQueryResultLines(buildQueryResultLines(search, results));
        }

        cg.destroy();
      } catch (err) {
        error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
