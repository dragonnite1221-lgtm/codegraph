/**
 * opencode path + write helpers, split out of opencode.ts to stay within the
 * file-size gate. Reads/writes go through jsonc-parser so user comments survive
 * idempotent re-runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser';
import { Location, WriteResult } from './types';
import {
  atomicWriteFileSync,
  jsonDeepEqual,
  replaceOrAppendMarkedSection,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
  INSTRUCTIONS_TEMPLATE,
} from '../instructions-template';

export const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

export function globalConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'opencode');
  }
  // XDG_CONFIG_HOME if set, else ~/.config — matches opencode's docs.
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'opencode');
}

function configBaseDir(loc: Location): string {
  return loc === 'global' ? globalConfigDir() : process.cwd();
}

// Pick existing .jsonc, then .json, default to .jsonc for new files.
// opencode auto-creates .jsonc on first run, so that's the dominant
// real-world case and the sensible default for greenfield installs.
export function configPath(loc: Location): string {
  const dir = configBaseDir(loc);
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  if (fs.existsSync(jsonc)) return jsonc;
  if (fs.existsSync(json)) return json;
  return jsonc;
}

export function instructionsPath(loc: Location): string {
  return path.join(configBaseDir(loc), 'AGENTS.md');
}

export function readConfigText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

export function parseConfig(text: string): Record<string, any> {
  if (!text.trim()) return {};
  const errors: any[] = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, any>;
}

export function getOpencodeServerEntry(): { type: string; command: string[]; enabled: boolean } {
  return {
    type: 'local',
    command: ['codegraph', 'serve', '--mcp'],
    enabled: true,
  };
}

export function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const existed = fs.existsSync(file);
  let text = readConfigText(file);

  // Seed a minimal opencode config when the file is brand-new so
  // the result is a complete, schema-tagged file (not just a bare
  // `{ "mcp": {...} }`).
  if (!text.trim()) {
    text = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  }

  const config = parseConfig(text);
  const before = config.mcp?.codegraph;
  const after = getOpencodeServerEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  // Add $schema if the user's existing file is missing it.
  if (!config.$schema) {
    const schemaEdits = modify(text, ['$schema'], 'https://opencode.ai/config.json', {
      formattingOptions: FORMATTING,
    });
    text = applyEdits(text, schemaEdits);
  }

  // Surgical edit — preserves comments, formatting, and order of
  // every key we don't touch.
  const edits = modify(text, ['mcp', 'codegraph'], after, {
    formattingOptions: FORMATTING,
  });
  const updated = applyEdits(text, edits);
  atomicWriteFileSync(file, updated);

  return { path: file, action: existed ? 'updated' : 'created' };
}

export function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

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
