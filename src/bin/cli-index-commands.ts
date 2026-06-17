/**
 * codegraph index / sync commands. Extracted from bin/codegraph.ts to stay
 * within the file-size gate; registered via the same
 * register<Name>Command(program, deps) pattern as the other subcommands.
 */

import type { Command } from 'commander';
import { isInitialized } from '../directory';
import { getGlyphs } from '../ui/glyphs';
import { createShimmerProgress } from '../ui/shimmer-progress';
import {
  colors,
  createVerboseProgress,
  error,
  formatDuration,
  formatNumber,
  info,
  printIndexResult,
  type IndexResult,
} from './cli-output';
import type { CliCommandDeps } from './cli-lifecycle-commands';

/** codegraph index [path] */
export function registerIndexCommand(program: Command, deps: CliCommandDeps): void {
  const { resolveProjectPath, loadCodeGraph, importESM } = deps;
  program
    .command('index [path]')
    .description('Index all files in the project')
    .option('-f, --force', 'Force full re-index even if already indexed')
    .option('-q, --quiet', 'Suppress progress output')
    .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
    .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; verbose?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          info('Run "codegraph init" first');
          process.exit(1);
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);

        if (options.quiet) {
          // Quiet mode: no UI, just run
          if (options.force) cg.clear();
          const result = await cg.indexAll();
          if (!result.success) process.exit(1);
          cg.destroy();
          return;
        }

        const clack = await importESM('@clack/prompts');
        clack.intro('Indexing project');

        if (options.force) {
          cg.clear();
          clack.log.info('Cleared existing index');
        }

        let result: IndexResult;

        if (options.verbose) {
          result = await cg.indexAll({ onProgress: createVerboseProgress(), verbose: true });
        } else {
          process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
          const progress = createShimmerProgress();
          result = await cg.indexAll({ onProgress: progress.onProgress });
          await progress.stop();
        }

        printIndexResult(clack, result, projectPath);

        if (!result.success) {
          process.exit(1);
        }

        clack.outro('Done');
        cg.destroy();
      } catch (err) {
        error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

/** codegraph sync [path] */
export function registerSyncCommand(program: Command, deps: CliCommandDeps): void {
  const { resolveProjectPath, loadCodeGraph, importESM } = deps;
  program
    .command('sync [path]')
    .description('Sync changes since last index')
    .option('-q, --quiet', 'Suppress output (for git hooks)')
    .action(async (pathArg: string | undefined, options: { quiet?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          if (!options.quiet) {
            error(`CodeGraph not initialized in ${projectPath}`);
          }
          process.exit(1);
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);

        if (options.quiet) {
          await cg.sync();
          cg.destroy();
          return;
        }

        const clack = await importESM('@clack/prompts');
        clack.intro('Syncing CodeGraph');

        process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
        const progress = createShimmerProgress();

        const result = await cg.sync({ onProgress: progress.onProgress });

        await progress.stop();

        const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

        if (totalChanges === 0) {
          clack.log.info('Already up to date');
        } else {
          clack.log.success(`Synced ${formatNumber(totalChanges)} changed files`);
          const details: string[] = [];
          if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
          if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
          if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);
          clack.log.info(`${details.join(', ')} ${getGlyphs().dash} ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`);
        }

        clack.outro('Done');
        cg.destroy();
      } catch (err) {
        if (!options.quiet) {
          error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(1);
      }
    });
}
