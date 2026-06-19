/**
 * CodeGraph config/directory/uninitialize/close/graph-query foundation tests.
 * Split out of foundation.test.ts to stay within the file-size gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { DEFAULT_CONFIG, Node, Edge } from '../src/types';
import { loadConfig, saveConfig } from '../src/config';
import { isInitialized, getCodeGraphDir, validateDirectory } from '../src/directory';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('CodeGraph Foundation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('Configuration', () => {
    it('should load and merge config with defaults', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const config = loadConfig(tempDir);
      expect(config.version).toBe(DEFAULT_CONFIG.version);
      expect(config.rootDir).toBe(path.resolve(tempDir));
    });

    it('should update configuration', () => {
      const cg = CodeGraph.initSync(tempDir);

      cg.updateConfig({ maxFileSize: 999999 });

      expect(cg.getConfig().maxFileSize).toBe(999999);

      cg.close();

      // Verify persistence
      const config = loadConfig(tempDir);
      expect(config.maxFileSize).toBe(999999);
    });
  });

  describe('Directory Management', () => {
    it('should validate directory structure', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should detect invalid directory', () => {
      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Uninitialize', () => {
    it('should remove .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      cg.uninitialize();

      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(false);
      expect(CodeGraph.isInitialized(tempDir)).toBe(false);
    });
  });

  describe('Close/Destroy', () => {
    it('should close database but keep .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      cg.destroy(); // destroy is alias for close

      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(true);
      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
    });
  });

  describe('Graph Query Methods', () => {
    it('should throw "Node not found" for non-existent nodes', () => {
      const cg = CodeGraph.initSync(tempDir);

      // getContext throws for non-existent nodes
      expect(() => cg.getContext('non-existent')).toThrow(/not found/i);

      cg.close();
    });

    it('should return empty results for non-existent nodes', () => {
      const cg = CodeGraph.initSync(tempDir);

      // These methods return empty results instead of throwing
      const traverseResult = cg.traverse('non-existent');
      expect(traverseResult.nodes.size).toBe(0);

      const callGraph = cg.getCallGraph('non-existent');
      expect(callGraph.nodes.size).toBe(0);

      const typeHierarchy = cg.getTypeHierarchy('non-existent');
      expect(typeHierarchy.nodes.size).toBe(0);

      const usages = cg.findUsages('non-existent');
      expect(usages.length).toBe(0);

      cg.close();
    });

  });
});
