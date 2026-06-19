/**
 * codegraph_explore file selection + source-section rendering. Split out of
 * explore-output.ts to stay within the file-size gate.
 */

import { existsSync, readFileSync } from 'fs';
import type { Subgraph } from '../types';
import { validatePathWithinRoot } from '../utils';
import {
  buildClusters,
  buildFileHeader,
  buildFileSection,
  buildSymbolRanges,
} from './explore-clusters';
import type { ExploreGraph, FileGroup } from './explore-types';
import type { ExploreOutputBudget } from './explore-budget';

export interface GroupedFiles {
  sortedFiles: Array<[string, FileGroup]>;
  fileGroups: Map<string, FileGroup>;
  entryNodeIds: Set<string>;
  connectedToEntry: Set<string>;
}

/** Group subgraph nodes by file, score by entry/connectivity, and sort by relevance. */
export function groupAndScoreFiles(subgraph: Subgraph, query: string): GroupedFiles {
  const fileGroups = new Map<string, FileGroup>();
  const entryNodeIds = new Set(subgraph.roots);
  const connectedToEntry = new Set<string>();
  for (const edge of subgraph.edges) {
    if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
    if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
  }

  for (const node of subgraph.nodes.values()) {
    if (node.kind === 'import' || node.kind === 'export') continue;

    const group = fileGroups.get(node.filePath) || { nodes: [], score: 0 };
    group.nodes.push(node);
    if (entryNodeIds.has(node.id)) {
      group.score += 10;
    } else if (connectedToEntry.has(node.id)) {
      group.score += 3;
    } else {
      group.score += 1;
    }
    fileGroups.set(node.filePath, group);
  }

  const relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= 3);
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

  const sortedFiles = relevantFiles.sort((a, b) => {
    const aPath = a[0].toLowerCase();
    const bPath = b[0].toLowerCase();

    const hasQueryRelevance = (filePath: string, nodes: FileGroup['nodes']) => {
      const fp = filePath.toLowerCase();
      if (queryTerms.some(t => fp.includes(t))) return true;
      return nodes.some(n => queryTerms.some(t => n.name.toLowerCase().includes(t)));
    };

    const aRelevant = hasQueryRelevance(aPath, a[1].nodes);
    const bRelevant = hasQueryRelevance(bPath, b[1].nodes);
    if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;

    const isLowValue = (p: string) =>
      /\/(tests?|__tests?__|spec)\//i.test(p) ||
      /\bicons?\b/i.test(p) ||
      /\bi18n\b/i.test(p);
    const aLow = isLowValue(aPath);
    const bLow = isLowValue(bPath);
    if (aLow !== bLow) return aLow ? 1 : -1;

    if (a[1].score !== b[1].score) return b[1].score - a[1].score;
    return b[1].nodes.length - a[1].nodes.length;
  });

  return { sortedFiles, fileGroups, entryNodeIds, connectedToEntry };
}

export interface SourceSectionParams {
  cg: ExploreGraph;
  projectRoot: string;
  sortedFiles: Array<[string, FileGroup]>;
  entryNodeIds: Set<string>;
  connectedToEntry: Set<string>;
  subgraph: Subgraph;
  budget: ExploreOutputBudget;
  maxFiles: number;
}

/** Append the "### Source Code" section, returning inclusion/trim stats. */
export function appendSourceSections(
  lines: string[],
  params: SourceSectionParams
): { filesIncluded: number; anyFileTrimmed: boolean } {
  const { cg, projectRoot, sortedFiles, entryNodeIds, connectedToEntry, subgraph, budget, maxFiles } = params;

  lines.push('### Source Code');
  lines.push('');

  let totalChars = lines.join('\n').length;
  let filesIncluded = 0;
  let anyFileTrimmed = false;

  for (const [filePath, group] of sortedFiles) {
    if (filesIncluded >= maxFiles) break;
    if (totalChars > budget.maxOutputChars * 0.9) break;

    const absPath = validatePathWithinRoot(projectRoot, filePath);
    if (!absPath || !existsSync(absPath)) continue;

    let fileContent: string;
    try {
      fileContent = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const fileLines = fileContent.split('\n');
    const lang = group.nodes[0]?.language || '';
    const ranges = buildSymbolRanges({
      nodes: group.nodes,
      fileLines,
      entryNodeIds,
      connectedToEntry,
      subgraph,
      cg,
    });

    ranges.sort((a, b) => a.start - b.start);
    if (ranges.length === 0) continue;

    const clusters = buildClusters(ranges, budget.gapThreshold);
    const { fileSection, allSymbols, fileTrimmed } = buildFileSection(clusters, fileLines, budget);
    if (fileSection.length === 0) continue;

    if (fileTrimmed || clusters.length > 0) {
      anyFileTrimmed ||= fileTrimmed;
    }

    const fileHeader = buildFileHeader(filePath, allSymbols, budget);

    if (totalChars + fileSection.length + 200 > budget.maxOutputChars) {
      const remaining = budget.maxOutputChars - totalChars - 200;
      if (remaining < 500) break;
      const trimmed = fileSection.slice(0, remaining) + '\n... (trimmed) ...';

      lines.push(fileHeader, '', '```' + lang, trimmed, '```', '');
      totalChars += trimmed.length + 200;
      filesIncluded++;
      anyFileTrimmed = true;
      break;
    }

    lines.push(fileHeader, '', '```' + lang, fileSection, '```', '');
    totalChars += fileSection.length + 200;
    filesIncluded++;
  }

  return { filesIncluded, anyFileTrimmed };
}
