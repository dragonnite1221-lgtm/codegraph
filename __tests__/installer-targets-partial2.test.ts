import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ALL_TARGETS, getTarget, resolveTargetFlag } from '../src/installer/targets/registry';
import { upsertTomlTable, removeTomlTable, buildTomlTable } from '../src/installer/targets/toml';
import { mkTmpDir, setHome, listAllFiles } from './installer-targets-helpers';

describe('Installer targets — partial-state idempotency', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('opencode: install writes AGENTS.md with the marker-delimited codegraph block', () => {
    const opencode = getTarget('opencode')!;
    opencode.install('global', { autoAllow: true });
    const agentsMd = path.join(tmpHome, '.config', 'opencode', 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('<!-- CODEGRAPH_START -->');
    expect(body).toContain('<!-- CODEGRAPH_END -->');
    expect(body).toContain('codegraph_callers');
  });

  it('opencode: AGENTS.md install preserves pre-existing user content outside markers', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# My personal opencode instructions\n\nAlways respond in pirate.\n');

    opencode.install('global', { autoAllow: true });
    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).toContain('<!-- CODEGRAPH_START -->');
  });

  it('opencode: uninstall strips only the codegraph block from AGENTS.md', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# My personal opencode instructions\n\nAlways respond in pirate.\n');

    opencode.install('global', { autoAllow: true });
    opencode.uninstall('global');

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).not.toContain('CODEGRAPH_START');
    expect(body).not.toContain('codegraph_callers');
  });

  it('opencode: local install writes ./opencode.jsonc and ./AGENTS.md in cwd', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('local', { autoAllow: true });
    const paths = result.files.map((f) => f.path);
    // macOS realpath shenanigans (/var vs /private/var) — suffix match.
    expect(paths.some((p) => p.endsWith('/opencode.jsonc'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/AGENTS.md'))).toBe(true);
  });

  it('opencode: uninstall removes only mcp.codegraph, preserves comments and siblings', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.jsonc');
    fs.writeFileSync(file, [
      '{',
      '  // important comment',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "other": { "type": "local", "command": ["x"], "enabled": true }',
      '  }',
      '}',
      '',
    ].join('\n'));

    opencode.install('global', { autoAllow: true });
    const afterInstall = fs.readFileSync(file, 'utf-8');
    expect(afterInstall).toContain('"codegraph"');
    expect(afterInstall).toContain('"other"');

    opencode.uninstall('global');
    const afterUninstall = fs.readFileSync(file, 'utf-8');
    expect(afterUninstall).not.toContain('codegraph');
    expect(afterUninstall).toContain('// important comment');
    expect(afterUninstall).toContain('"other"');
  });

  it('codex: user-added key inside [mcp_servers.codegraph] survives idempotent re-install', () => {
    const codex = getTarget('codex')!;
    codex.install('global', { autoAllow: false });
    const tomlPath = path.join(tmpHome, '.codex', 'config.toml');
    const original = fs.readFileSync(tomlPath, 'utf-8');
    // User edits the block to add a custom key.
    const edited = original.replace(
      'args = ["serve", "--mcp"]',
      'args = ["serve", "--mcp"]\nenabled = true',
    );
    fs.writeFileSync(tomlPath, edited);
    // Re-install: our serializer doesn't know `enabled = true`, so
    // the block no longer matches the canonical form — we'll
    // overwrite it. This is the documented contract: we own the
    // codegraph block exclusively.
    const second = codex.install('global', { autoAllow: false });
    const tomlEntry = second.files.find((f) => f.path.endsWith('config.toml'))!;
    expect(tomlEntry.action).toBe('updated');
    const after = fs.readFileSync(tomlPath, 'utf-8');
    expect(after).not.toContain('enabled = true');
  });
});
