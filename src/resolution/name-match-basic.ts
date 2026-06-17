/**
 * Basic name-matching strategies: file-path, exact-name, and qualified-name.
 * Split out of name-matcher.ts to stay within the file-size gate.
 */

import { UnresolvedRef, ResolvedRef, ResolutionContext } from './types';
import { computePathProximity, findBestMatch } from './name-match-helpers';

/**
 * Try to resolve a path-like reference (e.g., "snippets/drawer-menu.liquid")
 * by matching the filename against file nodes.
 */
export function matchByFilePath(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (!ref.referenceName.includes('/')) return null;

  // Extract the filename from the path
  const fileName = ref.referenceName.split('/').pop();
  if (!fileName) return null;

  // Search for file nodes with this name
  const candidates = context.getNodesByName(fileName);
  const fileNodes = candidates.filter(n => n.kind === 'file');

  if (fileNodes.length === 0) return null;

  // Prefer exact path match on qualified_name
  const exactMatch = fileNodes.find(n => n.qualifiedName === ref.referenceName || n.filePath === ref.referenceName);
  if (exactMatch) {
    return {
      original: ref,
      targetNodeId: exactMatch.id,
      confidence: 0.95,
      resolvedBy: 'file-path',
    };
  }

  // Fall back to suffix match (e.g., ref="snippets/foo.liquid" matches "src/snippets/foo.liquid")
  const suffixMatch = fileNodes.find(n => n.qualifiedName.endsWith(ref.referenceName) || n.filePath.endsWith(ref.referenceName));
  if (suffixMatch) {
    return {
      original: ref,
      targetNodeId: suffixMatch.id,
      confidence: 0.85,
      resolvedBy: 'file-path',
    };
  }

  // If only one file node with this name, use it with lower confidence
  if (fileNodes.length === 1) {
    return {
      original: ref,
      targetNodeId: fileNodes[0]!.id,
      confidence: 0.7,
      resolvedBy: 'file-path',
    };
  }

  return null;
}

/**
 * Try to resolve a reference by exact name match
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const candidates = context.getNodesByName(ref.referenceName);

  if (candidates.length === 0) {
    return null;
  }

  // If only one match, use it — but penalize cross-language matches
  if (candidates.length === 1) {
    const isCrossLanguage = candidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? 0.5 : 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Multiple matches - try to narrow down
  const bestMatch = findBestMatch(ref, candidates, context);
  if (bestMatch) {
    // Lower confidence when the match is from a distant/unrelated module
    const proximity = computePathProximity(ref.filePath, bestMatch.filePath);
    const confidence = proximity >= 30 ? 0.7 : 0.4;
    return {
      original: ref,
      targetNodeId: bestMatch.id,
      confidence,
      resolvedBy: 'exact-match',
    };
  }

  return null;
}

/**
 * Try to resolve by qualified name
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Check if the reference name looks qualified (contains :: or .)
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  const candidates = context.getNodesByQualifiedName(ref.referenceName);

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.95,
      resolvedBy: 'qualified-name',
    };
  }

  // Try partial qualified name match
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts[parts.length - 1];
  if (lastName) {
    const partialCandidates = context.getNodesByName(lastName);
    for (const candidate of partialCandidates) {
      if (candidate.qualifiedName.endsWith(ref.referenceName)) {
        return {
          original: ref,
          targetNodeId: candidate.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  return null;
}
