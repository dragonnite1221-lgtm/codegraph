#!/usr/bin/env node
/**
 * CodeGraph CLI
 *
 * Command-line interface for CodeGraph code intelligence.
 *
 * Usage:
 *   codegraph                    Run interactive installer (when no args)
 *   codegraph install            Run interactive installer
 *   codegraph init [path]        Initialize CodeGraph in a project
 *   codegraph uninit [path]      Remove CodeGraph from a project
 *   codegraph index [path]       Index all files in the project
 *   codegraph sync [path]        Sync changes since last index
 *   codegraph status [path]      Show index status
 *   codegraph query <search>     Search for symbols
 *   codegraph files [options]    Show project file structure
 *   codegraph context <task>     Build context for a task
 *   codegraph affected [files]   Find test files affected by changes
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { isInitialized } from '../directory';
import { createShimmerProgress } from '../ui/shimmer-progress';
import { getGlyphs } from '../ui/glyphs';

import { registerAffectedCommand } from './affected-command';
import {
  chalk,
  colors,
  createVerboseProgress,
  error,
  formatDuration,
  formatNumber,
  info,
  printIndexResult,
  success,
  warn,
  type IndexResult,
} from './cli-output';
import { registerContextCommand } from './context-command';
import { registerFilesCommand } from './files-command';
import { registerInstallCommand } from './install-command';
import { buildUnsupportedNodeBlockBanner } from './node-version-check';
import { registerQueryCommand } from './query-command';
import { registerServeCommand } from './serve-command';
import {
  buildStatusJson,
  buildStatusLines,
  buildUninitializedStatusJson,
  buildUninitializedStatusLines,
  printStatusLines,
} from './status-output';
import { registerUnlockCommand } from './unlock-command';

// Lazy-load heavy modules (CodeGraph, runInstaller) to keep CLI startup fast.
async function loadCodeGraph(): Promise<typeof import('../index')> {
  try {
    return await import('../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m${getGlyphs().err}\x1b[0m Failed to load CodeGraph modules.`);
    console.error(`\n  Node: ${process.version}  Platform: ${process.platform} ${process.arch}`);
    console.error(`\n  Error: ${msg}`);
    console.error('\n  Try reinstalling with: npm install -g @colbymchenry/codegraph\n');
    process.exit(1);
  }
}

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages. This bypasses the transformation.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

// Block CodeGraph on Node.js 24+ — V8's turboshaft WASM JIT has a Zone
// allocator bug that reliably crashes when compiling tree-sitter
// grammars (see #54, #81, #140). The previous behaviour was a soft
// console.warn that scrolls off-screen before the OOM crash 30 seconds
// later, leading to a steady stream of "what is this OOM" reports.
// Hard-exit before any WASM work; allow override via env var for users
// who patched V8 themselves or want to test a future fix.
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (nodeMajor >= 24) {
  process.stderr.write(buildUnsupportedNodeBlockBanner(nodeVersion) + '\n');
  if (!process.env.CODEGRAPH_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // Override active — banner shown for visibility, continuing.
}

// Check if running with no arguments - run installer
if (process.argv.length === 2) {
  import('../installer').then(({ runInstaller }) =>
    runInstaller()
  ).catch((err) => {
    console.error('Installation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // Normal CLI flow
  main();
}

process.on('uncaughtException', (error) => {
  console.error('[CodeGraph] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[CodeGraph] Unhandled rejection:', reason);
  process.exit(1);
});

function main() {

const program = new Command();

// Version from package.json
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
);

program
  .name('codegraph')
  .description('Code intelligence and knowledge graph for any codebase')
  .version(packageJson.version);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve project path from argument or current directory
 * Walks up parent directories to find nearest initialized CodeGraph project
 * (must have .codegraph/codegraph.db, not just .codegraph/lessons.db)
 */
function resolveProjectPath(pathArg?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());

  // If exact path is initialized (has codegraph.db), use it
  if (isInitialized(absolutePath)) {
    return absolutePath;
  }

  // Walk up to find nearest parent with CodeGraph initialized
  // Note: findNearestCodeGraphRoot finds any .codegraph folder, but we need one with codegraph.db
  let current = absolutePath;
  const root = path.parse(current).root;

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;

    if (isInitialized(current)) {
      return current;
    }
  }

  // Not found - return original path (will fail later with helpful error)
  return absolutePath;
}

// Shimmer progress renderer (runs in a worker thread for smooth animation)
// Imported at top of file from '../ui/shimmer-progress'

// =============================================================================
// Commands
// =============================================================================

/**
 * codegraph init [path]
 */
program
  .command('init [path]')
  .description('Initialize CodeGraph in a project directory')
  .option('-i, --index', 'Run initial indexing after initialization')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { index?: boolean; verbose?: boolean }) => {
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
          result = await cg.indexAll({
            onProgress: createVerboseProgress(),
            verbose: true,
          });
        } else {
          process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
          const progress = createShimmerProgress();
          result = await cg.indexAll({
            onProgress: progress.onProgress,
          });
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

/**
 * codegraph uninit [path]
 */
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

/**
 * codegraph index [path]
 */
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
        result = await cg.indexAll({
          onProgress: createVerboseProgress(),
          verbose: true,
        });
      } else {
        process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
        const progress = createShimmerProgress();
        result = await cg.indexAll({
          onProgress: progress.onProgress,
        });
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

/**
 * codegraph sync [path]
 */
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

      const result = await cg.sync({
        onProgress: progress.onProgress,
      });

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

/**
 * codegraph status [path]
 */
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
        console.log(JSON.stringify(buildStatusJson({
          projectPath,
          stats,
          changes,
          backend,
        })));
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

registerQueryCommand(program, { resolveProjectPath, loadCodeGraph });
registerFilesCommand(program, { resolveProjectPath, loadCodeGraph });
registerContextCommand(program, { resolveProjectPath, loadCodeGraph });
registerServeCommand(program, { resolveProjectPath });
registerUnlockCommand(program, { resolveProjectPath });
registerAffectedCommand(program, { resolveProjectPath, loadCodeGraph });
registerInstallCommand(program);

// Parse and run
program.parse();

} // end main()
