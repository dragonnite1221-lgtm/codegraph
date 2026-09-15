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
 *
 * Exercises real SQLite (per this repo's testing convention -- no DB
 * mocking) via DatabaseConnection + QueryBuilder against a temp db file.
 * See resolution-resolve-batched-concurrency.test.ts for the follow-up
 * regressions around the loop's infinite-loop guard itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { resolveAndPersistBatched } from '../src/resolution/resolution-resolve';
import { makeResolver, nodeRecord, unresolvedRef } from './helpers/resolution-resolve-test-utils';

describe('resolveAndPersistBatched loop control', () => {
  let dir: string;
  let conn: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-batched-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(conn.getDb());
  });

  afterEach(() => {
    conn.close();
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
});
