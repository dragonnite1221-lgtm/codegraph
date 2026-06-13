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
  type NodeRow,
  type UnresolvedRefRow,
  rowToEdge,
  rowToFileRecord,
  rowToNode,
  rowToUnresolvedReference,
} from './row-mappers';
import {
  runFindNodesByExactName,
  runFindNodesByNameSubstring,
  runSearchNodes,
} from './search-queries';
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
  runDeleteResolvedReferences,
  runDeleteSpecificResolvedReferences,
  runGetUnresolvedReferences,
  runGetUnresolvedReferencesByFiles,
  type ResolvedReferenceKey,
} from './unresolved-ref-queries';

export type { FileQueryOptions } from './file-queries';

/**
 * Query builder for the knowledge graph database
 */
export class QueryBuilder {
  private db: SqliteDatabase;

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;

  // Prepared statements (lazily initialized)
  private stmts: {
    insertNode?: SqliteStatement;
    updateNode?: SqliteStatement;
    deleteNode?: SqliteStatement;
    deleteNodesByFile?: SqliteStatement;
    getNodeById?: SqliteStatement;
    getNodesByFile?: SqliteStatement;
    getNodesByKind?: SqliteStatement;
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
    insertUnresolved?: SqliteStatement;
    deleteUnresolvedByNode?: SqliteStatement;
    getUnresolvedByName?: SqliteStatement;
    getNodesByName?: SqliteStatement;
    getNodesByQualifiedNameExact?: SqliteStatement;
    getNodesByLowerName?: SqliteStatement;
    getUnresolvedCount?: SqliteStatement;
    getUnresolvedBatch?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
    getAllNodeNames?: SqliteStatement;
  } = {};

