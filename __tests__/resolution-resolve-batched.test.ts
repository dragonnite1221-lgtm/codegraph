/**
 * Regression: resolveAndPersistBatched must keep processing later batches
 * even when an earlier batch resolves nothing, and its infinite-loop guard
 * must not be fooled by concurrent writes to the unresolved_refs table.
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
 *
 * Exercises real SQLite (per this repo's testing convention -- no DB
 * mocking) via DatabaseConnection + QueryBuilder against a temp db file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { resolveAndPersistBatched, type ResolverApi } from '../src/resolution/resolution-resolve';
import type { UnresolvedRef, ResolvedRef } from '../src/resolution/types';
import type { Node, UnresolvedReference } from '../src/types';

function nodeRecord(id: string, filePath: string): Node {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: id,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
  };
}

function unresolvedRef(fromNodeId: string, referenceName: string): UnresolvedReference {
  return {
    fromNodeId,
    referenceName,
    referenceKind: 'calls',
    line: 1,
    column: 1,
    filePath: 'a.ts',
    language: 'typescript',
  };
}

/** Real ResolverApi: `queries` is a genuine QueryBuilder over a temp SQLite db; only resolveOne (the actual name-matching logic under test elsewhere) is stubbed. */
function makeResolver(queries: QueryBuilder, unresolvableNames: Set<string>): ResolverApi {
  return {
    queries,
    warmCaches: () => {},
    resolveOne: (ref: UnresolvedRef): ResolvedRef | null => {
      if (unresolvableNames.has(ref.referenceName)) return null;
      return {
        original: ref,
        targetNodeId: 'target',
        confidence: 1,
        resolvedBy: 'exact-match',
      };
    },
    getFilePathFromNodeId: () => 'a.ts',
    getLanguageFromNodeId: () => 'typescript',
  };
}

describe('resolveAndPersistBatched loop control', () => {
  let dir: string;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-batched-'));
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(conn.getDb());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('continues processing later batches after an earlier batch resolves nothing', async () => {
    // Batch 1 (batchSize=2): both fail to resolve.
    // Batch 2 and 3: both refs resolve successfully, against a real target node.
    queries.insertNode(nodeRecord('target', 'target.ts'));
    for (const name of ['unresolvable-1', 'unresolvable-2', 'resolvable-3', 'resolvable-4', 'resolvable-5', 'resolvable-6']) {
      queries.insertNode(nodeRecord(`node:${name}`, 'a.ts'));
    }
    queries.insertUnresolvedRefsBatch(
      ['unresolvable-1', 'unresolvable-2', 'resolvable-3', 'resolvable-4', 'resolvable-5', 'resolvable-6'].map((name) =>
        unresolvedRef(`node:${name}`, name)
      )
    );

    const unresolvableNames = new Set(['unresolvable-1', 'unresolvable-2']);
    const resolver = makeResolver(queries, unresolvableNames);

    const onProgress = vi.fn();
    const result = await resolveAndPersistBatched(resolver, onProgress, 2);

    // All 6 refs must have been visited across all 3 batches, not just the
    // first one -- the all-fail batch must not halt the remaining batches.
    expect(result.stats.total).toBe(6);
    expect(result.stats.resolved).toBe(4);
    expect(result.stats.unresolved).toBe(2);

    // Every row -- resolved and unresolvable -- must have been drained from
    // the real unresolved_refs table; nothing left stranded behind the
    // failed batch.
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
    // The 4 resolvable refs must have produced real edges into the graph.
    expect(queries.getIncomingEdges('target')).toHaveLength(4);
  });

  it('does not abort remaining batches because a concurrent writer inserted new rows', async () => {
    // Regression for a second-order bug in the original fix: the
    // loop-progress guard was based on the unresolved_refs table's total
    // row count. resolveReferencesBatched() isn't lock-protected against a
    // concurrent indexing pass inserting new refs -- if enough land between
    // one batch's deletes and the count check, the net count can fail to
    // shrink (or even grow), which must NOT be mistaken for a stall.
    queries.insertNode(nodeRecord('target', 'target.ts'));
    queries.insertNode(nodeRecord('node:a', 'a.ts'));
    queries.insertNode(nodeRecord('node:b', 'b.ts'));
    queries.insertUnresolvedRefsBatch([unresolvedRef('node:a', 'a-ref'), unresolvedRef('node:b', 'b-ref')]);

    const resolver = makeResolver(queries, new Set());
    let batchesSeen = 0;

    const result = await resolveAndPersistBatched(
      resolver,
      () => {
        batchesSeen++;
        // Simulate a concurrent indexing pass inserting a fresh unresolved
        // ref after the first batch has already been resolved + deleted,
        // but before the loop's own next-iteration fetch.
        if (batchesSeen === 1) {
          queries.insertNode(nodeRecord('node:c', 'c.ts'));
          queries.insertUnresolvedRefsBatch([unresolvedRef('node:c', 'c-ref')]);
        }
      },
      1
    );

    // 2 original refs + 1 concurrently-inserted ref, all resolved.
    expect(result.stats.resolved).toBe(3);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
  });
});
