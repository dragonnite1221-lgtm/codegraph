import type { Command } from 'commander';

import { isInitialized } from '../directory';

import { error } from './cli-output';

type CommandDeps = {
  resolveProjectPath(pathArg?: string): string;
  loadCodeGraph(): Promise<typeof import('../index')>;
};

export function registerContextCommand(program: Command, deps: CommandDeps): void {
  program
    .command('context <task>')
    .description('Build context for a task (outputs markdown)')
    .option('-p, --path <path>', 'Project path')
    .option('-n, --max-nodes <number>', 'Maximum nodes to include', '50')
    .option('-c, --max-code <number>', 'Maximum code blocks', '10')
    .option('--no-code', 'Exclude code blocks')
    .option('-f, --format <format>', 'Output format (markdown, json)', 'markdown')
    .action(async (task: string, options: {
      path?: string;
      maxNodes?: string;
      maxCode?: string;
      code?: boolean;
      format?: string;
    }) => {
      const projectPath = deps.resolveProjectPath(options.path);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          process.exit(1);
        }

        const { default: CodeGraph } = await deps.loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);

        const context = await cg.buildContext(task, {
          maxNodes: parseInt(options.maxNodes || '50', 10),
          maxCodeBlocks: parseInt(options.maxCode || '10', 10),
          includeCode: options.code !== false,
          format: options.format as 'markdown' | 'json',
        });

        console.log(context);
        cg.destroy();
      } catch (err) {
        error(`Failed to build context: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
