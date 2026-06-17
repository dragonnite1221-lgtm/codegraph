/**
 * Cursor target.
 *
 *   - MCP server entry to `~/.cursor/mcp.json` (global) or
 *     `./.cursor/mcp.json` (local). Same `{mcpServers: {...}}` shape
 *     as Claude.
 *   - Instructions to `./.cursor/rules/codegraph.mdc` (project-local
 *     ONLY). Cursor's rules system is a project-scoped surface;
 *     global cursor rules aren't a stable convention as of 2026-05.
 *     For `--location=global`, only mcp.json is written.
 *
 * ## Why we hardcode `--path` for Cursor
 *
 * Cursor launches MCP-server subprocesses with a working directory
 * that ISN'T the workspace root AND doesn't pass `rootUri` /
 * `workspaceFolders` in the MCP initialize call. The codegraph MCP
 * server's `process.cwd()` fallback therefore misses the workspace's
 * `.codegraph/` and reports "not initialized" on every tool call.
 *
 * So we inject `--path` into the args ourselves:
 *
 *   - `local`  install: absolute path (we know it at install time).
 *   - `global` install: `${workspaceFolder}` — Cursor expands this to
 *     the open workspace's root, giving us per-workspace behavior
 *     from a single global config.
 *
 * Codex and Claude do not need this — they launch MCP servers with
 * `cwd = workspace` and pass `rootUri`, respectively.
 *
 * No permissions concept — Cursor doesn't have an auto-allow list
 * the installer can populate. `autoAllow` is silently ignored.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  readJsonFile,
  removeMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import {
  buildCursorMcpConfig,
  mcpJsonPath,
  rulesPath,
  writeMcpEntry,
  writeRulesEntry,
} from './cursor-io';

class CursorTarget implements AgentTarget {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor';
  readonly docsUrl = 'https://docs.cursor.com/context/model-context-protocol';

  supportsLocation(_loc: Location): boolean {
    // Both supported, but `local` writes more files (mcp.json + rules);
    // `global` writes only mcp.json. The orchestrator surfaces the
    // difference via describePaths.
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // "Installed" heuristic: does ~/.cursor exist (global) or has the
    // user opted into a project-local cursor config dir?
    const installed = loc === 'global'
      ? fs.existsSync(path.join(os.homedir(), '.cursor'))
      : fs.existsSync(path.join(process.cwd(), '.cursor'));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));

    if (loc === 'local') {
      files.push(writeRulesEntry());
    }

    return {
      files,
      notes: ['Restart Cursor for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    if (loc === 'local') {
      const rules = rulesPath();
      const action = removeMarkedSection(rules, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
      files.push({ path: rules, action });
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildCursorMcpConfig(loc) } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'local'
      ? [mcpJsonPath(loc), rulesPath()]
      : [mcpJsonPath(loc)];
  }

  /**
   * Write the project-local `.cursor/rules/codegraph.mdc` file. Used
   * by `codegraph init` to bootstrap projects that have only the
   * global `~/.cursor/mcp.json` — without the rules file, the Cursor
   * agent has no signal to prefer codegraph over native grep.
   */
  wireProjectSurfaces(): WriteResult {
    return { files: [writeRulesEntry()] };
  }
}

export const cursorTarget: AgentTarget = new CursorTarget();
