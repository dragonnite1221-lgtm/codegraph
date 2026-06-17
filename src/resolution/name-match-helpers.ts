/**
 * Shared scoring/parsing helpers for name matching, split out of name-matcher.ts
 * to stay within the file-size gate.
 */

import { Node } from '../types';
import { UnresolvedRef, ResolutionContext } from './types';

/**
 * Split a camelCase or PascalCase string into words.
 */
export function splitCamelCase(str: string): string[] {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:\/\\]+/)
    .filter(w => w.length > 1);
}

/**
 * Compute directory proximity between two file paths.
 * Returns a score based on the number of shared directory segments.
 * Higher score = closer in directory tree.
 */
export function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/').slice(0, -1);
  const dir2 = filePath2.split('/').slice(0, -1);

  let shared = 0;
  for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
    if (dir1[i] === dir2[i]) {
      shared++;
    } else {
      break;
    }
  }

  // Each shared directory segment contributes 15 points, capped at 80
  return Math.min(shared * 15, 80);
}

/**
 * Find the best matching node when there are multiple candidates
 */
export function findBestMatch(
  ref: UnresolvedRef,
  candidates: Node[],
  _context: ResolutionContext
): Node | null {
  // Prioritization rules:
  // 1. Same file > different file
  // 2. Directory proximity (same module/package > different module)
  // 3. Same language > different language
  // 4. Functions/methods > classes/types (for call references)
  // 5. Exported > non-exported

  let bestScore = -1;
  let bestNode: Node | null = null;

  for (const candidate of candidates) {
    let score = 0;

    // Same file bonus
    if (candidate.filePath === ref.filePath) {
      score += 100;
    }

    // Directory proximity bonus — strongly prefer same module/package
    score += computePathProximity(ref.filePath, candidate.filePath);

    // Language matching: strongly prefer same language, penalize cross-language
    if (candidate.language === ref.language) {
      score += 50;
    } else {
      score -= 80;
    }

    // For call references, prefer functions/methods
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      }
    }

    // For instantiation references (`new Foo()`), prefer class-like
    // targets — without this, a function named `Foo` in another module
    // could outscore the actual class.
    if (ref.referenceKind === 'instantiates') {
      if (
        candidate.kind === 'class' ||
        candidate.kind === 'struct' ||
        candidate.kind === 'interface'
      ) {
        score += 25;
      }
    }

    // For decorator references (`@Foo`), prefer functions. Class
    // decorators (Python `@SomeClass`, Java annotation interfaces)
    // also resolve here, hence the smaller class bonus.
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15;
      }
    }

    // Exported bonus
    if (candidate.isExported) {
      score += 10;
    }

    // Closer line number (within same file)
    if (candidate.filePath === ref.filePath && candidate.startLine) {
      const distance = Math.abs(candidate.startLine - ref.line);
      score += Math.max(0, 20 - distance / 10);
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = candidate;
    }
  }

  return bestNode;
}
