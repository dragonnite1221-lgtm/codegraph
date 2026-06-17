/**
 * Svelte / SvelteKit Framework Resolver
 *
 * Handles Svelte component references, Svelte 5 runes,
 * store auto-subscriptions, and SvelteKit route/module patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import {
  isRuneReference,
  isPascalCase,
  resolveComponent,
  getSvelteKitRouteInfo,
  filePathToSvelteKitRoute,
} from './svelte-resolve';


/**
 * SvelteKit framework-provided module prefixes
 */
const SVELTEKIT_MODULE_PREFIXES = [
  '$app/navigation',
  '$app/stores',
  '$app/environment',
  '$app/forms',
  '$app/paths',
  '$env/static/private',
  '$env/static/public',
  '$env/dynamic/private',
  '$env/dynamic/public',
];

export const svelteResolver: FrameworkResolver = {
  name: 'svelte',
  languages: ['svelte'],

  detect(context: ResolutionContext): boolean {
    // Check for svelte or @sveltejs/kit in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.svelte || deps['@sveltejs/kit']) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .svelte files in project
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.svelte'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Svelte runes ($state, $derived, $effect, etc.)
    if (isRuneReference(ref.referenceName)) {
      // Runes are compiler-provided — return a high-confidence "framework" resolution
      // so CodeGraph doesn't waste time searching for user-defined symbols.
      // We use the fromNodeId as targetNodeId since runes don't have real targets.
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // Pattern 2: Store auto-subscriptions ($storeName)
    if (ref.referenceName.startsWith('$') && !ref.referenceName.startsWith('$$')) {
      const storeName = ref.referenceName.substring(1);
      const storeNode = context.getNodesByName(storeName).find(
        (n) => n.kind === 'variable' || n.kind === 'constant'
      );
      if (storeNode) {
        return {
          original: ref,
          targetNodeId: storeNode.id,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: SvelteKit module imports ($app/*, $env/*, $lib/*)
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('$')) {
      // $lib/* resolves to src/lib/* — try to find the target file
      if (ref.referenceName.startsWith('$lib/')) {
        const libPath = ref.referenceName.replace('$lib/', 'src/lib/');
        // Try common extensions
        for (const ext of ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js']) {
          const fullPath = libPath + ext;
          if (context.fileExists(fullPath)) {
            const nodes = context.getNodesInFile(fullPath);
            if (nodes.length > 0) {
              return {
                original: ref,
                targetNodeId: nodes[0]!.id,
                confidence: 0.9,
                resolvedBy: 'framework',
              };
            }
          }
        }
      }

      // $app/* and $env/* are framework-provided
      if (SVELTEKIT_MODULE_PREFIXES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        return {
          original: ref,
          targetNodeId: ref.fromNodeId,
          confidence: 1.0,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Component references (PascalCase) — resolve to .svelte files
    if (isPascalCase(ref.referenceName) && ref.referenceKind === 'calls') {
      const result = resolveComponent(ref.referenceName, ref.filePath, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, _content) {
    const nodes: Node[] = [];
    const now = Date.now();

    // Detect SvelteKit route files
    const fileName = filePath.split(/[/\\]/).pop() || '';
    const routeMatch = getSvelteKitRouteInfo(fileName);

    if (routeMatch) {
      // Extract route path from directory structure
      // e.g., src/routes/blog/[slug]/+page.svelte -> /blog/:slug
      const routePath = filePathToSvelteKitRoute(filePath);

      if (routePath) {
        nodes.push({
          id: `route:${filePath}:${routePath}:1`,
          kind: 'route',
          name: routePath,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          language: filePath.endsWith('.svelte') ? 'svelte' : 'typescript',
          updatedAt: now,
        });
      }
    }

    return { nodes, references: [] };
  },
};

