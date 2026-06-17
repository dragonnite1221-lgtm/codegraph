/**
 * Context Builder
 *
 * Builds rich context for tasks by combining FTS search with graph traversal.
 * Outputs structured context ready to inject into Claude.
 */

import {
  Node,
  Edge,
  NodeKind,
  Subgraph,
  TaskContext,
  TaskInput,
  BuildContextOptions,
  FindRelevantContextOptions,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from '../graph';
import { generateScoredCandidates } from './context-search';
import {
  extractNodeCode,
  assembleContextSubgraph,
} from './context-helpers';
import { buildContext as buildContextImpl } from './context-build';



/**
 * Node kinds that provide high information value in context results.
 * Imports/exports are excluded because they have near-zero information density -
 * they tell you something exists, not how it works.
 */
const HIGH_VALUE_NODE_KINDS: NodeKind[] = [
  'function', 'method', 'class', 'interface', 'type_alias', 'struct', 'trait',
  'component', 'route', 'variable', 'constant', 'enum', 'module', 'namespace',
];

/**
 * Default options for finding relevant context
 */
const DEFAULT_FIND_OPTIONS: Required<FindRelevantContextOptions> = {
  searchLimit: 3,        // Reduced from 5
  traversalDepth: 1,     // Reduced from 2
  maxNodes: 20,          // Reduced from 50
  minScore: 0.3,
  edgeKinds: [],
  nodeKinds: HIGH_VALUE_NODE_KINDS, // Filter out imports/exports by default
};

/**
 * Context Builder
 *
 * Coordinates semantic search and graph traversal to build
 * comprehensive context for tasks.
 */
export class ContextBuilder {
  private projectRoot: string;
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(
    projectRoot: string,
    queries: QueryBuilder,
    traverser: GraphTraverser
  ) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.traverser = traverser;
  }

  async buildContext(
    input: TaskInput,
    options: BuildContextOptions = {},
  ): Promise<TaskContext | string> {
    return buildContextImpl(
      this.projectRoot,
      this.findRelevantContext.bind(this),
      input,
      options,
    );
  }

  /**
   * Find relevant subgraph for a query
   *
   * Uses hybrid search combining exact symbol lookup with semantic search:
   * 1. Extract potential symbol names from query
   * 2. Look up exact matches for those symbols (high confidence)
   * 3. Use semantic search for concept matching
   * 4. Merge results, prioritizing exact matches
   * 5. Traverse graph from entry points
   *
   * @param query - Natural language query
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options: FindRelevantContextOptions = {}
  ): Promise<Subgraph> {
    const opts = { ...DEFAULT_FIND_OPTIONS, ...options };

    // Start with empty subgraph
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const roots: string[] = [];

    // Handle empty query - return empty subgraph
    if (!query || query.trim().length === 0) {
      return { nodes, edges, roots };
    }

    // Generate the scored candidate set, then assemble the final subgraph.
    const searchResults = generateScoredCandidates(query, opts, this.queries);
    const isTestQuery = query.toLowerCase().includes('test') || query.toLowerCase().includes('spec');

    return assembleContextSubgraph(searchResults, opts, isTestQuery, {
      traverser: this.traverser,
      queries: this.queries,
    });
  }

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    const node = this.queries.getNodeById(nodeId);
    if (!node) {
      return null;
    }

    return extractNodeCode(node, this.projectRoot);
  }

}

/**
 * Create a context builder
 */
export function createContextBuilder(
  projectRoot: string,
  queries: QueryBuilder,
  traverser: GraphTraverser
): ContextBuilder {
  return new ContextBuilder(projectRoot, queries, traverser);
}

// Re-export formatter
export { formatContextAsMarkdown, formatContextAsJson } from './formatter';
