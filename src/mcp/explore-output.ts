/**
 * codegraph_explore output builder.
 *
 * buildExploreOutput orchestrates: fetch a relevant subgraph, group/score files
 * (explore-build-files), and render the relationships + source + trailing notes
 * sections (explore-build-files / explore-build-sections), all sized to an
 * adaptive budget (explore-budget). Split into modules to stay within the
 * file-size gate.
 */

import { clamp } from '../utils';
import {
  type ExploreOutputBudget,
  getExploreBudget,
  getExploreOutputBudget,
} from './explore-budget';
import type {
  BuildExploreOutputOptions,
  ExploreGraph,
} from './explore-types';
import { appendSourceSections, groupAndScoreFiles } from './explore-build-files';
import { appendAdditionalAndNotes, appendRelationships } from './explore-build-sections';

export { getExploreBudget, getExploreOutputBudget };
export type { ExploreOutputBudget };
export type { ExploreGraph, BuildExploreOutputOptions } from './explore-types';

export async function buildExploreOutput(
  cg: ExploreGraph,
  query: string,
  options: BuildExploreOutputOptions = {},
): Promise<string> {
  const projectRoot = cg.getProjectRoot();

  let budget: ExploreOutputBudget;
  try {
    budget = getExploreOutputBudget(cg.getStats().fileCount);
  } catch {
    budget = getExploreOutputBudget(Infinity);
  }
  const maxFiles = clamp(options.maxFiles || budget.defaultMaxFiles, 1, 20);

  const subgraph = await cg.findRelevantContext(query, {
    searchLimit: 8,
    traversalDepth: 3,
    maxNodes: 200,
    minScore: 0.2,
  });

  if (subgraph.nodes.size === 0) {
    return `No relevant code found for "${query}"`;
  }

  const { sortedFiles, fileGroups, entryNodeIds, connectedToEntry } =
    groupAndScoreFiles(subgraph, query);

  const lines: string[] = [
    `## Exploration: ${query}`,
    '',
    `Found ${subgraph.nodes.size} symbols across ${fileGroups.size} files.`,
    '',
  ];

  appendRelationships(lines, subgraph, budget);

  const { filesIncluded, anyFileTrimmed } = appendSourceSections(lines, {
    cg,
    projectRoot,
    sortedFiles,
    entryNodeIds,
    connectedToEntry,
    subgraph,
    budget,
    maxFiles,
  });

  appendAdditionalAndNotes(lines, {
    cg,
    fileGroups,
    sortedFiles,
    filesIncluded,
    anyFileTrimmed,
    budget,
  });

  return lines.join('\n');
}
