/**
 * Regression: resolveAndPersistBatched's infinite-loop guard must not be
 * fooled by concurrent writes to unresolved_refs.
 *
 * resolveReferencesBatched() (CodeGraph#resolveReferencesBatched) is public
 * and does not acquire the indexing mutex/file lock, so a concurrent
 * indexing pass can insert new unresolved refs while a batched resolve is
 * in flight. The guard must key off something that concurrent activity
 * elsewhere in the table can't corrupt.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { resolveAndPersistBatched } from '../src/resolution/resolution-resolve';
import { makeResolver, nodeRecord, unresolvedRef } from './helpers/resolution-resolve-test-utils';

describe('resolveAndPersistBatched concurrency safety', () => {
  let dir: string;
  let conn: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-batched-concurrency-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(conn.getDb());
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not abort remaining batches because a concurrent writer inserted new rows', async () => {
    // Regression for a second-order bug in the original fix: the
    // loop-progress guard was based on the unresolved_refs table's total
    // row count. If enough rows land between one batch's deletes and the
    // count check, the net count can fail to shrink (or even grow), which
    // must NOT be mistaken for a stall.
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

  it('does not strand a trailing ref behind a concurrently-reinserted, content-identical one', async () => {
    // Regression for a flaw in an earlier version of this fix: identifying
    // a batch by its field values (fromNodeId/referenceName/referenceKind/
    // line/column) instead of its actual row id.
    //
    // Sequence with only ONE pre-existing ref (`dup-ref`), batchSize=1:
    //   iter1: fetches `dup-ref` (id1), resolves + deletes it.
    //          Concurrently, a writer reinserts a reference with the exact
    //          same field values (e.g. a re-extraction pass reparsing the
    //          same call site) as `dup-ref2` (id2), AND inserts an
    //          unrelated trailing ref `trailing-ref` (id3).
    //   iter2: fetches `dup-ref2` (id2, lowest remaining id). Its field
    //          values equal iter1's -- indistinguishable from "the same
    //          row failed to delete" by field values alone, but never by
    //          row id (id2 != id1). Resolves + deletes it fine either way,
    //          but a field-value-based stall guard would then abort the
    //          loop right here, before `trailing-ref` (id3) is ever
    //          fetched -- silently stranding it.
    queries.insertNode(nodeRecord('target', 'target.ts'));
    queries.insertNode(nodeRecord('node:a', 'a.ts'));
    queries.insertNode(nodeRecord('node:b', 'b.ts'));
    queries.insertUnresolvedRefsBatch([unresolvedRef('node:a', 'dup-ref')]);

    const resolver = makeResolver(queries, new Set());
    let batchesSeen = 0;

    const result = await resolveAndPersistBatched(
      resolver,
      () => {
        batchesSeen++;
        if (batchesSeen === 1) {
          queries.insertUnresolvedRefsBatch([
            unresolvedRef('node:a', 'dup-ref'), // same fields as the just-deleted row, new id
            unresolvedRef('node:b', 'trailing-ref'), // distinct ref queued behind it
          ]);
        }
      },
      1
    );

    expect(result.stats.resolved).toBe(3);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
  });
});
