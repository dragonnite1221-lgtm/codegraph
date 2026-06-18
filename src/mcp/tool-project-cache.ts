/**
 * Cross-project CodeGraph instance cache + execution lifecycle for the MCP
 * ToolHandler. Opens other projects on-demand (keyed by resolved root),
 * evicts the oldest beyond a cap, and defers closing instances that are still
 * mid-execution. Split out of tools.ts to stay within the file-size gate.
 */

import CodeGraph, { findNearestCodeGraphRoot } from '../index';
import { isAbsolute, relative, resolve } from 'path';

const MAX_PROJECT_CACHE_SIZE = 32;

function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export class ProjectCache {
  // Cache of opened CodeGraph instances for cross-project queries, keyed by
  // resolved project root to avoid duplicate SQLite handles for path aliases.
  private projectCache: Map<string, CodeGraph> = new Map();
  private activeExecutions = 0;
  private pendingProjectCloses: Set<CodeGraph> = new Set();

  constructor(private cg: CodeGraph | null) {}

  setDefault(cg: CodeGraph): void {
    this.cg = cg;
  }

  hasDefault(): boolean {
    return this.cg !== null;
  }

  getDefault(): CodeGraph | null {
    return this.cg;
  }

  /** Bracket a tool execution so in-flight instances aren't closed underneath it. */
  beginExecution(): void {
    this.activeExecutions++;
  }

  endExecution(): void {
    this.activeExecutions--;
    this.flushPendingProjectCloses();
  }

  /**
   * Get CodeGraph instance for a project. If projectPath is provided, opens
   * that project's CodeGraph (cached, walking up to the nearest .codegraph/).
   * Otherwise returns the default instance.
   */
  getCodeGraph(projectPath?: string): CodeGraph {
    if (!projectPath) {
      if (!this.cg) {
        throw new Error('CodeGraph not initialized for this project. Run \'codegraph init\' first.');
      }
      return this.cg;
    }

    const requestedPath = resolve(projectPath);

    if (this.cg) {
      const defaultRoot = resolve(this.cg.getProjectRoot());
      if (pathContains(defaultRoot, requestedPath)) {
        return this.cg;
      }
    }

    // Walk up parent directories to find nearest .codegraph/
    const resolvedRoot = findNearestCodeGraphRoot(requestedPath);

    if (!resolvedRoot) {
      throw new Error(`CodeGraph not initialized in ${projectPath}. Run 'codegraph init' in that project first.`);
    }

    if (this.cg && resolve(this.cg.getProjectRoot()) === resolvedRoot) {
      return this.cg;
    }

    if (this.projectCache.has(resolvedRoot)) {
      return this.projectCache.get(resolvedRoot)!;
    }

    const cg = CodeGraph.openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    this.evictOldestCachedProjects();
    return cg;
  }

  private evictOldestCachedProjects(): void {
    while (this.projectCache.size > MAX_PROJECT_CACHE_SIZE) {
      const oldest = this.projectCache.entries().next().value;
      if (!oldest) return;
      const [projectRoot, cg] = oldest;
      this.projectCache.delete(projectRoot);
      this.closeProjectWhenIdle(cg);
    }
  }

  private closeProjectWhenIdle(cg: CodeGraph): void {
    if (this.activeExecutions > 0) {
      this.pendingProjectCloses.add(cg);
      return;
    }
    cg.close();
  }

  private flushPendingProjectCloses(): void {
    if (this.activeExecutions > 0) return;
    for (const cg of this.pendingProjectCloses) {
      cg.close();
    }
    this.pendingProjectCloses.clear();
  }

  /** Close the default + all cached project connections. */
  closeAll(): void {
    for (const cg of new Set([
      ...(this.cg ? [this.cg] : []),
      ...this.projectCache.values(),
      ...this.pendingProjectCloses,
    ])) {
      cg.close();
    }
    this.cg = null;
    this.projectCache.clear();
    this.pendingProjectCloses.clear();
  }
}
