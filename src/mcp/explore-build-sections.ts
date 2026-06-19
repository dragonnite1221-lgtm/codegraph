/**
 * codegraph_explore relationship section + trailing "additional files" and
 * completeness/budget notes. Split out of explore-output.ts to stay within the
 * file-size gate.
 */

import type { Subgraph } from '../types';
import type { ExploreGraph, FileGroup } from './explore-types';
import { type ExploreOutputBudget, getExploreBudget } from './explore-budget';

/** Append the "### Relationships" section when enabled and non-empty. */
export function appendRelationships(
  lines: string[],
  subgraph: Subgraph,
  budget: ExploreOutputBudget
): void {
  const significantEdges = subgraph.edges.filter(e => e.kind !== 'contains');
  if (!budget.includeRelationships || significantEdges.length === 0) return;

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

export interface AdditionalNotesParams {
  cg: ExploreGraph;
  fileGroups: Map<string, FileGroup>;
  sortedFiles: Array<[string, FileGroup]>;
  filesIncluded: number;
  anyFileTrimmed: boolean;
  budget: ExploreOutputBudget;
}

/** Append the "additional relevant files" list and completeness/budget notes. */
export function appendAdditionalAndNotes(lines: string[], params: AdditionalNotesParams): void {
  const { cg, fileGroups, sortedFiles, filesIncluded, anyFileTrimmed, budget } = params;

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
}
