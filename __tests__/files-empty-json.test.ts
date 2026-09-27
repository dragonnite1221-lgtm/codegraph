import { Command } from 'commander';
import { expect, it, vi } from 'vitest';

vi.mock('../src/directory', () => ({ isInitialized: () => true }));

import { registerFilesCommand } from '../src/bin/files-command';

it('prints a JSON array for empty index and empty filter results', async () => {
  let files: Array<{ path: string; language: string; nodeCount: number; size: number }> = [];
  const graph = { getFiles: () => files, destroy: () => {} };
  const output: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line) => { output.push(String(line)); });
  try {
    for (const args of [[], ['--filter', 'missing']]) {
      files = args.length ? [{ path: 'src/keep.ts', language: 'typescript', nodeCount: 1, size: 1 }] : [];
      const program = new Command();
      registerFilesCommand(program, {
        resolveProjectPath: () => '/synthetic',
        loadCodeGraph: async () => ({ default: { open: async () => graph } } as unknown as typeof import('../src/index')),
      });
      await program.parseAsync(['node', 'codegraph', 'files', '--json', ...args]);
      expect(output[output.length - 1]).toBe('[]');
    }
  } finally {
    log.mockRestore();
  }
});
