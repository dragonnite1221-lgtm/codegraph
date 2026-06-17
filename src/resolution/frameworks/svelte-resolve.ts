/**
 * Svelte resolver helpers split out of svelte.ts to keep it within the
 * 200-line limit. Pure helpers — no behavior change.
 */

import { ResolutionContext } from '../types';

/**
 * Svelte 5 runes — compiler-provided, not user code
 */
export const SVELTE_RUNES = new Set([
  '$state',
  '$state.raw',
  '$state.snapshot',
  '$derived',
  '$derived.by',
  '$effect',
  '$effect.pre',
  '$effect.root',
  '$effect.tracking',
  '$props',
  '$bindable',
  '$inspect',
  '$host',
]);

/**
 * Check if a reference name is a Svelte rune
 */
export function isRuneReference(name: string): boolean {
  // Direct match (e.g. $state, $derived)
  if (SVELTE_RUNES.has(name)) return true;

  // Rune method calls come through as the base rune name
  // e.g. $state.raw -> the call is to "$state" with ".raw" accessed as property
  // Check if it's a base rune that has sub-methods
  if (name === '$state' || name === '$derived' || name === '$effect') return true;

  return false;
}

/**
 * Check if string is PascalCase
 */
export function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * Resolve a Svelte component reference using name-based lookup
 */
export function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  // Look for component nodes by name
  const candidates = context.getNodesByName(name);
  const components = candidates.filter((n) => n.kind === 'component');

  if (components.length === 0) return null;

  // Prefer same directory
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = components.filter((n) => n.filePath.startsWith(fromDir));
  if (sameDir.length > 0) return sameDir[0]!.id;

  return components[0]!.id;
}

/**
 * SvelteKit route file patterns
 */
export const SVELTEKIT_ROUTE_FILES: Record<string, string> = {
  '+page.svelte': 'page',
  '+page.ts': 'page-load',
  '+page.js': 'page-load',
  '+page.server.ts': 'page-server-load',
  '+page.server.js': 'page-server-load',
  '+layout.svelte': 'layout',
  '+layout.ts': 'layout-load',
  '+layout.js': 'layout-load',
  '+layout.server.ts': 'layout-server-load',
  '+layout.server.js': 'layout-server-load',
  '+server.ts': 'api-endpoint',
  '+server.js': 'api-endpoint',
  '+error.svelte': 'error-page',
};

/**
 * Check if filename is a SvelteKit route file
 */
export function getSvelteKitRouteInfo(fileName: string): string | null {
  return SVELTEKIT_ROUTE_FILES[fileName] || null;
}

/**
 * Convert a file path to a SvelteKit route path
 */
export function filePathToSvelteKitRoute(filePath: string): string | null {
  // Normalize to forward slashes
  const normalized = filePath.replace(/\\/g, '/');

  // Find the routes directory
  const routesIndex = normalized.indexOf('/routes/');
  if (routesIndex === -1) return null;

  // Extract the path after routes/
  const afterRoutes = normalized.substring(routesIndex + '/routes/'.length);

  // Remove the file name
  const lastSlash = afterRoutes.lastIndexOf('/');
  const dirPath = lastSlash === -1 ? '' : afterRoutes.substring(0, lastSlash);

  // Convert SvelteKit param syntax [param] to :param
  let route = '/' + dirPath
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')  // [...rest] -> *rest
    .replace(/\[{2}([^\]]+)\]{2}/g, ':$1?') // [[optional]] -> :optional?
    .replace(/\[([^\]]+)\]/g, ':$1');        // [param] -> :param

  if (route === '/') return '/';
  // Remove trailing slash
  return route.replace(/\/$/, '');
}
