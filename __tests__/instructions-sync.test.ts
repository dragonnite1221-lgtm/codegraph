/**
 * Instructions sync guard
 *
 * The codegraph usage guidance lives in three places that must stay in sync
 * (CLAUDE.md house rule): the MCP `initialize` payload (server-instructions),
 * the agent-agnostic instructions template written by the installer, and the
 * Cursor `.cursor/rules/codegraph.mdc` rule. This test makes that sync
 * machine-checked instead of manual:
 *
 *   1. codegraph.mdc is treated as GENERATED — its body must be byte-identical
 *      to INSTRUCTIONS_TEMPLATE (the single source). Regenerate with
 *      `node scripts/gen-cursor-rule.cjs` if this fails.
 *   2. All three documents must reference exactly the set of tools the MCP
 *      server actually registers — no missing tool, no stale one.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { INSTRUCTIONS_TEMPLATE } from '../src/installer/instructions-template';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';
import { tools } from '../src/mcp/tool-definitions';

const MDC_PATH = path.join(__dirname, '..', '.cursor', 'rules', 'codegraph.mdc');

/** Extract the marker-delimited body from the .mdc (everything after frontmatter). */
function mdcBody(): string {
  const raw = fs.readFileSync(MDC_PATH, 'utf-8');
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1] : raw;
}

function toolTokens(text: string): string[] {
  return [...new Set(text.match(/codegraph_[a-z]+/g) ?? [])].sort();
}

describe('instructions sync', () => {
  it('codegraph.mdc body is generated from INSTRUCTIONS_TEMPLATE (single source)', () => {
    const body = mdcBody();
    const norm = (s: string) => (s.endsWith('\n') ? s : s + '\n');
    expect(norm(body)).toBe(norm(INSTRUCTIONS_TEMPLATE));
  });

  it('all three instruction docs reference exactly the registered tool set', () => {
    const registered = [...new Set(tools.map((t) => t.name))].sort();

    expect(toolTokens(INSTRUCTIONS_TEMPLATE)).toEqual(registered);
    expect(toolTokens(SERVER_INSTRUCTIONS)).toEqual(registered);
    expect(toolTokens(mdcBody())).toEqual(registered);
  });
});
