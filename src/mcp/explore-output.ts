import { existsSync, readFileSync } from 'fs';

import type { Edge, Node, Subgraph } from '../types';
import { clamp, validatePathWithinRoot } from '../utils';

/**
 * Calculate the recommended number of codegraph_explore calls based on project size.
 * Larger codebases need more exploration calls to cover their surface area,
 * but smaller ones should use fewer to avoid unnecessary overhead.
 */
export function getExploreBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

/**
 * Adaptive output budget for `codegraph_explore`, scaled to project size.
 */
export interface ExploreOutputBudget {
  maxOutputChars: number;
  defaultMaxFiles: number;
  maxCharsPerFile: number;
  gapThreshold: number;
  maxSymbolsInFileHeader: number;
  maxEdgesPerRelationshipKind: number;
  includeRelationships: boolean;
  includeAdditionalFiles: boolean;
  includeCompletenessSignal: boolean;
  includeBudgetNote: boolean;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  if (fileCount < 500) {
    return {
      maxOutputChars: 18000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: true,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
    };
  }
  if (fileCount < 5000) {
    return {
      maxOutputChars: 28000,
      defaultMaxFiles: 9,
      maxCharsPerFile: 5000,
      gapThreshold: 12,
      maxSymbolsInFileHeader: 10,
      maxEdgesPerRelationshipKind: 10,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  if (fileCount < 15000) {
    return {
      maxOutputChars: 35000,
      defaultMaxFiles: 12,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  return {
    maxOutputChars: 38000,
    defaultMaxFiles: 14,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
  };
}

type ExploreStats = {
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

  const fileGroups = new Map<string, { nodes: Node[]; score: number }>();
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

    const hasQueryRelevance = (filePath: string, nodes: Node[]) => {
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

  const lines: string[] = [
    `## Exploration: ${query}`,
    '',
    `Found ${subgraph.nodes.size} symbols across ${fileGroups.size} files.`,
    '',
  ];

  const significantEdges = subgraph.edges.filter(e => e.kind !== 'contains');

  if (budget.includeRelationships && significantEdges.length > 0) {
    lines.push('### Relationships');
    lines.push('');

    const byKind = new Map<string, Array<{ source: string; target: string }>>();
    for (const edge of significantEdges) {
      const sourceNode = subgraph.nodes.get(edge.source);
      const targetNode = subgraph.nodes.get(edge.target);
      if (!sourceNode || !targetNode) continue;

      const group = byKind.get(edge.kind) || [];
      group.push({ source: sourceNode.name, target: targetNode.name });
      byKind.set(edge.kind, group);
    }

    for (const [kind, edges] of byKind) {
      const cap = budget.maxEdgesPerRelationshipKind;
      const shown = edges.slice(0, cap);
      lines.push(`**${kind}:**`);
      for (const e of shown) {
        lines.push(`- ${e.source} → ${e.target}`);
      }
      if (edges.length > cap) {
        lines.push(`- ... and ${edges.length - cap} more`);
      }
      lines.push('');
    }
  }

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

      lines.push(fileHeader);
      lines.push('');
      lines.push('```' + lang);
      lines.push(trimmed);
      lines.push('```');
      lines.push('');
      totalChars += trimmed.length + 200;
      filesIncluded++;
      anyFileTrimmed = true;
      break;
    }

    lines.push(fileHeader);
    lines.push('');
    lines.push('```' + lang);
    lines.push(fileSection);
    lines.push('```');
    lines.push('');

    totalChars += fileSection.length + 200;
    filesIncluded++;
  }

  if (budget.includeAdditionalFiles) {
    const remainingRelevant = sortedFiles.slice(filesIncluded);
    const peripheralFiles = [...fileGroups.entries()]
      .filter(([, group]) => group.score < 3)
      .sort((a, b) => b[1].score - a[1].score);
    const remainingFiles = [...remainingRelevant, ...peripheralFiles];
    if (remainingFiles.length > 0) {
      lines.push('### Additional relevant files (not shown)');
      lines.push('');
      for (const [filePath, group] of remainingFiles.slice(0, 10)) {
        const symbols = group.nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
        lines.push(`- ${filePath}: ${symbols}`);
      }
      if (remainingFiles.length > 10) {
        lines.push(`- ... and ${remainingFiles.length - 10} more files`);
      }
    }
  }

  if (budget.includeCompletenessSignal) {
    lines.push('');
    lines.push('---');
    lines.push(`> **Complete source code is included above for ${filesIncluded} files.** You do NOT need to re-read these files — the relevant sections are already shown in full. Only use Read/Grep for files listed under "Additional relevant files" if you need more detail.`);
  } else if (anyFileTrimmed) {
    lines.push('');
    lines.push(`> Some file sections were trimmed for size. Use \`codegraph_node\` or Read for the full source if needed.`);
  }

  if (budget.includeBudgetNote) {
    try {
      const stats = cg.getStats();
      const callBudget = getExploreBudget(stats.fileCount);
      lines.push('');
      lines.push(`> **Explore budget: ${callBudget} calls max for this project (${stats.fileCount.toLocaleString()} files indexed).** Stop exploring and synthesize your answer once you've used ${callBudget} calls — do NOT make additional explore calls beyond this budget.`);
    } catch {
      // Stats unavailable — skip budget note.
    }
  }

  return lines.join('\n');
}

type SymbolRange = {
  start: number;
  end: number;
  name: string;
  kind: string;
  importance: number;
};

type SymbolCluster = {
  start: number;
  end: number;
  symbols: string[];
  score: number;
  maxImportance: number;
};

function buildSymbolRanges(input: {
  nodes: Node[];
  fileLines: string[];
  entryNodeIds: Set<string>;
  connectedToEntry: Set<string>;
  subgraph: Subgraph;
  cg: Pick<ExploreGraph, 'getOutgoingEdges'>;
}): SymbolRange[] {
  const envelopeKinds = new Set(['file', 'module', 'class', 'struct', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
  const ranges: SymbolRange[] = input.nodes
    .filter(n => n.startLine > 0 && n.endLine > 0)
    .filter(n => !(envelopeKinds.has(n.kind) && (n.endLine - n.startLine + 1) > input.fileLines.length * 0.5))
    .map(n => {
      let importance = 1;
      if (input.entryNodeIds.has(n.id)) importance = 10;
      else if (input.connectedToEntry.has(n.id)) importance = 3;
      return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance };
    });

  const edgeLines = new Set<string>();
  for (const node of input.nodes) {
    const outgoing = input.cg.getOutgoingEdges(node.id);
    for (const edge of outgoing) {
      if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
      const key = `${edge.line}:${edge.target}`;
      if (edgeLines.has(key)) continue;
      edgeLines.add(key);
      const targetNode = input.subgraph.nodes.get(edge.target);
      const targetName = targetNode?.name ?? edge.kind;
      ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2 });
    }
  }

  return ranges;
}

function buildClusters(ranges: SymbolRange[], gapThreshold: number): SymbolCluster[] {
  const clusters: SymbolCluster[] = [];
  let current: SymbolCluster = {
    start: ranges[0]!.start,
    end: ranges[0]!.end,
    symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
    score: ranges[0]!.importance,
    maxImportance: ranges[0]!.importance,
  };

  for (let i = 1; i < ranges.length; i++) {
    const r = ranges[i]!;
    if (r.start <= current.end + gapThreshold) {
      current.end = Math.max(current.end, r.end);
      current.symbols.push(`${r.name}(${r.kind})`);
      current.score += r.importance;
      current.maxImportance = Math.max(current.maxImportance, r.importance);
    } else {
      clusters.push(current);
      current = {
        start: r.start,
        end: r.end,
        symbols: [`${r.name}(${r.kind})`],
        score: r.importance,
        maxImportance: r.importance,
      };
    }
  }
  clusters.push(current);
  return clusters;
}

function buildFileSection(
  clusters: SymbolCluster[],
  fileLines: string[],
  budget: ExploreOutputBudget,
): { fileSection: string; allSymbols: string[]; fileTrimmed: boolean } {
  const contextPadding = 3;
  const withLineNumbers = exploreLineNumbersEnabled();
  const buildSection = (c: { start: number; end: number }): string => {
    const startIdx = Math.max(0, c.start - 1 - contextPadding);
    const endIdx = Math.min(fileLines.length, c.end + contextPadding);
    const slice = fileLines.slice(startIdx, endIdx).join('\n');
    return withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice;
  };
  const gapMarker = '\n\n... (gap) ...\n\n';

  const rankedClusters = clusters
    .map((c, i) => ({ idx: i, span: c.end - c.start + 1, c }))
    .sort((a, b) => {
      if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
      const densityA = a.c.score / a.span;
      const densityB = b.c.score / b.span;
      if (densityB !== densityA) return densityB - densityA;
      if (b.c.score !== a.c.score) return b.c.score - a.c.score;
      return a.span - b.span;
    });

  const chosenIndices = new Set<number>();
  let projectedChars = 0;
  for (const rc of rankedClusters) {
    const sectionLen = buildSection(rc.c).length + (chosenIndices.size > 0 ? gapMarker.length : 0);
    if (chosenIndices.size === 0) {
      chosenIndices.add(rc.idx);
      projectedChars += sectionLen;
      continue;
    }
    if (projectedChars + sectionLen > budget.maxCharsPerFile) continue;
    chosenIndices.add(rc.idx);
    projectedChars += sectionLen;
  }

  let fileSection = '';
  const allSymbols: string[] = [];
  let fileTrimmed = false;
  for (let i = 0; i < clusters.length; i++) {
    if (!chosenIndices.has(i)) continue;
    const cluster = clusters[i]!;
    const section = buildSection(cluster);
    if (fileSection.length > 0) fileSection += gapMarker;
    fileSection += section;
    allSymbols.push(...cluster.symbols);
  }

  if (fileSection.length > budget.maxCharsPerFile) {
    fileSection = fileSection.slice(0, budget.maxCharsPerFile) + '\n... (trimmed) ...';
    fileTrimmed = true;
  }

  return {
    fileSection,
    allSymbols,
    fileTrimmed: chosenIndices.size < clusters.length || fileTrimmed,
  };
}

function buildFileHeader(filePath: string, allSymbols: string[], budget: ExploreOutputBudget): string {
  const symbolCounts = new Map<string, number>();
  for (const s of allSymbols) {
    symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
  }
  const sortedSymbols = [...symbolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  const headerSymbols = sortedSymbols.slice(0, budget.maxSymbolsInFileHeader);
  const omittedCount = sortedSymbols.length - headerSymbols.length;
  const headerSuffix = omittedCount > 0
    ? `${headerSymbols.join(', ')}, +${omittedCount} more`
    : headerSymbols.join(', ');
  return `#### ${filePath} — ${headerSuffix}`;
}

function exploreLineNumbersEnabled(): boolean {
  return process.env.CODEGRAPH_EXPLORE_LINENUMS !== '0';
}

function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}
