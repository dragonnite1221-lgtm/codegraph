/**
 * Adaptive call/output budgets for codegraph_explore, scaled to project size.
 * Split out of explore-output.ts to stay within the file-size gate.
 */

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
