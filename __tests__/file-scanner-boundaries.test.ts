import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { getGitChangedFiles, getGitVisibleFiles } from '../src/extraction/file-scanner';
import { isPathWithinRootReal, validatePathWithinRoot } from '../src/path-security';
import { DEFAULT_CONFIG } from '../src/types';

const posixIt = process.platform === 'win32' ? it.skip : it;

describe('file scanner trust boundary', () => {
  let rootDir: string;
  let externalDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-root-'));
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-external-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { force: true, recursive: true });
    fs.rmSync(externalDir, { force: true, recursive: true });
  });

  posixIt('rejects a tracked symlink whose real target escapes a git root', async () => {
    initGit(rootDir);
    const externalFile = path.join(externalDir, 'secret.ts');
    fs.writeFileSync(externalFile, 'export const secret = true;');
    fs.symlinkSync(externalFile, path.join(rootDir, 'leak.ts'));
    git(rootDir, 'add', 'leak.ts');

    const config = { ...DEFAULT_CONFIG, rootDir, exclude: [] };
    expect(getGitVisibleFiles(rootDir)).toContain('leak.ts');
    expect(scanDirectory(rootDir, config)).not.toContain('leak.ts');
    await expect(scanDirectoryAsync(rootDir, config)).resolves.not.toContain('leak.ts');
    expect(validatePathWithinRoot(rootDir, 'leak.ts')).toBeNull();
  });

  posixIt('does not descend through an external directory symlink', () => {
    fs.writeFileSync(path.join(externalDir, 'secret.ts'), 'export const secret = true;');
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.symlinkSync(externalDir, path.join(rootDir, 'src', 'external'), 'dir');

    const config = { ...DEFAULT_CONFIG, rootDir, exclude: [] };
    expect(scanDirectory(rootDir, config)).toEqual([]);
  });

  posixIt('preserves in-root files and links through a symlinked project root', () => {
    const linkedRoot = path.join(externalDir, 'project-root');
    const externalFile = path.join(externalDir, 'outside.ts');
    fs.writeFileSync(path.join(rootDir, 'inside.ts'), 'export const inside = true;');
    fs.writeFileSync(externalFile, 'export const outside = true;');
    fs.symlinkSync(path.join(rootDir, 'inside.ts'), path.join(rootDir, 'inside-link.ts'));
    fs.symlinkSync(externalFile, path.join(rootDir, 'outside-link.ts'));
    fs.symlinkSync(rootDir, linkedRoot, 'dir');

    const config = { ...DEFAULT_CONFIG, rootDir: linkedRoot, exclude: [] };
    expect(scanDirectory(linkedRoot, config).sort()).toEqual(['inside-link.ts', 'inside.ts']);
  });

  posixIt('fails closed when a real path cannot be resolved', () => {
    fs.symlinkSync(path.join(externalDir, 'missing'), path.join(rootDir, 'broken'));
    expect(isPathWithinRootReal('broken', rootDir)).toBe(false);
  });

  posixIt('preserves whitespace and newlines in git filenames', () => {
    initGit(rootDir);
    const filename = 'src/line\nbreak .ts';
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.writeFileSync(path.join(rootDir, filename), 'export const value = 1;');
    git(rootDir, 'add', filename);
    git(rootDir, 'commit', '-qm', 'add unusual filename');

    expect(getGitVisibleFiles(rootDir)).toContain(filename);

    fs.writeFileSync(path.join(rootDir, filename), 'export const value = 2;');
    const config = { ...DEFAULT_CONFIG, rootDir, exclude: [] };
    expect(getGitChangedFiles(rootDir, config)?.modified).toEqual([filename]);
  });
});

function initGit(cwd: string): void {
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'CodeGraph Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}
