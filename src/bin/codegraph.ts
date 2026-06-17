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
import { getGlyphs } from '../ui/glyphs';

import { registerAffectedCommand } from './affected-command';
import { registerContextCommand } from './context-command';
import { registerFilesCommand } from './files-command';
import { registerInstallCommand } from './install-command';
import { buildUnsupportedNodeBlockBanner } from './node-version-check';
import { registerQueryCommand } from './query-command';
import { registerServeCommand } from './serve-command';
import { registerUnlockCommand } from './unlock-command';
import {
  registerInitCommand,
  registerStatusCommand,
  registerUninitCommand,
} from './cli-lifecycle-commands';
import { registerIndexCommand, registerSyncCommand } from './cli-index-commands';

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

const lifecycleDeps = { resolveProjectPath, loadCodeGraph, importESM };
registerInitCommand(program, lifecycleDeps);
registerUninitCommand(program, lifecycleDeps);
registerIndexCommand(program, lifecycleDeps);
registerSyncCommand(program, lifecycleDeps);
registerStatusCommand(program, lifecycleDeps);

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
