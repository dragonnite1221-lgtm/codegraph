/**
 * Resolution drivers: resolveAll (iterate + resolve), and the persist variants
 * that write edges and prune the unresolved-refs table. Split out of index.ts
 * to stay within the file-size gate. Operate on the resolver via ResolverApi.
 */

import { UnresolvedReference } from '../types';
import { QueryBuilder } from '../db/queries';
import { UnresolvedRef, ResolvedRef, ResolutionResult } from './types';
import { buildResolvedEdges } from './edge-builder';

/** What the resolution drivers need from the ReferenceResolver. */
export interface ResolverApi {
  queries: QueryBuilder;
  warmCaches(): void;
  resolveOne(ref: UnresolvedRef): ResolvedRef | null;
  getFilePathFromNodeId(nodeId: string): string;
  getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'];
}

/** Resolve all unresolved references. */
export function resolveAll(
  resolver: ResolverApi,
  unresolvedRefs: UnresolvedReference[],
  onProgress?: (current: number, total: number) => void
): ResolutionResult {
  // Pre-load all nodes into memory for fast lookups
  resolver.warmCaches();

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
    filePath: ref.filePath || resolver.getFilePathFromNodeId(ref.fromNodeId),
    language: ref.language || resolver.getLanguageFromNodeId(ref.fromNodeId),
  }));

  const total = refs.length;
  let lastReportedPercent = -1;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!; // Array index is guaranteed to be in bounds
    const result = resolver.resolveOne(ref);

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
    stats: { total: refs.length, resolved: resolved.length, unresolved: unresolved.length, byMethod },
  };
}

function deleteRefs(
  queries: QueryBuilder,
  refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: UnresolvedRef['referenceKind'] }>
): void {
  if (refs.length === 0) return;
  queries.deleteSpecificResolvedReferences(
    refs.map((r) => ({
      fromNodeId: r.fromNodeId,
      referenceName: r.referenceName,
      referenceKind: r.referenceKind,
    }))
  );
}

/** Resolve and persist edges to the database. */
export function resolveAndPersist(
  resolver: ResolverApi,
  unresolvedRefs: UnresolvedReference[],
  onProgress?: (current: number, total: number) => void
): ResolutionResult {
  const result = resolveAll(resolver, unresolvedRefs, onProgress);

  // Create edges from resolved references
  const edges = buildResolvedEdges(resolver.queries, result.resolved);
  if (edges.length > 0) {
    resolver.queries.insertEdges(edges);
  }

  // Clean up resolved refs from unresolved_refs table so metrics are accurate
  deleteRefs(resolver.queries, result.resolved.map((r) => r.original));

  return result;
}

/** Stable identity for a fetched batch, used to detect a genuine stall below. */
function batchIdentity(batch: UnresolvedReference[]): string {
  return JSON.stringify(batch.map((r) => [r.fromNodeId, r.referenceName, r.referenceKind, r.line, r.column]));
}

/**
 * Resolve and persist in batches to keep memory bounded. Persists edges and
 * prunes resolved + unresolvable refs after each batch.
 */
export async function resolveAndPersistBatched(
  resolver: ResolverApi,
  onProgress?: (current: number, total: number) => void,
  batchSize: number = 5000
): Promise<ResolutionResult> {
  resolver.warmCaches();

  const total = resolver.queries.getUnresolvedReferencesCount();
  let processed = 0;
  let previousBatchKey: string | null = null;
  const aggregateStats = {
    total: 0,
    resolved: 0,
    unresolved: 0,
    byMethod: {} as Record<string, number>,
  };

  // Process in batches. We always read from offset 0 because resolved refs
  // are deleted after each batch, shifting the remaining rows forward.
  while (true) {
    const batch = resolver.queries.getUnresolvedReferencesBatch(0, batchSize);
    if (batch.length === 0) break;

    // Identify this batch by its own rows (fetched in stable `id` order),
    // not the table's total row count -- resolveReferencesBatched() isn't
    // lock-protected against a concurrent indexing pass inserting new
    // unresolved refs, which could inflate the total count and mask a
    // genuine stall, or shrink it and produce a false one. New rows from a
    // concurrent writer always get a larger id and so always sort after
    // this batch, never into it, so this identity is unaffected by
    // concurrent activity elsewhere in the table.
    const batchKey = batchIdentity(batch);

    const result = resolveAll(resolver, batch);

    // Persist edges immediately
    const edges = buildResolvedEdges(resolver.queries, result.resolved);
    if (edges.length > 0) {
      resolver.queries.insertEdges(edges);
    }

    // Clean up resolved + unresolvable refs so they don't appear in the next batch
    deleteRefs(resolver.queries, result.resolved.map((r) => r.original));
    deleteRefs(resolver.queries, result.unresolved);

    // Aggregate stats
    aggregateStats.total += result.stats.total;
    aggregateStats.resolved += result.stats.resolved;
    aggregateStats.unresolved += result.stats.unresolved;
    for (const [method, count] of Object.entries(result.stats.byMethod)) {
      aggregateStats.byMethod[method] = (aggregateStats.byMethod[method] || 0) + count;
    }

    processed += batch.length;
    onProgress?.(processed, total);

    // Safety net against an infinite loop: every ref in this batch was just
    // deleted above (as resolved or as unresolved), so the same batch must
    // not reappear next iteration -- if it does, the delete had no effect.
    // A batch resolving *zero* references is NOT itself a stall: its refs
    // are still removed, and later (untouched) batches may resolve fine
    // once e.g. other files finish indexing, so one all-fail batch must
    // not abort the batches behind it. Measured before the yield below so
    // a concurrent writer can't influence this comparison.
    if (batchKey === previousBatchKey) {
      break;
    }
    previousBatchKey = batchKey;

    // Yield so progress UI can render between batches
    await new Promise(resolve => setImmediate(resolve));
  }

  return { resolved: [], unresolved: [], stats: aggregateStats };
}
