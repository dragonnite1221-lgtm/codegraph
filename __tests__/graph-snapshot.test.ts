/**
 * Graph snapshot regression test
 *
 * Indexes a small, fixed multi-language fixture and pins the resulting graph
 * shape (node/edge counts by kind) plus a couple of resolved cross-symbol
 * edges. This is a holistic guard for the extraction + resolution pipeline:
 * any change that alters what symbols/relationships are produced fails here,
 * complementing the per-construct extraction tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const TS_SRC = `export class Greeter {
  greet(name: string): string {
    return 'hi ' + name;
  }
}

export function run(): string {
  const g = new Greeter();
  return g.greet('world');
}
`;

const PY_SRC = `class Counter:
    def __init__(self):
        self.n = 0

    def inc(self):
        self.n += 1


def make():
    c = Counter()
    c.inc()
    return c
`;

describe('graph snapshot (extraction + resolution)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-snap-'));
    fs.writeFileSync(path.join(dir, 'greeter.ts'), TS_SRC);
    fs.writeFileSync(path.join(dir, 'counter.py'), PY_SRC);
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('produces a stable node/edge shape for the fixture', async () => {
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const stats = cg.getStats();

      // Drop zero-count buckets for a compact, stable projection.
      const nonZero = (rec: Record<string, number>) =>
        Object.fromEntries(Object.entries(rec).filter(([, v]) => v > 0));

      expect({
        fileCount: stats.fileCount,
        nodesByKind: nonZero(stats.nodesByKind),
        edgesByKind: nonZero(stats.edgesByKind),
        filesByLanguage: nonZero(stats.filesByLanguage),
      }).toMatchInlineSnapshot(`
        {
          "edgesByKind": {
            "calls": 2,
            "contains": 7,
            "instantiates": 2,
          },
          "fileCount": 2,
          "filesByLanguage": {
            "python": 1,
            "typescript": 1,
          },
          "nodesByKind": {
            "class": 2,
            "file": 2,
            "function": 2,
            "method": 3,
          },
        }
      `);
    } finally {
      cg.close();
    }
  });

  it('resolves the intra-file call run() -> Greeter.greet', async () => {
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const greet = cg.searchNodes('greet', { limit: 5 }).find((r) => r.node.name === 'greet');
      expect(greet).toBeDefined();

      const callerNames = cg.getCallers(greet!.node.id).map((c) => c.node.name);
      expect(callerNames).toContain('run');
    } finally {
      cg.close();
    }
  });
});
