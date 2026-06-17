/**
 * Node Queries
 *
 * Prepared statements and lookups for node CRUD on the knowledge graph.
 * Mirrors the delegation pattern used by UnresolvedReferenceQueries so the
 * QueryBuilder stays thin while node-specific statements live in one place.
 * Read getters live in node-read-queries.ts and insert/update SQL in
 * node-queries-sql.ts to stay within the file-size gate.
 */

import type {
  Node,
  NodeKind,
  SearchOptions,
  SearchResult,
} from '../types';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
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
import { INSERT_NODE_SQL, UPDATE_NODE_SQL } from './node-queries-sql';
import {
  type NodeStmts,
  getAllNodeNames,
  getAllNodes,
  getNodeById,
  getNodesByFile,
  getNodesByKind,
  getNodesByLowerName,
  getNodesByName,
  getNodesByQualifiedNameExact,
} from './node-read-queries';

type StatementRunner = <T>(sql: string, fn: (stmt: SqliteStatement) => T) => T;

export class NodeQueries {
  private stmts: NodeStmts = {};

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

  /** Clear the node cache */
  clearCache(): void {
    this.cache.clear();
  }

  getNodeById(id: string): Node | null {
    return getNodeById(this.db, this.stmts, this.cache, id);
  }

  getNodesByFile(filePath: string): Node[] {
    return getNodesByFile(this.db, this.stmts, filePath);
  }

  getNodesByKind(kind: NodeKind): Node[] {
    return getNodesByKind(this.db, this.stmts, kind);
  }

  getAllNodes(): Node[] {
    return getAllNodes(this.runStatement);
  }

  getNodesByName(name: string): Node[] {
    return getNodesByName(this.db, this.stmts, name);
  }

  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    return getNodesByQualifiedNameExact(this.db, this.stmts, qualifiedName);
  }

  getNodesByLowerName(lowerName: string): Node[] {
    return getNodesByLowerName(this.db, this.stmts, lowerName);
  }

  getAllNodeNames(): string[] {
    return getAllNodeNames(this.db, this.stmts);
  }

  /** Shared dependencies for the search-queries helpers. */
  private searchDeps() {
    return {
      runStatement: this.runStatement,
      getAllNodeNames: () => this.getAllNodeNames(),
    };
  }

  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    return runSearchNodes(this.searchDeps(), query, options);
  }

  /**
   * Find nodes by exact name match (hybrid search): exact or case-insensitive
   * lookup, returning high-confidence matches for known symbol names.
   */
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    return runFindNodesByExactName(this.searchDeps(), names, options);
  }

  /**
   * Find nodes whose name contains a substring (LIKE-based). Useful for
   * CamelCase-part matching where FTS fails ("TransportSearchAction" is one
   * FTS token, not matchable by "Search"*).
   */
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    return runFindNodesByNameSubstring(this.searchDeps(), substring, options);
  }
}