  constructor(db: SqliteDatabase) {
    this.db = db;
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
  // Node Operations
  // ===========================================================================

  /**
   * Insert a new node
   */
  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters, @updatedAt
        )
      `);
    }

    // Validate required fields to prevent SQLite bind errors
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node with missing required fields:', {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        language: node.language,
      });
      return;
    }

    try {
      this.stmts.insertNode.run({
        id: node.id,
        kind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName ?? node.name,
        filePath: node.filePath,
        language: node.language,
        startLine: node.startLine ?? 0,
        endLine: node.endLine ?? 0,
        startColumn: node.startColumn ?? 0,
        endColumn: node.endColumn ?? 0,
        docstring: node.docstring ?? null,
        signature: node.signature ?? null,
        visibility: node.visibility ?? null,
        isExported: node.isExported ? 1 : 0,
        isAsync: node.isAsync ? 1 : 0,
        isStatic: node.isStatic ? 1 : 0,
        isAbstract: node.isAbstract ? 1 : 0,
        decorators: node.decorators ? JSON.stringify(node.decorators) : null,
        typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
        updatedAt: node.updatedAt ?? Date.now(),
      });
      this.nodeCache.delete(node.id);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Insert multiple nodes in a transaction
   */
  insertNodes(nodes: Node[]): void {
    this.db.transaction(() => {
      for (const node of nodes) {
        this.insertNode(node);
      }
    })();
  }

  /**
   * Update an existing node
   */
  updateNode(node: Node): void {
    if (!this.stmts.updateNode) {
      this.stmts.updateNode = this.db.prepare(`
        UPDATE nodes SET
          kind = @kind,
          name = @name,
          qualified_name = @qualifiedName,
          file_path = @filePath,
          language = @language,
          start_line = @startLine,
          end_line = @endLine,
          start_column = @startColumn,
          end_column = @endColumn,
          docstring = @docstring,
          signature = @signature,
          visibility = @visibility,
          is_exported = @isExported,
          is_async = @isAsync,
          is_static = @isStatic,
          is_abstract = @isAbstract,
          decorators = @decorators,
          type_parameters = @typeParameters,
          updated_at = @updatedAt
        WHERE id = @id
      `);
    }

    // Invalidate cache before update
    this.nodeCache.delete(node.id);

    // Validate required fields
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node update with missing required fields:', node.id);
      return;
    }

    this.stmts.updateNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): void {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    // Invalidate cache
    this.nodeCache.delete(id);
    this.stmts.deleteNode.run(id);
  }

  /**
   * Delete all nodes for a file
   */
  deleteNodesByFile(filePath: string): void {
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    // Invalidate cache for nodes in this file
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) {
        this.nodeCache.delete(id);
      }
    }
    this.stmts.deleteNodesByFile.run(filePath);
  }

  /**
   * Get a node by ID
   */
  getNodeById(id: string): Node | null {
    // Check cache first
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      // Move to end to implement LRU (delete and re-add)
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }

    if (!this.stmts.getNodeById) {
      this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    }
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) {
      return null;
    }

    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
  }

  /**
   * Add a node to the cache, evicting oldest if needed
   */
  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      // Evict oldest (first) entry
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) {
        this.nodeCache.delete(firstKey);
      }
    }
    this.nodeCache.set(node.id, node);
  }

  /**
   * Clear the node cache
   */
  clearCache(): void {
    this.nodeCache.clear();
  }

  /**
   * Get all nodes in a file
   */
  getNodesByFile(filePath: string): Node[] {
    if (!this.stmts.getNodesByFile) {
      this.stmts.getNodesByFile = this.db.prepare(
        'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
      );
    }
    const rows = this.stmts.getNodesByFile.all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: NodeKind): Node[] {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    const rows = this.stmts.getNodesByKind.all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes in the database
   */
  getAllNodes(): Node[] {
    const rows = this.withStatement('SELECT * FROM nodes', (stmt) => stmt.all() as NodeRow[]);
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact name match (uses idx_nodes_name index)
   */
  getNodesByName(name: string): Node[] {
    if (!this.stmts.getNodesByName) {
      this.stmts.getNodesByName = this.db.prepare('SELECT * FROM nodes WHERE name = ?');
    }
    const rows = this.stmts.getNodesByName.all(name) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
   */
  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    if (!this.stmts.getNodesByQualifiedNameExact) {
      this.stmts.getNodesByQualifiedNameExact = this.db.prepare(
        'SELECT * FROM nodes WHERE qualified_name = ?'
      );
    }
    const rows = this.stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by lowercase name match (uses idx_nodes_lower_name expression index)
   */
  getNodesByLowerName(lowerName: string): Node[] {
    if (!this.stmts.getNodesByLowerName) {
      this.stmts.getNodesByLowerName = this.db.prepare(
        'SELECT * FROM nodes WHERE lower(name) = ?'
      );
    }
    const rows = this.stmts.getNodesByLowerName.all(lowerName) as NodeRow[];
    return rows.map(rowToNode);
  }

  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    return runSearchNodes(
      {
        runStatement: (sql, fn) => this.withStatement(sql, fn),
        getAllNodeNames: () => this.getAllNodeNames(),
      },
      query,
      options
    );
  }

  /**
   * Find nodes by exact name match
   *
   * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
   * Returns high-confidence matches for known symbol names extracted from query.
   *
   * @param names - Array of symbol names to look up
   * @param options - Search options (kinds, languages, limit)
   * @returns SearchResult array with exact matches scored at 1.0
   */
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    return runFindNodesByExactName(
      {
        runStatement: (sql, fn) => this.withStatement(sql, fn),
        getAllNodeNames: () => this.getAllNodeNames(),
      },
      names,
      options
    );
  }

  /**
   * Find nodes whose name contains a substring (LIKE-based).
   * Useful for CamelCase-part matching where FTS fails because
   * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
   *
   * Results are ordered by name length (shorter = more likely to be the core type).
   */
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    return runFindNodesByNameSubstring(
      {
        runStatement: (sql, fn) => this.withStatement(sql, fn),
        getAllNodeNames: () => this.getAllNodeNames(),
      },
      substring,
      options
    );
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
    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
    }

    this.stmts.insertUnresolved.run({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
      candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
      filePath: ref.filePath ?? '',
      language: ref.language ?? 'unknown',
    });
  }

  /**
   * Insert multiple unresolved references in a transaction
   */
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    if (refs.length === 0) return;
    const insert = this.db.transaction(() => {
      for (const ref of refs) {
        this.insertUnresolvedRef(ref);
      }
    });
    insert();
  }

  /**
   * Delete unresolved references from a node
   */
  deleteUnresolvedByNode(nodeId: string): void {
    if (!this.stmts.deleteUnresolvedByNode) {
      this.stmts.deleteUnresolvedByNode = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ?'
      );
    }
    this.stmts.deleteUnresolvedByNode.run(nodeId);
  }

  /**
   * Get unresolved references by name (for resolution)
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedByName) {
      this.stmts.getUnresolvedByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
    return rows.map(rowToUnresolvedReference);
  }

  /**
   * Get all unresolved references
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    return runGetUnresolvedReferences((sql, fn) => this.withStatement(sql, fn));
  }

  /**
   * Get the count of unresolved references without loading them into memory
   */
  getUnresolvedReferencesCount(): number {
    if (!this.stmts.getUnresolvedCount) {
      this.stmts.getUnresolvedCount = this.db.prepare(
        'SELECT COUNT(*) as count FROM unresolved_refs'
      );
    }
    const row = this.stmts.getUnresolvedCount.get() as { count: number };
    return row.count;
  }

  /**
   * Get a batch of unresolved references using LIMIT/OFFSET pagination.
   * Used to process references in bounded memory chunks.
   */
  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedBatch) {
      this.stmts.getUnresolvedBatch = this.db.prepare(
        'SELECT * FROM unresolved_refs ORDER BY id LIMIT ? OFFSET ?'
      );
    }
    const rows = this.stmts.getUnresolvedBatch.all(limit, offset) as UnresolvedRefRow[];
    return rows.map(rowToUnresolvedReference);
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
    if (!this.stmts.getAllNodeNames) {
      this.stmts.getAllNodeNames = this.db.prepare('SELECT DISTINCT name FROM nodes');
    }
    const rows = this.stmts.getAllNodeNames.all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * Get unresolved references scoped to specific file paths.
   * Uses the idx_unresolved_file_path index for efficient lookup.
   */
  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    return runGetUnresolvedReferencesByFiles(
      (sql, fn) => this.withStatement(sql, fn),
      filePaths
    );
  }

  /**
   * Delete all unresolved references (after resolution)
   */
  clearUnresolvedReferences(): void {
    this.db.exec('DELETE FROM unresolved_refs');
  }

  /**
   * Delete resolved references by their IDs
   */
  deleteResolvedReferences(fromNodeIds: string[]): void {
    runDeleteResolvedReferences((sql, fn) => this.withStatement(sql, fn), fromNodeIds);
  }

  /**
   * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
   * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
   */
  deleteSpecificResolvedReferences(refs: ResolvedReferenceKey[]): void {
    runDeleteSpecificResolvedReferences(this.db, refs);
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

  /**
   * Get a metadata value by key
   */
  getMetadata(key: string): string | null {
    return runGetMetadata({ runStatement: (sql, fn) => this.withStatement(sql, fn) }, key);
  }

  /**
   * Set a metadata key-value pair (upsert)
   */
  setMetadata(key: string, value: string): void {
    runSetMetadata({ runStatement: (sql, fn) => this.withStatement(sql, fn) }, key, value);
  }

  /**
   * Get all metadata as a key-value record
   */
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
