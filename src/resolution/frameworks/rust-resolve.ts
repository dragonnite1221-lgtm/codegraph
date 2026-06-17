/**
 * Rust resolver name/module-resolution helpers split out of rust.ts to keep
 * it within the 200-line limit. Pure helpers — no behavior change.
 */

import { ResolutionContext } from '../types';
import { getCargoWorkspaceCrateMap } from './cargo-workspace';

const cargoWorkspaceMapCache = new WeakMap<ResolutionContext, Map<string, string>>();

function getCachedCargoWorkspaceCrateMap(context: ResolutionContext): Map<string, string> {
  const cached = cargoWorkspaceMapCache.get(context);
  if (cached) return cached;
  const map = getCargoWorkspaceCrateMap(context);
  cargoWorkspaceMapCache.set(context, map);
  return map;
}

// Directory patterns
export const HANDLER_DIRS = ['/handlers/', '/handler/', '/api/', '/routes/', '/controllers/'];
export const SERVICE_DIRS = ['/services/', '/service/', '/repository/', '/domain/'];
export const MODEL_DIRS = ['/models/', '/model/', '/entities/', '/entity/', '/domain/', '/types/'];

export const FUNCTION_KINDS = new Set(['function']);
export const SERVICE_KINDS = new Set(['struct', 'trait']);
export const STRUCT_KINDS = new Set(['struct']);

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

export interface ModuleResolution {
  targetId: string;
  fromWorkspace: boolean;
}

export function resolveModule(name: string, context: ResolutionContext): ModuleResolution | null {
  // Rust modules can be either mod.rs in a directory or name.rs
  const localPaths = [`src/${name}.rs`, `src/${name}/mod.rs`];

  const workspaceCrates = getCachedCargoWorkspaceCrateMap(context);
  const cratePath = workspaceCrates.get(name);
  const workspacePaths = cratePath
    ? [`${cratePath}/src/lib.rs`, `${cratePath}/src/main.rs`]
    : [];

  const candidates: Array<{ path: string; fromWorkspace: boolean }> = [
    ...localPaths.map((path) => ({ path, fromWorkspace: false })),
    ...workspacePaths.map((path) => ({ path, fromWorkspace: true })),
  ];

  for (const { path: modPath, fromWorkspace } of candidates) {
    if (!context.fileExists(modPath)) continue;
    const nodes = context.getNodesInFile(modPath);
    const modNode = nodes.find((n) => n.kind === 'module');
    if (modNode) return { targetId: modNode.id, fromWorkspace };
    if (nodes.length > 0) return { targetId: nodes[0]!.id, fromWorkspace };
  }

  return null;
}
