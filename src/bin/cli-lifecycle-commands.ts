/**
 * codegraph init / uninit / status commands. Extracted from bin/codegraph.ts
 * to stay within the file-size gate; registered via the same
 * register<Name>Command(program, deps) pattern as the other subcommands.
 */

import type { Command } from 'commander';
import { isInitialized } from '../directory';
import { getGlyphs } from '../ui/glyphs';
import { createShimmerProgress } from '../ui/shimmer-progress';
import {
  chalk,
  colors,
  createVerboseProgress,
  error,
  info,
  printIndexResult,
  success,
  warn,
  type IndexResult,
} from './cli-output';
import {
  buildStatusJson,
  buildStatusLines,
  buildUninitializedStatusJson,
  buildUninitializedStatusLines,
  printStatusLines,
} from './status-output';

interface CliCommandDeps {
  resolveProjectPath: (pathArg?: string) => string;
  loadCodeGraph: () => Promise<typeof import('../index')>;
  importESM: (specifier: string) => Promise<typeof import('@clack/prompts')>;
}

/** codegraph init [path] */
export function registerInitCommand(program: Command, deps: CliCommandDeps): void {
  const { loadCodeGraph, importESM } = deps;
  program
    .command('init [path]')
    .description('Initialize CodeGraph in a project directory')
    .option('-i, --index', 'Run initial indexing after initialization')
    .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
    .action(async (pathArg: string | undefined, options: { index?: boolean; verbose?: boolean }) => {
      const path = await import('path');
      const projectPath = path.resolve(pathArg || process.cwd());
      const clack = await importESM('@clack/prompts');

      clack.intro('Initializing CodeGraph');

      try {
        if (isInitialized(projectPath)) {
          clack.log.warn(`Already initialized in ${projectPath}`);
          clack.log.info('Use "codegraph index" to re-index or "codegraph sync" to update');
          // Re-run agent surface wiring so re-running `init` is the
          // documented way to recover a project that's missing its
          // Cursor rules file (or future per-agent project surfaces).
          try {
            const { wireProjectSurfacesForGlobalAgents } = await import('../installer');
            for (const { target, file } of wireProjectSurfacesForGlobalAgents()) {
              clack.log.success(`${target.displayName}: ${file.action} ${file.path}`);
            }
          } catch { /* non-fatal */ }
          clack.outro('');
          return;
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.init(projectPath, { index: false });
        clack.log.success(`Initialized in ${projectPath}`);

        // Bootstrap project-local surfaces for any agent that's
        // configured globally (Cursor needs ./.cursor/rules/codegraph.mdc
        // to actually prefer codegraph over native grep). Silent when
        // there's nothing to write.
        try {
          const { wireProjectSurfacesForGlobalAgents } = await import('../installer');
          for (const { target, file } of wireProjectSurfacesForGlobalAgents()) {
            clack.log.success(`${target.displayName}: ${file.action} ${file.path}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          clack.log.warn(`Skipped wiring project-local agent surfaces: ${msg}`);
        }

        if (options.index) {
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
        } else {
          clack.log.info('Run "codegraph index" to index the project');
        }

        clack.outro('Done');
        cg.destroy();
      } catch (err) {
        clack.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

/** codegraph uninit [path] */
export function registerUninitCommand(program: Command, deps: CliCommandDeps): void {
  const { resolveProjectPath, loadCodeGraph } = deps;
  program
    .command('uninit [path]')
    .description('Remove CodeGraph from a project (deletes .codegraph/ directory)')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (pathArg: string | undefined, options: { force?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          warn(`CodeGraph is not initialized in ${projectPath}`);
          return;
        }

        if (!options.force) {
          // Confirm with user
          const readline = await import('readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(
              chalk.yellow(`${getGlyphs().warn} This will permanently delete all CodeGraph data. Continue? (y/N) `),
              resolve
            );
          });
          rl.close();

          if (answer.toLowerCase() !== 'y') {
            info('Cancelled');
            return;
          }
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = CodeGraph.openSync(projectPath);
        cg.uninitialize();

        success(`Removed CodeGraph from ${projectPath}`);
      } catch (err) {
        error(`Failed to uninitialize: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

/** codegraph status [path] */
export function registerStatusCommand(program: Command, deps: CliCommandDeps): void {
  const { resolveProjectPath, loadCodeGraph } = deps;
  program
    .command('status [path]')
    .description('Show index status and statistics')
    .option('-j, --json', 'Output as JSON')
    .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          if (options.json) {
            console.log(JSON.stringify(buildUninitializedStatusJson(projectPath)));
            return;
          }
          printStatusLines(buildUninitializedStatusLines(projectPath));
          return;
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);
        const stats = cg.getStats();
        const changes = cg.getChangedFiles();
        const backend = cg.getBackend();

        // JSON output mode
        if (options.json) {
          console.log(JSON.stringify(buildStatusJson({ projectPath, stats, changes, backend })));
          cg.destroy();
          return;
        }

        printStatusLines(buildStatusLines({ projectPath, stats, changes, backend }));
        cg.destroy();
      } catch (err) {
        error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

export type { CliCommandDeps };
