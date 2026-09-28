import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('explore count includes main and subagent calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-eval-'));
  try {
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(project);
    const logs = join(home, '.claude', 'projects', realpathSync(project).replace(/[/:\\]/g, '-'));
    const subagents = join(logs, 'session', 'subagents');
    mkdirSync(subagents, { recursive: true });
    const call = JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'mcp__codegraph__codegraph_explore' }] } });
    writeFileSync(join(logs, 'session.jsonl'), `${call}\n${call}\n`);
    writeFileSync(join(subagents, 'agent.jsonl'), `${call}\n${call}\n${call}\n`);

    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./parse-session.mjs', import.meta.url)), project], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /VERDICT: codegraph_explore used 5x/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
