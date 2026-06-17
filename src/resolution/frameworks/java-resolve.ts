/**
 * Java/Spring name-resolution helpers split out of java.ts to keep it within
 * the 200-line limit. Pure helpers — no behavior change.
 */

import { ResolutionContext } from '../types';

// Directory patterns
export const SERVICE_DIRS = ['/service/', '/services/'];
export const REPO_DIRS = ['/repository/', '/repositories/'];
export const CONTROLLER_DIRS = ['/controller/', '/controllers/'];
export const ENTITY_DIRS = ['/entity/', '/entities/', '/model/', '/models/', '/domain/'];
export const COMPONENT_DIRS = ['/component/', '/components/', '/config/'];

export const CLASS_KINDS = new Set(['class']);
export const SERVICE_KINDS = new Set(['class', 'interface']);

/**
 * Resolve a symbol by name using indexed queries instead of scanning all files.
 */
export function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // Fall back to any match
  return kindFiltered[0]!.id;
}
