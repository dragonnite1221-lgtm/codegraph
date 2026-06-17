/**
 * Cursor path + write helpers, split out of cursor.ts to stay within the
 * file-size gate. See cursor.ts for the `--path` rationale.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Location, WriteResult } from './types';
import {
  atomicWriteFileSync,
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

export function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.cursor', 'mcp.json')
    : path.join(process.cwd(), '.cursor', 'mcp.json');
}

/**
 * Cursor "rules" file. Only meaningful for the project-local
 * location — Cursor reads `.cursor/rules/*.mdc` from the workspace
 * root. There is no global equivalent.
 */
export function rulesPath(): string {
  return path.join(process.cwd(), '.cursor', 'rules', 'codegraph.mdc');
}

/**
 * Cursor `.mdc` rules use YAML-ish frontmatter. `alwaysApply: true`
 * makes the rule load on every conversation regardless of file
 * patterns — appropriate for a tool-usage guide that's relevant
 * whenever the user is asking the agent to navigate code.
 */
const MDC_FRONTMATTER = [
  '---',
  'description: CodeGraph MCP usage guide — when to use which tool',
  'alwaysApply: true',
  '---',
  '',
].join('\n');

/**
 * Build the codegraph MCP-server config for Cursor at the given
 * location. Inherits the shared shape ({type, command, args}) and
 * appends `--path` so the spawned MCP server resolves the workspace
 * correctly regardless of Cursor's launch cwd. See cursor.ts header for
 * the full rationale.
 */
export function buildCursorMcpConfig(loc: Location): { type: string; command: string; args: string[] } {
  const base = getMcpServerConfig();
  const pathArg = loc === 'local' ? process.cwd() : '${workspaceFolder}';
  return { ...base, args: [...base.args, '--path', pathArg] };
}

export function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildCursorMcpConfig(loc);

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export function writeRulesEntry(): WriteResult['files'][number] {
  const file = rulesPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Body is frontmatter + the shared instructions block. The
  // marker-based replacement targets only the marker block, so the
  // frontmatter is preserved across re-runs.
  const body = MDC_FRONTMATTER + INSTRUCTIONS_TEMPLATE;

  if (!fs.existsSync(file)) {
    atomicWriteFileSync(file, body + '\n');
    return { path: file, action: 'created' };
  }

  // For .mdc files we own outright, do byte-equality first.
  const existing = fs.readFileSync(file, 'utf-8');
  const wantWithNL = body + '\n';
  if (existing === wantWithNL) {
    return { path: file, action: 'unchanged' };
  }

  // Otherwise, marker-based section swap (preserves any user-added
  // content outside the markers).
  const action = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created'
      : action === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
}
