import { expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from '../src/installer/targets/shared';

it('preserves private config permissions and refuses a preexisting temp path', () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-config-'));
  try {
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, 'old');
    fs.chmodSync(config, 0o600);
    atomicWriteFileSync(config, 'new');
    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(config, 'utf8')).toBe('new');

    const victim = path.join(dir, 'victim');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, config + '.tmp.' + process.pid);
    expect(() => atomicWriteFileSync(config, 'overwrite')).toThrow();
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
    expect(fs.readFileSync(config, 'utf8')).toBe('new');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
