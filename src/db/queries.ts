/**
 * Database Queries
 *
 * QueryBuilder is the facade over the per-entity query classes (nodes, edges,
 * files, unresolved refs) + summary/metadata helpers. The node/edge/file query
 * logic lives in node-queries.ts / edge-write-queries.ts / file-write-queries.ts
 * to stay within the file-size gate; this class wires them and delegates.
 */

import { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import {
  Node,
  Edge,
  FileRecord,
  UnresolvedReference,
  NodeKind,
  EdgeKind,
  GraphStats,
  SearchOptions,
  SearchResult,
} from '../types';
import {
  runGetAllMetadata,
  runGetMetadata,
  runGetStats,
  runSetMetadata,
} from './summary-queries';
import { type FileQueryOptions } from './file-queries';
import {
  type ResolvedReferenceKey,
  UnresolvedReferenceQueries,
} from './unresolved-ref-queries';
import { NodeCache } from './node-cache';
import { NodeQueries } from './node-queries';
import { EdgeQueries } from './edge-write-queries';
import { FileQueries } from './file-write-queries';

export type { FileQueryOptions } from './file-queries';

/** Query builder for the knowledge graph database */
export class QueryBuilder {
  private db: SqliteDatabase;
  private unresolvedRefs: UnresolvedReferenceQueries;
  private nodeQueries: NodeQueries;
  private edgeQueries: EdgeQueries;
  private fileQueries: FileQueries;
  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache = new NodeCache();

  constructor(db: SqliteDatabase) {
    this.db = db;
    const runner = <T>(sql: string, fn: (stmt: SqliteStatement) => T): T => this.withStatement(sql, fn);
    this.unresolvedRefs = new UnresolvedReferenceQueries(db, runner);
    this.nodeQueries = new NodeQueries(db, runner, this.nodeCache);
    this.edgeQueries = new EdgeQueries(db, runner);
    this.fileQueries = new FileQueries(db, runner, (fp) => this.deleteNodesByFile(fp));
  }

  private withStatement<T>(sql: string, fn: (stmt: SqliteStatement) => T): T {
    const stmt = this.db.prepare(sql);
    try {
      return fn(stmt);
    } finally {
      stmt.finalize?.();
    }
  }

  // === Node Operations (delegated to NodeQueries) ===
  insertNode(node: Node): void { this.nodeQueries.insertNode(node); }
  insertNodes(nodes: Node[]): void { this.nodeQueries.insertNodes(nodes); }
  updateNode(node: Node): void { this.nodeQueries.updateNode(node); }
  deleteNode(id: string): void { this.nodeQueries.deleteNode(id); }
  deleteNodesByFile(filePath: string): void { this.nodeQueries.deleteNodesByFile(filePath); }
  getNodeById(id: string): Node | null { return this.nodeQueries.getNodeById(id); }
  clearCache(): void { this.nodeQueries.clearCache(); }
  getNodesByFile(filePath: string): Node[] { return this.nodeQueries.getNodesByFile(filePath); }
  getNodesByKind(kind: NodeKind): Node[] { return this.nodeQueries.getNodesByKind(kind); }
  getAllNodes(): Node[] { return this.nodeQueries.getAllNodes(); }
  getNodesByName(name: string): Node[] { return this.nodeQueries.getNodesByName(name); }
  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    return this.nodeQueries.getNodesByQualifiedNameExact(qualifiedName);
  }
  getNodesByLowerName(lowerName: string): Node[] { return this.nodeQueries.getNodesByLowerName(lowerName); }
  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    return this.nodeQueries.searchNodes(query, options);
  }
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    return this.nodeQueries.findNodesByExactName(names, options);
  }
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    return this.nodeQueries.findNodesByNameSubstring(substring, options);
  }
  getAllNodeNames(): string[] { return this.nodeQueries.getAllNodeNames(); }

  // === Edge Operations (delegated to EdgeQueries) ===
  insertEdge(edge: Edge): void { this.edgeQueries.insertEdge(edge); }
  insertEdges(edges: Edge[]): void { this.edgeQueries.insertEdges(edges); }
  deleteEdgesBySource(sourceId: string): void { this.edgeQueries.deleteEdgesBySource(sourceId); }
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    return this.edgeQueries.getOutgoingEdges(sourceId, kinds, provenance);
  }
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    return this.edgeQueries.getIncomingEdges(targetId, kinds);
  }
  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    return this.edgeQueries.findEdgesBetweenNodes(nodeIds, kinds);
  }

  // === File Operations (delegated to FileQueries) ===
  upsertFile(file: FileRecord): void { this.fileQueries.upsertFile(file); }
  deleteFile(filePath: string): void { this.fileQueries.deleteFile(filePath); }
  getFileByPath(filePath: string): FileRecord | null { return this.fileQueries.getFileByPath(filePath); }
  getAllFiles(options: FileQueryOptions = {}): FileRecord[] { return this.fileQueries.getAllFiles(options); }
  countFiles(options: Pick<FileQueryOptions, 'pathPrefix'> = {}): number {
    return this.fileQueries.countFiles(options);
  }
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    return this.fileQueries.getStaleFiles(currentHashes);
  }
  getAllFilePaths(): string[] { return this.fileQueries.getAllFilePaths(); }

  // === Unresolved References (delegated to UnresolvedReferenceQueries) ===
  insertUnresolvedRef(ref: UnresolvedReference): void { this.unresolvedRefs.insert(ref); }
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void { this.unresolvedRefs.insertBatch(refs); }
  deleteUnresolvedByNode(nodeId: string): void { this.unresolvedRefs.deleteByNode(nodeId); }
  getUnresolvedByName(name: string): UnresolvedReference[] { return this.unresolvedRefs.getByName(name); }
  getUnresolvedReferences(): UnresolvedReference[] { return this.unresolvedRefs.getAll(); }
  getUnresolvedReferencesCount(): number { return this.unresolvedRefs.count(); }
  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    return this.unresolvedRefs.getBatch(offset, limit);
  }
  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    return this.unresolvedRefs.getByFiles(filePaths);
  }
  clearUnresolvedReferences(): void { this.unresolvedRefs.clear(); }
  deleteResolvedReferences(fromNodeIds: string[]): void { this.unresolvedRefs.deleteResolved(fromNodeIds); }
  deleteSpecificResolvedReferences(refs: ResolvedReferenceKey[]): void {
    this.unresolvedRefs.deleteSpecificResolved(refs);
  }

  // === Statistics + Project Metadata ===
  getStats(): GraphStats {
    return runGetStats({ runStatement: (sql, fn) => this.withStatement(sql, fn) });
  }
  getMetadata(key: string): string | null {
    return runGetMetadata({ runStatement: (sql, fn) => this.withStatement(sql, fn) }, key);
  }
  setMetadata(key: string, value: string): void {
    runSetMetadata({ runStatement: (sql, fn) => this.withStatement(sql, fn) }, key, value);
  }
  getAllMetadata(): Record<string, string> {
    return runGetAllMetadata({ runStatement: (sql, fn) => this.withStatement(sql, fn) });
  }

  /** Clear all data from the database */
  clear(): void {
    this.nodeCache.clear();
    this.db.transaction(() => {
      this.db.exec('DELETE FROM unresolved_refs');
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM files');
    })();
  }
}
