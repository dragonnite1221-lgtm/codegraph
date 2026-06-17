/**
 * React resolver helpers split out of react.ts to keep it within the
 * 200-line limit. Pure helpers — no behavior change.
 */

import { ResolutionContext } from '../types';

/**
 * Check if string is PascalCase
 */
export function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * Check if name is a built-in type
 */
export function isBuiltInType(name: string): boolean {
  return BUILT_IN_TYPES.has(name);
}

export const BUILT_IN_TYPES = new Set([
  'Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Math', 'Number',
  'Object', 'Promise', 'RegExp', 'String', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'React', 'Component', 'Fragment', 'Suspense', 'StrictMode',
]);

export const COMPONENT_KINDS = new Set(['component', 'function', 'class']);

/**
 * Resolve a component reference using name-based lookup
 */
export function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const components = candidates.filter((n) => COMPONENT_KINDS.has(n.kind));
  if (components.length === 0) return null;

  // Prefer same directory
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = components.filter((n) => n.filePath.startsWith(fromDir));
  if (sameDir.length > 0) return sameDir[0]!.id;

  // Prefer component directories
  const COMPONENT_DIRS = ['/components/', '/src/components/', '/app/components/', '/pages/', '/src/pages/', '/views/', '/src/views/'];
  const preferred = components.filter((n) =>
    COMPONENT_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return components[0]!.id;
}

/**
 * Resolve a custom hook reference using name-based lookup
 */
export function resolveHook(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const hooks = candidates.filter((n) => n.kind === 'function' && n.name.startsWith('use'));
  if (hooks.length === 0) return null;

  // Prefer hooks directories
  const HOOK_DIRS = ['/hooks/', '/src/hooks/', '/lib/hooks/', '/utils/hooks/'];
  const preferred = hooks.filter((n) =>
    HOOK_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return hooks[0]!.id;
}

/**
 * Resolve a context reference using name-based lookup
 */
export function resolveContext(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) {
    // Try without Context/Provider suffix
    const baseName = name.replace(/Context$|Provider$/, '');
    if (baseName !== name) {
      const baseCandidates = context.getNodesByName(baseName);
      if (baseCandidates.length > 0) return baseCandidates[0]!.id;
    }
    return null;
  }

  // Prefer context directories
  const CONTEXT_DIRS = ['/context/', '/contexts/', '/src/context/', '/src/contexts/', '/providers/', '/src/providers/'];
  const preferred = candidates.filter((n) =>
    CONTEXT_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return candidates[0]!.id;
}

/**
 * Convert file path to Next.js route
 */
export function filePathToRoute(filePath: string): string | null {
  // pages/index.tsx -> /
  // pages/about.tsx -> /about
  // pages/blog/[slug].tsx -> /blog/:slug
  // app/page.tsx -> /
  // app/about/page.tsx -> /about

  if (filePath.includes('pages/')) {
    let route = filePath
      .replace(/^.*pages\//, '/')
      .replace(/\/index\.(tsx?|jsx?)$/, '')
      .replace(/\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  if (filePath.includes('app/')) {
    // App router - only page.tsx files are routes
    if (!filePath.includes('page.')) {
      return null;
    }

    let route = filePath
      .replace(/^.*app\//, '/')
      .replace(/\/page\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  return null;
}
