/**
 * Vue / Nuxt Framework Resolver
 *
 * Handles Vue component references, compiler macros (defineProps, etc.),
 * Nuxt auto-imports, and Nuxt file-based routing patterns.
 */

import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import {
  VUE_COMPILER_MACROS,
  NUXT_AUTO_IMPORTS,
  NUXT_VIRTUAL_MODULES,
} from './vue-consts';
import { extractVueRoutes, isPascalCase, resolveComponent } from './vue-resolve';


export const vueResolver: FrameworkResolver = {
  name: 'vue',

  detect(context: ResolutionContext): boolean {
    // Check for vue or nuxt in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.vue || deps.nuxt || deps['@nuxt/kit']) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .vue files in project
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.vue'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Vue compiler macros (defineProps, defineEmits, etc.)
    if (VUE_COMPILER_MACROS.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // Pattern 2: Nuxt auto-imported composables
    if (NUXT_AUTO_IMPORTS.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // Pattern 3: Nuxt virtual module imports (#imports, #components, etc.)
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('#')) {
      if (NUXT_VIRTUAL_MODULES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        return {
          original: ref,
          targetNodeId: ref.fromNodeId,
          confidence: 1.0,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: @ alias imports (@/components/Foo -> src/components/Foo)
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('@/')) {
      const aliasPath = ref.referenceName.replace('@/', 'src/');
      for (const ext of ['', '.ts', '.js', '.vue', '/index.ts', '/index.js', '/index.vue']) {
        const fullPath = aliasPath + ext;
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

    // Pattern 5: ~ alias imports (~/components/Foo -> src/components/Foo, Nuxt convention)
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('~/')) {
      const aliasPath = ref.referenceName.replace('~/', 'src/');
      for (const ext of ['', '.ts', '.js', '.vue', '/index.ts', '/index.js', '/index.vue']) {
        const fullPath = aliasPath + ext;
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

    // Pattern 6: Component references (PascalCase) — resolve to .vue files
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

  extract(filePath: string, _content: string) {
    return extractVueRoutes(filePath);
  },
};

