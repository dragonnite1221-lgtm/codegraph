import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource, scanDirectory, shouldIncludeFile } from '../src/extraction';
import { detectLanguage, isLanguageSupported, getSupportedLanguages, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { normalizePath } from '../src/utils';
import { DEFAULT_CONFIG } from '../src/types';
import { createTempDir, cleanupTempDir } from './extraction-helpers';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Path Normalization', () => {
  it('should convert backslashes to forward slashes', () => {
    expect(normalizePath('gui\\node_modules\\foo')).toBe('gui/node_modules/foo');
    expect(normalizePath('src\\components\\Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('should leave forward-slash paths unchanged', () => {
    expect(normalizePath('src/components/Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('should handle empty string', () => {
    expect(normalizePath('')).toBe('');
  });
});

describe('Directory Exclusion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should exclude node_modules directories', () => {
    // Create structure: src/index.ts + node_modules/pkg/index.js
    const srcDir = path.join(tempDir, 'src');
    const nmDir = path.join(tempDir, 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should exclude nested node_modules directories', () => {
    // Create structure: packages/app/node_modules/pkg/index.js
    const srcDir = path.join(tempDir, 'packages', 'app', 'src');
    const nmDir = path.join(tempDir, 'packages', 'app', 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('packages/app/src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should exclude .git directories', () => {
    const srcDir = path.join(tempDir, 'src');
    const gitDir = path.join(tempDir, '.git', 'objects');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(gitDir, 'pack.ts'), 'export const y = 2;');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('.git'))).toBe(true);
  });

  it('should return forward-slash paths on all platforms', () => {
    const srcDir = path.join(tempDir, 'src', 'components');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'Button.tsx'), 'export function Button() {}');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files.length).toBe(1);
    expect(files[0]).toBe('src/components/Button.tsx');
    expect(files[0]).not.toContain('\\');
  });

  it('should respect .codegraphignore marker', () => {
    const srcDir = path.join(tempDir, 'src');
    const vendorDir = path.join(tempDir, 'vendor');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(vendorDir, 'lib.ts'), 'export const y = 2;');
    fs.writeFileSync(path.join(vendorDir, '.codegraphignore'), '');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('vendor'))).toBe(true);
  });
});

describe('Git Submodules', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should index files inside git submodules (issue #147)', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    // Build a separate "library" repo to use as a submodule source.
    const libDir = path.join(tempDir, '_lib');
    fs.mkdirSync(libDir, { recursive: true });
    git(libDir, 'init', '-q');
    git(libDir, 'config', 'user.email', 'test@test.com');
    git(libDir, 'config', 'user.name', 'Test');
    // Host-level commit signing would break commits in this throwaway repo.
    git(libDir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(libDir, 'lib.ts'), 'export const fromSubmodule = 1;');
    git(libDir, 'add', '-A');
    git(libDir, 'commit', '-q', '-m', 'lib init');

    // Build the main repo and add the lib repo as a submodule.
    const mainDir = path.join(tempDir, 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    git(mainDir, 'init', '-q');
    git(mainDir, 'config', 'user.email', 'test@test.com');
    git(mainDir, 'config', 'user.name', 'Test');
    git(mainDir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(mainDir, 'app.ts'), 'export const app = 1;');
    git(mainDir, 'add', '-A');
    git(mainDir, 'commit', '-q', '-m', 'app init');
    // protocol.file.allow=always is required to add a local-path submodule on
    // recent git versions (CVE-2022-39253 mitigation).
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', libDir, 'libs/lib'],
      { cwd: mainDir, stdio: 'pipe' }
    );
    git(mainDir, 'commit', '-q', '-m', 'add submodule');

    const config = { ...DEFAULT_CONFIG, rootDir: mainDir };
    const files = scanDirectory(mainDir, config);

    expect(files).toContain('app.ts');
    expect(files).toContain('libs/lib/lib.ts');
  });
});
