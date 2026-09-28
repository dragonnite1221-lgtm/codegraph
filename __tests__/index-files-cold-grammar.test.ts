import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect, it, vi } from 'vitest';
import type { OrchestratorApi } from '../src/extraction';

it('loads the detected grammar when indexing a file in a cold process', async () => {
  vi.resetModules();
  const { indexFileWithContent } = await import('../src/extraction/extraction-index-files');
  const { isGrammarLoaded } = await import('../src/extraction/grammars');
  const rootDir = mkdtempSync(join(tmpdir(), 'codegraph-cold-grammar-'));
  try {
    const relativePath = 'cold.ts';
    const content = 'export function coldStart() { return 1; }';
    const fullPath = join(rootDir, relativePath);
    writeFileSync(fullPath, content);
    const orch = {
      rootDir,
      config: { maxFileSize: 1024 * 1024 },
      ensureDetectedFrameworks: () => [],
      storeExtractionResult: () => {},
    } as unknown as OrchestratorApi;

    const result = await indexFileWithContent(orch, relativePath, content, statSync(fullPath));
    expect(isGrammarLoaded('typescript')).toBe(true);
    expect(result.errors.filter((error) => error.severity === 'error')).toEqual([]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

it('does not initialize WASM for a language with its own extractor', async () => {
  vi.resetModules();
  const { indexFileWithContent } = await import('../src/extraction/extraction-index-files');
  const { isGrammarsInitialized } = await import('../src/extraction/grammars');
  const rootDir = mkdtempSync(join(tmpdir(), 'codegraph-custom-language-'));
  try {
    const relativePath = 'sample.liquid';
    const content = '{{ product.title }}';
    const fullPath = join(rootDir, relativePath);
    writeFileSync(fullPath, content);
    const orch = {
      rootDir,
      config: { maxFileSize: 1024 * 1024 },
      ensureDetectedFrameworks: () => [],
      storeExtractionResult: () => {},
    } as unknown as OrchestratorApi;

    expect(isGrammarsInitialized()).toBe(false);
    await indexFileWithContent(orch, relativePath, content, statSync(fullPath));
    expect(isGrammarsInitialized()).toBe(false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
