import type { Command } from 'commander';
import * as fs from 'fs';

import { isInitialized } from '../directory';

import { findAffectedTests } from './affected-tests';
import { chalk, error, info } from './cli-output';

type CommandDeps = {
  resolveProjectPath(pathArg?: string): string;
  loadCodeGraph(): Promise<typeof import('../index')>;
};

export function registerAffectedCommand(program: Command, deps: CommandDeps): void {
  program
    .command('affected [files...]')
    .description('Find test files affected by changed source files')
    .option('-p, --path <path>', 'Project path')
    .option('--stdin', 'Read file list from stdin (one per line)')
    .option('-d, --depth <number>', 'Max dependency traversal depth', '5')
    .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
    .option('-j, --json', 'Output as JSON')
    .option('-q, --quiet', 'Only output file paths, no decoration')
    .action(async (fileArgs: string[], options: {
      path?: string;
      stdin?: boolean;
      depth?: string;
      filter?: string;
      json?: boolean;
      quiet?: boolean;
    }) => {
      const projectPath = deps.resolveProjectPath(options.path);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          process.exit(1);
        }

        const changedFiles: string[] = [...(fileArgs || [])];

        if (options.stdin) {
          const stdinData = fs.readFileSync(0, 'utf-8');
          const stdinFiles = stdinData.split('\n').map(f => f.trim()).filter(Boolean);
          changedFiles.push(...stdinFiles);
        }

        if (changedFiles.length === 0) {
          if (!options.quiet) info('No files provided. Use file arguments or --stdin.');
          process.exit(0);
        }

        const { default: CodeGraph } = await deps.loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);
        const result = findAffectedTests(changedFiles, cg, {
          maxDepth: parseInt(options.depth || '5', 10),
          filter: options.filter,
        });
        const sortedTests = result.affectedTests;

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (options.quiet) {
          for (const t of sortedTests) console.log(t);
        } else if (sortedTests.length === 0) {
          info('No test files affected by the changed files.');
        } else {
          console.log(chalk.bold(`\nAffected test files (${sortedTests.length}):\n`));
          for (const t of sortedTests) {
            console.log('  ' + chalk.cyan(t));
          }
          console.log();
        }

        cg.destroy();
      } catch (err) {
        error(`Affected analysis failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
