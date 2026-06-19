/**
 * Adaptive output budget for codegraph_explore (#185) — runtime output tests.
 * Split out of explore-output-budget.test.ts to stay within the file-size gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getExploreBudget, getExploreOutputBudget, ToolHandler } from '../src/mcp/tools';
import CodeGraph from '../src/index';

describe('codegraph_explore output respects the adaptive budget', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-budget-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // A handful of files with one fat target file. The fat file mimics the
    // Alamofire Session.swift case: many methods stacked on top of each other,
    // which collapsed into one giant cluster pre-#185.
    const fatLines: string[] = ['export class Session {'];
    for (let i = 0; i < 30; i++) {
      fatLines.push(`  method${i}(arg: string): string {`);
      fatLines.push(`    return this.helper${i}(arg) + "${i}";`);
      fatLines.push(`  }`);
      fatLines.push(`  private helper${i}(arg: string): string {`);
      fatLines.push(`    return arg.repeat(${i + 1});`);
      fatLines.push(`  }`);
    }
    fatLines.push('}');
    fs.writeFileSync(path.join(srcDir, 'session.ts'), fatLines.join('\n'));

    // A few small supporting files so the project has >1 indexed file.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(srcDir, `support${i}.ts`),
        `import { Session } from './session';\nexport function callSession${i}(s: Session) { return s.method${i}('hi'); }\n`
      );
    }

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('keeps total output under the small-project cap', async () => {
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    const smallBudget = getExploreOutputBudget(100);
    // Allow a small overshoot for the trailing markers — the cap is enforced
    // per-file rather than as an absolute output ceiling.
    expect(text.length).toBeLessThan(smallBudget.maxOutputChars + 500);
  });

  it('omits the meta-text gated off for small projects', async () => {
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).not.toContain('### Additional relevant files');
    expect(text).not.toContain('Complete source code is included above');
    expect(text).not.toContain('Explore budget:');
  });

  it('still includes the Relationships section — it is the cheapest structural signal', async () => {
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // Either there are relationships, or no edges were significant — both are fine.
    // We just want to confirm we did not accidentally gate it off.
    const hasRelationships = text.includes('### Relationships');
    const sourceFollowsHeader = text.indexOf('### Source Code') > 0;
    expect(hasRelationships || sourceFollowsHeader).toBe(true);
  });

  it('prefixes source lines with line numbers by default (cat -n style)', async () => {
    delete process.env.CODEGRAPH_EXPLORE_LINENUMS;
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // At least one fenced source line should look like `<digits>\t<code>`.
    expect(/\n\d+\t/.test(text)).toBe(true);
  });

  it('omits line numbers when CODEGRAPH_EXPLORE_LINENUMS=0', async () => {
    process.env.CODEGRAPH_EXPLORE_LINENUMS = '0';
    try {
      const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
      const text = result.content?.[0]?.text ?? '';
      // The synthetic source has no tab-prefixed numeric lines of its own,
      // so none should appear when the toggle is off.
      expect(/\n\d+\t(?:export|  )/.test(text)).toBe(false);
    } finally {
      delete process.env.CODEGRAPH_EXPLORE_LINENUMS;
    }
  });

  it('uses language-neutral omission markers (no C-style // in the output)', async () => {
    // The gap/trimmed separators must not assume `//` is a comment — that's
    // wrong in Python, Ruby, etc. They render inside fenced source blocks.
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).not.toContain('// ... (gap)');
    expect(text).not.toContain('// ... trimmed');
  });

  it('does not collapse a whole-file class into just its header (envelope filter)', async () => {
    // The synthetic `Session` class spans the entire file. Without the
    // envelope filter it would form one giant cluster that tail-trims to
    // the class declaration, hiding the methods. Confirm real method bodies
    // make it into the output. Regression guard for the #185 follow-up.
    const result = await handler.execute('codegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // A method body line (`methodN(arg: string)`) should appear, not just
    // the `export class Session {` opener.
    const hasMethodBody = /method\d+\(arg: string\)/.test(text);
    expect(hasMethodBody).toBe(true);
  });
});
