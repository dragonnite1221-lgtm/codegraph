/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the knowledge graph.
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
  type EdgeRow,
  type FileRow,
  rowToEdge,
  rowToFileRecord,
} from './row-mappers';
import {
  runGetAllMetadata,
  runGetMetadata,
  runGetStats,
  runSetMetadata,
} from './summary-queries';
import {
  hasFileQueryFilters,
  runCountFiles,
  runGetFilteredFiles,
  type FileQueryOptions,
} from './file-queries';
import {
  hasOutgoingEdgeFilters,
  runFindEdgesBetweenNodes,
  runGetFilteredOutgoingEdges,
  runGetIncomingEdgesByKinds,
} from './edge-queries';
import {
  type ResolvedReferenceKey,
  UnresolvedReferenceQueries,
} from './unresolved-ref-queries';
import { NodeCache } from './node-cache';
import { NodeQueries } from './node-queries';

export type { FileQueryOptions } from './file-queries';

/**
 * Query builder for the knowledge graph database
 */
export class QueryBuilder {
  private db: SqliteDatabase;
  private unresolvedRefs: UnresolvedReferenceQueries;
  private nodeQueries: NodeQueries;

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache = new NodeCache();

  // Prepared statements (lazily initialized)
  private stmts: {
    insertEdge?: SqliteStatement;
    upsertFile?: SqliteStatement;
    deleteEdgesBySource?: SqliteStatement;
    deleteEdgesByTarget?: SqliteStatement;
    getEdgesBySource?: SqliteStatement;
    getEdgesByTarget?: SqliteStatement;
    insertFile?: SqliteStatement;
    updateFile?: SqliteStatement;
    deleteFile?: SqliteStatement;
    getFileByPath?: SqliteStatement;
    getAllFiles?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
  } = {};

  constructor(db: SqliteDatabase) {
    this.db = db;
    this.unresolvedRefs = new UnresolvedReferenceQueries(db, (sql, fn) =>
      this.withStatement(sql, fn)
    );
    this.nodeQueries = new NodeQueries(
      db,
      (sql, fn) => this.withStatement(sql, fn),
      this.nodeCache
    );
  }

  private withStatement<T>(sql: string, fn: (stmt: SqliteStatement) => T): T {
    const stmt = this.db.prepare(sql);
    try {
      return fn(stmt);
    } finally {
      stmt.finalize?.();
    }
  }

  // ===========================================================================
  // Node Operations (delegated to NodeQueries)
  // ===========================================================================

  insertNode(node: Node): void {
    this.nodeQueries.insertNode(node);
  }

  insertNodes(nodes: Node[]): void {
    this.nodeQueries.insertNodes(nodes);
  }

  updateNode(node: Node): void {
    this.nodeQueries.updateNode(node);
  }

  deleteNode(id: string): void {
    this.nodeQueries.deleteNode(id);
  }

  deleteNodesByFile(filePath: string): void {
    this.nodeQueries.deleteNodesByFile(filePath);
  }

  getNodeById(id: string): Node | null {
    return this.nodeQueries.getNodeById(id);
  }

  clearCache(): void {
    this.nodeQueries.clearCache();
  }

  getNodesByFile(filePath: string): Node[] {
    return this.nodeQueries.getNodesByFile(filePath);
  }

  getNodesByKind(kind: NodeKind): Node[] {
    return this.nodeQueries.getNodesByKind(kind);
  }

  getAllNodes(): Node[] {
    return this.nodeQueries.getAllNodes();
  }

