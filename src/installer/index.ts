/**
 * CodeGraph Interactive Installer
 *
 * Multi-target: writes MCP server config + instructions for the
 * agents the user picks (Claude Code, Cursor, Codex CLI, opencode).
 * Defaults to the Claude-only behavior for backwards compatibility
 * when no targets are explicitly chosen and nothing else is detected.
 *
 * Uses @clack/prompts for the interactive UI; `runInstallerWithOptions`
 * is the non-interactive entry point used by the `--target` /
 * `--print-config` CLI flags.
 */

import { execSync } from 'child_process';
import type { Location } from './targets/types';
import {
  type RunInstallerOptions,
  getVersion,
  initializeLocalProject,
  resolveTargets,
  tildify,
} from './installer-flow';

// Backwards-compat: keep these named exports — downstream code may
// import them. The shim in `config-writer.ts` continues to re-export
// them too.
export {
  writeMcpConfig,
  writePermissions,
  writeClaudeMd,
  hasMcpConfig,
  hasPermissions,
  hasClaudeMdSection,
} from './config-writer';
export type { InstallLocation } from './config-writer';
export { wireProjectSurfacesForGlobalAgents } from './installer-flow';
export type { RunInstallerOptions } from './installer-flow';

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages. This bypasses the transformation.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

/**
 * Interactive entry point — preserves the historical UX (`codegraph
 * install` with no args goes through the prompts), but now starts
 * the targets multi-select pre-populated with detected agents.
 */
export async function runInstaller(): Promise<void> {
  return runInstallerWithOptions({});
}

export async function runInstallerWithOptions(opts: RunInstallerOptions): Promise<void> {
  const clack = await importESM('@clack/prompts');

  clack.intro(`CodeGraph v${getVersion()}`);

  // --yes implies all defaults; explicit flags still win.
  const useDefaults = opts.yes === true;

  // Step 1: which agent targets? Asked FIRST so the user knows what
  // they're committing to before we touch npm or disk. Detection
  // probes the user-provided location if known, else 'global' as the
  // most common default — labels are a hint, not load-bearing.
  const detectionLocation: Location = opts.location ?? 'global';
  const targets = await resolveTargets(clack, opts, detectionLocation, useDefaults);
  if (targets.length === 0) {
    clack.outro('No agent targets selected — nothing to do.');
    return;
  }

  // Step 2: install the codegraph npm package on PATH (always offered;
  // matches existing behavior). Skipped when --yes (assume present).
  if (!useDefaults) {
    const shouldInstallGlobally = await clack.confirm({
      message: 'Install the codegraph CLI on your PATH? (Required so agents can launch the MCP server)',
      initialValue: true,
    });
    if (clack.isCancel(shouldInstallGlobally)) {
      clack.cancel('Installation cancelled.');
      process.exit(0);
    }
    if (shouldInstallGlobally) {
      const s = clack.spinner();
      s.start('Installing codegraph CLI...');
      try {
        execSync('npm install -g @colbymchenry/codegraph', { stdio: 'pipe' });
        s.stop('Installed codegraph CLI on PATH');
      } catch {
        s.stop('Could not install (permission denied)');
        clack.log.warn('Try: sudo npm install -g @colbymchenry/codegraph');
      }
    } else {
      clack.log.info('Skipped CLI install — agents will not be able to launch the MCP server without it');
    }
  }

  // Step 3: where the per-agent config files should land.
  let location: Location;
  if (opts.location) {
    location = opts.location;
  } else if (useDefaults) {
    location = 'global';
  } else {
    // If every selected target is global-only (e.g. Codex), skip the
    // prompt and force user-wide — project-local would just produce
    // skip warnings.
    const allGlobalOnly = targets.every((t) => !t.supportsLocation('local'));
    if (allGlobalOnly) {
      location = 'global';
      clack.log.info('Writing user-wide configs (selected agents have no project-local config).');
    } else {
      const sel = await clack.select({
        message: 'Apply agent configs to all your projects, or just this one?',
        options: [
          { value: 'global' as const, label: 'All projects', hint: '~/.claude, ~/.cursor, etc.' },
          { value: 'local'  as const, label: 'Just this project', hint: './.claude, ./.cursor, etc.' },
        ],
        initialValue: 'global' as const,
      });
      if (clack.isCancel(sel)) {
        clack.cancel('Installation cancelled.');
        process.exit(0);
      }
      location = sel;
    }
  }

  // Step 4: auto-allow permissions (only meaningful for Claude;
  // skipped silently by other targets).
  let autoAllow: boolean;
  if (opts.autoAllow !== undefined) {
    autoAllow = opts.autoAllow;
  } else if (useDefaults) {
    autoAllow = true;
  } else if (targets.some((t) => t.id === 'claude')) {
    const ans = await clack.confirm({
      message: 'Auto-allow CodeGraph commands? (Skips permission prompts in Claude Code)',
      initialValue: true,
    });
    if (clack.isCancel(ans)) {
      clack.cancel('Installation cancelled.');
      process.exit(0);
    }
    autoAllow = ans;
  } else {
    autoAllow = false;
  }

  // Step 5: per-target install loop.
  for (const target of targets) {
    if (!target.supportsLocation(location)) {
      clack.log.warn(
        `${target.displayName}: skipped — does not support --location=${location}.`,
      );
      continue;
    }
    const result = target.install(location, { autoAllow });
    for (const file of result.files) {
      const verb = file.action === 'unchanged'
        ? 'Unchanged'
        : file.action === 'created' ? 'Created' : 'Updated';
      clack.log.success(`${target.displayName}: ${verb} ${tildify(file.path)}`);
    }
    for (const note of result.notes ?? []) {
      clack.log.info(`${target.displayName}: ${note}`);
    }
  }

  // Step 6: for local install, initialize the project.
  if (location === 'local') {
    await initializeLocalProject(clack);
  }

  if (location === 'global') {
    clack.note('cd your-project\ncodegraph init -i', 'Quick start');
  }

  const finalNote = targets.length > 0
    ? `Done! Restart your agent${targets.length > 1 ? 's' : ''} to use CodeGraph.`
    : 'Done!';
  clack.outro(finalNote);
}
