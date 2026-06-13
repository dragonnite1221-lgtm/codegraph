/**
 * Node Queries
 *
 * Prepared statements and lookups for node CRUD on the knowledge graph.
 * Mirrors the delegation pattern used by UnresolvedReferenceQueries so the
 * QueryBuilder stays thin while node-specific statements live in one place.
 */

import type {
  Node,
  NodeKind,
  SearchOptions,
  SearchResult,
} from '../types';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import { type NodeRow, rowToNode } from './row-mappers';
import {
  describeNodeRequiredFields,
  isNodePersistable,
  nodeToStatementParams,
} from './node-params';
import { NodeCache } from './node-cache';
import {
  runFindNodesByExactName,
  runFindNodesByNameSubstring,
  runSearchNodes,
} from './search-queries';

type StatementRunner = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;

const INSERT_NODE_SQL = `
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
`;

const UPDATE_NODE_SQL = `
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
`;

export class NodeQueries {
  private stmts: {
    insertNode?: SqliteStatement;
    updateNode?: SqliteStatement;
    deleteNode?: SqliteStatement;
    deleteNodesByFile?: SqliteStatement;
    getNodeById?: SqliteStatement;
    getNodesByFile?: SqliteStatement;
    getNodesByKind?: SqliteStatement;
    getNodesByName?: SqliteStatement;
    getNodesByQualifiedNameExact?: SqliteStatement;
    getNodesByLowerName?: SqliteStatement;
    getAllNodeNames?: SqliteStatement;
  } = {};

  constructor(
    private readonly db: SqliteDatabase,
    private readonly runStatement: StatementRunner,
    private readonly cache: NodeCache
  ) {}

  /**
   * Insert a new node
   */
  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(INSERT_NODE_SQL);
    }

    // Validate required fields to prevent SQLite bind errors
    if (!isNodePersistable(node)) {
      console.error('[CodeGraph] Skipping node with missing required fields:', describeNodeRequiredFields(node));
      return;
    }

    this.stmts.insertNode.run(nodeToStatementParams(node));
    this.cache.delete(node.id);
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
      this.stmts.updateNode = this.db.prepare(UPDATE_NODE_SQL);
    }

    // Invalidate cache before update
    this.cache.delete(node.id);

    // Validate required fields
    if (!isNodePersistable(node)) {
      console.error('[CodeGraph] Skipping node update with missing required fields:', node.id);
      return;
    }

    this.stmts.updateNode.run(nodeToStatementParams(node));
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): void {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    this.cache.delete(id);
    this.stmts.deleteNode.run(id);
  }

  /**
   * Delete all nodes for a file
   */
  deleteNodesByFile(filePath: string): void {
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    this.cache.deleteByFile(filePath);
    this.stmts.deleteNodesByFile.run(filePath);
  }

  /**
   * Get a node by ID
   */
  getNodeById(id: string): Node | null {
    const cached = this.cache.get(id);
    if (cached) {
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
    this.cache.set(node);
    return node;
  }

  /**
   * Clear the node cache
   */
  clearCache(): void {
    this.cache.clear();
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
    const rows = this.runStatement('SELECT * FROM nodes', (stmt) => stmt.all() as NodeRow[]);
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

  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    return runSearchNodes(
      {
        runStatement: this.runStatement,
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
   */
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    return runFindNodesByExactName(
      {
        runStatement: this.runStatement,
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
   */
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    return runFindNodesByNameSubstring(
      {
        runStatement: this.runStatement,
        getAllNodeNames: () => this.getAllNodeNames(),
      },
      substring,
      options
    );
  }
}
