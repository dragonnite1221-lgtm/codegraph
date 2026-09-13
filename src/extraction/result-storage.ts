import type * as fs from 'fs';

import type { Edge, ExtractionResult, FileRecord, Language, Node } from '../types';
import { hashContent } from './file-scanner';

interface ExtractionStorageQueries {
  getFileByPath(filePath: string): FileRecord | null;
  getNodesByFile(filePath: string): Node[];
  getIncomingEdgesForTargets(targetIds: string[]): Edge[];
  deleteFile(filePath: string): void;
  insertNodes(nodes: ExtractionResult['nodes']): void;
  insertEdges(edges: ExtractionResult['edges']): void;
  insertUnresolvedRefsBatch(refs: ExtractionResult['unresolvedReferences']): void;
  upsertFile(file: FileRecord): void;
  /** Run the delete + inserts + upsert as a single committed transaction. */
  transaction<T>(fn: () => T): T;
}

/**
 * Whether a surviving node is still a plausible target for a cross-file
 * edge, given what the fresh extraction says about it now:
 *
 * - `file` nodes have no "exported" concept at all -- extractors always
 *   stamp them `isExported: false` (see tree-sitter-extract.ts) even though
 *   they're the standard target of `imports` edges. Always preservable.
 * - `isExported` is populated by a per-language extractor hook that only a
 *   subset of languages (JS/TS and friends) implement; `false` there is a
 *   real, deliberate "no longer exported" signal.
 * - Languages that track access via `visibility` instead (Java, C#, Rust,
 *   Kotlin, Swift, ...) never set `isExported`, so `false` alone would miss
 *   a public-to-private change there. Explicit `visibility === 'private'`
 *   is the other disqualifying signal.
 * - Anything else (`isExported` true/undefined, `visibility` public/
 *   protected/internal/undefined) is treated as still reachable -- this is
 *   a filter for the common, clear-cut disqualifying cases, not a full
 *   language-aware access-control model.
 *
 * ponytail: this is node-local, not ancestor-aware. A method never gets its
 * own `isExported` (only extractFunction sets it; extractMethod doesn't --
 * see extractors-callable.ts), so `export class Foo { m() {} }` losing its
 * `export` doesn't disqualify calls into `Foo.m` even though `Foo` itself
 * now correctly reports isExported: false. Likewise Java/Kotlin/etc.
 * package-private (no modifier) is indistinguishable from "visibility not
 * tracked" here, since both are `undefined`. Closing this needs the same
 * containment-chain + language-aware access-control modeling the resolution
 * engine itself doesn't have either (its own isExported use, in
 * name-match-helpers.ts, is a scoring bonus, not a hard reachability
 * check) -- out of scope for this fix. The failure direction here is
 * "preserves an edge that's no longer valid" (stale-but-harmless), not
 * "drops a valid one" (the bug this file exists to fix), so it's a
 * narrower miss than the pre-fix behavior of replaying unconditionally.
 */
function isStillReferenceable(node: Node): boolean {
  if (node.kind === 'file') return true;
  if (node.isExported === false) return false;
  if (node.visibility === 'private') return false;
  return true;
}

/**
 * `deleteFile` cascades to every edge touching this file's old nodes,
 * including edges from OTHER files that call/reference into it (edges.target
 * has ON DELETE CASCADE too). Re-extracting this file only recreates edges
 * whose both ends are in the fresh result, so a caller in an untouched file
 * loses its edge into this one on every reindex of the callee.
 *
 * Capture those incoming cross-file edges before the delete, and replay the
 * ones whose target symbol still exists under the same id after reindex AND
 * is still a valid reference target in the fresh extraction (id is a hash of
 * file+kind+name+declaration line, so a body-only edit keeps it; an actual
 * rename/removal changes or drops it — but the id can also survive a
 * semantic change, e.g. `export`/`public` being dropped, that makes it
 * unreachable from other files; see isStillReferenceable()).
 */
function findPreservableIncomingEdges(
  queries: ExtractionStorageQueries,
  filePath: string,
  survivingNodes: Map<string, Node>
): Edge[] {
  const oldNodeIds = new Set(queries.getNodesByFile(filePath).map((node) => node.id));
  const validTargetIds = [...oldNodeIds].filter((id) => {
    const survivor = survivingNodes.get(id);
    return survivor !== undefined && isStillReferenceable(survivor);
  });

  const preserved: Edge[] = [];
  const seen = new Set<string>();

  for (const edge of queries.getIncomingEdgesForTargets(validTargetIds)) {
    if (oldNodeIds.has(edge.source)) continue; // same-file edge — the fresh extraction recreates it
    const key = [
      edge.source,
      edge.target,
      edge.kind,
      edge.line ?? '',
      edge.column ?? '',
      edge.provenance ?? '',
      JSON.stringify(edge.metadata ?? null),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    preserved.push(edge);
  }

  return preserved;
}

/**
 * Store a parsed file result in the graph database.
 */
export function storeExtractionResult(
  queries: ExtractionStorageQueries,
  filePath: string,
  content: string,
  language: Language,
  stats: fs.Stats,
  result: ExtractionResult
): void {
  const contentHash = hashContent(content);

  const existingFile = queries.getFileByPath(filePath);
  if (existingFile && existingFile.contentHash === contentHash) {
    return;
  }

  const validNodes = result.nodes.filter(
    (node) => node.id && node.kind && node.name && node.filePath && node.language
  );
  const insertedIds = new Set(validNodes.map((node) => node.id));
  const validNodesById = new Map(validNodes.map((node) => [node.id, node]));

  const validEdges =
    result.edges.length > 0
      ? result.edges.filter(
          (edge) => insertedIds.has(edge.source) && insertedIds.has(edge.target)
        )
      : [];

  const refsWithContext =
    result.unresolvedReferences.length > 0
      ? result.unresolvedReferences
          .filter((ref) => insertedIds.has(ref.fromNodeId))
          .map((ref) => ({
            ...ref,
            filePath: ref.filePath ?? filePath,
            language: ref.language ?? language,
          }))
      : [];

  const preservedEdges = existingFile
    ? findPreservableIncomingEdges(queries, filePath, validNodesById)
    : [];

  // Batch delete + inserts + upsert into a single transaction (one commit per
  // file instead of 3-4), which the WASM fallback fsyncs on each commit.
  queries.transaction(() => {
    if (existingFile) {
      queries.deleteFile(filePath);
    }
    if (validNodes.length > 0) {
      queries.insertNodes(validNodes);
    }
    if (validEdges.length > 0) {
      queries.insertEdges(validEdges);
    }
    if (preservedEdges.length > 0) {
      queries.insertEdges(preservedEdges);
    }
    if (refsWithContext.length > 0) {
      queries.insertUnresolvedRefsBatch(refsWithContext);
    }
    queries.upsertFile({
      path: filePath,
      contentHash,
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  });
}
