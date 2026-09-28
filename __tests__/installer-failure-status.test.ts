import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ targets: [] as unknown[], initialized: 0, calls: [] as string[] }));
vi.mock('../src/installer/installer-flow', () => ({
  getVersion: () => 'test',
  resolveTargets: async () => state.targets,
  initializeLocalProject: async () => { state.initialized++; },
  tildify: (p: string) => p,
}));

import { runInstallerWithOptions } from '../src/installer';

it('reports target failures after continuing and skips initialization when all fail', async () => {
  const failed = {
    id: 'claude', displayName: 'Claude', supportsLocation: () => true,
    install: () => { state.calls.push('failed'); throw new Error('synthetic failure'); },
  };
  const succeeded = {
    id: 'cursor', displayName: 'Cursor', supportsLocation: () => true,
    install: () => { state.calls.push('succeeded'); return { files: [] }; },
  };

  state.targets = [failed];
  await expect(runInstallerWithOptions({ yes: true, location: 'local' })).rejects.toThrow(/installation incomplete/);
  expect(state.initialized).toBe(0);

  state.targets = [failed, succeeded];
  await expect(runInstallerWithOptions({ yes: true, location: 'local' })).rejects.toThrow(/installation incomplete/);
  expect(state.calls).toEqual(['failed', 'failed', 'succeeded']);
  expect(state.initialized).toBe(1);
});
