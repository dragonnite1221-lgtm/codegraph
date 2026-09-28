import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect, it } from 'vitest';
import { createDefaultConfig, loadConfig, saveConfig, validateConfig } from '../src/config';

it('reloads configured languages supported by extraction', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'codegraph-config-languages-'));
  try {
    const config = createDefaultConfig(rootDir);
    config.languages = ['swift', 'c', 'cpp', 'vue', 'scala'];
    saveConfig(rootDir, config);
    expect(loadConfig(rootDir).languages).toEqual(config.languages);
    expect(validateConfig({ ...config, languages: ['not-a-language'] })).toBe(false);
    expect(validateConfig({ ...config, languages: ['__proto__'] })).toBe(false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
