import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectCache } from '../src/mcp/tool-project-cache';

describe('MCP ProjectCache lifecycle', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function codegraphRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codegraph-handler-cache-'));
    mkdirSync(join(dir, '.codegraph'));
    tempDirs.push(dir);
    return dir;
  }

  it('reuses the default CodeGraph for matching projectPath requests', () => {
    const projectRoot = codegraphRoot();
    const defaultCg = {
      getProjectRoot: vi.fn(() => projectRoot),
      close: vi.fn(),
    };
    const handler = new ProjectCache(defaultCg as any) as any;

    expect(handler.getCodeGraph(projectRoot)).toBe(defaultCg);
    expect(handler.projectCache.size).toBe(0);
  });

  it('defers evicted project closes until active executions finish', () => {
    const handler = new ProjectCache(null) as any;
    const project = { close: vi.fn() };

    handler.activeExecutions = 1;
    handler.closeProjectWhenIdle(project);

    expect(project.close).not.toHaveBeenCalled();
    expect(handler.pendingProjectCloses.has(project)).toBe(true);

    handler.activeExecutions = 0;
    handler.flushPendingProjectCloses();

    expect(project.close).toHaveBeenCalledTimes(1);
    expect(handler.pendingProjectCloses.size).toBe(0);
  });

  it('closes default and cached projects during closeAll', () => {
    const defaultCg = { close: vi.fn() };
    const handler = new ProjectCache(defaultCg as any) as any;
    const cached = { close: vi.fn() };
    const pending = { close: vi.fn() };

    handler.projectCache.set('/repo', cached);
    handler.pendingProjectCloses.add(pending);

    handler.closeAll();

    expect(defaultCg.close).toHaveBeenCalledTimes(1);
    expect(cached.close).toHaveBeenCalledTimes(1);
    expect(pending.close).toHaveBeenCalledTimes(1);
    expect(handler.cg).toBeNull();
    expect(handler.projectCache.size).toBe(0);
    expect(handler.pendingProjectCloses.size).toBe(0);
  });
});
