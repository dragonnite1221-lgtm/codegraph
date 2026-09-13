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
 * semantic change, e.g. `export` being dropped, that makes it unreachable
 * from other files. Re-checking `isExported` against the current result
 * catches that case; `isExported === undefined` means the extractor doesn't
 * track visibility for this node kind/language, so it doesn't block replay).
 */
function findPreservableIncomingEdges(
  queries: ExtractionStorageQueries,
  filePath: string,
  survivingNodes: Map<string, Node>
): Edge[] {
  const oldNodeIds = new Set(queries.getNodesByFile(filePath).map((node) => node.id));
  const validTargetIds = [...oldNodeIds].filter((id) => {
    const survivor = survivingNodes.get(id);
    return survivor !== undefined && survivor.isExported !== false;
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
