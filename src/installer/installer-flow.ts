/**
 * Installer flow helpers: option types, target resolution, project-local
 * initialization, and global-agent surface wiring. Split out of installer's
 * index.ts to stay within the file-size gate.
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  ALL_TARGETS,
  detectAll,
  getTarget,
  resolveTargetFlag,
} from './targets/registry';
import type { AgentTarget, Location, WriteResult } from './targets/types';
import { getGlyphs } from '../ui/glyphs';

export interface RunInstallerOptions {
  /** Comma-separated target list, or `auto` / `all` / `none`. */
  target?: string;
  /** Skip the location prompt; use this value directly. */
  location?: Location;
  /** Skip the auto-allow prompt; use this value directly. */
  autoAllow?: boolean;
  /**
   * Skip every confirm and use defaults: location=global,
   * autoAllow=true, target=auto. For scripting / CI.
   */
  yes?: boolean;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function getVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * For every target that has a global config and exposes
 * `wireProjectSurfaces`, write its project-local surfaces (e.g.
 * Cursor's `.cursor/rules/codegraph.mdc`). Idempotent — runs
 * silently when there's nothing to write.
 *
 * Returns the list of `(target, file)` pairs that were created or
 * updated — caller decides how to surface them.
 */
export function wireProjectSurfacesForGlobalAgents(): Array<{
  target: AgentTarget;
  file: WriteResult['files'][number];
}> {
  const written: Array<{ target: AgentTarget; file: WriteResult['files'][number] }> = [];
  for (const target of ALL_TARGETS) {
    if (typeof target.wireProjectSurfaces !== 'function') continue;
    const detection = target.detect('global');
    if (!detection.alreadyConfigured) continue;
    const result = target.wireProjectSurfaces();
    for (const file of result.files) {
      if (file.action === 'created' || file.action === 'updated') {
        written.push({ target, file });
      }
    }
  }
  return written;
}

/**
 * Replace home-directory prefix in a path with `~/` for cleaner log
 * lines. Pure cosmetic.
 */
export function tildify(p: string): string {
  const home = require('os').homedir();
  if (p.startsWith(home + path.sep)) return '~' + p.substring(home.length);
  return p;
}

export async function resolveTargets(
  clack: typeof import('@clack/prompts'),
  opts: RunInstallerOptions,
  location: Location,
  useDefaults: boolean,
): Promise<AgentTarget[]> {
  // Explicit --target flag wins.
  if (opts.target !== undefined) {
    return resolveTargetFlag(opts.target, location);
  }

  // --yes implies auto-detect.
  if (useDefaults) {
    return resolveTargetFlag('auto', location);
  }

  // Interactive multi-select.
  const detected = detectAll(location);
  const initialValues = detected
    .filter(({ detection }) => detection.installed)
    .map(({ target }) => target.id);
  // If nothing detected, default to Claude alone (matches the
  // historical default and the smallest-surprise outcome).
  const initial = initialValues.length > 0 ? initialValues : ['claude'];

  const choice = await clack.multiselect<string>({
    message: 'Which agents should CodeGraph configure?',
    options: ALL_TARGETS.map((t) => {
      const det = detected.find(({ target }) => target.id === t.id)!.detection;
      const flag = det.installed ? '(detected)' : '(not found)';
      const globalOnly = !t.supportsLocation('local') ? ' — global only' : '';
      return {
        value: t.id,
        label: `${t.displayName} ${flag}${globalOnly}`,
      };
    }),
    initialValues: initial,
    required: false,
  });

  if (clack.isCancel(choice)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  return choice
    .map((id) => getTarget(id))
    .filter((t): t is AgentTarget => t !== undefined);
}

/**
 * Initialize CodeGraph in the current project (for local installs).
 * Unchanged from the pre-refactor version — agent-agnostic by nature.
 */
export async function initializeLocalProject(clack: typeof import('@clack/prompts')): Promise<void> {
  const projectPath = process.cwd();

  let CodeGraph: typeof import('../index').default;
  try {
    CodeGraph = (await import('../index')).default;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    clack.log.error(`Could not load native modules: ${msg}`);
    clack.log.info('Skipping project initialization. Run "codegraph init -i" later.');
    return;
  }

  // Check if already initialized
  if (CodeGraph.isInitialized(projectPath)) {
    clack.log.info('CodeGraph already initialized in this project');
    return;
  }

  // Initialize
  const cg = await CodeGraph.init(projectPath);
  clack.log.success('Created .codegraph/ directory');

  // Index the project with shimmer progress (worker thread for smooth animation)
  const { createShimmerProgress } = await import('../ui/shimmer-progress');
  process.stdout.write(`\x1b[2m${getGlyphs().rail}\x1b[0m\n`);
  const progress = createShimmerProgress();

  const result = await cg.indexAll({
    onProgress: progress.onProgress,
  });

  await progress.stop();

  if (result.filesErrored > 0) {
    clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} failed, ${formatNumber(result.nodesCreated)} symbols)`);
  } else {
    clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.nodesCreated)} symbols)`);
  }

  cg.close();
}
