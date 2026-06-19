/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies. Per-reference matching lives
 * in resolution-match.ts and the resolve/persist drivers in
 * resolution-resolve.ts (operating on this resolver via ResolverApi) to stay
 * within the file-size gate; this class owns caches + framework state.
 */

import { Node, UnresolvedReference } from '../types';
import { QueryBuilder } from '../db/queries';
import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionResult,
  ResolutionContext,
  FrameworkResolver,
  ImportMapping,
} from './types';
import { detectFrameworks } from './frameworks';
import { type AliasMap } from './path-aliases';
import type { ReExport } from './types';
import { createResolutionContext } from './resolution-context';
import { resolveOne as runResolveOne } from './resolution-match';
import {
  resolveAll as runResolveAll,
  resolveAndPersist as runResolveAndPersist,
  resolveAndPersistBatched as runResolveAndPersistBatched,
} from './resolution-resolve';

// Re-export types
export * from './types';

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private projectRoot: string;
  queries: QueryBuilder;
  private context: ResolutionContext;
  private frameworks: FrameworkResolver[] = [];
  private nodeCache: Map<string, Node[]> = new Map(); // per-file node cache (bounded)
  private fileCache: Map<string, string | null> = new Map(); // per-file content cache (bounded)
  private importMappingCache: Map<string, ImportMapping[]> = new Map();
  private reExportCache: Map<string, ReExport[]> = new Map();
  private nameCache: Map<string, Node[]> = new Map(); // name → nodes cache
  private lowerNameCache: Map<string, Node[]> = new Map(); // lower(name) → nodes cache
  private qualifiedNameCache: Map<string, Node[]> = new Map(); // qualified_name → nodes cache
  private knownNames: Set<string> | null = null; // all known symbol names for fast pre-filtering
  private knownFiles: Set<string> | null = null;
  private cachesWarmed = false;
  // tsconfig/jsconfig path-alias map. `undefined` = not yet computed,
  // `null` = computed and absent. Treated as immutable for the
  // resolver's lifetime; callers re-create the resolver if config changes.
  private projectAliases: AliasMap | null | undefined = undefined;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.context = createResolutionContext({
      queries: this.queries,
      projectRoot: this.projectRoot,
      nodeCache: this.nodeCache,
      fileCache: this.fileCache,
      importMappingCache: this.importMappingCache,
      reExportCache: this.reExportCache,
      nameCache: this.nameCache,
      lowerNameCache: this.lowerNameCache,
      qualifiedNameCache: this.qualifiedNameCache,
      getKnownFiles: () => this.knownFiles,
      getAliases: () => this.projectAliases,
      setAliases: (aliases) => { this.projectAliases = aliases; },
    });
  }

  /** Initialize the resolver (detect frameworks, etc.) */
  initialize(): void {
    this.frameworks = detectFrameworks(this.context);
    this.clearCaches();
  }

  /**
   * Pre-build lightweight caches for resolution. Node lookups go through
   * indexed SQLite queries; we only cache the set of known symbol names + file
   * paths for fast pre-filtering (avoids OOM from loading all nodes).
   */
  warmCaches(): void {
    if (this.cachesWarmed) return;
    this.knownFiles = new Set(this.queries.getAllFilePaths());
    this.knownNames = new Set(this.queries.getAllNodeNames());
    this.cachesWarmed = true;
  }

  /** Clear internal caches */
  clearCaches(): void {
    this.nodeCache.clear();
    this.fileCache.clear();
    this.importMappingCache.clear();
    this.reExportCache.clear();
    this.nameCache.clear();
    this.lowerNameCache.clear();
    this.qualifiedNameCache.clear();
    this.knownNames = null;
    this.knownFiles = null;
    this.cachesWarmed = false;
  }

  /** Resolve all unresolved references */
  resolveAll(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    return runResolveAll(this, unresolvedRefs, onProgress);
  }

  /** Resolve a single reference */
  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    return runResolveOne(
      { knownNames: this.knownNames, frameworks: this.frameworks, context: this.context },
      ref
    );
  }

  /** Resolve and persist edges to database */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    return runResolveAndPersist(this, unresolvedRefs, onProgress);
  }

  /** Resolve and persist in batches to keep memory bounded. */
  async resolveAndPersistBatched(
    onProgress?: (current: number, total: number) => void,
    batchSize: number = 5000
  ): Promise<ResolutionResult> {
    return runResolveAndPersistBatched(this, onProgress, batchSize);
  }

  /** Get detected frameworks */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }

  /** Get file path from node ID */
  getFilePathFromNodeId(nodeId: string): string {
    const node = this.queries.getNodeById(nodeId);
    return node?.filePath || '';
  }

  /** Get language from node ID */
  getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
    const node = this.queries.getNodeById(nodeId);
    return node?.language || 'unknown';
  }
}

/**
 * Create a reference resolver instance
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
