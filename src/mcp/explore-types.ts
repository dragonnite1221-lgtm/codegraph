/**
 * Shared types for codegraph_explore output building. Split out of
 * explore-output.ts so the build helpers and the orchestrator can share them
 * without an import cycle.
 */

import type { Edge, Node, Subgraph } from '../types';

export type ExploreStats = {
  fileCount: number;
};

export type ExploreGraph = {
  getProjectRoot(): string;
  getStats(): ExploreStats;
  findRelevantContext(query: string, options: {
    searchLimit: number;
    traversalDepth: number;
    maxNodes: number;
    minScore: number;
  }): Promise<Subgraph>;
  getOutgoingEdges(nodeId: string): Edge[];
};

export type BuildExploreOutputOptions = {
  maxFiles?: number;
};

/** A file's collected nodes + relevance score during exploration. */
export type FileGroup = { nodes: Node[]; score: number };
