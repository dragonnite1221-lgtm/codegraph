/**
 * Installer Tests
 *
 * Tests for installer config-writer fixes:
 * - readJsonFile error handling
 * - writeClaudeMd section replacement
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the exported functions from config-writer
import {
  writeMcpConfig,
  writePermissions,
  writeClaudeMd,
  hasMcpConfig,
  hasPermissions,
  hasClaudeMdSection,
} from '../src/installer/config-writer';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-installer-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Installer Config Writer', () => {
  let origCwd: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanupTempDir(tempDir);
  });

  describe('readJsonFile error handling', () => {
    it('should return empty object for non-existent file', () => {
      // writeMcpConfig reads claude.json - if it doesn't exist, it should create it
      writeMcpConfig('local');

      const claudeJson = path.join(tempDir, '.claude.json');
      expect(fs.existsSync(claudeJson)).toBe(true);

      const content = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.codegraph).toBeDefined();
    });

    it('refuses to overwrite corrupted JSON; preserves it and backs it up', () => {
      // A corrupted .claude.json must NOT be clobbered with just our
      // codegraph entry (that would wipe the user's other MCP servers).
      // The write is refused, the original bytes survive, and a
      // timestamped backup is made.
      const claudeJson = path.join(tempDir, '.claude.json');
      const corrupt = '{ this is not valid json !!!';
      fs.writeFileSync(claudeJson, corrupt);

      expect(() => writeMcpConfig('local')).toThrow(/not valid JSON/);

      // Original file untouched.
      expect(fs.readFileSync(claudeJson, 'utf-8')).toBe(corrupt);

      // A timestamped backup of the corrupt original exists.
      const backups = fs.readdirSync(tempDir).filter(
        (f) => f.startsWith('.claude.json.corrupt-') && f.endsWith('.bak'),
      );
      expect(backups.length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(tempDir, backups[0]), 'utf-8')).toBe(corrupt);
    });

    it('should preserve existing valid config when adding codegraph', () => {
      const claudeJson = path.join(tempDir, '.claude.json');
      fs.writeFileSync(claudeJson, JSON.stringify({
        mcpServers: { other: { command: 'other-tool' } },
        customField: 'preserved',
      }, null, 2));

      writeMcpConfig('local');

      const content = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
      expect(content.mcpServers.codegraph).toBeDefined();
      expect(content.mcpServers.other).toBeDefined();
      expect(content.customField).toBe('preserved');
    });
  });

});
