/**
 * opencode target.
 *
 *   - MCP server entry to `~/.config/opencode/opencode.jsonc` (global,
 *     XDG-style; `%APPDATA%/opencode/opencode.jsonc` on Windows) or
 *     `./opencode.jsonc` (local). Falls back to `opencode.json` when a
 *     `.json` file already exists; defaults new installs to `.jsonc`
 *     because that's what opencode itself creates on first run.
 *   - Instructions to `~/.config/opencode/AGENTS.md` (global) or
 *     `./AGENTS.md` (local). opencode reads AGENTS.md for agent
 *     instructions — same convention Codex CLI uses.
 *   - No permissions concept.
 *
 * Config shape uses opencode's wrapper:
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "mcp": { "codegraph": { "type": "local", "command": [...], "enabled": true } }
 *   }
 *
 * The shape differs from Claude/Cursor — opencode uses `mcp.<name>`
 * (not `mcpServers`), takes `command` as a string array combining
 * binary + args, and includes an explicit `enabled` flag.
 *
 * Reads + writes go through `jsonc-parser` so any `//` and `/* *\/`
 * comments the user has added to their `.jsonc` survive idempotent
 * re-runs.
 */

import * as fs from 'fs';
import { modify, applyEdits } from 'jsonc-parser';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  removeMarkedSection,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import {
  FORMATTING,
  configPath,
  getOpencodeServerEntry,
  globalConfigDir,
  instructionsPath,
  parseConfig,
  readConfigText,
  writeInstructionsEntry,
  writeMcpEntry,
} from './opencode-io';

class OpencodeTarget implements AgentTarget {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly docsUrl = 'https://opencode.ai/docs/config';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.mcp?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir())
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    files.push(writeInstructionsEntry(loc));
    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const file = configPath(loc);

    if (!fs.existsSync(file)) {
      files.push({ path: file, action: 'not-found' });
    } else {
      const text = readConfigText(file);
      const config = parseConfig(text);
      if (!config.mcp?.codegraph) {
        files.push({ path: file, action: 'not-found' });
      } else {
        // Drop our key surgically. Leaves siblings + comments untouched.
        let edits = modify(text, ['mcp', 'codegraph'], undefined, {
          formattingOptions: FORMATTING,
        });
        let updated = applyEdits(text, edits);

        // If `mcp` is now an empty object, drop the wrapper too.
        const afterParsed = parseConfig(updated);
        if (afterParsed.mcp && typeof afterParsed.mcp === 'object' &&
            Object.keys(afterParsed.mcp).length === 0) {
          edits = modify(updated, ['mcp'], undefined, { formattingOptions: FORMATTING });
          updated = applyEdits(updated, edits);
        }

        atomicWriteFileSync(file, updated);
        files.push({ path: file, action: 'removed' });
      }
    }

    const instr = instructionsPath(loc);
    const instrAction = removeMarkedSection(instr, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    files.push({ path: instr, action: instrAction });

    return { files };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { codegraph: getOpencodeServerEntry() },
    }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc), instructionsPath(loc)];
  }
}

export const opencodeTarget: AgentTarget = new OpencodeTarget();
