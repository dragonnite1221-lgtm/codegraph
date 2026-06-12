import { defineConfig } from 'vitest/config';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const isUnsupportedNode = nodeMajor >= 24;

if (isUnsupportedNode && !process.env.CODEGRAPH_ALLOW_UNSAFE_NODE) {
  throw new Error(
    `CodeGraph tests require Node.js >=18 <24; current Node.js is ${process.versions.node}. ` +
      'Use Node.js 22 LTS, or set CODEGRAPH_ALLOW_UNSAFE_NODE=1 for targeted unsupported-runtime diagnostics.'
  );
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    // Some developer machines exercise the WASM SQLite fallback when the
    // optional native better-sqlite3 binding was built for another Node ABI.
    // Keep integration tests classified as slow instead of failing on the
    // default 5s/10s Vitest limits.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Node 24+ is not a supported runtime for CodeGraph, but developers can
    // still run the test suite locally. In that unsupported path the WASM
    // fallback is slow and memory-heavy, so avoid parallel worker exits.
    ...(isUnsupportedNode ? { maxWorkers: 1, minWorkers: 1 } : {}),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
