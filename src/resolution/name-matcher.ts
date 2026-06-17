/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution. The individual
 * strategies live in sibling modules (name-match-basic / name-match-method,
 * with shared scoring in name-match-helpers) to stay within the file-size gate;
 * this module keeps the fuzzy fallback and the matchReference orchestrator, and
 * re-exports the strategies for stable import paths.
 */

import { UnresolvedRef, ResolvedRef, ResolutionContext } from './types';
import {
  matchByExactName,
  matchByFilePath,
  matchByQualifiedName,
} from './name-match-basic';
import { matchMethodCall } from './name-match-method';

export { matchByFilePath, matchByExactName, matchByQualifiedName } from './name-match-basic';
export { matchMethodCall } from './name-match-method';

/**
 * Fuzzy match - last resort with lower confidence
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase();

  // Use pre-built lowercase index for O(1) lookup instead of scanning all nodes
  const candidates = context.getNodesByLowerName(lowerName);

  // Filter to callable kinds only (function, method, class)
  const callableKinds = new Set(['function', 'method', 'class']);
  const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind));

  // Prefer same-language matches
  const sameLanguageCandidates = callableCandidates.filter(n => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates;

  if (finalCandidates.length === 1) {
    const isCrossLanguage = finalCandidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: finalCandidates[0]!.id,
      confidence: isCrossLanguage ? 0.3 : 0.5,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}

/**
 * Match all strategies in order of confidence
 */
export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Try strategies in order of confidence
  let result: ResolvedRef | null;

  // 0. File path match (e.g., "snippets/drawer-menu.liquid" → file node)
  result = matchByFilePath(ref, context);
  if (result) return result;

  // 1. Qualified name match (highest confidence)
  result = matchByQualifiedName(ref, context);
  if (result) return result;

  // 2. Method call pattern
  result = matchMethodCall(ref, context);
  if (result) return result;

  // 3. Exact name match
  result = matchByExactName(ref, context);
  if (result) return result;

  // 4. Fuzzy match (lowest confidence)
  result = matchFuzzy(ref, context);
  if (result) return result;

  return null;
}
