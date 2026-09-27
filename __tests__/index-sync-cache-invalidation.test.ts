import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('ordinary sync on a reused CodeGraph instance', () => {
  let dir: string;
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves calls to a symbol added after the initial index', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-cache-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function oldFn() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), "import { oldFn } from './a';\nexport function useIt() { return oldFn(); }\n");
    graph = await CodeGraph.init(dir, { index: true });

    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function brandNewName() { return 2; }\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), "import { brandNewName } from './a';\nexport function useIt() { return brandNewName(); }\n");
    const result = await graph.sync();

    expect(result.filesModified).toBeGreaterThan(0);
    const target = graph.getNodesByKind('function').find((node) => node.name === 'brandNewName');
    expect(target).toBeDefined();
    expect(graph.getIncomingEdges(target!.id).some((edge) => edge.kind === 'calls')).toBe(true);
  });
});
