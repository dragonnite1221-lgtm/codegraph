/**
 * Import Resolver
 *
 * Resolves import paths to actual files and symbols.
 */

import * as path from 'path';
import { Language, Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from './types';
import { applyAliases } from './path-aliases';

// Import/re-export parsing lives in import-extractors; re-exported here so
// existing consumers (resolution/index.ts) keep their import paths.
export {
  extractImportMappings,
  extractReExports,
  clearImportMappingCache,
} from './import-extractors';

/**
 * Extension resolution order by language
 */
const EXTENSION_RESOLUTION: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '/index.js', '/index.jsx'],
  tsx: ['.tsx', '.ts', '.d.ts', '.js', '.jsx', '/index.tsx', '/index.ts', '/index.js'],
  jsx: ['.jsx', '.js', '/index.jsx', '/index.js'],
  python: ['.py', '/__init__.py'],
  go: ['.go'],
  rust: ['.rs', '/mod.rs'],
  java: ['.java'],
  csharp: ['.cs'],
  php: ['.php'],
  ruby: ['.rb'],
};

/**
 * Resolve an import path to an actual file
 */
export function resolveImportPath(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string | null {
  // Skip external/npm packages — but pass the context so the
  // bare-specifier heuristic can consult the project's tsconfig
  // alias map first (custom prefixes like `@components/*` would
  // otherwise be misclassified as npm).
  if (isExternalImport(importPath, language, context)) {
    return null;
  }

  const projectRoot = context.getProjectRoot();
  const fromDir = path.dirname(path.join(projectRoot, fromFile));

  // Handle relative imports
  if (importPath.startsWith('.')) {
    return resolveRelativeImport(importPath, fromDir, language, context);
  }

  // Handle absolute/aliased imports (like @/ or src/)
  return resolveAliasedImport(importPath, projectRoot, language, context);
}

/**
 * Check if an import is external (npm package, etc.)
 *
 * `context` is consulted for project-defined path aliases
 * (tsconfig/jsconfig `paths`). Without that check, custom prefixes
 * like `@components/*` would fail the bare-specifier heuristic and
 * be classified as external before alias resolution can run.
 */
function isExternalImport(
  importPath: string,
  language: Language,
  context?: ResolutionContext
): boolean {
  // Relative imports are not external
  if (importPath.startsWith('.')) {
    return false;
  }

  // Common external patterns
  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx') {
    // Node built-ins
    if (['fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'events', 'stream', 'child_process', 'buffer'].includes(importPath)) {
      return true;
    }
    // Project-defined alias prefix? Treat as local.
    const aliases = context?.getProjectAliases?.();
    if (aliases) {
      for (const pat of aliases.patterns) {
        if (importPath.startsWith(pat.prefix)) return false;
      }
    }
    // Scoped packages or bare specifiers that don't start with aliases
    if (!importPath.startsWith('@/') && !importPath.startsWith('~/') && !importPath.startsWith('src/')) {
      // Likely an npm package
      return true;
    }
  }

  if (language === 'python') {
    // Standard library modules
    const stdLibs = ['os', 'sys', 'json', 're', 'math', 'datetime', 'collections', 'typing', 'pathlib', 'logging'];
    if (stdLibs.includes(importPath.split('.')[0]!)) {
      return true;
    }
  }

  if (language === 'go') {
    // Standard library or external packages
    if (!importPath.startsWith('.') && !importPath.includes('/internal/')) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve a relative import
 */
function resolveRelativeImport(
  importPath: string,
  fromDir: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const projectRoot = context.getProjectRoot();
  const extensions = EXTENSION_RESOLUTION[language] || [];

  // Try the path as-is first
  const basePath = path.resolve(fromDir, importPath);
  const relativePath = path.relative(projectRoot, basePath).replace(/\\/g, '/');

  // Try each extension
  for (const ext of extensions) {
    const candidatePath = relativePath + ext;
    if (context.fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  // Try without extension (might already have one)
  if (context.fileExists(relativePath)) {
    return relativePath;
  }

  return null;
}

/**
 * Resolve an aliased/absolute import.
 *
 * Tries, in order:
 *   1. Project-defined `compilerOptions.paths` (tsconfig/jsconfig).
 *      Each pattern can have multiple replacements; tried in tsconfig
 *      priority order with extension permutations.
 *   2. The legacy hard-coded fallback list (`@/`, `~/`, `src/`, ...)
 *      for projects that have aliases but no tsconfig paths block.
 *   3. Direct path lookup (with extensions).
 */
function resolveAliasedImport(
  importPath: string,
  projectRoot: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const extensions = EXTENSION_RESOLUTION[language] || [];
  const tryWithExt = (basePath: string): string | null => {
    for (const ext of extensions) {
      const candidate = basePath + ext;
      if (context.fileExists(candidate)) return candidate;
    }
    if (context.fileExists(basePath)) return basePath;
    return null;
  };

  // 1. Project tsconfig/jsconfig paths.
  const aliasMap = context.getProjectAliases?.();
  if (aliasMap) {
    const candidates = applyAliases(importPath, aliasMap, projectRoot);
    for (const c of candidates) {
      const hit = tryWithExt(c);
      if (hit) return hit;
    }
  }

  // 2. Hard-coded fallback list. Kept for projects that use these
  //    conventional aliases without declaring them in tsconfig.
  const fallbackAliases: Record<string, string> = {
    '@/': 'src/',
    '~/': 'src/',
    '@src/': 'src/',
    'src/': 'src/',
    '@app/': 'app/',
    'app/': 'app/',
  };
  for (const [alias, replacement] of Object.entries(fallbackAliases)) {
    if (importPath.startsWith(alias)) {
      const hit = tryWithExt(importPath.replace(alias, replacement));
      if (hit) return hit;
    }
  }

  // 3. Direct path.
  return tryWithExt(importPath);
}


/**
 * Resolve a reference using import mappings
 */
export function resolveViaImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Use cached import mappings (avoids re-reading and re-parsing per ref)
  const imports = context.getImportMappings(ref.filePath, ref.language);
  if (imports.length === 0 && !context.readFile(ref.filePath)) {
    return null;
  }

  // Check if the reference name matches any import
  for (const imp of imports) {
    if (imp.localName === ref.referenceName || ref.referenceName.startsWith(imp.localName + '.')) {
      // Resolve the import path
      const resolvedPath = resolveImportPath(
        imp.source,
        ref.filePath,
        ref.language,
        context
      );

      if (resolvedPath) {
        const exportedName = imp.isDefault ? 'default' : imp.exportedName;
        const memberName = imp.isNamespace
          ? ref.referenceName.replace(imp.localName + '.', '')
          : null;

        const targetNode = findExportedSymbol(
          resolvedPath,
          { isDefault: imp.isDefault, isNamespace: imp.isNamespace, exportedName, memberName },
          ref.language,
          context,
          new Set()
        );

        if (targetNode) {
          return {
            original: ref,
            targetNodeId: targetNode.id,
            confidence: 0.9,
            resolvedBy: 'import',
          };
        }
      }
    }
  }

  return null;
}

/** Recursive depth cap for re-export chain following. Real codebases
 *  rarely chain barrels more than 2–3 deep; 8 is a generous safety
 *  net that still bounds worst-case work. */
const REEXPORT_MAX_DEPTH = 8;

/**
 * Find an exported symbol in `filePath`, following `export { x } from
 * './other'` and `export * from './other'` chains until the original
 * declaration is reached. Cycle-safe via the `visited` set.
 *
 * Without this, every barrel-style import (`import { Foo } from
 * './index'` where `index.ts` only re-exports) used to resolve to
 * nothing — the existing code only looked for declarations IN the
 * resolved file, not declarations the file forwarded.
 */
function findExportedSymbol(
  filePath: string,
  want: {
    isDefault: boolean;
    isNamespace: boolean;
    exportedName: string;
    memberName: string | null;
  },
  language: Language,
  context: ResolutionContext,
  visited: Set<string>,
  depth = 0
): Node | undefined {
  if (depth > REEXPORT_MAX_DEPTH) return undefined;
  if (visited.has(filePath)) return undefined;
  visited.add(filePath);

  const nodesInFile = context.getNodesInFile(filePath);

  // 1. Direct hit: the symbol is declared in this file.
  if (want.isDefault) {
    const direct = nodesInFile.find(
      (n) => n.isExported && (n.kind === 'function' || n.kind === 'class')
    );
    if (direct) return direct;
  } else if (want.isNamespace && want.memberName) {
    const direct = nodesInFile.find(
      (n) => n.name === want.memberName && n.isExported
    );
    if (direct) return direct;
  } else {
    const direct = nodesInFile.find(
      (n) => n.name === want.exportedName && n.isExported
    );
    if (direct) return direct;
  }

  // 2. Re-export hit: the file forwards the symbol to another module.
  const reExports = context.getReExports?.(filePath, language) ?? [];
  if (reExports.length === 0) return undefined;

  // Look for explicit `export { want } from './other'` (with optional rename).
  const targetName = want.isDefault ? 'default' : want.exportedName;
  for (const rex of reExports) {
    if (rex.kind === 'named' && rex.exportedName === targetName) {
      const next = resolveImportPath(rex.source, filePath, language, context);
      if (!next) continue;
      // After rename: `export { foo as bar } from './x'` — to chase
      // `bar`, we look for `foo` in `./x`.
      const chained = findExportedSymbol(
        next,
        {
          isDefault: rex.originalName === 'default',
          isNamespace: false,
          exportedName: rex.originalName,
          memberName: null,
        },
        language,
        context,
        visited,
        depth + 1
      );
      if (chained) return chained;
    }
  }

  // 3. Wildcard re-export: `export * from './other'` — try every
  //    forwarding source. This is the barrel-of-barrels case.
  for (const rex of reExports) {
    if (rex.kind === 'wildcard') {
      const next = resolveImportPath(rex.source, filePath, language, context);
      if (!next) continue;
      const chained = findExportedSymbol(next, want, language, context, visited, depth + 1);
      if (chained) return chained;
    }
  }

  return undefined;
}
