/**
 * Python (Django/Flask/FastAPI) shared resolver helpers split out of python.ts
 * to keep it within the 200-line limit. Pure helpers — no behavior change.
 */

import { Node } from '../../types';
import { UnresolvedRef, ResolutionContext, FrameworkExtractionResult } from '../types';

export function resolveHandlerName(expr: string): { name: string; kind: 'references' | 'imports' } | null {
  // include('module.path')
  const includeMatch = expr.match(/^include\s*\(\s*['"]([^'"]+)['"]/);
  if (includeMatch) return { name: includeMatch[1]!, kind: 'imports' };

  // Strip trailing .as_view(...) or .as_view()
  let head = expr.replace(/\.as_view\s*\([^)]*\)\s*$/, '');
  // Drop any other trailing method call
  head = head.replace(/\.\w+\s*\([^)]*\)\s*$/, '');

  const dotted = head.split('.').filter(Boolean);
  if (dotted.length === 0) return null;
  const last = dotted[dotted.length - 1]!;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return null;

  return { name: last, kind: 'references' };
}


export interface DecoratorRouteOpts {
  decoratorRegex: RegExp;
  defaultMethod: string;
  methodGroup?: number;
  methodFromGroup?: number; // methods=[...] list
  pathGroup: number;
  handlerGroup?: number;
  findHandler?: boolean;
  language: 'python';
}

export function extractDecoratorRoutes(filePath: string, content: string, opts: DecoratorRouteOpts): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  let match: RegExpExecArray | null;
  while ((match = opts.decoratorRegex.exec(content)) !== null) {
    const routePath = match[opts.pathGroup];
    let method = opts.defaultMethod;
    if (opts.methodGroup && match[opts.methodGroup]) {
      method = match[opts.methodGroup]!.toUpperCase();
    } else if (opts.methodFromGroup && match[opts.methodFromGroup]) {
      const m = match[opts.methodFromGroup]!.match(/['"]([A-Z]+)['"]/i);
      if (m) method = m[1]!.toUpperCase();
    }
    const line = content.slice(0, match.index).split('\n').length;
    const name = method ? `${method} ${routePath}` : routePath!;
    const routeNode: Node = {
      id: `route:${filePath}:${line}:${method}:${routePath}`,
      kind: 'route',
      name,
      qualifiedName: `${filePath}::${method}:${routePath}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: match[0].length,
      language: opts.language,
      updatedAt: now,
    };
    nodes.push(routeNode);

    let handlerName: string | undefined;
    if (opts.handlerGroup && match[opts.handlerGroup]) {
      handlerName = match[opts.handlerGroup];
    } else if (opts.findHandler) {
      const tail = content.slice(match.index + match[0].length);
      const defMatch = tail.match(/\n\s*(?:async\s+)?def\s+(\w+)/);
      if (defMatch) handlerName = defMatch[1];
    }
    if (handlerName) {
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerName,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      });
    }
  }
  return { nodes, references };
}

// Directory patterns
export const MODEL_DIRS = ['models', 'app/models', 'src/models'];
export const VIEW_DIRS = ['views', 'app/views', 'src/views', 'api/views'];
export const FORM_DIRS = ['forms', 'app/forms', 'src/forms'];
export const ROUTER_DIRS = ['/routers/', '/api/', '/routes/', '/endpoints/'];
export const DEP_DIRS = ['/dependencies/', '/deps/', '/core/'];

export const CLASS_KINDS = new Set(['class']);
export const VIEW_KINDS = new Set(['class', 'function']);
export const VARIABLE_KINDS = new Set(['variable']);
export const FUNCTION_KINDS = new Set(['function']);

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
  if (preferredDirPatterns.length > 0) {
    const preferred = kindFiltered.filter((n) =>
      preferredDirPatterns.some((d) => n.filePath.includes(d))
    );
    if (preferred.length > 0) return preferred[0]!.id;
  }

  // Fall back to any match
  return kindFiltered[0]!.id;
}
