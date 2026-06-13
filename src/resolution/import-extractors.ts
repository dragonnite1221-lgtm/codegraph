/**
 * Import extractors
 *
 * Per-language parsing of import statements and re-export declarations into
 * ImportMapping / ReExport records, plus the per-file mapping cache. Split out
 * of import-resolver.ts so path resolution and source parsing stay separate.
 */

import { Language } from '../types';
import { ImportMapping, ReExport } from './types';

/**
 * Extract import mappings from a file
 */
export function extractImportMappings(
  _filePath: string,
  content: string,
  language: Language
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx') {
    mappings.push(...extractJSImports(content));
  } else if (language === 'python') {
    mappings.push(...extractPythonImports(content));
  } else if (language === 'go') {
    mappings.push(...extractGoImports(content));
  } else if (language === 'php') {
    mappings.push(...extractPHPImports(content));
  }

  return mappings;
}

/**
 * Extract JS/TS import mappings
 */
function extractJSImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // ES6 imports
  const importRegex = /import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*(?:(\*)\s+as\s+(\w+))?\s*from\s*['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const [, defaultImport, namedImports, star, namespaceAlias, source] = match;

    // Default import
    if (defaultImport) {
      mappings.push({
        localName: defaultImport,
        exportedName: 'default',
        source: source!,
        isDefault: true,
        isNamespace: false,
      });
    }

    // Named imports
    if (namedImports) {
      const names = namedImports.split(',').map((s) => s.trim());
      for (const name of names) {
        const aliasMatch = name.match(/(\w+)\s+as\s+(\w+)/);
        if (aliasMatch) {
          mappings.push({
            localName: aliasMatch[2]!,
            exportedName: aliasMatch[1]!,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        } else if (name) {
          mappings.push({
            localName: name,
            exportedName: name,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        }
      }
    }

    // Namespace import
    if (star && namespaceAlias) {
      mappings.push({
        localName: namespaceAlias,
        exportedName: '*',
        source: source!,
        isDefault: false,
        isNamespace: true,
      });
    }
  }

  // Require statements
  const requireRegex = /(?:const|let|var)\s+(?:(\w+)|{([^}]+)})\s*=\s*require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const [, defaultName, destructured, source] = match;

    if (defaultName) {
      mappings.push({
        localName: defaultName,
        exportedName: 'default',
        source: source!,
        isDefault: true,
        isNamespace: false,
      });
    }

    if (destructured) {
      const names = destructured.split(',').map((s) => s.trim());
      for (const name of names) {
        const aliasMatch = name.match(/(\w+)\s*:\s*(\w+)/);
        if (aliasMatch) {
          mappings.push({
            localName: aliasMatch[2]!,
            exportedName: aliasMatch[1]!,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        } else if (name) {
          mappings.push({
            localName: name,
            exportedName: name,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        }
      }
    }
  }

  return mappings;
}

/**
 * Extract Python import mappings
 */
function extractPythonImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // from X import Y
  const fromImportRegex = /from\s+([\w.]+)\s+import\s+([^#\n]+)/g;
  let match;

  while ((match = fromImportRegex.exec(content)) !== null) {
    const [, source, imports] = match;
    const names = imports!.split(',').map((s) => s.trim());

    for (const name of names) {
      const aliasMatch = name.match(/(\w+)\s+as\s+(\w+)/);
      if (aliasMatch) {
        mappings.push({
          localName: aliasMatch[2]!,
          exportedName: aliasMatch[1]!,
          source: source!,
          isDefault: false,
          isNamespace: false,
        });
      } else if (name && name !== '*') {
        mappings.push({
          localName: name,
          exportedName: name,
          source: source!,
          isDefault: false,
          isNamespace: false,
        });
      }
    }
  }

  // import X
  const importRegex = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
  while ((match = importRegex.exec(content)) !== null) {
    const [, source, alias] = match;
    const localName = alias || source!.split('.').pop()!;
    mappings.push({
      localName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  return mappings;
}

/**
 * Extract Go import mappings
 */
function extractGoImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // import "path" or import alias "path"
  const singleImportRegex = /import\s+(?:(\w+)\s+)?["']([^"']+)["']/g;
  let match;

  while ((match = singleImportRegex.exec(content)) !== null) {
    const [, alias, source] = match;
    const packageName = source!.split('/').pop()!;
    mappings.push({
      localName: alias || packageName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  // import ( ... ) block
  const blockImportRegex = /import\s*\(\s*([^)]+)\s*\)/gs;
  while ((match = blockImportRegex.exec(content)) !== null) {
    const block = match[1]!;
    const lineRegex = /(?:(\w+)\s+)?["']([^"']+)["']/g;
    let lineMatch;

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const [, alias, source] = lineMatch;
      const packageName = source!.split('/').pop()!;
      mappings.push({
        localName: alias || packageName,
        exportedName: '*',
        source: source!,
        isDefault: false,
        isNamespace: true,
      });
    }
  }

  return mappings;
}

/**
 * Extract PHP import mappings (use statements)
 */
function extractPHPImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // use Namespace\Class; or use Namespace\Class as Alias;
  const useRegex = /use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/g;
  let match;

  while ((match = useRegex.exec(content)) !== null) {
    const [, fullPath, alias] = match;
    const className = fullPath!.split('\\').pop()!;
    mappings.push({
      localName: alias || className,
      exportedName: className,
      source: fullPath!,
      isDefault: false,
      isNamespace: false,
    });
  }

  return mappings;
}

// Cache import mappings per file to avoid re-reading and re-parsing
const importMappingCache = new Map<string, ImportMapping[]>();

/**
 * Clear the import mapping cache (call between indexing runs)
 */
export function clearImportMappingCache(): void {
  importMappingCache.clear();
}

/**
 * Strip JS line + block comments from `content` while preserving
 * string literals (so `"//"` inside a string stays intact). Used by
 * {@link extractReExports} so commented-out export-from statements
 * don't generate phantom re-export edges.
 *
 * Scanner is deliberately small: it only tracks the three contexts
 * relevant for JS/TS — single-quote string, double-quote string, and
 * template literal. Comment recognition is the JS spec subset, no
 * regex-literal awareness (which is fine for our use case: we don't
 * apply this to function bodies, only to top-level files).
 */
function stripJsComments(content: string): string {
  let out = '';
  let i = 0;
  let str: '"' | "'" | '`' | null = null;
  while (i < content.length) {
    const ch = content[i]!;
    if (str !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < content.length) {
        out += content[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === str) str = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      str = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract JS/TS re-export declarations from `content`.
 *
 * Recognised forms:
 *   export { foo } from './a';
 *   export { foo as bar } from './a';
 *   export * from './a';
 *   export * as ns from './a';   (treated as wildcard for chasing)
 *   export { default as Foo } from './a';
 *
 * The walker intentionally stays regex-based — the import-resolver
 * elsewhere in this file already chooses regex over a fresh
 * tree-sitter pass, and this function shares that trade-off. Errors
 * fall through silently; resolution simply skips the broken file.
 */
export function extractReExports(content: string, language: Language): ReExport[] {
  if (
    language !== 'typescript' &&
    language !== 'javascript' &&
    language !== 'tsx' &&
    language !== 'jsx'
  ) {
    return [];
  }
  const out: ReExport[] = [];

  // Pre-strip block comments + line comments so a commented-out
  // `// export { x } from '...'` doesn't produce a phantom edge.
  // (Template literals are still a possible source of false positives;
  // a project that builds export statements as runtime strings is
  // out of scope.)
  const cleaned = stripJsComments(content);

  // Wildcard: `export * from '...'` or `export * as ns from '...'`
  const wildcardRe = /export\s*\*(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = wildcardRe.exec(cleaned)) !== null) {
    out.push({ kind: 'wildcard', source: m[1]! });
  }

  // Named: `export { a, b as c } from '...'`
  const namedRe = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = namedRe.exec(cleaned)) !== null) {
    const inner = m[1]!;
    const source = m[2]!;
    for (const raw of inner.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      const aliasMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        out.push({
          kind: 'named',
          exportedName: aliasMatch[2]!,
          originalName: aliasMatch[1]!,
          source,
        });
      } else if (/^\w+$/.test(item)) {
        out.push({
          kind: 'named',
          exportedName: item,
          originalName: item,
          source,
        });
      }
    }
  }

  return out;
}
