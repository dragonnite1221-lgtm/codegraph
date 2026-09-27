import { expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cursorTarget } from '../src/installer/targets/cursor';
import { writeMcpEntry, writeRulesEntry } from '../src/installer/targets/cursor-io';

it('refuses project-local Cursor paths through linked directories', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cursor-'));
  const previousCwd = process.cwd();
  try {
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    const externalConfig = path.join(outside, 'mcp.json');
    fs.writeFileSync(externalConfig, 'keep');
    process.chdir(project);

    fs.symlinkSync(outside, path.join(project, '.cursor'), 'dir');
    expect(() => cursorTarget.detect('local')).toThrow(/symbolic link/);
    expect(() => writeMcpEntry('local')).toThrow(/symbolic link/);
    expect(() => writeRulesEntry()).toThrow(/symbolic link/);
    expect(fs.readFileSync(externalConfig, 'utf8')).toBe('keep');

    fs.unlinkSync(path.join(project, '.cursor'));
    fs.mkdirSync(path.join(project, '.cursor'));
    fs.symlinkSync(outside, path.join(project, '.cursor', 'rules'), 'dir');
    expect(() => writeMcpEntry('local')).toThrow(/symbolic link/);
    expect(() => cursorTarget.uninstall('local')).toThrow(/symbolic link/);
    expect(fs.existsSync(path.join(project, '.cursor', 'mcp.json'))).toBe(false);
    expect(fs.readFileSync(externalConfig, 'utf8')).toBe('keep');
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
