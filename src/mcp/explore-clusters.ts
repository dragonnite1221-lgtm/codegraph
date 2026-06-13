/**
 * Explore output clustering
 *
 * Symbol-range collection, gap-based clustering, and per-file source-section
 * rendering used by buildExploreOutput. Split out of explore-output.ts to keep
 * the top-level assembly readable.
 */

import type { Node, Subgraph } from '../types';
import type { ExploreGraph, ExploreOutputBudget } from './explore-output';

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

export function buildSymbolRanges(input: {
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

export function buildClusters(ranges: SymbolRange[], gapThreshold: number): SymbolCluster[] {
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

export function buildFileSection(
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

export function buildFileHeader(filePath: string, allSymbols: string[], budget: ExploreOutputBudget): string {
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
