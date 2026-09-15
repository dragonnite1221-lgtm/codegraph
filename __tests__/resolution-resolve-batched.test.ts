/**
 * Regression: resolveAndPersistBatched must keep processing later batches
 * even when an earlier batch resolves nothing.
 *
 * The batch loop always reads from offset 0 because both resolved AND
 * unresolved refs are deleted from `unresolved_refs` after every batch
 * (see `deleteRefs` calls in resolveAndPersistBatched) -- so the table
 * itself always shrinks by a full batch, guaranteeing forward progress.
 * The old "if nothing resolved in this batch, break" guard didn't check
 * that invariant; it bailed out of the *entire* loop the moment any single
 * batch failed to resolve a single reference, silently abandoning every
 * batch queued behind it even though they were never touched and could
 * easily contain resolvable references (e.g. once other files finish
 * indexing).
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveAndPersistBatched, type ResolverApi } from '../src/resolution/resolution-resolve';
import type { UnresolvedRef, ResolvedRef } from '../src/resolution/types';
import type { UnresolvedReference } from '../src/types-records';
import type { QueryBuilder } from '../src/db/queries';

interface Key {
  fromNodeId: string;
  referenceName: string;
  referenceKind: UnresolvedRef['referenceKind'];
}

function makeRef(name: string): UnresolvedReference {
  return {
    fromNodeId: `node:${name}`,
    referenceName: name,
    referenceKind: 'calls',
    line: 1,
    column: 1,
    filePath: 'a.ts',
    language: 'typescript',
  };
}

function sameKey(a: Key, b: Key): boolean {
  return (
    a.fromNodeId === b.fromNodeId &&
    a.referenceName === b.referenceName &&
    a.referenceKind === b.referenceKind
  );
}

/** In-memory stand-in for the unresolved_refs table + a fake ResolverApi. */
function makeFakeResolver(rows: UnresolvedReference[], unresolvableNames: Set<string>) {
  let table = [...rows];
  const insertedEdges: unknown[] = [];

  const queries = {
    getUnresolvedReferencesCount: () => table.length,
    getUnresolvedReferencesBatch: (offset: number, limit: number) => table.slice(offset, offset + limit),
    insertEdges: (edges: unknown[]) => { insertedEdges.push(...edges); },
    deleteSpecificResolvedReferences: (keys: Key[]) => {
      table = table.filter((row) => !keys.some((k) => sameKey(k, row as Key)));
    },
    // edge-builder.ts consults this to promote calls->instantiates and
    // extends->implements; returning null keeps every edge at its original
    // referenceKind, which is all this test cares about.
    getNodeById: () => null,
  } as unknown as QueryBuilder;

  const resolver: ResolverApi = {
    queries,
    warmCaches: () => {},
    resolveOne: (ref: UnresolvedRef): ResolvedRef | null => {
      if (unresolvableNames.has(ref.referenceName)) return null;
      return {
        original: ref,
        targetNodeId: `target:${ref.referenceName}`,
        confidence: 1,
        resolvedBy: 'exact-match',
      };
    },
    getFilePathFromNodeId: () => 'a.ts',
    getLanguageFromNodeId: () => 'typescript',
  };

  return { resolver, getTable: () => table };
}

describe('resolveAndPersistBatched loop control', () => {
  it('continues processing later batches after an earlier batch resolves nothing', async () => {
    // Batch 1 (batchSize=2): both fail to resolve.
    // Batch 2 and 3: both refs resolve successfully.
    const rows = [
      makeRef('unresolvable-1'),
      makeRef('unresolvable-2'),
      makeRef('resolvable-3'),
      makeRef('resolvable-4'),
      makeRef('resolvable-5'),
      makeRef('resolvable-6'),
    ];
    const unresolvableNames = new Set(['unresolvable-1', 'unresolvable-2']);
    const { resolver, getTable } = makeFakeResolver(rows, unresolvableNames);

    const onProgress = vi.fn();
    const result = await resolveAndPersistBatched(resolver, onProgress, 2);

    // All 6 refs must have been visited across all 3 batches, not just the
    // first one -- the all-fail batch must not halt the remaining batches.
    expect(result.stats.total).toBe(6);
    expect(result.stats.resolved).toBe(4);
    expect(result.stats.unresolved).toBe(2);

    // Every row -- resolved and unresolvable -- must have been drained from
    // the table; nothing should be left stranded behind the failed batch.
    expect(getTable()).toHaveLength(0);
  });
});
