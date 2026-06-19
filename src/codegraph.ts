/**
 * Main CodeGraph class — the primary interface to the code knowledge graph.
 *
 * Most methods are thin delegations to the subsystems (orchestrator, resolver,
 * graph manager/traverser, query builder, context builder). Project lifecycle
 * (init/open) lives in codegraph-lifecycle.ts and the indexing drivers in
 * indexing-operations.ts, to stay within the file-size gate.
 */

import * as path from 'path';
import {
  CodeGraphConfig, Node, Edge, FileRecord, ExtractionResult, Subgraph,
  TraversalOptions, SearchOptions, SearchResult, Context, GraphStats,
  TaskInput, TaskContext, BuildContextOptions, FindRelevantContextOptions,
} from './types';
import { DatabaseConnection } from './db';
import { QueryBuilder, type FileQueryOptions } from './db/queries';
import { saveConfig } from './config';
import { isInitialized, removeDirectory } from './directory';
import {
  ExtractionOrchestrator, IndexResult, SyncResult, extractFromSource,
} from './extraction';
import { ReferenceResolver, createResolver, ResolutionResult } from './resolution';
import { GraphTraverser, GraphQueryManager } from './graph';
import { ContextBuilder, createContextBuilder } from './context';
import { Mutex, FileLock } from './utils';
import { FileWatcher, WatchOptions } from './sync';
import { runIndexAll, runIndexFiles, runSync } from './indexing-operations';
import type { InitOptions, OpenOptions, IndexOptions } from './codegraph-types';
import {
  initCodeGraph, initCodeGraphSync, openCodeGraph, openCodeGraphSync,
} from './codegraph-lifecycle';

