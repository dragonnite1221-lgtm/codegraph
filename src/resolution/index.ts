/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies.
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
import { matchReference } from './name-matcher';
import { resolveViaImport } from './import-resolver';
import { detectFrameworks } from './frameworks';
import { type AliasMap } from './path-aliases';
import type { ReExport } from './types';
import { createResolutionContext } from './resolution-context';
import { isBuiltInOrExternal } from './builtin-symbols';
import { buildResolvedEdges } from './edge-builder';

// Re-export types
export * from './types';

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private projectRoot: string;
  private queries: QueryBuilder;
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

  /**
   * Initialize the resolver (detect frameworks, etc.)
   */
  initialize(): void {
    this.frameworks = detectFrameworks(this.context);
    this.clearCaches();
  }

  /**
   * Pre-build lightweight caches for resolution.
   * Node lookups are now handled by indexed SQLite queries instead of
   * loading all nodes into memory (which caused OOM on large codebases).
   * We cache the set of known symbol names for fast pre-filtering.
   */
  warmCaches(): void {
    if (this.cachesWarmed) return;

    // Only cache the set of known file paths (lightweight string set)
    this.knownFiles = new Set(this.queries.getAllFilePaths());

    // Cache all distinct symbol names for fast pre-filtering (just strings, not full nodes)
    this.knownNames = new Set(this.queries.getAllNodeNames());

    this.cachesWarmed = true;
  }

  /**
   * Clear internal caches
   */
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


  /**
   * Resolve all unresolved references
   */
  resolveAll(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    // Pre-load all nodes into memory for fast lookups
    this.warmCaches();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    // Convert to our internal format, using denormalized fields when available
    const refs: UnresolvedRef[] = unresolvedRefs.map((ref) => ({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId),
      language: ref.language || this.getLanguageFromNodeId(ref.fromNodeId),
    }));

    const total = refs.length;
    let lastReportedPercent = -1;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!; // Array index is guaranteed to be in bounds
      const result = this.resolveOne(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(ref);
      }

      // Report progress every 1% to avoid too many updates
      if (onProgress) {
        const currentPercent = Math.floor((i / total) * 100);
        if (currentPercent > lastReportedPercent) {
          lastReportedPercent = currentPercent;
          onProgress(i + 1, total);
        }
      }
    }

    // Final progress report
    if (onProgress && total > 0) {
      onProgress(total, total);
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Check if a reference name has any possible match in the codebase.
   * Uses the pre-built knownNames set to skip expensive resolution
   * for names that definitely don't exist as symbols.
   */
  private hasAnyPossibleMatch(name: string): boolean {
    if (!this.knownNames) return true; // no pre-filter available

    // Direct name match
    if (this.knownNames.has(name)) return true;

    // For qualified names like "obj.method" or "Class::method", check the parts
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const receiver = name.substring(0, dotIdx);
      const member = name.substring(dotIdx + 1);
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
      // Also check capitalized receiver (instance-method resolution)
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      if (this.knownNames.has(capitalized)) return true;
    }
    const colonIdx = name.indexOf('::');
    if (colonIdx > 0) {
      const receiver = name.substring(0, colonIdx);
      const member = name.substring(colonIdx + 2);
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
    }

    // For path-like references (e.g., "snippets/drawer-menu.liquid"), check the filename
    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      const fileName = name.substring(slashIdx + 1);
      if (this.knownNames.has(fileName)) return true;
    }

    return false;
  }

  /**
   * Does `ref.referenceName` match an import declared in its containing
   * file? Used as a pre-filter escape so re-export chain resolution
   * still gets a chance when the name has no project-wide declaration.
   */
  private matchesAnyImport(ref: UnresolvedRef): boolean {
    const imports = this.context.getImportMappings(ref.filePath, ref.language);
    if (imports.length === 0) return false;
    for (const imp of imports) {
      if (
        imp.localName === ref.referenceName ||
        ref.referenceName.startsWith(imp.localName + '.')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a single reference
   */
  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    // Skip built-in/external references
    if (isBuiltInOrExternal(ref, this.knownNames)) {
      return null;
    }

    // Fast pre-filter: skip if no symbol with this name exists anywhere
    // AND the name doesn't match a local import. The import escape is
    // necessary because re-export rename chains (`import { login }
    // from './barrel'` where the barrel has `export { signIn as login }
    // from './auth'`) intentionally call a name that has no
    // declaration anywhere — only the renamed upstream symbol does.
    if (!this.hasAnyPossibleMatch(ref.referenceName) && !this.matchesAnyImport(ref)) {
      return null;
    }

    const candidates: ResolvedRef[] = [];

    // Strategy 1: Try framework-specific resolution
    for (const framework of this.frameworks) {
      const result = framework.resolve(ref, this.context);
      if (result) {
        if (result.confidence >= 0.9) return result; // High confidence, return immediately
        candidates.push(result);
      }
    }

    // Strategy 2: Try import-based resolution
    const importResult = resolveViaImport(ref, this.context);
    if (importResult) {
      if (importResult.confidence >= 0.9) return importResult;
      candidates.push(importResult);
    }

    // Strategy 3: Try name matching
    const nameResult = matchReference(ref, this.context);
    if (nameResult) {
      candidates.push(nameResult);
    }

    if (candidates.length === 0) return null;

    // Return highest confidence candidate
    return candidates.reduce((best, curr) =>
      curr.confidence > best.confidence ? curr : best
    );
  }


  /**
   * Resolve and persist edges to database
   */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    const result = this.resolveAll(unresolvedRefs, onProgress);

    // Create edges from resolved references
    const edges = buildResolvedEdges(this.queries, result.resolved);

    // Insert edges into database
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
    }

    // Clean up resolved refs from unresolved_refs table so metrics are accurate
    if (result.resolved.length > 0) {
      this.queries.deleteSpecificResolvedReferences(
        result.resolved.map((r) => ({
          fromNodeId: r.original.fromNodeId,
          referenceName: r.original.referenceName,
          referenceKind: r.original.referenceKind,
        }))
      );
    }

    return result;
  }

  /**
   * Resolve and persist in batches to keep memory bounded.
   * Processes unresolved references in chunks, persisting edges and cleaning
   * up resolved refs after each batch to avoid accumulating large arrays.
   */
  async resolveAndPersistBatched(
    onProgress?: (current: number, total: number) => void,
    batchSize: number = 5000
  ): Promise<ResolutionResult> {
    this.warmCaches();

    const total = this.queries.getUnresolvedReferencesCount();
    let processed = 0;
    const aggregateStats = {
      total: 0,
      resolved: 0,
      unresolved: 0,
      byMethod: {} as Record<string, number>,
    };

    // Process in batches. We always read from offset 0 because resolved refs
    // are deleted after each batch, shifting the remaining rows forward.
    while (true) {
      const batch = this.queries.getUnresolvedReferencesBatch(0, batchSize);
      if (batch.length === 0) break;

      const result = this.resolveAll(batch);

      // Persist edges immediately
      const edges = buildResolvedEdges(this.queries, result.resolved);
      if (edges.length > 0) {
        this.queries.insertEdges(edges);
      }

      // Clean up resolved refs so they don't appear in the next batch
      if (result.resolved.length > 0) {
        this.queries.deleteSpecificResolvedReferences(
          result.resolved.map((r) => ({
            fromNodeId: r.original.fromNodeId,
            referenceName: r.original.referenceName,
            referenceKind: r.original.referenceKind,
          }))
        );
      }

      // Delete unresolvable refs from this batch to avoid re-processing them
      if (result.unresolved.length > 0) {
        this.queries.deleteSpecificResolvedReferences(
          result.unresolved.map((r) => ({
            fromNodeId: r.fromNodeId,
            referenceName: r.referenceName,
            referenceKind: r.referenceKind,
          }))
        );
      }

      // Aggregate stats
      aggregateStats.total += result.stats.total;
      aggregateStats.resolved += result.stats.resolved;
      aggregateStats.unresolved += result.stats.unresolved;
      for (const [method, count] of Object.entries(result.stats.byMethod)) {
        aggregateStats.byMethod[method] = (aggregateStats.byMethod[method] || 0) + count;
      }

      processed += batch.length;
      onProgress?.(processed, total);

      // Yield so progress UI can render between batches
      await new Promise(resolve => setImmediate(resolve));

      // If nothing was resolved or removed in this batch, we'd loop forever
      // on the same rows. Break to avoid infinite loop.
      if (result.resolved.length === 0 && result.unresolved.length === batch.length) {
        break;
      }
    }

    return {
      resolved: [],
      unresolved: [],
      stats: aggregateStats,
    };
  }

  /**
   * Get detected frameworks
   */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }


  /**
   * Get file path from node ID
   */
  private getFilePathFromNodeId(nodeId: string): string {
    const node = this.queries.getNodeById(nodeId);
    return node?.filePath || '';
  }

  /**
   * Get language from node ID
   */
  private getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
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
