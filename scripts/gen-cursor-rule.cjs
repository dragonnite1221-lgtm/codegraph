#!/usr/bin/env node
/**
 * Regenerate .cursor/rules/codegraph.mdc from the single source of truth
 * (INSTRUCTIONS_TEMPLATE in src/installer/instructions-template.ts).
 *
 * The .mdc body is byte-identical to INSTRUCTIONS_TEMPLATE; only the Cursor
 * frontmatter is .mdc-specific and is preserved verbatim. Run after editing
 * the instructions template:  node scripts/gen-cursor-rule.cjs
 *
 * The __tests__/instructions-sync.test.ts guard fails if the committed .mdc
 * drifts from the template.
 */
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const { INSTRUCTIONS_TEMPLATE } = require(path.join(repo, 'dist', 'installer', 'instructions-template.js'));

const mdcPath = path.join(repo, '.cursor', 'rules', 'codegraph.mdc');
const existing = fs.readFileSync(mdcPath, 'utf-8');
const fm = existing.match(/^(---\n[\s\S]*?\n---\n)/);
if (!fm) {
  console.error('Could not find frontmatter in', mdcPath);
  process.exit(1);
}

const body = INSTRUCTIONS_TEMPLATE.endsWith('\n') ? INSTRUCTIONS_TEMPLATE : INSTRUCTIONS_TEMPLATE + '\n';
const out = fm[1] + body;
fs.writeFileSync(mdcPath, out);
console.log(`Regenerated ${path.relative(repo, mdcPath)} from INSTRUCTIONS_TEMPLATE (${body.length} body bytes).`);