export class CodeGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private config: CodeGraphConfig;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;
  private indexMutex = new Mutex();
  private fileLock: FileLock;
  private watcher: FileWatcher | null = null;

  constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    config: CodeGraphConfig,
    projectRoot: string
  ) {
    this.db = db;
    this.queries = queries;
    this.config = config;
    this.projectRoot = projectRoot;
    this.fileLock = new FileLock(path.join(projectRoot, '.codegraph', 'codegraph.lock'));
    this.orchestrator = new ExtractionOrchestrator(projectRoot, config, queries);
    this.resolver = createResolver(projectRoot, queries);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = createContextBuilder(projectRoot, queries, this.traverser);
  }
  static init(projectRoot: string, options: InitOptions = {}): Promise<CodeGraph> {
    return initCodeGraph(CodeGraph, projectRoot, options);
  }
  static initSync(projectRoot: string, options: Omit<InitOptions, 'index' | 'onProgress'> = {}): CodeGraph {
    return initCodeGraphSync(CodeGraph, projectRoot, options);
  }
  static open(projectRoot: string, options: OpenOptions = {}): Promise<CodeGraph> {
    return openCodeGraph(CodeGraph, projectRoot, options);
  }
  static openSync(projectRoot: string): CodeGraph {
    return openCodeGraphSync(CodeGraph, projectRoot);
  }
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  close(): void {
    this.unwatch();
    this.fileLock.release();
    this.db.close();
  }

  private indexingDeps() {
    return {
      indexMutex: this.indexMutex,
      fileLock: this.fileLock,
      orchestrator: this.orchestrator,
      queries: this.queries,
      resolver: this.resolver,
    };
  }
  getConfig(): CodeGraphConfig { return { ...this.config }; }
  updateConfig(updates: Partial<CodeGraphConfig>): void {
    Object.assign(this.config, updates);
    saveConfig(this.projectRoot, this.config);
    this.orchestrator = new ExtractionOrchestrator(this.projectRoot, this.config, this.queries);
    this.resolver = createResolver(this.projectRoot, this.queries);
  }
  getProjectRoot(): string { return this.projectRoot; }
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> { return runIndexAll(this.indexingDeps(), options); }
  async indexFiles(filePaths: string[]): Promise<IndexResult> { return runIndexFiles(this.indexingDeps(), filePaths); }
  async sync(options: IndexOptions = {}): Promise<SyncResult> { return runSync(this.indexingDeps(), options); }
  isIndexing(): boolean { return this.indexMutex.isLocked(); }
  watch(options: WatchOptions = {}): boolean {
    if (this.watcher?.isActive()) return true;
    this.watcher = new FileWatcher(
      this.projectRoot,
      this.config,
      async () => {
        const result = await this.sync();
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options
    );
    return this.watcher.start();
  }
  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }
  isWatching(): boolean { return this.watcher?.isActive() ?? false; }
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }
  extractFromSource(filePath: string, source: string): ExtractionResult { return extractFromSource(filePath, source); }
  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    return this.resolver.resolveAndPersist(this.queries.getUnresolvedReferences(), onProgress);
  }
  async resolveReferencesBatched(onProgress?: (current: number, total: number) => void): Promise<ResolutionResult> {
    return this.resolver.resolveAndPersistBatched(onProgress);
  }
  getDetectedFrameworks(): string[] { return this.resolver.getDetectedFrameworks(); }
  reinitializeResolver(): void { this.resolver.initialize(); }
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }
  getBackend(): import('./db').SqliteBackend { return this.db.getBackend(); }
  getNode(id: string): Node | null { return this.queries.getNodeById(id); }
  getNodesInFile(filePath: string): Node[] { return this.queries.getNodesByFile(filePath); }
  getNodesByKind(kind: Node['kind']): Node[] { return this.queries.getNodesByKind(kind); }
  searchNodes(query: string, options?: SearchOptions): SearchResult[] { return this.queries.searchNodes(query, options); }
  getOutgoingEdges(nodeId: string): Edge[] { return this.queries.getOutgoingEdges(nodeId); }
  getIncomingEdges(nodeId: string): Edge[] { return this.queries.getIncomingEdges(nodeId); }
  getFile(filePath: string): FileRecord | null { return this.queries.getFileByPath(filePath); }
  getFiles(options: FileQueryOptions = {}): FileRecord[] { return this.queries.getAllFiles(options); }
  countFiles(options: Pick<FileQueryOptions, 'pathPrefix'> = {}): number { return this.queries.countFiles(options); }
  getContext(nodeId: string): Context { return this.graphManager.getContext(nodeId); }
  traverse(startId: string, options?: TraversalOptions): Subgraph { return this.traverser.traverseBFS(startId, options); }
  getCallGraph(nodeId: string, depth: number = 2): Subgraph { return this.traverser.getCallGraph(nodeId, depth); }
  getTypeHierarchy(nodeId: string): Subgraph { return this.traverser.getTypeHierarchy(nodeId); }
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> { return this.traverser.findUsages(nodeId); }
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph { return this.traverser.getImpactRadius(nodeId, maxDepth); }
  findPath(fromId: string, toId: string, edgeKinds?: Edge['kind'][]): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }
  getAncestors(nodeId: string): Node[] { return this.traverser.getAncestors(nodeId); }
  getChildren(nodeId: string): Node[] { return this.traverser.getChildren(nodeId); }
  getFileDependencies(filePath: string): string[] { return this.graphManager.getFileDependencies(filePath); }
  getFileDependents(filePath: string): string[] { return this.graphManager.getFileDependents(filePath); }
  findCircularDependencies(): string[][] { return this.graphManager.findCircularDependencies(); }
  findDeadCode(kinds?: Node['kind'][]): Node[] { return this.graphManager.findDeadCode(kinds); }
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number; outgoingEdgeCount: number; callCount: number;
    callerCount: number; childCount: number; depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }
  async getCode(nodeId: string): Promise<string | null> { return this.contextBuilder.getCode(nodeId); }
  async findRelevantContext(query: string, options?: FindRelevantContextOptions): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }
  async buildContext(input: TaskInput, options?: BuildContextOptions): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }
  optimize(): void { this.db.optimize(); }
  clear(): void { this.queries.clear(); }
  /** @deprecated Use close() instead */
  destroy(): void { this.close(); }
  uninitialize(): void {
    this.close();
    removeDirectory(this.projectRoot);
  }
}

export default CodeGraph;
