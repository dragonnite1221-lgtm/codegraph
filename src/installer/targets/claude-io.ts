/**
 * Claude Code path + write helpers, split out of claude.ts to stay within the
 * file-size gate. The write* helpers are exported so the legacy
 * `config-writer.ts` shim can call a single named operation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Location, WriteResult } from './types';
import {
  atomicWriteFileSync,
  getCodeGraphPermissions,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  replaceOrAppendMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
  INSTRUCTIONS_TEMPLATE,
} from '../instructions-template';

export function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.claude')
    : path.join(process.cwd(), '.claude');
}
export function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.claude.json')
    : path.join(process.cwd(), '.claude.json');
}
export function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
export function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'CLAUDE.md');
}

export function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    // Already exactly what we'd write — preserve byte-identical file.
    return { path: file, action: 'unchanged' };
  }
  // 'created' here means: the file itself did not exist before this
  // write. A pre-existing `.claude.json` containing other MCP servers
  // (no `codegraph` key) is 'updated', not 'created' — we're adding
  // an entry to a file that was already there. Codex uses a different
  // idiom (empty-content => 'created') because its config.toml is
  // ours alone to manage.
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export function writePermissionsEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const settings = readJsonFile(file);
  const created = !fs.existsSync(file);

  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  const want = getCodeGraphPermissions();
  const before = [...settings.permissions.allow];
  for (const perm of want) {
    if (!settings.permissions.allow.includes(perm)) {
      settings.permissions.allow.push(perm);
    }
  }
  if (jsonDeepEqual(before, settings.permissions.allow) && !created) {
    return { path: file, action: 'unchanged' };
  }
  writeJsonFile(file, settings);
  return { path: file, action: created ? 'created' : 'updated' };
}

export function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  // Ensure config dir exists (for global ~/.claude/).
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Honor the legacy "unmarked ## CodeGraph" rewrite path that the
  // original installer supported (some users hand-pasted a section
  // before markers existed). Detect first and migrate inline.
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    if (!content.includes(CODEGRAPH_SECTION_START)) {
      const headerMatch = content.match(/\n## CodeGraph\n/);
      if (headerMatch && headerMatch.index !== undefined) {
        const sectionStart = headerMatch.index;
        const after = content.substring(sectionStart + 1);
        const nextHeader = after.match(/\n## (?!#)/);
        const sectionEnd = nextHeader && nextHeader.index !== undefined
          ? sectionStart + 1 + nextHeader.index
          : content.length;
        const merged =
          content.substring(0, sectionStart) +
          '\n' + INSTRUCTIONS_TEMPLATE +
          content.substring(sectionEnd);
        atomicWriteFileSync(file, merged);
        return { path: file, action: 'updated' };
      }
    }
  }

  const action = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  // Map the four-state action to WriteResult's action vocabulary.
  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created'
      : action === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
}