  getNodesByName(name: string): Node[] {
    return this.nodeQueries.getNodesByName(name);
  }

  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    return this.nodeQueries.getNodesByQualifiedNameExact(qualifiedName);
  }

  getNodesByLowerName(lowerName: string): Node[] {
    return this.nodeQueries.getNodesByLowerName(lowerName);
  }

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

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Insert a new edge
   */
  insertEdge(edge: Edge): void {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
      `);
    }

    this.stmts.insertEdge.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      line: edge.line ?? null,
      col: edge.column ?? null,
      provenance: edge.provenance ?? null,
    });
  }

  /**
   * Insert multiple edges in a transaction
   */
  insertEdges(edges: Edge[]): void {
    this.db.transaction(() => {
      for (const edge of edges) {
        this.insertEdge(edge);
      }
    })();
  }

  /**
   * Delete all edges from a source node
   */
  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    if (hasOutgoingEdgeFilters(kinds, provenance)) {
      return runGetFilteredOutgoingEdges(
        (sql, fn) => this.withStatement(sql, fn),
        sourceId,
        kinds,
        provenance
      );
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      return runGetIncomingEdgesByKinds(
        (sql, fn) => this.withStatement(sql, fn),
        targetId,
        kinds
      );
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Find all edges where both source and target are in the given node set.
   * Useful for recovering inter-node connectivity after BFS.
   */
  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    return runFindEdgesBetweenNodes((sql, fn) => this.withStatement(sql, fn), nodeIds, kinds);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Insert or update a file record
   */
  upsertFile(file: FileRecord): void {
    if (!this.stmts.upsertFile) {
      this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors
      `);
    }

    this.stmts.upsertFile.run({
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : null,
    });
  }

  /**
   * Delete a file record and its nodes
   */
  deleteFile(filePath: string): void {
    this.db.transaction(() => {
      this.deleteNodesByFile(filePath);
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      this.stmts.deleteFile.run(filePath);
    })();
  }

  /**
   * Get a file record by path
   */
  getFileByPath(filePath: string): FileRecord | null {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  /**
   * Get all tracked files
   */
  getAllFiles(options: FileQueryOptions = {}): FileRecord[] {
    if (!hasFileQueryFilters(options)) {
      if (!this.stmts.getAllFiles) {
        this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
      }
      const rows = this.stmts.getAllFiles.all() as FileRow[];
      return rows.map(rowToFileRecord);
    }

    return runGetFilteredFiles((sql, fn) => this.withStatement(sql, fn), options);
  }

  countFiles(options: Pick<FileQueryOptions, 'pathPrefix'> = {}): number {
    return runCountFiles((sql, fn) => this.withStatement(sql, fn), options);
  }

  /**
   * Get files that need re-indexing (hash changed)
   */
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter((f) => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  // ===========================================================================
  // Unresolved References
  // ===========================================================================

  /**
   * Insert an unresolved reference
   */
  insertUnresolvedRef(ref: UnresolvedReference): void {
    this.unresolvedRefs.insert(ref);
  }

  /**
   * Insert multiple unresolved references in a transaction
   */
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    this.unresolvedRefs.insertBatch(refs);
  }

  /**
   * Delete unresolved references from a node
   */
  deleteUnresolvedByNode(nodeId: string): void {
    this.unresolvedRefs.deleteByNode(nodeId);
  }

  /**
   * Get unresolved references by name (for resolution)
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    return this.unresolvedRefs.getByName(name);
  }

  /**
   * Get all unresolved references
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    return this.unresolvedRefs.getAll();
  }

  /**
   * Get the count of unresolved references without loading them into memory
   */
  getUnresolvedReferencesCount(): number {
    return this.unresolvedRefs.count();
  }

  /**
   * Get a batch of unresolved references using LIMIT/OFFSET pagination.
   * Used to process references in bounded memory chunks.
   */
  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    return this.unresolvedRefs.getBatch(offset, limit);
  }

  /**
   * Get all tracked file paths (lightweight — no full FileRecord objects)
   */
  getAllFilePaths(): string[] {
    if (!this.stmts.getAllFilePaths) {
      this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * Get all distinct node names (lightweight — just name strings for pre-filtering)
   */
  getAllNodeNames(): string[] {
    return this.nodeQueries.getAllNodeNames();
  }

  /**
   * Get unresolved references scoped to specific file paths.
   * Uses the idx_unresolved_file_path index for efficient lookup.
   */
  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    return this.unresolvedRefs.getByFiles(filePaths);
  }

  /**
   * Delete all unresolved references (after resolution)
   */
  clearUnresolvedReferences(): void {
    this.unresolvedRefs.clear();
  }

  /**
   * Delete resolved references by their IDs
   */
  deleteResolvedReferences(fromNodeIds: string[]): void {
    this.unresolvedRefs.deleteResolved(fromNodeIds);
  }

  /**
   * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
   * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
   */
  deleteSpecificResolvedReferences(refs: ResolvedReferenceKey[]): void {
    this.unresolvedRefs.deleteSpecificResolved(refs);
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    return runGetStats({ runStatement: (sql, fn) => this.withStatement(sql, fn) });
  }

  // ===========================================================================
  // Project Metadata
  // ===========================================================================

  // Get a metadata value by key
  getMetadata(key: string): string | null {
    return runGetMetadata({ runStatement: (sql, fn) => this.withStatement(sql, fn) }, key);
  }

  // Set a metadata key-value pair (upsert)
  setMetadata(key: string, value: string): void {
    runSetMetadata({ runStatement: (sql, fn) => this.withStatement(sql, fn) }, key, value);
  }

  // Get all metadata as a key-value record
  getAllMetadata(): Record<string, string> {
    return runGetAllMetadata({ runStatement: (sql, fn) => this.withStatement(sql, fn) });
  }

  /**
   * Clear all data from the database
   */
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
