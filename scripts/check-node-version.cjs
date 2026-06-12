#!/usr/bin/env node

const nodeVersion = process.versions.node;
const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] || '0', 10);

if (nodeMajor >= 24 && !process.env.CODEGRAPH_ALLOW_UNSAFE_NODE) {
  console.error(
    [
      `[CodeGraph] Unsupported Node.js version for tests: ${nodeVersion}`,
      'CodeGraph requires Node.js >=18 <24 because Node.js 24+ can crash with',
      '`Fatal process out of memory: Zone` while compiling tree-sitter WASM grammars.',
      'Use Node.js 22 LTS for the full test suite.',
      'For targeted diagnostics only, rerun with CODEGRAPH_ALLOW_UNSAFE_NODE=1.',
    ].join('\n')
  );
  process.exit(1);
}
