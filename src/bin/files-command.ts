import type { Command } from 'commander';

import { isInitialized } from '../directory';

import { globToRegex } from './affected-tests';
import { error, info } from './cli-output';
import { renderFiles } from './files-output';

type CommandDeps = {
  resolveProjectPath(pathArg?: string): string;
  loadCodeGraph(): Promise<typeof import('../index')>;
};

export function registerFilesCommand(program: Command, deps: CommandDeps): void {
  program
    .command('files')
    .description('Show project file structure from the index')
    .option('-p, --path <path>', 'Project path')
    .option('--filter <dir>', 'Filter to files under this directory')
    .option('--pattern <glob>', 'Filter files matching this glob pattern')
    .option('--format <format>', 'Output format (tree, flat, grouped)', 'tree')
    .option('--max-depth <number>', 'Maximum directory depth for tree format')
    .option('--no-metadata', 'Hide file metadata (language, symbol count)')
    .option('-j, --json', 'Output as JSON')
    .action(async (options: {
      path?: string;
      filter?: string;
      pattern?: string;
      format?: string;
      maxDepth?: string;
      metadata?: boolean;
      json?: boolean;
    }) => {
      const projectPath = deps.resolveProjectPath(options.path);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          process.exit(1);
        }

        const { default: CodeGraph } = await deps.loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);
        let files = cg.getFiles();

        if (files.length === 0) {
          info('No files indexed. Run "codegraph index" first.');
          cg.destroy();
          return;
        }

        if (options.filter) {
          const filter = options.filter;
          files = files.filter(f => f.path.startsWith(filter) || f.path.startsWith('./' + filter));
        }

        if (options.pattern) {
          const regex = globToRegex(options.pattern);
          files = files.filter(f => regex.test(f.path));
        }

        if (files.length === 0) {
          info('No files found matching the criteria.');
          cg.destroy();
          return;
        }

        if (options.json) {
          const output = files.map(f => ({
            path: f.path,
            language: f.language,
            nodeCount: f.nodeCount,
            size: f.size,
          }));
          console.log(JSON.stringify(output, null, 2));
          cg.destroy();
          return;
        }

        renderFiles(files, {
          includeMetadata: options.metadata !== false,
          format: options.format || 'tree',
          maxDepth: options.maxDepth ? parseInt(options.maxDepth, 10) : undefined,
        });

        console.log();
        cg.destroy();
      } catch (err) {
        error(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
