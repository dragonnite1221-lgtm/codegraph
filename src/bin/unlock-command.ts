import type { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { getCodeGraphDir, isInitialized } from '../directory';
import { getGlyphs } from '../ui/glyphs';

import { error, info, success } from './cli-output';

type CommandDeps = {
  resolveProjectPath(pathArg?: string): string;
};

export function registerUnlockCommand(program: Command, deps: CommandDeps): void {
  program
    .command('unlock [path]')
    .description('Remove a stale lock file that is blocking indexing')
    .action(async (pathArg: string | undefined) => {
      const projectPath = deps.resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          return;
        }

        const lockPath = path.join(getCodeGraphDir(projectPath), 'codegraph.lock');

        if (!fs.existsSync(lockPath)) {
          info(`No lock file found ${getGlyphs().dash} nothing to do`);
          return;
        }

        fs.unlinkSync(lockPath);
        success('Removed lock file. You can now run indexing again.');
      } catch (err) {
        error(`Failed to remove lock: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
