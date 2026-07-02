import type * as fs from 'fs';

import type { ExtractionResult, FileRecord, Language } from '../types';
import { hashContent } from './file-scanner';

interface ExtractionStorageQueries {
  getFileByPath(filePath: string): FileRecord | null;
  deleteFile(filePath: string): void;
  insertNodes(nodes: ExtractionResult['nodes']): void;
  insertEdges(edges: ExtractionResult['edges']): void;
  insertUnresolvedRefsBatch(refs: ExtractionResult['unresolvedReferences']): void;
  upsertFile(file: FileRecord): void;
  /** Run the delete + inserts + upsert as a single committed transaction. */
  transaction<T>(fn: () => T): T;
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
