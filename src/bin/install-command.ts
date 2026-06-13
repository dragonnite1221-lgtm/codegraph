import type { Command } from 'commander';

import { error } from './cli-output';

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Install codegraph MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode)')
    .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
    .option('-l, --location <where>', 'Install location: "global" or "local". Default: prompt')
    .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=auto, auto-allow on')
    .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code only)')
    .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
    .action(async (opts: {
      target?: string;
      location?: string;
      yes?: boolean;
      permissions?: boolean;
      printConfig?: string;
    }) => {
      if (opts.printConfig) {
        const { getTarget, listTargetIds } = await import('../installer/targets/registry');
        const target = getTarget(opts.printConfig);
        if (!target) {
          const known = listTargetIds().join(', ');
          error(`Unknown target "${opts.printConfig}". Known: ${known}.`);
          process.exit(1);
        }
        const loc = (opts.location === 'local' ? 'local' : 'global') as 'global' | 'local';
        process.stdout.write(target.printConfig(loc));
        return;
      }

      const { runInstallerWithOptions } = await import('../installer');
      if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
        error(`--location must be "global" or "local" (got "${opts.location}").`);
        process.exit(1);
      }
      try {
        const explicitNoPermissions = opts.permissions === false;
        const autoAllow: boolean | undefined = explicitNoPermissions
          ? false
          : opts.yes
            ? true
            : undefined;

        await runInstallerWithOptions({
          target: opts.target,
          location: opts.location as 'global' | 'local' | undefined,
          autoAllow,
          yes: opts.yes,
        });
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
